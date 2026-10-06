import { escapeHtml } from './net.js';

export interface StorefrontScriptConfig {
  handle: string;
  src: string;
  load?: 'interactive' | 'idle';
}

export interface StorefrontPageConfig {
  appId: string;
  appName: string;
  store: string;
  scripts: StorefrontScriptConfig[];
  locale: string;
  currency: string;
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
<header><strong>${escapeHtml(config.store)}</strong>${buttons}<a href="/">Dashboard</a></header>
<main>
  <h1 id="page-title">${escapeHtml(PAGES[0].title)}</h1>
  <p class="note">An example store page running ${escapeHtml(config.appName)}'s storefront scripts, as a real store's catalogue pages do. The buttons stand in for client-side navigation.</p>
  <ol id="script-log"></ol>
</main>
<script type="application/json" id="store-config">${json({ app: config.appId, scripts: config.scripts })}</script>
<script>${STORE_SCRIPT}</script>
</body>
</html>`;
}
