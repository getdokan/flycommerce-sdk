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

function fail(request: any, error: string) {
  listener({
    source: parent,
    origin: dashboard,
    data: { source: 'flycom-dashboard', appId: request.appId, requestId: request.requestId, action: request.action, success: false, error },
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

  it('shares one token request between concurrent calls, and asks again after a failure or near expiry', async () => {
    posted.length = 0;
    const app = createApp({ appId: 'printer' });
    reply(posted[0].message, undefined);
    const tokenRequests = () => posted.filter((entry) => entry.message.action === 'GET_SESSION_TOKEN').map((entry) => entry.message);

    const failing = [app.getSessionToken(), app.getSessionToken()];
    assert.strictEqual(tokenRequests().length, 1);
    fail(tokenRequests()[0], 'not_allowed');
    for (const call of failing) await assert.rejects(call, { message: 'not_allowed' });

    const concurrent = [app.getSessionToken(), app.getSessionToken(), app.getSessionToken()];
    assert.strictEqual(tokenRequests().length, 2, 'a failed request is not reused');
    reply(tokenRequests()[1], { session_token: 'short-lived', expires_in: 5 });
    assert.deepStrictEqual(await Promise.all(concurrent), ['short-lived', 'short-lived', 'short-lived']);

    const refreshed = app.getSessionToken();
    assert.strictEqual(tokenRequests().length, 3, 'a token within 10 seconds of expiry is not served');
    reply(tokenRequests()[2], { session_token: 'fresh', expires_in: 60 });
    assert.strictEqual(await refreshed, 'fresh');
    assert.strictEqual(await app.getSessionToken(), 'fresh');
    assert.strictEqual(tokenRequests().length, 3);
  });

  it('sends the session token only to the page origin and fetchOrigins, and refuses other URLs', async () => {
    posted.length = 0;
    fetchCalls.length = 0;
    const app = createApp({ appId: 'printer', fetchOrigins: ['https://api.printer.example/'] });
    reply(posted[0].message, undefined);

    const first = app.fetch('/api/invoices');
    await Promise.resolve();
    reply(posted.find((entry) => entry.message.action === 'GET_SESSION_TOKEN')!.message, { session_token: 'tok-123', expires_in: 60 });
    await first;

    await app.fetch('https://printer.example.org/api/invoices');
    await app.fetch(new URL('https://api.printer.example/v1/invoices'));
    await app.fetch(new Request('https://api.printer.example/v1/invoices', { headers: { 'X-Trace': 't-1' } }));
    await app.fetch('/api/custom', { headers: { Authorization: 'CustomKey 999' } });

    const auth = fetchCalls.map((call) => new Headers(call.init.headers).get('Authorization'));
    assert.deepStrictEqual(auth, ['Bearer tok-123', 'Bearer tok-123', 'Bearer tok-123', 'Bearer tok-123', 'CustomKey 999']);
    assert.strictEqual(new Headers(fetchCalls[3].init.headers).get('X-Trace'), 't-1', "a Request's own headers are kept");

    fetchCalls.length = 0;
    for (const url of [
      'https://api.stripe.com/v1/charges',
      '//evil.example/steal',
      'http://printer.example.org/api/invoices',
      'https://printer.example.org:8443/api/invoices',
      'https://printer.example.org.evil.example/api',
      'data:text/plain,hi',
    ]) {
      await assert.rejects(app.fetch(url), { message: /only to this page's origin/ }, url);
    }
    await assert.rejects(app.fetch(new Request('https://api.stripe.com/v1/charges')), { message: /only to this page's origin/ });
    assert.strictEqual(fetchCalls.length, 0, 'nothing is sent to another origin');
  });

  it('resolves a relative URL against the document base, as fetch() does', async () => {
    posted.length = 0;
    fetchCalls.length = 0;
    const app = createApp({ appId: 'printer' });
    reply(posted[0].message, undefined);

    Object.assign(fakeDocument, { baseURI: 'https://cdn.example/' });
    try {
      await assert.rejects(app.fetch('/api/invoices'), { message: /not to https:\/\/cdn\.example/ });
      assert.strictEqual(fetchCalls.length, 0);
    } finally {
      delete (fakeDocument as { baseURI?: string }).baseURI;
    }
  });

  it('refuses a fetchOrigins entry that is not an http origin', () => {
    assert.throws(() => createApp({ appId: 'printer', fetchOrigins: ['api.printer.example'] }));
    assert.throws(() => createApp({ appId: 'printer', fetchOrigins: ['ftp://api.printer.example'] }), { message: /http and https/ });
  });

  it('refuses to talk when it cannot tell who embedded it', async () => {
    fakeDocument.referrer = '';
    posted.length = 0;

    const app = createApp({ appId: 'printer' });

    await assert.rejects(app.getSessionToken(), { message: /pass parentOrigin/ });
    assert.strictEqual(posted.length, 0);
  });
});
