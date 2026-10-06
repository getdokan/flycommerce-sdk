import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ExampleDashboard, type ExampleDashboardOptions } from '../dashboard.js';
import { FakeHub } from '../hub.js';

const scripts = [
  { handle: 'badge', src: 'http://127.0.0.1:4600/badge.js' },
  { handle: 'chat', src: 'http://127.0.0.1:4600/chat.js', load: 'interactive' as const },
];

describe('the example storefront', () => {
  let hub: FakeHub;
  const started: ExampleDashboard[] = [];

  before(async () => {
    hub = await FakeHub.start({ apps: [{ appId: 'chat-app', appSecret: 'secret', redirectUri: 'http://127.0.0.1:1/auth/callback' }] });
  });

  after(async () => {
    await Promise.all(started.map((dashboard) => dashboard.close()));
    await hub.close();
  });

  const start = async (changes: Partial<ExampleDashboardOptions> = {}) => {
    const dashboard = await ExampleDashboard.start({
      hub,
      appId: 'chat-app',
      appName: 'Chat',
      appUrl: 'http://127.0.0.1:4600',
      store: 'demo.flycom.shop',
      pages: [{ label: 'Inbox', slug: 'inbox' }],
      ...changes,
    });
    started.push(dashboard);
    return dashboard;
  };

  it('sets window.FlyCommerce before it loads the declared scripts, and links to the page from the dashboard', async () => {
    const dashboard = await start({ scripts });
    const store = await (await fetch(`${dashboard.url}/storefront`)).text();
    const menu = await (await fetch(`${dashboard.url}/apps/inbox`)).text();
    const context = store.indexOf('window.FlyCommerce = {"store":"demo.flycom.shop","locale":"en","currency":"USD","pageType":"home"};');
    const declared = store.indexOf(JSON.stringify({ app: 'chat-app', scripts }));

    assert.ok(context > 0, 'the context is set');
    assert.ok(declared > context, 'the scripts, in the declared order, come after the context');
    assert.match(store, /new CustomEvent\('flycommerce:page', \{ detail \}\)/);
    assert.match(store, /data-page-type="product" data-path="\/products\/green-tea"/);
    assert.match(menu, /<a href="\/storefront">Example storefront<\/a>/);
  });

  it('has no store page, and no link to one, when the app declares no scripts', async () => {
    const dashboard = await start({ scripts: [] });
    const missing = await fetch(`${dashboard.url}/storefront`);
    const menu = await (await fetch(`${dashboard.url}/apps/inbox`)).text();

    assert.equal(missing.status, 404);
    assert.ok(!menu.includes('href="/storefront"'));
  });
});
