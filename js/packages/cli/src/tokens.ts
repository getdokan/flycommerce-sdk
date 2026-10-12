import { readConfigFile } from './config-file.js';
import { CliError, Context, confirmed } from './context.js';
import { PortalApi } from './portal.js';
import { table } from './table.js';
import { CreatedDeployToken, DeployToken } from './types.js';

const EXPIRY_DAYS = [30, 90, 180];
export const DEFAULT_EXPIRY_DAYS = 90;
const NAME_LIMIT = 60;

const tokensPath = (appId: string) => `apps/${encodeURIComponent(appId)}/tokens`;

export async function createToken(
  ctx: Context,
  portal: string,
  options: { config?: string; name?: string; expires?: string }
): Promise<void> {
  const name = (options.name ?? 'CI').trim();
  if (name === '' || name.length > NAME_LIMIT) throw new CliError(`--name takes up to ${NAME_LIMIT} characters, like "GitHub Actions".`);

  const days = options.expires === undefined ? DEFAULT_EXPIRY_DAYS : Number(options.expires);
  if (!EXPIRY_DAYS.includes(days)) throw new CliError(`--expires takes ${EXPIRY_DAYS.join(', ')} (days).`);

  const { appId } = readConfigFile(ctx, options.config);
  const created = await PortalApi.signedIn(portal, ctx).post<CreatedDeployToken>(tokensPath(appId), { name, expiresInDays: days });

  ctx.stdout(
    [
      `Created deploy token "${created.name}" for ${appId}${created.expiresAt ? `, expiring ${created.expiresAt.slice(0, 10)}` : ''}.`,
      'The token, shown only now:',
      `  ${created.token}`,
      "Save it as the FLYCOMMERCE_TOKEN secret in your CI. It releases versions of this app only: it can't submit for review or manage tokens.",
    ].join('\n')
  );
}

export async function listTokens(ctx: Context, portal: string, options: { config?: string }): Promise<void> {
  const { appId } = readConfigFile(ctx, options.config);
  const tokens = await PortalApi.signedIn(portal, ctx).get<DeployToken[]>(tokensPath(appId));

  if (tokens.length === 0) {
    ctx.stdout(`${appId} has no deploy tokens. Create one for CI with: flycommerce app token create --name "<name>"`);
    return;
  }

  const day = (value: string | null) => (value ? value.slice(0, 10) : '');
  ctx.stdout(
    table([
      ['ID', 'NAME', 'CREATED', 'EXPIRES', 'LAST USED'],
      ...tokens.map((token) => [
        String(token.id),
        token.name,
        day(token.createdAt),
        day(token.expiresAt),
        day(token.lastUsedAt) || 'never',
      ]),
    ])
  );
}

export async function revokeToken(ctx: Context, portal: string, options: { config?: string; id?: string; yes?: boolean }): Promise<void> {
  if (options.id === undefined || !/^\d{1,18}$/.test(options.id)) {
    throw new CliError('Name the token by its ID, from flycommerce app token list: flycommerce app token revoke <id>');
  }

  const { appId } = readConfigFile(ctx, options.config);

  if (!options.yes) {
    if (!ctx.prompt) throw new CliError('Nobody is at a terminal to confirm this: pass --yes to revoke the token.');
    if (!(await confirmed(ctx.prompt, `Revoke deploy token ${options.id}? CI using it stops releasing. (y/N) `))) {
      throw new CliError('Cancelled; the token still works.');
    }
  }

  await PortalApi.signedIn(portal, ctx).delete(`${tokensPath(appId)}/${options.id}`);
  ctx.stdout(`Revoked deploy token ${options.id} for ${appId}.`);
}
