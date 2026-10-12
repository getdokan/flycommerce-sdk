import fs from 'node:fs';
import path from 'node:path';
import { Context } from './context.js';
import { PortalApi } from './portal.js';
import { PlatformEnvironment } from './types.js';

export const ENV_FILE = '.env';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/** KEY=value pairs from a .env file; comments and blank lines are skipped, quotes removed. */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    values[match[1]] = unquote(match[2]);
  }

  return values;
}

function unquote(raw: string): string {
  const value = raw.trim();
  const quote = value[0];

  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }

  // An unquoted value ends at an inline comment.
  return value.replace(/\s+#.*$/, '');
}

function quoted(value: string): string {
  return /^[A-Za-z0-9_./:@*,+-]*$/.test(value) ? value : JSON.stringify(value);
}

export function readEnvFile(file: string): Record<string, string> | undefined {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Sets these keys in the file, keeping every other line; a new file is readable only by you, since it holds secrets. */
export function writeEnvValues(file: string, values: Record<string, string>, heading: string): { created: boolean } {
  let lines: string[] = [];
  let created = false;

  try {
    lines = fs
      .readFileSync(file, 'utf8')
      .replace(/\r?\n$/, '')
      .split(/\r?\n/);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    created = true;
  }

  const pending = new Map(Object.entries(values));
  const kept: string[] = [];

  for (const line of lines) {
    const key = line.trimStart().startsWith('#') ? undefined : LINE.exec(line)?.[1];

    if (key === undefined || !(key in values)) {
      kept.push(line);
    } else if (pending.has(key)) {
      kept.push(`${key}=${quoted(values[key])}`);
      pending.delete(key);
    }
    // A key set twice keeps only its first line: the one now written.
  }

  if (pending.size > 0) {
    if (kept.length > 0 && kept[kept.length - 1].trim() !== '') kept.push('');
    kept.push(`# ${heading}`, ...[...pending].map(([key, value]) => `${key}=${quoted(value)}`));
  }

  fs.writeFileSync(file, kept.join('\n') + '\n', created ? { mode: 0o600, flag: 'wx' } : {});
  return { created };
}

export function platformValues(environment: PlatformEnvironment): Record<string, string> {
  return {
    HUB_API_URL: environment.hubApiUrl,
    JWKS_URL: environment.jwksUrl,
    ALLOWED_ISSUERS: environment.allowedIssuers.join(','),
    FRAME_ANCESTORS: environment.frameAncestors,
  };
}

/** Points the app's server at the platform behind this portal: production, staging or a local hub. */
export async function envPull(ctx: Context, portal: string, options: { file?: string }): Promise<void> {
  const environment = await PortalApi.signedIn(portal, ctx).get<PlatformEnvironment>('me/environment');
  const fileName = options.file ?? ENV_FILE;
  const file = path.resolve(ctx.cwd, fileName);
  const values = platformValues(environment);
  const { created } = writeEnvValues(file, values, `The platform behind ${environment.portalUrl}, from flycommerce env pull`);

  ctx.stdout(
    [
      `${created ? 'Created' : 'Updated'} ${fileName} for ${environment.portalUrl}:`,
      ...Object.entries(values).map(([key, value]) => `  ${key}=${value}`),
      '',
      'APP_ID and APP_SECRET are yours to set: flycommerce app create --dev --write-env does both for a new app.',
    ].join('\n')
  );
}
