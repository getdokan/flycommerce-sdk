import fs from 'node:fs';

export interface AppConfigPage {
  slug: string;
  label: string;
  path: string;
  children?: AppConfigPage[];
}

/** app-config.json: the version this code is, and the dashboard pages it serves. Released from the developer portal. */
export interface AppConfig {
  appId: string;
  versionId: number;
  version: string;
  quote?: string;
  appUrl: string;
  dashboard: { pages: AppConfigPage[] };
}

export class AppConfigError extends Error {
  constructor(
    readonly file: string,
    readonly problems: string[]
  ) {
    super(`${file} is not valid:\n- ${problems.join('\n- ')}`);
    this.name = 'AppConfigError';
  }
}

const KEYS = ['appId', 'versionId', 'version', 'quote', 'appUrl', 'dashboard'];
const MAX_PAGES = 20;
const SLUG = /^[A-Za-z0-9_-]{1,100}$/;
const PATH = /^\/[^\s?#]*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Reads and checks app-config.json, with the rules FlyCommerce applies when it is uploaded, so a broken file
 * stops the app at start instead of at release. Pass `appId` to also check the file belongs to this app.
 */
export function loadAppConfig(file: string, options: { appId?: string } = {}): AppConfig {
  let value: unknown;

  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new AppConfigError(file, [error instanceof Error ? error.message : String(error)]);
  }

  const problems = checkAppConfig(value);

  if (problems.length === 0 && options.appId !== undefined && (value as AppConfig).appId !== options.appId) {
    problems.push(`appId is ${(value as AppConfig).appId}, but this app runs as ${options.appId} (APP_ID).`);
  }

  if (problems.length > 0) {
    throw new AppConfigError(file, problems);
  }

  return value as AppConfig;
}

/** Every problem with a parsed app-config.json; empty when it is valid. */
export function checkAppConfig(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['It must be a single JSON object.'];
  }

  const config = value as Record<string, unknown>;
  const problems: string[] = [];
  const unknown = Object.keys(config).filter((key) => !KEYS.includes(key));

  if (unknown.length > 0) {
    problems.push(`Unknown keys: ${unknown.join(', ')}. Its keys are ${KEYS.join(', ')}.`);
  }

  if (typeof config.appId !== 'string' || config.appId === '') {
    problems.push('appId is required.');
  }
  if (!Number.isInteger(config.versionId) || (config.versionId as number) < 1) {
    problems.push('versionId must be a whole number from 1, like 12.');
  }
  if (typeof config.version !== 'string' || !VERSION.test(config.version)) {
    problems.push('version must be three numbers, like 1.11.0.');
  }
  if (config.quote !== undefined && config.quote !== null && (typeof config.quote !== 'string' || config.quote.length > 140)) {
    problems.push('quote must be text of up to 140 characters.');
  }
  problems.push(...checkAppUrl(config.appUrl));

  const dashboard = config.dashboard as { pages?: unknown } | undefined;

  if (typeof dashboard !== 'object' || dashboard === null || !Array.isArray(dashboard.pages)) {
    problems.push('dashboard.pages must be a list.');
  } else if (Object.keys(dashboard).some((key) => key !== 'pages')) {
    problems.push('dashboard takes only pages.');
  } else {
    problems.push(...checkPages(dashboard.pages));
  }

  return problems;
}

/** The request paths an app must serve its dashboard page on: every page and sub-page. */
export function pagePaths(config: AppConfig): string[] {
  return config.dashboard.pages.flatMap((page) => [page.path, ...(page.children ?? []).map((child) => child.path)]);
}

function checkAppUrl(value: unknown): string[] {
  if (typeof value !== 'string') {
    return ['appUrl is required, like https://app.example.com.'];
  }

  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.test');

    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      return ['appUrl must use https (http only for localhost).'];
    }
    if (url.search !== '' || url.hash !== '') {
      return ['appUrl must not have a query string or #.'];
    }
  } catch {
    return [`appUrl is not a URL: ${value}`];
  }

  return [];
}

function checkPages(pages: unknown[]): string[] {
  const problems: string[] = [];
  const slugs: string[] = [];

  if (pages.length > MAX_PAGES) {
    problems.push(`Up to ${MAX_PAGES} pages.`);
  }

  const check = (page: unknown, where: string, nested: boolean) => {
    if (typeof page !== 'object' || page === null) {
      problems.push(`${where} must be an object.`);
      return;
    }

    const { slug, label, path, children, ...rest } = page as Record<string, unknown>;

    if (Object.keys(rest).length > 0) {
      problems.push(`${where} does not take ${Object.keys(rest).join(', ')}.`);
    }
    if (typeof slug !== 'string' || !SLUG.test(slug)) {
      problems.push(`${where}.slug must be letters, numbers, - and _.`);
    } else {
      slugs.push(slug);
    }
    if (typeof label !== 'string' || label === '' || label.length > 40) {
      problems.push(`${where}.label must be text of up to 40 characters.`);
    }
    if (typeof path !== 'string' || !PATH.test(path)) {
      problems.push(`${where}.path must start with / and have no spaces, query string or #.`);
    }
    if (children !== undefined) {
      if (nested) {
        problems.push(`${where} is a sub-page; pages nest one level deep.`);
      } else if (!Array.isArray(children) || children.length > MAX_PAGES) {
        problems.push(`${where}.children must be a list of up to ${MAX_PAGES} pages.`);
      } else {
        children.forEach((child, index) => check(child, `${where}.children[${index}]`, true));
      }
    }
  };

  pages.forEach((page, index) => check(page, `dashboard.pages[${index}]`, false));

  const repeated = [...new Set(slugs.filter((slug, index) => slugs.indexOf(slug) !== index))];

  if (repeated.length > 0) {
    problems.push(`Each slug must be unique; repeated: ${repeated.join(', ')}.`);
  }

  return problems;
}
