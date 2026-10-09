import crypto from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './http.js';
import { Sealer } from './sealer.js';

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

/** Remembers spent tickets. Shared by several instances, `spend` must be atomic, like Redis `SET key 1 NX PXAT expiresAt`. */
export interface OAuthNonceStore {
  /** True the first time `nonce` is spent; keep it until `expiresAt`, in milliseconds since the epoch. */
  spend(nonce: string, expiresAt: number): boolean | Promise<boolean>;
}

export interface OAuthFlowsOptions {
  /** At least 32 bytes, known only to your app and the same on every instance. Without it, only the instance that issued a ticket can finish it. */
  secret?: string;
  /** In memory by default, which holds per instance: share one store between instances that share a `secret`. */
  nonces?: OAuthNonceStore;
  now?: () => number;
}

interface Ticket {
  store: string;
  expiresAt: number;
  id: string;
}

interface Flow {
  store: string;
  expiresAt: number;
  ticket: string;
  ticketExpiresAt: number;
  browser: string;
}

const TTL_MS = 10 * 60 * 1000;

const randomId = () => crypto.randomBytes(32).toString('base64url');

const digest = (value: string) => crypto.createHash('sha256').update(value).digest('base64url');

class MemoryNonceStore implements OAuthNonceStore {
  private readonly spent = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  spend(nonce: string, expiresAt: number): boolean {
    const now = this.now();

    for (const [id, until] of this.spent) {
      if (until <= now) {
        this.spent.delete(id);
      }
    }

    if (this.spent.has(nonce)) {
      return false;
    }
    this.spent.set(nonce, expiresAt);

    return true;
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
  private readonly now: () => number;
  private readonly nonces: OAuthNonceStore;
  private readonly tickets: Sealer;
  private readonly states: Sealer;

  constructor(
    readonly provider: OAuthProvider,
    options: OAuthFlowsOptions | (() => number) = {}
  ) {
    const { secret, nonces, now }: OAuthFlowsOptions = typeof options === 'function' ? { now: options } : options;

    if (secret !== undefined && Buffer.byteLength(secret) < 32) {
      throw new Error('The OAuthFlows secret must be at least 32 bytes.');
    }

    const ikm = secret ?? crypto.randomBytes(32);
    // Separate keys per token and provider, so a ticket never opens as a state or as another provider's ticket.
    const key = (purpose: string) =>
      new Sealer(
        Buffer.from(crypto.hkdfSync('sha256', ikm, 'flycommerce-oauth-flows', `${purpose}:${provider.name}`, 32)).toString('base64')
      );

    this.now = now ?? (() => Date.now());
    this.nonces = nonces ?? new MemoryNonceStore(this.now);
    this.tickets = key('ticket');
    this.states = key('state');
  }

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
    const expiresAt = this.now() + TTL_MS;
    const ticket: Ticket = { store, expiresAt, id: randomId() };

    const url = new URL(this.beginPath, this.provider.redirectUri);
    url.searchParams.set('ticket', this.tickets.seal(JSON.stringify(ticket)));

    return { beginUrl: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
  }

  begin(url: URL, res: ServerResponse): void {
    const ticket = this.read<Ticket>(this.tickets, url.searchParams.get('ticket'));

    if (!ticket || !(ticket.expiresAt > this.now())) {
      throw new HttpError(
        400,
        'oauth_link_expired',
        'This link has expired or was already used. Go back to your dashboard and click Connect again.'
      );
    }

    const browser = randomId();
    const flow: Flow = {
      store: ticket.store,
      expiresAt: this.now() + TTL_MS,
      ticket: ticket.id,
      ticketExpiresAt: ticket.expiresAt,
      browser: digest(browser),
    };
    const state = this.states.seal(JSON.stringify(flow));

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
      'Set-Cookie': this.cookie(browser, TTL_MS / 1000),
      'Cache-Control': 'no-store',
      // The ticket is in this URL; the provider has no need to see it.
      'Referrer-Policy': 'no-referrer',
    });
    res.end();
  }

  async complete(req: IncomingMessage, url: URL, res: ServerResponse): Promise<{ store: string; tokens: OAuthTokens }> {
    const browser = cookieValue(req, this.cookieName);
    res.setHeader('Set-Cookie', this.cookie('', 0));

    // state is required: without it, a callback carrying someone else's code would link their account to this store.
    const flow = this.read<Flow>(this.states, url.searchParams.get('state'));

    // The ticket is spent only once the browser matches, so a leaked state cannot spend the merchant's.
    if (
      !browser ||
      !flow ||
      !(flow.expiresAt > this.now()) ||
      !sameSecret(digest(browser), String(flow.browser)) ||
      !(await this.nonces.spend(flow.ticket, flow.ticketExpiresAt + TTL_MS))
    ) {
      throw new HttpError(
        400,
        'oauth_flow_invalid',
        `This ${this.provider.label} sign-in did not start in this browser, took too long, or was already used. Go back to your dashboard and click Connect again.`
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

  private read<T>(sealer: Sealer, sealed: string | null): T | null {
    try {
      return sealed ? (JSON.parse(sealer.open(sealed)) as T) : null;
    } catch {
      return null;
    }
  }
}
