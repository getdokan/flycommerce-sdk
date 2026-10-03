# The contract

What every FlyCommerce SDK implements, in any language. An app that follows these documents works without any SDK.

| Document | Covers |
| --- | --- |
| [session-token.md](session-token.md) | The token a dashboard page sends its own server: format, keys, claims, checks, and exchanging it for store access |
| [webhooks.md](webhooks.md) | Events the store sends an app: request format, signature, delivery |

A change to either document is a change for every SDK. It goes in the same pull request as the code that implements it, and a breaking change bumps every affected package.
