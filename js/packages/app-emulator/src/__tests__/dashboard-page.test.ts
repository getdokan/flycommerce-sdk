import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type HostPageConfig, hostPage } from '../dashboard-page.js';

const config = (pages: HostPageConfig['pages']): HostPageConfig => ({
  appId: 'export',
  appName: 'Order Export',
  appUrl: 'http://localhost:4000',
  store: 'demo.flycom.shop',
  slug: pages[0].slug,
  pages,
  role: 'owner',
  roles: ['owner', 'admin'],
  locale: 'en',
  theme: 'light',
});

const menu = (html: string) => html.slice(html.indexOf('<h2>Apps</h2>'), html.indexOf('</nav>'));

describe('the example dashboard menu', () => {
  it('shows a one-page app as a single item named after the app, as the dashboard does', () => {
    const nav = menu(hostPage(config([{ slug: 'export', label: 'Export orders' }])));

    assert.match(nav, /<a href="\/apps\/export\?role=owner" aria-current="page">Order Export<\/a>/);
    assert.doesNotMatch(nav, /Export orders/);
  });

  it('lists each page under the app name when there are several', () => {
    const nav = menu(
      hostPage(
        config([
          { slug: 'queue', label: 'Review queue' },
          { slug: 'settings', label: 'Settings' },
        ])
      )
    );

    assert.match(nav, />Order Export</);
    assert.match(nav, /aria-current="page">Review queue<\/a>/);
    assert.match(nav, />Settings<\/a>/);
  });
});

describe('the example dashboard frame', () => {
  const frameUrl = (html: string) =>
    JSON.parse(/<script type="application\/json" id="host-config">(.*?)<\/script>/s.exec(html)![1]).frameUrl;

  it("frames appUrl + the page's path, as the dashboard does", () => {
    const html = hostPage({
      ...config([{ slug: 'export', label: 'Export orders', path: '/orders/export' }]),
      appUrl: 'http://localhost:4000/',
    });

    assert.equal(frameUrl(html), 'http://localhost:4000/orders/export');
    assert.match(html, /frame\.src = config\.frameUrl \+ '#nonce=' \+ nonce;/);
  });

  it('frames /<slug> for a page given without a path', () => {
    assert.equal(frameUrl(hostPage(config([{ slug: 'export', label: 'Export orders' }]))), 'http://localhost:4000/export');
  });
});
