# Security policy

## Reporting a vulnerability

Please **don't** report security problems in public issues, discussions or pull requests.

Report them privately through GitHub: [**Report a vulnerability**](https://github.com/getdokan/flycommerce-sdk/security/advisories/new). Only the maintainers can see the report.

Please include:

- the package and version affected
- what an attacker can do, and what they need first
- steps or code to reproduce it

## What happens next

- We acknowledge the report within **3 business days**.
- We send a first assessment, with severity and next steps, within **10 business days**.
- We fix confirmed issues in the latest version of each affected package, publish a [GitHub security advisory](https://github.com/getdokan/flycommerce-sdk/security/advisories), and request a CVE where one applies.
- We credit you in the advisory unless you'd rather we didn't.

Please give us a reasonable time to release a fix before you disclose the issue publicly. We aim to fix critical issues within 30 days.

## Supported versions

Only the latest published version of each package gets security fixes. Packages are `0.x`: breaking changes come in minor versions, and older lines aren't patched.

## Scope

In scope: the code in this repository and the packages published from it.

Out of scope here: FlyCommerce's hosted services (the dashboard, stores, the APIs). Report those through the same link, and we'll route them to the right team.

## How releases are protected

The packages aren't on npm yet. From their first release:

- They're published from GitHub Actions with npm Trusted Publishing and [provenance](https://docs.npmjs.com/generating-provenance-statements), so no long-lived npm token exists.
- Every release needs a maintainer's approval in the `release` environment.
- Their only runtime dependency is each other: `app-server` and `app-testing` use `app-bridge`.

Already true today: every GitHub Action is pinned to a full commit SHA, and Dependabot keeps them and the dev dependencies current.

Once a package is published, check that what you installed was built from this repository:

```bash
npm audit signatures
```
