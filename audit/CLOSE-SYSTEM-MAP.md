# CLOSE-SYSTEM-MAP — flujo completo de cierre de signals y trades

**Fecha:** 2026-05-07
**Scope:** mapeo del sistema de cierre actual (pre-fix). Este doc se acompaña de
`CLOSE-SYSTEM-DIAGNOSIS.md` que identifica el root cause del bug "trades no cierran".

---

## Tres niveles independientes

```
┌────────────────────────────────────────────────────────────────┐
│  Nivel 1: signals  (tabla 'signals' — DB global compartida)    │
│  Nivel 2: signal_trades  (tabla 'signal_trades' — per-user)    │
│  Nivel 3: paperData.positions (cliente, browser localStorage)  │
└────────────────────────────────────────────────────────────────┘
```

Cada nivel tiene su propio state machine y su propio mecanismo de cierre. El bug está
**en el gap entre nivel 1 y nivel 2** (ver DIAGNOSIS).

---

## Nivel 1 — `signals` (global)

**Schema** (`backend/database.js` líneas 177–222):
- `state TEXT` ∈ `{NEW, ACTIVE, TRADED, EXPIRED, SUPERSEDED, CANCELED}`
- `outcome TEXT` ∈ `{NULL, WIN, LOSS, NO_HIT}`
- `outcome_price NUMERIC` precio de cierre (TP, SL, o último close)
- `closed_at TIMESTAMPTZ`
- `expires_at TIMESTAMPTZ` (ts + TTL = ts + 4h)

**State machine** (`backend/signal-store.js` líneas 33–40):
```
NEW → ACTIVE   (auto al insertar)
ACTIVE → TRADED       (cuando user opera vía POST /api/signals/:id/operate)
ACTIVE → EXPIRED      (cron al pasar TTL O al detectar TP/SL hit)
ACTIVE → SUPERSEDED   (no usado actualmente — anti-spam dedup keeps the first)
ACTIVE → CANCELED     (admin override)
```

**Mecanismos de cierre activos:**

| Trigger | Función | Frecuencia | Resultado |
|---|---|---|---|
| TP/SL hit detectado | `runTpslMonitorCycle` (signal-cron.js l.208–309) | cada 30s | state→EXPIRED, outcome=WIN/LOSS, outcome_price=tp/sl |
| TTL expirado | `runExpirationCycle` (signal-cron.js l.32–48) → `expireStale` (signal-store.js l.301–330) | cada 60s | state→EXPIRED, outcome=COALESCE(outcome,'NO_HIT') |
| Manual admin | `transitionState` (signal-store.js l.228–270) | bajo demanda | state→CANCELED |

**Cómo TPSL detecta hit:**
- Para cada signal ACTIVE con `expires_at > NOW()`, fetch OHLC 5m de Binance fapi (fallback Bybit) desde `signal.ts` hasta ahora.
- Itera bars chronológicamente. Para BUY: si `bar.h >= tp` → WIN; si `bar.l <= sl` → LOSS. Para SELL: invertido.
- Si TP y SL caen en mismo bar (ambig): conservative LOSS.
- Si OHLC source falla: fallback a `fetchLatestCloseFallback` (legacy close-as-proxy).

**Estado: FUNCIONA** (con la condición de que la DB tenga las columnas `outcome / outcome_price / closed_at` — el user agregó manualmente vía SQL en Supabase recientemente).

---

## Nivel 2 — `signal_trades` (per-user, link signal ↔ user)

**Schema** (`backend/database.js` líneas 239–259):
- `signal_id TEXT` (FK a signals)
- `key_id INT` (FK a license_keys)
- `mode TEXT` ∈ `{paper, real_testnet, real_mainnet}`
- `trade_state TEXT` ∈ `{PENDING_OPEN, OPEN, PENDING_CLOSE, CLOSED, FAILED}`
- `open_price NUMERIC`, `close_price NUMERIC`, `close_reason TEXT`, `pnl NUMERIC`
- `binance_order_id TEXT`
- `opened_at`, `closed_at TIMESTAMPTZ`
- UNIQUE `(signal_id, key_id, mode)` — un trade por user-mode-signal.

**State machine implícito:**
```
PENDING_OPEN → OPEN          (al confirmar fill)
OPEN → PENDING_CLOSE         (en flight de cierre)
PENDING_CLOSE → CLOSED       (al confirmar cierre)
ANY → FAILED                 (error fatal)
```

**Apertura:**
- Endpoint `POST /api/signals/:id/operate` (server.js l.1140s+) → `sigStore.openTradeForSignal` (signal-store.js l.348–390)
- Para `mode='real_*'`: además `broker.placeTradeWithTPSL` (broker.js l.237+) coloca:
  - Entry order MARKET (línea 395+)
  - TP como `TAKE_PROFIT_MARKET` con `reduceOnly=true` (línea 487+)
  - SL como `STOP_MARKET` con `reduceOnly=true` (línea 525+)
- Si placeTradeWithTPSL falla TP/SL → emergency close (línea 460+).

**Cierre — DOS mecanismos disponibles**:

| Trigger | Función | Frecuencia | Modos cubiertos | Estado |
|---|---|---|---|---|
| Frontend client-side detecta TP/SL en `paperData.positions` y llama endpoint | `closePaperTrade` → `POST /api/signals/trades/:tradeId/close` (server.js l.1170–1218) | depende del browser abierto | paper | **FRÁGIL — depende de browser activo** |
| Binance ejecutó TP/SL automático, reconcile detecta posición ausente | `runReconcileCycle` → `sigStore.closeTrade` con `reason='RECONCILE_EXTERNAL'` (signal-cron.js l.60–135) | cada 5min | real_testnet, real_mainnet | OK con caveats |

**Lo que NO existe:**
- Cron server-side que cierre `signal_trades` cuando el `signal` asociado pasó a EXPIRED con outcome.
- Cron server-side que cierre paper trades por TP/SL hit.
- Cron server-side que cierre paper trades por TIME_STOP cuando `signal.expires_at < NOW()`.

→ **Este es el gap que produce los trades zombie.** Ver DIAGNOSIS.

---

## Nivel 3 — `paperData.positions` (cliente)

**Storage:** browser localStorage + sync a `user_paper_data` table vía `POST /api/user/paper` (server.js l.2101–2126, last-write-wins).

**Cierre client-side** (frontend/app.html l.15310–15336):
```js
paperData.positions.forEach(p => {
  if (p.tp && p.dir==='BUY' && cur >= p.tp) toClose.push({reason:'TP_HIT', exitPrice:p.tp});
  else if (p.tp && p.dir==='SELL' && cur <= p.tp) toClose.push({reason:'TP_HIT', exitPrice:p.tp});
  else if (p.sl && p.dir==='BUY' && cur <= p.sl) toClose.push({reason:'SL_HIT', exitPrice:p.sl});
  else if (p.sl && p.dir==='SELL' && cur >= p.sl) toClose.push({reason:'SL_HIT', exitPrice:p.sl});
});
toClose.forEach(c => closePaperTrade(c.id, c.exitPrice, c.reason));
```

**Requisitos para que funcione:**
1. Browser tab abierta.
2. WS de futuros entregando `px[sym]` actualizado (chequeo de staleness <60s).
3. Trade abierto >10s (anti-glitch).
4. `closePaperTrade` llama el endpoint REST y persiste vía sync.

**Falla cuando:**
- Browser cerrado → no hay polling → no se detecta TP/SL.
- WS down → `px[sym]` stale → skip de todos los trades >60s.
- Multi-device: si user opera en mobile y abre en desktop, el reciente sync tira las positions del otro.

---

## Otros mecanismos relevantes

### Safety gates (cliente)
- `frontend/app.html` (no leído en detalle aquí): daily loss stop (-5% equity), DD peak (-25%), circuit breaker (5 losses/6h), min balance ($100), max deployed (50% equity).
- Disparan cierre masivo client-side, pero sólo si la app está abierta.

### Reconciliación broker
- `runReconcileCycle` (signal-cron.js l.60–135), cada 5min.
- Para cada `broker_configs.is_active=1`: query Binance positions, compara con DB.
- Si DB tiene OPEN y Binance no → `closeTrade(reason='RECONCILE_EXTERNAL')` ✓
- Si Binance tiene posición y DB no → log + `_onReconcileDivergence` callback (no auto-fix).

**Caveats**:
- 5min de lag mínimo después de cierre real.
- Si user revocó key/license (`is_active=0`), no reconcilia más.
- Si Binance API down → catch silently, no cierra hasta que vuelva.

### Per-trade structured log
- Ya implementado hoy (signal-cron.js l.295+): cada trade que cierra emite `[SignalCron][TRADE]` con todos los detalles.
- Pero **solo a nivel signal**. Para signal_trades no hay equivalente.

---

## Endpoints relevantes

| Endpoint | Método | Función |
|---|---|---|
| `POST /api/signals/:id/operate` | POST | Abrir trade (paper o real) sobre una signal |
| `POST /api/signals/trades/:tradeId/close` | POST | Cerrar un trade del user (frontend-driven) |
| `POST /api/broker/reconcile` | POST | Forzar reconcile manual |
| `GET /api/admin/health-v447` | GET | (recién agregado) Live health stats V44.7 |

**No existen aún (pero deberían):**
- `GET /api/admin/open-trades` — listar todos los OPEN del sistema, edad, status
- `POST /api/admin/close-zombie-trades` — emergencia masiva
- `POST /api/admin/close-user-trades` — cerrar todos de un user

---

## Resumen visual del flujo

```
┌─────────────────────┐
│ V44 engine genera   │
│ signal              │
└──────────┬──────────┘
           ↓
┌─────────────────────┐    cron 30s OHLC intrabar
│ signal ACTIVE       │ ←──────────────────────────┐
│ (DB)                │                             │
└──────────┬──────────┘    cron 60s TTL expire     │
           │                                        │
           │ user opera       ┌─────────────────────┴─┐
           ↓                  │ TP/SL hit detected →   │
┌─────────────────────┐       │ signal → EXPIRED       │
│ signal_trades OPEN  │       │ outcome=WIN/LOSS       │
│ (DB, per-user)      │       └────────────────────────┘
│ - mode=paper        │              │
│ - mode=real_*       │              │ ❌ NO HAY CRON QUE PROPAGUE
└──────────┬──────────┘              │    el cierre del signal a los
           │                         │    signal_trades asociados.
           │                         │
   ┌───────┴────────┐                │
   │                │                ↓
   ↓                ↓        signal_trades quedan OPEN
   paper           real_*    para siempre (zombies).
   ↓                ↓
   browser         Binance
   client-side     reconcile
   only            cycle 5min
   (frágil)        (ok caveats)
```

---

## Archivos del sistema de cierre

```
backend/signal-cron.js       # cron jobs (expire, reconcile, tpsl)
backend/signal-store.js      # state machine + queries
backend/database.js          # schema
backend/server.js            # endpoints REST
backend/broker.js            # placeTradeWithTPSL + closePosition
frontend/app.html            # cliente paper TP/SL detection
```

Próximo doc: **`CLOSE-SYSTEM-DIAGNOSIS.md`** con el root cause exacto y plan de fix.
