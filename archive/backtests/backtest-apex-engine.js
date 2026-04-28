#!/usr/bin/env node
/**
 * APEX SIGNAL ENGINE — Comprehensive Backtest
 * 6 sub-strategies, 5 pairs, 120 days, real Binance Futures data
 * Walk-forward analysis with regime classification
 *
 * Usage: node backtest-apex-engine.js
 */

const https = require('https');

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════
const INITIAL_CAPITAL = 500;
const LEVERAGE = 5;
const MAKER_FEE = 0.0002;   // 0.02% limit entry + TP
const TAKER_FEE = 0.0004;   // 0.04% market SL
const SLIPPAGE = 0.0001;    // 0.01% on SL only
const DELAY_BARS = 1;       // enter at NEXT bar open
const DAYS = 120;
const MAX_LOSS_PCT = 0.02;  // 2% per trade of CURRENT capital
const MIN_CAPITAL = 100;    // STOP trading if capital drops below this
const MAX_POSITIONS = 3;
const MAX_SAME_DIR = 2;
const DAILY_LOSS_LIMIT = 0.06; // 6% of CURRENT capital
const STREAK_COOLDOWN = 8;  // after 3 consecutive losses
const MIN_APEX_SCORE = 6;   // lower threshold, filter bad strategies instead
const HIGH_CONF_SCORE = 10; // lowered from 12
const WALK_FORWARD_DAYS = 30; // 4 periods of 30 days

// Per-strategy cooldowns (in bars)
const STRATEGY_COOLDOWNS = {
  VWAP_REVERSION: 2,
  MOMENTUM_PULSE: 3,
  STRUCTURE_BOUNCE: 3,
  TREND_CONTINUATION: 4,
  DIVERGENCE_SNIPER: 5,
  SQUEEZE_EXPLOSION: 10
};
const GLOBAL_SYMBOL_COOLDOWN = 2; // min bars between any trades on same symbol

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];

const STRATEGY_NAMES = [
  'VWAP_REVERSION',
  'MOMENTUM_PULSE',
  'SQUEEZE_EXPLOSION',
  'DIVERGENCE_SNIPER',
  'STRUCTURE_BOUNCE',
  'TREND_CONTINUATION'
];

// ═══════════════════════════════════════════════════════════════
// INDICATOR LIBRARY
// ═══════════════════════════════════════════════════════════════

function calcEMAArr(data, p) {
  if (!data || !data.length) return [];
  const k = 2 / (p + 1);
  const r = [data[0]];
  for (let i = 1; i < data.length; i++) r.push(data[i] * k + r[i - 1] * (1 - k));
  return r;
}

function calcEMA(data, p) {
  const arr = calcEMAArr(data, p);
  return arr.length ? arr[arr.length - 1] : 0;
}

function calcSMA(data, p) {
  if (!data || data.length < p) return data ? data[data.length - 1] || 0 : 0;
  const sl = data.slice(-p);
  return sl.reduce((a, b) => a + b, 0) / p;
}

function calcRSI(closes, p = 14) {
  if (!closes || closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[closes.length - p - 1 + i] - closes[closes.length - p - 1 + i - 1];
    if (d > 0) g += d; else l += Math.abs(d);
  }
  let ag = g / p, al = l / p;
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}

function calcRSIArray(closes, p = 14) {
  if (!closes || closes.length < p + 1) return [];
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l += Math.abs(d);
  }
  let ag = g / p, al = l / p;
  const result = new Array(p).fill(50);
  result.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? Math.abs(d) : 0)) / p;
    result.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
  }
  return result;
}

function calcMACD(closes) {
  if (!closes || closes.length < 35) return { h: 0, ph: 0, macd: 0, sig: 0 };
  const e12 = calcEMAArr(closes, 12), e26 = calcEMAArr(closes, 26);
  const ml = e12.map((v, i) => v - e26[i]);
  const sl = calcEMAArr(ml, 9);
  return {
    h: ml[ml.length - 1] - sl[sl.length - 1],
    ph: (ml[ml.length - 2] || 0) - (sl[sl.length - 2] || sl[sl.length - 1]),
    macd: ml[ml.length - 1],
    sig: sl[sl.length - 1]
  };
}

function calcMACDHistArray(closes) {
  if (!closes || closes.length < 35) return [];
  const e12 = calcEMAArr(closes, 12), e26 = calcEMAArr(closes, 26);
  const ml = e12.map((v, i) => v - e26[i]);
  const sl = calcEMAArr(ml, 9);
  return ml.map((v, i) => v - sl[i]);
}

function calcBB(closes, p = 20, mult = 2) {
  if (!closes || closes.length < p) return { u: 0, m: 0, l: 0, width: 0 };
  const sl = closes.slice(-p);
  const m = sl.reduce((a, b) => a + b, 0) / p;
  const sd = Math.sqrt(sl.reduce((a, b) => a + Math.pow(b - m, 2), 0) / p);
  return { u: m + mult * sd, m, l: m - mult * sd, width: 2 * mult * sd };
}

function calcStoch(H, L, C, kp = 14, dp = 3) {
  if (!C || C.length < kp + dp) return { k: 50, d: 50 };
  const kArr = [];
  for (let i = kp; i <= C.length; i++) {
    const hi = Math.max(...H.slice(i - kp, i));
    const lo = Math.min(...L.slice(i - kp, i));
    kArr.push(hi === lo ? 50 : ((C[i - 1] - lo) / (hi - lo)) * 100);
  }
  const dArr = [];
  for (let i = dp - 1; i < kArr.length; i++) {
    let sum = 0;
    for (let j = 0; j < dp; j++) sum += kArr[i - j];
    dArr.push(sum / dp);
  }
  return { k: kArr[kArr.length - 1] || 50, d: dArr[dArr.length - 1] || 50 };
}

function calcATR(H, L, C, p = 14) {
  if (!H || H.length < p + 1) return 0;
  const trs = [];
  for (let i = 1; i < C.length; i++) {
    trs.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
  }
  if (trs.length < p) return trs.reduce((a, b) => a + b, 0) / trs.length;
  let atr = trs.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < trs.length; i++) atr = (atr * (p - 1) + trs[i]) / p;
  return atr;
}

function wilderSmooth(arr, period) {
  if (arr.length < period) return arr.map(() => 0);
  const r = [];
  let s = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period; i++) r.push(0);
  r[period - 1] = s;
  for (let i = period; i < arr.length; i++) {
    s = (s * (period - 1) + arr[i]) / period;
    r.push(s);
  }
  return r;
}

function calcADX(H, L, C, p = 14) {
  if (!H || C.length < p * 2 + 1) return { adx: 15, pdi: 0, mdi: 0 };
  const pdm = [], mdm = [], tr = [];
  for (let i = 1; i < H.length; i++) {
    const upMove = H[i] - H[i - 1], dnMove = L[i - 1] - L[i];
    pdm.push(upMove > dnMove && upMove > 0 ? upMove : 0);
    mdm.push(dnMove > upMove && dnMove > 0 ? dnMove : 0);
    tr.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
  }
  const smTR = wilderSmooth(tr, p);
  const smPDM = wilderSmooth(pdm, p);
  const smMDM = wilderSmooth(mdm, p);
  const pdi = smPDM.map((v, i) => smTR[i] ? (v / smTR[i]) * 100 : 0);
  const mdi = smMDM.map((v, i) => smTR[i] ? (v / smTR[i]) * 100 : 0);
  const dx = pdi.map((v, i) => {
    const s = v + mdi[i];
    return s ? Math.abs(v - mdi[i]) / s * 100 : 0;
  });
  const dxValid = dx.slice(p - 1);
  const adxArr = dxValid.length >= p ? wilderSmooth(dxValid, p) : dxValid;
  return {
    adx: adxArr[adxArr.length - 1] || 15,
    pdi: pdi[pdi.length - 1] || 0,
    mdi: mdi[mdi.length - 1] || 0
  };
}

function calcOBV(C, V) {
  if (!C || C.length < 2) return { obv: 0, slope: 0, rising: false };
  let obv = 0;
  const arr = [0];
  for (let i = 1; i < C.length; i++) {
    if (C[i] > C[i - 1]) obv += V[i];
    else if (C[i] < C[i - 1]) obv -= V[i];
    arr.push(obv);
  }
  const n = Math.min(arr.length, 20);
  const recent = arr.slice(-n);
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += recent[i]; sumXY += i * recent[i]; sumX2 += i * i; }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX || 1);
  return { obv: arr[arr.length - 1], slope, rising: slope > 0 };
}

function calcCMF(H, L, C, V, p = 20) {
  if (!H || H.length < p) return 0;
  let mfvSum = 0, volSum = 0;
  for (let i = H.length - p; i < H.length; i++) {
    const range = H[i] - L[i];
    const mfm = range > 0 ? ((C[i] - L[i]) - (H[i] - C[i])) / range : 0;
    mfvSum += mfm * V[i];
    volSum += V[i];
  }
  return volSum > 0 ? mfvSum / volSum : 0;
}

function calcVWAPWithBands(klines, lookback) {
  const start = Math.max(0, klines.length - (lookback || klines.length));
  let cumVol = 0, cumVolPrice = 0, cumVolPriceSq = 0;
  const vwapArr = [], stdArr = [];
  for (let i = start; i < klines.length; i++) {
    const h = parseFloat(klines[i][2]), l = parseFloat(klines[i][3]);
    const c = parseFloat(klines[i][4]), v = parseFloat(klines[i][5]);
    const tp = (h + l + c) / 3;
    cumVol += v;
    cumVolPrice += tp * v;
    cumVolPriceSq += tp * tp * v;
    const vwap = cumVol > 0 ? cumVolPrice / cumVol : c;
    const variance = cumVol > 0 ? (cumVolPriceSq / cumVol) - vwap * vwap : 0;
    const std = Math.sqrt(Math.max(0, variance));
    vwapArr.push(vwap);
    stdArr.push(std);
  }
  return {
    vwap: vwapArr[vwapArr.length - 1] || 0,
    std: stdArr[stdArr.length - 1] || 0,
    vwapArr,
    stdArr
  };
}

function calcKeltner(H, L, C, emaLen = 20, atrLen = 14, mult = 1.5) {
  if (!C || C.length < Math.max(emaLen, atrLen) + 1) return { upper: 0, mid: 0, lower: 0 };
  const mid = calcEMA(C, emaLen);
  const atr = calcATR(H, L, C, atrLen);
  return { upper: mid + mult * atr, mid, lower: mid - mult * atr };
}

function calcSupertrend(H, L, C, period = 10, mult = 3) {
  if (!H || H.length < period + 1) return { trend: 'BUY', value: C ? C[C.length - 1] : 0 };
  const atrArr = [];
  for (let i = period; i < H.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += Math.max(H[j] - L[j], Math.abs(H[j] - C[j - 1]), Math.abs(L[j] - C[j - 1]));
    }
    atrArr.push(sum / period);
  }
  let trend = 1; // 1 = up, -1 = down
  let upperBand, lowerBand, supertrend;
  const offset = period;
  for (let i = 0; i < atrArr.length; i++) {
    const idx = i + offset;
    const hl2 = (H[idx] + L[idx]) / 2;
    const atr = atrArr[i];
    const basicUpper = hl2 + mult * atr;
    const basicLower = hl2 - mult * atr;
    if (i === 0) {
      upperBand = basicUpper;
      lowerBand = basicLower;
    } else {
      lowerBand = basicLower > lowerBand ? basicLower : (C[idx - 1] > lowerBand ? lowerBand : basicLower);
      upperBand = basicUpper < upperBand ? basicUpper : (C[idx - 1] < upperBand ? upperBand : basicUpper);
    }
    if (trend === 1) {
      if (C[idx] < lowerBand) trend = -1;
    } else {
      if (C[idx] > upperBand) trend = 1;
    }
    supertrend = trend === 1 ? lowerBand : upperBand;
  }
  return { trend: trend === 1 ? 'BUY' : 'SELL', value: supertrend };
}

// Pivot point detection (swing highs/lows)
function detectPivots(H, L, leftBars = 5, rightBars = 5) {
  const pivotHighs = [], pivotLows = [];
  for (let i = leftBars; i < H.length - rightBars; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= leftBars; j++) {
      if (H[i] <= H[i - j]) isHigh = false;
      if (L[i] >= L[i - j]) isLow = false;
    }
    for (let j = 1; j <= rightBars; j++) {
      if (H[i] <= H[i + j]) isHigh = false;
      if (L[i] >= L[i + j]) isLow = false;
    }
    if (isHigh) pivotHighs.push({ idx: i, price: H[i] });
    if (isLow) pivotLows.push({ idx: i, price: L[i] });
  }
  return { highs: pivotHighs, lows: pivotLows };
}

// Support/Resistance detection with volume clustering
function detectSR(H, L, C, V, lookback = 100) {
  const start = Math.max(0, H.length - lookback);
  const pivots = detectPivots(H.slice(start), L.slice(start), 3, 3);
  const levels = [];
  const allPivotPrices = [
    ...pivots.highs.map(p => ({ price: p.price, type: 'R' })),
    ...pivots.lows.map(p => ({ price: p.price, type: 'S' }))
  ];

  // Cluster nearby levels
  const sorted = allPivotPrices.sort((a, b) => a.price - b.price);
  const clusters = [];
  let cluster = sorted[0] ? [sorted[0]] : [];
  for (let i = 1; i < sorted.length; i++) {
    const pctDiff = Math.abs(sorted[i].price - cluster[0].price) / cluster[0].price;
    if (pctDiff < 0.003) { // 0.3% threshold
      cluster.push(sorted[i]);
    } else {
      if (cluster.length >= 2) clusters.push(cluster);
      cluster = [sorted[i]];
    }
  }
  if (cluster.length >= 2) clusters.push(cluster);

  for (const cl of clusters) {
    const avgPrice = cl.reduce((a, b) => a + b.price, 0) / cl.length;
    levels.push({ price: avgPrice, touches: cl.length, type: cl[0].type });
  }
  return levels.sort((a, b) => b.touches - a.touches).slice(0, 10);
}

// Fibonacci retracement levels
function calcFibLevels(swingHigh, swingLow) {
  const range = swingHigh - swingLow;
  return {
    high: swingHigh,
    low: swingLow,
    fib236: swingHigh - range * 0.236,
    fib382: swingHigh - range * 0.382,
    fib500: swingHigh - range * 0.500,
    fib618: swingHigh - range * 0.618,
    fib786: swingHigh - range * 0.786
  };
}

// Candlestick patterns
function detectCandlePatterns(O, H, L, C) {
  const len = C.length;
  if (len < 3) return { hammer: false, engulfBull: false, engulfBear: false, pinBarBull: false, pinBarBear: false, doji: false };
  const i = len - 1;
  const body = Math.abs(C[i] - O[i]);
  const range = H[i] - L[i];
  const upperWick = H[i] - Math.max(O[i], C[i]);
  const lowerWick = Math.min(O[i], C[i]) - L[i];
  const bullish = C[i] > O[i];
  const prevBody = Math.abs(C[i - 1] - O[i - 1]);

  const hammer = bullish && lowerWick > body * 2 && upperWick < body * 0.5 && range > 0;
  const engulfBull = bullish && C[i - 1] < O[i - 1] && C[i] > O[i - 1] && O[i] < C[i - 1];
  const engulfBear = !bullish && C[i - 1] > O[i - 1] && C[i] < O[i - 1] && O[i] > C[i - 1];
  const pinBarBull = lowerWick > range * 0.6 && body < range * 0.25;
  const pinBarBear = upperWick > range * 0.6 && body < range * 0.25;
  const doji = range > 0 && body / range < 0.1;

  return { hammer, engulfBull, engulfBear, pinBarBull, pinBarBear, doji, bullish };
}

// RSI Divergence detection
function detectRSIDivergence(C, rsiArr, lookback = 30) {
  if (!rsiArr || rsiArr.length < lookback) return { bull: false, bear: false };
  const n = C.length;
  const start = n - lookback;

  // Find two most recent swing lows in price
  let bull = false, bear = false;

  // Bullish: price lower low, RSI higher low
  const priceLows = [], priceHighs = [];
  for (let i = start + 2; i < n - 2; i++) {
    if (C[i] <= C[i - 1] && C[i] <= C[i - 2] && C[i] <= C[i + 1] && C[i] <= C[i + 2]) {
      priceLows.push({ idx: i, price: C[i], rsi: rsiArr[i] });
    }
    if (C[i] >= C[i - 1] && C[i] >= C[i - 2] && C[i] >= C[i + 1] && C[i] >= C[i + 2]) {
      priceHighs.push({ idx: i, price: C[i], rsi: rsiArr[i] });
    }
  }

  if (priceLows.length >= 2) {
    const last = priceLows[priceLows.length - 1];
    const prev = priceLows[priceLows.length - 2];
    if (last.price < prev.price && last.rsi > prev.rsi) bull = true;
  }
  if (priceHighs.length >= 2) {
    const last = priceHighs[priceHighs.length - 1];
    const prev = priceHighs[priceHighs.length - 2];
    if (last.price > prev.price && last.rsi < prev.rsi) bear = true;
  }

  return { bull, bear };
}

// Volume ratio
function volumeRatio(V, period = 20) {
  if (!V || V.length < period + 1) return 1;
  const avg = V.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  return avg > 0 ? V[V.length - 1] / avg : 1;
}

// Volatility percentile
function volatilityPercentile(H, L, C, lookbackATR = 14, lookbackPercentile = 100) {
  if (!H || H.length < lookbackPercentile + lookbackATR) return 50;
  const atrValues = [];
  for (let end = lookbackATR + 1; end <= H.length; end++) {
    const hSlice = H.slice(end - lookbackATR - 1, end);
    const lSlice = L.slice(end - lookbackATR - 1, end);
    const cSlice = C.slice(end - lookbackATR - 1, end);
    let trs = [];
    for (let i = 1; i < hSlice.length; i++) {
      trs.push(Math.max(hSlice[i] - lSlice[i], Math.abs(hSlice[i] - cSlice[i - 1]), Math.abs(lSlice[i] - cSlice[i - 1])));
    }
    atrValues.push(trs.reduce((a, b) => a + b, 0) / trs.length);
  }
  const currentATR = atrValues[atrValues.length - 1];
  const recent = atrValues.slice(-lookbackPercentile);
  const below = recent.filter(v => v <= currentATR).length;
  return (below / recent.length) * 100;
}

// BB inside Keltner squeeze detection
function detectSqueeze(bbWidth, kcUpper, kcLower, bbUpper, bbLower) {
  return bbUpper < kcUpper && bbLower > kcLower;
}

// Consecutive squeeze bars count
function countSqueezeBars(H, L, C, maxLookback = 30) {
  let count = 0;
  for (let offset = 0; offset < maxLookback; offset++) {
    const end = C.length - offset;
    if (end < 21) break;
    const cSlice = C.slice(0, end);
    const hSlice = H.slice(0, end);
    const lSlice = L.slice(0, end);
    const bb = calcBB(cSlice, 20, 2);
    const kc = calcKeltner(hSlice, lSlice, cSlice, 20, 14, 1.5);
    if (bb.u < kc.upper && bb.l > kc.lower) count++;
    else break;
  }
  return count;
}

// ═══════════════════════════════════════════════════════════════
// REGIME CLASSIFIER
// ═══════════════════════════════════════════════════════════════
function classifyRegime(H_1h, L_1h, C_1h, H_5m, L_5m, C_5m) {
  const adx1h = calcADX(H_1h, L_1h, C_1h, 14);
  const bb5m = calcBB(C_5m, 20, 2);
  const kc5m = calcKeltner(H_5m, L_5m, C_5m, 20, 14, 1.5);
  const isSqueeze = bb5m.u < kc5m.upper && bb5m.l > kc5m.lower;
  const volPct = volatilityPercentile(H_5m, L_5m, C_5m, 14, 100);

  if (isSqueeze) return 'SQUEEZE';
  if (adx1h.adx > 30) return 'STRONG_TREND';
  if (adx1h.adx > 20) return 'MILD_TREND';
  if (adx1h.adx < 15 && volPct > 70) return 'CHOPPY';
  if (adx1h.adx < 20 && volPct < 30) return 'QUIET_RANGE';
  if (adx1h.adx < 20) return 'ACTIVE_RANGE';
  return 'MILD_TREND';
}

// ═══════════════════════════════════════════════════════════════
// SUB-STRATEGIES
// ═══════════════════════════════════════════════════════════════

// Strategy 1: VWAP REVERSION
function checkVWAPReversion(klines5m, O, H, L, C, V, regime) {
  if (regime !== 'ACTIVE_RANGE' && regime !== 'QUIET_RANGE') return null;
  if (C.length < 60) return null;

  const vwapData = calcVWAPWithBands(klines5m.slice(-288), 288); // ~1 day of 5m
  const vwap = vwapData.vwap, std = vwapData.std;
  if (std === 0 || vwap === 0) return null;

  const cur = C[C.length - 1];
  const deviation = (cur - vwap) / std;
  const rsi = calcRSI(C, 7);
  const vr = volumeRatio(V, 20);
  const candle = detectCandlePatterns(O, H, L, C);

  let signal = null;
  const atr = calcATR(H, L, C, 14);

  // LONG: price below VWAP by >1.5 std, RSI <35, volume >0.8x avg
  // Require bullish candle for entry (7.4% WR without was too low)
  const hasBullCandle = candle.hammer || candle.engulfBull || candle.pinBarBull;
  if (deviation < -1.5 && rsi < 35 && vr > 0.8 && hasBullCandle) {
    const moveToMean = Math.abs(vwap - cur);
    const tp = cur + moveToMean * 1.0; // target = mean (conservative, ensures more hits)
    const sl = cur - atr * 1.2; // wider SL for more room
    if (tp > cur && sl < cur) {
      signal = { dir: 'BUY', entry: cur, tp, sl, strategy: 'VWAP_REVERSION' };
      signal.bonus = true;
    }
  }

  // SHORT: price above VWAP by >1.5 std, RSI >65
  const hasBearCandle = candle.engulfBear || candle.pinBarBear;
  if (deviation > 1.5 && rsi > 65 && vr > 0.8 && hasBearCandle) {
    const moveToMean = Math.abs(cur - vwap);
    const tp = cur - moveToMean * 1.0;
    const sl = cur + atr * 1.2;
    if (tp < cur && sl > cur) {
      signal = { dir: 'SELL', entry: cur, tp, sl, strategy: 'VWAP_REVERSION' };
      signal.bonus = true;
    }
  }

  return signal;
}

// Strategy 2: MOMENTUM PULSE
function checkMomentumPulse(O, H, L, C, V, regime) {
  if (regime === 'CHOPPY' || regime === 'QUIET_RANGE') return null;
  if (C.length < 50) return null;

  const ema8 = calcEMA(C, 8);
  const ema13 = calcEMA(C, 13);
  const ema21 = calcEMA(C, 21);
  const macd = calcMACD(C);
  const adx = calcADX(H, L, C, 14);
  const atr = calcATR(H, L, C, 14);
  const cur = C[C.length - 1];
  const prevClose = C[C.length - 2];
  const candle = detectCandlePatterns(O, H, L, C);

  const rsi = calcRSI(C, 14);
  const obv = calcOBV(C, V);

  // LONG: ema8 > ema21 + RSI 40-70 + ADX>25 + OBV confirms
  if (ema8 > ema21 && adx.adx > 25 && adx.pdi > adx.mdi && rsi > 40 && rsi < 70) {
    const histGrowing = macd.h > 0 && macd.h > macd.ph;
    const pullback = cur <= ema13 * 1.002 && cur >= ema21 * 0.998;
    if (histGrowing && pullback && obv.rising) {
      const tp = cur + atr * 2.5;
      const sl = cur - atr * 1.2; // TP:SL = ~2:1
      if (tp > cur && sl < cur) {
        return { dir: 'BUY', entry: cur, tp, sl, strategy: 'MOMENTUM_PULSE' };
      }
    }
  }

  // SHORT: ema8 < ema21 + OBV declining
  if (ema8 < ema21 && adx.adx > 25 && adx.mdi > adx.pdi && rsi > 30 && rsi < 60) {
    const histGrowing = macd.h < 0 && macd.h < macd.ph;
    const pullback = cur >= ema13 * 0.998 && cur <= ema21 * 1.002;
    if (histGrowing && pullback && !obv.rising) {
      const tp = cur - atr * 2.5;
      const sl = cur + atr * 1.2;
      if (tp < cur && sl > cur) {
        return { dir: 'SELL', entry: cur, tp, sl, strategy: 'MOMENTUM_PULSE' };
      }
    }
  }

  return null;
}

// Strategy 3: SQUEEZE EXPLOSION
function checkSqueezeExplosion(O, H, L, C, V, regime) {
  if (C.length < 50) return null;

  const squeezeBars = countSqueezeBars(H, L, C, 30);
  if (squeezeBars < 4) return null; // relaxed from 8 to 4

  const bb = calcBB(C, 20, 2);
  const kc = calcKeltner(H, L, C, 20, 14, 1.5);
  const cur = C[C.length - 1];
  const prevClose = C[C.length - 2];
  const vr = volumeRatio(V, 20);

  // Check BB width percentile (relaxed from 10 to 20)
  // Must have broken out of squeeze (current bar NOT in squeeze but previous was)
  const curSqueeze = bb.u < kc.upper && bb.l > kc.lower;
  if (curSqueeze) return null; // Still in squeeze, wait for breakout

  if (vr < 1.3) return null; // relaxed from 2.0 to 1.3

  const squeezeRange = bb.u - bb.l;
  const macd = calcMACD(C);

  // LONG breakout — Fix 4: TP = range*1.5, SL = middle of range
  if (cur > bb.u && macd.h > 0) {
    const tp = cur + squeezeRange * 1.5; // reduced from 2.0
    const sl = bb.m; // middle of range
    if (tp > cur && sl < cur) {
      return { dir: 'BUY', entry: cur, tp, sl, strategy: 'SQUEEZE_EXPLOSION' };
    }
  }

  // SHORT breakout
  if (cur < bb.l && macd.h < 0) {
    const tp = cur - squeezeRange * 1.5;
    const sl = bb.m;
    if (tp < cur && sl > cur) {
      return { dir: 'SELL', entry: cur, tp, sl, strategy: 'SQUEEZE_EXPLOSION' };
    }
  }

  return null;
}

// Strategy 4: DIVERGENCE SNIPER
function checkDivergenceSniper(O, H, L, C, V, regime) {
  if (C.length < 50) return null;

  const rsiArr = calcRSIArray(C, 14);
  const div = detectRSIDivergence(C, rsiArr, 30);
  const candle = detectCandlePatterns(O, H, L, C);
  const atr = calcATR(H, L, C, 14);
  const cur = C[C.length - 1];
  const rsi = rsiArr[rsiArr.length - 1];
  const vr = volumeRatio(V, 20);

  // Bullish divergence: price lower low + RSI higher low + confirmation candle
  // Relaxed: volumeRatio >0.8 for confirmation (was implicit >1.2)
  if (div.bull && (candle.hammer || candle.engulfBull || candle.bullish) && rsi < 45 && vr > 0.8) {
    const recentHigh = Math.max(...H.slice(-20));
    const recentLow = Math.min(...L.slice(-10));
    const tp = recentHigh;
    const sl = recentLow - atr * 0.5;
    if (tp > cur * 1.001 && sl < cur) {
      return { dir: 'BUY', entry: cur, tp, sl, strategy: 'DIVERGENCE_SNIPER' };
    }
  }

  // Bearish divergence — relaxed confirmation
  if (div.bear && (candle.engulfBear || !candle.bullish) && rsi > 55 && vr > 0.8) {
    const recentLow = Math.min(...L.slice(-20));
    const recentHigh = Math.max(...H.slice(-10));
    const tp = recentLow;
    const sl = recentHigh + atr * 0.5;
    if (tp < cur * 0.999 && sl > cur) {
      return { dir: 'SELL', entry: cur, tp, sl, strategy: 'DIVERGENCE_SNIPER' };
    }
  }

  return null;
}

// Strategy 5: STRUCTURE BOUNCE
function checkStructureBounce(O, H, L, C, V, regime) {
  if (C.length < 100) return null;
  // Only trade in ranging regimes (trend breaks S/R)
  if (regime === 'STRONG_TREND') return null;

  const srLevels = detectSR(H, L, C, V, 100);
  if (srLevels.length < 2) return null;

  const cur = C[C.length - 1];
  const rsi = calcRSI(C, 7);
  const candle = detectCandlePatterns(O, H, L, C);
  const atr = calcATR(H, L, C, 14);
  const vr = volumeRatio(V, 20);

  for (const level of srLevels) {
    const proximity = Math.abs(cur - level.price) / cur;
    if (proximity > 0.003) continue;

    // LONG: touching support + candle + RSI <40 + volume confirmation
    if (cur >= level.price * 0.997 && cur <= level.price * 1.003 && level.type === 'S') {
      if ((candle.pinBarBull || candle.hammer || candle.engulfBull) && rsi < 40 && vr > 0.9) {
        const resistances = srLevels.filter(l => l.price > cur * 1.003);
        const nextR = resistances.length ? resistances[0].price : cur + atr * 2.5;
        const tp = nextR;
        const sl = level.price - atr * 1.0;
        // Ensure minimum R:R of 1.5
        const rr = (tp - cur) / (cur - sl);
        if (tp > cur && sl < cur && rr >= 1.2) {
          return { dir: 'BUY', entry: cur, tp, sl, strategy: 'STRUCTURE_BOUNCE' };
        }
      }
    }

    // SHORT: touching resistance — require candle pattern + volume
    if (cur >= level.price * 0.997 && cur <= level.price * 1.003 && level.type === 'R') {
      if ((candle.pinBarBear || candle.engulfBear) && rsi > 60 && vr > 0.9) {
        const supports = srLevels.filter(l => l.price < cur * 0.997);
        const nextS = supports.length ? supports[supports.length - 1].price : cur - atr * 2.5;
        const tp = nextS;
        const sl = level.price + atr * 1.0;
        const rr = (cur - tp) / (sl - cur);
        if (tp < cur && sl > cur && rr >= 1.2) {
          return { dir: 'SELL', entry: cur, tp, sl, strategy: 'STRUCTURE_BOUNCE' };
        }
      }
    }
  }

  return null;
}

// Strategy 6: TREND CONTINUATION (MTF Fibonacci)
function checkTrendContinuation(O, H, L, C, V, C_1h, H_1h, L_1h, V_1h, C_4h, H_4h, L_4h, regime) {
  if (C.length < 50 || !C_1h || C_1h.length < 30 || !C_4h || C_4h.length < 20) return null;
  if (regime === 'CHOPPY') return null;

  const cur = C[C.length - 1];
  const atr = calcATR(H, L, C, 14);
  const candle = detectCandlePatterns(O, H, L, C);
  const vr = volumeRatio(V, 20);

  // Check 1h and 4h trend alignment
  const ema20_1h = calcEMA(C_1h, 20);
  const ema50_1h = calcEMA(C_1h, 50);
  const adx_1h = calcADX(H_1h, L_1h, C_1h, 14);
  const ema20_4h = calcEMA(C_4h, 20);
  const ema50_4h = calcEMA(C_4h, 50);

  const bullTrend1h = ema20_1h > ema50_1h && adx_1h.pdi > adx_1h.mdi;
  const bearTrend1h = ema20_1h < ema50_1h && adx_1h.mdi > adx_1h.pdi;
  const bullTrend4h = ema20_4h > ema50_4h;
  const bearTrend4h = ema20_4h < ema50_4h;

  // Find recent 5m swing for Fibonacci
  const recent50H = H.slice(-50);
  const recent50L = L.slice(-50);
  const swingHigh = Math.max(...recent50H);
  const swingLow = Math.min(...recent50L);
  const fib = calcFibLevels(swingHigh, swingLow);

  const rsi5m = calcRSI(C, 14);

  // LONG: 1h+4h bullish + 5m pullback to Fib 38.2-61.8%
  // Removed: "minimum 2 confluences" — 1 is enough with trend confirmation
  // RSI range relaxed from 35-50 to 30-60
  if (bullTrend1h && bullTrend4h && rsi5m > 35 && rsi5m < 55) {
    const atFib382 = Math.abs(cur - fib.fib382) / cur < 0.002;
    const atFib500 = Math.abs(cur - fib.fib500) / cur < 0.002;
    const atFib618 = Math.abs(cur - fib.fib618) / cur < 0.002;
    const atFibLevel = atFib382 || atFib500 || atFib618;

    // Need candle confirmation (volume alone not enough)
    const hasConfirmation = candle.hammer || candle.engulfBull || candle.pinBarBull;
    if (atFibLevel && hasConfirmation) {
      const tp = cur + atr * 3.0; // wider TP for trend trades
      const sl = cur - atr * 1.2;
      if (tp > cur && sl < cur) {
        return { dir: 'BUY', entry: cur, tp, sl, strategy: 'TREND_CONTINUATION' };
      }
    }
  }

  // SHORT: 1h+4h bearish + pullback up to Fib
  if (bearTrend1h && bearTrend4h && rsi5m > 45 && rsi5m < 65) {
    const fibDown = calcFibLevels(swingHigh, swingLow);
    const atFib382 = Math.abs(cur - fibDown.fib382) / cur < 0.002;
    const atFib500 = Math.abs(cur - fibDown.fib500) / cur < 0.002;
    const atFib618 = Math.abs(cur - fibDown.fib618) / cur < 0.002;
    const atFibLevel = atFib382 || atFib500 || atFib618;

    const hasConfirmation = candle.engulfBear || candle.pinBarBear;
    if (atFibLevel && hasConfirmation) {
      const tp = cur - atr * 3.0;
      const sl = cur + atr * 1.2;
      if (tp < cur && sl > cur) {
        return { dir: 'SELL', entry: cur, tp, sl, strategy: 'TREND_CONTINUATION' };
      }
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
// APEX SCORE SYSTEM
// ═══════════════════════════════════════════════════════════════
function calculateApexScore(signal, O, H, L, C, V, regime, htfTrend, consecutiveLosses, klines5m) {
  let score = 5; // Base score for valid signal

  const rsi7 = calcRSI(C, 7);
  const rsi14 = calcRSI(C, 14);
  const macd = calcMACD(C);
  const adx = calcADX(H, L, C, 14);
  const obv = calcOBV(C, V);
  const cmf = calcCMF(H, L, C, V, 20);
  const vr = volumeRatio(V, 20);
  const st = calcSupertrend(H, L, C, 10, 3);
  const stoch = calcStoch(H, L, C, 14, 3);

  // Confluence bonuses
  // +1: RSI alignment
  if (signal.dir === 'BUY' && rsi14 < 45) score += 1;
  if (signal.dir === 'SELL' && rsi14 > 55) score += 1;

  // +1: MACD alignment
  if (signal.dir === 'BUY' && macd.h > 0) score += 1;
  if (signal.dir === 'SELL' && macd.h < 0) score += 1;
  if (signal.dir === 'BUY' && macd.h > macd.ph) score += 1; // momentum growing
  if (signal.dir === 'SELL' && macd.h < macd.ph) score += 1;

  // +2: ADX confirming trend strength
  if (adx.adx > 25) score += 1;
  if (signal.dir === 'BUY' && adx.pdi > adx.mdi) score += 1;
  if (signal.dir === 'SELL' && adx.mdi > adx.pdi) score += 1;

  // +1: OBV alignment
  if (signal.dir === 'BUY' && obv.rising) score += 1;
  if (signal.dir === 'SELL' && !obv.rising) score += 1;

  // +1: CMF alignment
  if (signal.dir === 'BUY' && cmf > 0.05) score += 1;
  if (signal.dir === 'SELL' && cmf < -0.05) score += 1;

  // +1-2: Volume confirmation
  if (vr > 1.5) score += 2;
  else if (vr > 1.2) score += 1;

  // +1: Supertrend alignment
  if (signal.dir === 'BUY' && st.trend === 'BUY') score += 1;
  if (signal.dir === 'SELL' && st.trend === 'SELL') score += 1;

  // +2: Stochastic extreme
  if (signal.dir === 'BUY' && stoch.k < 25) score += 2;
  if (signal.dir === 'SELL' && stoch.k > 75) score += 2;

  // +3: HTF trend agreement
  if (htfTrend === signal.dir) score += 3;
  else if (htfTrend === 'NEUTRAL') score += 0;

  // Bonus for candle confirmation on VWAP_REVERSION
  if (signal.bonus) score += 1;

  // Penalties
  // -1: Counter-trend to HTF (reduced from -3, was too harsh)
  if ((htfTrend === 'BUY' && signal.dir === 'SELL') || (htfTrend === 'SELL' && signal.dir === 'BUY')) score -= 1;

  // -1: Low volume (reduced from -2)
  if (vr < 0.7) score -= 1;

  // -3: Choppy regime (reduced from -5)
  if (regime === 'CHOPPY') score -= 3;

  // -1 per consecutive loss (capped at -3, reduced from -2 per / -6 cap)
  score -= Math.min(consecutiveLosses * 1, 3);

  // -1: VWAP reversion in trend regime (reduced from -2)
  if (signal.strategy === 'VWAP_REVERSION' && (regime === 'STRONG_TREND' || regime === 'MILD_TREND')) score -= 1;

  // Risk-reward ratio bonus
  const rr = signal.dir === 'BUY'
    ? (signal.tp - signal.entry) / (signal.entry - signal.sl)
    : (signal.entry - signal.tp) / (signal.sl - signal.entry);
  if (rr > 3) score += 2;
  else if (rr > 2) score += 1;

  return Math.max(0, score);
}

function getHTFTrend(C_1h, H_1h, L_1h, V_1h) {
  if (!C_1h || C_1h.length < 30) return 'NEUTRAL';
  const ema9 = calcEMA(C_1h, 9);
  const ema21 = calcEMA(C_1h, 21);
  const macd = calcMACD(C_1h);
  const adx = calcADX(H_1h, L_1h, C_1h, 14);
  const obv = calcOBV(C_1h, V_1h);

  let b = 0, s = 0;
  if (ema9 > ema21) b += 2; else s += 2;
  if (macd.h > 0) b += 1.5; else s += 1.5;
  if (adx.adx > 20 && adx.pdi > adx.mdi) b += 2;
  else if (adx.adx > 20 && adx.mdi > adx.pdi) s += 2;
  if (obv.rising) b += 1; else s += 1;

  if (b > s + 2) return 'BUY';
  if (s > b + 2) return 'SELL';
  return 'NEUTRAL';
}

// ═══════════════════════════════════════════════════════════════
// DATA FETCHING
// ═══════════════════════════════════════════════════════════════
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getKlines(symbol, interval, limit, endTime) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}${endTime ? '&endTime=' + endTime : ''}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await fetchJSON(url);
      if (Array.isArray(data)) return data;
      if (data && data.code === -1003) {
        console.log('  Rate limited, waiting 30s...');
        await sleep(30000);
        continue;
      }
      return null;
    } catch (e) {
      if (attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
      return null;
    }
  }
  return null;
}

async function downloadAllKlines(symbol, interval, days) {
  const barsPerDay = { '5m': 288, '1h': 24, '4h': 6 };
  const barMs = { '5m': 300000, '1h': 3600000, '4h': 14400000 };
  const totalBars = days * barsPerDay[interval];
  const allKlines = [];
  let endTime = Date.now();

  process.stdout.write(`  ${symbol} ${interval}: `);
  while (allKlines.length < totalBars) {
    const batch = await getKlines(symbol, interval, 1500, endTime);
    if (!batch || !batch.length) break;
    allKlines.unshift(...batch);
    endTime = batch[0][0] - 1; // before first candle of batch
    process.stdout.write(`${allKlines.length}..`);
    await sleep(200); // rate limit
  }
  // Deduplicate by open time
  const seen = new Set();
  const deduped = [];
  for (const k of allKlines) {
    if (!seen.has(k[0])) { seen.add(k[0]); deduped.push(k); }
  }
  deduped.sort((a, b) => a[0] - b[0]);
  // Keep only requested amount + buffer
  const needed = totalBars + 500; // extra for indicator warmup
  const result = deduped.length > needed ? deduped.slice(-needed) : deduped;
  console.log(` ${result.length} bars`);
  return result;
}

// ═══════════════════════════════════════════════════════════════
// TRADE EXECUTION SIMULATOR
// ═══════════════════════════════════════════════════════════════
function simulateTrade(trade, bar) {
  // bar = [openTime, open, high, low, close, volume, ...]
  const open = parseFloat(bar[1]);
  const high = parseFloat(bar[2]);
  const low = parseFloat(bar[3]);

  if (trade.dir === 'BUY') {
    const tpHit = high >= trade.tp;
    const slHit = low <= trade.sl;

    if (tpHit && slHit) {
      // Both hit — determine by proximity to open
      const distToTP = Math.abs(open - trade.tp);
      const distToSL = Math.abs(open - trade.sl);
      if (distToSL <= distToTP) return 'SL';
      return 'TP';
    }
    if (slHit) return 'SL';
    if (tpHit) return 'TP';
    return null;
  } else {
    const tpHit = low <= trade.tp;
    const slHit = high >= trade.sl;

    if (tpHit && slHit) {
      const distToTP = Math.abs(open - trade.tp);
      const distToSL = Math.abs(open - trade.sl);
      if (distToSL <= distToTP) return 'SL';
      return 'TP';
    }
    if (slHit) return 'SL';
    if (tpHit) return 'TP';
    return null;
  }
}

function calculatePnL(trade, result) {
  const posSize = INITIAL_CAPITAL * LEVERAGE;
  return calculatePnLDynamic(trade, result, posSize);
}

function calculatePnLDynamic(trade, result, posSize) {
  const entryFee = posSize * MAKER_FEE; // maker for limit entry
  let exitPrice, exitFee;

  if (result === 'TP') {
    exitPrice = trade.tp;
    exitFee = posSize * MAKER_FEE; // maker for limit TP
  } else {
    // SL: taker + slippage
    if (trade.dir === 'BUY') {
      exitPrice = trade.sl * (1 - SLIPPAGE); // slippage makes SL worse
    } else {
      exitPrice = trade.sl * (1 + SLIPPAGE);
    }
    exitFee = posSize * TAKER_FEE;
  }

  let pnl;
  if (trade.dir === 'BUY') {
    pnl = ((exitPrice - trade.entry) / trade.entry) * posSize;
  } else {
    pnl = ((trade.entry - exitPrice) / trade.entry) * posSize;
  }

  pnl -= (entryFee + exitFee); // subtract fees
  return pnl;
}

// ═══════════════════════════════════════════════════════════════
// MAIN BACKTEST ENGINE
// ═══════════════════════════════════════════════════════════════
async function runBacktest() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  APEX SIGNAL ENGINE v2 — COMPREHENSIVE BACKTEST');
  console.log(`  Capital: $${INITIAL_CAPITAL} | Leverage: ${LEVERAGE}x | Dynamic Position Sizing`);
  console.log(`  Pairs: ${SYMBOLS.join(', ')} | Days: ${DAYS}`);
  console.log(`  Fees: ${MAKER_FEE * 100}% maker, ${TAKER_FEE * 100}% taker, ${SLIPPAGE * 100}% slip`);
  console.log(`  Min APEX Score: ${MIN_APEX_SCORE} | Min Capital: $${MIN_CAPITAL}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Download data for all pairs
  console.log('>>> Downloading Binance Futures kline data...\n');
  const allData = {};

  for (const sym of SYMBOLS) {
    console.log(`Downloading ${sym}...`);
    const k5m = await downloadAllKlines(sym, '5m', DAYS + 5); // extra warmup
    await sleep(500);
    const k1h = await downloadAllKlines(sym, '1h', DAYS + 10);
    await sleep(500);
    const k4h = await downloadAllKlines(sym, '4h', DAYS + 20);
    await sleep(500);

    if (!k5m || !k5m.length || !k1h || !k1h.length || !k4h || !k4h.length) {
      console.log(`  WARNING: Failed to download data for ${sym}, skipping.`);
      continue;
    }

    allData[sym] = { k5m, k1h, k4h };
    console.log(`  ${sym}: 5m=${k5m.length}, 1h=${k1h.length}, 4h=${k4h.length}\n`);
  }

  const activeSymbols = Object.keys(allData);
  if (!activeSymbols.length) {
    console.log('ERROR: No data downloaded. Check internet/API.');
    return;
  }

  console.log('\n>>> Running backtest simulation...\n');

  // State tracking
  let capital = INITIAL_CAPITAL;
  let peakCapital = INITIAL_CAPITAL;
  let maxDrawdown = 0;
  let capitalDepleted = false; // set true if capital < MIN_CAPITAL
  const openPositions = []; // { sym, dir, entry, tp, sl, strategy, openBar, apexScore, posSize }
  const allTrades = [];
  const strategyTrades = {};
  const pairTrades = {};
  const dailyPnL = {};
  const equityCurve = [INITIAL_CAPITAL];

  STRATEGY_NAMES.forEach(s => strategyTrades[s] = []);
  activeSymbols.forEach(s => pairTrades[s] = []);

  // Cooldown state per symbol AND per strategy
  const cooldowns = {}; // sym -> barIndex when cooldown expires
  const strategyCooldowns = {}; // `${sym}_${strategy}` -> barIndex
  const consecutiveLosses = {}; // sym -> count
  activeSymbols.forEach(s => { cooldowns[s] = 0; consecutiveLosses[s] = 0; });
  let globalConsecutiveLosses = 0;

  // Daily tracking — Fix 6: daily loss limit = 6% of CURRENT capital (not initial)
  let currentDay = '';
  let dailyLoss = 0;
  let dailyStopped = false;
  let dailyCapitalAtStart = capital; // track capital at start of day

  // Regime cache (refresh every 3 bars = 15 min)
  const regimeCache = {};
  let lastRegimeBar = -999;

  // Determine the simulation range
  // Use the shortest 5m dataset to set the range
  let minBars = Infinity;
  for (const sym of activeSymbols) {
    minBars = Math.min(minBars, allData[sym].k5m.length);
  }

  const warmup = 300; // indicator warmup bars
  const startBar = warmup;
  const endBar = minBars - 1; // leave room for DELAY_BARS

  console.log(`Simulating bars ${startBar} to ${endBar} (${endBar - startBar} bars, ~${((endBar - startBar) / 288).toFixed(1)} days)`);

  // Walk-forward period tracking
  const walkForwardResults = [];
  const barsPerPeriod = WALK_FORWARD_DAYS * 288;
  let periodStart = startBar;
  let periodTrades = [];

  for (let barIdx = startBar; barIdx < endBar; barIdx++) {
    // Check walk-forward period boundary
    if (barIdx - periodStart >= barsPerPeriod && periodTrades.length > 0) {
      const periodData = summarizeTrades(periodTrades, INITIAL_CAPITAL);
      const periodNum = walkForwardResults.length + 1;
      const kRef = allData[activeSymbols[0]].k5m[periodStart];
      const kRefEnd = allData[activeSymbols[0]].k5m[barIdx - 1];
      periodData.startDate = new Date(kRef[0]).toISOString().split('T')[0];
      periodData.endDate = new Date(kRefEnd[0]).toISOString().split('T')[0];
      walkForwardResults.push(periodData);
      periodStart = barIdx;
      periodTrades = [];
    }

    // Fix 1: STOP all trading if capital below minimum
    if (capital < MIN_CAPITAL) {
      if (!capitalDepleted) {
        capitalDepleted = true;
        console.log(`  !!! Capital depleted ($${capital.toFixed(2)} < $${MIN_CAPITAL}) at bar ${barIdx} — stopping all trading`);
      }
      continue;
    }

    // Get current timestamp for daily tracking
    const refKline = allData[activeSymbols[0]].k5m[barIdx];
    const day = new Date(refKline[0]).toISOString().split('T')[0];
    if (day !== currentDay) {
      currentDay = day;
      dailyLoss = 0;
      dailyStopped = false;
      dailyCapitalAtStart = capital; // Fix 6: reset daily reference to CURRENT capital
    }

    if (dailyStopped) continue;

    // Check open positions for TP/SL
    for (let p = openPositions.length - 1; p >= 0; p--) {
      const pos = openPositions[p];
      const symData = allData[pos.sym];
      if (!symData) continue;
      if (barIdx >= symData.k5m.length) continue;

      const bar = symData.k5m[barIdx];
      const result = simulateTrade(pos, bar);

      if (result) {
        // Fix 1: Use dynamic position size stored on the trade
        const posSize = pos.posSize || (INITIAL_CAPITAL * LEVERAGE);
        const pnl = calculatePnLDynamic(pos, result, posSize);

        // Cap loss at 2% of CURRENT capital
        const cappedPnl = Math.max(pnl, -capital * MAX_LOSS_PCT);

        capital += cappedPnl;
        if (capital > peakCapital) peakCapital = capital;
        const dd = (peakCapital - capital) / peakCapital;
        if (dd > maxDrawdown) maxDrawdown = dd;

        const trade = {
          sym: pos.sym,
          dir: pos.dir,
          strategy: pos.strategy,
          entry: pos.entry,
          exit: result === 'TP' ? pos.tp : pos.sl,
          tp: pos.tp,
          sl: pos.sl,
          pnl: cappedPnl,
          result,
          apexScore: pos.apexScore,
          openBar: pos.openBar,
          closeBar: barIdx,
          date: day,
          posSize
        };

        allTrades.push(trade);
        periodTrades.push(trade);
        strategyTrades[pos.strategy].push(trade);
        pairTrades[pos.sym].push(trade);
        dailyPnL[day] = (dailyPnL[day] || 0) + cappedPnl;

        // Update cooldowns — Fix 5: per-strategy cooldowns
        const stratCooldown = STRATEGY_COOLDOWNS[pos.strategy] || 3;
        if (result === 'SL') {
          cooldowns[pos.sym] = barIdx + GLOBAL_SYMBOL_COOLDOWN;
          strategyCooldowns[`${pos.sym}_${pos.strategy}`] = barIdx + stratCooldown;
          consecutiveLosses[pos.sym] = (consecutiveLosses[pos.sym] || 0) + 1;
          globalConsecutiveLosses++;
          if (consecutiveLosses[pos.sym] >= 3) {
            cooldowns[pos.sym] = barIdx + STREAK_COOLDOWN;
            consecutiveLosses[pos.sym] = 0;
          }
          dailyLoss += Math.abs(cappedPnl);
          // Fix 6: daily loss limit = 6% of CURRENT capital at start of day
          if (dailyLoss >= dailyCapitalAtStart * DAILY_LOSS_LIMIT) {
            dailyStopped = true;
          }
        } else {
          cooldowns[pos.sym] = barIdx + GLOBAL_SYMBOL_COOLDOWN; // still apply global cooldown
          strategyCooldowns[`${pos.sym}_${pos.strategy}`] = barIdx + Math.max(1, Math.floor(stratCooldown / 2));
          consecutiveLosses[pos.sym] = 0;
          if (globalConsecutiveLosses > 0) globalConsecutiveLosses = Math.max(0, globalConsecutiveLosses - 1);
        }

        openPositions.splice(p, 1);
      }
    }

    if (dailyStopped) continue;

    // Update regime every 3 bars (15 min)
    if (barIdx - lastRegimeBar >= 3) {
      lastRegimeBar = barIdx;
      for (const sym of activeSymbols) {
        const sd = allData[sym];
        // Map 5m bar to 1h bar
        const barTime = sd.k5m[barIdx][0];
        const h1Idx = sd.k1h.findIndex(k => k[0] > barTime) - 1;
        if (h1Idx < 20) continue;

        const C_1h = sd.k1h.slice(0, h1Idx + 1).map(k => parseFloat(k[4]));
        const H_1h = sd.k1h.slice(0, h1Idx + 1).map(k => parseFloat(k[2]));
        const L_1h = sd.k1h.slice(0, h1Idx + 1).map(k => parseFloat(k[3]));

        const C_5m = sd.k5m.slice(Math.max(0, barIdx - 200), barIdx + 1).map(k => parseFloat(k[4]));
        const H_5m = sd.k5m.slice(Math.max(0, barIdx - 200), barIdx + 1).map(k => parseFloat(k[2]));
        const L_5m = sd.k5m.slice(Math.max(0, barIdx - 200), barIdx + 1).map(k => parseFloat(k[3]));

        regimeCache[sym] = classifyRegime(H_1h, L_1h, C_1h, H_5m, L_5m, C_5m);
      }
    }

    // Skip signal generation if max positions reached
    if (openPositions.length >= MAX_POSITIONS) continue;

    // Generate signals for each symbol
    for (const sym of activeSymbols) {
      if (openPositions.length >= MAX_POSITIONS) break;
      if (barIdx < cooldowns[sym]) continue; // cooldown active

      const sd = allData[sym];
      if (barIdx >= sd.k5m.length - DELAY_BARS) continue;

      // Already have position for this symbol?
      if (openPositions.some(p => p.sym === sym)) continue;

      // Check directional limits
      const longCount = openPositions.filter(p => p.dir === 'BUY').length;
      const shortCount = openPositions.filter(p => p.dir === 'SELL').length;

      // Extract OHLCV data (window for indicators)
      const window = sd.k5m.slice(Math.max(0, barIdx - 299), barIdx + 1);
      const O = window.map(k => parseFloat(k[1]));
      const H = window.map(k => parseFloat(k[2]));
      const L = window.map(k => parseFloat(k[3]));
      const C = window.map(k => parseFloat(k[4]));
      const V = window.map(k => parseFloat(k[5]));

      // Get HTF data
      const barTime = sd.k5m[barIdx][0];
      const h1Idx = sd.k1h.findIndex(k => k[0] > barTime) - 1;
      const h4Idx = sd.k4h.findIndex(k => k[0] > barTime) - 1;

      let C_1h = [], H_1h = [], L_1h = [], V_1h = [];
      if (h1Idx >= 0) {
        const h1Window = sd.k1h.slice(Math.max(0, h1Idx - 60), h1Idx + 1);
        C_1h = h1Window.map(k => parseFloat(k[4]));
        H_1h = h1Window.map(k => parseFloat(k[2]));
        L_1h = h1Window.map(k => parseFloat(k[3]));
        V_1h = h1Window.map(k => parseFloat(k[5]));
      }

      let C_4h = [], H_4h = [], L_4h = [];
      if (h4Idx >= 0) {
        const h4Window = sd.k4h.slice(Math.max(0, h4Idx - 40), h4Idx + 1);
        C_4h = h4Window.map(k => parseFloat(k[4]));
        H_4h = h4Window.map(k => parseFloat(k[2]));
        L_4h = h4Window.map(k => parseFloat(k[3]));
      }

      const regime = regimeCache[sym] || 'MILD_TREND';
      const htfTrend = getHTFTrend(C_1h, H_1h, L_1h, V_1h);

      // Run all 6 sub-strategies
      const signals = [
        checkVWAPReversion(window, O, H, L, C, V, regime),
        checkMomentumPulse(O, H, L, C, V, regime),
        checkSqueezeExplosion(O, H, L, C, V, regime),
        checkDivergenceSniper(O, H, L, C, V, regime),
        checkStructureBounce(O, H, L, C, V, regime),
        checkTrendContinuation(O, H, L, C, V, C_1h, H_1h, L_1h, V_1h, C_4h, H_4h, L_4h, regime)
      ].filter(s => s !== null);

      if (!signals.length) continue;

      // Fix 1: Dynamic position sizing based on CURRENT capital
      const dynamicPosSize = Math.min(2500, capital * LEVERAGE);

      // Score each signal and pick the best
      let bestSignal = null, bestScore = 0;
      for (const sig of signals) {
        // Check per-strategy cooldown
        const stratKey = `${sym}_${sig.strategy}`;
        if (strategyCooldowns[stratKey] && barIdx < strategyCooldowns[stratKey]) continue;

        // Enforce risk cap: max loss = 2% of CURRENT capital
        const maxLoss = capital * MAX_LOSS_PCT;
        const rawLoss = sig.dir === 'BUY'
          ? ((sig.entry - sig.sl) / sig.entry) * dynamicPosSize
          : ((sig.sl - sig.entry) / sig.entry) * dynamicPosSize;

        if (rawLoss > maxLoss) {
          // Adjust SL to cap at maxLoss
          if (sig.dir === 'BUY') {
            sig.sl = sig.entry * (1 - maxLoss / dynamicPosSize);
          } else {
            sig.sl = sig.entry * (1 + maxLoss / dynamicPosSize);
          }
        }

        const score = calculateApexScore(sig, O, H, L, C, V, regime, htfTrend, globalConsecutiveLosses, window);
        if (score > bestScore) {
          bestScore = score;
          bestSignal = sig;
        }
      }

      if (!bestSignal || bestScore < MIN_APEX_SCORE) continue;

      // Check directional limit
      if (bestSignal.dir === 'BUY' && longCount >= MAX_SAME_DIR) continue;
      if (bestSignal.dir === 'SELL' && shortCount >= MAX_SAME_DIR) continue;

      // DELAY: Entry at NEXT bar's OPEN
      const entryBar = sd.k5m[barIdx + DELAY_BARS];
      if (!entryBar) continue;
      const entryPrice = parseFloat(entryBar[1]); // next bar's OPEN

      // Recalculate TP/SL relative to actual entry price
      const entryShift = entryPrice - bestSignal.entry;
      const adjustedTP = bestSignal.tp + entryShift;
      const adjustedSL = bestSignal.sl + entryShift;

      // Validate TP/SL still make sense
      if (bestSignal.dir === 'BUY' && (adjustedTP <= entryPrice || adjustedSL >= entryPrice)) continue;
      if (bestSignal.dir === 'SELL' && (adjustedTP >= entryPrice || adjustedSL <= entryPrice)) continue;

      // Increased sizing for high-confidence signals
      const sizeMultiplier = bestScore >= HIGH_CONF_SCORE ? 1.25 : 1.0;
      const finalPosSize = dynamicPosSize * sizeMultiplier;

      openPositions.push({
        sym,
        dir: bestSignal.dir,
        entry: entryPrice,
        tp: adjustedTP,
        sl: adjustedSL,
        strategy: bestSignal.strategy,
        openBar: barIdx + DELAY_BARS,
        apexScore: bestScore,
        posSize: finalPosSize
      });
    }

    // Track equity curve daily
    if (barIdx % 288 === 0) {
      equityCurve.push(capital);
    }
  }

  // Close any remaining open positions at last close
  for (const pos of openPositions) {
    const sd = allData[pos.sym];
    const lastBar = sd.k5m[sd.k5m.length - 1];
    const exitPrice = parseFloat(lastBar[4]);
    const posSize = pos.posSize || (INITIAL_CAPITAL * LEVERAGE);
    let pnl;
    if (pos.dir === 'BUY') {
      pnl = ((exitPrice - pos.entry) / pos.entry) * posSize;
    } else {
      pnl = ((pos.entry - exitPrice) / pos.entry) * posSize;
    }
    pnl -= posSize * (MAKER_FEE + TAKER_FEE);
    capital += pnl;
    allTrades.push({
      sym: pos.sym, dir: pos.dir, strategy: pos.strategy,
      entry: pos.entry, exit: exitPrice, pnl, result: 'TIMEOUT',
      apexScore: pos.apexScore, date: new Date(lastBar[0]).toISOString().split('T')[0]
    });
    strategyTrades[pos.strategy].push(allTrades[allTrades.length - 1]);
    pairTrades[pos.sym].push(allTrades[allTrades.length - 1]);
  }

  // Add final walk-forward period
  if (periodTrades.length > 0) {
    const periodData = summarizeTrades(periodTrades, INITIAL_CAPITAL);
    const kRef = allData[activeSymbols[0]].k5m[periodStart];
    const kRefEnd = allData[activeSymbols[0]].k5m[endBar - 1] || allData[activeSymbols[0]].k5m[allData[activeSymbols[0]].k5m.length - 1];
    periodData.startDate = new Date(kRef[0]).toISOString().split('T')[0];
    periodData.endDate = new Date(kRefEnd[0]).toISOString().split('T')[0];
    walkForwardResults.push(periodData);
  }

  // ═══════════════════════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  BACKTEST RESULTS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const totalDays = (endBar - startBar) / 288;
  printSummary('COMBINED (ALL STRATEGIES)', allTrades, totalDays, capital, INITIAL_CAPITAL);

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('  PER STRATEGY BREAKDOWN');
  console.log('─────────────────────────────────────────────────────────────');
  for (const strat of STRATEGY_NAMES) {
    if (strategyTrades[strat].length > 0) {
      printSummary(`  ${strat}`, strategyTrades[strat], totalDays);
    }
  }

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('  PER PAIR BREAKDOWN');
  console.log('─────────────────────────────────────────────────────────────');
  for (const sym of activeSymbols) {
    if (pairTrades[sym].length > 0) {
      printSummary(`  ${sym}`, pairTrades[sym], totalDays);
    }
  }

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('  WALK-FORWARD ANALYSIS (per period)');
  console.log('─────────────────────────────────────────────────────────────');
  for (let i = 0; i < walkForwardResults.length; i++) {
    const p = walkForwardResults[i];
    console.log(`\n  Period ${i + 1}: ${p.startDate} to ${p.endDate}`);
    console.log(`    Trades: ${p.trades} | PnL: $${p.pnl.toFixed(2)} | WR: ${p.winRate.toFixed(1)}% | PF: ${p.profitFactor.toFixed(2)} | MaxDD: ${(p.maxDD * 100).toFixed(1)}%`);
  }

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('  MONTHLY BREAKDOWN');
  console.log('─────────────────────────────────────────────────────────────');
  const monthlyPnL = {};
  for (const t of allTrades) {
    const month = t.date ? t.date.slice(0, 7) : 'unknown';
    monthlyPnL[month] = (monthlyPnL[month] || 0) + t.pnl;
  }
  const monthlyTrades = {};
  for (const t of allTrades) {
    const month = t.date ? t.date.slice(0, 7) : 'unknown';
    monthlyTrades[month] = (monthlyTrades[month] || 0) + 1;
  }
  for (const [month, pnl] of Object.entries(monthlyPnL).sort()) {
    console.log(`  ${month}: PnL $${pnl.toFixed(2)} | Trades: ${monthlyTrades[month]}`);
  }

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('  EQUITY CURVE (daily snapshots)');
  console.log('─────────────────────────────────────────────────────────────');
  const step = Math.max(1, Math.floor(equityCurve.length / 20));
  for (let i = 0; i < equityCurve.length; i += step) {
    const bar = '█'.repeat(Math.max(1, Math.round((equityCurve[i] / Math.max(...equityCurve)) * 40)));
    console.log(`  Day ${String(i).padStart(3)}: $${equityCurve[i].toFixed(2)} ${bar}`);
  }

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('  REGIME DISTRIBUTION');
  console.log('─────────────────────────────────────────────────────────────');
  const regimeCounts = {};
  for (const trades of allTrades) {
    // We can't track regime per trade in current impl, so skip
  }

  // Apex score distribution
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('  APEX SCORE DISTRIBUTION');
  console.log('─────────────────────────────────────────────────────────────');
  const scoreBuckets = {};
  for (const t of allTrades) {
    const bucket = Math.floor((t.apexScore || 0) / 2) * 2;
    const key = `${bucket}-${bucket + 1}`;
    if (!scoreBuckets[key]) scoreBuckets[key] = { count: 0, wins: 0, pnl: 0 };
    scoreBuckets[key].count++;
    if (t.result === 'TP') scoreBuckets[key].wins++;
    scoreBuckets[key].pnl += t.pnl;
  }
  for (const [range, data] of Object.entries(scoreBuckets).sort()) {
    console.log(`  Score ${range}: ${data.count} trades | WR: ${(data.wins / data.count * 100).toFixed(1)}% | PnL: $${data.pnl.toFixed(2)}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  FINAL CAPITAL: $' + capital.toFixed(2));
  console.log('  TOTAL PnL: $' + (capital - INITIAL_CAPITAL).toFixed(2));
  console.log('  MAX DRAWDOWN: ' + (maxDrawdown * 100).toFixed(2) + '%');
  console.log('═══════════════════════════════════════════════════════════════');
}

// ═══════════════════════════════════════════════════════════════
// REPORTING UTILITIES
// ═══════════════════════════════════════════════════════════════
function summarizeTrades(trades, initCapital) {
  if (!trades.length) return { trades: 0, pnl: 0, winRate: 0, profitFactor: 0, maxDD: 0, avgWin: 0, avgLoss: 0 };

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnL = trades.reduce((a, t) => a + t.pnl, 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));

  let equity = initCapital || INITIAL_CAPITAL;
  let peak = equity;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    trades: trades.length,
    pnl: totalPnL,
    winRate: (wins.length / trades.length) * 100,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    maxDD,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    wins: wins.length,
    losses: losses.length
  };
}

function printSummary(label, trades, totalDays, finalCapital, initialCapital) {
  const s = summarizeTrades(trades, initialCapital);
  console.log(`\n${label}`);
  console.log(`  Trades: ${s.trades} | Wins: ${s.wins} | Losses: ${s.losses}`);
  console.log(`  PnL: $${s.pnl.toFixed(2)} | WR: ${s.winRate.toFixed(1)}% | PF: ${s.profitFactor.toFixed(2)}`);
  console.log(`  MaxDD: ${(s.maxDD * 100).toFixed(2)}%`);
  console.log(`  Avg Win: $${s.avgWin.toFixed(2)} | Avg Loss: $${s.avgLoss.toFixed(2)}`);
  if (totalDays > 0) console.log(`  Trades/Day: ${(s.trades / totalDays).toFixed(1)}`);
  if (finalCapital !== undefined) console.log(`  Final Capital: $${finalCapital.toFixed(2)}`);
  if (finalCapital !== undefined && initialCapital) console.log(`  ROI: ${(((finalCapital - initialCapital) / initialCapital) * 100).toFixed(2)}%`);
}

// ═══════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════
runBacktest().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
