# @flycommerce/cli

## 0.2.0

### Patch Changes

- Updated dependencies [7f8dd45]
  - @flycommerce/app-server@0.2.0
  - @flycommerce/app-emulator@0.2.0

## 0.1.0

- First public release: `flycommerce login`, `logout`, `whoami`, `app list`, `app link`, `app dev` and `app release` and `app versions`. Browser sign-in with PKCE, one sign-in per portal, `FLYCOMMERCE_TOKEN` for CI, Cloudflare quick tunnels or `--tunnel-url` for `app dev`.
- `app release` without `--version` works out the version from the Conventional Commits since the last `app-v<x.y.z>` tag, or the portal's last release, and writes the changelog, title and tags from them. It previews everything, asks before releasing (`--yes`, `--dry-run`, `--edit`), and tags the release in git without pushing.
- `app submit` shows the review checklist and submits the app for FlyCommerce's review, with `--notes` for the reviewer.
- Day to day without the portal: `app create` makes an app and shows its secret once (`--dev` links `app-config.dev.json`, `--write-env` puts `APP_ID` and `APP_SECRET` in `.env` instead); `env pull` writes the platform's `HUB_API_URL`, `JWKS_URL`, `ALLOWED_ISSUERS` and `FRAME_ANCESTORS`; `app dev --local` runs the app on FlyCommerce's emulator with no account or tunnel; `app status`, `app open`, `app secret rotate` and `app token create|list|revoke`; `doctor` checks the sign-in, config files and `.env`; `init` is another name for `app init`.
- `app dev` runs `cloudflared` with an empty config of its own, so the ingress rules of a named tunnel's `~/.cloudflared/config.yml` can't take over the quick tunnel, and checks that the tunnel reaches your port before pushing anything; it stops with the likely cause when it doesn't. Script srcs and install redirects on `http://localhost:<port>` move onto the tunnel. `app release` refuses a config whose `appUrl` or URLs only this computer or a private network can reach, and `--dry-run` runs every check the release runs and fails the same way, including on a version already waiting in the portal.
