# Changelog

All notable changes to the `flycommerce-apps` Claude Code plugin. Versions follow [semantic versioning](https://semver.org).

## [0.4.0]

- Storefront scripts act for the shopper: `FlyCommerce.run()` for `cart.add`, `cart.update`, `cart.remove`, `cart.get`, `nav.goto` and `ui.openCart`, with feature detection, the store's Undo and limits, and `flycommerce:cart:updated`. Replaces the old "no customer data" rule, which the platform no longer matches.
- There is no cart id and an app never needs one; the skill says so when asked for "the logged-in user's cart id", and names the only client that uses the Cart API.
- Shopper tokens: `FlyCommerce.shopperToken()`, verified on the server (`authenticateShopper`), `signed_in` and `customer_id` with `storefront.customer`, and reading only that customer's orders.
- Product search with `catalog.read`, and the pause on third-party storefront scripts.
- The description now matches plain requests, such as a chatbot or shopping assistant on the storefront, an add-to-cart button, the shopper's cart or knowing which customer is signed in.

## [0.3.0]

- Develop and release with the CLI: one app per environment, `flycommerce app link`, `app dev` through a tunnel with `APP_URL`, `REDIRECT_URI` and `PORT`, `app release`, and `FLYCOMMERCE_TOKEN` in CI.
- `app release` works out the version, title, tags and changelog from Conventional Commits, previews them with `--dry-run`, and tags the release in git; `app submit` checks the review checklist and submits for review. The skill asks for Conventional Commits and leaves the submit decision to the developer.
- `app-config.json` for every environment: script `src` and the new `install.redirectUrl` as paths on `appUrl`, `versionId` and `version` optional. `install.redirectUrl` is compared byte for byte, and every file keeps an `appUrl`.

## [0.2.0]

- Storefront scripts: when to use them, declaring them in `app-config.json`, the trust model and the pages they never run on, no guaranteed load order, `window.FlyCommerce` and the `flycommerce:page` event, no customer data, and testing them in the emulator.

## [0.1.1]

- Only the store owner and admins open apps today; `vendor` is reserved. The skill no longer says vendors see app pages.

## [0.1.0]

- First release.
