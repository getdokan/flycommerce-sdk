import { createContext, ReactNode, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { AppBridge, createApp } from './index.js';
import type { AppConfig, DashboardContext, FrameViewport, TitleBar, TitleBarAction } from './types.js';

const bridges = new Map<string, AppBridge>();

// StrictMode renders twice; a second bridge would announce the app to the dashboard twice.
function bridgeFor(config: AppConfig): AppBridge {
  let bridge = bridges.get(config.appId);

  if (!bridge) {
    bridge = createApp(config);
    bridges.set(config.appId, bridge);
  }

  return bridge;
}

const AppBridgeContext = createContext<AppBridge | null>(null);

export type AppBridgeProviderProps = AppConfig & { children: ReactNode };

/** Connects the app to the dashboard once. Later config changes are ignored. */
export function AppBridgeProvider({ children, ...config }: AppBridgeProviderProps) {
  return <AppBridgeContext.Provider value={bridgeFor(config)}>{children}</AppBridgeContext.Provider>;
}

export function useAppBridge(): AppBridge {
  const bridge = useContext(AppBridgeContext);

  if (!bridge) {
    throw new Error('useAppBridge() needs an <AppBridgeProvider> above it.');
  }

  return bridge;
}

/** The dashboard's locale, direction and theme; null until the dashboard answers, or outside it. */
export function useDashboardContext(): DashboardContext | null {
  const bridge = useAppBridge();

  return useSyncExternalStore(
    (onChange) => bridge.on('CONTEXT', onChange),
    () => bridge.context,
    () => null
  );
}

/** The part of the frame the merchant can see; null outside the dashboard. */
export function useFrameViewport(): FrameViewport | null {
  const bridge = useAppBridge();

  return useSyncExternalStore(
    (onChange) => bridge.on('VIEWPORT', onChange),
    () => bridge.viewport,
    () => null
  );
}

export interface TitleBarActionInput extends TitleBarAction {
  onAction?: () => void;
}

export interface TitleBarInput extends Omit<TitleBar, 'actions'> {
  actions?: TitleBarActionInput[];
}

/**
 * Shows the title and actions in the dashboard's own header.
 * `embedded` is false when the page is opened outside the dashboard, so it can draw its own.
 */
export function useTitleBar({ title, subtitle, actions = [] }: TitleBarInput): { embedded: boolean } {
  const bridge = useAppBridge();
  const handlers = useRef(new Map<string, () => void>());

  const titleBar: TitleBar = {
    title,
    subtitle,
    actions: actions.map(({ id, label, variant, disabled, loading }) => ({ id, label, variant, disabled, loading })),
  };
  const serialized = JSON.stringify(titleBar);

  useEffect(() => {
    handlers.current = new Map(actions.flatMap((action) => (action.onAction ? [[action.id, action.onAction]] : [])));
  });

  useEffect(() => {
    bridge.setTitleBar(JSON.parse(serialized) as TitleBar);
  }, [bridge, serialized]);

  useEffect(() => bridge.on('TITLE_ACTION', ({ id }) => handlers.current.get(id)?.()), [bridge]);

  return { embedded: bridge.embedded };
}
