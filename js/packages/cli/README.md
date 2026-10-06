# @flycommerce/cli

The FlyCommerce command line, `flycommerce`: sign in to the developer portal, link `app-config.json` to an app, run a development app on your own store through a tunnel, and release versions.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/getdokan/flycommerce-sdk/blob/main/LICENSE)

## Install

> **Preview.** On npm under the `next` tag while FlyCommerce's app platform is in testing: `npm install --save-dev @flycommerce/cli@next`. The first stable release comes with the launch.

```bash
npm install --save-dev @flycommerce/cli
npx flycommerce --help
```

Node 22 or later. No dependencies beyond `@flycommerce/app-server`, which checks `app-config.json` the way FlyCommerce does.

## One app per environment

Keep two apps in the developer portal:

- a **production app**: the one merchants install and FlyCommerce reviews, described by `app-config.json`;
- a **development app**: unpublished, installed only on your own stores, never reviewed, described by `app-config.dev.json`.

The two files differ only in `appId`, and `appUrl` is the only thing that differs between environments. Write script `src` and `install.redirectUrl` as paths (`"/storefront/welcome.js"`, `"/auth/callback"`) so they follow `appUrl`. Changes to an unpublished app apply to your stores at once, so the development app is where you try every change, including changes to a published app's pages and scripts.

## Commands

| Command                                                                                                        | Does                                                                    |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `flycommerce login`                                                                                            | Signs in to the developer portal in your browser.                       |
| `flycommerce logout`                                                                                           | Forgets this computer's sign-in.                                        |
| `flycommerce whoami`                                                                                           | Shows who you're signed in as.                                          |
| `flycommerce app list`                                                                                         | Lists your apps.                                                        |
| `flycommerce app link [--config <name>] [--app <appId>]`                                                       | Writes an app's ID into `app-config.json`, or `app-config.<name>.json`. |
| `flycommerce app dev [--config <name>] [--port <port>] [--tunnel-url <url>] [-- <command>]`                    | Runs a development app on your store through a tunnel to this computer. |
| `flycommerce app release --version <x.y.z> --message <text> [--title <text>] [--config <name>] [--no-release]` | Checks the config, creates the version and releases it.                 |
| `flycommerce app versions [--config <name>]`                                                                   | Lists the app's versions and which one is live.                         |

`flycommerce <command> --help` explains each one.

### Sign in

```bash
flycommerce login
```

The browser opens the portal's "Allow FlyCommerce CLI" page; the link is printed too, in case it doesn't open. The sign-in comes back to a server on `127.0.0.1` that the CLI runs for those few minutes, and is exchanged with a PKCE verifier only that process knows.

The token is kept in `~/.config/flycommerce/credentials.json` (`$XDG_CONFIG_HOME/flycommerce/` when that is set), readable only by you, one per portal. `logout` forgets it on this computer; revoke it in the portal's **Credentials** tab to end it everywhere.

### Develop on your store

```bash
flycommerce app link --config dev     # once: pick your development app
flycommerce app dev --config dev -- npm run dev:server
```

`app dev`:

1. starts a Cloudflare quick tunnel to `http://localhost:<port>` (port 4000 unless `--port`), or uses `--tunnel-url`;
2. pushes the config to the development app, with `appUrl` set to the tunnel;
3. runs your server, `npm start` unless you give a command after `--`, with these set:

   | Variable          | Value                                                           |
   | ----------------- | --------------------------------------------------------------- |
   | `APP_URL`         | The tunnel's URL                                                |
   | `REDIRECT_URI`    | `install.redirectUrl` on the tunnel, or `APP_URL/auth/callback` |
   | `PORT`            | `--port`                                                        |
   | `APP_CONFIG_FILE` | The config file's full path, so the server reads the same file  |

4. prints the install link, the pages and the storefront scripts.

`appServerConfigFromEnv()` from `@flycommerce/app-server` reads `APP_URL` and `REDIRECT_URI`, so `.env` only needs the development app's ID and secret. Ctrl+C stops your server and the tunnel.

The tunnel URL changes on every run, so `app dev` pushes on every start. The development app keeps its App ID, secret and your stores' installs across runs; reinstall only when its permissions change. Add `"install": { "redirectUrl": "/auth/callback" }` to the config so installs come back through the current tunnel.

`app dev` refuses an app that's published, waiting for review or rejected: it changes only by releasing a version.

**Tunnels.** With no `--tunnel-url`, [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) must be installed; the CLI never downloads it. Any other tunnel works with `--tunnel-url https://…`: ngrok, a named Cloudflare tunnel, and so on.

### Release

```bash
flycommerce app release --version 1.2.0 --message "Adds a welcome banner on the home page"
```

The CLI checks `app-config.json` locally, creates the version with its changelog, and releases it with the config, filling in `versionId` and `version`. A listed app's new pages, permissions and scripts wait for FlyCommerce's review, and the CLI lists them. With `--no-release` it stops after creating the version; running the command again without it releases that same version. FlyCommerce keeps one unreleased version at a time, so while another is waiting the CLI says so and asks you to release or delete it first. If FlyCommerce refuses the config, the CLI prints each problem and exits with `1`.

## CI

Set `FLYCOMMERCE_TOKEN` to a deploy token from the portal's **Credentials** tab. It's used instead of the saved sign-in and is never written to disk. A deploy token works for one app, and not for `app dev`.

```yaml
- run: npx flycommerce app release --version "$VERSION" --message "$NOTES"
  env:
    FLYCOMMERCE_TOKEN: ${{ secrets.FLYCOMMERCE_TOKEN }}
```

## Environment

| Variable                  | Meaning                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `FLYCOMMERCE_TOKEN`       | A token to use instead of the saved sign-in                                                      |
| `FLYCOMMERCE_PORTAL_URL`  | The developer portal, when `--portal` isn't given (default `https://developers.flycommerce.com`) |
| `FLYCOMMERCE_CLOUDFLARED` | The `cloudflared` binary to run, when it isn't on `PATH`                                         |
| `XDG_CONFIG_HOME`         | Where `flycommerce/credentials.json` is kept (default `~/.config`)                               |

## Security

- The sign-in uses PKCE (S256) and a random `state`, checked in constant time; an answer with another `state` is refused and nothing is saved.
- The token goes only to the portal, over `https` (plain `http` only to `localhost`). It's never printed or put in a URL.
- Every request has a timeout.

Report vulnerabilities through [SECURITY.md](https://github.com/getdokan/flycommerce-sdk/blob/main/SECURITY.md).

## Links

- [Changelog](https://github.com/getdokan/flycommerce-sdk/blob/main/js/packages/cli/CHANGELOG.md)
- [`app-config.json`](https://github.com/getdokan/flycommerce-sdk/blob/main/spec/app-config.md)
- [All packages](https://github.com/getdokan/flycommerce-sdk#readme)
