import { ParseArgsConfig, parseArgs } from 'node:util';
import { link, listApps, versions, whoami } from './apps.js';
import { LIMITS } from './changelog.js';
import { CliError, Context } from './context.js';
import { deleteCredential } from './credentials.js';
import { DEFAULT_COMMAND, DEFAULT_PORT, dev } from './dev.js';
import { login } from './login.js';
import { CLI_VERSION, DEFAULT_PORTAL, portalUrl } from './portal.js';
import { printable } from './printable.js';
import { release } from './release.js';
import { submit } from './submit.js';

export type { Context } from './context.js';

const HELP = `Usage: flycommerce <command> [options]

Commands:
  login            Sign in to the developer portal in your browser
  logout           Forget this computer's sign-in
  whoami           Show who you're signed in as
  app list         List your apps
  app link         Write an app's ID into app-config.json or app-config.<name>.json
  app dev          Run a development app on your store, through a tunnel to this computer
  app release      Work out the version and changelog from your commits, then release it
  app versions     List the app's versions and which one is live
  app submit       Check the review checklist and submit the app for FlyCommerce's review

Options:
  --portal <url>   The developer portal (default ${DEFAULT_PORTAL})
  -h, --help       Help for a command, like: flycommerce app dev --help
  -v, --version    The CLI's version

Environment:
  FLYCOMMERCE_TOKEN       A token to use instead of the saved sign-in, for CI
  FLYCOMMERCE_PORTAL_URL  The developer portal, when --portal isn't given`;

const COMMAND_HELP: Record<string, string> = {
  login: `Usage: flycommerce login [--portal <url>]

Opens the developer portal in your browser to allow the CLI, and keeps the token in
~/.config/flycommerce/credentials.json (readable only by you), one per portal.
The link is printed too, for a computer whose browser doesn't open by itself.`,
  logout: `Usage: flycommerce logout [--portal <url>]

Forgets this computer's sign-in to the portal. Revoke the token itself in the portal's Credentials tab.`,
  whoami: `Usage: flycommerce whoami [--portal <url>]`,
  'app list': `Usage: flycommerce app list [--portal <url>]

Your apps, with their App IDs and whether each is published.`,
  'app link': `Usage: flycommerce app link [--config <name>] [--app <appId>]

Writes the App ID into app-config.json, or app-config.<name>.json with --config <name>.
A new app-config.<name>.json starts as a copy of app-config.json. Without --app, asks which app.

  --config <name>  Use app-config.<name>.json, like --config dev
  --app <appId>    The app to link, from flycommerce app list`,
  'app dev': `Usage: flycommerce app dev [--config <name>] [--port <port>] [--tunnel-url <url>] [-- <command>]

Starts a Cloudflare quick tunnel to http://localhost:<port> (or uses --tunnel-url), pushes the
config to the development app with appUrl set to the tunnel, then runs your server with
APP_URL, REDIRECT_URI, PORT and APP_CONFIG_FILE set. Ctrl+C stops the server and the tunnel.
Only for an unpublished app: link a development app with flycommerce app link --config dev.

  --config <name>     Use app-config.<name>.json, like --config dev
  --port <port>       The port your server listens on (default ${DEFAULT_PORT})
  --tunnel-url <url>  Your own tunnel's https URL (ngrok, a named Cloudflare tunnel, …);
                      without it, cloudflared must be installed
  -- <command>        Your server's command (default: ${DEFAULT_COMMAND.join(' ')})`,
  'app release': `Usage: flycommerce app release [--version <x.y.z>] [--message <text>] [--title <text>] [--tag <tag>]…
                               [--config <name>] [--dry-run] [--edit] [--yes] [--no-release] [--no-git-tag]

Checks app-config.json, creates the version with its changelog, and releases it with the config.
A listed app's new pages, permissions and scripts wait for FlyCommerce's review.

Without --version, the version comes from the Conventional Commits since the last release: a
breaking change (type! or a BREAKING CHANGE: footer) bumps the major number (the minor one below
1.0.0), a feat the minor one, anything else releasable (fix, perf, refactor, revert) the patch one.
The last release is the highest <prefix><x.y.z> git tag in HEAD's history; without one, or when a
newer version was released, the version released last and the commits since its date. Only
commits touching this directory count.
The changelog groups them into breaking changes, features, fixes and other; the title is the
first breaking change or feature, else the first fix; the tags are the commits' scopes.
It shows all that and asks before releasing, then tags the commit: <prefix><version>, never pushed.

  --version <x.y.z>     The version, instead of working it out (needed outside a git repository)
  --message <text>      The changelog, instead of writing it from the commits
  --title <text>        The version's title, up to ${LIMITS.title} characters
  --tag <tag>           A tag, instead of the scopes; repeat for up to ${LIMITS.tags}
  --config <name>       Use app-config.<name>.json
  --tag-prefix <text>   Git tags look like <prefix><x.y.z> (default app-v, or app-<name>-v with --config)
  --include-all         Count every commit, chores, docs, tests and CI included
  --dry-run             Show the version and changelog, and stop: nothing is created
  --edit                Edit the changelog in $EDITOR before releasing
  -y, --yes             Don't ask; needed without a terminal unless --version and --message are both given
  --no-release          Create the version, but don't release it
  --no-git-tag          Don't create the git tag`,
  'app versions': `Usage: flycommerce app versions [--config <name>]

The app's versions, newest first, and which one is live.`,
  'app submit': `Usage: flycommerce app submit [--config <name>] [--notes <text>] [--yes]

Shows the app's review checklist, what's done and what isn't with where to fix it, and when all
of it is done, submits the app for FlyCommerce's review. Release a version first: the review
covers what's released. A published app has nothing to submit: its changes go to review when
they're released. Deploy tokens can release but not submit; sign in with flycommerce login.

  --config <name>  Use app-config.<name>.json
  --notes <text>   Notes for the reviewer, up to 5000 characters, like where to find a feature
  -y, --yes        Don't ask; needed without a terminal`,
};

type Options = NonNullable<ParseArgsConfig['options']>;

const COMMON: Options = { portal: { type: 'string' }, help: { type: 'boolean', short: 'h' } };
const CONFIG: Options = { config: { type: 'string' } };

const OPTIONS: Record<string, Options> = {
  login: {},
  logout: {},
  whoami: {},
  'app list': {},
  'app link': { ...CONFIG, app: { type: 'string' } },
  'app dev': { ...CONFIG, port: { type: 'string' }, 'tunnel-url': { type: 'string' } },
  'app release': {
    ...CONFIG,
    version: { type: 'string' },
    message: { type: 'string', short: 'm' },
    title: { type: 'string' },
    tag: { type: 'string', multiple: true },
    'tag-prefix': { type: 'string' },
    'include-all': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    edit: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    'no-release': { type: 'boolean' },
    'no-git-tag': { type: 'boolean' },
  },
  'app versions': { ...CONFIG },
  'app submit': { ...CONFIG, notes: { type: 'string' }, yes: { type: 'boolean', short: 'y' } },
};

/** Runs one command and returns the exit code. */
export async function run(argv: string[], context: Context): Promise<number> {
  // Names, titles and URLs come from the portal; whatever they hold, the terminal only shows text.
  const ctx: Context = {
    ...context,
    stdout: (text) => context.stdout(printable(text)),
    stderr: (text) => context.stderr(printable(text)),
  };

  try {
    return await dispatch(argv, ctx);
  } catch (error) {
    if (error instanceof CliError) {
      ctx.stderr(`Error: ${error.message}`);
      if (error.problems.length > 0) ctx.stderr(error.problems.map((problem) => `  - ${problem}`).join('\n'));
      return 1;
    }
    ctx.stderr(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function dispatch(argv: string[], ctx: Context): Promise<number> {
  const separator = argv.indexOf('--');
  const args = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  const [first, second] = args;

  if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
    ctx.stdout(HELP);
    return first === undefined ? 1 : 0;
  }
  if (first === '--version' || first === '-v') {
    ctx.stdout(CLI_VERSION);
    return 0;
  }

  const name = first === 'app' ? (second === undefined || second.startsWith('-') ? 'app' : `app ${second}`) : first;

  if (name === 'app') {
    ctx.stdout(HELP);
    return args.includes('--help') || args.includes('-h') ? 0 : 1;
  }
  if (!(name in OPTIONS)) {
    throw new CliError(`Unknown command: ${name}. Run flycommerce --help for the commands.`);
  }

  let values: Record<string, string | string[] | boolean | undefined>;
  let positionals: string[];

  try {
    ({ values, positionals } = parseArgs({
      args: args.slice(name.split(' ').length),
      options: { ...COMMON, ...OPTIONS[name] },
      allowPositionals: true,
      strict: true,
    }) as { values: Record<string, string | string[] | boolean | undefined>; positionals: string[] });
  } catch (error) {
    const option = /'([^']+)'/.exec((error as Error).message)?.[1];
    const problem =
      (error as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && option
        ? `Unknown option ${option}.`
        : (error as Error).message;
    throw new CliError(`${problem} Run flycommerce ${name} --help for its options.`);
  }

  if (values.help) {
    ctx.stdout(COMMAND_HELP[name]);
    return 0;
  }
  if (positionals.length > 0) {
    throw new CliError(`flycommerce ${name} doesn't take ${positionals.join(' ')}. Run flycommerce ${name} --help.`);
  }
  if (command.length > 0 && name !== 'app dev') {
    throw new CliError(`Only flycommerce app dev takes a command after --.`);
  }

  const portal = portalUrl(values.portal as string | undefined, ctx.env);
  const text = (key: string) => values[key] as string | undefined;
  const flag = (key: string) => values[key] === true;

  switch (name) {
    case 'login':
      await login(ctx, portal);
      return 0;
    case 'logout':
      ctx.stdout(
        deleteCredential(ctx.env, portal)
          ? `Signed out of ${portal} on this computer. The token works until it expires; revoke it in the portal's Credentials tab to end it now.`
          : `You weren't signed in to ${portal} on this computer.`
      );
      return 0;
    case 'whoami':
      await whoami(ctx, portal);
      return 0;
    case 'app list':
      await listApps(ctx, portal);
      return 0;
    case 'app link':
      await link(ctx, portal, { config: text('config'), app: text('app') });
      return 0;
    case 'app dev':
      return dev(ctx, portal, { config: text('config'), port: text('port'), tunnelUrl: text('tunnel-url'), command });
    case 'app release':
      await release(ctx, portal, {
        config: text('config'),
        version: text('version'),
        message: text('message'),
        title: text('title'),
        tags: values.tag as string[] | undefined,
        tagPrefix: text('tag-prefix'),
        includeAll: flag('include-all'),
        dryRun: flag('dry-run'),
        edit: flag('edit'),
        yes: flag('yes'),
        noRelease: flag('no-release'),
        noGitTag: flag('no-git-tag'),
      });
      return 0;
    case 'app versions':
      await versions(ctx, portal, { config: text('config') });
      return 0;
    case 'app submit':
      await submit(ctx, portal, { config: text('config'), notes: text('notes'), yes: flag('yes') });
      return 0;
  }

  return 1;
}
