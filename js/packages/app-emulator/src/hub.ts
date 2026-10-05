import crypto from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionTokenPayload } from '@flycommerce/app-bridge';
import { RunningServer, readJsonBody, sendJson, serve } from './net.js';

export interface RegisteredApp {
  appId: string;
  appSecret: string;
  /** The install redirect registered in the developer portal. */
  redirectUri: string;
}

export interface Installation {
  appId: string;
  store: string;
  marketplaceId: number;
  installationId: number;
  scopes: string[];
  clientId: string;
  clientSecret: string;
  active: boolean;
}

export interface AccessGrant {
  appId: string;
  store: string;
  scopes: string[];
  /** Set for a user access token: the user the app acts for. */
  user?: { id: string; role: string; sid: string };
}

export interface SessionTokenOptions {
  appId: string;
  store: string;
  userId?: string;
  /** The user's role: `owner` or `admin` today; see spec/session-token.md. */
  role?: string;
  ttlSeconds?: number;
  /** Which dashboard login the token was issued under; logout() with the same id ends user access tokens from it. */
  loginId?: string;
}

const ACCESS_TOKEN_TTL_SECONDS = 900;
const SESSION_TOKEN_TTL_SECONDS = 60;
const KEY_ID = 'fake-hub-1';

const randomToken = (prefix: string) => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;

/** FlyCommerce as an app sees it: public keys, install codes, store credentials, and session tokens signed the same way. */
export class FakeHub {
  private readonly keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly apps = new Map<string, RegisteredApp>();
  private readonly installations: Installation[] = [];
  private readonly codes = new Map<string, Installation>();
  private readonly accessTokens = new Map<string, { installation: Installation; expiresAt: number; user?: AccessGrant['user'] }>();
  private readonly endedLogins = new Set<string>();
  private server: RunningServer | null = null;
  private nextMarketplaceId = 100;

  private constructor(apps: RegisteredApp[]) {
    for (const app of apps) this.apps.set(app.appId, app);
  }

  static async start(options: { apps: RegisteredApp[]; port?: number }): Promise<FakeHub> {
    const hub = new FakeHub(options.apps);
    hub.server = await serve((req, res, url) => hub.route(req, res, url), options.port);
    return hub;
  }

  get url(): string {
    return this.requireServer().url;
  }

  /** What an app puts in HUB_API_URL. */
  get apiUrl(): string {
    return `${this.url}/api`;
  }

  get jwksUrl(): string {
    return `${this.url}/.well-known/jwks.json`;
  }

  /** The `iss` of every session token; stands in for https://app.flycommerce.com, which every region's tokens name. */
  get issuer(): string {
    return this.url;
  }

  /** A merchant approving the app: returns the install redirect, carrying the one-time code the app trades for a credential. */
  install(appId: string, options: { store: string; scopes: string[] }): { code: string; callbackUrl: string; installation: Installation } {
    const app = this.requireApp(appId);
    const existing = this.installations.find((candidate) => candidate.appId === appId && candidate.store === options.store);

    const installation: Installation = existing ?? {
      appId,
      store: options.store,
      marketplaceId: this.nextMarketplaceId++,
      installationId: this.installations.length + 1,
      scopes: [],
      clientId: '',
      clientSecret: '',
      active: true,
    };

    // Reinstalling re-consents: a fresh credential, and the old one stops working.
    this.revokeTokens(installation);
    Object.assign(installation, {
      scopes: [...options.scopes],
      clientId: randomToken('ci'),
      clientSecret: randomToken('cs'),
      active: true,
    });

    if (!existing) this.installations.push(installation);

    const code = randomToken('code');
    this.codes.set(code, installation);

    const callbackUrl = new URL(app.redirectUri);
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('store', options.store);

    return { code, callbackUrl: callbackUrl.toString(), installation };
  }

  /** The platform never tells an app it was removed; it just stops accepting the app's credential. */
  uninstall(appId: string, store: string): void {
    const installation = this.findInstallation(appId, store);

    if (installation) {
      installation.active = false;
      this.revokeTokens(installation);
    }
  }

  findInstallation(appId: string, store: string): Installation | undefined {
    return this.installations.find((candidate) => candidate.appId === appId && candidate.store === store);
  }

  /** The user logs out of the dashboard: user access tokens issued under that login stop working. */
  logout(options: Pick<SessionTokenOptions, 'store' | 'userId' | 'loginId'>): void {
    this.endedLogins.add(this.sessionRef(options));
  }

  sessionToken(options: SessionTokenOptions): string {
    const installation = this.findInstallation(options.appId, options.store);
    const now = Math.floor(Date.now() / 1000);

    const payload: SessionTokenPayload = {
      iss: this.issuer,
      aud: options.appId,
      sub: options.userId ?? '1',
      typ: 'session',
      marketplace_id: installation?.marketplaceId ?? 0,
      store_domain: options.store,
      user_role: options.role ?? 'admin',
      app_id: options.appId,
      installation_id: installation?.installationId ?? 0,
      iat: now,
      nbf: now,
      exp: now + (options.ttlSeconds ?? SESSION_TOKEN_TTL_SECONDS),
      jti: crypto.randomUUID(),
      sid: this.sessionRef(options),
    };

    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const signingInput = `${encode({ alg: 'RS256', typ: 'JWT', kid: KEY_ID })}.${encode(payload)}`;
    const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(this.keys.privateKey).toString('base64url');

    return `${signingInput}.${signature}`;
  }

  /** For the fake store: which installation an access token belongs to, if it is still good. */
  verifyAccessToken(token: string): AccessGrant | null {
    const entry = this.accessTokens.get(token);

    if (!entry || entry.expiresAt <= Date.now() || !entry.installation.active) {
      return null;
    }

    if (entry.user && this.endedLogins.has(entry.user.sid)) {
      return null;
    }

    return { appId: entry.installation.appId, store: entry.installation.store, scopes: entry.installation.scopes, user: entry.user };
  }

  async close(): Promise<void> {
    await this.server?.close();
    this.server = null;
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
      const jwk = this.keys.publicKey.export({ format: 'jwk' });
      return sendJson(res, 200, { keys: [{ ...jwk, kid: KEY_ID, alg: 'RS256', use: 'sig' }] });
    }

    if (req.method === 'POST' && url.pathname === '/api/oauth/token') {
      return this.token(await readJsonBody<Record<string, string>>(req), res);
    }

    sendJson(res, 404, { error: 'not_found' });
  }

  private token(body: Record<string, string>, res: ServerResponse): void {
    if (body.grant_type === 'authorization_code') {
      const app = this.apps.get(body.app_id);
      const installation = this.codes.get(body.code);

      if (!app || app.appSecret !== body.app_secret) {
        return sendJson(res, 401, { error: 'invalid_client' });
      }

      if (!installation || installation.appId !== app.appId || body.redirect_uri !== app.redirectUri) {
        return sendJson(res, 400, { error: 'invalid_grant' });
      }

      this.codes.delete(body.code);

      return sendJson(res, 200, {
        store: installation.store,
        app_id: installation.clientId,
        app_secret: installation.clientSecret,
        scope: installation.scopes.join(' '),
      });
    }

    if (body.grant_type === 'client_credentials') {
      const installation = this.installations.find(
        (candidate) => candidate.clientId === body.app_id && candidate.clientSecret === body.app_secret
      );

      if (!installation || !installation.active) {
        return sendJson(res, 401, { error: 'invalid_client' });
      }

      const token = randomToken('at');
      this.accessTokens.set(token, { installation, expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000 });

      return sendJson(res, 200, {
        access_token: token,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        store: installation.store,
        scope: installation.scopes.join(' '),
      });
    }

    sendJson(res, 400, { error: 'unsupported_grant_type' });
  }

  /**
   * What the store does at POST /api/v1/apps/token: a session token it signed, for an app still installed and a login
   * still open, becomes 15 minutes of access as that user. FlyCommerce is not involved.
   */
  exchangeSessionToken(sessionToken: string): { access_token: string; expires_in: number; scope: string } | null {
    const claims = this.verifySessionToken(sessionToken);
    const installation = claims ? this.findInstallation(claims.aud, claims.store_domain ?? '') : undefined;

    if (
      !claims ||
      !installation ||
      !installation.active ||
      claims.installation_id !== installation.installationId ||
      typeof claims.sid !== 'string' ||
      this.endedLogins.has(claims.sid)
    ) {
      return null;
    }

    const token = randomToken('uat');
    const user = { id: claims.sub, role: claims.user_role, sid: claims.sid };
    this.accessTokens.set(token, { installation, user, expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000 });

    return { access_token: token, expires_in: ACCESS_TOKEN_TTL_SECONDS, scope: installation.scopes.join(' ') };
  }

  private verifySessionToken(token: string): SessionTokenPayload | null {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) return null;

    const valid = crypto
      .createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(this.keys.publicKey, Buffer.from(signature, 'base64url'));
    if (!valid) return null;

    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as SessionTokenPayload;
    return claims.typ === 'session' && claims.exp > Math.floor(Date.now() / 1000) ? claims : null;
  }

  private sessionRef(options: Pick<SessionTokenOptions, 'store' | 'userId' | 'loginId'>): string {
    return crypto
      .createHash('sha256')
      .update(options.loginId ?? `login:${options.store}:${options.userId ?? '1'}`)
      .digest('hex');
  }

  private revokeTokens(installation: Installation): void {
    for (const [token, entry] of this.accessTokens) {
      if (entry.installation === installation) this.accessTokens.delete(token);
    }
  }

  private requireApp(appId: string): RegisteredApp {
    const app = this.apps.get(appId);
    if (!app) throw new Error(`FakeHub has no app registered as ${appId}.`);
    return app;
  }

  private requireServer(): RunningServer {
    if (!this.server) throw new Error('FakeHub is not running; use FakeHub.start().');
    return this.server;
  }
}
