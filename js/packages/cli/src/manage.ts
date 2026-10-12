import fs from 'node:fs';
import path from 'node:path';
import { configFileName, readConfigFile, writeAppId } from './config-file.js';
import { CliError, Context, confirmed } from './context.js';
import { ENV_FILE, writeEnvValues } from './env.js';
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

/** Shows a secret once, or writes it to .env so it never reaches the terminal. */
function handOver(ctx: Context, values: Record<string, string>, secretKey: string, writeEnv: boolean | undefined): void {
  if (writeEnv) {
    const { created } = writeEnvValues(path.join(ctx.cwd, ENV_FILE), values, 'From flycommerce');
    ctx.stdout(`${created ? 'Created' : 'Updated'} ${ENV_FILE} with ${Object.keys(values).join(' and ')}.`);
    return;
  }

  ctx.stdout(
    [
      `The app secret, shown only now:`,
      `  ${values[secretKey]}`,
      `Keep it as ${secretKey} in your server's .env, never in the repo. Lost it? flycommerce app secret rotate.`,
    ].join('\n')
  );
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

  const api = PortalApi.signedIn(portal, ctx);
  const created = await api.post<CreatedApp>('apps', {
    name,
    ...(options.redirectUrl !== undefined ? { redirectUrl: options.redirectUrl } : {}),
    ...(categoryId !== undefined ? { categoryId } : {}),
  });

  ctx.stdout(`Created ${created.name} (${created.appId}), ${created.status}: it installs only on your own stores until you publish it.`);

  if (linkTo !== undefined) {
    const { fileName, created: newFile } = writeAppId(ctx, linkTo, created.appId);
    ctx.stdout(`${newFile ? 'Created' : 'Updated'} ${fileName}: appId is ${created.appId}.`);
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
  const url = page === 'install' ? urls.installUrl : urls[page];

  ctx.stdout(`Opening ${url}`);
  ctx.openUrl(url);
}

export async function rotateSecret(
  ctx: Context,
  portal: string,
  options: { config?: string; yes?: boolean; writeEnv?: boolean }
): Promise<void> {
  const { appId } = readConfigFile(ctx, options.config);
  const api = PortalApi.signedIn(portal, ctx);
  let secret: string;

  try {
    ({ secret } = await api.post<{ secret: string }>(`${appPath(appId)}/secret`, {}));
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
  handOver(ctx, { APP_SECRET: secret }, 'APP_SECRET', options.writeEnv);
}
