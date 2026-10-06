import fs from 'node:fs';
import path from 'node:path';
import { CliError, Context } from './context.js';

const NAME = /^[A-Za-z0-9_-]{1,40}$/;

export interface ConfigFile {
  name: string;
  path: string;
  config: Record<string, unknown>;
}

/** app-config.json, or app-config.<name>.json for --config <name>. */
export function configFileName(name: string | undefined): string {
  if (name === undefined) return 'app-config.json';
  if (!NAME.test(name)) {
    throw new CliError(`--config takes a name like dev, for app-config.dev.json; "${name}" isn't one.`);
  }
  return `app-config.${name}.json`;
}

export function linkHint(name: string | undefined): string {
  return `flycommerce app link${name === undefined ? '' : ` --config ${name}`}`;
}

export function readJsonObject(file: string): Record<string, unknown> {
  let value: unknown;

  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CliError(`${path.basename(file)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError(`${path.basename(file)} must be a single JSON object.`);
  }

  return value as Record<string, unknown>;
}

/** The linked config file: it must exist and name its app. */
export function readConfigFile(ctx: Context, name: string | undefined): ConfigFile & { appId: string } {
  const fileName = configFileName(name);
  const file = path.join(ctx.cwd, fileName);

  if (!fs.existsSync(file)) {
    throw new CliError(`There's no ${fileName} here. Run: ${linkHint(name)}`);
  }

  const config = readJsonObject(file);

  if (typeof config.appId !== 'string' || config.appId === '') {
    throw new CliError(`${fileName} has no appId. Run: ${linkHint(name)}`);
  }

  return { name: fileName, path: file, config, appId: config.appId };
}

const TEMPLATE = (appId: string) => ({
  appId,
  appUrl: 'https://your-app.example.com',
  install: { redirectUrl: '/auth/callback' },
  dashboard: { pages: [] },
});

/** Writes appId, keeping the rest; a new app-config.<name>.json starts as a copy of app-config.json. */
export function writeAppId(ctx: Context, name: string | undefined, appId: string): { fileName: string; created: boolean } {
  const fileName = configFileName(name);
  const file = path.join(ctx.cwd, fileName);

  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    const config = readJsonObject(file);
    const field = /("appId"\s*:\s*)"(?:[^"\\]|\\.)*"/g;
    const matches = text.match(field) ?? [];
    const updated =
      typeof config.appId === 'string' && matches.length === 1
        ? text.replace(field, (_, key: string) => `${key}${JSON.stringify(appId)}`)
        : JSON.stringify({ ...config, appId }, null, 2) + '\n';

    fs.writeFileSync(file, updated);
    return { fileName, created: false };
  }

  const production = path.join(ctx.cwd, 'app-config.json');
  let contents: Record<string, unknown> = TEMPLATE(appId);

  if (name !== undefined && fs.existsSync(production)) {
    const { versionId, version, ...rest } = readJsonObject(production);
    contents = { ...rest, appId };
  }

  fs.writeFileSync(file, JSON.stringify(contents, null, 2) + '\n');
  return { fileName, created: true };
}
