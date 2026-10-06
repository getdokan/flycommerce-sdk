# The contract

What every FlyCommerce SDK implements, in any language. An app that follows these documents works without any SDK.

| Document | Covers |
| --- | --- |
| [session-token.md](session-token.md) | The token a dashboard page sends its own server: format, keys, claims, checks, and exchanging it for store access |
| [webhooks.md](webhooks.md) | Events the store sends an app: request format, signature, delivery |
| [storefront-scripts.md](storefront-scripts.md) | Scripts an app adds to the storefront: config, where and when they load, `window.FlyCommerce`, the page event |

A change to any of these documents is a change for every SDK. It goes in the same pull request as the code that implements it, and a breaking change bumps every affected package.
