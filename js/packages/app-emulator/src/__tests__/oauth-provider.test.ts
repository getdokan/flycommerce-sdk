import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { OAuthFlows, json } from '@flycommerce/app-server';
import { FakeOAuthProvider } from '../oauth-provider.js';
import { RunningServer, sendJson, serve } from '../net.js';

describe('FakeOAuthProvider, driven by the OAuthFlows apps use', () => {
  let provider: FakeOAuthProvider;
  let providerServer: RunningServer;
  let appServer: RunningServer;
  let flows: OAuthFlows;

  before(async () => {
    const appPort = await new Promise<number>((resolve) => {
      const probe = http.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    const redirectUri = `http://127.0.0.1:${appPort}/auth/example/callback`;

    provider = new FakeOAuthProvider({
      clients: [{ clientId: 'client_1', clientSecret: 'secret_1', redirectUris: [redirectUri] }],
      accounts: [{ id: 'acct_7', name: 'Acme', email: 'owner@acme.test' }],
      accessTokenTtlSeconds: 60,
    });

    providerServer = await serve(async (req, res, url) => {
      if (await provider.handle(req, res, url)) return;
      const grant = provider.authenticate(req);
      return grant ? sendJson(res, 200, { account: grant.account.id }) : sendJson(res, 401, { error: 'invalid_token' });
    });

    flows = new OAuthFlows({
      name: 'example',
      label: 'Example',
      authorizeUrl: `${providerServer.url}/oauth/authorize`,
      tokenUrl: `${providerServer.url}/oauth/token`,
      clientId: 'client_1',
      clientSecret: 'secret_1',
      redirectUri,
    });

    appServer = await serve(async (req, res, url) => {
      if (url.pathname === flows.beginPath) return flows.begin(url, res);
      json(res, 200, await flows.complete(req, url, res));
    }, appPort);
  });

  after(async () => {
    await appServer.close();
    await providerServer.close();
  });

  async function signIn(): Promise<{ accessToken: string; refreshToken: string }> {
    const begun = await fetch(flows.issueTicket('alpha.flycom.shop').beginUrl, { redirect: 'manual' });
    const cookie = (begun.headers.get('set-cookie') ?? '').split(';')[0];
    const back = provider.approve(begun.headers.get('location')!);
    const done = (await (await fetch(back, { headers: { cookie } })).json()) as any;

    return { accessToken: done.tokens.accessToken, refreshToken: done.tokens.refreshToken };
  }

  const refresh = (refreshToken: string) =>
    fetch(`${providerServer.url}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: 'client_1',
        client_secret: 'secret_1',
      }),
    });

  const call = (token: string) => fetch(`${providerServer.url}/v1/account`, { headers: { Authorization: `Bearer ${token}` } });

  it('completes a real authorization-code sign-in and accepts the token', async () => {
    const { accessToken, refreshToken } = await signIn();

    assert.ok(refreshToken);
    assert.deepStrictEqual(await (await call(accessToken)).json(), { account: 'acct_7' });
  });

  it('rotates refresh tokens: each works exactly once', async () => {
    const { refreshToken } = await signIn();

    const first = await refresh(refreshToken);
    const replay = await refresh(refreshToken);

    assert.strictEqual(first.status, 200);
    assert.strictEqual(replay.status, 400);
    assert.deepStrictEqual(await replay.json(), { error: 'invalid_grant' });
  });

  it('expires access tokens on demand, so an app’s refresh path is exercised', async () => {
    const { accessToken, refreshToken } = await signIn();

    provider.expireAccessTokens();

    assert.strictEqual((await call(accessToken)).status, 401);
    const renewed = (await (await refresh(refreshToken)).json()) as { access_token: string };
    assert.strictEqual((await call(renewed.access_token)).status, 200);
  });

  it('ends every token when the account holder revokes the app', async () => {
    const { accessToken, refreshToken } = await signIn();

    provider.revokeAccount('acct_7');

    assert.strictEqual((await call(accessToken)).status, 401);
    assert.strictEqual((await refresh(refreshToken)).status, 400);
  });

  it('never redirects to a URI the client did not register', () => {
    const authorize = new URL(`${providerServer.url}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: 'client_1',
      redirect_uri: 'http://evil.test/steal',
    }).toString();

    assert.throws(() => provider.approve(authorize.toString()), /unregistered redirect_uri/);
  });

  it('sends a denial back as access_denied', () => {
    const authorize = new URL(`${providerServer.url}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: 'client_1',
      redirect_uri: flows.provider.redirectUri,
      state: 's1',
    }).toString();

    const back = new URL(provider.deny(authorize.toString()));

    assert.strictEqual(back.searchParams.get('error'), 'access_denied');
    assert.strictEqual(back.searchParams.get('state'), 's1');
  });

  it('shows a consent page for local runs', async () => {
    const authorize = new URL(`${providerServer.url}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: 'client_1',
      redirect_uri: flows.provider.redirectUri,
    }).toString();

    const page = await (await fetch(authorize)).text();

    assert.match(page, /Allow as Acme/);
    assert.match(page, /Deny/);
  });
});
