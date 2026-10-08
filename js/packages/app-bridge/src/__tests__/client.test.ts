import { describe, it } from 'node:test';
import assert from 'node:assert';

type Listener = (event: { source: unknown; origin: string; data: any }) => void;

const dashboard = 'https://store.flycommerce.com';
const posted: { message: any; targetOrigin: string }[] = [];
const parent = { postMessage: (message: any, targetOrigin: string) => posted.push({ message, targetOrigin }) };
let listener: Listener = () => {};

const classes = new Set<string>();
const styles = new Map<string, string>();
const root = {
  style: { setProperty: (name: string, value: string) => styles.set(name, value) },
  lang: '',
  dir: '',
  dataset: {} as Record<string, string>,
  classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) },
};
const fakeDocument = { referrer: `${dashboard}/admin/apps/order-printer/invoices`, documentElement: root };
const fetchCalls: { input: any; init: any }[] = [];

Object.assign(globalThis, {
  window: {
    parent,
    location: {
      hash: '#nonce=n-123',
      pathname: '/invoices',
      search: '',
      origin: 'https://printer.example.org',
      href: 'https://printer.example.org/invoices',
    },
    history: { replaceState: () => {} },
    addEventListener: (_type: string, fn: Listener) => {
      listener = fn;
    },
    fetch: (input: any, init?: any) => {
      fetchCalls.push({ input, init });
      return Promise.resolve(new Response('ok'));
    },
  },
  document: fakeDocument,
});

const { createApp } = await import('../index.js');

function reply(request: any, payload: unknown, from: { source?: unknown; origin?: string } = {}) {
  listener({
    source: from.source ?? parent,
    origin: from.origin ?? dashboard,
    data: {
      source: 'flycom-dashboard',
      appId: request.appId,
      requestId: request.requestId,
      action: request.action,
      success: true,
      payload,
    },
  });
}

function dashboardEvent(data: Record<string, unknown>, from: { source?: unknown; origin?: string } = {}) {
  listener({
    source: from.source ?? parent,
    origin: from.origin ?? dashboard,
    data: { source: 'flycom-dashboard', appId: 'printer', ...data },
  });
}

describe('@flycommerce/app-bridge client', () => {
  it('posts only to the dashboard that embedded it', () => {
    posted.length = 0;
    createApp({ appId: 'printer' });

    assert.strictEqual(posted[0].targetOrigin, dashboard);
    assert.strictEqual(posted[0].message.action, 'APP_READY');
    assert.strictEqual(posted[0].message.nonce, 'n-123');

    reply(posted[0].message, undefined);
  });

  it('ignores replies from another window or another origin', async () => {
    posted.length = 0;
    const app = createApp({ appId: 'printer' });
    reply(posted[0].message, undefined);

    const token = app.getSessionToken();
    const request = posted[1].message;

    reply(request, { session_token: 'from-another-frame', expires_in: 60 }, { source: {} });
    reply(request, { session_token: 'from-another-origin', expires_in: 60 }, { origin: 'https://evil.example' });
    reply(request, { session_token: 'from-the-dashboard', expires_in: 60 });

    assert.strictEqual(await token, 'from-the-dashboard');
  });

  it('lays the page out in the dashboard locale, direction and theme', async () => {
    posted.length = 0;
    const app = createApp({ appId: 'printer' });
    reply(posted[0].message, { locale: 'ar', direction: 'rtl', theme: 'dark' });

    assert.deepStrictEqual(await app.ready, { locale: 'ar', direction: 'rtl', theme: 'dark' });
    assert.strictEqual(root.lang, 'ar');
    assert.strictEqual(root.dir, 'rtl');
    assert.strictEqual(root.dataset.theme, 'dark');
    assert.ok(classes.has('dark'));
    assert.ok('embedded' in root.dataset);

    dashboardEvent({ event: 'CONTEXT', payload: { locale: 'en', direction: 'ltr', theme: 'sepia' } });
    assert.strictEqual(app.context?.locale, 'ar', 'a malformed context is ignored');
  });

  it('sends title bars without waiting for a reply, and takes header clicks only from the dashboard', () => {
    posted.length = 0;
    const app = createApp({ appId: 'printer' });
    reply(posted[0].message, undefined);

    app.setTitleBar({ title: 'Invoices', actions: [{ id: 'print', label: 'Print', variant: 'primary' }] });
    const titleBar = posted.find((entry) => entry.message.action === 'TITLE_BAR')!.message;

    assert.strictEqual(titleBar.requestId, undefined);
    assert.strictEqual(titleBar.payload.title, 'Invoices');

    const clicks: string[] = [];
    app.on('TITLE_ACTION', ({ id }) => clicks.push(id));

    dashboardEvent({ event: 'TITLE_ACTION', payload: { id: 'print' } }, { origin: 'https://evil.example' });
    dashboardEvent({ event: 'TITLE_ACTION', payload: { id: 'print' } }, { source: {} });
    dashboardEvent({ event: 'TITLE_ACTION', payload: { id: 'print' } });

    assert.deepStrictEqual(clicks, ['print']);
  });

  it('asks in the dashboard dialog and confirms only on an explicit yes', async () => {
    posted.length = 0;
    const app = createApp({ appId: 'printer' });
    reply(posted[0].message, undefined);

    const declined = app.confirm({ title: 'Disconnect?', message: 'Syncing stops.', destructive: true });
    await Promise.resolve();
    const first = posted.find((entry) => entry.message.action === 'CONFIRM')!.message;
    assert.deepStrictEqual(first.payload, { title: 'Disconnect?', message: 'Syncing stops.', destructive: true });
    reply(first, { confirmed: false });

    const accepted = app.confirm({ title: 'Disconnect?', message: 'Syncing stops.' });
    await Promise.resolve();
    const second = posted.filter((entry) => entry.message.action === 'CONFIRM')[1].message;
    reply(second, { confirmed: 'yes' });

    assert.strictEqual(await declined, false);
    assert.strictEqual(await accepted, false, 'anything but true is a no');
  });

  it('exposes the visible part of the frame so overlays can centre on it', () => {
    posted.length = 0;
    const app = createApp({ appId: 'printer' });
    reply(posted[0].message, undefined);
    const seen: number[] = [];
    app.on('VIEWPORT', ({ top }) => seen.push(top));

    dashboardEvent({ event: 'VIEWPORT', payload: { top: 900, height: 600 } }, { origin: 'https://evil.example' });
    dashboardEvent({ event: 'VIEWPORT', payload: { top: -5, height: 600 } });
    dashboardEvent({ event: 'VIEWPORT', payload: { top: 1200, height: 640 } });

    assert.deepStrictEqual(seen, [1200]);
    assert.deepStrictEqual(app.viewport, { top: 1200, height: 640 });
    assert.strictEqual(styles.get('--flycom-viewport-top'), '1200px');
    assert.strictEqual(styles.get('--flycom-viewport-height'), '640px');
  });

  it('deduplicates concurrent inflight session token requests', async () => {
    posted.length = 0;
    const app = createApp({ appId: 'printer' });
    reply(posted[0].message, undefined);

    const [t1, t2, t3] = [app.getSessionToken(), app.getSessionToken(), app.getSessionToken()];
    const tokenRequests = posted.filter((entry) => entry.message.action === 'GET_SESSION_TOKEN');
    assert.strictEqual(tokenRequests.length, 1, 'only a single postMessage is fired for concurrent calls');

    reply(tokenRequests[0].message, { session_token: 'shared-token', expires_in: 60 });
    assert.deepStrictEqual(await Promise.all([t1, t2, t3]), ['shared-token', 'shared-token', 'shared-token']);
  });

  it('attaches session token only to same-origin requests and preserves existing headers', async () => {
    posted.length = 0;
    fetchCalls.length = 0;
    const app = createApp({ appId: 'printer' });
    reply(posted[0].message, undefined);

    // Call 1: relative URL (same-origin)
    const p1 = app.fetch('/api/invoices');
    const req1 = posted.find((entry) => entry.message.action === 'GET_SESSION_TOKEN')!.message;
    reply(req1, { session_token: 'tok-123', expires_in: 60 });
    await p1;

    const auth1 = new Headers(fetchCalls[0].init.headers).get('Authorization');
    assert.strictEqual(auth1, 'Bearer tok-123');

    // Call 2: cross-origin URL (must NOT attach session token)
    fetchCalls.length = 0;
    await app.fetch('https://api.stripe.com/v1/charges');
    const auth2 = new Headers(fetchCalls[0].init.headers).get('Authorization');
    assert.strictEqual(auth2, null, 'cross-origin request must not receive session token');

    // Call 3: custom Authorization header already set (must NOT be overwritten)
    fetchCalls.length = 0;
    await app.fetch('/api/custom', { headers: { Authorization: 'CustomKey 999' } });
    const auth3 = new Headers(fetchCalls[0].init.headers).get('Authorization');
    assert.strictEqual(auth3, 'CustomKey 999', 'pre-existing Authorization must be preserved');
  });

  it('refuses to talk when it cannot tell who embedded it', async () => {
    fakeDocument.referrer = '';
    posted.length = 0;

    const app = createApp({ appId: 'printer' });

    await assert.rejects(app.getSessionToken(), { message: /pass parentOrigin/ });
    assert.strictEqual(posted.length, 0);
  });
});
