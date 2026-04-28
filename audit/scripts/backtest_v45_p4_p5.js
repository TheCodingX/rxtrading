#!/usr/bin/env node
'use strict';
// V44.5 PALANCA 4 — Regime-conditional sizing
// V44.5 PALANCA 5 — Position correlation management
//
// Tests P4 + P5 individual and combined with the winning P11+P7 stack.
//
// Usage: node backtest_v45_p4_p5.js [config]
//   p4_only, p5_only, p4_p11, p5_p11, p4_p5_p11_p7

const fs = require('fs');
const path = require('path');

const CFG = (process.argv[2] || 'p4_only').toLowerCase();
const VALID = ['p4_only', 'p5_only', 'p4_p11', 'p5_p11', 'p4_p5_p11', 'p4_p5_p11_p7'];
if(!VALID.includes(CFG)){
  console.error(`Invalid: ${CFG}. Valid: ${VALID.join(', ')}`);
  process.exit(1);
}

const FLAGS = {
  P4: CFG.includes('p4'),
  P5: CFG.includes('p5'),
  P11: CFG.includes('p11'),
  P7: CFG.includes('p7')
};

const KLINES_DIR = '/tmp/binance-klines-1h';
const OUT_DIR = path.join(__dirname, '..', 'results');

const PAIRS = [
  'ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT',
  'BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT',
  'SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'
];

// Pair correlation clusters (from research)
const CLUSTERS = {
  BTCUSDT: 'L1maj', ETHUSDT: 'L1maj',
  SOLUSDT: 'SOLadj', SUIUSDT: 'SOLadj', NEARUSDT: 'SOLadj',
  ARBUSDT: 'L2', POLUSDT: 'L2',
  LINKUSDT: 'DeFi', ATOMUSDT: 'DeFi', INJUSDT: 'DeFi',
  XRPUSDT: 'Other', ADAUSDT: 'Other', TRXUSDT: 'Other',
  '1000PEPEUSDT': 'MemesAI', RENDERUSDT: 'MemesAI'
};

console.log('═'.repeat(70));
console.log(`V44.5 P4+P5 BACKTEST — ${CFG.toUpperCase()}`);
console.log('═'.repeat(70));
console.log(`P4=${FLAGS.P4} P5=${FLAGS.P5} P11=${FLAGS.P11} P7=${FLAGS.P7}`);

// Load data
const data = {};
for(const p of PAIRS){
  const f = path.join(KLINES_DIR, `${p}.json`);
  if(!fs.existsSync(f)) continue;
  data[p] = JSON.parse(fs.readFileSync(f, 'utf8')).map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4] }));
}

function proxyFunding(bars1h){
  const n = bars1h.length;
  const c = bars1h.map(b => b.c);
  const ema = new Float64Array(n);
  ema[0] = c[0];
  const alpha = 2 / 51;
  for(let i = 1; i < n; i++) ema[i] = c[i] * alpha + ema[i-1] * (1 - alpha);
  const premium = c.map((v, i) => (v - ema[i]) / ema[i]);
  const f = new Float64Array(n);
  for(let i = 8; i < n; i++){
    let s = 0;
    for(let j = i - 7; j <= i; j++) s += premium[j];
    f[i] = s / 8;
  }
  return f;
}

// PALANCA 4 — BTC regime detector (HMM proxy via simple realized vol + trend)
// State: BULL (1), CHOP (0), BEAR (-1)
// Detection: rolling 30d vs 90d EMA + realized vol percentile
function btcRegime(btcBars, idx){
  if(!btcBars || idx < 720) return 0;  // CHOP default
  const recent = btcBars.slice(idx - 720, idx);  // 30d (720h)
  const longer = btcBars.slice(idx - 2160, idx);  // 90d
  if(recent.length < 100 || longer.length < 100) return 0;
  const recentClose = recent[recent.length - 1].c;
  const recentStart = recent[0].c;
  const longerMean = longer.reduce((s,b) => s + b.c, 0) / longer.length;
  const trend30d = (recentClose - recentStart) / recentStart;
  const aboveLongMean = (recentClose - longerMean) / longerMean;
  // Realized vol (1h returns)
  const rets = [];
  for(let j = 1; j < recent.length; j++){
    rets.push(Math.log(recent[j].c / recent[j-1].c));
  }
  const meanRet = rets.reduce((a,b)=>a+b, 0) / rets.length;
  const stdRet = Math.sqrt(rets.reduce((s,r)=>s+(r-meanRet)**2, 0) / rets.length);
  const annVol = stdRet * Math.sqrt(24 * 365);

  // Classification rules
  if(trend30d > 0.05 && aboveLongMean > 0.02) return 1;  // BULL
  if(trend30d < -0.05 && aboveLongMean < -0.02) return -1; // BEAR
  return 0; // CHOP
}

// P4: regime → sizing multiplier (NO filtering)
function regimeSizeMult(regime){
  if(regime === 1) return 1.0;   // BULL — base sizing
  if(regime === -1) return 0.7;  // BEAR — reduce
  return 0.85;  // CHOP — slight reduce
}

// P11 by-pair sizing
function pairSizeMult(rollingPF){
  if(rollingPF === null) return 1.0;
  if(rollingPF >= 2.5) return 1.6;
  if(rollingPF >= 2.0) return 1.4;
  if(rollingPF >= 1.5) return 1.2;
  if(rollingPF >= 1.2) return 1.0;
  if(rollingPF >= 1.0) return 0.85;
  if(rollingPF >= 0.8) return 0.65;
  return 0.45;
}

function termStructureBoost(fund, idx, dir){
  if(idx < 168) return 1.0;
  const f24 = fund.slice(idx-24, idx).filter(isFinite);
  const f7d = fund.slice(idx-168, idx).filter(isFinite);
  if(f24.length < 12 || f7d.length < 80) return 1.0;
  const m24 = f24.reduce((a,b)=>a+b,0)/f24.length;
  const m7d = f7d.reduce((a,b)=>a+b,0)/f7d.length;
  const std = Math.sqrt(f7d.reduce((s,v)=>s+(v-m7d)**2, 0)/f7d.length);
  const div = m24 - m7d;
  const aligned = dir === 1 ? -div : div;
  const norm = std > 0 ? aligned/std : 0;
  return 1.0 + Math.max(0, Math.min(0.30, norm * 0.15));
}

const INIT_CAP = 500;
const SIZE_PCT = 0.10;
const TP_BPS = 30, SL_BPS = 25, HOLD_H = 4, FEE_RT = 0.0008, SLIP_SL = 0.0002;

const trades = [];
let cap = INIT_CAP;
const dailyPnL = {};
const tradesByPair = {};
PAIRS.forEach(p => tradesByPair[p] = []);

function rollingPF(pairTs, currentTs){
  const cutoffEnd = currentTs - 7 * 86400000;
  const cutoffStart = cutoffEnd - 90 * 86400000;
  const win = pairTs.filter(t => t.ts >= cutoffStart && t.ts <= cutoffEnd);
  if(win.length < 30) return null;
  const w = win.filter(t => t.pnl > 0);
  const gp = w.reduce((s,t)=>s+t.pnl, 0);
  const gl = -win.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl, 0);
  return gl > 0 ? gp/gl : 999;
}

const t0 = Date.now();

// PALANCA 5: Track open positions across pairs for cluster constraint
// Snapshot: at each settlement window, check open positions (pos still active)
const openPositionsByPair = {};
PAIRS.forEach(p => openPositionsByPair[p] = null);

function clusterCount(targetCluster, currentTs){
  let count = 0;
  for(const p of PAIRS){
    const op = openPositionsByPair[p];
    if(op && CLUSTERS[p] === targetCluster){
      // Check if still open (entry < current && exit >= current)
      // Since we iterate per-pair sequentially, we need a different approach:
      // Simplification: count pairs that have entered in last HOLD_H hours
      // (proxy for open positions in their HOLD window)
      if(currentTs - op < HOLD_H * 3600000) count++;
    }
  }
  return count;
}

// We need to iterate ALL pairs in time-sorted order for P5 to work properly
// Build time-sorted event stream
const eventStream = [];
for(const pair of PAIRS){
  if(!data[pair]) continue;
  const bars = data[pair];
  const fund = proxyFunding(bars);
  for(let i = 50; i < bars.length - HOLD_H; i++){
    eventStream.push({ pair, i, t: bars[i].t, fund: fund[i], bars, fundArr: fund });
  }
}
eventStream.sort((a,b) => a.t - b.t);
console.log(`Time-sorted event stream: ${eventStream.length} events`);

// State per pair (for entry/exit tracking)
const positionByPair = {};
PAIRS.forEach(p => positionByPair[p] = null);

const btcBars = data['BTCUSDT'] ? data['BTCUSDT'] : null;
let regimeCounts = { BULL: 0, CHOP: 0, BEAR: 0 };

// Build BTC index map for fast lookup at time t
const btcIdxByTime = {};
if(btcBars){
  for(let i = 0; i < btcBars.length; i++) btcIdxByTime[btcBars[i].t] = i;
}

let p5Skipped = 0;

for(const evt of eventStream){
  const { pair, i, t, fund, bars, fundArr } = evt;
  const pos = positionByPair[pair];
  const hr = new Date(t).getUTCHours();

  // === Check exits on existing position ===
  if(pos){
    const e = pos.entry, dir = pos.dir, h = bars[i].h, l = bars[i].l;
    const tp = dir === 1 ? e * (1 + TP_BPS/10000) : e * (1 - TP_BPS/10000);
    const sl = dir === 1 ? e * (1 - SL_BPS/10000) : e * (1 + SL_BPS/10000);
    const hitTP = (dir === 1 && h >= tp) || (dir === -1 && l <= tp);
    const hitSL = (dir === 1 && l <= sl) || (dir === -1 && h >= sl);
    const to = i >= pos.entryI + HOLD_H;
    if(hitTP || hitSL || to){
      const ex = hitTP ? tp : (hitSL ? (dir === 1 ? sl*(1-SLIP_SL) : sl*(1+SLIP_SL)) : bars[i].c);
      const pct = dir === 1 ? (ex-e)/e : (e-ex)/e;
      const pnl = pos.size * pct - pos.size * FEE_RT;
      cap += pnl;
      const dk = new Date(t).toISOString().slice(0,10);
      dailyPnL[dk] = (dailyPnL[dk] || 0) + pnl;
      const tr = { pnl, ts: t, pair, dir, type: hitTP ? 'TP' : (hitSL ? 'SL' : 'TO') };
      trades.push(tr);
      tradesByPair[pair].push(tr);
      positionByPair[pair] = null;
      openPositionsByPair[pair] = null;
    }
  }

  // === Check for new entry ===
  if(!positionByPair[pair] && (hr === 0 || hr === 8 || hr === 16)){
    if(!isFinite(fund)) continue;
    const fW = [];
    for(let j = Math.max(0, i-168); j < i; j++) if(isFinite(fundArr[j])) fW.push(fundArr[j]);
    if(fW.length < 50) continue;
    const sorted = [...fW].sort((a,b)=>a-b);
    const p80 = sorted[Math.floor(sorted.length*0.8)] || 0;
    const p20 = sorted[Math.floor(sorted.length*0.2)] || 0;
    let dir = 0;
    if(fund > p80 && fund > 0.005) dir = -1;
    else if(fund < p20 && fund < -0.002) dir = 1;
    if(dir === 0) continue;

    // PALANCA 5: Cluster constraint
    let p5Mult = 1.0;
    if(FLAGS.P5){
      const cluster = CLUSTERS[pair] || 'Other';
      const clCount = clusterCount(cluster, t);
      if(clCount >= 2) {
        // Already 2+ in same cluster — reduce size or skip
        p5Mult = 0.5;  // half size for 3rd+ cluster member
      }
    }

    // PALANCA 11
    let p11Mult = 1.0;
    if(FLAGS.P11){
      const pf = rollingPF(tradesByPair[pair], t);
      p11Mult = pairSizeMult(pf);
    }

    // PALANCA 7
    let p7Mult = 1.0;
    if(FLAGS.P7){
      p7Mult = termStructureBoost(fundArr, i, dir);
    }

    // PALANCA 4
    let p4Mult = 1.0;
    if(FLAGS.P4 && btcBars){
      // Find BTC bar idx at this time
      const btcIdx = btcIdxByTime[t] !== undefined ? btcIdxByTime[t] : -1;
      if(btcIdx > 0){
        const regime = btcRegime(btcBars, btcIdx);
        if(regime === 1) regimeCounts.BULL++;
        else if(regime === -1) regimeCounts.BEAR++;
        else regimeCounts.CHOP++;
        p4Mult = regimeSizeMult(regime);
      }
    }

    const totalMult = p11Mult * p7Mult * p4Mult * p5Mult;

    positionByPair[pair] = {
      entry: bars[i].c, dir, entryI: i,
      size: cap * SIZE_PCT * totalMult,
      sizeMult: totalMult,
      p11Mult, p7Mult, p4Mult, p5Mult
    };
    openPositionsByPair[pair] = t;
  }
}

const dt = ((Date.now() - t0) / 1000).toFixed(1);

function compute(trades, dailyPnL, capital = INIT_CAP){
  if(trades.length === 0) return { n: 0 };
  const w = trades.filter(t => t.pnl > 0);
  const l = trades.filter(t => t.pnl <= 0);
  const gp = w.reduce((s,t)=>s+t.pnl, 0);
  const gl = -l.reduce((s,t)=>s+t.pnl, 0);
  const days = Object.keys(dailyPnL).sort();
  const dr = days.map(d => dailyPnL[d]/capital);
  const m = dr.reduce((a,b)=>a+b,0)/Math.max(1,dr.length);
  const v = dr.reduce((s,r)=>s+(r-m)**2,0)/Math.max(1,dr.length);
  const sh = Math.sqrt(v) > 0 ? (m/Math.sqrt(v))*Math.sqrt(365) : 0;
  let pk = 0, mdd = 0, cum = 0;
  for(const d of days){ cum += dailyPnL[d]; if(cum>pk) pk=cum; if(pk-cum>mdd) mdd=pk-cum; }
  return { n: trades.length, wins: w.length, losses: l.length,
    pf: gl > 0 ? gp/gl : 999, wr: (w.length/trades.length)*100,
    pnl: trades.reduce((s,t)=>s+t.pnl, 0), sharpe: sh, mdd, mddPct: (mdd/capital)*100,
    tpd: days.length > 0 ? trades.length/days.length : 0, days: days.length };
}

const stats = compute(trades, dailyPnL);
const sortedDays = Object.keys(dailyPnL).sort();
const win7d = [];
for(let i = 0; i + 6 < sortedDays.length; i++){
  win7d.push({ pnl: sortedDays.slice(i,i+7).reduce((s,d)=>s+dailyPnL[d], 0) });
}
const pos7d = win7d.filter(w => w.pnl > 0).length;
const sorted = win7d.map(w=>w.pnl).sort((a,b)=>a-b);

console.log('');
console.log(`Trades: ${stats.n}  PF: ${stats.pf.toFixed(3)}  WR: ${stats.wr.toFixed(2)}%  PnL: $${stats.pnl.toFixed(2)}  DD: ${stats.mddPct.toFixed(2)}%  Sharpe: ${stats.sharpe.toFixed(2)}  t/d: ${stats.tpd.toFixed(2)}`);
console.log(`7d: ${(pos7d/win7d.length*100).toFixed(1)}% pos | worst $${sorted[0].toFixed(2)} (${(sorted[0]/INIT_CAP*100).toFixed(2)}%)`);
console.log(`Regime distribution (P4): BULL=${regimeCounts.BULL} CHOP=${regimeCounts.CHOP} BEAR=${regimeCounts.BEAR}`);

const out = { config: CFG, flags: FLAGS, stats,
  positivePct: (pos7d/win7d.length)*100, worstWin: sorted[0],
  windows7d_count: win7d.length, windows7d_positive: pos7d,
  regimeCounts, dailyPnL, runtime_s: parseFloat(dt) };
fs.writeFileSync(path.join(OUT_DIR, `v45_holdout_v2_${CFG}.json`), JSON.stringify(out, null, 2));
console.log(`✓ Saved`);
