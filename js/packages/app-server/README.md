# @flycommerce/app-server

Server-side building blocks for FlyCommerce apps, on Node's own `http` module and with no dependencies beyond `@flycommerce/app-bridge`.

- **`authenticate()`**: verify the session token on a request from your page, and get the store and user.
- **`StoreApi`**: call the store API **as the user** (only what both your app and that user may do) or **as the app** (for webhooks and background jobs). Tokens are exchanged and cached for you.
- **`handleInstall()`**: finish an install redirect and keep the store's credential.
- **`OAuthFlows`**: let a merchant sign in to a third-party service (state check, cookie binding, code exchange).
- **`serveWebApp()`**: serve your built pages with the right framing headers.
- **`Sealer`**: AES-256-GCM encryption for secrets you hold for a merchant.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/getdokan/flycommerce-sdk/blob/main/LICENSE)

## Install

> **Preview.** On npm under the `next` tag while FlyCommerce's app platform is in testing: `npm install @flycommerce/app-server@next`. The first stable release comes with the launch.

```bash
npm install @flycommerce/app-server
```

Node 22 or later. ESM only.

## Example

```ts
import http from 'node:http';
import { HubClient, StoreApi, appServerConfigFromEnv, authenticate, handleInstall, json, sendError } from '@flycommerce/app-server';

const config = appServerConfigFromEnv();
const hub = new HubClient(config);
const store = new StoreApi(config, hub);

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    try {
      if (url.pathname === '/auth/callback') {
        await handleInstall(url, res, { hub, credentials: config.credentials, frameAncestors: config.frameAncestors, appName: 'My app' });
        return;
      }

      if (url.pathname === '/api/orders') {
        const session = await authenticate(req, config);
        return json(res, 200, await store.asUser(session).get('/api/v1/orders'));
      }

      json(res, 404, { error: 'not_found' });
    } catch (error) {
      sendError(res, error, 'my-app');
    }
  })
  .listen(3000);
```

### Webhooks

Subscribe in `handleInstall`'s `onInstalled`, which runs before the merchant is sent back. `reconcileWebhook` leaves exactly one subscription per endpoint and returns its secret; keep that sealed. If `onInstalled` fails, the install still completes, so call `reconcileWebhook` again on startup for any store with no secret.

```ts
import { readWebhook, reconcileWebhook } from '@flycommerce/app-server';

// In handleInstall's options:
onInstalled: async (store) => {
  const endpoint = `https://my-app.example/webhooks?store=${store}`;
  const { secret } = await reconcileWebhook(api.asApp(store), { endpoint, events: ['order.created'] });
  webhookSecrets.set(store, secret);
},

// The endpoint: the store comes from `?store=` and is trusted only because the body verifies under its secret.
if (url.pathname === '/webhooks') {
  const { store, delivery } = await readWebhook(req, (s) => webhookSecrets.get(s));
  // delivery.event, delivery.timestamp, delivery.data
  return json(res, 200, {});
}
```

`readWebhook` answers an unknown store and a bad signature with the same `401`. `data` is the record as the store keeps it (snake_case, money as decimal strings). See [`spec/webhooks.md`](https://github.com/getdokan/flycommerce-sdk/blob/main/spec/webhooks.md).

### Third-party sign-in

`OAuthFlows` lets a merchant connect their account on another service, such as Mailchimp, to their store. Your page asks your server for a ticket, with the store taken from the session token, and opens its `beginUrl` in a new tab:

```ts
import { OAuthFlows } from '@flycommerce/app-server';

const mailchimp = new OAuthFlows(
  {
    name: 'mailchimp',
    label: 'Mailchimp',
    authorizeUrl: 'https://login.mailchimp.com/oauth2/authorize',
    tokenUrl: 'https://login.mailchimp.com/oauth2/token',
    clientId: process.env.MAILCHIMP_CLIENT_ID!,
    clientSecret: process.env.MAILCHIMP_CLIENT_SECRET!,
    redirectUri: 'https://my-app.example/auth/mailchimp/callback',
  },
  { secret: process.env.OAUTH_SECRET } // optional, see below
);

if (url.pathname === '/api/mailchimp/connect') {
  const { store } = await authenticate(req, config);
  return json(res, 200, mailchimp.issueTicket(store));
}
if (url.pathname === mailchimp.beginPath) return mailchimp.begin(url, res);
if (url.pathname === mailchimp.callbackPath) {
  const { store, tokens } = await mailchimp.complete(req, url, res);
  // Keep tokens for store, sealed.
}
```

The ticket and the `state` are sealed with AES-256-GCM, so nothing is stored until the callback. The callback finishes only in the browser that began the flow, within ten minutes, and each ticket finishes at most one sign-in.

**More than one instance.** Without `secret`, each instance seals with its own random key, so a flow must begin and finish on the instance that issued the ticket. Give every instance the same `secret`, at least 32 bytes and known only to your app (`openssl rand -base64 32`); never the provider's client secret, which the provider knows.

Spent tickets are remembered in memory, per instance. With several instances, a ticket that leaked within its ten minutes, from browser history or an access log, could finish a second sign-in on another instance and link someone else's account to the store. Share one store between instances; `spend` must be atomic:

```ts
const nonces = {
  spend: async (nonce: string, expiresAt: number) => (await redis.set(`oauth:${nonce}`, '1', { NX: true, PXAT: expiresAt })) === 'OK',
};
new OAuthFlows(provider, { secret: process.env.OAUTH_SECRET, nonces });
```

### Uninstalls

Nobody tells an app it was removed: the store just refuses its credential. `isInstallationRevoked(error)` recognises that refusal, so the app can stop serving the store and `credentials.delete(store)`.

### Configuration

`appServerConfigFromEnv()` reads:

| Variable                      | Required | Meaning                                                                                                     |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `APP_ID`, `APP_SECRET`        | yes      | From the developer portal                                                                                   |
| `HUB_API_URL`                 | yes      | FlyCommerce's API, `https://developers.flycommerce.com/api`                                                 |
| `APP_URL`                     | no       | Where the app is served. `flycommerce app dev` sets it to the tunnel                                        |
| `REDIRECT_URI`                | no       | Your install redirect, exactly as registered. Defaults to `APP_URL/auth/callback`; one of the two is needed |
| `JWKS_URL`, `ALLOWED_ISSUERS` | no       | FlyCommerce's: `https://app.flycommerce.com/.well-known/jwks.json` and `https://app.flycommerce.com`        |
| `STORE_BASE_URL`              | no       | Local development only: sends every store's calls, tokens included, to this one host                        |
| `FRAME_ANCESTORS`             | no       | Dashboards allowed to frame your pages                                                                      |
| `CREDENTIALS_FILE`            | no       | Where `FileCredentialStore` keeps store credentials (default `data/credentials.json`)                       |

`FileCredentialStore` suits a single instance: it writes atomically with `0600` permissions. Pass `{ sealer: new Sealer(key) }` to keep every credential encrypted on disk. Running more than one instance? Implement `CredentialStore` (`get`, `put`, `delete`) on your database.

### app-config.json

`loadAppConfig(file)` reads and checks `app-config.json` with FlyCommerce's rules, so a broken file stops the app at start instead of at release; `checkAppConfig(value)` returns every problem with a parsed one. `versionId` and `version` are optional: `flycommerce app release` fills them in.

Write script `src` and `install.redirectUrl` as paths, so the same file works with any `appUrl`:

```json
{
  "appId": "my-app",
  "appUrl": "https://my-app.example",
  "install": { "redirectUrl": "/auth/callback" },
  "dashboard": { "pages": [{ "slug": "home", "label": "Home", "path": "/home" }] },
  "storefront": { "scripts": [{ "handle": "chat", "src": "/chat.js" }] }
}
```

`resolveAppConfig(config, { appUrl })` returns the config with those paths as absolute URLs on `appUrl` (the file's own, or the one given), which is what FlyCommerce stores. The install redirect is kept exactly as written, since the install exchange compares it byte for byte; it needs an ASCII host and at most 255 characters once joined to `appUrl`. See [`spec/app-config.md`](https://github.com/getdokan/flycommerce-sdk/blob/main/spec/app-config.md).

### Storefront scripts

An app can add up to three scripts to the merchant's storefront, for chat, reviews and similar features. Declare them in `app-config.json`:

```json
"storefront": { "scripts": [{ "handle": "chat", "src": "/chat.js", "load": "idle" }] }
```

- `handle`: lower-case letters, numbers and `-`, up to 40 characters, unique within the app.
- `src`: a path on `appUrl`, like `/chat.js`, or an `https` URL on the same host as `appUrl`; up to 2000 characters.
- `load`: `interactive` (once the page can be used) or `idle` (after the page has loaded, the default).

`loadAppConfig` checks all of it. Serve the files yourself, as `text/javascript`.

A script runs on the store's pages with the page's full access. That's why FlyCommerce serves only the scripts you declare, from your own host, after reviewing the version. The merchant can switch them off, and FlyCommerce can suspend them. They never run on the builder or previews, the customer account, checkout, payment and order pages, sign-in and account pages, or the dashboard; navigating into those pages reloads the page, so no app script carries over. Each script loads `async` in no guaranteed order, so make each one self-contained. See [`spec/storefront-scripts.md`](https://github.com/getdokan/flycommerce-sdk/blob/main/spec/storefront-scripts.md).

## Security

- Every outgoing request has a timeout.
- API answers are sent with `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- OAuth sign-in requires the sealed `state` it issued, and finishes only in the browser holding the `HttpOnly`, `SameSite=Lax` cookie set with it, compared in constant time.
- The store is always taken from the verified session token, never from the request.

Report vulnerabilities through [SECURITY.md](https://github.com/getdokan/flycommerce-sdk/blob/main/SECURITY.md).

## Links

- [Changelog](https://github.com/getdokan/flycommerce-sdk/blob/main/js/packages/app-server/CHANGELOG.md)
- [The contract](https://github.com/getdokan/flycommerce-sdk/tree/main/spec)
- [All packages](https://github.com/getdokan/flycommerce-sdk#readme)
