# @flycommerce/cli

The FlyCommerce command line, `flycommerce`: sign in to the developer portal, link `app-config.json` to an app, run a development app on your own store through a tunnel, release versions with changelogs written from your commits, and submit the app for review.

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

| Command                                                                                     | Does                                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `flycommerce login`                                                                         | Signs in to the developer portal in your browser.                        |
| `flycommerce logout`                                                                        | Forgets this computer's sign-in.                                         |
| `flycommerce whoami`                                                                        | Shows who you're signed in as.                                           |
| `flycommerce app list`                                                                      | Lists your apps.                                                         |
| `flycommerce app link [--config <name>] [--app <appId>]`                                    | Writes an app's ID into `app-config.json`, or `app-config.<name>.json`.  |
| `flycommerce app dev [--config <name>] [--port <port>] [--tunnel-url <url>] [-- <command>]` | Runs a development app on your store through a tunnel to this computer.  |
| `flycommerce app release [--dry-run] [--yes] [--version <x.y.z>] [--message <text>] […]`    | Works out the version and changelog from your commits, then releases it. |
| `flycommerce app versions [--config <name>]`                                                | Lists the app's versions and which one is live.                          |
| `flycommerce app submit [--config <name>] [--notes <text>] [--yes]`                         | Shows the review checklist and submits the app for FlyCommerce's review. |

`flycommerce <command> --help` explains each one.

### Sign in

```bash
flycommerce login
```

The browser opens the portal's "Allow FlyCommerce CLI" page; the link is printed too, in case it doesn't open. The sign-in comes back to a server on `127.0.0.1` that the CLI runs for those few minutes, and is exchanged with a PKCE verifier only that process knows.

The token is kept in `~/.config/flycommerce/credentials.json` (`$XDG_CONFIG_HOME/flycommerce/` when that is set), readable only by you, one per portal. If that file can't be read, `login` keeps it as `credentials.json.bak` and starts a new one. `logout` forgets it on this computer; revoke it in the portal's **Credentials** tab to end it everywhere.

### Develop on your store

```bash
flycommerce app link --config dev     # once: pick your development app
flycommerce app dev --config dev -- npm run dev:server
```

`app dev`:

1. starts a Cloudflare quick tunnel to `http://localhost:<port>` (port 4000 unless `--port`), or uses `--tunnel-url`;
2. pushes the config to the development app, with `appUrl` set to the tunnel;
3. runs your server, `npm start` unless you give a command after `--`, with these set:

   | Variable          | Value                                                                                                                             |
   | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
   | `APP_URL`         | The tunnel's URL                                                                                                                  |
   | `REDIRECT_URI`    | The redirect URL FlyCommerce now holds for the app, exactly; else `install.redirectUrl` on the tunnel, or `APP_URL/auth/callback` |
   | `PORT`            | `--port`                                                                                                                          |
   | `APP_CONFIG_FILE` | The config file's full path, so the server reads the same file                                                                    |

4. prints the install link, the pages and the storefront scripts.

`appServerConfigFromEnv()` from `@flycommerce/app-server` reads `APP_URL` and `REDIRECT_URI`, so `.env` only needs the development app's ID and secret. Load the config with `loadAppConfig(process.env.APP_CONFIG_FILE ?? 'app-config.json')`; that's why the file keeps an `appUrl` even though the push replaces it. Ctrl+C stops your server and the tunnel; if the tunnel stops on its own, `app dev` stops your server and exits with an error.

Your server and `cloudflared` run without `FLYCOMMERCE_TOKEN` or any other `FLYCOMMERCE_*` variable, so the portal token never reaches them. On Windows the command runs through `cmd.exe` with each argument quoted, since `npm` and similar commands are `.cmd` files; elsewhere it runs without a shell.

The tunnel URL changes on every run, so `app dev` pushes on every start. The development app keeps its App ID, secret and your stores' installs across runs; reinstall only when its permissions change, which `app dev` tells you, for example after adding the first storefront script. Add `"install": { "redirectUrl": "/auth/callback" }` to the config so installs come back through the current tunnel.

`app dev` refuses an app that's published, waiting for review or rejected: it changes only by releasing a version.

**Tunnels.** With no `--tunnel-url`, [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) must be installed; the CLI never downloads it. Any other tunnel works with `--tunnel-url https://…`: ngrok, a named Cloudflare tunnel, and so on.

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

The CLI checks `app-config.json` locally, creates the version with its changelog, and releases it with the config, filling in `versionId` and `version`. A listed app's new pages, permissions and scripts wait for FlyCommerce's review, and the CLI lists them. A changed `install.redirectUrl` waits too: until it's approved, merchants still return to the approved URL, so keep that route working. While the app itself waits for review, the version goes live once it's approved. With `--no-release` it stops after creating the version; running the command again without it releases that same version. FlyCommerce keeps one unreleased version at a time, so while another is waiting the CLI says so and asks you to release or delete it first. If FlyCommerce refuses the config, the CLI prints each problem and exits with `1`.

After releasing, it tags the commit with an annotated `app-v<version>` tag holding the changelog, so the next release starts from there. It never pushes: run `git push origin app-v1.3.0` to share the tag. `--no-git-tag` skips it. Uncommitted changes get a warning, since neither the changelog nor the tag includes them.

### Submit for review

```bash
flycommerce app submit --notes "Test store: demo.example.com; the export is under Orders"
```

`app submit` shows the review checklist, what's done and what isn't with a link to fix each, and when everything's done, asks and submits the app for FlyCommerce's review. Release a version first: the review covers what's released. An app already waiting for review, or already published, has nothing to submit (a published app's changes go to review when you release them), and the CLI says so and exits with `0`. A rejected app can't be submitted again from the CLI; contact support. Without a terminal it needs `--yes`. A deploy token can release but not submit, so sign in with `flycommerce login` to submit.

## CI

Set `FLYCOMMERCE_TOKEN` to a deploy token from the portal's **Credentials** tab. It's used instead of the saved sign-in and is never written to disk. A deploy token works for one app, can release but not submit for review, and doesn't work for `app dev`.

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

| Variable                  | Meaning                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `FLYCOMMERCE_TOKEN`       | A token to use instead of the saved sign-in                                                      |
| `FLYCOMMERCE_PORTAL_URL`  | The developer portal, when `--portal` isn't given (default `https://developers.flycommerce.com`) |
| `FLYCOMMERCE_CLOUDFLARED` | The `cloudflared` binary to run, when it isn't on `PATH`                                         |
| `XDG_CONFIG_HOME`         | Where `flycommerce/credentials.json` is kept (default `~/.config`)                               |

## Security

- The sign-in uses PKCE (S256) and a random `state`, checked in constant time; an answer with another `state` is refused and nothing is saved.
- The token goes only to the portal, over `https` (plain `http` only to `localhost`), and never follows a redirect. It's never printed, put in a URL, or passed to the processes `app dev` starts.
- Only an answer carrying the sign-in's `state` can end it; anything else that calls the loopback is answered `400` and ignored.
- Everything the CLI prints, app names, titles and URLs from the portal included, is stripped of terminal escape sequences, control characters and bidi overrides.
- Every request has a timeout.

Report vulnerabilities through [SECURITY.md](https://github.com/getdokan/flycommerce-sdk/blob/main/SECURITY.md).

## Links

- [Changelog](https://github.com/getdokan/flycommerce-sdk/blob/main/js/packages/cli/CHANGELOG.md)
- [`app-config.json`](https://github.com/getdokan/flycommerce-sdk/blob/main/spec/app-config.md)
- [All packages](https://github.com/getdokan/flycommerce-sdk#readme)
