# @flycommerce/app-server

## 0.1.0

- First public release.
- Storefront scripts: `app-config.json` can declare up to three under `storefront.scripts` (`handle`, an `https` `src` on the `appUrl` host, `load` of `interactive` or `idle`), and `loadAppConfig` checks them.
- `app-config.json` for every environment: a script `src` and the new `install.redirectUrl` can be paths on `appUrl`, `versionId` and `version` are optional, and `resolveAppConfig` turns the paths into URLs on a given `appUrl`.
- `appServerConfigFromEnv` reads `APP_URL`, and `REDIRECT_URI` defaults to `APP_URL/auth/callback`.
- `OAuthFlows` works across instances: the ticket and the `state` are sealed with AES-256-GCM, so give every instance the same `secret` option (at least 32 bytes) and, to finish each ticket once across them, a shared `nonces` store. Without `secret`, it behaves as before, on one instance. The cookie no longer carries the `state`, so a leaked `state` cannot finish the sign-in in another browser. A reused ticket is now refused at the callback rather than at the begin link. The second argument may still be a clock function.
- `checkAppConfig` keeps `install.redirectUrl` within FlyCommerce's limits: an ASCII host and at most 255 characters once joined to `appUrl`. `resolveAppConfig` keeps it exactly as written.
