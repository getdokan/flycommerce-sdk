# @flycommerce/app-bridge

Run your FlyCommerce app's pages inside the merchant dashboard. The bridge gets session tokens for your server, and lets your page navigate, set the dashboard's title bar, show toasts and confirmations, and follow the dashboard's language, direction and theme.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/getdokan/flycommerce-sdk/blob/main/LICENSE)

## Install

> **Not on npm yet.** The first release comes with FlyCommerce's app platform launch. Until then, build it from this repository.

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

## On your server

Verify the session token before trusting it:

```ts
import { verifySessionToken } from '@flycommerce/app-bridge/server';

const session = await verifySessionToken(token, { appId: process.env.APP_ID! });
// session.store_domain and session.sub tell you which store and which user.
```

`@flycommerce/app-server` wraps this together with the rest of what a server needs.

## Security

- The bridge only talks to the dashboard that framed it. It checks the sender and origin of every message, and never posts to `*`.
- `verifySessionToken` accepts only RS256 tokens signed by a FlyCommerce key, for your app (`aud`) and from FlyCommerce (`iss`), within their 60-second life.

The token format is in [`spec/session-token.md`](https://github.com/getdokan/flycommerce-sdk/blob/main/spec/session-token.md). Report vulnerabilities through [SECURITY.md](https://github.com/getdokan/flycommerce-sdk/blob/main/SECURITY.md).

## Links

- [Changelog](https://github.com/getdokan/flycommerce-sdk/blob/main/js/packages/app-bridge/CHANGELOG.md)
- [All packages](https://github.com/getdokan/flycommerce-sdk#readme)
