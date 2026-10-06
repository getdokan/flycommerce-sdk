import {
  AppBridgeAction,
  AppBridgeEvent,
  AppBridgeEventName,
  AppBridgeMessage,
  AppBridgeResponse,
  AppConfig,
  ConfirmOptions,
  DashboardContext,
  FrameViewport,
  SessionTokenResponse,
  TitleActionEvent,
  TitleBar,
  ToastOptions,
} from './types.js';

export * from './types.js';

type PendingRequest = { resolve: (value: any) => void; reject: (error: Error) => void };

type EventPayloads = {
  TITLE_ACTION: TitleActionEvent;
  CONTEXT: DashboardContext;
  VIEWPORT: FrameViewport;
};

type Listeners = { [E in AppBridgeEventName]: Set<(payload: EventPayloads[E]) => void> };

function referrerOrigin(): string | null {
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
}

/** The app id the app's server wrote into <meta name="flycom-app-id">, so one build serves every environment. */
export function appIdFromPage(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="flycom-app-id"]')?.content ?? '';
}

export function parseDashboardContext(value: unknown): DashboardContext | null {
  if (!value || typeof value !== 'object') return null;

  const { locale, direction, theme } = value as Record<string, unknown>;

  if (typeof locale !== 'string' || (direction !== 'ltr' && direction !== 'rtl') || (theme !== 'light' && theme !== 'dark')) {
    return null;
  }

  return { locale, direction, theme };
}

export function parseFrameViewport(value: unknown): FrameViewport | null {
  if (!value || typeof value !== 'object') return null;

  const { top, height } = value as Record<string, unknown>;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

  return valid(top) && valid(height) ? { top, height } : null;
}

// Where @flycommerce/ui (Radix) mounts popovers and menus; inside the dashboard it caps them at a fixed height, so they reach past the page.
const POPUPS = '[data-radix-popper-content-wrapper]';
// Room below a popup for its shadow.
const POPUP_SHADOW = 8;
// Room for the trigger and the gaps either side of it, when a popup has to move from above its trigger to below.
const FLIP_ROOM = 64;

/** Where the frame must end for this popup to show whole. */
function popupEnd(popup: Element): number {
  const { top, bottom, height } = popup.getBoundingClientRect();

  // Flipped above its trigger and cut off at the top: room below makes Radix, which tries below first, move it back down.
  if (top < 0 && popup.firstElementChild?.getAttribute('data-side') === 'top') return bottom + height + FLIP_ROOM;

  return bottom + POPUP_SHADOW;
}

function popupsIn(node: Node): Element[] {
  if (!(node instanceof Element)) return [];
  return node.matches(POPUPS) ? [node] : Array.from(node.querySelectorAll(POPUPS));
}

export class AppBridge {
  public readonly appId: string;
  /** The dashboard's context once it answers APP_READY; null outside the dashboard or when it never answers. */
  public readonly ready: Promise<DashboardContext | null>;
  private readonly nonce: string;
  private readonly parentWindow: Window | null;
  // Never '*': that would hand the nonce and every request to whatever page framed the app.
  private readonly parentOrigin: string | null;
  private readonly applyContext: boolean;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;
  private currentContext: DashboardContext | null = null;
  private currentViewport: FrameViewport | null = null;
  private stopResizing: (() => void) | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly listeners: Listeners = { TITLE_ACTION: new Set(), CONTEXT: new Set(), VIEWPORT: new Set() };

  constructor(config: AppConfig) {
    this.appId = config.appId;
    this.nonce = this.extractNonce();
    this.parentWindow = typeof window !== 'undefined' ? window.parent : null;
    this.parentOrigin = config.parentOrigin ?? (typeof document !== 'undefined' ? referrerOrigin() : null);
    this.applyContext = config.applyContext ?? true;

    if (typeof window === 'undefined') {
      this.ready = Promise.resolve(null);
      return;
    }

    window.addEventListener('message', this.handleMessage);
    this.ready = this.init();
  }

  /** False when the page is opened outside a dashboard frame; title bars and resizing are then skipped. */
  get embedded(): boolean {
    return Boolean(this.parentWindow && this.parentWindow !== window && this.parentOrigin && this.nonce);
  }

  get context(): DashboardContext | null {
    return this.currentContext;
  }

  /** The visible part of the frame; null outside the dashboard, where the browser viewport is the answer. */
  get viewport(): FrameViewport | null {
    return this.currentViewport;
  }

  private extractNonce(): string {
    if (typeof window === 'undefined') return '';
    const hash = window.location.hash || '';
    const match = hash.match(/(?:#|&)nonce=([^&]+)/);
    const nonce = match ? match[1] : '';

    if (nonce) {
      const cleanHash = hash
        .replace(/(?:#|&)nonce=[^&]+/, '')
        .replace(/^#&/, '#')
        .replace(/^#$/, '');
      const cleanUrl = window.location.pathname + window.location.search + (cleanHash ? '#' + cleanHash : '');
      window.history.replaceState(null, '', cleanUrl);
    }

    return nonce;
  }

  private handleMessage = (event: MessageEvent) => {
    if (event.source !== this.parentWindow || event.origin !== this.parentOrigin) return;

    const data = event.data as AppBridgeResponse | AppBridgeEvent | null;
    if (!data || typeof data !== 'object') return;
    if (data.source !== 'flycom-dashboard' || data.appId !== this.appId) return;

    if ('event' in data) {
      this.handleEvent(data);
      return;
    }

    const pending = data.requestId ? this.pendingRequests.get(data.requestId) : undefined;
    if (!pending) return;

    this.pendingRequests.delete(data.requestId!);

    if (data.success) {
      pending.resolve(data.payload);
    } else {
      pending.reject(new Error(data.error || 'AppBridge action failed'));
    }
  };

  private handleEvent(data: AppBridgeEvent): void {
    if (data.event === 'CONTEXT') {
      const context = parseDashboardContext(data.payload);
      if (context) this.setContext(context);
      return;
    }

    if (data.event === 'VIEWPORT') {
      const viewport = parseFrameViewport(data.payload);
      if (viewport) this.setViewport(viewport);
      return;
    }

    if (data.event === 'TITLE_ACTION' && typeof data.payload?.id === 'string') {
      this.emit('TITLE_ACTION', { id: data.payload.id });
    }
  }

  private setContext(context: DashboardContext): void {
    this.currentContext = context;

    if (this.applyContext) {
      const root = document.documentElement;
      root.lang = context.locale;
      root.dir = context.direction;
      root.dataset.theme = context.theme;
      root.classList.toggle('dark', context.theme === 'dark');
    }

    this.emit('CONTEXT', context);
  }

  // The frame is as tall as the page, so centring an overlay on the frame can put it off screen.
  private setViewport(viewport: FrameViewport): void {
    this.currentViewport = viewport;

    if (this.applyContext) {
      const { style } = document.documentElement;
      style.setProperty('--flycom-viewport-top', `${viewport.top}px`);
      style.setProperty('--flycom-viewport-height', `${viewport.height}px`);
    }

    this.emit('VIEWPORT', viewport);
  }

  private emit<E extends AppBridgeEventName>(event: E, payload: EventPayloads[E]): void {
    for (const handler of [...(this.listeners[event] as Set<(payload: EventPayloads[E]) => void>)]) {
      handler(payload);
    }
  }

  private post(action: AppBridgeAction, payload: unknown, requestId?: string): void {
    const message: AppBridgeMessage = {
      source: 'flycom-app-bridge',
      appId: this.appId,
      nonce: this.nonce,
      action,
      payload,
      requestId,
    };

    this.parentWindow!.postMessage(message, this.parentOrigin!);
  }

  /** `timeoutMs` null waits as long as the merchant takes. */
  private send<T = any>(action: AppBridgeAction, payload?: any, timeoutMs: number | null = 10000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.parentWindow || this.parentWindow === window) {
        reject(new Error('App is not running inside an embedded frame.'));
        return;
      }

      if (!this.parentOrigin) {
        reject(new Error('Cannot tell which dashboard embedded this app; pass parentOrigin to createApp().'));
        return;
      }

      const requestId = crypto.randomUUID();
      this.pendingRequests.set(requestId, { resolve, reject });
      this.post(action, payload, requestId);

      if (timeoutMs === null) return;

      setTimeout(() => {
        if (this.pendingRequests.delete(requestId)) {
          reject(new Error(`AppBridge request timed out: ${action}`));
        }
      }, timeoutMs);
    });
  }

  // Fire-and-forget: the dashboard does not reply to a message without a requestId.
  private notify(action: AppBridgeAction, payload?: unknown): void {
    if (this.embedded) {
      this.post(action, payload);
    }
  }

  private async init(): Promise<DashboardContext | null> {
    if (!this.embedded) return null;

    const acknowledged = this.send('APP_READY');

    if (this.applyContext) {
      document.documentElement.dataset.embedded = '';
    }

    this.stopResizing = this.observeHeight();

    try {
      const context = parseDashboardContext(await acknowledged);
      if (context) this.setContext(context);

      return context;
    } catch (err) {
      console.warn('[AppBridge] Failed to acknowledge APP_READY:', err);

      return null;
    }
  }

  // The dashboard sizes the frame to the page, so the dashboard scrolls instead of the frame.
  private observeHeight(): () => void {
    if (typeof ResizeObserver === 'undefined') return () => {};

    const root = document.documentElement;
    let reported = -1;
    let frame = 0;

    const report = () => {
      frame = 0;
      let height = root.getBoundingClientRect().height;

      document.querySelectorAll(POPUPS).forEach((popup) => {
        height = Math.max(height, popupEnd(popup) + window.scrollY);
      });
      height = Math.ceil(height);

      if (height !== reported) {
        reported = height;
        this.notify('RESIZE', { height });
      }
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(report);
    };

    const sizes = new ResizeObserver(schedule);
    sizes.observe(root);

    // Popups are fixed to the viewport, so opening, moving or closing one changes nothing the root's size shows.
    const popups = new MutationObserver((records) => {
      for (const record of records) {
        record.removedNodes.forEach((node) => popupsIn(node).forEach((popup) => sizes.unobserve(popup)));
      }
      document.querySelectorAll(POPUPS).forEach((popup) => {
        sizes.observe(popup);
        popups.observe(popup, { attributes: true, attributeFilter: ['style'] });
      });
      schedule();
    });
    const watchPopups = () => popups.observe(document.body, { childList: true });

    // A script in <head> runs before <body> exists.
    if (document.body) watchPopups();
    else document.addEventListener('DOMContentLoaded', watchPopups, { once: true });

    report();

    return () => {
      sizes.disconnect();
      popups.disconnect();
      cancelAnimationFrame(frame);
    };
  }

  /** Listen for dashboard events; returns the function that stops listening. */
  public on<E extends AppBridgeEventName>(event: E, handler: (payload: EventPayloads[E]) => void): () => void {
    const handlers = this.listeners[event] as Set<(payload: EventPayloads[E]) => void>;
    handlers.add(handler);

    return () => {
      handlers.delete(handler);
    };
  }

  /**
   * A 60-second session token from the dashboard, reused until 10 seconds before it expires.
   */
  public async getSessionToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedToken && this.tokenExpiresAt - now > 10) {
      return this.cachedToken;
    }

    const res = await this.send<SessionTokenResponse>('GET_SESSION_TOKEN');
    this.cachedToken = res.session_token;
    this.tokenExpiresAt = now + (res.expires_in || 60);

    return this.cachedToken;
  }

  public async toast(message: string, options: ToastOptions = {}): Promise<void> {
    await this.send('TOAST', { message, type: options.type || 'info' });
  }

  /** Asks in the dashboard's own dialog; true only for the confirm button. Outside it, the browser's confirm(). */
  public async confirm(options: ConfirmOptions): Promise<boolean> {
    if (!this.embedded) {
      return typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm(`${options.title}\n\n${options.message}`)
        : false;
    }

    const answer = await this.send<{ confirmed?: boolean }>('CONFIRM', options, null);
    return answer?.confirmed === true;
  }

  /**
   * Ask the dashboard to open one of its own pages, e.g. /admin/orders.
   */
  public async navigate(path: string): Promise<void> {
    await this.send('NAVIGATE', { path });
  }

  /** Open another of this app's dashboard pages by slug, so the dashboard's URL and sidebar follow. */
  public async openPage(slug: string): Promise<void> {
    await this.send('NAVIGATE', { surface: slug });
  }

  public async loading(active: boolean): Promise<void> {
    await this.send('LOADING', { active });
  }

  /** Show a title, subtitle and up to three actions in the dashboard's own header. */
  public setTitleBar(titleBar: TitleBar): void {
    this.notify('TITLE_BAR', titleBar);
  }

  /**
   * fetch() with the session token attached, for calls to the app's own backend.
   */
  public async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const token = await this.getSessionToken();
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${token}`);

    return window.fetch(input, { ...init, headers });
  }

  public destroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.handleMessage);
    }

    this.stopResizing?.();
    this.stopResizing = null;
  }
}

export function createApp(config: AppConfig): AppBridge {
  return new AppBridge(config);
}
