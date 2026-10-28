# @flycommerce/app-emulator

## 0.2.0

### Minor Changes

- 7f8dd45: Storefront apps can act for the shopper and know who they are.
  
  - `@flycommerce/app-bridge`: `verifyShopperToken()` on the server; types for `window.FlyCommerce.run()`, `can()`, `actions()`, `shopperToken()` and the `flycommerce:cart:updated` event.
  - `@flycommerce/app-server`: `authenticateShopper()` for requests from a storefront script, and `allowStorefrontCalls()` for their CORS preflight.
  - `@flycommerce/app-emulator`: products with `?search=` and the ranked search, the order filters a real store takes (unknown filters are a 400), shopper tokens, and the store actions on the example storefront with a guest or signed-in shopper.

### Patch Changes

- Updated dependencies [7f8dd45]
  - @flycommerce/app-bridge@0.2.0

## 0.1.0

- First public release.
- Storefront scripts: `ExampleDashboard.start({ scripts })` runs them on an example store page at `/storefront`, with `window.FlyCommerce` and `flycommerce:page`.
- The example dashboard frames `appUrl` + each page's `path`, as the dashboard does (`/<slug>` when a page has no `path`), and runs a script whose `src` is a path from `appUrl`.
