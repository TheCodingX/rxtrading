# GO / NO-GO DECISION — Deploy VIP Pagos (UPDATED 2026-04-22 22:40 UTC)
**Decisor:** Auditoría técnica + legal + marketing (3 agentes fresh pass)
**Producto:** RX PRO Trading Platform — Launch VIP $600

---

## 🛑 DECISIÓN: **NO-GO** (sin cambio)

**Motivo actualizado:** 18 findings CRÍTICOS abiertos tras fresh audit. Progress incremental desde pass previo pero scope profundizado reveló nuevos issues.

---

## Delta vs audit previo (3h atrás)

| Categoría | Previo | Fresh Pass | Δ Neto |
|-----------|--------|-----------|--------|
| CRÍTICO   | 11     | 18        | +7 (nuevos detectados) |
| ALTO      | 21     | 17        | -4 (mejoras) |
| MEDIO     | 17     | 12        | -5 |
| BAJO      | 8      | 4         | -4 |

### Lo que SÍ mejoró:
- ✅ `.env` NO está en git history (`git ls-files backend/.env` → vacío)
- ✅ `escapeHtml` helper existe (aunque no aplicado a todos)
- ✅ `safeErrorMessage` helper existe (parcial)
- ✅ JWT entropy check presente (aunque débil)
- ✅ `normalizeIP` + `getClientIP` implementados
- ✅ Stats APEX unificados en 3 de 6 lugares (hero, motor card, comparative)

### Lo que NO se atacó o se descubrió nuevo:
- ❌ Secrets rotation pendiente (JWT + ADMIN + DB creds débiles, nunca rotados)
- ❌ CORS `localhost:*` acepta en production
- ❌ console.log con PII (35+ front + 3 backend con keyId/symbol/amount)
- ❌ app.html = **1.38 MB** (NEW FINDING — bloated)
- ❌ npm audit HIGH severity: tar CVEs (NEW FINDING)
- ❌ `/api/admin/autotrade/pause-all` endpoint NO EXISTE
- ❌ Close-all emergency UI sin botón
- ❌ Privacy.html / terms.html / cookies.html NO existen (GDPR risk)
- ❌ Jurisdicción legal en TOS vacía

---

## Top 12 DEPLOY BLOCKERS CRÍTICOS (actualizado)

### P0 — Obligatorios (12h trabajo)

1. **Rotate secrets** (JWT, ADMIN, Supabase DB) → Render env vars — 3h
2. **XSS sweep** 30 innerHTML residuales → `escapeHtml` o `textContent` — 4h
3. **Privacy.html / Terms.html / Cookies.html** crear — 5h
4. **Jurisdicción TOS** completar (decision legal) — 2-3h
5. **Legacy v42 DOM** eliminar div + botones onclick — 5min
6. **Engine lock server-side** place-order rechaza engine≠apex — 1h
7. **Stats PF unified** (3 lugares stale con 1.30) — 1h
8. **console.log strip** frontend + backend PII — 30min
9. **Global error middleware** en server.js — 10min
10. **Place-order transaction atomicity** BEGIN/COMMIT — 1.5h
11. **app.html reduction** externalizar libs lazy-load — 3h
12. **Close-all emergency button** UI + endpoint admin — 2h

### P1 — Hardening adicional (4h)

13. JWT entropy tighten (>=16 distinct chars)
14. Refresh token rate limit específico (5/min)
15. CORS localhost solo dev
16. Safety state DB → frontend sync on load
17. `/api/admin/autotrade/pause-all` endpoint
18. `npm audit fix` (tar CVEs)

**Total effort CRÍTICOS:** ~16h técnicas + 4-6h legal/secrets rotation.

---

## Criterios para reconsiderar GO

Reconvocar a GO decision cuando:
- [ ] 18 CRÍTICOS → 0 (todos FIXED + verificados)
- [ ] `/health` retorna `{ok:true, checks:{db,jwt,broker_keys}}` en prod
- [ ] 9 smoke tests E2E passed (ver `SMOKE-TESTS-RESULTS.md`)
- [ ] Secrets rotation confirmed en Render env vars (not `.env` local)
- [ ] `privacy.html`, `terms.html`, `cookies.html`, `refund.html` live + linked en footer
- [ ] `grep 'setApexEngine' frontend/app.html | grep -v 'apex'` → 0 matches (solo engine='apex')
- [ ] `grep 'console.log' frontend/app.html | wc -l` → <5 (sanitized errors only)
- [ ] `grep 'console.log.*keyId\|console.log.*amount\|console.log.*symbol' backend/server.js` → 0 matches
- [ ] npm audit `--audit-level=high` → 0 vulnerabilities
- [ ] Stats PF APEX: `grep -r 'PF 1.30\|PF 1.85\|PF 1.32' frontend/ | sort -u` → un solo valor O disclosure dual explícito
- [ ] `/api/broker/place-order` valida `engine === 'apex'` hardcoded
- [ ] Git tags `v1.0.0` con changelog de todos los findings fixed
- [ ] Commit limpio: `git status` sin uncommitted en archivos críticos

---

## Riesgos si se deployara AHORA

Ranking de daños potenciales (worst-case):

| Riesgo | Probabilidad | Impacto | Timeframe |
|--------|--------------|---------|-----------|
| Compromise backend via weak ADMIN_SECRET | Alta | CATASTRÓFICO | <24h |
| Account takeover vía XSS residual (30 vectors) | Media | ALTO | Semana 1 |
| GDPR fine EU (privacy.html 404) | Alta (si tráfico EU) | MEDIO ($20k-€20M) | Día 1-3 |
| Position orphan en Binance (non-atomic trades) | Media | MEDIO (confusión user) | Días 2-7 |
| Motor legacy v42 activado via DevTools | Baja (user técnico) | ALTO ($$ real) | Día 1+ |
| Fraud claim por stats inconsistent (1.30 vs 1.85) | Media | ALTO (class action) | Mes 1-3 |
| PII exposure via console logs | Alta | MEDIO (compliance) | Día 1 |

**Expected value de daño:** significativamente superior al costo de remediar (~20-25h).

---

## Path to GO (plan 5 días)

### Día 1 (6h) — Security Sweep
- 2h: Rotate secrets (Supabase password, JWT, ADMIN, Stripe, MP, NOWPayments) + Render env vars
- 1h: JWT entropy tighten + refresh rate limit + CORS prod gate
- 1h: Console.log strip (front + back) con sanitization
- 1h: Error middleware global
- 1h: Testing + verify `/health`

### Día 2 (6h) — XSS + Transactions
- 3h: XSS sweep (30 innerHTML críticas con escapeHtml/textContent)
- 2h: Place-order transaction atomicity (BEGIN/COMMIT/ROLLBACK)
- 1h: npm audit fix + retest

### Día 3 (6h) — Legal
- 2h: privacy.html (GDPR compliant)
- 2h: terms.html + completar jurisdicción (decision legal)
- 1h: cookies.html + refund.html
- 1h: Footer links + cookie banner fix + disclaimer sync landing↔app

### Día 4 (6h) — Engine Lock + Emergency + Performance
- 1h: Remove legacy v42 DOM + engine lock server-side + stats PF unify
- 1.5h: Safety state DB → frontend sync
- 1h: `/api/admin/autotrade/pause-all` + close-all UI button
- 2.5h: app.html reduction (externalize Chart.js + Firebase + lazy payment libs)

### Día 5 (4h) — Verification + GO
- 1h: Smoke tests E2E (9 flows — ver SMOKE-TESTS-RESULTS.md)
- 1h: Git commits atómicos + tag `v1.0.0`
- 1h: Re-audit CRÍTICOS → esperado 0
- 1h: **GO meeting + soft launch** a 5-10 usuarios beta (48h observación)

---

## Checklist final pre-GO (Día 5)

```
SECURITY
[ ] Secrets rotados (JWT/ADMIN/DB/Stripe/MP/NP)
[ ] Sentry captura errors (opcional P2)
[ ] Rate limits (login 10/min, refresh 5/min, trade 20/min)
[ ] JWT entropy >=16 distinct chars
[ ] CORS origin whitelist explícita
[ ] console.log strip + PII sanitized

TRADING ENGINE
[ ] Solo engine='apex' aceptado (frontend inmutable + backend hardcoded)
[ ] Legacy v42 DOM removed (grep test)
[ ] Safety gates DB sync
[ ] Reconciliation /api/broker/reconcile funcional
[ ] SPX filter hard-fail si stale (opcional P2)

LEGAL
[ ] /privacy.html live
[ ] /terms.html live + jurisdicción completa
[ ] /cookies.html + /refund.html
[ ] Footer links en landing + app
[ ] Disclaimers uniformes landing↔app

UI/UX
[ ] Stats APEX unificados (grep test)
[ ] Mobile responsive 375px
[ ] Open redirect whitelist (3.4)
[ ] Brand "RX PRO" consistente meta

INFRA
[ ] /health 200 con {ok:true}
[ ] /api/broker/status retorna safety state
[ ] Place-order atomic transaction
[ ] Global error middleware
[ ] Emergency endpoints (/pause-all, /close-all)
[ ] UptimeRobot check cada 5min (opcional P2)
[ ] Git tag v1.0.0 con changelog

PERFORMANCE
[ ] app.html <600KB gzipped
[ ] Chart.js + Firebase external + lazy
[ ] LCP landing <2.5s
[ ] TTI app <3s

SMOKE TESTS
[ ] 9/9 flows E2E passed
```

---

## Escalado

Responsable técnico único aprueba antes de deployar. Si deploy ocurre sin approval:
- Rollback inmediato via Render (ver `EMERGENCY-PLAYBOOK.md`)
- Post-mortem obligatorio

**Status actualizable** — esta decisión vigente hasta que los 18 blockers cierren.

---

## Referencias

- `PRE-DEPLOY-AUDIT-FRESH-2026-04-22-v2.md` — audit completo actualizado
- `PRE-DEPLOY-AUDIT-REPORT.md` — audit inicial (baseline)
- `SMOKE-TESTS-RESULTS.md` — plan de 9 flows E2E
- `POST-DEPLOY-WATCHLIST.md` — MEDIO/BAJO para semana 1-4 post-launch
- `EMERGENCY-PLAYBOOK.md` — procedures si incidente
