# POST-DEPLOY WATCHLIST
**Fecha:** 2026-04-22
**Scope:** Findings MEDIO / BAJO / COSMÉTICO no bloqueantes para el launch pero pendientes de atender post-deploy.

Estos items NO bloquean GO. Se trackean acá para iterar durante las primeras 2-4 semanas post-launch.

---

## TIER — ATACAR EN SEMANA 1 POST-LAUNCH

### 1. SQL transactions atómicas en place-order
**Archivo:** `backend/server.js:1860-1869`
**Problema:** Trade placed + INSERT log no atómico. Si log falla tras exchange success, inconsistencia DB.
**Fix:** BEGIN/COMMIT/ROLLBACK con `pool.connect()`.
**Effort:** M

### 2. Reconciliation bidirectional (detectar orphaned positions)
**Archivo:** `backend/server.js:2028-2071`
**Problema:** Solo detecta DB→Binance, no Binance→DB.
**Fix:** Extraer `livePositions` sin entry en recent `broker_trade_log` → flag + alert.
**Effort:** M

### 3. TP/SL failure → emergency close entry
**Archivo:** `backend/broker.js:390-424`
**Problema:** Si ambos TP/SL fallan, entry queda sin hedge.
**Fix:** Market close reduceOnly automático si TP fail.
**Effort:** M

### 4. Idempotency cache TTL ≥24h
**Archivo:** `backend/server.js:1753-1758`
**Problema:** TTL desconocido; si <24h, retry puede doble-place.
**Fix:** Verificar, aumentar si necesario.
**Effort:** S investigación + S fix

### 5. Partial fill validation
**Archivo:** `backend/broker.js:312-321`
**Fix:** Rechazar si `executedQty < 0.95 * requested`.
**Effort:** M

### 6. Binance 429 retry — 5 intentos en vez de 3
**Archivo:** `backend/broker.js:115-134`
**Fix:** maxRetries=5, cap 8s.
**Effort:** S

### 7. Graceful shutdown con tracking de active requests
**Archivo:** `backend/server.js:2202-2217`
**Fix:** Esperar up to 15s para requests activos.
**Effort:** M

### 8. Error middleware global sanitizer
**Archivo:** `backend/server.js` múltiples
**Fix:** Middleware que en NODE_ENV=production devuelve `{error:'Internal Server Error', code, ts}`.
**Effort:** S
**Nota:** Este podría promoverse a CRÍTICO si stack traces aparecen visibles en prod.

---

## TIER — ATACAR EN SEMANAS 2-4

### 9. `/health` expone mode a no-admin
**Archivo:** `backend/server.js:700-720`
**Fix:** Condicionar detalles a admin auth.
**Effort:** S

### 10. Logs con PII (keyId, emails)
**Archivos:** `backend/server.js:407-412, 1668, 1843`
**Fix:** `sanitizeLogData()` helper.
**Effort:** S

### 11. FK CASCADE broker_configs → audit loss
**Archivo:** `backend/database.js:95-112`
**Fix:** Soft-delete en license_keys + RESTRICT en FK.
**Effort:** M

### 12. Rate limiter IP sin normalización IPv6
**Archivo:** `backend/server.js:327-330`
**Fix:** `normalizeIP(getClientIP(req))` en `perUserKey`.
**Effort:** S

### 13. Slippage 5% threshold puede ser false positive
**Archivo:** `backend/broker.js:322-336`
**Fix:** Aumentar a 8% o per-pair configurable + log histogram.
**Effort:** S

### 14. Daily loss reset UTC vs usuario local
**Archivo:** `frontend/app.html:12297-12306`
**Fix:** Usar timestamp backend 24h rolling.
**Effort:** S

### 15. Google Fonts sin `&display=swap`
**Archivo:** `app.html:28-29`
**Effort:** S

### 16. Motor cards responsive <375px
**Archivo:** `app.html` `.motors-grid`
**Fix:** Media query + touch targets ≥44px.
**Effort:** S

### 17. Disabled states claros en leverage buttons
**Archivo:** `app.html:4665-4671`
**Fix:** opacity + cursor not-allowed.
**Effort:** S

### 18. Pricing tiers claros en landing
**Archivo:** `landing.html:1713`
**Fix:** Tabla con $49/$129/$399/$599 explícita.
**Effort:** M

### 19. WebSocket error handler silencioso
**Archivo:** `landing.html:1146`
**Fix:** Toast "Connection lost — retrying".
**Effort:** S

### 20. Refund Policy standalone page
**Fix:** Crear `frontend/refund.html`.
**Effort:** S

### 21. US Geo-blocking (si aplica jurisdicción)
**Fix:** GeoIP check en `/api/payments/checkout` + disclaimer.
**Effort:** M

### 22. Cookie opt-out / revocar consent
**Fix:** Modal "Manage Preferences" en footer.
**Effort:** M

### 23. Cookie Policy page
**Fix:** `frontend/cookies.html`.
**Effort:** S

### 24. Walk-forward report público (`/backtest-results.html`)
**Fix:** Visualizar equity curve, meses perdedores, DD histórico.
**Effort:** M

### 25. Docs públicos (quickstart, API)
**Fix:** `frontend/docs/quickstart.html` + `/docs/api.html`.
**Effort:** M

### 26. Sentry + UptimeRobot integration
**Fix:** Error tracking + uptime 5min check.
**Effort:** M

### 27. CI/CD pipeline (`.github/workflows/deploy.yml`)
**Fix:** Lint + audit + tests + auto-deploy.
**Effort:** L

### 28. cors@2.8.5 → ^2.8.7 upgrade
**Archivo:** `backend/package.json`
**Effort:** S

---

## TIER — COSMÉTICOS (SIN TIMELINE)

### 29. Reconciliation valida TP/SL órdenes activas
**Archivo:** `backend/server.js:2028`
**Fix:** Pull open orders per symbol, validar cada pos tiene TP+SL.
**Effort:** M

### 30. TP limit timeout (4h cancel + market close)
**Archivo:** `backend/broker.js:390-424`
**Effort:** M

### 31. Commented legacy code cleanup
**Archivo:** `app.html:5548-5567`
**Effort:** S

### 32. Brand inconsistencia "RX Pro" vs "RX PRO"
**Archivos:** landing.html:14, app.html:6
**Fix:** Standardizar.
**Effort:** S

### 33. Status page público (`/status.html`)
**Fix:** Simple HTML que consulta `/health`.
**Effort:** S

---

## Tracking

- Items 1-8: **Semana 1** post-launch. Target: cerrar todos.
- Items 9-28: **Semanas 2-4**. Priorizar por user reports y data real.
- Items 29-33: Backlog. Cerrar cuando haya space.

---

## KPIs para monitorear post-launch

### Financieros
- **Win rate vivo vs backtest** (APEX): diferencia <5pp aceptable; >10pp requiere investigación
- **Drawdown máximo observado** vs claimed 24% (APEX PRO+) / 4.58% (ULTRA holdout)
- **PF rolling 30d vs claimed**: divergencia >20% trigger alert
- **Settlements ejecutados / oportunidades detectadas** (efficiency del autotrade)

### Operativos
- **Uptime %** (target 99.5%)
- **p95 response time** `/api/broker/place-order` (<2s ideal)
- **Webhook success rate** Stripe/MP/NOWPayments (>99%)
- **Reconciliation discrepancies** detectadas por día
- **Orphaned positions count** (debería ser 0)

### UX
- **Onboarding completion rate** (target >80%)
- **Activation → first trade time**
- **Support tickets por VIP activo** (proxy de confusión UX)
- **Churn 30d, 90d**

### Seguridad
- **401/403 rate** (brute force attempts indicator)
- **Admin endpoints hit count**
- **Rate limit 429 count** (abusers detection)
- **Sentry error volume** y por endpoint

Alertas en Slack/email cuando cualquier métrica se desvíe >2σ del baseline.
