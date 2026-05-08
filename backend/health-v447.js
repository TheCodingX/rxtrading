/**
 * V44.7 LIVE HEALTH STATS — shared module.
 *
 * Single source of truth for live engine validation stats. Consumed by:
 *   • backend/scripts/health-check-v447.js (cron / CI / Slack alerts)
 *   • backend/server.js  →  GET /api/admin/health-v447
 *
 * Why a shared module: the verdict logic must be identical in both places so
 * that ops dashboards and alerting cron never disagree on whether the engine
 * is healthy.
 */
'use strict';

const { pool } = require('./database');

const DEFAULT_FEE_BPS = parseFloat(process.env.HEALTH_FEE_BPS || '8');
const DEFAULT_ENGINE_LIKE = 'apex-v44.7%';
const MIN_DECISIVE_FOR_VERDICT = 200;

function _erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function wilsonLower(wins, n, z = 1.96) {
  if (!n) return 0;
  const p = wins / n;
  const denom = 1 + z * z / n;
  const center = p + z * z / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return (center - margin) / denom;
}

function oneSidedP(wins, n, p0 = 0.5) {
  if (!n) return 1;
  const mu = n * p0;
  const sigma = Math.sqrt(n * p0 * (1 - p0));
  const z = (wins - mu) / Math.max(1e-9, sigma);
  return 1 - 0.5 * (1 + _erf(z / Math.SQRT2));
}

function bootstrapPFCI(pnls, iters = 2000, alpha = 0.05) {
  if (pnls.length < 10) return [null, null];
  const pfs = [];
  for (let i = 0; i < iters; i++) {
    let gw = 0, gl = 0;
    for (let j = 0; j < pnls.length; j++) {
      const v = pnls[(Math.random() * pnls.length) | 0];
      if (v > 0) gw += v;
      else gl += -v;
    }
    pfs.push(gl > 0 ? gw / gl : (gw > 0 ? 99 : 0));
  }
  pfs.sort((a, b) => a - b);
  return [pfs[Math.floor(iters * alpha / 2)], pfs[Math.floor(iters * (1 - alpha / 2))]];
}

function maxConsecLosses(rows) {
  const sorted = [...rows].sort((a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime());
  let cur = 0, max = 0;
  for (const r of sorted) {
    if (r.outcome === 'LOSS') { cur++; if (cur > max) max = cur; }
    else cur = 0;
  }
  return max;
}

function computeVerdict({ decisive, pfLo, wrLower95 }) {
  if (decisive < MIN_DECISIVE_FOR_VERDICT) {
    return { status: 'YELLOW', reason: `N=${decisive} < ${MIN_DECISIVE_FOR_VERDICT}, insufficient sample for conclusion` };
  }
  if (pfLo != null && pfLo < 1.05) {
    return { status: 'RED', reason: `PF 95%-CI lower=${pfLo.toFixed(2)} < 1.05 (engine bleeding)` };
  }
  if (wrLower95 <= 50) {
    return { status: 'RED', reason: `WR Wilson lower-CI=${wrLower95.toFixed(1)}% ≤ 50% (no edge over coinflip)` };
  }
  if (pfLo != null && pfLo >= 1.20 && wrLower95 > 52) {
    return { status: 'GREEN', reason: `PF lower=${pfLo.toFixed(2)} ≥ 1.20 and WR lower=${wrLower95.toFixed(1)}% > 52%` };
  }
  return { status: 'YELLOW', reason: `PF lower=${pfLo != null ? pfLo.toFixed(2) : 'n/a'}, WR lower=${wrLower95.toFixed(1)}% — borderline` };
}

/**
 * Compute live health stats for a window. Returns a JSON-serializable report.
 *
 * @param {object} opts
 * @param {number} opts.days       Window (default 30)
 * @param {string} opts.engineLike LIKE pattern for engine_version (default 'apex-v44.7%')
 * @param {number} opts.feeBps     Roundtrip fee in bps (default 8)
 */
async function computeHealthReport({ days = 30, engineLike = DEFAULT_ENGINE_LIKE, feeBps = DEFAULT_FEE_BPS } = {}) {
  const t0 = Date.now();
  const { rows } = await pool.query(
    `SELECT signal_id, symbol, direction, entry, tp, sl, outcome, outcome_price,
            ts, closed_at, engine_version, confidence, meta
       FROM signals
      WHERE engine_version LIKE $1
        AND closed_at IS NOT NULL
        AND outcome IS NOT NULL
        AND closed_at >= NOW() - ($2 || ' days')::interval
      ORDER BY closed_at ASC`,
    [engineLike, String(days)]
  );

  const wins = rows.filter(r => r.outcome === 'WIN');
  const losses = rows.filter(r => r.outcome === 'LOSS');
  const noHits = rows.filter(r => r.outcome === 'NO_HIT');
  const decisiveRows = [...wins, ...losses];
  const decisive = decisiveRows.length;

  const pnlBps = [];
  for (const r of decisiveRows) {
    const e = parseFloat(r.entry), x = parseFloat(r.outcome_price);
    if (!isFinite(e) || !isFinite(x) || e <= 0) continue;
    const sign = r.direction === 'BUY' ? 1 : -1;
    const grossBps = ((x - e) / e) * 10000 * sign;
    pnlBps.push(grossBps - feeBps);
  }

  const wr = decisive > 0 ? wins.length / decisive * 100 : 0;
  const wrLower95 = wilsonLower(wins.length, decisive) * 100;
  const wrPVal = oneSidedP(wins.length, decisive, 0.5);

  let gw = 0, gl = 0;
  for (const v of pnlBps) { if (v > 0) gw += v; else gl += -v; }
  const pf = gl > 0 ? gw / gl : (gw > 0 ? 99 : 0);
  const [pfLo, pfHi] = bootstrapPFCI(pnlBps);

  const dayCount = {};
  for (const r of decisiveRows) {
    const d = new Date(r.closed_at).toISOString().slice(0, 10);
    dayCount[d] = (dayCount[d] || 0) + 1;
  }
  const daysObs = Object.keys(dayCount).length;
  const tradesPerDay = daysObs > 0 ? decisive / daysObs : 0;
  const consecLosses = maxConsecLosses(decisiveRows);
  const totalPnLBps = pnlBps.reduce((s, v) => s + v, 0);
  const avgPnLBps = pnlBps.length ? totalPnLBps / pnlBps.length : 0;

  const bySym = {};
  for (const r of decisiveRows) {
    const k = r.symbol;
    if (!bySym[k]) bySym[k] = { w: 0, l: 0 };
    bySym[k][r.outcome === 'WIN' ? 'w' : 'l']++;
  }

  const srcCount = { real: 0, proxy: 0, unknown: 0 };
  for (const r of rows) {
    const m = r.meta || {};
    const s = m.funding_source || '';
    if (s === 'premium_index_real') srcCount.real++;
    else if (s === 'proxy_ema') srcCount.proxy++;
    else srcCount.unknown++;
  }

  const verdict = computeVerdict({ decisive, pfLo, wrLower95 });

  return {
    timestamp: new Date().toISOString(),
    engine_filter: engineLike,
    window_days: days,
    fee_bps: feeBps,
    sample: {
      total_with_outcome: rows.length,
      wins: wins.length,
      losses: losses.length,
      no_hits: noHits.length,
      decisive,
      sufficient: decisive >= MIN_DECISIVE_FOR_VERDICT,
      min_required: MIN_DECISIVE_FOR_VERDICT
    },
    funding_source: srcCount,
    metrics: {
      wr_pct: +wr.toFixed(2),
      wr_wilson_lower95_pct: +wrLower95.toFixed(2),
      wr_p_value_vs_50: +wrPVal.toFixed(4),
      pf: +pf.toFixed(3),
      pf_ci95_lower: pfLo != null ? +pfLo.toFixed(3) : null,
      pf_ci95_upper: pfHi != null ? +pfHi.toFixed(3) : null,
      total_pnl_bps: +totalPnLBps.toFixed(1),
      avg_pnl_bps: +avgPnLBps.toFixed(2),
      trades_per_day: +tradesPerDay.toFixed(2),
      max_consec_losses: consecLosses,
      days_observed: daysObs
    },
    by_symbol: Object.entries(bySym)
      .map(([s, x]) => ({ sym: s, w: x.w, l: x.l, n: x.w + x.l, wr: +(x.w / Math.max(1, x.w + x.l) * 100).toFixed(1) }))
      .sort((a, b) => b.n - a.n),
    verdict,
    runtime_ms: Date.now() - t0
  };
}

module.exports = {
  computeHealthReport,
  wilsonLower,
  oneSidedP,
  bootstrapPFCI,
  computeVerdict,
  MIN_DECISIVE_FOR_VERDICT
};
