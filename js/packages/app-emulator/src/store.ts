import crypto from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { FakeHub, AccessGrant } from './hub.js';
import { RunningServer, bearer, readJsonBody, sendJson, serve } from './net.js';

export type OrderStatus = 'pending' | 'processing' | 'on_hold' | 'completed' | 'canceled';

// The store's own numbers for an order's status, as a delivery's `data` carries them.
const STATUS_NUMBERS: Record<OrderStatus, number> = { completed: 1, processing: 2, pending: 3, canceled: 5, on_hold: 6 };

// filters[createdAt] and filters[updatedAt]: a bare date means "since"; >, >=, < and <= compare.
function matchesDateFilters(order: FakeOrder, url: URL): boolean {
  for (const field of ['createdAt', 'updatedAt'] as const) {
    const raw = url.searchParams.get(`filters[${field}]`);
    if (!raw) continue;

    const [, operator = '>=', value] = /^(>=|<=|>|<)?(.+)$/.exec(raw.trim()) ?? [];
    const bound = Date.parse(value ?? '');
    const at = Date.parse(order[field]);
    if (Number.isNaN(bound)) continue;

    const ok = operator === '>' ? at > bound : operator === '<' ? at < bound : operator === '<=' ? at <= bound : at >= bound;
    if (!ok) return false;
  }

  return true;
}

export interface FakeAddress {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
}

export interface FakeLineItem {
  id: string;
  productId: number;
  title: string;
  sku: string | null;
  quantity: number;
  total: number;
}

/** The order resource as the store API returns it; relations appear only when `include` asks for them. */
export interface FakeOrder {
  id: string;
  orderNo: number;
  status: OrderStatus;
  paymentStatus: 'paid' | 'unpaid' | 'refunded';
  total: number;
  customerId: number | null;
  billingAddress: FakeAddress;
  shippingAddress: FakeAddress;
  createdAt: string;
  updatedAt: string;
  lineItems: FakeLineItem[];
  orderGroup: {
    currency: string;
    customerInfo: { id: number | null; email: string; firstName: string | null; lastName: string | null };
  };
}

/** A product as the store API returns it, with the fields a storefront app usually needs. */
export interface FakeProduct {
  id: string;
  title: string;
  slug: string;
  status: 'published' | 'draft';
  price: number;
  salePrice: number | null;
  description: string;
  sellCount: number;
}

// The store refuses a filter it doesn't know with a 400 for apps, rather than quietly returning everything.
function unknownFilters(url: URL, allowed: string[]): string[] {
  return [...url.searchParams.keys()]
    .map((key) => /^filters?\[([^\]]+)\]$/.exec(key))
    .filter((match): match is RegExpExecArray => match !== null)
    .filter((match) => !match[0].startsWith('filters[') || !allowed.includes(match[1]))
    .map((match) => match[0]);
}

function page<T>(rows: T[], url: URL): { rows: T[]; meta?: Record<string, number> } {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 15), 1), 100);

  if (url.searchParams.get('paginate') !== 'full') return { rows: rows.slice(0, limit) };

  const current = Math.max(Number(url.searchParams.get('page') ?? 1), 1);
  return {
    rows: rows.slice((current - 1) * limit, current * limit),
    meta: { currentPage: current, lastPage: Math.max(Math.ceil(rows.length / limit), 1), perPage: limit, total: rows.length },
  };
}

export interface FakeWebhook {
  id: number;
  appId: string;
  endpoint: string;
  description: string;
  status: 'enabled' | 'disabled';
  events: string[];
  secret: string;
}

export interface Delivery {
  webhookId: number;
  event: string;
  endpoint: string;
  status: number;
  body: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  appId: string | null;
  store: string | null;
  /** The user an app acted for; null for the app's own token. */
  userId: string | null;
  body: unknown;
}

export const WEBHOOK_EVENTS = [
  'product.created',
  'product.updated',
  'product.deleted',
  'category.created',
  'category.updated',
  'category.deleted',
  'collection.created',
  'collection.updated',
  'collection.deleted',
  'brand.created',
  'brand.updated',
  'brand.deleted',
  'order.created',
  'order.updated',
  'order.deleted',
  'order.canceled',
  'order.completed',
  'order.refund.created',
  'order.shipment.created',
  'order.shipment.updated',
] as const;

const HOLDABLE: OrderStatus[] = ['pending', 'processing'];
const CANCELABLE: OrderStatus[] = ['pending', 'processing', 'on_hold'];

/** A user's standing in the store: owner, full access, active, and the permissions the owner gave them. */
export interface TeamMember {
  owner?: boolean;
  fullAccess?: boolean;
  active?: boolean;
  permissions?: string[];
}

// Without an explicit member, the session role decides: owner holds all, admin full access, anyone else view only.
const DEFAULT_MEMBER: Record<string, TeamMember> = {
  owner: { owner: true },
  admin: { fullAccess: true },
};

/** One store's data inside the fake. */
export class StoreFixture {
  readonly orderList: FakeOrder[] = [];
  private readonly team = new Map<string, TeamMember>();
  readonly webhookList: FakeWebhook[] = [];
  readonly productList: FakeProduct[] = [];
  private nextOrderNo = 1001;
  private nextProductId = 1;
  private lastStamp = 0;

  constructor(readonly domain: string) {}

  /** Sets what a user may do when an app acts for them with a user access token. */
  setTeamMember(userId: string | number, member: TeamMember): void {
    this.team.set(String(userId), member);
  }

  teamMember(userId: string, role: string): TeamMember {
    return this.team.get(userId) ?? DEFAULT_MEMBER[role] ?? { permissions: ['order.view', 'product.view', 'integration.view'] };
  }

  addOrder(
    overrides: Partial<Omit<FakeOrder, 'billingAddress' | 'orderGroup'>> & {
      email?: string;
      firstName?: string;
      lastName?: string;
      currency?: string;
    } = {}
  ): FakeOrder {
    const orderNo = overrides.orderNo ?? this.nextOrderNo++;
    const createdAt = overrides.createdAt ?? this.now();
    const email = overrides.email ?? `buyer${orderNo}@example.test`;
    const firstName = overrides.firstName ?? 'Nadia';
    const lastName = overrides.lastName ?? 'Rahman';

    const order: FakeOrder = {
      id: overrides.id ?? `01ORDER${orderNo}`,
      orderNo,
      status: overrides.status ?? 'processing',
      paymentStatus: overrides.paymentStatus ?? 'paid',
      total: overrides.total ?? 120,
      customerId: overrides.customerId === undefined ? orderNo : overrides.customerId,
      // Real orders carry no e-mail on the address; the buyer's e-mail lives on the order group.
      billingAddress: { firstName, lastName, email: null, phone: '+8801700000000', city: 'Dhaka', country: 'BD' },
      shippingAddress: { firstName, lastName, email: null, phone: '+8801700000000', city: 'Dhaka', country: 'BD' },
      createdAt,
      updatedAt: overrides.updatedAt ?? createdAt,
      lineItems: overrides.lineItems ?? [
        { id: `L${orderNo}`, productId: 7, title: 'Circle Lamp', sku: 'LAMP', quantity: 1, total: overrides.total ?? 120 },
      ],
      orderGroup: {
        currency: overrides.currency ?? 'USD',
        customerInfo: { id: overrides.customerId === undefined ? orderNo : overrides.customerId, email, firstName, lastName },
      },
    };

    this.orderList.push(order);
    return order;
  }

  addProduct(overrides: Partial<FakeProduct> & { title: string }): FakeProduct {
    const id = overrides.id ?? `01PRODUCT${this.nextProductId++}`;
    const product: FakeProduct = {
      id,
      title: overrides.title,
      slug:
        overrides.slug ??
        overrides.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, ''),
      status: overrides.status ?? 'published',
      price: overrides.price ?? 10,
      salePrice: overrides.salePrice ?? null,
      description: overrides.description ?? '',
      sellCount: overrides.sellCount ?? 0,
    };

    this.productList.push(product);
    return product;
  }

  product(id: string): FakeProduct | undefined {
    return this.productList.find((candidate) => candidate.id === id && candidate.status === 'published');
  }

  updateOrder(id: string, patch: Partial<Pick<FakeOrder, 'status' | 'paymentStatus' | 'total'>>): FakeOrder {
    const order = this.requireOrder(id);
    Object.assign(order, patch, { updatedAt: this.now() });
    return order;
  }

  // Real time, at least a millisecond apart, so newest-first and since-filters behave as on a store.
  private now(): string {
    this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    return new Date(this.lastStamp).toISOString();
  }

  order(id: string): FakeOrder | undefined {
    return this.orderList.find((candidate) => candidate.id === id);
  }

  requireOrder(id: string): FakeOrder {
    const order = this.order(id);
    if (!order) throw new Error(`No order ${id} in ${this.domain}.`);
    return order;
  }
}

/** The store's REST API as an installed app reaches it, enforcing the scopes the merchant granted. */
export class FakeStore {
  readonly requests: RecordedRequest[] = [];
  readonly deliveries: Delivery[] = [];
  private readonly stores = new Map<string, StoreFixture>();
  private server: RunningServer | null = null;
  private nextWebhookId = 1;

  private constructor(private readonly hub: FakeHub) {}

  static async start(hub: FakeHub, options: { port?: number } = {}): Promise<FakeStore> {
    const store = new FakeStore(hub);
    store.server = await serve((req, res, url) => store.route(req, res, url), options.port);
    return store;
  }

  /** What an app puts in STORE_BASE_URL: every store is served here and told apart by the access token. */
  get url(): string {
    if (!this.server) throw new Error('FakeStore is not running; use FakeStore.start().');
    return this.server.url;
  }

  store(domain: string): StoreFixture {
    let fixture = this.stores.get(domain);

    if (!fixture) {
      fixture = new StoreFixture(domain);
      this.stores.set(domain, fixture);
    }

    return fixture;
  }

  /** Sends an event the way the store does: `{event, timestamp, data}`, signed with HMAC-SHA256 of the raw body. */
  async deliver(domain: string, event: string, data: Record<string, unknown>): Promise<Delivery[]> {
    const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data });
    const sent: Delivery[] = [];

    for (const webhook of this.store(domain).webhookList) {
      if (webhook.status !== 'enabled' || !webhook.events.includes(event)) continue;
      // Uninstalling suspends an app's subscriptions; reinstalling resumes them.
      if (!this.hub.findInstallation(webhook.appId, domain)?.active) continue;

      const signature = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');
      let status = 0;

      try {
        const response = await fetch(webhook.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature },
          body,
        });
        status = response.status;
      } catch {
        status = 0;
      }

      const delivery = { webhookId: webhook.id, event, endpoint: webhook.endpoint, status, body };
      this.deliveries.push(delivery);
      sent.push(delivery);
    }

    return sent;
  }

  /** The order as a delivery's `data` carries it: the stored record, snake_case, money as decimal strings, status as a number. */
  static rawOrder(order: FakeOrder): Record<string, unknown> {
    return {
      id: order.id,
      order_no: order.orderNo,
      status: STATUS_NUMBERS[order.status],
      payment_status: order.paymentStatus,
      total: order.total.toFixed(2),
      created_at: order.createdAt,
      updated_at: order.updatedAt,
    };
  }

  async close(): Promise<void> {
    await this.server?.close();
    this.server = null;
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const token = bearer(req);
    const grant = token ? this.hub.verifyAccessToken(token) : null;
    const body = req.method === 'GET' || req.method === 'DELETE' ? undefined : await readJsonBody(req);

    this.requests.push({
      method: req.method ?? '',
      path: url.pathname,
      query: url.search,
      appId: grant?.appId ?? null,
      store: grant?.store ?? null,
      userId: grant?.user?.id ?? null,
      body,
    });

    // The app's server trades its page's session token here; the body, not a bearer token, is the credential.
    if (req.method === 'POST' && url.pathname === '/api/v1/apps/token') {
      const exchanged = this.hub.exchangeSessionToken(String((body as { session_token?: unknown } | undefined)?.session_token ?? ''));

      return exchanged
        ? sendJson(res, 200, { ...exchanged, token_type: 'Bearer' })
        : sendJson(res, 401, {
            error: 'invalid_session_token',
            message: 'The session token is not valid, has expired or its login has ended.',
          });
    }

    if (!grant) {
      return sendJson(res, 401, { message: 'Unauthenticated.' });
    }

    const fixture = this.store(grant.store);
    const route = `${req.method} ${url.pathname}`;
    const orderAction = /^PATCH \/api\/v1\/orders\/([^/]+)\/(on-hold|remove-hold|cancel)$/.exec(route);
    const orderShow = /^GET \/api\/v1\/orders\/([^/]+)$/.exec(route);
    const productShow = /^GET \/api\/v1\/products\/([^/]+)$/.exec(route);
    const webhookItem = /^(GET|DELETE) \/api\/v1\/integrations\/webhooks\/(\d+)$/.exec(route);

    if (route === 'GET /api/v1/orders') {
      if (!this.allowed(res, grant, 'orders.read', 'order.view')) return;
      if (!this.knownFilters(res, url, ['createdAt', 'updatedAt', 'orderNo', 'customerId', 'status'])) return;
      return this.listOrders(res, fixture, url);
    }

    if (route === 'GET /api/v1/products') {
      if (!this.allowed(res, grant, 'catalog.read', 'product.view')) return;
      if (!this.knownFilters(res, url, ['ids', 'slug'])) return;
      return this.listProducts(res, fixture, url);
    }

    if (route === 'GET /api/v1/search/products') {
      if (!this.allowed(res, grant, 'catalog.read', 'product.view')) return;
      return this.searchProducts(res, fixture, url);
    }

    if (productShow && productShow[1] !== 'batch') {
      if (!this.allowed(res, grant, 'catalog.read', 'product.view')) return;
      const product = fixture.product(decodeURIComponent(productShow[1]));
      return product ? sendJson(res, 200, { data: product }) : sendJson(res, 404, { message: 'Product not found.' });
    }

    if (orderShow) {
      if (!this.allowed(res, grant, 'orders.read', 'order.view')) return;
      const order = fixture.order(decodeURIComponent(orderShow[1]));
      return order ? sendJson(res, 200, { data: this.present(order, url) }) : sendJson(res, 404, { message: 'Order not found.' });
    }

    if (orderAction) {
      if (!this.allowed(res, grant, 'orders.write', 'order.update')) return;
      return this.actOnOrder(res, fixture, decodeURIComponent(orderAction[1]), orderAction[2]);
    }

    if (route === 'GET /api/v1/integrations/webhooks') {
      if (!this.allowed(res, grant, 'webhooks.manage', 'integration.view')) return;
      // An app sees only its own subscriptions.
      const own = fixture.webhookList
        .filter((webhook) => webhook.appId === grant.appId)
        .map(({ secret: _secret, appId: _appId, ...rest }) => rest);
      return sendJson(res, 200, { data: own });
    }

    if (route === 'POST /api/v1/integrations/webhooks') {
      if (!this.allowed(res, grant, 'webhooks.manage', 'integration.update')) return;
      return this.createWebhook(res, fixture, grant, body as Record<string, unknown>);
    }

    if (webhookItem) {
      if (!this.allowed(res, grant, 'webhooks.manage', webhookItem[1] === 'DELETE' ? 'integration.delete' : 'integration.view')) return;
      const index = fixture.webhookList.findIndex((webhook) => webhook.id === Number(webhookItem[2]) && webhook.appId === grant.appId);

      if (index < 0) return sendJson(res, 404, { message: 'Webhook not found.' });

      if (webhookItem[1] === 'DELETE') {
        fixture.webhookList.splice(index, 1);
        return sendJson(res, 204);
      }

      const { secret: _secret, appId: _appId, ...rest } = fixture.webhookList[index];
      return sendJson(res, 200, { data: rest });
    }

    sendJson(res, 404, { message: 'Not found.' });
  }

  // Same order as the real store: the app's scope first, then, for a user access token, the user's permission.
  private allowed(res: ServerResponse, grant: AccessGrant, scope: string, permission: string): boolean {
    if (!grant.scopes.includes(scope)) {
      sendJson(res, 403, { message: `This app has not been granted ${scope}.` });
      return false;
    }

    if (!grant.user) return true;

    const member = this.store(grant.store).teamMember(grant.user.id, grant.user.role);
    const holds = member.owner || (member.active !== false && (member.fullAccess || (member.permissions ?? []).includes(permission)));

    if (holds) return true;

    sendJson(res, 403, { message: `Your team account does not have the ${permission} permission.` });
    return false;
  }

  private knownFilters(res: ServerResponse, url: URL, allowed: string[]): boolean {
    const unknown = unknownFilters(url, allowed);
    if (unknown.length === 0) return true;

    sendJson(res, 400, {
      message: `Unknown filter ${unknown.join(', ')}. This list takes ${allowed.map((name) => `filters[${name}]`).join(', ')}.`,
    });
    return false;
  }

  // As the real store: without ?paginate=full there are no pages, only the first `limit` rows and no meta.
  private listOrders(res: ServerResponse, fixture: StoreFixture, url: URL): void {
    const newestFirst = (url.searchParams.get('sort') ?? '-createdAt') === '-createdAt';
    const exact = (name: string) => url.searchParams.get(`filters[${name}]`);
    const sorted = [...fixture.orderList]
      .filter((order) => matchesDateFilters(order, url))
      .filter((order) => exact('orderNo') === null || String(order.orderNo) === exact('orderNo'))
      .filter((order) => exact('customerId') === null || String(order.customerId) === exact('customerId'))
      .filter((order) => exact('status') === null || order.status === exact('status'))
      .sort((a, b) => (newestFirst ? -1 : 1) * a.createdAt.localeCompare(b.createdAt));
    const { rows, meta } = page(sorted, url);

    sendJson(res, 200, { data: rows.map((order) => this.present(order, url)), ...(meta ? { meta } : {}) });
  }

  // ?search= on the listing: the slug starts with it, or the title contains it.
  private listProducts(res: ServerResponse, fixture: StoreFixture, url: URL): void {
    const term = url.searchParams.get('search')?.toLowerCase();
    const ids = url.searchParams.get('filters[ids]')?.split(',');
    const slug = url.searchParams.get('filters[slug]');
    const found = fixture.productList
      .filter((product) => product.status === 'published')
      .filter((product) => !term || product.slug.startsWith(term) || product.title.toLowerCase().includes(term))
      .filter((product) => !ids || ids.includes(product.id))
      .filter((product) => slug === null || product.slug === slug);
    const { rows, meta } = page(found, url);

    sendJson(res, 200, { data: rows, ...(meta ? { meta } : {}) });
  }

  // The ranked search: every word counts, the products matching most words first. No typo tolerance here.
  private searchProducts(res: ServerResponse, fixture: StoreFixture, url: URL): void {
    const words = (url.searchParams.get('search') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 15), 1), 100);
    const current = Math.max(Number(url.searchParams.get('page') ?? 1), 1);
    const scored = fixture.productList
      .filter((product) => product.status === 'published')
      .map((product) => {
        const text = `${product.title} ${product.description}`.toLowerCase();
        return { product, score: words.filter((word) => text.includes(word)).length };
      })
      .filter(({ score }) => words.length === 0 || score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ product }) => product);

    sendJson(res, 200, {
      data: scored.slice((current - 1) * limit, current * limit),
      meta: { currentPage: current, lastPage: Math.max(Math.ceil(scored.length / limit), 1), perPage: limit, total: scored.length },
    });
  }

  private present(order: FakeOrder, url: URL): Record<string, unknown> {
    const include = new Set(
      (url.searchParams.get('include') ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    );
    const { lineItems, orderGroup, ...rest } = structuredClone(order);

    return {
      ...rest,
      ...(include.has('lineItems') ? { lineItems } : {}),
      ...(include.has('orderGroup') ? { orderGroup } : {}),
    };
  }

  private actOnOrder(res: ServerResponse, fixture: StoreFixture, id: string, action: string): void {
    const order = fixture.order(id);

    if (!order) return sendJson(res, 404, { message: 'Order not found.' });

    if (action === 'on-hold') {
      if (!HOLDABLE.includes(order.status)) {
        return sendJson(res, 422, {
          message: `Order #${order.orderNo} cannot be put on hold while it is ${order.status.replace('_', ' ')}.`,
        });
      }
      fixture.updateOrder(id, { status: 'on_hold' });
    } else if (action === 'remove-hold') {
      if (order.status !== 'on_hold') {
        return sendJson(res, 422, { message: `Order #${order.orderNo} is not on hold.` });
      }
      fixture.updateOrder(id, { status: 'processing' });
    } else {
      if (!CANCELABLE.includes(order.status)) {
        return sendJson(res, 422, { message: `Order #${order.orderNo} cannot be canceled while it is ${order.status}.` });
      }
      fixture.updateOrder(id, { status: 'canceled' });
    }

    sendJson(res, 200, { message: 'Order updated.', data: fixture.order(id) });
  }

  private createWebhook(res: ServerResponse, fixture: StoreFixture, grant: AccessGrant, body: Record<string, unknown>): void {
    const events = Array.isArray(body.events) ? body.events.filter((event): event is string => typeof event === 'string') : [];
    const unknown = events.filter((event) => !(WEBHOOK_EVENTS as readonly string[]).includes(event));
    let endpoint: URL | null = null;

    try {
      endpoint = new URL(String(body.endpoint ?? ''));
    } catch {
      endpoint = null;
    }

    if (!endpoint || !/^https?:$/.test(endpoint.protocol) || events.length === 0 || unknown.length > 0) {
      return sendJson(res, 422, {
        message: 'The given data was invalid.',
        errors: {
          ...(endpoint ? {} : { endpoint: ['The endpoint must be a valid URL.'] }),
          ...(events.length ? {} : { events: ['Choose at least one event.'] }),
          ...(unknown.length ? { events: [`Unknown events: ${unknown.join(', ')}.`] } : {}),
        },
      });
    }

    const webhook: FakeWebhook = {
      id: this.nextWebhookId++,
      appId: grant.appId,
      endpoint: endpoint.toString(),
      description: String(body.description ?? ''),
      status: body.status === 'disabled' ? 'disabled' : 'enabled',
      events,
      secret: crypto.randomBytes(24).toString('hex'),
    };

    fixture.webhookList.push(webhook);

    const { appId: _appId, ...presented } = webhook;
    // The secret is returned once, on creation.
    sendJson(res, 201, { message: 'Webhook created successfully.', data: presented });
  }
}
