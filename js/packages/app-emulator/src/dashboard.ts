import { IncomingMessage, ServerResponse } from 'node:http';
import { HostPageEntry, HostPlan, hostPage } from './dashboard-page.js';
import { FakeHub } from './hub.js';
import { RunningServer, escapeHtml, sendHtml, sendJson, serve } from './net.js';
import { StorefrontProduct, StorefrontScriptConfig, storefrontPage } from './storefront-page.js';

/** appUrl without trailing slashes; a loop, since a regex here is slow on many slashes. */
function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

export type { HostPageEntry, HostPlan, StorefrontScriptConfig };

export interface ExampleDashboardOptions {
  hub: FakeHub;
  appId: string;
  appName: string;
  /** Where the app serves its dashboard pages, e.g. http://localhost:4600 */
  appUrl: string;
  store: string;
  /** The app's dashboard.pages from app-config.json: each is framed at appUrl + its path. */
  pages: HostPageEntry[];
  /** The app's plans from app-config.json. With them, pages lock by plan and the menu offers the owner a switch. */
  plans?: HostPlan[];
  /** The app's planCallback from app-config.json: asked where to send the owner who picks another plan. */
  planCallback?: string;
  /** The app's storefront.scripts from app-config.json; /storefront then runs them on an example store page. A path src is resolved against appUrl. */
  scripts?: StorefrontScriptConfig[];
  userId?: string;
  /** Products the example storefront's cart can hold, e.g. a FakeStore fixture's productList. */
  products?: StorefrontProduct[];
  /** Who a signed-in shopper is on the example storefront (default 1001). */
  customerId?: number;
  locale?: string;
  theme?: 'light' | 'dark';
  port?: number;
}

// The roles FlyCommerce issues session tokens to today.
const ROLES = ['owner', 'admin'];
// Each role is a different user, as in a real store; one user switching roles would share one user access token.
const ROLE_USERS: Record<string, string> = { owner: '1', admin: '2' };
// How long FlyCommerce waits for a callback before showing its own notice.
const CALLBACK_TIMEOUT_MS = 3000;

/** As FlyCommerce resolves a script src or a callback: a path is appended to appUrl, a URL is taken as it is. */
const onAppUrl = (base: string, value: string): string => (value.startsWith('/') && !value.startsWith('//') ? base + value : value);

type Landing = { frameUrl: string } | { dashboard: string } | { notice: true };

/** A stand-in for the merchant dashboard: frames the app's pages and answers the bridge like the real one does, and runs its storefront scripts on /storefront. */
export class ExampleDashboard {
  private server: RunningServer | null = null;

  private constructor(private readonly options: ExampleDashboardOptions) {}

  static async start(options: ExampleDashboardOptions): Promise<ExampleDashboard> {
    const dashboard = new ExampleDashboard(options);
    const plans = options.plans ?? [];

    if (plans.length > 0) {
      const first = plans.find((plan) => plan.default) ?? plans[0];
      options.hub.declarePlans(options.appId, [first.key, ...plans.filter((plan) => plan !== first).map((plan) => plan.key)]);
    }

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

  /** Every page and sub-page, in menu order. */
  private get pages(): HostPageEntry[] {
    return this.options.pages.flatMap((page) => [page, ...(page.children ?? [])]);
  }

  /** FlyCommerce's rule for the menu; a sub-page that is open on its own follows a locked parent. */
  private access(page: HostPageEntry): 'available' | 'plan' | 'inactive' {
    const plan = this.options.hub.planOf(this.options.appId, this.options.store);
    const own = (entry: HostPageEntry) =>
      entry.isActive === false
        ? 'inactive'
        : entry.plans === undefined || (plan !== null && entry.plans.includes(plan))
          ? 'available'
          : 'plan';
    const parent = this.options.pages.find((candidate) => (candidate.children ?? []).includes(page));
    const access = own(page);

    return access === 'available' && parent ? own(parent) : access;
  }

  /** Where an app may send a merchant: under /admin, read without the query string and percent-decoded. */
  private static isAdminPath(path: string): boolean {
    // eslint-disable-next-line no-control-regex
    if (path.length > 2000 || /[\s#\\\u0000-\u001f\u007f]/.test(path)) return false;

    try {
      const route = decodeURIComponent(path.split('?')[0]);
      return /^\/admin(\/|$)/.test(route) && !route.includes('//') && !route.split('/').includes('..');
    } catch {
      return false;
    }
  }

  /** Asks the app where to send the merchant, as FlyCommerce does: its session token, 3 seconds, no redirects followed. */
  private async ask(callback: string | undefined, role: string, body: Record<string, unknown>): Promise<Landing> {
    if (!callback) return { notice: true };

    const { options } = this;
    const base = withoutTrailingSlashes(options.appUrl);
    const target = onAppUrl(base, callback);

    try {
      const response = await fetch(target, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${options.hub.sessionToken({ appId: options.appId, store: options.store, userId: options.userId ?? ROLE_USERS[role], role })}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });
      if (response.status !== 200) await response.body?.cancel();
      const answer = response.status === 200 ? ((await response.json().catch(() => null)) as Record<string, unknown> | null) : null;
      const path = answer?.path;
      const dashboard = answer?.dashboard;

      // One leading slash keeps the frame on the app's host.
      // eslint-disable-next-line no-control-regex
      if (typeof path === 'string' && path.length <= 2000 && /^\/(?!\/)[^\s\\#\u0000-\u001f\u007f]*$/.test(path)) {
        return { frameUrl: new URL(target).origin + path };
      }
      if (typeof dashboard === 'string' && ExampleDashboard.isAdminPath(dashboard)) {
        return { dashboard };
      }
    } catch {
      // An app that is down or slow gets the notice, like any unusable answer.
    }

    return { notice: true };
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { options } = this;
    const role = ROLES.includes(url.searchParams.get('role') ?? '') ? url.searchParams.get('role')! : 'owner';

    const base = withoutTrailingSlashes(options.appUrl);
    // As FlyCommerce does with a path src: appended to appUrl.
    const scripts = (options.scripts ?? []).map((script) => ({ ...script, src: onAppUrl(base, script.src) }));

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(302, {
        Location:
          options.pages.length === 0 && scripts.length > 0
            ? '/storefront'
            : `/apps/${(this.pages.find((candidate) => this.access(candidate) === 'available') ?? this.pages[0])?.slug ?? ''}`,
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/storefront') {
      if (scripts.length === 0) {
        return sendHtml(res, 404, '<!doctype html><p>This app has no storefront scripts. Add storefront.scripts to app-config.json.</p>');
      }

      return sendHtml(
        res,
        200,
        storefrontPage({
          appId: options.appId,
          appName: options.appName,
          store: options.store,
          scripts,
          locale: options.locale ?? 'en',
          currency: 'USD',
          products: options.products,
          customerId: options.customerId,
        })
      );
    }

    // The store's own route for a script's shopper token: same-origin only, and only for the app whose scripts run here.
    const shopperToken = /^\/apps\/([A-Za-z0-9_-]{1,64})\/shopper-token$/.exec(url.pathname);

    if (req.method === 'POST' && shopperToken) {
      if (req.headers['x-requested-with'] !== 'XMLHttpRequest') {
        return sendJson(res, 403, { message: 'Ask from the store page.' });
      }

      if (shopperToken[1] !== options.appId || scripts.length === 0) {
        return sendJson(res, 404, { message: 'This app does not run on this storefront.' });
      }

      const customerId = url.searchParams.get('shopper') === 'customer' ? (options.customerId ?? 1001) : null;
      return sendJson(res, 200, {
        token: options.hub.shopperToken({ appId: options.appId, store: options.store, customerId }),
        expiresIn: 300,
      });
    }

    const page = /^\/apps\/([A-Za-z0-9_-]+)$/.exec(url.pathname);

    const plans = options.plans ?? [];
    // As FlyCommerce: a plan switch only where the app has a plan callback and the store let it set the plan.
    const canSwitch =
      options.planCallback !== undefined &&
      (options.hub.findInstallation(options.appId, options.store)?.scopes.includes('plan.manage') ?? false);
    const host = (slug: string, landing?: { url: string; heading: string }) =>
      hostPage({
        appId: options.appId,
        appName: options.appName,
        appUrl: options.appUrl,
        store: options.store,
        slug,
        pages: this.pages,
        locked: this.pages.filter((candidate) => this.access(candidate) !== 'available').map((candidate) => candidate.slug),
        landingUrl: landing?.url,
        heading: landing?.heading,
        plans: plans.length > 0 ? { all: plans, current: options.hub.planOf(options.appId, options.store), canSwitch } : undefined,
        storefront: scripts.length > 0,
        role,
        roles: ROLES,
        locale: options.locale ?? 'en',
        theme: options.theme ?? 'light',
      });
    const notice = (what: string, why: string) =>
      sendHtml(
        res,
        200,
        `<!doctype html><h1>${escapeHtml(what)} isn’t available right now</h1><p>${escapeHtml(why)}</p><p><a href="/">Back to the app</a></p>`
      );
    const land = (landing: Landing, slug: string, heading: string, why: string) => {
      if ('frameUrl' in landing) return sendHtml(res, 200, host(slug, { url: landing.frameUrl, heading }));
      if ('dashboard' in landing) {
        // A header takes ASCII only; what is already ASCII, percent-escapes included, goes as the app wrote it.
        res.writeHead(302, { Location: landing.dashboard.replace(/[^\x20-\x7e]/g, (char) => encodeURIComponent(char)) });
        return void res.end();
      }

      return notice(heading, why);
    };

    if (req.method === 'GET' && page) {
      const entry = this.pages.find((candidate) => candidate.slug === page[1]);

      if (!entry) {
        return sendHtml(res, 404, `<!doctype html><p>This app has no page "${escapeHtml(page[1])}".</p>`);
      }

      const access = this.access(entry);

      if (access === 'available') {
        return sendHtml(res, 200, host(entry.slug));
      }

      // A locked page is never framed: the app's callback says where the merchant lands instead.
      return land(
        await this.ask(entry.callback, role, { page: entry.slug, reason: access }),
        entry.slug,
        entry.title ?? entry.label,
        access === 'plan'
          ? `It isn’t part of this store’s plan for ${options.appName}.`
          : `${options.appName} has switched this page off for now.`
      );
    }

    // The owner picking another plan: the app is asked where to send them, and sets the plan itself.
    if (req.method === 'GET' && url.pathname === '/plan-change') {
      const plan = url.searchParams.get('plan') ?? '';

      if (role !== 'owner' || !canSwitch || !plans.some((candidate) => candidate.key === plan)) {
        return sendHtml(res, 403, '<!doctype html><p>Only the store owner can ask for one of the app’s plans.</p>');
      }

      return land(
        await this.ask(options.planCallback, role, { plan, currentPlan: options.hub.planOf(options.appId, options.store) }),
        '',
        'Plan',
        `${options.appName} can’t change plans right now.`
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
