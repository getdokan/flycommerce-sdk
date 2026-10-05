# Contributing

Thanks for helping. This guide covers developing the JavaScript packages and releasing them.

By taking part you agree to follow the [code of conduct](https://github.com/getdokan/flycommerce-sdk/blob/main/CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](https://github.com/getdokan/flycommerce-sdk/blob/main/SECURITY.md), never a public issue.

## Layout

```
spec/                     the contract every SDK follows
js/                       npm workspaces
  packages/app-bridge/
  packages/app-server/
  packages/app-emulator/
  .changeset/             pending release notes
ai/claude/                Claude Code plugins, one folder each
.claude-plugin/           the marketplace that lists them
```

Each language has its own folder and its own CI. Each package has its own changelog. The JavaScript packages share one version number: a release of any of them releases all of them, so an app only ever needs the same version of each.

## Develop

You need Node 22 or later, the oldest Node release still maintained. The repo pins 22 in `.nvmrc`.

```bash
cd js
npm ci
npm test               # builds, then runs every package's tests
npm run typecheck
npm run format         # Prettier; CI runs format:check
npm run check:package  # publint and "Are the types wrong?" on what would be published
```

Tests use Node's built-in runner (`node --test`). The React hooks in `app-bridge` use Vitest with jsdom.

### Rules for the packages

- **No runtime dependencies.** The published packages use Node's own modules (`node:crypto`, `node:http`, `fetch`) and an optional React peer. A new runtime dependency needs a strong reason and a maintainer's agreement in the PR.
- **ESM only**, with types. No CommonJS build.
- **Every network call has a timeout.**
- **Never put a token, secret or customer data in an error message or a log line.**
- **The bridge message names stay as they are.** The dashboard reads them, so changing one is a breaking change on both sides.
- **A change to the contract** (token claims, webhook signature) **starts in [`spec/`](https://github.com/getdokan/flycommerce-sdk/tree/main/spec)**, in the same PR as the code.

## Pull requests

1. Branch from `main`.
2. Make the change, with tests. A bug fix gets a test that fails without the fix.
3. Add a changeset if a published package changed:

   ```bash
   cd js
   npx changeset
   ```

   Pick the changed packages and the bump: `patch` for fixes, `minor` for features. While packages are `0.x`, a breaking change is a `minor`. Write the note for the developers who'll read the changelog. Commit the generated `.changeset/*.md` file. CI fails a PR that changes a package without one. If a change needs no release, run `npx changeset --empty`.

4. Open the PR with a title in the [commit message format](#commit-messages). CI must be green. PRs are squash-merged.

## Commit messages

Commit messages and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <summary>
```

| Type | For |
|---|---|
| `feat` | something new people can use |
| `fix` | a bug fix |
| `perf` | faster or smaller, same behaviour |
| `refactor` | a code change that doesn't change behaviour |
| `docs` | documentation only |
| `test` | tests only |
| `build` | the build, dependencies or release configuration |
| `ci` | GitHub Actions |
| `chore` | anything else, such as a release |

- The scope is optional: the package or area, such as `app-server`, `app-bridge`, `app-emulator`, `spec` or `ai`.
- Write the summary in the imperative, in lower case, with no full stop: `fix(app-server): refuse a webhook with no signature`.
- A breaking change adds `!` after the type or scope and says in the body what to change.

PRs are squash-merged, so the PR title becomes the commit on `main`, and a check fails the PR until the title follows the format. The commit message is for the history; developers read the changeset.

## Claude Code plugins

There's no publish step: developers get whatever is on `main` when they update the marketplace. So in the same pull request as a plugin change:

- bump `version` in its `.claude-plugin/plugin.json`, or installed copies won't update;
- add a section to its `CHANGELOG.md`;
- run `claude plugin validate --strict .` and the same on the plugin's folder (the `ai` workflow does both).

A skill states FlyCommerce's rules and points at the published docs for detail. When the platform changes, update the docs first, then the skill.

## Releasing

Maintainers only. Releases are published by GitHub Actions. The one exception is each package's very first version, published once by an admin, because npm needs a package to exist before Trusted Publishing can be set up for it.

Publishing stays switched off until the repository variable `NPM_PUBLISH_ENABLED` is `true`. An admin sets it once each package's first version is on npm and its Trusted Publisher is configured.

1. Merged changesets collect in a pull request titled **"Version Packages"**. The release workflow keeps it up to date: the next version for every package, and each package's `CHANGELOG.md`.
2. Review it, and squash-merge it when CI is green.
3. The publish job waits for approval in the **`release` environment**. A maintainer approves it in the workflow run.
4. The workflow publishes every package to npm with provenance, then tags each one (`@flycommerce/app-server@0.2.0`) and creates its GitHub release.
5. Check:

   ```bash
   npm view @flycommerce/<package> version
   ```

If publishing fails halfway, re-run the failed job. Packages already on npm are skipped.
