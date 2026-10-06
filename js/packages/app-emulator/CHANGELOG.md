# @flycommerce/app-emulator

## 0.1.0

- First public release.
- Storefront scripts: `ExampleDashboard.start({ scripts })` runs them on an example store page at `/storefront`, with `window.FlyCommerce` and `flycommerce:page`.
- The example dashboard frames `appUrl` + each page's `path`, as the dashboard does (`/<slug>` when a page has no `path`), and runs a script whose `src` is a path from `appUrl`.
