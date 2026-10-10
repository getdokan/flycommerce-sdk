# @flycommerce/cli

## 0.2.0

### Patch Changes

- Updated dependencies [7f8dd45]
  - @flycommerce/app-server@0.2.0

## 0.1.0

- First public release: `flycommerce login`, `logout`, `whoami`, `app list`, `app link`, `app dev` and `app release` and `app versions`. Browser sign-in with PKCE, one sign-in per portal, `FLYCOMMERCE_TOKEN` for CI, Cloudflare quick tunnels or `--tunnel-url` for `app dev`.
- `app release` without `--version` works out the version from the Conventional Commits since the last `app-v<x.y.z>` tag, or the portal's last release, and writes the changelog, title and tags from them. It previews everything, asks before releasing (`--yes`, `--dry-run`, `--edit`), and tags the release in git without pushing.
- `app submit` shows the review checklist and submits the app for FlyCommerce's review, with `--notes` for the reviewer.
