#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// COMPREHENSIVE BACKTEST ENGINE — 3 Signal Motors Audit
// Fetches real Binance 5m/15m/1h klines for last 14 days
// Replicates exact genSig() logic for strict, scalp, frequent
// ═══════════════════════════════════════════════════════════════

const https = require('https');

// ═══ CONFIGURATION ═══
const CAPITAL = 10000;
const POS_SIZE = 500;
const LEVERAGE = 5;
const FEE_RT = 0.0008; // 0.08% round-trip
const TIMEOUT_CANDLES = [30, 50, 80]; // test multiple timeouts
const DEFAULT_TIMEOUT = 50;

const VIP_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','ADAUSDT','DOTUSDT','LINKUSDT','APTUSDT','NEARUSDT','ATOMUSDT','FILUSDT','UNIUSDT','ARBUSDT','OPUSDT','SHIBUSDT','TRXUSDT','SUIUSDT','SEIUSDT','TIAUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT'];
const SCALP_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','DOTUSDT','NEARUSDT','APTUSDT'];
const FREE_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];

const COOLDOWNS = { strict: 24, scalp: 12, frequent: 8 }; // candles

// ═══ INDICATOR FUNCTIONS (exact replicas from app.html) ═══

function calcRSI(closes, p = 14) {
  if (closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l += Math.abs(d); }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p; al = (al * (p - 1) + (d < 0 ? Math.abs(d) : 0)) / p; }
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}

function calcEMAArr(data, p) { const k = 2 / (p + 1); const r = [data[0]]; for (let i = 1; i < data.length; i++) r.push(data[i] * k + r[i - 1] * (1 - k)); return r; }
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
  const sl = closes.slice(-p); const m = sl.reduce((a, b) => a + b) / p;
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
  const dArr = []; for (let i = 2; i < kArr.length; i++) dArr.push((kArr[i] + kArr[i - 1] + kArr[i - 2]) / 3);
  return { k: kArr.at(-1) || 50, d: dArr.at(-1) || 50 };
}

function calcATR(H, L, C, p = 14) {
  if (C.length < p + 1) return 0;
  const trs = []; for (let i = 1; i < C.length; i++) trs.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
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
    const r = []; let s = arr.slice(0, period).reduce((a, b) => a + b) / period;
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
  for (let i = 1; i < C.length; i++) { if (C[i] > C[i - 1]) obv += V[i]; else if (C[i] < C[i - 1]) obv -= V[i]; arr.push(obv); }
  const n = Math.min(arr.length, 20); const recent = arr.slice(-n);
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += recent[i]; sumXY += i * recent[i]; sumX2 += i * i; }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX || 1);
  return { obv: arr.at(-1), slope, rising: slope > 0 };
}

function calcParabolicSAR(H, L, C) {
  if (C.length < 5) return { sar: C.at(-1), trend: 'BUY', recentFlip: false };
  let af = 0.02, maxAf = 0.2, sar = L[0], ep = H[0], isUp = true, lastFlipIdx = 0;
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

function calcVWAP(klines) {
  let cumVol = 0, cumVolPrice = 0; const vwapArr = [];
  for (const k of klines) {
    const typPrice = (k.h + k.l + k.c) / 3; const vol = k.v;
    cumVol += vol; cumVolPrice += (typPrice * vol);
    vwapArr.push(cumVolPrice / cumVol);
  }
  return vwapArr;
}

function calcKeltner(H, L, C, emaLen = 20, atrLen = 14, mult = 2) {
  if (C.length < Math.max(emaLen, atrLen) + 1) return { upper: 0, mid: 0, lower: 0, width: 0, position: 0.5, atr: 0 };
  const mid = calcEMA(C, emaLen); const atr = calcATR(H, L, C, atrLen);
  const upper = mid + mult * atr; const lower = mid - mult * atr;
  const range = upper - lower; const width = mid ? range / mid : 0;
  const cur = C.at(-1); const position = range > 0 ? (cur - lower) / range : 0.5;
  return { upper, mid, lower, width, position, atr };
}

function detectOrderBlocks(H, L, C, V, lookback = 50) {
  if (C.length < lookback) return { bullOB: null, bearOB: null };
  const tail = C.length - lookback;
  let bullOB = null, bearOB = null;
  for (let i = tail + 2; i < C.length - 1; i++) {
    const body = Math.abs(C[i] - C[i - 1]);
    const avgBody = Math.abs(C[i - 1] - C[i - 2]);
    const volSpike = V[i] > V[i - 1] * 1.5;
    if (body > avgBody * 1.5 && volSpike) {
      if (C[i] > C[i - 1]) { bullOB = { price: L[i], high: H[i], idx: i }; }
      else { bearOB = { price: H[i], low: L[i], idx: i }; }
    }
  }
  return { bullOB, bearOB };
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

function detectRSIDivergence(C, H, L, period = 14) {
  if (C.length < period + 25) return { bull: false, bear: false };
  const rsiArr = [];
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) { const d = C[i] - C[i - 1]; if (d > 0) ag += d; else al += Math.abs(d); }
  ag /= period; al /= period;
  rsiArr.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
  for (let i = period + 1; i < C.length; i++) {
    const d = C[i] - C[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    rsiArr.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
  }
  const len = Math.min(rsiArr.length, 40);
  const priceTail = C.slice(-len); const rsiTail = rsiArr.slice(-len);
  let priceLows = [], priceHighs = [];
  for (let i = 3; i < len - 3; i++) {
    let isLow = true, isHigh = true;
    for (let j = 1; j <= 3; j++) {
      if (priceTail[i] > priceTail[i - j] || priceTail[i] > priceTail[i + j]) isLow = false;
      if (priceTail[i] < priceTail[i - j] || priceTail[i] < priceTail[i + j]) isHigh = false;
    }
    if (isLow) priceLows.push({ idx: i, price: priceTail[i], rsi: rsiTail[i] });
    if (isHigh) priceHighs.push({ idx: i, price: priceTail[i], rsi: rsiTail[i] });
  }
  let bull = false;
  if (priceLows.length >= 2) {
    const [prev, last] = priceLows.slice(-2);
    if (last.idx - prev.idx >= 5 && last.price < prev.price && last.rsi > prev.rsi + 2) bull = true;
  }
  let bear = false;
  if (priceHighs.length >= 2) {
    const [prev, last] = priceHighs.slice(-2);
    if (last.idx - prev.idx >= 5 && last.price > prev.price && last.rsi < prev.rsi - 2) bear = true;
  }
  return { bull, bear };
}

function detectMACDDivergence(C) {
  if (C.length < 40) return { bull: false, bear: false };
  const e12 = calcEMAArr(C, 12), e26 = calcEMAArr(C, 26);
  const macdLine = e12.map((v, i) => v - e26[i]);
  const len = Math.min(macdLine.length, 40);
  const priceTail = C.slice(-len); const macdTail = macdLine.slice(-len);
  let priceLows = [], priceHighs = [];
  for (let i = 3; i < len - 3; i++) {
    let isLow = true, isHigh = true;
    for (let j = 1; j <= 3; j++) {
      if (priceTail[i] > priceTail[i - j] || priceTail[i] > priceTail[i + j]) isLow = false;
      if (priceTail[i] < priceTail[i - j] || priceTail[i] < priceTail[i + j]) isHigh = false;
    }
    if (isLow) priceLows.push({ idx: i, price: priceTail[i], macd: macdTail[i] });
    if (isHigh) priceHighs.push({ idx: i, price: priceTail[i], macd: macdTail[i] });
  }
  let bull = false, bear = false;
  if (priceLows.length >= 2) {
    const [prev, last] = priceLows.slice(-2);
    if (last.idx - prev.idx >= 5 && last.price < prev.price && last.macd > prev.macd) bull = true;
  }
  if (priceHighs.length >= 2) {
    const [prev, last] = priceHighs.slice(-2);
    if (last.idx - prev.idx >= 5 && last.price > prev.price && last.macd < prev.macd) bear = true;
  }
  return { bull, bear };
}

function findPivotLevels(H, L, C, lookback = 50) {
  const tail = Math.max(0, C.length - lookback);
  let supports = [], resistances = [];
  for (let i = tail + 4; i < C.length - 1; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= 4; j++) {
      if (i - j >= tail && H[i] <= H[i - j]) isHigh = false;
      if (i + j < C.length && H[i] <= H[i + j]) isHigh = false;
      if (i - j >= tail && L[i] >= L[i - j]) isLow = false;
      if (i + j < C.length && L[i] >= L[i + j]) isLow = false;
    }
    if (isHigh) resistances.push(H[i]);
    if (isLow) supports.push(L[i]);
  }
  const cur = C.at(-1);
  const nearestRes = resistances.filter(r => r > cur).sort((a, b) => a - b)[0] || null;
  const nearestSup = supports.filter(s => s < cur).sort((a, b) => b - a)[0] || null;
  return { nearestRes, nearestSup, supports, resistances };
}

// ═══ DATA FETCHING ═══

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

async function getKlines(sym, tf, limit = 1000, startTime = null, endTime = null) {
  let url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`;
  if (startTime) url += `&startTime=${startTime}`;
  if (endTime) url += `&endTime=${endTime}`;
  const data = await fetchJSON(url);
  return data.map(k => ({
    t: k[0], o: parseFloat(k[1]), h: parseFloat(k[2]), l: parseFloat(k[3]),
    c: parseFloat(k[4]), v: parseFloat(k[5]), ct: k[6]
  }));
}

async function getAllKlines(sym, tf, days = 14) {
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;
  const allKlines = [];
  let cursor = start;
  while (cursor < now) {
    const batch = await getKlines(sym, tf, 1000, cursor);
    if (!batch || !batch.length) break;
    allKlines.push(...batch);
    cursor = batch[batch.length - 1].t + 1;
    if (batch.length < 1000) break;
    await sleep(100); // rate limit
  }
  // deduplicate by timestamp
  const seen = new Set();
  return allKlines.filter(k => { if (seen.has(k.t)) return false; seen.add(k.t); return true; });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══ SIGNAL GENERATION (exact replica of genSig) ═══

function genSignal(C5, H5, L5, V5, C15, H15, L15, C1h, H1h, L1h, V1h, kl5Raw, hourUTC, mode, sym) {
  if (!C5 || C5.length < 50) return null;
  const isStrict = mode === 'strict';
  const isScalp = mode === 'scalp';

  const cur = C5.at(-1);
  let B = 0, S = 0;
  const inds = [];

  // STEP 1: HTF Trend (1H)
  let htfTrend = 'NEUTRAL', htfStrength = 0;
  if (C1h && C1h.length > 25) {
    const ema9h = calcEMA(C1h, 9), ema21h = calcEMA(C1h, 21), ema50h = calcEMA(C1h, 50);
    const rsi1h = calcRSI(C1h, 14); const mac1h = calcMACD(C1h);
    const adx1h = calcADX(H1h, L1h, C1h); const obv1h = calcOBV(C1h, V1h);
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
  if (C15 && C15.length > 25) {
    const ema9_15 = calcEMA(C15, 9), ema21_15 = calcEMA(C15, 21);
    const rsi15 = calcRSI(C15, 14); const mac15 = calcMACD(C15);
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
  const avgV = V5.slice(-20).reduce((a, b) => a + b) / 20;
  const lv = V5.at(-1);
  const vr = lv / avgV;
  const adxData = calcADX(H5, L5, C5);
  const obvData = calcOBV(C5, V5);
  const psar = calcParabolicSAR(H5, L5, C5);
  const stFull = calcStoch(H5, L5, C5, 14);
  let atr = calcATR(H5, L5, C5, 14);
  const rsiDiv = detectRSIDivergence(C5, H5, L5, 14);
  const macdDiv = detectMACDDivergence(C5);

  // Regime
  let regimeData = detectRegime(H5, L5, C5, adxData, atr);
  const regime = regimeData.regime || 'RANGING';
  const isTrending = regime === 'TRENDING';
  const isQuiet = regime === 'QUIET';
  const isVolatile = regime === 'VOLATILE';

  // Keltner + Order Blocks
  const kc = calcKeltner(H5, L5, C5, 20, 14, 2);
  let orderBlocks = { bullOB: null, bearOB: null };
  try { orderBlocks = detectOrderBlocks(H5, L5, C5, V5, 50); } catch (e) { }

  // ═══ SCORING BY MODE ═══

  if (isStrict && isTrending) {
    // TREND-FOLLOWING MODE
    if (e9 > e21 && e9p <= e21p) { B += 2.5; inds.push({ s: 'BUY' }); }
    else if (e9 < e21 && e9p >= e21p) { S += 2.5; inds.push({ s: 'SELL' }); }
    else if (e9 > e21) { B += 0.5; inds.push({ s: 'BUY' }); }
    else { S += 0.5; inds.push({ s: 'SELL' }); }

    if (cur > e50) { B += 0.5; inds.push({ s: 'BUY' }); } else { S += 0.5; inds.push({ s: 'SELL' }); }

    if (mac.h > 0 && mac.ph < 0) { B += 2; inds.push({ s: 'BUY' }); }
    else if (mac.h < 0 && mac.ph > 0) { S += 2; inds.push({ s: 'SELL' }); }
    else if (mac.h > 0 && mac.h > mac.ph) { B += 1; inds.push({ s: 'BUY' }); }
    else if (mac.h < 0 && mac.h < mac.ph) { S += 1; inds.push({ s: 'SELL' }); }

    if (adxData.pdi > adxData.mdi) { B += 2; inds.push({ s: 'BUY' }); } else { S += 2; inds.push({ s: 'SELL' }); }
    if (obvData.rising) { B += 1; inds.push({ s: 'BUY' }); } else { S += 1; inds.push({ s: 'SELL' }); }

    if (psar.recentFlip) {
      if (psar.trend === 'BUY') { B += 1.5; inds.push({ s: 'BUY' }); } else { S += 1.5; inds.push({ s: 'SELL' }); }
    } else {
      if (psar.trend === 'BUY') { B += 0.5; inds.push({ s: 'BUY' }); } else { S += 0.5; inds.push({ s: 'SELL' }); }
    }

    if (cur > (kl5Raw ? calcVWAP(kl5Raw.slice(-50)).at(-1) : e21) && vr > 0.7) { B += 0.5; inds.push({ s: 'BUY' }); }
    else if (cur < (kl5Raw ? calcVWAP(kl5Raw.slice(-50)).at(-1) : e21) && vr > 0.7) { S += 0.5; inds.push({ s: 'SELL' }); }

    if (kc.position > 1.0) { B += 1; inds.push({ s: 'BUY' }); }
    else if (kc.position < 0) { S += 1; inds.push({ s: 'SELL' }); }
    else if (kc.position > 0.7) { B += 0.3; inds.push({ s: 'BUY' }); }
    else if (kc.position < 0.3) { S += 0.3; inds.push({ s: 'SELL' }); }

    if (orderBlocks.bullOB && cur <= orderBlocks.bullOB.price * 1.005) { B += 1.5; inds.push({ s: 'BUY' }); }
    else if (orderBlocks.bearOB && cur >= orderBlocks.bearOB.price * 0.995) { S += 1.5; inds.push({ s: 'SELL' }); }

    // RSI as NEUTRAL in trend mode
    inds.push({ s: 'NEUTRAL' });

    if (rsiDiv.bull) { B += 2.5; inds.push({ s: 'BUY' }); }
    else if (rsiDiv.bear) { S += 2.5; inds.push({ s: 'SELL' }); }
    if (macdDiv.bull) { B += 2; inds.push({ s: 'BUY' }); }
    else if (macdDiv.bear) { S += 2; inds.push({ s: 'SELL' }); }

  } else if (isStrict && !isTrending) {
    // VIP MEAN-REVERSION
    if (rsi < 25) { B += 4; inds.push({ s: 'BUY' }); }
    else if (rsi < 30) { B += 3; inds.push({ s: 'BUY' }); }
    else if (rsi < 35) { B += 2; inds.push({ s: 'BUY' }); }
    else if (rsi > 75) { S += 4; inds.push({ s: 'SELL' }); }
    else if (rsi > 70) { S += 3; inds.push({ s: 'SELL' }); }
    else if (rsi > 65) { S += 2; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    if (stFull.k < 20) { B += 3; inds.push({ s: 'BUY' }); }
    else if (stFull.k < 30) { B += 2; inds.push({ s: 'BUY' }); }
    else if (stFull.k > 80) { S += 3; inds.push({ s: 'SELL' }); }
    else if (stFull.k > 70) { S += 2; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    const bbR = bb.u - bb.l; const bbPos = bbR > 0 ? (cur - bb.l) / bbR : 0.5;
    if (bbPos < 0.1) { B += 3; inds.push({ s: 'BUY' }); }
    else if (bbPos < 0.2) { B += 2; inds.push({ s: 'BUY' }); }
    else if (bbPos > 0.9) { S += 3; inds.push({ s: 'SELL' }); }
    else if (bbPos > 0.8) { S += 2; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    const mom3 = (cur - (C5[C5.length - 4] || cur)) / Math.max(atr, 0.0001);
    if (mom3 < -1) { B += 2; inds.push({ s: 'BUY' }); }
    else if (mom3 < -0.5) { B += 1; inds.push({ s: 'BUY' }); }
    else if (mom3 > 1) { S += 2; inds.push({ s: 'SELL' }); }
    else if (mom3 > 0.5) { S += 1; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    let bearRun = 0, bullRun = 0;
    for (let ci = Math.max(0, C5.length - 4); ci < C5.length; ci++) {
      if (C5[ci] < (C5[ci - 1] || C5[ci])) bearRun++; else bearRun = 0;
      if (C5[ci] > (C5[ci - 1] || C5[ci])) bullRun++; else bullRun = 0;
    }
    if (bearRun >= 4) { B += 2; inds.push({ s: 'BUY' }); }
    else if (bearRun >= 3) { B += 1; inds.push({ s: 'BUY' }); }
    if (bullRun >= 4) { S += 2; inds.push({ s: 'SELL' }); }
    else if (bullRun >= 3) { S += 1; inds.push({ s: 'SELL' }); }

    const emaDist = (cur - e21) / Math.max(atr, 0.0001);
    if (emaDist < -1.5) { B += 1.5; inds.push({ s: 'BUY' }); }
    else if (emaDist < -0.8) { B += 0.8; inds.push({ s: 'BUY' }); }
    else if (emaDist > 1.5) { S += 1.5; inds.push({ s: 'SELL' }); }
    else if (emaDist > 0.8) { S += 0.8; inds.push({ s: 'SELL' }); }

    if (mac.h > 0 && mac.ph <= 0) { B += 1.5; inds.push({ s: 'BUY' }); }
    else if (mac.h < 0 && mac.ph >= 0) { S += 1.5; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    if (obvData.rising && B > S) { B += 1; inds.push({ s: 'BUY' }); }
    else if (!obvData.rising && S > B) { S += 1; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    if (vr > 1.5) { if (B > S) B *= 1.1; else S *= 1.1; }

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
    else if (rsi < 35) { B += 2; inds.push({ s: 'BUY' }); }
    else if (rsi < 40) { B += 1; inds.push({ s: 'BUY' }); }
    else if (rsi > 75) { S += 4; inds.push({ s: 'SELL' }); }
    else if (rsi > 70) { S += 3; inds.push({ s: 'SELL' }); }
    else if (rsi > 65) { S += 2; inds.push({ s: 'SELL' }); }
    else if (rsi > 60) { S += 1; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    if (stochK < 20) { B += 3; inds.push({ s: 'BUY' }); }
    else if (stochK < 30) { B += 1.5; inds.push({ s: 'BUY' }); }
    else if (stochK > 80) { S += 3; inds.push({ s: 'SELL' }); }
    else if (stochK > 70) { S += 1.5; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    if (bbP < 0.1) { B += 3; inds.push({ s: 'BUY' }); }
    else if (bbP < 0.2) { B += 2; inds.push({ s: 'BUY' }); }
    else if (bbP > 0.9) { S += 3; inds.push({ s: 'SELL' }); }
    else if (bbP > 0.8) { S += 2; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    if (mom3val < -1.0) { B += 2; inds.push({ s: 'BUY' }); }
    else if (mom3val < -0.5) { B += 1; inds.push({ s: 'BUY' }); }
    else if (mom3val > 1.0) { S += 2; inds.push({ s: 'SELL' }); }
    else if (mom3val > 0.5) { S += 1; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    if (scalpBearExh) { B += 2; inds.push({ s: 'BUY' }); }
    else if (scalpBullExh) { S += 2; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    if (emaDist21 < -1.5) { B += 1.5; inds.push({ s: 'BUY' }); }
    else if (emaDist21 > 1.5) { S += 1.5; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    if (mac.h > 0 && mac.ph < 0) { S += 1; inds.push({ s: 'SELL' }); } // CONTRARIAN
    else if (mac.h < 0 && mac.ph > 0) { B += 1; inds.push({ s: 'BUY' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

  } else {
    // FREE MODE
    if (rsi < 28) { B += 3; inds.push({ s: 'BUY' }); }
    else if (rsi < 35) { B += 2; inds.push({ s: 'BUY' }); }
    else if (rsi < 40) { B += 1; inds.push({ s: 'BUY' }); }
    else if (rsi > 72) { S += 3; inds.push({ s: 'SELL' }); }
    else if (rsi > 65) { S += 2; inds.push({ s: 'SELL' }); }
    else if (rsi > 60) { S += 1; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    const stoch = stFull.k || 50;
    if (stoch < 25) { B += 2; inds.push({ s: 'BUY' }); }
    else if (stoch < 35) { B += 1; inds.push({ s: 'BUY' }); }
    else if (stoch > 75) { S += 2; inds.push({ s: 'SELL' }); }
    else if (stoch > 65) { S += 1; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    const bbR = bb.u - bb.l; const bbPos = bbR > 0 ? (cur - bb.l) / bbR : 0.5;
    if (bbPos < 0.15) { B += 2; inds.push({ s: 'BUY' }); }
    else if (bbPos < 0.25) { B += 1; inds.push({ s: 'BUY' }); }
    else if (bbPos > 0.85) { S += 2; inds.push({ s: 'SELL' }); }
    else if (bbPos > 0.75) { S += 1; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    const freeMom3 = (cur - (C5[C5.length - 4] || cur)) / Math.max(atr, 0.0001);
    if (freeMom3 < -0.8) { B += 1; inds.push({ s: 'BUY' }); }
    else if (freeMom3 > 0.8) { S += 1; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    if (mac.h > 0 && mac.ph < 0) { B += 1; inds.push({ s: 'BUY' }); }
    else if (mac.h < 0 && mac.ph > 0) { S += 1; inds.push({ s: 'SELL' }); }
    else { inds.push({ s: 'NEUTRAL' }); }

    if (obvData.rising) { B += 0.5; inds.push({ s: 'BUY' }); }
    else { S += 0.5; inds.push({ s: 'SELL' }); }
  }

  // Volume multiplier (non-scalp)
  if (!isScalp) {
    if (vr > 1.5 && B > S) B *= 1.1;
    else if (vr > 1.5 && S > B) S *= 1.1;
  }

  // ═══ DECISION ENGINE ═══
  const buyInds = inds.filter(i => i.s === 'BUY').length;
  const sellInds = inds.filter(i => i.s === 'SELL').length;

  let signal = 'NEUTRAL';
  let conf = 0;
  let filterReason = null;

  if (isStrict) {
    const vipMinConv = 8, vipMinConds = 3;
    if (isTrending) { filterReason = 'TRENDING_BLOCK'; }
    else if (B > S && B >= vipMinConv && buyInds >= vipMinConds) signal = 'BUY';
    else if (S > B && S >= vipMinConv && sellInds >= vipMinConds) signal = 'SELL';

    if (signal !== 'NEUTRAL' && adxData.adx > 20) { signal = 'NEUTRAL'; filterReason = 'ADX>20'; }
    if (signal !== 'NEUTRAL' && (hourUTC === 8 || hourUTC === 21 || hourUTC === 22)) { signal = 'NEUTRAL'; filterReason = 'BLOCKED_HOUR'; }
    if (signal !== 'NEUTRAL' && isVolatile) { signal = 'NEUTRAL'; filterReason = 'VOLATILE'; }

    if (signal !== 'NEUTRAL') {
      const convScore = signal === 'BUY' ? B : S;
      const condCount = signal === 'BUY' ? buyInds : sellInds;
      conf = Math.min(85, Math.round(50 + convScore * 2.5 + condCount * 1.5));
      if (htfTrend === signal) conf = Math.min(85, conf + 5);
      if (mtfConfirm === signal) conf = Math.min(85, conf + 3);
      if (rsiDiv.bull && signal === 'BUY') conf = Math.min(85, conf + 3);
      if (rsiDiv.bear && signal === 'SELL') conf = Math.min(85, conf + 3);
    }

  } else if (isScalp) {
    const scalpMinConv = 6, scalpMinConds = 3;
    if (B > S && B >= scalpMinConv && buyInds >= scalpMinConds) signal = 'BUY';
    else if (S > B && S >= scalpMinConv && sellInds >= scalpMinConds) signal = 'SELL';

    if (signal !== 'NEUTRAL' && adxData.adx > 20) { signal = 'NEUTRAL'; filterReason = 'ADX>20'; }
    if (signal === 'BUY' && mtfConfirm === 'SELL') { signal = 'NEUTRAL'; filterReason = 'MTF_CONTRA'; }
    if (signal === 'SELL' && mtfConfirm === 'BUY') { signal = 'NEUTRAL'; filterReason = 'MTF_CONTRA'; }
    if (signal !== 'NEUTRAL' && hourUTC >= 0 && hourUTC < 6) { signal = 'NEUTRAL'; filterReason = 'DEAD_HOURS'; }
    if (signal !== 'NEUTRAL' && vr < 0.3) { signal = 'NEUTRAL'; filterReason = 'LOW_VOL'; }

    if (signal !== 'NEUTRAL') {
      const maxConv = Math.max(B, S);
      conf = Math.min(85, Math.max(55, Math.round(50 + maxConv * 3)));
    }

  } else {
    const freeMinConv = 5, freeMinConds = 2;
    if (B > S && B >= freeMinConv && buyInds >= freeMinConds) signal = 'BUY';
    else if (S > B && S >= freeMinConv && sellInds >= freeMinConds) signal = 'SELL';

    if (signal !== 'NEUTRAL' && isTrending) { signal = 'NEUTRAL'; filterReason = 'TRENDING'; }
    if (signal !== 'NEUTRAL' && isVolatile) { signal = 'NEUTRAL'; filterReason = 'VOLATILE'; }
    if (signal !== 'NEUTRAL' && adxData.adx > 30) { signal = 'NEUTRAL'; filterReason = 'ADX>30'; }
    if (signal !== 'NEUTRAL' && hourUTC >= 0 && hourUTC < 6) { signal = 'NEUTRAL'; filterReason = 'DEAD_HOURS'; }
    if (signal !== 'NEUTRAL' && vr < 0.4) { signal = 'NEUTRAL'; filterReason = 'LOW_VOL'; }

    if (signal !== 'NEUTRAL') {
      const convScore = signal === 'BUY' ? B : S;
      const condCount = signal === 'BUY' ? buyInds : sellInds;
      conf = Math.min(75, Math.round(40 + convScore * 2 + condCount * 1.5));
    }
  }

  // ═══ TP/SL CALCULATION ═══
  let atr15 = atr;
  if (C15 && C15.length > 15 && H15 && H15.length > 15 && L15 && L15.length > 15) {
    const _a15 = calcATR(H15, L15, C15, 14);
    if (_a15 > 0) atr15 = _a15;
  }
  let atr1h = atr;
  if (H1h && H1h.length > 15 && L1h && L1h.length > 15 && C1h && C1h.length > 15) {
    const _a1h = calcATR(H1h, L1h, C1h, 14);
    if (_a1h > 0) atr1h = _a1h;
  }
  const blendedATR = Math.max(atr15, atr1h / 4);

  // Min volatility check (strict only)
  if (isStrict && signal !== 'NEUTRAL') {
    const volPct = atr15 / cur;
    if (volPct < 0.0008) { signal = 'NEUTRAL'; filterReason = 'LOW_ATR'; }
  }

  let tpDist, slDist;
  if (isScalp) {
    const useATR = atr15 || blendedATR;
    tpDist = useATR * 1.0;
    slDist = useATR * 1.0;
  } else if (isStrict) {
    tpDist = blendedATR * 1.5;
    slDist = blendedATR * 1.0;
  } else {
    tpDist = blendedATR * 1.5;
    slDist = blendedATR * 1.0;
  }

  // Min TP enforcement
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

  // S/R awareness (strict & scalp)
  if (signal !== 'NEUTRAL' && (isStrict || isScalp)) {
    try {
      let pivotH = H5, pivotL = L5, pivotC = C5;
      if (H1h && H1h.length > 20) { pivotH = H1h; pivotL = L1h; pivotC = C1h; }
      const pivots = findPivotLevels(pivotH, pivotL, pivotC, 50);
      if (signal === 'BUY' && pivots.nearestRes) {
        const distToRes = pivots.nearestRes - cur;
        if (distToRes > 0 && distToRes < tpDist * 0.7) {
          if (distToRes > slDist * 1.2) tpDist = distToRes * 0.92;
          else { signal = 'NEUTRAL'; filterReason = 'SR_BLOCK'; }
        }
      }
      if (signal === 'SELL' && pivots.nearestSup) {
        const distToSup = cur - pivots.nearestSup;
        if (distToSup > 0 && distToSup < tpDist * 0.7) {
          if (distToSup > slDist * 1.2) tpDist = distToSup * 0.92;
          else { signal = 'NEUTRAL'; filterReason = 'SR_BLOCK'; }
        }
      }
    } catch (e) { }
  }

  if (signal === 'NEUTRAL') return { signal: 'NEUTRAL', filterReason, B, S, buyInds, sellInds, regime };

  const tp = signal === 'BUY' ? cur + tpDist + costBuffer : cur - tpDist - costBuffer;
  const sl = signal === 'BUY' ? cur - slDist - costBuffer : cur + slDist + costBuffer;

  return { signal, conf, entry: cur, tp, sl, tpDist, slDist, B, S, buyInds, sellInds, regime, htfTrend, mtfConfirm, adx: adxData.adx, rsi, filterReason: null };
}

// ═══ BACKTEST SIMULATION ═══

function simulateTrades(signals5m, klines5m, mode, timeoutCandles = 50) {
  const trades = [];
  const cooldown = COOLDOWNS[mode];
  const lastTradeBar = {}; // per-symbol cooldown tracker

  for (let i = 0; i < signals5m.length; i++) {
    const sig = signals5m[i];
    if (!sig || sig.signal === 'NEUTRAL') continue;

    const sym = sig.sym;
    const barIdx = sig.barIdx;

    // Cooldown check
    if (lastTradeBar[sym] !== undefined && (barIdx - lastTradeBar[sym]) < cooldown) continue;

    // Find the klines for this symbol starting from this bar
    const symKlines = klines5m[sym];
    if (!symKlines || barIdx >= symKlines.length - 1) continue;

    const entryPrice = sig.entry;
    const tp = sig.tp;
    const sl = sig.sl;
    let exitPrice = null, exitReason = null, exitBar = null;

    // Simulate forward from entry
    for (let j = barIdx + 1; j < Math.min(barIdx + timeoutCandles + 1, symKlines.length); j++) {
      const candle = symKlines[j];

      if (sig.signal === 'BUY') {
        // Check SL first (conservative — assume worst case intrabar)
        if (candle.l <= sl) { exitPrice = sl; exitReason = 'SL'; exitBar = j; break; }
        if (candle.h >= tp) { exitPrice = tp; exitReason = 'TP'; exitBar = j; break; }
      } else {
        if (candle.h >= sl) { exitPrice = sl; exitReason = 'SL'; exitBar = j; break; }
        if (candle.l <= tp) { exitPrice = tp; exitReason = 'TP'; exitBar = j; break; }
      }
    }

    // Timeout
    if (!exitPrice) {
      const timeoutBar = Math.min(barIdx + timeoutCandles, symKlines.length - 1);
      exitPrice = symKlines[timeoutBar].c;
      exitReason = 'TIMEOUT';
      exitBar = timeoutBar;
    }

    // PnL calculation
    let pnlPct;
    if (sig.signal === 'BUY') pnlPct = (exitPrice - entryPrice) / entryPrice;
    else pnlPct = (entryPrice - exitPrice) / entryPrice;

    pnlPct -= FEE_RT; // subtract fees
    const pnlDollar = POS_SIZE * LEVERAGE * pnlPct;
    const duration = (exitBar - barIdx) * 5; // minutes

    const entryTime = new Date(symKlines[barIdx].t);
    const exitTime = new Date(symKlines[exitBar].t);

    trades.push({
      sym, signal: sig.signal, entryPrice, exitPrice, tp, sl,
      pnlPct, pnlDollar, exitReason, duration,
      entryTime, exitTime, barIdx, exitBar,
      regime: sig.regime, adx: sig.adx, rsi: sig.rsi,
      conf: sig.conf, hourUTC: entryTime.getUTCHours(),
      dayOfWeek: entryTime.getUTCDay(),
      B: sig.B, S: sig.S
    });

    lastTradeBar[sym] = barIdx;
  }

  return trades;
}

// ═══ METRICS CALCULATION ═══

function calcMetrics(trades, label) {
  if (!trades.length) return { label, trades: 0 };

  const wins = trades.filter(t => t.pnlDollar > 0);
  const losses = trades.filter(t => t.pnlDollar <= 0);
  const wr = (wins.length / trades.length * 100);
  const totalPnl = trades.reduce((s, t) => s + t.pnlDollar, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlDollar, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlDollar, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const expectancy = (wr / 100 * avgWin) - ((1 - wr / 100) * avgLoss);

  // Max drawdown
  let peak = CAPITAL, equity = CAPITAL, maxDD = 0;
  const equityCurve = [CAPITAL];
  for (const t of trades) {
    equity += t.pnlDollar;
    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const avgDuration = trades.reduce((s, t) => s + t.duration, 0) / trades.length;
  const best = trades.reduce((a, b) => a.pnlDollar > b.pnlDollar ? a : b);
  const worst = trades.reduce((a, b) => a.pnlDollar < b.pnlDollar ? a : b);

  // Consecutive wins/losses
  let maxConsW = 0, maxConsL = 0, cw = 0, cl = 0;
  for (const t of trades) {
    if (t.pnlDollar > 0) { cw++; cl = 0; maxConsW = Math.max(maxConsW, cw); }
    else { cl++; cw = 0; maxConsL = Math.max(maxConsL, cl); }
  }

  // By symbol
  const bySym = {};
  for (const t of trades) {
    if (!bySym[t.sym]) bySym[t.sym] = { trades: 0, pnl: 0, wins: 0 };
    bySym[t.sym].trades++;
    bySym[t.sym].pnl += t.pnlDollar;
    if (t.pnlDollar > 0) bySym[t.sym].wins++;
  }

  // By hour
  const byHour = {};
  for (let h = 0; h < 24; h++) byHour[h] = { trades: 0, pnl: 0, wins: 0 };
  for (const t of trades) {
    byHour[t.hourUTC].trades++;
    byHour[t.hourUTC].pnl += t.pnlDollar;
    if (t.pnlDollar > 0) byHour[t.hourUTC].wins++;
  }

  // By regime
  const byRegime = {};
  for (const t of trades) {
    if (!byRegime[t.regime]) byRegime[t.regime] = { trades: 0, pnl: 0, wins: 0 };
    byRegime[t.regime].trades++;
    byRegime[t.regime].pnl += t.pnlDollar;
    if (t.pnlDollar > 0) byRegime[t.regime].wins++;
  }

  // By day of week
  const byDay = {};
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const t of trades) {
    const d = dayNames[t.dayOfWeek];
    if (!byDay[d]) byDay[d] = { trades: 0, pnl: 0, wins: 0 };
    byDay[d].trades++;
    byDay[d].pnl += t.pnlDollar;
    if (t.pnlDollar > 0) byDay[d].wins++;
  }

  // By exit reason
  const byExit = {};
  for (const t of trades) {
    if (!byExit[t.exitReason]) byExit[t.exitReason] = { count: 0, pnl: 0 };
    byExit[t.exitReason].count++;
    byExit[t.exitReason].pnl += t.pnlDollar;
  }

  // Daily Sharpe
  const dailyPnl = {};
  for (const t of trades) {
    const day = t.entryTime.toISOString().slice(0, 10);
    if (!dailyPnl[day]) dailyPnl[day] = 0;
    dailyPnl[day] += t.pnlDollar;
  }
  const dailyReturns = Object.values(dailyPnl);
  const avgDaily = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const stdDaily = Math.sqrt(dailyReturns.reduce((a, b) => a + Math.pow(b - avgDaily, 2), 0) / dailyReturns.length);
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(365) : 0;

  // Equity curve by day
  const dailyEquity = {};
  let eq = CAPITAL;
  for (const t of trades) {
    const day = t.entryTime.toISOString().slice(0, 10);
    eq += t.pnlDollar;
    dailyEquity[day] = eq;
  }

  return {
    label, trades: trades.length,
    buys: trades.filter(t => t.signal === 'BUY').length,
    sells: trades.filter(t => t.signal === 'SELL').length,
    wr: wr.toFixed(1),
    totalPnl: totalPnl.toFixed(2),
    totalPnlPct: (totalPnl / CAPITAL * 100).toFixed(2),
    pf: pf.toFixed(2),
    maxDD: maxDD.toFixed(2),
    avgDuration: avgDuration.toFixed(0),
    avgWin: avgWin.toFixed(2),
    avgLoss: avgLoss.toFixed(2),
    expectancy: expectancy.toFixed(2),
    sharpe: sharpe.toFixed(2),
    maxConsW, maxConsL,
    best: { sym: best.sym, pnl: best.pnlDollar.toFixed(2), signal: best.signal, time: best.entryTime.toISOString() },
    worst: { sym: worst.sym, pnl: worst.pnlDollar.toFixed(2), signal: worst.signal, time: worst.entryTime.toISOString() },
    bySym, byHour, byRegime, byDay, byExit, dailyEquity,
    finalEquity: eq.toFixed(2)
  };
}

// ═══ MAIN BACKTEST RUNNER ═══

async function runBacktest() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  COMPREHENSIVE BACKTEST — 3 Signal Engines × 14 Days');
  console.log('  Capital: $' + CAPITAL + ' | Pos: $' + POS_SIZE + ' | Leverage: ' + LEVERAGE + 'x');
  console.log('═══════════════════════════════════════════════════════\n');

  const allSyms = [...new Set([...VIP_SYMS, ...SCALP_SYMS, ...FREE_SYMS])];
  const klines = { '5m': {}, '15m': {}, '1h': {} };

  // Fetch data for all symbols
  console.log(`Fetching data for ${allSyms.length} symbols (5m + 15m + 1h)...`);
  for (const sym of allSyms) {
    process.stdout.write(`  ${sym}...`);
    try {
      klines['5m'][sym] = await getAllKlines(sym, '5m', 14);
      await sleep(50);
      klines['15m'][sym] = await getAllKlines(sym, '15m', 14);
      await sleep(50);
      klines['1h'][sym] = await getAllKlines(sym, '1h', 14);
      await sleep(50);
      console.log(` ${klines['5m'][sym].length} bars (5m)`);
    } catch (e) {
      console.log(` FAILED: ${e.message}`);
    }
  }

  console.log('\n--- Data fetching complete ---\n');

  // Run each engine
  const results = {};
  for (const mode of ['strict', 'scalp', 'frequent']) {
    const syms = mode === 'strict' ? VIP_SYMS : mode === 'scalp' ? SCALP_SYMS : FREE_SYMS;
    console.log(`\n═══ Running ${mode.toUpperCase()} engine on ${syms.length} pairs ═══`);

    const allSignals = [];
    let totalGenerated = 0, totalFiltered = 0;
    const filterCounts = {};

    for (const sym of syms) {
      const k5 = klines['5m'][sym];
      const k15 = klines['15m'][sym];
      const k1h = klines['1h'][sym];
      if (!k5 || k5.length < 280) { console.log(`  ${sym}: insufficient data (${k5 ? k5.length : 0} bars)`); continue; }

      const C5 = k5.map(k => k.c), H5 = k5.map(k => k.h), L5 = k5.map(k => k.l), V5 = k5.map(k => k.v);

      // Slide window: need 280 bars lookback
      const LOOKBACK = 280;
      for (let i = LOOKBACK; i < k5.length; i++) {
        const sliceC5 = C5.slice(i - LOOKBACK, i + 1);
        const sliceH5 = H5.slice(i - LOOKBACK, i + 1);
        const sliceL5 = L5.slice(i - LOOKBACK, i + 1);
        const sliceV5 = V5.slice(i - LOOKBACK, i + 1);

        // Find corresponding 15m and 1h data
        const candleTime = k5[i].t;
        const hourUTC = new Date(candleTime).getUTCHours();

        let C15 = null, H15 = null, L15 = null;
        if (k15 && k15.length > 30) {
          const idx15 = k15.findIndex(k => k.t > candleTime);
          const end15 = idx15 > 0 ? idx15 : k15.length;
          const start15 = Math.max(0, end15 - 100);
          const slice15 = k15.slice(start15, end15);
          C15 = slice15.map(k => k.c);
          H15 = slice15.map(k => k.h);
          L15 = slice15.map(k => k.l);
        }

        let C1h = null, H1h = null, L1h = null, V1h = null;
        if (k1h && k1h.length > 30) {
          const idx1h = k1h.findIndex(k => k.t > candleTime);
          const end1h = idx1h > 0 ? idx1h : k1h.length;
          const start1h = Math.max(0, end1h - 50);
          const slice1h = k1h.slice(start1h, end1h);
          C1h = slice1h.map(k => k.c);
          H1h = slice1h.map(k => k.h);
          L1h = slice1h.map(k => k.l);
          V1h = slice1h.map(k => k.v);
        }

        // Build kl5Raw for VWAP
        const kl5Raw = k5.slice(Math.max(0, i - 50), i + 1);

        const sig = genSignal(sliceC5, sliceH5, sliceL5, sliceV5, C15, H15, L15, C1h, H1h, L1h, V1h, kl5Raw, hourUTC, mode, sym);

        totalGenerated++;

        if (sig && sig.signal !== 'NEUTRAL') {
          allSignals.push({ ...sig, sym, barIdx: i });
        } else if (sig && sig.filterReason) {
          totalFiltered++;
          filterCounts[sig.filterReason] = (filterCounts[sig.filterReason] || 0) + 1;
        }
      }
    }

    console.log(`  Total bars scanned: ${totalGenerated}`);
    console.log(`  Signals generated: ${allSignals.length}`);
    console.log(`  Signals filtered: ${totalFiltered}`);
    console.log(`  Filter breakdown:`, JSON.stringify(filterCounts));

    // Simulate trades with different timeouts
    for (const timeout of TIMEOUT_CANDLES) {
      const trades = simulateTrades(allSignals, klines['5m'], mode, timeout);
      const metrics = calcMetrics(trades, `${mode.toUpperCase()} (timeout=${timeout})`);
      results[`${mode}_t${timeout}`] = metrics;

      console.log(`\n  --- ${mode.toUpperCase()} | Timeout=${timeout} bars (${timeout * 5}min) ---`);
      console.log(`  Trades: ${metrics.trades} | WR: ${metrics.wr}% | PnL: $${metrics.totalPnl} (${metrics.totalPnlPct}%)`);
      console.log(`  PF: ${metrics.pf} | MaxDD: ${metrics.maxDD}% | Avg Duration: ${metrics.avgDuration}min`);
      console.log(`  Expectancy: $${metrics.expectancy} | Sharpe: ${metrics.sharpe}`);
      console.log(`  Max Consecutive W/L: ${metrics.maxConsW}/${metrics.maxConsL}`);
      if (metrics.trades > 0) {
        console.log(`  Best: ${metrics.best.sym} $${metrics.best.pnl} | Worst: ${metrics.worst.sym} $${metrics.worst.pnl}`);
        console.log(`  Final Equity: $${metrics.finalEquity}`);
      }
    }

    // Detailed breakdown for default timeout
    const defaultKey = `${mode}_t${DEFAULT_TIMEOUT}`;
    const m = results[defaultKey];
    if (m && m.trades > 0) {
      console.log(`\n  ═══ DETAILED BREAKDOWN (${mode.toUpperCase()}, timeout=50) ═══`);

      // By Symbol
      console.log('\n  BY SYMBOL:');
      console.log('  ' + 'Symbol'.padEnd(12) + 'Trades'.padStart(8) + 'WR%'.padStart(8) + 'PnL $'.padStart(10));
      const sortedSyms = Object.entries(m.bySym).sort((a, b) => b[1].pnl - a[1].pnl);
      for (const [sym, data] of sortedSyms) {
        const wr = data.trades > 0 ? (data.wins / data.trades * 100).toFixed(1) : '0.0';
        console.log('  ' + sym.padEnd(12) + String(data.trades).padStart(8) + (wr + '%').padStart(8) + ('$' + data.pnl.toFixed(2)).padStart(10));
      }

      // By Hour (top 5 best, top 5 worst)
      console.log('\n  BY HOUR UTC (sorted by PnL):');
      const sortedHours = Object.entries(m.byHour).filter(([, d]) => d.trades > 0).sort((a, b) => b[1].pnl - a[1].pnl);
      console.log('  ' + 'Hour'.padEnd(6) + 'Trades'.padStart(8) + 'WR%'.padStart(8) + 'PnL $'.padStart(10));
      for (const [hour, data] of sortedHours) {
        const wr = data.trades > 0 ? (data.wins / data.trades * 100).toFixed(1) : '0.0';
        console.log('  ' + (hour + 'h').padEnd(6) + String(data.trades).padStart(8) + (wr + '%').padStart(8) + ('$' + data.pnl.toFixed(2)).padStart(10));
      }

      // By Regime
      console.log('\n  BY REGIME:');
      for (const [reg, data] of Object.entries(m.byRegime)) {
        const wr = data.trades > 0 ? (data.wins / data.trades * 100).toFixed(1) : '0.0';
        console.log(`  ${reg.padEnd(12)} ${data.trades} trades, WR=${wr}%, PnL=$${data.pnl.toFixed(2)}`);
      }

      // By Day
      console.log('\n  BY DAY OF WEEK:');
      for (const [day, data] of Object.entries(m.byDay)) {
        if (data.trades === 0) continue;
        const wr = (data.wins / data.trades * 100).toFixed(1);
        console.log(`  ${day.padEnd(5)} ${data.trades} trades, WR=${wr}%, PnL=$${data.pnl.toFixed(2)}`);
      }

      // By Exit Reason
      console.log('\n  BY EXIT REASON:');
      for (const [reason, data] of Object.entries(m.byExit)) {
        console.log(`  ${reason.padEnd(10)} ${data.count} trades, PnL=$${data.pnl.toFixed(2)}`);
      }

      // Equity curve by day
      console.log('\n  EQUITY CURVE (daily):');
      for (const [day, eq] of Object.entries(m.dailyEquity)) {
        const change = eq - CAPITAL;
        console.log(`  ${day}  $${eq.toFixed(2)} (${change >= 0 ? '+' : ''}${change.toFixed(2)})`);
      }
    }
  }

  // ═══ COMPARATIVE SUMMARY ═══
  console.log('\n\n═══════════════════════════════════════════════════════');
  console.log('  COMPARATIVE SUMMARY (timeout=50 bars)');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
  console.log('  ' + 'Engine'.padEnd(12) + 'Trades'.padStart(8) + 'WR%'.padStart(8) + 'PnL$'.padStart(10) + 'PnL%'.padStart(8) + 'PF'.padStart(6) + 'MaxDD%'.padStart(8) + 'AvgDur'.padStart(8) + 'Sharpe'.padStart(8));
  console.log('  ' + '-'.repeat(76));

  for (const mode of ['strict', 'scalp', 'frequent']) {
    const key = `${mode}_t${DEFAULT_TIMEOUT}`;
    const m = results[key];
    if (!m || !m.trades) { console.log(`  ${mode.toUpperCase().padEnd(12)} — no trades —`); continue; }
    console.log('  ' +
      mode.toUpperCase().padEnd(12) +
      String(m.trades).padStart(8) +
      (m.wr + '%').padStart(8) +
      ('$' + m.totalPnl).padStart(10) +
      (m.totalPnlPct + '%').padStart(8) +
      m.pf.padStart(6) +
      (m.maxDD + '%').padStart(8) +
      (m.avgDuration + 'm').padStart(8) +
      m.sharpe.padStart(8)
    );
  }

  // Timeout comparison
  console.log('\n\n═══ TIMEOUT SENSITIVITY ANALYSIS ═══');
  for (const mode of ['strict', 'scalp', 'frequent']) {
    console.log(`\n  ${mode.toUpperCase()}:`);
    for (const t of TIMEOUT_CANDLES) {
      const m = results[`${mode}_t${t}`];
      if (!m || !m.trades) continue;
      console.log(`    T=${t} (${t * 5}min): ${m.trades} trades, WR=${m.wr}%, PnL=$${m.totalPnl} (${m.totalPnlPct}%), PF=${m.pf}`);
    }
  }

  // R:R sensitivity for scalp
  console.log('\n\n═══ R:R ANALYSIS NOTE ═══');
  console.log('  Scalp uses 1:1 R:R (TP=SL=1xATR). The TP/SL distance is symmetric.');
  console.log('  To test 1.2:1 or 1.5:1, modify tpDist multiplier in the backtest.');
  console.log('  Current analysis uses the production config for fidelity.');

  console.log('\n\nBacktest complete.');
}

runBacktest().catch(e => { console.error('FATAL:', e); process.exit(1); });
