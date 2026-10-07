import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { FLYCOMMERCE_ORIGIN, appServerConfigFromEnv } from '../config.js';
import { FileCredentialStore, MemoryCredentialStore } from '../credentials.js';
import { HubClient, HubError } from '../hub.js';
import { HttpError, json } from '../http.js';
import { Sealer } from '../sealer.js';
import { authenticate } from '../session.js';
import { serveWebApp } from '../static.js';
import { StoreApi } from '../store-api.js';

async function listen(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('FileCredentialStore', () => {
  it('keeps the file readable by its owner only, even when it already existed with wider permissions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credentials-'));
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });

    new FileCredentialStore(file).put('alpha.flycom.shop', { clientId: 'id', clientSecret: 'secret', scope: '' });

    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepStrictEqual(fs.readdirSync(dir), ['credentials.json'], 'no temporary file is left behind');
    assert.strictEqual(new FileCredentialStore(file).get('alpha.flycom.shop')?.clientSecret, 'secret');
  });
});

describe('FileCredentialStore with a damaged file', () => {
  it('stops instead of reading it as empty and overwriting every other store', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'credentials-')), 'credentials.json');
    fs.writeFileSync(file, '{"alpha.flycom.shop": {"clientId": "id", ');
    const store = new FileCredentialStore(file);

    assert.throws(() => store.get('alpha.flycom.shop'), SyntaxError);
    assert.throws(() => store.put('beta.flycom.shop', { clientId: 'id', clientSecret: 'secret', scope: '' }), SyntaxError);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"alpha.flycom.shop": {"clientId": "id", ', 'the file is left as it was');
  });

  it('still treats a missing file as no stores yet', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'credentials-')), 'missing.json');

    assert.strictEqual(new FileCredentialStore(file).get('alpha.flycom.shop'), undefined);
  });
});

describe('Sealer', () => {
  const sealer = new Sealer(Buffer.alloc(32, 7).toString('base64'));

  it('opens what it sealed', () => {
    assert.strictEqual(sealer.open(sealer.seal('webhook secret')), 'webhook secret');
  });

  it('refuses a shortened authentication tag, which GCM would otherwise accept', () => {
    const [iv, tag, encrypted] = sealer.seal('webhook secret').split('.');
    const short = Buffer.from(tag, 'base64url').subarray(0, 4).toString('base64url');

    assert.throws(() => sealer.open([iv, short, encrypted].join('.')), /Not a sealed value/);
  });

  it('refuses anything that is not a sealed value with a clear error', () => {
    assert.throws(() => sealer.open('plain text'), /Not a sealed value/);
  });
});

describe('appServerConfigFromEnv', () => {
  const env = { APP_ID: 'app', APP_SECRET: 'secret', REDIRECT_URI: 'https://app.example/auth/callback' };

  it("verifies against FlyCommerce's issuer and keys whichever API host the app uses", () => {
    const config = appServerConfigFromEnv({ ...env, HUB_API_URL: 'https://developers.flycommerce.com/api' });

    assert.deepStrictEqual(config.allowedIssuers, [FLYCOMMERCE_ORIGIN]);
    assert.strictEqual(config.jwksUrl, `${FLYCOMMERCE_ORIGIN}/.well-known/jwks.json`);
  });

  it('takes both from the environment when they are set', () => {
    const config = appServerConfigFromEnv({
      ...env,
      HUB_API_URL: 'http://localhost:4000/api',
      JWKS_URL: 'http://localhost:4000/.well-known/jwks.json',
      ALLOWED_ISSUERS: 'http://localhost:4000',
    });

    assert.deepStrictEqual(config.allowedIssuers, ['http://localhost:4000']);
    assert.strictEqual(config.jwksUrl, 'http://localhost:4000/.well-known/jwks.json');
  });

  it('defaults REDIRECT_URI to APP_URL/auth/callback, and lets REDIRECT_URI win', () => {
    const { REDIRECT_URI, ...withoutRedirect } = env;
    const hub = { HUB_API_URL: 'https://developers.flycommerce.com/api' };
    const fromAppUrl = appServerConfigFromEnv({ ...withoutRedirect, ...hub, APP_URL: 'https://quiet-fox.trycloudflare.com/' });

    assert.strictEqual(fromAppUrl.appUrl, 'https://quiet-fox.trycloudflare.com');
    assert.strictEqual(fromAppUrl.redirectUri, 'https://quiet-fox.trycloudflare.com/auth/callback');
    assert.strictEqual(appServerConfigFromEnv({ ...env, ...hub, APP_URL: 'https://other.example' }).redirectUri, REDIRECT_URI);
    assert.throws(() => appServerConfigFromEnv({ ...withoutRedirect, ...hub }), /REDIRECT_URI is required, or APP_URL/);
  });
});

describe('authenticate', () => {
  it("doesn't tell the caller which check a bad session token failed", async () => {
    const req = { headers: { authorization: 'Bearer not.a.token' } } as http.IncomingMessage;

    await assert.rejects(
      authenticate(req, { appId: 'app', jwksUrl: 'http://127.0.0.1:9/jwks', allowedIssuers: [] }),
      (error: HttpError) => {
        assert.strictEqual(error.status, 401);
        assert.strictEqual(error.message, 'The session token is not valid.');
        return true;
      }
    );
  });
});

describe('StoreApi paths', () => {
  const store = new StoreApi({ credentials: new MemoryCredentialStore() }, {} as HubClient).asApp('shop.flycom.shop');

  it("refuses a path that would send the store's token to another host", async () => {
    for (const path of ['.evil.example/x', '@evil.example/x', 'https://evil.example/x']) {
      await assert.rejects(store.get(path), TypeError, path);
    }
  });

  it('accepts a path on the store', async () => {
    // Passes the path check and stops at the missing credential, before any request is sent.
    await assert.rejects(store.get('/api/v1/orders'), (error: HttpError) => error.code === 'store_not_connected');
  });
});

describe('HubClient', () => {
  it('refuses a token answer without an access token instead of caching nothing', async () => {
    const hub = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ expires_in: 900 }));
    });

    try {
      const client = new HubClient({ hubApiUrl: hub.url, appId: 'a', appSecret: 's', redirectUri: 'https://app.test/cb' });

      await assert.rejects(client.accessToken('alpha.flycom.shop', { clientId: 'c', clientSecret: 's', scope: '' }), (error: unknown) => {
        return error instanceof HubError && error.message === 'access_token_missing';
      });
    } finally {
      await hub.close();
    }
  });
});

describe('serveWebApp', () => {
  it('treats a malformed escape in an asset path as not found, not as a crash', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
    fs.mkdirSync(path.join(root, 'assets'));
    const res = new http.ServerResponse(new http.IncomingMessage(null as never));

    assert.strictEqual(await serveWebApp('GET', '/assets/%E0%A4%A', res, { root, appId: 'a' }), false);
  });
});

describe('json', () => {
  it('tells browsers and proxies not to keep API answers', async () => {
    const server = await listen((_req, res) => json(res, 200, { ok: true }));

    try {
      const response = await fetch(server.url);

      assert.strictEqual(response.headers.get('cache-control'), 'no-store');
      assert.strictEqual(response.headers.get('x-content-type-options'), 'nosniff');
    } finally {
      await server.close();
    }
  });
});
