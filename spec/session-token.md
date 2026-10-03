# Session tokens

A page of your app runs inside the merchant's dashboard. Its requests to your server carry a **session token**, which tells your server which store and which user is asking. Your server must verify it before trusting anything in it.

## Getting one (the page)

The page asks the dashboard for a token through the bridge (`getSessionToken()` in `@flycommerce/app-bridge`) and sends it as:

```
Authorization: Bearer <session token>
```

Tokens live for **60 seconds**. Ask for a fresh one for each request; the bridge caches it while it's valid.

## Format

A JWT ([RFC 7519](https://www.rfc-editor.org/rfc/rfc7519)) signed with **RS256** ([RFC 7518 §3.3](https://www.rfc-editor.org/rfc/rfc7518#section-3.3)).

**Header**

| Field | Value |
| --- | --- |
| `alg` | `RS256`. Refuse anything else, including `none`. |
| `typ` | `JWT` |
| `kid` | The ID of the signing key, `key_` followed by 16 hex characters |

**Claims**

| Claim | Meaning |
| --- | --- |
| `iss` | Who vouches for the token: FlyCommerce, `https://app.flycommerce.com` |
| `aud` | Your app's ID. A token for another app must be refused. |
| `typ` | `session` |
| `sub` | The user's ID, unique within this store only |
| `store_domain` | The store, as its permanent platform host (`<name>.flycom.shop`). **The only store you may trust.** Never take the store from a URL, body or header. It doesn't change when the merchant adds or changes a custom domain, so it's safe to key data on. |
| `marketplace_id` | The store's numeric ID |
| `user_role` | `owner` (the store owner), `admin` (store staff) or `vendor` (a seller on a marketplace store). New roles may be added; treat an unknown one as the least privileged. Use it to decide what your app lets this user do. |
| `app_id` | Your app's ID (same as `aud`) |
| `installation_id` | This store's installation of your app |
| `sid` | Identifies the user's dashboard login. Logging out ends tokens from that login. |
| `iat`, `nbf`, `exp` | Issued at, not before, expiry (Unix seconds) |
| `jti` | A unique ID for this token |

Ignore claims you don't know; new ones may be added.

## Keys

FlyCommerce publishes its public keys as a JSON Web Key Set ([RFC 7517](https://www.rfc-editor.org/rfc/rfc7517)):

```
https://app.flycommerce.com/.well-known/jwks.json
```

Each FlyCommerce region signs with its own key; the set holds one public key per region.

- **Cache** the set. It's served with `Cache-Control: public, max-age=3600`.
- **Use the key whose `kid` matches** the token header. Use only keys with `kty` `RSA`, and `use` `sig` and `alg` `RS256` when present.
- **On an unknown `kid`, fetch the set again**, since keys rotate. Do it at most every 30 seconds, so forged `kid`s can't make you hammer the endpoint.
- **Time out** the fetch (5 seconds is plenty) rather than hold requests open.

## Checks, in order

1. The token has three parts and the header's `alg` is `RS256`.
2. The signature verifies with the key matching `kid`.
3. `exp` is in the future and `nbf` is not, allowing a few seconds of clock skew.
4. `typ` is `session`.
5. `aud` equals your app ID.
6. `iss` is `https://app.flycommerce.com`.
7. `store_domain` is present.

If any check fails, answer `401` and don't say which check failed.

## Exchanging it for store access

A session token is **not** a store API credential. To act on the store as this user, exchange it at the store:

```http
POST https://<store_domain>/api/v1/apps/token
Content-Type: application/json

{ "session_token": "<session token>" }
```

```json
{ "access_token": "…", "token_type": "Bearer", "expires_in": 900, "scope": "orders.read orders.write" }
```

- The access token lasts **15 minutes**. It acts as the user, and allows only what both your app's approved permissions and that user's own permissions allow.
- Cache it per login (`store_domain`, `sub`, `sid`), and renew it a minute before it expires.
- A `401` means the login ended, the app was uninstalled, or the token wasn't valid. Ask the page for a new session token; if that fails too, the user has to reload.
- Access tokens stop working immediately when the app is uninstalled or rejected.

For work no user is doing (webhooks, scheduled jobs), use the app's own credential from the install exchange instead.
