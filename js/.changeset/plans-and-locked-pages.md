---
'@flycommerce/app-server': minor
'@flycommerce/app-bridge': minor
'@flycommerce/app-emulator': minor
'@flycommerce/cli': minor
---

Plans and locked pages. `app-config.json` now takes `plans` and `planCallback`, and each page takes `title`, `plans`, `isActive` and `callback`; `checkAppConfig()` holds them to FlyCommerce's rules and `resolveAppConfig()` resolves the callbacks. `@flycommerce/app-server` adds `pageAccess()`, `planOf()` and `defaultPlan()` to apply the same rule as the dashboard's menu, `readLockedPageCallback()` and `readPlanCallback()` to answer FlyCommerce's callbacks, and `StoreApi.setPlan()` to tell FlyCommerce a store's plan. Session and shopper token payloads have a `plan` claim. The emulator's dashboard locks pages, follows callbacks and offers a plan switch; its store accepts the set-plan call. `flycommerce app dev` moves callback URLs onto the tunnel, and `app dev --local` grants `plan.manage` when the config declares plans. See `spec/plans.md`.
