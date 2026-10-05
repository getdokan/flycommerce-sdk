# flycommerce-api

Teaches Claude Code to call a FlyCommerce store's REST API, from an app or from a script with a personal access token: which token to use, finding endpoints and permissions in the reference, filters, includes, paging, incremental sync, errors and webhooks.

Installed on its own for scripts, or with **flycommerce-apps**, which depends on it.

## Install

In Claude Code:

```
/plugin marketplace add getdokan/flycommerce-sdk
/plugin install flycommerce-api@flycommerce
```

Claude uses the skill when a task needs it. The skill reads FlyCommerce's published docs at https://developers.flycommerce.com rather than guessing endpoints or fields.

## What's inside

- `skills/flycommerce-api/SKILL.md`: the rules Claude follows, where the facts come from, and when to hand off to the other FlyCommerce plugins.
