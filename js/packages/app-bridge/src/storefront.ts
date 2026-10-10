import type {
  CartLine,
  CartSummary,
  StorefrontActionInfo,
  StorefrontActionInputs,
  StorefrontActionName,
  StorefrontActionResult,
  StorefrontContext,
  StorefrontPageDetail,
} from './types.js';

export type {
  CartLine,
  CartSummary,
  StorefrontActionInfo,
  StorefrontActionInputs,
  StorefrontActionName,
  StorefrontActionResult,
  StorefrontContext,
  StorefrontPageDetail,
};

// Opt-in, so a dashboard page's `window` doesn't claim a FlyCommerce global it never has.
declare global {
  interface Window {
    FlyCommerce?: StorefrontContext;
  }

  interface WindowEventMap {
    'flycommerce:page': CustomEvent<StorefrontPageDetail>;
    'flycommerce:cart:updated': CustomEvent<CartSummary>;
  }
}
