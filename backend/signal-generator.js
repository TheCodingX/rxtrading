/**
 * SIGNAL GENERATOR — Periodic worker that runs the V44 engine and persists signals.
 *
 * Responsibilities:
 *   • Cron-driven (every SCAN_INTERVAL_MS, default 60s).
 *   • Single-instance lock via Postgres advisory lock (no double-run if 2 workers).
 *   • Calls v44-engine.scanAllPairs() during eligible hours.
 *   • Persists each new signal via signal-store.insertSignal (idempotent).
 *   • Emits signal events (handled internally by signal-store).
 *
 * Author: 2026-04-25 audit phase 3
 */
'use strict';

const { pool } = require('./database');
const v44 = require('./v44-engine');
const sigStore = require('./signal-store');

const SCAN_INTERVAL_MS = parseInt(process.env.SIGNAL_SCAN_INTERVAL_MS || '60000', 10); // 60s default
const HOLD_HOURS = parseInt(process.env.V44_HOLD_HOURS || '4', 10); // V44 hold = 4h
const TTL_MS = HOLD_HOURS * 60 * 60 * 1000;
const ADVISORY_LOCK_KEY = 0x52585353; // 'RXSS' (RX Signal Store generator)

// 2026-04-27 V44.6 deploy: bump engine version when T6+T5 flags active so DB rows
// reflect the actual engine that produced them (audit + rollback traceability).
const _v46_active = process.env.APEX_V46_T6 === '1' && process.env.APEX_V46_T5 === '1';
const ENGINE_VERSION = process.env.SIGNAL_ENGINE_VERSION ||
  (_v46_active ? 'apex-v44.6-funding-carry-bayes-hawkes-1.0' : 'apex-v44-funding-carry-1.0');

let _timer = null;
let _running = false;
let _onNewSignalCb = null;

/**
 * Try to acquire Postgres advisory lock. Returns true if got it, false otherwise.
 * Used for single-instance enforcement across multiple node processes.
 */
async function _tryAcquireAdvisoryLock(client) {
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [ADVISORY_LOCK_KEY]);
  return rows[0].got === true;
}

async function _releaseAdvisoryLock(client) {
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  } catch (_) {}
}

/**
 * Run one scan cycle. Single-instance enforced via advisory lock.
 */
async function runScanCycle() {
  if (_running) return { skipped: 'already_running' };
  _running = true;
  let client;
  try {
    client = await pool.connect();
    const got = await _tryAcquireAdvisoryLock(client);
    if (!got) {
      return { skipped: 'lock_held_by_other_instance' };
    }
    const t0 = Date.now();
    const scan = await v44.scanAllPairs();
    const scanMs = Date.now() - t0;
    const results = {
      scanned: scan.scanned || 0,
      signals_found: (scan.signals || []).length,
      created: 0,
      duplicate: 0,
      reason: scan.reason
    };
    // 2026-04-27: log every scan cycle in eligible windows for visibility
    if (scan.reason === 'ok') {
      console.log(`[SignalGen] scan complete in ${scanMs}ms — scanned=${scan.scanned}, signals_found=${results.signals_found}, window=${scan.window_type}`);
      if (results.signals_found > 0) {
        for (const s of scan.signals) {
          console.log(`[SignalGen]   → ${s.signal} ${s.symbol} conf=${s.confidence} z=${s.funding_zscore?.toFixed(3) || 'n/a'} sizeMult=${s.size_multiplier || 'n/a'}`);
        }
      } else {
        console.log(`[SignalGen]   no pair passed filters this cycle (z<threshold or funding not extreme)`);
      }
    }

    for (const sig of (scan.signals || [])) {
      try {
        const r = await sigStore.insertSignal({
          symbol: sig.symbol,
          direction: sig.signal,
          engineVersion: ENGINE_VERSION,
          entry: sig.entry,
          tp: sig.tp,
          sl: sig.sl,
          confidence: sig.confidence,
          ts: sig.timestamp || Date.now(),
          ttlMs: TTL_MS,
          meta: {
            funding: sig.funding,
            funding_zscore: sig.funding_zscore,
            size_multiplier: sig.size_multiplier,
            quality_score: sig.quality_score,
            window_type: sig.window_type,
            leverage: sig.leverage,
            hold_hours: sig.hold_hours,
            engine: sig.engine
          }
        });
        if (r.created) {
          results.created++;
          if (_onNewSignalCb) {
            try { await _onNewSignalCb(r.signal); } catch (_) {}
          }
        } else {
          results.duplicate++;
        }
      } catch (err) {
        console.warn('[SignalGen] insert failed for', sig.symbol, err.message);
      }
    }
    return results;
  } catch (err) {
    console.error('[SignalGen] scan cycle error:', err.message);
    return { error: err.message };
  } finally {
    if (client) {
      await _releaseAdvisoryLock(client);
      client.release();
    }
    _running = false;
  }
}

/**
 * Start the periodic generator. Idempotent.
 */
function start({ onNewSignal } = {}) {
  if (_onNewSignalCb && onNewSignal) _onNewSignalCb = onNewSignal;
  else if (onNewSignal) _onNewSignalCb = onNewSignal;
  if (_timer) return;
  // Initial run after brief startup delay (let DB pool settle)
  setTimeout(() => { runScanCycle().catch(e => console.warn('[SignalGen] initial run err', e.message)); }, 5000);
  _timer = setInterval(() => {
    runScanCycle().catch(e => console.warn('[SignalGen] periodic run err', e.message));
  }, SCAN_INTERVAL_MS);
  console.log('[SignalGen] started — scan every', SCAN_INTERVAL_MS, 'ms, engine:', ENGINE_VERSION);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  ENGINE_VERSION,
  SCAN_INTERVAL_MS,
  HOLD_HOURS,
  TTL_MS,
  runScanCycle,
  start,
  stop
};
