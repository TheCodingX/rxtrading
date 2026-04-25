/**
 * SIGNAL CRON JOBS — Server-side periodic maintenance.
 *
 * 1. Expiration job (60s): UPDATE signals SET state='EXPIRED' WHERE state='ACTIVE' AND expires_at < NOW().
 *    Emits signal_event 'expired' for each. WS broadcasts to clients to remove from UI.
 *
 * 2. Reconciliation job (5min): for each user with broker connected,
 *    fetch open positions from Binance and reconcile with signal_trades.
 *    If divergence: log + alert admin (do not auto-close blindly).
 *
 * Author: 2026-04-25 audit phase 3
 */
'use strict';

const { pool } = require('./database');
const sigStore = require('./signal-store');

const EXPIRATION_INTERVAL_MS = parseInt(process.env.SIGNAL_EXPIRE_INTERVAL_MS || '60000', 10); // 60s
const RECONCILE_INTERVAL_MS = parseInt(process.env.SIGNAL_RECONCILE_INTERVAL_MS || '300000', 10); // 5min

let _expireTimer = null;
let _reconcileTimer = null;
let _onSignalExpiredCb = null;
let _onReconcileDivergence = null;

/**
 * Run expiration cycle. Returns { expiredCount, ids }.
 */
async function runExpirationCycle() {
  try {
    const ids = await sigStore.expireStale();
    if (ids.length > 0) {
      console.log('[SignalCron] expired', ids.length, 'signals');
      if (_onSignalExpiredCb) {
        for (const sid of ids) {
          try { await _onSignalExpiredCb(sid); } catch (_) {}
        }
      }
    }
    return { expiredCount: ids.length, ids };
  } catch (err) {
    console.error('[SignalCron] expiration error:', err.message);
    return { error: err.message };
  }
}

/**
 * Run reconciliation cycle. For each user with broker_configs is_active=1, query Binance positions
 * and compare with signal_trades trade_state='OPEN' for that user.
 *
 * Strategy:
 *   • If our DB has OPEN trade but Binance has no position → trade was closed externally. Mark CLOSED with reason RECONCILE_EXTERNAL.
 *   • If Binance has position but our DB has no OPEN trade → log divergence + alert (manual investigation).
 *
 * Note: this requires broker.js + decryption of api keys. Using existing helpers.
 */
async function runReconcileCycle() {
  try {
    // Lazy-load broker to avoid circular deps
    let broker;
    try { broker = require('./broker'); } catch (_) { return { skipped: 'no_broker' }; }
    const { rows: configs } = await pool.query(
      `SELECT bc.id, bc.key_id, bc.api_key_enc, bc.api_secret_enc
         FROM broker_configs bc
         JOIN license_keys lk ON lk.id = bc.key_id
        WHERE bc.is_active = 1
          AND lk.is_revoked = 0
          AND COALESCE(lk.is_deleted,0) = 0
        LIMIT 200`
    );
    const stats = { users_checked: 0, divergences: 0, externally_closed: 0 };
    for (const cfg of configs) {
      stats.users_checked++;
      try {
        // Decrypt keys (broker.decryptKeys helper expected; if absent, skip)
        let creds;
        try {
          creds = typeof broker.decryptKeys === 'function'
            ? broker.decryptKeys({ api_key_enc: cfg.api_key_enc, api_secret_enc: cfg.api_secret_enc })
            : null;
        } catch (_) { creds = null; }
        if (!creds || !creds.apiKey || !creds.apiSecret) continue;
        // Get open Binance positions
        const positions = typeof broker.getOpenPositions === 'function'
          ? await broker.getOpenPositions(creds).catch(() => [])
          : [];
        const binanceSymbols = new Set(positions.map(p => p.symbol));

        // Get our DB OPEN trades for this user
        const { rows: openTrades } = await pool.query(
          `SELECT t.id, t.signal_id, t.binance_order_id, s.symbol
             FROM signal_trades t
             JOIN signals s ON s.signal_id = t.signal_id
            WHERE t.key_id = $1 AND t.trade_state = 'OPEN' AND t.mode IN ('real_testnet','real_mainnet')`,
          [cfg.key_id]
        );

        for (const t of openTrades) {
          if (!binanceSymbols.has(t.symbol)) {
            // Externally closed — mark in our DB
            await sigStore.closeTrade({
              tradeId: t.id,
              closePrice: null,
              closeReason: 'RECONCILE_EXTERNAL',
              pnl: null,
              meta: { reconciled_at: new Date().toISOString() }
            });
            stats.externally_closed++;
          }
        }

        // Detect Binance positions without DB record (divergence)
        const dbSymbols = new Set(openTrades.map(t => t.symbol));
        for (const pos of positions) {
          if (!dbSymbols.has(pos.symbol)) {
            stats.divergences++;
            console.warn('[SignalCron] divergence — user', cfg.key_id, 'has Binance position', pos.symbol, 'with no DB trade');
            if (_onReconcileDivergence) {
              try { await _onReconcileDivergence({ keyId: cfg.key_id, position: pos }); } catch (_) {}
            }
          }
        }
      } catch (err) {
        console.warn('[SignalCron] reconcile user err', cfg.key_id, err.message);
      }
    }
    return stats;
  } catch (err) {
    console.error('[SignalCron] reconcile error:', err.message);
    return { error: err.message };
  }
}

function start({ onSignalExpired, onReconcileDivergence } = {}) {
  if (onSignalExpired) _onSignalExpiredCb = onSignalExpired;
  if (onReconcileDivergence) _onReconcileDivergence = onReconcileDivergence;
  if (!_expireTimer) {
    setTimeout(() => runExpirationCycle().catch(e => console.warn(e.message)), 8000);
    _expireTimer = setInterval(() => {
      runExpirationCycle().catch(e => console.warn(e.message));
    }, EXPIRATION_INTERVAL_MS);
    console.log('[SignalCron] expiration job started — every', EXPIRATION_INTERVAL_MS, 'ms');
  }
  if (!_reconcileTimer) {
    setTimeout(() => runReconcileCycle().catch(e => console.warn(e.message)), 30000);
    _reconcileTimer = setInterval(() => {
      runReconcileCycle().catch(e => console.warn(e.message));
    }, RECONCILE_INTERVAL_MS);
    console.log('[SignalCron] reconciliation job started — every', RECONCILE_INTERVAL_MS, 'ms');
  }
}

function stop() {
  if (_expireTimer) { clearInterval(_expireTimer); _expireTimer = null; }
  if (_reconcileTimer) { clearInterval(_reconcileTimer); _reconcileTimer = null; }
}

module.exports = {
  EXPIRATION_INTERVAL_MS,
  RECONCILE_INTERVAL_MS,
  runExpirationCycle,
  runReconcileCycle,
  start,
  stop
};
