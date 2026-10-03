import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { FileCredentialStore } from '../credentials.js';
import { HubClient, HubError } from '../hub.js';
import { json } from '../http.js';
import { serveWebApp } from '../static.js';

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
