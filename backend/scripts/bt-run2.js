// V44.7 BACKTEST v2 — Expanded search with structural enhancements:
//   • Sub-universe selection (ALL, MAJORS, TOP3, BTC_ONLY)
//   • ATR-regime filter (skip when 24h volatility is in top quintile or bottom quintile)
//   • Momentum confirmation (require last-4h move in agreement / disagreement with signal)
//   • Funding-window bias (MID-only / PRE-only / all)
//   • Wider asymmetric TP/SL (R:R from 0.5 to 6.0)
//   • Per-pair edge inspection
'use strict';
const fs = require('fs');
const path = require('path');

const CACHE_DIR = '/tmp/v447-data';

const FULL_UNIVERSE = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT',
  'ARBUSDT','ATOMUSDT','TRXUSDT','NEARUSDT','POLUSDT','INJUSDT','SUIUSDT','AVAXUSDT',
  'OPUSDT','DOTUSDT','RENDERUSDT','1000PEPEUSDT','1000SHIBUSDT','JUPUSDT'
];

const SUB_UNIVERSES = {
  ALL: FULL_UNIVERSE,
  MAJORS: ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT'],
  TOP3: ['BTCUSDT','ETHUSDT','SOLUSDT'],
  ALTS: ['ARBUSDT','ATOMUSDT','LINKUSDT','POLUSDT','SUIUSDT','NEARUSDT','INJUSDT','OPUSDT','DOTUSDT','AVAXUSDT'],
  MEMES: ['DOGEUSDT','1000PEPEUSDT','1000SHIBUSDT'],
};

// ─────────── helpers ───────────
function computeProxyEMA(klines) {
  const n = klines.length;
  const closes = klines.map(b => b.c);
  const ema = new Float64Array(n);
  ema[0] = closes[0];
  const alpha = 2/51;
  for (let i=1; i<n; i++) ema[i] = closes[i]*alpha + ema[i-1]*(1-alpha);
  const premium = closes.map((v,i)=>(v-ema[i])/ema[i]);
  const f = new Float64Array(n);
  for (let i=8; i<n; i++) {
    let s=0; for (let j=i-7; j<=i; j++) s += premium[j];
    f[i] = s/8;
  }
  return f;
}

function computeATR(klines, lookback = 24) {
  const n = klines.length;
  const atr = new Float64Array(n);
  for (let i = lookback; i < n; i++) {
    let sumTR = 0;
    for (let j = i - lookback + 1; j <= i; j++) {
      const tr = Math.max(
        klines[j].h - klines[j].l,
        Math.abs(klines[j].h - klines[j-1].c),
        Math.abs(klines[j].l - klines[j-1].c)
      );
      sumTR += tr;
    }
    atr[i] = sumTR / lookback / klines[i].c; // normalized to price (returns dimensionless)
  }
  return atr;
}

function precomputeZ(arr, lookback) {
  const N = arr.length;
  const z = new Float64Array(N);
  let sum=0, sumSq=0, n=0;
  for (let j=0; j<lookback && j<N; j++) {
    const v = arr[j];
    if (isFinite(v)) { sum+=v; sumSq+=v*v; n++; }
  }
  for (let i=0; i<N; i++) {
    if (i<lookback-1) { z[i]=0; continue; }
    if (i>=lookback) {
      const inV = arr[i], outV = arr[i-lookback];
      if (isFinite(inV))  { sum+=inV;  sumSq+=inV*inV;  n++; }
      if (isFinite(outV)) { sum-=outV; sumSq-=outV*outV; n--; }
    }
    if (n<lookback*0.5 || !isFinite(arr[i])) { z[i]=0; continue; }
    const mean = sum/n;
    const variance = sumSq/n - mean*mean;
    const std = variance>0 ? Math.sqrt(variance) : 0;
    z[i] = std>0 ? (arr[i]-mean)/std : 0;
  }
  return z;
}

function precomputePcts(arr, w) {
  const N = arr.length;
  const p20 = new Float64Array(N), p80 = new Float64Array(N);
  for (let i=0; i<N; i++) {
    if (i<w) { p20[i]=NaN; p80[i]=NaN; continue; }
    const win = [];
    for (let j=i-w; j<i; j++) if (isFinite(arr[j])) win.push(arr[j]);
    if (win.length<50) { p20[i]=NaN; p80[i]=NaN; continue; }
    win.sort((a,b)=>a-b);
    p20[i] = win[Math.floor(win.length*0.20)];
    p80[i] = win[Math.floor(win.length*0.80)];
  }
  return {p20, p80};
}

function loadPair(sym, fundSrc) {
  const klFile = path.join(CACHE_DIR, `${sym}-klines-1h.json`);
  if (!fs.existsSync(klFile)) return null;
  const klines = JSON.parse(fs.readFileSync(klFile, 'utf8'));
  if (!klines.length) return null;
  let fundArr;
  if (fundSrc === 'proxy_ema') {
    fundArr = computeProxyEMA(klines);
  } else {
    const prFile = path.join(CACHE_DIR, `${sym}-premium-1h.json`);
    if (!fs.existsSync(prFile)) return null;
    const prem = JSON.parse(fs.readFileSync(prFile, 'utf8'));
    const m = new Map();
    for (const p of prem) m.set(p.t, p.c);
    fundArr = new Float64Array(klines.length);
    let last = NaN, matched = 0;
    for (let i=0; i<klines.length; i++) {
      if (m.has(klines[i].t)) { last = m.get(klines[i].t); matched++; }
      fundArr[i] = isFinite(last) ? last : NaN;
    }
    if (matched < klines.length*0.6) return null;
  }
  const zArr = precomputeZ(fundArr, 720);
  const pcts = precomputePcts(fundArr, 168);
  const atr = computeATR(klines, 24);
  const atrPcts = precomputePcts(atr, 168);
  return { sym, klines, fundArr, zArr, p20Arr: pcts.p20, p80Arr: pcts.p80, atr, atrP20: atrPcts.p20, atrP80: atrPcts.p80 };
}

// Eligible windows
const SETT_HOURS = [0,8,16];
function getWinType(hr) {
  for (const s of SETT_HOURS) {
    if (hr===s) return 'MID';
    if (hr===((s-1+24)%24)) return 'PRE';
    if (hr===((s+1)%24)) return 'POST';
  }
  return null;
}
function winWeight(t) { return t==='MID'?1.0:t==='PRE'?0.85:t==='POST'?0.75:0; }

// Backtest single pair
function btPair(pd, p) {
  const { klines, fundArr, zArr, p20Arr, p80Arr, atr, atrP20, atrP80 } = pd;
  const out = [];
  const minBars = 720 + 50;
  const HOLD = p.HOLD_H;
  for (let i = minBars; i < klines.length - HOLD; i++) {
    const bar = klines[i];
    const hr = new Date(bar.t).getUTCHours();
    const wt = getWinType(hr);
    if (!wt) continue;
    if (p.MID_ONLY && wt !== 'MID') continue;

    const f = fundArr[i];
    if (!isFinite(f)) continue;
    const p80 = p80Arr[i], p20 = p20Arr[i];
    if (!isFinite(p80) || !isFinite(p20)) continue;

    let dir = 0;
    if (f > p80 && f > p.F_POS) dir = -1;
    else if (f < p20 && f < p.F_NEG) dir = 1;
    if (!dir) continue;
    if (p.INVERT) dir = -dir;

    const z = zArr[i];
    const quality = Math.abs(z) * winWeight(wt);
    if (quality < p.QT) continue;

    // ATR filter: skip when volatility is extreme (top or bottom quintile)
    if (p.ATR_FILTER) {
      const a = atr[i];
      const ap20 = atrP20[i], ap80 = atrP80[i];
      if (isFinite(a) && isFinite(ap20) && isFinite(ap80)) {
        if (p.ATR_FILTER === 'skip_high' && a > ap80) continue;
        if (p.ATR_FILTER === 'skip_low' && a < ap20) continue;
        if (p.ATR_FILTER === 'mid_only' && (a > ap80 || a < ap20)) continue;
      }
    }

    // Momentum filter: last-4h direction
    if (p.MOM_FILTER) {
      const past4 = klines[i-4]?.c;
      if (!past4) continue;
      const moveBps = (bar.c - past4) / past4 * 10000;
      // CONFIRM: signal direction must agree with recent momentum
      // FADE: signal direction must oppose recent momentum
      if (p.MOM_FILTER === 'confirm') {
        if (dir === 1 && moveBps < 0) continue;
        if (dir === -1 && moveBps > 0) continue;
      } else if (p.MOM_FILTER === 'fade') {
        if (dir === 1 && moveBps > 0) continue;
        if (dir === -1 && moveBps < 0) continue;
      }
    }

    // Walk forward looking for TP/SL hit
    const entry = bar.c;
    const tp = dir === 1 ? entry*(1+p.TP/10000) : entry*(1-p.TP/10000);
    const sl = dir === 1 ? entry*(1-p.SL/10000) : entry*(1+p.SL/10000);
    let outcome = null, exit = entry, hitI = i+HOLD;
    for (let j=i+1; j<=i+HOLD && j<klines.length; j++) {
      const fb = klines[j];
      if (dir === 1) {
        const tpHit = fb.h >= tp, slHit = fb.l <= sl;
        if (tpHit && slHit) { outcome='LOSS'; exit=sl; hitI=j; break; }
        if (tpHit) { outcome='WIN'; exit=tp; hitI=j; break; }
        if (slHit) { outcome='LOSS'; exit=sl; hitI=j; break; }
      } else {
        const tpHit = fb.l <= tp, slHit = fb.h >= sl;
        if (tpHit && slHit) { outcome='LOSS'; exit=sl; hitI=j; break; }
        if (tpHit) { outcome='WIN'; exit=tp; hitI=j; break; }
        if (slHit) { outcome='LOSS'; exit=sl; hitI=j; break; }
      }
    }
    if (!outcome) {
      outcome = 'TIMEOUT';
      exit = klines[Math.min(i+HOLD, klines.length-1)].c;
    }
    const pnlBps = dir===1 ? ((exit-entry)/entry)*10000 : ((entry-exit)/entry)*10000;
    out.push({ sym: pd.sym, dir, t: bar.t, entry, exit, pnl_bps: pnlBps - p.FEE, outcome, z, quality });
    i = Math.max(i, hitI);
  }
  return out;
}

function statsOf(trades) {
  if (!trades.length) return { trades:0,wr:0,pf:0,dd:0,perDay:0,sharpe:0,totalPnl_bps:0 };
  const wins = trades.filter(t=>t.pnl_bps>0);
  const losses = trades.filter(t=>t.pnl_bps<=0);
  const gw = wins.reduce((s,t)=>s+t.pnl_bps,0);
  const gl = Math.abs(losses.reduce((s,t)=>s+t.pnl_bps,0));
  const wr = wins.length/trades.length*100;
  const pf = gl>0 ? gw/gl : (gw>0?99:0);
  trades.sort((a,b)=>a.t-b.t);
  let eq=0,peak=0,maxDD=0;
  for (const t of trades) { eq += t.pnl_bps; if (eq>peak) peak=eq; if (peak-eq>maxDD) maxDD=peak-eq; }
  const span = trades[trades.length-1].t - trades[0].t;
  const days = Math.max(1, span/86400000);
  const perDay = trades.length/days;
  const mean = (gw-gl)/trades.length;
  const variance = trades.reduce((s,t)=>s+(t.pnl_bps-mean)**2,0)/trades.length;
  const sharpe = variance>0 ? mean/Math.sqrt(variance) : 0;
  return { trades:trades.length, wins:wins.length, losses:losses.length,
    wr:+wr.toFixed(2), pf:+pf.toFixed(3), dd_bps:+maxDD.toFixed(0),
    totalPnl_bps:+(gw-gl).toFixed(0), perDay:+perDay.toFixed(2),
    sharpe:+sharpe.toFixed(3), span_days:+days.toFixed(0)
  };
}

function annualizedReturn(stats, lev=3, sizePct=0.10) {
  if (!stats.trades) return 0;
  const avgPerTrade = stats.totalPnl_bps / stats.trades;
  const tpy = stats.perDay * 365;
  const eff = avgPerTrade * lev * sizePct / 10000;
  return +(((1+eff)**tpy - 1) * 100).toFixed(1);
}

function splitTrades(trades, ratio=0.7) {
  if (!trades.length) return { train:[], test:[] };
  trades.sort((a,b)=>a.t-b.t);
  const cut = trades[0].t + (trades[trades.length-1].t-trades[0].t)*ratio;
  return { train: trades.filter(t=>t.t<cut), test: trades.filter(t=>t.t>=cut) };
}

function run(pairs, p) {
  const all = [];
  for (const pd of pairs) all.push(...btPair(pd, p));
  return all;
}

function compositeScore(r) {
  const t = r.test;
  if (!t.trades || t.trades < 30) return -Infinity;
  if (t.pf < 1.0 || r.annual < 0) return -Infinity;
  const pfS = Math.min(t.pf, 3)/3;
  const annS = Math.min(r.annual, 400)/400;
  const tdS = Math.min(t.perDay, 15)/15;
  const wrS = Math.min(t.wr, 80)/80;
  const ddP = Math.max(0, 1 - t.dd_bps/1500);
  // Train-test consistency penalty
  const consistency = 1 - Math.min(1, Math.abs(t.wr - r.train.wr)/30);
  return pfS*0.30 + annS*0.20 + tdS*0.15 + wrS*0.15 + ddP*0.10 + consistency*0.10;
}

(async () => {
  const t0 = Date.now();
  const cache = new Map();
  function getPairs(uName, src) {
    const key = `${uName}|${src}`;
    if (cache.has(key)) return cache.get(key);
    const list = [];
    for (const sym of SUB_UNIVERSES[uName]) {
      const pd = loadPair(sym, src);
      if (pd) list.push(pd);
    }
    cache.set(key, list);
    return list;
  }

  const grid = {
    UNIVERSE: ['ALL','MAJORS','TOP3','ALTS','MEMES'],
    SOURCE:   ['proxy_ema','premium'],
    TP:       [40, 60, 100, 150, 200],
    SL:       [10, 20, 30, 50],
    QT:       [0.6, 1.2, 2.0, 3.0],
    F_POS_PROXY:   [0.0015, 0.003, 0.006],
    F_NEG_PROXY:   [-0.0006, -0.0015, -0.003],
    F_POS_REAL:    [0.0001, 0.0003],
    F_NEG_REAL:    [-0.0001, -0.0003],
    HOLD_H:   [4, 8, 24],
    INVERT:   [false, true],
    MID_ONLY: [false, true],
    ATR_FILTER: [null, 'skip_high', 'mid_only'],
    MOM_FILTER: [null, 'confirm', 'fade'],
    FEE: [8]
  };

  const allRes = [];
  let combo = 0;
  // Estimate combos
  const total = grid.UNIVERSE.length * grid.SOURCE.length * grid.TP.length * grid.SL.length *
                grid.QT.length * 3 * 3 * grid.HOLD_H.length * grid.INVERT.length *
                grid.MID_ONLY.length * grid.ATR_FILTER.length * grid.MOM_FILTER.length;
  console.log(`grid combos ≈ ${total}`);

  for (const U of grid.UNIVERSE)
  for (const SRC of grid.SOURCE) {
    const pairs = getPairs(U, SRC);
    if (!pairs.length) continue;
    const fposGrid = SRC==='proxy_ema' ? grid.F_POS_PROXY : grid.F_POS_REAL;
    const fnegGrid = SRC==='proxy_ema' ? grid.F_NEG_PROXY : grid.F_NEG_REAL;
    for (const TP of grid.TP)
    for (const SL of grid.SL)
    for (const QT of grid.QT)
    for (const FP of fposGrid)
    for (const FN of fnegGrid)
    for (const H of grid.HOLD_H)
    for (const INV of grid.INVERT)
    for (const MID of grid.MID_ONLY)
    for (const ATRF of grid.ATR_FILTER)
    for (const MOMF of grid.MOM_FILTER) {
      combo++;
      if (combo % 1000 === 0) process.stdout.write(`  ${combo}/${total}\r`);
      const params = { TP, SL, QT, F_POS:FP, F_NEG:FN, HOLD_H:H, INVERT:INV, MID_ONLY:MID, ATR_FILTER:ATRF, MOM_FILTER:MOMF, FEE:8 };
      const trades = run(pairs, params);
      if (trades.length < 100) continue;
      const split = splitTrades(trades, 0.7);
      const trainStats = statsOf(split.train);
      const testStats = statsOf(split.test);
      const annual = annualizedReturn(testStats, 3, 0.10);
      allRes.push({ params: { ...params, UNIVERSE: U, SOURCE: SRC }, train: trainStats, test: testStats, annual });
    }
  }
  console.log(`\nEvaluated ${allRes.length} configs`);

  allRes.forEach(r => r._score = compositeScore(r));
  allRes.sort((a,b) => b._score - a._score);

  // Top profitable
  console.log(`\n═══ TOP 20 PROFITABLE OOS (PF≥1, annual>0) ═══`);
  let n = 0;
  for (const r of allRes) {
    if (r._score === -Infinity) break;
    const p = r.params, t = r.test, tr = r.train;
    console.log(`#${++n} score=${r._score.toFixed(3)} U=${p.UNIVERSE} SRC=${p.SOURCE} TP=${p.TP} SL=${p.SL} QT=${p.QT} FP=${p.F_POS} FN=${p.F_NEG} H=${p.HOLD_H} INV=${p.INVERT} MID=${p.MID_ONLY} ATR=${p.ATR_FILTER} MOM=${p.MOM_FILTER}`);
    console.log(`   TRAIN: ${tr.trades}t WR=${tr.wr}% PF=${tr.pf} td=${tr.perDay} DD=${tr.dd_bps}bps`);
    console.log(`   TEST : ${t.trades}t WR=${t.wr}% PF=${t.pf} td=${t.perDay} DD=${t.dd_bps}bps annual=${r.annual}%`);
    if (n >= 20) break;
  }
  if (n === 0) console.log('  NO profitable config in OOS across any combination.');

  // Hard targets
  const hard = allRes.filter(r => {
    const t = r.test;
    return t.wr >= 70 && t.pf >= 1.5 && t.perDay >= 10 && r.annual >= 200 && t.dd_bps < 1500;
  });
  console.log(`\n═══ HARD TARGETS (WR≥70 PF≥1.5 td≥10 ann≥200% DD<1500bps): ${hard.length} configs ═══`);
  for (let i=0; i<Math.min(10, hard.length); i++) {
    const r = hard[i], p = r.params, t = r.test;
    console.log(`  U=${p.UNIVERSE} SRC=${p.SOURCE} TP=${p.TP} SL=${p.SL} QT=${p.QT} FP=${p.F_POS} FN=${p.F_NEG} H=${p.HOLD_H} INV=${p.INVERT} MID=${p.MID_ONLY} ATR=${p.ATR_FILTER} MOM=${p.MOM_FILTER}`);
    console.log(`    → WR=${t.wr}% PF=${t.pf} td=${t.perDay} DD=${t.dd_bps}bps ann=${r.annual}%`);
  }

  // Relaxed targets (any profit + decent WR)
  const relaxed = allRes.filter(r => {
    const t = r.test;
    return t.wr >= 55 && t.pf >= 1.2 && t.perDay >= 3 && r.annual >= 50;
  });
  console.log(`\n═══ RELAXED (WR≥55 PF≥1.2 td≥3 ann≥50%): ${relaxed.length} configs ═══`);
  for (let i=0; i<Math.min(10, relaxed.length); i++) {
    const r = relaxed[i], p = r.params, t = r.test;
    console.log(`  U=${p.UNIVERSE} SRC=${p.SOURCE} TP=${p.TP} SL=${p.SL} QT=${p.QT} FP=${p.F_POS} FN=${p.F_NEG} H=${p.HOLD_H} INV=${p.INVERT} MID=${p.MID_ONLY} ATR=${p.ATR_FILTER} MOM=${p.MOM_FILTER}`);
    console.log(`    → WR=${t.wr}% PF=${t.pf} td=${t.perDay} DD=${t.dd_bps}bps ann=${r.annual}%`);
  }

  fs.writeFileSync('/tmp/v447-data/all-results-v2.json', JSON.stringify(allRes.slice(0, 200), null, 2));
  console.log(`\nTop-200 saved to /tmp/v447-data/all-results-v2.json`);
  console.log(`Total time: ${((Date.now()-t0)/1000).toFixed(1)}s`);
})();
