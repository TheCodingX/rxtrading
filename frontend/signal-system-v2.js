/**
 * SIGNAL SYSTEM v2 — Frontend client
 *
 * Capabilities:
 *   • Server time sync + drift detection (Date.now() local NEVER used for TTLs)
 *   • WebSocket subscriber with auth + reconnect + gap-fill on lastSeq
 *   • REST fallback if WS unavailable (polling /api/signals/active every 30s)
 *   • BroadcastChannel('rx-signals') for multi-tab sync
 *   • Persistent notification center with localStorage cache + DB sync
 *   • Map<signalId, signal> de-duplicated state with subscribers
 *
 * Usage from app.html:
 *   <script src="signal-system-v2.js"></script>
 *   RXSignals.init({ apiBase: '...', getToken: () => 'jwt', engineVersion: 'apex-v44-funding-carry-1.0' });
 *   RXSignals.subscribe('signal:created', sig => ...);
 *   RXSignals.subscribe('signal:expired', sigId => ...);
 *   RXSignals.subscribe('signal:state', { signalId, prev, next } => ...);
 *   RXSignals.subscribe('notification', n => ...);
 *
 * Public API:
 *   RXSignals.getActiveSignals()                    → Array<signal>
 *   RXSignals.getSignal(signalId)                   → signal | null
 *   RXSignals.getServerTime()                       → epoch ms (corrected)
 *   RXSignals.getServerDrift()                      → ms diff client - server
 *   RXSignals.operate(signalId, mode, openPrice)    → Promise<{ok, trade?, reason?}>
 *   RXSignals.closeTrade(tradeId, reason, ...)      → Promise<{ok}>
 *   RXSignals.getNotifications()                    → Array<notif>
 *   RXSignals.markRead(ids)                         → Promise
 *   RXSignals.acknowledge(id)                       → Promise
 *   RXSignals.connectionState()                     → 'connecting'|'open'|'reconnecting'|'closed'|'rest_fallback'
 *
 * Author: 2026-04-25 audit phase 3
 */
(function (global) {
  'use strict';

  const SERVER_TIME_SYNC_MS = 60000; // every 60s
  const REST_FALLBACK_POLL_MS = 30000; // poll /api/signals/active every 30s if WS down
  const WS_MAX_RECONNECT_MS = 30000;
  const BC_CHANNEL = 'rx-signals';

  // ─── State ──────────────────────────────────────────────────────────────
  const state = {
    apiBase: '',
    wsUrl: '',
    getToken: () => null,
    engineVersion: null,
    serverTimeOffset: 0, // serverTime = Date.now() + serverTimeOffset
    serverTimeAt: 0,
    signals: new Map(), // signalId → signal
    notifications: [],
    unreadCount: 0,
    pendingCritical: [],
    lastSeq: 0,
    ws: null,
    wsBackoff: 1000,
    wsState: 'closed',
    bc: null,
    timeSyncTimer: null,
    restFallbackTimer: null,
    subscribers: new Map(), // event → Set<fn>
    initialized: false
  };

  // ─── Helpers ────────────────────────────────────────────────────────────
  function now() { return Date.now() + state.serverTimeOffset; }

  function emit(event, payload) {
    const set = state.subscribers.get(event);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); } catch (err) { console.warn('[RXSignals] subscriber err', event, err); }
    }
  }

  function bcEmit(payload) {
    try { if (state.bc) state.bc.postMessage(payload); } catch (_) {}
  }

  function _fetch(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const token = state.getToken && state.getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(state.apiBase + path, Object.assign({}, opts, { headers })).then(r => {
      if (!r.ok) return r.json().then(j => { throw new Error(j.error || 'http_' + r.status); }).catch(() => { throw new Error('http_' + r.status); });
      return r.json();
    });
  }

  // ─── Server time sync ───────────────────────────────────────────────────
  async function syncServerTime() {
    try {
      const t0 = Date.now();
      const r = await fetch(state.apiBase + '/api/server/time').then(r => r.json());
      const t1 = Date.now();
      const rtt = t1 - t0;
      // Correct for one-way latency (assume symmetric)
      const serverEstimate = r.serverTime + rtt / 2;
      const offset = serverEstimate - t1;
      state.serverTimeOffset = offset;
      state.serverTimeAt = t1;
      if (Math.abs(offset) > 5000) {
        console.warn('[RXSignals] clock drift', offset, 'ms — using server-corrected time');
      }
      emit('time:synced', { offset, rtt });
    } catch (err) {
      // Non-fatal: keep last known offset
    }
  }

  // ─── Snapshot fetch (initial + REST fallback) ──────────────────────────
  async function loadSnapshot() {
    try {
      const url = '/api/signals/active' + (state.engineVersion ? `?engine=${encodeURIComponent(state.engineVersion)}&limit=100` : '?limit=100');
      const r = await fetch(state.apiBase + url).then(r => r.json());
      // Merge into state.signals
      const seenIds = new Set();
      for (const s of (r.signals || [])) {
        seenIds.add(s.signal_id);
        const prev = state.signals.get(s.signal_id);
        state.signals.set(s.signal_id, s);
        if (!prev) emit('signal:created', s);
      }
      // Remove signals no longer in the active set
      for (const id of Array.from(state.signals.keys())) {
        if (!seenIds.has(id)) {
          state.signals.delete(id);
          emit('signal:expired', id);
        }
      }
      if (r.lastSeq && r.lastSeq > state.lastSeq) state.lastSeq = r.lastSeq;
      // Drift check
      if (r.serverTime) {
        const offset = r.serverTime - Date.now();
        if (Math.abs(offset - state.serverTimeOffset) > 2000) {
          state.serverTimeOffset = offset; state.serverTimeAt = Date.now();
        }
      }
      emit('snapshot', { count: state.signals.size, lastSeq: state.lastSeq });
    } catch (err) {
      // Silent: WS handles state too
    }
  }

  // ─── Apply event from WS/REST ──────────────────────────────────────────
  function _applyEvent(ev) {
    if (!ev) return;
    if (ev.sequenceNumber && ev.sequenceNumber > state.lastSeq) state.lastSeq = ev.sequenceNumber;
    if (ev.event_type === 'created' && ev.signal) {
      state.signals.set(ev.signal.signal_id, ev.signal);
      emit('signal:created', ev.signal);
      bcEmit({ kind: 'signal:created', signal: ev.signal });
    } else if (ev.event_type === 'expired') {
      state.signals.delete(ev.signal_id);
      // 2026-04-29: pass meta (outcome, exitPrice, reason) so historial can show WIN/LOSS/NO_HIT
      emit('signal:expired', ev.signal_id, ev.meta || {});
      bcEmit({ kind: 'signal:expired', signalId: ev.signal_id, meta: ev.meta || {} });
    } else if (ev.event_type === 'superseded' || ev.event_type === 'state_changed') {
      const sig = state.signals.get(ev.signal_id);
      if (sig) {
        sig.state = ev.new_state;
        if (ev.new_state !== 'ACTIVE') {
          state.signals.delete(ev.signal_id);
          emit('signal:expired', ev.signal_id);
        } else {
          emit('signal:state', { signalId: ev.signal_id, prev: ev.prev_state, next: ev.new_state });
        }
      }
      bcEmit({ kind: 'signal:state', signalId: ev.signal_id, prev: ev.prev_state, next: ev.new_state });
    }
  }

  // ─── WebSocket ──────────────────────────────────────────────────────────
  function _wsConnect() {
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
    state.wsState = 'connecting';
    let ws;
    try { ws = new WebSocket(state.wsUrl); } catch (err) { _scheduleReconnect(); return; }
    state.ws = ws;
    ws.onopen = () => {
      state.wsBackoff = 1000;
      const token = state.getToken && state.getToken();
      if (token) ws.send(JSON.stringify({ type: 'auth', token }));
    };
    ws.onmessage = (msgEv) => {
      let msg;
      try { msg = JSON.parse(msgEv.data); } catch (_) { return; }
      if (msg.type === 'hello') {
        // server says authRequired — already sent in onopen
        return;
      }
      if (msg.type === 'auth_ok') {
        state.wsState = 'open';
        emit('ws:open', { keyId: msg.keyId });
        // Subscribe + request gap fill if we have a lastSeq
        ws.send(JSON.stringify({ type: 'subscribe', engineVersion: state.engineVersion }));
        if (state.lastSeq > 0) {
          ws.send(JSON.stringify({ type: 'request_gap_fill', sinceSeq: state.lastSeq }));
        }
        return;
      }
      if (msg.type === 'auth_fail') {
        state.wsState = 'closed';
        emit('ws:auth_fail', msg);
        return;
      }
      if (msg.type === 'snapshot') {
        // Replace signals with snapshot
        const seen = new Set();
        for (const s of (msg.signals || [])) {
          seen.add(s.signal_id);
          state.signals.set(s.signal_id, s);
        }
        for (const id of Array.from(state.signals.keys())) {
          if (!seen.has(id)) state.signals.delete(id);
        }
        if (msg.lastSeq) state.lastSeq = msg.lastSeq;
        if (msg.serverTime) {
          state.serverTimeOffset = msg.serverTime - Date.now();
          state.serverTimeAt = Date.now();
        }
        emit('snapshot', { count: state.signals.size, lastSeq: state.lastSeq });
        return;
      }
      if (msg.type === 'event') { _applyEvent(msg); return; }
      if (msg.type === 'gap_fill') {
        for (const ev of (msg.events || [])) _applyEvent(ev);
        return;
      }
      if (msg.type === 'notification') {
        if (msg.notif) {
          state.notifications.unshift(msg.notif);
          if (msg.notif.read === 0 || !msg.notif.read) state.unreadCount++;
          if (msg.notif.severity === 'CRITICAL' && !msg.notif.acknowledged) state.pendingCritical.unshift(msg.notif);
          emit('notification', msg.notif);
          bcEmit({ kind: 'notification', notif: msg.notif });
        }
        return;
      }
      if (msg.type === 'pong') return;
      if (msg.type === 'error') console.warn('[RXSignals] ws error', msg.message);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      state.wsState = 'closed';
      _scheduleReconnect();
    };
  }

  function _scheduleReconnect() {
    state.wsState = 'reconnecting';
    const backoff = Math.min(state.wsBackoff, WS_MAX_RECONNECT_MS);
    state.wsBackoff = Math.min(state.wsBackoff * 2, WS_MAX_RECONNECT_MS);
    setTimeout(_wsConnect, backoff + Math.floor(Math.random() * 500));
  }

  // ─── REST fallback ──────────────────────────────────────────────────────
  function _startRestFallback() {
    if (state.restFallbackTimer) return;
    state.restFallbackTimer = setInterval(() => {
      if (state.wsState !== 'open') {
        loadSnapshot().catch(() => {});
        // Also pull events since lastSeq
        if (state.lastSeq > 0) {
          fetch(state.apiBase + `/api/signals/events?sinceSeq=${state.lastSeq}&limit=200`)
            .then(r => r.json())
            .then(r => { for (const ev of (r.events || [])) _applyEvent(ev); })
            .catch(() => {});
        }
      }
    }, REST_FALLBACK_POLL_MS);
  }

  // ─── Notifications ──────────────────────────────────────────────────────
  async function loadNotifications() {
    try {
      const r = await _fetch('/api/notifications?limit=50');
      state.notifications = r.notifs || [];
      state.unreadCount = r.unread || 0;
      state.pendingCritical = r.pendingCritical || [];
      emit('notifications:loaded', { count: state.notifications.length, unread: state.unreadCount });
    } catch (_) {}
  }

  async function markRead(ids) {
    try {
      await _fetch('/api/notifications/read', { method: 'POST', body: JSON.stringify({ ids: ids || [] }) });
      // Update local state
      if (!ids || ids.length === 0) {
        state.notifications.forEach(n => { n.read = 1; });
        state.unreadCount = 0;
      } else {
        const idset = new Set(ids);
        state.notifications.forEach(n => { if (idset.has(n.id)) n.read = 1; });
        state.unreadCount = Math.max(0, state.unreadCount - ids.length);
      }
      emit('notifications:updated');
      bcEmit({ kind: 'notifications:read' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function acknowledge(id) {
    try {
      const r = await _fetch(`/api/notifications/${id}/ack`, { method: 'POST', body: '{}' });
      // Remove from pending
      state.pendingCritical = state.pendingCritical.filter(n => n.id !== id);
      const n = state.notifications.find(x => x.id === id);
      if (n) { n.acknowledged = 1; n.read = 1; }
      emit('notifications:updated');
      bcEmit({ kind: 'notifications:ack', id });
      return r;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ─── Operate / close trade ──────────────────────────────────────────────
  async function operate(signalId, mode = 'paper', openPrice = null) {
    try {
      const body = { mode };
      if (openPrice != null) body.openPrice = openPrice;
      const r = await _fetch(`/api/signals/${signalId}/operate`, {
        method: 'POST', body: JSON.stringify(body)
      });
      bcEmit({ kind: 'trade:opened', signalId, mode, trade: r.trade });
      return r;
    } catch (err) {
      return { ok: false, reason: 'request_failed', error: err.message };
    }
  }

  async function closeTrade(tradeId, closeReason, closePrice = null, pnl = null, meta = {}) {
    try {
      const body = { closeReason, closePrice, pnl, meta };
      const r = await _fetch(`/api/signals/trades/${tradeId}/close`, {
        method: 'POST', body: JSON.stringify(body)
      });
      bcEmit({ kind: 'trade:closed', tradeId, closeReason, pnl });
      return r;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ─── BroadcastChannel (multi-tab) ──────────────────────────────────────
  function _setupBroadcastChannel() {
    if (typeof BroadcastChannel !== 'function') return;
    try {
      state.bc = new BroadcastChannel(BC_CHANNEL);
      state.bc.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg) return;
        if (msg.kind === 'signal:created' && msg.signal) {
          if (!state.signals.has(msg.signal.signal_id)) {
            state.signals.set(msg.signal.signal_id, msg.signal);
            emit('signal:created', msg.signal);
          }
        } else if (msg.kind === 'signal:expired') {
          if (state.signals.has(msg.signalId)) {
            state.signals.delete(msg.signalId);
            emit('signal:expired', msg.signalId);
          }
        } else if (msg.kind === 'signal:state') {
          const sig = state.signals.get(msg.signalId);
          if (sig) sig.state = msg.next;
          emit('signal:state', { signalId: msg.signalId, prev: msg.prev, next: msg.next });
        } else if (msg.kind === 'notification' && msg.notif) {
          if (!state.notifications.find(n => n.id === msg.notif.id)) {
            state.notifications.unshift(msg.notif);
            if (!msg.notif.read) state.unreadCount++;
            emit('notification', msg.notif);
          }
        } else if (msg.kind === 'notifications:read' || msg.kind === 'notifications:ack') {
          loadNotifications().catch(() => {});
        }
      };
    } catch (_) {}
  }

  // ─── Public API ─────────────────────────────────────────────────────────
  function init({ apiBase, wsUrl, getToken, engineVersion } = {}) {
    if (state.initialized) return;
    state.apiBase = apiBase || '';
    state.wsUrl = wsUrl || (state.apiBase.replace(/^http/i, 'ws') + '/ws/signals');
    state.getToken = getToken || (() => null);
    state.engineVersion = engineVersion || null;
    state.initialized = true;

    syncServerTime().catch(() => {});
    state.timeSyncTimer = setInterval(syncServerTime, SERVER_TIME_SYNC_MS);
    loadSnapshot().catch(() => {});
    loadNotifications().catch(() => {});
    _setupBroadcastChannel();

    // 2026-04-27 fix: anonymous users (no token) have no WS access (server requires auth).
    // Skip WS entirely → REST fallback. When user logs in later, token check below promotes to WS.
    const _initialToken = state.getToken && state.getToken();
    if (!_initialToken) {
      state.wsState = 'rest_fallback';
    } else {
      _wsConnect();
    }
    _startRestFallback();

    // 2026-04-27 fix2: poll for token availability post-login. If user logs in after init,
    // upgrade from rest_fallback → WS. Check every 5s. Once promoted, stop polling.
    let _tokenCheckTimer = setInterval(() => {
      if (state.wsState === 'open' || state.wsState === 'connecting') {
        clearInterval(_tokenCheckTimer);
        return;
      }
      const tok = state.getToken && state.getToken();
      if (tok) {
        // Token now available — try WS connection
        _wsConnect();
      }
    }, 5000);

    emit('initialized');
  }

  function subscribe(event, fn) {
    if (!state.subscribers.has(event)) state.subscribers.set(event, new Set());
    state.subscribers.get(event).add(fn);
    return () => state.subscribers.get(event).delete(fn);
  }

  function getActiveSignals() { return Array.from(state.signals.values()); }
  function getSignal(signalId) { return state.signals.get(signalId) || null; }
  function getServerTime() { return now(); }
  function getServerDrift() { return state.serverTimeOffset; }
  function connectionState() { return state.wsState; }
  function getNotifications() { return state.notifications.slice(); }
  function getUnreadCount() { return state.unreadCount; }
  function getPendingCritical() { return state.pendingCritical.slice(); }

  global.RXSignals = {
    init, subscribe,
    getActiveSignals, getSignal, getServerTime, getServerDrift, connectionState,
    operate, closeTrade,
    getNotifications, getUnreadCount, getPendingCritical, markRead, acknowledge,
    loadSnapshot, loadNotifications, syncServerTime
  };
})(typeof window !== 'undefined' ? window : this);
