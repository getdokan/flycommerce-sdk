import crypto from 'node:crypto';

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
