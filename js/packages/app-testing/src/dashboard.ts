import { IncomingMessage, ServerResponse } from 'node:http';
import { hostPage } from './dashboard-page.js';
import { FakeHub } from './hub.js';
import { RunningServer, escapeHtml, sendHtml, sendJson, serve } from './net.js';

export interface ExampleDashboardOptions {
  hub: FakeHub;
  appId: string;
  appName: string;
  /** Where the app serves its dashboard pages, e.g. http://localhost:4600 */
  appUrl: string;
  store: string;
  pages: { label: string; slug: string }[];
  userId?: string;
  locale?: string;
  theme?: 'light' | 'dark';
  port?: number;
}

const ROLES = ['owner', 'admin', 'staff'];
// Each role is a different user, as in a real store; one user switching roles would share one user access token.
const ROLE_USERS: Record<string, string> = { owner: '1', admin: '2', staff: '3' };

/** A stand-in for the merchant dashboard: frames the app's pages and answers the bridge like the real one does. */
export class ExampleDashboard {
  private server: RunningServer | null = null;

  private constructor(private readonly options: ExampleDashboardOptions) {}

  static async start(options: ExampleDashboardOptions): Promise<ExampleDashboard> {
    const dashboard = new ExampleDashboard(options);
    dashboard.server = await serve((req, res, url) => dashboard.route(req, res, url), options.port);
    return dashboard;
  }

  get url(): string {
    if (!this.server) throw new Error('ExampleDashboard is not running; use ExampleDashboard.start().');
    return this.server.url;
  }

  async close(): Promise<void> {
    await this.server?.close();
    this.server = null;
  }

  private route(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const { options } = this;
    const role = ROLES.includes(url.searchParams.get('role') ?? '') ? url.searchParams.get('role')! : 'owner';

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(302, { Location: `/apps/${options.pages[0]?.slug ?? ''}` });
      res.end();
      return;
    }

    const page = /^\/apps\/([A-Za-z0-9_-]+)$/.exec(url.pathname);

    if (req.method === 'GET' && page) {
      if (!options.pages.some((candidate) => candidate.slug === page[1])) {
        return sendHtml(res, 404, `<!doctype html><p>This app has no page "${escapeHtml(page[1])}".</p>`);
      }

      return sendHtml(
        res,
        200,
        hostPage({
          appId: options.appId,
          appName: options.appName,
          appUrl: options.appUrl,
          store: options.store,
          slug: page[1],
          pages: options.pages,
          role,
          roles: ROLES,
          locale: options.locale ?? 'en',
          theme: options.theme ?? 'light',
        })
      );
    }

    // Stands in for the dashboard's session-token endpoint, which answers only the dashboard's own origin.
    if (req.method === 'POST' && url.pathname === '/session-token') {
      return sendJson(res, 200, {
        session_token: options.hub.sessionToken({
          appId: options.appId,
          store: options.store,
          userId: options.userId ?? ROLE_USERS[role],
          role,
        }),
        token_type: 'Bearer',
        expires_in: 60,
      });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/admin')) {
      return sendHtml(
        res,
        200,
        `<!doctype html><p>The real dashboard would open <code>${escapeHtml(url.pathname)}</code> here.</p><p><a href="/">Back to the app</a></p>`
      );
    }

    sendJson(res, 404, { error: 'not_found' });
  }
}
