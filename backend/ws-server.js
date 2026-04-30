/**
 * WS SERVER — Real-time signal/event push to authenticated clients.
 *
 * Protocol (text frames, JSON):
 *   Client → Server:
 *     { type: 'auth', token: '<jwt>' }                  — must be first message
 *     { type: 'subscribe', engineVersion: '...' }        — subscribe to engine signals
 *     { type: 'request_gap_fill', sinceSeq: <number> }  — request missed events on reconnect
 *     { type: 'ping' }
 *
 *   Server → Client:
 *     { type: 'auth_ok' | 'auth_fail', reason? }
 *     { type: 'snapshot', signals: [...], serverTime, lastSeq }
 *     { type: 'event', sequenceNumber, event_type, signal_id, prev_state, new_state, signal? }
 *     { type: 'notification', notif: {...} }
 *     { type: 'gap_fill', events: [...] }
 *     { type: 'pong' }
 *     { type: 'error', message }
 *
 * Per-user sequence: server tracks last broadcast seq; clients can request gap_fill from any earlier seq.
 *
 * Auth: validates JWT issued by main API. If invalid → close 4001.
 *
 * Author: 2026-04-25 audit phase 3
 */
'use strict';

const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const sigStore = require('./signal-store');
const notifStore = require('./notification-store');

const HEARTBEAT_INTERVAL_MS = 30000;
const AUTH_TIMEOUT_MS = 10000;
const MAX_CLIENTS_PER_USER = 5; // tabs/devices

const _clientsByUser = new Map(); // keyId → Set<WebSocket>
let _wss = null;

function _broadcast(predicate, payload) {
  if (!_wss) return;
  const msg = JSON.stringify(payload);
  _wss.clients.forEach(ws => {
    try {
      if (ws.readyState === ws.OPEN && predicate(ws)) ws.send(msg);
    } catch (_) {}
  });
}

/**
 * Send to all authenticated clients (any user).
 */
function broadcastEvent(event) {
  _broadcast(ws => ws._authed === true, { type: 'event', ...event });
}

/**
 * Send to specific user (all their tabs/devices).
 */
function pushToUser(keyId, payload) {
  const set = _clientsByUser.get(keyId);
  if (!set) return 0;
  const msg = JSON.stringify(payload);
  let sent = 0;
  for (const ws of set) {
    try {
      if (ws.readyState === ws.OPEN) { ws.send(msg); sent++; }
    } catch (_) {}
  }
  return sent;
}

/**
 * Push notification to user. If user offline, notification is already persisted in DB → will be fetched on reconnect.
 */
function pushNotification(keyId, notif) {
  return pushToUser(keyId, { type: 'notification', notif });
}

function _addClient(keyId, ws) {
  if (!_clientsByUser.has(keyId)) _clientsByUser.set(keyId, new Set());
  const set = _clientsByUser.get(keyId);
  // Enforce max clients per user — drop oldest
  if (set.size >= MAX_CLIENTS_PER_USER) {
    const oldest = set.values().next().value;
    try { oldest.close(4002, 'too_many_clients'); } catch (_) {}
    set.delete(oldest);
  }
  set.add(ws);
}

function _removeClient(keyId, ws) {
  const set = _clientsByUser.get(keyId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) _clientsByUser.delete(keyId);
  }
}

function _verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const payload = jwt.verify(token, secret);
    // Expected payload format from main auth: { keyId, role?, iat, exp }
    if (!payload.keyId) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

async function _sendSnapshot(ws, engineVersion) {
  try {
    const signals = await sigStore.getActiveSignals({ engineVersion, limit: 50 });
    // Get last seq from signal_events
    const { rows: lastRows } = await require('./database').pool.query(
      'SELECT COALESCE(MAX(sequence_number), 0) AS last_seq FROM signal_events'
    );
    const lastSeq = parseInt(lastRows[0].last_seq, 10) || 0;
    ws.send(JSON.stringify({
      type: 'snapshot',
      signals,
      serverTime: Date.now(),
      lastSeq,
      engineVersion: engineVersion || null
    }));
  } catch (err) {
    try { ws.send(JSON.stringify({ type: 'error', message: 'snapshot_failed' })); } catch (_) {}
  }
}

async function _sendGapFill(ws, sinceSeq) {
  try {
    const events = await sigStore.getEventsSince(sinceSeq, 500);
    ws.send(JSON.stringify({ type: 'gap_fill', events }));
  } catch (err) {
    try { ws.send(JSON.stringify({ type: 'error', message: 'gap_fill_failed' })); } catch (_) {}
  }
}

function _onMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'auth') {
    if (ws._authed) return;
    const payload = _verifyToken(msg.token);
    if (!payload) {
      try { ws.send(JSON.stringify({ type: 'auth_fail', reason: 'invalid_token' })); } catch (_) {}
      try { ws.close(4001, 'auth_fail'); } catch (_) {}
      return;
    }
    ws._authed = true;
    ws._keyId = payload.keyId;
    _addClient(payload.keyId, ws);
    try { ws.send(JSON.stringify({ type: 'auth_ok', keyId: payload.keyId, serverTime: Date.now() })); } catch (_) {}
    return;
  }

  if (!ws._authed) return; // ignore other messages until authed

  if (msg.type === 'subscribe') {
    ws._engineVersion = msg.engineVersion || null;
    _sendSnapshot(ws, ws._engineVersion).catch(() => {});
    return;
  }

  if (msg.type === 'request_gap_fill') {
    const since = parseInt(msg.sinceSeq, 10) || 0;
    _sendGapFill(ws, since).catch(() => {});
    return;
  }

  if (msg.type === 'ping') {
    try { ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now() })); } catch (_) {}
    return;
  }
}

/**
 * Mount the WS server on an existing http.Server. Returns the WSS instance.
 */
function attach(httpServer) {
  if (_wss) return _wss;
  _wss = new WebSocketServer({ server: httpServer, path: '/ws/signals' });

  // Heartbeat — kill stale connections
  const heartbeatIv = setInterval(() => {
    _wss.clients.forEach(ws => {
      if (ws._isAlive === false) {
        try { ws.terminate(); } catch (_) {}
        return;
      }
      ws._isAlive = false;
      try { ws.ping(); } catch (_) {}
    });
  }, HEARTBEAT_INTERVAL_MS);

  _wss.on('close', () => clearInterval(heartbeatIv));

  _wss.on('connection', (ws, req) => {
    ws._isAlive = true;
    ws._authed = false;
    ws._connectedAt = Date.now();
    ws.on('pong', () => { ws._isAlive = true; });
    ws.on('message', raw => _onMessage(ws, raw));
    ws.on('close', () => {
      if (ws._authed && ws._keyId) _removeClient(ws._keyId, ws);
    });
    ws.on('error', () => {});
    // Auth timeout: if not authed within AUTH_TIMEOUT_MS, drop
    setTimeout(() => {
      if (!ws._authed) {
        try { ws.close(4001, 'auth_timeout'); } catch (_) {}
      }
    }, AUTH_TIMEOUT_MS);
    try {
      ws.send(JSON.stringify({ type: 'hello', serverTime: Date.now(), authRequired: true }));
    } catch (_) {}
  });

  console.log('[WS] signals server attached at /ws/signals');
  return _wss;
}

/**
 * Hook called by signal-generator when new signal created. Pushes 'event' to all authed clients.
 */
async function onNewSignal(signal) {
  // Fetch sequence_number from latest event for this signal
  try {
    const { rows } = await require('./database').pool.query(
      "SELECT sequence_number FROM signal_events WHERE signal_id = $1 AND event_type = 'created' ORDER BY sequence_number DESC LIMIT 1",
      [signal.signal_id]
    );
    const seq = rows[0] ? parseInt(rows[0].sequence_number, 10) : null;
    broadcastEvent({
      sequenceNumber: seq,
      event_type: 'created',
      signal_id: signal.signal_id,
      prev_state: null,
      new_state: 'ACTIVE',
      signal: {
        signal_id: signal.signal_id,
        symbol: signal.symbol,
        direction: signal.direction,
        engine_version: signal.engine_version,
        entry: signal.entry,
        tp: signal.tp,
        sl: signal.sl,
        confidence: signal.confidence,
        ts: signal.ts,
        expires_at: signal.expires_at,
        state: 'ACTIVE'
      }
    });
  } catch (err) {
    console.warn('[WS] onNewSignal err:', err.message);
  }
}

/**
 * Hook called by signal-cron when signal expires.
 */
async function onSignalExpired(signalId) {
  try {
    const { rows } = await require('./database').pool.query(
      "SELECT sequence_number FROM signal_events WHERE signal_id = $1 AND event_type = 'expired' ORDER BY sequence_number DESC LIMIT 1",
      [signalId]
    );
    const seq = rows[0] ? parseInt(rows[0].sequence_number, 10) : null;
    broadcastEvent({
      sequenceNumber: seq,
      event_type: 'expired',
      signal_id: signalId,
      prev_state: 'ACTIVE',
      new_state: 'EXPIRED'
    });
  } catch (err) {
    console.warn('[WS] onSignalExpired err:', err.message);
  }
}

/**
 * 2026-04-29 — Hook called by TP/SL monitor cron when signal closes with outcome WIN/LOSS.
 * Broadcasts to all connected clients so frontend can update historial in real-time.
 */
async function onSignalClosed({ signalId, outcome, exitPrice, reason, symbol }) {
  try {
    const { rows } = await require('./database').pool.query(
      "SELECT sequence_number FROM signal_events WHERE signal_id = $1 ORDER BY sequence_number DESC LIMIT 1",
      [signalId]
    );
    const seq = rows[0] ? parseInt(rows[0].sequence_number, 10) : null;
    broadcastEvent({
      sequenceNumber: seq,
      event_type: 'expired',
      signal_id: signalId,
      prev_state: 'ACTIVE',
      new_state: 'EXPIRED',
      meta: { outcome, exitPrice, reason, symbol }
    });
  } catch (err) {
    console.warn('[WS] onSignalClosed err:', err.message);
  }
}

/**
 * Hook called by reconciliation cron on divergence detection.
 * Persists a CRITICAL notification for the user.
 */
async function onReconcileDivergence({ keyId, position }) {
  try {
    const { created, notif } = await notifStore.insert({
      keyId,
      eventType: 'reconcile_divergence',
      severity: 'CRITICAL',
      title: 'Divergencia detectada en Binance',
      body: `Posición ${position.symbol} ${position.side || ''} en Binance sin trade asociado en RX. Investigá manualmente.`,
      refKey: `reconcile-${keyId}-${position.symbol}-${Math.floor(Date.now() / 60000)}`,
      meta: position
    });
    if (created) pushNotification(keyId, notif);
  } catch (err) {
    console.warn('[WS] onReconcileDivergence err:', err.message);
  }
}

module.exports = {
  attach,
  broadcastEvent,
  pushToUser,
  pushNotification,
  onNewSignal,
  onSignalExpired,
  onSignalClosed,
  onReconcileDivergence
};
