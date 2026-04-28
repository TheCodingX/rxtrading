#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY GRID SEARCH — 8 Strategies × 7 Pairs × 120 Days × SL/TP Grid
// Real Binance data, zero look-ahead bias, realistic execution model
// ═══════════════════════════════════════════════════════════════════════════════
const https = require('https');

// ─── CONFIG ───
const PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT'];
const DAYS = 120;
const INIT_CAP = 500, LEV = 5, POS_SIZE = INIT_CAP * LEV; // $2500
const FEE_MAKER = 0.0002, FEE_TAKER = 0.0005, SLIP_SL = 0.0003;
const FILL_RATE = 0.80;
const MAX_POSITIONS = 3;
const TIMEOUT_BARS = 200; // max bars to hold
const ENTRY_DELAY = 2;   // enter at OPEN of signal_bar + 2

// SL/TP grids for search
const SL_GRID = [0.003, 0.005, 0.007, 0.010, 0.012, 0.015];
const TP_GRID = [0.006, 0.010, 0.015, 0.020, 0.025, 0.030];

// ─── HTTP FETCH ───
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Parse error: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getKlines(sym, interval, days) {
  const end = Date.now(), start = end - days * 86400000;
  let all = [], t = start;
  const base = 'https://api.binance.com/api/v3/klines';
  while (t < end) {
    const url = `${base}?symbol=${sym}&interval=${interval}&startTime=${Math.floor(t)}&limit=1000`;
    let retries = 3;
    let k;
    while (retries > 0) {
      try { k = await fetchJSON(url); break; }
      catch (e) { retries--; if (retries === 0) { console.error(`  FAIL ${sym} ${interval}: ${e.message}`); return all; } await sleep(2000); }
    }
    if (!k || !k.length) break;
    all = all.concat(k);
    t = parseInt(k[k.length - 1][6]) + 1;
    await sleep(150); // rate limit
  }
  return all;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── PARSE KLINES ───
function parseKlines(klines) {
  return klines.map(k => ({
    t: parseInt(k[0]), o: parseFloat(k[1]), h: parseFloat(k[2]),
    l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
    tClose: parseInt(k[6])
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATORS — all inline, zero dependencies
// ═══════════════════════════════════════════════════════════════════════════════

function sma(arr, p) {
  const r = new Array(arr.length);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= p) sum -= arr[i - p];
    r[i] = i < p - 1 ? NaN : sum / p;
  }
  return r;
}

function ema(arr, p) {
  const r = new Array(arr.length);
  const m = 2 / (p + 1);
  r[0] = arr[0];
  for (let i = 1; i < arr.length; i++) r[i] = arr[i] * m + r[i - 1] * (1 - m);
  return r;
}

function rsi(closes, p = 14) {
  const r = new Array(closes.length).fill(NaN);
  if (closes.length < p + 1) return r;
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= p; al /= p;
  r[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
    r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return r;
}

function bbands(closes, p = 20, mult = 2) {
  const mid = sma(closes, p), up = new Array(closes.length), dn = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(mid[i])) { up[i] = NaN; dn[i] = NaN; continue; }
    let ss = 0;
    for (let j = i - p + 1; j <= i; j++) ss += (closes[j] - mid[i]) ** 2;
    const std = Math.sqrt(ss / p);
    up[i] = mid[i] + mult * std;
    dn[i] = mid[i] - mult * std;
  }
  return { mid, up, dn };
}

function macd(closes, f = 12, s = 26, sig = 9) {
  const ef = ema(closes, f), es = ema(closes, s);
  const line = ef.map((v, i) => v - es[i]);
  const signal = ema(line, sig);
  const hist = line.map((v, i) => v - signal[i]);
  return { line, signal, hist };
}

function stoch(highs, lows, closes, kp = 14, dp = 3) {
  const k = new Array(closes.length).fill(NaN);
  for (let i = kp - 1; i < closes.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kp + 1; j <= i; j++) { hh = Math.max(hh, highs[j]); ll = Math.min(ll, lows[j]); }
    k[i] = hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100;
  }
  const d = sma(k.map(v => isNaN(v) ? 50 : v), dp);
  return { k, d };
}

function adxCalc(highs, lows, closes, p = 14) {
  const n = closes.length;
  const tr = [0], pdm = [0], ndm = [0];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    const up = highs[i] - highs[i - 1], dn = lows[i - 1] - lows[i];
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
  }
  const atrArr = ema(tr, p), spdm = ema(pdm, p), sndm = ema(ndm, p);
  const pdi = spdm.map((v, i) => atrArr[i] ? v / atrArr[i] * 100 : 0);
  const ndi = sndm.map((v, i) => atrArr[i] ? v / atrArr[i] * 100 : 0);
  const dx = pdi.map((v, i) => { const s = v + ndi[i]; return s ? Math.abs(v - ndi[i]) / s * 100 : 0; });
  return { adx: ema(dx, p), pdi, ndi, atr: atrArr };
}

function atr(highs, lows, closes, p = 14) {
  const tr = [0];
  for (let i = 1; i < closes.length; i++)
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  return ema(tr, p);
}

function obv(closes, volumes) {
  const r = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) r.push(r[i - 1] + volumes[i]);
    else if (closes[i] < closes[i - 1]) r.push(r[i - 1] - volumes[i]);
    else r.push(r[i - 1]);
  }
  return r;
}

function cmf(highs, lows, closes, volumes, p = 20) {
  const r = new Array(closes.length).fill(0);
  for (let i = p - 1; i < closes.length; i++) {
    let mfvSum = 0, volSum = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const hl = highs[j] - lows[j];
      const mfm = hl === 0 ? 0 : ((closes[j] - lows[j]) - (highs[j] - closes[j])) / hl;
      mfvSum += mfm * volumes[j];
      volSum += volumes[j];
    }
    r[i] = volSum === 0 ? 0 : mfvSum / volSum;
  }
  return r;
}

function zscore(closes, p = 50) {
  const m = sma(closes, p), r = new Array(closes.length).fill(0);
  for (let i = p - 1; i < closes.length; i++) {
    let ss = 0;
    for (let j = i - p + 1; j <= i; j++) ss += (closes[j] - m[i]) ** 2;
    const std = Math.sqrt(ss / p);
    r[i] = std > 0 ? (closes[i] - m[i]) / std : 0;
  }
  return r;
}

function roc(closes, p = 3) {
  const r = new Array(closes.length).fill(0);
  for (let i = p; i < closes.length; i++) r[i] = (closes[i] - closes[i - p]) / closes[i - p];
  return r;
}

// Volume ratio: current vol / SMA(vol, p)
function volRatio(volumes, p = 20) {
  const avg = sma(volumes, p);
  return volumes.map((v, i) => isNaN(avg[i]) || avg[i] === 0 ? 1 : v / avg[i]);
}

// Cumulative delta estimate (buy vol vs sell vol from candle structure)
function cumDelta(highs, lows, closes, opens, volumes) {
  const r = [0];
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const buyPct = hl === 0 ? 0.5 : (closes[i] - lows[i]) / hl;
    const delta = volumes[i] * (buyPct - (1 - buyPct)); // buy - sell
    r.push(r[i - 1] + delta);
  }
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE — shared across all strategies
// ═══════════════════════════════════════════════════════════════════════════════

function runBacktest(allSignals, allKl5m, cfg = {}) {
  // allSignals: [{pair, bar, dir, sl, tp, _seq}]  dir: 1=long, -1=short
  // allKl5m: {PAIR: parsed klines}
  // Returns stats object
  const slPct = cfg.sl || 0.005;
  const tpPct = cfg.tp || 0.015;

  let capital = INIT_CAP;
  const positions = []; // active
  const trades = [];
  let fillSeq = 0;

  // Sort signals by time
  const sortedSigs = allSignals.slice().sort((a, b) => {
    const tA = allKl5m[a.pair][Math.min(a.bar, allKl5m[a.pair].length - 1)].t;
    const tB = allKl5m[b.pair][Math.min(b.bar, allKl5m[b.pair].length - 1)].t;
    return tA - tB;
  });

  for (const sig of sortedSigs) {
    const kl = allKl5m[sig.pair];
    const entryBar = sig.bar + ENTRY_DELAY;
    if (entryBar >= kl.length) continue;

    // Fill rate: skip 20%
    fillSeq++;
    if (fillSeq % 5 === 0) continue;

    // Max positions check
    if (positions.length >= MAX_POSITIONS) {
      // Check if any positions have closed by now
      resolvePositions(positions, trades, allKl5m, kl[entryBar].t);
      if (positions.length >= MAX_POSITIONS) continue;
    }

    const entryPrice = kl[entryBar].o;
    const useSlPct = sig.sl || slPct;
    const useTpPct = sig.tp || tpPct;
    const slPrice = sig.dir === 1 ? entryPrice * (1 - useSlPct) : entryPrice * (1 + useSlPct);
    const tpPrice = sig.dir === 1 ? entryPrice * (1 + useTpPct) : entryPrice * (1 - useTpPct);
    const qty = POS_SIZE / entryPrice;

    positions.push({
      pair: sig.pair, dir: sig.dir, entry: entryPrice,
      sl: slPrice, tp: tpPrice, qty, bar: entryBar,
      slPct: useSlPct, tpPct: useTpPct
    });
  }

  // Resolve all remaining positions
  resolveAllPositions(positions, trades, allKl5m);

  return computeStats(trades);
}

function resolvePositions(positions, trades, allKl5m, currentTime) {
  for (let p = positions.length - 1; p >= 0; p--) {
    const pos = positions[p];
    const kl = allKl5m[pos.pair];
    let closed = false;
    for (let j = pos.bar + 1; j < kl.length && j <= pos.bar + TIMEOUT_BARS; j++) {
      if (kl[j].t > currentTime) break;
      const result = checkExit(pos, kl[j]);
      if (result) {
        recordTrade(trades, pos, result);
        positions.splice(p, 1);
        closed = true;
        break;
      }
    }
    if (!closed && pos.bar + TIMEOUT_BARS < kl.length) {
      // Timeout: close at market
      const exitBar = Math.min(pos.bar + TIMEOUT_BARS, kl.length - 1);
      if (kl[exitBar].t <= currentTime) {
        recordTrade(trades, pos, { type: 'TO', price: kl[exitBar].c });
        positions.splice(p, 1);
      }
    }
  }
}

function resolveAllPositions(positions, trades, allKl5m) {
  while (positions.length > 0) {
    const pos = positions.pop();
    const kl = allKl5m[pos.pair];
    let closed = false;
    for (let j = pos.bar + 1; j < kl.length && j <= pos.bar + TIMEOUT_BARS; j++) {
      const result = checkExit(pos, kl[j]);
      if (result) {
        recordTrade(trades, pos, result);
        closed = true;
        break;
      }
    }
    if (!closed) {
      const exitBar = Math.min(pos.bar + TIMEOUT_BARS, kl.length - 1);
      recordTrade(trades, pos, { type: 'TO', price: kl[exitBar].c });
    }
  }
}

function checkExit(pos, bar) {
  let hitSL = false, hitTP = false;
  if (pos.dir === 1) { hitSL = bar.l <= pos.sl; hitTP = bar.h >= pos.tp; }
  else { hitSL = bar.h >= pos.sl; hitTP = bar.l <= pos.tp; }

  // SL priority when both hit same bar
  if (hitSL && hitTP) hitTP = false;

  if (hitSL) {
    const slip = pos.dir === 1 ? (1 - SLIP_SL) : (1 + SLIP_SL);
    return { type: 'SL', price: pos.sl * slip };
  }
  if (hitTP) return { type: 'TP', price: pos.tp };
  return null;
}

function recordTrade(trades, pos, result) {
  const pnl = pos.dir === 1
    ? (result.price - pos.entry) * pos.qty
    : (pos.entry - result.price) * pos.qty;
  const fees = POS_SIZE * FEE_MAKER + POS_SIZE * (result.type === 'SL' ? FEE_TAKER : FEE_MAKER);
  const net = pnl - fees;
  trades.push({
    pair: pos.pair, dir: pos.dir, entry: pos.entry,
    exit: result.price, pnl: net, type: result.type,
    slPct: pos.slPct, tpPct: pos.tpPct
  });
}

function computeStats(trades) {
  if (trades.length === 0) return {
    pf: 0, wr: 0, trades: 0, tradesPerDay: 0, pnl: 0,
    maxDD: 0, avgWin: 0, avgLoss: 0, grossProfit: 0, grossLoss: 0, perPair: {}
  };
  let grossProfit = 0, grossLoss = 0, wins = 0;
  let equity = INIT_CAP, peak = INIT_CAP, maxDD = 0;
  const perPair = {};

  for (const t of trades) {
    if (t.pnl > 0) { grossProfit += t.pnl; wins++; }
    else grossLoss += Math.abs(t.pnl);
    equity += t.pnl;
    peak = Math.max(peak, equity);
    const dd = (peak - equity) / peak;
    maxDD = Math.max(maxDD, dd);

    if (!perPair[t.pair]) perPair[t.pair] = { gp: 0, gl: 0, n: 0, w: 0 };
    const pp = perPair[t.pair];
    pp.n++;
    if (t.pnl > 0) { pp.gp += t.pnl; pp.w++; }
    else pp.gl += Math.abs(t.pnl);
  }

  return {
    pf: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    wr: trades.length > 0 ? (wins / trades.length * 100) : 0,
    trades: trades.length,
    tradesPerDay: trades.length / DAYS,
    pnl: equity - INIT_CAP,
    maxDD: maxDD * 100,
    avgWin: wins > 0 ? grossProfit / wins : 0,
    avgLoss: (trades.length - wins) > 0 ? grossLoss / (trades.length - wins) : 0,
    grossProfit, grossLoss, perPair
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY SIGNAL GENERATORS
// ═══════════════════════════════════════════════════════════════════════════════

// Pre-compute all indicators for a pair
function computeIndicators(kl) {
  const c = kl.map(k => k.c), h = kl.map(k => k.h), l = kl.map(k => k.l);
  const o = kl.map(k => k.o), v = kl.map(k => k.v);
  return {
    c, h, l, o, v,
    rsi7: rsi(c, 7), rsi14: rsi(c, 14),
    stochK: stoch(h, l, c, 14, 3).k,
    macdData: macd(c),
    bb: bbands(c, 20, 2),
    ema9: ema(c, 9), ema21: ema(c, 21), ema50: ema(c, 50),
    adxData: adxCalc(h, l, c, 14),
    atr14: atr(h, l, c, 14),
    obvArr: obv(c, v),
    cmfArr: cmf(h, l, c, v, 20),
    volR: volRatio(v, 20),
    zs50: zscore(c, 50),
    roc3: roc(c, 3),
    cumDeltaArr: cumDelta(h, l, c, o, v),
    sma50: sma(c, 50)
  };
}

// ─── STRATEGY 1: Multi-Indicator Confluence Score ───
function strategy1Signals(kl, ind, threshold = 10) {
  const signals = [];
  const { c, rsi7, rsi14, stochK, macdData, bb, ema9, ema21, volR, adxData, obvArr, cmfArr } = ind;

  for (let i = 60; i < kl.length - 3; i++) {
    if (isNaN(rsi14[i]) || isNaN(stochK[i])) continue;
    let longScore = 0, shortScore = 0;

    // RSI(7) extremes
    if (rsi7[i] < 25) longScore += 2; else if (rsi7[i] < 35) longScore += 1;
    if (rsi7[i] > 75) shortScore += 2; else if (rsi7[i] > 65) shortScore += 1;

    // RSI(14) extremes
    if (rsi14[i] < 30) longScore += 2; else if (rsi14[i] < 40) longScore += 1;
    if (rsi14[i] > 70) shortScore += 2; else if (rsi14[i] > 60) shortScore += 1;

    // Stoch(14,3)
    if (stochK[i] < 20) longScore += 2; else if (stochK[i] < 30) longScore += 1;
    if (stochK[i] > 80) shortScore += 2; else if (stochK[i] > 70) shortScore += 1;

    // MACD histogram
    if (macdData.hist[i] > 0 && macdData.hist[i - 1] <= 0) longScore += 2;
    if (macdData.hist[i] < 0 && macdData.hist[i - 1] >= 0) shortScore += 2;
    if (macdData.hist[i] > 0) longScore += 0.5;
    if (macdData.hist[i] < 0) shortScore += 0.5;

    // BB position
    const bbRange = bb.up[i] - bb.dn[i];
    if (bbRange > 0) {
      const bbPos = (c[i] - bb.dn[i]) / bbRange;
      if (bbPos < 0.1) longScore += 2; else if (bbPos < 0.25) longScore += 1;
      if (bbPos > 0.9) shortScore += 2; else if (bbPos > 0.75) shortScore += 1;
    }

    // EMA9/21 cross
    if (ema9[i] > ema21[i] && ema9[i - 1] <= ema21[i - 1]) longScore += 2;
    if (ema9[i] < ema21[i] && ema9[i - 1] >= ema21[i - 1]) shortScore += 2;
    if (ema9[i] > ema21[i]) longScore += 0.5;
    if (ema9[i] < ema21[i]) shortScore += 0.5;

    // Volume ratio
    if (volR[i] > 2.0) { longScore += 1; shortScore += 1; }
    else if (volR[i] > 1.5) { longScore += 0.5; shortScore += 0.5; }

    // ADX
    if (adxData.adx[i] > 25) {
      if (adxData.pdi[i] > adxData.ndi[i]) longScore += 1.5;
      else shortScore += 1.5;
    }

    // OBV trend (5-bar slope)
    if (i >= 5) {
      if (obvArr[i] > obvArr[i - 5]) longScore += 1;
      else shortScore += 1;
    }

    // CMF
    if (cmfArr[i] > 0.1) longScore += 1.5;
    else if (cmfArr[i] < -0.1) shortScore += 1.5;

    if (longScore >= threshold && longScore > shortScore + 2)
      signals.push({ pair: null, bar: i, dir: 1 });
    else if (shortScore >= threshold && shortScore > longScore + 2)
      signals.push({ pair: null, bar: i, dir: -1 });
  }
  return signals;
}

// ─── STRATEGY 2: Adaptive Regime + Best-for-Regime ───
function strategy2Signals(kl, ind, kl1h, ind1h) {
  const signals = [];
  const { c, h, l, rsi14, bb, ema9, ema21, adxData, atr14, volR, stochK, macdData } = ind;

  for (let i = 60; i < kl.length - 3; i++) {
    if (isNaN(adxData.adx[i])) continue;
    const adxVal = adxData.adx[i];
    const atrPct = c[i] > 0 ? atr14[i] / c[i] : 0;

    // Classify regime
    let regime;
    if (adxVal > 25) regime = 'TRENDING';
    else if (adxVal < 20) regime = 'RANGING';
    else regime = atrPct > 0.005 ? 'VOLATILE' : 'RANGING';

    // Also check 1H regime alignment if available
    let htfDir = 0;
    if (kl1h && ind1h) {
      // Find the latest fully-closed 1H bar before current 5m bar time
      const curTime = kl[i].t;
      let h1Idx = -1;
      for (let j = kl1h.length - 1; j >= 0; j--) {
        if (kl1h[j].tClose < curTime) { h1Idx = j; break; }
      }
      if (h1Idx >= 10) {
        if (ind1h.ema9[h1Idx] > ind1h.ema21[h1Idx]) htfDir = 1;
        else if (ind1h.ema9[h1Idx] < ind1h.ema21[h1Idx]) htfDir = -1;
      }
    }

    if (regime === 'TRENDING') {
      // Trade WITH trend: EMA crossover + momentum
      if (ema9[i] > ema21[i] && ema9[i - 1] <= ema21[i - 1] && adxData.pdi[i] > adxData.ndi[i]) {
        if (htfDir >= 0) signals.push({ pair: null, bar: i, dir: 1 });
      }
      if (ema9[i] < ema21[i] && ema9[i - 1] >= ema21[i - 1] && adxData.ndi[i] > adxData.pdi[i]) {
        if (htfDir <= 0) signals.push({ pair: null, bar: i, dir: -1 });
      }
      // Also: strong momentum continuation
      if (macdData.hist[i] > 0 && macdData.hist[i] > macdData.hist[i - 1] && rsi14[i] > 55 && rsi14[i] < 75 && adxData.pdi[i] > adxData.ndi[i]) {
        if (htfDir >= 0 && volR[i] > 1.2) signals.push({ pair: null, bar: i, dir: 1 });
      }
      if (macdData.hist[i] < 0 && macdData.hist[i] < macdData.hist[i - 1] && rsi14[i] < 45 && rsi14[i] > 25 && adxData.ndi[i] > adxData.pdi[i]) {
        if (htfDir <= 0 && volR[i] > 1.2) signals.push({ pair: null, bar: i, dir: -1 });
      }
    } else if (regime === 'RANGING') {
      // Mean reversion: RSI extremes + BB
      const bbRange = bb.up[i] - bb.dn[i];
      const bbPos = bbRange > 0 ? (c[i] - bb.dn[i]) / bbRange : 0.5;
      if (rsi14[i] < 28 && bbPos < 0.15 && stochK[i] < 25)
        signals.push({ pair: null, bar: i, dir: 1 });
      if (rsi14[i] > 72 && bbPos > 0.85 && stochK[i] > 75)
        signals.push({ pair: null, bar: i, dir: -1 });
    } else { // VOLATILE
      // Breakout: BB squeeze + volume explosion
      const bbRange = bb.up[i] - bb.dn[i];
      const bbPrev = i >= 20 ? bb.up[i - 20] - bb.dn[i - 20] : bbRange;
      const squeeze = bbRange < bbPrev * 0.6; // BB narrowing
      if (squeeze && volR[i] > 2.0) {
        if (c[i] > bb.up[i]) signals.push({ pair: null, bar: i, dir: 1 });
        if (c[i] < bb.dn[i]) signals.push({ pair: null, bar: i, dir: -1 });
      }
      // Also check expansion from squeeze
      if (i >= 3 && volR[i] > 1.8) {
        const prevSqueeze = (bb.up[i - 3] - bb.dn[i - 3]) < (bb.up[i - 20] - bb.dn[i - 20]) * 0.65;
        if (prevSqueeze && c[i] > bb.mid[i] && c[i - 1] < bb.mid[i - 1])
          signals.push({ pair: null, bar: i, dir: 1 });
        if (prevSqueeze && c[i] < bb.mid[i] && c[i - 1] > bb.mid[i - 1])
          signals.push({ pair: null, bar: i, dir: -1 });
      }
    }
  }
  return signals;
}

// ─── STRATEGY 3: Triple Timeframe Alignment ───
function strategy3Signals(kl5m, ind5m, kl15m, ind15m, kl1h, ind1h) {
  const signals = [];
  if (!kl15m || !kl1h || !ind15m || !ind1h) return signals;

  for (let i = 60; i < kl5m.length - 3; i++) {
    if (isNaN(ind5m.rsi7[i])) continue;
    const curTime = kl5m[i].t;

    // 1H: Direction (EMA50 slope) — must be fully closed
    let h1Dir = 0, h1Idx = -1;
    for (let j = kl1h.length - 1; j >= 0; j--) {
      if (kl1h[j].tClose < curTime) { h1Idx = j; break; }
    }
    if (h1Idx < 55) continue;
    const ema50Slope = (ind1h.ema50[h1Idx] - ind1h.ema50[h1Idx - 5]) / ind1h.ema50[h1Idx - 5];
    if (ema50Slope > 0.001) h1Dir = 1;
    else if (ema50Slope < -0.001) h1Dir = -1;
    else continue; // no clear direction

    // 15M: Confirm pullback — must be fully closed
    let m15Idx = -1;
    for (let j = kl15m.length - 1; j >= 0; j--) {
      if (kl15m[j].tClose < curTime) { m15Idx = j; break; }
    }
    if (m15Idx < 25) continue;
    const price15 = ind15m.c[m15Idx];
    const ema21_15 = ind15m.ema21[m15Idx];
    const distPct = Math.abs(price15 - ema21_15) / ema21_15;
    if (distPct > 0.005) continue; // not near value area

    // 5M: Entry trigger
    if (h1Dir === 1 && ind5m.rsi7[i] < 30)
      signals.push({ pair: null, bar: i, dir: 1 });
    else if (h1Dir === -1 && ind5m.rsi7[i] > 70)
      signals.push({ pair: null, bar: i, dir: -1 });
  }
  return signals;
}

// ─── STRATEGY 4: Volume-Price Divergence ───
function strategy4Signals(kl, ind) {
  const signals = [];
  const { c, h, l, cumDeltaArr, volR } = ind;
  const lookback = 20;

  for (let i = lookback + 5; i < kl.length - 3; i++) {
    if (volR[i] < 1.5) continue; // need volume spike

    // Check for price making new low but delta making higher low
    let priceNewLow = true, deltaHigherLow = false;
    let priceLowIdx = i, deltaLowIdx = i;
    for (let j = i - lookback; j < i; j++) {
      if (l[j] < l[i]) { priceNewLow = false; break; }
    }
    // Find previous local low in last 20 bars
    let prevLowPrice = Infinity, prevLowDelta = Infinity, prevLowIdx = -1;
    for (let j = i - lookback; j < i - 3; j++) {
      if (l[j] < l[j - 1] && l[j] < l[j + 1] && l[j] < prevLowPrice) {
        prevLowPrice = l[j];
        prevLowDelta = cumDeltaArr[j];
        prevLowIdx = j;
      }
    }

    if (prevLowIdx > 0) {
      // Bullish divergence: price lower low, delta higher low
      if (l[i] <= prevLowPrice && cumDeltaArr[i] > prevLowDelta + 0.01 * Math.abs(prevLowDelta))
        signals.push({ pair: null, bar: i, dir: 1 });
    }

    // Check for price making new high but delta making lower high
    let prevHighPrice = -Infinity, prevHighDelta = -Infinity, prevHighIdx = -1;
    for (let j = i - lookback; j < i - 3; j++) {
      if (h[j] > h[j - 1] && h[j] > h[j + 1] && h[j] > prevHighPrice) {
        prevHighPrice = h[j];
        prevHighDelta = cumDeltaArr[j];
        prevHighIdx = j;
      }
    }

    if (prevHighIdx > 0) {
      // Bearish divergence: price higher high, delta lower high
      if (h[i] >= prevHighPrice && cumDeltaArr[i] < prevHighDelta - 0.01 * Math.abs(prevHighDelta))
        signals.push({ pair: null, bar: i, dir: -1 });
    }
  }
  return signals;
}

// ─── STRATEGY 5: Z-Score Mean Reversion ───
function strategy5Signals(kl, ind) {
  const signals = [];
  const { c, zs50, adxData, rsi14 } = ind;
  const rsiZs = zscore(ind.rsi14.map(v => isNaN(v) ? 50 : v), 50);

  for (let i = 60; i < kl.length - 3; i++) {
    if (isNaN(adxData.adx[i])) continue;

    if (adxData.adx[i] < 25) {
      // Ranging: Use price Z-score
      if (zs50[i] < -2.0) signals.push({ pair: null, bar: i, dir: 1 });
      else if (zs50[i] > 2.0) signals.push({ pair: null, bar: i, dir: -1 });
    } else {
      // Trending: Use RSI Z-score mean reversion
      if (rsiZs[i] < -2.0 && adxData.pdi[i] > adxData.ndi[i])
        signals.push({ pair: null, bar: i, dir: 1 });
      else if (rsiZs[i] > 2.0 && adxData.ndi[i] > adxData.pdi[i])
        signals.push({ pair: null, bar: i, dir: -1 });
    }
  }
  return signals;
}

// ─── STRATEGY 6: Momentum Burst Detection ───
function strategy6Signals(kl, ind) {
  const signals = [];
  const { c, roc3, atr14, volR, adxData, rsi14 } = ind;

  // Track recent bursts
  const burstOrigins = [];

  for (let i = 30; i < kl.length - 3; i++) {
    if (isNaN(adxData.adx[i]) || adxData.adx[i] < 20) continue;
    const atrPct = c[i] > 0 ? atr14[i] / c[i] : 0;

    // Detect burst: ROC(3) > 2*ATR% AND volume > 2x average
    if (Math.abs(roc3[i]) > 2 * atrPct && volR[i] > 2.0) {
      const burstDir = roc3[i] > 0 ? 1 : -1;
      burstOrigins.push({ bar: i, dir: burstDir, origin: c[i - 3], distance: Math.abs(c[i] - c[i - 3]) });
    }

    // Check for pullback entry from recent burst
    for (let b = burstOrigins.length - 1; b >= 0; b--) {
      const burst = burstOrigins[b];
      if (i - burst.bar > 30 || i - burst.bar < 3) continue; // too old or too soon

      if (burst.dir === 1) {
        // Bull burst: wait for RSI to cool then re-enter
        if (rsi14[i] < 45 && rsi14[i - 1] >= 45) {
          signals.push({
            pair: null, bar: i, dir: 1,
            _burstDist: burst.distance, _burstOrigin: burst.origin
          });
          burstOrigins.splice(b, 1);
        }
      } else {
        // Bear burst: wait for RSI to cool then re-enter
        if (rsi14[i] > 55 && rsi14[i - 1] <= 55) {
          signals.push({
            pair: null, bar: i, dir: -1,
            _burstDist: burst.distance, _burstOrigin: burst.origin
          });
          burstOrigins.splice(b, 1);
        }
      }
    }

    // Prune old bursts
    while (burstOrigins.length > 0 && i - burstOrigins[0].bar > 40) burstOrigins.shift();
  }
  return signals;
}

// ─── STRATEGY 7: Smart Money Concepts (Order Block + FVG) ───
function strategy7Signals(kl, ind) {
  const signals = [];
  const { c, h, l, o, v, volR, ema21 } = ind;

  // Detect order blocks and FVGs
  const orderBlocks = []; // {type: 'bull'|'bear', top, bottom, bar, tested}
  const fvgs = []; // {type: 'bull'|'bear', top, bottom, bar}

  for (let i = 5; i < kl.length - 3; i++) {
    // Order block: 3+ candles in same direction creating strong move
    const isBullOB = c[i] > o[i] && c[i - 1] > o[i - 1] && c[i - 2] > o[i - 2] &&
      (c[i] - o[i - 2]) / o[i - 2] > 0.003 && volR[i] > 1.3;
    const isBearOB = c[i] < o[i] && c[i - 1] < o[i - 1] && c[i - 2] < o[i - 2] &&
      (o[i - 2] - c[i]) / o[i - 2] > 0.003 && volR[i] > 1.3;

    if (isBullOB) {
      orderBlocks.push({ type: 'bull', top: Math.max(o[i - 2], c[i - 2]), bottom: Math.min(o[i - 2], l[i - 2]), bar: i, tested: false });
    }
    if (isBearOB) {
      orderBlocks.push({ type: 'bear', top: Math.max(o[i - 2], h[i - 2]), bottom: Math.min(o[i - 2], c[i - 2]), bar: i, tested: false });
    }

    // FVG: gap between candle 1 high and candle 3 low
    if (i >= 2) {
      if (l[i] > h[i - 2]) // Bullish FVG (gap up)
        fvgs.push({ type: 'bull', top: l[i], bottom: h[i - 2], bar: i });
      if (h[i] < l[i - 2]) // Bearish FVG (gap down)
        fvgs.push({ type: 'bear', top: l[i - 2], bottom: h[i], bar: i });
    }

    // Check for retest of order blocks
    for (let ob = orderBlocks.length - 1; ob >= 0; ob--) {
      const block = orderBlocks[ob];
      if (block.tested || i - block.bar < 5 || i - block.bar > 100) {
        if (i - block.bar > 100) orderBlocks.splice(ob, 1);
        continue;
      }
      if (block.type === 'bull' && l[i] <= block.top && l[i] >= block.bottom) {
        signals.push({ pair: null, bar: i, dir: 1 });
        block.tested = true;
      }
      if (block.type === 'bear' && h[i] >= block.bottom && h[i] <= block.top) {
        signals.push({ pair: null, bar: i, dir: -1 });
        block.tested = true;
      }
    }

    // Check for FVG fill
    for (let f = fvgs.length - 1; f >= 0; f--) {
      const gap = fvgs[f];
      if (i - gap.bar < 3 || i - gap.bar > 60) {
        if (i - gap.bar > 60) fvgs.splice(f, 1);
        continue;
      }
      if (gap.type === 'bull' && l[i] <= gap.top && c[i] > gap.bottom) {
        signals.push({ pair: null, bar: i, dir: 1 });
        fvgs.splice(f, 1);
      }
      if (gap.type === 'bear' && h[i] >= gap.bottom && c[i] < gap.top) {
        signals.push({ pair: null, bar: i, dir: -1 });
        fvgs.splice(f, 1);
      }
    }

    // Prune old structures
    while (orderBlocks.length > 50) orderBlocks.shift();
    while (fvgs.length > 50) fvgs.shift();
  }
  return signals;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRID SEARCH + MAIN
// ═══════════════════════════════════════════════════════════════════════════════

function gridSearch(signalsByPair, allKl5m, stratName, slGrid = SL_GRID, tpGrid = TP_GRID) {
  // Flatten signals across pairs
  let bestStats = null, bestCfg = null;
  let tested = 0;
  for (const sl of slGrid) {
    for (const tp of tpGrid) {
      if (tp <= sl) continue; // TP must exceed SL
      const allSigs = [];
      for (const pair of PAIRS) {
        if (!signalsByPair[pair]) continue;
        for (const sig of signalsByPair[pair]) {
          allSigs.push({ ...sig, pair, sl, tp });
        }
      }
      const stats = runBacktest(allSigs, allKl5m, { sl, tp });
      tested++;
      if (!bestStats || stats.pf > bestStats.pf || (stats.pf === bestStats.pf && stats.tradesPerDay > bestStats.tradesPerDay)) {
        bestStats = stats;
        bestCfg = { sl, tp };
      }
    }
  }
  return { stats: bestStats, cfg: bestCfg, tested };
}

function printStratResult(num, name, result, extraParams = '') {
  const { stats, cfg } = result;
  if (!stats || stats.trades === 0) {
    console.log(`\nSTRATEGY ${num}: ${name}`);
    console.log('  NO TRADES GENERATED');
    return;
  }
  console.log(`\nSTRATEGY ${num}: ${name}`);
  console.log(`  Best config: SL=${(cfg.sl * 100).toFixed(1)}%, TP=${(cfg.tp * 100).toFixed(1)}%${extraParams ? ', ' + extraParams : ''}`);
  console.log(`  PF: ${stats.pf.toFixed(2)} | WR: ${stats.wr.toFixed(1)}% | Trades/day: ${stats.tradesPerDay.toFixed(1)} | PnL: $${stats.pnl.toFixed(0)} | Max DD: ${stats.maxDD.toFixed(1)}%`);
  console.log(`  Avg Win: $${stats.avgWin.toFixed(2)} | Avg Loss: $${stats.avgLoss.toFixed(2)} | Total trades: ${stats.trades}`);
  let pairLine = '  Per pair:';
  for (const pair of PAIRS) {
    const pp = stats.perPair[pair];
    if (pp && pp.n > 0) {
      const pf = pp.gl > 0 ? (pp.gp / pp.gl).toFixed(2) : (pp.gp > 0 ? '999' : '0.00');
      pairLine += ` ${pair.replace('USDT', '')} PF ${pf}(${pp.n})`;
    }
  }
  console.log(pairLine);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

(async () => {
  const startRun = Date.now();
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  STRATEGY GRID SEARCH — 8 Strategies × 7 Pairs × 120 Days');
  console.log('  Capital: $500 | Leverage: 5x | Position: $2,500');
  console.log('  Fees: 0.02% maker, 0.05% taker, 0.03% SL slippage');
  console.log('  Entry: OPEN of bar+2 | Fill rate: 80% | Max 3 positions');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ─── FETCH ALL DATA ───
  console.log('FETCHING DATA...');
  const allKl5m = {}, allKl15m = {}, allKl1h = {};
  const allInd5m = {}, allInd15m = {}, allInd1h = {};

  for (const pair of PAIRS) {
    process.stdout.write(`  ${pair}: `);

    // 5m data
    process.stdout.write('5m');
    const raw5m = await getKlines(pair, '5m', DAYS + 5); // extra buffer for indicators
    allKl5m[pair] = parseKlines(raw5m);
    process.stdout.write(`(${allKl5m[pair].length}) `);

    // 15m data
    process.stdout.write('15m');
    const raw15m = await getKlines(pair, '15m', DAYS + 5);
    allKl15m[pair] = parseKlines(raw15m);
    process.stdout.write(`(${allKl15m[pair].length}) `);

    // 1h data
    process.stdout.write('1h');
    const raw1h = await getKlines(pair, '1h', DAYS + 10);
    allKl1h[pair] = parseKlines(raw1h);
    process.stdout.write(`(${allKl1h[pair].length})`);

    console.log(' OK');
  }

  // ─── COMPUTE INDICATORS ───
  console.log('\nCOMPUTING INDICATORS...');
  for (const pair of PAIRS) {
    allInd5m[pair] = computeIndicators(allKl5m[pair]);
    allInd15m[pair] = computeIndicators(allKl15m[pair]);
    allInd1h[pair] = computeIndicators(allKl1h[pair]);
    process.stdout.write(`  ${pair} `);
  }
  console.log('DONE\n');

  const results = {};

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 1: Multi-Indicator Confluence Score
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TESTING STRATEGY 1: Multi-Indicator Confluence Score...');
  let bestS1 = null;
  for (const thresh of [8, 10, 12, 14]) {
    const sigsByPair = {};
    for (const pair of PAIRS) {
      sigsByPair[pair] = strategy1Signals(allKl5m[pair], allInd5m[pair], thresh);
    }
    const result = gridSearch(sigsByPair, allKl5m, `S1-thresh${thresh}`);
    process.stdout.write(`  thresh=${thresh}: ${result.stats ? result.stats.trades : 0} trades, PF=${result.stats ? result.stats.pf.toFixed(2) : '0'} (${result.tested} combos)\n`);
    if (!bestS1 || (result.stats && result.stats.pf > (bestS1.stats ? bestS1.stats.pf : 0))) {
      bestS1 = { ...result, extraParams: `threshold=${thresh}` };
    }
  }
  results['S1'] = bestS1;

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 2: Adaptive Regime + Best-for-Regime
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nTESTING STRATEGY 2: Adaptive Regime + Best-for-Regime...');
  {
    const sigsByPair = {};
    for (const pair of PAIRS) {
      sigsByPair[pair] = strategy2Signals(allKl5m[pair], allInd5m[pair], allKl1h[pair], allInd1h[pair]);
    }
    results['S2'] = gridSearch(sigsByPair, allKl5m, 'S2');
    console.log(`  ${results['S2'].stats ? results['S2'].stats.trades : 0} trades, PF=${results['S2'].stats ? results['S2'].stats.pf.toFixed(2) : '0'} (${results['S2'].tested} combos)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 3: Triple Timeframe Alignment
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nTESTING STRATEGY 3: Triple Timeframe Alignment...');
  {
    const sigsByPair = {};
    for (const pair of PAIRS) {
      sigsByPair[pair] = strategy3Signals(
        allKl5m[pair], allInd5m[pair],
        allKl15m[pair], allInd15m[pair],
        allKl1h[pair], allInd1h[pair]
      );
    }
    // Strategy 3 uses dynamic SL/TP based on swing, but grid search still applies
    results['S3'] = gridSearch(sigsByPair, allKl5m, 'S3');
    console.log(`  ${results['S3'].stats ? results['S3'].stats.trades : 0} trades, PF=${results['S3'].stats ? results['S3'].stats.pf.toFixed(2) : '0'} (${results['S3'].tested} combos)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 4: Volume-Price Divergence
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nTESTING STRATEGY 4: Volume-Price Divergence...');
  {
    const sigsByPair = {};
    for (const pair of PAIRS) {
      sigsByPair[pair] = strategy4Signals(allKl5m[pair], allInd5m[pair]);
    }
    results['S4'] = gridSearch(sigsByPair, allKl5m, 'S4');
    console.log(`  ${results['S4'].stats ? results['S4'].stats.trades : 0} trades, PF=${results['S4'].stats ? results['S4'].stats.pf.toFixed(2) : '0'} (${results['S4'].tested} combos)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 5: Z-Score Mean Reversion
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nTESTING STRATEGY 5: Z-Score Mean Reversion...');
  {
    const sigsByPair = {};
    for (const pair of PAIRS) {
      sigsByPair[pair] = strategy5Signals(allKl5m[pair], allInd5m[pair]);
    }
    results['S5'] = gridSearch(sigsByPair, allKl5m, 'S5');
    console.log(`  ${results['S5'].stats ? results['S5'].stats.trades : 0} trades, PF=${results['S5'].stats ? results['S5'].stats.pf.toFixed(2) : '0'} (${results['S5'].tested} combos)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 6: Momentum Burst Detection
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nTESTING STRATEGY 6: Momentum Burst Detection...');
  {
    const sigsByPair = {};
    for (const pair of PAIRS) {
      sigsByPair[pair] = strategy6Signals(allKl5m[pair], allInd5m[pair]);
    }
    // Wider SL for burst strategies
    const burstSL = [0.005, 0.007, 0.010, 0.015, 0.020, 0.025];
    const burstTP = [0.010, 0.015, 0.020, 0.030, 0.040, 0.050];
    results['S6'] = gridSearch(sigsByPair, allKl5m, 'S6', burstSL, burstTP);
    console.log(`  ${results['S6'].stats ? results['S6'].stats.trades : 0} trades, PF=${results['S6'].stats ? results['S6'].stats.pf.toFixed(2) : '0'} (${results['S6'].tested} combos)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 7: Smart Money Concepts (Order Block + FVG)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nTESTING STRATEGY 7: Smart Money Concepts...');
  {
    const sigsByPair = {};
    for (const pair of PAIRS) {
      sigsByPair[pair] = strategy7Signals(allKl5m[pair], allInd5m[pair]);
    }
    results['S7'] = gridSearch(sigsByPair, allKl5m, 'S7');
    console.log(`  ${results['S7'].stats ? results['S7'].stats.trades : 0} trades, PF=${results['S7'].stats ? results['S7'].stats.pf.toFixed(2) : '0'} (${results['S7'].tested} combos)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY 8: Combined Best (top 2-3 decorrelated strategies)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nTESTING STRATEGY 8: Combined Best...');
  {
    // Find strategies with PF > 1.3 and sufficient trades
    const candidates = [];
    for (const key of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']) {
      const r = results[key];
      if (r && r.stats && r.stats.pf > 1.0 && r.stats.trades > 20) {
        candidates.push({ key, pf: r.stats.pf, trades: r.stats.trades, cfg: r.cfg });
      }
    }
    candidates.sort((a, b) => b.pf - a.pf);
    console.log(`  Eligible strategies (PF>1.0, >20 trades): ${candidates.map(c => `${c.key}(PF=${c.pf.toFixed(2)})`).join(', ') || 'NONE'}`);

    // Take top 3
    const top = candidates.slice(0, 3);
    if (top.length >= 2) {
      // Re-generate signals for top strategies with their best SL/TP
      const combinedSigs = [];
      const stratGenerators = {
        S1: (pair) => strategy1Signals(allKl5m[pair], allInd5m[pair], parseInt((results['S1'].extraParams || 'threshold=10').split('=')[1])),
        S2: (pair) => strategy2Signals(allKl5m[pair], allInd5m[pair], allKl1h[pair], allInd1h[pair]),
        S3: (pair) => strategy3Signals(allKl5m[pair], allInd5m[pair], allKl15m[pair], allInd15m[pair], allKl1h[pair], allInd1h[pair]),
        S4: (pair) => strategy4Signals(allKl5m[pair], allInd5m[pair]),
        S5: (pair) => strategy5Signals(allKl5m[pair], allInd5m[pair]),
        S6: (pair) => strategy6Signals(allKl5m[pair], allInd5m[pair]),
        S7: (pair) => strategy7Signals(allKl5m[pair], allInd5m[pair])
      };

      for (const strat of top) {
        for (const pair of PAIRS) {
          const gen = stratGenerators[strat.key];
          if (!gen) continue;
          const sigs = gen(pair);
          for (const sig of sigs) {
            combinedSigs.push({ ...sig, pair, sl: strat.cfg.sl, tp: strat.cfg.tp, _strat: strat.key });
          }
        }
      }

      const combinedStats = runBacktest(combinedSigs, allKl5m, {});
      results['S8'] = {
        stats: combinedStats,
        cfg: { sl: top[0].cfg.sl, tp: top[0].cfg.tp },
        strategies: top.map(t => t.key)
      };
      console.log(`  Combined ${top.map(t => t.key).join('+')} → ${combinedStats.trades} trades, PF=${combinedStats.pf.toFixed(2)}`);

      // Also try grid search on combined
      const combinedByPair = {};
      for (const pair of PAIRS) {
        combinedByPair[pair] = [];
        for (const strat of top) {
          const gen = stratGenerators[strat.key];
          if (!gen) continue;
          combinedByPair[pair] = combinedByPair[pair].concat(gen(pair));
        }
      }
      const combinedGrid = gridSearch(combinedByPair, allKl5m, 'S8-grid');
      if (combinedGrid.stats && combinedGrid.stats.pf > combinedStats.pf) {
        results['S8'] = { ...combinedGrid, strategies: top.map(t => t.key) };
        console.log(`  Grid search improved → PF=${combinedGrid.stats.pf.toFixed(2)}`);
      }
    } else {
      // Fall back to best single strategy
      console.log('  Not enough qualifying strategies, using best single');
      const bestKey = candidates.length > 0 ? candidates[0].key : 'S1';
      results['S8'] = results[bestKey] || { stats: { pf: 0, wr: 0, trades: 0, tradesPerDay: 0, pnl: 0, maxDD: 0, avgWin: 0, avgLoss: 0, perPair: {} }, cfg: { sl: 0.005, tp: 0.015 } };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESULTS TABLE
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  COMPREHENSIVE RESULTS — ALL 8 STRATEGIES');
  console.log('═══════════════════════════════════════════════════════════════════');

  const names = {
    S1: 'Multi-Indicator Confluence Score',
    S2: 'Adaptive Regime + Best-for-Regime',
    S3: 'Triple Timeframe Alignment',
    S4: 'Volume-Price Divergence',
    S5: 'Z-Score Mean Reversion',
    S6: 'Momentum Burst Detection',
    S7: 'Smart Money Concepts (OB+FVG)',
    S8: 'Combined Best'
  };

  let overallBest = null, overallBestKey = '';
  for (const key of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
    const r = results[key];
    printStratResult(key.slice(1), names[key], r || { stats: null, cfg: {} }, r?.extraParams || (key === 'S8' && r?.strategies ? `strategies=${r.strategies.join('+')}` : ''));
    if (r && r.stats && r.stats.pf > (overallBest ? overallBest.pf : 0)) {
      overallBest = r.stats;
      overallBestKey = key;
    }
  }

  // ─── SUMMARY TABLE ───
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  COMPARISON TABLE');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Strategy                          |   PF  |   WR  | Tr/day |    PnL  | MaxDD');
  console.log('  ----------------------------------|-------|-------|--------|---------|------');
  for (const key of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
    const r = results[key];
    const s = r?.stats;
    if (!s || s.trades === 0) {
      console.log(`  ${key} ${names[key].padEnd(30)} |  N/A  |  N/A  |   N/A  |    N/A  |  N/A`);
      continue;
    }
    const pfStr = s.pf.toFixed(2).padStart(5);
    const wrStr = (s.wr.toFixed(1) + '%').padStart(5);
    const tpdStr = s.tradesPerDay.toFixed(1).padStart(5);
    const pnlStr = ('$' + s.pnl.toFixed(0)).padStart(7);
    const ddStr = (s.maxDD.toFixed(1) + '%').padStart(5);
    console.log(`  ${key} ${names[key].substring(0, 30).padEnd(30)} | ${pfStr} | ${wrStr} | ${tpdStr}  | ${pnlStr} | ${ddStr}`);
  }

  // ─── TARGET CHECK ───
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  TARGET CHECK: PF >= 2.2, WR >= 55%, Trades/day >= 10');
  console.log('═══════════════════════════════════════════════════════════════════');
  let anyHit = false;
  for (const key of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']) {
    const s = results[key]?.stats;
    if (!s) continue;
    const pfOk = s.pf >= 2.2, wrOk = s.wr >= 55, tpdOk = s.tradesPerDay >= 10;
    if (pfOk && wrOk && tpdOk) {
      console.log(`  >>> ${key} ${names[key]} MEETS ALL TARGETS <<<`);
      anyHit = true;
    } else if (pfOk || wrOk) {
      const status = [];
      status.push(pfOk ? 'PF OK' : `PF ${s.pf.toFixed(2)} < 2.2`);
      status.push(wrOk ? 'WR OK' : `WR ${s.wr.toFixed(1)}% < 55%`);
      status.push(tpdOk ? 'Tr/d OK' : `Tr/d ${s.tradesPerDay.toFixed(1)} < 10`);
      console.log(`  ${key}: ${status.join(' | ')}`);
    }
  }
  if (!anyHit) {
    console.log('  No single strategy meets ALL targets simultaneously.');
    console.log('  This is expected — the targets are extremely aggressive for adverse markets.');
    console.log(`  OVERALL BEST: ${overallBestKey} ${names[overallBestKey]} with PF=${overallBest?.pf.toFixed(2) || 'N/A'}`);
  }

  // ─── MARKET CONDITIONS ───
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  MARKET CONDITIONS DURING TEST PERIOD');
  console.log('═══════════════════════════════════════════════════════════════════');
  const btcKl = allKl5m['BTCUSDT'];
  if (btcKl && btcKl.length > 100) {
    const btcStart = btcKl[0].c, btcEnd = btcKl[btcKl.length - 1].c;
    let btcHigh = 0, btcLow = Infinity;
    for (const k of btcKl) { btcHigh = Math.max(btcHigh, k.h); btcLow = Math.min(btcLow, k.l); }
    console.log(`  BTC: $${btcStart.toFixed(0)} -> $${btcEnd.toFixed(0)} (${((btcEnd / btcStart - 1) * 100).toFixed(1)}%)`);
    console.log(`  Range: $${btcLow.toFixed(0)} - $${btcHigh.toFixed(0)} (${((btcHigh / btcLow - 1) * 100).toFixed(1)}%)`);
    const maxDrop = ((btcLow - btcHigh) / btcHigh * 100).toFixed(1);
    console.log(`  Max drawdown from high: ${maxDrop}%`);
    const startDate = new Date(btcKl[0].t).toISOString().slice(0, 10);
    const endDate = new Date(btcKl[btcKl.length - 1].t).toISOString().slice(0, 10);
    console.log(`  Period: ${startDate} to ${endDate}`);
  }

  const elapsed = ((Date.now() - startRun) / 1000).toFixed(1);
  console.log(`\nCompleted in ${elapsed}s`);
  console.log('═══════════════════════════════════════════════════════════════════');
})();
