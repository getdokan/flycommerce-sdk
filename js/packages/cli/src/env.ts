import fs from 'node:fs';
import path from 'node:path';
import { CliError, Context } from './context.js';
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

// A control character could end the line and start a key of its own.
const CONTROL = /[\u0000-\u001f\u007f]/;
// What the portal may send for the platform: plain http(s) URLs, nothing that could be read as more.
const PLATFORM_URL = /^https?:\/\/[^\s"'`\\]+$/;

/** Sets these keys in the file, keeping every other line; a new file is readable only by you, since it holds secrets. */
export function writeEnvValues(file: string, values: Record<string, string>, heading: string): { created: boolean } {
  for (const [key, value] of Object.entries(values)) {
    if (CONTROL.test(value)) throw new CliError(`Refusing to write ${key}: its value has a line break or another control character.`);
  }

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

function platformUrls(key: string, urls: unknown[]): string[] {
  if (urls.length === 0 || !urls.every((url) => typeof url === 'string' && PLATFORM_URL.test(url))) {
    throw new CliError(`The portal sent a ${key} that isn't a list of http(s) URLs, so nothing was written.`);
  }
  return urls as string[];
}

/** The four values, checked: they come from the network and end up in a file the app trusts. */
export function platformValues(environment: PlatformEnvironment): Record<string, string> {
  const ancestors = typeof environment.frameAncestors === 'string' ? environment.frameAncestors.split(' ').filter(Boolean) : [];

  return {
    HUB_API_URL: platformUrls('HUB_API_URL', [environment.hubApiUrl])[0],
    JWKS_URL: platformUrls('JWKS_URL', [environment.jwksUrl])[0],
    ALLOWED_ISSUERS: platformUrls('ALLOWED_ISSUERS', Array.isArray(environment.allowedIssuers) ? environment.allowedIssuers : []).join(','),
    FRAME_ANCESTORS: platformUrls('FRAME_ANCESTORS', ancestors).join(' '),
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
