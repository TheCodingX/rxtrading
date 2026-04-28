/**
 * RxTrading Walk-Forward Backtest Engine
 * =======================================
 * Replica EXACTA de genSig() de app.html con datos REALES de Binance.
 * Simula 60 días de operación para los modos STRICT y SCALP.
 *
 * Uso: node walkforward-backtest.js
 */

const https = require('https');

// ============================================================================
// INDICATOR FUNCTIONS (replica exacta de app.html)
// ============================================================================

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
  for (let i = 1; i < C.length; i++)
    trs.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
  if (trs.length < p) return trs.reduce((a, b) => a + b) / trs.length;
  let atr = trs.slice(0, p).reduce((a, b) => a + b) / p;
  for (let i = p; i < trs.length; i++) atr = (atr * (p - 1) + trs[i]) / p;
  return atr;
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
  function wilderSmooth(arr, period) {
    if (arr.length < period) return arr.map(() => 0);
    const r = [];
    let s = arr.slice(0, period).reduce((a, b) => a + b) / period;
    for (let i = 0; i < period; i++) r.push(0);
    r[period - 1] = s;
    for (let i = period; i < arr.length; i++) { s = (s * (period - 1) + arr[i]) / period; r.push(s); }
    return r;
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
  const range = upper - lower;
  const width = mid ? range / mid : 0;
  const cur = C.at(-1);
  const position = range > 0 ? (cur - lower) / range : 0.5;
  return { upper, mid, lower, width, position, atr };
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

function calcMFI(H, L, C, V, period = 14) {
  if (C.length < period + 1) return 50;
  let posFlow = 0, negFlow = 0;
  for (let i = C.length - period; i < C.length; i++) {
    const tp = (H[i] + L[i] + C[i]) / 3;
    const prevTp = (H[i - 1] + L[i - 1] + C[i - 1]) / 3;
    const mf = tp * V[i];
    if (tp > prevTp) posFlow += mf;
    else negFlow += mf;
  }
  if (negFlow === 0) return 100;
  const ratio = posFlow / negFlow;
  return 100 - (100 / (1 + ratio));
}

function calcVWAP(klines) {
  let cumVol = 0, cumVolPrice = 0;
  const vwapArr = [];
  for (const k of klines) {
    const typPrice = (k[2] + k[3] + k[4]) / 3;
    const vol = k[5];
    cumVol += vol; cumVolPrice += (typPrice * vol);
    vwapArr.push(cumVol > 0 ? cumVolPrice / cumVol : k[4]);
  }
  return vwapArr;
}

function detectRegime(H, L, C, adxPre, atrPre) {
  const adx = adxPre || calcADX(H, L, C);
  const atr = atrPre || calcATR(H, L, C, 14);
  const avgP = C.slice(-20).reduce((a, b) => a + b) / 20;
  const atrPct = atr / avgP * 100;
  if (adx.adx > 25 && atrPct > 1.5) return { regime: 'TRENDING' };
  if (adx.adx < 20 && atrPct < 0.8) return { regime: 'QUIET' };
  if (atrPct > 2) return { regime: 'VOLATILE' };
  return { regime: 'RANGING' };
}

// ============================================================================
// SIGNAL ENGINE (replica exacta de genSig de app.html)
// ============================================================================

function genSigFromData(kl5, kl15, kl1h, mode) {
  const isStrict = (mode === 'strict');
  const isScalp = (mode === 'scalp');

  if (!kl5 || !kl5.length) return null;

  const C = kl5.map(k => k[4]);
  const H = kl5.map(k => k[2]);
  const L = kl5.map(k => k[3]);
  const V = kl5.map(k => k[5]);
  const C15 = kl15 ? kl15.map(k => k[4]) : [];
  const H15 = kl15 ? kl15.map(k => k[2]) : [];
  const L15 = kl15 ? kl15.map(k => k[3]) : [];
  const V15 = kl15 ? kl15.map(k => k[5]) : [];
  const C1h = kl1h ? kl1h.map(k => k[4]) : [];
  const H1h = kl1h ? kl1h.map(k => k[2]) : [];
  const L1h = kl1h ? kl1h.map(k => k[3]) : [];

  const cur = C.at(-1);
  let B = 0, S = 0;
  let bInds = 0, sInds = 0;

  // HTF Trend (1H)
  let htfTrend = 'NEUTRAL';
  if (C1h.length >= 20) {
    const e5h = calcEMA(C1h, 5);
    const e13h = calcEMA(C1h, 13);
    const rsiH = calcRSI(C1h, 14);
    if (e5h > e13h && rsiH > 45) htfTrend = 'BUY';
    else if (e5h < e13h && rsiH < 55) htfTrend = 'SELL';
  }

  // MTF Confirm (15m)
  let mtfConfirm = 'NEUTRAL';
  if (C15.length >= 20) {
    const e5m = calcEMA(C15, 5);
    const e13m = calcEMA(C15, 13);
    const rsiM = calcRSI(C15, 14);
    if (e5m > e13m && rsiM > 45) mtfConfirm = 'BUY';
    else if (e5m < e13m && rsiM < 55) mtfConfirm = 'SELL';
  }

  // Indicators
  const rsi = calcRSI(C, 7);
  const macd = calcMACD(C);
  const bb = calcBB(C, 10, 1.8);
  const stoch = calcStoch(H, L, C, 7);
  const atr = calcATR(H, L, C, 14);
  const adx = calcADX(H, L, C, 14);
  const keltner = calcKeltner(H, L, C, 20, 14, 2);
  const psar = calcParabolicSAR(H, L, C);
  const mfi = calcMFI(H, L, C, V, 7);
  const obv = calcOBV(C, V);

  // VWAP
  const vwapArr = calcVWAP(kl5);
  const vwap = vwapArr.at(-1);

  // Volume
  const avgVol = V.slice(-20).reduce((a, b) => a + b) / 20;
  const lastVol = V.at(-1);
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

  // BB position
  const bbRange = bb.u - bb.l;
  const bbPos = bbRange > 0 ? (cur - bb.l) / bbRange : 0.5;

  const regime = detectRegime(H, L, C, adx, atr);

  // ====== STRICT ENGINE ======
  if (isStrict) {
    // RSI
    if (rsi < 25) { B += 2; bInds++; } else if (rsi < 35) { B += 1.5; bInds++; } else if (rsi < 45) { B += 0.5; bInds++; }
    if (rsi > 75) { S += 2; sInds++; } else if (rsi > 65) { S += 1.5; sInds++; } else if (rsi > 55) { S += 0.5; sInds++; }

    // Stochastic
    if (stoch.k < 20 && stoch.k > stoch.d) { B += 2; bInds++; } else if (stoch.k < 30) { B += 1; bInds++; }
    if (stoch.k > 80 && stoch.k < stoch.d) { S += 2; sInds++; } else if (stoch.k > 70) { S += 1; sInds++; }

    // Bollinger Bands
    if (bbPos < 0.05) { B += 2; bInds++; } else if (bbPos < 0.15) { B += 1; bInds++; }
    if (bbPos > 0.95) { S += 2; sInds++; } else if (bbPos > 0.85) { S += 1; sInds++; }

    // MACD
    if (macd.h > 0 && macd.ph <= 0) { B += 2; bInds++; } else if (macd.h > 0) { B += 0.5; bInds++; }
    if (macd.h < 0 && macd.ph >= 0) { S += 2; sInds++; } else if (macd.h < 0) { S += 0.5; sInds++; }

    // EMA 5/13
    const ema5 = calcEMA(C, 5);
    const ema13 = calcEMA(C, 13);
    if (ema5 > ema13) { B += 1; bInds++; } else { S += 1; sInds++; }

    // VWAP
    if (cur > vwap) { B += 1; bInds++; } else { S += 1; sInds++; }

    // Volume
    if (volRatio > 1.5) { if (C.at(-1) > C.at(-2)) { B += 1; bInds++; } else { S += 1; sInds++; } }

    // Keltner
    if (keltner.position < 0.1) { B += 1.5; bInds++; } else if (keltner.position < 0.25) { B += 0.5; bInds++; }
    if (keltner.position > 0.9) { S += 1.5; sInds++; } else if (keltner.position > 0.75) { S += 0.5; sInds++; }

    // Parabolic SAR
    if (psar.trend === 'BUY') { B += 1; bInds++; } else { S += 1; sInds++; }

    // MFI
    if (mfi < 25) { B += 1.5; bInds++; } else if (mfi < 40) { B += 0.5; bInds++; }
    if (mfi > 75) { S += 1.5; sInds++; } else if (mfi > 60) { S += 0.5; sInds++; }

    // Gate logic
    let minScore = 7;
    const doubleAlign = htfTrend !== 'NEUTRAL' && mtfConfirm === htfTrend;
    if (doubleAlign) minScore = 6;

    // Strict: HTF MUST agree
    if (htfTrend === 'NEUTRAL') return { signal: 'NEUTRAL', score: Math.max(B, S) };

    let signal = 'NEUTRAL';
    if (B >= minScore && bInds >= 4 && B > S + 1 && htfTrend === 'BUY') signal = 'BUY';
    else if (S >= minScore && sInds >= 4 && S > B + 1 && htfTrend === 'SELL') signal = 'SELL';

    if (signal === 'NEUTRAL') return { signal: 'NEUTRAL', score: Math.max(B, S) };

    // Post-filters
    const atrPct = atr / cur * 100;
    if (atrPct > 0.8 || atrPct < 0.05) return { signal: 'NEUTRAL', score: Math.max(B, S), reason: 'volatility_filter' };

    // Momentum filter
    let consRed = 0;
    for (let i = C.length - 1; i >= Math.max(0, C.length - 5); i--) {
      if (C[i] < (C[i - 1] || C[i])) consRed++; else break;
    }
    if (signal === 'BUY' && consRed >= 4) return { signal: 'NEUTRAL', score: B, reason: 'momentum_filter' };

    let consGreen = 0;
    for (let i = C.length - 1; i >= Math.max(0, C.length - 5); i--) {
      if (C[i] > (C[i - 1] || C[i])) consGreen++; else break;
    }
    if (signal === 'SELL' && consGreen >= 4) return { signal: 'NEUTRAL', score: S, reason: 'momentum_filter' };

    // Volume filter
    const avgVol3 = V.slice(-3).reduce((a, b) => a + b) / 3;
    const avgVol20 = V.slice(-20).reduce((a, b) => a + b) / 20;
    if (avgVol3 < avgVol20 * 0.3) return { signal: 'NEUTRAL', score: Math.max(B, S), reason: 'volume_filter' };

    const score = signal === 'BUY' ? B : S;
    let conf = 65 + (score / 22) * 28;
    if (htfTrend === signal) conf += 5;
    if (mtfConfirm === signal) conf += 3;
    conf = Math.min(95, Math.max(55, conf));

    return { signal, score, confidence: conf, B, S, bInds, sInds, htfTrend, mtfConfirm, atr, cur };
  }

  // ====== SCALP ENGINE ======
  if (isScalp) {
    // RSI - generous
    if (rsi < 25) { B += 2; bInds++; } else if (rsi < 35) { B += 1.5; bInds++; } else if (rsi < 45) { B += 1; bInds++; }
    if (rsi > 75) { S += 2; sInds++; } else if (rsi > 65) { S += 1.5; sInds++; } else if (rsi > 55) { S += 1; sInds++; }

    // Stochastic - extended
    if (stoch.k < 25 && stoch.k > stoch.d) { B += 2; bInds++; } else if (stoch.k < 40) { B += 1; bInds++; }
    if (stoch.k > 75 && stoch.k < stoch.d) { S += 2; sInds++; } else if (stoch.k > 60) { S += 1; sInds++; }

    // Bollinger Bands - extended
    if (bbPos < 0.08) { B += 2; bInds++; } else if (bbPos < 0.25) { B += 1; bInds++; }
    if (bbPos > 0.92) { S += 2; sInds++; } else if (bbPos > 0.75) { S += 1; sInds++; }

    // MACD
    if (macd.h > 0 && macd.ph <= 0) { B += 2; bInds++; } else if (macd.h > 0) { B += 1; bInds++; }
    if (macd.h < 0 && macd.ph >= 0) { S += 2; sInds++; } else if (macd.h < 0) { S += 1; sInds++; }

    // EMA 5/13
    const ema5 = calcEMA(C, 5);
    const ema13 = calcEMA(C, 13);
    if (ema5 > ema13) { B += 1; bInds++; } else { S += 1; sInds++; }

    // VWAP
    if (cur > vwap) { B += 1; bInds++; } else { S += 1; sInds++; }

    // Volume - lower threshold
    if (volRatio > 0.8) { if (C.at(-1) > C.at(-2)) { B += 1; bInds++; } else { S += 1; sInds++; } }

    // Keltner - extended
    if (keltner.position < 0.15) { B += 1.5; bInds++; } else if (keltner.position < 0.3) { B += 0.5; bInds++; }
    if (keltner.position > 0.85) { S += 1.5; sInds++; } else if (keltner.position > 0.7) { S += 0.5; sInds++; }

    // Parabolic SAR
    if (psar.trend === 'BUY') { B += 1; bInds++; } else { S += 1; sInds++; }

    // MFI - extended
    if (mfi < 30) { B += 1.5; bInds++; } else if (mfi < 45) { B += 0.5; bInds++; }
    if (mfi > 70) { S += 1.5; sInds++; } else if (mfi > 55) { S += 0.5; sInds++; }

    // Gate logic
    let minScore = 6;
    const doubleAlign = mtfConfirm !== 'NEUTRAL' && htfTrend === mtfConfirm;
    if (doubleAlign) minScore = 5;
    else if (mtfConfirm === 'NEUTRAL') minScore = 7;

    let signal = 'NEUTRAL';
    if (B >= minScore && bInds >= 4 && B > S + 0.5) {
      // Check against HTF
      if (htfTrend === 'SELL') {
        if (B < minScore + 2) return { signal: 'NEUTRAL', score: B, reason: 'against_htf' };
      }
      signal = 'BUY';
    } else if (S >= minScore && sInds >= 4 && S > B + 0.5) {
      if (htfTrend === 'BUY') {
        if (S < minScore + 2) return { signal: 'NEUTRAL', score: S, reason: 'against_htf' };
      }
      signal = 'SELL';
    }

    if (signal === 'NEUTRAL') return { signal: 'NEUTRAL', score: Math.max(B, S) };

    // Volume filter
    if (volRatio < 0.3) return { signal: 'NEUTRAL', score: Math.max(B, S), reason: 'volume_filter' };

    // Momentum filter
    let consRed = 0;
    for (let i = C.length - 1; i >= Math.max(0, C.length - 5); i--) {
      if (C[i] < (C[i - 1] || C[i])) consRed++; else break;
    }
    if (signal === 'BUY' && consRed >= 4) return { signal: 'NEUTRAL', score: B, reason: 'momentum_filter' };

    let consGreen = 0;
    for (let i = C.length - 1; i >= Math.max(0, C.length - 5); i--) {
      if (C[i] > (C[i - 1] || C[i])) consGreen++; else break;
    }
    if (signal === 'SELL' && consGreen >= 4) return { signal: 'NEUTRAL', score: S, reason: 'momentum_filter' };

    const score = signal === 'BUY' ? B : S;
    let conf = 50 + (score / 22) * 40;
    if (mtfConfirm === signal) conf += 3;
    if (htfTrend === signal) conf += 5;
    conf = Math.min(90, Math.max(50, conf));

    return { signal, score, confidence: conf, B, S, bInds, sInds, htfTrend, mtfConfirm, atr, cur };
  }

  return { signal: 'NEUTRAL', score: 0 };
}

// ============================================================================
// BINANCE DATA FETCHER
// ============================================================================

function fetchKlines(symbol, interval, startTime, endTime, limit = 1000) {
  return new Promise((resolve, reject) => {
    let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    if (startTime) url += `&startTime=${startTime}`;
    if (endTime) url += `&endTime=${endTime}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.code) { reject(new Error(parsed.msg)); return; }
          resolve(parsed.map(k => [
            k[0],                    // openTime
            parseFloat(k[1]),        // open
            parseFloat(k[2]),        // high
            parseFloat(k[3]),        // low
            parseFloat(k[4]),        // close
            parseFloat(k[5]),        // volume
            k[6],                    // closeTime
          ]));
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchAllKlines(symbol, interval, startTime, endTime) {
  const allKlines = [];
  let currentStart = startTime;
  const intervalMs = {
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000
  };
  const stepMs = 1000 * intervalMs[interval];

  while (currentStart < endTime) {
    const klines = await fetchKlines(symbol, interval, currentStart, endTime, 1000);
    if (!klines.length) break;
    allKlines.push(...klines);
    const lastTime = klines[klines.length - 1][0];
    if (lastTime >= endTime || klines.length < 1000) break;
    currentStart = lastTime + intervalMs[interval];
    await sleep(100); // Rate limit
  }

  return allKlines;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================================
// WALK-FORWARD BACKTESTER
// ============================================================================

async function runBacktest(symbol, mode, days = 60) {
  const now = Date.now();
  const startTime = now - days * 24 * 60 * 60 * 1000;
  const endTime = now;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  BACKTEST: ${symbol} | Mode: ${mode.toUpperCase()} | ${days} days`);
  console.log(`  Period: ${new Date(startTime).toISOString().slice(0, 10)} → ${new Date(endTime).toISOString().slice(0, 10)}`);
  console.log(`${'='.repeat(70)}`);

  // Fetch all data
  console.log('  Fetching 5m klines...');
  const kl5m = await fetchAllKlines(symbol, '5m', startTime, endTime);
  console.log(`  → ${kl5m.length} candles (5m)`);

  console.log('  Fetching 15m klines...');
  const kl15m = await fetchAllKlines(symbol, '15m', startTime, endTime);
  console.log(`  → ${kl15m.length} candles (15m)`);

  console.log('  Fetching 1h klines...');
  const kl1h = await fetchAllKlines(symbol, '1h', startTime, endTime);
  console.log(`  → ${kl1h.length} candles (1h)`);

  // Walk-forward simulation
  const lookback5m = 280;
  const lookback15m = 100;
  const lookback1h = 50;
  const stepBars = mode === 'strict' ? 36 : 12; // Cooldown in bars

  const trades = [];
  let lastSignalBar = -999;
  let totalBars = kl5m.length;
  let signalsChecked = 0;

  console.log(`\n  Walking forward through ${totalBars} bars (step=${stepBars})...`);

  for (let i = lookback5m; i < totalBars - 1; i += 1) {
    // Cooldown check
    if (i - lastSignalBar < stepBars) continue;

    signalsChecked++;

    // Build windows
    const window5m = kl5m.slice(Math.max(0, i - lookback5m), i + 1);

    // Find matching 15m/1h windows by timestamp
    const curTime = kl5m[i][0];
    const kl15Window = kl15m.filter(k => k[0] <= curTime).slice(-lookback15m);
    const kl1hWindow = kl1h.filter(k => k[0] <= curTime).slice(-lookback1h);

    if (window5m.length < 50) continue;

    const result = genSigFromData(window5m, kl15Window, kl1hWindow, mode);

    if (!result || result.signal === 'NEUTRAL') continue;

    // We have a signal! Calculate TP/SL
    const entry = result.cur;
    const atrVal = result.atr || calcATR(
      window5m.map(k => k[2]),
      window5m.map(k => k[3]),
      window5m.map(k => k[4]),
      14
    );

    const tpMult = 1.8;
    const slMult = 1.0;
    let tpDist = atrVal * tpMult;
    let slDist = atrVal * slMult;

    const minTPdist = entry * 0.002;
    if (tpDist < minTPdist) tpDist = minTPdist;
    if (slDist < entry * 0.001) slDist = entry * 0.001;

    const costBuffer = entry * 0.0008;
    const slipBuffer = entry * 0.0005;
    const totalBuffer = costBuffer + slipBuffer;

    let tp, sl;
    if (result.signal === 'BUY') {
      tp = entry + tpDist - totalBuffer;
      sl = entry - slDist + slipBuffer;
    } else {
      tp = entry - tpDist + totalBuffer;
      sl = entry + slDist - slipBuffer;
    }

    // Simulate outcome using FUTURE candles
    let outcome = null;
    let exitPrice = null;
    let exitBar = null;
    let maxFavorable = 0;
    let maxAdverse = 0;
    const maxBarsHold = mode === 'strict' ? 144 : 48; // 12h strict, 4h scalp

    for (let j = i + 1; j < Math.min(i + maxBarsHold, totalBars); j++) {
      const candle = kl5m[j];
      const high = candle[2];
      const low = candle[3];
      const close = candle[4];

      if (result.signal === 'BUY') {
        maxFavorable = Math.max(maxFavorable, (high - entry) / entry * 100);
        maxAdverse = Math.max(maxAdverse, (entry - low) / entry * 100);

        // Check SL first (worst case)
        if (low <= sl) {
          outcome = 'SL';
          exitPrice = sl;
          exitBar = j;
          break;
        }
        // Check TP
        if (high >= tp) {
          outcome = 'TP';
          exitPrice = tp;
          exitBar = j;
          break;
        }
      } else {
        maxFavorable = Math.max(maxFavorable, (entry - low) / entry * 100);
        maxAdverse = Math.max(maxAdverse, (high - entry) / entry * 100);

        if (high >= sl) {
          outcome = 'SL';
          exitPrice = sl;
          exitBar = j;
          break;
        }
        if (low <= tp) {
          outcome = 'TP';
          exitPrice = tp;
          exitBar = j;
          break;
        }
      }
    }

    // If neither TP nor SL hit, close at last bar
    if (!outcome) {
      const lastBar = Math.min(i + maxBarsHold - 1, totalBars - 1);
      exitPrice = kl5m[lastBar][4];
      exitBar = lastBar;
      if (result.signal === 'BUY') {
        outcome = exitPrice > entry ? 'PROFIT' : 'LOSS';
      } else {
        outcome = exitPrice < entry ? 'PROFIT' : 'LOSS';
      }
    }

    const pnlPct = result.signal === 'BUY'
      ? ((exitPrice - entry) / entry * 100)
      : ((entry - exitPrice) / entry * 100);

    // Deduct fees (0.08% round trip)
    const netPnl = pnlPct - 0.16;

    const holdTime = (exitBar - i) * 5; // minutes

    trades.push({
      date: new Date(kl5m[i][6]).toISOString().slice(0, 16),
      signal: result.signal,
      entry: entry,
      tp: tp,
      sl: sl,
      exit: exitPrice,
      outcome,
      pnlPct: netPnl,
      holdMins: holdTime,
      score: result.score,
      conf: result.confidence,
      htf: result.htfTrend,
      mtf: result.mtfConfirm,
      maxFav: maxFavorable,
      maxAdv: maxAdverse,
      bInds: result.bInds,
      sInds: result.sInds,
    });

    lastSignalBar = i;
  }

  return { symbol, mode, trades, signalsChecked, totalBars, startTime, endTime };
}

// ============================================================================
// RESULTS PRINTER
// ============================================================================

function printResults(result) {
  const { symbol, mode, trades, signalsChecked, totalBars } = result;

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  RESULTADOS: ${symbol} ${mode.toUpperCase()}`);
  console.log(`${'─'.repeat(70)}`);

  if (!trades.length) {
    console.log('  Sin señales generadas en el periodo.');
    return { totalTrades: 0 };
  }

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const tpHits = trades.filter(t => t.outcome === 'TP');
  const slHits = trades.filter(t => t.outcome === 'SL');
  const buys = trades.filter(t => t.signal === 'BUY');
  const sells = trades.filter(t => t.signal === 'SELL');

  const totalPnl = trades.reduce((s, t) => s + t.pnlPct, 0);
  const avgPnl = totalPnl / trades.length;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const winRate = (wins.length / trades.length * 100);
  const profitFactor = losses.length && Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0)) > 0
    ? wins.reduce((s, t) => s + t.pnlPct, 0) / Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0))
    : Infinity;

  const avgHold = trades.reduce((s, t) => s + t.holdMins, 0) / trades.length;
  const avgConf = trades.reduce((s, t) => s + (t.conf || 0), 0) / trades.length;

  // Max consecutive wins/losses
  let maxConsWins = 0, maxConsLosses = 0, cw = 0, cl = 0;
  for (const t of trades) {
    if (t.pnlPct > 0) { cw++; cl = 0; maxConsWins = Math.max(maxConsWins, cw); }
    else { cl++; cw = 0; maxConsLosses = Math.max(maxConsLosses, cl); }
  }

  // Drawdown
  let equity = 1000;
  let peak = 1000;
  let maxDD = 0;
  const equityCurve = [];
  for (const t of trades) {
    equity *= (1 + t.pnlPct / 100);
    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe ratio approximation (daily)
  const dailyReturns = [];
  let dayTrades = [];
  let currentDay = trades[0]?.date?.slice(0, 10);
  for (const t of trades) {
    const day = t.date?.slice(0, 10);
    if (day !== currentDay) {
      if (dayTrades.length) dailyReturns.push(dayTrades.reduce((s, x) => s + x.pnlPct, 0));
      dayTrades = [];
      currentDay = day;
    }
    dayTrades.push(t);
  }
  if (dayTrades.length) dailyReturns.push(dayTrades.reduce((s, x) => s + x.pnlPct, 0));
  const avgDaily = dailyReturns.length ? dailyReturns.reduce((a, b) => a + b) / dailyReturns.length : 0;
  const stdDaily = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((s, r) => s + Math.pow(r - avgDaily, 2), 0) / (dailyReturns.length - 1))
    : 0;
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(365) : 0;

  // Best/Worst trades
  const best = trades.reduce((b, t) => t.pnlPct > b.pnlPct ? t : b, trades[0]);
  const worst = trades.reduce((w, t) => t.pnlPct < w.pnlPct ? t : w, trades[0]);

  console.log(`
  ┌─────────────────────────────────────────────────────────────────┐
  │                    RESUMEN EJECUTIVO                            │
  ├─────────────────────────────────────────────────────────────────┤
  │  Total Signals Checked:     ${String(signalsChecked).padStart(8)}                         │
  │  Total Trades:              ${String(trades.length).padStart(8)}                         │
  │  Bars Processed:            ${String(totalBars).padStart(8)}                         │
  ├─────────────────────────────────────────────────────────────────┤
  │  WIN RATE:                  ${(winRate.toFixed(2) + '%').padStart(8)}                         │
  │  Wins / Losses:             ${String(wins.length).padStart(4)} / ${String(losses.length).padEnd(4)}                        │
  │  TP Hits / SL Hits:         ${String(tpHits.length).padStart(4)} / ${String(slHits.length).padEnd(4)}                        │
  │  BUY / SELL Signals:        ${String(buys.length).padStart(4)} / ${String(sells.length).padEnd(4)}                        │
  ├─────────────────────────────────────────────────────────────────┤
  │  TOTAL P&L (net fees):      ${(totalPnl.toFixed(2) + '%').padStart(8)}                         │
  │  Avg Trade P&L:             ${(avgPnl.toFixed(3) + '%').padStart(8)}                         │
  │  Avg Win:                   ${('+' + avgWin.toFixed(3) + '%').padStart(8)}                         │
  │  Avg Loss:                  ${(avgLoss.toFixed(3) + '%').padStart(8)}                         │
  │  PROFIT FACTOR:             ${profitFactor === Infinity ? '     Inf' : profitFactor.toFixed(3).padStart(8)}                         │
  ├─────────────────────────────────────────────────────────────────┤
  │  Max Consecutive Wins:      ${String(maxConsWins).padStart(8)}                         │
  │  Max Consecutive Losses:    ${String(maxConsLosses).padStart(8)}                         │
  │  Max Drawdown:              ${(maxDD.toFixed(2) + '%').padStart(8)}                         │
  │  Sharpe Ratio (annualized): ${sharpe.toFixed(3).padStart(8)}                         │
  ├─────────────────────────────────────────────────────────────────┤
  │  Avg Hold Time:             ${(avgHold.toFixed(0) + ' min').padStart(8)}                         │
  │  Avg Confidence:            ${(avgConf.toFixed(1) + '%').padStart(8)}                         │
  │  Equity $1000 →             ${('$' + equity.toFixed(2)).padStart(8)}                         │
  ├─────────────────────────────────────────────────────────────────┤
  │  Best Trade:  ${best.date} ${best.signal.padEnd(4)} ${('+' + best.pnlPct.toFixed(3) + '%').padStart(9)}          │
  │  Worst Trade: ${worst.date} ${worst.signal.padEnd(4)} ${(worst.pnlPct.toFixed(3) + '%').padStart(9)}          │
  └─────────────────────────────────────────────────────────────────┘`);

  // Win rate by signal direction
  const buyWR = buys.length ? (buys.filter(t => t.pnlPct > 0).length / buys.length * 100).toFixed(1) : 'N/A';
  const sellWR = sells.length ? (sells.filter(t => t.pnlPct > 0).length / sells.length * 100).toFixed(1) : 'N/A';
  const buyPnl = buys.reduce((s, t) => s + t.pnlPct, 0);
  const sellPnl = sells.reduce((s, t) => s + t.pnlPct, 0);

  console.log(`
  ┌─────────────────────────────────────────────────────────────────┐
  │  BY DIRECTION                                                   │
  ├──────────┬──────────┬──────────┬──────────┬─────────────────────┤
  │          │  Count   │  WinRate │  P&L     │  Avg P&L            │
  ├──────────┼──────────┼──────────┼──────────┼─────────────────────┤
  │  BUY     │  ${String(buys.length).padStart(6)}  │  ${String(buyWR + '%').padStart(6)}  │  ${(buyPnl.toFixed(2) + '%').padStart(7)} │  ${(buys.length ? (buyPnl / buys.length).toFixed(3) + '%' : 'N/A').padStart(8)}            │
  │  SELL    │  ${String(sells.length).padStart(6)}  │  ${String(sellWR + '%').padStart(6)}  │  ${(sellPnl.toFixed(2) + '%').padStart(7)} │  ${(sells.length ? (sellPnl / sells.length).toFixed(3) + '%' : 'N/A').padStart(8)}            │
  └──────────┴──────────┴──────────┴──────────┴─────────────────────┘`);

  // Win rate by confidence bucket
  const confBuckets = {};
  for (const t of trades) {
    const bucket = Math.floor((t.conf || 50) / 10) * 10;
    const key = `${bucket}-${bucket + 9}%`;
    if (!confBuckets[key]) confBuckets[key] = { wins: 0, total: 0, pnl: 0 };
    confBuckets[key].total++;
    if (t.pnlPct > 0) confBuckets[key].wins++;
    confBuckets[key].pnl += t.pnlPct;
  }

  console.log(`
  ┌─────────────────────────────────────────────────────────────────┐
  │  BY CONFIDENCE                                                  │
  ├──────────────┬──────────┬──────────┬────────────────────────────┤
  │  Bucket      │  Count   │  WinRate │  P&L                      │
  ├──────────────┼──────────┼──────────┼────────────────────────────┤`);
  for (const [k, v] of Object.entries(confBuckets).sort()) {
    console.log(`  │  ${k.padEnd(12)}│  ${String(v.total).padStart(6)}  │  ${(v.total ? (v.wins / v.total * 100).toFixed(1) + '%' : 'N/A').padStart(6)}  │  ${(v.pnl.toFixed(2) + '%').padStart(8)}                    │`);
  }
  console.log(`  └──────────────┴──────────┴──────────┴────────────────────────────┘`);

  // Weekly breakdown
  const weeklyData = {};
  for (const t of trades) {
    const d = new Date(t.date);
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay());
    const weekKey = weekStart.toISOString().slice(0, 10);
    if (!weeklyData[weekKey]) weeklyData[weekKey] = { trades: 0, wins: 0, pnl: 0 };
    weeklyData[weekKey].trades++;
    if (t.pnlPct > 0) weeklyData[weekKey].wins++;
    weeklyData[weekKey].pnl += t.pnlPct;
  }

  console.log(`
  ┌─────────────────────────────────────────────────────────────────┐
  │  WEEKLY BREAKDOWN                                               │
  ├──────────────┬──────────┬──────────┬────────────────────────────┤
  │  Week        │  Trades  │  WinRate │  P&L                      │
  ├──────────────┼──────────┼──────────┼────────────────────────────┤`);
  for (const [w, v] of Object.entries(weeklyData).sort()) {
    const wr = v.trades ? (v.wins / v.trades * 100).toFixed(1) : '0';
    console.log(`  │  ${w.padEnd(12)}│  ${String(v.trades).padStart(6)}  │  ${(wr + '%').padStart(6)}  │  ${(v.pnl.toFixed(2) + '%').padStart(8)}                    │`);
  }
  console.log(`  └──────────────┴──────────┴──────────┴────────────────────────────┘`);

  // Print last 20 trades
  console.log(`
  ┌─────────────────────────────────────────────────────────────────────────────────────────┐
  │  LAST 20 TRADES                                                                         │
  ├──────────────────┬──────┬───────────┬───────────┬───────────┬────────┬──────┬────────────┤
  │  Date            │ Dir  │ Entry     │ TP        │ SL        │ P&L    │ Out  │ Hold       │
  ├──────────────────┼──────┼───────────┼───────────┼───────────┼────────┼──────┼────────────┤`);
  for (const t of trades.slice(-20)) {
    const pnlStr = (t.pnlPct >= 0 ? '+' : '') + t.pnlPct.toFixed(3) + '%';
    console.log(`  │  ${t.date.padEnd(16)}│ ${t.signal.padEnd(4)} │ ${t.entry.toFixed(2).padStart(9)} │ ${t.tp.toFixed(2).padStart(9)} │ ${t.sl.toFixed(2).padStart(9)} │ ${pnlStr.padStart(6)} │ ${t.outcome.padEnd(4)} │ ${(t.holdMins + 'min').padStart(8)}   │`);
  }
  console.log(`  └──────────────────┴──────┴───────────┴───────────┴───────────┴────────┴──────┴────────────┘`);

  return {
    totalTrades: trades.length,
    winRate,
    totalPnl,
    profitFactor,
    maxDrawdown: maxDD,
    sharpe,
    equity,
    avgHold,
    avgConf,
    trades
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║          RxTrading Walk-Forward Backtest Engine v1.0                ║
║          Datos REALES de Binance | 60 días                         ║
║          Fecha: ${new Date().toISOString().slice(0, 19)}                        ║
╚══════════════════════════════════════════════════════════════════════╝`);

  // Symbols to test (top volume pairs)
  const symbols = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT'
  ];

  const modes = ['strict', 'scalp'];
  const allResults = {};

  for (const mode of modes) {
    console.log(`\n\n${'█'.repeat(70)}`);
    console.log(`  MODE: ${mode.toUpperCase()}`);
    console.log(`${'█'.repeat(70)}`);

    allResults[mode] = {};
    const aggregated = {
      totalTrades: 0, wins: 0, losses: 0, totalPnl: 0,
      allTrades: [], tpHits: 0, slHits: 0
    };

    for (const sym of symbols) {
      try {
        const result = await runBacktest(sym, mode, 60);
        const stats = printResults(result);
        allResults[mode][sym] = stats;

        if (stats.totalTrades > 0) {
          aggregated.totalTrades += stats.totalTrades;
          aggregated.wins += stats.trades.filter(t => t.pnlPct > 0).length;
          aggregated.losses += stats.trades.filter(t => t.pnlPct <= 0).length;
          aggregated.totalPnl += stats.totalPnl;
          aggregated.tpHits += stats.trades.filter(t => t.outcome === 'TP').length;
          aggregated.slHits += stats.trades.filter(t => t.outcome === 'SL').length;
          aggregated.allTrades.push(...stats.trades);
        }

        await sleep(500); // Rate limit between symbols
      } catch (err) {
        console.log(`  ERROR ${sym}: ${err.message}`);
        await sleep(1000);
      }
    }

    // Aggregated results
    const agg = aggregated;
    console.log(`\n\n${'═'.repeat(70)}`);
    console.log(`  RESULTADOS AGREGADOS — ${mode.toUpperCase()} MODE (${symbols.length} pares, 60 días)`);
    console.log(`${'═'.repeat(70)}`);

    if (agg.totalTrades > 0) {
      const aggWR = (agg.wins / agg.totalTrades * 100);
      const aggAvgPnl = agg.totalPnl / agg.totalTrades;

      // Equity curve aggregated
      let equity = 10000;
      let peak = 10000;
      let maxDD = 0;
      for (const t of agg.allTrades.sort((a, b) => a.date.localeCompare(b.date))) {
        equity *= (1 + t.pnlPct / 100);
        if (equity > peak) peak = equity;
        const dd = (peak - equity) / peak * 100;
        if (dd > maxDD) maxDD = dd;
      }

      const avgHold = agg.allTrades.reduce((s, t) => s + t.holdMins, 0) / agg.totalTrades;
      const avgConf = agg.allTrades.reduce((s, t) => s + (t.conf || 0), 0) / agg.totalTrades;

      const totalWinPnl = agg.allTrades.filter(t => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
      const totalLossPnl = Math.abs(agg.allTrades.filter(t => t.pnlPct <= 0).reduce((s, t) => s + t.pnlPct, 0));
      const pf = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : Infinity;

      console.log(`
  ╔═══════════════════════════════════════════════════════════════════╗
  ║                 RESUMEN FINAL ${mode.toUpperCase().padEnd(6)}                           ║
  ╠═══════════════════════════════════════════════════════════════════╣
  ║  Total Trades:              ${String(agg.totalTrades).padStart(8)}                        ║
  ║  WIN RATE:                  ${(aggWR.toFixed(2) + '%').padStart(8)}                        ║
  ║  Wins / Losses:             ${String(agg.wins).padStart(4)} / ${String(agg.losses).padEnd(4)}                       ║
  ║  TP / SL Hits:              ${String(agg.tpHits).padStart(4)} / ${String(agg.slHits).padEnd(4)}                       ║
  ╠═══════════════════════════════════════════════════════════════════╣
  ║  TOTAL P&L (net fees):      ${(agg.totalPnl.toFixed(2) + '%').padStart(8)}                        ║
  ║  Avg Trade:                 ${(aggAvgPnl.toFixed(3) + '%').padStart(8)}                        ║
  ║  PROFIT FACTOR:             ${pf === Infinity ? '     Inf' : pf.toFixed(3).padStart(8)}                        ║
  ║  MAX DRAWDOWN:              ${(maxDD.toFixed(2) + '%').padStart(8)}                        ║
  ╠═══════════════════════════════════════════════════════════════════╣
  ║  Avg Hold Time:             ${(avgHold.toFixed(0) + ' min').padStart(8)}                        ║
  ║  Avg Confidence:            ${(avgConf.toFixed(1) + '%').padStart(8)}                        ║
  ║  $10,000 → $${equity.toFixed(2).padStart(11)}                                     ║
  ╚═══════════════════════════════════════════════════════════════════╝`);

      // Per-symbol summary
      console.log(`
  ┌──────────────────────────────────────────────────────────────────┐
  │  PER-SYMBOL SUMMARY                                             │
  ├──────────┬──────────┬──────────┬──────────┬──────────────────────┤
  │  Symbol  │  Trades  │  WinRate │  P&L     │  Equity             │
  ├──────────┼──────────┼──────────┼──────────┼──────────────────────┤`);
      for (const sym of symbols) {
        const s = allResults[mode][sym];
        if (s && s.totalTrades > 0) {
          console.log(`  │  ${sym.padEnd(8)}│  ${String(s.totalTrades).padStart(6)}  │  ${(s.winRate.toFixed(1) + '%').padStart(6)}  │  ${(s.totalPnl.toFixed(2) + '%').padStart(7)} │  $${s.equity.toFixed(2).padStart(10)}          │`);
        } else {
          console.log(`  │  ${sym.padEnd(8)}│       0  │    N/A  │     N/A │         N/A          │`);
        }
      }
      console.log(`  └──────────┴──────────┴──────────┴──────────┴──────────────────────┘`);
    } else {
      console.log('  No se generaron señales en ningún par para este modo.');
    }
  }

  console.log(`\n\n${'═'.repeat(70)}`);
  console.log('  BACKTEST COMPLETADO');
  console.log(`  Fecha: ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(70)}\n`);
}

main().catch(console.error);
