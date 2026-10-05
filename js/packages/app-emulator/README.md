# @flycommerce/app-emulator

A local FlyCommerce emulator for developing and testing your app, with no account or network needed: a hub that issues and verifies tokens, a store with an API and webhooks, a dashboard that frames your pages, and a kit for faking a third-party OAuth 2.0 provider.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/getdokan/flycommerce-sdk/blob/main/LICENSE)

## Install

> **Not on npm yet.** The first release comes with FlyCommerce's app platform launch. Until then, build it from this repository.

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

- **Orders:** `addOrder()` stamps real times, and the order list honours `include`, `paginate=full`, `sort` and `filters[createdAt]` / `filters[updatedAt]` (a bare date means "since").
- **Webhooks:** `deliver(store, event, data)` sends the real body, `{event, timestamp, data}`, signed with each subscription's secret. `FakeStore.rawOrder(order)` gives `data` the shape a store sends: snake_case, money as decimal strings, status as a number.
- **Uninstall:** `hub.uninstall()` refuses the app's tokens and suspends its subscriptions; installing again resumes them.

## Links

- [Changelog](https://github.com/getdokan/flycommerce-sdk/blob/main/js/packages/app-emulator/CHANGELOG.md)
- [All packages](https://github.com/getdokan/flycommerce-sdk#readme)
