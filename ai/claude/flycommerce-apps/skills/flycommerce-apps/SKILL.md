---
name: flycommerce-apps
description: Build a FlyCommerce app that merchants install into their store. Covers the install code exchange, dashboard pages and the app bridge, storefront scripts, verifying session tokens, calling the store as the user or as the app, webhooks, app-config.json, background jobs, private versus listed apps, and developing and releasing with the flycommerce CLI. Use when the project is a FlyCommerce app, or the task mentions FlyCommerce apps, app installs, session tokens, storefront scripts, app-config.json, the flycommerce CLI or the FlyCommerce developer portal.
---

# Building a FlyCommerce app

A FlyCommerce app is a web app the developer hosts. A merchant installs it into their store; it then shows pages inside the merchant's dashboard, can add scripts to the store's storefront, calls the store's API, and receives the store's webhooks.

## Sources of truth

Read before writing platform code, and again when unsure. Never guess an endpoint, field, permission, header or claim name.

- The full guide, as Markdown: https://developers.flycommerce.com/docs/guides/apps.md. Fetch it at the start of any task that touches installs, tokens, pages, webhooks or publishing. If `docs/flycommerce/building-apps.md` exists in the project, read that copy instead.
- The API reference, as OpenAPI: https://developers.flycommerce.com/docs/openapi.json. As text, with each endpoint's permissions: https://developers.flycommerce.com/llms-full.txt. Search it for an endpoint's path, parameters and required permission before calling it. If something isn't in the reference, an app can't call it: say so instead of inventing it.
- The index of everything: https://developers.flycommerce.com/llms.txt.

## The other FlyCommerce plugins

This plugin is one of a set from the `flycommerce` marketplace. Each covers one part of the platform; use the one that matches the part of the task in front of you.

- **flycommerce-api** (installed with this plugin): finding and calling store endpoints, includes, pagination, errors, webhook subscriptions. Use it for every endpoint the app calls.
- **flycommerce-ui** (installed with this plugin): the app's pages, built from `@flycommerce/ui` with the dashboard's components, tokens and icons. Use it for every screen.
- **flycommerce-mcp** (separate): an AI agent or agent platform shopping in a store. That's a different integration from an installed app, with different credentials; never mix them. If the project does that too and the skill isn't available, ask the developer to run `/plugin install flycommerce-mcp@flycommerce`.

## Use what else the session has

The FlyCommerce plugins cover only the platform. For the rest, use what's available:

- **The framework.** If a skill or plugin for the project's framework is enabled (Laravel, Next.js, Express, Rails, and so on), follow it for routing, middleware, queues, migrations and tests. Put the FlyCommerce rules below on top of it.
- **Design.** A design skill or Figma connector, if the session has one, is for reading the design. The components still come from `@flycommerce/ui`, through the flycommerce-ui skill.
- **The app bridge.** If `@flycommerce/app-bridge` is in the project's dependencies, use it for session tokens, the title bar, toasts, confirmations and navigation. If it isn't, don't add it from memory: ask the developer how their pages talk to the dashboard.
- **Testing against a store.** The developer runs a development app on their own store with `flycommerce app dev` (below). Don't create accounts, stores or credentials yourself; ask for test values and keep them out of the repo.

## Rules that must hold

### Credentials
- The app ID and app secret are used only to exchange an install code: `POST https://developers.flycommerce.com/api/oauth/token` with `grant_type=authorization_code`, `code`, `app_id`, `app_secret` and `redirect_uri`. Nothing else.
- That exchange returns a credential for one store (`app_id`, `app_secret`, `store`, `scope`). Store it encrypted, keyed by `store`, and overwrite it on reinstall; the old one stops working.
- An app access token comes from the same endpoint with `grant_type=client_credentials` and that store's credential, not the app's. It lasts 15 minutes and has no refresh token.
- `scope` is what the merchant granted, which can be less than requested. Design for it.
- Secrets live only on the server, in environment variables or encrypted storage. Never in frontend code, logs, URLs or the repo.

### Install callback
- Exchange `code` immediately: it expires in 60 seconds and works once.
- Never trust the `store` query parameter; use the `store` from the exchange response. It's the store's permanent `<name>.flycom.shop` host.
- Redirect to `return_to` only when it's an `https://*.flycommerce.com` or `https://*.flycom.shop` URL whose path starts with `/admin/apps/`. Send `Referrer-Policy: no-referrer`.

### Pages in the dashboard
- Every page sends `Content-Security-Policy: frame-ancestors https://*.flycommerce.com https://*.flycom.shop`.
- Pages have no cookie session. Each request to the app's server carries `Authorization: Bearer <session token>`, fetched fresh from the bridge for every request.

### Storefront scripts
- Use them for features shoppers see on the store: chat, reviews, badges. Declare up to 3 in `app-config.json`: `"storefront": { "scripts": [{ "handle": "chat", "src": "/chat.js", "load": "idle" }] }`.
- `handle` is `[a-z0-9-]{1,40}` and unique; `src` is a path on `appUrl` (write it this way) or an `https` URL on the same host, up to 2000 characters, with no secrets in it; `load` is `interactive` or `idle` (the default). Prefer `idle` unless the feature is needed as soon as the page can be used.
- Be honest with the developer about the trust model: the script runs on the store's pages with the page's full access. FlyCommerce serves only what the app declares, from its own host, after reviewing the version; the merchant grants `storefront.scripts` at install and can switch scripts off; FlyCommerce can suspend them. They never run on the builder or previews, the customer account (`/customers/*`), checkout, payment and order pages, sign-in and account pages (login, register, forgot and reset password, OTP verification, `/private`), or the dashboard (`/admin`, `/dashboard`, `/vendor`). Navigating into or out of those pages reloads the page, so no app script sees their data; don't promise more than that, and never try to reach them.
- Read the store's context from `window.FlyCommerce` (`store`, `locale`, `currency`, `pageType`) and follow client-side navigation with the `flycommerce:page` event (`detail: { pageType, path }`). `pageType` in the global is the page the script loaded on; after that, only the event is current. Type both with `import type {} from '@flycommerce/app-bridge/storefront'`. Spec: https://github.com/getdokan/flycommerce-sdk/blob/main/spec/storefront-scripts.md.
- There's no customer data: no shopper ID, name, email, cart or token. Never read the store's storage, cookies or tokens to get it, and never send the page's data to the app's server beyond what the feature needs.
- Scripts load `async`, in no guaranteed order. Make each one self-contained; never depend on another script, or the page's code, having loaded first.
- Keep the script small and self-contained: one root element of the app's own, prefixed names, no changes to the store's elements, styles or globals, no thrown errors. Ask for consent before tracking; stores have no consent banner yet.
- Test locally with `@flycommerce/app-emulator`: pass the scripts to `ExampleDashboard.start({ scripts })` and open `/storefront` on the example dashboard.

### Session tokens
- Verify on the server before reading any claim: `alg` is RS256 (refuse anything else, including `none`); the signature verifies with the matching `kid` from `https://app.flycommerce.com/.well-known/jwks.json` (cache an hour, refetch at most every 30 seconds on an unknown `kid`); `exp` and `nbf` hold with a few seconds of leeway; `typ` is `session`; `aud` is the app ID; `iss` is `https://app.flycommerce.com`.
- On any failure answer `401` with no detail.
- The store is `store_domain` from the verified token. Never take a store from a URL, body or header.
- `user_role` is `owner` or `admin`: only they can open apps today. `vendor` is reserved for marketplace sellers. Treat any other value as the least privileged.

### Calling the store
- Calls go to `https://<store>/api/v1/...` with a bearer token.
- For a user in the app's pages: exchange the session token at `POST https://<store>/api/v1/apps/token` with `{"session_token": "..."}`. The store then allows what both the app and that user may do. Cache per `store_domain` + `sub` + `sid`; renew a minute before the 15 minutes run out.
- For webhooks and scheduled jobs: the app access token.
- Never ask a merchant for a personal access token (`flyp_...`). Those are for a person's own scripts.
- A `403` or `422` from the store is final: show its message, don't retry it, don't re-implement its permission checks. Retry only timeouts, `5xx` and `429`, with backoff and `Retry-After`.
- If a fresh token is refused, the app was uninstalled or rejected: mark the store removed and stop its work. Nobody sends an uninstall event.

### Webhooks
- Subscribe with `POST https://<store>/api/v1/integrations/webhooks` as the app (`webhooks.manage`). Store the returned secret encrypted; it's shown once.
- Verify `X-Webhook-Signature` (lowercase hex HMAC-SHA256 of the raw body bytes, keyed with that subscription's secret) in constant time before parsing JSON. Configure the framework so the raw body is available.
- Answer an unknown store and a bad signature identically.
- Each event is sent once and never retried, with no delivery ID or timestamp. Handlers are idempotent, keyed on the resource ID and its update time. Return `2xx` fast and do the work in a background job. A scheduled job catches up on what deliveries missed.
- Uninstalling suspends the app's subscriptions; reinstalling resumes them. Reconcile on install and on startup: list the app's subscriptions, delete any it can't verify, create the missing ones.

### Data
- Every table has the store, and every query filters on the store from the verified session token or the job's store.
- Never log tokens, secrets, codes, query strings or customer data.

### app-config.json
- Only `appUrl` differs between environments. Write every page `path`, script `src` and `install.redirectUrl` as a path on it (`"/auth/callback"`), never with a host, so the same file works for production, a development app and a tunnel. Spec: https://github.com/getdokan/flycommerce-sdk/blob/main/spec/app-config.md.
- One file per app: `app-config.json` for the production app, `app-config.<name>.json` (like `app-config.dev.json`) for another, differing in `appId`.
- `install.redirectUrl` is optional; when set, releasing the file sets the app's redirect URL. Set it, so installs follow `appUrl`.
- `storefront` is optional and takes only `scripts` (see above).
- Pages: at most 20, at most one level of `children`; `label` up to 40 characters; `slug` of letters, numbers, `-` and `_`; `path` starting with `/` with no spaces, `?` or `#`.
- `appUrl` is `https` (plain `http` only for `localhost` and `.test`). `versionId` and `version` are optional: leave them out and let `flycommerce app release` fill them in. If they're there, they must match the changelog entry.
- Check the file with `loadAppConfig` from `@flycommerce/app-server` at the server's start; `appServerConfigFromEnv` reads `APP_URL` and defaults `REDIRECT_URI` to `APP_URL/auth/callback`.

### Develop and release with the CLI
- `@flycommerce/cli` (`npx flycommerce`) does the portal bookkeeping. Prefer it to describing portal clicks. Guide: https://github.com/getdokan/flycommerce-sdk/tree/main/js/packages/cli.
- One app per environment: the production app merchants install, and an unpublished development app installed only on the developer's own stores. `flycommerce app link --config dev` writes the development app's ID into `app-config.dev.json`.
- `flycommerce app dev --config dev -- <server command>` opens a tunnel (Cloudflare's `cloudflared`, or `--tunnel-url`), pushes the config to the development app with `appUrl` set to the tunnel, and runs the server with `APP_URL`, `REDIRECT_URI`, `PORT` and `APP_CONFIG_FILE` set. The server reads those rather than hard-coding a host or port, and loads the config from `APP_CONFIG_FILE` when it's set. The development app's ID and secret go in the developer's `.env`, never in the repo.
- `app dev` refuses a published app. Never work around that by pointing the production app at a tunnel: merchants' stores would load it.
- `flycommerce app release --version 1.2.0 --message "…"` checks the config, creates the version and releases it; a listed app's new pages, permissions and scripts wait for review. In CI it reads a per-app deploy token from `FLYCOMMERCE_TOKEN`.
- `flycommerce login` signs in through the browser. Never ask the developer for their token, and never print, log or commit one.

### Private and listed apps
- An unpublished app is **private**: it installs only on stores owned by the developer account that owns the app, on a marketplace or a standalone store alike, and no other merchant sees it. Publishing lists it for every merchant, after FlyCommerce's review.
- A private app's pages and requested permissions apply without review; privileged permissions still need FlyCommerce to grant them.
- The code is the same either way: still key data by store (the owner may have several stores), and still verify every token. Publishing later changes nothing in the app.
- On a marketplace store, only the owner and admins open the app's pages today; vendors can't. Still gate on `user_role`, so a later vendor role gets the least access.
- A private app can't be installed on a store another account owns. If the developer needs that, the answer is publishing it, not a workaround.

## How to work

- Build one piece at a time, each with its tests: project config, install callback, session-token middleware, one page calling the store, webhooks, background jobs.
- Test the failure cases the rules name: an expired or reused code, a reinstall, a `return_to` on another site, a token for another app, `alg: none`, an unknown `kid`, a bad webhook signature, the same webhook twice, a refused token.
- Before calling a piece done, check it against the rules above and say which ones it relies on.
