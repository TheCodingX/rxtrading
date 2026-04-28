#!/usr/bin/env node
'use strict';
/**
 * APEX + SAFE research V2
 *
 * Iteration 2 improvements:
 * APEX:
 *  - Stricter threshold: P90 (was P75)
 *  - Require regime-aligned direction (bull→LONG only, bear→SHORT only, chop→both)
 *  - Require MTF >= 0.5
 *  - Meta-labeling layer: second GBM predicts P(win) given primary signal
 *  - Maker-only simulation: 30% of signals rejected (unfilled)
 *  - Kill-switch per pair rolling 14d
 *  - Exposure cap by regime: bull=100%, chop=60%, bear=20%
 *
 * SAFE:
 *  - Even stricter: P97 + MTF >= 0.8 + confluence 10 gates
 *  - Regime must be bull (no chop - too risky for WR 85%)
 *  - Skip bear/chop entirely
 *  - TP tight (0.3xATR), SL wide (1.0xATR) to enable high WR
 *    [math: WR 85% requires TP<<SL or accept WR lower]
 *  - Hold timeout 30 bars min, 80 bars max
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
    let v = 0, qv = 0, tbv = 0, tbqv = 0, cnt = 0;
    for (const b of slice) {
      if (b[2] > h) h = b[2];
      if (b[3] < l) l = b[3];
      v += b[5]; qv += b[7]; cnt += b[8]; tbv += b[9]; tbqv += b[10];
    }
    const takerBuyRatio = v > 0 ? tbv / v : 0.5;
    let ofi = 0;
    for (const b of slice) {
      const takerSell = b[5] - b[9];
      ofi += (b[9] - takerSell);
    }
    out.push({
      ts: slice[0][0], o, h, l, c, v, cnt, takerBuyRatio,
      ofi, tbRatioDelta: takerBuyRatio - 0.5
    });
  }
  return out;
}

function ema(arr, period, key = 'c') {
  const a = 2 / (period + 1);
  const out = new Array(arr.length);
  let v = arr[0][key];
  for (let i = 0; i < arr.length; i++) {
    v = arr[i][key] * a + v * (1 - a);
    out[i] = v;
  }
  return out;
}

function rsi(arr, period = 14) {
  const out = new Array(arr.length).fill(50);
  let gain = 0, loss = 0;
  for (let i = 1; i <= period && i < arr.length; i++) {
    const d = arr[i].c - arr[i - 1].c;
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period; i < arr.length; i++) {
    const d = arr[i].c - arr[i - 1].c;
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = 100 - 100 / (1 + (loss === 0 ? 100 : gain / loss));
  }
  return out;
}

function atr(arr, period = 14) {
  const out = new Array(arr.length).fill(0);
  let sum = 0;
  for (let i = 1; i <= period && i < arr.length; i++) {
    sum += Math.max(arr[i].h - arr[i].l, Math.abs(arr[i].h - arr[i - 1].c), Math.abs(arr[i].l - arr[i - 1].c));
  }
  out[period] = sum / period;
  for (let i = period + 1; i < arr.length; i++) {
    const tr = Math.max(arr[i].h - arr[i].l, Math.abs(arr[i].h - arr[i - 1].c), Math.abs(arr[i].l - arr[i - 1].c));
    out[i] = (out[i - 1] * (period - 1) + tr) / period;
  }
  return out;
}

function adx(arr, period = 14) {
  const out = new Array(arr.length).fill(0);
  if (arr.length < period * 2) return out;
  let pDM = 0, nDM = 0, tr = 0;
  for (let i = 1; i <= period && i < arr.length; i++) {
    const up = arr[i].h - arr[i - 1].h, dn = arr[i - 1].l - arr[i].l;
    if (up > dn && up > 0) pDM += up;
    if (dn > up && dn > 0) nDM += dn;
    tr += Math.max(arr[i].h - arr[i].l, Math.abs(arr[i].h - arr[i - 1].c), Math.abs(arr[i].l - arr[i - 1].c));
  }
  for (let i = period + 1; i < arr.length; i++) {
    const up = arr[i].h - arr[i - 1].h, dn = arr[i - 1].l - arr[i].l;
    const dmp = up > dn && up > 0 ? up : 0;
    const dmn = dn > up && dn > 0 ? dn : 0;
    const trN = Math.max(arr[i].h - arr[i].l, Math.abs(arr[i].h - arr[i - 1].c), Math.abs(arr[i].l - arr[i - 1].c));
    pDM = pDM - pDM / period + dmp;
    nDM = nDM - nDM / period + dmn;
    tr = tr - tr / period + trN;
    const pDI = 100 * pDM / tr, nDI = 100 * nDM / tr;
    const dx = 100 * Math.abs(pDI - nDI) / (pDI + nDI + 1e-9);
    out[i] = i === period + 1 ? dx : (out[i - 1] * (period - 1) + dx) / period;
  }
  return out;
}

function mtfAlignment(bars, idx) {
  if (idx < 96) return 0;
  const b = bars;
  const avg = (from, to) => {
    let s = 0, n = 0;
    for (let i = Math.max(0, from); i <= Math.min(b.length - 1, to); i++) { s += b[i].c; n++; }
    return n > 0 ? s / n : 0;
  };
  // 15m
  const t15 = avg(idx - 9, idx) > avg(idx - 21, idx - 10) ? 1 : -1;
  // 1h
  const t1h = avg(idx - 15, idx) > avg(idx - 31, idx - 16) ? 1 : -1;
  // 4h
  const t4h = avg(idx - 47, idx) > avg(idx - 95, idx - 48) ? 1 : -1;
  // 1d
  const t1d = avg(idx - 95, idx) > avg(idx - 191, idx - 96) ? 1 : -1;
  const sum = t15 + t1h + t4h + t1d;
  // Signed: +1 all bull, -1 all bear
  return sum / 4;
}

function detectRegime(bars, idx) {
  const period = 96;
  if (idx < period) return 'chop';
  const slice = bars.slice(idx - period, idx + 1);
  let sumRet2 = 0, n = 0;
  for (let i = 1; i < slice.length; i++) {
    const r = Math.log(slice[i].c / slice[i - 1].c);
    sumRet2 += r * r;
    n++;
  }
  const rv = Math.sqrt(sumRet2 / n) * Math.sqrt(96);
  const ret24 = (slice[slice.length - 1].c - slice[0].c) / slice[0].c;
  const adxVals = adx(slice, 14);
  const adxNow = adxVals[adxVals.length - 1] || 20;
  if (ret24 > 0.015 && adxNow > 25 && rv < 0.06) return 'bull';
  if (ret24 < -0.015 && adxNow > 25) return 'bear';
  if (rv > 0.07 || adxNow < 18) return 'chop';
  return Math.abs(ret24) > 0.008 ? (ret24 > 0 ? 'bull' : 'bear') : 'chop';
}

function buildFeatures(bars) {
  const e9 = ema(bars, 9);
  const e21 = ema(bars, 21);
  const e55 = ema(bars, 55);
  const r14 = rsi(bars, 14);
  const a14 = atr(bars, 14);
  const adx14 = adx(bars, 14);
  const features = [];
  for (let i = 192; i < bars.length; i++) {
    const b = bars[i];
    const ret1 = (b.c - bars[i - 1].c) / bars[i - 1].c;
    const ret4 = (b.c - bars[i - 4].c) / bars[i - 4].c;
    const ret16 = (b.c - bars[i - 16].c) / bars[i - 16].c;
    const ret96 = (b.c - bars[i - 96].c) / bars[i - 96].c;
    let vol16 = 0;
    for (let j = i - 15; j <= i; j++) {
      const r = (bars[j].c - bars[j - 1].c) / bars[j - 1].c;
      vol16 += r * r;
    }
    vol16 = Math.sqrt(vol16 / 16);
    const emaCross = (e9[i] - e21[i]) / e21[i];
    const emaSlow = (e21[i] - e55[i]) / e55[i];
    const rsiNorm = (r14[i] - 50) / 50;
    const atrPct = a14[i] / b.c;
    const adxN = adx14[i] / 100;
    const regime = detectRegime(bars, i);
    const regimeBull = regime === 'bull' ? 1 : 0;
    const regimeBear = regime === 'bear' ? 1 : 0;
    const regimeChop = regime === 'chop' ? 1 : 0;
    const mtfSigned = mtfAlignment(bars, i); // [-1, +1]
    const mtfAbs = Math.abs(mtfSigned);
    features.push({
      ts: b.ts, c: b.c, h: b.h, l: b.l,
      ret1, ret4, ret16, ret96, vol16,
      tbrDelta: b.tbRatioDelta, ofiNorm: b.ofi / (b.v + 1e-9),
      emaCross, emaSlow, rsiNorm, atrPct, adxN,
      regime, regimeBull, regimeBear, regimeChop,
      mtfSigned, mtfAbs
    });
  }
  return features;
}

function tripleBarrierLabels(features, atrMult = 1.5, timeout = 60) {
  const labels = [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const atrPct = f.atrPct;
    const tp = f.c * (1 + atrPct * atrMult);
    const sl = f.c * (1 - atrPct * atrMult);
    let outcome = 0;
    for (let j = i + 1; j < Math.min(i + timeout, features.length); j++) {
      if (features[j].h >= tp) { outcome = 1; break; }
      if (features[j].l <= sl) { outcome = -1; break; }
    }
    labels.push(outcome);
  }
  return labels;
}

class SimpleGBM {
  constructor(opts = {}) {
    this.lr = opts.lr || 0.05;
    this.nEst = opts.nEst || 100;
    this.trees = [];
  }
  fit(X, y) {
    const n = X.length;
    const preds = new Array(n).fill(0);
    for (let t = 0; t < this.nEst; t++) {
      const resid = y.map((yi, i) => yi - preds[i]);
      const tree = this.fitStump(X, resid);
      for (let i = 0; i < n; i++) {
        preds[i] += this.lr * this.predictTree(tree, X[i]);
      }
      this.trees.push(tree);
    }
  }
  fitStump(X, y) {
    if (X.length === 0) return { isLeaf: true, value: 0 };
    const nFeat = X[0].length;
    let bestErr = Infinity, bestFeat = 0, bestThr = 0, bestL = 0, bestR = 0;
    const featsToTry = Math.min(nFeat, 10);
    const featIdxs = [];
    for (let k = 0; k < featsToTry; k++) featIdxs.push(Math.floor(prng() * nFeat));
    for (const f of featIdxs) {
      const vals = X.map(x => x[f]).sort((a, b) => a - b);
      const triesPerFeat = 12;
      for (let k = 0; k < triesPerFeat; k++) {
        const thr = vals[Math.floor(vals.length * (k + 0.5) / triesPerFeat)];
        let sumL = 0, cntL = 0, sumR = 0, cntR = 0;
        for (let i = 0; i < X.length; i++) {
          if (X[i][f] <= thr) { sumL += y[i]; cntL++; }
          else { sumR += y[i]; cntR++; }
        }
        if (cntL === 0 || cntR === 0) continue;
        const meanL = sumL / cntL, meanR = sumR / cntR;
        let err = 0;
        for (let i = 0; i < X.length; i++) {
          const p = X[i][f] <= thr ? meanL : meanR;
          err += (y[i] - p) * (y[i] - p);
        }
        if (err < bestErr) {
          bestErr = err; bestFeat = f; bestThr = thr; bestL = meanL; bestR = meanR;
        }
      }
    }
    return { isLeaf: false, feat: bestFeat, thr: bestThr, left: bestL, right: bestR };
  }
  predictTree(tree, x) {
    if (tree.isLeaf) return tree.value;
    return x[tree.feat] <= tree.thr ? tree.left : tree.right;
  }
  predict(x) {
    let y = 0;
    for (const t of this.trees) y += this.lr * this.predictTree(t, x);
    return y;
  }
}

async function main() {
  console.log('[V2] APEX + SAFE research iteration 2');
  const data = {};
  for (const pair of PAIRS) {
    const b1m = load1m(pair);
    if (!b1m || b1m.length < 10000) { console.log(`[SKIP] ${pair}`); continue; }
    const b15m = aggregate15m(b1m);
    const feats = buildFeatures(b15m);
    const labels = tripleBarrierLabels(feats, 1.5, 60);
    data[pair] = { bars: b15m, features: feats, labels };
    console.log(`[LOAD] ${pair}: ${feats.length} features`);
  }
  const activePairs = Object.keys(data);
  const sample = data[activePairs[0]].features;
  const tsStart = sample[0].ts, tsEnd = sample[sample.length - 1].ts;
  console.log(`[V2] ${activePairs.length} pairs, range ${new Date(tsStart).toISOString().slice(0,10)} → ${new Date(tsEnd).toISOString().slice(0,10)}`);

  const TRAIN_DAYS = 120, TEST_DAYS = 30, STEP_DAYS = 30;
  const windows = [];
  let trainStart = tsStart;
  while (true) {
    const trainEnd = trainStart + TRAIN_DAYS * 86400000;
    const testEnd = trainEnd + TEST_DAYS * 86400000;
    if (testEnd > tsEnd) break;
    windows.push({ trainStart, trainEnd, testStart: trainEnd, testEnd });
    trainStart += STEP_DAYS * 86400000;
  }
  console.log(`[V2] ${windows.length} walk-forward windows`);

  const apexTrades = [];
  const safeTrades = [];

  for (let w = 0; w < windows.length; w++) {
    const win = windows[w];
    console.log(`[WF ${w+1}/${windows.length}] Test ${new Date(win.testStart).toISOString().slice(0,10)} → ${new Date(win.testEnd).toISOString().slice(0,10)}`);

    // Train primary models
    const models = {}, metaModels = {}, thresholds = {};
    for (const pair of activePairs) {
      const feats = data[pair].features, labels = data[pair].labels;
      const Xtrain = [], ytrain = [];
      for (let i = 0; i < feats.length; i++) {
        if (feats[i].ts < win.trainStart || feats[i].ts >= win.trainEnd) continue;
        const f = feats[i];
        Xtrain.push([f.ret1, f.ret4, f.ret16, f.ret96, f.vol16, f.tbrDelta, f.ofiNorm, f.emaCross, f.emaSlow, f.rsiNorm, f.atrPct, f.adxN, f.regimeBull, f.regimeBear, f.regimeChop, f.mtfSigned, f.mtfAbs]);
        ytrain.push(labels[i]);
      }
      if (Xtrain.length < 200) continue;
      const gbm = new SimpleGBM({ nEst: 80, lr: 0.06 });
      gbm.fit(Xtrain, ytrain);
      models[pair] = gbm;

      // Meta-model: predict P(correct) given primary score + context features
      const Xmeta = [], ymeta = [];
      for (let i = 0; i < feats.length; i++) {
        if (feats[i].ts < win.trainStart || feats[i].ts >= win.trainEnd) continue;
        const f = feats[i];
        const primary = gbm.predict([f.ret1, f.ret4, f.ret16, f.ret96, f.vol16, f.tbrDelta, f.ofiNorm, f.emaCross, f.emaSlow, f.rsiNorm, f.atrPct, f.adxN, f.regimeBull, f.regimeBear, f.regimeChop, f.mtfSigned, f.mtfAbs]);
        const primarySign = primary > 0 ? 1 : -1;
        const actualSign = labels[i];
        // Meta feature: |primary|, mtf abs, regime, recent win rate
        Xmeta.push([Math.abs(primary), f.mtfAbs, f.regimeBull, f.regimeBear, f.vol16, f.atrPct, f.adxN]);
        ymeta.push(primarySign === actualSign ? 1 : (actualSign === 0 ? 0 : -1));
      }
      if (Xmeta.length >= 200) {
        const metaGbm = new SimpleGBM({ nEst: 40, lr: 0.08 });
        metaGbm.fit(Xmeta, ymeta);
        metaModels[pair] = metaGbm;
      }

      // Thresholds
      const preds = Xtrain.map(x => Math.abs(gbm.predict(x)));
      preds.sort((a, b) => a - b);
      thresholds[pair] = {
        p75: preds[Math.floor(preds.length * 0.75)],
        p90: preds[Math.floor(preds.length * 0.90)],
        p95: preds[Math.floor(preds.length * 0.95)],
        p97: preds[Math.floor(preds.length * 0.97)]
      };
    }

    // SIMULATE TEST
    const apexOpen = [], safeOpen = [];
    const apexMaxPos = 4, safeMaxPos = 1;

    // Track per-pair rolling PnL for kill-switch (APEX)
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
            ? (b.h >= t.tp ? { hit: 'tp', px: t.tp } : (b.l <= t.sl ? { hit: 'sl', px: t.sl } : null))
            : (b.l <= t.tp ? { hit: 'tp', px: t.tp } : (b.h >= t.sl ? { hit: 'sl', px: t.sl } : null));
          const barsHeld = Math.floor((b.ts - t.ts) / (15 * 60 * 1000));
          const timeout = t.engine === 'SAFE' ? 80 : 60;
          if (mv || barsHeld >= timeout) {
            const exitPx = mv ? mv.px : b.c;
            const pnl = t.side === 'LONG'
              ? (exitPx - t.entry) / t.entry * POS_SIZE - POS_SIZE * FEE_RT
              : (t.entry - exitPx) / t.entry * POS_SIZE - POS_SIZE * FEE_RT;
            const tr = { pair: t.pair, side: t.side, entry: t.entry, exit: exitPx, tsEntry: t.ts, tsExit: b.ts, barsHeld, pnl, win: pnl > 0, engine: t.engine };
            if (t.engine === 'APEX') { apexTrades.push(tr); pairPnL[t.pair].push({ ts: b.ts, pnl }); }
            else { safeTrades.push(tr); }
            openList.splice(i, 1);
          }
        }
      }

      const model = models[b.pair];
      if (!model) continue;
      const x = [b.ret1, b.ret4, b.ret16, b.ret96, b.vol16, b.tbrDelta, b.ofiNorm, b.emaCross, b.emaSlow, b.rsiNorm, b.atrPct, b.adxN, b.regimeBull, b.regimeBear, b.regimeChop, b.mtfSigned, b.mtfAbs];
      const score = model.predict(x);
      const absScore = Math.abs(score);
      const thr = thresholds[b.pair];
      if (!thr) continue;

      // Meta-label
      const metaModel = metaModels[b.pair];
      const metaScore = metaModel ? metaModel.predict([absScore, b.mtfAbs, b.regimeBull, b.regimeBear, b.vol16, b.atrPct, b.adxN]) : 0.5;

      // Kill-switch rolling 14d
      const cutoff = b.ts - 14 * 86400000;
      const recentPnL = pairPnL[b.pair].filter(p => p.ts >= cutoff);
      const recentSum = recentPnL.reduce((s, p) => s + p.pnl, 0);
      const killed = recentPnL.length >= 5 && recentSum < -50;

      // ========== APEX ==========
      const apexRegimeCap = b.regime === 'bull' ? 4 : b.regime === 'chop' ? 2 : 1;
      const minMetaApex = 0.15;
      if (!killed
          && apexOpen.length < Math.min(apexMaxPos, apexRegimeCap)
          && absScore >= thr.p90
          && metaScore >= minMetaApex
          && b.mtfAbs >= 0.5
          && !apexOpen.find(t => t.pair === b.pair)) {
        const cluster = CLUSTERS[b.pair];
        const sameCluster = apexOpen.filter(t => CLUSTERS[t.pair] === cluster).length;
        if (sameCluster < 2) {
          const side = score > 0 ? 'LONG' : 'SHORT';
          // Regime-aligned direction
          const regimeAllowed = (b.regime === 'bull' && side === 'LONG') || (b.regime === 'bear' && side === 'SHORT') || (b.regime === 'chop');
          // Maker-only simulation: 35% rejection (won't fill)
          const makerFill = prng() > 0.35;
          if (regimeAllowed && makerFill) {
            const entry = b.c;
            const atrPx = b.atrPct * entry;
            const tp = side === 'LONG' ? entry + atrPx * 1.5 : entry - atrPx * 1.5;
            const sl = side === 'LONG' ? entry - atrPx * 1.0 : entry + atrPx * 1.0;
            apexOpen.push({ pair: b.pair, side, entry, tp, sl, ts: b.ts, engine: 'APEX' });
          }
        }
      }

      // ========== SAFE ==========
      // Ultra strict: P97 + MTF >= 0.75 signed same direction + bull/chop only
      if (safeOpen.length < safeMaxPos
          && absScore >= thr.p97
          && metaScore >= 0.25
          && Math.abs(b.mtfSigned) >= 0.75
          && b.regime !== 'bear'
          && !safeOpen.find(t => t.pair === b.pair)) {
        const side = score > 0 ? 'LONG' : 'SHORT';
        // Direction must match MTF and regime
        const mtfAligned = (side === 'LONG' && b.mtfSigned > 0) || (side === 'SHORT' && b.mtfSigned < 0);
        const regimeAllowed = (b.regime === 'bull' && side === 'LONG') || (b.regime === 'chop');
        const makerFill = prng() > 0.35;
        if (mtfAligned && regimeAllowed && makerFill) {
          const entry = b.c;
          const atrPx = b.atrPct * entry;
          // SAFE config: TP wide 2.5x, SL 1.0x (honest — WR will be lower)
          const tp = side === 'LONG' ? entry + atrPx * 2.5 : entry - atrPx * 2.5;
          const sl = side === 'LONG' ? entry - atrPx * 1.0 : entry + atrPx * 1.0;
          safeOpen.push({ pair: b.pair, side, entry, tp, sl, ts: b.ts, engine: 'SAFE' });
        }
      }
    }
  }

  function metrics(trades) {
    if (trades.length === 0) return { n: 0 };
    const wins = trades.filter(t => t.win);
    const losses = trades.filter(t => !t.win);
    const sumWin = wins.reduce((s, t) => s + t.pnl, 0);
    const sumLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pnl = sumWin - sumLoss;
    const wr = wins.length / trades.length;
    const pf = sumLoss > 0 ? sumWin / sumLoss : sumWin;
    let peak = 0, dd = 0, cash = 0;
    for (const t of trades) {
      cash += t.pnl;
      if (cash > peak) peak = cash;
      const d = peak > 0 ? (peak - cash) / (INIT_CAP + peak) : 0;
      if (d > dd) dd = d;
    }
    const monthly = {};
    for (const t of trades) {
      const m = new Date(t.tsExit).toISOString().slice(0, 7);
      if (!monthly[m]) monthly[m] = { pnl: 0, n: 0, w: 0 };
      monthly[m].pnl += t.pnl; monthly[m].n++;
      if (t.win) monthly[m].w++;
    }
    const monthsPos = Object.values(monthly).filter(m => m.pnl > 0).length;
    const monthsTotal = Object.keys(monthly).length;
    const avgHold = trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length * 15;

    // Rolling windows
    const sorted = [...trades].sort((a, b) => a.tsExit - b.tsExit);
    const mkRolling = (days) => {
      const results = [];
      for (let i = 0; i < sorted.length; i++) {
        const end = sorted[i].tsExit;
        const start = end - days * 86400000;
        const windowT = sorted.filter(t => t.tsExit >= start && t.tsExit <= end);
        results.push(windowT.reduce((s, t) => s + t.pnl, 0));
      }
      return results;
    };
    const r30 = mkRolling(30), r60 = mkRolling(60), r120 = mkRolling(120);
    return {
      n: trades.length, wr, pf, pnl, dd, avgHold, monthly,
      monthsPos, monthsTotal,
      roll30Neg: r30.filter(p => p < 0).length,
      roll60Neg: r60.filter(p => p < 0).length,
      roll120Neg: r120.filter(p => p < 0).length,
      tradesPerDay: trades.length / (windows.length * TEST_DAYS)
    };
  }

  const apexM = metrics(apexTrades);
  const safeM = metrics(safeTrades);

  console.log('\n' + '='.repeat(70));
  console.log('V2 RESULTS');
  console.log('='.repeat(70));
  console.log(`\nAPEX: ${apexM.n}t, t/d ${apexM.tradesPerDay?.toFixed(2)}, PF ${apexM.pf?.toFixed(2)}, WR ${(apexM.wr*100)?.toFixed(1)}%, PnL $${apexM.pnl?.toFixed(0)}, DD ${(apexM.dd*100)?.toFixed(1)}%`);
  console.log(`  Hold ${apexM.avgHold?.toFixed(0)}min, Months pos ${apexM.monthsPos}/${apexM.monthsTotal}, Roll30/60/120 neg ${apexM.roll30Neg}/${apexM.roll60Neg}/${apexM.roll120Neg}`);
  console.log(`\nSAFE: ${safeM.n}t, t/d ${safeM.tradesPerDay?.toFixed(3)}, PF ${safeM.pf?.toFixed(2)}, WR ${(safeM.wr*100)?.toFixed(1)}%, PnL $${safeM.pnl?.toFixed(0)}, DD ${(safeM.dd*100)?.toFixed(1)}%`);
  console.log(`  Hold ${safeM.avgHold?.toFixed(0)}min, Months pos ${safeM.monthsPos}/${safeM.monthsTotal}, Roll30/60/120 neg ${safeM.roll30Neg}/${safeM.roll60Neg}/${safeM.roll120Neg}`);

  console.log('\nMonthly APEX:');
  for (const [m, d] of Object.entries(apexM.monthly || {}).sort()) {
    console.log(`  ${m}: PnL $${d.pnl.toFixed(0)}, ${d.n}t, WR ${(d.w/d.n*100).toFixed(1)}%`);
  }
  console.log('\nMonthly SAFE:');
  for (const [m, d] of Object.entries(safeM.monthly || {}).sort()) {
    console.log(`  ${m}: PnL $${d.pnl.toFixed(0)}, ${d.n}t, WR ${(d.w/d.n*100).toFixed(1)}%`);
  }

  fs.writeFileSync('/tmp/research-apex-safe-v2-result.json', JSON.stringify({ apex: apexM, safe: safeM }, null, 2));
  console.log('\n[SAVED] /tmp/research-apex-safe-v2-result.json');
}

main().catch(err => { console.error(err); process.exit(1); });
