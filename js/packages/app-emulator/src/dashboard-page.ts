import { escapeHtml } from './net.js';

/** A dashboard page from app-config.json. Without a path, it is served at /<slug>. */
export interface HostPageEntry {
  label: string;
  slug: string;
  path?: string;
}

export interface HostPageConfig {
  appId: string;
  appName: string;
  appUrl: string;
  store: string;
  slug: string;
  pages: HostPageEntry[];
  /** Links to the example store page when the app has storefront scripts. */
  storefront?: boolean;
  role: string;
  roles: string[];
  locale: string;
  theme: 'light' | 'dark';
}

// Mirrors the real dashboard's embed page: same sandbox, same message checks, same title bar limits.
const HOST_SCRIPT = String.raw`
const config = JSON.parse(document.getElementById('host-config').textContent);
const appOrigin = new URL(config.appUrl).origin;
const nonce = crypto.randomUUID();
const frame = document.getElementById('app-frame');
const log = document.getElementById('bridge-log');
const RTL = ['ar', 'fa', 'he', 'ur'];
let ready = false;

frame.src = config.frameUrl + '#nonce=' + nonce;

const context = () => {
  const locale = document.getElementById('locale').value;
  return { locale, direction: RTL.includes(locale.split('-')[0]) ? 'rtl' : 'ltr', theme: document.getElementById('theme').value };
};

const record = (direction, message) => {
  const entry = document.createElement('li');
  entry.textContent = direction + ' ' + JSON.stringify(message);
  log.prepend(entry);
};

const post = (message) => {
  record('→', message);
  frame.contentWindow.postMessage(message, appOrigin);
};

const reply = (data, success, payload, error) => {
  if (!data.requestId) return;
  post({ source: 'flycom-dashboard', appId: config.appId, requestId: data.requestId, action: data.action, success, payload, error });
};

const emit = (event, payload) => {
  if (ready) post({ source: 'flycom-dashboard', appId: config.appId, event, payload });
};

const toast = (message, type) => {
  const item = document.createElement('div');
  item.className = 'toast toast-' + (type || 'info');
  item.textContent = message;
  document.getElementById('toasts').append(item);
  setTimeout(() => item.remove(), 4000);
};

const parseTitleBar = (payload) => {
  if (!payload || typeof payload.title !== 'string') return null;
  const title = payload.title.trim();
  if (!title || title.length > 80) return null;
  const bar = { title, subtitle: '', actions: [] };
  if (typeof payload.subtitle === 'string' && payload.subtitle.trim().length <= 160) bar.subtitle = payload.subtitle.trim();
  let primary = false;
  for (const raw of (Array.isArray(payload.actions) ? payload.actions.slice(0, 3) : [])) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.label !== 'string') continue;
    const label = raw.label.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw.id) || !label || label.length > 32 || bar.actions.some((a) => a.id === raw.id)) continue;
    let variant = ['primary', 'secondary', 'destructive'].includes(raw.variant) ? raw.variant : 'secondary';
    if (variant === 'primary') { variant = primary ? 'secondary' : 'primary'; primary = true; }
    bar.actions.push({ id: raw.id, label, variant, disabled: Boolean(raw.disabled), loading: Boolean(raw.loading) });
  }
  return bar;
};

const parseConfirmation = (payload) => {
  if (!payload || typeof payload.title !== 'string' || typeof payload.message !== 'string') return null;
  const label = (value, fallback) => value === undefined ? fallback : (typeof value === 'string' && value.trim() && value.trim().length <= 32 ? value.trim() : null);
  const title = payload.title.trim();
  const message = payload.message.trim();
  const confirmLabel = label(payload.confirmLabel, 'Confirm');
  const cancelLabel = label(payload.cancelLabel, 'Cancel');
  if (!title || title.length > 80 || !message || message.length > 500 || !confirmLabel || !cancelLabel) return null;
  return { title, message, confirmLabel, cancelLabel, destructive: payload.destructive === true };
};

let answerConfirmation = null;

const askMerchant = (question) => new Promise((resolve) => {
  const dialog = document.getElementById('confirm-dialog');
  document.getElementById('confirm-title').textContent = question.title;
  document.getElementById('confirm-message').textContent = question.message;
  const yes = document.getElementById('confirm-yes');
  yes.textContent = question.confirmLabel;
  yes.className = 'action ' + (question.destructive ? 'action-destructive-solid' : 'action-primary');
  document.getElementById('confirm-no').textContent = question.cancelLabel;
  answerConfirmation = (confirmed) => { answerConfirmation = null; dialog.close(); resolve(confirmed); };
  dialog.showModal();
});

document.getElementById('confirm-yes').addEventListener('click', () => answerConfirmation && answerConfirmation(true));
document.getElementById('confirm-no').addEventListener('click', () => answerConfirmation && answerConfirmation(false));
document.getElementById('confirm-dialog').addEventListener('cancel', () => answerConfirmation && answerConfirmation(false));

let viewportFrame = 0;
let reportedViewport = '';
const reportViewport = () => {
  viewportFrame = 0;
  const rect = frame.getBoundingClientRect();
  const top = Math.round(Math.max(0, -rect.top));
  const height = Math.round(Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0)));
  if (top + ':' + height === reportedViewport) return;
  reportedViewport = top + ':' + height;
  emit('VIEWPORT', { top, height });
};
const scheduleViewport = () => { viewportFrame ||= requestAnimationFrame(reportViewport); };
document.addEventListener('scroll', scheduleViewport, { capture: true, passive: true });
window.addEventListener('resize', scheduleViewport);

const renderTitleBar = (bar) => {
  document.getElementById('page-title').textContent = bar.title;
  document.getElementById('page-subtitle').textContent = bar.subtitle;
  const actions = document.getElementById('page-actions');
  actions.replaceChildren(...bar.actions.map((action) => {
    const button = document.createElement('button');
    button.className = 'action action-' + action.variant;
    button.textContent = action.loading ? action.label + '…' : action.label;
    button.disabled = action.disabled || action.loading;
    button.addEventListener('click', () => emit('TITLE_ACTION', { id: action.id }));
    return button;
  }));
};

window.addEventListener('message', async (event) => {
  if (event.origin !== appOrigin || event.source !== frame.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.source !== 'flycom-app-bridge' || data.appId !== config.appId) return;
  if (data.nonce !== nonce) return;
  record('←', data);

  switch (data.action) {
    case 'APP_READY':
      ready = true;
      document.getElementById('loading').hidden = true;
      reply(data, true, context());
      return scheduleViewport();
    case 'GET_SESSION_TOKEN': {
      const response = await fetch('/session-token?role=' + encodeURIComponent(config.role), { method: 'POST' });
      return response.ok ? reply(data, true, await response.json()) : reply(data, false, undefined, 'Failed to fetch session token');
    }
    case 'NAVIGATE': {
      const payload = data.payload || {};
      if (typeof payload.surface === 'string') {
        if (!config.pages.some((page) => page.slug === payload.surface)) return reply(data, false, undefined, 'This app has no surface with the slug "' + payload.surface + '".');
        reply(data, true);
        return window.location.assign('/apps/' + payload.surface + window.location.search);
      }
      const path = payload.path;
      if (typeof path === 'string' && /^\/admin(\/|$)/.test(path) && !path.includes('//') && !path.includes('\\') && !path.split('/').includes('..')) {
        reply(data, true);
        return window.location.assign(path);
      }
      return reply(data, false, undefined, 'Apps can only open admin dashboard pages under /admin.');
    }
    case 'TOAST':
      if (typeof (data.payload || {}).message === 'string') { toast(data.payload.message, data.payload.type); reply(data, true); }
      return;
    case 'LOADING':
      document.getElementById('loading').hidden = !(data.payload && data.payload.active);
      return reply(data, true);
    case 'TITLE_BAR': {
      const bar = parseTitleBar(data.payload);
      if (bar) renderTitleBar(bar);
      return;
    }
    case 'RESIZE': {
      const height = data.payload && data.payload.height;
      if (typeof height === 'number' && Number.isFinite(height)) frame.style.height = Math.ceil(Math.min(Math.max(height, 120), 50000)) + 'px';
      return scheduleViewport();
    }
    case 'CONFIRM': {
      const question = parseConfirmation(data.payload);
      if (!question) return reply(data, false, undefined, 'CONFIRM needs a title of 1 to 80 characters, a message of 1 to 500 and labels of up to 32.');
      if (answerConfirmation) return reply(data, false, undefined, 'A confirmation is already open.');
      const confirmed = await askMerchant(question);
      return reply(data, true, { confirmed });
    }
  }
});

document.getElementById('locale').addEventListener('change', () => emit('CONTEXT', context()));
document.getElementById('theme').addEventListener('change', () => { document.documentElement.dataset.theme = context().theme; emit('CONTEXT', context()); });
document.getElementById('role').addEventListener('change', (event) => {
  const url = new URL(window.location.href);
  url.searchParams.set('role', event.target.value);
  window.location.assign(url);
});
`;

const HOST_STYLES = `
:root { --bg:#f5f6f8; --panel:#fff; --ink:#0f1729; --muted:#5b6478; --line:#e3e5ea; --accent:#1d4ed8; }
:root[data-theme="dark"] { --bg:#0e1116; --panel:#161b22; --ink:#e6e9ef; --muted:#9aa4b2; --line:#2a313c; --accent:#6d9bff; }
* { box-sizing:border-box; }
body { margin:0; font:14px/1.5 system-ui,sans-serif; background:var(--bg); color:var(--ink); display:grid; grid-template-columns:220px 1fr; min-height:100vh; }
nav { background:var(--panel); border-inline-end:1px solid var(--line); padding:16px; }
nav h2 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:18px 0 6px; }
nav a { display:block; padding:6px 10px; border-radius:6px; color:var(--ink); text-decoration:none; }
nav a[aria-current="page"] { background:var(--bg); font-weight:600; }
main { padding:20px 28px; min-width:0; }
.fake-bar { display:flex; gap:12px; align-items:center; font-size:12px; color:var(--muted); margin-bottom:16px; flex-wrap:wrap; }
.fake-bar select { font:inherit; }
header { display:flex; align-items:flex-start; gap:16px; margin-bottom:12px; }
header div { flex:1; min-width:0; }
h1 { font-size:20px; margin:0; }
#page-subtitle { color:var(--muted); margin:2px 0 0; }
#page-actions { display:flex; gap:8px; }
.action { font:inherit; padding:7px 14px; border-radius:8px; border:1px solid var(--line); background:var(--panel); color:var(--ink); cursor:pointer; }
.action-primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.action:disabled { opacity:.5; cursor:not-allowed; }
.action-destructive { color:#d92d20; }
.action-destructive-solid { background:#d92d20; border-color:#d92d20; color:#fff; }
#confirm-dialog { border:1px solid var(--line); border-radius:12px; background:var(--panel); color:var(--ink); padding:20px; max-width:420px; width:calc(100% - 32px); }
#confirm-dialog::backdrop { background:rgb(15 23 41 / .45); }
#confirm-dialog h2 { margin:0 0 6px; font-size:16px; } #confirm-dialog p { margin:0; color:var(--muted); white-space:pre-line; }
#confirm-dialog small { display:block; margin-top:12px; color:var(--muted); }
#confirm-dialog footer { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
.frame-wrap { position:relative; }
#app-frame { display:block; width:100%; border:0; height:600px; background:transparent; }
#loading { position:absolute; inset:0; display:grid; place-items:center; background:var(--bg); color:var(--muted); } #loading[hidden] { display:none; }
#toasts { position:fixed; inset-inline-end:16px; bottom:16px; display:grid; gap:8px; }
.toast { background:var(--panel); border:1px solid var(--line); border-inline-start:3px solid var(--accent); padding:10px 14px; border-radius:8px; max-width:360px; }
.toast-success { border-inline-start-color:#12b76a; } .toast-error { border-inline-start-color:#d92d20; } .toast-warning { border-inline-start-color:#f79009; }
@media (max-width: 767px) { body { grid-template-columns:1fr; } nav { border-inline-end:0; border-bottom:1px solid var(--line); } main { padding:16px; } header { flex-wrap:wrap; } }
details { margin-top:20px; font-size:12px; } #bridge-log { font-family:ui-monospace,monospace; max-height:240px; overflow:auto; padding-inline-start:18px; color:var(--muted); }
`;

export function hostPage(config: HostPageConfig): string {
  const option = (value: string, selected: string, label = value) =>
    `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;

  const link = (page: { slug: string }, label: string) =>
    `<a href="/apps/${escapeHtml(page.slug)}?role=${escapeHtml(config.role)}"${page.slug === config.slug ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`;

  // As the dashboard: one page is the app's own menu item; only several get the app name above them.
  const menu =
    config.pages.length === 1
      ? link(config.pages[0], config.appName)
      : `<div style="font-weight:600;padding:6px 10px">${escapeHtml(config.appName)}</div>` +
        config.pages.map((page) => link(page, page.label)).join('');

  // As the dashboard: appUrl + the page's path.
  const current = config.pages.find((page) => page.slug === config.slug);
  const frameUrl = config.appUrl.replace(/\/+$/, '') + (current?.path ?? `/${config.slug}`);
  // </script> inside JSON would end the tag early.
  const json = JSON.stringify({ ...config, frameUrl }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en" data-theme="${config.theme}">
<head><meta charset="utf-8"><title>${escapeHtml(config.appName)} — Example dashboard</title><style>${HOST_STYLES}</style></head>
<body>
<nav>
  <strong>Example dashboard</strong>
  <div style="color:var(--muted);font-size:12px">${escapeHtml(config.store)}</div>
  <h2>Apps</h2>
  ${menu}
  ${config.storefront ? '<h2>Storefront</h2><a href="/storefront">Example storefront</a>' : ''}
</nav>
<main>
  <div class="fake-bar">
    <label>Role ${`<select id="role">${config.roles.map((role) => option(role, config.role)).join('')}</select>`}</label>
    <label>Locale <select id="locale">${['en', 'bn', 'ar', 'tr'].map((locale) => option(locale, config.locale)).join('')}</select></label>
    <label>Theme <select id="theme">${option('light', config.theme)}${option('dark', config.theme)}</select></label>
  </div>
  <header><div><h1 id="page-title">${escapeHtml(config.appName)}</h1><p id="page-subtitle"></p></div><div id="page-actions"></div></header>
  <div class="frame-wrap">
    <iframe id="app-frame" title="${escapeHtml(config.appName)}" sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-modals allow-downloads" allow="clipboard-write; fullscreen"></iframe>
    <div id="loading">Loading ${escapeHtml(config.appName)}…</div>
  </div>
  <details><summary>Bridge messages</summary><ul id="bridge-log"></ul></details>
</main>
<div id="toasts" role="status" aria-live="polite"></div>
<dialog id="confirm-dialog" aria-labelledby="confirm-title">
  <h2 id="confirm-title"></h2>
  <p id="confirm-message"></p>
  <small>Asked by ${escapeHtml(config.appName)}</small>
  <footer><button type="button" class="action" id="confirm-no"></button><button type="button" id="confirm-yes"></button></footer>
</dialog>
<script type="application/json" id="host-config">${json}</script>
<script>${HOST_SCRIPT}</script>
</body>
</html>`;
}
