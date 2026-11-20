import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { storefrontPage } from '../storefront-page.js';

// Values made inside the page's own context: compare their contents, not their prototypes.
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

type Run = (
  name: string,
  input?: unknown
) => Promise<{ ok: boolean; result?: any; error?: string; reason?: string; details?: Record<string, number> }>;

/** Runs the example store's own page script against a stand-in document, and hands back what an app script would see. */
function openStore() {
  const html = storefrontPage({
    appId: 'chat-app',
    appName: 'Chat',
    store: 'demo.flycom.shop',
    scripts: [],
    locale: 'en',
    currency: 'USD',
    products: [{ id: 'tea', title: 'Green tea', slug: 'green-tea', price: 12.5 }],
  });

  const blocks = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  const data = new Map(blocks.map(([, attributes, body]) => [/id="([^"]+)"/.exec(attributes)?.[1], body]));
  const elements = new Map<string, any>();
  const element = (id?: string): any => ({
    textContent: (id && data.get(id)) || '',
    value: 'guest',
    children: [] as any[],
    append(child: any) {
      this.children.push(child);
    },
    addEventListener() {},
  });
  const events: any[] = [];
  const window: any = { addEventListener() {}, dispatchEvent: (event: any) => events.push(event.detail) };
  const document = {
    body: element(),
    getElementById: (id: string) => elements.get(id) ?? elements.set(id, element(id)).get(id),
    createElement: () => element(),
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    window,
    document,
    setTimeout: () => 0,
    CustomEvent: class {
      constructor(
        readonly type: string,
        readonly init: { detail: unknown }
      ) {}
      get detail() {
        return this.init.detail;
      }
    },
  });

  for (const [, attributes, body] of blocks) {
    if (!attributes.includes('application/json')) vm.runInContext(body, context);
  }

  const undo = () => elements.get('notice').children.at(-1).onclick();

  return { run: window.FlyCommerce.run as Run, events, undo };
}

describe("the example storefront's coupon actions", () => {
  it('applies a coupon to the cart, and Undo takes it off', async () => {
    const store = openStore();
    await store.run('cart.add', { items: [{ productId: 'tea', quantity: 2 }] });

    const applied = await store.run('cart.applyCoupon', { code: 'SAVE10' });

    assert.deepEqual(
      { ok: applied.ok, subtotal: applied.result.subtotal, discount: applied.result.discount, total: applied.result.total },
      { ok: true, subtotal: 25, discount: 2.5, total: 22.5 }
    );
    assert.deepEqual(plain(applied.result.coupons), [{ code: 'SAVE10', discount: 2.5 }]);
    assert.equal(applied.result.currency, 'USD');

    store.undo();
    assert.deepEqual(plain(store.events.at(-1).coupons), []);
    assert.equal((await store.run('cart.get')).result.total, 25);
  });

  it('says why it refuses a code, the way a store does', async () => {
    const store = openStore();
    assert.equal((await store.run('cart.applyCoupon', { code: 'SAVE10' })).reason, 'empty_cart');

    await store.run('cart.add', { items: [{ productId: 'tea', quantity: 1 }] });

    const reasons = [];
    for (const code of ['save10', 'SUMMER', 'BIG20']) reasons.push((await store.run('cart.applyCoupon', { code })).reason);
    assert.deepEqual(reasons, ['invalid', 'expired', 'below_minimum']);

    assert.deepEqual(plain((await store.run('cart.applyCoupon', { code: 'BIG20' })).details), { minimum: 50, shortfall: 37.5 });
    assert.equal((await store.run('cart.removeCoupon', { code: 'SAVE10' })).reason, 'not_applied');
    assert.equal((await store.run('cart.applyCoupon', { code: '../cart' })).ok, false);
    assert.equal((await store.run('cart.removeCoupon', { code: '..' })).error, 'Invalid input for cart.removeCoupon.');
  });
});
