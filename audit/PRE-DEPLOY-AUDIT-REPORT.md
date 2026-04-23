# PRE-DEPLOY AUDIT REPORT — RX PRO Trading Platform
**Fecha:** 2026-04-22
**Scope:** Auditoría completa pre-deploy a usuarios VIP pagos ($600)
**Auditor:** Multi-agent review (5 áreas × 3 agentes)
**Status:** ❌ **NO-GO** — 11 CRÍTICOS, 21 ALTOS, varios MEDIOS/BAJOS

---

## RESUMEN EJECUTIVO

| Severidad | Total | Área 1 Sec | Área 2 Engine | Área 3 UX | Área 4 Backend | Área 5 Legal | Área 6 Marketing | Área 10 Infra |
|-----------|-------|------------|---------------|-----------|----------------|--------------|------------------|---------------|
| CRÍTICO   | 11    | 4          | 2             | 3         | 1              | 3            | (ver área 3)     | 1             |
| ALTO      | 21    | 4          | 3             | 5         | 2              | 5            | (ver área 3)     | 5             |
| MEDIO     | 17    | 3          | 5             | 3         | 3              | 1            | 3                | 3             |
| BAJO      | 8     | 0          | 4             | 2         | 2              | 0            | 0                | 0             |

**Verdict:** No se puede aprobar GO para deploy con esta lista de CRÍTICOS abiertos. Cada finding CRÍTICO es potencial vector de pérdida financiera, exposición legal, o fraude percibido por usuario.

---

# ÁREA 1 — SEGURIDAD

## [CRÍTICO] 1.1 Secrets reales comiteados al git

**Archivo:** `backend/.env` (tracked en git history)
**Evidence:** git log/diff muestra DATABASE_URL, JWT_SECRET, ADMIN_SECRET, STRIPE keys con valores reales.
**Riesgo:** Cualquiera con acceso al repo público o mirror puede:
- Conectarse a la DB productiva (`postgresql://...aws-1-sa-east-1...`)
- Forjar JWTs con el secret
- Ejecutar endpoints admin
- Consumir webhooks Stripe con signing secret
**Fix:**
1. **Rotación inmediata** de TODOS los secrets (Supabase DB password, JWT_SECRET, ADMIN_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, MP credentials, NOWPayments keys)
2. Purgar `.env` del git history: `git filter-repo --path backend/.env --invert-paths`
3. Distribuir nuevos secrets vía Render/Netlify env vars (nunca en repo)
4. Verificar `backend/.gitignore` tiene `.env`
5. Audit DB access logs últimas 72h por IPs desconocidas
**Effort:** L (2-3h rotación + coordinación)

## [CRÍTICO] 1.2 XSS — 184 instancias de `.innerHTML` con user data sin sanitizar

**Archivos:** `frontend/app.html` múltiples (ej: 8345, 8976, 11363, 13348)
**Evidence:** Grep `innerHTML=.*\${` retorna 184+ matches; varios interpolan datos desde backend/localStorage directamente.
**Riesgo:** Account takeover, credential theft, injection de malware/stealer JS si el backend o LS se contamina.
**Fix:**
```javascript
// Helper universal
function safeHTML(strings, ...values) {
  const esc = v => String(v).replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'}[c]));
  return strings.reduce((acc,s,i) => acc + s + (i<values.length ? esc(values[i]) : ''), '');
}
// Para texto puro preferir:
el.textContent = data;
```
Aplicar a las 184 instancias (scripteable con replace-all controlado).
**Effort:** L (sed + manual review por instancia)

## [CRÍTICO] 1.3 JWT entropy validation débil

**Archivo:** `backend/server.js:32-35`
**Evidence:** `_checkSecretEntropy` valida `distinct >= 10`. Permite secrets tipo `abcdefghij` repetido.
**Fix:**
```javascript
function _checkSecretEntropy(s) {
  if (!s || s.length < 32) return false;
  const chars = new Set(s);
  if (chars.size < 16) return false;
  if (/(.)\1{3,}/.test(s)) return false;      // no 4+ repeats
  if (/(.{2,})\1{2,}/.test(s)) return false;  // no patterns
  return true;
}
```
**Effort:** S

## [CRÍTICO] 1.4 Refresh token endpoint sin rate limit agresivo

**Archivo:** `backend/server.js:643-695` (`/api/keys/refresh`)
**Evidence:** Solo protegido por `generalLimiter` (100/15min). Refresh token robado → DoS + token fabrication loop.
**Fix:** Rate limit específico 5 req/min por keyId.
**Effort:** S

## [ALTO] 1.5 API Keys Binance sin rotación ni versionado

**Archivo:** `backend/database.js:96-112`
**Riesgo:** Si `BROKER_MASTER_KEY` compromete, todas las keys históricas quedan expuestas sin mecanismo de revocación masiva.
**Fix:** Agregar `key_rotation_version`, `key_changed_at`, require re-auth tras 90d.
**Effort:** M

## [ALTO] 1.6 Fingerprint validation débil — client-generated

**Archivo:** `backend/server.js:454-576` (`/api/keys/validate`)
**Riesgo:** Client spoofs fingerprint → múltiples activaciones desde devices distintos.
**Fix:** Generar fingerprint server-side combinando User-Agent + Accept-Language + IP normalizada, guardar hash no plain.
**Effort:** M

## [ALTO] 1.7 JSON.parse sin try/catch

**Archivo:** `frontend/app.html:6412, 6430, 6894, 6929, etc.`
**Riesgo:** LS corrupto → crash app sin recuperación.
**Fix:** `safeJSONParse` helper con fallback, aplicar a todas las llamadas.
**Effort:** S

## [ALTO] 1.8 Admin endpoints sin 2FA para bulk delete

**Archivo:** `backend/server.js:1250-1369`
**Riesgo:** ADMIN_SECRET filtrado → atacante genera/revoca keys masivamente.
**Fix:** Require 2FA email confirmation para operaciones >5 keys; logging con admin ID real (no solo 'admin').
**Effort:** M

## [MEDIO] 1.9 Max leverage/position desde request body

**Archivo:** `backend/server.js:1641-1643`
**Fix:** Global hardcoded + cap desde DB `broker_configs`, no aceptar del body.
**Effort:** S

## [MEDIO] 1.10 Withdraw disabled no verificado en keys aceptadas

**Archivo:** `backend/broker.js:141-147`
**Fix:** En `testConnection`, chequear `account.permissions` no incluye `WITHDRAW`. Rechazar key si lo permite.
**Effort:** S

## [MEDIO] 1.11 CORS trust proxy sin normalización de IP para rate limit

**Archivo:** `backend/server.js:225, 327-330`
**Fix:** Usar `normalizeIP(getClientIP(req))` en `perUserKey` fallback.
**Effort:** S

---

# ÁREA 2 — MOTOR APEX & TRADING LOGIC

## [CRÍTICO] 2.1 Legacy v42 PRO+ DOM accesible vía DevTools

**Archivo:** `frontend/app.html:5558-5567`
**Evidence:** `<div style="display:none;">` con `<button onclick="setApexEngine('v42proplus')">` en DOM.
**Riesgo:** Usuario remueve `display:none` o dispara `setApexEngine('v42proplus')` desde console → ejecuta motor direccional NO validado → pérdida real $$ en mainnet.
**Fix:** Eliminar div y funciones `setApexEngine` que aceptan valores distintos de 'apex'. Si se necesita preservar `runApexV16OnData` para rescate, mover a `/research-v44/legacy/` fuera del bundle.
**Effort:** S

## [CRÍTICO] 2.2 Engine lock no enforced server-side

**Archivo:** `frontend/app.html:12234-12236, 12492` + `backend/server.js` place-order
**Evidence:** `APEX_ENGINE = localStorage.getItem('rx_apex_engine') || 'v42proplus'`. Client puede spoofear LS.
**Fix:**
- Frontend: `const APEX_ENGINE = 'apex'` inmutable, nunca leer/escribir LS
- Backend: `/api/broker/place-order` rechaza requests con `engine !== 'apex'`, hardcoded
**Effort:** M

## [ALTO] 2.3 SPX macro filter silent disable si data stale

**Archivo:** `frontend/app.html:12263-12269`
**Evidence:** Si `_spxCache.stale` → `ok:true, reason:'spx_no_data_passthrough'`.
**Riesgo:** Backtest edge (PF 1.30) asumía ~10 blocks/mes del filtro. Live sin filter = 2× trades sin gate de risk-off. Flash crash exposure.
**Fix:** Hard-fail si cache >2h stale: bloquear todas las señales hasta que data recovere. Log + alert admin.
**Effort:** M

## [ALTO] 2.4 Frozen SAFE_FUNDING_PARAMS no enforced server-side

**Archivo:** `frontend/app.html:15900-15905` + `backend/broker.js:289-294`
**Riesgo:** Cliente podría mandar TP distinto a 30bps o size > SIZE_PCT. Backend no valida geometry vs frozen params.
**Fix:** Backend valida `|tp-entry|/entry ∈ [27,33] bps` y `size ≤ balance * 0.10 * leverageCap`.
**Effort:** M

## [ALTO] 2.5 Safety state frontend-only, no sincronizado desde DB en page load

**Archivos:** `frontend/app.html:12291-12315`, `backend/server.js:1673` (`/api/broker/status` no retorna state)
**Evidence:** `_apexSafetyState` in-memory + LS. Al cerrar tab + reabrir, consecLosses reset a 0 aunque DB tiene 4.
**Riesgo:** Circuit breaker bypass, daily loss reset al refresh.
**Fix:** `/api/broker/status` retorna `{consecutiveLosses, circuitBreakerUntil, dailyLossUsd, lastDailyResetAt}`. Frontend sincroniza `_apexSafetyState` al recibir.
**Effort:** M

## [MEDIO] 2.6 TP/SL failure → posición desprotegida

**Archivo:** `backend/broker.js:390-424`
**Evidence:** Si TAKE_PROFIT_MARKET y fallback TAKE_PROFIT fallan, entry filled queda sin SL. Solo warning al client.
**Fix:** Si TP/SL fallan, emergency close market reduceOnly de la entry.
**Effort:** M

## [MEDIO] 2.7 Reconciliation unidirectional (no detecta orphaned positions)

**Archivo:** `backend/server.js:2028-2071`
**Evidence:** Detecta DB→Binance desync pero no Binance→DB. Si network fail antes de INSERT, position orphan en Binance sin tracking.
**Fix:** Detectar `livePositions` sin entry en recent `broker_trade_log` → alert + flag `orphaned_position`.
**Effort:** M

## [MEDIO] 2.8 Idempotency cache TTL desconocido / no visible

**Archivo:** `backend/server.js:1753-1758`
**Evidence:** `checkIdempotency` llamado pero implementación no grep-eable en mismo archivo; `_tradeResultCache` es separado (5min TTL).
**Fix:** Verificar TTL ≥24h. Si <, aumentar y testear.
**Effort:** S investigación + S fix

## [MEDIO] 2.9 Partial fill no validado explícitamente

**Archivo:** `backend/broker.js:312-321`
**Fix:** Validar `executedQty ≥ 0.95 * requestedQty`, sino rechazar + cerrar.
**Effort:** M

## [MEDIO] 2.10 Binance 429 retry muy agresivo (solo 3 intentos)

**Archivo:** `backend/broker.js:115-134`
**Fix:** maxRetries=5, cap 8s.
**Effort:** S

## [BAJO] 2.11 Slippage 5% threshold alto para altcoins iliquidos

**Archivo:** `backend/broker.js:322-336`
**Fix:** Considerar 8% o per-pair configurable + logging histogram.
**Effort:** S

## [BAJO] 2.12 Daily loss reset UTC vs usuario local

**Archivo:** `frontend/app.html:12297-12306`
**Fix:** Usar `rx_daily_reset_at` timestamp backend, 24h rolling.
**Effort:** S

## [BAJO] 2.13 Reconciliation no valida que TP/SL sigan activos en Binance

**Archivo:** `backend/server.js:2028`
**Fix:** Extraer open orders y validar que cada position tiene TP+SL pareada.
**Effort:** M

## [BAJO] 2.14 Sin timeout en TP limit fallback

**Archivo:** `backend/broker.js:390-424`
**Fix:** clientOrderId + cancel+market-close tras HOLD_H (4h).
**Effort:** M

---

# ÁREA 3 — FRONTEND UI/UX

## [CRÍTICO] 3.1 Stats APEX INCONSISTENTES (PF 1.30 vs 1.85)

**Archivos:**
- `app.html:5417` → "PF 1.85 holdout OOS 365d"
- `app.html:5610-5614` → motor card PF 1.85 visual
- `app.html:4125` → "Basado en PF 1.30 hist."
- `landing.html:789` → "PF 1.30 walk-forward 274d OOS"
- Paper trading description → PF 1.30
- `app.html:4426` → "APEX ULTRA PF 1.65 · WR 70.5%" (otra versión distinta)

**Riesgo:** CRÍTICO — Legal liability. Cliente paga $600 promising 1.85 PF y ve disclaimers de 1.30 → demanda por publicidad engañosa.
**Fix:**
1. Elegir valor canónico basado en evidencia documentada (`/research-v44/apex-x/reports/*`)
2. Mostrar AMBOS con disclosure: "Walk-forward 274d: PF 1.30 | Holdout OOS 365d: PF 1.85 (best-case validated)"
3. Unificar en los 6 lugares identificados
**Effort:** M

## [CRÍTICO] 3.2 Legacy v42 engine visible en meta/HTML comments

**Archivos:**
- `app.html:5548-5567` — div legacy hidden pero botones con onclick activos
- `landing.html meta og:title="APEX v42 PRO+"`, `twitter:title="APEX v42 PRO+"`
**Fix:** Remover completo div + botones legacy. Update meta OG/Twitter a "APEX ELITE" o genérico.
**Effort:** S

## [CRÍTICO] 3.3 console.log/warn en producción expone internals

**Archivos:** `app.html:6774, 6781, 6788, 6795, 6802, 6809, 6816, 6823` + varios Firebase/Auth
**Evidence:** `console.log('[Auth] Logged in')`, `console.warn('[Firebase] Init error:', e.message)`, etc.
**Fix:** Global strip `console.log` en prod build; mantener `console.error` con contexto sanitizado.
**Effort:** S

## [ALTO] 3.4 Open redirect via `window.location.href = data.url`

**Archivo:** `app.html:20112, 20128`
**Fix:** Whitelist URLs:
```javascript
const allowed = ['https://rxtrading.net','https://checkout.stripe.com','https://nowpayments.io','https://www.mercadopago.com'];
if (data.url && allowed.some(a => data.url.startsWith(a)) || data.url.startsWith('/')) window.location.href = data.url;
```
**Effort:** S

## [ALTO] 3.5 Brand inconsistencia "RX Pro" vs "RX PRO"

**Archivos:** `landing.html:14`, `app.html:6`, múltiples
**Fix:** Standardizar "RX PRO" en todos los meta/títulos.
**Effort:** S

## [ALTO] 3.6 WR inconsistencia 73.5% (card) vs 70.5% (desc) vs 60%+ (backup)

**Archivos:** `app.html:5611, 4426` + backups
**Fix:** Unificar con valor canónico del backtest oficial.
**Effort:** M

## [ALTO] 3.7 localhost hardcoded fallback

**Archivos:** `app.html:6345-6346`, `landing.html:1618-1619`, `index.html:1512-1513`
**Fix:** API paths relativos `/api/...` o env-injected.
**Effort:** M

## [ALTO] 3.8 Motor cards no responsive <768px (2 columnas estrechas)

**Archivo:** `app.html` `.motors-grid{grid-template-columns:repeat(2,1fr);}`
**Fix:** `@media(max-width:768px){.motors-grid{grid-template-columns:1fr;}}` + touch targets ≥44px
**Effort:** S

## [MEDIO] 3.9 Google Fonts sin `display=swap`

**Archivo:** `app.html:28-29`
**Fix:** Agregar `&display=swap` al URL.
**Effort:** S

## [MEDIO] 3.10 Estados disabled no claros en leverage buttons

**Archivo:** `app.html:4665-4671`
**Fix:** Visual disabled state con opacity + cursor not-allowed si leverage > cap.
**Effort:** S

## [MEDIO] 3.11 Pricing section no menciona tiers claros en landing

**Archivo:** `landing.html:1713` muestra solo "$1.37/día"
**Fix:** Tabla clara con $49/$129/$399/$599 y qué incluye cada uno.
**Effort:** M

## [BAJO] 3.12 Commented legacy code mantenido

**Archivo:** `app.html:5548-5567`
**Fix:** Remover si no va a ser usado en 30d.
**Effort:** S

## [BAJO] 3.13 WebSocket error handler silencioso

**Archivo:** `landing.html:1146`
**Fix:** Mostrar toast "Connection lost — retrying".
**Effort:** S

---

# ÁREA 4 — BACKEND & APIS

## [CRÍTICO] 4.1 Error messages exponen stack traces

**Archivo:** `backend/server.js` múltiples (1668, 1720)
**Fix:** Middleware global error sanitizer que en `NODE_ENV=production` devuelve genéricos.
**Effort:** S

## [ALTO] 4.2 Transactions no atómicas en place-order

**Archivo:** `backend/server.js:1860-1869`
**Riesgo:** Trade placed en Binance pero INSERT trade_log falla → inconsistencia DB.
**Fix:** `BEGIN / COMMIT / ROLLBACK` con pool.connect(). Si log falla tras exchange success, alert admin.
**Effort:** M

## [ALTO] 4.3 Graceful shutdown timeout corto

**Archivo:** `backend/server.js:2202-2217`
**Fix:** Track active requests, esperar max 15s.
**Effort:** M

## [MEDIO] 4.4 /health expone mode (testnet/mainnet) públicamente

**Archivo:** `backend/server.js:700-720`
**Fix:** Requerir admin auth para detalles.
**Effort:** S

## [MEDIO] 4.5 Logs contienen PII (emails, keyIds en plain)

**Archivos:** `backend/server.js:407-412, 1668, 1843`
**Fix:** `sanitizeLogData()` helper que mask emails y keyIds.
**Effort:** S

## [MEDIO] 4.6 FK CASCADE en broker_configs puede orphan audit_logs

**Archivo:** `backend/database.js:95-112`
**Fix:** Soft-delete en license_keys + RESTRICT en broker_configs.
**Effort:** M

## [BAJO] 4.7 Rate limiter IP key sin normalización IPv6

**Archivo:** `backend/server.js:327-330`
**Fix:** `normalizeIP(getClientIP(req))`.
**Effort:** S

## [BAJO] 4.8 Endpoints undocumented / legacy

Requiere inventario completo — postponer a post-launch.

---

# ÁREA 5 — LEGAL & COMPLIANCE

## [CRÍTICO] 5.1 Privacy Policy link → 404

**Archivo:** `frontend/landing.html:2009` referencia `/privacy.html` inexistente.
**Riesgo:** Viola GDPR Art. 13/14. Cookie banner con link roto.
**Fix:** Crear `frontend/privacy.html` con data colectada, propósito, retención, derechos usuario, cookies, contacto DPO.
**Effort:** M

## [CRÍTICO] 5.2 TOS no disponible públicamente standalone

**Evidence:** TOS embebido en modal de `app.html:6100-6300`. No hay `/tos.html`. Footer landing sin link.
**Fix:** Crear `frontend/terms.html` con TOS completo + link en footer.
**Effort:** M

## [CRÍTICO] 5.3 Jurisdicción operador NO especificada en TOS

**Archivo:** `app.html:6296` — "Estos términos se rigen por las leyes del país donde RX PRO esté legalmente constituido..." (BLANK)
**Fix:** Completar con país, entidad legal, domicilio, governing law, dispute resolution.
**Effort:** M

## [ALTO] 5.4 Disclaimers de trading incompletos en app.html vs landing

**Fix:** Replicar "Past performance does not guarantee future results" + "Trading involves risk of loss" + capital mín $1000 + horizonte 6m en TOS modal.
**Effort:** S

## [ALTO] 5.5 Walk-forward/holdout validation sin link a reporte público

**Fix:** Crear `frontend/backtest-results.html` con equity curve, meses perdedores, DD máximo, metodología. Link desde landing.
**Effort:** M

## [ALTO] 5.6 US Geo-blocking no implementado

**Fix:** GeoIP check en `/api/payments/checkout` + disclaimer prominente "Not available to US residents".
**Effort:** M

## [ALTO] 5.7 Cookie banner sin opt-out / revocación

**Fix:** Modal "Manage Preferences" en footer, LS timestamp, permitir revocar consent.
**Effort:** M

## [ALTO] 5.8 Cookie Policy documento no existe

**Fix:** Crear `frontend/cookies.html` con tipos, duración, cómo deshabilitar.
**Effort:** S

## [MEDIO] 5.9 Refund Policy no claramente accesible

**Fix:** Crear `frontend/refund.html` con condiciones 7-day guarantee mencionado.
**Effort:** S

---

# ÁREA 10 — DEPENDENCIES & INFRA

## [CRÍTICO] 10.1 `.env` comiteado + secrets en git history

(Duplicado de 1.1, prioridad máxima)

## [ALTO] 10.2 `.env.example` vs código inconsistente

**Fix:** Auditar todas las env vars usadas en `server.js` y documentarlas.
**Effort:** S

## [ALTO] 10.3 Health endpoint sin status page público

**Fix:** Crear `/status.html` que consulta `/health` + uptime monitor.
**Effort:** S

## [ALTO] 10.4 Sin CI/CD — no pre-deploy validation

**Fix:** `.github/workflows/deploy.yml` con lint + audit + tests + deploy.
**Effort:** L

## [ALTO] 10.5 Monitoring minimal — sin Sentry/alerting

**Fix:** Integrar Sentry (free tier) + UptimeRobot + email alerts.
**Effort:** M

## [ALTO] 10.6 Git uncommitted changes críticos

**Evidence:** `backend/server.js`, `backend/broker.js`, `frontend/app.html` modificados sin commit.
**Fix:** Review y commit atómicos antes de deploy.
**Effort:** S

## [MEDIO] 10.7 cors@2.8.5 antigua

**Fix:** Bump a ^2.8.7.
**Effort:** S

## [MEDIO] 10.8 Docs públicos (quickstart, API) no existen

**Fix:** `frontend/docs/quickstart.html` + `frontend/docs/api.html`.
**Effort:** M

---

# TOP 12 DEPLOY BLOCKERS (si uno queda abierto → NO-GO)

| # | Severidad | Finding | Área | Effort | Tiempo Acumulado |
|---|-----------|---------|------|--------|-------------------|
| 1 | CRÍTICO | Rotate ALL secrets + purge `.env` del git | 1.1 / 10.1 | L | 3h |
| 2 | CRÍTICO | XSS 184 innerHTML (helper + sweep) | 1.2 | L | 4h |
| 3 | CRÍTICO | Legacy v42 DOM + engine lock server-side | 2.1, 2.2, 3.2 | M | 1.5h |
| 4 | CRÍTICO | Stats PF 1.30 vs 1.85 inconsistentes (unificar en 6 lugares) | 3.1 | M | 1h |
| 5 | CRÍTICO | Error messages sin sanitizar (middleware global) | 4.1 | S | 30min |
| 6 | CRÍTICO | Privacy Policy link 404 (crear /privacy.html) | 5.1 | M | 2h |
| 7 | CRÍTICO | TOS standalone (/terms.html) + jurisdicción | 5.2, 5.3 | M | 2h |
| 8 | CRÍTICO | JWT entropy + refresh rate limit | 1.3, 1.4 | S+S | 45min |
| 9 | CRÍTICO | console.log/warn strip producción | 3.3 | S | 20min |
| 10 | ALTO | Safety state sync DB → frontend en page load | 2.5 | M | 1.5h |
| 11 | ALTO | SPX macro filter hard-fail si stale >2h | 2.3 | M | 1h |
| 12 | ALTO | Open redirect whitelist | 3.4 | S | 15min |

**Total effort mínimo CRÍTICOS para GO:** 14-16 horas trabajo técnico + 4-6h coordinación secrets rotation + 2-4h revisión legal.

---

# CONCLUSIÓN

**VEREDICTO:** ❌ **NO-GO hasta resolver TODOS los CRÍTICOS**

Con evidence agregado de 3 agentes independientes, el producto **NO puede** recibir capital real de usuarios pagos en el estado actual. Los riesgos son acumulativos:

1. **Secrets en git** → compromise total del stack backend en horas de que repo sea público
2. **XSS 184 instances** → account takeover masivo si algún dato backend se contamina
3. **Stats inconsistentes (PF 1.30 vs 1.85)** → fraud by misrepresentation → clase action potencial
4. **Legacy engine DOM-accessible** → motor no validado puede correr con capital real
5. **Privacy 404** → GDPR violation automática el día 1 de launch EU

**Tiempo realista a GO:** 3-5 días trabajo dedicado (técnico + legal + secrets rotation + testing).

Siguiente paso: ver `GO-NOGO-DECISION.md` para decisión ejecutiva y `SMOKE-TESTS-RESULTS.md` para flows E2E pendientes a ejecutar.
