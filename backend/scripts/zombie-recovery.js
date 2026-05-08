#!/usr/bin/env node
/**
 * ZOMBIE TRADES RECOVERY — CLI script.
 *
 * Identifies signal_trades that should have closed but stayed OPEN due to the
 * pre-2026-05-07 bug (no server-side propagation of signal close → trade close).
 * Reports them, lets ops review, then closes them with the correct outcome.
 *
 * Usage:
 *   DATABASE_URL=…  node backend/scripts/zombie-recovery.js                  # dry-run, prints CSV
 *   DATABASE_URL=…  node backend/scripts/zombie-recovery.js --execute        # actually closes
 *   DATABASE_URL=…  node backend/scripts/zombie-recovery.js --execute --json # JSON output
 *
 * Two zombie classes detected:
 *   A) signal_closed_trade_open
 *      - signal.state ∈ {EXPIRED, CANCELED, SUPERSEDED}
 *      - signal.outcome IS NOT NULL (WIN/LOSS/NO_HIT)
 *      - signal_trades.trade_state ∈ {OPEN, PENDING_CLOSE}
 *      - Action: close trade with reason = TP_HIT/SL_HIT/TIME_STOP per outcome.
 *
 *   B) ttl_passed_no_outcome
 *      - signal.expires_at < NOW() - 1h
 *      - signal.outcome IS NULL (somehow expire cron didn't reach)
 *      - signal_trades.trade_state ∈ {OPEN, PENDING_CLOSE}
 *      - Action: close trade with reason = TIME_STOP at signal.entry (zero PnL).
 *
 * Modes handled:
 *   - paper:        always recovered.
 *   - real_*:       LISTED in dry-run report so ops can verify against Binance, but
 *                   NOT auto-closed (broker reconcile is authoritative). Use the
 *                   admin endpoint `POST /api/admin/close-user-trades/:keyId` after
 *                   manual verification.
 *
 * Output CSV columns:
 *   trade_id, signal_id, key_id, mode, symbol, direction, open_price, exit_price,
 *   outcome, derived_reason, derived_pnl, age_hours, engine_version, action_taken
 */
'use strict';

const { pool } = require('../database');
const sigStore = require('../signal-store');

const EXECUTE = process.argv.includes('--execute');
const JSON_OUT = process.argv.includes('--json');
const REAL_ALSO = process.argv.includes('--include-real'); // explicit opt-in
const LIMIT = parseInt(
  (process.argv.find(a => a.startsWith('--limit=')) || '').replace('--limit=', '') || '5000',
  10
);

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function deriveReason(outcome) {
  if (outcome === 'WIN') return 'TP_HIT';
  if (outcome === 'LOSS') return 'SL_HIT';
  return 'TIME_STOP';
}

function deriveExitPrice({ outcome, outcome_price, tp, sl, entry }) {
  if (outcome_price != null) return parseFloat(outcome_price);
  if (outcome === 'WIN') return parseFloat(tp);
  if (outcome === 'LOSS') return parseFloat(sl);
  return parseFloat(entry);
}

function derivePnL({ direction, openPrice, exitPrice, meta }) {
  if (!isFinite(openPrice) || !isFinite(exitPrice) || openPrice <= 0) return null;
  const sign = direction === 'BUY' ? 1 : -1;
  const pctMove = ((exitPrice - openPrice) / openPrice) * sign;
  const m = meta || {};
  const notional = parseFloat(m.notional || m.quote_amount || m.amt || 0);
  const lev = parseFloat(m.leverage || m.lev || 1);
  if (!notional || notional <= 0) return null;
  return +(notional * lev * pctMove).toFixed(8);
}

(async () => {
  console.log(`[zombie-recovery] mode=${EXECUTE ? 'EXECUTE' : 'DRY-RUN'} include_real=${REAL_ALSO ? 'yes' : 'no'} limit=${LIMIT}`);
  let exitCode = 0;
  try {
    const { rows: zombies } = await pool.query(`
      SELECT t.id              AS trade_id,
             t.signal_id,
             t.key_id,
             t.mode,
             t.trade_state,
             t.open_price,
             t.opened_at,
             t.meta            AS trade_meta,
             s.symbol,
             s.direction,
             s.entry,
             s.tp,
             s.sl,
             s.state           AS signal_state,
             s.outcome,
             s.outcome_price,
             s.closed_at,
             s.expires_at,
             s.engine_version,
             EXTRACT(EPOCH FROM (NOW() - t.opened_at))::INT AS age_seconds,
             CASE
               WHEN s.state IN ('EXPIRED','CANCELED','SUPERSEDED') AND s.outcome IS NOT NULL
                 THEN 'signal_closed_trade_open'
               WHEN s.expires_at IS NOT NULL AND s.expires_at < NOW() - INTERVAL '1 hour'
                 THEN 'ttl_passed_no_outcome'
               ELSE NULL
             END AS zombie_kind
        FROM signal_trades t
        JOIN signals s ON s.signal_id = t.signal_id
       WHERE t.trade_state IN ('OPEN','PENDING_CLOSE','PENDING_OPEN')
         AND (
              (s.state IN ('EXPIRED','CANCELED','SUPERSEDED') AND s.outcome IS NOT NULL)
           OR (s.expires_at IS NOT NULL AND s.expires_at < NOW() - INTERVAL '1 hour')
         )
       ORDER BY t.opened_at ASC NULLS FIRST
       LIMIT $1
    `, [LIMIT]);

    if (zombies.length === 0) {
      console.log('[zombie-recovery] no zombies found ✓');
      await pool.end();
      process.exit(0);
    }

    const summary = {
      total: zombies.length,
      by_mode: {},
      by_kind: {},
      paper_recoverable: 0,
      real_skipped: 0
    };
    const actions = [];

    for (const z of zombies) {
      summary.by_mode[z.mode] = (summary.by_mode[z.mode] || 0) + 1;
      summary.by_kind[z.zombie_kind] = (summary.by_kind[z.zombie_kind] || 0) + 1;

      const isReal = z.mode === 'real_testnet' || z.mode === 'real_mainnet';
      const willTouch = !isReal || REAL_ALSO;
      const outcome = z.outcome;
      const reason = outcome ? deriveReason(outcome) : 'TIME_STOP';
      const exitPrice = deriveExitPrice({
        outcome, outcome_price: z.outcome_price, tp: z.tp, sl: z.sl, entry: z.entry
      });
      const pnl = derivePnL({
        direction: z.direction,
        openPrice: parseFloat(z.open_price || z.entry),
        exitPrice,
        meta: z.trade_meta
      });
      const action = {
        trade_id: z.trade_id,
        signal_id: z.signal_id,
        key_id: z.key_id,
        mode: z.mode,
        symbol: z.symbol,
        direction: z.direction,
        open_price: parseFloat(z.open_price || z.entry) || null,
        exit_price: exitPrice,
        outcome,
        zombie_kind: z.zombie_kind,
        derived_reason: reason,
        derived_pnl: pnl,
        age_hours: +(z.age_seconds / 3600).toFixed(1),
        engine_version: z.engine_version,
        action_taken: 'pending'
      };

      if (!willTouch) {
        action.action_taken = 'skipped_real_mode_use_admin_endpoint';
        summary.real_skipped++;
      } else if (!EXECUTE) {
        action.action_taken = 'dry_run_would_close';
        summary.paper_recoverable++;
      } else {
        try {
          const cr = await sigStore.closeTrade({
            tradeId: z.trade_id,
            closePrice: exitPrice,
            closeReason: reason,
            pnl,
            meta: {
              recovered: true,
              recovery_script: 'zombie-recovery.js',
              recovery_at: new Date().toISOString(),
              signal_outcome: outcome,
              zombie_kind: z.zombie_kind
            }
          });
          if (cr.ok) {
            action.action_taken = 'closed';
            summary.paper_recoverable++;
          } else {
            action.action_taken = 'close_failed:' + (cr.reason || 'unknown');
          }
        } catch (e) {
          action.action_taken = 'error:' + e.message;
          exitCode = 1;
        }
      }
      actions.push(action);
    }

    if (JSON_OUT) {
      console.log(JSON.stringify({ summary, actions, executed: EXECUTE }, null, 2));
    } else {
      // CSV
      console.log('\n--- ZOMBIE TRADES CSV ---');
      console.log('trade_id,signal_id,key_id,mode,symbol,direction,open_price,exit_price,outcome,derived_reason,derived_pnl,age_hours,engine_version,zombie_kind,action_taken');
      for (const a of actions) {
        console.log([
          a.trade_id, a.signal_id, a.key_id, a.mode, a.symbol, a.direction,
          a.open_price, a.exit_price, a.outcome, a.derived_reason, a.derived_pnl,
          a.age_hours, a.engine_version, a.zombie_kind, a.action_taken
        ].map(csvEscape).join(','));
      }
      console.log('--- END CSV ---\n');
      console.log('Summary:');
      console.log('  Total zombies:', summary.total);
      console.log('  By mode:', JSON.stringify(summary.by_mode));
      console.log('  By kind:', JSON.stringify(summary.by_kind));
      console.log('  Paper recoverable:', summary.paper_recoverable);
      console.log('  Real (skipped):', summary.real_skipped);
      if (!EXECUTE) {
        console.log('\n[zombie-recovery] DRY-RUN — re-run with --execute to actually close');
      } else {
        console.log('\n[zombie-recovery] EXECUTED — closures persisted to DB');
      }
    }
  } catch (e) {
    console.error('[zombie-recovery] error:', e.message);
    exitCode = 2;
  } finally {
    try { await pool.end(); } catch (_) {}
    process.exit(exitCode);
  }
})();
