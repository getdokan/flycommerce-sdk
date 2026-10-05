# flycommerce-mcp

Teaches Claude Code to connect an AI agent or agent platform to a FlyCommerce store's MCP server: the protocol, tools and identity tiers, request signatures, the checkout hand-off, idempotency, limits and errors.

Separate from the app plugins: an agent shopping in a store uses different credentials from an app installed in it.

## Install

In Claude Code:

```
/plugin marketplace add getdokan/flycommerce-sdk
/plugin install flycommerce-mcp@flycommerce
```

Claude uses the skill when a task needs it. The skill reads FlyCommerce's published docs at https://developers.flycommerce.com rather than guessing endpoints or fields.

## What's inside

- `skills/flycommerce-mcp/SKILL.md`: the rules Claude follows, where the facts come from, and when to hand off to the other FlyCommerce plugins.
