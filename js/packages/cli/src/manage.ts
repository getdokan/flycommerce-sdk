import fs from 'node:fs';
import path from 'node:path';
import { checkWritable, configFileName, linkHint, readConfigFile, writeAppId } from './config-file.js';
import { CliError, Context, confirmed } from './context.js';
import { ENV_FILE, readEnvFile, writeEnvValues } from './env.js';
import { ApiError, PortalApi } from './portal.js';
import { AppStatusDetails, CreatedApp } from './types.js';

export interface CreateOptions {
  name?: string;
  dev?: boolean;
  config?: string;
  redirectUrl?: string;
  category?: string;
  writeEnv?: boolean;
}

const appPath = (appId: string) => `apps/${encodeURIComponent(appId)}`;

function packageName(cwd: string): string | undefined {
  try {
    const { name } = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as { name?: unknown };
    return typeof name === 'string' && name !== '' ? name : undefined;
  } catch {
    return undefined;
  }
}

async function appName(ctx: Context, options: CreateOptions): Promise<string> {
  if (options.name !== undefined) return options.name.trim();
  if (!ctx.prompt) throw new CliError('Name the app with --name "<name>".');

  const suggested = packageName(ctx.cwd);
  const fallback = suggested && options.dev ? `${suggested} (dev)` : suggested;
  const answer = (await ctx.prompt(`App name${fallback ? ` (${fallback})` : ''}: `)).trim();

  return answer || fallback || '';
}

const envPath = (ctx: Context) => path.join(ctx.cwd, ENV_FILE);

/** Before anything changes on the portal: .env must be readable, and never hold another app's credentials. */
function checkEnvFor(ctx: Context, appId: string | undefined): void {
  let current: Record<string, string> | undefined;

  try {
    current = readEnvFile(envPath(ctx));
  } catch (error) {
    throw new CliError(`Can't read ${ENV_FILE}: ${(error as Error).message}. Leave out --write-env to see the secret instead.`);
  }

  const held = current?.APP_ID;
  // A secret with no APP_ID beside it could be any app's.
  if ((held && held !== appId) || (!held && current?.APP_SECRET)) {
    throw new CliError(
      `${ENV_FILE} already holds ${held ? `APP_ID ${held}` : 'an APP_SECRET with no APP_ID'}, so --write-env would replace that app's credentials. Leave out --write-env to see the secret, or move those lines out of ${ENV_FILE} first.`
    );
  }
}

function showSecret(ctx: Context, secretKey: string, secret: string): void {
  ctx.stdout(
    [
      `The app secret, shown only now:`,
      `  ${secret}`,
      `Keep it as ${secretKey} in your server's .env, never in the repo. Lost it? flycommerce app secret rotate.`,
    ].join('\n')
  );
}

function warnIfShared(ctx: Context): void {
  if (process.platform === 'win32') return;
  const mode = fs.statSync(envPath(ctx)).mode & 0o777;
  if (mode & 0o077) {
    ctx.stdout(`Note: other users on this computer can read ${ENV_FILE} (mode ${mode.toString(8)}). Run: chmod 600 ${ENV_FILE}`);
  }
}

/** Shows a secret once, or writes it to .env so it never reaches the terminal; a failed write still shows it, since it can't be fetched again. */
function handOver(ctx: Context, values: Record<string, string>, secretKey: string, writeEnv: boolean | undefined): void {
  if (!writeEnv) return showSecret(ctx, secretKey, values[secretKey]);

  try {
    const { created } = writeEnvValues(envPath(ctx), values, 'From flycommerce');
    ctx.stdout(`${created ? 'Created' : 'Updated'} ${ENV_FILE} with ${Object.keys(values).join(' and ')}.`);
    warnIfShared(ctx);
  } catch (error) {
    showSecret(ctx, secretKey, values[secretKey]);
    throw new CliError(`Couldn't write ${ENV_FILE}: ${(error as Error).message}. The secret is above, shown this once.`);
  }
}

export async function createApp(ctx: Context, portal: string, options: CreateOptions): Promise<void> {
  // --dev links app-config.dev.json unless --config names another file.
  const linkTo = options.config ?? (options.dev ? 'dev' : undefined);
  if (linkTo !== undefined) configFileName(linkTo);

  let categoryId: number | undefined;
  if (options.category !== undefined) {
    categoryId = Number(options.category);
    if (!Number.isInteger(categoryId) || categoryId < 1) throw new CliError('--category takes a category ID, like 3.');
  }

  const name = await appName(ctx, options);
  if (name.length < 3) throw new CliError('The app name needs at least 3 characters.');

  // Checked before the portal call: the secret it returns can't be fetched again.
  if (linkTo !== undefined) checkWritable(ctx, linkTo);
  if (options.writeEnv) checkEnvFor(ctx, undefined);

  const api = PortalApi.signedIn(portal, ctx);
  const created = await api.post<CreatedApp>('apps', {
    name,
    ...(options.redirectUrl !== undefined ? { redirectUrl: options.redirectUrl } : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
  });

  ctx.stdout(`Created ${created.name} (${created.appId}), ${created.status}: it installs only on your own stores until you publish it.`);

  if (linkTo !== undefined) {
    try {
      const { fileName, created: newFile } = writeAppId(ctx, linkTo, created.appId);
      ctx.stdout(`${newFile ? 'Created' : 'Updated'} ${fileName}: appId is ${created.appId}.`);
    } catch (error) {
      showSecret(ctx, 'APP_SECRET', created.secret);
      throw new CliError(
        `Couldn't link ${created.appId}: ${(error as Error).message}. The secret is above, shown this once; link it with ${linkHint(linkTo)} --app ${created.appId}.`
      );
    }
  }

  handOver(ctx, { APP_ID: created.appId, APP_SECRET: created.secret }, 'APP_SECRET', options.writeEnv);

  const next =
    linkTo !== undefined
      ? `Next: flycommerce env pull, then flycommerce app dev --config ${linkTo}`
      : `Next: flycommerce app link --app ${created.appId}`;
  ctx.stdout(categoryId === undefined ? `${next}. Pick a category in the portal before you submit it for review.` : `${next}.`);
}

function date(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : '';
}

export async function status(ctx: Context, portal: string, options: { config?: string }): Promise<void> {
  const { appId } = readConfigFile(ctx, options.config);
  const app = await PortalApi.signedIn(portal, ctx).get<AppStatusDetails>(`${appPath(appId)}/status`);
  const live = app.liveVersion;
  const waiting = app.waitingVersion;
  const outstanding = app.checklist.outstanding;

  const rows: [string, string][] = [
    ['Live version', live ? `${live.version} (#${live.versionId}), released ${date(live.releasedAt)}` : 'none'],
    ['Waiting version', waiting ? `${waiting.version} (#${waiting.versionId}), not released` : 'none'],
    ['Waiting for review', app.awaitingReview.length > 0 ? app.awaitingReview.join(', ') : 'nothing'],
    [
      'Review checklist',
      app.checklist.ready ? 'ready' : `${outstanding.length} to do: ${outstanding.join(', ')} (details: flycommerce app submit)`,
    ],
    ['Installs', `${app.installs.active} active`],
    ['Last dev push', app.devPushedAt ? app.devPushedAt.replace('T', ' ').slice(0, 16) : 'never'],
    ['Portal', app.urls.portal],
    ['Install link', app.urls.installUrl],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines = [`${app.name} (${app.appId}), ${app.status}`, ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)];

  // Only the developer's own stores are listed; a published app's merchants are theirs to disclose.
  for (const store of app.installs.stores ?? []) {
    lines.push(`    ${store.host ?? 'a store'}${store.installedAt ? `  since ${date(store.installedAt)}` : ''}`);
  }

  ctx.stdout(lines.join('\n'));
}

const PAGES = ['portal', 'versions', 'publishing', 'install'] as const;

export async function openApp(ctx: Context, portal: string, options: { config?: string; page?: string }): Promise<void> {
  const page = (options.page ?? 'portal') as (typeof PAGES)[number];
  if (!PAGES.includes(page)) throw new CliError(`--page takes ${PAGES.join(', ')}.`);

  const { appId } = readConfigFile(ctx, options.config);
  const { urls } = await PortalApi.signedIn(portal, ctx).get<AppStatusDetails>(`${appPath(appId)}/status`);
  const url = openable(page === 'install' ? urls.installUrl : urls[page], portal);

  ctx.stdout(`Opening ${url}`);
  ctx.openUrl(url);
}

/** Only a web link reaches the system's opener, which would run a file: or program path too. */
function openable(url: string, portal: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new CliError("The portal sent a link that isn't a URL, so it wasn't opened.");
  }

  // http only when the portal itself is on this computer, which portalUrl allows.
  const allowed = parsed.protocol === 'https:' || (parsed.protocol === 'http:' && new URL(portal).protocol === 'http:');
  if (!allowed) throw new CliError(`The portal sent a ${parsed.protocol} link, so it wasn't opened: only https links open.`);

  return parsed.href;
}

export async function rotateSecret(
  ctx: Context,
  portal: string,
  options: { config?: string; yes?: boolean; writeEnv?: boolean }
): Promise<void> {
  const { appId } = readConfigFile(ctx, options.config);
  if (options.writeEnv) checkEnvFor(ctx, appId);

  const api = PortalApi.signedIn(portal, ctx);
  let secret: string;

  try {
    // With --yes the hub's confirmation goes in the first request: each rotation counts against an hourly limit.
    ({ secret } = await api.post<{ secret: string }>(`${appPath(appId)}/secret`, options.yes ? { confirm: true } : {}));
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'confirm_required') throw error;

    // A published app's live installs fail to exchange codes until the new secret is deployed.
    if (!options.yes) {
      if (!ctx.prompt) throw new CliError(`${error.message} Pass --yes to rotate it anyway.`);
      ctx.stdout(`${appId} is published. Its live installs break until you deploy the new secret.`);
      if (!(await confirmed(ctx.prompt, 'Rotate the secret? (y/N) '))) throw new CliError('Cancelled; the secret is unchanged.');
    }

    ({ secret } = await api.post<{ secret: string }>(`${appPath(appId)}/secret`, { confirm: true }));
  }

  ctx.stdout(`Rotated ${appId}'s secret. The old one stopped working.`);
  handOver(ctx, { APP_ID: appId, APP_SECRET: secret }, 'APP_SECRET', options.writeEnv);
}
