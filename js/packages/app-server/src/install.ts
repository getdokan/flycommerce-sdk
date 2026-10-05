import type { ServerResponse } from 'node:http';
import { CredentialStore } from './credentials.js';
import { HubClient, HubError } from './hub.js';
import { HttpError, html } from './http.js';
import { connectedPage, noticePage } from './page.js';

/** Finishes an install redirect: trades the code for the store's credential and keeps it. Returns the store. */
export async function completeInstall(url: URL, hub: HubClient, credentials: CredentialStore): Promise<string> {
  const code = url.searchParams.get('code');

  if (!code) {
    throw new HttpError(400, 'missing_code');
  }

  let exchanged: Awaited<ReturnType<HubClient['exchangeCode']>>;

  try {
    exchanged = await hub.exchangeCode(code);
  } catch (error) {
    const reason =
      error instanceof HubError ? `FlyCommerce refused the install code (${error.status})` : 'FlyCommerce could not be reached';
    throw new HttpError(502, 'install_exchange_failed', `Could not finish installing: ${reason}.`);
  }

  credentials.put(exchanged.store, exchanged.credential);
  hub.forget(exchanged.store);

  return exchanged.store;
}

function originAllowed(pattern: string, target: URL): boolean {
  const match = /^(https?):\/\/(\*\.)?([^/:*]+)(?::(\d+))?$/.exec(pattern.trim());
  if (!match) return false;

  const [, protocol, wildcard, host, port] = match;
  const defaultPort = protocol === 'https' ? '443' : '80';

  if (target.protocol !== `${protocol}:` || (target.port || defaultPort) !== (port ?? defaultPort)) return false;

  // As in CSP, *.example.com covers subdomains only, not example.com itself.
  return wildcard ? target.hostname.endsWith(`.${host}`) : target.hostname === host;
}

/** The dashboard page to return to after installing, if `return_to` names one on a dashboard this app already lets frame it. */
export function installReturnUrl(url: URL, frameAncestors: string[]): string | null {
  const raw = url.searchParams.get('return_to');
  if (!raw) return null;

  let target: URL;

  try {
    target = new URL(raw);
  } catch {
    return null;
  }

  if (target.username || target.password || !target.pathname.startsWith('/admin/apps/')) return null;

  return frameAncestors.some((pattern) => originAllowed(pattern, target)) ? target.toString() : null;
}

export interface InstallOptions {
  hub: HubClient;
  credentials: CredentialStore;
  frameAncestors: string[];
  appName: string;
  /** Runs after the credential is kept and before the merchant is sent back, e.g. to subscribe to webhooks. */
  onInstalled?: (store: string) => Promise<void>;
}

/** The whole install redirect: exchange the code, then land the merchant on the app's page in the dashboard they came from. */
export async function handleInstall(url: URL, res: ServerResponse, options: InstallOptions): Promise<string | null> {
  const landing = installReturnUrl(url, options.frameAncestors);
  let store: string;

  try {
    store = await completeInstall(url, options.hub, options.credentials);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;

    const back = landing ? { label: 'Back to your dashboard', href: landing } : undefined;
    html(res, noticePage(`${options.appName} could not finish installing`, error.message, back), undefined, error.status);
    return null;
  }

  if (options.onInstalled) {
    try {
      await options.onInstalled(store);
    } catch (error) {
      // The install itself succeeded; the app's own reconcile on startup finishes the setup.
      console.error('[install] onInstalled failed', error);
    }
  }

  if (landing) {
    // The code is in this URL; the dashboard has no need to see it in a Referer.
    res.writeHead(302, { Location: landing, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  } else {
    html(res, connectedPage(options.appName, store));
  }

  return store;
}
