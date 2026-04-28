#!/usr/bin/env node
'use strict';
// V45 SUPREME — Unified backtester for palancas 11-18 with flag-based activation.
// Inherits from v2 baseline (validated PF 1.467) and layers any combination of palancas.
//
// FLAGS (env vars):
//   APEX_V45_PAIR_SIZING=1     → P11 by-pair rolling sizing
//   APEX_V45_TERM_STRUCTURE=1  → P7 term-structure boost
//   APEX_V45_HEDGE=1           → P12 contra-correlated hedge
//   APEX_V45_DYNAMIC_TP=1      → P13 TP scaling by funding extremity
//   APEX_V45_MICRO_STOP=1      → P14 micro time-stop (BE if no movement 20m)
//   APEX_V45_LAYER2=1          → P16 Layer 2 portfolio exposure modulator
//   APEX_V45_VOL_SL=1          → P17 volatility-aware SL/TP
//   APEX_V45_ANTI_TILT=1       → P18 post-loss portfolio size reduction
//   APEX_V45_CORR_CAP=1        → P15 correlation-aware portfolio cap
//
// CLI: node backtest_v45_supreme.js [config_label]
//   Where config_label is just informational; flags come from env.

const fs = require('fs');
const path = require('path');

const KLINES_DIR = '/tmp/binance-klines-1h';
const OUT_DIR = path.join(__dirname, '..', 'results');
const CFG_LABEL = (process.argv[2] || 'unlabeled');

const FLAGS = {
  P11: process.env.APEX_V45_PAIR_SIZING === '1',
  P7:  process.env.APEX_V45_TERM_STRUCTURE === '1',
  P12: process.env.APEX_V45_HEDGE === '1',
  P13: process.env.APEX_V45_DYNAMIC_TP === '1',
  P14: process.env.APEX_V45_MICRO_STOP === '1',
  P16: process.env.APEX_V45_LAYER2 === '1',
  P17: process.env.APEX_V45_VOL_SL === '1',
  P18: process.env.APEX_V45_ANTI_TILT === '1',
  P15: process.env.APEX_V45_CORR_CAP === '1'
};

const PAIRS = [
  'ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT',
  'BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT',
  'SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'
];

// Cluster definitions (for P15)
const CLUSTERS = {
  BTCUSDT: 'L1maj', ETHUSDT: 'L1maj',
  SOLUSDT: 'SOLadj', SUIUSDT: 'SOLadj', NEARUSDT: 'SOLadj',
  ARBUSDT: 'L2', POLUSDT: 'L2',
  LINKUSDT: 'DeFi', ATOMUSDT: 'DeFi', INJUSDT: 'DeFi',
  XRPUSDT: 'Other', ADAUSDT: 'Other', TRXUSDT: 'Other',
  '1000PEPEUSDT': 'MemesAI', RENDERUSDT: 'MemesAI'
};

// Negatively correlated pair mapping (for P12 hedge)
// Heuristic: hedge with a pair from a different cluster, ideally inverse direction
const HEDGE_PAIRS = {
  // Dirty hedge map: same cluster pairs are NOT used; cross-cluster preferred
  L1maj: 'TRXUSDT',     // BTC/ETH hedged with TRX (low correlation)
  SOLadj: 'XRPUSDT',    // SOL/SUI hedged with XRP
  L2: 'TRXUSDT',
  DeFi: '1000PEPEUSDT',
  Other: 'ETHUSDT',
  MemesAI: 'BTCUSDT'
};

console.log('═'.repeat(80));
console.log(`V45 SUPREME BACKTEST — ${CFG_LABEL.toUpperCase()}`);
console.log(`Flags: ${Object.entries(FLAGS).filter(([k,v])=>v).map(([k])=>k).join(', ') || 'BASELINE'}`);
console.log('═'.repeat(80));

const data = {};
for(const p of PAIRS){
  const f = path.join(KLINES_DIR, `${p}.json`);
  if(!fs.existsSync(f)) continue;
  data[p] = JSON.parse(fs.readFileSync(f, 'utf8')).map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4] }));
}

// === Funding proxy (validated) ===
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

// === ATR (1h) for P17 ===
function computeATR(bars, period = 14){
  const n = bars.length;
  const atr = new Float64Array(n);
  let tr_sum = 0;
  for(let i = 1; i < n; i++){
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i-1].c),
      Math.abs(bars[i].l - bars[i-1].c)
    );
    if(i <= period){
      tr_sum += tr;
      atr[i] = tr_sum / i;
    } else {
      atr[i] = (atr[i-1] * (period - 1) + tr) / period;
    }
  }
  return atr;
}

// === Realized vol 24h (for P17) ===
function realizedVol24h(bars, idx){
  if(idx < 24) return 0;
  const rets = [];
  for(let j = idx - 23; j <= idx; j++){
    if(bars[j-1] && bars[j].c > 0 && bars[j-1].c > 0){
      rets.push(Math.log(bars[j].c / bars[j-1].c));
    }
  }
  if(rets.length < 5) return 0;
  const m = rets.reduce((a,b)=>a+b, 0) / rets.length;
  return Math.sqrt(rets.reduce((s,r)=>s+(r-m)**2, 0) / rets.length);
}

// === Pre-compute funding + ATR + RV ===
const fundCache = {};
const atrCache = {};
const rvWinCache = {};
for(const pair of PAIRS){
  if(!data[pair]) continue;
  fundCache[pair] = proxyFunding(data[pair]);
  atrCache[pair] = computeATR(data[pair], 14);
  // RV percentiles for vol regime (P17)
  const rvSeries = [];
  for(let i = 24; i < data[pair].length; i++){
    rvSeries.push(realizedVol24h(data[pair], i));
  }
  rvSeries.sort((a,b)=>a-b);
  rvWinCache[pair] = {
    p30: rvSeries[Math.floor(rvSeries.length * 0.30)] || 0,
    p70: rvSeries[Math.floor(rvSeries.length * 0.70)] || 0
  };
}

// === Helpers ===
function pairSizeMultV45(rollingPF){
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
  const f24 = []; for(let j = idx-24; j < idx; j++) if(isFinite(fund[j])) f24.push(fund[j]);
  const f7d = []; for(let j = idx-168; j < idx; j++) if(isFinite(fund[j])) f7d.push(fund[j]);
  if(f24.length < 12 || f7d.length < 80) return 1.0;
  const m24 = f24.reduce((a,b)=>a+b,0)/f24.length;
  const m7d = f7d.reduce((a,b)=>a+b,0)/f7d.length;
  const std = Math.sqrt(f7d.reduce((s,v)=>s+(v-m7d)**2, 0)/f7d.length);
  const div = m24 - m7d;
  const aligned = dir === 1 ? -div : div;
  const norm = std > 0 ? aligned/std : 0;
  return 1.0 + Math.max(0, Math.min(0.30, norm * 0.15));
}

// P13: Dynamic TP scaling based on funding |z|
function dynamicTPMult(absZ){
  if(!FLAGS.P13) return { tpMult: 1.0, sizeMult: 1.0 };
  if(absZ > 3.0) return { tpMult: 1.0, sizeMult: 1.0 };       // strong: full TP
  if(absZ > 2.0) return { tpMult: 0.75, sizeMult: 1.0 };      // mid: TP closer
  return { tpMult: 0.55, sizeMult: 0.7 };                     // weak: even closer + smaller
}

// P17: Vol-aware SL/TP scaling
function volAwareScale(rv, p30, p70){
  if(!FLAGS.P17 || p30 === 0) return 1.0;
  if(rv < p30) return 0.7;     // low vol: tighter
  if(rv > p70) return 1.4;     // high vol: wider
  return 1.0;
}

// P12: Hedge stream - simplified to track hedge positions
// When trending detected (extreme funding direction sustained), open hedge
// Implementation: per-pair, when 5d funding direction strong (mean >2σ from longer baseline),
// open opposite-direction trade in cluster's hedge pair

// P14: Micro time-stop - configurable threshold via env var
// Hourly granularity: check at hour 1 + hour 2 of 4-hour hold
// If at check time the trade hasn't moved favorably enough → BE close
// Default thresholds calibrated to keep BE closures <30% of trades
function checkMicroStop(pos, bars, currentI){
  if(!FLAGS.P14) return null;
  const elapsedH = currentI - pos.entryI;
  // Threshold: % of TP_BPS distance required at check time
  // Default 0.50 = need to be 50% of way to TP at hour 1 to keep
  const microThreshold = parseFloat(process.env.APEX_V45_MICRO_THRESHOLD || '0.50');
  // TP_BPS = 30, so default needs 0.0015 (15bps) move at hour 1
  const requiredMove = (30 / 10000) * microThreshold;

  if(elapsedH === 1 && !pos.microStopChecked){
    pos.microStopChecked = true;
    const dir = pos.dir;
    const e = pos.entry;
    const c = bars[currentI].c;
    const favMove = dir === 1 ? (c - e) / e : (e - c) / e;
    // Adverse close at hour 1: BE
    if(favMove < requiredMove){
      return { close: true, exitPrice: e };
    }
  }
  return null;
}

// === Layer 2 Meta-model (P16): heuristic version ===
// Track rolling 7d portfolio PnL → if negative, modulate global exposure down
let _rollingDailyPnL = [];  // last 30 days array
function layer2GlobalMult(currentDayKey){
  if(!FLAGS.P16) return 1.0;
  if(_rollingDailyPnL.length < 7) return 1.0;
  const last7 = _rollingDailyPnL.slice(-7);
  const sum7 = last7.reduce((a,b)=>a+b, 0);
  const last3 = _rollingDailyPnL.slice(-3);
  const sum3 = last3.reduce((a,b)=>a+b, 0);
  // Aggressive de-risking when recent days strongly negative
  if(sum3 < -10) return 0.5;  // bad recent
  if(sum7 < -15) return 0.7;
  if(sum3 > 15) return 1.2;   // strong recent
  return 1.0;
}

// === Anti-tilt (P18): track consecutive losses portfolio-wide ===
let _recentOutcomes = [];  // FIFO max 50
function antiTiltMult(){
  if(!FLAGS.P18) return 1.0;
  if(_recentOutcomes.length < 10) return 1.0;
  const last10 = _recentOutcomes.slice(-10);
  const losses = last10.filter(o => o === 'L').length;
  if(losses >= 7) return 0.6;  // 7+ losses in 10 → tilt protection
  return 1.0;
}

// === Correlation cap (P15): track open exposure per cluster ===
const _clusterExposure = {};  // cluster → sum of |size|
function clusterExposure(cluster){
  return _clusterExposure[cluster] || 0;
}
function corrCapMult(pair, baseSize){
  if(!FLAGS.P15) return 1.0;
  const cluster = CLUSTERS[pair] || 'Other';
  const cur = clusterExposure(cluster);
  const baselineSize = 50;  // typical V44 size at $500 cap
  const maxNetCluster = baselineSize * 2.5;  // allow 2.5x baseline aggregate per cluster
  if(cur + baseSize <= maxNetCluster) return 1.0;
  // Reduce proportionally
  const remaining = maxNetCluster - cur;
  if(remaining <= 0) return 0.3;
  return remaining / baseSize;
}

// === P12 Hedge tracking ===
const _hedgePositions = [];  // active hedge positions
function checkHedgeTrigger(pair, dir, fund, idx){
  if(!FLAGS.P12) return null;
  if(idx < 168) return null;
  // Trending detection: funding direction sustained 5d (120 hours)
  const f5d = [];
  for(let j = idx - 120; j < idx; j++) if(isFinite(fund[j])) f5d.push(fund[j]);
  if(f5d.length < 80) return null;
  const m5d = f5d.reduce((a,b)=>a+b, 0) / f5d.length;
  // Compare to 30d baseline
  const f30d = [];
  for(let j = idx - 720; j < idx; j++) if(isFinite(fund[j])) f30d.push(fund[j]);
  if(f30d.length < 200) return null;
  const m30d = f30d.reduce((a,b)=>a+b, 0) / f30d.length;
  const std30 = Math.sqrt(f30d.reduce((s,v)=>s+(v-m30d)**2, 0) / f30d.length);
  if(std30 === 0) return null;
  const z = (m5d - m30d) / std30;
  // If trending strong in same direction as primary trade (not contra) → likely to continue
  // Trade is contra-funding. So if funding is trending FURTHER from extreme, hedge needed.
  const trendingFurther = (dir === -1 && z > 1.5) || (dir === 1 && z < -1.5);
  if(!trendingFurther) return null;
  const cluster = CLUSTERS[pair] || 'Other';
  const hedgePair = HEDGE_PAIRS[cluster];
  if(!hedgePair || !data[hedgePair]) return null;
  return { hedgePair, hedgeSize: 0.15 };  // 15% capital
}

// === Main backtest ===
const INIT_CAP = 500;
const SIZE_PCT = 0.10;
const TP_BPS_BASE = 30;
const SL_BPS_BASE = 25;
const HOLD_H = 4;
const FEE_RT = 0.0008;
const SLIP_SL = 0.0002;

const trades = [];
let cap = INIT_CAP;
const dailyPnL = {};
const tradesByPair = {};
PAIRS.forEach(p => tradesByPair[p] = []);

function rollingPF(pairTs, currentTs){
  if(!FLAGS.P11) return null;
  const cutoffEnd = currentTs - 7 * 86400000;
  const cutoffStart = cutoffEnd - 90 * 86400000;
  const win = pairTs.filter(t => t.ts >= cutoffStart && t.ts <= cutoffEnd);
  if(win.length < 30) return null;
  const w = win.filter(t => t.pnl > 0);
  const gp = w.reduce((s,t)=>s+t.pnl, 0);
  const gl = -win.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl, 0);
  return gl > 0 ? gp/gl : 999;
}

// Iterate time-sorted across all pairs
const eventStream = [];
for(const pair of PAIRS){
  if(!data[pair]) continue;
  const bars = data[pair];
  for(let i = 50; i < bars.length - HOLD_H; i++){
    eventStream.push({ pair, i, t: bars[i].t });
  }
}
eventStream.sort((a,b) => a.t - b.t);

const positionByPair = {};
PAIRS.forEach(p => positionByPair[p] = null);
let currentDayKey = null;
let dailyPnLToday = 0;

const t0 = Date.now();

function closePos(pair, currentI, hitTP, hitSL, isMicroStop = false){
  const bars = data[pair];
  const pos = positionByPair[pair];
  if(!pos) return;
  const e = pos.entry, dir = pos.dir;
  const tp = pos.tpP, sl = pos.slP;
  let exitP, outcome;
  if(isMicroStop){
    exitP = e;
    outcome = 'MICRO_BE';
  } else if(hitTP){
    exitP = tp;
    outcome = 'TP';
  } else if(hitSL){
    exitP = dir === 1 ? sl * (1 - SLIP_SL) : sl * (1 + SLIP_SL);
    outcome = 'SL';
  } else {
    exitP = bars[currentI].c;
    outcome = 'TO';
  }
  const pct = dir === 1 ? (exitP - e) / e : (e - exitP) / e;
  const pnl = pos.size * pct - pos.size * FEE_RT;
  cap += pnl;
  const dk = new Date(bars[currentI].t).toISOString().slice(0, 10);
  dailyPnL[dk] = (dailyPnL[dk] || 0) + pnl;
  trades.push({
    pnl, ts: bars[currentI].t, pair, dir,
    size: pos.size, sizeMult: pos.sizeMult || 1,
    type: outcome, isHedge: !!pos.isHedge
  });
  if(!pos.isHedge){
    tradesByPair[pair].push({ pnl, ts: bars[currentI].t });
    _recentOutcomes.push(pnl > 0 ? 'W' : 'L');
    if(_recentOutcomes.length > 50) _recentOutcomes.shift();
  }
  // Update cluster exposure
  const cluster = CLUSTERS[pair] || 'Other';
  _clusterExposure[cluster] = Math.max(0, (_clusterExposure[cluster] || 0) - pos.size);
  positionByPair[pair] = null;
}

for(const evt of eventStream){
  const { pair, i, t } = evt;
  const bars = data[pair];
  const fund = fundCache[pair];
  const atr = atrCache[pair];
  const hr = new Date(t).getUTCHours();

  // Update daily PnL tracker for L2
  const dk = new Date(t).toISOString().slice(0, 10);
  if(currentDayKey !== dk){
    if(currentDayKey !== null){
      _rollingDailyPnL.push(dailyPnLToday);
      if(_rollingDailyPnL.length > 30) _rollingDailyPnL.shift();
    }
    currentDayKey = dk;
    dailyPnLToday = dailyPnL[dk] || 0;
  } else {
    dailyPnLToday = dailyPnL[dk] || 0;
  }

  const pos = positionByPair[pair];

  // === Exit checks ===
  if(pos){
    // P14: micro time-stop
    const microRes = checkMicroStop(pos, bars, i);
    if(microRes && microRes.close){
      closePos(pair, i, false, false, true);
    } else {
      const e = pos.entry, dir = pos.dir, h = bars[i].h, l = bars[i].l;
      const tp = pos.tpP, sl = pos.slP;
      const hitTP = (dir === 1 && h >= tp) || (dir === -1 && l <= tp);
      const hitSL = (dir === 1 && l <= sl) || (dir === -1 && h >= sl);
      const to = i >= pos.entryI + HOLD_H;
      if(hitTP || hitSL || to){
        closePos(pair, i, hitTP, hitSL);
      }
    }
  }

  // === Entry check (only at settlement hours) ===
  if(!positionByPair[pair] && (hr === 0 || hr === 8 || hr === 16)){
    if(!isFinite(fund[i])) continue;
    const fW = [];
    for(let j = Math.max(0, i-168); j < i; j++) if(isFinite(fund[j])) fW.push(fund[j]);
    if(fW.length < 50) continue;
    const sorted = [...fW].sort((a,b)=>a-b);
    const p80 = sorted[Math.floor(sorted.length*0.8)] || 0;
    const p20 = sorted[Math.floor(sorted.length*0.2)] || 0;
    let dir = 0;
    if(fund[i] > p80 && fund[i] > 0.005) dir = -1;
    else if(fund[i] < p20 && fund[i] < -0.002) dir = 1;
    if(dir === 0) continue;

    // Z-score for funding
    const fMean = fW.reduce((a,b)=>a+b, 0) / fW.length;
    const fStd = Math.sqrt(fW.reduce((s,v)=>s+(v-fMean)**2, 0) / fW.length);
    const z = fStd > 0 ? (fund[i] - fMean) / fStd : 0;
    const absZ = Math.abs(z);

    // Sizing chain
    let sizeMult = 1.0;

    // P11: by-pair
    if(FLAGS.P11){
      const histPF = rollingPF(tradesByPair[pair], t);
      sizeMult *= pairSizeMultV45(histPF);
    }

    // P7: term-structure
    if(FLAGS.P7){
      sizeMult *= termStructureBoost(fund, i, dir);
    }

    // P13: dynamic TP scaling (also affects size)
    let tpMultDynamic = 1.0;
    if(FLAGS.P13){
      const dyn = dynamicTPMult(absZ);
      tpMultDynamic = dyn.tpMult;
      sizeMult *= dyn.sizeMult;
    }

    // P17: vol-aware SL/TP scaling
    let volScale = 1.0;
    if(FLAGS.P17){
      const rv = realizedVol24h(bars, i);
      volScale = volAwareScale(rv, rvWinCache[pair].p30, rvWinCache[pair].p70);
    }

    // P16: Layer 2 portfolio exposure modulator
    if(FLAGS.P16){
      sizeMult *= layer2GlobalMult(dk);
    }

    // P18: anti-tilt
    if(FLAGS.P18){
      sizeMult *= antiTiltMult();
    }

    // P15: cluster correlation cap
    const baseSize = cap * SIZE_PCT * sizeMult;
    if(FLAGS.P15){
      sizeMult *= corrCapMult(pair, baseSize);
    }

    // Cap total to avoid runaway leverage
    sizeMult = Math.min(2.0, sizeMult);
    const finalSize = cap * SIZE_PCT * sizeMult;
    if(finalSize <= 0) continue;

    // Compute TP/SL (with P17 vol scale + P13 dynamic TP)
    const tpBps = TP_BPS_BASE * tpMultDynamic * volScale;
    const slBps = SL_BPS_BASE * volScale;
    const tpP = dir === 1 ? bars[i].c * (1 + tpBps/10000) : bars[i].c * (1 - tpBps/10000);
    const slP = dir === 1 ? bars[i].c * (1 - slBps/10000) : bars[i].c * (1 + slBps/10000);

    // Track cluster exposure
    const cluster = CLUSTERS[pair] || 'Other';
    _clusterExposure[cluster] = (_clusterExposure[cluster] || 0) + finalSize;

    positionByPair[pair] = {
      entry: bars[i].c, dir, entryI: i,
      size: finalSize, sizeMult,
      tpP, slP,
      isHedge: false,
      microStopChecked: false
    };

    // P12: hedge trigger (for trending periods)
    if(FLAGS.P12){
      const hedge = checkHedgeTrigger(pair, dir, fund, i);
      if(hedge && !positionByPair[hedge.hedgePair]){
        const hBars = data[hedge.hedgePair];
        // Find the bar at same timestamp in hedge pair
        const hIdx = hBars.findIndex(b => b.t >= t);
        if(hIdx >= 0 && hIdx < hBars.length - HOLD_H){
          const hSize = cap * hedge.hedgeSize;
          // Hedge direction: opposite of primary signal in funding-stress moments
          const hDir = -dir;
          const hC = hBars[hIdx].c;
          positionByPair[hedge.hedgePair] = {
            entry: hC, dir: hDir, entryI: hIdx,
            size: hSize, sizeMult: 1.0,
            tpP: hDir === 1 ? hC * 1.003 : hC * 0.997,
            slP: hDir === 1 ? hC * 0.9975 : hC * 1.0025,
            isHedge: true,
            microStopChecked: false
          };
        }
      }
    }
  }
}

const dt = ((Date.now() - t0) / 1000).toFixed(1);

// === Stats ===
function computeStats(trades, dailyPnL, capital = INIT_CAP){
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
  return {
    n: trades.length, wins: w.length, losses: l.length,
    pf: gl > 0 ? gp/gl : 999, wr: (w.length/trades.length)*100,
    pnl: trades.reduce((s,t)=>s+t.pnl, 0), sharpe: sh, mdd, mddPct: (mdd/capital)*100,
    tpd: days.length > 0 ? trades.length/days.length : 0, days: days.length
  };
}

const stats = computeStats(trades, dailyPnL);
const sortedDays = Object.keys(dailyPnL).sort();
const win7d = [];
for(let i = 0; i + 6 < sortedDays.length; i++){
  win7d.push({ pnl: sortedDays.slice(i,i+7).reduce((s,d)=>s+dailyPnL[d], 0) });
}
const pos7d = win7d.filter(w => w.pnl > 0).length;
const sorted7d = win7d.map(w=>w.pnl).sort((a,b)=>a-b);
const positivePct = (pos7d/win7d.length)*100;
const worstWin = sorted7d[0] || 0;
const worstPct = (worstWin / INIT_CAP) * 100;

console.log('');
console.log(`Trades: ${stats.n}  PF: ${stats.pf.toFixed(3)}  WR: ${stats.wr.toFixed(2)}%  PnL: $${stats.pnl.toFixed(2)}  DD: ${stats.mddPct.toFixed(2)}%  Sharpe: ${stats.sharpe.toFixed(2)}  t/d: ${stats.tpd.toFixed(2)}`);
console.log(`7d windows: ${positivePct.toFixed(1)}% pos | worst $${worstWin.toFixed(2)} (${worstPct.toFixed(2)}%)`);

const outcomes = { TP: 0, SL: 0, TO: 0, MICRO_BE: 0 };
trades.forEach(t => { outcomes[t.type] = (outcomes[t.type]||0) + 1; });
const hedgeTrades = trades.filter(t => t.isHedge).length;
console.log(`Outcomes: TP=${outcomes.TP} SL=${outcomes.SL} TO=${outcomes.TO} MICRO_BE=${outcomes.MICRO_BE} Hedge=${hedgeTrades}`);

const out = {
  config: CFG_LABEL, flags: FLAGS, stats,
  positivePct, worstWin, worstPct,
  windows7d_count: win7d.length, windows7d_positive: pos7d,
  outcomes, hedgeTrades, dailyPnL,
  runtime_s: parseFloat(dt)
};
const outFile = path.join(OUT_DIR, `v45_supreme_${CFG_LABEL}.json`);
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(`✓ Saved ${outFile}  (${dt}s)`);
