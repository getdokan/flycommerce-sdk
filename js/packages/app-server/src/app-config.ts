import fs from 'node:fs';

/** appUrl without trailing slashes; a loop, since a regex here is slow on many slashes. */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

export interface AppConfigPage {
  slug: string;
  label: string;
  path: string;
  children?: AppConfigPage[];
}

/** interactive: once the page can be used. idle: when the browser is idle after the page has loaded. */
export type ScriptLoad = 'interactive' | 'idle';

/** A script the store adds to its catalogue pages. It runs with the page's full access, so it's reviewed with the version. */
export interface AppConfigScript {
  /** Lower-case letters, numbers and -, up to 40 characters, unique within the app. */
  handle: string;
  /** A path on appUrl, like /storefront/chat.js, or an https URL on the same host as appUrl. */
  src: string;
  /** Defaults to idle. */
  load?: ScriptLoad;
}

export interface AppConfigInstall {
  /** Where installs are sent back to: a path on appUrl, like /auth/callback, or a URL on the same host. */
  redirectUrl?: string;
}

/** app-config.json: the app's dashboard pages, storefront scripts and install redirect, and the version this code is. */
export interface AppConfig {
  appId: string;
  /** Filled in by the CLI on release; without it, an upload releases the version waiting to be released. */
  versionId?: number;
  version?: string;
  quote?: string;
  appUrl: string;
  install?: AppConfigInstall;
  dashboard: { pages: AppConfigPage[] };
  storefront?: { scripts: AppConfigScript[] };
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

const KEYS = ['appId', 'versionId', 'version', 'quote', 'appUrl', 'install', 'dashboard', 'storefront'];
const MAX_PAGES = 20;
const SLUG = /^[A-Za-z0-9_-]{1,100}$/;
const PATH = /^\/[^\s?#]*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_SCRIPTS = 3;
const HANDLE = /^[a-z0-9-]{1,40}$/;
const LOADS: ScriptLoad[] = ['interactive', 'idle'];
// FlyCommerce keeps the redirect URL, joined to appUrl, in 255 characters.
const MAX_REDIRECT_URL = 255;

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
  if (config.versionId !== undefined && (!Number.isInteger(config.versionId) || (config.versionId as number) < 1)) {
    problems.push('versionId must be a whole number from 1, like 12.');
  }
  if (config.version !== undefined && (typeof config.version !== 'string' || !VERSION.test(config.version))) {
    problems.push('version must be three numbers, like 1.11.0.');
  }
  if (config.quote !== undefined && config.quote !== null && (typeof config.quote !== 'string' || config.quote.length > 140)) {
    problems.push('quote must be text of up to 140 characters.');
  }
  problems.push(...checkAppUrl(config.appUrl));

  if (config.install !== undefined) {
    problems.push(...checkInstall(config.install, config.appUrl));
  }

  const dashboard = config.dashboard as { pages?: unknown } | undefined;

  if (typeof dashboard !== 'object' || dashboard === null || !Array.isArray(dashboard.pages)) {
    problems.push('dashboard.pages must be a list.');
  } else if (Object.keys(dashboard).some((key) => key !== 'pages')) {
    problems.push('dashboard takes only pages.');
  } else {
    problems.push(...checkPages(dashboard.pages));
  }

  if (config.storefront !== undefined) {
    problems.push(...checkStorefront(config.storefront, config.appUrl));
  }

  return problems;
}

/** The config with script srcs and the install redirect as URLs on appUrl (or the one given), as FlyCommerce stores them. */
export function resolveAppConfig(config: AppConfig, options: { appUrl?: string } = {}): AppConfig {
  const appUrl = options.appUrl ?? config.appUrl;
  const resolved: AppConfig = { ...config, appUrl };

  if (config.install?.redirectUrl !== undefined) {
    resolved.install = { ...config.install, redirectUrl: resolveOnAppUrl(config.install.redirectUrl, appUrl) };
  }
  if (config.storefront) {
    resolved.storefront = {
      ...config.storefront,
      scripts: config.storefront.scripts.map((script) => ({ ...script, src: resolveOnAppUrl(script.src, appUrl) })),
    };
  }

  return resolved;
}

// A path is appended to appUrl, as FlyCommerce does with page paths.
function resolveOnAppUrl(pathOrUrl: string, appUrl: string): string {
  return isPath(pathOrUrl) ? withoutTrailingSlashes(appUrl) + pathOrUrl : pathOrUrl;
}

/** The request paths an app must serve its dashboard page on: every page and sub-page. */
export function pagePaths(config: AppConfig): string[] {
  return config.dashboard.pages.flatMap((page) => [page.path, ...(page.children ?? []).map((child) => child.path)]);
}

function isLocal(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.test');
}

function checkAppUrl(value: unknown): string[] {
  if (typeof value !== 'string') {
    return ['appUrl is required, like https://app.example.com.'];
  }

  try {
    const url = new URL(value);
    const local = isLocal(url);

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

function appHostOf(appUrl: unknown): string | null {
  try {
    return typeof appUrl === 'string' ? new URL(appUrl).hostname : null;
  } catch {
    // checkAppUrl reports it.
    return null;
  }
}

function isPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}

function checkInstall(install: unknown, appUrl: unknown): string[] {
  if (typeof install !== 'object' || install === null || Array.isArray(install)) {
    return ['install must be an object, like { "redirectUrl": "/auth/callback" }.'];
  }

  const { redirectUrl, ...rest } = install as Record<string, unknown>;
  const problems: string[] = [];

  if (Object.keys(rest).length > 0) {
    problems.push(`install takes only redirectUrl; it does not take ${Object.keys(rest).join(', ')}.`);
  }
  if (redirectUrl === undefined) {
    return problems;
  }

  const urlProblems = checkUrlOnApp(redirectUrl, appHostOf(appUrl), 'install.redirectUrl');

  if (urlProblems.length > 0 || typeof appUrl !== 'string') {
    return [...problems, ...urlProblems];
  }

  // The code exchange compares it byte for byte, so it is kept exactly as written, in ASCII.
  const joined = resolveOnAppUrl(redirectUrl as string, appUrl);
  const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(joined)?.[1] ?? '';

  if (/[^\x00-\x7f]/.test(host)) {
    problems.push('install.redirectUrl must have an ASCII host; write an international domain in its xn-- form.');
  }
  if (joined.length > MAX_REDIRECT_URL) {
    problems.push(`install.redirectUrl is at most ${MAX_REDIRECT_URL} characters once joined to appUrl.`);
  }

  return problems;
}

function checkStorefront(storefront: unknown, appUrl: unknown): string[] {
  if (typeof storefront !== 'object' || storefront === null || Array.isArray(storefront)) {
    return ['storefront must be an object, like { "scripts": [ … ] }.'];
  }

  const { scripts, ...rest } = storefront as Record<string, unknown>;
  const problems: string[] = [];

  if (Object.keys(rest).length > 0) {
    problems.push(`storefront takes only scripts; it does not take ${Object.keys(rest).join(', ')}.`);
  }
  if (!Array.isArray(scripts) || scripts.length > MAX_SCRIPTS) {
    problems.push(`storefront.scripts must be a list of up to ${MAX_SCRIPTS} scripts.`);
    return problems;
  }

  const appHost = appHostOf(appUrl);
  const handles: string[] = [];

  scripts.forEach((script, index) => {
    const where = `storefront.scripts[${index}]`;

    if (typeof script !== 'object' || script === null || Array.isArray(script)) {
      problems.push(`${where} must be an object.`);
      return;
    }

    const { handle, src, load, ...others } = script as Record<string, unknown>;

    if (Object.keys(others).length > 0) {
      problems.push(`${where} does not take ${Object.keys(others).join(', ')}.`);
    }
    if (typeof handle !== 'string' || !HANDLE.test(handle)) {
      problems.push(`${where}.handle must be lower-case letters, numbers and -, up to 40 characters.`);
    } else {
      handles.push(handle);
    }
    problems.push(...checkUrlOnApp(src, appHost, `${where}.src`));
    if (load !== undefined && !LOADS.includes(load as ScriptLoad)) {
      problems.push(`${where}.load must be ${LOADS.join(' or ')}.`);
    }
  });

  const repeated = [...new Set(handles.filter((handle, index) => handles.indexOf(handle) !== index))];

  if (repeated.length > 0) {
    problems.push(`Each script handle must be unique; repeated: ${repeated.join(', ')}.`);
  }

  return problems;
}

/** A path on appUrl, or an absolute URL on its host: script srcs and the install redirect. */
function checkUrlOnApp(value: unknown, appHost: string | null, where: string): string[] {
  if (typeof value !== 'string' || value === '' || value.length > 2000) {
    return [`${where} must be a path or a URL of up to 2000 characters.`];
  }
  // URL() would turn \ into /, so the hub and the browser could disagree on the host.
  if (value.includes('\\')) {
    return [`${where} must not contain \\.`];
  }
  if (value.includes('#')) {
    return [`${where} must not have a #.`];
  }
  if (value.startsWith('//')) {
    return [`${where} must be a path starting with a single /, or a full URL.`];
  }
  if (value.startsWith('/')) {
    return /\s/.test(value) ? [`${where} must not contain spaces.`] : [];
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [`${where} is not a URL or a path starting with /: ${value}`];
  }

  if (url.protocol !== 'https:' && !(isLocal(url) && url.protocol === 'http:')) {
    return [`${where} must use https (http only for localhost).`];
  }
  if (url.username !== '' || url.password !== '') {
    return [`${where} must not contain a user name or password.`];
  }
  if (appHost !== null && url.hostname !== appHost) {
    return [`${where} must be on ${appHost}, the host in appUrl.`];
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
