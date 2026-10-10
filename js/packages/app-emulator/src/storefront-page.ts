import { escapeHtml } from './net.js';

export interface StorefrontScriptConfig {
  handle: string;
  src: string;
  load?: 'interactive' | 'idle';
}

/** A product the example store can put in its cart. */
export interface StorefrontProduct {
  id: string;
  title: string;
  slug: string;
  price: number;
}

export interface StorefrontPageConfig {
  appId: string;
  appName: string;
  store: string;
  scripts: StorefrontScriptConfig[];
  locale: string;
  currency: string;
  products?: StorefrontProduct[];
  /** The customer a "Signed in" shopper is, for shopper tokens. */
  customerId?: number;
}

const PAGES = [
  { pageType: 'home', path: '/', title: 'Home' },
  { pageType: 'product', path: '/products/green-tea', title: 'Green tea' },
];

// Mirrors the storefront: context first, then interactive scripts once the page is usable, idle ones after load.
const STORE_SCRIPT = String.raw`
const config = JSON.parse(document.getElementById('store-config').textContent);
const log = document.getElementById('script-log');

const record = (line) => {
  const entry = document.createElement('li');
  entry.textContent = line;
  log.append(entry);
};

const add = (script) => {
  const element = document.createElement('script');
  element.id = 'app-' + config.app + '-' + script.handle;
  element.src = script.src;
  element.onload = () => record('loaded ' + script.handle);
  element.onerror = () => record('failed ' + script.handle + ' (' + script.src + ')');
  document.body.append(element);
};

const load = (when) => config.scripts.filter((script) => (script.load || 'idle') === when).forEach(add);

// window.FlyCommerce.run(): the store's actions, here on an in-page cart, with the store's limits and Undo.
const products = JSON.parse(document.getElementById('store-products').textContent);
const cart = [];
const changes = [];
const key = (line) => line.productId + ':' + (line.variationId || '');
const productName = (id) => (products.find((product) => product.id === id) || {}).title || id;
const priceOf = (id) => (products.find((product) => product.id === id) || {}).price || 0;
const summary = () => {
  const lines = cart.map((line) => ({ ...line, name: productName(line.productId), unitPrice: priceOf(line.productId), total: priceOf(line.productId) * line.quantity }));
  return { lines, count: lines.reduce((sum, line) => sum + line.quantity, 0), subtotal: lines.reduce((sum, line) => sum + line.total, 0) };
};
const quantityOf = (line) => (cart.find((candidate) => key(candidate) === key(line)) || { quantity: 0 }).quantity;
const setQuantity = (line, quantity) => {
  const index = cart.findIndex((candidate) => key(candidate) === key(line));
  if (quantity === 0) { if (index >= 0) cart.splice(index, 1); }
  else if (index >= 0) cart[index].quantity = quantity;
  else cart.push({ productId: line.productId, variationId: line.variationId, quantity });
};
const drawCart = () => {
  const now = summary();
  document.getElementById('cart-count').textContent = String(now.count);
  document.getElementById('cart-lines').innerHTML = '';
  now.lines.forEach((line) => {
    const item = document.createElement('li');
    item.textContent = line.quantity + ' × ' + line.name;
    document.getElementById('cart-lines').append(item);
  });
};
const changed = () => {
  drawCart();
  const detail = summary();
  record('flycommerce:cart:updated ' + JSON.stringify({ count: detail.count, subtotal: detail.subtotal }));
  window.dispatchEvent(new CustomEvent('flycommerce:cart:updated', { detail }));
  return detail;
};
const announce = (message, before) => {
  const notice = document.getElementById('notice');
  notice.textContent = message + ' ';
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.textContent = 'Undo';
  undo.onclick = () => { cart.splice(0, cart.length, ...before); notice.textContent = 'Undone.'; changed(); };
  notice.append(undo);
  record('announced: ' + message);
};
const line = (input) => typeof input.productId === 'string' && input.productId && (input.variationId === undefined || typeof input.variationId === 'string');
const quantity = (value) => Number.isInteger(value) && value >= 1 && value <= 10;
const ACTIONS = {
  'cart.get': { changes: false, description: "Read the shopper's cart: each line's product, quantity and price, the item count and the subtotal.", valid: () => true, run: () => summary() },
  'cart.add': {
    changes: true,
    description: "Add products to the shopper's cart. Quantities add to what is already there.",
    valid: (input) => Array.isArray(input.items) && input.items.length >= 1 && input.items.length <= 10 && input.items.every((item) => line(item) && quantity(item.quantity)),
    run: (input) => {
      const before = cart.map((entry) => ({ ...entry }));
      input.items.forEach((item) => setQuantity(item, quantityOf(item) + item.quantity));
      const count = input.items.reduce((sum, item) => sum + item.quantity, 0);
      announce('Added ' + count + (count === 1 ? ' item' : ' items') + ' to your cart', before);
      return changed();
    },
  },
  'cart.update': {
    changes: true,
    description: 'Set the quantity of one line already in the cart.',
    valid: (input) => line(input) && quantity(input.quantity),
    run: (input) => {
      if (!quantityOf(input)) throw new Error('That product is not in the cart.');
      const before = cart.map((entry) => ({ ...entry }));
      setQuantity(input, input.quantity);
      announce('Your cart was updated', before);
      return changed();
    },
  },
  'cart.remove': {
    changes: true,
    description: 'Remove one line from the cart.',
    valid: line,
    run: (input) => {
      if (!quantityOf(input)) throw new Error('That product is not in the cart.');
      const before = cart.map((entry) => ({ ...entry }));
      setQuantity(input, 0);
      announce('Removed ' + productName(input.productId) + ' from your cart', before);
      return changed();
    },
  },
  'nav.goto': {
    changes: false,
    description: 'Take the shopper to a product, collection or category by its slug, or to the cart page.',
    valid: (input) => input.to === 'cart' || (['product', 'collection', 'category'].includes(input.to) && /^[^/?#\s]{1,200}$/.test(input.slug || '')),
    run: (input) => {
      const path = input.to === 'cart' ? '/cart' : '/' + { product: 'products', collection: 'collections', category: 'categories' }[input.to] + '/' + encodeURIComponent(input.slug);
      document.getElementById('page-title').textContent = path;
      record('nav.goto ' + path);
      return null;
    },
  },
  'ui.openCart': { changes: false, description: 'Open the cart drawer.', valid: () => true, run: () => { document.getElementById('cart').open = true; return null; } },
};

Object.assign(window.FlyCommerce, {
  async run(name, input = {}) {
    const action = Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null;
    if (!action) return { ok: false, error: 'Unknown action: ' + name + '.' };
    if (!action.valid(input || {})) return { ok: false, error: 'Invalid input for ' + name + '.' };
    if (action.changes) {
      while (changes.length && changes[0] <= Date.now() - 60000) changes.shift();
      if (changes.length >= 10) return { ok: false, error: 'Too many cart changes. Try again in a minute.' };
      changes.push(Date.now());
    }
    try { return { ok: true, result: action.run(input || {}) }; } catch (error) { return { ok: false, error: error.message }; }
  },
  can: (name) => Object.hasOwn(ACTIONS, name),
  actions: () => Object.entries(ACTIONS).map(([name, action]) => ({ name, description: action.description, changes: action.changes })),
  // As on a store: POST to the page's own origin, which signs a token for that app and the shopper signed in.
  async shopperToken(appId) {
    const shopper = document.getElementById('shopper').value;
    try {
      const response = await fetch('/apps/' + encodeURIComponent(appId) + '/shopper-token?shopper=' + shopper, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (!response.ok) return null;
      return (await response.json()).token || null;
    } catch { return null; }
  },
});

load('interactive');
window.addEventListener('load', () => {
  const idle = () => load('idle');
  if ('requestIdleCallback' in window) requestIdleCallback(idle); else setTimeout(idle, 0);
});

document.querySelectorAll('[data-page-type]').forEach((button) => button.addEventListener('click', () => {
  const detail = { pageType: button.dataset.pageType, path: button.dataset.path };
  document.getElementById('page-title').textContent = button.textContent;
  document.querySelectorAll('[data-page-type]').forEach((other) => other.setAttribute('aria-current', String(other === button)));
  record('flycommerce:page ' + JSON.stringify(detail));
  window.dispatchEvent(new CustomEvent('flycommerce:page', { detail }));
}));
`;

const STORE_STYLES = `
* { box-sizing:border-box; }
body { margin:0; font:15px/1.5 system-ui,sans-serif; background:#fff; color:#0f1729; }
header { display:flex; gap:12px; align-items:center; padding:14px 24px; border-bottom:1px solid #e3e5ea; flex-wrap:wrap; }
header strong { flex:1; }
header button { font:inherit; padding:6px 12px; border-radius:8px; border:1px solid #e3e5ea; background:#fff; cursor:pointer; }
header button[aria-current="true"] { background:#0f1729; border-color:#0f1729; color:#fff; }
main { padding:24px; max-width:960px; margin:0 auto; }
.note { color:#5b6478; }
#script-log { font-family:ui-monospace,monospace; font-size:12px; color:#5b6478; padding-inline-start:18px; }
#notice { min-height:1.5em; }
#notice button, #cart summary { font:inherit; cursor:pointer; }
label, select { font:inherit; }
`;

export function storefrontPage(config: StorefrontPageConfig): string {
  const context = { store: config.store, locale: config.locale, currency: config.currency, pageType: PAGES[0].pageType };
  // </script> inside JSON would end the tag early.
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');
  const buttons = PAGES.map(
    (page, index) =>
      `<button type="button" data-page-type="${page.pageType}" data-path="${page.path}" aria-current="${index === 0}">${escapeHtml(page.title)}</button>`
  ).join('');

  return `<!doctype html>
<html lang="${escapeHtml(config.locale)}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(config.store)} — Example storefront</title>
<style>${STORE_STYLES}</style>
<script>window.FlyCommerce = ${json(context)};</script>
</head>
<body>
<header><strong>${escapeHtml(config.store)}</strong>${buttons}<label>Shopper <select id="shopper"><option value="guest">Guest</option><option value="customer">Signed in, customer #${config.customerId ?? 1001}</option></select></label><a href="/">Dashboard</a></header>
<main>
  <h1 id="page-title">${escapeHtml(PAGES[0].title)}</h1>
  <p class="note">An example store page running ${escapeHtml(config.appName)}'s storefront scripts, as a real store's catalogue pages do. The buttons stand in for client-side navigation.</p>
  <p id="notice" role="status"></p>
  <details id="cart"><summary>Cart (<span id="cart-count">0</span>)</summary><ul id="cart-lines"></ul></details>
  <ol id="script-log"></ol>
</main>
<script type="application/json" id="store-config">${json({ app: config.appId, scripts: config.scripts })}</script>
<script type="application/json" id="store-products">${json(config.products ?? [])}</script>
<script>${STORE_SCRIPT}</script>
</body>
</html>`;
}
