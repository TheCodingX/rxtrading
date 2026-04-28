# SIGNAL SYSTEM MAP — RX Trading
**Date:** 2026-04-25 · **Phase:** 1 (Inventory)

---

## ESTRUCTURA GENERAL

```
backend/
├── server.js          (115 KB) — API server + endpoints
├── v44-engine.js      (7.5 KB) — APEX V44 funding carry engine
├── broker.js          (26 KB) — Binance Futures integration
├── mailer.js          (5.4 KB) — Email notifications
└── database.js        (7.9 KB) — Postgres pool

frontend/
└── app.html           (1.4 MB) — SPA monolítica (HTML+CSS+JS inline)
```

---

## 1 · SIGNAL GENERATION

### 1.1 Backend V44 Engine
`backend/v44-engine.js`
| Item | Línea | Responsabilidad |
|---|---|---|
| `SAFE_FUNDING_PARAMS` | 7-32 | Frozen config: TP=30bps, SL=25bps, HOLD=4h, lookback=720h |
| `evaluateFundingCarry()` | 103-155 | Genera señal V44 (BUY/SELL + confidence) |
| `fundingZScore()` | 53-62 | Z-score sobre funding proxy |
| `passQualityFilter()` | 83-87 | Threshold confidence ≥ 1.101 |
| `scanAllPairs()` | 180-195 | Escanea 15 pares en paralelo |
| `findNextEligibleHour()` | 197-207 | Settlement windows (0/8/16 UTC ± 1h) |

**Universo V44 (15 pares):** `ADA, RENDER, ARB, ETH, XRP, BTC, 1000PEPE, ATOM, LINK, POL, SOL, SUI, TRX, NEAR, INJ`

### 1.2 Frontend genSig
`frontend/app.html`
| Item | Línea | Responsabilidad |
|---|---|---|
| `genSig(sym, tf, mode)` | 10930-12100 | Generador principal multi-engine |
| `_v44SigCache` | 10945-10965 | Cache 4h (in-memory + localStorage) |
| `_genSigCooldowns` | 11008-11016 | Per-mode: strict=3h, binance=1h, scalp=1h, free=5h |
| `_isSignalBreached()` | (usado L8482) | Price-breach guard |
| HTF Trend (1H) | 11029-11051 | EMA(9,21,50)+RSI+MACD+ADX+OBV |
| 15m Confirmation | 11053-11066 | EMA(9,21)+MACD+RSI |

**Modos:** `binance/strict` (V44, 15 pairs), `scalp` (legacy 9 pairs), `frequent` (4 public pairs)

### 1.3 Endpoints REST
| Endpoint | Línea | Auth |
|---|---|---|
| `GET /api/public-signals` | server.js:2588 | No |
| `GET /api/user/signals` | server.js:1566-1584 | VIP |
| `POST /api/user/signals` | server.js:1587-1614 | VIP (optimistic concurrency) |

---

## 2 · SIGNAL STORAGE & DB

### 2.1 SQL Tables
| Tabla | Campos | Constraints |
|---|---|---|
| `user_signal_history` | key_id, data:JSON[500], updated_at | PK: key_id (UNIQUE) |
| `broker_configs` | key_id, api_key_enc, api_secret_enc, max_position_usd, daily_loss_limit_usd, max_leverage, circuit_breaker_until, consecutive_losses | PK:id, FK:key_id |

⚠️ **No hay tabla `signals` global server-side.** Cada user persiste su historial local; el server solo cachea 4h en memoria por instancia.

### 2.2 LocalStorage Keys
| Key | TTL | Líneas | Propósito |
|---|---|---|---|
| `rx_v44_sig_cache` | 4h | 10944-10965 | V44 signals |
| `rx_fired_sig_hashes` | 4h | 13357-13377 | Notification dedup |
| `rx_operated_sig_ids` | 6h | 10831-10861 | Trade dedup |
| `rx_post_loss_cooldown` | 4h | 8413-8430 | Anti-relapse |
| `rxtrading_paper_v60` | persistente | 7429-7447 | Paper data |
| `rxtrading_sighist_v70` | persistente | 7471-7480 | Local sig history |

---

## 3 · FRONTEND DELIVERY

### 3.1 WebSockets
| Stream | URL | Línea |
|---|---|---|
| Spot 5m klines | `wss://data-stream.binance.com/stream?streams=...@kline_5m` | 9706 |
| Futures 15m klines | `wss://fstream.binance.com/stream?streams=...@kline_15m` | 7731 |
| User Data | `wss://fstream.binance.com/ws/{listenKey}` | 7780-7781 |

### 3.2 Polling Intervals
| Función | Intervalo | Propósito |
|---|---|---|
| `refreshPaperSignal` | 30s | Paper scan |
| `_runRealAutoScan` | 8s | Real autotrade scan |
| `_runVipMultiScan` | manual + loop | VIP scan |
| Server poll fallback | on-demand | Cuando WS stale >60s |

⚠️ **No hay WS para señales** — frontend genera señales localmente vía `genSig()` que consulta klines.

---

## 4 · SIGNAL DISPLAY POINTS

| Zona | Función | Línea |
|---|---|---|
| Paper Trading Panel | `_updatePaperSigDisplay()` | 3700-3850 |
| VIP Zone Dashboard | `updVIPSig()` | 3600-3700 |
| Signal Lock Card | `showSignalLock()` / `updateSignalLockTimer()` | 13670-13690 |
| Toast notifications | `toast()` | 9549 |
| Banner "NUEVA SEÑAL" | `_showNuevaSenalBanner()` | (search) |
| AI INTEL trend strip | `_swingScan()` | 6090+ |

---

## 5 · STATE MANAGEMENT (in-memory)

| Var | Línea | TTL | Backed |
|---|---|---|---|
| `_signalLock` | 8668 | 5 min | NO (memoria) |
| `_vipSigRunning` | 13316 | mutex | — |
| `_paperSigRefreshRunning` | 15449 | mutex | — |
| `_realAutoTradeInFlight` | 8441 | per-symbol mutex | — |
| `_paperAutoTradeInFlight` | (added) | per-symbol mutex | — |
| `_genSigCooldowns` | 11009-11016 | per-mode | — |
| `_operatedSigIds` | 10831-10861 | 6h | localStorage |
| `_lastSignalTimes` | 9459-13380 | 4h | — |
| `_v44SigCache` | 10944-10965 | 4h | localStorage |
| `_firedSigHashes` | 13357-13377 | 4h | localStorage |
| `_postLossCooldown` | 8413-8430 | 4h | localStorage |
| `_pxTimestamp` | 8407 | live | — |
| `_realAutoTradeSymCooldowns` | 8522-8525 | 60min | — |
| `_lastGlobalTradeTs` | 8532-8535 | 4min throttle | — |

---

## 6 · DEDUPLICATION LAYERS

| Layer | Mecanismo | Clave | TTL | Entry points |
|---|---|---|---|---|
| **L1 Notification** | `_firedSigHashes` | `sym + '_' + mode` | 4h | `_runVipMultiScan` |
| **L2 Trade** | `_operatedSigIds` | `signalId` (UUID) | 6h | `openPaperTrade`, `autoTradeFromSignal` |
| **L3 Active Lock** | `_signalLock` | `_signalLock.sym/.signal` | 5min | `_runVipMultiScan`, `showSignalLock` |
| **L4 Anti-relapse** | `_postLossCooldown` | `sym + '|' + dir` | 4h | `closePaperTrade`, `autoTradeFromSignal`, `realAutoTradeFromSignal`, `_updatePaperSigDisplay`, `applyPaperSignal` |

⚠️ **No hay constraint UNIQUE server-side** — la dedup está toda en frontend + cache memoria.

---

## 7 · EXPIRATION & TTL

| Componente | TTL | Validación | Reset |
|---|---|---|---|
| `_signalLock` | 5 min | Auto-expire (Date.now > expiresAt) | TP/SL hit o expire |
| V44 Cache | 4h | `(Date.now - _cachedAt) < 4h` | Breach o TTL |
| `_firedSigHashes` | 4h | Cleanup en init | Manual en scan |
| `_operatedSigIds` | 6h | Cleanup en `rxWasSignalOperated` | Auto |
| `_postLossCooldown` | 4h | Implicit (key persiste, ignorada si exp) | Manual en close |
| Paper position | hasta TP/SL | `renderPaper` cada tick | TP/SL hit |
| Real position | hold_hours | Backend gestiona OCO en Binance | TP/SL o manual |

⚠️ **No hay cron jobs de expiración server-side.** Todo es lazy.

---

## 8 · AUTOTRADING

### 8.1 Paper Autotrade
| Función | Línea | Guards |
|---|---|---|
| `autoTradeFromSignal` | 15905-15990 | Mutex per-sym, post-loss CD, safety gate, breach, danger score, mode match |
| `openPaperTrade` | 14842-14892 | dup check, signal operated, balance, breach, post-loss CD |
| `closePaperTrade` | 14894-14960 | reason enum obligatoria |

### 8.2 Real Autotrade
| Función | Línea | Guards |
|---|---|---|
| `_runRealAutoScan` | 8362-8373 | setInterval 8s |
| `realAutoTradeFromSignal` | 8439-8610 | Per-symbol mutex, post-loss CD, entry validation, price freshness (30s), breach, mode==binance, macro gate, min conf, vol protect, per-sym CD 60min, global throttle 4min, position dup |
| `POST /api/broker/place-order` | server.js:1916-2070 | X-Idempotency-Key, max position, max leverage, daily loss, circuit breaker, concurrent positions, capital deployed % |

---

## 9 · TRADE LIFECYCLE

### 9.1 Paper
```
genSig → dedup (L1) → safety + post-loss → alert + display
   → openPaperTrade (dedup L2) → renderPaper TP/SL eval → closePaperTrade(reason)
```

### 9.2 Real
```
_runRealAutoScan → realAutoTradeFromSignal (mutex+gates+price freshness+breach)
  → POST /api/broker/place-order → broker.placeTradeWithTPSL → Binance OCO
  → User Data WS escucha fills → close OCO automático en TP/SL
```

### 9.3 RX_CLOSE_REASON enum
`TP_HIT, SL_HIT, MANUAL_CLOSE, SAFETY_GATE_DAILY, SAFETY_GATE_DD, SAFETY_GATE_CIRCUIT, TIME_STOP, ADMIN_OVERRIDE, EXCHANGE_LIQUIDATION, RECONCILE_EXTERNAL`

---

## 10 · NOTIFICATIONS

| Canal | Función | Línea | Dedup |
|---|---|---|---|
| Toast | `toast(msg, dur)` | 9549 | NO (queue auto) |
| Sound | `playSignalBeep(type)` | 19016+ | — |
| Banner | `_showNuevaSenalBanner()` | (search) | — |
| Visual alert | `triggerSignalAlert(sym, sig, conf, mode)` | 19077+ | `_firedSigHashes` (L1) |
| Email | `sendRecoveryEmail` (mailer.js) | — | Solo recovery |
| Push notifications | NO implementado | — | — |

⚠️ **Sin centro de notificaciones persistente** — toasts son volátiles, eventos críticos no se preservan si user offline.

---

## 11 · SAFETY GATES

### 11.1 Paper (Frontend)
| Gate | Línea | Bloqueo |
|---|---|---|
| Daily Loss -5% | 15018-15029 | Si `(dayLossAcc/dayStartBalance) ≥ 5%` |
| Drawdown -25% | 15025-15026 | Si `(peak-balance)/peak ≥ 25%` |
| Circuit Breaker | 15020 | 5 pérdidas en 24h |
| `_paperSafetyState` | (implícito) | Persiste dayKey, peakBalance, circuitUntil |

### 11.2 Real (Backend)
| Gate | Línea (server.js) | Bloqueo |
|---|---|---|
| Daily Loss Limit | 1975 | `dailyLoss >= dailyLim` |
| Circuit Breaker | 1960-1966 | `consecutive_losses >= threshold` |
| Max Position | 1969 | `usdAmount > maxPos` |
| Max Leverage | 1972 | `leverage > maxLev` |
| Concurrent Positions | 1991 | `openPositions.length >= maxConcurrent` |
| Capital Deployed % | 1999 | `(currentNotional+newNotional) > balance*maxDeployPct` |

---

## 12 · JOBS / CRON

### Frontend setIntervals
| Job | Intervalo |
|---|---|
| `refreshPaperSignal` | 30s |
| `_runRealAutoScan` | 8s |
| `updateSignalLockTimer` | 1s |
| `saveConfig` | on-change |

### Backend
| Job | Intervalo |
|---|---|
| Broker key cache cleanup | 60s (server.js:33-38) |
| Trade result cache cleanup | per-request lazy |

⚠️ **No hay cron job server-side de signal expiration**, **ni de trade reconciliation periódica con Binance**.

---

## 13 · TIMING & SYNC

| Uso | Fuente | Línea |
|---|---|---|
| Candle Time (HTF) | `kl5[].t` (Binance) | 11070 |
| Signal generation | `Date.now()` local | en genSig |
| TTL checks | `Date.now()` vs `_cachedAt` | 10950 |
| Signal lock expiry | `sig.ts \|\| sig.timestamp \|\| Date.now()` | 13580 (FIX 2026-04-24) |
| Price timestamp | `_pxTimestamp[sym] = Date.now()` | 7730+ |

⚠️ **No existe `/api/server/time`**. Frontend confía en Date.now() local para TTLs (mitigado parcialmente por usar timestamp de kline Binance para session timing).

---

## 14 · MULTI-CLIENT SYNC

| Mecanismo | Implementación | Línea |
|---|---|---|
| LocalStorage | `savePaper()` + `storage` event | 14887 |
| Cloud sync | POST /api/user/signals + DB UPSERT optimistic | 7398-7614 |
| Conflict resolution | `WHERE updated_at <= EXCLUDED.updated_at` | server.js:1603 |
| BroadcastChannel | NO implementado | — |

⚠️ **Sin sync real-time entre tabs/devices.** Dos tabs pueden generar señales y trades en paralelo. Solo sync vía cloud (latencia ~segundos).

---

# RESUMEN EJECUTIVO

## Lo que SÍ existe
✅ V44 engine sólido + scan engine
✅ 4 capas de dedup (notification, trade, lock, anti-relapse)
✅ Per-symbol mutex en autotrade real + paper
✅ Idempotency-Key determinístico (signalId-based) en place-order
✅ Price freshness tracking + fresh fetch si stale
✅ Price-breach detection en 6 entry points
✅ RX_CLOSE_REASON enum obligatorio en closePaperTrade
✅ Backend safety gates (daily loss, DD, circuit, max position/leverage/notional)
✅ X-Idempotency-Key en backend con cache 5min
✅ pg_advisory_xact_lock para concurrent position check
✅ Server-driven `expiresAt` para signal lock (sig.ts based)

## Lo que NO existe (gaps vs spec)
❌ **No hay tabla `signals` global** — cada user con su cache local
❌ **No hay constraint UNIQUE server-side** sobre `(symbol, direction, bucket, engine)`
❌ **No hay state machine formal** (NEW→ACTIVE→TRADED/EXPIRED/SUPERSEDED)
❌ **No hay cron jobs server-side** de expiración (todo lazy)
❌ **No existe `/api/server/time`** — frontend confía en Date.now() local
❌ **No hay WS de señales** (frontend genera local vía klines)
❌ **No hay notification center persistente** — toasts volátiles
❌ **No hay BroadcastChannel** entre tabs
❌ **No hay reliable delivery** de critical events (safety gate trigger se pierde si user offline)
❌ **No hay sequenceNumber** en delivery (no hay forma de detectar gaps)
❌ **No hay reconciliation cron** servidor↔Binance

## Componentes reutilizables
- `rxSignalId(sig, sym)` — generación determinística (L10724-10739, FIX 2026-04-24)
- `_isSignalBreached(sig, sym)` — single source of truth para breach
- `RX_CLOSE_REASON` enum — close reasons categorizadas
- `rxPaperSafetyIsBlocked()` — safety state evaluation
- `_isInPostLossCooldown(sym, dir)` — cooldown evaluation
