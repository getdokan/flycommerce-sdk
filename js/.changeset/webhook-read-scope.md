---
'@flycommerce/app-emulator': patch
---

Subscribing to a webhook event now needs the read scope for what it delivers, matching the store API: `orders.read` for `order.*` events, `catalog.read` for the others.
