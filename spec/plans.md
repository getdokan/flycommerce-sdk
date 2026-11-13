# Plans, locked pages and callbacks

An app can offer plans and decide, page by page, which stores open what. The conditions live in [app-config.json](app-config.md); FlyCommerce applies them to the merchant's menu, and the app applies the same rule on its own server. Where a merchant lands when a page is locked, or when they ask for another plan, is the app's decision, made through callbacks.

## Plans

```json
{
  "plans": [
    { "key": "free", "name": "Free", "default": true },
    { "key": "pro", "name": "Pro" }
  ],
  "planCallback": "/callbacks/plan"
}
```

| Key | Rule |
| --- | --- |
| `key` | Starts with a lower-case letter; up to 40 lower-case letters, numbers and `-`. Unique within the app. |
| `name` | 1 to 40 characters. Shown to the merchant. |
| `default` | Exactly one plan has `"default": true`: the plan a store is on until the app sets another. |

A store's plan belongs to its installation. It starts on the default plan, and falls back to it if the app stops declaring the plan it was on. Installing the app again over a live installation, which is how a store approves new permissions, keeps the plan; removing the app and installing it again starts over on the default.

## What a store gets of a page

A page is one of:

| State | When |
| --- | --- |
| `available` | `isActive` isn't `false`, and the page has no `plans` or they include the store's plan. |
| `plan` | `isActive` isn't `false`, but the page's `plans` don't include the store's plan. |
| `inactive` | `isActive` is `false`. This wins over `plan`. |

A sub-page that is `available` on its own takes its parent's state when the parent is locked.

An available page is in the app's menu and framed as usual. A locked page stays in the menu with a lock, and is **never framed**. The app must apply the same rule on its server from the token's `plan` claim: a locked menu item doesn't stop a request to the app's API.

## The `plan` claim

Session tokens and shopper tokens carry `plan`: the key of the plan the store is on, or `null` when the app declares no plans. See [session-token.md](session-token.md) and [storefront-scripts.md](storefront-scripts.md). A token without the claim reads as the default plan.

## Callbacks

FlyCommerce calls a callback from its own servers, with the **session token** of the person who clicked:

```http
POST https://app.example.com/callbacks/reports-locked
Authorization: Bearer <session token>
Content-Type: application/json
Accept: application/json
```

Verify the token exactly as for a request from the app's own page. It names the store, the person, their role and the plan.

| Callback | When | Body |
| --- | --- | --- |
| A page's `callback` | A store that can't open the page clicks it. | `{ "page": "<slug>", "reason": "plan" \| "inactive" }` |
| `planCallback` | The store's owner asks for another plan. | `{ "plan": "<key asked for>", "currentPlan": "<key>" \| null }`. `currentPlan` is a convenience: the plan to trust is the token's `plan` claim. |

Answer with status `200` and JSON, within **3 seconds**:

```json
{ "path": "/upgrade?from=reports" }
```

or

```json
{ "dashboard": "/admin/apps" }
```

| Answer | Rule | What happens |
| --- | --- | --- |
| `path` | Up to 2000 characters, starting with one `/` (not `//`), with no `\`, `#` or spaces. A query string is allowed. | The dashboard frames it on the callback's host, like a page. It must allow framing like one, and needn't be in `dashboard.pages`. |
| `dashboard` | `/admin` or a path under it, up to 2000 characters, with no `//`, `\`, `#`, spaces or control characters, and no `..` segment once percent-decoded. A query string is allowed and isn't judged. A page of the same app that is itself locked counts as no answer. | The dashboard goes to that page of the merchant's admin. |

Anything else is no answer: a timeout, a status other than `200`, a redirect (never followed), a body that isn't one of the two shapes, or a page without a `callback`. The merchant then sees FlyCommerce's own notice that the page isn't available. For `planCallback`, an app without one gives the merchant no way to ask for another plan from the dashboard.

A callback URL is a path on `appUrl`, or a URL on `appUrl`'s own address (the same scheme, host and port), with no query string, and at most 2000 characters once joined to `appUrl`. FlyCommerce calls it only over `https` on a public address. Once the app is published, a new or changed callback waits for review; until then stores keep the approved one, and the app's pages keep working. A removed callback stops being called at once.

New or changed `plans`, on the app or on a page, wait for review the same way once the app is published, and apply together when approved: until then stores keep the pages they have, so none is locked out of a page before it can move to the plan that opens it. `isActive` takes effect at once.

`planCallback` is sent only for the store's owner, and only on a store that approved `plan.manage`. An app should still refuse a plan callback whose token isn't the owner's, since any staff member's page holds a session token.

## Setting a store's plan

FlyCommerce never changes a plan and takes no payment. After its own checkout, the app tells FlyCommerce the plan the store is now on, with its **app access token**:

```http
PUT https://<store_domain>/api/v1/app-installation/plan
Authorization: Bearer <app access token>
Content-Type: application/json

{ "plan": "pro" }
```

| Status | Meaning |
| --- | --- |
| `200` | The store is on that plan. Its menu and its next tokens follow. |
| `403` | The app lacks `plan.manage`, or the token is a user access token: only the app itself sets a plan. |
| `422` | The app doesn't declare that plan. |

The `plan.manage` permission is added to an app while its config declares `plans`, with or without a `planCallback`, and merchants approve it when they install. A store that installed the app before it had plans approves it by installing the app again, which keeps its plan; until then it is offered no plan switch.
