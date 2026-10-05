---
name: flycommerce-api
description: Call a FlyCommerce store's REST API, from an installed app or from a script with a personal access token. Covers getting a token, finding the endpoint and permission in the API reference, filters, includes, pagination, incremental sync, errors and webhook subscriptions and signatures. Use when code calls https://<store>/api/v1/..., or the task mentions the FlyCommerce API, a FlyCommerce store's orders, products or webhooks, or a flyp_ token.
---

# Calling a FlyCommerce store's API

Every store serves its own API at `https://<store>/api/v1/...`, where `<store>` is the store's host. Calls carry a bearer token that works for that one store.

## Sources of truth

- The API reference, as OpenAPI: https://developers.flycommerce.com/docs/openapi.json. As text, with each endpoint's summary and permissions: https://developers.flycommerce.com/llms-full.txt. If `docs/flycommerce/openapi.json` exists in the project, read that copy instead.
- Find every endpoint, parameter, field and permission there before writing the call. **An endpoint that isn't in the reference is closed to apps**, whatever the merchant granted: say so instead of guessing one.
- Treat unknown response fields as normal; fields are added without notice. Don't validate strictly against the reference.

## The other FlyCommerce plugins

This plugin is one of a set from the `flycommerce` marketplace. If the task reaches beyond calling the API, use the matching one; if its skill isn't available, ask the developer to install it (you can't run `/plugin` commands yourself).

- **flycommerce-apps** (`/plugin install flycommerce-apps@flycommerce`): when the code is part of an app merchants install: installs, session tokens, dashboard pages, publishing. It decides which token an app uses; this skill covers the calls.
- **flycommerce-mcp** (`/plugin install flycommerce-mcp@flycommerce`): when an AI agent is shopping in a store. Shopping goes through the store's MCP server or UCP endpoints, not this API.

If a skill or plugin for the project's language or HTTP client is enabled, follow it for the code; the rules here are what FlyCommerce requires.

## Getting a token

Every token lasts 15 minutes. There is no refresh token: get a new one.

| Who is calling | How |
| --- | --- |
| An installed app, for a user in its pages | `POST https://<store>/api/v1/apps/token` with `{"session_token": "..."}`. Allows what both the app and that user may do. |
| An installed app, with no user (webhooks, jobs) | `POST https://developers.flycommerce.com/api/oauth/token` with `grant_type=client_credentials` and **that store's credential** from the install exchange, never the app's own ID and secret. The answer's `store` is the host to call. |
| A merchant's or staff member's own script | `POST https://<store>/api/v1/tokens/exchange` with `{"token": "flyp_..."}`. The person creates the `flyp_` token under **Profile → Personal access tokens** in the dashboard, picking its permissions and an expiry of up to 180 days. |

- Read tokens and credentials from environment variables or a secret store. Never put them in code, logs, URLs or the repo.
- An app never asks a merchant for a personal access token.
- The URL decides the store; the token decides whether you may. A token for one store doesn't work on another.

## Making calls

- Responses are wrapped in `data`.
- **Relations are opt-in:** ask with `include=`, for example `include=lineItems,orderGroup` on orders. An unknown include is a `400`.
- **Filters are `filters[...]`**, plural; `filter` is a `400` naming the right one. Unknown filter and sort names are a `400`.
- **Paging is opt-in.** Without `paginate` you get only the first `limit` rows and no sign of more, and `page` alone does nothing. Use `paginate=full` with `page` and `limit` for `meta` (`currentPage`, `lastPage`, `perPage`, `total`), or `paginate=cursor` to walk a large set.
- **Incremental sync:** `filters[updatedAt]` with `sort=updatedAt,id`. A bare value means "since". Deletions and unpublished records just disappear, so only a periodic full read finds them.
- **Cart and Checkout** endpoints are the shopper's own flow and refuse app tokens.

## Errors

- `401`: the token expired, the login ended, or the app was uninstalled. Get a new token once; if that's refused too, stop working for that store.
- `403` naming a permission: the merchant didn't grant it. Tell the user which one. `403` saying the endpoint isn't available to apps: that won't change.
- `422`: a business rule refused the action (for example holding a completed order). Show the message; don't retry.
- Retry only timeouts, `5xx` and `429`, with backoff, honouring `Retry-After`.

## Webhooks

- Subscribe with `POST https://<store>/api/v1/integrations/webhooks` (`webhooks.manage`): `endpoint`, `events`, `description`, `status`. The answer's secret is shown once: store it encrypted.
- Events: `order.created`, `order.updated`, `order.deleted`, `order.canceled`, `order.completed`, `order.refund.created`, `order.shipment.created`, `order.shipment.updated`, and `created`/`updated`/`deleted` for `product`, `category`, `collection` and `brand`.
- Verify `X-Webhook-Signature`: lowercase hex HMAC-SHA256 of the **raw body bytes**, keyed with the subscription's secret, compared in constant time (`hash_equals`, `crypto.timingSafeEqual`), before parsing JSON.
- Each event is sent once, never retried, with no delivery ID or timestamp. Make handlers idempotent on the resource ID and update time, answer `2xx` fast, and catch up on a schedule.

## How to work

- Show the request you're about to send (method, URL, query, body, which token) before writing the code around it, so the developer can check it against the reference.
- For scripts, read the store host and token from the environment, and print what was done in words a merchant understands.
