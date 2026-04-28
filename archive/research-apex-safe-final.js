#!/usr/bin/env node
'use strict';
/**
 * APEX + SAFE research final
 *
 * Data: /tmp/binance-klines-1m (9 months 1m bars, 32 pairs)
 *       /tmp/binance-metrics (5m metrics: OI, LSR, taker ratio)
 *
 * APEX: HMM regime + ensemble 3-label + meta-label + exposure caps
 * SAFE: Confluence 10-gate + P95 ensemble + MTF alignment
 *
 * Targets APEX: PF>=1.55, WR>=50%, all months positive, DD<=25%, t/d 3-8
 * Targets SAFE: PF 1.30-1.80, WR>=85%, 1-2 t/d, hold>=30min, all months pos
 */
const fs = require('fs');
const path = require('path');

const KLINES_DIR = '/tmp/binance-klines-1m';
const METRICS_DIR = '/tmp/binance-metrics';

// 15 pairs from v42 PRO+ filtered universe
const PAIRS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
  'ADAUSDT','AVAXUSDT','DOGEUSDT','LINKUSDT','LTCUSDT',
  'DOTUSDT','ATOMUSDT','TRXUSDT','NEARUSDT','INJUSDT'
];

const TF_MIN = 15;
const BARS_PER_DAY = 24 * 60 / TF_MIN;
const INIT_CAP = 10000;
const POS_SIZE = 1000;
const FEE_RT = 0.0004; // 4 bps round trip

// Clusters for correlation constraint
const CLUSTERS = {
  BTCUSDT:'BTC', ETHUSDT:'L1', BNBUSDT:'L1', SOLUSDT:'L1',
  AVAXUSDT:'L1', ATOMUSDT:'L1', DOTUSDT:'L1', NEARUSDT:'L1',
  XRPUSDT:'alt', ADAUSDT:'alt', LINKUSDT:'alt', LTCUSDT:'alt',
  DOGEUSDT:'meme', TRXUSDT:'alt', INJUSDT:'defi'
};

// Seeded PRNG
function mkPRNG(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const prng = mkPRNG(314159265);

// ==============================================================
// DATA LOADING
// ==============================================================
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
      // [openTs, O, H, L, C, V, closeTs, quoteV, count, takerBuyV, takerBuyQV]
      bars.push([+p[0], +p[1], +p[2], +p[3], +p[4], +p[5], +p[6], +p[7], +p[8], +p[9], +p[10]]);
    }
  }
  bars.sort((a, b) => a[0] - b[0]);
  return bars;
}

// Aggregate 1m → 15m with microstructure
function aggregate15m(bars1m) {
  const out = [];
  for (let i = 0; i + TF_MIN <= bars1m.length; i += TF_MIN) {
    const slice = bars1m.slice(i, i + TF_MIN);
    const o = slice[0][1];
    const c = slice[slice.length - 1][4];
    let h = -Infinity, l = Infinity;
    let v = 0, qv = 0, tbv = 0, tbqv = 0, cnt = 0;
    for (const b of slice) {
      if (b[2] > h) h = b[2];
      if (b[3] < l) l = b[3];
      v += b[5];
      qv += b[7];
      cnt += b[8];
      tbv += b[9];
      tbqv += b[10];
    }
    const takerBuyRatio = v > 0 ? tbv / v : 0.5;
    const avgTradeSize = cnt > 0 ? v / cnt : 0;
    // OFI proxy: signed taker delta aggregated
    let ofi = 0;
    for (const b of slice) {
      const takerSell = b[5] - b[9];
      ofi += (b[9] - takerSell);
    }
    out.push({
      ts: slice[0][0], o, h, l, c,
      v, qv, cnt, tbv, tbqv,
      takerBuyRatio,
      avgTradeSize,
      ofi,
      tbRatioDelta: takerBuyRatio - 0.5
    });
  }
  return out;
}

// Technical indicators
function ema(arr, period, key = 'c') {
  const alpha = 2 / (period + 1);
  const out = new Array(arr.length);
  let v = arr[0][key];
  for (let i = 0; i < arr.length; i++) {
    v = arr[i][key] * alpha + v * (1 - alpha);
    out[i] = v;
  }
  return out;
}

function rsi(arr, period = 14) {
  const out = new Array(arr.length).fill(50);
  let gain = 0, loss = 0;
  for (let i = 1; i <= period && i < arr.length; i++) {
    const d = arr[i].c - arr[i - 1].c;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period; i < arr.length; i++) {
    const d = arr[i].c - arr[i - 1].c;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    const rs = loss === 0 ? 100 : gain / loss;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function atr(arr, period = 14) {
  const out = new Array(arr.length).fill(0);
  let sum = 0;
  for (let i = 1; i <= period && i < arr.length; i++) {
    const tr = Math.max(arr[i].h - arr[i].l, Math.abs(arr[i].h - arr[i - 1].c), Math.abs(arr[i].l - arr[i - 1].c));
    sum += tr;
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
    const up = arr[i].h - arr[i - 1].h;
    const dn = arr[i - 1].l - arr[i].l;
    if (up > dn && up > 0) pDM += up;
    if (dn > up && dn > 0) nDM += dn;
    tr += Math.max(arr[i].h - arr[i].l, Math.abs(arr[i].h - arr[i - 1].c), Math.abs(arr[i].l - arr[i - 1].c));
  }
  for (let i = period + 1; i < arr.length; i++) {
    const up = arr[i].h - arr[i - 1].h;
    const dn = arr[i - 1].l - arr[i].l;
    const dmp = up > dn && up > 0 ? up : 0;
    const dmn = dn > up && dn > 0 ? dn : 0;
    const trN = Math.max(arr[i].h - arr[i].l, Math.abs(arr[i].h - arr[i - 1].c), Math.abs(arr[i].l - arr[i - 1].c));
    pDM = pDM - pDM / period + dmp;
    nDM = nDM - nDM / period + dmn;
    tr = tr - tr / period + trN;
    const pDI = 100 * pDM / tr;
    const nDI = 100 * nDM / tr;
    const dx = 100 * Math.abs(pDI - nDI) / (pDI + nDI + 1e-9);
    out[i] = i === period + 1 ? dx : (out[i - 1] * (period - 1) + dx) / period;
  }
  return out;
}

// MTF alignment score (required by SAFE)
function mtfAlignment(bars15m, idx) {
  if (idx < 96) return 0;
  // 15m trend
  const ema9_15 = bars15m.slice(Math.max(0, idx - 20), idx + 1).reduce((s, b) => s + b.c, 0) / Math.min(20, idx + 1);
  const ema21_15 = bars15m.slice(Math.max(0, idx - 40), idx + 1).reduce((s, b) => s + b.c, 0) / Math.min(40, idx + 1);
  const t15 = ema9_15 > ema21_15 ? 1 : -1;
  // 1h: aggregate 4 × 15m
  const bar1h = bars15m.slice(Math.max(0, idx - 4), idx + 1);
  const ema1h_fast = bar1h.slice(-10).reduce((s, b) => s + b.c, 0) / Math.min(10, bar1h.length);
  const ema1h_slow = bars15m.slice(Math.max(0, idx - 96), idx + 1).reduce((s, b) => s + b.c, 0) / Math.min(96, idx + 1);
  const t1h = ema1h_fast > ema1h_slow ? 1 : -1;
  // 4h: 16 × 15m
  const bar4h_start = Math.max(0, idx - 16);
  const bar4h_avg = bars15m.slice(bar4h_start, idx + 1).reduce((s, b) => s + b.c, 0) / (idx + 1 - bar4h_start);
  const bar4h_prev = bars15m.slice(Math.max(0, idx - 32), bar4h_start).reduce((s, b) => s + b.c, 0) / Math.max(1, bar4h_start - Math.max(0, idx - 32));
  const t4h = bar4h_avg > bar4h_prev ? 1 : -1;
  // 1d: 96 × 15m
  const bar1d_avg = bars15m.slice(Math.max(0, idx - 96), idx + 1).reduce((s, b) => s + b.c, 0) / (idx + 1 - Math.max(0, idx - 96));
  const bar1d_prev = bars15m.slice(Math.max(0, idx - 192), Math.max(0, idx - 96)).reduce((s, b) => s + b.c, 0) / Math.max(1, Math.max(0, idx - 96) - Math.max(0, idx - 192));
  const t1d = bar1d_avg > bar1d_prev ? 1 : -1;
  // Alignment: all same sign = 1.0, 3/4 = 0.75, etc.
  const sum = t15 + t1h + t4h + t1d;
  const absSum = Math.abs(sum);
  return absSum / 4; // 0, 0.5, or 1.0
}

// HMM 3-state regime on realized vol + ADX + returns
function detectRegime(bars15m, idx, period = 96) {
  if (idx < period) return 'chop';
  const slice = bars15m.slice(idx - period, idx + 1);
  // Realized vol 24h
  let sumRet2 = 0, n = 0;
  for (let i = 1; i < slice.length; i++) {
    const r = Math.log(slice[i].c / slice[i - 1].c);
    sumRet2 += r * r;
    n++;
  }
  const rv = Math.sqrt(sumRet2 / n) * Math.sqrt(96); // annualized 15m
  // Trend strength (24h return)
  const ret24 = (slice[slice.length - 1].c - slice[0].c) / slice[0].c;
  // ADX proxy
  const adxVals = adx(slice, 14);
  const adxNow = adxVals[adxVals.length - 1] || 20;
  // Decision rules (simplified HMM):
  // Bull trend: ret24>1% AND ADX>25
  // Bear trend: ret24<-1% AND ADX>25
  // Chop: otherwise
  if (ret24 > 0.015 && adxNow > 25 && rv < 0.05) return 'bull';
  if (ret24 < -0.015 && adxNow > 25) return 'bear';
  if (rv > 0.06) return 'chop'; // high vol = chop
  if (adxNow < 20) return 'chop';
  return Math.abs(ret24) > 0.008 ? (ret24 > 0 ? 'bull' : 'bear') : 'chop';
}

// ==============================================================
// BUILD FEATURES
// ==============================================================
function buildFeatures(bars15m) {
  const e9 = ema(bars15m, 9);
  const e21 = ema(bars15m, 21);
  const e55 = ema(bars15m, 55);
  const r14 = rsi(bars15m, 14);
  const a14 = atr(bars15m, 14);
  const adx14 = adx(bars15m, 14);
  const features = [];
  for (let i = 96; i < bars15m.length; i++) {
    const b = bars15m[i];
    const ret1 = (b.c - bars15m[i - 1].c) / bars15m[i - 1].c;
    const ret4 = (b.c - bars15m[i - 4].c) / bars15m[i - 4].c;
    const ret16 = (b.c - bars15m[i - 16].c) / bars15m[i - 16].c;
    // Rolling windows for vol
    let vol16 = 0;
    for (let j = i - 15; j <= i; j++) {
      const r = (bars15m[j].c - bars15m[j - 1].c) / bars15m[j - 1].c;
      vol16 += r * r;
    }
    vol16 = Math.sqrt(vol16 / 16);
    // Microstructure
    const tbrDelta = b.tbRatioDelta;
    const ofiNorm = b.ofi / (b.v + 1e-9);
    // Indicators
    const emaCross = (e9[i] - e21[i]) / e21[i];
    const emaSlow = (e21[i] - e55[i]) / e55[i];
    const rsiNorm = (r14[i] - 50) / 50;
    const atrPct = a14[i] / b.c;
    const adxN = adx14[i] / 100;
    // Regime
    const regime = detectRegime(bars15m, i);
    const regimeBull = regime === 'bull' ? 1 : 0;
    const regimeBear = regime === 'bear' ? 1 : 0;
    // MTF
    const mtf = mtfAlignment(bars15m, i);
    features.push({
      ts: b.ts, c: b.c, h: b.h, l: b.l,
      ret1, ret4, ret16, vol16,
      tbrDelta, ofiNorm,
      emaCross, emaSlow, rsiNorm, atrPct, adxN,
      regime, regimeBull, regimeBear, mtf
    });
  }
  return features;
}

// Triple-barrier labels (López de Prado)
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

// ==============================================================
// GBM-style simple ensemble (decision stumps + bagging)
// ==============================================================
class SimpleGBM {
  constructor(opts = {}) {
    this.lr = opts.lr || 0.05;
    this.nEst = opts.nEst || 100;
    this.maxDepth = opts.maxDepth || 3;
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
    const n = X.length;
    const nFeatures = X[0].length;
    let bestErr = Infinity, bestFeat = 0, bestThr = 0, bestLeft = 0, bestRight = 0;
    // Sample features for speed
    const featsToTry = Math.min(nFeatures, 8);
    const featIdxs = [];
    for (let k = 0; k < featsToTry; k++) featIdxs.push(Math.floor(prng() * nFeatures));
    for (const f of featIdxs) {
      const vals = X.map(x => x[f]).sort((a, b) => a - b);
      // Try a few thresholds
      const triesPerFeat = 10;
      for (let k = 0; k < triesPerFeat; k++) {
        const thr = vals[Math.floor(vals.length * (k + 0.5) / triesPerFeat)];
        let sumL = 0, cntL = 0, sumR = 0, cntR = 0;
        for (let i = 0; i < n; i++) {
          if (X[i][f] <= thr) { sumL += y[i]; cntL++; }
          else { sumR += y[i]; cntR++; }
        }
        if (cntL === 0 || cntR === 0) continue;
        const meanL = sumL / cntL;
        const meanR = sumR / cntR;
        let err = 0;
        for (let i = 0; i < n; i++) {
          const p = X[i][f] <= thr ? meanL : meanR;
          err += (y[i] - p) * (y[i] - p);
        }
        if (err < bestErr) {
          bestErr = err; bestFeat = f; bestThr = thr;
          bestLeft = meanL; bestRight = meanR;
        }
      }
    }
    return { isLeaf: false, feat: bestFeat, thr: bestThr, left: bestLeft, right: bestRight };
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

// ==============================================================
// MAIN
// ==============================================================
async function main() {
  console.log('[RESEARCH] Starting APEX + SAFE research');
  console.log('[RESEARCH] Loading data...');

  const data = {};
  for (const pair of PAIRS) {
    const b1m = load1m(pair);
    if (!b1m || b1m.length < 10000) {
      console.log(`[SKIP] ${pair} - insufficient data`);
      continue;
    }
    const b15m = aggregate15m(b1m);
    const feats = buildFeatures(b15m);
    const labels = tripleBarrierLabels(feats, 1.5, 60);
    data[pair] = { bars: b15m, features: feats, labels };
    console.log(`[LOAD] ${pair}: ${b15m.length} bars 15m, ${feats.length} features`);
  }

  const activePairs = Object.keys(data);
  console.log(`[RESEARCH] ${activePairs.length} pairs loaded`);

  if (activePairs.length < 5) {
    console.log('[FATAL] Not enough pairs with data');
    process.exit(1);
  }

  // Extract date range
  const sample = data[activePairs[0]].features;
  const tsStart = sample[0].ts;
  const tsEnd = sample[sample.length - 1].ts;
  const daysTotal = (tsEnd - tsStart) / (24 * 3600 * 1000);
  console.log(`[RESEARCH] Date range: ${new Date(tsStart).toISOString().slice(0,10)} → ${new Date(tsEnd).toISOString().slice(0,10)} (${daysTotal.toFixed(0)}d)`);

  // ========================================================
  // WALK-FORWARD: Train 120d / Test 30d / Step 30d
  // ========================================================
  const TRAIN_DAYS = 120;
  const TEST_DAYS = 30;
  const STEP_DAYS = 30;
  const windows = [];
  let trainStart = tsStart;
  while (true) {
    const trainEnd = trainStart + TRAIN_DAYS * 24 * 3600 * 1000;
    const testEnd = trainEnd + TEST_DAYS * 24 * 3600 * 1000;
    if (testEnd > tsEnd) break;
    windows.push({ trainStart, trainEnd, testStart: trainEnd, testEnd });
    trainStart += STEP_DAYS * 24 * 3600 * 1000;
  }
  console.log(`[RESEARCH] Walk-forward windows: ${windows.length}`);

  // Store all trades from all windows
  const apexTrades = [];
  const safeTrades = [];

  for (let w = 0; w < windows.length; w++) {
    const win = windows[w];
    console.log(`[WF ${w+1}/${windows.length}] Train ${new Date(win.trainStart).toISOString().slice(0,10)} → Test ${new Date(win.testEnd).toISOString().slice(0,10)}`);

    // Train per pair
    const models = {};
    const thresholds = {};
    for (const pair of activePairs) {
      const feats = data[pair].features;
      const labels = data[pair].labels;
      // Collect train samples
      const Xtrain = [], ytrain = [];
      for (let i = 0; i < feats.length; i++) {
        if (feats[i].ts < win.trainStart || feats[i].ts >= win.trainEnd) continue;
        const f = feats[i];
        Xtrain.push([f.ret1, f.ret4, f.ret16, f.vol16, f.tbrDelta, f.ofiNorm, f.emaCross, f.emaSlow, f.rsiNorm, f.atrPct, f.adxN, f.regimeBull, f.regimeBear, f.mtf]);
        ytrain.push(labels[i]);
      }
      if (Xtrain.length < 200) continue;
      const gbm = new SimpleGBM({ nEst: 60, lr: 0.08, maxDepth: 3 });
      gbm.fit(Xtrain, ytrain);
      models[pair] = gbm;
      // Compute validation threshold (P75 of |predict| on train)
      const preds = Xtrain.map(x => Math.abs(gbm.predict(x)));
      preds.sort((a, b) => a - b);
      thresholds[pair] = {
        p75: preds[Math.floor(preds.length * 0.75)],
        p90: preds[Math.floor(preds.length * 0.90)],
        p95: preds[Math.floor(preds.length * 0.95)]
      };
    }

    // ========================================================
    // SIMULATE TEST PERIOD — APEX (P75 threshold, regime caps)
    // ========================================================
    // Open position tracking per slot
    let apexCash = INIT_CAP;
    let safeCash = INIT_CAP;
    const apexOpen = [];
    const safeOpen = [];
    const apexMaxPos = 4, safeMaxPos = 1;

    // Iterate all bars in test period across all pairs (chronological)
    const bars = [];
    for (const pair of activePairs) {
      for (const f of data[pair].features) {
        if (f.ts < win.testStart || f.ts >= win.testEnd) continue;
        bars.push({ pair, ...f });
      }
    }
    bars.sort((a, b) => a.ts - b.ts);

    for (const b of bars) {
      // Check exits first for both engines
      for (const openList of [apexOpen, safeOpen]) {
        for (let i = openList.length - 1; i >= 0; i--) {
          const t = openList[i];
          if (t.pair !== b.pair) continue;
          // Check TP/SL
          const mv = t.side === 'LONG'
            ? (b.h >= t.tp ? { hit: 'tp', px: t.tp } : (b.l <= t.sl ? { hit: 'sl', px: t.sl } : null))
            : (b.l <= t.tp ? { hit: 'tp', px: t.tp } : (b.h >= t.sl ? { hit: 'sl', px: t.sl } : null));
          const barsHeld = Math.floor((b.ts - t.ts) / (15 * 60 * 1000));
          if (mv || barsHeld >= 60) {
            const exitPx = mv ? mv.px : b.c;
            const pnl = t.side === 'LONG'
              ? (exitPx - t.entry) / t.entry * POS_SIZE - POS_SIZE * FEE_RT
              : (t.entry - exitPx) / t.entry * POS_SIZE - POS_SIZE * FEE_RT;
            const tradeRec = {
              pair: t.pair, side: t.side, entry: t.entry, exit: exitPx,
              tsEntry: t.ts, tsExit: b.ts, barsHeld,
              pnl, win: pnl > 0, engine: t.engine
            };
            if (t.engine === 'APEX') { apexTrades.push(tradeRec); apexCash += pnl; }
            else { safeTrades.push(tradeRec); safeCash += pnl; }
            openList.splice(i, 1);
          }
        }
      }

      // Evaluate new signals
      const model = models[b.pair];
      if (!model) continue;
      const x = [b.ret1, b.ret4, b.ret16, b.vol16, b.tbrDelta, b.ofiNorm, b.emaCross, b.emaSlow, b.rsiNorm, b.atrPct, b.adxN, b.regimeBull, b.regimeBear, b.mtf];
      const score = model.predict(x);
      const absScore = Math.abs(score);
      const thr = thresholds[b.pair];
      if (!thr) continue;

      // ========== APEX ==========
      const apexRegimeCapBull = 4, apexRegimeCapChop = 3, apexRegimeCapBear = 1;
      const apexMaxByRegime = b.regime === 'bull' ? apexRegimeCapBull
                            : b.regime === 'chop' ? apexRegimeCapChop
                            : apexRegimeCapBear;
      if (apexOpen.length < Math.min(apexMaxPos, apexMaxByRegime)
          && absScore >= thr.p75
          && !apexOpen.find(t => t.pair === b.pair)) {
        // Cluster check: max 2 per cluster
        const cluster = CLUSTERS[b.pair];
        const sameCluster = apexOpen.filter(t => CLUSTERS[t.pair] === cluster).length;
        if (sameCluster < 2) {
          const side = score > 0 ? 'LONG' : 'SHORT';
          // Skip bear-long or bull-short (regime-align)
          if (!(b.regime === 'bear' && side === 'LONG') && !(b.regime === 'bull' && side === 'SHORT')) {
            const entry = b.c;
            const atrPx = b.atrPct * entry;
            const tp = side === 'LONG' ? entry + atrPx * 1.5 : entry - atrPx * 1.5;
            const sl = side === 'LONG' ? entry - atrPx * 1.0 : entry + atrPx * 1.0;
            apexOpen.push({ pair: b.pair, side, entry, tp, sl, ts: b.ts, engine: 'APEX' });
          }
        }
      }

      // ========== SAFE ==========
      // Gates: MTF >= 0.75, regime !bear, score >= P95, same dir as regime
      if (safeOpen.length < safeMaxPos
          && absScore >= thr.p95
          && b.mtf >= 0.75
          && b.regime !== 'bear'
          && !safeOpen.find(t => t.pair === b.pair)) {
        const side = score > 0 ? 'LONG' : 'SHORT';
        if ((b.regime === 'bull' && side === 'LONG') || (b.regime === 'chop')) {
          const entry = b.c;
          const atrPx = b.atrPct * entry;
          const tp = side === 'LONG' ? entry + atrPx * 2.5 : entry - atrPx * 2.5;
          const sl = side === 'LONG' ? entry - atrPx * 1.0 : entry + atrPx * 1.0;
          safeOpen.push({ pair: b.pair, side, entry, tp, sl, ts: b.ts, engine: 'SAFE' });
        }
      }
    }
  }

  // ==============================================================
  // METRICS
  // ==============================================================
  function metrics(trades, label) {
    if (trades.length === 0) return { label, n: 0 };
    const wins = trades.filter(t => t.win);
    const losses = trades.filter(t => !t.win);
    const sumWin = wins.reduce((s, t) => s + t.pnl, 0);
    const sumLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const pnl = sumWin - sumLoss;
    const wr = wins.length / trades.length;
    const pf = sumLoss > 0 ? sumWin / sumLoss : sumWin;
    // DD
    let peak = 0, dd = 0, cash = 0;
    for (const t of trades) {
      cash += t.pnl;
      if (cash > peak) peak = cash;
      const d = peak > 0 ? (peak - cash) / (INIT_CAP + peak) : 0;
      if (d > dd) dd = d;
    }
    // Monthly buckets
    const monthly = {};
    for (const t of trades) {
      const m = new Date(t.tsExit).toISOString().slice(0, 7);
      if (!monthly[m]) monthly[m] = { pnl: 0, n: 0, w: 0 };
      monthly[m].pnl += t.pnl;
      monthly[m].n++;
      if (t.win) monthly[m].w++;
    }
    const monthsPos = Object.values(monthly).filter(m => m.pnl > 0).length;
    const monthsTotal = Object.keys(monthly).length;
    // Avg hold
    const avgHold = trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length * 15;
    // Rolling windows
    const sortedTrades = [...trades].sort((a, b) => a.tsExit - b.tsExit);
    const rolling30 = [], rolling60 = [], rolling120 = [];
    for (let i = 0; i < sortedTrades.length; i++) {
      const endTs = sortedTrades[i].tsExit;
      for (const [days, arr] of [[30, rolling30], [60, rolling60], [120, rolling120]]) {
        const winStart = endTs - days * 24 * 3600 * 1000;
        const windowTrades = sortedTrades.filter(t => t.tsExit >= winStart && t.tsExit <= endTs);
        const pnlW = windowTrades.reduce((s, t) => s + t.pnl, 0);
        arr.push(pnlW);
      }
    }
    const roll30Neg = rolling30.filter(p => p < 0).length;
    const roll60Neg = rolling60.filter(p => p < 0).length;
    const roll120Neg = rolling120.filter(p => p < 0).length;

    return {
      label, n: trades.length, wr, pf, pnl, dd, avgHold,
      monthly, monthsPos, monthsTotal,
      roll30Neg, roll60Neg, roll120Neg,
      tradesPerDay: trades.length / (windows.length * TEST_DAYS)
    };
  }

  const apexM = metrics(apexTrades, 'APEX');
  const safeM = metrics(safeTrades, 'SAFE');

  console.log('\n' + '='.repeat(70));
  console.log('FINAL RESULTS');
  console.log('='.repeat(70));
  console.log(`\nAPEX (${windows.length * TEST_DAYS}d OOS):`);
  console.log(`  Trades: ${apexM.n}, t/d: ${apexM.tradesPerDay?.toFixed(2)}`);
  console.log(`  PF: ${apexM.pf?.toFixed(2)}, WR: ${(apexM.wr * 100)?.toFixed(1)}%`);
  console.log(`  PnL: $${apexM.pnl?.toFixed(0)}, DD: ${(apexM.dd * 100)?.toFixed(1)}%`);
  console.log(`  Months pos: ${apexM.monthsPos}/${apexM.monthsTotal}`);
  console.log(`  Roll30 neg: ${apexM.roll30Neg}, Roll60 neg: ${apexM.roll60Neg}, Roll120 neg: ${apexM.roll120Neg}`);
  console.log(`  Avg hold: ${apexM.avgHold?.toFixed(0)} min`);

  console.log(`\nSAFE (${windows.length * TEST_DAYS}d OOS):`);
  console.log(`  Trades: ${safeM.n}, t/d: ${safeM.tradesPerDay?.toFixed(3)}`);
  console.log(`  PF: ${safeM.pf?.toFixed(2)}, WR: ${(safeM.wr * 100)?.toFixed(1)}%`);
  console.log(`  PnL: $${safeM.pnl?.toFixed(0)}, DD: ${(safeM.dd * 100)?.toFixed(1)}%`);
  console.log(`  Months pos: ${safeM.monthsPos}/${safeM.monthsTotal}`);
  console.log(`  Roll30 neg: ${safeM.roll30Neg}, Roll60 neg: ${safeM.roll60Neg}, Roll120 neg: ${safeM.roll120Neg}`);
  console.log(`  Avg hold: ${safeM.avgHold?.toFixed(0)} min`);

  console.log('\nMonthly APEX:');
  for (const [m, d] of Object.entries(apexM.monthly || {}).sort()) {
    console.log(`  ${m}: PnL $${d.pnl.toFixed(0)}, ${d.n} trades, WR ${(d.w/d.n*100).toFixed(1)}%`);
  }
  console.log('\nMonthly SAFE:');
  for (const [m, d] of Object.entries(safeM.monthly || {}).sort()) {
    console.log(`  ${m}: PnL $${d.pnl.toFixed(0)}, ${d.n} trades, WR ${(d.w/d.n*100).toFixed(1)}%`);
  }

  // Gate checks
  console.log('\n' + '='.repeat(70));
  console.log('GATE CHECKS');
  console.log('='.repeat(70));

  const apexGates = {
    pf: (apexM.pf || 0) >= 1.55,
    wr: (apexM.wr || 0) >= 0.50,
    monthsAll: apexM.monthsPos === apexM.monthsTotal,
    roll30: apexM.roll30Neg === 0,
    roll60: apexM.roll60Neg === 0,
    roll120: apexM.roll120Neg === 0,
    dd: (apexM.dd || 1) <= 0.25
  };
  const safeGates = {
    pf: (safeM.pf || 0) >= 1.30 && (safeM.pf || 0) <= 1.80,
    wr: (safeM.wr || 0) >= 0.85,
    monthsAll: safeM.monthsPos === safeM.monthsTotal,
    hold: (safeM.avgHold || 0) >= 30,
    tradesPerDay: (safeM.tradesPerDay || 999) <= 2 && (safeM.tradesPerDay || 0) >= 0.1,
    dd: (safeM.dd || 1) <= 0.15
  };

  console.log('\nAPEX gates:');
  for (const [k, v] of Object.entries(apexGates)) console.log(`  ${v?'[PASS]':'[FAIL]'} ${k}`);
  console.log('\nSAFE gates:');
  for (const [k, v] of Object.entries(safeGates)) console.log(`  ${v?'[PASS]':'[FAIL]'} ${k}`);

  const apexAllPass = Object.values(apexGates).every(v => v);
  const safeAllPass = Object.values(safeGates).every(v => v);
  console.log(`\nAPEX: ${apexAllPass ? 'ALL TARGETS HIT' : 'GAPS — needs iteration'}`);
  console.log(`SAFE: ${safeAllPass ? 'ALL TARGETS HIT' : 'GAPS — needs iteration'}`);

  // Save results
  const output = {
    timestamp: new Date().toISOString(),
    apex: apexM,
    safe: safeM,
    apexGates,
    safeGates,
    apexAllPass,
    safeAllPass,
    windows: windows.length,
    daysOOS: windows.length * TEST_DAYS
  };
  // Only serializable fields
  fs.writeFileSync('/tmp/research-apex-safe-result.json', JSON.stringify(output, null, 2));
  console.log('\n[SAVED] /tmp/research-apex-safe-result.json');
}

main().catch(err => { console.error(err); process.exit(1); });
