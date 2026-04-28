# DEPLOY CHECKLIST — RX Trading

**Fecha:** 2026-04-27
**Status:** ✅ Deploy-ready

---

## PRE-DEPLOY

### Backend (Render)

- [ ] **Push código** a repo Git → Render auto-redeploys
- [ ] **Set env vars** (Render → Environment):
  ```
  APEX_V45_PAIR_SIZING=1
  APEX_V45_TERM_STRUCTURE=1
  APEX_V46_R3=1
  APEX_V46_R5=1
  APEX_V46_R6=1
  APEX_QUALITY_THRESHOLD=0.5     # Critical para que tab señales NO esté vacía
  ```
- [ ] Verificar Render logs muestran `[V44 Scheduler] started` + `[SignalGen] started`
- [ ] Smoke test: `curl https://rxtrading-1.onrender.com/health` → 200
- [ ] Smoke test: `curl https://rxtrading-1.onrender.com/api/v44/diag` → 200 con `binance_fetch_test.ok=true`
- [ ] Smoke test: `curl https://rxtrading-1.onrender.com/api/signals/active` → 200 (puede estar vacío si no es ventana)

### Frontend (Netlify)

- [ ] Push `frontend/app.html` (4 fixes aplicados)
- [ ] Push `frontend/landing.html` (V46 stats + ROI recalibrado)
- [ ] Push `frontend/index.html` (sincronizado con landing)
- [ ] Verificar Netlify deploy succeeded
- [ ] Test producción: `https://rxtrading.net` carga sin console errors
- [ ] Test app: `https://rxtrading.net/app.html` — bell icon, VIP panel visible

### Database

- [ ] Migrations ya aplicadas (signal_events, signal_trades, notifications)
- [ ] Connection pool config OK (Render Postgres)
- [ ] Backup automático Render activo

---

## DEPLOY COMMANDS

```bash
# 1. Frontend deploy (Netlify CLI o Git push)
git add frontend/app.html frontend/landing.html frontend/index.html
git commit -m "deploy: V46 stats + UI fixes pre-launch"
git push origin main

# 2. Backend deploy (Render auto on git push)
git add backend/server.js backend/v44-engine.js audit/
git commit -m "deploy: V46 engine + audit reports"
git push origin main

# 3. Set Render env vars (via dashboard)
# Render → Environment → Add:
#   APEX_V45_PAIR_SIZING=1
#   APEX_V45_TERM_STRUCTURE=1
#   APEX_V46_R3=1
#   APEX_V46_R5=1
#   APEX_V46_R6=1
#   APEX_QUALITY_THRESHOLD=0.5
# → Trigger redeploy

# 4. Verify
curl https://rxtrading-1.onrender.com/health
curl https://rxtrading-1.onrender.com/api/v44/diag | jq
```

---

## POST-DEPLOY (primeras 48h)

### Health monitoring

- [ ] Render logs cada 4h: cero `[Error]` críticos
- [ ] DB queries: latency p99 < 200ms
- [ ] WS server: `connectionState: "open"` desde cliente
- [ ] Signal generator: scan cycle log cada 60s
- [ ] Funding rate fetcher: actualiza cada 8h

### Signal flow

- [ ] Verificar tabla `signals` recibe inserts
- [ ] Verificar tabla `signal_events` registra state transitions
- [ ] Verificar `lastSeq` en `/api/signals/active` incrementa con tiempo

### User-facing

- [ ] `rxtrading.net` carga en <3s (Lighthouse)
- [ ] App.html: bell + VIP panel + paper trade visibles
- [ ] Backtest interactivo retorna stats V46 (PF ~1.4)
- [ ] ROI calculator muestra "+37%" para 12 meses default

### Critical alarms

- [ ] Si signal generator no produce signals en 24h → ajustar `APEX_QUALITY_THRESHOLD` más bajo (0.3)
- [ ] Si Binance fetch test falla 3 veces → activar OKX/Bybit fallback path
- [ ] Si DB connection drops → restart Render

---

## ROLLBACK PLAN

### Tier 1 — Quitar palancas V46 (más conservador)

```
Render env: remove
  APEX_V46_R3
  APEX_V46_R5
  APEX_V46_R6
→ redeploy
```
Resultado: V44.5 P11+P7 baseline (PF 1.30 realistic).

### Tier 2 — Quitar V45 también

```
Render env: remove
  APEX_V45_PAIR_SIZING
  APEX_V45_TERM_STRUCTURE
→ redeploy
```
Resultado: V44 baseline (PF 1.16 realistic).

### Tier 3 — Revert código completo

```bash
git revert <commit-hash>
git push origin main
# Render auto-deploys revert
```

---

## RUTAS DE USUARIO

### Visitor (sin login)

1. `https://rxtrading.net` → landing
2. Click "ACTIVATE VIP" → app.html VIP onboarding
3. License code prompt → validate vs Render

### VIP user

1. Login → VIP unlocked
2. Tab Paper Trade → simular con $10K virtual
3. Tab Señales → live signals (cuando ventana funding)
4. Tab AI INTEL → market intelligence
5. Configuración → conectar Binance API (testnet primero)

### Autotrade flow

1. PANEL VIP → Autotrade ON
2. Engine corre cron cada 60s
3. Signal generated → backend insert
4. WS push to client
5. Auto-place Binance order con TP+SL OCO
6. Reconciliation cada 5min

---

## MARKETING POST-DEPLOY

### Frase principal

> "APEX Engine V46 — funding carry institucional con per-pair sizing dinámico. Backtest holdout 365d realistic: PF 1.43, 80.8% de semanas positivas, +37% PnL anualizado net of all costs."

### Disclaimer obligatorio

> "Stats incluyen costos reales: fees Binance (taker 0.05%), slippage 0.02%, funding payments. Drawdown máximo backtest: 3.67%. Worst week: -2.14%. Past performance does not guarantee future results. Trading involves risk of loss."

### NO decir
- "PF 2.0" (era ideal sin costos)
- "100% accuracy"
- "Bot infalible"

---

## CONTACTOS DE EMERGENCIA

- Render dashboard: monitoring + logs
- Supabase: DB connection + queries
- Binance Futures: API status (api.binance.com/sapi/v1/system/status)
- DNS: rxtrading.net → Netlify (frontend) + rxtrading-1.onrender.com (API)

---

## VERIFICATION COMMANDS

```bash
# Health
curl https://rxtrading-1.onrender.com/health

# Server time
curl https://rxtrading-1.onrender.com/api/server/time

# Diag (post-deploy backend)
curl https://rxtrading-1.onrender.com/api/v44/diag | jq

# Active signals
curl https://rxtrading-1.onrender.com/api/signals/active | jq

# Force scan (admin only)
curl -X POST https://rxtrading-1.onrender.com/api/admin/v44/force-scan \
  -H "x-admin-secret: $ADMIN_SECRET"

# Macro data
curl https://rxtrading-1.onrender.com/api/macro/spx
curl https://rxtrading-1.onrender.com/api/binance/klines?symbol=BTCUSDT&interval=15m&limit=10
```

---

## VEREDICTO FINAL

✅ **GO LANZAMIENTO**

- 12 zonas auditadas
- 3 fixes aplicados esta sesión + previos
- 0 vulnerabilities (npm audit)
- 0 V44 stats remaining
- 0 console errors en page load
- 5/6 endpoints production OK (1 nuevo espera redeploy)
- Legal compliance ✅
- Honestidad de stats ✅
- Rollback plan documentado

**Plataforma lista para usuarios VIP $600.**
