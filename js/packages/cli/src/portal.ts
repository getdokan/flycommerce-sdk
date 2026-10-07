import fs from 'node:fs';
import { CliError, Context } from './context.js';
import { readCredential } from './credentials.js';
import { printable } from './printable.js';
import { withoutTrailingSlashes } from './url.js';

export { printable };

export const DEFAULT_PORTAL = 'https://developers.flycommerce.com';

const REQUEST_TIMEOUT_MS = 30_000;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export const CLI_VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** The portal to talk to: --portal, then FLYCOMMERCE_PORTAL_URL, then FlyCommerce's. */
export function portalUrl(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const value = flag || env.FLYCOMMERCE_PORTAL_URL || DEFAULT_PORTAL;
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new CliError(`The portal URL is not a URL: ${value}`);
  }

  // The token travels to this host, so only https, except on this computer.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname))) {
    throw new CliError(`The portal URL must use https: ${value}`);
  }
  if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new CliError(`The portal URL must be a plain address, like ${DEFAULT_PORTAL}.`);
  }

  return `${url.origin}${withoutTrailingSlashes(url.pathname)}`;
}

export class ApiError extends CliError {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    problems: string[] = [],
    readonly details: Record<string, unknown> = {}
  ) {
    super(message, problems);
    this.name = 'ApiError';
  }
}

type TokenSource = 'env' | 'file' | 'none';

/** The developer API at <portal>/api/cli/v1. */
export class PortalApi {
  private constructor(
    readonly portal: string,
    private readonly token: string | undefined,
    private readonly source: TokenSource,
    private readonly signal?: AbortSignal
  ) {}

  static anonymous(portal: string, ctx: Context): PortalApi {
    return new PortalApi(portal, undefined, 'none', ctx.signal);
  }

  static withToken(portal: string, token: string, ctx: Context): PortalApi {
    return new PortalApi(portal, token, 'file', ctx.signal);
  }

  /** FLYCOMMERCE_TOKEN wins over the saved sign-in, so CI never needs one. */
  static signedIn(portal: string, ctx: Context): PortalApi {
    if (ctx.env.FLYCOMMERCE_TOKEN) {
      return new PortalApi(portal, ctx.env.FLYCOMMERCE_TOKEN, 'env', ctx.signal);
    }

    const saved = readCredential(ctx.env, portal);

    if (!saved) {
      throw new CliError(`You're not signed in to ${portal}. Run: flycommerce login`);
    }
    if (saved.expiresAt && Date.parse(saved.expiresAt) <= Date.now()) {
      throw new CliError(`Your sign-in to ${portal} has expired. Run: flycommerce login`);
    }

    return new PortalApi(portal, saved.token, 'file', ctx.signal);
  }

  get usesEnvToken(): boolean {
    return this.source === 'env';
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(this.signal ? [this.signal] : [])];
    let response: Response;

    try {
      response = await fetch(`${this.portal}/api/cli/v1/${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': `flycommerce-cli/${CLI_VERSION}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any(signals),
        redirect: 'manual',
      });
    } catch (error) {
      if (this.signal?.aborted) throw new CliError('Cancelled.');
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'it did not answer in time' : 'the request failed';
      throw new CliError(`Could not reach ${this.portal}: ${reason}.`);
    }

    // A redirect means the wrong host, or a sign-in page; the token must not follow it.
    if (response.status >= 300 && response.status < 400) {
      throw new CliError(`${this.portal} redirected the request instead of answering it. Check the portal URL.`);
    }

    const text = await response.text();
    let data: unknown = undefined;

    try {
      data = text === '' ? undefined : JSON.parse(text);
    } catch {
      // A proxy's HTML error page; reported by status below.
    }

    if (!response.ok) {
      throw this.error(response.status, data);
    }
    if (data === undefined) {
      throw new CliError(`${this.portal} answered ${method} ${path} with something that isn't JSON.`);
    }

    return data as T;
  }

  private error(status: number, data: unknown): ApiError {
    const body = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
    const code = typeof body.error === 'string' ? body.error : undefined;
    const problems = Array.isArray(body.problems) ? body.problems.map((problem) => printable(problemText(problem))) : [];
    let message = typeof body.message === 'string' && body.message !== '' ? printable(body.message) : `The portal answered ${status}.`;

    if (status === 401) {
      message =
        this.source === 'env'
          ? 'FLYCOMMERCE_TOKEN was refused: it has expired, was revoked, or is for another portal.'
          : `Your sign-in to ${this.portal} was refused: it has expired or was revoked. Run: flycommerce login`;
    }

    return new ApiError(status, code, message, problems, body);
  }
}

function problemText(problem: unknown): string {
  if (typeof problem === 'string') return problem;
  if (typeof problem === 'object' && problem !== null) {
    const { message, path, field } = problem as { message?: unknown; path?: unknown; field?: unknown };
    const where = typeof path === 'string' ? path : typeof field === 'string' ? field : undefined;
    if (typeof message === 'string') return where ? `${where}: ${message}` : message;
  }
  return JSON.stringify(problem);
}
