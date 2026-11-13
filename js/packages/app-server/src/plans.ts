import type { IncomingMessage } from 'node:http';
import { AppConfig, AppConfigPage } from './app-config.js';
import { HttpError, readJson } from './http.js';
import { authenticate } from './session.js';
import type { DashboardSession } from './store-api.js';
import type { AppServerConfig } from './config.js';

/** What a store gets of a page: the page, or why it is locked. */
export type PageAccess = 'available' | 'plan' | 'inactive';

/** The plan a store is on until the app changes it; null when the app declares no plans. */
export function defaultPlan(config: Pick<AppConfig, 'plans'>): string | null {
  const plans = config.plans ?? [];

  return (plans.find((plan) => plan.default) ?? plans[0])?.key ?? null;
}

/** The store's plan from a verified session or shopper token; a token without the claim reads as the default plan. */
export function planOf(config: Pick<AppConfig, 'plans'>, payload: { plan?: unknown }): string | null {
  return typeof payload.plan === 'string' ? payload.plan : defaultPlan(config);
}

/** What a store on `plan` gets of a page, by the rule FlyCommerce applies to the menu; an unknown slug is `inactive`. */
export function pageAccess(config: Pick<AppConfig, 'dashboard'>, slug: string, plan: string | null): PageAccess {
  const own = (page: AppConfigPage): PageAccess => {
    if (page.isActive === false) return 'inactive';

    return page.plans === undefined || (plan !== null && page.plans.includes(plan)) ? 'available' : 'plan';
  };

  for (const page of config.dashboard.pages) {
    if (page.slug === slug) return own(page);

    const child = (page.children ?? []).find((candidate) => candidate.slug === slug);

    if (child) {
      const access = own(child);
      return access !== 'available' ? access : own(page);
    }
  }

  return 'inactive';
}

/** Where a callback sends the merchant: a path on your appUrl, framed by the dashboard, or a page of the admin. */
export type CallbackAnswer = { path: string } | { dashboard: string };

/** A page's `callback`: a store that can't open the page clicked it in the menu. */
export interface LockedPageCallback extends DashboardSession {
  /** The slug of the locked page. */
  page: string;
  /** `plan`: not on the store's plan. `inactive`: the page's isActive is false. */
  reason: 'plan' | 'inactive';
}

/** `planCallback`: the store's owner asked for another plan. Nothing has changed yet; you set the plan. */
export interface PlanCallback extends DashboardSession {
  /** The plan asked for: one of your plan keys. */
  plan: string;
  /** The plan the store is on now. */
  currentPlan: string | null;
}

type CallbackConfig = Pick<AppServerConfig, 'appId' | 'jwksUrl' | 'allowedIssuers'>;

/** Verifies and reads a page callback; answer with a `CallbackAnswer` as JSON within 3 seconds. */
export async function readLockedPageCallback(req: IncomingMessage, config: CallbackConfig): Promise<LockedPageCallback> {
  const asking = await authenticate(req, config);
  const { page, reason } = await readCallbackBody(req);

  if (typeof page !== 'string' || page === '' || (reason !== 'plan' && reason !== 'inactive')) {
    throw new HttpError(400, 'bad_callback', 'A page callback names a page and a reason.');
  }

  return { ...asking, page, reason };
}

async function readCallbackBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJson<unknown>(req);

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'bad_callback', 'A callback body is a JSON object.');
  }

  return body as Record<string, unknown>;
}

/** Reads the plan callback, which only the store's owner may send. Pass your app-config.json to refuse a plan you don't declare. */
export async function readPlanCallback(
  req: IncomingMessage,
  config: CallbackConfig,
  appConfig?: Pick<AppConfig, 'plans'>
): Promise<PlanCallback> {
  const asking = await authenticate(req, config);

  // FlyCommerce asks only for the owner; anyone else holding a session token must not start a plan change.
  if (asking.session.user_role !== 'owner') {
    throw new HttpError(403, 'owner_only', 'Only the store owner can ask for another plan.');
  }

  const { plan } = await readCallbackBody(req);

  if (typeof plan !== 'string' || plan === '' || (appConfig && !(appConfig.plans ?? []).some((candidate) => candidate.key === plan))) {
    throw new HttpError(400, 'unknown_plan', 'This app has no such plan.');
  }

  // The store's plan is the token's, which FlyCommerce signed; the body's copy could be anyone's.
  return { ...asking, plan, currentPlan: typeof asking.session.plan === 'string' ? asking.session.plan : null };
}
