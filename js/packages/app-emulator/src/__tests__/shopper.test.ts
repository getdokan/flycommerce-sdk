import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { IncomingMessage } from 'node:http';
import { verifySessionToken, verifyShopperToken, clearJwksCache } from '@flycommerce/app-bridge/server';
import { HubClient, MemoryCredentialStore, StoreApi, StoreApiError, authenticateShopper } from '@flycommerce/app-server';
import { ExampleDashboard } from '../dashboard.js';
import { FakePlatform, startFakePlatform } from '../platform.js';

const app = { appId: 'app_shopper', appSecret: 'secret_shopper', redirectUri: 'http://127.0.0.1:1/auth/callback' };
const domain = 'tea.flycom.shop';

/** A shopping assistant's path through the emulator: find products, know the shopper, read their orders. */
describe('the emulator for storefront apps', () => {
  let platform: FakePlatform;
  let hubClient: HubClient;
  let storeApi: StoreApi;
  let credentials: MemoryCredentialStore;
  let dashboard: ExampleDashboard;

  before(async () => {
    platform = await startFakePlatform(app);
    hubClient = new HubClient({ hubApiUrl: platform.hub.apiUrl, ...app });
    credentials = new MemoryCredentialStore();
    storeApi = new StoreApi({ credentials, storeUrl: () => platform.store.url }, hubClient);

    const store = platform.store.store(domain);
    store.addProduct({ title: 'Green tea', price: 8, description: 'Loose leaf, from Darjeeling' });
    store.addProduct({ title: 'Green tea bags', price: 5 });
    store.addProduct({ title: 'Blue mug', price: 12, description: 'Holds a pot of tea' });
    store.addProduct({ title: 'Hidden kettle', status: 'draft' });
    store.addOrder({ customerId: 501, total: 30 });
    store.addOrder({ customerId: 502, total: 40 });

    dashboard = await ExampleDashboard.start({
      hub: platform.hub,
      appId: app.appId,
      appName: 'Shop assistant',
      appUrl: 'http://127.0.0.1:4700',
      store: domain,
      pages: [],
      scripts: [{ handle: 'bubble', src: '/bubble.js' }],
      products: store.productList,
      customerId: 501,
    });
  });

  after(async () => {
    clearJwksCache();
    await dashboard.close();
    await platform.close();
  });

  const install = async (scopes: string[]) => {
    const { code } = platform.hub.install(app.appId, { store: domain, scopes });
    const { store, credential } = await hubClient.exchangeCode(code);
    credentials.put(store, credential);
    hubClient.forget(store);
    return storeApi.asApp(store);
  };

  const verify = (token: string) =>
    verifyShopperToken(token, { appId: app.appId, jwksUrl: platform.hub.jwksUrl, allowedIssuers: [platform.hub.issuer] });

  it('finds products by name in the listing, and ranks them in the search', async () => {
    const store = await install(['catalog.read']);

    const listed = await store.get<{ data: { title: string }[] }>('/api/v1/products', { search: 'green' });
    const ranked = await store.get<{ data: { title: string }[]; meta: { total: number } }>('/api/v1/search/products', {
      search: 'green tea',
    });

    assert.deepStrictEqual(
      listed.data.map((product) => product.title),
      ['Green tea', 'Green tea bags']
    );
    assert.deepStrictEqual(
      ranked.data.map((product) => product.title),
      ['Green tea', 'Green tea bags', 'Blue mug']
    );
    assert.strictEqual(ranked.meta.total, 3, 'a draft product is never found');
  });

  it('needs catalog.read to search, and refuses a filter the store does not know', async () => {
    const withoutCatalog = await install(['orders.read']);
    await assert.rejects(
      withoutCatalog.get('/api/v1/search/products', { search: 'tea' }),
      (error: StoreApiError) => error.upstreamStatus === 403
    );

    const store = await install(['catalog.read', 'orders.read']);
    await assert.rejects(store.get('/api/v1/orders', { 'filters[customer]': 501 }), (error: StoreApiError) => error.upstreamStatus === 400);
    await assert.rejects(
      store.get('/api/v1/orders', { 'filter[customerId]': 501 }),
      (error: StoreApiError) => error.upstreamStatus === 400
    );
  });

  it("reads one customer's orders, as the real store filters them", async () => {
    const store = await install(['orders.read']);

    const { data } = await store.get<{ data: { customerId: number }[] }>('/api/v1/orders', { 'filters[customerId]': 501 });

    assert.deepStrictEqual(
      data.map((order) => order.customerId),
      [501]
    );
  });

  it('names the customer in a shopper token only when the app was granted storefront.customer', async () => {
    await install(['catalog.read']);
    const without = await verify(platform.hub.shopperToken({ appId: app.appId, store: domain, customerId: 501 }));

    await install(['catalog.read', 'storefront.customer']);
    const granted = await verify(platform.hub.shopperToken({ appId: app.appId, store: domain, customerId: 501 }));
    const guest = await verify(platform.hub.shopperToken({ appId: app.appId, store: domain }));

    assert.deepStrictEqual([without.signed_in, without.customer_id], [true, null]);
    assert.deepStrictEqual([granted.signed_in, granted.customer_id, granted.store_domain], [true, 501, domain]);
    assert.deepStrictEqual([guest.signed_in, guest.customer_id], [false, null]);
  });

  it('keeps shopper and session tokens apart', async () => {
    const shopper = platform.hub.shopperToken({ appId: app.appId, store: domain, customerId: 501 });
    const session = platform.hub.sessionToken({ appId: app.appId, store: domain });
    const options = { appId: app.appId, jwksUrl: platform.hub.jwksUrl, allowedIssuers: [platform.hub.issuer] };

    await assert.rejects(verifySessionToken(shopper, options), /Expected 'session'/);
    await assert.rejects(verifyShopperToken(session, options), /Expected 'shopper'/);
    await assert.rejects(verifyShopperToken(shopper, { ...options, appId: 'someone_else' }));
  });

  it("gives the store page's script a shopper token for its own app, from the same origin only", async () => {
    await install(['catalog.read', 'storefront.customer']);
    const ask = (appId: string, query = '', headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' }) =>
      fetch(`${dashboard.url}/apps/${appId}/shopper-token${query}`, { method: 'POST', headers });

    const signedIn = await ask(app.appId, '?shopper=customer');
    const guest = await ask(app.appId);

    assert.strictEqual((await verify((await signedIn.json()).token)).customer_id, 501);
    assert.strictEqual((await verify((await guest.json()).token)).signed_in, false);
    assert.strictEqual((await ask('app_elsewhere')).status, 404);
    assert.strictEqual((await ask(app.appId, '', {})).status, 403);
  });

  it("verifies the shopper on the app's server with authenticateShopper", async () => {
    await install(['catalog.read', 'storefront.customer']);
    const config = { appId: app.appId, jwksUrl: platform.hub.jwksUrl, allowedIssuers: [platform.hub.issuer] };
    const request = (authorization?: string) => ({ headers: authorization ? { authorization } : {} }) as IncomingMessage;
    const token = platform.hub.shopperToken({ appId: app.appId, store: domain, customerId: 501 });

    const shopper = await authenticateShopper(request(`Bearer ${token}`), config);

    assert.deepStrictEqual([shopper.store, shopper.signedIn, shopper.customerId], [domain, true, 501]);
    await assert.rejects(authenticateShopper(request(), config), /missing_shopper_token/);
    await assert.rejects(authenticateShopper(request('Bearer not.a.token'), config), /The shopper token is not valid/);
  });

  it('runs the store actions on its example page: cart, Undo, events and the shopper switch', async () => {
    const page = await (await fetch(`${dashboard.url}/storefront`)).text();

    assert.match(page, /Object\.assign\(window\.FlyCommerce, \{/);
    assert.match(page, /'cart\.add': \{/);
    assert.match(page, /new CustomEvent\('flycommerce:cart:updated', \{ detail \}\)/);
    assert.match(page, /<select id="shopper">.*Signed in, customer #501/);
    assert.match(page, /<script type="application\/json" id="store-products">\[\{"id":"01PRODUCT1","title":"Green tea"/);
  });
});
