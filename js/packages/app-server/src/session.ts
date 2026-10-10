import { IncomingMessage } from 'node:http';
import type { SessionTokenPayload, ShopperTokenPayload } from '@flycommerce/app-bridge';
import { verifySessionToken, verifyShopperToken } from '@flycommerce/app-bridge/server';
import { AppServerConfig } from './config.js';
import { HttpError } from './http.js';
import type { DashboardSession } from './store-api.js';

/** Who is asking, from the dashboard session token on a request from the app's own frame. */
export async function authenticate(
  req: IncomingMessage,
  config: Pick<AppServerConfig, 'appId' | 'jwksUrl' | 'allowedIssuers'>
): Promise<DashboardSession> {
  const header = req.headers.authorization ?? '';

  if (!header.startsWith('Bearer ')) {
    throw new HttpError(401, 'missing_session_token');
  }

  const token = header.slice(7).trim();
  let session: SessionTokenPayload;

  try {
    session = await verifySessionToken(token, {
      appId: config.appId,
      jwksUrl: config.jwksUrl,
      allowedIssuers: config.allowedIssuers,
    });
  } catch {
    // Which check failed is a hint to whoever forged the token, so the answer never says.
    throw new HttpError(401, 'invalid_session_token', 'The session token is not valid.');
  }

  if (!session.store_domain) {
    throw new HttpError(401, 'invalid_session_token', 'The session token is not valid.');
  }

  return { store: session.store_domain, session, token };
}

/** Who is shopping, from the shopper token your storefront script sent. */
export interface ShopperRequest {
  /** The store's permanent domain: the only store this request may act for. */
  store: string;
  signedIn: boolean;
  /** The store's id for the customer; null for a guest, or when the merchant didn't grant `storefront.customer`. */
  customerId: number | null;
  shopper: ShopperTokenPayload;
}

/** Who is shopping, from `Authorization: Bearer <shopper token>` on a request from your storefront script. */
export async function authenticateShopper(
  req: IncomingMessage,
  config: Pick<AppServerConfig, 'appId' | 'jwksUrl' | 'allowedIssuers'>
): Promise<ShopperRequest> {
  const header = req.headers.authorization ?? '';

  if (!header.startsWith('Bearer ')) {
    throw new HttpError(401, 'missing_shopper_token');
  }

  let shopper: ShopperTokenPayload;

  try {
    shopper = await verifyShopperToken(header.slice(7).trim(), {
      appId: config.appId,
      jwksUrl: config.jwksUrl,
      allowedIssuers: config.allowedIssuers,
    });
  } catch {
    throw new HttpError(401, 'invalid_shopper_token', 'The shopper token is not valid.');
  }

  if (!shopper.store_domain) {
    throw new HttpError(401, 'invalid_shopper_token', 'The shopper token is not valid.');
  }

  return {
    store: shopper.store_domain,
    signedIn: shopper.signed_in === true,
    customerId: shopper.signed_in === true && typeof shopper.customer_id === 'number' ? shopper.customer_id : null,
    shopper,
  };
}
