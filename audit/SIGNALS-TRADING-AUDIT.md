# SIGNALS-TRADING-AUDIT — FASE 2
Fecha: 2026-04-24
Scope: áreas A-E vs checklist del protocolo.

Leyenda: ✅ PASS · ❌ FAIL · ⚠️ UNCLEAR/PARTIAL

---

## ÁREA A — GENERACIÓN DE SEÑALES

### A.1 Unicidad de señales
- ❌ **No existe `signalId` determinístico.** El código usa `paperLastSig`/`vipLastSig` como objeto crudo con `timestamp` pero no genera un hash estable.
- ⚠️ `_firedSigHashes` (app.html:12715) existe pero solo para el banner de nueva señal, dedup por `sym+dir+confBucket` (collision-prone).
- ❌ No hay estructura `Map<signalId, signal>` indexada.
- **Fix requerido**: generar `signalId = sha1(sym+dir+Math.round(ts/60000)+engine+tpRound+slRound)` al emitir, persistir en cache y dispatch.

### A.2 Estabilidad de señal
- ⚠️ `_v44SigCache[sym]` mantiene TP/SL mientras dure TTL — **parcial PASS**.
- ❌ Post-breach (`app.html:10310-10317`) la purga regenera señal fresca con **nuevo entry/TP/SL** al precio del momento → mutación visible.
- **Fix requerido**: al breach, marcar `_closed:true,reason` y NO regenerar dentro del TTL.

### A.3 Expiración
- ✅ TTL 4 h implementado (`v44TTL_MS = 4*60*60*1000`).
- ✅ `applyPaperSignal` valida ventana operable (`hold_hours * 3600 - 10min`).
- ⚠️ No hay log explícito cuando expira; solo `delete _v44SigCache[key]` silencioso.
- **Fix menor**: `console.info('[V44] signal expired', sym)` + entrada en history como "EXPIRED_UNOPERATED".

### A.4 Scan loop concurrency
- ✅ `_paperSigRefreshRunning` (app.html:14606-14676) previene re-entry.
- ✅ Scan interval 30 s paper / 15 s VIP (app.html:19927).
- ⚠️ Múltiples `setInterval` coexisten: paper (30 s), VIP (15 s), broker status (30 s), reconcile (5 min). Correcto; cada uno con su propio mutex.

### A.5 Persistencia
- ✅ `_v44SigCache` persiste en `localStorage['rx_v44_sig_cache']`.
- ✅ Cooldowns persisten en `localStorage['rx_gensig_cooldowns']`.
- ❌ **No hay Map de `signalId → operatedTradeIds`** en localStorage. Al refresh se pierde la lista de qué señales ya se operaron → re-dispatch posible.
- **Fix requerido**: persistir `_operatedSignalIds: Set<signalId>` con TTL 4 h.

---

## ÁREA B — EJECUCIÓN DE TRADES

### B.1 Deduplicación pre-open
- ⚠️ `autoTradeFromSignal` deduplica **por símbolo** (`positions.find(p=>p.sym===sym)`) y por cooldown 30 s. **NO por signalId.**
- ❌ `applyPaperSignal` (botón OPERAR) no deduplica por signalId.
- ❌ Doble-click sobre OPERAR → mutex sync ineficaz → puede crear 2 trades.
- ✅ Backend `/api/broker/place-order` tiene `X-Idempotency-Key` + `pg_advisory_xact_lock` (server.js:1919-1986) → real autotrading SÍ deduplica.
- **Fix requerido frontend**: `_operatedSignalIds` set + mutex asincrónico con await savePaper completo.

### B.2 Atomic state transitions
- ❌ Paper trade no tiene estados formales. Posiciones son `{id,sym,dir,amt,entry,tp,sl,time}` sin campo `state`.
- ❌ No hay `PENDING_OPEN/OPEN/PENDING_CLOSE/CLOSED`.
- ✅ Backend sí tiene `broker_trade_log` con `status` (`open|closed|closed_reconciled`).
- **Fix requerido**: agregar `state: 'OPEN'|'PENDING_CLOSE'|'CLOSED'` + `closeReason`.

### B.3 TP/SL placement
- ✅ Paper: TP y SL guardados junto a la posición; chequeados en cada `renderPaper`.
- ✅ Real: `broker.placeTradeWithTPSL` coloca 3 órdenes atomicas (entry → TP → SL) con `clientOrderId` único (broker.js:302).
- ✅ Si TP/SL placement falla en real → `emergencyClosed:true` (server.js:2020).
- PASS completo.

### B.4 Cierre con razón categorizada
- ❌ `closePaperTrade(id, exactExitPrice)` NO tiene parámetro `reason`.
- ❌ `paperData.history.push({...pos,exit,pnl,closedAt})` no persiste razón.
- ❌ Toast único para todos los cierres: `"Cerrado ${sym} — P&L: $X"`.
- ❌ Ni TP_HIT ni SL_HIT ni MANUAL_CLOSE distinguidos.
- ✅ Backend real `/api/broker/trade-result` registra PnL pero no reason explícita.
- **Fix obligatorio**: parámetro `reason`, persistir en history, toast con razón, UI con badge de razón.

### B.5 Paper / live parity
- ✅ Misma señal V44 usada por paper y real (mismo `genApexV44LiveSignal` + cache compartido).
- ✅ Mismos TP/SL calculados.
- ⚠️ **Slippage diferente**: paper usa precio exacto del TP/SL (`exactExitPrice`), real sufre slippage Binance. Aceptable.
- ⚠️ Safety gates: real tiene DB-persisted (daily_loss_current, circuit_breaker_until); paper no tiene circuit breaker.
- **Fix requerido**: aplicar circuit breaker y daily stop al paper también para paridad perfecta.

---

## ÁREA C — UI / VISUALIZACIÓN

### C.1 Estados de señal visibles
- ⚠️ Activa: sí, se muestra card con confidence/entry/TP/SL/timestamp.
- ❌ "OPERADA": no hay badge explícito cuando se operó la señal actual.
- ❌ "EXPIRADA": no hay UI para señal expirada.
- ❌ "DESCARTADA": tampoco.
- **Fix**: badge en el card ("✓ OPERADA", "⏱ EXPIRADA", "✕ DESCARTADA").

### C.2 Estados de trade
- ✅ Trade abierto: visible con entry, tamaño, leverage, TP/SL, PnL unrealized.
- ❌ Trade cerrado: muestra PnL pero **no razón**.
- ❌ Historial: no muestra razón.
- **Fix**: agregar columna reason + icon al historial.

### C.3 Gráfico
- ✅ Entry, TP, SL dibujados con líneas horizontales.
- ❌ Marker de cierre ausente. Si TP se tocó en un wick intrabar invisible al TF, usuario no ve nada.
- ❌ No hay línea vertical con timestamp+razón de cierre.
- **Fix**: dibujar X rojo/verde en el timestamp de cierre con label `TP_HIT @ hh:mm:ss`.

### C.4 Notificaciones
- ✅ Toast al aparecer señal nueva.
- ⚠️ Toast al abrir trade: `"${dir} ${sym} — $amt x${lev}"` sin estado de confirmación.
- ❌ Toast al cerrar: sin razón.
- ❌ Safety gate activate: no hay toast crítico.
- **Fix**: toast destacado (rojo, 8 s) con razón específica al cerrar + safety gate.

---

## ÁREA D — LIVE AUTOTRADING MAINNET

### D.1 Precondiciones
- ✅ Verifica license VIP válida en `/api/broker/place-order` (verifyToken middleware).
- ✅ Verifica broker configurado (`SELECT * FROM broker_configs WHERE is_active=1`).
- ✅ Balance mínimo chequeado (`accountSnapshot` + limits).
- ⚠️ Onboarding: existe en frontend (`localStorage.rx_onboarded`) pero no validado backend.
- ✅ Safety limits configurables (`max_position_usd`, `max_leverage`, `daily_loss_limit_usd`).
- **Fix menor**: backend valida `onboarding_completed=true` en la license table.

### D.2 Order placement mainnet
- ✅ Saldo verificado (`getAccountInfo` antes de place).
- ✅ Leverage ≤ max (hardcoded 20x backend, configurable por user).
- ✅ Amount ≤ max_position_usd (server-side).
- ✅ Symbol precision: `roundToStep(qty, stepSize)` en broker.js.
- ✅ Binance response verificada: `orderId`, `status`.
- ⚠️ Retry: no hay retry explícito con backoff en place-order. Si Binance responde 500, devuelve error al usuario.
- **Fix**: 3 retries con backoff 500ms/1s/2s en `placeTradeWithTPSL` para 5xx responses (no para 4xx).

### D.3 Position reconciliation
- ✅ `/api/broker/reconcile` cada 5 min (frontend interval + backend endpoint server.js:2208).
- ✅ Detecta posiciones cerradas en Binance sin log local.
- ✅ Global rate-limit 20/min para proteger Binance API.
- ⚠️ Si hay divergencia, marca `status='closed_reconciled'` en log, **no notifica al admin**.
- **Fix**: al reconciliar discrepancias, loggear con WARN + considerar alert webhook.

### D.4 Binance WebSocket
- ✅ listenKey obtenido via `/api/broker/listen-key` (server.js:2114).
- ✅ Frontend connect WS directo (app.html:7337-7401).
- ✅ Keep-alive cada 30 min (`POST /api/broker/listen-key-keepalive`).
- ⚠️ Reconnect automático: no verificado explícitamente. `ws.onclose` debería re-conectar — chequear.
- **Fix menor**: reconnect con backoff exp + log.

### D.5 Rate limiting
- ✅ Rate limit global: `brokerLimiter` (60/min por keyId).
- ✅ Reconcile limiter global 20/min.
- ⚠️ No hay weight tracking de Binance REST (los endpoints tienen pesos distintos, `getAccountInfo=5`, `placeOrder=1`, etc.).
- **Fix menor**: middleware que suma weight y pausa si >80% del pool/min.

### D.6 Funding rate awareness
- ✅ V44 engine es funding carry → detecta settlement windows internamente.
- ✅ `apexMacroSpxGate` chequea direction vs SPX macro.
- ✅ UTC timestamps consistentes.
- PASS.

### D.7 Eventos extremos
- ✅ `checkMarketVolatility` (app.html:15083) bloquea autotrade si danger ≥ 7.
- ✅ Exchange maintenance: Binance devuelve 5xx → error retornado al usuario (no crash).
- ⚠️ API keys revocados: no hay detección proactiva; solo fail en el próximo request.
- ⚠️ Flash crash: detectado por multi-factor danger score pero no cierra posiciones existentes.
- **Fix**: en danger ≥ 9, pausar autotrade + mostrar alert; cierre automático solo si DD > safety threshold.

---

## ÁREA E — PAPER / LIVE PARITY

### E.1 Separación clara
- ✅ Paper: `paperData` en localStorage + Firestore sync.
- ✅ Real: `broker_configs` + `broker_trade_log` en PostgreSQL.
- ✅ Nunca se mezclan: paper simula fills; real ejecuta en Binance.
- PASS.

### E.2 Configuración espejo
- ✅ Mismo engine V44 para ambos (`genApexV44LiveSignal`).
- ✅ Mismo TP/SL calculado.
- ❌ Safety gates divergen: real tiene circuit breaker + daily stop; paper NO tiene circuit breaker.
- **Fix**: aplicar mismos gates al paper para paridad completa.

### E.3 Transición paper → live
- ✅ Usuario puede probar paper sin broker.
- ✅ Activar broker real requiere API keys + safety limits.
- ⚠️ No hay confirmación explícita "pasar a dinero real" con re-check de términos.
- ⚠️ Performance paper se muestra distinto de live (balance separado).
- **Fix**: modal de confirmación al conectar broker real ("Dinero real — riesgo de pérdida" + checkbox terms).

---

## RESUMEN SCORE

| Área | PASS | FAIL | UNCLEAR | Nota |
|------|------|------|---------|------|
| A (señales) | 4 | 3 | 2 | signalId inexistente, estabilidad rota post-breach, persistencia parcial |
| B (ejecución) | 2 | 4 | 1 | dedup frontend roto, cierre sin razón, paper sin circuit breaker |
| C (UI) | 3 | 5 | 2 | sin badges de estado, sin razón visible |
| D (real) | 12 | 0 | 4 | sólido, faltan retries + detección API revoke |
| E (parity) | 3 | 1 | 1 | paper sin safety gates del real |

**Críticos a fixear en FASE 3**:
1. signalId determinístico + `_operatedSignalIds` set.
2. `closePaperTrade(id, exitPrice, reason)` con persistencia y toast.
3. Mutex openPaperTrade efectivo (async + finally).
4. Estabilidad post-breach (flag en lugar de regenerar).
5. UI: badges de estado + marker de cierre en chart.
6. Paper: circuit breaker + daily stop mirror del real.

**Post-launch**:
- Retries con backoff real autotrading.
- Detección proactiva API key revoke.
- Binance weight tracking.
- WS reconnect con backoff.
