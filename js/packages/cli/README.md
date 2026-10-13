# @flycommerce/cli

The FlyCommerce command line, `flycommerce`: start an app from an example, create it in the developer portal, point its server at the platform, run it on FlyCommerce's emulator or on your own store through a tunnel, check your setup, release versions with changelogs written from your commits, manage its secret and deploy tokens, and submit it for review.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/getdokan/flycommerce-sdk/blob/main/LICENSE)

## Install

> **Preview.** On npm under the `next` tag while FlyCommerce's app platform is in testing: `npm install --save-dev @flycommerce/cli@next`. The first stable release comes with the launch.

```bash
npm install --save-dev @flycommerce/cli
npx flycommerce --help
```

Node 22 or later. Its only dependencies are FlyCommerce's own: `@flycommerce/app-server`, which checks `app-config.json` the way FlyCommerce does, and `@flycommerce/app-emulator`, for `app dev --local`.

## One app per environment

Keep two apps in the developer portal:

- a **production app**: the one merchants install and FlyCommerce reviews, described by `app-config.json`;
- a **development app**: unpublished, installed only on your own stores, never reviewed, described by `app-config.dev.json`.

The two files differ only in `appId`, and `appUrl` is the only thing that differs between environments. Write script `src` and `install.redirectUrl` as paths (`"/storefront/welcome.js"`, `"/auth/callback"`) so they follow `appUrl`. Changes to an unpublished app apply to your stores at once, so the development app is where you try every change, including changes to a published app's pages and scripts.

## Commands

| Command                                                                                     | Does                                                                                                |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `flycommerce login`                                                                         | Signs in to the developer portal in your browser.                                                   |
| `flycommerce logout`                                                                        | Forgets this computer's sign-in.                                                                    |
| `flycommerce whoami`                                                                        | Shows who you're signed in as.                                                                      |
| `flycommerce doctor`                                                                        | Checks your sign-in, config files and `.env`, and says how to fix each problem.                     |
| `flycommerce env pull [--file <path>]`                                                      | Writes the platform's `HUB_API_URL`, `JWKS_URL`, `ALLOWED_ISSUERS` and `FRAME_ANCESTORS` to `.env`. |
| `flycommerce app init [<directory>] [--template <name>]` (or `flycommerce init`)            | Copies one of FlyCommerce's example apps into a new directory.                                      |
| `flycommerce app create [--name <name>] [--dev] [--write-env]`                              | Creates an app in the portal and shows its secret once.                                             |
| `flycommerce app list`                                                                      | Lists your apps.                                                                                    |
| `flycommerce app link [--config <name>] [--app <appId>]`                                    | Writes an app's ID into `app-config.json`, or `app-config.<name>.json`.                             |
| `flycommerce app dev --local [--port <port>] [--scopes <list>] [-- <command>]`              | Runs your app on FlyCommerce's emulator: no account, portal or tunnel.                              |
| `flycommerce app dev [--config <name>] [--port <port>] [--tunnel-url <url>] [-- <command>]` | Runs a development app on your store through a tunnel to this computer.                             |
| `flycommerce app status [--config <name>]`                                                  | Shows the live and waiting versions, what waits for review, the checklist and installs.             |
| `flycommerce app open [--page <page>]`                                                      | Opens the app in the developer portal.                                                              |
| `flycommerce app secret rotate [--write-env] [--yes]`                                       | Replaces the app secret and shows the new one once.                                                 |
| `flycommerce app token create\|list\|revoke`                                                | Creates (shown once), lists and revokes the app's deploy tokens for CI.                             |
| `flycommerce app release [--dry-run] [--yes] [--version <x.y.z>] [--message <text>] […]`    | Works out the version and changelog from your commits, then releases it.                            |
| `flycommerce app versions [--config <name>]`                                                | Lists the app's versions and which one is live.                                                     |
| `flycommerce app submit [--config <name>] [--notes <text>] [--yes]`                         | Shows the review checklist and submits the app for FlyCommerce's review.                            |

`flycommerce <command> --help` explains each one.

### Start an app

```bash
flycommerce app init my-app                      # from the order-export example
flycommerce app init my-app --template <name>    # from another example
```

`app init` downloads FlyCommerce's example apps with `git` (a shallow clone, never asking for a password) and copies one into the directory, which must be new or empty; a directory holding only `.git` counts as empty. Without a directory it uses the current one. `--template` takes an example's name, never a path; a name that isn't an example lists the ones there are.

The copy is named after its directory: `package.json`'s `name`, and `app-config.json`'s `appId` until you link a real app. The example's `versionId` and `version` are left out, since they're the example's, not yours. It creates nothing in the developer portal. `flycommerce init` is the same command.

Next, `npm install`, then run it on the emulator with no account (`flycommerce app dev --local`, below). To run it on your store: `flycommerce app create --dev --write-env`, `flycommerce env pull`, then `flycommerce app dev --config dev`.

### Run on the emulator

```bash
flycommerce app dev --local                      # runs npm start
flycommerce app dev --local -- npm run dev:server
```

Nothing reaches FlyCommerce: no sign-in, portal or tunnel. `app dev --local` starts FlyCommerce's emulator (a hub, a store with a few products and orders, and a dashboard), runs your server with your config's `APP_ID` and the emulator's `APP_SECRET`, `HUB_API_URL`, `JWKS_URL`, `ALLOWED_ISSUERS`, `STORE_BASE_URL` and `FRAME_ANCESTORS`, plus `APP_URL` (`http://localhost:<port>`), `REDIRECT_URI`, `PORT` and `APP_CONFIG_FILE` as `app dev` sets them. Once the server listens, it installs the app on the emulated store and prints the dashboard and storefront links. The emulator's values replace your real secret and platform addresses only for that process; `.env` is untouched, and anything else your server needs, like an encryption key, still comes from it.

The install grants every permission the emulator answers for (`catalog.read`, `orders.read`, `orders.write`, `webhooks.manage`, `storefront.scripts`, `storefront.customer`); `--scopes orders.read,catalog.read` grants fewer, to try what a merchant who grants less sees. Everything is in memory and starts fresh on each run. Ctrl+C stops your server and the emulator.

### Create an app

```bash
flycommerce app create --name "Order Export (dev)" --dev --write-env
```

`app create` creates an app in the developer portal. A new app is unpublished: it installs only on your own stores until FlyCommerce reviews and publishes it, so the same command makes a development app or the start of a production one. `--dev` links it in `app-config.dev.json` (`--config <name>` picks another file). The app secret is shown once; `--write-env` writes `APP_ID` and `APP_SECRET` to `.env` instead, so the secret never reaches your terminal, and a new `.env` is readable only by you. It refuses a `.env` that already holds another `APP_ID`, before creating anything, rather than replace that app's credentials; if writing fails anyway, the secret is shown. Without `--name` it asks, suggesting `package.json`'s name. Pick the app's category in the portal (or pass `--category <id>`) before you submit it for review.

### Point your server at the platform

```bash
flycommerce env pull
```

`env pull` asks the portal you're signed in to which platform it serves, and writes its `HUB_API_URL`, `JWKS_URL`, `ALLOWED_ISSUERS` and `FRAME_ANCESTORS` to `.env` (`--file` for another file). The same app then talks to production, staging or a local hub without code changes: sign in with `--portal` or `FLYCOMMERCE_PORTAL_URL` and pull again. It keeps every other line, comments and secrets included.

### Check your setup

```bash
flycommerce doctor
```

`doctor` checks what an app needs before it runs, and says how to fix each problem:

- Node's version;
- every `app-config*.json` here, as FlyCommerce checks it;
- the sign-in, and whether each config's app is one of yours (a development config pointing at a published app gets a warning);
- `.env`: `APP_ID`, `APP_SECRET` and `HUB_API_URL`, and whether it points at the platform of the portal you're signed in to;
- whether git ignores `.env`;
- `cloudflared`, for `app dev`.

It never prints a value from `.env`, and exits with `1` when something must be fixed.

### Sign in

```bash
flycommerce login
```

The browser opens the portal's "Allow FlyCommerce CLI" page; the link is printed too, in case it doesn't open. The sign-in comes back to a server on `127.0.0.1` that the CLI runs for those few minutes, and is exchanged with a PKCE verifier only that process knows.

The token is kept in `~/.config/flycommerce/credentials.json` (`$XDG_CONFIG_HOME/flycommerce/` when that is set), readable only by you, one per portal. If that file can't be read, `login` keeps it as `credentials.json.bak` and starts a new one. `logout` forgets it on this computer; revoke it in the portal's **Credentials** tab to end it everywhere.

### Develop on your store

```bash
flycommerce app create --dev --write-env   # once: a development app, linked in app-config.dev.json
flycommerce env pull                       # once per platform
flycommerce app dev --config dev -- npm run dev:server
```

`app dev`:

1. starts a Cloudflare quick tunnel to `http://localhost:<port>` (port 4000 unless `--port`), or uses `--tunnel-url`;
2. checks that the tunnel reaches the port: before your server starts, the CLI answers a one-off request on the port itself and sends it through the tunnel, waiting up to a minute for a new tunnel's DNS. If the request comes back with anything else, it stops with the likely cause and pushes nothing. If something already listens on the port, it warns and skips the check;
3. pushes the config to the development app, with `appUrl` set to the tunnel. Script srcs and `install.redirectUrl` on `http://localhost:<port>`, as `app init`'s example writes them, move onto the tunnel, as paths do;
4. runs your server, `npm start` unless you give a command after `--`, with these set:

   | Variable          | Value                                                                                                                             |
   | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
   | `APP_URL`         | The tunnel's URL                                                                                                                  |
   | `REDIRECT_URI`    | The redirect URL FlyCommerce now holds for the app, exactly; else `install.redirectUrl` on the tunnel, or `APP_URL/auth/callback` |
   | `PORT`            | `--port`                                                                                                                          |
   | `APP_CONFIG_FILE` | The config file's full path, so the server reads the same file                                                                    |

5. prints the install link, the pages and the storefront scripts.

`appServerConfigFromEnv()` from `@flycommerce/app-server` reads `APP_URL` and `REDIRECT_URI`, so `.env` only needs the development app's ID and secret. Load the config with `loadAppConfig(process.env.APP_CONFIG_FILE ?? 'app-config.json')`; that's why the file keeps an `appUrl` even though the push replaces it. Ctrl+C stops your server and the tunnel; if the tunnel stops on its own, `app dev` stops your server and exits with an error.

Your server and `cloudflared` run without `FLYCOMMERCE_TOKEN` or any other `FLYCOMMERCE_*` variable, so the portal token never reaches them. On Windows the command runs through `cmd.exe` with each argument quoted, since `npm` and similar commands are `.cmd` files; elsewhere it runs without a shell.

The tunnel URL changes on every run, so `app dev` pushes on every start. The development app keeps its App ID, secret and your stores' installs across runs; reinstall only when its permissions change, which `app dev` tells you, for example after adding the first storefront script. Add `"install": { "redirectUrl": "/auth/callback" }` to the config so installs come back through the current tunnel.

`app dev` refuses an app that's published, waiting for review or rejected: it changes only by releasing a version.

**Tunnels.** With no `--tunnel-url`, [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) must be installed; the CLI never downloads it. It runs `cloudflared` with an empty `--config` of its own, so a named tunnel's `~/.cloudflared/config.yml` and its `ingress` rules don't apply to the quick tunnel. Any other tunnel works with `--tunnel-url https://…`: ngrok, a named Cloudflare tunnel, and so on; it must send requests to `http://localhost:<port>`, which `app dev` checks.

### Release

```bash
flycommerce app release --dry-run   # see the version and changelog it would release
flycommerce app release             # the same, then asks before releasing
```

Write your commits as [Conventional Commits](https://www.conventionalcommits.org) (`feat: add CSV export`, `fix(orders): keep the date filter`) and `app release` works out the rest:

- **The last release** is the highest `app-v<x.y.z>` git tag that `HEAD` contains (`app-<name>-v<x.y.z>` with `--config <name>`, or set `--tag-prefix`). With no such tag, or when a newer version was released without one (from CI, say), it's the version released last in the portal, and the commits are those made since its release date. Only commits that touch the current directory count, so a repository with several apps works too.
- **The version.** A breaking change (`feat!:`, or a `BREAKING CHANGE:` footer) bumps the major number, or the minor one while it's below 1.0.0. A `feat` bumps the minor number; a `fix`, `perf`, `refactor` or `revert` the patch number. The first release is 1.0.0. It's always higher than any version already released, including one released from the portal.
- **The changelog** lists the commits under _Breaking changes_, _Features_, _Fixes_ and _Other_, with the scope in bold: `- **orders:** keep the date filter (#12)`. Merge commits are left out, and so are `chore`, `docs`, `test`, `ci`, `build` and `style` commits unless you pass `--include-all`. It's kept within FlyCommerce's 5000 characters.
- **The title** is the first breaking change or feature, else the first fix, up to 80 characters. **The tags** are the commits' scopes, up to 5.

If there's nothing releasable since the last release, it says so and exits with `0`, releasing nothing. `--version`, `--message`, `--title` and `--tag` (repeatable) replace what it works out, and `--edit` opens the changelog in `$EDITOR` before you confirm. Outside a git repository, give `--version` and `--message`.

It prints the version, title, tags and changelog, and asks before releasing; `--yes` doesn't ask, and `--dry-run` stops there with nothing created. Without a terminal it needs `--yes`, unless you gave both `--version` and `--message`.

`--dry-run` runs every check the release runs before it changes anything, and fails with the same errors and exit code: the config, the version, and a version already waiting in the portal. What it can't run are FlyCommerce's own checks when it receives the config, such as its own domains, which only the release reaches.

The CLI checks `app-config.json` locally, including that stores can reach it: it refuses an `appUrl`, script `src` or `install.redirectUrl` on `localhost`, a `.localhost`, `.test`, `.internal` or `.local` name, or a private address. `app dev` puts the tunnel in `appUrl` on its own, so a development config can keep `http://localhost:4000`; release a config with your app's public address. It creates the version with its changelog, and releases it with the config, filling in `versionId` and `version`. A listed app's new pages, permissions and scripts wait for FlyCommerce's review, and the CLI lists them. A changed `install.redirectUrl` waits too: until it's approved, merchants still return to the approved URL, so keep that route working. While the app itself waits for review, the version goes live once it's approved. With `--no-release` it stops after creating the version; running the command again without it releases that same version. FlyCommerce keeps one unreleased version at a time, so while another is waiting the CLI says so and asks you to release or delete it first. When the one waiting has the same number, the release uses it, with the changelog, title and tags it already has. If FlyCommerce refuses the config, the CLI prints each problem and exits with `1`.

After releasing, it tags the commit with an annotated `app-v<version>` tag holding the changelog, so the next release starts from there. It never pushes: run `git push origin app-v1.3.0` to share the tag. `--no-git-tag` skips it. Uncommitted changes get a warning, since neither the changelog nor the tag includes them.

### Day to day

```bash
flycommerce app status --config dev       # versions, review, checklist, installs, links
flycommerce app open --page versions      # portal, versions, publishing or install
flycommerce app secret rotate --write-env
flycommerce app token create --name "GitHub Actions" --expires 90
flycommerce app token list
flycommerce app token revoke 12
```

- `app status` shows the live and waiting versions, what waits for FlyCommerce's review, what the review checklist still needs, how many stores have the app (your own by name; a published app's merchants only as a count), the last dev push, and the portal and install links.
- `app open` opens the app's portal page in your browser, and prints the link.
- `app secret rotate` replaces the app secret; the old one stops working at once. A published app's live installs break until you deploy the new secret, so for one it asks first (`--yes` without a terminal). `--write-env` writes the new secret, with `APP_ID`, to `.env` instead of showing it, and refuses a `.env` that holds another app's `APP_ID`.
- `app token create` makes a deploy token for CI (30, 90 or 180 days, `--name` defaults to `CI`) and shows it once. `app token list` shows when each was made, expires and was last used, never the token. `app token revoke <id>` asks first (`--yes` without a terminal).

Creating apps, rotating secrets and managing tokens need your own sign-in: a deploy token can't do them.

### Submit for review

```bash
flycommerce app submit --notes "Test store: demo.example.com; the export is under Orders"
```

`app submit` shows the review checklist, what's done and what isn't with a link to fix each, and when everything's done, asks and submits the app for FlyCommerce's review. Release a version first: the review covers what's released. An app already waiting for review, or already published, has nothing to submit (a published app's changes go to review when you release them), and the CLI says so and exits with `0`. A rejected app can't be submitted again from the CLI; contact support. Without a terminal it needs `--yes`. A deploy token can release but not submit, so sign in with `flycommerce login` to submit.

## CI

Set `FLYCOMMERCE_TOKEN` to a deploy token, from `flycommerce app token create` or the portal's **Credentials** tab. It's used instead of the saved sign-in and is never written to disk. A deploy token works for one app, can release but not submit for review, and doesn't work for `app dev`.

```yaml
on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # the commits and tags since the last release
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: npm ci
      - run: npx flycommerce app release --yes
        env:
          FLYCOMMERCE_TOKEN: ${{ secrets.FLYCOMMERCE_TOKEN }}
```

The tag it makes stays on the runner. Push it (`git push origin "app-v$VERSION"`, with `contents: write`) for the next run to start from it; without it, the next run starts from the portal's last release date. A push with no `feat`, `fix`, `perf`, `refactor` or `revert` commits since then releases nothing and exits with `0`.

## Environment

| Variable                     | Meaning                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `FLYCOMMERCE_TOKEN`          | A token to use instead of the saved sign-in                                                               |
| `FLYCOMMERCE_PORTAL_URL`     | The developer portal, when `--portal` isn't given (default `https://developers.flycommerce.com`)          |
| `FLYCOMMERCE_CLOUDFLARED`    | The `cloudflared` binary to run, when it isn't on `PATH`                                                  |
| `FLYCOMMERCE_TEMPLATES_REPO` | Where `app init` downloads the examples from, like a mirror: an `https://`, `ssh://` or `file://` git URL |
| `XDG_CONFIG_HOME`            | Where `flycommerce/credentials.json` is kept (default `~/.config`)                                        |

## Security

- The sign-in uses PKCE (S256) and a random `state`, checked in constant time; an answer with another `state` is refused and nothing is saved.
- The token goes only to the portal, over `https` (plain `http` only to `localhost`), and never follows a redirect. It's never printed, put in a URL, or passed to the processes `app dev` starts.
- Only an answer carrying the sign-in's `state` can end it; anything else that calls the loopback is answered `400` and ignored.
- An app secret or deploy token is shown once, as the portal shows it; with `--write-env` a secret goes to `.env` and never reaches the terminal. A `.env` the CLI creates is readable only by you, and `doctor` never prints a value from it.
- `app dev --local` gives your server the emulator's own secret, never your real one, and installs the app only on a port nothing else is listening on, so the one-time install code reaches your server.
- Everything the CLI prints, app names, titles and URLs from the portal included, is stripped of terminal escape sequences, control characters and bidi overrides.
- Every request has a timeout.

Report vulnerabilities through [SECURITY.md](https://github.com/getdokan/flycommerce-sdk/blob/main/SECURITY.md).

## Links

- [Changelog](https://github.com/getdokan/flycommerce-sdk/blob/main/js/packages/cli/CHANGELOG.md)
- [`app-config.json`](https://github.com/getdokan/flycommerce-sdk/blob/main/spec/app-config.md)
- [All packages](https://github.com/getdokan/flycommerce-sdk#readme)
