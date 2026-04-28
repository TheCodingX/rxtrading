# Ultra Audit Final — 2026-04-21

## Resumen ejecutivo

6 agentes paralelos auditaron el stack completo. **Findings consolidados por severidad**:

### 🔴 CRITICAL (deploy-blocking)
1. **i18n coverage 49%** — VIP Dashboard 0%, Onboarding Wizard 1-2%, Payment Modal 10%
2. **CSRF missing** en POST `/api/user/paper`, `/api/user/signals`, `/api/broker/trade-result`
3. **Access token en localStorage** (XSS vector) — debería ser httpOnly cookie
4. **BROKER_MASTER_KEY** debe validarse estrictamente al boot

### 🟠 HIGH
5. **Race: scanners paralelos same pair** → double execution (app.html:10165, 14603)
6. **Kill-switch código dormant** pero puede re-enable via LS corrupt
7. **Broker order dedup missing** — sin `clientOrderId`, retry causa órdenes duplicadas
8. **Multi-tab sync naive overwrite** — Tab A writes, Tab B overwrites without merge
9. **Firestore/backend sync race** — no authority designation
10. **Logout incomplete** — offline queue no se limpia
11. **Rate limit /api/keys/validate** — enumeration attack posible
12. **listenKey untracked** — multiple per user possible
13. **TOCTOU en concurrent trade placement** — advisory lock débil

### 🟡 MEDIUM
14. **4 mode selectors desync** — vip-mode-sel / paper-mode-sel / main-mode-sel / pub-mode-sel
15. **Concurrent openPaperTrade race** — balance puede ir negativo
16. **Timer cleanup on VIP toggle** — scanners duplicados
17. **Stale signal age check** — fallback a 0 si falta `ts` field
18. **localStorage no size monitoring** — QuotaExceededError posible
19. **Circuit breaker puede ser lento** — 5 losses pero en illiquid pares cae rápido
20. **Audit log keys bulk** — count agregado, no individual
21. **Broker keys decrypted cada request** — sin caching
22. **CSP unsafe-inline** — XSS high-impact
23. **Webhook secrets no monitored**
24. **Reduced-motion coverage parcial**
25. **Gold text contrast** en rgba(255,215,0,.6) bajo

### 🟢 LOW
26. **Position ID collision** (timestamp+random, rare)
27. **Toast queue overflow**
28. **WS price staleness** sin detector
29. **Cloud sync offline persistence** stale tras crash
30. **Payment recovery email TODO** no implementado

## Archivos auditados
- Backend: server.js (2,206 lines), broker.js (596), database.js (179)
- Frontend: app.html (23,340 lines), landing.html (1,903 lines)
- **Total: 28,224 líneas analizadas**

## i18n Gap quantification
- Total strings user-facing: ~615
- Translated: ~300 (49%)
- Critical gaps: VIP Dashboard (24/24 untranslated), Onboarding (200+), Payment Modal (20+)
- Tier 1 fix target: 244 strings

## Estado general
- Backend: **solid for V1**, needs pre-deploy hardening
- Frontend: **premium aesthetic** confirmed, accessibility PASS
- Data persistence: **adequate** with gaps en multi-tab + Firestore race
- Signal system: **mostly sound**, 3 race conditions identificadas

## Prioridad pre-deploy

### Inmediato (bloquea deploy)
1. Complete i18n for VIP dashboard + Onboarding
2. CSRF tokens on state-changing POST endpoints
3. CSP unsafe-inline → nonce-based
4. Logout clears all LS keys + offline queue
5. Verify BROKER_MASTER_KEY enforced at boot

### Sprint 1 post-deploy
6. Mutex/atomic for scanner same-pair
7. clientOrderId on broker orders
8. Single appMode state (eliminate 4-selector desync)
9. Multi-tab version vector
10. listenKey tracking per user

### Sprint 2
11. Decrypted keys caching
12. Webhook monitoring dashboard
13. Circuit breaker at 80% daily loss
14. LS size monitoring
15. Remove kill-switch dormant code
