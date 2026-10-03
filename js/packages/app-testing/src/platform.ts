import { FakeHub, RegisteredApp } from './hub.js';
import { FakeStore } from './store.js';

export interface FakePlatform {
  hub: FakeHub;
  store: FakeStore;
  /** The environment an app built on @flycommerce/app-server reads, pointed at these fakes. */
  env: Record<string, string>;
  close(): Promise<void>;
}

/** FlyCommerce and a store wired together, for one app. */
export async function startFakePlatform(app: RegisteredApp, ports: { hub?: number; store?: number } = {}): Promise<FakePlatform> {
  const hub = await FakeHub.start({ apps: [app], port: ports.hub });
  const store = await FakeStore.start(hub, { port: ports.store });

  return {
    hub,
    store,
    env: {
      APP_ID: app.appId,
      APP_SECRET: app.appSecret,
      REDIRECT_URI: app.redirectUri,
      HUB_API_URL: hub.apiUrl,
      JWKS_URL: hub.jwksUrl,
      ALLOWED_ISSUERS: hub.issuer,
      STORE_BASE_URL: store.url,
    },
    close: async () => {
      await store.close();
      await hub.close();
    },
  };
}
