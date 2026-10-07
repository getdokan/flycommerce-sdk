import fs from 'node:fs';
import { CredentialStore, FileCredentialStore } from './credentials.js';

/** appUrl without trailing slashes; a loop, since a regex here is slow on many slashes. */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/** Where every region's session tokens are verified: the issuer they name and the keys that sign them. */
export const FLYCOMMERCE_ORIGIN = 'https://app.flycommerce.com';

export interface AppServerConfig {
  /** The app id from the developer portal: the `aud` of every session token and half of the install exchange. */
  appId: string;
  appSecret: string;
  /** FlyCommerce's API, e.g. https://developers.flycommerce.com/api */
  hubApiUrl: string;
  /** Exactly as registered in the developer portal; FlyCommerce compares it byte for byte. */
  redirectUri: string;
  /** Where the app is served, from APP_URL; `flycommerce app dev` sets it to the tunnel. */
  appUrl?: string;
  jwksUrl: string;
  allowedIssuers: string[];
  frameAncestors: string[];
  credentials: CredentialStore;
  storeUrl?: (store: string) => string;
}

/** Loads `.env` from the working directory when there is one. Variables already set, as a deploy sets them, win. */
export function loadEnvFile(file = '.env'): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function list(value: string | undefined, fallback: string[]): string[] {
  return value ? value.split(/[\s,]+/).filter(Boolean) : fallback;
}

export function appServerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AppServerConfig {
  const hubApiUrl = required(env, 'HUB_API_URL');
  const appUrl = env.APP_URL ? withoutTrailingSlashes(env.APP_URL) : undefined;

  if (!env.REDIRECT_URI && !appUrl) {
    throw new Error('REDIRECT_URI is required, or APP_URL to use APP_URL/auth/callback.');
  }

  return {
    appId: required(env, 'APP_ID'),
    appSecret: required(env, 'APP_SECRET'),
    hubApiUrl,
    redirectUri: env.REDIRECT_URI || `${appUrl}/auth/callback`,
    appUrl,
    // Fixed rather than taken from HUB_API_URL: the API answers on more than one host, the issuer on one.
    jwksUrl: env.JWKS_URL ?? `${FLYCOMMERCE_ORIGIN}/.well-known/jwks.json`,
    allowedIssuers: list(env.ALLOWED_ISSUERS, [FLYCOMMERCE_ORIGIN]),
    frameAncestors: list(env.FRAME_ANCESTORS, ['https://*.flycommerce.com', 'https://*.flycom.shop']),
    credentials: new FileCredentialStore(env.CREDENTIALS_FILE ?? 'data/credentials.json'),
    // Local development only: every store's calls, tokens included, go to this one host.
    storeUrl: env.STORE_BASE_URL ? () => withoutTrailingSlashes(env.STORE_BASE_URL!) : undefined,
  };
}
