# @flycommerce/app-testing

A fake FlyCommerce for testing your app and running it locally: a hub that issues and verifies tokens, a store with an API and webhooks, a dashboard that frames your pages, and a kit for faking a third-party OAuth 2.0 provider.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/getdokan/flycommerce-sdk/blob/main/LICENSE)

## Install

```bash
npm install --save-dev @flycommerce/app-testing
```

Node 20 or later. ESM only. **For tests and local development only.** The fakes accept any credentials they're given and must never run in production.

## Example

```ts
import { startFakePlatform } from '@flycommerce/app-testing';

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

## Links

- [Changelog](https://github.com/getdokan/flycommerce-sdk/blob/main/js/packages/app-testing/CHANGELOG.md)
- [All packages](https://github.com/getdokan/flycommerce-sdk#readme)
