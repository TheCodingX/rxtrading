# Audit Final V2 — Post-Fix Deep Audit 2026-04-21

## Metodología
6 agentes paralelos analizaron: Signal System, i18n, UI/UX, Data Persistence, Backend Security, VIP/Trading Safety.
**Total findings nuevos: 52** (post-fixes aplicados del audit anterior).

---

## 🔴 CRITICAL (5 — blocking real trading)

### 1. Mutex timeout hangs (app.html:10073)
`_v16InFlight` no tiene timeout. Si `_genV16APEXSignalInner` hangs (API timeout) → pair lockeado para siempre → scanner skip forever.
**Fix:** `Promise.race([inner, timeoutPromise(15000)])` + finally cleanup.

### 2. `openPaperTrade` balance race (app.html:13836)
Rapid click = double deduction. Balance check-deduct sin mutex.
**Fix:** `window._paperTradeOpening` flag en try/finally.

### 3. Server-side capital $1000 minimum NOT enforced (app.html:21097)
Gate solo frontend. User puede setear `localStorage.rx_rt_onboarding_v1 = {capital_amount:50}` → bypass.
**Fix:** Backend valida capital en activación autotrading real.

### 4. CSRF protection missing (server.js:1358+)
POST /api/user/paper, /api/user/signals, /api/broker/* sin CSRF token.
**Fix:** Double-submit cookie CSRF token.

### 5. Broker clientOrderId missing (broker.js placeTradeWithTPSL)
Retry on timeout → orden duplicada en Binance → 2x posición.
**Fix:** `clientOrderId: crypto.randomUUID()` en entry/TP/SL orders.

---

## 🟠 HIGH (15)

6. **Paper + Real autotrading cooldown dedup missing** (app.html:7720, 14644). Separate cooldown maps.
7. **Balance source race** (app.html:4148). `_brokerBalance` undefined pre-fetch → muestra DEMO en vez de REAL.
8. **Max capital deployed 50% NOT checked frontend** (app.html:7538). User puede abrir notional >50% balance.
9. **Concurrent positions NOT tracked frontend** (app.html:7259). Max N positions enforced backend only.
10. **Order idempotency missing real-trade-modal** (app.html:7571). No request ID.
11. **Multi-tab positions wholesale replace** (app.html:18764). Tab B trades lost when Tab A syncs.
12. **JWT 7-day TTL too long** (server.js:454). Stolen token = 7 días exposición.
13. **CSP unsafe-inline** (server.js:140). XSS vector on any user input reflection.
14. **Backtest cooldown mismatch** (backtest-apex-v16.js vs live). User reported -40%/-63% DD on 60d.
15. **RAZON card cascading layout gap** (app.html:3419). Parent `.vmg` expected child density.
16. **Dashboard DOM reorder FOUC** (app.html:4266-4283). 250ms delay shows wrong position.
17. **Offline queue no backoff** (app.html:7038). 50 requests spike → 429 rate limit.
18. **IP-only rate limit `/api/keys/validate`** (server.js:245). Enumeration via proxy rotation.
19. **Recovery token email TODO** (server.js:1454). Feature non-functional.
20. **tar package CVE** (package.json). Path traversal on install.

---

## 🟡 MEDIUM (20)

21. **Signal entry=0 fallback silent** (app.html:10135). $0 entry, bad TP/SL.
22. **WebSocket price stale detection** (app.html:7132). No timestamp, uses old px[sym].
23. **ATR ratio recompute stale** (app.html:14415). Drift fix uses old ATR.
24. **Real AT cooldown memory leak** (app.html:7746). `_realAutoTradeSymCooldowns` never cleaned.
25. **Paper position timestamp NaN** (app.html:13911). Malformed `p.time` → close immediately.
26. **Firestore vs backend sync conflict winner undefined** (app.html:6746, 6986).
27. **Stale tab recovery data loss** (app.html:7812). Cloud overwrites local-only trades.
28. **Auth failure UI degradation missing** (app.html:7353). 401 retry but no user toast.
29. **Token in LS XSS vector** (app.html:6307). Should be httpOnly cookie.
30. **Broker rate limiter per-IP not per-user** (server.js:1566). NAT shares 30 req/min.
31. **Webhook secret optional in dev → staging risk** (server.js:860). `NODE_ENV=production` without secret = free keys.
32. **Audit log gaps on payments** (server.js:710-1100). No `logAudit()` calls.
33. **Daily loss reset UTC, not local** (app.html:12100). 5h misalignment in UTC-5.
34. **Broker keys decrypted per request** (broker.js:37). No caching, CPU cost.
35. **Refresh token reuse silent revoke** (server.js:615). No email notification.
36. **Panic button sequential, no parallel** (app.html:7449). Slow close on 8+ positions.
37. **listenKey keepalive fails silently** (app.html:7208). No error handler.
38. **Gauge actualPct hardcoded 0** (app.html:4181). VIP expected-vs-actual widget non-functional.
39. **Grid collapse mobile <375px** (app.html:3976). `span 2` causes misaligned rows.
40. **Modal focus trap incomplete** (app.html:21504). first-real-confirm-modal sin Tab trap.

---

## 🟢 LOW (12)

41. **Signal dedup 60s window too short** (app.html:15191). Same signal at 61s passes.
42. **Cursor lerp mismatch 60Hz display** (app.html:8645). 0.6 lerp designed for 120Hz.
43. **prefers-reduced-motion coverage partial** (app.html:multi). Cursor/particles/ROI/onboarding still animate.
44. **"Cargando..." stuck states** (app.html:4040, 4054, 4990). No error fallback.
45. **VIP balance count-up sin aria-live** (app.html:4124). Screen reader silent.
46. **Skip-to-content link absent** (app.html:2986).
47. **Orphaned schema keys** (app.html:6354). v55/v56/v57 keys left behind.
48. **Signal dedup sin ID on merge** (app.html:6878, 11487).
49. **Interval cleanup race on toggle** (app.html:7612). Orphaned intervals possible.
50. **Stack traces in prod logs** (server.js:2108). Exposed in JSON logs.
51. **MP signature comment typo** (server.js:838). Broken comment syntax.
52. **FAQ accordions sin chevron indicator** (landing.html:895).

---

## i18n Remaining (42 strings)

### Critical gaps (block English users):
- **rtWizard 10-step onboarding: 21 strings** — Paso 1-10 titles + step descriptions
- **Dynamic status text: 8** — "Dentro de rango ✓", "Atención", "Peligro — revisar", "Hoy", "día/días"
- **Placeholders: 10** — "Buscar activo...", "Tu Binance API Key", "Nombre del perfil..."
- **Title attributes: 8** — tooltip on hover
- **Aria-labels: 3** — screen reader accessibility
- **Confirm dialogs: 3** — critical interaction prompts

**Coverage actual: 89-90%** | **Target: 95%+** | **Effort: 4-5h**

---

## Findings YA FIXED (verified)

✅ `_v16InFlight` mutex added
✅ Signal has ts/time/timestamp fields
✅ applyPaperSignal 120s stale + drift recompute
✅ Position ID `crypto.randomUUID()`
✅ Kill switch `const USE_KILL_SWITCH = false &&`
✅ Logout clears all LS keys including offline queue
✅ Mode selector sync 5 selectors
✅ RAZON card hidden
✅ Precision row removed from Results
✅ VIP dashboard balance source badge + last-synced timestamp
✅ 40 new i18n keys (VIP Dashboard + Safety + Stale signal)

---

## Recomendación deploy

### Pre-deploy blockers (CRITICAL 5 + HIGH selective):
1. Mutex timeout (app.html:10073) — 30 min fix
2. openPaperTrade mutex (app.html:13836) — 30 min fix
3. Backend capital $1000 enforce — 1h backend
4. clientOrderId broker orders — 1h backend
5. Paper + Real cooldown cross-check — 30 min
6. Balance source race first-fetch gate — 30 min

### Post-deploy sprint (remaining):
- CSRF middleware
- CSP unsafe-inline removal
- Full i18n onboarding
- WS price staleness detection
- Offline queue exponential backoff
- Multi-tab positions merge by ID

### Long-term:
- httpOnly cookie token migration
- JWT TTL reduction 15min access
- Token caching for broker
- Comprehensive E2E test suite
- Email recovery implementation
- Payment audit log coverage

**Estado general: 89% deploy-ready. CRITICAL 5 deben fixearse antes de público pago.**
