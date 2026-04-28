# TESTNET SMOKE RESULTS — FASE 5
Fecha: 2026-04-24

## Estado de ejecución

**⚠ NO EJECUTADO EN TESTNET REAL.**
Motivo: requiere API keys de Binance Futures testnet (`BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_API_SECRET`) + cuenta testnet con balance USDT simulado. Estos secretos no están provisionados en el entorno actual.

Este documento sirve como **protocolo reproducible** para correr el smoke manualmente antes de deploy mainnet.

---

## Pre-requisitos

1. Cuenta Binance Futures testnet activa: https://testnet.binancefuture.com
2. API keys generadas con permisos Futures + Enable Futures.
3. Balance testnet USDT ≥ $1 000.
4. Variables de entorno en backend:
   ```
   BINANCE_TESTNET=true
   BROKER_MASTER_KEY=<clave AES-256 hex 64 chars>
   DATABASE_URL=<postgres testnet-ready>
   ```
5. Usuario con license VIP válida en la base (`licenses.keys`).

---

## Protocolo

### P1 — Conexión broker
```
POST /api/broker/connect
Body: { apiKey, apiSecret, label:'testnet-smoke' }
Auth: Bearer <JWT VIP>
```
**Expected**: `{ ok:true, balance: <número>, mode:'testnet' }`.
**Fail si**: 400 sin balance ni mode.

### P2 — Verificar safety limits por defecto
```
GET /api/broker/status
```
**Expected**: `{ connected:true, mode:'testnet', dailyLimit:500, maxLeverage:20, maxConcurrent:4, consecutiveLosses:0 }`.

### P3 — Place order TESTNET
```
POST /api/broker/place-order
Headers: X-Idempotency-Key: smoke-test-001
Body: { symbol:'BTCUSDT', side:'BUY', usdAmount:100, leverage:5, tp:<precio+1%>, sl:<precio-1%>, currentPrice:<precio-actual> }
```
**Expected**:
- `{ ok:true, orderId:<n>, tpOrderId:<n>, slOrderId:<n> }`
- Posición visible en Binance testnet.
- 3 órdenes: entry (market), TP (take_profit_market), SL (stop_market).

### P4 — Idempotency
Repetir P3 con **mismo `X-Idempotency-Key`**.
**Expected**: mismo response cacheado, NO segunda orden en Binance.

### P5 — Reconcile
```
POST /api/broker/reconcile
```
**Expected**: si la posición sigue abierta, `{ ok:true, reconciled:0 }`. Si TP/SL ya fillearon, `reconciled:1` con update en `broker_trade_log`.

### P6 — Circuit breaker
Simular 5 pérdidas consecutivas (abrir/cerrar 5 trades perdedores):
- Cada close-with-loss incrementa `consecutive_losses`.
- Al 5º, backend setea `circuit_breaker_until = NOW() + 6h`.
- Próximo `/api/broker/place-order` → `400 { error:'Circuit breaker activo...' }`.

### P7 — Daily loss stop
Acumular `daily_loss_current >= daily_loss_limit_usd`.
**Expected**: próximo place-order → `400 { error:'Límite diario de pérdida alcanzado' }`.

### P8 — Rate limiting
Spam 65 requests en <60 s a `/api/broker/place-order`.
**Expected**: response 60+ con `429 { error:'Too many requests' }` (brokerLimiter configurado a 60/min).

### P9 — ListenKey WebSocket
```
POST /api/broker/listen-key
```
**Expected**: `{ ok:true, listenKey:<string>, host:'wss://stream.binancefuture.com' }`.
Conectar `wss://stream.binancefuture.com/ws/<listenKey>` → recibe `ACCOUNT_UPDATE` tras cada fill.

### P10 — Paper/live parity
Generar una señal V44 BUY en VIP (mainnet mode false).
- Abrir en paper con el mismo TP/SL.
- Abrir en testnet real (P3) con mismo symbol/side/amount.
- Esperar a que una de las dos cierre.
- **Expected**: ambas cierran por mismo motivo (TP_HIT o SL_HIT), diferencia de slippage <0.3%.

---

## Checklist de aprobación pre-mainnet

| # | Ítem | Status |
|---|------|--------|
| P1 | Conexión testnet ok | ⏸ pending (requiere creds) |
| P2 | Safety limits visibles | ⏸ |
| P3 | Place order 3× (entry/TP/SL) atómico | ⏸ |
| P4 | Idempotency key bloquea duplicados | ⏸ |
| P5 | Reconcile detecta fills externos | ⏸ |
| P6 | Circuit breaker tras 5 losses | ⏸ |
| P7 | Daily stop tras límite diario | ⏸ |
| P8 | Rate limiting 429 al pasar 60/min | ⏸ |
| P9 | ListenKey + WS receive fills | ⏸ |
| P10 | Paper/live parity ≤0.3% slippage | ⏸ |

## Nota para Deploy

Este smoke DEBE ejecutarse en testnet antes de habilitar mainnet para usuarios VIP pagos. El GO/NO-GO (FASE 6) condiciona el deploy mainnet a la ejecución exitosa de P1-P10.

Sin credenciales en esta sesión, la decisión se emite con smoke **diferido** — lo cual sigue siendo válido porque los fixes de FASE 3 no tocan el código de ejecución real (backend broker.js + server.js /place-order), que ya estaba probado previamente según `audit/PRE-DEPLOY-AUDIT-FRESH-2026-04-22-v2.md`. Los cambios de esta auditoría son quirúrgicos al frontend paper + dedup/reason UI, que están cubiertos por la suite E2E `signals-trading.test.js` (22/22 PASS).
