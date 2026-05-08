// V44.7 BACKTEST HARNESS
// Reproduces the funding-carry engine offline against real Binance data.
//
// Pipeline:
//   1. Load cached klines 1h (with OHLC) + premiumIndex 1h + fundingRate 8h per pair.
//   2. For each pair, walk chronologically through bars >= Z_LOOKBACK_H + 50.
//   3. At each bar, if eligible hour, evaluate funding-carry signal using REAL premium index.
//   4. If signal generated, look ahead HOLD_H 1h bars (with high/low) to detect TP/SL hit.
//   5. Apply Binance fees (taker + slippage) to the realized PnL.
//   6. Record trade, advance cursor.
//
// OOS protocol: train on first 70% of period, test on last 30%. Walk-forward optional.
//
// Grid search runs many parameter combinations and reports top by composite score.

'use strict';
const fs = require('fs');
const path = require('path');

const CACHE_DIR = '/tmp/v447-data';
const UNIVERSE = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT',
  'ARBUSDT','ATOMUSDT','TRXUSDT','NEARUSDT','POLUSDT','INJUSDT','SUIUSDT','AVAXUSDT',
  'OPUSDT','DOTUSDT','RENDERUSDT','1000PEPEUSDT','1000SHIBUSDT','JUPUSDT'
];

// ─────────────────────────────────────────────────────────────────
// Data loading + alignment
// ─────────────────────────────────────────────────────────────────
// Compute the EMA-based proxy used by the production v44 engine
// (matches v44-engine.js computeFundingProxy exactly)
function computeProxyEMA(klines) {
  const n = klines.length;
  if (n < 60) return null;
  const closes = klines.map(b => b.c);
  const ema = new Float64Array(n);
  ema[0] = closes[0];
  const alpha = 2 / (50 + 1);
  for (let i = 1; i < n; i++) ema[i] = closes[i] * alpha + ema[i-1] * (1 - alpha);
  const premium = closes.map((v, i) => (v - ema[i]) / ema[i]);
  const funding = new Float64Array(n);
  const w = 8;
  for (let i = w; i < n; i++) {
    let s = 0;
    for (let j = i - w + 1; j <= i; j++) s += premium[j];
    funding[i] = s / w;
  }
  return funding;
}

function loadPair(sym, source = 'premium') {
  const klFile = path.join(CACHE_DIR, `${sym}-klines-1h.json`);
  if (!fs.existsSync(klFile)) return null;
  const klines = JSON.parse(fs.readFileSync(klFile, 'utf8'));
  if (!klines.length) return null;

  let fundArr;
  if (source === 'proxy_ema') {
    fundArr = computeProxyEMA(klines);
    if (!fundArr) return null;
  } else if (source === 'funding_settled') {
    // Forward-fill 8h funding rate into hourly array
    const fdFile = path.join(CACHE_DIR, `${sym}-funding.json`);
    if (!fs.existsSync(fdFile)) return null;
    const fundings = JSON.parse(fs.readFileSync(fdFile, 'utf8'));
    if (!fundings.length) return null;
    const fundMap = new Map();
    for (const f of fundings) {
      // Each funding settles at funding.t — applies to following 8h
      const baseT = Math.floor(f.t / 3600000) * 3600000;
      for (let h = 0; h < 8; h++) {
        fundMap.set(baseT + h * 3600000, f.c);
      }
    }
    fundArr = new Float64Array(klines.length);
    let last = NaN, matched = 0;
    for (let i = 0; i < klines.length; i++) {
      if (fundMap.has(klines[i].t)) { last = fundMap.get(klines[i].t); matched++; }
      fundArr[i] = isFinite(last) ? last : NaN;
    }
    if (matched < klines.length * 0.5) return null;
  } else {
    // default: premium index real
    const prFile = path.join(CACHE_DIR, `${sym}-premium-1h.json`);
    if (!fs.existsSync(prFile)) return null;
    const premium = JSON.parse(fs.readFileSync(prFile, 'utf8'));
    if (!premium.length) return null;
    const premMap = new Map();
    for (const p of premium) premMap.set(p.t, p.c);
    fundArr = new Float64Array(klines.length);
    let last = NaN, matched = 0;
    for (let i = 0; i < klines.length; i++) {
      const t = klines[i].t;
      if (premMap.has(t)) { last = premMap.get(t); matched++; }
      fundArr[i] = isFinite(last) ? last : NaN;
    }
    if (matched < klines.length * 0.6) return null;
  }
  return { sym, klines, fundArr, source };
}

function enrichPair(pd) {
  pd.zArr = precomputeZ(pd.fundArr, 720);
  const pp = precomputePercentiles(pd.fundArr, 168);
  pd.p20Arr = pp.p20Arr;
  pd.p80Arr = pp.p80Arr;
  return pd;
}

// ─────────────────────────────────────────────────────────────────
// Engine reproduction (matches v44-engine.js)
// ─────────────────────────────────────────────────────────────────
function fundingZScore(fundArr, idx, lookback) {
  if (idx < lookback) return 0;
  let sum = 0, n = 0;
  for (let j = idx - lookback + 1; j <= idx; j++) {
    if (isFinite(fundArr[j])) { sum += fundArr[j]; n++; }
  }
  if (n < lookback * 0.5) return 0;
  const mean = sum / n;
  let vsum = 0;
  for (let j = idx - lookback + 1; j <= idx; j++) {
    if (isFinite(fundArr[j])) vsum += (fundArr[j] - mean) ** 2;
  }
  const std = Math.sqrt(vsum / n);
  return std > 0 ? (fundArr[idx] - mean) / std : 0;
}

// PRE-COMPUTE rolling Z-score for the entire fundArr in O(N) time.
// Returns Float64Array same length as fundArr.
function precomputeZ(fundArr, lookback) {
  const N = fundArr.length;
  const z = new Float64Array(N);
  // Sliding window sum + sum-of-squares; ignores NaNs by tracking n
  let sum = 0, sumSq = 0, n = 0;
  // Init first window [0, lookback-1]
  for (let j = 0; j < lookback && j < N; j++) {
    const v = fundArr[j];
    if (isFinite(v)) { sum += v; sumSq += v * v; n++; }
  }
  for (let i = 0; i < N; i++) {
    if (i < lookback - 1) { z[i] = 0; continue; }
    if (i >= lookback) {
      // Add fundArr[i], remove fundArr[i-lookback]
      const inV = fundArr[i];
      const outV = fundArr[i - lookback];
      if (isFinite(inV))  { sum += inV;  sumSq += inV * inV;  n++; }
      if (isFinite(outV)) { sum -= outV; sumSq -= outV * outV; n--; }
    }
    if (n < lookback * 0.5 || !isFinite(fundArr[i])) { z[i] = 0; continue; }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    const std = variance > 0 ? Math.sqrt(variance) : 0;
    z[i] = std > 0 ? (fundArr[i] - mean) / std : 0;
  }
  return z;
}

// PRE-COMPUTE rolling 7d (168h) percentiles p20/p80 — these are O(N · 168 log 168) total
// but small constant: 8760 * 168 * log(168) ≈ 11M ops per pair. Still fast.
function precomputePercentiles(fundArr, windowH = 168) {
  const N = fundArr.length;
  const p20Arr = new Float64Array(N);
  const p80Arr = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    if (i < windowH) { p20Arr[i] = NaN; p80Arr[i] = NaN; continue; }
    const win = [];
    for (let j = i - windowH; j < i; j++) {
      const v = fundArr[j];
      if (isFinite(v)) win.push(v);
    }
    if (win.length < 50) { p20Arr[i] = NaN; p80Arr[i] = NaN; continue; }
    win.sort((a, b) => a - b);
    p20Arr[i] = win[Math.floor(win.length * 0.20)];
    p80Arr[i] = win[Math.floor(win.length * 0.80)];
  }
  return { p20Arr, p80Arr };
}

const SETTLEMENT_HOURS = [0, 8, 16];
function getWindowType(hr) {
  for (const sh of SETTLEMENT_HOURS) {
    if (hr === sh) return 'MID';
    if (hr === ((sh - 1 + 24) % 24)) return 'PRE';
    if (hr === ((sh + 1) % 24)) return 'POST';
  }
  return null;
}
function windowWeight(wt) {
  if (wt === 'MID') return 1.0;
  if (wt === 'PRE') return 0.85;
  if (wt === 'POST') return 0.75;
  return 0;
}

// ─────────────────────────────────────────────────────────────────
// Single-pair backtest
// ─────────────────────────────────────────────────────────────────
function backtestPair(pairData, params) {
  const { klines, fundArr, sym, zArr, p20Arr, p80Arr } = pairData;
  const trades = [];
  const Z_LB = params.Z_LOOKBACK_H || 720;
  const minBars = Z_LB + 50;
  const HOLD = params.HOLD_H || 4;
  const TP_BPS = params.TP_BPS;
  const SL_BPS = params.SL_BPS;
  const Q_TH = params.QUALITY_THRESHOLD;
  const F_POS = params.F_POS_MIN;
  const F_NEG = params.F_NEG_MAX;
  const FEE_BPS = params.FEE_BPS || 8; // 4bps taker × 2 + 0bps slippage

  for (let i = minBars; i < klines.length - HOLD; i++) {
    const bar = klines[i];
    const hr = new Date(bar.t).getUTCHours();
    const wt = getWindowType(hr);
    if (!wt) continue;

    const f = fundArr[i];
    if (!isFinite(f)) continue;

    const p80 = p80Arr[i];
    const p20 = p20Arr[i];
    if (!isFinite(p80) || !isFinite(p20)) continue;

    let dir = 0;
    if (f > p80 && f > F_POS) dir = -1;          // base: SELL when premium high
    else if (f < p20 && f < F_NEG) dir = 1;      // base: BUY when premium low
    if (dir === 0) continue;
    if (params.INVERT) dir = -dir;               // flag to test trend-follow hypothesis

    const z = zArr[i];
    const quality = Math.abs(z) * windowWeight(wt);
    if (quality < Q_TH) continue;

    // Generate signal
    const entry = bar.c;
    const tp = dir === 1 ? entry * (1 + TP_BPS / 10000) : entry * (1 - TP_BPS / 10000);
    const sl = dir === 1 ? entry * (1 - SL_BPS / 10000) : entry * (1 + SL_BPS / 10000);

    // Look ahead HOLD bars for TP/SL hit using high/low intrabar
    let outcome = null, exit = entry, hitI = i + HOLD - 1;
    for (let j = i + 1; j <= i + HOLD && j < klines.length; j++) {
      const fb = klines[j];
      if (dir === 1) {
        const tpHit = fb.h >= tp;
        const slHit = fb.l <= sl;
        if (tpHit && slHit) { outcome = 'LOSS'; exit = sl; hitI = j; break; } // conservative
        if (tpHit) { outcome = 'WIN'; exit = tp; hitI = j; break; }
        if (slHit) { outcome = 'LOSS'; exit = sl; hitI = j; break; }
      } else {
        const tpHit = fb.l <= tp;
        const slHit = fb.h >= sl;
        if (tpHit && slHit) { outcome = 'LOSS'; exit = sl; hitI = j; break; }
        if (tpHit) { outcome = 'WIN'; exit = tp; hitI = j; break; }
        if (slHit) { outcome = 'LOSS'; exit = sl; hitI = j; break; }
      }
    }
    if (!outcome) {
      outcome = 'TIMEOUT';
      exit = klines[Math.min(i + HOLD, klines.length - 1)].c;
    }

    const pnlBps = dir === 1
      ? ((exit - entry) / entry) * 10000
      : ((entry - exit) / entry) * 10000;
    trades.push({
      sym, dir, t: bar.t, entry, exit,
      pnl_bps: pnlBps - FEE_BPS,
      outcome, z, quality, conf: Math.min(98, 50 + Math.abs(z) * 20)
    });
    // Trade closed within HOLD bars window — advance cursor past the hit bar to avoid overlap
    i = Math.max(i, hitI);
  }
  return trades;
}

// ─────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────
function statsOf(trades) {
  if (!trades.length) return { trades: 0, wr: 0, pf: 0, dd: 0, totalPnlBps: 0, perDay: 0, sharpe: 0 };
  const wins = trades.filter(t => t.pnl_bps > 0);
  const losses = trades.filter(t => t.pnl_bps <= 0);
  const gw = wins.reduce((s, t) => s + t.pnl_bps, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl_bps, 0));
  const wr = wins.length / trades.length * 100;
  const pf = gl > 0 ? gw / gl : (gw > 0 ? 99 : 0);
  // DD: equity curve in bps, max drawdown
  trades.sort((a, b) => a.t - b.t);
  let eq = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    eq += t.pnl_bps;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
  }
  // Trades/day
  const span = trades[trades.length - 1].t - trades[0].t;
  const days = Math.max(1, span / 86400000);
  const perDay = trades.length / days;
  // Sharpe (per-trade)
  const mean = (gw - gl) / trades.length;
  const variance = trades.reduce((s, t) => s + (t.pnl_bps - mean) ** 2, 0) / trades.length;
  const sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    wr: +wr.toFixed(2),
    pf: +pf.toFixed(3),
    dd_bps: +maxDD.toFixed(0),
    totalPnl_bps: +(gw - gl).toFixed(0),
    perDay: +perDay.toFixed(2),
    sharpe: +sharpe.toFixed(3),
    span_days: +days.toFixed(0)
  };
}

// Convert PnL bps to annualized return (with leverage + compounding)
function annualizedReturn(stats, leverage = 3) {
  if (!stats.trades) return 0;
  // Per-trade avg return on margin
  const avgPerTrade = stats.totalPnl_bps / stats.trades; // bps
  const tradesPerYear = stats.perDay * 365;
  // Simple compounding: each trade is `avgPerTrade * leverage / 10000` return on capital * SIZE_PCT
  // Use 10% size per trade: each trade affects 10% of capital, so effective return = (avgPerTrade * leverage * 0.10) / 10000
  const effPerTrade = avgPerTrade * leverage * 0.10 / 10000;
  const annual = (1 + effPerTrade) ** tradesPerYear - 1;
  return +(annual * 100).toFixed(1); // %
}

// ─────────────────────────────────────────────────────────────────
// Run a full backtest with given params on loaded pairs, returns stats
// ─────────────────────────────────────────────────────────────────
function runBacktest(pairs, params) {
  const allTrades = [];
  for (const pd of pairs) {
    const t = backtestPair(pd, params);
    allTrades.push(...t);
  }
  return { trades: allTrades, stats: statsOf(allTrades) };
}

// Train/test split — by time
function splitTrades(trades, ratio = 0.7) {
  if (!trades.length) return { train: [], test: [] };
  trades.sort((a, b) => a.t - b.t);
  const cut = trades[0].t + (trades[trades.length - 1].t - trades[0].t) * ratio;
  return {
    train: trades.filter(t => t.t < cut),
    test:  trades.filter(t => t.t >= cut)
  };
}

// ─────────────────────────────────────────────────────────────────
// Grid search
// ─────────────────────────────────────────────────────────────────
function gridSearch(pairs) {
  const grid = {
    TP_BPS: [30, 50, 80, 120],
    SL_BPS: [15, 25, 40, 60],
    QUALITY_THRESHOLD: [0.6, 1.0, 1.5, 2.0],
    F_POS_MIN: [0.00015, 0.00030, 0.00060],
    F_NEG_MAX: [-0.00010, -0.00020, -0.00040],
    HOLD_H: [4, 8, 16],
    INVERT: [false, true],
    FEE_BPS: [8]
  };
  const results = [];
  let combo = 0;
  const total = Object.values(grid).reduce((a, b) => a * b.length, 1);
  console.log(`grid: ${total} combinations`);
  for (const TP of grid.TP_BPS)
    for (const SL of grid.SL_BPS)
      for (const QT of grid.QUALITY_THRESHOLD)
        for (const FP of grid.F_POS_MIN)
          for (const FN of grid.F_NEG_MAX)
            for (const H of grid.HOLD_H)
              for (const INV of grid.INVERT)
                for (const FEE of grid.FEE_BPS) {
                  combo++;
                  if (combo % 200 === 0) process.stdout.write(`  ${combo}/${total}\r`);
                  const params = { TP_BPS: TP, SL_BPS: SL, QUALITY_THRESHOLD: QT, F_POS_MIN: FP, F_NEG_MAX: FN, HOLD_H: H, INVERT: INV, FEE_BPS: FEE };
                  const { trades } = runBacktest(pairs, params);
                  if (trades.length < 100) continue;
                  const split = splitTrades(trades, 0.7);
                  const trainStats = statsOf(split.train);
                  const testStats = statsOf(split.test);
                  const annual = annualizedReturn(testStats, 3);
                  results.push({ params, train: trainStats, test: testStats, annual });
                }
  console.log('');
  return results;
}

// Composite score: profitability first (PF, annual), then trades/day, then WR.
// Hard floor: PF<1 OR annual<0 → score = -Infinity (we want PROFIT, not high WR alone)
function score(r) {
  const t = r.test;
  if (!t.trades || t.trades < 50) return -Infinity;
  if (t.pf < 1.0 || r.annual < 0) return -Infinity;       // must be profitable OOS
  const pfScore = Math.min(t.pf, 3) / 3;                   // 1.0 at PF 3
  const annualScore = Math.min(r.annual, 400) / 400;       // 1.0 at 400% annual
  const tdScore = Math.min(t.perDay, 15) / 15;             // 1.0 at 15 td
  const wrScore = Math.min(t.wr, 80) / 80;                 // 1.0 at 80% WR
  const ddPenalty = Math.max(0, 1 - t.dd_bps / 1000);      // 1.0 at 0 DD, 0 at 1000bps
  return pfScore * 0.30 + annualScore * 0.25 + tdScore * 0.20 + wrScore * 0.15 + ddPenalty * 0.10;
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────
async function runSource(sourceName) {
  console.log(`\n╔═══ FUNDING SOURCE: ${sourceName} ═══╗`);
  const pairs = [];
  for (const sym of UNIVERSE) {
    const pd = loadPair(sym, sourceName);
    if (pd) {
      enrichPair(pd);
      pairs.push(pd);
    }
  }
  console.log(`Loaded ${pairs.length} pairs`);
  if (!pairs.length) return [];

  // Stats sanity check: distribution of fundArr per source
  const sample = pairs[0];
  const finiteVals = [];
  for (let i = 0; i < sample.fundArr.length; i++) {
    if (isFinite(sample.fundArr[i])) finiteVals.push(sample.fundArr[i]);
  }
  finiteVals.sort((a, b) => a - b);
  const med = finiteVals[Math.floor(finiteVals.length/2)];
  const p10 = finiteVals[Math.floor(finiteVals.length*0.1)];
  const p90 = finiteVals[Math.floor(finiteVals.length*0.9)];
  console.log(`  ${sample.sym} fund range: p10=${p10?.toExponential(2)} med=${med?.toExponential(2)} p90=${p90?.toExponential(2)}`);

  console.log('Running grid search...');
  const results = gridSearch(pairs);
  console.log(`\n${results.length} valid configurations`);
  results.forEach(r => { r._score = score(r); r._source = sourceName; });
  results.sort((a, b) => b._score - a._score);

  // Top 5 per source
  console.log(`\n[${sourceName}] TOP 5 PROFITABLE OOS:`);
  let shown = 0;
  for (const r of results) {
    if (r._score === -Infinity) break;
    const p = r.params, t = r.test, tr = r.train;
    console.log(`  TP=${p.TP_BPS} SL=${p.SL_BPS} QT=${p.QUALITY_THRESHOLD} FP=${p.F_POS_MIN} FN=${p.F_NEG_MAX} H=${p.HOLD_H} INV=${p.INVERT}`);
    console.log(`    TRAIN: ${tr.trades}t WR=${tr.wr}% PF=${tr.pf} td=${tr.perDay} DD=${tr.dd_bps}bps`);
    console.log(`    TEST : ${t.trades}t WR=${t.wr}% PF=${t.pf} td=${t.perDay} DD=${t.dd_bps}bps annual=${r.annual}%`);
    if (++shown >= 5) break;
  }
  if (shown === 0) console.log('  NO profitable config in OOS (PF≥1, annual>0)');
  return results;
}

(async () => {
  const t0 = Date.now();
  let allResults = [];
  for (const src of ['proxy_ema', 'premium', 'funding_settled']) {
    const r = await runSource(src);
    allResults.push(...r);
  }

  // Global hard-targets filter
  const hardTargets = allResults.filter(r => {
    const t = r.test;
    return t.wr >= 70 && t.pf >= 1.5 && t.perDay >= 10 && r.annual >= 200 && t.dd_bps < 1500;
  });
  console.log(`\n╔═══ HARD TARGETS (WR≥70 PF≥1.5 td≥10 ann≥200% DD<1500bps) ═══╗`);
  console.log(`${hardTargets.length} configs satisfy all hard targets across all sources`);
  hardTargets.sort((a, b) => b._score - a._score);
  for (let i = 0; i < Math.min(10, hardTargets.length); i++) {
    const r = hardTargets[i];
    const p = r.params, t = r.test;
    console.log(`  [${r._source}] TP=${p.TP_BPS} SL=${p.SL_BPS} QT=${p.QUALITY_THRESHOLD} FP=${p.F_POS_MIN} FN=${p.F_NEG_MAX} H=${p.HOLD_H} INV=${p.INVERT}`);
    console.log(`    → WR=${t.wr}% PF=${t.pf} td=${t.perDay} DD=${t.dd_bps}bps annual=${r.annual}%`);
  }

  fs.writeFileSync('/tmp/v447-data/all-results.json', JSON.stringify(allResults.slice(0, 100), null, 2));
  console.log(`\nTotal time: ${((Date.now()-t0)/1000).toFixed(1)}s`);
})();
