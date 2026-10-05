import { IncomingMessage } from 'node:http';
import type { SessionTokenPayload } from '@flycommerce/app-bridge';
import { verifySessionToken } from '@flycommerce/app-bridge/server';
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
