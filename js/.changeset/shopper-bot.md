---
'@flycommerce/app-bridge': minor
'@flycommerce/app-server': minor
'@flycommerce/app-emulator': minor
---

Storefront apps can act for the shopper and know who they are.

- `@flycommerce/app-bridge`: `verifyShopperToken()` on the server; types for `window.FlyCommerce.run()`, `can()`, `actions()`, `shopperToken()` and the `flycommerce:cart:updated` event.
- `@flycommerce/app-server`: `authenticateShopper()` for requests from a storefront script, and `allowStorefrontCalls()` for their CORS preflight.
- `@flycommerce/app-emulator`: products with `?search=` and the ranked search, the order filters a real store takes (unknown filters are a 400), shopper tokens, and the store actions on the example storefront with a guest or signed-in shopper.
