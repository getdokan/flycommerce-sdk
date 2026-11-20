---
'@flycommerce/app-bridge': minor
'@flycommerce/app-emulator': minor
---

Storefront scripts can use coupons and read the cart's totals.

- `@flycommerce/app-bridge`: types for `cart.applyCoupon` and `cart.removeCoupon`, the `reason` and `details` on a refused action (`CouponRefusalReason`), and the cart's `discount`, `total`, `coupons`, `currency` and each line's seller.
- `@flycommerce/app-emulator`: the example storefront takes the codes `SAVE10`, `BIG20` (needs a cart of 50) and `SUMMER` (expired), so an app can see a discount and each kind of refusal.
