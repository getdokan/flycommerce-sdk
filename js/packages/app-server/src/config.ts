import fs from 'node:fs';
import { CredentialStore, FileCredentialStore } from './credentials.js';

export interface AppServerConfig {
  /** The app id from the developer portal: the `aud` of every session token and half of the install exchange. */
  appId: string;
  appSecret: string;
  /** FlyCommerce's API, e.g. https://app.flycommerce.com/api */
  hubApiUrl: string;
  /** Exactly as registered in the developer portal; FlyCommerce compares it byte for byte. */
  redirectUri: string;
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
  const hubOrigin = new URL(hubApiUrl).origin;

  return {
    appId: required(env, 'APP_ID'),
    appSecret: required(env, 'APP_SECRET'),
    hubApiUrl,
    redirectUri: required(env, 'REDIRECT_URI'),
    jwksUrl: env.JWKS_URL ?? `${hubOrigin}/.well-known/jwks.json`,
    // FlyCommerce signs session tokens with its own origin as the issuer.
    allowedIssuers: list(env.ALLOWED_ISSUERS, [hubOrigin]),
    frameAncestors: list(env.FRAME_ANCESTORS, ['https://*.flycommerce.com', 'https://*.flycom.shop']),
    credentials: new FileCredentialStore(env.CREDENTIALS_FILE ?? 'data/credentials.json'),
    // A local setup has no routing for https://{store}; send every store's calls to one local store instead.
    storeUrl: env.STORE_BASE_URL ? () => env.STORE_BASE_URL!.replace(/\/+$/, '') : undefined,
  };
}
