#!/usr/bin/env node
'use strict';
/**
 * V3 — Pearson-per-pair (mimic v42 PRO+) + SAFE ultra-selective
 *
 * Approach change:
 * - Instead of GBM, use Pearson correlation per feature per pair (like v42 PRO+)
 *   which previously achieved PF 1.32 empirically
 * - APEX: combine top-3 features per pair by |corr|, weighted sum, dir signal
 * - SAFE: P95 Pearson score + MTF direction aligned + regime bull/chop only
 */
const fs = require('fs');
const path = require('path');

const KLINES_DIR = '/tmp/binance-klines-1m';
const PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT','LINKUSDT','LTCUSDT','DOTUSDT','ATOMUSDT','TRXUSDT','NEARUSDT','INJUSDT'];
const TF_MIN = 15;
const INIT_CAP = 10000;
const POS_SIZE = 1000;
const FEE_RT = 0.0004;
const CLUSTERS = {
  BTCUSDT:'BTC', ETHUSDT:'L1', BNBUSDT:'L1', SOLUSDT:'L1', AVAXUSDT:'L1',
  ATOMUSDT:'L1', DOTUSDT:'L1', NEARUSDT:'L1',
  XRPUSDT:'alt', ADAUSDT:'alt', LINKUSDT:'alt', LTCUSDT:'alt', TRXUSDT:'alt',
  DOGEUSDT:'meme', INJUSDT:'defi'
};

function mkPRNG(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const prng = mkPRNG(314159265);

function load1m(pair) {
  const dir = path.join(KLINES_DIR, pair);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.csv')).sort();
  const bars = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    const lines = content.split('\n');
    const start = lines[0].startsWith('open_time') ? 1 : 0;
    for (let i = start; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) continue;
      const p = l.split(',');
      if (p.length < 11) continue;
      bars.push([+p[0], +p[1], +p[2], +p[3], +p[4], +p[5], +p[6], +p[7], +p[8], +p[9], +p[10]]);
    }
  }
  bars.sort((a, b) => a[0] - b[0]);
  return bars;
}

function aggregate15m(bars1m) {
  const out = [];
  for (let i = 0; i + TF_MIN <= bars1m.length; i += TF_MIN) {
    const slice = bars1m.slice(i, i + TF_MIN);
    const o = slice[0][1], c = slice[slice.length - 1][4];
    let h = -Infinity, l = Infinity;
    let v = 0, cnt = 0, tbv = 0;
    for (const b of slice) {
      if (b[2] > h) h = b[2];
      if (b[3] < l) l = b[3];
      v += b[5]; cnt += b[8]; tbv += b[9];
    }
    const tbr = v > 0 ? tbv / v : 0.5;
    out.push({ ts: slice[0][0], o, h, l, c, v, cnt, tbr, tbd: tbr - 0.5 });
  }
  return out;
}

function ema(arr, period, key='c') {
  const a = 2/(period+1);
  const out = new Array(arr.length); let v = arr[0][key];
  for (let i = 0; i < arr.length; i++) { v = arr[i][key]*a + v*(1-a); out[i] = v; }
  return out;
}

function rsi(arr, period=14) {
  const out = new Array(arr.length).fill(50);
  let g=0, l=0;
  for (let i = 1; i <= period && i < arr.length; i++) { const d = arr[i].c - arr[i-1].c; if (d>0) g += d; else l -= d; }
  g /= period; l /= period;
  for (let i = period; i < arr.length; i++) {
    const d = arr[i].c - arr[i-1].c;
    g = (g*(period-1) + (d>0?d:0))/period;
    l = (l*(period-1) + (d<0?-d:0))/period;
    out[i] = 100 - 100/(1 + (l===0?100:g/l));
  }
  return out;
}

function atr(arr, period=14) {
  const out = new Array(arr.length).fill(0);
  let sum = 0;
  for (let i=1; i<=period && i<arr.length; i++)
    sum += Math.max(arr[i].h-arr[i].l, Math.abs(arr[i].h-arr[i-1].c), Math.abs(arr[i].l-arr[i-1].c));
  out[period] = sum/period;
  for (let i = period+1; i < arr.length; i++) {
    const tr = Math.max(arr[i].h-arr[i].l, Math.abs(arr[i].h-arr[i-1].c), Math.abs(arr[i].l-arr[i-1].c));
    out[i] = (out[i-1]*(period-1) + tr)/period;
  }
  return out;
}

function adx(arr, period=14) {
  const out = new Array(arr.length).fill(0);
  if (arr.length < period*2) return out;
  let pDM=0, nDM=0, tr=0;
  for (let i=1; i<=period && i<arr.length; i++) {
    const up = arr[i].h - arr[i-1].h, dn = arr[i-1].l - arr[i].l;
    if (up>dn && up>0) pDM += up;
    if (dn>up && dn>0) nDM += dn;
    tr += Math.max(arr[i].h-arr[i].l, Math.abs(arr[i].h-arr[i-1].c), Math.abs(arr[i].l-arr[i-1].c));
  }
  for (let i=period+1; i<arr.length; i++) {
    const up = arr[i].h - arr[i-1].h, dn = arr[i-1].l - arr[i].l;
    const dmp = up>dn && up>0 ? up : 0;
    const dmn = dn>up && dn>0 ? dn : 0;
    const trN = Math.max(arr[i].h-arr[i].l, Math.abs(arr[i].h-arr[i-1].c), Math.abs(arr[i].l-arr[i-1].c));
    pDM = pDM - pDM/period + dmp;
    nDM = nDM - nDM/period + dmn;
    tr = tr - tr/period + trN;
    const pDI = 100*pDM/tr, nDI = 100*nDM/tr;
    const dx = 100*Math.abs(pDI-nDI)/(pDI+nDI+1e-9);
    out[i] = i===period+1 ? dx : (out[i-1]*(period-1)+dx)/period;
  }
  return out;
}

function mtfAlignment(bars, idx) {
  if (idx < 192) return 0;
  const avg = (from, to) => {
    let s = 0, n = 0;
    for (let i = Math.max(0, from); i <= Math.min(bars.length-1, to); i++) { s += bars[i].c; n++; }
    return n>0 ? s/n : 0;
  };
  const t15 = avg(idx-9, idx) > avg(idx-21, idx-10) ? 1 : -1;
  const t1h = avg(idx-15, idx) > avg(idx-31, idx-16) ? 1 : -1;
  const t4h = avg(idx-47, idx) > avg(idx-95, idx-48) ? 1 : -1;
  const t1d = avg(idx-95, idx) > avg(idx-191, idx-96) ? 1 : -1;
  return (t15+t1h+t4h+t1d)/4;
}

function detectRegime(bars, idx) {
  const period = 96;
  if (idx < period) return 'chop';
  const slice = bars.slice(idx - period, idx + 1);
  let sumRet2 = 0, n = 0;
  for (let i = 1; i < slice.length; i++) {
    const r = Math.log(slice[i].c/slice[i-1].c);
    sumRet2 += r*r;
    n++;
  }
  const rv = Math.sqrt(sumRet2/n) * Math.sqrt(96);
  const ret24 = (slice[slice.length-1].c - slice[0].c)/slice[0].c;
  const adxVals = adx(slice, 14);
  const adxNow = adxVals[adxVals.length-1] || 20;
  if (ret24 > 0.015 && adxNow > 25 && rv < 0.06) return 'bull';
  if (ret24 < -0.015 && adxNow > 25) return 'bear';
  if (rv > 0.07 || adxNow < 18) return 'chop';
  return Math.abs(ret24) > 0.008 ? (ret24>0?'bull':'bear') : 'chop';
}

const FEATURE_NAMES = ['ret1','ret4','ret16','vol16','tbd','emaCross','emaSlow','rsiNorm','adxN','mtfSigned'];

function buildFeatures(bars) {
  const e9 = ema(bars, 9);
  const e21 = ema(bars, 21);
  const e55 = ema(bars, 55);
  const r14 = rsi(bars, 14);
  const a14 = atr(bars, 14);
  const adx14 = adx(bars, 14);
  const feats = [];
  for (let i = 192; i < bars.length; i++) {
    const b = bars[i];
    const ret1 = (b.c - bars[i-1].c)/bars[i-1].c;
    const ret4 = (b.c - bars[i-4].c)/bars[i-4].c;
    const ret16 = (b.c - bars[i-16].c)/bars[i-16].c;
    let vol16 = 0;
    for (let j = i-15; j <= i; j++) {
      const r = (bars[j].c - bars[j-1].c)/bars[j-1].c;
      vol16 += r*r;
    }
    vol16 = Math.sqrt(vol16/16);
    const emaCross = (e9[i] - e21[i])/e21[i];
    const emaSlow = (e21[i] - e55[i])/e55[i];
    const rsiNorm = (r14[i] - 50)/50;
    const atrPct = a14[i]/b.c;
    const adxN = adx14[i]/100;
    const regime = detectRegime(bars, i);
    const mtfSigned = mtfAlignment(bars, i);
    feats.push({
      ts: b.ts, c: b.c, h: b.h, l: b.l, atrPct,
      feats: [ret1, ret4, ret16, vol16, b.tbd, emaCross, emaSlow, rsiNorm, adxN, mtfSigned],
      regime, mtfSigned
    });
  }
  return feats;
}

// Compute forward label: return 2 bars ahead
function forwardReturn(feats, i, horizon=2) {
  if (i + horizon >= feats.length) return null;
  return (feats[i+horizon].c - feats[i].c) / feats[i].c;
}

// Pearson correlation
function pearsonCorr(x, y) {
  const n = x.length;
  if (n < 10) return 0;
  let sx=0, sy=0, sxy=0, sx2=0, sy2=0;
  for (let i=0; i<n; i++) {
    sx += x[i]; sy += y[i];
    sxy += x[i]*y[i];
    sx2 += x[i]*x[i]; sy2 += y[i]*y[i];
  }
  const num = n*sxy - sx*sy;
  const den = Math.sqrt((n*sx2 - sx*sx) * (n*sy2 - sy*sy));
  return den === 0 ? 0 : num/den;
}

async function main() {
  console.log('[V3] APEX + SAFE Pearson-per-pair iteration');
  const data = {};
  for (const pair of PAIRS) {
    const b1m = load1m(pair);
    if (!b1m || b1m.length < 10000) { console.log(`[SKIP] ${pair}`); continue; }
    const b15m = aggregate15m(b1m);
    const feats = buildFeatures(b15m);
    data[pair] = { bars: b15m, features: feats };
  }
  const activePairs = Object.keys(data);
  const sample = data[activePairs[0]].features;
  const tsStart = sample[0].ts, tsEnd = sample[sample.length-1].ts;
  console.log(`[V3] ${activePairs.length} pairs, range ${new Date(tsStart).toISOString().slice(0,10)} → ${new Date(tsEnd).toISOString().slice(0,10)}`);

  const TRAIN_DAYS = 120, TEST_DAYS = 30, STEP_DAYS = 30;
  const windows = [];
  let ts = tsStart;
  while (true) {
    const te = ts + TRAIN_DAYS*86400000;
    const end = te + TEST_DAYS*86400000;
    if (end > tsEnd) break;
    windows.push({ trainStart: ts, trainEnd: te, testStart: te, testEnd: end });
    ts += STEP_DAYS*86400000;
  }
  console.log(`[V3] ${windows.length} windows`);

  const apexTrades = [];
  const safeTrades = [];

  for (let w = 0; w < windows.length; w++) {
    const win = windows[w];
    console.log(`[WF ${w+1}/${windows.length}]`);

    // Compute Pearson corr per pair for each feature vs forward return (train period)
    const weights = {};
    const scoreSigma = {};
    for (const pair of activePairs) {
      const feats = data[pair].features;
      const trainFeats = feats.filter(f => f.ts >= win.trainStart && f.ts < win.trainEnd);
      if (trainFeats.length < 500) continue;
      const Y = [];
      const xByFeat = FEATURE_NAMES.map(() => []);
      for (let i = 0; i < trainFeats.length; i++) {
        const fullIdx = feats.indexOf(trainFeats[i]);
        const fr = forwardReturn(feats, fullIdx, 2);
        if (fr == null) continue;
        Y.push(fr);
        for (let k = 0; k < FEATURE_NAMES.length; k++) {
          xByFeat[k].push(trainFeats[i].feats[k]);
        }
      }
      // Compute corrs
      const corrs = [];
      for (let k = 0; k < FEATURE_NAMES.length; k++) {
        const c = pearsonCorr(xByFeat[k], Y);
        corrs.push({ idx: k, corr: c, abs: Math.abs(c) });
      }
      corrs.sort((a,b) => b.abs - a.abs);
      // Take top 5 features by |corr|
      const topK = corrs.slice(0, 5);
      weights[pair] = topK;

      // Compute score distribution
      const scores = trainFeats.map(f => {
        let s = 0;
        for (const tk of topK) s += tk.corr * f.feats[tk.idx];
        return s;
      });
      scores.sort((a,b) => Math.abs(a) - Math.abs(b));
      scoreSigma[pair] = {
        p50: Math.abs(scores[Math.floor(scores.length*0.5)]),
        p70: Math.abs(scores[Math.floor(scores.length*0.7)]),
        p85: Math.abs(scores[Math.floor(scores.length*0.85)]),
        p95: Math.abs(scores[Math.floor(scores.length*0.95)])
      };
    }

    // Simulate test
    const apexOpen = [], safeOpen = [];
    const pairPnL = {};
    for (const p of activePairs) pairPnL[p] = [];

    const bars = [];
    for (const pair of activePairs) {
      for (const f of data[pair].features) {
        if (f.ts < win.testStart || f.ts >= win.testEnd) continue;
        bars.push({ pair, ...f });
      }
    }
    bars.sort((a, b) => a.ts - b.ts);

    for (const b of bars) {
      // Exits
      for (const openList of [apexOpen, safeOpen]) {
        for (let i = openList.length - 1; i >= 0; i--) {
          const t = openList[i];
          if (t.pair !== b.pair) continue;
          const mv = t.side === 'LONG'
            ? (b.h >= t.tp ? { hit:'tp', px:t.tp } : (b.l <= t.sl ? { hit:'sl', px:t.sl } : null))
            : (b.l <= t.tp ? { hit:'tp', px:t.tp } : (b.h >= t.sl ? { hit:'sl', px:t.sl } : null));
          const barsHeld = Math.floor((b.ts - t.ts)/(15*60*1000));
          const timeout = t.engine === 'SAFE' ? 80 : 60;
          if (mv || barsHeld >= timeout) {
            const exitPx = mv ? mv.px : b.c;
            const pnl = t.side === 'LONG'
              ? (exitPx - t.entry)/t.entry * POS_SIZE - POS_SIZE*FEE_RT
              : (t.entry - exitPx)/t.entry * POS_SIZE - POS_SIZE*FEE_RT;
            const tr = { pair: t.pair, side: t.side, entry: t.entry, exit: exitPx, tsEntry: t.ts, tsExit: b.ts, barsHeld, pnl, win: pnl>0, engine: t.engine };
            if (t.engine === 'APEX') { apexTrades.push(tr); pairPnL[t.pair].push({ ts: b.ts, pnl }); }
            else safeTrades.push(tr);
            openList.splice(i, 1);
          }
        }
      }

      const w = weights[b.pair];
      const sig = scoreSigma[b.pair];
      if (!w || !sig) continue;

      let score = 0;
      for (const tk of w) score += tk.corr * b.feats[tk.idx];
      const absScore = Math.abs(score);

      // Kill switch
      const cutoff = b.ts - 14*86400000;
      const recent = pairPnL[b.pair].filter(p => p.ts >= cutoff);
      const recentSum = recent.reduce((s,p)=>s+p.pnl, 0);
      const killed = recent.length >= 5 && recentSum < -50;

      // APEX
      const apexMaxPos = 4;
      const apexRegimeCap = b.regime === 'bull' ? 4 : b.regime === 'chop' ? 3 : 1;
      if (!killed
          && apexOpen.length < Math.min(apexMaxPos, apexRegimeCap)
          && absScore >= sig.p70
          && Math.abs(b.mtfSigned) >= 0.5
          && !apexOpen.find(t => t.pair === b.pair)) {
        const cluster = CLUSTERS[b.pair];
        const sameCluster = apexOpen.filter(t => CLUSTERS[t.pair] === cluster).length;
        if (sameCluster < 2) {
          const side = score > 0 ? 'LONG' : 'SHORT';
          const regimeAllowed = (b.regime === 'bull' && side === 'LONG')
                             || (b.regime === 'bear' && side === 'SHORT')
                             || (b.regime === 'chop');
          if (regimeAllowed) {
            const entry = b.c;
            const atrPx = b.atrPct * entry;
            const tp = side === 'LONG' ? entry + atrPx*1.5 : entry - atrPx*1.5;
            const sl = side === 'LONG' ? entry - atrPx*1.0 : entry + atrPx*1.0;
            apexOpen.push({ pair: b.pair, side, entry, tp, sl, ts: b.ts, engine: 'APEX' });
          }
        }
      }

      // SAFE — ultra selective: P95 + signed MTF >= 0.75 same dir + bull/chop
      const safeMaxPos = 1;
      if (safeOpen.length < safeMaxPos
          && absScore >= sig.p95
          && Math.abs(b.mtfSigned) >= 0.75
          && b.regime !== 'bear'
          && !safeOpen.find(t => t.pair === b.pair)) {
        const side = score > 0 ? 'LONG' : 'SHORT';
        const mtfAligned = (side === 'LONG' && b.mtfSigned > 0) || (side === 'SHORT' && b.mtfSigned < 0);
        const regimeAllowed = (b.regime === 'bull' && side === 'LONG') || (b.regime === 'chop');
        if (mtfAligned && regimeAllowed) {
          const entry = b.c;
          const atrPx = b.atrPct * entry;
          const tp = side === 'LONG' ? entry + atrPx*2.5 : entry - atrPx*2.5;
          const sl = side === 'LONG' ? entry - atrPx*1.0 : entry + atrPx*1.0;
          safeOpen.push({ pair: b.pair, side, entry, tp, sl, ts: b.ts, engine: 'SAFE' });
        }
      }
    }
  }

  function metrics(trades) {
    if (trades.length === 0) return { n: 0 };
    const wins = trades.filter(t=>t.win);
    const losses = trades.filter(t=>!t.win);
    const sumWin = wins.reduce((s,t)=>s+t.pnl, 0);
    const sumLoss = Math.abs(losses.reduce((s,t)=>s+t.pnl, 0));
    const pnl = sumWin - sumLoss;
    const wr = wins.length/trades.length;
    const pf = sumLoss > 0 ? sumWin/sumLoss : sumWin;
    let peak=0, dd=0, cash=0;
    for (const t of trades) {
      cash += t.pnl;
      if (cash > peak) peak = cash;
      const d = peak > 0 ? (peak - cash)/(INIT_CAP + peak) : 0;
      if (d > dd) dd = d;
    }
    const monthly = {};
    for (const t of trades) {
      const m = new Date(t.tsExit).toISOString().slice(0,7);
      if (!monthly[m]) monthly[m] = { pnl:0, n:0, w:0 };
      monthly[m].pnl += t.pnl; monthly[m].n++; if (t.win) monthly[m].w++;
    }
    const monthsPos = Object.values(monthly).filter(m => m.pnl > 0).length;
    const monthsTotal = Object.keys(monthly).length;
    const avgHold = trades.reduce((s,t)=>s+t.barsHeld, 0)/trades.length*15;
    const sorted = [...trades].sort((a,b)=>a.tsExit - b.tsExit);
    const mkRolling = (days) => {
      const r = [];
      for (let i=0; i<sorted.length; i++) {
        const e = sorted[i].tsExit;
        const s = e - days*86400000;
        const w = sorted.filter(t => t.tsExit >= s && t.tsExit <= e);
        r.push(w.reduce((x,t)=>x+t.pnl, 0));
      }
      return r;
    };
    const r30 = mkRolling(30), r60 = mkRolling(60), r120 = mkRolling(120);
    return {
      n: trades.length, wr, pf, pnl, dd, avgHold, monthly,
      monthsPos, monthsTotal,
      roll30Neg: r30.filter(p=>p<0).length,
      roll60Neg: r60.filter(p=>p<0).length,
      roll120Neg: r120.filter(p=>p<0).length,
      tradesPerDay: trades.length/(windows.length*TEST_DAYS)
    };
  }

  const apexM = metrics(apexTrades);
  const safeM = metrics(safeTrades);
  console.log('\n' + '='.repeat(70));
  console.log('V3 RESULTS');
  console.log('='.repeat(70));
  console.log(`APEX: ${apexM.n}t, t/d ${apexM.tradesPerDay?.toFixed(2)}, PF ${apexM.pf?.toFixed(2)}, WR ${(apexM.wr*100)?.toFixed(1)}%, PnL $${apexM.pnl?.toFixed(0)}, DD ${(apexM.dd*100)?.toFixed(1)}%`);
  console.log(`  Hold ${apexM.avgHold?.toFixed(0)}min, Months pos ${apexM.monthsPos}/${apexM.monthsTotal}, Roll30/60/120 neg ${apexM.roll30Neg}/${apexM.roll60Neg}/${apexM.roll120Neg}`);
  console.log(`SAFE: ${safeM.n}t, t/d ${safeM.tradesPerDay?.toFixed(3)}, PF ${safeM.pf?.toFixed(2)}, WR ${(safeM.wr*100)?.toFixed(1)}%, PnL $${safeM.pnl?.toFixed(0)}, DD ${(safeM.dd*100)?.toFixed(1)}%`);
  console.log(`  Hold ${safeM.avgHold?.toFixed(0)}min, Months pos ${safeM.monthsPos}/${safeM.monthsTotal}, Roll30/60/120 neg ${safeM.roll30Neg}/${safeM.roll60Neg}/${safeM.roll120Neg}`);

  console.log('\nMonthly APEX:');
  for (const [m, d] of Object.entries(apexM.monthly || {}).sort())
    console.log(`  ${m}: PnL $${d.pnl.toFixed(0)}, ${d.n}t, WR ${(d.w/d.n*100).toFixed(1)}%`);
  console.log('\nMonthly SAFE:');
  for (const [m, d] of Object.entries(safeM.monthly || {}).sort())
    console.log(`  ${m}: PnL $${d.pnl.toFixed(0)}, ${d.n}t, WR ${(d.w/d.n*100).toFixed(1)}%`);

  fs.writeFileSync('/tmp/research-apex-safe-v3-result.json', JSON.stringify({ apex: apexM, safe: safeM }, null, 2));
  console.log('\n[SAVED] /tmp/research-apex-safe-v3-result.json');
}

main().catch(e => { console.error(e); process.exit(1); });
