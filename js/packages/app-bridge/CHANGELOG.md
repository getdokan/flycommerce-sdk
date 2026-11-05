# @flycommerce/app-bridge

## 0.2.0

### Minor Changes

- 7f8dd45: Storefront apps can act for the shopper and know who they are.
  
  - `@flycommerce/app-bridge`: `verifyShopperToken()` on the server; types for `window.FlyCommerce.run()`, `can()`, `actions()`, `shopperToken()` and the `flycommerce:cart:updated` event.
  - `@flycommerce/app-server`: `authenticateShopper()` for requests from a storefront script, and `allowStorefrontCalls()` for their CORS preflight.
  - `@flycommerce/app-emulator`: products with `?search=` and the ranked search, the order filters a real store takes (unknown filters are a 400), shopper tokens, and the store actions on the example storefront with a guest or signed-in shopper.

## 0.1.0

- First public release.
- `fetch()` sends the session token only to the page's own origin and the origins in the new `fetchOrigins` option of `createApp`, and refuses any other URL before sending anything. The `0.1.0-next.0` preview sent it to any URL. An `Authorization` header you set is kept, and so are a `Request`'s own headers.
- Calls to `getSessionToken()` made while a token is being fetched share that request.
- Storefront scripts: `StorefrontContext` and `StorefrontPageDetail`, and `@flycommerce/app-bridge/storefront`, which types `window.FlyCommerce` and the `flycommerce:page` event.
