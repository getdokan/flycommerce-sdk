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

interface TicketPayload {
  store: string;
  expiresAt: number;
  nonce: string;
}

interface FlowPayload {
  store: string;
  expiresAt: number;
  nonce: string;
}

const TTL_MS = 10 * 60 * 1000;

const randomId = () => crypto.randomBytes(32).toString('base64url');

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

function seal(payload: unknown, secret: string): string {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const json = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

function open<T = unknown>(sealed: string, secret: string): T | null {
  try {
    const parts = sealed.split('.');
    if (parts.length !== 3) return null;
    const [ivB64, tagB64, encB64] = parts;
    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    const encrypted = Buffer.from(encB64, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const key = deriveKey(secret);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');

    return JSON.parse(decrypted) as T;
  } catch {
    return null;
  }
}

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
  private readonly spentTickets = new Map<string, number>();
  private readonly spentFlows = new Map<string, number>();

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

    const nonce = randomId();
    const expiresAt = this.now() + TTL_MS;
    const ticket = seal({ store, expiresAt, nonce }, this.provider.clientSecret);

    const url = new URL(this.beginPath, this.provider.redirectUri);
    url.searchParams.set('ticket', ticket);

    return { beginUrl: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
  }

  begin(url: URL, res: ServerResponse): void {
    this.sweep();

    const rawTicket = url.searchParams.get('ticket') ?? '';
    const ticket = open<TicketPayload>(rawTicket, this.provider.clientSecret);

    if (!ticket || ticket.expiresAt <= this.now() || this.spentTickets.has(ticket.nonce)) {
      throw new HttpError(
        400,
        'oauth_link_expired',
        'This link has expired or was already used. Go back to your dashboard and click Connect again.'
      );
    }
    this.spentTickets.set(ticket.nonce, ticket.expiresAt);

    const state = seal({ store: ticket.store, expiresAt: this.now() + TTL_MS, nonce: randomId() }, this.provider.clientSecret);

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
    const echoed = url.searchParams.get('state');

    res.setHeader('Set-Cookie', this.cookie('', 0));

    // state is required: without it, a callback carrying someone else's code would link their account to this store.
    if (!marker || echoed === null || !sameSecret(echoed, marker)) {
      throw new HttpError(
        400,
        'oauth_flow_invalid',
        `This ${this.provider.label} sign-in did not start in this browser, or took too long. Go back to your dashboard and click Connect again.`
      );
    }

    const flow = open<FlowPayload>(marker, this.provider.clientSecret);

    if (!flow || flow.expiresAt <= this.now() || this.spentFlows.has(flow.nonce)) {
      throw new HttpError(
        400,
        'oauth_flow_invalid',
        `This ${this.provider.label} sign-in did not start in this browser, or took too long. Go back to your dashboard and click Connect again.`
      );
    }
    this.spentFlows.set(flow.nonce, flow.expiresAt);

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

    for (const pending of [this.spentTickets, this.spentFlows]) {
      for (const [nonce, expiresAt] of pending) {
        if (expiresAt <= now) {
          pending.delete(nonce);
        }
      }
    }
  }
}
