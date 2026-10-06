import type { StorefrontContext, StorefrontPageDetail } from './types.js';

export type { StorefrontContext, StorefrontPageDetail };

// Opt-in, so a dashboard page's `window` doesn't claim a FlyCommerce global it never has.
declare global {
  interface Window {
    FlyCommerce?: StorefrontContext;
  }

  interface WindowEventMap {
    'flycommerce:page': CustomEvent<StorefrontPageDetail>;
  }
}
