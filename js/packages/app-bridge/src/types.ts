export type AppBridgeAction = 'APP_READY' | 'GET_SESSION_TOKEN' | 'NAVIGATE' | 'TOAST' | 'LOADING' | 'TITLE_BAR' | 'RESIZE' | 'CONFIRM';

export type AppBridgeMessage<T = any> = {
  source: 'flycom-app-bridge';
  appId: string;
  nonce: string;
  action: AppBridgeAction;
  payload?: T;
  // Absent on notifications, which the dashboard handles without replying.
  requestId?: string;
};

export type AppBridgeResponse<T = any> = {
  source: 'flycom-dashboard';
  appId: string;
  requestId?: string;
  action: AppBridgeAction;
  success: boolean;
  payload?: T;
  error?: string;
};

export type AppBridgeEventName = 'TITLE_ACTION' | 'CONTEXT' | 'VIEWPORT';

/** Sent by the dashboard on its own initiative, not in reply to a request. */
export type AppBridgeEvent<T = any> = {
  source: 'flycom-dashboard';
  appId: string;
  event: AppBridgeEventName;
  payload?: T;
};

export interface DashboardContext {
  locale: string;
  direction: 'ltr' | 'rtl';
  theme: 'light' | 'dark';
}

export type TitleBarActionVariant = 'primary' | 'secondary' | 'destructive';

/**
 * The dashboard shows at most 3 actions and one primary; labels over 32 characters and ids outside
 * [A-Za-z0-9_-]{1,64} are dropped.
 */
export interface TitleBarAction {
  id: string;
  label: string;
  variant?: TitleBarActionVariant;
  disabled?: boolean;
  loading?: boolean;
}

/** Title up to 80 characters, subtitle up to 160. */
export interface TitleBar {
  title: string;
  subtitle?: string;
  actions?: TitleBarAction[];
}

export interface TitleActionEvent {
  id: string;
}

/** Title up to 80 characters, message up to 500, button labels up to 32. */
export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive, for actions that remove or stop something. */
  destructive?: boolean;
}

/** The part of the app's frame the merchant can see, in CSS pixels from the top of the frame. */
export interface FrameViewport {
  top: number;
  height: number;
}

export interface AppConfig {
  appId: string;
  /** The embedding dashboard's origin. Defaults to the origin in document.referrer. */
  parentOrigin?: string;
  /** Put the dashboard's locale, direction, theme and visible area on <html>. Defaults to true. */
  applyContext?: boolean;
  /** Your backend's origins other than the page's own, such as `https://api.my-app.example`, that `fetch()` may send the session token to. */
  fetchOrigins?: string[];
}

// The claims of a FlyCommerce session token.
export interface SessionTokenPayload {
  iss: string;
  aud: string;
  sub: string;
  typ: 'session';
  marketplace_id: number;
  store_domain: string | null;
  user_role: string;
  app_id: string;
  installation_id: number;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  /** Hash of the dashboard login this was issued under; user access tokens stop working when that login ends. */
  sid?: string;
  [key: string]: any;
}

export interface SessionTokenResponse {
  session_token: string;
  token_type: string;
  expires_in: number;
}

export interface ToastOptions {
  type?: 'success' | 'error' | 'warning' | 'info';
}

// The claims of a shopper token: who is shopping, for one app's storefront script to hand its server.
export interface ShopperTokenPayload {
  iss: string;
  aud: string;
  typ: 'shopper';
  marketplace_id: number;
  store_domain: string | null;
  installation_id: number;
  /** True only for a customer's own sign-in; store staff and support signed in as a customer are guests. */
  signed_in: boolean;
  /** The store's id for the customer, only when the merchant granted `storefront.customer`. */
  customer_id: number | null;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

/** One line of the shopper's cart, as `cart.get` and `flycommerce:cart:updated` give it. */
export interface CartLine {
  productId: string;
  variationId?: string;
  name: string;
  quantity: number;
  unitPrice: number | null;
  total: number | null;
}

/** The shopper's cart: never its id, nor anything about the customer. */
export interface CartSummary {
  lines: CartLine[];
  count: number;
  subtotal: number;
}

/** What each storefront action takes. Quantities are 1 to 10, and `cart.add` takes up to 10 lines. */
export interface StorefrontActionInputs {
  'cart.get': Record<string, never>;
  'cart.add': { items: { productId: string; variationId?: string; quantity: number }[] };
  'cart.update': { productId: string; variationId?: string; quantity: number };
  'cart.remove': { productId: string; variationId?: string };
  'nav.goto': { to: 'product' | 'collection' | 'category'; slug: string } | { to: 'cart' };
  'ui.openCart': Record<string, never>;
}

export type StorefrontActionName = keyof StorefrontActionInputs;

export type StorefrontActionResult = { ok: true; result: unknown } | { ok: false; error: string };

export interface StorefrontActionInfo {
  name: StorefrontActionName;
  /** One sentence, written for an AI model choosing a tool. */
  description: string;
  /** Changes something the shopper owns: announced with Undo, and at most 10 a minute. */
  changes: boolean;
}

/** `window.FlyCommerce` on a storefront page that runs an app's script. It holds nothing about the shopper. */
export interface StorefrontContext {
  /** The store's domain, e.g. demo.flycom.shop. */
  store: string;
  locale: string;
  /** ISO 4217, e.g. USD. */
  currency: string;
  /** The kind of page the script loaded on, e.g. home, product or category. */
  pageType: string;
  /** Does what the shopper could do with a click, through the store's own code. Absent on stores that predate it. */
  run?<N extends StorefrontActionName>(name: N, input?: StorefrontActionInputs[N]): Promise<StorefrontActionResult>;
  can?(name: string): boolean;
  actions?(): StorefrontActionInfo[];
  /** A 5-minute token naming the shopper to your server, or null when the store won't give your app one. */
  shopperToken?(appId: string): Promise<string | null>;
}

/** The detail of `flycommerce:page`, dispatched on `window` after each client-side navigation. */
export interface StorefrontPageDetail {
  pageType: string;
  path: string;
}
