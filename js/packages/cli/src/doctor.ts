import fs from 'node:fs';
import path from 'node:path';
import { checkAppConfig } from '@flycommerce/app-server';
import { readJsonObject } from './config-file.js';
import { CliError, Context } from './context.js';
import { ENV_FILE, platformValues, readEnvFile } from './env.js';
import { isIgnored } from './git.js';
import { describeUser } from './login.js';
import { ApiError, PortalApi } from './portal.js';
import { AppSummary, PlatformEnvironment } from './types.js';

const MIN_NODE = 22;
const CONFIG_FILE = /^app-config(\.[A-Za-z0-9_-]{1,40})?\.json$/;
// What @flycommerce/app-server refuses to start without.
const REQUIRED_ENV = ['APP_ID', 'APP_SECRET', 'HUB_API_URL'];

type Level = 'ok' | 'warn' | 'fail';

interface Check {
  level: Level;
  text: string;
  fix?: string;
}

const MARK: Record<Level, string> = { ok: '✓', warn: '!', fail: '✗' };

function onPath(program: string, env: NodeJS.ProcessEnv): boolean {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const names = process.platform === 'win32' ? [`${program}.exe`, `${program}.cmd`] : [program];

  return (env[pathKey] ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => names.some((name) => fs.existsSync(path.join(dir, name))));
}

function configFiles(cwd: string): string[] {
  return fs
    .readdirSync(cwd)
    .filter((name) => CONFIG_FILE.test(name))
    .sort((a, b) => (a === 'app-config.json' ? -1 : b === 'app-config.json' ? 1 : a.localeCompare(b)));
}

/** Checks the sign-in, the config files and .env; resolves to 1 when something must be fixed. */
export async function doctor(ctx: Context, portal: string): Promise<number> {
  const checks: Check[] = [];
  const add = (level: Level, text: string, fix?: string) => checks.push({ level, text, fix });

  const major = Number(process.versions.node.split('.')[0]);
  if (major >= MIN_NODE) add('ok', `Node ${process.versions.node}`);
  else add('fail', `Node ${process.versions.node} is too old`, `Install Node ${MIN_NODE} or later.`);

  // The config files, read locally.
  const appIds = new Map<string, string>();
  const files = configFiles(ctx.cwd);

  if (files.length === 0) {
    add('fail', 'No app-config.json here', "Run this in your app's folder, or start one: flycommerce app init");
  }
  for (const file of files) {
    try {
      const config = readJsonObject(path.join(ctx.cwd, file));
      const problems = checkAppConfig(config);
      if (problems.length > 0) {
        add('fail', `${file} is not valid: ${problems.join('; ')}`);
      } else {
        add('ok', `${file} is valid`);
        if (typeof config.appId === 'string') appIds.set(file, config.appId);
      }
    } catch (error) {
      add('fail', error instanceof CliError ? error.message : `${file} can't be read: ${(error as Error).message}`);
    }
  }

  // The sign-in, and what the portal knows.
  let environment: PlatformEnvironment | undefined;

  try {
    const api = PortalApi.signedIn(portal, ctx);
    const me = await api.get<{ name?: string; email?: string }>('me');
    add('ok', `Signed in to ${portal} as ${describeUser(me)}${api.usesEnvToken ? ' (with FLYCOMMERCE_TOKEN)' : ''}`);

    environment = await api.get<PlatformEnvironment>('me/environment');

    if (appIds.size > 0) {
      let apps: AppSummary[] | undefined;
      try {
        apps = await api.get<AppSummary[]>('apps');
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 403) throw error;
        add(
          'warn',
          "This token can't list your apps, so which app each config uses wasn't checked",
          'Sign in with flycommerce login to check it.'
        );
      }
      for (const [file, appId] of appIds) {
        if (!apps) break;
        const app = apps.find((candidate) => candidate.appId === appId);
        const link = `flycommerce app link${file === 'app-config.json' ? '' : ` --config ${file.slice('app-config.'.length, -'.json'.length)}`}`;

        if (!app) add('fail', `${file}: ${appId} isn't one of your apps on ${portal}`, link);
        else if (file !== 'app-config.json' && app.status !== 'unpublished')
          add(
            'warn',
            `${file}: ${app.name} is ${app.status}, so app dev won't push to it`,
            'Link an unpublished development app: flycommerce app create --dev'
          );
        else add('ok', `${file}: ${app.name} (${app.status})`);
      }
    }
  } catch (error) {
    add('fail', error instanceof CliError ? error.message : String(error), 'flycommerce login');
  }

  // .env, without ever printing a value that could be a secret.
  const envFile = path.join(ctx.cwd, ENV_FILE);
  const env = readEnvFile(envFile);

  if (env === undefined) {
    add('fail', `No ${ENV_FILE} here`, 'flycommerce env pull writes the platform values; set APP_ID and APP_SECRET too.');
  } else {
    const missing = REQUIRED_ENV.filter((key) => !env[key]);
    if (missing.length > 0)
      add('fail', `${ENV_FILE} is missing ${missing.join(', ')}`, missing.includes('HUB_API_URL') ? 'flycommerce env pull' : undefined);
    else add('ok', `${ENV_FILE} has ${REQUIRED_ENV.join(', ')}`);

    if (env.APP_ID && appIds.size > 0 && ![...appIds.values()].includes(env.APP_ID)) {
      add('warn', `${ENV_FILE}'s APP_ID matches none of the config files`, `Use the App ID from one of: ${[...appIds.keys()].join(', ')}`);
    }

    if (environment) {
      const expected = platformValues(environment);
      // ALLOWED_ISSUERS is a list, comma- or space-separated, as @flycommerce/app-server reads it.
      const normal = (key: string, value: string) =>
        key === 'ALLOWED_ISSUERS'
          ? value
              .split(/[\s,]+/)
              .filter(Boolean)
              .sort()
              .join(',')
          : value;
      const differ = ['HUB_API_URL', 'JWKS_URL', 'ALLOWED_ISSUERS'].filter(
        (key) => env[key] !== undefined && normal(key, env[key]) !== normal(key, expected[key])
      );
      if (differ.length > 0)
        add('fail', `${ENV_FILE}'s ${differ.join(', ')} point at another platform than ${portal}`, 'flycommerce env pull');
      else if (env.HUB_API_URL) add('ok', `${ENV_FILE} points at ${environment.portalUrl}'s platform`);
    }

    const ignored = isIgnored(ctx.cwd, ctx.env, ENV_FILE);
    if (ignored === false)
      add('fail', `git doesn't ignore ${ENV_FILE}, so its secrets could be committed`, `Add ${ENV_FILE} to .gitignore.`);
    else if (ignored) add('ok', `git ignores ${ENV_FILE}`);
  }

  // As app dev runs it: FLYCOMMERCE_CLOUDFLARED, a path or a name on PATH, else cloudflared.
  const cloudflared = ctx.env.FLYCOMMERCE_CLOUDFLARED || 'cloudflared';
  const found = /[\\/]/.test(cloudflared) ? fs.existsSync(cloudflared) : onPath(cloudflared, ctx.env);
  if (found) add('ok', 'cloudflared is installed, for app dev');
  else add('warn', 'cloudflared is not installed', 'app dev needs it for its tunnel, unless you pass --tunnel-url or use --local.');

  ctx.stdout(
    checks
      .flatMap((check) => [`${MARK[check.level]} ${check.text}`, ...(check.fix && check.level !== 'ok' ? [`    ${check.fix}`] : [])])
      .join('\n')
  );

  const failures = checks.filter((check) => check.level === 'fail').length;
  ctx.stdout(failures === 0 ? '\nNothing to fix.' : `\n${failures} to fix.`);
  return failures === 0 ? 0 : 1;
}
