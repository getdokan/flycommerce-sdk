import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { HttpError, json } from '../http.js';
import { OAuthDeniedError, OAuthFlows, OAuthNonceStore, OAuthProvider } from '../oauth.js';

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('OAuthFlows', () => {
  const tokenRequests: URLSearchParams[] = [];
  let tokenReply: { status: number; body: unknown } = { status: 200, body: { access_token: 'access-1', expires_in: 0 } };
  let clock = Date.now();
  let flows: OAuthFlows;
  let appUrl: string;
  const servers: http.Server[] = [];

  before(async () => {
    const provider = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      tokenRequests.push(new URLSearchParams(raw));
      json(res, tokenReply.status, tokenReply.body);
    });
    servers.push(provider);
    const providerUrl = await listen(provider);

    // The routes an app mounts, with the store it would take from a session token given directly.
    const app = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://app');

      try {
        if (url.pathname === '/ticket') return json(res, 200, flows.issueTicket(url.searchParams.get('store')!));
        if (url.pathname === flows.beginPath) return flows.begin(url, res);
        if (url.pathname === flows.callbackPath) return json(res, 200, await flows.complete(req, url, res));
        json(res, 404, {});
      } catch (error) {
        if (error instanceof OAuthDeniedError) return json(res, 200, { denied: error.message });
        if (error instanceof HttpError) return json(res, error.status, { error: error.code });
        throw error;
      }
    });
    servers.push(app);
    appUrl = await listen(app);

    flows = new OAuthFlows(
      {
        name: 'acme',
        label: 'Acme',
        authorizeUrl: 'https://login.acme.test/oauth2/authorize',
        tokenUrl: `${providerUrl}/oauth2/token`,
        clientId: 'client-1',
        clientSecret: 'secret-1',
        redirectUri: `${appUrl}/auth/acme/callback`,
      },
      () => clock
    );
  });

  beforeEach(() => {
    tokenRequests.length = 0;
    tokenReply = { status: 200, body: { access_token: 'access-1', expires_in: 0 } };
    clock = Date.now();
  });

  after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  });

  const ticketFor = async (store: string) =>
    ((await (await fetch(`${appUrl}/ticket?store=${store}`)).json()) as { beginUrl: string }).beginUrl;

  /** Follows the new tab as far as the provider, returning what a browser would hold. */
  const begin = async (beginUrl: string) => {
    const res = await fetch(beginUrl, { redirect: 'manual' });
    const location = res.headers.get('location');
    const setCookie = res.headers.get('set-cookie') ?? '';

    return {
      status: res.status,
      authorize: location ? new URL(location) : null,
      setCookie,
      cookie: setCookie.split(';')[0],
    };
  };

  const callback = (query: Record<string, string>, cookie?: string) =>
    fetch(`${appUrl}/auth/acme/callback?${new URLSearchParams(query)}`, { headers: cookie ? { cookie } : {} });

  it('sends the new tab to the provider with everything the authorization needs', async () => {
    const started = await begin(await ticketFor('alpha.flycom.shop'));

    assert.strictEqual(started.status, 302);
    assert.strictEqual(started.authorize?.origin + started.authorize!.pathname, 'https://login.acme.test/oauth2/authorize');
    assert.strictEqual(started.authorize?.searchParams.get('response_type'), 'code');
    assert.strictEqual(started.authorize?.searchParams.get('client_id'), 'client-1');
    assert.strictEqual(started.authorize?.searchParams.get('redirect_uri'), `${appUrl}/auth/acme/callback`);
    assert.match(started.setCookie, /HttpOnly/);
    assert.match(started.setCookie, /SameSite=Lax/);
    assert.match(started.cookie, /^flycom_oauth_acme=[\w-]{43}$/);
    assert.ok(!started.cookie.includes(started.authorize!.searchParams.get('state')!), 'the cookie is not the state');
  });

  it('finishes for the store that began it, and exchanges the code the way the spec says', async () => {
    const started = await begin(await ticketFor('alpha.flycom.shop'));
    const state = started.authorize!.searchParams.get('state')!;

    const res = await callback({ code: 'code-1', state }, started.cookie);
    const done = (await res.json()) as any;

    assert.strictEqual(res.status, 200);
    assert.strictEqual(done.store, 'alpha.flycom.shop');
    assert.deepStrictEqual(done.tokens, { accessToken: 'access-1', refreshToken: null, expiresAt: null, scope: null });

    const exchange = tokenRequests[0];
    assert.strictEqual(exchange.get('grant_type'), 'authorization_code');
    assert.strictEqual(exchange.get('code'), 'code-1');
    assert.strictEqual(exchange.get('client_secret'), 'secret-1');
    assert.strictEqual(exchange.get('redirect_uri'), `${appUrl}/auth/acme/callback`);
  });

  it('refuses a callback without state, even in the browser that began the flow', async () => {
    // Otherwise a link carrying someone else's code would connect their account to this store.
    const started = await begin(await ticketFor('alpha.flycom.shop'));

    const res = await callback({ code: 'attackers-code' }, started.cookie);

    assert.strictEqual(res.status, 400);
  });

  it('finishes at most one sign-in per ticket', async () => {
    const beginUrl = await ticketFor('alpha.flycom.shop');
    const first = await begin(beginUrl);
    const second = await begin(beginUrl);

    assert.strictEqual((await callback({ code: 'code-1', state: first.authorize!.searchParams.get('state')! }, first.cookie)).status, 200);
    assert.strictEqual(
      (await callback({ code: 'code-2', state: second.authorize!.searchParams.get('state')! }, second.cookie)).status,
      400
    );
    assert.strictEqual(tokenRequests.length, 1);
  });

  it('remembers a spent ticket as long as any flow begun from it can finish', async () => {
    const beginUrl = await ticketFor('alpha.flycom.shop');
    const first = await begin(beginUrl);
    assert.strictEqual((await callback({ code: 'code-1', state: first.authorize!.searchParams.get('state')! }, first.cookie)).status, 200);

    clock += 10 * 60 * 1000 - 1;
    const late = await begin(beginUrl);
    clock += 10 * 60 * 1000 - 2;

    assert.strictEqual((await callback({ code: 'code-2', state: late.authorize!.searchParams.get('state')! }, late.cookie)).status, 400);
    assert.strictEqual(tokenRequests.length, 1);
  });

  it('refuses a ticket past its ten minutes', async () => {
    const beginUrl = await ticketFor('alpha.flycom.shop');
    clock += 10 * 60 * 1000 + 1;

    assert.strictEqual((await begin(beginUrl)).status, 400);
  });

  // Login CSRF: an attacker approves with their own account and sends the victim the callback link.
  it('will not finish in a browser that did not begin the flow', async () => {
    const started = await begin(await ticketFor('alpha.flycom.shop'));
    const state = started.authorize!.searchParams.get('state')!;

    const res = await callback({ code: 'attackers-code', state });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(tokenRequests.length, 0, 'no code is exchanged for a browser that did not start the flow');
  });

  it('refuses a state that does not match the browser', async () => {
    const started = await begin(await ticketFor('alpha.flycom.shop'));

    const res = await callback({ code: 'code-1', state: 'someone-elses-state' }, started.cookie);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(tokenRequests.length, 0);
  });

  it('finishes only once, so a refreshed callback does nothing', async () => {
    const started = await begin(await ticketFor('alpha.flycom.shop'));
    const state = started.authorize!.searchParams.get('state')!;

    assert.strictEqual((await callback({ code: 'code-1', state }, started.cookie)).status, 200);
    assert.strictEqual((await callback({ code: 'code-1', state }, started.cookie)).status, 400);
    assert.strictEqual(tokenRequests.length, 1);
  });

  it('reports a merchant who declined, and spends the flow', async () => {
    const started = await begin(await ticketFor('alpha.flycom.shop'));
    const state = started.authorize!.searchParams.get('state')!;

    const res = await callback({ error: 'access_denied', state }, started.cookie);

    assert.deepStrictEqual(await res.json(), { denied: 'access_denied' });
    assert.strictEqual((await callback({ code: 'code-1', state }, started.cookie)).status, 400);
    assert.strictEqual(tokenRequests.length, 0);
  });

  it('turns a refused exchange into a message, not a crash', async () => {
    tokenReply = { status: 400, body: { error: 'invalid_grant' } };
    const started = await begin(await ticketFor('alpha.flycom.shop'));

    const res = await callback({ code: 'stale', state: started.authorize!.searchParams.get('state')! }, started.cookie);

    assert.deepStrictEqual(await res.json(), { error: 'oauth_exchange_failed' });
    assert.strictEqual(res.status, 502);
  });

  it('dates tokens that expire, and keeps a refresh token', async () => {
    tokenReply = { status: 200, body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, scope: 'read' } };
    const started = await begin(await ticketFor('alpha.flycom.shop'));

    const state = started.authorize!.searchParams.get('state')!;
    const done = (await (await callback({ code: 'code-1', state }, started.cookie)).json()) as any;

    assert.strictEqual(done.tokens.refreshToken, 'refresh-2');
    assert.strictEqual(done.tokens.expiresAt, new Date(clock + 3600 * 1000).toISOString());
  });

  it('marks the cookie Secure when the redirect is https', () => {
    const secure = new OAuthFlows({
      name: 'acme',
      label: 'Acme',
      authorizeUrl: 'https://login.acme.test/authorize',
      tokenUrl: 'https://login.acme.test/token',
      clientId: 'c',
      clientSecret: 's',
      redirectUri: 'https://app.acme.test/auth/acme/callback',
    });
    const headers: Record<string, unknown> = {};
    const res = { writeHead: (_status: number, sent: Record<string, unknown>) => Object.assign(headers, sent), end: () => undefined };

    secure.begin(new URL(secure.issueTicket('alpha.flycom.shop').beginUrl), res as unknown as http.ServerResponse);

    assert.match(String(headers['Set-Cookie']), /; Secure$/);
  });

  const ticketIn = (beginUrl: string) => new URL(beginUrl).searchParams.get('ticket')!;

  it('refuses a ticket that was altered', async () => {
    const ticket = ticketIn(await ticketFor('alpha.flycom.shop'));
    const [iv, tag, body] = ticket.split('.');
    const flipped = Buffer.from(body, 'base64url');
    flipped[0] ^= 1;

    const res = await begin(`${appUrl}${flows.beginPath}?ticket=${[iv, tag, flipped.toString('base64url')].join('.')}`);

    assert.strictEqual(res.status, 400);
  });

  it('answers malformed tickets and states with a 400, never a crash', async () => {
    for (const bad of ['', '.', '..', 'a.b.c', 'a.b.c.d', '!!!.@@@.###', 'x'.repeat(2000), '%00']) {
      assert.strictEqual((await begin(`${appUrl}${flows.beginPath}?ticket=${encodeURIComponent(bad)}`)).status, 400, bad.slice(0, 20));
      assert.strictEqual((await callback({ code: 'code-1', state: bad }, `flycom_oauth_acme=${bad}`)).status, 400, bad.slice(0, 20));
    }
    assert.strictEqual(tokenRequests.length, 0);
  });

  it('refuses a state past its ten minutes', async () => {
    const started = await begin(await ticketFor('alpha.flycom.shop'));
    clock += 10 * 60 * 1000 + 1;

    const res = await callback({ code: 'code-1', state: started.authorize!.searchParams.get('state')! }, started.cookie);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(tokenRequests.length, 0);
  });

  it("will not finish one store's state with the cookie from another store's flow", async () => {
    const alpha = await begin(await ticketFor('alpha.flycom.shop'));
    const beta = await begin(await ticketFor('beta.flycom.shop'));

    assert.strictEqual((await callback({ code: 'code-1', state: beta.authorize!.searchParams.get('state')! }, alpha.cookie)).status, 400);
    assert.strictEqual(tokenRequests.length, 0);

    const res = await callback({ code: 'code-1', state: alpha.authorize!.searchParams.get('state')! }, alpha.cookie);
    assert.strictEqual(((await res.json()) as { store: string }).store, 'alpha.flycom.shop');
  });

  // Anyone who sees the begin link (history, access logs) would otherwise hold a state for the store.
  it('will not take a ticket as a state', async () => {
    const ticket = ticketIn(await ticketFor('alpha.flycom.shop'));

    const res = await callback({ code: 'attackers-code', state: ticket }, `flycom_oauth_acme=${ticket}`);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(tokenRequests.length, 0);
  });

  // The provider, and the callback URL in history and logs, see every state.
  it('will not take a state as a ticket', async () => {
    const started = await begin(await ticketFor('alpha.flycom.shop'));

    const res = await begin(`${appUrl}${flows.beginPath}?ticket=${started.authorize!.searchParams.get('state')}`);

    assert.strictEqual(res.status, 400);
  });

  // A state leaks with the callback URL; the cookie never leaves the browser that began the flow.
  it('will not finish a leaked state in another browser', async () => {
    const started = await begin(await ticketFor('alpha.flycom.shop'));
    const state = started.authorize!.searchParams.get('state')!;

    const res = await callback({ code: 'attackers-code', state }, `flycom_oauth_acme=${state}`);

    assert.strictEqual(res.status, 400);
    assert.strictEqual(tokenRequests.length, 0);
  });

  // The provider knows the client secret, and some providers issue none.
  it('will not open a ticket sealed with the provider client secret', async () => {
    const key = crypto.createHash('sha256').update('secret-1').digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plain = JSON.stringify({ store: 'victim.flycom.shop', expiresAt: clock + 60_000, nonce: 'n' });
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const forged = [iv, cipher.getAuthTag(), body].map((part) => part.toString('base64url')).join('.');

    const res = await begin(`${appUrl}${flows.beginPath}?ticket=${forged}`);

    assert.strictEqual(res.status, 400);
  });

  describe('across instances', () => {
    const secret = 'an-app-secret-of-at-least-32-bytes!';
    const provider = (name = 'acme'): OAuthProvider => ({
      name,
      label: 'Acme',
      authorizeUrl: 'https://login.acme.test/oauth2/authorize',
      tokenUrl: flows.provider.tokenUrl,
      clientId: 'client-1',
      clientSecret: 'secret-1',
      redirectUri: `${appUrl}/auth/${name}/callback`,
    });

    const sharedNonces = (): OAuthNonceStore => {
      const spent = new Set<string>();
      return { spend: async (nonce) => !spent.has(nonce) && !!spent.add(nonce) };
    };

    const beginOn = (instance: OAuthFlows, beginUrl: string) => {
      const sent: Record<string, string> = {};
      instance.begin(new URL(beginUrl), {
        writeHead: (_status: number, headers: Record<string, string>) => Object.assign(sent, headers),
        end: () => undefined,
      } as never);
      return { state: new URL(sent['Location']).searchParams.get('state')!, cookie: sent['Set-Cookie'].split(';')[0] };
    };

    const completeOn = (instance: OAuthFlows, started: { state: string; cookie: string }, code: string) =>
      instance.complete(
        { headers: { cookie: started.cookie } } as never,
        new URL(`${instance.provider.redirectUri}?code=${code}&state=${started.state}`),
        {
          setHeader: () => undefined,
        } as never
      );

    it('finishes on another instance that shares the secret', async () => {
      const nonces = sharedNonces();
      const [a, b, c] = [0, 1, 2].map(() => new OAuthFlows(provider(), { secret, nonces, now: () => clock }));

      const done = await completeOn(c, beginOn(b, a.issueTicket('multi.flycom.shop').beginUrl), 'code-1');

      assert.strictEqual(done.store, 'multi.flycom.shop');
      assert.strictEqual(done.tokens.accessToken, 'access-1');
    });

    it('finishes a ticket once across instances that share a nonce store', async () => {
      const nonces = sharedNonces();
      const [a, b] = [0, 1].map(() => new OAuthFlows(provider(), { secret, nonces, now: () => clock }));
      const beginUrl = a.issueTicket('multi.flycom.shop').beginUrl;

      await completeOn(a, beginOn(a, beginUrl), 'code-1');

      await assert.rejects(completeOn(b, beginOn(b, beginUrl), 'attackers-code'), { code: 'oauth_flow_invalid' });
      assert.strictEqual(tokenRequests.length, 1);
    });

    it("refuses another instance's ticket without a shared secret", () => {
      const issuer = new OAuthFlows(provider());

      assert.throws(() => beginOn(new OAuthFlows(provider()), issuer.issueTicket('multi.flycom.shop').beginUrl), {
        code: 'oauth_link_expired',
      });
    });

    it('refuses a ticket issued for another provider', () => {
      const other = new OAuthFlows(provider('other'), { secret });
      const beginUrl = new URL(other.issueTicket('multi.flycom.shop').beginUrl);
      beginUrl.pathname = '/auth/acme/begin';

      assert.throws(() => beginOn(new OAuthFlows(provider(), { secret }), beginUrl.toString()), { code: 'oauth_link_expired' });
    });

    it('refuses a secret shorter than 32 bytes', () => {
      for (const weak of ['', 'secret-1', 'x'.repeat(31)]) {
        assert.throws(() => new OAuthFlows(provider(), { secret: weak }), /at least 32 bytes/);
      }
    });
  });
});
