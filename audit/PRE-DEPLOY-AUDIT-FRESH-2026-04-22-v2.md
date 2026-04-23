# PRE-DEPLOY AUDIT — RX PRO Trading Platform (Fresh Pass v2)
**Fecha:** 2026-04-22 (re-audit post-mejoras)
**Scope:** 10 áreas completas
**Auditor:** Multi-agent fresh pass (3 agentes paralelos)
**Status:** ❌ **NO-GO** — 18 CRÍTICOS abiertos, 17 ALTOS pendientes

---

## VS. AUDIT PREVIO (21:41 UTC)

| Categoría | Previo | Actual | Δ |
|-----------|--------|--------|---|
| **CRÍTICO** | 11 | 18 | +7 (más detallados tras 2do pass) |
| **ALTO** | 21 | 17 | -4 (mejoras parciales) |
| **MEDIO** | 17 | 12 | -5 |
| **BAJO** | 8 | 4 | -4 |

**Mejoras cerradas confirmadas:**
- ✅ `.env` NO está tracked en git (`git ls-files backend/.env` vacío)
- ✅ `_checkSecretEntropy()` existe en server.js (aunque débil, ver 1.3)
- ✅ `safeErrorMessage()` helper presente en múltiples endpoints (parcial, falta middleware global)
- ✅ `escapeHtml()` helper existe (parcial, 30 innerHTML aún sin sanitizar)
- ✅ `normalizeIP()` + `getClientIP()` implementados
- ✅ Landing fonts con `&display=swap`
- ✅ Stats APEX unificados en 3 lugares (hero, comparative, motor card)

**Nuevos findings críticos detectados:**
- ❌ CORS `localhost:*` catch-all activo en NODE_ENV=production
- ❌ console.log/warn en frontend (35+ instancias con PII: emails, migration paths, auth state)
- ❌ console.log en backend broker (keyId + symbol + amount en logs stdout)
- ❌ npm audit HIGH severity: `tar` CVEs path traversal (indirect via node-pre-gyp)
- ❌ app.html = **1.38 MB** (bloated, bloquea FCP mobile)
- ❌ `/api/admin/autotrade/pause-all` endpoint NO EXISTE
- ❌ Emergency close-all UI inaccesible (endpoint existe pero sin botón visible)
- ❌ No git tags para versionado deploys (zero tags)

---

## FINDINGS CRÍTICOS (18)

### ÁREA 1 — SEGURIDAD (8 CRÍTICOS)

| # | File:Line | Issue | Status | Fix | Effort |
|---|-----------|-------|--------|-----|--------|
| 1.1 | `backend/.env:1-6` | Secrets reales aún en instancia (DATABASE_URL, JWT, ADMIN_SECRET predecible). `.env` no tracked pero secrets débiles + nunca rotados | OPEN | Rotar TODO en Supabase/Render env vars | L 3h |
| 1.2 | `frontend/app.html:4259-8976` | **169 innerHTML total**, ~30 con datos dinámicos sin `escapeHtml` (ej 4259, 6772, 6698, 7795, 8976) | OPEN | Sweep con `escapeHtml()` o `textContent` | L 3-4h |
| 1.3 | `backend/server.js:24-35` | `_checkSecretEntropy` require solo 10 chars distintos → permite `abcdefghij` repetido | OPEN | Tighten a 16 chars + no patterns | S 15min |
| 1.4 | `backend/server.js:643` | `/api/keys/refresh` solo con `generalLimiter` (100/15min) — refresh token robado permite forging | OPEN | `refreshTokenLimiter` 5/min por keyId | S 20min |
| 1.5 | `backend/server.js:159-166` | CORS acepta `localhost:*` en todos los env (incluyendo NODE_ENV=production) | OPEN | Gate con `process.env.NODE_ENV !== 'production'` | S 10min |
| 1.6 | `backend/server.js:1843,1855,1874` | `console.log(\`[Broker] place-order → key=${keyId} ${side} ${symbol} $${usdAmount}\`)` en prod | OPEN | Wrap con NODE_ENV check + sanitize keyId | S 15min |
| 4.1 | `backend/server.js` final | No hay middleware global error sanitizer — stack traces pueden leak si endpoint olvida try/catch | OPEN | `app.use((err,req,res,next)=>{...})` middleware final | S 10min |
| 4.2 | `backend/server.js:1860-1869` | Place-order + INSERT log sin BEGIN/COMMIT — orphan position en Binance si INSERT falla | OPEN | `pool.connect() + BEGIN/COMMIT/ROLLBACK` | M 1.5h |

### ÁREA 2 — MOTOR APEX (3 CRÍTICOS)

| # | File:Line | Issue | Status | Fix | Effort |
|---|-----------|-------|--------|-----|--------|
| 2.1 | `frontend/app.html:5550-5567` | `<div class="motor-card apex" style="display:none">` con botones `setApexEngine('v41')`, `('v42pro')`, `('v42proplus')` onclick ACTIVOS | OPEN | Eliminar div + botones completo | S 5min |
| 2.2 | `frontend/app.html:12235,12492` + `backend/server.js:1751` | `APEX_ENGINE` lee desde LS spoofable; backend place-order NO valida `engine === 'apex'` | OPEN | Frontend `const APEX_ENGINE='apex'` inmutable + backend hardcoded check | M 1-1.5h |
| 2.5 | `frontend/app.html:12293-12315` + `backend/server.js:1673` | `_apexSafetyState` in-memory+LS. Al refresh tab, reset a 0 aunque DB tiene circuit_breaker_until | OPEN | `/api/broker/status` retorna safety state → frontend sync on load | M 1.5h |

### ÁREA 3 — UI/UX (2 CRÍTICOS)

| # | File:Line | Issue | Status | Fix | Effort |
|---|-----------|-------|--------|-----|--------|
| 3.1 | `app.html:4125,4269`, `landing.html:789` | Stats PF 1.30 en 3 lugares vs PF 1.85 en 3 lugares (motor card hero, comparative, motor desc) | PARTIAL | Elegir canonical + disclosure dual en los 3 pendientes | M 1h |
| 3.3 | `frontend/app.html` múltiples (6330, 6416, 6492, 6504, 6524...) | **35+ console.log/warn** con PII (`[Auth] Logged in: user@gmail.com`, migration paths, Firebase state) | OPEN | Global strip prod build + keep sanitized console.error | S 15min |

### ÁREA 5 — LEGAL (3 CRÍTICOS)

| # | File:Line | Issue | Status | Fix | Effort |
|---|-----------|-------|--------|-----|--------|
| 5.1 | Missing `frontend/privacy.html` | Cookie banner `landing.html:2009` linkea a `/privacy.html` → 404 → GDPR violation día 1 EU | OPEN | Crear `privacy.html` con datos/propósito/retención/derechos | M 2-3h |
| 5.2 | `app.html:6100-6300` (embedded modal) | TOS solo en modal app, no standalone. Footer landing sin link TOS. Usuarios no pueden leer TOS pre-signup | OPEN | Crear `terms.html` standalone + link footer | M 2h |
| 5.3 | `app.html:6296` | "Estos términos se rigen por las leyes del país donde RX PRO esté legalmente constituido..." — **BLANK** | OPEN | Completar país, entidad, domicilio, governing law, dispute resolution | M 3h (requiere decisión legal) |

### ÁREA 7 — PERFORMANCE (1 CRÍTICO)

| # | File:Line | Issue | Status | Fix | Effort |
|---|-----------|-------|--------|-----|--------|
| 7.1 | `frontend/app.html` entire | 1,381,321 bytes = 1.38 MB. Chart.js + Firebase + Stripe inline. Bloquea FCP mobile 3G +3-5s | OPEN | Externalizar libs + lazy load modales + split | L 3h |

### ÁREA 8 — EMERGENCY (1 CRÍTICO)

| # | File:Line | Issue | Status | Fix | Effort |
|---|-----------|-------|--------|-----|--------|
| 8.1 | `frontend/app.html` — botón missing | Endpoint `/api/broker/close-all` existe (backend/server.js:2074) pero SIN UI button → usuario debe usar curl manual | OPEN | Agregar panic button en dashboard top-right + confirm doble | M 1.5h |

---

## FINDINGS ALTOS (17)

| # | Área | File:Line | Issue | Status | Effort |
|---|------|-----------|-------|--------|--------|
| 1.7 | Seg | `server.js:454-576` | Fingerprint client-generated spoofeable | OPEN | M 1.5h |
| 1.8 | Seg | `server.js:1237-1369` | Admin endpoints bulk sin 2FA | OPEN | M 1.5h |
| 1.9 | Seg | `frontend/app.html` varios | JSON.parse sin try/catch | OPEN | S |
| 2.3 | Eng | `broker.js:390-424` | TP/SL failure → position desprotegida | OPEN | M 1h |
| 2.4 | Eng | `app.html:12263-12269` | SPX macro filter silent disable si stale | OPEN | M 1h |
| 3.2 | UX | `landing.html:14,20,6` | Brand "RX Pro" vs "RX PRO" inconsistente en meta og/twitter | OPEN | S 5min |
| 3.4 | UX | `app.html:20112,20128` | Open redirect via `window.location.href = data.url` sin whitelist | OPEN | S 15min |
| 3.7 | UX | varios | localhost hardcoded fallback en fetches | OPEN | M |
| 4.3 | BE | `server.js:700-720` | `/health` expone mode (testnet/mainnet) sin auth | OPEN | S 5min |
| 4.4 | BE | `server.js:89,974,1843` | Logs con PII (emails, keyIds, amounts) | OPEN | M 1h |
| 4.5 | BE | `database.js:98` | FK CASCADE broker_configs → orphan audit_logs | OPEN | M |
| 5.4 | Legal | `landing.html:939` | Disclaimers landing incompletos vs app | OPEN | S 30min |
| 5.5 | Legal | Missing `/backtest-results.html` | Stats sin reporte público metodológico | OPEN | M 2h |
| 5.6 | Legal | Missing | US geo-blocking no implementado | OPEN | M 1.5h |
| 5.7 | Legal | `landing.html:2008` | Cookie opt-out post-acceptance missing | OPEN | S 1h |
| 5.8 | Legal | Missing `cookies.html` | Cookie Policy doc no existe | OPEN | S 1h |
| 8.2 | Emer | Backend missing | `/api/admin/autotrade/pause-all` endpoint NO EXISTE | OPEN | S 30min |

---

## FINDINGS MEDIOS (12)

| # | Área | Issue | Status | Effort |
|---|------|-------|--------|--------|
| 1.10 | Seg | max leverage aceptable del body (cap desde DB existe ✓) | FIXED | - |
| 2.6 | Eng | TP/SL failure emergency close | OPEN | M |
| 2.7 | Eng | Reconciliation unidirectional | OPEN | M |
| 2.8 | Eng | Idempotency cache TTL desconocido | OPEN | S |
| 2.9 | Eng | Partial fill validation | OPEN | M |
| 4.6 | BE | Rate limiter IPv6 norm (FIXED ✓) | - | - |
| 4.7 | BE | DB pool timeout 30s OK ✓ | FIXED | - |
| 4.8 | BE | Graceful shutdown 10s timeout corto | OPEN | M |
| 5.9 | Legal | Refund Policy standalone no existe | OPEN | S 1h |
| 6.1 | Mktg | Stats cross-ref 3/6 lugares con PF 1.30 stale | OPEN | M |
| 6.2 | Mktg | Meta og:title "APEX v42 PRO+" legacy | OPEN | S 2min |
| 10.7 | Infra | README.md "PF 1.32" vs otros | OPEN | M |

---

## FINDINGS BAJOS (4)

| # | Área | Issue | Status |
|---|------|-------|--------|
| 7.2 | Perf | App.html fonts `display=swap` verify | OPEN |
| 7.5 | Perf | Favicons en data:URL no cacheable | OPEN |
| 10.9 | Infra | No TypeScript/JSDoc | OPEN |
| 10.10 | Infra | No integration/e2e tests backend | OPEN |

---

## DEPENDENCY VULNERABILITIES

```
npm audit (backend/)
HIGH SEVERITY: tar (via @mapbox/node-pre-gyp)
  CVE: 5+ path traversal CVEs
  Affected: tar <7.5.8
  Fix: npm update @mapbox/node-pre-gyp
```

**Action:** `cd backend && npm update && npm audit fix` → commit package-lock.json

---

## TOP 12 DEPLOY BLOCKERS (obligatorios para GO)

| Prioridad | # | Issue | Effort | Acum |
|-----------|---|-------|--------|------|
| P0 | 1.1 | Rotate secrets (JWT, ADMIN, DB) | L 3h | 3h |
| P0 | 1.2 | XSS sweep ~30 innerHTML | L 4h | 7h |
| P0 | 3.3 | Strip console.log frontend (35+) | S 15min | 7.25h |
| P0 | 1.6 | Strip console.log backend PII | S 15min | 7.5h |
| P0 | 5.1 | Crear `privacy.html` | M 2-3h | 10h |
| P0 | 5.2 | Crear `terms.html` standalone | M 2h | 12h |
| P0 | 5.3 | Completar jurisdicción TOS | M 3h legal | 15h |
| P0 | 2.1 | Remover legacy v42 DOM | S 5min | 15.1h |
| P0 | 2.2 | Engine lock server + frontend inmutable | M 1h | 16.1h |
| P0 | 3.1 | Unificar stats PF (3 lugares stale) | M 1h | 17.1h |
| P0 | 4.1 | Error middleware global | S 10min | 17.2h |
| P0 | 4.2 | Transaction atomicity place-order | M 1.5h | 18.7h |
| P1 | 1.3 | JWT entropy tighten | S 15min | 18.95h |
| P1 | 1.4 | Refresh rate limit 5/min | S 20min | 19.3h |
| P1 | 1.5 | CORS localhost prod gate | S 10min | 19.4h |
| P1 | 2.5 | Safety state DB → frontend sync | M 1.5h | 20.9h |
| P1 | 7.1 | Reducir app.html <500KB | L 3h | 24h |
| P1 | 8.1 | Close-all emergency button | M 1.5h | 25.5h |
| P1 | 8.2 | `/api/admin/autotrade/pause-all` | S 30min | 26h |

**Total effort mínimo P0+P1:** ~26 horas técnicas + 4-6h coordinación secrets/legal.

---

## PATH TO GO (5 días)

### Día 1 (6h) — Security sweep
- Morning: Secrets rotation + Render env vars
- Midday: JWT entropy + refresh rate limit + CORS prod
- Afternoon: Console.log strip (front + back)

### Día 2 (6h) — XSS + Error handling
- Morning: XSS sweep (30 innerHTML con escapeHtml)
- Midday: Global error middleware
- Afternoon: Place-order transaction atomicity

### Día 3 (6h) — Legal + Engine lock
- Morning: `privacy.html` + `terms.html` + `cookies.html` + `refund.html`
- Midday: Completar jurisdicción TOS
- Afternoon: Remove legacy v42 DOM + engine lock server-side + unificar stats PF

### Día 4 (6h) — Emergency + Performance + Safety sync
- Morning: `/api/admin/autotrade/pause-all` + panic close-all UI
- Midday: Safety state DB → frontend sync
- Afternoon: app.html reduction (externalizar libs, lazy load)

### Día 5 (4h) — Verification + GO
- Morning: Smoke tests E2E (9 flows)
- Midday: npm audit fix (tar CVEs)
- Afternoon: git commits atómicos + git tags v1.0.0 + **GO decision**

---

## CONCLUSIÓN

**VEREDICTO: ❌ NO-GO hasta cerrar los 18 CRÍTICOS**

Progreso desde audit previo (3h atrás): **mejoras incrementales**, pero scope total más profundo reveló issues adicionales:
- `.env` security ≠ secret rotation (✓ not tracked, ❌ valores débiles)
- XSS progress: 184 → 169 innerHTML (parcial, sigue crítico)
- Error handling: sanitizer helper ✓ pero middleware global ❌

**Tiempo realista a GO:** 5 días calendar con 6h/día dedicado.

**Riesgo si deploy ahora:**
1. Compromise en <24h por DB credentials + weak ADMIN_SECRET
2. Account takeover via XSS residual (30 vectores)
3. GDPR fine día 1 EU (privacy 404)
4. Position orphans en Binance si place-order falla post-exchange
5. Motor legacy accesible via DevTools → $$ en mainnet sin validación

Ver `GO-NOGO-DECISION.md` (actualizado) para decision executiva y `EMERGENCY-PLAYBOOK.md` para response si deploy sale mal.
