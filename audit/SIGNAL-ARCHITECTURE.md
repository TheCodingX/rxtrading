# SIGNAL SYSTEM v2 — ARCHITECTURE
**Date:** 2026-04-25 · **Phase:** 3 (post-fixes)

---

## OVERVIEW

```
┌─────────────────────────────────────────────────────────────┐
│                        BACKEND                              │
│                                                             │
│  ┌──────────────┐    ┌────────────────┐   ┌──────────────┐ │
│  │ signal-      │    │ signal-store   │   │ ws-server    │ │
│  │ generator    │───▶│ (DAO + state   │──▶│ (WebSocket)  │ │
│  │ (cron 60s)   │    │  machine)      │   │              │ │
│  └──────┬───────┘    └────────┬───────┘   └──────┬───────┘ │
│         │                     │                  │         │
│         │                     ▼                  │         │
│         │          ┌────────────────────┐        │         │
│         │          │   PostgreSQL       │        │         │
│         │          │                    │        │         │
│         │          │ signals            │        │         │
│         │          │ signal_events      │        │         │
│         │          │ signal_trades      │        │         │
│         │          │ notifications      │        │         │
│         │          └────────────────────┘        │         │
│         │                     ▲                  │         │
│         ▼                     │                  │         │
│  ┌──────────────┐    ┌────────┴───────┐          │         │
│  │ v44-engine   │    │ signal-cron    │          │         │
│  │ (V44 algo)   │    │ • expire 60s   │          │         │
│  └──────────────┘    │ • reconcile 5m │          │         │
│                      └────────────────┘          │         │
│                                                  │         │
│  ┌──────────────────────────────────────────────┘         │
│  │                                                          │
│  │  REST endpoints (express):                               │
│  │   GET  /api/server/time                                  │
│  │   GET  /api/signals/active                               │
│  │   GET  /api/signals/events?sinceSeq                      │
│  │   POST /api/signals/:id/operate (atomic)                 │
│  │   POST /api/signals/trades/:id/close                     │
│  │   GET  /api/signals/my-trades                            │
│  │   GET  /api/notifications                                │
│  │   POST /api/notifications/read                           │
│  │   POST /api/notifications/:id/ack                        │
│  └──────────────────────────────────────────────────────────┘
│                       ▲   │
└───────────────────────┼───┼──────────────────────────────────┘
                        │   │
                  HTTPS ╋   ╋ WS /ws/signals
                        │   │
                        ▼   ▼
          ┌─────────────────────────────────┐
          │         FRONTEND (browser)      │
          │                                 │
          │  ┌────────────────────────────┐ │
          │  │ RXSignals (window global)  │ │
          │  │  • state.signals: Map      │ │
          │  │  • state.notifications     │ │
          │  │  • state.lastSeq           │ │
          │  │  • state.serverTimeOffset  │ │
          │  └─────┬──────────────────────┘ │
          │        │                        │
          │  ┌─────┴────────┐  ┌──────────┐ │
          │  │ WS subscriber│  │ REST     │ │
          │  │ + reconnect  │  │ fallback │ │
          │  │ + gap_fill   │  │ poll 30s │ │
          │  └──────────────┘  └──────────┘ │
          │                                 │
          │  ┌────────────────────────────┐ │
          │  │ BroadcastChannel(rx-signals)│ │
          │  │ multi-tab sync             │ │
          │  └────────────────────────────┘ │
          │                                 │
          │  ┌────────────────────────────┐ │
          │  │ Notification Center UI     │ │
          │  │ • Bell + badge             │ │
          │  │ • Persistent feed          │ │
          │  │ • CRITICAL modal (block)   │ │
          │  └────────────────────────────┘ │
          │                                 │
          │  ┌────────────────────────────┐ │
          │  │ genSig() V44 mode          │ │
          │  │ → consults RXSignals first │ │
          │  │ (legacy fallback retained) │ │
          │  └────────────────────────────┘ │
          └─────────────────────────────────┘
```

---

## SIGNAL STATE MACHINE

```
       ┌─────┐
       │ NEW │  (transient, immediately becomes ACTIVE)
       └──┬──┘
          │
          ▼
    ┌──────────┐
    │  ACTIVE  │ ◀── insertSignal()
    └─┬─┬─┬─┬──┘
      │ │ │ │
      │ │ │ └──▶ CANCELED   (admin override, terminal)
      │ │ └────▶ SUPERSEDED (newer same-(sym,dir,engine), terminal)
      │ └──────▶ EXPIRED    (cron when expires_at < NOW(), terminal)
      └────────▶ TRADED     (atomic via openTradeForSignal, terminal)
```

**Atomicity:** every transition uses `SELECT … FOR UPDATE` + state check + insert into `signal_events` (audit trail) within a single Postgres transaction.

**No revival:** terminal states have empty `VALID_TRANSITIONS` arrays.

---

## TRADE STATE MACHINE

```
                ┌────────────────┐
                │  PENDING_OPEN  │
                └────────┬───────┘
                         │
                         ▼
                ┌────────────────┐
                │      OPEN      │ ◀── openTradeForSignal()
                └────────┬───────┘
                         │
                         ▼
                ┌────────────────┐
                │ PENDING_CLOSE  │ (real trades, mid-Binance close)
                └────────┬───────┘
                         │
                         ▼
                ┌────────────────┐
                │     CLOSED     │ ◀── closeTrade(reason ∈ enum)
                └────────────────┘     reason MANDATORY
```

**Idempotency:** `UNIQUE(signal_id, key_id, mode)` ensures one trade per (user, signal, mode). Concurrent operate requests for same triple → 1 wins, others get `already_traded`.

---

## DEDUP (4 LAYERS)

```
Layer 1: DB UNIQUE on signal_id              ← signal-store insertSignal ON CONFLICT DO NOTHING
Layer 2: DB UNIQUE on (sym, dir, bucket, eng) ← bucket_minute = floor(ts/300000)*300000
Layer 3: DB UNIQUE on (signal_id, key_id, mode) (signal_trades)
Layer 4: Frontend Map<signalId, signal> (RXSignals)
```

Plus event-level: `notifications.UNIQUE(key_id, event_id)` with deterministic event_id.

---

## TIMING

```
client                        server
  │                             │
  │── GET /api/server/time ────▶│  t_serverA
  │◀── { serverTime: t_serverA } │
  │                             │
  t_clientB     ── compute offset = t_serverA + (RTT/2) - t_clientB ──
  │
  ALL TTLs use:
  serverTime = Date.now() + state.serverTimeOffset

  Re-sync every 60s.
  Drift > 5s → console.warn.
```

**No more `Date.now()` for TTL decisions.** Frontend signals always render relative to server-corrected time.

---

## DELIVERY (real-time)

```
Client                                Server
  │                                     │
  │── WS connect /ws/signals ──────────▶│
  │◀── hello { authRequired: true } ────│
  │                                     │
  │── auth { token: <jwt> } ───────────▶│  verify JWT
  │◀── auth_ok { keyId, serverTime } ──│
  │                                     │
  │── subscribe { engineVersion } ─────▶│
  │◀── snapshot { signals[], lastSeq } ─│   (initial state)
  │                                     │
  │       (signal generated)            │
  │◀── event { sequenceNumber, ... } ───│
  │                                     │
  │       (connection drops)            │
  │   ... reconnect with backoff ...    │
  │── auth + subscribe ────────────────▶│
  │── request_gap_fill { sinceSeq } ───▶│
  │◀── gap_fill { events[] } ───────────│   (missed events)
  │                                     │
```

**Resilience:**
- Heartbeat ping/pong every 30s
- Reconnect with exponential backoff (1s → 30s)
- REST fallback `/api/signals/active` polled every 30s if WS down
- Gap fill via `sequence_number` after reconnect

---

## NOTIFICATIONS

```
backend event ─▶ notifStore.insert (UNIQUE event_id) ─▶ DB
                          │
                          ▼
              wsServer.pushNotification(keyId)
                          │
                          ▼
                   client (online)
                   │ shows toast
                   │ updates badge
                   │ if CRITICAL: blocks UI until ack
                   │
              client (offline)
                   │ DB persist remains
                   │ on reconnect: GET /api/notifications
                   │ pendingCritical[] surfaces unacknowledged
```

**5 severities:** CRITICAL (must ack) · HIGH · MEDIUM · LOW · INFO.

---

## MULTI-TAB SYNC

```
Tab A                                Tab B
 │                                    │
 ├── BroadcastChannel('rx-signals') ──┤
 │                                    │
 (user opens trade in Tab A)
 │ POST /api/signals/X/operate
 │ → trade success
 │ bcEmit { kind: 'trade:opened' }
 │                                    │
 │            ───────────────────▶    │ Tab B
 │                                    │ updates UI immediately
 │                                    │ no DB roundtrip needed
```

Plus: WS push reaches both tabs (server `pushToUser` iterates all clients of that keyId).

---

## FILE INDEX (NEW + MODIFIED)

### New files
```
backend/signal-store.js           — DAO + state machine
backend/notification-store.js     — Notification DAO
backend/signal-generator.js       — V44 cron worker
backend/signal-cron.js            — expiration + reconciliation
backend/ws-server.js              — WebSocket server
backend/__tests__/signal-store.test.js
backend/__tests__/notification-store.test.js
frontend/signal-system-v2.js      — Frontend client
tests/e2e/signal-system.test.js   — 15 E2E tests
audit/SIGNAL-SYSTEM-MAP.md
audit/SIGNAL-AUDIT-REPORT.md
audit/SIGNAL-ARCHITECTURE.md
audit/SIGNAL-GO-NOGO.md
```

### Modified files
```
backend/database.js               — +4 tables (signals, signal_events, signal_trades, notifications)
backend/server.js                 — imports + REST endpoints + WS attach + cron boot
backend/package.json              — +ws dependency
frontend/app.html                 — +script tag, notification center CSS/HTML, genSig RXSignals integration
```

---

## ENV VARS

```
SIGNAL_BUCKET_MS=300000             (5 min default)
SIGNAL_SCAN_INTERVAL_MS=60000       (1 min default)
SIGNAL_EXPIRE_INTERVAL_MS=60000     (1 min default)
SIGNAL_RECONCILE_INTERVAL_MS=300000 (5 min default)
V44_HOLD_HOURS=4                    (TTL = 4h)
SIGNAL_ENGINE_VERSION=apex-v44-funding-carry-1.0
```

---

## DEPLOYMENT NOTES

1. Run `npm install` in backend (adds `ws` dependency).
2. Schema migrations apply on `initDB()` — idempotent, run on every boot.
3. WS server attaches to existing http.Server at `/ws/signals` path.
4. Frontend script `signal-system-v2.js` must be served alongside `app.html` (same dir).
5. CORS: backend already configured; WS uses same auth as REST (JWT in Authorization).
