import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { verifySessionToken, clearJwksCache } from '../server.js';
import { createApp } from '../index.js';

describe('@flycommerce/app-bridge server verification', () => {
  let rsaKeys: crypto.KeyPairSyncResult<string, string>;
  let publicJwk: any;
  let mockJwksServer: any;
  const appId = 'app_order_printer';
  const jwksPort = 9876;
  const jwksUrl = `http://127.0.0.1:${jwksPort}/.well-known/jwks.json`;
  const allowedIssuers = ['https://app.flycommerce.com'];

  before(async () => {
    rsaKeys = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const pubKeyObj = crypto.createPublicKey(rsaKeys.publicKey);
    const jwk = pubKeyObj.export({ format: 'jwk' });
    publicJwk = {
      ...jwk,
      kid: 'test-key-id-1',
      use: 'sig',
      alg: 'RS256',
    };

    const http = await import('node:http');
    mockJwksServer = http.createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [publicJwk] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => mockJwksServer.listen(jwksPort, '127.0.0.1', resolve));
  });

  after(async () => {
    if (mockJwksServer) {
      await new Promise<void>((resolve) => mockJwksServer.close(() => resolve()));
    }
  });

  function mintToken(claims: Record<string, any>, options: { kid?: string; alg?: string } = {}) {
    const header = {
      alg: options.alg || 'RS256',
      typ: 'JWT',
      kid: options.kid || 'test-key-id-1',
    };

    const base64Url = (obj: any) =>
      Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    const unsigned = `${base64Url(header)}.${base64Url(claims)}`;

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsigned);
    const signature = signer.sign(rsaKeys.privateKey, 'base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    return `${unsigned}.${signature}`;
  }

  it('successfully verifies a valid RS256 session token', async () => {
    clearJwksCache();
    const token = mintToken({
      iss: 'https://app.flycommerce.com',
      aud: appId,
      sub: '42',
      role: 'owner',
      dest: 'https://mystore.flycom.shop',
      typ: 'session',
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
    });

    const payload = await verifySessionToken(token, { appId, jwksUrl, allowedIssuers });

    assert.strictEqual(payload.aud, appId);
    assert.strictEqual(payload.sub, '42');
    assert.strictEqual(payload.role, 'owner');
    assert.strictEqual(payload.dest, 'https://mystore.flycom.shop');
    assert.strictEqual(payload.typ, 'session');
  });

  it('rejects an expired session token', async () => {
    clearJwksCache();
    const token = mintToken({
      iss: 'https://app.flycommerce.com',
      aud: appId,
      sub: '42',
      role: 'admin',
      dest: 'https://mystore.flycom.shop',
      typ: 'session',
      exp: Math.floor(Date.now() / 1000) - 10, // expired 10s ago
      iat: Math.floor(Date.now() / 1000) - 70,
    });

    await assert.rejects(
      async () => {
        await verifySessionToken(token, { appId, jwksUrl, allowedIssuers });
      },
      {
        message: /Session token has expired/,
      }
    );
  });

  it('rejects mismatched audience / appId', async () => {
    clearJwksCache();
    const token = mintToken({
      iss: 'https://app.flycommerce.com',
      aud: 'different_app_id',
      sub: '42',
      role: 'admin',
      dest: 'https://mystore.flycom.shop',
      typ: 'session',
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    await assert.rejects(
      async () => {
        await verifySessionToken(token, { appId, jwksUrl, allowedIssuers });
      },
      {
        message: /Invalid token audience/,
      }
    );
  });

  it('rejects tampered token signature', async () => {
    clearJwksCache();
    const token = mintToken({
      iss: 'https://app.flycommerce.com',
      aud: appId,
      sub: '42',
      role: 'admin',
      typ: 'session',
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    const tampered = token.substring(0, token.length - 4) + 'abcd';

    await assert.rejects(
      async () => {
        await verifySessionToken(tampered, { appId, jwksUrl, allowedIssuers });
      },
      {
        message: /Invalid JWT signature/,
      }
    );
  });

  it('rejects non-session token type', async () => {
    clearJwksCache();
    const token = mintToken({
      iss: 'https://app.flycommerce.com',
      aud: appId,
      sub: '42',
      role: 'admin',
      typ: 'access_token', // Not 'session'
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    await assert.rejects(
      async () => {
        await verifySessionToken(token, { appId, jwksUrl, allowedIssuers });
      },
      {
        message: /Invalid token type/,
      }
    );
  });

  it('rejects token with untrusted or missing issuer', async () => {
    clearJwksCache();
    const tokenNoIss = mintToken({
      aud: appId,
      sub: '42',
      role: 'admin',
      typ: 'session',
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    await assert.rejects(
      async () => {
        await verifySessionToken(tokenNoIss, { appId, jwksUrl, allowedIssuers });
      },
      {
        message: /Untrusted or missing token issuer/,
      }
    );

    const tokenEvilIss = mintToken({
      iss: 'https://evil-hacker.com',
      aud: appId,
      sub: '42',
      role: 'admin',
      typ: 'session',
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    await assert.rejects(
      async () => {
        await verifySessionToken(tokenEvilIss, { appId, jwksUrl, allowedIssuers });
      },
      {
        message: /Untrusted or missing token issuer/,
      }
    );
  });
  it('rejects a token that is not valid yet', async () => {
    clearJwksCache();
    const now = Math.floor(Date.now() / 1000);
    const token = mintToken({ iss: 'https://app.flycommerce.com', aud: appId, sub: '42', typ: 'session', nbf: now + 120, exp: now + 180 });

    await assert.rejects(verifySessionToken(token, { appId, jwksUrl, allowedIssuers }), { message: /not valid yet/ });
  });

  it('trusts the JWKS origin as issuer when no issuers are configured', async () => {
    clearJwksCache();
    const token = mintToken({
      iss: `http://127.0.0.1:${jwksPort}`,
      aud: appId,
      sub: '42',
      typ: 'session',
      exp: Math.floor(Date.now() / 1000) + 60,
    });

    const payload = await verifySessionToken(token, { appId, jwksUrl });

    assert.strictEqual(payload.sub, '42');
  });

  it('picks up a rotated key without waiting for the cache to expire', async () => {
    clearJwksCache();
    const exp = Math.floor(Date.now() / 1000) + 60;
    await verifySessionToken(mintToken({ iss: 'https://app.flycommerce.com', aud: appId, sub: '1', typ: 'session', exp }), {
      appId,
      jwksUrl,
      allowedIssuers,
    });

    const previous = { keys: rsaKeys, jwk: publicJwk };
    rsaKeys = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    publicJwk = { ...crypto.createPublicKey(rsaKeys.publicKey).export({ format: 'jwk' }), kid: 'test-key-id-2', use: 'sig', alg: 'RS256' };

    try {
      const token = mintToken({ iss: 'https://app.flycommerce.com', aud: appId, sub: '2', typ: 'session', exp }, { kid: 'test-key-id-2' });
      const payload = await verifySessionToken(token, { appId, jwksUrl, allowedIssuers });

      assert.strictEqual(payload.sub, '2');
    } finally {
      rsaKeys = previous.keys;
      publicJwk = previous.jwk;
      clearJwksCache();
    }
  });
});
