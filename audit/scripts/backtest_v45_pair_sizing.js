#!/usr/bin/env node
'use strict';
// V44.5 PALANCA 11 — By-pair sizing based on rolling historical performance.
// Avoids look-ahead by using PURGED rolling window (last 90d, gap 7d to current).
//
// Hypothesis: pairs with rolling PF >1.8 deserve size×1.5; pairs with PF<1.0 deserve size×0.5.
// This adapts dynamically based on actual recent performance, not fixed.

const fs = require('fs');
const path = require('path');

const KLINES_DIR = '/tmp/binance-klines-1h';
const OUT_DIR = path.join(__dirname, '..', 'results');

const PAIRS = [
  'ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT',
  'BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT',
  'SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'
];

// Rolling window params — out-of-sample protected
const ROLLING_LOOKBACK_DAYS = 90;
const GAP_DAYS = 7;  // Purge gap to avoid leak
const MIN_TRADES_FOR_ESTIMATE = 30;

console.log('═'.repeat(80));
console.log('V44.5 PALANCA 11 — BY-PAIR SIZING (rolling historical PF)');
console.log('═'.repeat(80));

// Load data
const data = {};
for(const p of PAIRS){
  const f = path.join(KLINES_DIR, `${p}.json`);
  if(!fs.existsSync(f)) continue;
  const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
  data[p] = arr.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
}
console.log(`Loaded ${Object.keys(data).length} pairs`);

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

// Pair sizing function based on rolling historical PF
function pairSizeMult(rollingPF){
  if(rollingPF === null || rollingPF === undefined) return 1.0;  // No history yet
  if(rollingPF >= 2.5) return 1.6;
  if(rollingPF >= 2.0) return 1.4;
  if(rollingPF >= 1.5) return 1.2;
  if(rollingPF >= 1.2) return 1.0;
  if(rollingPF >= 1.0) return 0.85;
  if(rollingPF >= 0.8) return 0.65;
  return 0.45;  // PF < 0.8 — strong underperformer
}

const INIT_CAP = 500;
const SIZE_PCT = 0.10;
const TP_BPS = 30;
const SL_BPS = 25;
const HOLD_H = 4;
const FEE_RT = 0.0008;
const SLIP_SL = 0.0002;

const trades = [];
let cap = INIT_CAP;
const dailyPnL = {};
const tradesByPair = {};  // for rolling stats
PAIRS.forEach(p => tradesByPair[p] = []);

function rollingPF(pairTrades, currentTs){
  // Trades in window [currentTs - LOOKBACK - GAP, currentTs - GAP]
  const cutoffEnd = currentTs - GAP_DAYS * 86400000;
  const cutoffStart = cutoffEnd - ROLLING_LOOKBACK_DAYS * 86400000;
  const window = pairTrades.filter(t => t.ts >= cutoffStart && t.ts <= cutoffEnd);
  if(window.length < MIN_TRADES_FOR_ESTIMATE) return null;
  const wins = window.filter(t => t.pnl > 0);
  const losses = window.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s,t)=>s+t.pnl, 0);
  const gl = -losses.reduce((s,t)=>s+t.pnl, 0);
  return gl > 0 ? gp / gl : 999;
}

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

        const trade = {
          pnl, ts, pair, dir: pos.dir,
          size: pos.size,
          sizeMult: pos.pairSizeMult,
          rollingPF: pos.rollingPF,
          type: hitTP ? 'TP' : (hitSL ? 'SL' : 'TO')
        };
        trades.push(trade);
        tradesByPair[pair].push(trade);
        pos = null;
      }
    }

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

      // PALANCA 11: rolling PF based sizing
      const histPF = rollingPF(tradesByPair[pair], ts);
      const pairMult = pairSizeMult(histPF);

      pos = {
        entry: bars[i].c, dir, entryI: i,
        size: cap * SIZE_PCT * pairMult,
        pairSizeMult: pairMult,
        rollingPF: histPF
      };
    }
  }
}

const dt = ((Date.now() - t0) / 1000).toFixed(1);

// Stats
function computeStats(trades, dailyPnL, capital = INIT_CAP){
  if(trades.length === 0) return { n: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s,t) => s + t.pnl, 0);
  const gl = -losses.reduce((s,t) => s + t.pnl, 0);
  const pf = gl > 0 ? gp / gl : 999;
  const wr = (wins.length / trades.length) * 100;
  const totalPnL = trades.reduce((s,t) => s + t.pnl, 0);
  const days = Object.keys(dailyPnL).sort();
  const dailyReturns = days.map(d => dailyPnL[d] / capital);
  const meanRet = dailyReturns.reduce((a,b)=>a+b, 0) / Math.max(1, dailyReturns.length);
  const variance = dailyReturns.reduce((s,r)=>s+(r-meanRet)**2, 0) / Math.max(1, dailyReturns.length);
  const sharpe = Math.sqrt(variance) > 0 ? (meanRet / Math.sqrt(variance)) * Math.sqrt(365) : 0;
  let peak = 0, mdd = 0, cum = 0;
  for(const dt of days){
    cum += dailyPnL[dt];
    if(cum > peak) peak = cum;
    if(peak - cum > mdd) mdd = peak - cum;
  }
  const tpd = days.length > 0 ? trades.length / days.length : 0;
  return { n: trades.length, wins: wins.length, losses: losses.length, pf, wr, pnl: totalPnL, sharpe, mdd, mddPct: (mdd/capital)*100, tpd, days: days.length };
}

const stats = computeStats(trades, dailyPnL);
console.log('');
console.log(`Trades: ${stats.n}  PF: ${stats.pf.toFixed(3)}  WR: ${stats.wr.toFixed(2)}%  PnL: $${stats.pnl.toFixed(2)}  DD: ${stats.mddPct.toFixed(2)}%  Sharpe: ${stats.sharpe.toFixed(2)}  t/d: ${stats.tpd.toFixed(2)}`);

// 7d windows
const sortedDays = Object.keys(dailyPnL).sort();
const windows7d = [];
for(let i = 0; i + 6 < sortedDays.length; i++){
  const w = sortedDays.slice(i, i + 7);
  windows7d.push({ pnl: w.reduce((s, d) => s + dailyPnL[d], 0) });
}
const positive = windows7d.filter(w => w.pnl > 0).length;
const sortedPnLs = windows7d.map(w => w.pnl).sort((a,b)=>a-b);
console.log(`7d windows: ${(positive/windows7d.length*100).toFixed(1)}% positive (${positive}/${windows7d.length})`);
console.log(`Worst 7d: $${sortedPnLs[0].toFixed(2)} (${(sortedPnLs[0]/INIT_CAP*100).toFixed(2)}% cap)`);

// By-pair breakdown
console.log('\nBY-PAIR with size multiplier applied:');
console.log(`${'pair'.padEnd(14)} ${'n'.padStart(5)} ${'WR%'.padStart(6)} ${'PF'.padStart(7)} ${'PnL'.padStart(9)} ${'avgMult'.padStart(8)}`);
PAIRS.forEach(p => {
  const pt = tradesByPair[p];
  if(pt.length === 0) return;
  const w = pt.filter(t => t.pnl > 0);
  const gp = w.reduce((s,t)=>s+t.pnl, 0);
  const gl = -pt.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl, 0);
  const avgMult = pt.reduce((s,t)=>s + (t.sizeMult||1), 0) / pt.length;
  console.log(`${p.padEnd(14)} ${String(pt.length).padStart(5)} ${(w.length/pt.length*100).toFixed(1).padStart(6)} ${(gl>0?gp/gl:999).toFixed(3).padStart(7)} ${pt.reduce((s,t)=>s+t.pnl,0).toFixed(2).padStart(9)} ${avgMult.toFixed(2).padStart(8)}`);
});

const out = {
  config: 'p11_pair_sizing',
  stats,
  positivePct: (positive / windows7d.length) * 100,
  worstWin: sortedPnLs[0],
  windows7d_count: windows7d.length,
  windows7d_positive: positive,
  by_pair: PAIRS.reduce((acc, p) => {
    const pt = tradesByPair[p];
    if(pt.length === 0) return acc;
    const w = pt.filter(t => t.pnl > 0);
    acc[p] = { n: pt.length, wr: (w.length/pt.length)*100, pnl: pt.reduce((s,t)=>s+t.pnl, 0) };
    return acc;
  }, {}),
  dailyPnL,
  runtime_s: parseFloat(dt)
};

fs.writeFileSync(path.join(OUT_DIR, 'v45_holdout_v2_p11_pair_sizing.json'), JSON.stringify(out, null, 2));
console.log(`\n✓ Saved: ${OUT_DIR}/v45_holdout_v2_p11_pair_sizing.json`);
