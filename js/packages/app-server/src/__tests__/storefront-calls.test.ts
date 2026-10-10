import { describe, it } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { allowStorefrontCalls, json } from '../http.js';

/** A storefront script calls its app's server from the store's own domain, whichever domain that is. */
describe('allowStorefrontCalls', () => {
  const start = async () => {
    const server = http.createServer((req, res) => {
      if (allowStorefrontCalls(req, res)) return;
      json(res, 200, { ok: true });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/assist` };
  };

  it('answers the preflight for a bearer token, and nothing else', async () => {
    const { server, url } = await start();

    const response = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://shop.example' } });

    assert.strictEqual(response.status, 204);
    assert.strictEqual(response.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(response.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
    assert.strictEqual(response.headers.get('access-control-allow-credentials'), null, 'no cookies cross origins');
    server.close();
  });

  it('lets the route answer, readable from any store', async () => {
    const { server, url } = await start();

    const response = await fetch(url, { method: 'POST', headers: { Origin: 'https://shop.example' } });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('access-control-allow-origin'), '*');
    assert.deepStrictEqual(await response.json(), { ok: true });
    server.close();
  });
});
