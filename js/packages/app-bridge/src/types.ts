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

/** `window.FlyCommerce` on a storefront page that runs an app's script. It holds nothing about the shopper. */
export interface StorefrontContext {
  /** The store's domain, e.g. demo.flycom.shop. */
  store: string;
  locale: string;
  /** ISO 4217, e.g. USD. */
  currency: string;
  /** The kind of page the script loaded on, e.g. home, product or category. */
  pageType: string;
}

/** The detail of `flycommerce:page`, dispatched on `window` after each client-side navigation. */
export interface StorefrontPageDetail {
  pageType: string;
  path: string;
}
