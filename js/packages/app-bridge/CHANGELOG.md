# @flycommerce/app-bridge

## 0.1.0

- First public release.
- `fetch()` sends the session token only to the page's own origin and the origins in the new `fetchOrigins` option of `createApp`, and refuses any other URL before sending anything. The `0.1.0-next.0` preview sent it to any URL. An `Authorization` header you set is kept, and so are a `Request`'s own headers.
- Calls to `getSessionToken()` made while a token is being fetched share that request.
- Storefront scripts: `StorefrontContext` and `StorefrontPageDetail`, and `@flycommerce/app-bridge/storefront`, which types `window.FlyCommerce` and the `flycommerce:page` event.
