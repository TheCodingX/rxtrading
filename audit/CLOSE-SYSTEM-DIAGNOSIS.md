# CLOSE-SYSTEM-DIAGNOSIS — root cause de "trades no cierran"

**Fecha:** 2026-05-07
**Severidad:** CRÍTICA — capital de usuarios en riesgo.
**Acompañante:** `CLOSE-SYSTEM-MAP.md` (mapa completo del sistema).

---

## Root cause

**No existe ningún cron server-side que propague el cierre de un `signals` a sus `signal_trades` asociados.**

Concretamente:

- `backend/signal-cron.js` corre 3 cron loops:
  - `runExpirationCycle` — cierra signals expiradas (level 1) ✓
  - `runTpslMonitorCycle` — cierra signals por TP/SL hit (level 1) ✓
  - `runReconcileCycle` — cierra signal_trades cuando Binance reportó cierre externo (level 2, **solo para mode=real_***) ✓ con caveats
- **No existe `runOrphanTradeCloseCycle`** o equivalente que mire `signal_trades.trade_state IN ('OPEN','PENDING_OPEN','PENDING_CLOSE')` y los cierre cuando el signal asociado pasó a EXPIRED.

Esto significa que para `mode='paper'`:
- Si el browser está cerrado cuando TP/SL se cumple, nadie cierra el trade.
- El frontend (`frontend/app.html` líneas 15310–15336) cierra paper trades por TP/SL **client-side**, llamando `POST /api/signals/trades/:tradeId/close`. Si el user no tiene la app abierta, el trade nunca recibe ese POST.

Para `mode='real_*'`:
- Cubierto por `runReconcileCycle` cada 5min con caveats (ver `CLOSE-SYSTEM-MAP.md` sección Reconciliación). Pero si broker_config.is_active=0 (user revocó), o Binance API falla persistentemente, también queda zombie.

---

## Archivos:línea exactos

| Defecto | Ubicación | Diagnóstico |
|---|---|---|
| Falta cron de cierre nivel 2 | `backend/signal-cron.js` (líneas 311–336, función `start`) | Solo arranca 3 timers: `_expireTimer`, `_reconcileTimer`, `_tpslTimer`. No arranca un timer que cierre `signal_trades`. |
| Cierre de paper depende del browser | `frontend/app.html` línea 15310–15336 (`closePaperTrade` loop) | Lógica TP/SL totalmente client-side. Si browser cerrado, no se ejecuta. |
| Reconcile no cierra paper | `backend/signal-cron.js` línea 96–113 (`runReconcileCycle`) | Filtro `t.mode IN ('real_testnet','real_mainnet')`. Paper queda excluido. |
| Reconcile no cubre signal-EXPIRED→trade-OPEN | `backend/signal-cron.js` línea 102–113 | Compara contra Binance positions, no contra `signals.state` o `signals.outcome`. |

---

## Resultado observable

**Síntomas que el usuario vería:**
- Signals que en la sección Historial aparecen como `WIN` / `LOSS` / `NO_HIT` (state=EXPIRED)
- Pero el trade asociado en su dashboard sigue en `OPEN` con PnL flotante actualizándose con el último precio
- Si cierra el browser y vuelve días después, el trade sigue OPEN
- Si el user no entra nunca, el trade se queda OPEN para siempre, ocupando el slot del UNIQUE `(signal_id, key_id, mode)`

**Magnitud potencial:**
- En paper: cualquier signal antigua con state=EXPIRED tiene N signal_trades asociados (uno por user que operó). Todos esos quedaron OPEN si los users no estaban con browser abierto al momento del cierre del signal.
- En real_*: probablemente menos zombies (Binance ejecuta TP/SL, reconcile cierra), pero aún hay casos: si placeTradeWithTPSL falló al colocar TP/SL (broker.js línea 460+ tiene emergency close, pero si la posición se abrió y TP/SL no pegaron, queda exposed).

---

## Sub-bugs adicionales (orden de prioridad)

### Bug A — paper sin server-side close ⭐ ROOT
Descrito arriba. Es el principal.

### Bug B — race condition entre expiration y TPSL
- `runExpirationCycle` corre cada 60s, marca signals con `expires_at < NOW` como EXPIRED + outcome=NO_HIT.
- `runTpslMonitorCycle` corre cada 30s, busca con `expires_at > NOW()`.
- En el último ciclo de TTL (4h - 30s), si TPSL detecta hit pero expire corre primero, el signal queda EXPIRED+NO_HIT en vez de WIN/LOSS.
- Magnitud: ~1% de signals.

### Bug C — reconcile only-real
- Mode=paper queda completamente fuera del reconcile.
- Nada que mire paper trades server-side.

### Bug D — divergencia detectada pero no fixeada
- `runReconcileCycle` línea 117–125: si Binance tiene posición pero DB no, solo loguea + callback, no cierra ni avisa al usuario activamente.
- El `_onReconcileDivergence` callback no está conectado a notif-store o dashboard alert.

### Bug E — placeTradeWithTPSL falla parcial sin cleanup
- broker.js l.460+: si TP price out of PRICE_FILTER, hace emergency close.
- Pero si TP order falla por otra razón (network timeout transient, l.521 fallback), el código sigue intentando SL.
- Si SL también falla, posición queda exposed en Binance hasta el próximo reconcile (5min).

### Bug F — signal_trades sin trade_state index
- `idx_signal_trades_user (key_id, trade_state)` cubre per-user, pero no hay un `idx_signal_trades_state_only` para queries globales como "SELECT * FROM signal_trades WHERE trade_state = 'OPEN'".
- Cualquier cron que necesite scanear globalmente va a hacer seq scan. Performance no crítica ahora pero dolerá a escala.

---

## Plan de fix (prioridad descendente)

### FIX 1 — Cron de cierre de signal_trades cuando signal cierra (resuelve Bug A, C)
- Nuevo loop en `signal-cron.js`: `runTradeCloseCycle()` cada 30s.
- Query: trades OPEN + signal asociado con state IN ('EXPIRED','SUPERSEDED','CANCELED') AND outcome IS NOT NULL
- Para cada match:
  - Calcular pnl correcto basado en mode + open_price + outcome_price + confidence/leverage del meta
  - `closeTrade(closeReason='TP_HIT'|'SL_HIT'|'TIME_STOP'|...)` mapeando outcome→reason
  - Notif al user
- Mode=paper: cerrar inmediatamente.
- Mode=real_*: solo cerrar en DB si reconcile ya confirmó (idempotente). Si Binance todavía tiene posición pero signal cerró → priority alert para investigación manual (mismatch real preocupante).

### FIX 2 — Cron de TIME_STOP para trades sin signal (resuelve Bug A parcial)
- En el mismo `runTradeCloseCycle`: si `signal.expires_at < NOW() - 1h` y el trade sigue OPEN → cerrar con reason TIME_STOP usando precio actual.
- Margin de 1h después del TTL para dar tiempo al cron de TPSL/expire.

### FIX 3 — Race condition expire vs TPSL (resuelve Bug B)
- Cambiar query de `runTpslMonitorCycle`: incluir signals con `expires_at > NOW() - INTERVAL '5 minutes'` (overlap window) para que TPSL gane sobre expire en los últimos 5min.
- O mejor: en `expireStale`, si pasa por un signal que tiene OHLC indicando TP/SL hit en el window, llamar primero a closeSignalWithOutcome.
- Decisión: ampliar la ventana TPSL es más simple y suficiente.

### FIX 4 — Conectar reconcile divergence a notif-store (resuelve Bug D)
- En `signal-cron.js` línea 121+: si divergence, además de log + callback, llamar `notifStore.insert` para el user con severity CRITICAL.
- Y registrar en una tabla `reconcile_divergences` para dashboard admin.

### FIX 5 — placeTradeWithTPSL atómico real (resuelve Bug E)
- Si TP+SL no se colocan ambos exitosamente: cancelar lo que se haya creado + cerrar entry posición + retornar error al user.
- Hoy ya intenta esto pero no es 100% atómico — refactor del flujo broker.js.
- **Mover a backlog** — alcance grande, no necesario para la emergencia actual.

### FIX 6 — Endpoints admin (monitoring + emergencia)
- `GET /api/admin/open-trades` — todos los OPEN, edad, mode, signal state
- `POST /api/admin/close-zombie-trades` — cerrar todos los OPEN cuyo signal ya cerró
- `POST /api/admin/close-user-trades/:keyId` — emergencia user-specific
- `POST /api/admin/pause-autotrade` — global kill-switch

### FIX 7 — Recovery de zombies históricos
- Script `backend/scripts/zombie-recovery.js`:
  - List signal_trades OPEN sin justificación
  - Para cada uno: calcular cierre correcto según signal asociado
  - Cerrar con reason='RECOVERY_AFTER_BUG' + meta indicando original deba haber sido WIN/LOSS/NO_HIT
  - Generar reporte CSV con compensación sugerida

---

## Tests E2E mínimos (para evitar regresión)

| Test | Setup | Expectativa |
|---|---|---|
| T1 — paper TP hit con browser cerrado | Insert signal ACTIVE, open paper trade, marcar signal como EXPIRED+WIN | Trade pasa a CLOSED en <60s vía cron, reason=TP_HIT |
| T2 — paper SL hit con browser cerrado | Igual, outcome=LOSS | Trade pasa a CLOSED en <60s, reason=SL_HIT |
| T3 — paper TIME_STOP | Insert signal con expires_at en el pasado | Trade pasa a CLOSED, reason=TIME_STOP |
| T4 — race expire vs TPSL en último 5min | Signal con TTL muy corto, OHLC con TP hit en último bar | outcome=WIN (no NO_HIT) |
| T5 — reconcile + signal cerrada simultánea | Real trade, Binance cerró posición, signal también EXPIRED | Trade CLOSED solo una vez (idempotente) |
| T6 — divergencia Binance ↔ DB | Mock: Binance position sin trade en DB | notification a admin con severity=CRITICAL |

---

## Acción inmediata recomendada

1. **AHORA**: implementar FIX 1 + FIX 2 + FIX 6 (cron de cierre + endpoint admin + script recovery).
2. **24h post-deploy**: correr zombie recovery script en producción, generar reporte de compensación, comunicar a usuarios afectados.
3. **+72h**: review live, agregar FIX 3 + FIX 4 si hay datos que lo justifiquen.
4. **Backlog**: FIX 5 (atomicidad broker), FIX 7 a fondo, tests E2E completos en CI.

---

## Lo que NO hacemos en este sprint

- ❌ Tocar el motor V44.7 (sigue en validación, no se mezcla con esto).
- ❌ Cambiar lógica de signal-store.openTradeForSignal o broker.placeTradeWithTPSL.
- ❌ Modificar el state machine de signals.
- ❌ Tocar el frontend client-side close (sigue funcionando, es defense-in-depth complementaria).

El fix es **aditivo**: nuevo cron + nuevos endpoints + script de recovery. Ningún cambio destructivo.
