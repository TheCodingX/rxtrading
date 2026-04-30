/**
 * SIGNAL STORE — Server-side source of truth for signals.
 *
 * Responsibilities:
 *   • Persist signals to `signals` table (atomic, idempotent via UNIQUE constraint).
 *   • Manage state machine: NEW → ACTIVE → TRADED/EXPIRED/SUPERSEDED/CANCELED.
 *   • Emit events to `signal_events` for WS clients (sequenceNumber-based gap fill).
 *   • Provide deterministic signalId (hash of pair+dir+bucket+engine+tp+sl).
 *
 * State machine:
 *   NEW       → ACTIVE                 (auto on insert)
 *   ACTIVE    → TRADED                 (atomic, via opTradedTransition with row lock)
 *   ACTIVE    → EXPIRED                (cron, on TTL pass)
 *   ACTIVE    → SUPERSEDED             (newer signal for same sym+dir replaces it)
 *   ACTIVE    → CANCELED               (admin override)
 *   TRADED    → COMPLETED              (handled in signal_trades, not signals)
 *
 * Author: 2026-04-25 audit phase 3
 */
'use strict';

const crypto = require('crypto');
const { pool } = require('./database');

// ─────────────────────────────────────────────────────────────────────
// Bucket size: 5 min default. Two signals for same (symbol,dir,engine)
// within the same 5-min window collide (UNIQUE constraint), preventing
// duplicate signals from race conditions in the generator.
// ─────────────────────────────────────────────────────────────────────
const BUCKET_SIZE_MS = parseInt(process.env.SIGNAL_BUCKET_MS || '300000', 10); // 5 min

const VALID_STATES = ['NEW', 'ACTIVE', 'TRADED', 'EXPIRED', 'SUPERSEDED', 'CANCELED'];
const VALID_TRANSITIONS = {
  NEW: ['ACTIVE', 'CANCELED'],
  ACTIVE: ['TRADED', 'EXPIRED', 'SUPERSEDED', 'CANCELED'],
  TRADED: [],
  EXPIRED: [],
  SUPERSEDED: [],
  CANCELED: []
};

/**
 * Compute deterministic signalId. Same inputs → same id. Different bucket = different id.
 */
function computeSignalId(symbol, direction, bucketMinute, engineVersion, tp, sl) {
  const tpStr = Number(tp).toFixed(8);
  const slStr = Number(sl).toFixed(8);
  const payload = `${symbol}|${direction}|${bucketMinute}|${engineVersion}|${tpStr}|${slStr}`;
  const h = crypto.createHash('sha256').update(payload).digest('hex');
  return 'sig_' + h.slice(0, 16);
}

/**
 * Compute current bucket given a server timestamp (UTC ms).
 */
function computeBucket(tsMs) {
  return Math.floor(tsMs / BUCKET_SIZE_MS) * BUCKET_SIZE_MS;
}

/**
 * Insert a new signal. Idempotent via UNIQUE constraint on (symbol, direction, bucket_minute, engine_version).
 *
 * @returns {{ created: boolean, signal: object | null }}
 *   created=true if newly inserted, false if duplicate (skip).
 */
async function insertSignal({
  symbol,
  direction,
  engineVersion,
  entry,
  tp,
  sl,
  confidence,
  ts,
  ttlMs,
  meta = {}
}) {
  if (!symbol || !direction || !engineVersion || !entry || !tp || !sl || ts == null || !ttlMs) {
    throw new Error('insertSignal: missing required fields');
  }
  if (!['BUY', 'SELL'].includes(direction)) throw new Error('insertSignal: direction must be BUY/SELL');
  const bucketMinute = computeBucket(ts);
  const signalId = computeSignalId(symbol, direction, bucketMinute, engineVersion, tp, sl);
  const expiresAt = new Date(ts + ttlMs);
  const tsDate = new Date(ts);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 2026-04-29 ANTI-SPAM: skip if ACTIVE signal already exists for (symbol, direction, engine_version)
    // No supersede — keep the FIRST signal until it closes/expires. Eliminates spam in historial.
    const existing = await client.query(
      `SELECT signal_id FROM signals
        WHERE symbol = $1 AND direction = $2 AND engine_version = $3 AND state = 'ACTIVE'
        LIMIT 1`,
      [symbol, direction, engineVersion]
    );
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return { created: false, signal: null, reason: 'active_already_exists', existingId: existing.rows[0].signal_id };
    }
    // Insert with ON CONFLICT DO NOTHING to handle race
    const insertSql = `
      INSERT INTO signals (
        signal_id, symbol, direction, engine_version, bucket_minute,
        entry, tp, sl, confidence, ts, expires_at, state, meta
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE',$12)
      ON CONFLICT (symbol, direction, bucket_minute, engine_version) DO NOTHING
      RETURNING *
    `;
    const { rows } = await client.query(insertSql, [
      signalId, symbol, direction, engineVersion, bucketMinute,
      entry, tp, sl, confidence, tsDate, expiresAt, JSON.stringify(meta)
    ]);
    if (rows.length === 0) {
      await client.query('COMMIT');
      return { created: false, signal: null, reason: 'duplicate_bucket' };
    }
    const signal = rows[0];
    // Emit creation event
    await client.query(
      `INSERT INTO signal_events (signal_id, event_type, prev_state, new_state, meta)
       VALUES ($1, 'created', NULL, 'ACTIVE', $2)`,
      [signalId, JSON.stringify({ confidence, entry, tp, sl })]
    );
    await client.query('COMMIT');
    return { created: true, signal };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 2026-04-29 — Close a signal with outcome (WIN/LOSS/NO_HIT).
 * Used by TP/SL monitor and expiration cron.
 * Sets state to EXPIRED and records outcome + exit price.
 */
async function closeSignalWithOutcome({ signalId, outcome, exitPrice, reason }) {
  const validOutcomes = ['WIN', 'LOSS', 'NO_HIT'];
  if (!validOutcomes.includes(outcome)) {
    return { ok: false, reason: 'invalid_outcome' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockRes = await client.query(
      'SELECT * FROM signals WHERE signal_id = $1 AND state = $2 FOR UPDATE',
      [signalId, 'ACTIVE']
    );
    if (lockRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_active_or_not_found' };
    }
    const upd = await client.query(
      `UPDATE signals
          SET state = 'EXPIRED',
              outcome = $1,
              outcome_price = $2,
              closed_at = NOW(),
              state_changed_at = NOW()
        WHERE signal_id = $3
        RETURNING *`,
      [outcome, exitPrice, signalId]
    );
    await client.query(
      `INSERT INTO signal_events (signal_id, event_type, prev_state, new_state, meta)
       VALUES ($1, 'expired', 'ACTIVE', 'EXPIRED', $2)`,
      [signalId, JSON.stringify({ outcome, exitPrice, reason })]
    );
    await client.query('COMMIT');
    return { ok: true, signal: upd.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, reason: 'error', error: err.message };
  } finally {
    client.release();
  }
}

/**
 * 2026-04-29 — Monitor open signals for TP/SL hits given current prices.
 * @param {Object} currentPrices - { 'BTCUSDT': 76500, 'ETHUSDT': 2300, ... }
 * @returns {Array} of { signalId, outcome, exitPrice, reason }
 */
async function monitorOpenSignals(currentPrices) {
  if (!currentPrices || typeof currentPrices !== 'object') return [];
  const { rows: openSigs } = await pool.query(
    `SELECT signal_id, symbol, direction, entry, tp, sl, expires_at
       FROM signals
      WHERE state = 'ACTIVE' AND expires_at > NOW()`
  );
  const closed = [];
  for (const sig of openSigs) {
    const price = currentPrices[sig.symbol];
    if (price == null || !isFinite(price)) continue;
    const tp = parseFloat(sig.tp);
    const sl = parseFloat(sig.sl);
    let outcome = null;
    let exitPrice = null;
    let reason = null;
    if (sig.direction === 'BUY') {
      if (price >= tp) { outcome = 'WIN'; exitPrice = tp; reason = 'TP_HIT'; }
      else if (price <= sl) { outcome = 'LOSS'; exitPrice = sl; reason = 'SL_HIT'; }
    } else { // SELL
      if (price <= tp) { outcome = 'WIN'; exitPrice = tp; reason = 'TP_HIT'; }
      else if (price >= sl) { outcome = 'LOSS'; exitPrice = sl; reason = 'SL_HIT'; }
    }
    if (outcome) {
      const res = await closeSignalWithOutcome({ signalId: sig.signal_id, outcome, exitPrice, reason });
      if (res.ok) closed.push({ signalId: sig.signal_id, outcome, exitPrice, reason, symbol: sig.symbol });
    }
  }
  return closed;
}

/**
 * Atomic state transition with row lock.
 * Returns { ok, prevState, newState, signal } or { ok: false, reason }.
 *
 * Used by:
 *   • cron expiration job (ACTIVE → EXPIRED)
 *   • atomic operate endpoint (ACTIVE → TRADED, with extra lock at signal_trades level)
 *   • admin override (ACTIVE → CANCELED)
 */
async function transitionState(signalId, expectedState, newState, meta = {}) {
  if (!VALID_STATES.includes(newState)) {
    return { ok: false, reason: 'invalid_target_state' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the row
    const lockRes = await client.query(
      'SELECT * FROM signals WHERE signal_id = $1 FOR UPDATE',
      [signalId]
    );
    if (lockRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_found' };
    }
    const row = lockRes.rows[0];
    if (expectedState && row.state !== expectedState) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'state_mismatch', currentState: row.state };
    }
    if (!VALID_TRANSITIONS[row.state] || !VALID_TRANSITIONS[row.state].includes(newState)) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'illegal_transition', from: row.state, to: newState };
    }
    const upd = await client.query(
      `UPDATE signals SET state = $1, state_changed_at = NOW() WHERE signal_id = $2 RETURNING *`,
      [newState, signalId]
    );
    await client.query(
      `INSERT INTO signal_events (signal_id, event_type, prev_state, new_state, meta)
       VALUES ($1, 'state_changed', $2, $3, $4)`,
      [signalId, row.state, newState, JSON.stringify(meta)]
    );
    await client.query('COMMIT');
    return { ok: true, prevState: row.state, newState, signal: upd.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, reason: 'error', error: err.message };
  } finally {
    client.release();
  }
}

/**
 * Get all currently active signals, optionally filtered by engine version.
 * Used by snapshot endpoint and scan loops.
 */
async function getActiveSignals({ engineVersion = null, limit = 100 } = {}) {
  const params = [];
  let where = "state = 'ACTIVE' AND expires_at > NOW()";
  if (engineVersion) {
    params.push(engineVersion);
    where += ` AND engine_version = $${params.length}`;
  }
  params.push(limit);
  const sql = `SELECT * FROM signals WHERE ${where} ORDER BY ts DESC LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

/**
 * Get a single signal by signal_id.
 */
async function getSignalById(signalId) {
  const { rows } = await pool.query('SELECT * FROM signals WHERE signal_id = $1', [signalId]);
  return rows[0] || null;
}

/**
 * Expire all ACTIVE signals where expires_at < NOW().
 * Returns array of signalIds expired.
 */
async function expireStale() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 2026-04-29: mark outcome=NO_HIT on TTL expiration (signal didn't hit TP nor SL within window)
    const upd = await client.query(`
      UPDATE signals
         SET state = 'EXPIRED',
             state_changed_at = NOW(),
             outcome = COALESCE(outcome, 'NO_HIT'),
             closed_at = COALESCE(closed_at, NOW())
       WHERE state = 'ACTIVE' AND expires_at <= NOW()
       RETURNING signal_id
    `);
    for (const row of upd.rows) {
      await client.query(
        `INSERT INTO signal_events (signal_id, event_type, prev_state, new_state, meta)
         VALUES ($1, 'expired', 'ACTIVE', 'EXPIRED', $2)`,
        [row.signal_id, JSON.stringify({ outcome: 'NO_HIT', reason: 'TTL_EXPIRED' })]
      );
    }
    await client.query('COMMIT');
    return upd.rows.map(r => r.signal_id);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get signal_events with sequence_number > lastSeq (for WS gap fill on reconnect).
 */
async function getEventsSince(lastSeq, limit = 500) {
  const { rows } = await pool.query(
    `SELECT * FROM signal_events WHERE sequence_number > $1 ORDER BY sequence_number ASC LIMIT $2`,
    [lastSeq || 0, limit]
  );
  return rows;
}

/**
 * Atomic open-trade-from-signal. Used by /api/signals/:id/operate.
 * Locks the signal row + checks state == ACTIVE + checks no existing trade for (signal_id, key_id, mode).
 * Returns { ok, trade } or { ok: false, reason }.
 */
async function openTradeForSignal({ signalId, keyId, mode, openPrice, meta = {} }) {
  if (!['paper', 'real_testnet', 'real_mainnet'].includes(mode)) {
    return { ok: false, reason: 'invalid_mode' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock signal row
    const sigRes = await client.query('SELECT * FROM signals WHERE signal_id = $1 FOR UPDATE', [signalId]);
    if (sigRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'signal_not_found' };
    }
    const sig = sigRes.rows[0];
    if (sig.state !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'signal_not_active', state: sig.state };
    }
    if (new Date(sig.expires_at) <= new Date()) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'signal_expired' };
    }
    // Insert trade with conflict on (signal_id, key_id, mode)
    const insTrade = await client.query(
      `INSERT INTO signal_trades (signal_id, key_id, trade_state, mode, open_price, opened_at, meta)
       VALUES ($1,$2,'OPEN',$3,$4,NOW(),$5)
       ON CONFLICT (signal_id, key_id, mode) DO NOTHING
       RETURNING *`,
      [signalId, keyId, mode, openPrice, JSON.stringify(meta)]
    );
    if (insTrade.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'already_traded' };
    }
    await client.query('COMMIT');
    return { ok: true, trade: insTrade.rows[0], signal: sig };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, reason: 'error', error: err.message };
  } finally {
    client.release();
  }
}

/**
 * Close a trade (paper or real). Records reason + pnl. Idempotent.
 */
async function closeTrade({ tradeId, closePrice, closeReason, pnl, meta = {} }) {
  const validReasons = [
    'TP_HIT', 'SL_HIT', 'TIME_STOP', 'TRAILING_STOP_HIT',
    'SAFETY_GATE_DAILY_LOSS', 'SAFETY_GATE_DD', 'SAFETY_GATE_CIRCUIT_BREAKER',
    'MANUAL_CLOSE', 'ADMIN_OVERRIDE', 'EXCHANGE_LIQUIDATION', 'SIGNAL_SUPERSEDED'
  ];
  if (!validReasons.includes(closeReason)) {
    return { ok: false, reason: 'invalid_close_reason' };
  }
  const upd = await pool.query(
    `UPDATE signal_trades
        SET trade_state = 'CLOSED',
            close_price = $1,
            close_reason = $2,
            pnl = $3,
            closed_at = NOW(),
            meta = meta || $4::jsonb
      WHERE id = $5 AND trade_state IN ('OPEN', 'PENDING_CLOSE')
      RETURNING *`,
    [closePrice, closeReason, pnl, JSON.stringify(meta), tradeId]
  );
  if (upd.rows.length === 0) {
    return { ok: false, reason: 'trade_not_open_or_not_found' };
  }
  // V44.5 PALANCA 11: Feed pair-stats tracker for rolling PF computation
  // Look up the signal to get the pair, then record this closed trade.
  try {
    const trade = upd.rows[0];
    const sig = await pool.query(
      'SELECT symbol FROM signals WHERE signal_id = $1 LIMIT 1',
      [trade.signal_id]
    );
    if (sig.rows.length > 0) {
      const v44Engine = require('./v44-engine');
      if (typeof v44Engine.recordTradeForPairStats === 'function') {
        v44Engine.recordTradeForPairStats(
          sig.rows[0].symbol,
          new Date(trade.closed_at).getTime(),
          parseFloat(pnl)
        );
      }
    }
  } catch (e) {
    // Non-fatal — pair stats feeding is opportunistic
    console.error('[V45] recordTradeForPairStats failed:', e.message);
  }
  return { ok: true, trade: upd.rows[0] };
}

/**
 * Get user's active trades.
 */
async function getActiveTradesForUser(keyId) {
  const { rows } = await pool.query(
    `SELECT t.*, s.symbol, s.direction, s.tp, s.sl, s.entry as signal_entry, s.confidence
       FROM signal_trades t
       JOIN signals s ON s.signal_id = t.signal_id
      WHERE t.key_id = $1 AND t.trade_state IN ('OPEN','PENDING_OPEN','PENDING_CLOSE')
      ORDER BY t.opened_at DESC`,
    [keyId]
  );
  return rows;
}

module.exports = {
  BUCKET_SIZE_MS,
  computeSignalId,
  computeBucket,
  insertSignal,
  transitionState,
  getActiveSignals,
  getSignalById,
  expireStale,
  getEventsSince,
  openTradeForSignal,
  closeTrade,
  getActiveTradesForUser,
  closeSignalWithOutcome,
  monitorOpenSignals,
  VALID_STATES,
  VALID_TRANSITIONS
};
