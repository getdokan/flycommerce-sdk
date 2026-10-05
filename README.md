# FlyCommerce SDK

Tools for building apps on [FlyCommerce](https://flycommerce.com): apps that merchants install into their store and use inside the FlyCommerce dashboard.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/getdokan/flycommerce-sdk/blob/main/LICENSE)

## Packages

> **Preview.** The packages aren't on npm yet; the first release comes with FlyCommerce's app platform launch.

### JavaScript and TypeScript

| Package | What it's for | Install as |
| --- | --- | --- |
| [`@flycommerce/app-bridge`](https://github.com/getdokan/flycommerce-sdk/tree/main/js/packages/app-bridge) | Your app's pages, running inside the dashboard: session tokens, navigation, title bar, dialogs, dashboard context. React hooks included. | `dependency` of your frontend |
| [`@flycommerce/app-server`](https://github.com/getdokan/flycommerce-sdk/tree/main/js/packages/app-server) | Your app's Node server: check who is asking, finish installs, call the store API as the user or as the app, sign in to third-party services. | `dependency` of your backend |
| [`@flycommerce/app-testing`](https://github.com/getdokan/flycommerce-sdk/tree/main/js/packages/app-testing) | A fake FlyCommerce and store for tests and local development. | `devDependency` |

Each package has its own version and changelog.

For components that look like the dashboard, use [`@flycommerce/ui`](https://github.com/getdokan/flycommerce-ui).

### Other languages

Not yet. Apps in any language can verify session tokens and webhooks by following [`spec/`](https://github.com/getdokan/flycommerce-sdk/tree/main/spec), with any JWT library and the REST API.

## Claude Code plugins

FlyCommerce's plugins teach Claude Code the platform, one part each. They know about each other, so installing one brings in what it needs.

| Plugin | What it's for |
| --- | --- |
| [`flycommerce-apps`](https://github.com/getdokan/flycommerce-sdk/tree/main/ai/claude/flycommerce-apps) | Building an app merchants install, private or listed. Also installs `flycommerce-api` and `flycommerce-ui`. |
| [`flycommerce-api`](https://github.com/getdokan/flycommerce-sdk/tree/main/ai/claude/flycommerce-api) | Calling a store's REST API, from an app or a script. |
| [`flycommerce-mcp`](https://github.com/getdokan/flycommerce-sdk/tree/main/ai/claude/flycommerce-mcp) | Connecting an AI agent to a store's MCP server. |
| [`flycommerce-ui`](https://github.com/getdokan/flycommerce-ui/tree/main/plugin) | Screens built with `@flycommerce/ui`. Lives in the UI library's repo. |

In Claude Code:

```
/plugin marketplace add getdokan/flycommerce-sdk
/plugin install flycommerce-apps@flycommerce
```

To turn them on for everyone working in a repo, add this to its checked-in `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "flycommerce": { "source": { "source": "github", "repo": "getdokan/flycommerce-sdk" } }
  },
  "enabledPlugins": { "flycommerce-apps@flycommerce": true }
}
```

## How an app fits together

1. A merchant opens your app in their dashboard. The dashboard frames your page.
2. Your page asks the dashboard for a short-lived **session token** (`app-bridge`) and sends it to your server.
3. Your server verifies the token against FlyCommerce's public keys (`app-server`). It now knows the store and the user.
4. To read or change store data, your server exchanges that token at the store for access **as that user**, or uses the app's own credential for background work.

The contract behind these steps is in [`spec/`](https://github.com/getdokan/flycommerce-sdk/tree/main/spec).

## Repository layout

```
spec/            the contract: session tokens, webhooks
js/              the JavaScript packages (npm workspaces)
ai/claude/       the Claude Code plugins
.claude-plugin/  the plugin marketplace
```

## Contributing and security

- [CONTRIBUTING.md](https://github.com/getdokan/flycommerce-sdk/blob/main/CONTRIBUTING.md): how to develop, test and release.
- [SECURITY.md](https://github.com/getdokan/flycommerce-sdk/blob/main/SECURITY.md): how to report a vulnerability. Please don't open a public issue for one.
- [CODE_OF_CONDUCT.md](https://github.com/getdokan/flycommerce-sdk/blob/main/CODE_OF_CONDUCT.md)

## License

[MIT](https://github.com/getdokan/flycommerce-sdk/blob/main/LICENSE)
