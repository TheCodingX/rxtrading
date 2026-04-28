#!/usr/bin/env node
'use strict';
// V44.5 Holdout backtest — runs evaluateFundingCarry from v44-engine.js
// over the 365d holdout (2024-07-01 → 2025-06-30) with selectable palanca flags.
//
// Usage:
//   node backtest_v45_holdout.js [config_name]
// Configs:
//   baseline  — V44 (all flags off)
//   p1        — only P1 (fine sizing)
//   p7        — only P7 (term-structure)
//   p9        — only P9 (reentry cooldown)
//   all       — P1 + P7 + P9
//
// Output: /audit/results/v45_holdout_{config}.json with full daily PnL + trades

const fs = require('fs');
const path = require('path');

const KLINES_DIR = '/tmp/binance-klines-1h';
const OUT_DIR = path.join(__dirname, '..', 'results');
if(!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const CONFIG = (process.argv[2] || 'baseline').toLowerCase();
const VALID = ['baseline', 'p1', 'p7', 'p9', 'all'];
if(!VALID.includes(CONFIG)){
  console.error(`Invalid config: ${CONFIG}. Valid: ${VALID.join(', ')}`);
  process.exit(1);
}

// Set env vars BEFORE requiring engine (engine reads them via Object.freeze at module load)
if(CONFIG === 'p1' || CONFIG === 'all') process.env.APEX_V45_FINE_SIZING = '1';
if(CONFIG === 'p7' || CONFIG === 'all') process.env.APEX_V45_TERM_STRUCTURE = '1';
if(CONFIG === 'p9' || CONFIG === 'all') process.env.APEX_V45_REENTRY_COOLDOWN = '1';

const engine = require('../../backend/v44-engine.js');
const { evaluateFundingCarry, SAFE_FUNDING_PARAMS, markSLHitForCooldown } = engine;

console.log(`═`.repeat(80));
console.log(`V44.5 HOLDOUT BACKTEST — config: ${CONFIG.toUpperCase()}`);
console.log(`═`.repeat(80));
console.log(`Flags: P1=${SAFE_FUNDING_PARAMS.V45_ELITE_M1_FINE_ENABLED} P7=${SAFE_FUNDING_PARAMS.V45_TERM_STRUCTURE_ENABLED} P9=${SAFE_FUNDING_PARAMS.V45_REENTRY_COOLDOWN_ENABLED}`);

// Load all klines
const PAIRS = SAFE_FUNDING_PARAMS.UNIVERSE;
const data = {};
for(const p of PAIRS){
  const f = path.join(KLINES_DIR, `${p}.json`);
  if(!fs.existsSync(f)){ console.log(`  ${p} MISSING`); continue; }
  const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
  // Convert to bars1h format expected by engine: { t, c }
  data[p] = arr.map(b => ({ t: b[0], h: b[2], l: b[3], c: b[4] }));
  // Pad for indicators that need warmup
  if(data[p].length < 800) console.log(`  ${p} only ${data[p].length} bars (need 800+ for V44 z-lookback)`);
}
console.log(`Loaded ${Object.keys(data).length} pairs`);
console.log('');

// Backtest: walk forward through every hour, evaluate signal, simulate exit
// Capital: $10,000, sizing: SIZE_PCT × multiplier
const CAPITAL = 10000;
const HOLD_HOURS = SAFE_FUNDING_PARAMS.HOLD_H;  // 4h max hold

const trades = [];
const dailyPnL = {};

// Sort pairs by length descending to process most-data first
const pairList = Object.keys(data).sort((a,b) => data[b].length - data[a].length);

let totalEvals = 0;
let totalSignals = 0;
let cooldownsApplied = 0;

const t0 = Date.now();

for(const pair of pairList){
  const bars = data[pair];
  // Need at least Z_LOOKBACK + 50 = 770 bars warmup
  const startIdx = SAFE_FUNDING_PARAMS.Z_LOOKBACK_H + 50;
  for(let i = startIdx; i < bars.length; i++){
    totalEvals++;
    // evaluateFundingCarry expects bars1h array up to current bar
    const slice = bars.slice(0, i + 1);
    const signal = evaluateFundingCarry(pair, slice);
    if(!signal) continue;
    totalSignals++;

    // Simulate trade outcome: walk forward up to HOLD_HOURS
    const entryT = signal.timestamp || bars[i].t;
    const entry = signal.entry;
    const tp = signal.tp;
    const sl = signal.sl;
    const dir = signal.signal === 'BUY' ? 1 : -1;
    const sizeMult = signal.size_multiplier;
    const lev = signal.leverage;
    const positionUSD = CAPITAL * SAFE_FUNDING_PARAMS.SIZE_PCT * sizeMult * lev;

    let exitPrice = bars[i].c;
    let exitT = bars[i].t;
    let outcome = 'TIME_STOP';
    let exitIdx = i;

    for(let j = 1; j <= HOLD_HOURS && (i + j) < bars.length; j++){
      const hb = bars[i + j];
      // Check both directions for TP/SL hit (using high/low for accuracy)
      const high = hb.h || hb.c;
      const low = hb.l || hb.c;
      if(dir === 1){
        if(low <= sl){ exitPrice = sl; exitT = hb.t; outcome = 'SL_HIT'; exitIdx = i + j; break; }
        if(high >= tp){ exitPrice = tp; exitT = hb.t; outcome = 'TP_HIT'; exitIdx = i + j; break; }
      } else {
        if(high >= sl){ exitPrice = sl; exitT = hb.t; outcome = 'SL_HIT'; exitIdx = i + j; break; }
        if(low <= tp){ exitPrice = tp; exitT = hb.t; outcome = 'TP_HIT'; exitIdx = i + j; break; }
      }
      exitPrice = hb.c;
      exitT = hb.t;
      exitIdx = i + j;
    }

    // PnL: (exit - entry) × dir × position / entry
    const pnlPct = (exitPrice - entry) * dir / entry;
    const pnlUSD = pnlPct * positionUSD;

    // Apply cooldown if SL_HIT and palanca enabled
    if(outcome === 'SL_HIT' && SAFE_FUNDING_PARAMS.V45_REENTRY_COOLDOWN_ENABLED){
      markSLHitForCooldown(pair, signal.signal, exitT);
    }

    const dayKey = new Date(entryT).toISOString().slice(0, 10);
    dailyPnL[dayKey] = (dailyPnL[dayKey] || 0) + pnlUSD;

    trades.push({
      pair,
      entryT, exitT,
      direction: signal.signal,
      entry, exit: exitPrice,
      tp, sl,
      pnlUSD, pnlPct,
      sizeMult,
      qualityScore: signal.quality_score,
      tsBoost: signal.ts_boost || 1.0,
      confidence: signal.confidence,
      outcome,
      windowType: signal.window_type
    });

    // Skip past exit to avoid overlap
    i = exitIdx;
  }
  process.stdout.write(`  ${pair.padEnd(14)} ${trades.filter(t => t.pair === pair).length} trades\n`);
}

const dt = ((Date.now() - t0) / 1000).toFixed(1);
console.log('');
console.log(`Walked ${totalEvals} evaluations, ${totalSignals} signals, ${trades.length} trades in ${dt}s`);

// === COMPUTE STATS ===
function computeStats(trades, dailyPnL){
  if(trades.length === 0) return { n: 0 };
  const wins = trades.filter(t => t.pnlUSD > 0);
  const losses = trades.filter(t => t.pnlUSD < 0);
  const grossProfit = wins.reduce((s,t) => s + t.pnlUSD, 0);
  const grossLoss = -losses.reduce((s,t) => s + t.pnlUSD, 0);
  const pf = grossLoss > 0 ? grossProfit / grossLoss : 999;
  const wr = (wins.length / trades.length) * 100;
  const totalPnL = wins.length + losses.length > 0
    ? trades.reduce((s,t) => s + t.pnlUSD, 0)
    : 0;
  // Sharpe (annualized from daily)
  const days = Object.keys(dailyPnL).sort();
  const dailyReturns = days.map(d => dailyPnL[d] / CAPITAL);
  const meanRet = dailyReturns.reduce((a,b)=>a+b, 0) / Math.max(1, dailyReturns.length);
  const variance = dailyReturns.reduce((s,r)=>s+(r-meanRet)*(r-meanRet), 0) / Math.max(1, dailyReturns.length);
  const stdRet = Math.sqrt(variance);
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(365) : 0;
  // Max drawdown from cumulative daily PnL
  let peak = 0, mdd = 0, cum = 0;
  for(const d of days){
    cum += dailyPnL[d];
    if(cum > peak) peak = cum;
    const dd = peak - cum;
    if(dd > mdd) mdd = dd;
  }
  const mddPct = (mdd / CAPITAL) * 100;
  // t/d
  const tradeDays = days.length;
  const tpd = tradeDays > 0 ? trades.length / tradeDays : 0;

  return {
    n: trades.length,
    wins: wins.length,
    losses: losses.length,
    pf, wr,
    pnl: totalPnL,
    sharpe,
    mdd, mddPct,
    tpd,
    days: tradeDays,
    grossProfit, grossLoss,
    avgWin: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLoss / losses.length : 0
  };
}

const stats = computeStats(trades, dailyPnL);
console.log('');
console.log('─'.repeat(60));
console.log(`STATS — ${CONFIG.toUpperCase()}`);
console.log('─'.repeat(60));
console.log(`Trades:    ${stats.n}  (W: ${stats.wins}, L: ${stats.losses})`);
console.log(`PF:        ${stats.pf.toFixed(3)}`);
console.log(`WR:        ${stats.wr.toFixed(2)}%`);
console.log(`PnL:       $${stats.pnl.toFixed(2)}`);
console.log(`Sharpe:    ${stats.sharpe.toFixed(2)}`);
console.log(`Max DD:    ${stats.mddPct.toFixed(2)}%  ($${stats.mdd.toFixed(2)})`);
console.log(`t/d:       ${stats.tpd.toFixed(2)}`);
console.log(`Days:      ${stats.days}`);

// 7d window distribution
const sortedDays = Object.keys(dailyPnL).sort();
const windows7d = [];
for(let i = 0; i + 6 < sortedDays.length; i++){
  const win = sortedDays.slice(i, i + 7);
  const winPnL = win.reduce((s,d) => s + dailyPnL[d], 0);
  windows7d.push({ start: win[0], end: win[6], pnl: winPnL });
}
const positiveWins = windows7d.filter(w => w.pnl > 0).length;
const positivePct = windows7d.length > 0 ? (positiveWins / windows7d.length) * 100 : 0;
const sortedPnLs = windows7d.map(w => w.pnl).sort((a,b) => a-b);
const worstWin = sortedPnLs.length > 0 ? sortedPnLs[0] : 0;
const worstPct = (worstWin / CAPITAL) * 100;

console.log('');
console.log(`7d windows: ${windows7d.length} total, ${positiveWins} positive (${positivePct.toFixed(1)}%)`);
console.log(`Worst 7d:   $${worstWin.toFixed(2)} (${worstPct.toFixed(2)}% of capital)`);

const out = {
  config: CONFIG,
  flags: {
    P1: SAFE_FUNDING_PARAMS.V45_ELITE_M1_FINE_ENABLED,
    P7: SAFE_FUNDING_PARAMS.V45_TERM_STRUCTURE_ENABLED,
    P9: SAFE_FUNDING_PARAMS.V45_REENTRY_COOLDOWN_ENABLED
  },
  stats,
  positivePct,
  worstWin,
  worstPct,
  windows7d_count: windows7d.length,
  windows7d_positive: positiveWins,
  dailyPnL,
  trades_summary: {
    total: trades.length,
    by_outcome: {
      TP_HIT: trades.filter(t => t.outcome === 'TP_HIT').length,
      SL_HIT: trades.filter(t => t.outcome === 'SL_HIT').length,
      TIME_STOP: trades.filter(t => t.outcome === 'TIME_STOP').length
    },
    by_pair: pairList.reduce((acc, p) => {
      const pt = trades.filter(t => t.pair === p);
      acc[p] = { n: pt.length, pnl: pt.reduce((s,t) => s + t.pnlUSD, 0) };
      return acc;
    }, {})
  },
  runtime_s: parseFloat(dt)
};

const outFile = path.join(OUT_DIR, `v45_holdout_${CONFIG}.json`);
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`\n✓ Saved: ${outFile}`);
