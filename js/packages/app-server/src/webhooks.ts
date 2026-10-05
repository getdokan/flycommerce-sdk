import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { HttpError, readRawBody } from './http.js';
import type { StoreClient } from './store-api.js';

/** Whether `signature` (the X-Webhook-Signature header) is the HMAC-SHA256 of the exact raw body under `secret`. */
export function verifyWebhookSignature(rawBody: string | Buffer, signature: string | string[] | undefined, secret: string): boolean {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature) || !secret) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();

  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/** A delivery's body: the event name, when the store sent it, and the record as the store keeps it. */
export interface WebhookDelivery<T = Record<string, unknown>> {
  event: string;
  timestamp: string;
  data: T;
}

/**
 * Reads and verifies one delivery. The store comes from the endpoint's own query string (`?store=`), and is trusted
 * only because the body verifies under that store's secret. Answers an unknown store and a bad signature alike.
 */
export async function readWebhook<T = Record<string, unknown>>(
  req: IncomingMessage,
  secretFor: (store: string) => string | undefined | Promise<string | undefined>,
  options: { storeParam?: string } = {}
): Promise<{ store: string; delivery: WebhookDelivery<T> }> {
  const store = new URL(req.url ?? '/', 'http://localhost').searchParams.get(options.storeParam ?? 'store') ?? '';
  const raw = await readRawBody(req);
  const secret = store ? await secretFor(store) : undefined;

  if (!secret || !verifyWebhookSignature(raw, req.headers['x-webhook-signature'], secret)) {
    throw new HttpError(401, 'invalid_signature');
  }

  const delivery = JSON.parse(raw) as WebhookDelivery<T>;

  if (typeof delivery?.event !== 'string' || typeof delivery.data !== 'object' || delivery.data === null) {
    throw new HttpError(400, 'invalid_delivery');
  }

  return { store, delivery };
}

/**
 * Makes sure this store has exactly one subscription for `endpoint`: deletes the app's existing ones for it and creates
 * a fresh one, because a secret is only ever shown when a subscription is created. Keep the returned secret, sealed.
 */
export async function reconcileWebhook(
  client: StoreClient,
  subscription: { endpoint: string; events: string[]; description?: string }
): Promise<{ id: number | string; secret: string }> {
  const existing: { id: number | string }[] = [];

  for await (const hook of client.paginate<{ id: number | string; endpoint: string }>('/api/v1/integrations/webhooks')) {
    if (hook.endpoint === subscription.endpoint) existing.push(hook);
  }

  for (const hook of existing) {
    await client.request('DELETE', `/api/v1/integrations/webhooks/${hook.id}`);
  }

  const created = await client.request<{ data?: { id: number | string; secret?: string } }>('POST', '/api/v1/integrations/webhooks', {
    body: {
      endpoint: subscription.endpoint,
      events: subscription.events,
      description: subscription.description ?? null,
      status: 'enabled',
    },
  });

  if (!created.data?.secret) {
    throw new Error('The store created the webhook but returned no secret.');
  }

  return { id: created.data.id, secret: created.data.secret };
}
