import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { verifySessionToken, clearJwksCache } from '../server.js';

/** Which published keys a session token may be checked against, and what happens when the key set is slow. */
describe('verifySessionToken key handling', () => {
  const appId = 'app-under-test';
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  let published: Record<string, unknown>[] = [];
  let delayMs = 0;
  let server: http.Server;
  let jwksUrl: string;

  function sign(kid: string): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const head = encode({ alg: 'RS256', typ: 'JWT', kid });
    const body = encode({ iss: new URL(jwksUrl).origin, aud: appId, sub: '1', typ: 'session', iat: now, nbf: now, exp: now + 60 });
    const signature = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(keys.privateKey).toString('base64url');

    return `${head}.${body}.${signature}`;
  }

  const jwk = (extra: Record<string, unknown>) => ({ ...keys.publicKey.export({ format: 'jwk' }), ...extra });

  before(async () => {
    server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: published }));
      }, delayMs);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    jwksUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/jwks.json`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    clearJwksCache();
    delayMs = 0;
  });

  it('accepts a token signed by an RSA signing key', async () => {
    published = [jwk({ kid: 'k1', use: 'sig', alg: 'RS256' })];

    assert.strictEqual((await verifySessionToken(sign('k1'), { appId, jwksUrl })).aud, appId);
  });

  it('refuses a key published for encryption, or for another algorithm', async () => {
    for (const extra of [{ use: 'enc' }, { alg: 'RS512' }]) {
      clearJwksCache();
      published = [jwk({ kid: 'k1', ...extra })];

      await assert.rejects(verifySessionToken(sign('k1'), { appId, jwksUrl }), /No matching public key/);
    }
  });

  it('gives up on a key set that does not answer, instead of hanging every request', async () => {
    published = [jwk({ kid: 'k1' })];
    delayMs = 8000;
    const started = Date.now();

    await assert.rejects(verifySessionToken(sign('k1'), { appId, jwksUrl }));
    assert.ok(Date.now() - started < 7000, 'the request was abandoned at the timeout');
  });
});
