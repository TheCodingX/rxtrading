#!/usr/bin/env node
/**
 * V44.7 LIVE HEALTH CHECK — CLI wrapper around backend/health-v447.js.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/health-check-v447.js [--days=N] [--json]
 *
 * Exit codes:  0=GREEN  1=YELLOW  2=RED  3=ERROR
 *
 * Designed to be run daily (cron / GitHub Actions / Render scheduled job) and
 * to alert on RED. Uses identical logic to /api/admin/health-v447 endpoint,
 * so dashboard and cron never disagree.
 */
'use strict';

const { pool } = require('../database');
const { computeHealthReport } = require('../health-v447');

const DAYS = parseInt(
  (process.argv.find(a => a.startsWith('--days=')) || '').replace('--days=', '') || '30',
  10
);
const ENGINE_LIKE = process.env.HEALTH_ENGINE_LIKE || 'apex-v44.7%';
const FEE_BPS = parseFloat(process.env.HEALTH_FEE_BPS || '8');
const JSON_OUT = process.argv.includes('--json');

(async () => {
  let exitCode = 3;
  try {
    const r = await computeHealthReport({ days: DAYS, engineLike: ENGINE_LIKE, feeBps: FEE_BPS });
    if (JSON_OUT) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      const m = r.metrics, s = r.sample, src = r.funding_source;
      console.log(`\n═══ V44.7 HEALTH CHECK · ${r.timestamp} ═══`);
      console.log(`Window: ${r.window_days}d · Engine: ${r.engine_filter} · Fee: ${r.fee_bps} bps roundtrip`);
      console.log(`\nSample:`);
      console.log(`  Closed total: ${s.total_with_outcome}  (Win ${s.wins} · Loss ${s.losses} · NoHit ${s.no_hits})`);
      console.log(`  Decisive (W+L): ${s.decisive}  ${s.sufficient ? '✓' : '⚠ INSUFFICIENT (need ≥' + s.min_required + ')'}`);
      console.log(`  Days observed: ${m.days_observed}`);
      console.log(`  Funding source: real=${src.real} · proxy=${src.proxy} · unknown=${src.unknown}`);
      console.log(`\nMetrics (decisive only):`);
      console.log(`  WR:     ${m.wr_pct}%   Wilson 95% lower: ${m.wr_wilson_lower95_pct}%   p-value vs 50%: ${m.wr_p_value_vs_50}`);
      console.log(`  PF:     ${m.pf}     95% CI: [${m.pf_ci95_lower ?? 'n/a'}, ${m.pf_ci95_upper ?? 'n/a'}]`);
      console.log(`  Trades: ${m.trades_per_day}/day   Total PnL: ${m.total_pnl_bps} bps   Avg: ${m.avg_pnl_bps} bps/trade`);
      console.log(`  Max consecutive losses: ${m.max_consec_losses}`);
      console.log(`\nPer-symbol (top 10):`);
      for (const x of r.by_symbol.slice(0, 10)) {
        console.log(`  ${x.sym.padEnd(14)} n=${String(x.n).padStart(4)}  W=${x.w} L=${x.l}  WR=${x.wr}%`);
      }
      console.log(`\n═══ VERDICT: ${r.verdict.status} ═══`);
      console.log(`Reason: ${r.verdict.reason}`);
      console.log(`\nRuntime: ${r.runtime_ms}ms\n`);
    }
    exitCode = r.verdict.status === 'GREEN' ? 0 : r.verdict.status === 'RED' ? 2 : 1;
  } catch (e) {
    console.error('[health-check] error:', e.message);
    exitCode = 3;
  } finally {
    try { await pool.end(); } catch (_) {}
    process.exit(exitCode);
  }
})();
