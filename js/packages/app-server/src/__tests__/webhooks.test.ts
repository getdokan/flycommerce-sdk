import { describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { FileCredentialStore, MemoryCredentialStore } from '../credentials.js';
import { HttpError } from '../http.js';
import { Sealer } from '../sealer.js';
import type { StoreClient } from '../store-api.js';
import { isInstallationRevoked } from '../store-api.js';
import type { HubClient } from '../hub.js';
import { handleInstall } from '../install.js';
import { serveWebApp } from '../static.js';
import { readWebhook, verifyWebhookSignature, reconcileWebhook } from '../webhooks.js';

const sign = (body: string, secret: string) => crypto.createHmac('sha256', secret).update(body).digest('hex');

describe('verifyWebhookSignature', () => {
  const body = '{"event":"order.created","timestamp":"2026-10-05T10:00:00+00:00","data":{"id":"01ORDER1"}}';

  it('accepts the signature of the exact body', () => {
    assert.strictEqual(verifyWebhookSignature(body, sign(body, 'secret'), 'secret'), true);
    assert.strictEqual(verifyWebhookSignature(Buffer.from(body), sign(body, 'secret'), 'secret'), true);
  });

  it('refuses a changed body, another secret, and anything that is not a signature', () => {
    assert.strictEqual(verifyWebhookSignature(body.replace('01ORDER1', '01ORDER2'), sign(body, 'secret'), 'secret'), false);
    assert.strictEqual(verifyWebhookSignature(body, sign(body, 'other'), 'secret'), false);
    for (const header of [undefined, '', 'nope', sign(body, 'secret').slice(2), [sign(body, 'secret')]]) {
      assert.strictEqual(verifyWebhookSignature(body, header, 'secret'), false);
    }
    assert.strictEqual(verifyWebhookSignature(body, sign(body, ''), ''), false, 'no secret, no trust');
  });
});

describe('credential stores', () => {
  const credential = { clientId: 'id', clientSecret: 'secret', scope: '' };

  it('forget one store and keep the others', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'credentials-')), 'credentials.json');

    for (const store of [new MemoryCredentialStore(), new FileCredentialStore(file)]) {
      store.put('alpha.flycom.shop', credential);
      store.put('beta.flycom.shop', credential);
      store.delete('alpha.flycom.shop');
      store.delete('never.flycom.shop');

      assert.strictEqual(store.get('alpha.flycom.shop'), undefined);
      assert.deepStrictEqual(store.get('beta.flycom.shop'), credential);
    }

    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  });
});

describe('serveWebApp', () => {
  it('serves assets when the build folder is given as a relative path', async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), '.web-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'export {};');

    let status = 0;
    const res = { writeHead: (code: number) => ((status = code), res), end: () => res } as unknown as ServerResponse;

    try {
      const served = await serveWebApp('GET', '/assets/app.js', res, { root: path.relative(process.cwd(), dir), appId: 'app' });
      assert.strictEqual(served, true);
      assert.strictEqual(status, 200);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('handleInstall', () => {
  const hub = {
    exchangeCode: async () => ({ store: 'alpha.flycom.shop', credential: { clientId: 'id', clientSecret: 'secret', scope: '' } }),
    forget: () => {},
  } as unknown as HubClient;
  const url = new URL('https://app.test/auth/callback?code=c&return_to=https%3A%2F%2Falpha.flycommerce.com%2Fadmin%2Fapps%2Fx');

  const response = (events: string[]) =>
    ({
      writeHead: (code: number) => (events.push(`respond ${code}`), {}),
      end: () => {},
    }) as unknown as ServerResponse;

  it('finishes the app’s setup before sending the merchant back', async () => {
    const events: string[] = [];
    const store = await handleInstall(url, response(events), {
      hub,
      credentials: new MemoryCredentialStore(),
      frameAncestors: ['https://*.flycommerce.com'],
      appName: 'Test',
      onInstalled: async (installed) => void events.push(`setup ${installed}`),
    });

    assert.strictEqual(store, 'alpha.flycom.shop');
    assert.deepStrictEqual(events, ['setup alpha.flycom.shop', 'respond 302']);
  });

  it('still lands the merchant when the setup fails', async () => {
    const events: string[] = [];
    const credentials = new MemoryCredentialStore();
    const error = console.error;
    console.error = () => {};

    try {
      await handleInstall(url, response(events), {
        hub,
        credentials,
        frameAncestors: ['https://*.flycommerce.com'],
        appName: 'Test',
        onInstalled: async () => {
          throw new Error('subscribe failed');
        },
      });
    } finally {
      console.error = error;
    }

    assert.deepStrictEqual(events, ['respond 302']);
    assert.ok(credentials.get('alpha.flycom.shop'), 'the credential is kept');
  });
});

describe('readWebhook', () => {
  const body = '{"event":"order.created","timestamp":"2026-10-05T10:00:00+00:00","data":{"id":"01ORDER1","total":"120.00"}}';
  const request = (url: string, signature?: string, raw = body) =>
    Object.assign(Readable.from([Buffer.from(raw)]), { url, headers: { 'x-webhook-signature': signature } }) as never;
  const secrets: Record<string, string> = { 'alpha.flycom.shop': 'alpha-secret' };

  it('returns the store and the delivery when the body verifies under that store’s secret', async () => {
    const { store, delivery } = await readWebhook(
      request('/webhooks?store=alpha.flycom.shop', sign(body, 'alpha-secret')),
      (s) => secrets[s]
    );

    assert.strictEqual(store, 'alpha.flycom.shop');
    assert.deepStrictEqual([delivery.event, delivery.data.id], ['order.created', '01ORDER1']);
  });

  it('answers an unknown store, a missing store and a bad signature alike', async () => {
    for (const req of [
      request('/webhooks?store=other.flycom.shop', sign(body, 'alpha-secret')),
      request('/webhooks', sign(body, 'alpha-secret')),
      request('/webhooks?store=alpha.flycom.shop', sign(body, 'wrong')),
    ]) {
      await assert.rejects(
        readWebhook(req, (s) => secrets[s]),
        (error: HttpError) => error.status === 401 && error.code === 'invalid_signature'
      );
    }
  });

  it('refuses a signed body that is not a delivery', async () => {
    const raw = '{"hello":"world"}';
    await assert.rejects(
      readWebhook(request('/webhooks?store=alpha.flycom.shop', sign(raw, 'alpha-secret'), raw), (s) => secrets[s]),
      (error: HttpError) => error.status === 400
    );
  });
});

describe('FileCredentialStore with a Sealer', () => {
  const sealer = new Sealer(Buffer.alloc(32, 9).toString('base64'));
  const credential = { clientId: 'id', clientSecret: 'very-secret', scope: 'orders.read' };

  it('keeps credentials encrypted on disk and reads them back', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'credentials-')), 'credentials.json');
    new FileCredentialStore(file, { sealer }).put('alpha.flycom.shop', credential);

    assert.ok(!fs.readFileSync(file, 'utf8').includes('very-secret'), 'the secret is not on disk in the clear');
    assert.deepStrictEqual(new FileCredentialStore(file, { sealer }).get('alpha.flycom.shop'), credential);
    assert.throws(() => new FileCredentialStore(file).get('alpha.flycom.shop'), /sealed/);
  });

  it('still reads credentials written before sealing was turned on', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'credentials-')), 'credentials.json');
    new FileCredentialStore(file).put('alpha.flycom.shop', credential);

    assert.deepStrictEqual(new FileCredentialStore(file, { sealer }).get('alpha.flycom.shop'), credential);
  });
});

describe('isInstallationRevoked', () => {
  it('recognises the store refusing an uninstalled app, and nothing else', () => {
    assert.strictEqual(isInstallationRevoked(new HttpError(409, 'installation_revoked')), true);
    assert.strictEqual(isInstallationRevoked(new HttpError(401, 'session_expired')), false);
    assert.strictEqual(isInstallationRevoked(new Error('installation_revoked')), false);
  });
});

describe('reconcileWebhook', () => {
  it('creates the new webhook first, then cleans up existing ones for that endpoint', async () => {
    const callLog: string[] = [];
    const mockClient = {
      async *paginate() {
        yield { id: 101, endpoint: 'https://app.test/webhook' };
        yield { id: 102, endpoint: 'https://other.test/webhook' };
      },
      request: async (method: string, path: string) => {
        callLog.push(`${method} ${path}`);
        if (method === 'POST') {
          return { data: { id: 201, secret: 'created-secret' } };
        }
        return {};
      },
    } as unknown as StoreClient;

    const result = await reconcileWebhook(mockClient, {
      endpoint: 'https://app.test/webhook',
      events: ['orders.created'],
    });

    assert.deepStrictEqual(result, { id: 201, secret: 'created-secret' });
    assert.deepStrictEqual(callLog, ['POST /api/v1/integrations/webhooks', 'DELETE /api/v1/integrations/webhooks/101']);
  });

  it('leaves existing webhooks intact if creating the new webhook fails', async () => {
    const callLog: string[] = [];
    const mockClient = {
      async *paginate() {
        yield { id: 101, endpoint: 'https://app.test/webhook' };
      },
      request: async (method: string, path: string) => {
        callLog.push(`${method} ${path}`);
        if (method === 'POST') {
          throw new Error('store connection failed');
        }
        return {};
      },
    } as unknown as StoreClient;

    await assert.rejects(
      reconcileWebhook(mockClient, {
        endpoint: 'https://app.test/webhook',
        events: ['orders.created'],
      }),
      /store connection failed/
    );

    assert.deepStrictEqual(callLog, ['POST /api/v1/integrations/webhooks']);
  });
});
