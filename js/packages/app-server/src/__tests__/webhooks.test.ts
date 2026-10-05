import { describe, it } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { FileCredentialStore, MemoryCredentialStore } from '../credentials.js';
import type { HubClient } from '../hub.js';
import { handleInstall } from '../install.js';
import { serveWebApp } from '../static.js';
import { verifyWebhookSignature } from '../webhooks.js';

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
