# @flycommerce/app-emulator

A local FlyCommerce emulator for developing and testing your app, with no account or network needed: a hub that issues and verifies tokens, a store with an API and webhooks, a dashboard that frames your pages, a store page that runs your storefront scripts, and a kit for faking a third-party OAuth 2.0 provider.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/getdokan/flycommerce-sdk/blob/main/LICENSE)

## Install

> **Preview.** On npm under the `next` tag while FlyCommerce's app platform is in testing: `npm install @flycommerce/app-emulator@next`. The first stable release comes with the launch.

```bash
npm install --save-dev @flycommerce/app-emulator
```

Node 22 or later. ESM only. **For tests and local development only.** The fakes sign with throwaway keys and keep everything in memory, so they must never run in production.

## Example

```ts
import { startFakePlatform } from '@flycommerce/app-emulator';

const platform = await startFakePlatform({
  appId: 'my-app',
  appSecret: 'test-secret',
  redirectUri: 'http://127.0.0.1:3000/auth/callback',
});

// Point your app at the fakes: APP_ID, HUB_API_URL, JWKS_URL, STORE_BASE_URL and the rest.
Object.assign(process.env, platform.env);

// … start your app and run your tests …

await platform.close();
```

## What it does like a real store

- **Orders:** `addOrder()` stamps real times, and the order list honours `include`, `paginate=full`, `sort`, `filters[createdAt]` / `filters[updatedAt]` (a bare date means "since"), `filters[orderNo]`, `filters[customerId]` and `filters[status]`. As on a real store, any other filter, or the singular `filter[…]`, is a 400.
- **Products:** `addProduct()`; `GET /api/v1/products` with `?search=` (the slug starts with it or the title contains it) and `GET /api/v1/search/products?search=`, which ranks by how many words match (no typo tolerance here). Both need `catalog.read`; drafts are never listed.
- **Webhooks:** `deliver(store, event, data)` sends the real body, `{event, timestamp, data}`, signed with each subscription's secret. `FakeStore.rawOrder(order)` gives `data` the shape a store sends: snake_case, money as decimal strings, status as a number.
- **Uninstall:** `hub.uninstall()` refuses the app's tokens and suspends its subscriptions; installing again resumes them.

## Dashboard pages

`ExampleDashboard.start({ hub, appId, appName, appUrl, store, pages })` serves a stand-in for the merchant dashboard. Pass `dashboard.pages` from `app-config.json`: as in the real dashboard, each page is framed at `appUrl` + its `path`, and answers the bridge the same way.

## Storefront scripts

Pass your `storefront.scripts` from `app-config.json` to `ExampleDashboard.start({ ..., scripts })`; a `src` that's a path is loaded from `appUrl`. Then `/storefront` runs them on an example store page, linked from the dashboard. As on a real store, `window.FlyCommerce` is set first, `interactive` scripts load once the page can be used and `idle` ones after it has loaded, each `async`, so in no guaranteed order. The page's buttons switch between a home and a product page and dispatch `flycommerce:page`.

The page also runs the store actions on an in-page cart: `window.FlyCommerce.run()` with the store's limits, its notice with Undo, `flycommerce:cart:updated`, and `shopperToken()`. Pass `products` (e.g. a fixture's `productList`) so the cart can name them, and switch the page's **Shopper** between a guest and a signed-in customer (`customerId`, default 1001). `platform.hub.shopperToken({ appId, store, customerId })` signs one in tests; the customer's id is in it only if the installation was granted `storefront.customer`.

## Links

- [Changelog](https://github.com/getdokan/flycommerce-sdk/blob/main/js/packages/app-emulator/CHANGELOG.md)
- [All packages](https://github.com/getdokan/flycommerce-sdk#readme)
