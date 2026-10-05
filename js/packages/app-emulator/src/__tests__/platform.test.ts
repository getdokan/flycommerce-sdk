import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { verifySessionToken, clearJwksCache } from '@flycommerce/app-bridge/server';
import { HttpError, HubClient, MemoryCredentialStore, StoreApi, reconcileWebhook } from '@flycommerce/app-server';
import { ExampleDashboard } from '../dashboard.js';
import { readBody, sendJson, serve } from '../net.js';
import { FakePlatform, startFakePlatform } from '../platform.js';
import { FakeStore } from '../store.js';

const app = { appId: 'app_reference', appSecret: 'secret_reference', redirectUri: 'http://127.0.0.1:1/auth/callback' };
const other = { appId: 'app_other', appSecret: 'secret_other', redirectUri: 'http://127.0.0.1:2/auth/callback' };
const domain = 'alpha.flycom.shop';

describe('the fake platform', () => {
  let platform: FakePlatform;
  let hubClient: HubClient;
  let storeApi: StoreApi;
  let credentials: MemoryCredentialStore;

  before(async () => {
    platform = await startFakePlatform(app);
    hubClient = new HubClient({ hubApiUrl: platform.hub.apiUrl, ...app });
    credentials = new MemoryCredentialStore();
    storeApi = new StoreApi({ credentials, storeUrl: () => platform.store.url }, hubClient);
  });

  after(async () => {
    clearJwksCache();
    await platform.close();
  });

  const install = async (scopes: string[]) => {
    const { code } = platform.hub.install(app.appId, { store: domain, scopes });
    const { store, credential } = await hubClient.exchangeCode(code);
    credentials.put(store, credential);
    hubClient.forget(store);
    return store;
  };

  it('exchanges an install code once, for the store the merchant installed on', async () => {
    const { code } = platform.hub.install(app.appId, { store: domain, scopes: ['orders.read'] });

    const { store, credential } = await hubClient.exchangeCode(code);

    assert.strictEqual(store, domain);
    assert.strictEqual(credential.scope, 'orders.read');
    await assert.rejects(hubClient.exchangeCode(code), /invalid_grant/);
  });

  it('refuses a code presented by another app or to another redirect', async () => {
    const { code } = platform.hub.install(app.appId, { store: domain, scopes: ['orders.read'] });

    await assert.rejects(
      new HubClient({ hubApiUrl: platform.hub.apiUrl, ...app, appSecret: 'wrong' }).exchangeCode(code),
      /invalid_client/
    );
    await assert.rejects(
      new HubClient({ hubApiUrl: platform.hub.apiUrl, ...app, redirectUri: 'http://evil.test/cb' }).exchangeCode(code),
      /invalid_grant/
    );
  });

  it('signs session tokens the SDK verifies, with the role asked for', async () => {
    const token = platform.hub.sessionToken({ appId: app.appId, store: domain, userId: '42', role: 'admin' });

    const session = await verifySessionToken(token, {
      appId: app.appId,
      jwksUrl: platform.hub.jwksUrl,
      allowedIssuers: [platform.hub.issuer],
    });

    assert.strictEqual(session.store_domain, domain);
    assert.strictEqual(session.sub, '42');
    assert.strictEqual(session.user_role, 'admin');
    await assert.rejects(
      verifySessionToken(token, { appId: 'someone_else', jwksUrl: platform.hub.jwksUrl, allowedIssuers: [platform.hub.issuer] })
    );
  });

  it('serves orders the way the real API does: relations only when included, pages only when asked for', async () => {
    const store = await install(['orders.read']);
    const fixture = platform.store.store(domain);
    fixture.orderList.length = 0;
    const first = fixture.addOrder({ email: 'nadia@example.test' });
    const second = fixture.addOrder();

    const unpaged = await storeApi.asApp(store).get<{ data: any[]; meta?: any }>('/api/v1/orders', { limit: 1, page: 2 });
    const bare = await storeApi.asApp(store).get<{ data: any[]; meta: any }>('/api/v1/orders', { limit: 1, paginate: 'full' });
    const included = await storeApi.asApp(store).get<{ data: any[] }>(`/api/v1/orders/${first.id}`, { include: 'lineItems,orderGroup' });

    assert.strictEqual(bare.data[0].id, second.id);
    assert.strictEqual(bare.data[0].orderGroup, undefined, 'the order group is a relation, absent unless asked for');
    assert.deepStrictEqual(bare.meta, { currentPage: 1, lastPage: 2, perPage: 1, total: 2 });
    assert.strictEqual(unpaged.meta, undefined, 'without paginate=full the store ignores page and sends no meta');
    assert.strictEqual(unpaged.data[0].id, second.id);
    assert.strictEqual((included.data as any).orderGroup.customerInfo.email, 'nadia@example.test');
    assert.strictEqual((included.data as any).billingAddress.email, null);
  });

  it('refuses what the merchant did not grant, in the store’s own words', async () => {
    const store = await install(['orders.read']);
    const order = platform.store.store(domain).addOrder();

    await assert.rejects(storeApi.asApp(store).request('PATCH', `/api/v1/orders/${order.id}/on-hold`), (error: HttpError) => {
      assert.strictEqual(error.code, 'store_refused');
      assert.match(error.message, /not been granted orders\.write/);
      return true;
    });
  });

  it('holds only orders that can be held', async () => {
    const store = await install(['orders.read', 'orders.write']);
    const fixture = platform.store.store(domain);
    const open = fixture.addOrder({ status: 'processing' });
    const done = fixture.addOrder({ status: 'completed' });

    await storeApi.asApp(store).request('PATCH', `/api/v1/orders/${open.id}/on-hold`);

    assert.strictEqual(fixture.order(open.id)?.status, 'on_hold');
    await assert.rejects(
      storeApi.asApp(store).request('PATCH', `/api/v1/orders/${done.id}/on-hold`),
      /cannot be put on hold while it is completed/
    );
  });

  it('lets an app manage only its own webhooks, and signs deliveries with the secret it returned once', async () => {
    const store = await install(['webhooks.manage']);
    const fixture = platform.store.store(domain);
    fixture.webhookList.push({
      id: 999,
      appId: other.appId,
      endpoint: 'http://127.0.0.1:9/other',
      description: '',
      status: 'enabled',
      events: ['order.created'],
      secret: 'theirs',
    });

    let received: { body: string; signature: string } | null = null;
    const receiver = await serve(async (req, res) => {
      received = { body: await readBody(req), signature: String(req.headers['x-webhook-signature']) };
      sendJson(res, 200, {});
    });

    const created = await storeApi.asApp(store).request<{ data: { id: number; secret: string } }>('POST', '/api/v1/integrations/webhooks', {
      body: { endpoint: `${receiver.url}/hooks`, events: ['order.created'], description: 'test', status: 'enabled' },
    });
    const listed = await storeApi.asApp(store).get<{ data: any[] }>('/api/v1/integrations/webhooks');

    assert.deepStrictEqual(
      listed.data.map((webhook) => webhook.id),
      [created.data.id],
      'another app’s subscription stays hidden'
    );
    assert.ok(
      listed.data.every((webhook) => !('secret' in webhook)),
      'secrets are not listed'
    );

    const order = fixture.addOrder();
    await platform.store.deliver(domain, 'order.created', FakeStore.rawOrder(order));
    await receiver.close();

    const expected = crypto.createHmac('sha256', created.data.secret).update(received!.body).digest('hex');
    assert.strictEqual(received!.signature, expected);
    const delivery = JSON.parse(received!.body);
    assert.strictEqual(delivery.event, 'order.created');
    assert.ok(!Number.isNaN(Date.parse(delivery.timestamp)));
    assert.deepStrictEqual([delivery.data.id, delivery.data.total, delivery.data.status], [order.id, order.total.toFixed(2), 2]);
    await assert.rejects(storeApi.asApp(store).request('DELETE', '/api/v1/integrations/webhooks/999'), /Webhook not found/);
  });

  it('suspends deliveries while the app is uninstalled and resumes them on reinstall', async () => {
    const store = await install(['orders.read', 'webhooks.manage']);
    const bodies: string[] = [];
    const receiver = await serve(async (req, res) => {
      bodies.push(await readBody(req));
      sendJson(res, 200, {});
    });
    await storeApi.asApp(store).request('POST', '/api/v1/integrations/webhooks', {
      body: { endpoint: receiver.url, events: ['order.created'], description: 'test', status: 'enabled' },
    });
    const order = () => FakeStore.rawOrder(platform.store.store(domain).addOrder());

    try {
      platform.hub.uninstall(app.appId, domain);
      assert.deepStrictEqual(await platform.store.deliver(domain, 'order.created', order()), [], 'nothing is sent while uninstalled');

      platform.hub.install(app.appId, { store: domain, scopes: ['orders.read', 'webhooks.manage'] });
      await platform.store.deliver(domain, 'order.created', order());
      assert.strictEqual(bodies.length, 1, 'reinstalling resumes it');
    } finally {
      await receiver.close();
    }
  });

  it('reconciles to exactly one subscription per endpoint, with a fresh secret', async () => {
    const store = await install(['webhooks.manage']);
    const client = storeApi.asApp(store);
    const endpoint = 'http://127.0.0.1:9/hooks?store=alpha.flycom.shop';

    const first = await reconcileWebhook(client, { endpoint, events: ['order.created'] });
    const second = await reconcileWebhook(client, { endpoint, events: ['order.created', 'order.updated'] });
    const mine = platform.store.store(domain).webhookList.filter((hook) => hook.endpoint === endpoint);

    assert.deepStrictEqual(
      mine.map((hook) => hook.id),
      [second.id]
    );
    assert.notStrictEqual(first.secret, second.secret);
    assert.strictEqual(mine[0].secret, second.secret);
    assert.deepStrictEqual(mine[0].events, ['order.created', 'order.updated']);
  });

  it('filters orders by when they were created or updated', async () => {
    const store = await install(['orders.read']);
    const fixture = platform.store.store(domain);
    const old = fixture.addOrder({ createdAt: '2026-01-01T00:00:00.000Z' });
    const recent = fixture.addOrder();
    const ids = async (query: Record<string, string>) =>
      ((await storeApi.asApp(store).get('/api/v1/orders', { ...query, limit: 100 })) as { data: { id: string }[] }).data.map((o) => o.id);

    const since = await ids({ 'filters[createdAt]': '2026-06-01T00:00:00Z' });
    assert.ok(since.includes(recent.id) && !since.includes(old.id), 'a bare date means since');

    const before = await ids({ 'filters[createdAt]': '<2026-06-01T00:00:00Z' });
    assert.ok(before.includes(old.id) && !before.includes(recent.id));
  });

  it('stops accepting the credential once the app is uninstalled', async () => {
    const store = await install(['orders.read']);
    await storeApi.asApp(store).get('/api/v1/orders');

    // No forget(): the app still holds a token the store accepted a moment ago.
    platform.hub.uninstall(app.appId, domain);

    await assert.rejects(storeApi.asApp(store).get('/api/v1/orders'), (error: HttpError) => {
      assert.strictEqual(error.code, 'installation_revoked');
      return true;
    });
  });

  it('lets an app act for a user only as far as that user may go, and only while they are logged in', async () => {
    const store = await install(['orders.read', 'orders.write']);
    const fixture = platform.store.store(domain);
    const dashboard = (userId: string, role: string, loginId?: string) => {
      const token = platform.hub.sessionToken({ appId: app.appId, store: domain, userId, role, loginId });
      return { store, token, session: JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) };
    };

    fixture.setTeamMember('11', { permissions: ['order.view'] });
    fixture.setTeamMember('12', { permissions: ['order.view', 'order.update'] });
    const viewer = storeApi.asUser(dashboard('11', 'admin'));
    const clerk = storeApi.asUser(dashboard('12', 'admin', 'clerk-laptop'));

    await assert.rejects(viewer.request('PATCH', `/api/v1/orders/${fixture.addOrder().id}/on-hold`), (error: HttpError) => {
      assert.strictEqual(error.code, 'store_refused');
      assert.match(error.message, /does not have the order\.update permission/);
      return true;
    });
    await clerk.request('PATCH', `/api/v1/orders/${fixture.addOrder().id}/on-hold`);
    await storeApi.asApp(store).request('PATCH', `/api/v1/orders/${fixture.addOrder().id}/on-hold`);

    assert.deepStrictEqual(
      platform.store.requests.slice(-2).map((request) => request.userId),
      ['12', null],
      'the store sees who acted'
    );

    platform.hub.logout({ store: domain, userId: '12', loginId: 'clerk-laptop' });
    await assert.rejects(clerk.get('/api/v1/orders'), (error: HttpError) => {
      assert.strictEqual(error.code, 'session_expired');
      return true;
    });

    const onPhone = storeApi.asUser(dashboard('12', 'admin', 'clerk-phone'));
    await onPhone.get('/api/v1/orders');
  });

  it('frames the app in a dashboard that issues session tokens for the chosen role', async () => {
    const dashboard = await ExampleDashboard.start({
      hub: platform.hub,
      appId: app.appId,
      appName: 'Reference',
      appUrl: 'http://127.0.0.1:4600',
      store: domain,
      pages: [{ label: 'Overview', slug: 'overview' }],
    });

    const page = await (await fetch(`${dashboard.url}/apps/overview`)).text();
    const missing = await fetch(`${dashboard.url}/apps/nope`);
    const issued = (await (await fetch(`${dashboard.url}/session-token?role=admin`, { method: 'POST' })).json()) as {
      session_token: string;
    };
    const session = await verifySessionToken(issued.session_token, {
      appId: app.appId,
      jwksUrl: platform.hub.jwksUrl,
      allowedIssuers: [platform.hub.issuer],
    });
    await dashboard.close();

    assert.match(page, /sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-modals allow-downloads"/);
    assert.ok(!page.includes('allow-top-navigation'), 'an app can never take over the dashboard tab');
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(session.user_role, 'admin');
  });
});
