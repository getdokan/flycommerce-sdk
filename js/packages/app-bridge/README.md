# @flycommerce/app-bridge

Run your FlyCommerce app's pages inside the merchant dashboard. The bridge gets session tokens for your server, and lets your page navigate, set the dashboard's title bar, show toasts and confirmations, and follow the dashboard's language, direction and theme.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/getdokan/flycommerce-sdk/blob/main/LICENSE)

## Install

> **Preview.** On npm under the `next` tag while FlyCommerce's app platform is in testing: `npm install @flycommerce/app-bridge@next`. The first stable release comes with the launch.

```bash
npm install @flycommerce/app-bridge
```

ESM only. React 18 or later is an optional peer, needed only for `@flycommerce/app-bridge/react`.

## In the page

```ts
import { createApp, appIdFromPage } from '@flycommerce/app-bridge';

const bridge = createApp({ appId: appIdFromPage() });

// Calls your own server with a fresh session token in the Authorization header.
const orders = await bridge.fetch('/api/orders').then((res) => res.json());

bridge.setTitleBar({ title: 'Orders' });
await bridge.toast('Saved');
```

`bridge.fetch()` sends the session token only to the page's own origin. If your API is on another origin, list it, and allow the page's origin in that API's CORS:

```ts
const bridge = createApp({ appId: appIdFromPage(), fetchOrigins: ['https://api.my-app.example'] });
```

`bridge.fetch()` refuses any other URL before sending anything; call other servers with `window.fetch()`. An `Authorization` header you set yourself is kept. Calls made at the same time share one token request.

With React:

```tsx
import { appIdFromPage } from '@flycommerce/app-bridge';
import { AppBridgeProvider, useAppBridge, useTitleBar } from '@flycommerce/app-bridge/react';

function Orders() {
  const bridge = useAppBridge();
  useTitleBar({ title: 'Orders' });

  return <button onClick={() => bridge.toast('Saved')}>Save</button>;
}

export function App() {
  return (
    <AppBridgeProvider appId={appIdFromPage()}>
      <Orders />
    </AppBridgeProvider>
  );
}
```

## Storefront scripts

A script your app adds to the storefront (declared under `storefront.scripts` in `app-config.json`) can read the store's context from `window.FlyCommerce`, and hear client-side navigation from the `flycommerce:page` event. To type both, opt in once:

```ts
import type {} from '@flycommerce/app-bridge/storefront';

const { locale, currency, pageType } = window.FlyCommerce ?? {};

window.addEventListener('flycommerce:page', (event) => {
  // event.detail: { pageType, path }
});
```

On stores that support them, the script can also act for the shopper and learn who they are:

```ts
const added = await window.FlyCommerce?.run?.('cart.add', { items: [{ productId, quantity: 1 }] });
if (added && !added.ok) showError(added.error); // the store's own message

const token = await window.FlyCommerce?.shopperToken?.(APP_ID); // for your server; null if the store won't issue one
window.addEventListener('flycommerce:cart:updated', (event) => updateBadge(event.detail.count));
```

`StorefrontContext` is `{ store, locale, currency, pageType }` plus the optional `run`, `can`, `actions` and `shopperToken`. It holds nothing about the shopper. `pageType` is the page the script loaded on; follow the event for later pages. The types are also exported from the main entry, without the global. See [`spec/storefront-scripts.md`](https://github.com/getdokan/flycommerce-sdk/blob/main/spec/storefront-scripts.md).

## On your server

Verify the session token before trusting it:

```ts
import { verifySessionToken } from '@flycommerce/app-bridge/server';

const session = await verifySessionToken(token, { appId: process.env.APP_ID! });
// session.store_domain and session.sub tell you which store and which user.
```

A shopper token from a storefront script is verified the same way, with `verifyShopperToken(token, { appId })`: type `shopper`, 5 minutes, and `customer_id` only when the merchant granted `storefront.customer`.

`@flycommerce/app-server` wraps both together with the rest of what a server needs.

## Security

- The bridge only talks to the dashboard that framed it. It checks the sender and origin of every message, and never posts to `*`.
- `fetch()` sends the session token only to the page's origin and `fetchOrigins`, so a URL you didn't list never receives it.
- `verifySessionToken` accepts only RS256 tokens signed by a FlyCommerce key, for your app (`aud`) and from FlyCommerce (`iss`), within their 60-second life.

The token format is in [`spec/session-token.md`](https://github.com/getdokan/flycommerce-sdk/blob/main/spec/session-token.md). Report vulnerabilities through [SECURITY.md](https://github.com/getdokan/flycommerce-sdk/blob/main/SECURITY.md).

## Links

- [Changelog](https://github.com/getdokan/flycommerce-sdk/blob/main/js/packages/app-bridge/CHANGELOG.md)
- [All packages](https://github.com/getdokan/flycommerce-sdk#readme)
