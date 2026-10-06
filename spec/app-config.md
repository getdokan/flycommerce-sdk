# app-config.json

The file that describes an app to FlyCommerce: where it's served, its dashboard pages, its storefront scripts and its install redirect. It lives in the app's repository and is uploaded on release, from the CLI or the developer portal. FlyCommerce and every SDK check it with the same rules.

## Environments

Only `appUrl` differs between environments; everything else is a path on it. A developer keeps one app per environment, each with its own file:

- `app-config.json`: the production app, the one merchants install and FlyCommerce reviews;
- `app-config.<name>.json`, like `app-config.dev.json`: another app, such as an unpublished development app.

The files differ in `appId`, and `appUrl` when the environment has a fixed one. `flycommerce app dev` replaces `appUrl` with its tunnel.

## Example

```json
{
  "appId": "order-export",
  "appUrl": "https://export.example.com",
  "install": { "redirectUrl": "/auth/callback" },
  "dashboard": {
    "pages": [{ "slug": "export", "label": "Export orders", "path": "/export" }]
  },
  "storefront": {
    "scripts": [{ "handle": "welcome", "src": "/storefront/welcome.js", "load": "idle" }]
  }
}
```

## Keys

| Key | Rule |
| --- | --- |
| `appId` | Required. The app's ID from the developer portal. |
| `versionId` | Optional. The version this file releases, a whole number from 1. The CLI fills it in; an upload without it releases the version waiting to be released. When present, it must be that version. |
| `version` | Optional. Three numbers, like `1.11.0`, matching `versionId`'s changelog entry. Filled in like `versionId`. |
| `quote` | Optional. Up to 140 characters. |
| `appUrl` | Required. Where the app is served: `https`, with no query string or `#`. Plain `http` only for `localhost`, `127.0.0.1`, `[::1]` and `.test` hosts, which FlyCommerce accepts only in local environments. |
| `install` | Optional. Takes only `redirectUrl`. |
| `install.redirectUrl` | Where installs are sent back with their one-time code: a path on `appUrl`, or an `https` URL on `appUrl`'s host. When present, releasing or pushing the file sets the app's redirect URL, and the portal shows it as set by `app-config.json`. |
| `dashboard.pages` | Required, may be empty. Up to 20 pages, each `{ slug, label, path, children? }`. See below. |
| `storefront.scripts` | Optional. Up to 3 scripts. See [storefront-scripts.md](storefront-scripts.md). |

No other keys are accepted.

### Pages

| Key | Rule |
| --- | --- |
| `slug` | Letters, numbers, `-` and `_`, up to 100 characters, unique across pages and sub-pages. |
| `label` | 1 to 40 characters. |
| `path` | Starts with `/`, with no spaces, `?` or `#`. The dashboard frames `appUrl` + `path`. |
| `children` | Sub-pages, one level deep, with the same keys except `children`. |

## Paths and URLs

A script `src` and `install.redirectUrl` take either form:

- **A path**, the recommended form: starts with a single `/` (not `//`), with no `\`, `#` or spaces. It's resolved by appending it to `appUrl` with any trailing `/` removed, the same way as a page's `path`: `https://export.example.com` + `/storefront/welcome.js`.
- **An absolute URL**: `https` (plain `http` only for the local hosts above), on the same host as `appUrl`, with no user name or password, `\` or `#`.

Either is at most 2000 characters. FlyCommerce stores every page, script and redirect as an absolute URL, so a later change to `appUrl` takes effect only through a release or a development push.
