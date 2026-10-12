# Storefront scripts

An app can add scripts to the merchant's storefront, for chat, reviews, badges and similar features.

## The trust model

A script runs on the store's own pages, with the page's full access: its DOM, its storage and whatever the page can reach. So:

- FlyCommerce serves only the scripts an app declares in its released `app-config.json`, and only from the app's own host.
- A listed app's scripts are reviewed with its version. A changed `src` or a new script is reviewed again; until then stores keep the approved ones. A private app's scripts run without review, and only on its owner's stores.
- Installing asks the merchant for the `storefront.scripts` permission ("Adds scripts to your storefront"). Stores that installed before an app declared scripts reinstall to grant it.
- The merchant can switch an app's scripts off. FlyCommerce can suspend them for every store.
- Scripts never run on these pages:
  - the builder and previews;
  - the customer account (`/customers/*`);
  - checkout, payment and order pages;
  - sign-in and account pages: login, register, forgot and reset password, OTP verification, and `/private`;
  - the dashboard: `/admin`, `/dashboard` and `/vendor`.

  Navigating into or out of one of them reloads the page, so no app script carries over in either direction.

Review covers the URL, not every later copy of the file behind it. That's why FlyCommerce can suspend an app's scripts at any time.

## Declaring them

```json
"storefront": {
  "scripts": [{ "handle": "chat", "src": "/widget.js", "load": "idle" }]
}
```

| Key | Rule |
| --- | --- |
| `handle` | `[a-z0-9-]{1,40}`, unique within the app. Names the script to the merchant and in support. |
| `src` | A path on `appUrl`, like `/widget.js`, or an `https` URL on the same host as `appUrl`; at most 2000 characters. A path starts with a single `/` and is appended to `appUrl` (see [app-config.md](app-config.md#paths-and-urls)), so it follows the app between environments. Plain `http` only for local development. It's public: no secrets in it. |
| `load` | `interactive`: once the page can be used. `idle`: when the browser is idle after the page has loaded. The default is `idle`. |

At most 3 scripts. `storefront` takes only `scripts`, and each script only these keys.

## How a store loads them

- On each full page load of a catalogue page, after the storefront's own code, each script is added once, as `<script id="app-<app>-<handle>" src="<src>">`. Client-side navigation doesn't load them again.
- `interactive` scripts start loading before `idle` ones, but each loads `async`: there's no guaranteed order, between groups or within one. Make each script self-contained; never depend on another script having loaded first.

## Store context

Before any app script, the page sets:

```js
window.FlyCommerce = { store: 'demo.flycom.shop', locale: 'en', currency: 'USD', pageType: 'product' };
```

| Field | Meaning |
| --- | --- |
| `store` | The store's domain |
| `locale` | The shopper's language, e.g. `en`, `bn` |
| `currency` | ISO 4217 code |
| `pageType` | The kind of page the script loaded on, e.g. `home`, `product`, `category`. Set at load only; follow `flycommerce:page` after that. |

It holds nothing about the shopper: no customer ID, name, email, cart or order.

## Store actions

Stores that support them add functions to `window.FlyCommerce`; check before calling (`typeof window.FlyCommerce.run === 'function'`). `run(name, input)` does what the shopper could do with a click, through the store's own code, so the cart count and drawer update as usual. It resolves to `{ ok: true, result }` or `{ ok: false, error }`, where `error` is the store's own message.

| Action | Input | Result |
| --- | --- | --- |
| `cart.get` | — | `{ lines: [{ productId, variationId?, name, quantity, unitPrice, total }], count, subtotal }`: never the cart's id or anything about the customer |
| `cart.add` | `{ items: [{ productId, variationId?, quantity }] }`, 1–10 lines, quantity 1–10 | The new cart |
| `cart.update` | `{ productId, variationId?, quantity }` | The new cart |
| `cart.remove` | `{ productId, variationId? }` | The new cart |
| `nav.goto` | `{ to: 'product' \| 'collection' \| 'category', slug }` or `{ to: 'cart' }` | `null`. Never another site, never checkout |
| `ui.openCart` | — | `null` |

- `can(name)` says whether the store has an action; `actions()` lists them, each with a description written for an AI choosing a tool and whether it `changes` the cart.
- The store announces every change with its own notice and an Undo, and allows at most 10 changes a minute per page.
- After each change, `flycommerce:cart:updated` is dispatched on `window` with the new cart as `detail`.
- Actions work on the cart of whoever is on the page, guest or signed in, so a script never needs the cart's id and is never given it. An app's server can't change a cart: Cart and Checkout refuse app tokens.

These run with the page's privileges, like the rest of your script: they are a convenience and a contract, not a permission boundary.

## Shopper tokens

`await window.FlyCommerce.shopperToken(appId)` resolves to a token for your app's server, or `null` when the store won't issue one (your app's scripts don't run on this store, or the store can't be reached). Send it in `Authorization: Bearer` and verify it on the server, never in the browser.

It's an RS256 JWT signed with the same keys as session tokens ([session-token.md](session-token.md)), valid for 5 minutes:

| Claim | Meaning |
| --- | --- |
| `typ` | `shopper` |
| `aud`, `iss` | Your App ID; FlyCommerce |
| `store_domain`, `marketplace_id`, `installation_id` | The store and your installation |
| `signed_in` | `true` only for a customer's own sign-in. Store staff, and support signed in as a customer, are guests |
| `customer_id` | The store's id for the customer, only if the merchant granted `storefront.customer`; otherwise `null` |

It identifies; it isn't a login, and no store API accepts it. With `customer_id`, read that customer's orders as your app (`GET /api/v1/orders?filters[customerId]=…`, `orders.read`), and show them only their own.

After each client-side navigation, the page dispatches on `window`:

```js
new CustomEvent('flycommerce:page', { detail: { pageType: 'category', path: '/categories/tea' } });
```

## Writing a script

- Load fast and fail quietly. Never block the page or throw into it.
- Stand alone. Don't depend on another of your scripts, or the page's own code, having loaded first.
- Put everything inside your own element and your own names. Don't change the store's elements, styles or globals.
- Don't read the store's storage, cookies or tokens, even though you can.
- Ask for consent before tracking: the store has no consent banner yet.
