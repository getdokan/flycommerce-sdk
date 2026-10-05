import type { SessionTokenPayload } from '@flycommerce/app-bridge';
import { AppServerConfig } from './config.js';
import { HubClient, HubError } from './hub.js';
import { HttpError } from './http.js';

const STORE_TIMEOUT_MS = 15 * 1000;

type Query = Record<string, string | number | undefined>;

/** A store API failure that keeps the store's own status, so a caller can tell "already gone" from "not allowed". */
export class StoreApiError extends HttpError {
  constructor(
    status: number,
    code: string,
    message: string,
    readonly upstreamStatus: number
  ) {
    super(status, code, message);
  }
}

/** A verified dashboard request: what authenticate() returns. */
export interface DashboardSession {
  store: string;
  session: SessionTokenPayload;
  /** The raw session token, which asUser() trades at the store for access as that user. */
  token: string;
}

/** The store API for one store, acting as either the app or a user. */
export interface StoreClient {
  readonly store: string;
  /** `app`: the app's own permissions. `user`: only what both the app and that user may do. */
  readonly actingAs: 'app' | 'user';
  request<T>(method: string, path: string, options?: { query?: Query; body?: unknown }): Promise<T>;
  get<T>(path: string, query?: Query): Promise<T>;
  /** Every item of a paginated list endpoint, a page at a time. */
  paginate<T>(path: string, query?: Query, limit?: number): AsyncGenerator<T>;
}

type TokenSource = { kind: 'app' } | { kind: 'user'; dashboard: DashboardSession };

export class StoreApi {
  private readonly userTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly config: Pick<AppServerConfig, 'credentials' | 'storeUrl'>,
    private readonly hub: HubClient
  ) {}

  /** As the app: for webhooks, scheduled tasks and automations, where no user is acting. */
  asApp(store: string): StoreClient {
    return this.client(store, { kind: 'app' });
  }

  /** As the user of the page: the store allows only what both the app's scopes and the user's permissions allow, and records the user as the actor. */
  asUser(dashboard: DashboardSession): StoreClient {
    return this.client(dashboard.store, { kind: 'user', dashboard });
  }

  private client(store: string, source: TokenSource): StoreClient {
    const request = <T>(method: string, path: string, options: { query?: Query; body?: unknown } = {}) =>
      this.send<T>(store, source, method, path, options, false);

    return {
      store,
      actingAs: source.kind,
      request,
      get: <T>(path: string, query?: Query) => request<T>('GET', path, { query }),
      async *paginate<T>(path: string, query: Query = {}, limit = 50): AsyncGenerator<T> {
        for (let page = 1; ; page++) {
          // The store pages only with paginate=full; without it, `page` is ignored and this would repeat page one forever.
          const body = await request<{ data?: T[]; meta?: { lastPage?: number } }>('GET', path, {
            query: { ...query, paginate: 'full', limit, page },
          });
          const items = body.data ?? [];

          yield* items;

          if (items.length < limit || page >= (body.meta?.lastPage ?? page)) {
            return;
          }
        }
      },
    };
  }

  private async token(store: string, source: TokenSource): Promise<string> {
    return source.kind === 'app' ? this.appToken(store) : this.userToken(store, source.dashboard);
  }

  private async appToken(store: string): Promise<string> {
    const credential = this.config.credentials.get(store);

    if (!credential) {
      throw new HttpError(409, 'store_not_connected', 'Reinstall the app on this store to connect it.');
    }

    try {
      return await this.hub.accessToken(store, credential);
    } catch (error) {
      // The platform never notifies an app of an uninstall; a refused credential is how it finds out.
      if (error instanceof HubError && error.status === 401) {
        throw new HttpError(409, 'installation_revoked', 'This store has removed the app. Reinstall it to reconnect.');
      }

      const reason =
        error instanceof HubError ? `FlyCommerce refused the credential (${error.status})` : 'FlyCommerce could not be reached';
      throw new HttpError(502, 'access_token_failed', `Could not get an access token: ${reason}.`);
    }
  }

  /** The store trades the session token the page sent for access as that user; FlyCommerce is not involved. */
  private async userToken(store: string, dashboard: DashboardSession): Promise<string> {
    // Per login, not per user: logging out on one device must not leave another device's token in use, or the reverse.
    const key = `${store}\u0000${dashboard.session.sub}\u0000${dashboard.session.sid ?? ''}`;
    const cached = this.userTokens.get(key);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    let response: Response;

    try {
      response = await fetch(`${this.baseUrl(store)}/api/v1/apps/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ session_token: dashboard.token }),
        signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
      });
    } catch {
      throw new HttpError(502, 'access_token_failed', 'Could not get an access token: the store could not be reached.');
    }

    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };

    if (response.status === 401) {
      throw new HttpError(401, 'session_expired', 'Your dashboard session has ended. Reload the page and try again.');
    }

    if (!response.ok || !body.access_token) {
      throw new HttpError(502, 'access_token_failed', `Could not get an access token: the store answered ${response.status}.`);
    }

    // One entry per login would otherwise outlive every login.
    for (const [cachedKey, entry] of this.userTokens) {
      if (entry.expiresAt <= Date.now()) this.userTokens.delete(cachedKey);
    }

    // Renew a minute early so a token never expires mid-request.
    this.userTokens.set(key, { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) - 60) * 1000 });

    return body.access_token;
  }

  private baseUrl(store: string): string {
    return this.config.storeUrl ? this.config.storeUrl(store) : `https://${store}`;
  }

  private async send<T>(
    store: string,
    source: TokenSource,
    method: string,
    path: string,
    options: { query?: Query; body?: unknown },
    retried: boolean
  ): Promise<T> {
    const base = new URL(this.baseUrl(store));

    // The path joins the store's URL as text, so anything but "/…" could carry the store's token to another host.
    if (!path.startsWith('/')) {
      throw new TypeError(`A store API path starts with "/": ${path}`);
    }

    const url = new URL(`${base.origin}${base.pathname.replace(/\/+$/, '')}${path}`);

    if (url.origin !== base.origin) {
      throw new TypeError(`A store API path must stay on the store: ${path}`);
    }

    const token = await this.token(store, source);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
      });
    } catch {
      throw new HttpError(502, 'store_unreachable', 'The store could not be reached. Try again.');
    }

    if (response.status === 401) {
      this.forget(store, source);

      // A cached token outlives an uninstall or a logout; a fresh one either works or says why not.
      if (!retried) return this.send<T>(store, source, method, path, options, true);

      if (source.kind === 'user') {
        throw new HttpError(401, 'session_expired', 'Your dashboard session has ended. Reload the page and try again.');
      }
    }

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      // The store's own words where it gives them: "this order cannot be held" tells a merchant more than a status code.
      const reason = (body as { message?: unknown }).message;
      const refused = response.status >= 400 && response.status < 500;

      throw new StoreApiError(
        refused ? 422 : 502,
        refused ? 'store_refused' : 'store_api_failed',
        typeof reason === 'string' && reason ? reason : `The store API answered ${response.status} to ${method} ${path}.`,
        response.status
      );
    }

    return body as T;
  }

  private forget(store: string, source: TokenSource): void {
    if (source.kind === 'app') {
      this.hub.forget(store);
      return;
    }

    for (const key of this.userTokens.keys()) {
      if (key.startsWith(`${store}\u0000${source.dashboard.session.sub}\u0000`)) this.userTokens.delete(key);
    }
  }
}
