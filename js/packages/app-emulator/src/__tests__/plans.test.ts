import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import {
  AppConfig,
  HubClient,
  MemoryCredentialStore,
  StoreApi,
  authenticate,
  checkAppConfig,
  handleInstall,
  pageAccess,
  planOf,
  readLockedPageCallback,
  readPlanCallback,
  sendError,
} from '@flycommerce/app-server';
import { ExampleDashboard } from '../dashboard.js';
import { RunningServer, readJsonBody, sendJson, serve } from '../net.js';
import { FakePlatform, startFakePlatform } from '../platform.js';

const store = 'alpha.flycom.shop';

/** An app with a free page and a Pro page, built only from the SDK, against fake FlyCommerce and its example dashboard. */
describe('plans, locked pages and callbacks, end to end', () => {
  let platform: FakePlatform;
  let app: RunningServer;
  let dashboard: ExampleDashboard;
  let config: AppConfig;
  let answer: unknown = null;
  const asked: Record<string, unknown>[] = [];

  before(async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = http.createServer().listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address() as { port: number };
        probe.close(() => resolve(free));
      });
    });
    const appUrl = `http://127.0.0.1:${port}`;
    const registration = { appId: 'app_plans', appSecret: 'secret_plans', redirectUri: `${appUrl}/auth/callback` };

    config = {
      appId: registration.appId,
      appUrl,
      install: { redirectUrl: '/auth/callback' },
      plans: [
        { key: 'free', name: 'Free', default: true },
        { key: 'pro', name: 'Pro' },
      ],
      planCallback: '/callbacks/plan',
      dashboard: {
        pages: [
          { slug: 'orders', label: 'Orders', title: 'Order export', path: '/orders' },
          {
            slug: 'reports',
            label: 'Reports',
            title: 'Sales reports',
            path: '/reports',
            plans: ['pro'],
            callback: '/callbacks/reports-locked',
          },
          {
            slug: 'beta',
            label: 'Beta',
            path: '/beta',
            isActive: false,
            children: [
              { slug: 'beta-notes', label: 'Notes', path: '/beta/notes' },
              { slug: 'beta-pro', label: 'Pro notes', path: '/beta/pro', plans: ['pro'], callback: '/callbacks/reports-locked' },
            ],
          },
        ],
      },
    };
    assert.deepStrictEqual(checkAppConfig(config), []);

    platform = await startFakePlatform(registration);

    const credentials = new MemoryCredentialStore();
    const server = {
      ...registration,
      hubApiUrl: platform.hub.apiUrl,
      jwksUrl: platform.hub.jwksUrl,
      allowedIssuers: [platform.hub.issuer],
    };
    const hub = new HubClient(server);
    const api = new StoreApi({ credentials, storeUrl: () => platform.store.url }, hub);

    app = await serve(async (req, res, url) => {
      try {
        if (url.pathname === '/auth/callback') {
          await handleInstall(url, res, { hub, credentials, frameAncestors: ['http://127.0.0.1'], appName: 'Plans' });
          return;
        }
        if (url.pathname === '/callbacks/reports-locked') {
          const callback = await readLockedPageCallback(req, server);
          asked.push({ page: callback.page, reason: callback.reason, store: callback.store, plan: planOf(config, callback.session) });
          sendJson(res, 200, answer ?? { path: `/upgrade?page=${callback.page}&reason=${callback.reason}` });
          return;
        }
        if (url.pathname === '/callbacks/plan') {
          const callback = await readPlanCallback(req, server, config);
          asked.push({ plan: callback.plan, currentPlan: callback.currentPlan });
          sendJson(res, 200, { path: `/plans?to=${callback.plan}` });
          return;
        }
        if (url.pathname === '/api/plan') {
          const { store: asking } = await authenticate(req, server);
          await api.setPlan(asking, String((await readJsonBody(req)).plan));
          sendJson(res, 200, {});
          return;
        }
        if (url.pathname === '/api/reports') {
          const { session } = await authenticate(req, server);
          const access = pageAccess(config, 'reports', planOf(config, session));
          sendJson(res, access === 'available' ? 200 : 403, access === 'available' ? { rows: [] } : { error: access });
          return;
        }
        sendJson(res, 404, {});
      } catch (error) {
        sendError(res, error, 'plans');
      }
    }, port);

    const { callbackUrl } = platform.hub.install(registration.appId, { store, scopes: ['plan.manage'] });
    await fetch(callbackUrl, { redirect: 'manual' });

    dashboard = await ExampleDashboard.start({
      hub: platform.hub,
      appId: registration.appId,
      appName: 'Plans',
      appUrl,
      store,
      pages: config.dashboard.pages,
      plans: config.plans,
      planCallback: config.planCallback,
    });
  });

  after(async () => {
    await dashboard.close();
    await app.close();
    await platform.close();
  });

  const open = (path: string) => fetch(`${dashboard.url}${path}`, { redirect: 'manual' });
  const frameUrl = (html: string) =>
    (JSON.parse(/<script type="application\/json" id="host-config">(.*?)<\/script>/s.exec(html)![1]) as { frameUrl: string }).frameUrl;
  const token = (role = 'owner') => platform.hub.sessionToken({ appId: 'app_plans', store, role });
  const call = (path: string, body: unknown, bearer = token()) =>
    fetch(`${app.url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('starts a store on the default plan, in its tokens and in what the app serves', async () => {
    assert.strictEqual(JSON.parse(Buffer.from(token().split('.')[1], 'base64url').toString()).plan, 'free');
    assert.strictEqual((await fetch(`${app.url}/api/reports`, { headers: { Authorization: `Bearer ${token()}` } })).status, 403);
  });

  it('opens an available page under its config title and marks the others locked', async () => {
    const html = await (await open('/apps/orders')).text();

    assert.strictEqual(frameUrl(html), `${app.url}/orders`);
    assert.match(html, /<h1 id="page-title">Order export<\/h1>/);
    assert.match(html, /Reports <span role="img" aria-label="Locked">/);
    assert.match(html, /Beta <span role="img" aria-label="Locked">/);
    assert.doesNotMatch(html, /Orders <span role="img" aria-label="Locked">/);
  });

  it('never frames a locked page: it frames where the page’s callback sends the merchant', async () => {
    const html = await (await open('/apps/reports')).text();

    assert.strictEqual(frameUrl(html), `${app.url}/upgrade?page=reports&reason=plan`);
    assert.match(html, /<h1 id="page-title">Sales reports<\/h1>/);
    assert.deepStrictEqual(asked.at(-1), { page: 'reports', reason: 'plan', store, plan: 'free' });
  });

  it('follows the app to a dashboard page, and shows its own notice for an answer it can’t follow or no callback', async () => {
    answer = { dashboard: '/admin/apps' };
    const redirected = await open('/apps/reports');
    assert.strictEqual(redirected.status, 302);
    assert.strictEqual(redirected.headers.get('location'), '/admin/apps');

    answer = { dashboard: '/admin?tab=plans' };
    assert.strictEqual((await open('/apps/reports')).headers.get('location'), '/admin?tab=plans');
    answer = { dashboard: '/admin/orders?search=a%20b' };
    assert.strictEqual((await open('/apps/reports')).headers.get('location'), '/admin/orders?search=a%20b');
    answer = { dashboard: '/admin/アプリ' };
    assert.strictEqual((await open('/apps/reports')).headers.get('location'), '/admin/%E3%82%A2%E3%83%97%E3%83%AA');

    for (const unusable of [
      { path: '//evil.example/x' },
      { path: 'https://evil.example/x' },
      { dashboard: '/admin/../x' },
      { dashboard: '/admin/..?x=1' },
      { dashboard: '/admin/%2e%2e/vendor' },
      { url: '/x' },
    ]) {
      answer = unusable;
      assert.match(await (await open('/apps/reports')).text(), /Sales reports isn’t available right now/);
    }
    answer = null;

    const before = asked.length;
    assert.match(await (await open('/apps/beta')).text(), /has switched this page off for now/);
    // A sub-page with no conditions of its own is locked with its parent.
    assert.match(await (await open('/apps/beta-notes')).text(), /has switched this page off for now/);
    assert.strictEqual(asked.length, before);

    // Its own plans don't make the reason "plan": no upgrade could open a page under one that is switched off.
    await open('/apps/beta-pro');
    assert.deepStrictEqual(asked.at(-1), { page: 'beta-pro', reason: 'inactive', store, plan: platform.hub.planOf('app_plans', store) });
  });

  it('asks the plan callback where to send the owner, and changes nothing itself', async () => {
    const html = await (await open('/plan-change?plan=pro&role=owner')).text();

    assert.strictEqual(frameUrl(html), `${app.url}/plans?to=pro`);
    assert.deepStrictEqual(asked.at(-1), { plan: 'pro', currentPlan: 'free' });

    // The current plan is the signed token's: what a caller writes in the body counts for nothing.
    await call('/callbacks/plan', { plan: 'pro', currentPlan: 'pro' });
    assert.deepStrictEqual(asked.at(-1), { plan: 'pro', currentPlan: 'free' });
    assert.strictEqual(platform.hub.planOf('app_plans', store), 'free');
    assert.strictEqual((await open('/plan-change?plan=pro&role=admin')).status, 403);
    // The app refuses it too, should anyone but the owner call its plan callback directly.
    assert.strictEqual((await call('/callbacks/plan', { plan: 'pro' }, token('admin'))).status, 403);
    assert.strictEqual((await open('/plan-change?plan=gold&role=owner')).status, 403);
  });

  it('lets the app set the plan with its own token, which unlocks the page everywhere', async () => {
    assert.strictEqual((await call('/api/plan', { plan: 'pro' })).status, 200);

    assert.strictEqual(platform.hub.planOf('app_plans', store), 'pro');
    assert.strictEqual(frameUrl(await (await open('/apps/reports')).text()), `${app.url}/reports`);
    assert.strictEqual((await fetch(`${app.url}/api/reports`, { headers: { Authorization: `Bearer ${token()}` } })).status, 200);
  });

  it('refuses a plan the app doesn’t declare, a user access token, and an app without plan.manage', async () => {
    assert.strictEqual((await call('/api/plan', { plan: 'gold' })).status >= 400, true);
    assert.strictEqual(platform.hub.planOf('app_plans', store), 'pro');

    const { access_token: userToken } = (await (
      await fetch(`${platform.store.url}/api/v1/apps/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: token() }),
      })
    ).json()) as { access_token: string };
    const asUser = await fetch(`${platform.store.url}/api/v1/app-installation/plan`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'free' }),
    });
    assert.strictEqual(asUser.status, 403);

    platform.hub.install('app_plans', { store, scopes: ['plan.manage'] });
    assert.strictEqual(platform.hub.planOf('app_plans', store), 'pro', 'approving permissions again keeps the plan');

    platform.hub.uninstall('app_plans', store);
    platform.hub.install('app_plans', { store, scopes: ['plan.manage'] });
    assert.strictEqual(platform.hub.planOf('app_plans', store), 'free', 'coming back after a removal starts on the default plan');
  });

  it('refuses a callback that is not FlyCommerce asking, or names a plan the app lacks', async () => {
    assert.strictEqual((await call('/callbacks/reports-locked', { page: 'reports', reason: 'plan' }, 'forged')).status, 401);
    assert.strictEqual((await call('/callbacks/reports-locked', { page: 'reports', reason: 'whim' })).status, 400);
    assert.strictEqual((await call('/callbacks/plan', { plan: 'gold' })).status, 400);
    assert.strictEqual((await call('/callbacks/plan', null)).status, 400);
    assert.strictEqual((await call('/callbacks/reports-locked', null)).status, 400);
  });

  it('falls back to the default when the app drops a store’s plan', () => {
    platform.hub.setPlan('app_plans', store, 'pro');
    platform.hub.declarePlans('app_plans', [{ key: 'free', default: true }]);
    assert.strictEqual(platform.hub.planOf('app_plans', store), 'free');
    platform.hub.declarePlans('app_plans', config.plans ?? []);
  });

  it('offers no plan switch on a store that never let the app set its plan', async () => {
    platform.hub.install('app_plans', { store, scopes: [] });

    try {
      assert.doesNotMatch(await (await open('/apps/orders')).text(), /href="\/plan-change\?/);
      assert.strictEqual((await open('/plan-change?plan=pro&role=owner')).status, 403);
    } finally {
      platform.hub.install('app_plans', { store, scopes: ['plan.manage'] });
    }

    assert.match(await (await open('/apps/orders')).text(), /href="\/plan-change\?/);
  });

  it('refuses every plan for an app that declares none, as FlyCommerce does', async () => {
    const none = await startFakePlatform({ appId: 'app_none', appSecret: 's', redirectUri: 'http://127.0.0.1:9/cb' });

    try {
      none.hub.install('app_none', { store, scopes: ['plan.manage'] });
      assert.strictEqual(none.hub.setPlan('app_none', store, 'pro'), false);
      assert.strictEqual(none.hub.planOf('app_none', store), null);
    } finally {
      await none.close();
    }
  });

  it('refuses an undeclared plan from the registration alone, with no dashboard running', async () => {
    const bare = await startFakePlatform({
      appId: 'app_bare',
      appSecret: 's',
      redirectUri: 'http://127.0.0.1:9/cb',
      plans: [{ key: 'pro' }, { key: 'free', default: true }],
    });

    try {
      bare.hub.install('app_bare', { store, scopes: ['plan.manage'] });
      assert.strictEqual(bare.hub.planOf('app_bare', store), 'free', 'the default, wherever it is listed');
      assert.strictEqual(bare.hub.setPlan('app_bare', store, 'gold'), false);
      assert.strictEqual(bare.hub.setPlan('app_bare', store, 'pro'), true);
    } finally {
      await bare.close();
    }
  });
});
