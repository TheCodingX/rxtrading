#!/usr/bin/env node
/**
 * DEFINITIVE BACKTEST ENGINE — Real Binance data, exact logic replication
 * Tests all 3 signal engines over 14 days of 5m data
 * Usage: node backtest-definitive.js [strict|scalp|free|all]
 */

const https = require('https');

// ═══════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════
const CAPITAL = 10000;
const POSITION_SIZE = 500;
const LEVERAGE = 5;
const FEE_RATE = 0.0008; // 0.08% round-trip
const TIMEOUT_BARS = 50;  // 4h10m at 5m bars
const DAYS = 14;

const VIP_PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','AVAXUSDT','ADAUSDT','DOTUSDT','LINKUSDT','APTUSDT','NEARUSDT','FILUSDT','UNIUSDT','ARBUSDT','OPUSDT','SHIBUSDT','SUIUSDT','SEIUSDT','TIAUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT'];
const SCALP_PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','DOTUSDT','NEARUSDT','APTUSDT','ARBUSDT','OPUSDT','SUIUSDT','SEIUSDT','FILUSDT','UNIUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT','TIAUSDT','ATOMUSDT'];
const FREE_PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];

// Cooldowns in bars (5m each)
const COOLDOWN = { strict: 24, scalp: 6, free: 8 };

// ═══════════════════════════════════════════════════════
// INDICATOR CALCULATIONS (exact replication from app.html)
// ═══════════════════════════════════════════════════════
function calcRSI(closes, p = 14) {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l += Math.abs(d);
  }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? Math.abs(d) : 0)) / p;
  }
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}

function calcEMAArr(data, p) {
  const k = 2 / (p + 1);
  const r = [data[0]];
  for (let i = 1; i < data.length; i++) r.push(data[i] * k + r[i - 1] * (1 - k));
  return r;
}

function calcEMA(data, p) { return calcEMAArr(data, p).at(-1); }

function calcMACD(closes) {
  if (closes.length < 35) return { h: 0, ph: 0, macd: 0, sig: 0 };
  const e12 = calcEMAArr(closes, 12), e26 = calcEMAArr(closes, 26);
  const ml = e12.map((v, i) => v - e26[i]);
  const sl = calcEMAArr(ml, 9);
  return { h: ml.at(-1) - sl.at(-1), ph: (ml.at(-2) || 0) - (sl.at(-2) || sl.at(-1)), macd: ml.at(-1), sig: sl.at(-1) };
}

function calcBB(closes, p = 20, s = 2) {
  if (closes.length < p) return { u: 0, m: 0, l: 0 };
  const sl = closes.slice(-p);
  const m = sl.reduce((a, b) => a + b) / p;
  const sd = Math.sqrt(sl.reduce((a, b) => a + Math.pow(b - m, 2), 0) / p);
  return { u: m + s * sd, m, l: m - s * sd };
}

function calcStoch(H, L, C, kp = 14) {
  if (C.length < kp + 3) return { k: 50, d: 50 };
  const kArr = [];
  for (let i = kp; i <= C.length; i++) {
    const sh = H.slice(i - kp, i), sl = L.slice(i - kp, i);
    const hi = Math.max(...sh), lo = Math.min(...sl);
    kArr.push(hi === lo ? 50 : ((C[i - 1] - lo) / (hi - lo)) * 100);
  }
  const dArr = [];
  for (let i = 2; i < kArr.length; i++) dArr.push((kArr[i] + kArr[i - 1] + kArr[i - 2]) / 3);
  return { k: kArr.at(-1) || 50, d: dArr.at(-1) || 50 };
}

function calcATR(H, L, C, p = 14) {
  if (C.length < p + 1) return 0;
  const trs = [];
  for (let i = 1; i < C.length; i++) trs.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
  if (trs.length < p) return trs.reduce((a, b) => a + b) / trs.length;
  let atr = trs.slice(0, p).reduce((a, b) => a + b) / p;
  for (let i = p; i < trs.length; i++) atr = (atr * (p - 1) + trs[i]) / p;
  return atr;
}

function wilderSmooth(arr, period) {
  if (arr.length < period) return arr.map(() => 0);
  const r = [];
  let s = arr.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = 0; i < period; i++) r.push(0);
  r[period - 1] = s;
  for (let i = period; i < arr.length; i++) { s = (s * (period - 1) + arr[i]) / period; r.push(s); }
  return r;
}

function calcADX(H, L, C, p = 14) {
  if (C.length < p * 2) return { adx: 15, pdi: 0, mdi: 0 };
  const pdm = [], mdm = [], tr = [];
  for (let i = 1; i < H.length; i++) {
    const upMove = H[i] - H[i - 1], dnMove = L[i - 1] - L[i];
    pdm.push(upMove > dnMove && upMove > 0 ? upMove : 0);
    mdm.push(dnMove > upMove && dnMove > 0 ? dnMove : 0);
    tr.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
  }
  const smTR = wilderSmooth(tr, p), smPDM = wilderSmooth(pdm, p), smMDM = wilderSmooth(mdm, p);
  const pdi = smPDM.map((v, i) => smTR[i] ? v / smTR[i] * 100 : 0);
  const mdi = smMDM.map((v, i) => smTR[i] ? v / smTR[i] * 100 : 0);
  const dx = pdi.map((v, i) => { const s = v + mdi[i]; return s ? Math.abs(v - mdi[i]) / s * 100 : 0; });
  const dxValid = dx.slice(p - 1);
  const adxArr = dxValid.length >= p ? wilderSmooth(dxValid, p) : dxValid;
  return { adx: adxArr.at(-1) || 15, pdi: pdi.at(-1) || 0, mdi: mdi.at(-1) || 0 };
}

function calcOBV(C, V) {
  if (C.length < 2) return { obv: 0, slope: 0, rising: false };
  let obv = 0; const arr = [0];
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
  return { obv: arr.at(-1), slope, rising: slope > 0 };
}

function calcKeltner(H, L, C, emaLen = 20, atrLen = 14, mult = 2) {
  if (C.length < Math.max(emaLen, atrLen) + 1) return { upper: 0, mid: 0, lower: 0, width: 0, position: 0.5 };
  const mid = calcEMA(C, emaLen);
  const atr = calcATR(H, L, C, atrLen);
  const upper = mid + mult * atr;
  const lower = mid - mult * atr;
  const width = upper - lower;
  const position = width > 0 ? (C.at(-1) - lower) / width : 0.5;
  return { upper, mid, lower, width, position };
}

function calcVWAP(klines) {
  let cumVol = 0, cumVolPrice = 0;
  const vwapArr = [];
  for (const k of klines) {
    const typPrice = (parseFloat(k[2]) + parseFloat(k[3]) + parseFloat(k[4])) / 3;
    const vol = parseFloat(k[5]);
    cumVol += vol; cumVolPrice += (typPrice * vol);
    vwapArr.push(cumVolPrice / cumVol);
  }
  return vwapArr;
}

function calcParabolicSAR(H, L, C) {
  if (C.length < 5) return { sar: C.at(-1), trend: 'BUY', recentFlip: false };
  let af = 0.02, maxAf = 0.2, sar = L[0], ep = H[0], isUp = true;
  let lastFlipIdx = 0;
  for (let i = 1; i < C.length; i++) {
    const pSar = sar + af * (ep - sar);
    if (isUp) {
      sar = Math.min(pSar, L[i - 1], i > 1 ? L[i - 2] : L[i - 1]);
      if (L[i] < sar) { isUp = false; sar = ep; ep = L[i]; af = 0.02; lastFlipIdx = i; }
      else { if (H[i] > ep) { ep = H[i]; af = Math.min(af + 0.02, maxAf); } sar = pSar; }
    } else {
      sar = Math.max(pSar, H[i - 1], i > 1 ? H[i - 2] : H[i - 1]);
      if (H[i] > sar) { isUp = true; sar = ep; ep = H[i]; af = 0.02; lastFlipIdx = i; }
      else { if (L[i] < ep) { ep = L[i]; af = Math.min(af + 0.02, maxAf); } sar = pSar; }
    }
  }
  const recentFlip = (C.length - 1 - lastFlipIdx) <= 5;
  return { sar, trend: isUp ? 'BUY' : 'SELL', recentFlip };
}

function detectRSIDivergence(C, H, L, period = 14) {
  if (C.length < period + 25) return { bull: false, bear: false };
  // Simplified divergence: compare last two swing lows/highs with RSI
  const rsiArr = [];
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = C[i] - C[i - 1];
    if (d > 0) ag += d; else al += Math.abs(d);
  }
  ag /= period; al /= period;
  rsiArr.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
  for (let i = period + 1; i < C.length; i++) {
    const d = C[i] - C[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    rsiArr.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
  }

  // Find swing lows and highs in last 30 bars
  const lookback = Math.min(30, L.length - 5);
  const start = L.length - lookback;
  let bull = false, bear = false;

  // Bullish divergence: price makes lower low, RSI makes higher low
  for (let i = start + 5; i < L.length - 3; i++) {
    if (L[i] < L[i - 3] && L[i] < L[i + 3]) {
      // Found a swing low at i
      for (let j = i + 5; j < Math.min(i + 20, L.length - 1); j++) {
        if (j + 2 < L.length && L[j] < L[j - 2] && L[j] < L[j + 2]) {
          const rsiI = rsiArr[i - period] || 50;
          const rsiJ = rsiArr[j - period] || 50;
          if (L[j] < L[i] && rsiJ > rsiI) { bull = true; break; }
        }
      }
    }
    if (bull) break;
  }

  // Bearish divergence: price makes higher high, RSI makes lower high
  for (let i = start + 5; i < H.length - 3; i++) {
    if (H[i] > H[i - 3] && H[i] > H[i + 3]) {
      for (let j = i + 5; j < Math.min(i + 20, H.length - 1); j++) {
        if (j + 2 < H.length && H[j] > H[j - 2] && H[j] > H[j + 2]) {
          const rsiI = rsiArr[i - period] || 50;
          const rsiJ = rsiArr[j - period] || 50;
          if (H[j] > H[i] && rsiJ < rsiI) { bear = true; break; }
        }
      }
    }
    if (bear) break;
  }

  return { bull, bear };
}

function detectMACDDivergence(C) {
  if (C.length < 40) return { bull: false, bear: false };
  const mac = calcMACD(C);
  // Simple check: if MACD histogram is near zero crossing and price diverges
  const bull = mac.h > mac.ph && mac.h < 0 && C.at(-1) < C.at(-5);
  const bear = mac.h < mac.ph && mac.h > 0 && C.at(-1) > C.at(-5);
  return { bull, bear };
}

function detectRegime(H, L, C, adxPre, atrPre) {
  const adx = adxPre || calcADX(H, L, C);
  const atr = atrPre || calcATR(H, L, C, 14);
  const avgP = C.slice(-20).reduce((a, b) => a + b) / 20;
  const atrPct = atr / avgP * 100;
  if (adx.adx > 25 && atrPct > 1.5) return { regime: 'TRENDING', label: 'TENDENCIA FUERTE', cls: 'trending' };
  if (adx.adx < 20 && atrPct < 0.8) return { regime: 'QUIET', label: 'MERCADO QUIETO', cls: 'quiet' };
  if (atrPct > 2) return { regime: 'VOLATILE', label: 'ALTA VOLATILIDAD', cls: 'volatile' };
  return { regime: 'RANGING', label: 'RANGO LATERAL', cls: 'ranging' };
}

function detectOrderBlocks(H, L, C, V, lookback = 50) {
  if (C.length < lookback) return { bullOB: null, bearOB: null };
  const tail = C.length - lookback;
  let bullOB = null, bearOB = null;
  const avgV = V.slice(tail).reduce((a, b) => a + b) / (lookback || 1);
  for (let i = tail + 2; i < C.length - 1; i++) {
    const body = Math.abs(C[i] - C[i - 1]);
    const prevBody = Math.abs(C[i - 1] - C[i - 2]);
    const isImbalance = prevBody > 0 && body > prevBody * 2;
    const isHighVol = V[i] > avgV * 1.5;
    if (isImbalance && isHighVol) {
      if (C[i] > C[i - 1]) { bullOB = { price: Math.min(C[i - 1], L[i]), high: H[i], idx: i }; }
      else { bearOB = { price: Math.max(C[i - 1], H[i]), low: L[i], idx: i }; }
    }
  }
  const cur = C.at(-1);
  const atr = calcATR(H, L, C, 14);
  if (bullOB && (cur - bullOB.price) > atr * 2) bullOB = null;
  if (bullOB && (bullOB.price - cur) > atr * 1) bullOB = null;
  if (bearOB && (bearOB.price - cur) > atr * 2) bearOB = null;
  if (bearOB && (cur - bearOB.price) > atr * 1) bearOB = null;
  return { bullOB, bearOB };
}

function findPivotLevels(H, L, C, lookback = 50) {
  const start = Math.max(0, C.length - lookback);
  const cur = C.at(-1);
  let nearestSup = null, nearestRes = null;
  for (let i = start + 2; i < C.length - 2; i++) {
    if (L[i] < L[i - 1] && L[i] < L[i - 2] && L[i] < L[i + 1] && L[i] < L[i + 2]) {
      if (L[i] < cur && (!nearestSup || L[i] > nearestSup)) nearestSup = L[i];
    }
    if (H[i] > H[i - 1] && H[i] > H[i - 2] && H[i] > H[i + 1] && H[i] > H[i + 2]) {
      if (H[i] > cur && (!nearestRes || H[i] < nearestRes)) nearestRes = H[i];
    }
  }
  return { nearestSup, nearestRes };
}

// ═══════════════════════════════════════════════════════
// SIGNAL GENERATION — Exact replication of app.html genSig()
// ═══════════════════════════════════════════════════════
function generateSignal(C5, H5, L5, V5, C15, H15, L15, V15, C1h, H1h, L1h, V1h, kl5raw, hourUTC, mode) {
  const isStrict = (mode === 'strict');
  const isScalp = (mode === 'scalp');
  const cur = C5.at(-1);
  let B = 0, S = 0;
  const inds = [];

  // STEP 1: HTF Trend (1H)
  let htfTrend = 'NEUTRAL', htfStrength = 0;
  if (C1h.length > 25) {
    const ema9h = calcEMA(C1h, 9), ema21h = calcEMA(C1h, 21), ema50h = calcEMA(C1h, 50);
    const rsi1h = calcRSI(C1h, 14);
    const mac1h = calcMACD(C1h);
    const adx1h = calcADX(H1h, L1h, C1h);
    const obv1h = calcOBV(C1h, V1h);
    let hB = 0, hS = 0;
    if (ema9h > ema21h) hB += 2; else hS += 2;
    if (C1h.at(-1) > ema50h) hB += 1; else hS += 1;
    if (mac1h.h > 0) hB += 1.5; else hS += 1.5;
    if (mac1h.h > mac1h.ph) hB += 1; else hS += 1;
    if (rsi1h > 50) hB += 1; else hS += 1;
    if (adx1h.adx > 20 && adx1h.pdi > adx1h.mdi) hB += 1.5;
    else if (adx1h.adx > 20 && adx1h.mdi > adx1h.pdi) hS += 1.5;
    if (obv1h.rising) hB += 1; else hS += 1;
    if (hB > hS + 2) { htfTrend = 'BUY'; htfStrength = hB - hS; }
    else if (hS > hB + 2) { htfTrend = 'SELL'; htfStrength = hS - hB; }
  }

  // STEP 2: MTF Confirm (15m)
  let mtfConfirm = 'NEUTRAL';
  if (C15.length > 25) {
    const ema9_15 = calcEMA(C15, 9), ema21_15 = calcEMA(C15, 21);
    const rsi15 = calcRSI(C15, 14);
    const mac15 = calcMACD(C15);
    let mB = 0, mS = 0;
    if (ema9_15 > ema21_15) mB += 1; else mS += 1;
    if (mac15.h > 0) mB += 1; else mS += 1;
    if (rsi15 > 50) mB += 0.5; else if (rsi15 < 50) mS += 0.5;
    if (mB > mS) mtfConfirm = 'BUY';
    else if (mS > mB) mtfConfirm = 'SELL';
  }

  // STEP 3: 5m indicators
  const rsi = calcRSI(C5, 14);
  const mac = calcMACD(C5);
  const ea9 = calcEMAArr(C5, 9), ea21 = calcEMAArr(C5, 21);
  const e9 = ea9.at(-1), e21 = ea21.at(-1), e9p = ea9.at(-2), e21p = ea21.at(-2);
  const e50 = calcEMA(C5, 50);
  const bb = calcBB(C5, 20, 2);
  const vwapArr = calcVWAP(kl5raw.slice(-50)); const vwap = vwapArr.at(-1);
  const avgV = V5.slice(-20).reduce((a, b) => a + b) / 20, lv = V5.at(-1), vr = lv / avgV;
  const adxData = calcADX(H5, L5, C5);
  const obvData = calcOBV(C5, V5);
  const psar = calcParabolicSAR(H5, L5, C5);
  const stFull = calcStoch(H5, L5, C5, 14);
  let atr = calcATR(H5, L5, C5, 14);
  const rsiDiv = detectRSIDivergence(C5, H5, L5, 14);
  const macdDiv = detectMACDDivergence(C5);

  let regimeData = { regime: 'RANGING', label: 'RANGO LATERAL', cls: 'ranging' };
  try { regimeData = detectRegime(H5, L5, C5, adxData, atr); } catch (e) { }
  const regime = regimeData.regime || 'RANGING';
  const isTrending = (regime === 'TRENDING');
  const isQuiet = (regime === 'QUIET');
  const isVolatile = (regime === 'VOLATILE');

  const kc = calcKeltner(H5, L5, C5, 20, 14, 2);
  let orderBlocks = { bullOB: null, bearOB: null };
  try { orderBlocks = detectOrderBlocks(H5, L5, C5, V5, 50); } catch (e) { }

  // ═══ SCORING BY MODE ═══
  if (isStrict && isTrending) {
    // TREND-FOLLOWING MODE
    if (e9 > e21 && e9p <= e21p) { B += 2.5; } else if (e9 < e21 && e9p >= e21p) { S += 2.5; }
    else if (e9 > e21) { B += 0.5; } else { S += 0.5; }
    if (cur > e50) { B += 0.5; } else { S += 0.5; }
    if (mac.h > 0 && mac.ph < 0) { B += 2; } else if (mac.h < 0 && mac.ph > 0) { S += 2; }
    else if (mac.h > 0 && mac.h > mac.ph) { B += 1; } else if (mac.h < 0 && mac.h < mac.ph) { S += 1; }
    if (adxData.pdi > adxData.mdi) { B += 2; } else { S += 2; }
    if (obvData.rising) { B += 1; } else { S += 1; }
    if (psar.recentFlip) { if (psar.trend === 'BUY') B += 1.5; else S += 1.5; }
    else { if (psar.trend === 'BUY') B += 0.5; else S += 0.5; }
    if (cur > vwap && vr > 0.7) { B += 0.5; } else if (cur < vwap && vr > 0.7) { S += 0.5; }
    if (kc.position > 1.0) { B += 1; } else if (kc.position < 0) { S += 1; }
    else if (kc.position > 0.7) { B += 0.3; } else if (kc.position < 0.3) { S += 0.3; }
    if (orderBlocks.bullOB && cur <= orderBlocks.bullOB.price * 1.005) { B += 1.5; }
    else if (orderBlocks.bearOB && cur >= orderBlocks.bearOB.price * 0.995) { S += 1.5; }
    if (rsiDiv.bull) { B += 2.5; } else if (rsiDiv.bear) { S += 2.5; }
    if (macdDiv.bull) { B += 2; } else if (macdDiv.bear) { S += 2; }
    // Count indicators for this branch
    const buyCount = (e9 > e21 ? 1 : 0) + (cur > e50 ? 1 : 0) + (mac.h > 0 ? 1 : 0) + (adxData.pdi > adxData.mdi ? 1 : 0) + (obvData.rising ? 1 : 0) + (psar.trend === 'BUY' ? 1 : 0) + (cur > vwap ? 1 : 0) + (rsiDiv.bull ? 1 : 0) + (macdDiv.bull ? 1 : 0);
    const sellCount = (e9 < e21 ? 1 : 0) + (cur < e50 ? 1 : 0) + (mac.h < 0 ? 1 : 0) + (adxData.mdi > adxData.pdi ? 1 : 0) + (!obvData.rising ? 1 : 0) + (psar.trend === 'SELL' ? 1 : 0) + (cur < vwap ? 1 : 0) + (rsiDiv.bear ? 1 : 0) + (macdDiv.bear ? 1 : 0);
    for (let i = 0; i < buyCount; i++) inds.push({ s: 'BUY' });
    for (let i = 0; i < sellCount; i++) inds.push({ s: 'SELL' });

  } else if (isStrict && !isTrending) {
    // MEAN-REVERSION MODE
    if (rsi < 25) { B += 4; inds.push({ s: 'BUY' }); }
    else if (rsi < 30) { B += 3; inds.push({ s: 'BUY' }); }
    else if (rsi < 35) { B += 2; inds.push({ s: 'BUY' }); }
    else if (rsi > 75) { S += 4; inds.push({ s: 'SELL' }); }
    else if (rsi > 70) { S += 3; inds.push({ s: 'SELL' }); }
    else if (rsi > 65) { S += 2; inds.push({ s: 'SELL' }); }

    if (stFull.k < 20) { B += 3; inds.push({ s: 'BUY' }); }
    else if (stFull.k < 30) { B += 2; inds.push({ s: 'BUY' }); }
    else if (stFull.k > 80) { S += 3; inds.push({ s: 'SELL' }); }
    else if (stFull.k > 70) { S += 2; inds.push({ s: 'SELL' }); }

    const bbR = bb.u - bb.l; const bbPos = bbR > 0 ? (cur - bb.l) / bbR : 0.5;
    if (bbPos < 0.1) { B += 3; inds.push({ s: 'BUY' }); }
    else if (bbPos < 0.2) { B += 2; inds.push({ s: 'BUY' }); }
    else if (bbPos > 0.9) { S += 3; inds.push({ s: 'SELL' }); }
    else if (bbPos > 0.8) { S += 2; inds.push({ s: 'SELL' }); }

    const mom3 = (cur - (C5[C5.length - 4] || cur)) / Math.max(atr, 0.0001);
    if (mom3 < -1) { B += 2; inds.push({ s: 'BUY' }); }
    else if (mom3 < -0.5) { B += 1; inds.push({ s: 'BUY' }); }
    else if (mom3 > 1) { S += 2; inds.push({ s: 'SELL' }); }
    else if (mom3 > 0.5) { S += 1; inds.push({ s: 'SELL' }); }

    // Candle exhaustion
    let bearRun = 0, bullRun = 0;
    for (let ci = Math.max(0, C5.length - 4); ci < C5.length; ci++) {
      if (C5[ci] < (C5[ci - 1] || C5[ci])) bearRun++; else bearRun = 0;
      if (C5[ci] > (C5[ci - 1] || C5[ci])) bullRun++; else bullRun = 0;
    }
    if (bearRun >= 4) { B += 2; inds.push({ s: 'BUY' }); }
    else if (bearRun >= 3) { B += 1; inds.push({ s: 'BUY' }); }
    if (bullRun >= 4) { S += 2; inds.push({ s: 'SELL' }); }
    else if (bullRun >= 3) { S += 1; inds.push({ s: 'SELL' }); }

    // EMA overextension
    const emaDist = (cur - e21) / Math.max(atr, 0.0001);
    if (emaDist < -1.5) { B += 1.5; inds.push({ s: 'BUY' }); }
    else if (emaDist < -0.8) { B += 0.8; inds.push({ s: 'BUY' }); }
    else if (emaDist > 1.5) { S += 1.5; inds.push({ s: 'SELL' }); }
    else if (emaDist > 0.8) { S += 0.8; inds.push({ s: 'SELL' }); }

    // MACD cross
    if (mac.h > 0 && mac.ph <= 0) { B += 1.5; inds.push({ s: 'BUY' }); }
    else if (mac.h < 0 && mac.ph >= 0) { S += 1.5; inds.push({ s: 'SELL' }); }

    // OBV
    if (obvData.rising && B > S) { B += 1; inds.push({ s: 'BUY' }); }
    else if (!obvData.rising && S > B) { S += 1; inds.push({ s: 'SELL' }); }

    // Volume spike
    if (vr > 1.5) { if (B > S) B *= 1.15; else S *= 1.15; }

    // Keltner
    if (kc.position < 0.05) { B += 2; inds.push({ s: 'BUY' }); }
    else if (kc.position < 0.15) { B += 1; inds.push({ s: 'BUY' }); }
    else if (kc.position > 0.95) { S += 2; inds.push({ s: 'SELL' }); }
    else if (kc.position > 0.85) { S += 1; inds.push({ s: 'SELL' }); }

    // RSI Divergence
    if (rsiDiv.bull) { B += 3; inds.push({ s: 'BUY' }); }
    else if (rsiDiv.bear) { S += 3; inds.push({ s: 'SELL' }); }

    // MACD Divergence
    if (macdDiv.bull) { B += 2; inds.push({ s: 'BUY' }); }
    else if (macdDiv.bear) { S += 2; inds.push({ s: 'SELL' }); }

  } else if (isScalp) {
    // SCALP MODE
    const stochK = stFull.k || 50;
    const bbRange = bb.u - bb.l;
    const bbP = bbRange > 0 ? (cur - bb.l) / bbRange : 0.5;
    const mom3val = (cur - (C5[C5.length - 4] || cur)) / Math.max(atr, 0.0001);
    const emaDist21 = (cur - e21) / Math.max(atr, 0.0001);
    const last4 = C5.slice(-4);
    const scalpBullExh = last4.length >= 4 && last4.every((x, i) => i === 0 || x > last4[i - 1]);
    const scalpBearExh = last4.length >= 4 && last4.every((x, i) => i === 0 || x < last4[i - 1]);

    if (rsi < 25) { B += 4; inds.push({ s: 'BUY' }); }
    else if (rsi < 30) { B += 3; inds.push({ s: 'BUY' }); }
    else if (rsi < 38) { B += 2; inds.push({ s: 'BUY' }); }
    else if (rsi < 45) { B += 1; inds.push({ s: 'BUY' }); }
    else if (rsi > 75) { S += 4; inds.push({ s: 'SELL' }); }
    else if (rsi > 70) { S += 3; inds.push({ s: 'SELL' }); }
    else if (rsi > 62) { S += 2; inds.push({ s: 'SELL' }); }
    else if (rsi > 55) { S += 1; inds.push({ s: 'SELL' }); }

    if (stochK < 20) { B += 3; inds.push({ s: 'BUY' }); }
    else if (stochK < 35) { B += 1.5; inds.push({ s: 'BUY' }); }
    else if (stochK > 80) { S += 3; inds.push({ s: 'SELL' }); }
    else if (stochK > 65) { S += 1.5; inds.push({ s: 'SELL' }); }

    if (bbP < 0.1) { B += 3; inds.push({ s: 'BUY' }); }
    else if (bbP < 0.25) { B += 2; inds.push({ s: 'BUY' }); }
    else if (bbP > 0.9) { S += 3; inds.push({ s: 'SELL' }); }
    else if (bbP > 0.75) { S += 2; inds.push({ s: 'SELL' }); }

    if (mom3val < -0.8) { B += 2; inds.push({ s: 'BUY' }); }
    else if (mom3val < -0.3) { B += 1; inds.push({ s: 'BUY' }); }
    else if (mom3val > 0.8) { S += 2; inds.push({ s: 'SELL' }); }
    else if (mom3val > 0.3) { S += 1; inds.push({ s: 'SELL' }); }

    if (scalpBearExh) { B += 2; inds.push({ s: 'BUY' }); }
    else if (scalpBullExh) { S += 2; inds.push({ s: 'SELL' }); }
    else {
      const l3 = C5.slice(-3);
      if (l3.length >= 3 && l3.every((x, i) => i === 0 || x < l3[i - 1])) { B += 1; inds.push({ s: 'BUY' }); }
      else if (l3.length >= 3 && l3.every((x, i) => i === 0 || x > l3[i - 1])) { S += 1; inds.push({ s: 'SELL' }); }
    }

    if (emaDist21 < -1.2) { B += 1.5; inds.push({ s: 'BUY' }); }
    else if (emaDist21 < -0.6) { B += 0.8; inds.push({ s: 'BUY' }); }
    else if (emaDist21 > 1.2) { S += 1.5; inds.push({ s: 'SELL' }); }
    else if (emaDist21 > 0.6) { S += 0.8; inds.push({ s: 'SELL' }); }

    // MACD contrarian
    if (mac.h > 0 && mac.ph < 0) { S += 1; inds.push({ s: 'SELL' }); }
    else if (mac.h < 0 && mac.ph > 0) { B += 1; inds.push({ s: 'BUY' }); }
    else if (mac.h > 0 && mac.h > mac.ph) { S += 0.5; inds.push({ s: 'SELL' }); }
    else if (mac.h < 0 && mac.h < mac.ph) { B += 0.5; inds.push({ s: 'BUY' }); }

    // OBV
    if (obvData.rising && B > S) { B += 0.8; inds.push({ s: 'BUY' }); }
    else if (!obvData.rising && S > B) { S += 0.8; inds.push({ s: 'SELL' }); }

    // Keltner
    if (kc.position < 0.05) { B += 1.5; inds.push({ s: 'BUY' }); }
    else if (kc.position < 0.2) { B += 0.8; inds.push({ s: 'BUY' }); }
    else if (kc.position > 0.95) { S += 1.5; inds.push({ s: 'SELL' }); }
    else if (kc.position > 0.8) { S += 0.8; inds.push({ s: 'SELL' }); }

    // RSI Divergence
    if (rsiDiv.bull) { B += 2; inds.push({ s: 'BUY' }); }
    else if (rsiDiv.bear) { S += 2; inds.push({ s: 'SELL' }); }

    // Volume amplifier
    if (vr > 1.5) { if (B > S) B *= 1.15; else S *= 1.15; }

  } else {
    // FREE MODE
    const freeStoch = stFull.k || 50;
    const freeBBR = bb.u - bb.l;
    const freeBBPos = freeBBR > 0 ? (cur - bb.l) / freeBBR : 0.5;

    if (rsi < 28) { B += 3; inds.push({ s: 'BUY' }); }
    else if (rsi < 35) { B += 2; inds.push({ s: 'BUY' }); }
    else if (rsi < 40) { B += 1; inds.push({ s: 'BUY' }); }
    else if (rsi > 72) { S += 3; inds.push({ s: 'SELL' }); }
    else if (rsi > 65) { S += 2; inds.push({ s: 'SELL' }); }
    else if (rsi > 60) { S += 1; inds.push({ s: 'SELL' }); }

    if (freeStoch < 25) { B += 2; inds.push({ s: 'BUY' }); }
    else if (freeStoch < 35) { B += 1; inds.push({ s: 'BUY' }); }
    else if (freeStoch > 75) { S += 2; inds.push({ s: 'SELL' }); }
    else if (freeStoch > 65) { S += 1; inds.push({ s: 'SELL' }); }

    if (freeBBPos < 0.15) { B += 2; inds.push({ s: 'BUY' }); }
    else if (freeBBPos < 0.25) { B += 1; inds.push({ s: 'BUY' }); }
    else if (freeBBPos > 0.85) { S += 2; inds.push({ s: 'SELL' }); }
    else if (freeBBPos > 0.75) { S += 1; inds.push({ s: 'SELL' }); }

    const freeMom3 = (cur - (C5[C5.length - 4] || cur)) / Math.max(atr, 0.0001);
    if (freeMom3 < -0.8) { B += 1; inds.push({ s: 'BUY' }); }
    else if (freeMom3 > 0.8) { S += 1; inds.push({ s: 'SELL' }); }

    if (mac.h > 0 && mac.ph < 0) { B += 1; inds.push({ s: 'BUY' }); }
    else if (mac.h < 0 && mac.ph > 0) { S += 1; inds.push({ s: 'SELL' }); }

    if (obvData.rising) { B += 0.5; inds.push({ s: 'BUY' }); }
    else { S += 0.5; inds.push({ s: 'SELL' }); }
  }

  // Volume info (non-scalp)
  if (!isScalp) {
    if (vr > 1.5 && B > S) B *= 1.1;
    else if (vr > 1.5 && S > B) S *= 1.1;
  }

  // ═══ SIGNAL DECISION ═══
  const buyInds = inds.filter(i => i.s === 'BUY').length;
  const sellInds = inds.filter(i => i.s === 'SELL').length;

  // Flow analysis
  let buyPressure = 0, sellPressure = 0;
  for (let i = C5.length - 5; i < C5.length; i++) {
    if (i < 1) continue;
    const open = C5[i - 1];
    const body = C5[i] - open;
    const upperWick = H5[i] - Math.max(C5[i], open);
    const lowerWick = Math.min(C5[i], open) - L5[i];
    if (body > 0) { buyPressure += body + lowerWick * 0.5; sellPressure += upperWick * 0.3; }
    else { sellPressure += Math.abs(body) + upperWick * 0.5; buyPressure += lowerWick * 0.3; }
  }
  const flowRatio = buyPressure / Math.max(0.001, sellPressure);
  const flowBull = flowRatio > 1.4;
  const flowBear = flowRatio < 0.7;

  let signal = 'NEUTRAL';
  let conf = 50;

  if (isStrict) {
    const vipMinConv = 8, vipMinConds = 3;
    if (isTrending) { /* block */ }
    else if (B > S && B >= vipMinConv && buyInds >= vipMinConds) signal = 'BUY';
    else if (S > B && S >= vipMinConv && sellInds >= vipMinConds) signal = 'SELL';

    if (signal !== 'NEUTRAL' && adxData.adx > 20) signal = 'NEUTRAL';
    if (signal !== 'NEUTRAL') {
      const vipAllowedHours = [6, 7, 13, 14, 19, 20, 21, 22, 23];
      if (!vipAllowedHours.includes(hourUTC)) signal = 'NEUTRAL';
    }
    if (signal !== 'NEUTRAL' && isVolatile) signal = 'NEUTRAL';
    if (signal !== 'NEUTRAL') {
      const dayOfWeek = new Date().getUTCDay();
      // In backtest we pass the actual day, handle below
    }

    if (signal !== 'NEUTRAL') {
      const convScore = signal === 'BUY' ? B : S;
      const condCount = signal === 'BUY' ? buyInds : sellInds;
      conf = Math.min(90, Math.round(50 + convScore * 2.5 + condCount * 1.5));
      if (htfTrend === signal) conf = Math.min(90, conf + 5);
      if (mtfConfirm === signal) conf = Math.min(90, conf + 3);
      if (rsiDiv.bull && signal === 'BUY') conf = Math.min(90, conf + 4);
      if (rsiDiv.bear && signal === 'SELL') conf = Math.min(90, conf + 4);
      if (macdDiv.bull && signal === 'BUY') conf = Math.min(90, conf + 3);
      if (macdDiv.bear && signal === 'SELL') conf = Math.min(90, conf + 3);
      if ((signal === 'BUY' && flowBull) || (signal === 'SELL' && flowBear)) conf = Math.min(90, conf + 2);
    }

  } else if (isScalp) {
    const scalpMinConv = 5, scalpMinConds = 2, scalpAdxMax = 22;
    if (B > S && B >= scalpMinConv && buyInds >= scalpMinConds) signal = 'BUY';
    else if (S > B && S >= scalpMinConv && sellInds >= scalpMinConds) signal = 'SELL';

    if (signal !== 'NEUTRAL' && adxData.adx > scalpAdxMax) signal = 'NEUTRAL';
    const scalpMaxConv = Math.max(B, S);
    if (signal === 'BUY' && mtfConfirm === 'SELL' && scalpMaxConv < 7) signal = 'NEUTRAL';
    if (signal === 'SELL' && mtfConfirm === 'BUY' && scalpMaxConv < 7) signal = 'NEUTRAL';

    if (signal !== 'NEUTRAL') {
      const scalpAllowedH = [0, 6, 7, 15, 20, 21, 23];
      if (!scalpAllowedH.includes(hourUTC)) signal = 'NEUTRAL';
    }

    // Dominance filter
    if (signal !== 'NEUTRAL' && Math.max(B, S) < Math.min(B, S) * 1.4) signal = 'NEUTRAL';
    if (signal !== 'NEUTRAL' && vr < 0.3) signal = 'NEUTRAL';

    if (signal !== 'NEUTRAL') {
      const maxConv = Math.max(B, S);
      const condCount = signal === 'BUY' ? buyInds : sellInds;
      conf = Math.min(88, Math.max(52, Math.round(48 + maxConv * 2.5 + condCount * 2)));
      if (htfTrend === signal) conf = Math.min(88, conf + 4);
      if (mtfConfirm === signal) conf = Math.min(88, conf + 3);
      if (rsiDiv.bull && signal === 'BUY') conf = Math.min(88, conf + 3);
      if (rsiDiv.bear && signal === 'SELL') conf = Math.min(88, conf + 3);
    }

  } else {
    // FREE
    const freeMinConv = 5, freeMinConds = 2;
    if (B > S && B >= freeMinConv && buyInds >= freeMinConds) signal = 'BUY';
    else if (S > B && S >= freeMinConv && sellInds >= freeMinConds) signal = 'SELL';

    if (signal !== 'NEUTRAL' && isTrending) signal = 'NEUTRAL';
    if (signal !== 'NEUTRAL' && isVolatile) signal = 'NEUTRAL';
    if (signal !== 'NEUTRAL' && adxData.adx > 30) signal = 'NEUTRAL';
    if (signal !== 'NEUTRAL') {
      const freeAllowedHours = [6, 10, 18, 20, 21, 23];
      if (!freeAllowedHours.includes(hourUTC)) signal = 'NEUTRAL';
    }
    if (signal !== 'NEUTRAL' && vr < 0.4) signal = 'NEUTRAL';

    if (signal !== 'NEUTRAL') {
      const convScore = signal === 'BUY' ? B : S;
      const condCount = signal === 'BUY' ? buyInds : sellInds;
      conf = Math.min(75, Math.round(40 + convScore * 2 + condCount * 1.5));
    }
  }

  // ═══ TP/SL ═══
  let atr15 = atr;
  if (H15.length > 15 && L15.length > 15 && C15.length > 15) {
    const a15 = calcATR(H15, L15, C15, 14);
    if (a15 > 0) atr15 = a15;
  }
  let atr1h = atr;
  if (H1h.length > 15 && L1h.length > 15 && C1h.length > 15) {
    const a1h = calcATR(H1h, L1h, C1h, 14);
    if (a1h > 0) atr1h = a1h;
  }
  const blendedATR = Math.max(atr15, atr1h / 4);

  // Minimum volatility filter for strict
  if (isStrict && signal !== 'NEUTRAL') {
    const volPct = atr15 / cur;
    if (volPct < 0.0008) signal = 'NEUTRAL';
  }

  let tpDist, slDist, useATR;
  if (isScalp) {
    useATR = atr15 || blendedATR;
    tpDist = useATR * 1.3;
    slDist = useATR * 1.0;
  } else if (isStrict) {
    useATR = blendedATR;
    tpDist = useATR * 1.5;
    slDist = useATR * 1.0;
  } else {
    useATR = blendedATR;
    tpDist = useATR * 1.5;
    slDist = useATR * 1.0;
  }

  // Minimum TP
  if (isScalp) {
    const minTP = cur * 0.0015;
    if (tpDist < minTP) tpDist = minTP;
    if (slDist < minTP) slDist = minTP;
  } else {
    const minTP = cur * 0.0012;
    if (tpDist < minTP) tpDist = minTP;
    if (slDist < minTP * 0.67) slDist = minTP * 0.67;
  }

  if (!isStrict && !isScalp && tpDist < slDist * 1.2) tpDist = slDist * 1.2;

  const costBuffer = cur * 0.0008;

  // S/R awareness
  if (signal !== 'NEUTRAL' && (isStrict || isScalp)) {
    try {
      let pivotH = H5, pivotL = L5, pivotC = C5;
      if (H1h.length > 20) { pivotH = H1h; pivotL = L1h; pivotC = C1h; }
      const pivots = findPivotLevels(pivotH, pivotL, pivotC, 50);
      if (signal === 'BUY' && pivots.nearestRes) {
        const distToRes = pivots.nearestRes - cur;
        if (distToRes > 0 && distToRes < tpDist * 0.7) {
          if (distToRes > slDist * 1.2) tpDist = distToRes * 0.92;
          else signal = 'NEUTRAL';
        }
      }
      if (signal === 'SELL' && pivots.nearestSup) {
        const distToSup = cur - pivots.nearestSup;
        if (distToSup > 0 && distToSup < tpDist * 0.7) {
          if (distToSup > slDist * 1.2) tpDist = distToSup * 0.92;
          else signal = 'NEUTRAL';
        }
      }
    } catch (e) { }
  }

  const tp = signal === 'BUY' ? cur + tpDist + costBuffer : signal === 'SELL' ? cur - tpDist - costBuffer : null;
  const sl = signal === 'BUY' ? cur - slDist - costBuffer : signal === 'SELL' ? cur + slDist + costBuffer : null;
  const tp1Dist = tpDist * (isScalp ? 0.50 : 0.60);
  const tp1 = signal === 'BUY' ? cur + tp1Dist + costBuffer : signal === 'SELL' ? cur - tp1Dist - costBuffer : null;

  return { signal, confidence: conf, B, S, entry: cur, tp, tp1, sl, tpDist, slDist, atr, regime, adx: adxData.adx, rsi, vr, htfTrend, mtfConfirm };
}

// ═══════════════════════════════════════════════════════
// DATA FETCHING
// ═══════════════════════════════════════════════════════
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function getKlines(sym, interval, limit, endTime) {
  let url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
  if (endTime) url += `&endTime=${endTime}`;
  try {
    return await fetchJSON(url);
  } catch (e) {
    console.error(`Error fetching ${sym} ${interval}:`, e.message);
    return [];
  }
}

async function fetchAllData(sym, days) {
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;
  const barsNeeded = (days * 24 * 60) / 5; // 5m bars
  const warmup = 280; // bars needed for indicator warmup

  // Fetch 5m data in batches
  const all5m = [];
  let endT = now;
  while (all5m.length < barsNeeded + warmup) {
    const batch = await getKlines(sym, '5m', 1000, endT);
    if (!batch || !batch.length) break;
    all5m.unshift(...batch);
    endT = batch[0][0] - 1;
    await sleep(100); // Rate limiting
  }

  // Fetch 15m data
  const bars15m = Math.ceil((days * 24 * 60) / 15) + 100;
  const all15m = [];
  endT = now;
  while (all15m.length < bars15m) {
    const batch = await getKlines(sym, '15m', 1000, endT);
    if (!batch || !batch.length) break;
    all15m.unshift(...batch);
    endT = batch[0][0] - 1;
    await sleep(100);
  }

  // Fetch 1h data
  const all1h = await getKlines(sym, '1h', Math.min(500, days * 24 + 50));
  await sleep(100);

  return { kl5: all5m, kl15: all15m, kl1h: all1h || [] };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════
// BACKTESTING ENGINE
// ═══════════════════════════════════════════════════════
async function runBacktest(mode) {
  const pairs = mode === 'strict' ? VIP_PAIRS : mode === 'scalp' ? SCALP_PAIRS : FREE_PAIRS;
  const cooldownBars = COOLDOWN[mode];

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  BACKTEST: ${mode.toUpperCase()} MODE — ${DAYS} days, ${pairs.length} pairs`);
  console.log(`${'═'.repeat(70)}\n`);

  const allTrades = [];
  const signalsByHour = new Array(24).fill(0);
  const tradesByHour = new Array(24).fill(0);
  const pnlByHour = new Array(24).fill(0);
  const tradesByPair = {};
  const tradesByRegime = {};
  const tradesByDay = new Array(7).fill(null).map(() => ({ trades: 0, pnl: 0, wins: 0 }));
  let totalSignalsGenerated = 0;
  let signalsFiltered = { adx: 0, hours: 0, volatile: 0, day: 0, mtf: 0, dominance: 0, volume: 0, volatility: 0, sr: 0, trending: 0 };

  for (const sym of pairs) {
    process.stdout.write(`  Fetching ${sym}...`);
    let data;
    try {
      data = await fetchAllData(sym, DAYS);
    } catch (e) {
      console.log(` ERROR: ${e.message}`);
      continue;
    }

    if (!data.kl5 || data.kl5.length < 300) {
      console.log(` insufficient data (${data.kl5?.length || 0} bars)`);
      continue;
    }

    const testStart = Date.now() - DAYS * 24 * 60 * 60 * 1000;
    // Find the index where test period starts (after warmup)
    let startIdx = 280;
    for (let i = 280; i < data.kl5.length; i++) {
      if (data.kl5[i][0] >= testStart) { startIdx = i; break; }
    }

    const trades = [];
    let lastSignalBar = -cooldownBars;
    let openTrade = null;

    // Walk through each 5m bar
    for (let i = startIdx; i < data.kl5.length; i++) {
      const bar = data.kl5[i];
      const barTime = bar[0];
      const barH = parseFloat(bar[2]);
      const barL = parseFloat(bar[3]);
      const barC = parseFloat(bar[4]);
      const hourUTC = new Date(barTime).getUTCHours();
      const dayOfWeek = new Date(barTime).getUTCDay();

      // Check open trade
      if (openTrade) {
        openTrade.barsHeld++;

        if (openTrade.signal === 'BUY') {
          if (barL <= openTrade.sl) {
            // Stop loss hit
            openTrade.exitPrice = openTrade.sl;
            openTrade.exitReason = 'SL';
            openTrade.pnl = ((openTrade.sl - openTrade.entry) / openTrade.entry) * LEVERAGE * POSITION_SIZE - (POSITION_SIZE * FEE_RATE);
            trades.push(openTrade);
            openTrade = null;
          } else if (barH >= openTrade.tp) {
            // Take profit hit
            openTrade.exitPrice = openTrade.tp;
            openTrade.exitReason = 'TP';
            openTrade.pnl = ((openTrade.tp - openTrade.entry) / openTrade.entry) * LEVERAGE * POSITION_SIZE - (POSITION_SIZE * FEE_RATE);
            trades.push(openTrade);
            openTrade = null;
          } else if (openTrade.barsHeld >= TIMEOUT_BARS) {
            // Timeout
            openTrade.exitPrice = barC;
            openTrade.exitReason = 'TIMEOUT';
            openTrade.pnl = ((barC - openTrade.entry) / openTrade.entry) * LEVERAGE * POSITION_SIZE - (POSITION_SIZE * FEE_RATE);
            trades.push(openTrade);
            openTrade = null;
          }
        } else { // SELL
          if (barH >= openTrade.sl) {
            openTrade.exitPrice = openTrade.sl;
            openTrade.exitReason = 'SL';
            openTrade.pnl = ((openTrade.entry - openTrade.sl) / openTrade.entry) * LEVERAGE * POSITION_SIZE - (POSITION_SIZE * FEE_RATE);
            trades.push(openTrade);
            openTrade = null;
          } else if (barL <= openTrade.tp) {
            openTrade.exitPrice = openTrade.tp;
            openTrade.exitReason = 'TP';
            openTrade.pnl = ((openTrade.entry - openTrade.tp) / openTrade.entry) * LEVERAGE * POSITION_SIZE - (POSITION_SIZE * FEE_RATE);
            trades.push(openTrade);
            openTrade = null;
          } else if (openTrade.barsHeld >= TIMEOUT_BARS) {
            openTrade.exitPrice = barC;
            openTrade.exitReason = 'TIMEOUT';
            openTrade.pnl = ((openTrade.entry - barC) / openTrade.entry) * LEVERAGE * POSITION_SIZE - (POSITION_SIZE * FEE_RATE);
            trades.push(openTrade);
            openTrade = null;
          }
        }
        continue; // Don't generate new signal while trade is open
      }

      // Cooldown check
      if (i - lastSignalBar < cooldownBars) continue;

      // Prepare data slices
      const slice5 = data.kl5.slice(Math.max(0, i - 279), i + 1);
      const C5 = slice5.map(k => parseFloat(k[4]));
      const H5 = slice5.map(k => parseFloat(k[2]));
      const L5 = slice5.map(k => parseFloat(k[3]));
      const V5 = slice5.map(k => parseFloat(k[5]));

      if (C5.length < 50) continue;

      // Find matching 15m bars
      const barTime15 = barTime - (barTime % (15 * 60 * 1000));
      let endIdx15 = data.kl15.findIndex(k => k[0] > barTime15);
      if (endIdx15 === -1) endIdx15 = data.kl15.length;
      const slice15 = data.kl15.slice(Math.max(0, endIdx15 - 100), endIdx15);
      const C15 = slice15.map(k => parseFloat(k[4]));
      const H15 = slice15.map(k => parseFloat(k[2]));
      const L15 = slice15.map(k => parseFloat(k[3]));
      const V15 = slice15.map(k => parseFloat(k[5]));

      // Find matching 1h bars
      const barTime1h = barTime - (barTime % (60 * 60 * 1000));
      let endIdx1h = data.kl1h.findIndex(k => k[0] > barTime1h);
      if (endIdx1h === -1) endIdx1h = data.kl1h.length;
      const slice1h = data.kl1h.slice(Math.max(0, endIdx1h - 50), endIdx1h);
      const C1h = slice1h.map(k => parseFloat(k[4]));
      const H1h = slice1h.map(k => parseFloat(k[2]));
      const L1h = slice1h.map(k => parseFloat(k[3]));
      const V1h = slice1h.map(k => parseFloat(k[5]));

      // Generate signal
      const sig = generateSignal(C5, H5, L5, V5, C15, H15, L15, V15, C1h, H1h, L1h, V1h, slice5, hourUTC, mode);

      if (!sig) continue;

      // Apply day-of-week filter (can't do inside generateSignal since it uses Date.now())
      if (mode === 'strict' && sig.signal !== 'NEUTRAL' && dayOfWeek === 6) {
        signalsFiltered.day++;
        sig.signal = 'NEUTRAL';
      }
      if (mode === 'scalp' && sig.signal !== 'NEUTRAL' && (dayOfWeek === 0 || dayOfWeek === 1 || dayOfWeek === 2)) {
        signalsFiltered.day++;
        sig.signal = 'NEUTRAL';
      }

      totalSignalsGenerated++;
      signalsByHour[hourUTC]++;

      if (sig.signal !== 'NEUTRAL') {
        lastSignalBar = i;
        openTrade = {
          sym, signal: sig.signal, entry: sig.entry, tp: sig.tp, sl: sig.sl,
          tp1: sig.tp1, tpDist: sig.tpDist, slDist: sig.slDist,
          confidence: sig.confidence, regime: sig.regime, adx: sig.adx,
          rsi: sig.rsi, vr: sig.vr, htfTrend: sig.htfTrend,
          entryTime: new Date(barTime).toISOString(),
          hourUTC, dayOfWeek, barsHeld: 0, pnl: 0
        };
      }
    }

    // Close any remaining open trade
    if (openTrade) {
      const lastBar = data.kl5.at(-1);
      openTrade.exitPrice = parseFloat(lastBar[4]);
      openTrade.exitReason = 'END';
      if (openTrade.signal === 'BUY') {
        openTrade.pnl = ((openTrade.exitPrice - openTrade.entry) / openTrade.entry) * LEVERAGE * POSITION_SIZE - (POSITION_SIZE * FEE_RATE);
      } else {
        openTrade.pnl = ((openTrade.entry - openTrade.exitPrice) / openTrade.entry) * LEVERAGE * POSITION_SIZE - (POSITION_SIZE * FEE_RATE);
      }
      trades.push(openTrade);
    }

    // Aggregate
    for (const t of trades) {
      allTrades.push(t);
      tradesByHour[t.hourUTC]++;
      pnlByHour[t.hourUTC] += t.pnl;
      if (!tradesByPair[sym]) tradesByPair[sym] = { trades: 0, pnl: 0, wins: 0 };
      tradesByPair[sym].trades++;
      tradesByPair[sym].pnl += t.pnl;
      if (t.pnl > 0) tradesByPair[sym].wins++;
      if (!tradesByRegime[t.regime]) tradesByRegime[t.regime] = { trades: 0, pnl: 0, wins: 0 };
      tradesByRegime[t.regime].trades++;
      tradesByRegime[t.regime].pnl += t.pnl;
      if (t.pnl > 0) tradesByRegime[t.regime].wins++;
      tradesByDay[t.dayOfWeek].trades++;
      tradesByDay[t.dayOfWeek].pnl += t.pnl;
      if (t.pnl > 0) tradesByDay[t.dayOfWeek].wins++;
    }

    console.log(` ${trades.length} trades, PnL: $${trades.reduce((a, t) => a + t.pnl, 0).toFixed(2)}`);
    await sleep(200); // Rate limiting between pairs
  }

  // ═══ RESULTS ═══
  printResults(mode, allTrades, tradesByPair, tradesByRegime, tradesByDay, pnlByHour, tradesByHour, signalsByHour, totalSignalsGenerated, signalsFiltered);
  return allTrades;
}

function printResults(mode, trades, byPair, byRegime, byDay, pnlByHour, tradesByHour, signalsByHour, totalSignals, filtered) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnL = trades.reduce((a, t) => a + t.pnl, 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const wr = trades.length ? (wins.length / trades.length * 100) : 0;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const expectancy = trades.length ? totalPnL / trades.length : 0;

  // Max drawdown
  let peak = CAPITAL, maxDD = 0, equity = CAPITAL;
  const equityCurve = [CAPITAL];
  for (const t of trades) {
    equity += t.pnl;
    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Max consecutive wins/losses
  let maxConsecWins = 0, maxConsecLosses = 0, cw = 0, cl = 0;
  for (const t of trades) {
    if (t.pnl > 0) { cw++; cl = 0; if (cw > maxConsecWins) maxConsecWins = cw; }
    else { cl++; cw = 0; if (cl > maxConsecLosses) maxConsecLosses = cl; }
  }

  // Avg duration
  const avgDuration = trades.length ? trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length * 5 : 0;

  // Exit reason breakdown
  const exitReasons = {};
  for (const t of trades) { exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1; }

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  RESULTS: ${mode.toUpperCase()}`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  Total trades:      ${trades.length} (${(trades.length / DAYS).toFixed(1)}/day)`);
  console.log(`  Win Rate:          ${wr.toFixed(1)}% (${wins.length}W / ${losses.length}L)`);
  console.log(`  PnL:               $${totalPnL.toFixed(2)} (${(totalPnL / CAPITAL * 100).toFixed(2)}%)`);
  console.log(`  Profit Factor:     ${pf.toFixed(2)}`);
  console.log(`  Max Drawdown:      ${maxDD.toFixed(2)}%`);
  console.log(`  Avg Win:           $${avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:          $${avgLoss.toFixed(2)}`);
  console.log(`  Expectancy:        $${expectancy.toFixed(2)}/trade`);
  console.log(`  Avg Duration:      ${avgDuration.toFixed(0)} minutes`);
  console.log(`  Max Consec Wins:   ${maxConsecWins}`);
  console.log(`  Max Consec Losses: ${maxConsecLosses}`);
  console.log(`  Final Equity:      $${equity.toFixed(2)} (from $${CAPITAL})`);

  console.log(`\n  Exit Reasons:`);
  for (const [reason, count] of Object.entries(exitReasons)) {
    console.log(`    ${reason}: ${count} (${(count / trades.length * 100).toFixed(1)}%)`);
  }

  console.log(`\n  PnL by Pair (Top 10 + Bottom 5):`);
  const pairArr = Object.entries(byPair).sort((a, b) => b[1].pnl - a[1].pnl);
  const top10 = pairArr.slice(0, 10);
  const bot5 = pairArr.slice(-5).reverse();
  console.log(`    ${'Pair'.padEnd(12)} ${'Trades'.padEnd(8)} ${'WR'.padEnd(8)} ${'PnL'.padEnd(12)}`);
  for (const [pair, data] of top10) {
    const pairWR = data.trades ? (data.wins / data.trades * 100).toFixed(0) : '0';
    console.log(`    ${pair.padEnd(12)} ${String(data.trades).padEnd(8)} ${(pairWR + '%').padEnd(8)} $${data.pnl.toFixed(2)}`);
  }
  console.log(`    --- Bottom 5 ---`);
  for (const [pair, data] of bot5) {
    const pairWR = data.trades ? (data.wins / data.trades * 100).toFixed(0) : '0';
    console.log(`    ${pair.padEnd(12)} ${String(data.trades).padEnd(8)} ${(pairWR + '%').padEnd(8)} $${data.pnl.toFixed(2)}`);
  }

  console.log(`\n  PnL by Regime:`);
  for (const [regime, data] of Object.entries(byRegime)) {
    const rwr = data.trades ? (data.wins / data.trades * 100).toFixed(0) : '0';
    console.log(`    ${regime.padEnd(12)} ${String(data.trades).padEnd(8)} WR:${(rwr + '%').padEnd(6)} PnL:$${data.pnl.toFixed(2)}`);
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  console.log(`\n  PnL by Day:`);
  for (let d = 0; d < 7; d++) {
    const data = byDay[d];
    if (!data.trades) continue;
    const dwr = (data.wins / data.trades * 100).toFixed(0);
    console.log(`    ${dayNames[d].padEnd(5)} ${String(data.trades).padEnd(8)} WR:${(dwr + '%').padEnd(6)} PnL:$${data.pnl.toFixed(2)}`);
  }

  console.log(`\n  PnL by Hour (UTC):`);
  for (let h = 0; h < 24; h++) {
    if (!tradesByHour[h]) continue;
    const p = pnlByHour[h];
    const bar = p > 0 ? '+'.repeat(Math.min(20, Math.round(p / 5))) : '-'.repeat(Math.min(20, Math.round(Math.abs(p) / 5)));
    console.log(`    H${String(h).padStart(2, '0')}: ${String(tradesByHour[h]).padEnd(6)} $${p.toFixed(0).padStart(8)} ${bar}`);
  }

  // Equity curve by day
  console.log(`\n  Equity Curve (daily snapshots):`);
  const barsPerDay = 288; // 24*60/5
  for (let d = 0; d <= DAYS; d++) {
    const idx = Math.min(d * Math.round(trades.length / DAYS), equityCurve.length - 1);
    if (idx >= 0 && idx < equityCurve.length) {
      const eq = equityCurve[idx];
      const pct = ((eq - CAPITAL) / CAPITAL * 100).toFixed(1);
      const bar = eq >= CAPITAL ? '█'.repeat(Math.min(30, Math.round((eq - CAPITAL) / 20))) : '▒'.repeat(Math.min(30, Math.round((CAPITAL - eq) / 20)));
      console.log(`    Day ${String(d).padStart(2)}: $${eq.toFixed(0).padStart(7)} (${pct.padStart(6)}%) ${bar}`);
    }
  }

  console.log(`\n  Best trade:  ${trades.length ? `$${Math.max(...trades.map(t => t.pnl)).toFixed(2)} (${trades.find(t => t.pnl === Math.max(...trades.map(t2 => t2.pnl)))?.sym} ${trades.find(t => t.pnl === Math.max(...trades.map(t2 => t2.pnl)))?.signal})` : 'N/A'}`);
  console.log(`  Worst trade: ${trades.length ? `$${Math.min(...trades.map(t => t.pnl)).toFixed(2)} (${trades.find(t => t.pnl === Math.min(...trades.map(t2 => t2.pnl)))?.sym} ${trades.find(t => t.pnl === Math.min(...trades.map(t2 => t2.pnl)))?.signal})` : 'N/A'}`);

  console.log(`${'─'.repeat(70)}\n`);
}

// ═══════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════
async function main() {
  const mode = process.argv[2] || 'all';

  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║    DEFINITIVE BACKTEST — Real Binance Data, Exact Logic Replication ║');
  console.log(`║    Period: Last ${DAYS} days | Capital: $${CAPITAL} | Position: $${POSITION_SIZE} × ${LEVERAGE}x     ║`);
  console.log(`║    Fees: ${FEE_RATE * 100}% RT | Timeout: ${TIMEOUT_BARS} bars (${(TIMEOUT_BARS * 5 / 60).toFixed(1)}h)              ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  if (mode === 'all' || mode === 'strict') {
    await runBacktest('strict');
  }
  if (mode === 'all' || mode === 'scalp') {
    await runBacktest('scalp');
  }
  if (mode === 'all' || mode === 'free') {
    await runBacktest('free');
  }

  console.log('\n✓ Backtest complete.');
}

main().catch(console.error);
