# @flycommerce/app-server

## 0.1.0

- First public release.
- Storefront scripts: `app-config.json` can declare up to three under `storefront.scripts` (`handle`, an `https` `src` on the `appUrl` host, `load` of `interactive` or `idle`), and `loadAppConfig` checks them.
- `app-config.json` for every environment: a script `src` and the new `install.redirectUrl` can be paths on `appUrl`, `versionId` and `version` are optional, and `resolveAppConfig` turns the paths into URLs on a given `appUrl`.
- `appServerConfigFromEnv` reads `APP_URL`, and `REDIRECT_URI` defaults to `APP_URL/auth/callback`.
