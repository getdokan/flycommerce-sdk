import crypto from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { bearer, escapeHtml, readBody, sendHtml, sendJson } from './net.js';

export interface OAuthClientRegistration {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

export interface FakeAccount {
  id: string;
  name: string;
  email: string;
}

export interface ProviderGrant {
  account: FakeAccount;
  clientId: string;
  scopes: string[];
}

export interface FakeOAuthProviderOptions {
  clients: OAuthClientRegistration[];
  /** Offered on the consent page of a local run. */
  accounts?: FakeAccount[];
  accessTokenTtlSeconds?: number;
  /** Mount point of the three endpoints, e.g. "/oauth" gives /oauth/authorize, /oauth/token and /oauth/revoke. */
  basePath?: string;
  now?: () => number;
}

interface IssuedCode {
  grant: ProviderGrant;
  redirectUri: string;
  expiresAt: number;
}

interface IssuedToken {
  grant: ProviderGrant;
  expiresAt: number;
  refreshToken: string;
}

const CODE_TTL_MS = 60_000;
const DEFAULT_ACCOUNT: FakeAccount = { id: 'acct_1', name: 'Fake Account', email: 'owner@example.test' };

const randomToken = (prefix: string) => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;

/** An OAuth 2.0 authorization server to build a provider fake on: codes, rotating refresh tokens, revocation, consent page. */
export class FakeOAuthProvider {
  readonly basePath: string;
  private readonly clients = new Map<string, OAuthClientRegistration>();
  private readonly accounts: FakeAccount[];
  private readonly codes = new Map<string, IssuedCode>();
  private readonly accessTokens = new Map<string, IssuedToken>();
  private readonly refreshTokens = new Map<string, { grant: ProviderGrant }>();
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor(options: FakeOAuthProviderOptions) {
    for (const client of options.clients) this.clients.set(client.clientId, client);
    this.accounts = options.accounts?.length ? options.accounts : [DEFAULT_ACCOUNT];
    this.ttlSeconds = options.accessTokenTtlSeconds ?? 3600;
    this.basePath = (options.basePath ?? '/oauth').replace(/\/+$/, '');
    this.now = options.now ?? (() => Date.now());
  }

  /** Handles the provider's OAuth endpoints; returns false for any other path so the fake can route its API. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (req.method === 'GET' && url.pathname === `${this.basePath}/authorize`) {
      this.consentPage(res, url);
      return true;
    }

    if (req.method === 'GET' && url.pathname === `${this.basePath}/decide`) {
      this.decideFromPage(res, url);
      return true;
    }

    if (req.method === 'POST' && url.pathname === `${this.basePath}/token`) {
      this.token(res, new URLSearchParams(await readBody(req)));
      return true;
    }

    if (req.method === 'POST' && url.pathname === `${this.basePath}/revoke`) {
      this.revoke(res, new URLSearchParams(await readBody(req)));
      return true;
    }

    return false;
  }

  /** The merchant clicking Allow, without a browser: returns where the provider redirects them. */
  approve(authorizeUrl: string, account: FakeAccount = this.accounts[0]): string {
    const request = this.readAuthorizeRequest(new URL(authorizeUrl));
    const code = randomToken('code');

    this.codes.set(code, {
      grant: { account, clientId: request.clientId, scopes: request.scopes },
      redirectUri: request.redirectUri,
      expiresAt: this.now() + CODE_TTL_MS,
    });

    return this.redirect(request.redirectUri, { code, state: request.state });
  }

  deny(authorizeUrl: string): string {
    const request = this.readAuthorizeRequest(new URL(authorizeUrl));
    return this.redirect(request.redirectUri, { error: 'access_denied', state: request.state });
  }

  /** For the fake's API routes: the grant behind a bearer access token, or null. */
  authenticate(req: IncomingMessage): ProviderGrant | null {
    const token = bearer(req);
    const issued = token ? this.accessTokens.get(token) : undefined;

    return issued && issued.expiresAt > this.now() ? issued.grant : null;
  }

  /** Makes every access token stale, so the next API call has to refresh. */
  expireAccessTokens(): void {
    for (const issued of this.accessTokens.values()) issued.expiresAt = 0;
  }

  /** The account holder removing the app on the provider's side. */
  revokeAccount(accountId: string): void {
    for (const [token, issued] of this.accessTokens) {
      if (issued.grant.account.id === accountId) this.accessTokens.delete(token);
    }

    for (const [token, entry] of this.refreshTokens) {
      if (entry.grant.account.id === accountId) this.refreshTokens.delete(token);
    }
  }

  private readAuthorizeRequest(url: URL): { clientId: string; redirectUri: string; state: string | null; scopes: string[] } {
    const client = this.clients.get(url.searchParams.get('client_id') ?? '');
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';

    // Never redirect to an unregistered URI: that is how authorization codes are stolen.
    if (!client || !client.redirectUris.includes(redirectUri) || url.searchParams.get('response_type') !== 'code') {
      throw new Error('invalid_request: unknown client, unregistered redirect_uri, or response_type is not code');
    }

    return {
      clientId: client.clientId,
      redirectUri,
      state: url.searchParams.get('state'),
      scopes: (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean),
    };
  }

  private consentPage(res: ServerResponse, url: URL): void {
    let request: ReturnType<FakeOAuthProvider['readAuthorizeRequest']>;

    try {
      request = this.readAuthorizeRequest(url);
    } catch (error) {
      return sendHtml(res, 400, `<!doctype html><title>Invalid request</title><p>${escapeHtml((error as Error).message)}</p>`);
    }

    const decide = (params: Record<string, string>) => {
      const target = new URL(`${this.basePath}/decide`, 'http://fake');
      target.search = url.search;
      for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
      return `${target.pathname}${target.search}`;
    };

    const choices = this.accounts
      .map(
        (account) =>
          `<li><a class="allow" href="${escapeHtml(decide({ decision: 'allow', account: account.id }))}">Allow as ${escapeHtml(account.name)} <small>${escapeHtml(account.email)}</small></a></li>`
      )
      .join('');

    sendHtml(
      res,
      200,
      `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Authorize ${escapeHtml(request.clientId)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#f5f6f8;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;border:1px solid #e3e5ea;border-radius:12px;padding:28px;max-width:420px}
ul{list-style:none;padding:0}li{margin:8px 0}a{display:block;padding:10px 14px;border-radius:8px;text-decoration:none}
.allow{background:#1d4ed8;color:#fff}.deny{color:#b42318}small{display:block;opacity:.8}</style></head>
<body><main><h1>Example sign-in</h1>
<p><strong>${escapeHtml(request.clientId)}</strong> wants access${request.scopes.length ? ` to <code>${escapeHtml(request.scopes.join(' '))}</code>` : ''}.</p>
<ul>${choices}</ul><a class="deny" href="${escapeHtml(decide({ decision: 'deny' }))}">Deny</a></main></body></html>`
    );
  }

  private decideFromPage(res: ServerResponse, url: URL): void {
    const authorizeUrl = new URL(`${this.basePath}/authorize`, 'http://fake');
    authorizeUrl.search = url.search;

    const account = this.accounts.find((candidate) => candidate.id === url.searchParams.get('account')) ?? this.accounts[0];
    const location =
      url.searchParams.get('decision') === 'allow' ? this.approve(authorizeUrl.toString(), account) : this.deny(authorizeUrl.toString());

    res.writeHead(302, { Location: location });
    res.end();
  }

  private token(res: ServerResponse, form: URLSearchParams): void {
    const client = this.clients.get(form.get('client_id') ?? '');

    if (!client || client.clientSecret !== form.get('client_secret')) {
      return sendJson(res, 401, { error: 'invalid_client' });
    }

    if (form.get('grant_type') === 'authorization_code') {
      const code = form.get('code') ?? '';
      const issued = this.codes.get(code);
      this.codes.delete(code);

      if (
        !issued ||
        issued.expiresAt <= this.now() ||
        issued.grant.clientId !== client.clientId ||
        issued.redirectUri !== form.get('redirect_uri')
      ) {
        return sendJson(res, 400, { error: 'invalid_grant' });
      }

      return sendJson(res, 200, this.issue(issued.grant));
    }

    if (form.get('grant_type') === 'refresh_token') {
      const refreshToken = form.get('refresh_token') ?? '';
      const entry = this.refreshTokens.get(refreshToken);

      if (!entry || entry.grant.clientId !== client.clientId) {
        return sendJson(res, 400, { error: 'invalid_grant' });
      }

      // Rotation: a refresh token works once, so a leaked one is only good until the app next refreshes.
      this.refreshTokens.delete(refreshToken);
      return sendJson(res, 200, this.issue(entry.grant));
    }

    sendJson(res, 400, { error: 'unsupported_grant_type' });
  }

  private revoke(res: ServerResponse, form: URLSearchParams): void {
    const token = form.get('token') ?? '';
    const access = this.accessTokens.get(token);

    if (access) {
      this.accessTokens.delete(token);
      this.refreshTokens.delete(access.refreshToken);
    }

    this.refreshTokens.delete(token);
    // RFC 7009: revoking an unknown token is not an error.
    sendJson(res, 200, {});
  }

  private issue(grant: ProviderGrant): Record<string, unknown> {
    const accessToken = randomToken('at');
    const refreshToken = randomToken('rt');

    this.accessTokens.set(accessToken, { grant, expiresAt: this.now() + this.ttlSeconds * 1000, refreshToken });
    this.refreshTokens.set(refreshToken, { grant });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.ttlSeconds,
      refresh_token: refreshToken,
      scope: grant.scopes.join(' '),
    };
  }

  private redirect(redirectUri: string, params: Record<string, string | null>): string {
    const url = new URL(redirectUri);

    for (const [key, value] of Object.entries(params)) {
      if (value !== null) url.searchParams.set(key, value);
    }

    return url.toString();
  }
}
