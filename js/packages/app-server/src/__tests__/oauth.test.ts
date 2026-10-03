import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { HttpError, json } from '../http.js';
import { OAuthDeniedError, OAuthFlows } from '../oauth.js';

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
    assert.strictEqual(started.cookie, `flycom_oauth_acme=${started.authorize?.searchParams.get('state')}`);
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

  it('spends a ticket on first use', async () => {
    const beginUrl = await ticketFor('alpha.flycom.shop');

    assert.strictEqual((await begin(beginUrl)).status, 302);
    assert.strictEqual((await begin(beginUrl)).status, 400);
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
});
