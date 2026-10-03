import crypto from 'node:crypto';
import { SessionTokenPayload } from './types.js';

export interface VerifySessionTokenOptions {
  appId: string;
  jwksUrl?: string;
  /** Defaults to the JWKS URL's origin: FlyCommerce signs with the origin it serves its keys from. */
  allowedIssuers?: string[];
  clockToleranceSeconds?: number;
}

interface JwkKey {
  kty: string;
  kid?: string;
  n: string;
  e: string;
  use?: string;
  alg?: string;
}

const DEFAULT_JWKS_URL = 'https://app.flycommerce.com/.well-known/jwks.json';
const JWKS_CACHE_TTL_MS = 3600 * 1000;
// An unknown kid may follow a key rotation, so refetch then — but not for every forged kid.
const JWKS_REFETCH_INTERVAL_MS = 30 * 1000;
const JWKS_TIMEOUT_MS = 5 * 1000;

const jwksCache = new Map<string, { keys: JwkKey[]; fetchedAt: number; refetchedAt: number }>();

function base64UrlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf8');
}

async function loadJwks(url: string, refetch = false): Promise<JwkKey[]> {
  const now = Date.now();
  const cached = jwksCache.get(url);

  if (cached && !refetch && now - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }

  if (cached && refetch && now - cached.refetchedAt < JWKS_REFETCH_INTERVAL_MS) {
    return cached.keys;
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Failed to fetch JWKS from ${url}: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { keys?: JwkKey[] };
  if (!data || !Array.isArray(data.keys)) {
    throw new Error('Invalid JWKS response structure: keys array missing.');
  }

  jwksCache.set(url, { keys: data.keys, fetchedAt: now, refetchedAt: refetch ? now : (cached?.refetchedAt ?? 0) });

  return data.keys;
}

function findKey(all: JwkKey[], kid: string | undefined): JwkKey | undefined {
  // Only RSA keys meant for signatures; anything else in the set is not ours to verify with.
  const keys = all.filter(
    (key) => key.kty === 'RSA' && (key.use === undefined || key.use === 'sig') && (key.alg === undefined || key.alg === 'RS256')
  );

  if (kid) {
    return keys.find((key) => key.kid === kid);
  }

  return keys.length === 1 ? keys[0] : undefined;
}

/**
 * Verifies an RS256 session token issued by FlyCommerce: signature against its JWKS, then
 * expiry, not-before, token type, audience (your app id) and issuer.
 */
export async function verifySessionToken(token: string, options: VerifySessionTokenOptions): Promise<SessionTokenPayload> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT: must consist of header, payload, and signature.');
  }

  const [rawHeader, rawPayload, rawSignature] = parts;

  let header: { alg?: string; kid?: string; typ?: string };
  let payload: SessionTokenPayload;

  try {
    header = JSON.parse(base64UrlDecode(rawHeader));
    payload = JSON.parse(base64UrlDecode(rawPayload));
  } catch (err: any) {
    throw new Error(`Failed to parse JWT JSON: ${err.message}`);
  }

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported JWT algorithm: ${header.alg}. Expected RS256.`);
  }

  const jwksUrl = options.jwksUrl || DEFAULT_JWKS_URL;
  let key = findKey(await loadJwks(jwksUrl), header.kid);

  if (!key && header.kid) {
    key = findKey(await loadJwks(jwksUrl, true), header.kid);
  }

  if (!key) {
    throw new Error(`No matching public key found in JWKS for kid: ${header.kid || '(none)'}`);
  }

  const publicKey = crypto.createPublicKey({ key: key as any, format: 'jwk' });
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${rawHeader}.${rawPayload}`);

  if (!verifier.verify(publicKey, Buffer.from(rawSignature, 'base64url'))) {
    throw new Error('Invalid JWT signature.');
  }

  const now = Math.floor(Date.now() / 1000);
  const tolerance = options.clockToleranceSeconds ?? 5;

  if (typeof payload.exp !== 'number' || payload.exp < now - tolerance) {
    throw new Error(`Session token has expired at ${payload.exp}, current time is ${now}.`);
  }

  if (typeof payload.nbf === 'number' && payload.nbf > now + tolerance) {
    throw new Error(`Session token is not valid yet (nbf ${payload.nbf}, current time is ${now}).`);
  }

  if (payload.typ !== 'session') {
    throw new Error(`Invalid token type: ${payload.typ}. Expected 'session'.`);
  }

  if (payload.aud !== options.appId) {
    throw new Error(`Invalid token audience: ${payload.aud}. Expected ${options.appId}.`);
  }

  const allowedIssuers = options.allowedIssuers ?? [new URL(jwksUrl).origin];

  if (!payload.iss || !allowedIssuers.includes(payload.iss)) {
    throw new Error(`Untrusted or missing token issuer: ${payload.iss || '(none)'}.`);
  }

  return payload;
}

/**
 * Testing helper: forget every cached key set.
 */
export function clearJwksCache(): void {
  jwksCache.clear();
}
