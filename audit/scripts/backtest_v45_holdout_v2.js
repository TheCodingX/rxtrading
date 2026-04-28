#!/usr/bin/env node
'use strict';
// V44.5 Holdout backtest — Uses ORIGINAL apex_x_engine.js stream_b logic (validated).
// Layers V44.5 palancas (P1, P7, P9) on top via env flags.
//
// Period: 2024-07-01 → 2025-06-30 (365d holdout OOS)
// Source: /tmp/binance-klines-1h/{SYMBOL}.json (downloaded by download_klines_holdout.js)
//
// Usage:
//   node backtest_v45_holdout_v2.js [config_name]
// Configs: baseline, p1, p7, p9, p1+p9, all
//
// Comparable directly with archive/research/research-v44/apex-x/results/02_holdout.json stream_b

const fs = require('fs');
const path = require('path');

const KLINES_DIR = '/tmp/binance-klines-1h';
const OUT_DIR = path.join(__dirname, '..', 'results');
if(!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const CONFIG = (process.argv[2] || 'baseline').toLowerCase();
const VALID = ['baseline', 'p1', 'p7', 'p9', 'p1+p7', 'p1+p9', 'all'];
if(!VALID.includes(CONFIG)){
  console.error(`Invalid config: ${CONFIG}. Valid: ${VALID.join(', ')}`);
  process.exit(1);
}

// Flag detection (controls which palancas activate)
const FLAGS = {
  P1: CONFIG.includes('p1') || CONFIG === 'all',
  P7: CONFIG.includes('p7') || CONFIG === 'all',
  P9: CONFIG.includes('p9') || CONFIG === 'all'
};

const PAIRS = [
  'ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT',
  'BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT',
  'SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'
];

console.log('═'.repeat(80));
console.log(`V44.5 HOLDOUT BACKTEST v2 — config: ${CONFIG.toUpperCase()}`);
console.log('═'.repeat(80));
console.log(`Flags: P1=${FLAGS.P1} P7=${FLAGS.P7} P9=${FLAGS.P9}`);
console.log(`Engine: original apex_x_engine.js stream_b + V44.5 layers`);
console.log('');

// Load 1h klines
const data = {};
for(const p of PAIRS){
  const f = path.join(KLINES_DIR, `${p}.json`);
  if(!fs.existsSync(f)){ console.log(`  ${p} MISSING`); continue; }
  const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
  data[p] = arr.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
}
console.log(`Loaded ${Object.keys(data).length} pairs`);

// === ORIGINAL FUNDING PROXY (matches stream_b) ===
function proxyFunding(bars1h){
  const n = bars1h.length;
  const c = bars1h.map(b => b.c);
  const ema = new Float64Array(n);
  ema[0] = c[0];
  const alpha = 2 / (50 + 1);
  for(let i = 1; i < n; i++) ema[i] = c[i] * alpha + ema[i-1] * (1 - alpha);
  const premium = c.map((v, i) => (v - ema[i]) / ema[i]);
  const funding = new Float64Array(n);
  const w = 8;
  for(let i = w; i < n; i++){
    let s = 0;
    for(let j = i - w + 1; j <= i; j++) s += premium[j];
    funding[i] = s / w;
  }
  return funding;
}

// === V44.5 PALANCA 1: Sizing fino continuous ===
function sizeMultV45_P1(qualityScore){
  const bp = [
    [0.000, 0.50],   // very low quality (vs threshold 0)
    [0.500, 0.70],   // P50 of stream_b funding regime
    [0.800, 0.85],
    [1.100, 1.00],
    [1.500, 1.20],
    [2.000, 1.50],
    [2.500, 1.80],
    [3.500, 2.00]
  ];
  const q = Math.max(0, qualityScore);
  if(q <= bp[0][0]) return bp[0][1];
  if(q >= bp[bp.length-1][0]) return bp[bp.length-1][1];
  for(let i = 0; i < bp.length - 1; i++){
    const [q1, m1] = bp[i];
    const [q2, m2] = bp[i+1];
    if(q >= q1 && q <= q2){
      const t = (q - q1) / (q2 - q1);
      return m1 + t * (m2 - m1);
    }
  }
  return 1.0;
}

// === V44.5 PALANCA 7: Term-structure boost ===
function termStructureBoost(fund, idx, dir){
  const N24 = 24;
  const N7D = 168;
  if(idx < N7D) return 1.0;
  const f24 = [];
  for(let j = idx - N24; j < idx; j++) if(isFinite(fund[j])) f24.push(fund[j]);
  const f7d = [];
  for(let j = idx - N7D; j < idx; j++) if(isFinite(fund[j])) f7d.push(fund[j]);
  if(f24.length < N24/2 || f7d.length < N7D/2) return 1.0;
  const mean24 = f24.reduce((a,b)=>a+b, 0) / f24.length;
  const mean7d = f7d.reduce((a,b)=>a+b, 0) / f7d.length;
  const stdDev = Math.sqrt(f7d.reduce((s,v)=>s+(v-mean7d)**2, 0) / f7d.length);
  const divergence = mean24 - mean7d;
  const alignedDivergence = dir === 1 ? -divergence : divergence;
  const normalizedDivergence = stdDev > 0 ? alignedDivergence / stdDev : 0;
  const trendBoost = Math.max(0, Math.min(0.30, normalizedDivergence * 0.15));

  let accelBoost = 0;
  if(idx >= 18){
    const m1 = fund.slice(idx-6, idx).filter(isFinite).reduce((a,b)=>a+b, 0) / 6;
    const m2 = fund.slice(idx-12, idx-6).filter(isFinite).reduce((a,b)=>a+b, 0) / 6;
    const m3 = fund.slice(idx-18, idx-12).filter(isFinite).reduce((a,b)=>a+b, 0) / 6;
    const accel = (m1 - m2) - (m2 - m3);
    const alignedAccel = dir === 1 ? -accel : accel;
    if(alignedAccel > 0 && stdDev > 0){
      accelBoost = Math.min(0.20, (alignedAccel / stdDev) * 0.25);
    }
  }
  return 1.0 + trendBoost + accelBoost;
}

// === V44.5 PALANCA 9: Reentry cooldown ===
const _cooldownMap = new Map();  // {pair}:{dir} → ts of last SL
function cooldownActive(pair, dir, nowMs){
  if(!FLAGS.P9) return false;
  const key = `${pair}:${dir}`;
  const lastSL = _cooldownMap.get(key);
  if(!lastSL) return false;
  const COOLDOWN_MS = 8 * 3600 * 1000;
  if(nowMs - lastSL < COOLDOWN_MS) return true;
  _cooldownMap.delete(key);
  return false;
}
function markSL(pair, dir, ts){
  _cooldownMap.set(`${pair}:${dir}`, ts);
}

// === Stream B simulation (V44 funding carry) with V44.5 layers ===
const INIT_CAP = 500;
const SIZE_PCT = 0.10;
const TP_BPS = 30;
const SL_BPS = 25;
const HOLD_H = 4;
const FEE_RT = 0.0008;  // round-trip fee
const SLIP_SL = 0.0002;

const trades = [];
let cap = INIT_CAP;
const dailyPnL = {};

const t0 = Date.now();

for(const pair of PAIRS){
  if(!data[pair]) continue;
  const bars = data[pair];
  const fund = proxyFunding(bars);

  let pos = null;
  for(let i = 50; i < bars.length - HOLD_H; i++){
    const ts = bars[i].t;
    const d = new Date(ts);
    const hr = d.getUTCHours();

    // === Check existing position for exits ===
    if(pos){
      const entry = pos.entry;
      const dir = pos.dir;
      const h = bars[i].h;
      const l = bars[i].l;
      const tpP = dir === 1 ? entry * (1 + TP_BPS/10000) : entry * (1 - TP_BPS/10000);
      const slP = dir === 1 ? entry * (1 - SL_BPS/10000) : entry * (1 + SL_BPS/10000);
      const hitTP = (dir === 1 && h >= tpP) || (dir === -1 && l <= tpP);
      const hitSL = (dir === 1 && l <= slP) || (dir === -1 && h >= slP);
      const timeout = i >= pos.entryI + HOLD_H;

      if(hitTP || hitSL || timeout){
        const exitP = hitTP ? tpP : (hitSL ? (dir === 1 ? slP * (1 - SLIP_SL) : slP * (1 + SLIP_SL)) : bars[i].c);
        const pnlPct = dir === 1 ? (exitP - entry) / entry : (entry - exitP) / entry;
        const pnl = pos.size * pnlPct - pos.size * FEE_RT;
        cap += pnl;
        const dateKey = d.toISOString().slice(0, 10);
        dailyPnL[dateKey] = (dailyPnL[dateKey] || 0) + pnl;

        const outcome = hitTP ? 'TP' : (hitSL ? 'SL' : 'TO');
        trades.push({
          pnl,
          date: dateKey,
          ts,
          pair,
          entryTs: bars[pos.entryI].t,
          dir: pos.dir,
          size: pos.size,
          sizeMult: pos.sizeMult || 1.0,
          qualityScore: pos.qualityScore || 0,
          tsBoost: pos.tsBoost || 1.0,
          type: outcome,
          stream: 'B'
        });

        // V44.5 Palanca 9: register SL hit for cooldown
        if(outcome === 'SL'){
          markSL(pair, pos.dir === 1 ? 'BUY' : 'SELL', ts);
        }
        pos = null;
      }
    }

    // === Check for new entry ===
    if(!pos && (hr === 0 || hr === 8 || hr === 16)){
      const f = fund[i];
      if(!isFinite(f)) continue;
      const fWin = [];
      for(let j = Math.max(0, i - 168); j < i; j++) if(isFinite(fund[j])) fWin.push(fund[j]);
      if(fWin.length < 50) continue;
      const sorted = [...fWin].sort((a, b) => a - b);
      const p80 = sorted[Math.floor(sorted.length * 0.80)] || 0;
      const p20 = sorted[Math.floor(sorted.length * 0.20)] || 0;

      let dir = 0;
      if(f > p80 && f > 0.005) dir = -1;
      else if(f < p20 && f < -0.002) dir = 1;
      if(dir === 0) continue;

      // V44.5 Palanca 9: Cooldown check
      if(cooldownActive(pair, dir === 1 ? 'BUY' : 'SELL', ts)) continue;

      // Compute quality_score = |z-score of funding|
      const fMean = fWin.reduce((a,b)=>a+b, 0) / fWin.length;
      const fStd = Math.sqrt(fWin.reduce((s,v)=>s+(v-fMean)**2, 0) / fWin.length);
      const z = fStd > 0 ? (f - fMean) / fStd : 0;
      let qualityScore = Math.abs(z);

      // V44.5 Palanca 7: Term-structure boost
      let tsBoost = 1.0;
      if(FLAGS.P7){
        tsBoost = termStructureBoost(fund, i, dir);
        qualityScore *= tsBoost;
      }

      // V44.5 Palanca 1: Fine sizing OR V44 default (1.0×)
      const sizeMult = FLAGS.P1 ? sizeMultV45_P1(qualityScore) : 1.0;

      pos = {
        entry: bars[i].c,
        dir,
        entryI: i,
        size: cap * SIZE_PCT * sizeMult,
        sizeMult,
        qualityScore,
        tsBoost
      };
    }
  }
}

const dt = ((Date.now() - t0) / 1000).toFixed(1);

// === Compute stats ===
function computeStats(trades, dailyPnL, capital = INIT_CAP){
  if(trades.length === 0) return { n: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s,t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s,t) => s + t.pnl, 0);
  const pf = grossLoss > 0 ? grossProfit / grossLoss : 999;
  const wr = (wins.length / trades.length) * 100;
  const totalPnL = trades.reduce((s,t) => s + t.pnl, 0);

  const days = Object.keys(dailyPnL).sort();
  const dailyReturns = days.map(d => dailyPnL[d] / capital);
  const meanRet = dailyReturns.reduce((a,b)=>a+b, 0) / Math.max(1, dailyReturns.length);
  const variance = dailyReturns.reduce((s,r)=>s+(r-meanRet)*(r-meanRet), 0) / Math.max(1, dailyReturns.length);
  const stdRet = Math.sqrt(variance);
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(365) : 0;

  let peak = 0, mdd = 0, cum = 0;
  for(const dt of days){
    cum += dailyPnL[dt];
    if(cum > peak) peak = cum;
    const dd = peak - cum;
    if(dd > mdd) mdd = dd;
  }
  const finalCap = capital + totalPnL;
  const mddPct = (mdd / Math.max(capital, finalCap)) * 100;
  const tpd = days.length > 0 ? trades.length / days.length : 0;

  return {
    n: trades.length, wins: wins.length, losses: losses.length,
    pf, wr, pnl: totalPnL, sharpe, mdd, mddPct, tpd, days: days.length,
    grossProfit, grossLoss,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0
  };
}

const stats = computeStats(trades, dailyPnL);

console.log('');
console.log('─'.repeat(70));
console.log(`STATS — ${CONFIG.toUpperCase()}`);
console.log('─'.repeat(70));
console.log(`Trades:    ${stats.n}  (W: ${stats.wins}, L: ${stats.losses})`);
console.log(`PF:        ${stats.pf.toFixed(3)}`);
console.log(`WR:        ${stats.wr.toFixed(2)}%`);
console.log(`PnL:       $${stats.pnl.toFixed(2)}  (cap: $${INIT_CAP} → $${(INIT_CAP + stats.pnl).toFixed(2)})`);
console.log(`Sharpe:    ${stats.sharpe.toFixed(2)}`);
console.log(`Max DD:    ${stats.mddPct.toFixed(2)}%  ($${stats.mdd.toFixed(2)})`);
console.log(`t/d:       ${stats.tpd.toFixed(2)}`);
console.log(`Days:      ${stats.days}`);
console.log(`Avg win:   $${stats.avgWin.toFixed(2)} / Avg loss: $${stats.avgLoss.toFixed(2)}`);

// 7d window distribution
const sortedDays = Object.keys(dailyPnL).sort();
const windows7d = [];
for(let i = 0; i + 6 < sortedDays.length; i++){
  const w = sortedDays.slice(i, i + 7);
  const winPnL = w.reduce((s, d) => s + dailyPnL[d], 0);
  windows7d.push({ start: w[0], end: w[6], pnl: winPnL });
}
const positiveWins = windows7d.filter(w => w.pnl > 0).length;
const positivePct = windows7d.length > 0 ? (positiveWins / windows7d.length) * 100 : 0;
const sortedPnLs = windows7d.map(w => w.pnl).sort((a, b) => a - b);
const worstWin = sortedPnLs[0] || 0;
const worstPct = (worstWin / INIT_CAP) * 100;
const bestWin = sortedPnLs[sortedPnLs.length - 1] || 0;
const bestPct = (bestWin / INIT_CAP) * 100;
const medianPnL = sortedPnLs[Math.floor(sortedPnLs.length / 2)] || 0;

console.log('');
console.log(`7d windows: ${windows7d.length} total, ${positiveWins} positive (${positivePct.toFixed(1)}%)`);
console.log(`Worst 7d:   $${worstWin.toFixed(2)} (${worstPct.toFixed(2)}% of capital)`);
console.log(`Best 7d:    $${bestWin.toFixed(2)} (${bestPct.toFixed(2)}%)`);
console.log(`Median 7d:  $${medianPnL.toFixed(2)}`);

// Outcome breakdown
const tpHits = trades.filter(t => t.type === 'TP').length;
const slHits = trades.filter(t => t.type === 'SL').length;
const toHits = trades.filter(t => t.type === 'TO').length;
console.log('');
console.log(`Exits: TP=${tpHits} (${(tpHits/trades.length*100).toFixed(1)}%) | SL=${slHits} (${(slHits/trades.length*100).toFixed(1)}%) | TO=${toHits} (${(toHits/trades.length*100).toFixed(1)}%)`);

console.log('');
console.log(`Runtime: ${dt}s`);

// Save full results
const out = {
  config: CONFIG,
  flags: FLAGS,
  period: { start: '2024-07-01', end: '2025-06-30' },
  stats,
  positivePct, worstWin, worstPct, bestWin, bestPct, medianPnL,
  windows7d_count: windows7d.length,
  windows7d_positive: positiveWins,
  by_outcome: { TP: tpHits, SL: slHits, TO: toHits },
  by_pair: PAIRS.reduce((acc, p) => {
    const pt = trades.filter(t => t.pair === p);
    if(pt.length === 0) return acc;
    const w = pt.filter(t => t.pnl > 0).length;
    const totalPnL = pt.reduce((s, t) => s + t.pnl, 0);
    acc[p] = { n: pt.length, wr: (w/pt.length)*100, pnl: totalPnL };
    return acc;
  }, {}),
  dailyPnL,
  trades_sample: trades.slice(0, 20),  // sample for inspection
  runtime_s: parseFloat(dt)
};

const outFile = path.join(OUT_DIR, `v45_holdout_v2_${CONFIG.replace('+','_')}.json`);
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`✓ Saved: ${outFile}`);
