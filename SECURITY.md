# Security

## Authentication

- **License keys:** `RX-VIP-XXXXXXXXXXXX` (12 chars, 60-bit entropy, GPU-resistant at bcrypt cost 12)
- **JWT access token:** 7d expiry, includes fingerprint + type
- **Refresh token:** 90d expiry, httpOnly cookie, `SameSite=strict`, rotated on every refresh with version counter
- **Reuse detection:** if old refresh token is used after rotation, ALL sessions for that user are revoked
- **Fail-closed:** if DB unreachable during auth check, return 503 (NOT 401/pass-through)

## Encryption

- **Broker API keys:** AES-256-GCM with unique IV per encryption + auth tag validation
- **Master key:** `BROKER_MASTER_KEY` env var (32-byte hex). If lost, all encrypted keys unrecoverable. Rotation requires re-encryption migration.
- **IP logging:** SHA-256 hashed with `IP_SALT` (GDPR compliant)

## Webhooks

- **Stripe:** signature verification via `stripe.webhooks.constructEvent` + timestamp replay protection (5min window)
- **MercadoPago:** HMAC-SHA256 `x-signature` validation with `MP_WEBHOOK_SECRET` (FAIL-503 in production if secret missing)
- **NOWPayments:** HMAC-SHA512 `x-nowpayments-sig` validation with sorted-keys JSON (FAIL-503 in production if secret missing)
- **CORS rejection:** all webhooks reject requests with `Origin` header (server-to-server only)
- **Idempotency:** `pg_advisory_xact_lock` on `paymentId` hash prevents concurrent double-processing

## Rate Limiting

- `/api/keys/validate`: 10/15min per IP (brute-force protection)
- `/api/keys/refresh`: 100/15min per IP (general)
- `/api/broker/*`: 30/min per user (authenticated, via `perUserKey`)
- `/api/broker/reconcile`: 20/min global (Binance API quota protection)
- `/api/macro/spx`: 30/min per IP (scraper protection)
- All limiters subnet-normalize IPv4 to /24 and IPv6 to /64 (prevents /32 rotation bypass)

## CSP + Headers

- `Content-Security-Policy`: strict whitelist per directive
- `Strict-Transport-Security`: max-age=31536000, preload
- `Referrer-Policy`: strict-origin-when-cross-origin
- `X-Frame-Options`: (via `frame-ancestors: 'none'` in CSP)
- `X-Content-Type-Options`: nosniff
- `upgrade-insecure-requests` in production only

## Input Validation

All `/api/broker/*` inputs validated via `rxValidate`:
- `symbol`: regex `/^[A-Z0-9]{3,20}USDT$/`
- `side`: enum `BUY|SELL`
- `leverage`: integer 1-20
- `usdAmount`: finite number 10-10000
- `price`: finite number > 0 and < 1e9
- `email`: RFC-compatible regex with length cap 254

## GDPR

- `POST /api/user/delete-all` — deletes all user data across tables (requires explicit `confirm: "DELETE_MY_DATA"`)
- `GET /api/user/export` — returns JSON with paper/signals/tradeLog
- `POST /api/payments/recover-key` — email-based recovery token
- IP addresses hashed (not plain)
- Recovery tokens expire in 1h, cleaned up hourly via cron
- Audit log retained 90 days, auto-purged

## Trading Safety

- TP/SL direction validation (BUY→TP>entry, SL<entry; SELL inverse)
- SL distance: 0.1% ≤ pct ≤ 25% of entry (prevents instant stops + catastrophic loss)
- `minNotional` + `PRICE_FILTER` validation before Binance API call
- Slippage >5% triggers emergency close
- Hedge mode auto-detection + `positionSide` parameter
- Partial fill validation (requires `status IN (FILLED, NEW)`)
- Leverage BLOCKING: if `setLeverage` fails with non -4046 code, abort trade
- Circuit breaker: 5 consecutive losses → 6h cooldown per user
- Max concurrent positions (default 4) + max capital deployed % (default 50%)
- TOCTOU defense: `pg_advisory_xact_lock` per-user on place-order
- Emergency close retry 3x with exponential backoff (1s, 2s, 3s)
- listenKey revoke before create (prevents accumulation), keep-alive every 30min
- Session fixation defense: auto-disconnect broker on Binance 401/-2015 error
- **Unique `clientOrderId` per trade** (entry/TP/SL each with distinct id) — prevents duplicate order on network retry
- **Minimum capital $1000 USDT** server-side check on mainnet `/api/broker/connect` (testnet exempt)
- **V44 signal cache** (TTL 4h) shared between VIP + Paper — guarantees same engine output, no race consumption
- **V44 server scheduler** runs 24/7 (every 10min) publishing to `/api/public-signals`, UptimeRobot keep-alive prevents Render sleep

## CSRF Protection

- **Architecture-level:** Bearer token in `Authorization` header (localStorage) — browsers won't attach to cross-origin requests
- **Refresh cookie:** httpOnly + `SameSite=strict` blocks cross-site send
- **Origin/Referer middleware:** `verifyOriginMiddleware` applied to ALL authenticated POSTs:
  - `/api/keys/logout`
  - `/api/user/paper`, `/api/user/signals`, `/api/user/delete-all`
  - `/api/broker/connect`, `/api/broker/place-order`, `/api/broker/trade-result`, `/api/broker/close-all`, `/api/broker/disconnect`, `/api/broker/reconcile`
- **Idempotency:** `X-Idempotency-Key` header on place-order (generated per-trade UUID) + server-side cache by `key_id`

## Incident Response

1. **Suspected leaked JWT_SECRET:** rotate env var, forces all sessions to re-login (old tokens invalid)
2. **Suspected leaked BROKER_MASTER_KEY:** CRITICAL — all encrypted API keys compromised. Disconnect all brokers, re-encrypt with new key via migration script.
3. **Suspected leaked webhook secret:** rotate in provider dashboard + env var, redeploy
4. **User reports stolen license key:** admin endpoint `/api/admin/keys/revoke` (logged to audit_log)
5. **Binance API compromise:** user changes API key in Binance → our `/api/broker/status` auto-detects 401 → auto-disconnect + audit log entry

## Audit Log

All admin actions write to `audit_log` table:
- `revoke_key`, `delete_key`, `generate_keys`
- `broker_auto_disconnect` (session fixation defense)
- Columns: actor, action, target (redacted), meta (JSON), ip (hashed), created_at
- Retention: 90 days
