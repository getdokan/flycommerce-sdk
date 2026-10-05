import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { HubClient, MemoryCredentialStore, handleInstall } from '@flycommerce/app-server';
import { RunningServer, serve } from '../net.js';
import { FakePlatform, startFakePlatform } from '../platform.js';

const domain = 'alpha.flycom.shop';
const dashboard = 'http://localhost:3001';

describe('handleInstall, against fake FlyCommerce', () => {
  let platform: FakePlatform;
  let app: RunningServer;
  const credentials = new MemoryCredentialStore();

  before(async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = http.createServer().listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address() as { port: number };
        probe.close(() => resolve(free));
      });
    });
    const registration = { appId: 'app_install', appSecret: 'secret_install', redirectUri: `http://127.0.0.1:${port}/auth/callback` };

    platform = await startFakePlatform(registration);
    const hub = new HubClient({ hubApiUrl: platform.hub.apiUrl, ...registration });

    app = await serve(async (_req, res, url) => {
      await handleInstall(url, res, { hub, credentials, frameAncestors: [dashboard], appName: 'Example' });
    }, port);
  });

  after(async () => {
    await app.close();
    await platform.close();
  });

  const installUrl = (returnTo?: string) => {
    const { callbackUrl } = platform.hub.install('app_install', { store: domain, scopes: ['orders.read'] });
    const url = new URL(callbackUrl);
    if (returnTo) url.searchParams.set('return_to', returnTo);
    return url;
  };

  it('keeps the credential and lands the merchant on the app’s page, without leaking the code', async () => {
    const res = await fetch(installUrl(`${dashboard}/admin/apps/example/overview`), { redirect: 'manual' });

    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), `${dashboard}/admin/apps/example/overview`);
    assert.strictEqual(res.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(credentials.get(domain), 'the store credential was kept');
  });

  it('shows the connected page when the install did not start in a trusted dashboard', async () => {
    const res = await fetch(installUrl('https://evil.test/admin/apps/example'), { redirect: 'manual' });

    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /Example is connected/);
  });

  it('explains a failed exchange and offers the way back', async () => {
    const url = installUrl(`${dashboard}/admin/apps/example/overview`);
    url.searchParams.set('code', 'spent-or-forged');

    const res = await fetch(url, { redirect: 'manual' });
    const page = await res.text();

    assert.strictEqual(res.status, 502);
    assert.match(page, /could not finish installing/);
    assert.match(page, /href="http:\/\/localhost:3001\/admin\/apps\/example\/overview"/);
  });
});
