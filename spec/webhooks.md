# Webhooks

A store sends your app an HTTP request when something your app subscribed to happens, such as an order being created.

## Subscribing

Your app creates its own subscriptions through the store API (`POST /api/v1/integrations/webhooks`, which needs the `webhooks.manage` permission). The response includes a **secret**, shown only once. Encrypt it and keep it.

An app sees and manages only the subscriptions it created.

## The request

```http
POST <your endpoint>
Content-Type: application/json
X-Webhook-Signature: <hex HMAC-SHA256>

{ …event payload… }
```

## Verifying the signature

`X-Webhook-Signature` is the lowercase hex HMAC-SHA256 ([RFC 2104](https://www.rfc-editor.org/rfc/rfc2104)) of the **exact request body bytes**, keyed with the subscription's secret.

1. Read the raw body before parsing it.
2. Compute the HMAC of those bytes with the secret.
3. Compare with the header **in constant time** (`crypto.timingSafeEqual`, `hash_equals`, `hmac.compare_digest`).
4. Only then parse the JSON.

Answer the same way for an unknown store and a bad signature, so your endpoint doesn't reveal which stores installed you.

## Delivery

- Each event is sent **once**. A failed delivery is recorded in the store's webhook log, and is **not retried**.
- There is **no timestamp or event ID** in the request yet. You can't tell a replayed delivery from a new one by the request alone, so make handlers idempotent: key on the resource's ID and its last update time.
- **Answer fast.** Record the work and return `2xx`, then do it in the background.

## Lifecycle

- **Uninstalling or rejecting** your app suspends its subscriptions on that store. Nothing is delivered while it's suspended.
- **Reinstalling**, or FlyCommerce approving the app again, resumes exactly the subscriptions that were suspended. One your app or the merchant switched off stays off.
- Subscriptions can drift. A merchant can delete one, and you can lose a secret. Reconcile on install and on startup: list your subscriptions, delete any you can't verify, and create the ones that are missing.

## Planned

Retries with backoff, a delivery ID, and a timestamp covered by the signature (for replay protection). When they ship, this document and the SDKs change together, and the current header keeps working through a deprecation period.
