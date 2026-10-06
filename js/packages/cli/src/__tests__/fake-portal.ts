import { createHash } from 'node:crypto';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { Context, run } from '../main.js';

export interface FakeApp {
  appId: string;
  name: string;
  status: string;
  published: boolean;
  redirectUrl: string | null;
  versions: { versionId: number; version: string; title: string; releasedAt: string | null }[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization?: string;
  body?: any;
}

/** The developer portal's CLI sign-in and /api/cli/v1, as the hub answers them. */
export class FakePortal {
  readonly token: string;
  readonly requests: RecordedRequest[] = [];
  readonly apps = new Map<string, FakeApp>();
  authorizeQuery?: URLSearchParams;
  /** Sent back to the loopback instead of the state the CLI sent. */
  forgedState?: string;
  releaseAnswer?: { status: number; body: unknown };
  /** Answers every API call with a redirect here, as a misconfigured host or a sign-in page would. */
  redirectTo?: string;
  private issuedCode?: string;
  private server!: http.Server;
  url = '';

  constructor(token = 'flyc_fake_token_123') {
    this.token = token;
  }

  static async start(token?: string): Promise<FakePortal> {
    const portal = new FakePortal(token);
    portal.server = http.createServer((req, res) => void portal.handle(req, res));
    await new Promise<void>((resolve) => portal.server.listen(0, '127.0.0.1', resolve));
    portal.url = `http://127.0.0.1:${(portal.server.address() as AddressInfo).port}`;
    return portal;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  addApp(app: Partial<FakeApp> & { appId: string }): FakeApp {
    const full: FakeApp = { name: app.appId, status: 'draft', published: false, redirectUrl: null, versions: [], ...app };
    this.apps.set(app.appId, full);
    return full;
  }

  apiCalls(): RecordedRequest[] {
    return this.requests.filter((request) => request.path.startsWith('/api/cli/v1/'));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    this.requests.push({ method: req.method!, path: url.pathname, authorization: req.headers.authorization, body });

    const send = (status: number, data?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };

    if (req.method === 'GET' && url.pathname === '/cli/authorize') {
      this.authorizeQuery = url.searchParams;
      this.issuedCode = 'one-time-code';
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', this.issuedCode);
      back.searchParams.set('state', this.forgedState ?? url.searchParams.get('state')!);
      return send(302, undefined, { Location: back.toString() });
    }

    if (req.method === 'POST' && url.pathname === '/api/cli/v1/token') {
      const challenge = createHash('sha256').update(String(body?.code_verifier)).digest('base64url');
      const ok =
        this.issuedCode !== undefined &&
        body?.code === this.issuedCode &&
        challenge === this.authorizeQuery?.get('code_challenge') &&
        body?.redirect_uri === this.authorizeQuery?.get('redirect_uri');
      this.issuedCode = undefined;
      return ok
        ? send(200, { token: this.token, expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString() })
        : send(400, { error: 'invalid_grant', message: 'The code is not valid.' });
    }

    if (!url.pathname.startsWith('/api/cli/v1/')) return send(404, { error: 'not_found', message: 'Not found.' });
    if (this.redirectTo) return send(302, undefined, { Location: this.redirectTo });
    if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { error: 'unauthenticated', message: 'Unauthenticated.' });

    const path = url.pathname.slice('/api/cli/v1/'.length);
    const parts = path.split('/').map(decodeURIComponent);

    if (req.method === 'GET' && path === 'me') return send(200, { id: 7, name: 'Dev Person', email: 'dev@example.com' });
    if (req.method === 'GET' && path === 'apps') {
      return send(
        200,
        [...this.apps.values()].map(({ appId, name, status, published }) => ({ appId, name, status, published }))
      );
    }

    const app = parts[0] === 'apps' ? this.apps.get(parts[1]) : undefined;
    if (!app) return send(404, { error: 'not_found', message: 'No such app.' });

    if (req.method === 'GET' && parts.length === 2)
      return send(200, { appId: app.appId, name: app.name, status: app.status, redirectUrl: app.redirectUrl, versions: app.versions });

    if (req.method === 'POST' && parts.length === 3 && parts[2] === 'versions') {
      if (app.versions.some((version) => version.version === body.version)) {
        return send(422, { error: 'invalid', message: 'That version exists.', problems: ['version: taken'] });
      }
      const versionId = app.versions.length + 1;
      app.versions.push({ versionId, version: body.version, title: body.title, releasedAt: null });
      return send(201, { versionId, version: body.version });
    }

    if (req.method === 'POST' && parts.length === 5 && parts[2] === 'versions' && parts[4] === 'release') {
      if (this.releaseAnswer) return send(this.releaseAnswer.status, this.releaseAnswer.body);
      const version = app.versions.find((candidate) => candidate.versionId === Number(parts[3]))!;
      version.releasedAt = new Date().toISOString();
      return send(200, { versionId: version.versionId, version: version.version, released: true, awaitingReview: [] });
    }

    if (req.method === 'PUT' && parts.length === 3 && parts[2] === 'dev-config') {
      if (app.published) return send(409, { error: 'app_published', message: 'A published app takes changes only through a release.' });
      const config = body.config;
      const base = String(config.appUrl).replace(/\/+$/, '');
      return send(200, {
        appUrl: base,
        pages: config.dashboard.pages.map((page: { label: string; slug: string; path: string }) => ({
          label: page.label,
          slug: page.slug,
          url: base + page.path,
        })),
        scripts: (config.storefront?.scripts ?? []).map((script: { handle: string; src: string }) => ({
          handle: script.handle,
          src: script.src.startsWith('/') ? base + script.src : script.src,
        })),
        installUrl: `${this.url}/apps/${app.appId}/install`,
      });
    }

    send(404, { error: 'not_found', message: 'Not found.' });
  }
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in-process against the given environment. */
export async function runCli(argv: string[], ctx: Partial<Context> & { env: NodeJS.ProcessEnv; cwd: string }): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    openUrl: () => {},
    ...ctx,
    stdout: (text) => (stdout += `${text}\n`),
    stderr: (text) => (stderr += `${text}\n`),
  });
  return { code, stdout, stderr };
}
