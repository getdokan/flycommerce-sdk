import { configFileName, linkHint, readConfigFile, writeAppId } from './config-file.js';
import { CliError, Context } from './context.js';
import { describeUser } from './login.js';
import { PortalApi } from './portal.js';
import { table } from './table.js';
import { AppDetails, AppSummary, AppVersionSummary } from './types.js';

export async function whoami(ctx: Context, portal: string): Promise<void> {
  const api = PortalApi.signedIn(portal, ctx);
  const me = await api.get<{ name?: string; email?: string }>('me');
  ctx.stdout(`Signed in to ${portal} as ${describeUser(me)}${api.usesEnvToken ? ' (with FLYCOMMERCE_TOKEN)' : ''}.`);
}

export async function listApps(ctx: Context, portal: string): Promise<void> {
  const apps = await PortalApi.signedIn(portal, ctx).get<AppSummary[]>('apps');

  if (apps.length === 0) {
    ctx.stdout(`You have no apps yet. Create one in the developer portal, ${portal}.`);
    return;
  }

  ctx.stdout(table([['APP ID', 'NAME', 'STATUS'], ...apps.map((app) => [app.appId, app.name, app.status])]));
}

export async function link(ctx: Context, portal: string, options: { config?: string; app?: string }): Promise<void> {
  const fileName = configFileName(options.config);
  const apps = await PortalApi.signedIn(portal, ctx).get<AppSummary[]>('apps');

  if (apps.length === 0) {
    throw new CliError(`You have no apps yet. Create one in the developer portal, ${portal}, then run: ${linkHint(options.config)}`);
  }

  const listing = apps.map(
    (app, index) => `  ${index + 1}. ${app.name} (${app.appId})${app.status === 'unpublished' ? '' : `, ${app.status}`}`
  );
  let chosen: AppSummary | undefined;

  if (options.app !== undefined) {
    chosen = apps.find((app) => app.appId === options.app);
    if (!chosen) throw new CliError(`You have no app ${options.app}. Your apps:`, listing);
  } else if (ctx.prompt) {
    ctx.stdout(`Which app should ${fileName} use?\n${listing.join('\n')}`);
    const answer = (await ctx.prompt(`Number (1-${apps.length}): `)).trim();
    chosen = apps[Number(answer) - 1];
    if (!/^\d+$/.test(answer) || !chosen) throw new CliError(`"${answer}" isn't one of the numbers.`);
  } else {
    throw new CliError('Pass the app with --app <appId>. Your apps:', listing);
  }

  const { created } = writeAppId(ctx, options.config, chosen.appId);
  ctx.stdout(`${created ? 'Created' : 'Updated'} ${fileName}: appId is ${chosen.appId} (${chosen.name}).`);

  if (options.config !== undefined && chosen.status !== 'unpublished') {
    ctx.stdout(`${chosen.name} is ${chosen.status}, so app dev won't push to it. Link an unpublished development app for local work.`);
  }
}

/** The live version is the one released last. */
export function liveVersion(versions: AppVersionSummary[]): AppVersionSummary | undefined {
  return versions
    .filter((version) => version.releasedAt)
    .sort((a, b) => Date.parse(b.releasedAt!) - Date.parse(a.releasedAt!) || b.versionId - a.versionId)[0];
}

export async function versions(ctx: Context, portal: string, options: { config?: string }): Promise<void> {
  const { appId } = readConfigFile(ctx, options.config);
  const app = await PortalApi.signedIn(portal, ctx).get<AppDetails>(`apps/${encodeURIComponent(appId)}`);
  const live = liveVersion(app.versions);

  ctx.stdout(`${app.name} (${app.appId})`);

  if (app.versions.length === 0) {
    ctx.stdout('No versions yet. Create and release one with: flycommerce app release --version 1.0.0 --message "…"');
    return;
  }

  const rows = [...app.versions]
    .sort((a, b) => b.versionId - a.versionId)
    .map((version) => [
      version.version,
      `#${version.versionId}`,
      version.versionId === live?.versionId ? 'live' : version.releasedAt ? 'released' : 'not released',
      version.releasedAt ? version.releasedAt.slice(0, 10) : '',
      version.title,
    ]);

  ctx.stdout(table([['VERSION', 'ID', 'STATE', 'RELEASED', 'TITLE'], ...rows]));
}
