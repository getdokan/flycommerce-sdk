import crypto from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './http.js';

export interface OAuthProvider {
  /** Names the begin path and the browser cookie, e.g. "mailchimp". */
  name: string;
  /** Shown to the merchant in messages, e.g. "Mailchimp". */
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Exactly as registered with the provider. The flow begins on this origin, so the cookie it sets comes back. */
  redirectUri: string;
  scopes?: string[];
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Null when the provider issues tokens that do not expire. */
  expiresAt: string | null;
  scope: string | null;
}

/** The merchant chose not to grant access on the provider's page. */
export class OAuthDeniedError extends Error {}

interface Pending {
  store: string;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;

const randomId = () => crypto.randomBytes(32).toString('base64url');

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');

    if (key === name) {
      return rest.join('=') || null;
    }
  }

  return null;
}

/** Authorization-code sign-in in its own tab; the cookie, not `state`, binds the return to the browser that began it. */
export class OAuthFlows {
  private readonly tickets = new Map<string, Pending>();
  private readonly flows = new Map<string, Pending>();

  constructor(
    readonly provider: OAuthProvider,
    private readonly now: () => number = () => Date.now()
  ) {}

  get beginPath(): string {
    return `/auth/${this.provider.name}/begin`;
  }

  get callbackPath(): string {
    return new URL(this.provider.redirectUri).pathname;
  }

  private get cookieName(): string {
    return `flycom_oauth_${this.provider.name}`;
  }

  issueTicket(store: string): { beginUrl: string; expiresAt: string } {
    this.sweep();

    const id = randomId();
    const expiresAt = this.now() + TTL_MS;
    this.tickets.set(id, { store, expiresAt });

    const url = new URL(this.beginPath, this.provider.redirectUri);
    url.searchParams.set('ticket', id);

    return { beginUrl: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
  }

  begin(url: URL, res: ServerResponse): void {
    this.sweep();

    const id = url.searchParams.get('ticket') ?? '';
    const ticket = this.tickets.get(id);
    this.tickets.delete(id);

    if (!ticket || ticket.expiresAt <= this.now()) {
      throw new HttpError(
        400,
        'oauth_link_expired',
        'This link has expired or was already used. Go back to your dashboard and click Connect again.'
      );
    }

    const state = randomId();
    this.flows.set(state, { store: ticket.store, expiresAt: this.now() + TTL_MS });

    const authorize = new URL(this.provider.authorizeUrl);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', this.provider.clientId);
    authorize.searchParams.set('redirect_uri', this.provider.redirectUri);
    authorize.searchParams.set('state', state);

    if (this.provider.scopes?.length) {
      authorize.searchParams.set('scope', this.provider.scopes.join(' '));
    }

    res.writeHead(302, {
      Location: authorize.toString(),
      'Set-Cookie': this.cookie(state, TTL_MS / 1000),
      'Cache-Control': 'no-store',
      // The ticket is in this URL; the provider has no need to see it.
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
  }

  async complete(req: IncomingMessage, url: URL, res: ServerResponse): Promise<{ store: string; tokens: OAuthTokens }> {
    const marker = cookieValue(req, this.cookieName);
    const flow = marker ? this.flows.get(marker) : undefined;

    // Spent before anything can fail, so a refreshed or replayed callback cannot finish twice.
    if (marker) {
      this.flows.delete(marker);
    }
    res.setHeader('Set-Cookie', this.cookie('', 0));

    const echoed = url.searchParams.get('state');

    // state is required: without it, a callback carrying someone else's code would link their account to this store.
    if (!marker || !flow || flow.expiresAt <= this.now() || echoed === null || !sameSecret(echoed, marker)) {
      throw new HttpError(
        400,
        'oauth_flow_invalid',
        `This ${this.provider.label} sign-in did not start in this browser, or took too long. Go back to your dashboard and click Connect again.`
      );
    }

    if (url.searchParams.get('error')) {
      throw new OAuthDeniedError(url.searchParams.get('error_description') || url.searchParams.get('error') || 'access_denied');
    }

    const code = url.searchParams.get('code');

    if (!code) {
      throw new HttpError(400, 'oauth_code_missing', `${this.provider.label} did not send an authorization code. Try connecting again.`);
    }

    return { store: flow.store, tokens: await this.exchange(code) };
  }

  private async exchange(code: string): Promise<OAuthTokens> {
    let response: Response;

    try {
      // Form-encoded, as the OAuth 2.0 token endpoint is specified; JSON is not accepted everywhere.
      response = await fetch(this.provider.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.provider.clientId,
          client_secret: this.provider.clientSecret,
          redirect_uri: this.provider.redirectUri,
          code,
        }),
        signal: AbortSignal.timeout(10 * 1000),
      });
    } catch {
      throw new HttpError(502, 'oauth_unreachable', `${this.provider.label} could not be reached. Try connecting again.`);
    }

    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok || typeof body.access_token !== 'string' || !body.access_token) {
      throw new HttpError(502, 'oauth_exchange_failed', `${this.provider.label} did not accept the authorization. Try connecting again.`);
    }

    const expiresIn = Number(body.expires_in);

    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(this.now() + expiresIn * 1000).toISOString() : null,
      scope: typeof body.scope === 'string' ? body.scope : null,
    };
  }

  private cookie(value: string, maxAgeSeconds: number): string {
    const secure = new URL(this.provider.redirectUri).protocol === 'https:' ? '; Secure' : '';

    // Lax is what lets it ride along on the provider's top-level redirect back to us.
    return `${this.cookieName}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure}`;
  }

  private sweep(): void {
    const now = this.now();

    for (const pending of [this.tickets, this.flows]) {
      for (const [id, entry] of pending) {
        if (entry.expiresAt <= now) {
          pending.delete(id);
        }
      }
    }
  }
}
