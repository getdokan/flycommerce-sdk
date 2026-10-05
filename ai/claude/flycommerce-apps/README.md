# flycommerce-apps

Teaches Claude Code to build FlyCommerce apps that merchants install: the install code exchange, dashboard pages, session tokens, calling the store as the user or the app, webhooks, `app-config.json`, background jobs, and private versus listed apps.

Installing it also installs **flycommerce-api** (store endpoints) and **flycommerce-ui** (pages built with `@flycommerce/ui`).

## Install

In Claude Code:

```
/plugin marketplace add getdokan/flycommerce-sdk
/plugin install flycommerce-apps@flycommerce
```

Claude uses the skill when a task needs it. The skill reads FlyCommerce's published docs at https://developers.flycommerce.com rather than guessing endpoints or fields.

## What's inside

- `skills/flycommerce-apps/SKILL.md`: the rules Claude follows, where the facts come from, and when to hand off to the other FlyCommerce plugins.
