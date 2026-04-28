#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// RX PRO — STRICT ENGINE BACKTEST (120 days, real Binance data)
// Faithful replication of genSig() mode='strict' from app.html
// ═══════════════════════════════════════════════════════════════════════

const https = require('https');

// ═══ CONFIG ═══
const SYMBOLS = ['BTCUSDT', 'BNBUSDT'];
const CAPITAL = 10000;
const POS_SIZE = 500;
const MAX_CONCURRENT = 4;
const COST_BUFFER_PCT = 0.0008; // 0.08% round-trip
const COOLDOWN_BARS = 25;
const TRADE_TIMEOUT_BARS = 50; // 4h10m at 5m bars
const DAYS = 120;

// ═══ INDICATOR FUNCTIONS (exact copies from app.html) ═══

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

function calcVWAP(klines) {
  let cumVol = 0, cumVolPrice = 0;
  const vwapArr = [];
  for (const k of klines) {
    const typPrice = (k.h + k.l + k.c) / 3;
    const vol = k.v;
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

// ═══ AIS FUNCTIONS (simplified for backtest — no persistence, no learned state) ═══

function checkMomentum(C, H, L, lookback = 5) {
  if (!C || C.length < lookback + 1) return { bullish: false, bearish: false, strength: 0, consecutiveUp: 0, consecutiveDn: 0 };
  const recent = C.slice(-lookback);
  let upCandles = 0, dnCandles = 0;
  let tempUp = 0, tempDn = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > recent[i - 1]) { upCandles++; tempUp++; tempDn = 0; }
    else { dnCandles++; tempDn++; tempUp = 0; }
  }
  const consecutiveUp = tempUp;
  const consecutiveDn = tempDn;
  const lows = L.slice(-lookback);
  let higherLows = 0;
  for (let i = 1; i < lows.length; i++) { if (lows[i] > lows[i - 1]) higherLows++; }
  const highs = H.slice(-lookback);
  let lowerHighs = 0;
  for (let i = 1; i < highs.length; i++) { if (highs[i] < highs[i - 1]) lowerHighs++; }
  const strength = (upCandles - dnCandles) / (lookback - 1);
  const bullish = upCandles >= 3 && higherLows >= 2;
  const bearish = dnCandles >= 3 && lowerHighs >= 2;
  return { bullish, bearish, strength, consecutiveUp, consecutiveDn, higherLows, lowerHighs };
}

function checkPriceAction(C, H, L, V, dir) {
  if (!C || C.length < 5) return { confirmed: false, score: 0 };
  let paScore = 0;
  const last3 = C.slice(-4);
  const c1 = last3[3] - last3[2];
  const c2 = last3[2] - last3[1];
  const c3 = last3[1] - last3[0];
  if (dir === 'BUY') {
    if (c1 > 0) paScore += 2;
    if (c2 > 0) paScore += 1;
    if (c1 > 0 && c1 > c2) paScore += 1;
    const body = Math.abs(C.at(-1) - C.at(-2));
    const lowerWick = Math.min(C.at(-1), C.at(-2)) - L.at(-1);
    if (lowerWick > body * 1.5) paScore += 2;
    if (c1 < 0 && c2 < 0 && c3 < 0) paScore -= 5;
  } else {
    if (c1 < 0) paScore += 2;
    if (c2 < 0) paScore += 1;
    if (c1 < 0 && Math.abs(c1) > Math.abs(c2)) paScore += 1;
    const upperWick = H.at(-1) - Math.max(C.at(-1), C.at(-2));
    const body = Math.abs(C.at(-1) - C.at(-2));
    if (upperWick > body * 1.5) paScore += 2;
    if (c1 > 0 && c2 > 0 && c3 > 0) paScore -= 5;
  }
  return { confirmed: paScore >= 2, score: paScore };
}

// ═══ DATA FETCHING ═══

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

async function fetchKlines(symbol, interval, days) {
  const limit = 1000;
  const msPerCandle = { '5m': 300000, '15m': 900000, '1h': 3600000 }[interval];
  const totalCandles = Math.ceil(days * 86400000 / msPerCandle);
  const endTime = Date.now();
  const startTime = endTime - days * 86400000;

  let allKlines = [];
  let fetchStart = startTime;

  while (fetchStart < endTime) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${fetchStart}&limit=${limit}`;
    try {
      const data = await fetchJSON(url);
      if (!data || !data.length) break;
      allKlines = allKlines.concat(data);
      fetchStart = data[data.length - 1][6] + 1; // closeTime + 1
      if (data.length < limit) break;
      await new Promise(r => setTimeout(r, 100)); // rate limit
    } catch (e) {
      console.error(`  Error fetching ${symbol} ${interval}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  return allKlines.map(k => ({
    t: k[0], // openTime
    o: parseFloat(k[1]),
    h: parseFloat(k[2]),
    l: parseFloat(k[3]),
    c: parseFloat(k[4]),
    v: parseFloat(k[5]),
    ct: k[6], // closeTime
  }));
}

// ═══ MAP 5m bars to corresponding 15m and 1h windows ═══

function getHTFWindow(barTime, htfKlines, lookback) {
  // Find all HTF candles that closed before or at barTime
  const relevant = htfKlines.filter(k => k.ct <= barTime);
  if (relevant.length < lookback) return null;
  return relevant.slice(-lookback);
}

// ═══ STRICT ENGINE (exact replica) ═══

function genSignalStrict(bar5mIdx, kl5m, kl15m, kl1h) {
  // We need 280 bars of 5m lookback
  const lookback = 280;
  const startIdx = Math.max(0, bar5mIdx - lookback + 1);
  const window5m = kl5m.slice(startIdx, bar5mIdx + 1);
  if (window5m.length < 50) return null;

  const C = window5m.map(k => k.c);
  const H = window5m.map(k => k.h);
  const L = window5m.map(k => k.l);
  const V = window5m.map(k => k.v);
  const cur = C.at(-1);
  const barTime = kl5m[bar5mIdx].ct;

  // Get HTF data windows
  const w15m = getHTFWindow(barTime, kl15m, 100);
  const w1h = getHTFWindow(barTime, kl1h, 50);

  const C15 = w15m ? w15m.map(k => k.c) : [];
  const H15 = w15m ? w15m.map(k => k.h) : [];
  const L15 = w15m ? w15m.map(k => k.l) : [];
  const V15 = w15m ? w15m.map(k => k.v) : [];

  const C1h = (w1h && w1h.length > 15) ? w1h.map(k => k.c) : [];
  const H1h = (w1h && w1h.length > 15) ? w1h.map(k => k.h) : [];
  const L1h = (w1h && w1h.length > 15) ? w1h.map(k => k.l) : [];
  const V1h = (w1h && w1h.length > 15) ? w1h.map(k => k.v) : [];

  // ═══ STEP 1: HTF 1H Trend ═══
  let htfTrend = 'NEUTRAL';
  let htfStrength = 0;
  if (w1h && w1h.length > 25) {
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

  // ═══ STEP 2: 15m Confirmation ═══
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

  // ═══ Session timing ═══
  const hourUTC = new Date(barTime).getUTCHours();
  const isDeadHours = hourUTC >= 0 && hourUTC < 6;
  const isLondonOpen = hourUTC >= 8 && hourUTC < 10;
  const isNYOpen = hourUTC >= 13 && hourUTC < 16;
  const isOverlap = hourUTC >= 13 && hourUTC < 16;

  // ═══ Regime detection ═══
  const adxData = calcADX(H, L, C);
  let atr = calcATR(H, L, C, 14);
  let regimeData = { regime: 'RANGING', label: 'RANGO LATERAL', cls: 'ranging' };
  try { regimeData = detectRegime(H, L, C, adxData, atr); } catch (e) {}
  const regime = regimeData.regime || 'RANGING';
  const isVolatile = (regime === 'VOLATILE');

  // ═══ STRICT SCORING ENGINE ═══
  const rsiS = calcRSI(C, 7);
  const mac = calcMACD(C);
  const ea5 = calcEMAArr(C, 5), ea13 = calcEMAArr(C, 13);
  const e5 = ea5.at(-1), e13 = ea13.at(-1);
  const bbS = calcBB(C, 10, 1.8);
  const bbSR = bbS.u - bbS.l;
  const bbSPos = bbSR > 0 ? (cur - bbS.l) / bbSR : 0.5;

  // VWAP: use raw kline data for last 50 bars
  const vwapSlice = window5m.slice(-50);
  const vwapArr = calcVWAP(vwapSlice);
  const vwap = vwapArr.at(-1);

  const avgV = V.slice(-20).reduce((a, b) => a + b) / 20;
  const lv = V.at(-1);
  const vr = lv / avgV;
  const stS = calcStoch(H, L, C, 7);
  const stK = stS.k || 50, stD = stS.d || 50;
  const psar = calcParabolicSAR(H, L, C);
  const kc = calcKeltner(H, L, C, 20, 14, 2);
  const mfi = calcMFI(H, L, C, V, 7);

  let bScore = 0, sScore = 0, bInds = 0, sInds = 0;

  // 1. RSI(7)
  if (rsiS < 25) { bScore += 3; bInds++; }
  else if (rsiS < 40) { bScore += 2; bInds++; }
  else if (rsiS < 48) { bScore += 1; bInds++; }
  else if (rsiS > 75) { sScore += 3; sInds++; }
  else if (rsiS > 60) { sScore += 2; sInds++; }
  else if (rsiS > 52) { sScore += 1; sInds++; }

  // 2. Stoch(7)
  const stCrossUp = stK > stD && stK < 35;
  const stCrossDown = stK < stD && stK > 65;
  if (stK < 25) { bScore += 3; bInds++; if (stCrossUp) bScore += 1; }
  else if (stK < 40) { bScore += 1.5; bInds++; }
  else if (stK > 75) { sScore += 3; sInds++; if (stCrossDown) sScore += 1; }
  else if (stK > 60) { sScore += 1.5; sInds++; }

  // 3. BB(10,1.8)
  if (bbSPos < 0.08) { bScore += 3; bInds++; }
  else if (bbSPos < 0.25) { bScore += 2; bInds++; }
  else if (bbSPos > 0.92) { sScore += 3; sInds++; }
  else if (bbSPos > 0.75) { sScore += 2; sInds++; }

  // 4. MACD
  if (mac.h > 0 && mac.ph <= 0) { bScore += 2.5; bInds++; }
  else if (mac.h < 0 && mac.ph >= 0) { sScore += 2.5; sInds++; }
  else if (mac.h > 0) { bScore += 0.5; }
  else { sScore += 0.5; }

  // 5. EMA 5/13
  if (e5 > e13) { bScore += 1.5; bInds++; } else { sScore += 1.5; sInds++; }

  // 6. VWAP
  if (vwap && cur < vwap) { bScore += 1; bInds++; }
  else if (vwap && cur > vwap) { sScore += 1; sInds++; }

  // 7. Volume
  if (vr > 1.5) {
    const vSig = rsiS < 50 ? 'BUY' : 'SELL';
    if (vSig === 'BUY') { bScore += 2; bInds++; } else { sScore += 2; sInds++; }
  } else if (vr > 0.8) {
    const vSig = rsiS < 50 ? 'BUY' : 'SELL';
    if (vSig === 'BUY') bScore += 0.5; else sScore += 0.5;
  }

  // 8. Keltner
  if (kc.position < 0.25) { bScore += 1.5; bInds++; }
  else if (kc.position > 0.75) { sScore += 1.5; sInds++; }

  // 9. Parabolic SAR
  if (psar.trend === 'BUY') { bScore += 1; bInds++; } else { sScore += 1; sInds++; }

  // 10. MFI(7)
  if (mfi < 35) { bScore += 1.5; bInds++; }
  else if (mfi > 65) { sScore += 1.5; sInds++; }

  // Session timing bonus
  if (isOverlap) { bScore += 1; sScore += 1; }
  else if (isLondonOpen || isNYOpen) { bScore += 0.5; sScore += 0.5; }
  if (isDeadHours) { bScore -= 0.5; sScore -= 0.5; }

  // AIS weights: In backtest, all weights = 1.0, so avgW = 1.0 (no adjustment)

  // ═══ DECISION ═══
  const minScore = 8;
  const minInds = 6;
  let signal = 'NEUTRAL';
  let score = 0;

  // HTF gate OBLIGATORIO
  if (htfTrend === 'BUY' && bScore >= minScore && bInds >= minInds) { signal = 'BUY'; score = bScore; }
  else if (htfTrend === 'SELL' && sScore >= minScore && sInds >= minInds) { signal = 'SELL'; score = sScore; }
  else if (htfTrend === 'NEUTRAL') {
    if (bScore >= minScore + 2 && bInds >= minInds && bScore > sScore + 2) { signal = 'BUY'; score = bScore; }
    else if (sScore >= minScore + 2 && sInds >= minInds && sScore > bScore + 2) { signal = 'SELL'; score = sScore; }
  }

  // Volatile + ADX>45 block
  if (signal !== 'NEUTRAL' && isVolatile && adxData.adx > 45) signal = 'NEUTRAL';

  // ═══ AIS FILTER 1: 5m Momentum ═══
  if (signal !== 'NEUTRAL') {
    const mom = checkMomentum(C, H, L, 5);
    if (signal === 'BUY' && (mom.consecutiveDn >= 2 || mom.strength < -0.2)) signal = 'NEUTRAL';
    if (signal === 'SELL' && (mom.consecutiveUp >= 2 || mom.strength > 0.2)) signal = 'NEUTRAL';
    if (signal === 'BUY' && mom.bullish) score += 2;
    if (signal === 'SELL' && mom.bearish) score += 2;
  }

  // ═══ AIS FILTER 2: Price Action ═══
  if (signal !== 'NEUTRAL') {
    const pa = checkPriceAction(C, H, L, V, signal);
    if (pa.score <= 0) signal = 'NEUTRAL';
    if (pa.score >= 3) score += 1;
  }

  // ═══ AIS FILTER 3: 15m Structure ═══
  if (signal !== 'NEUTRAL' && C15.length > 5) {
    const mom15 = checkMomentum(C15, H15, L15, 3);
    if (signal === 'BUY' && mom15.consecutiveDn >= 2) signal = 'NEUTRAL';
    if (signal === 'SELL' && mom15.consecutiveUp >= 2) signal = 'NEUTRAL';
  }

  // ═══ ULTRA FILTER: 15m Momentum Alignment ═══
  if (signal !== 'NEUTRAL' && C15.length >= 4) {
    const last3_15 = C15.slice(-4);
    const mom15dir = last3_15[3] - last3_15[0];
    const mom15up = (last3_15[1] > last3_15[0] ? 1 : 0) + (last3_15[2] > last3_15[1] ? 1 : 0) + (last3_15[3] > last3_15[2] ? 1 : 0);
    const mom15dn = 3 - mom15up;
    if (signal === 'BUY' && (mom15dir < 0 && mom15dn >= 2)) signal = 'NEUTRAL';
    else if (signal === 'SELL' && (mom15dir > 0 && mom15up >= 2)) signal = 'NEUTRAL';
  }

  // ═══ ULTRA FILTER: Order Flow Imbalance ═══
  if (signal !== 'NEUTRAL') {
    const lastC3 = C.slice(-3);
    const lastV3 = V.slice(-3);
    let volUp = 0, volDn = 0;
    for (let i = 0; i < 3; i++) {
      const prev = i === 0 ? C[C.length - 4] : lastC3[i - 1];
      if (lastC3[i] >= prev) volUp += lastV3[i]; else volDn += lastV3[i];
    }
    const volIncreasing = lastV3[2] > lastV3[1] || lastV3[1] > lastV3[0];
    if (signal === 'BUY' && (volUp < volDn || !volIncreasing)) signal = 'NEUTRAL';
    else if (signal === 'SELL' && (volDn < volUp || !volIncreasing)) signal = 'NEUTRAL';
  }

  // ═══ ULTRA FILTER: Volatility Quality ═══
  if (signal !== 'NEUTRAL') {
    const atr7 = calcATR(H, L, C, 7);
    const atrPct = (atr7 / cur) * 100;
    if (atrPct < 0.1) signal = 'NEUTRAL';
    else if (atrPct > 0.5) signal = 'NEUTRAL';
  }

  // AIS Filters 4-7: In backtest with no trade history, these are effectively no-ops:
  // - adaptiveBonus['strict'] = 0 (no trades yet to learn from)
  // - symbolReliability = 1.0 (< 2 trades)
  // - regimeBlocked = false (no losses recorded)
  // - symbolBlacklisted = false
  // - requiredEntryPattern = null (< 3 trades)

  if (signal === 'NEUTRAL') return null;

  // ═══ TP/SL Calculation ═══
  let atr15 = atr;
  if (H15.length > 15 && L15.length > 15 && C15.length > 15) {
    const _a15 = calcATR(H15, L15, C15, 14);
    if (_a15 > 0) atr15 = _a15;
  }
  let atr1h = atr;
  if (H1h.length > 15 && L1h.length > 15 && C1h.length > 15) {
    const _a1h = calcATR(H1h, L1h, C1h, 14);
    if (_a1h > 0) atr1h = _a1h;
  }

  // For strict: max(atr15, atr1h/4)
  const useATR = Math.max(atr15, atr1h / 4);
  const tpMult = 1.5;
  const slMult = 1.0;

  let tpDist = useATR * tpMult;
  let slDist = useATR * slMult;

  const minTPdist = cur * 0.002;
  if (tpDist < minTPdist) tpDist = minTPdist;
  if (slDist < cur * 0.001) slDist = cur * 0.001;

  const costBuffer = cur * COST_BUFFER_PCT;

  return {
    signal,
    score,
    entry: cur,
    tpDist,
    slDist,
    costBuffer,
    htfTrend,
    mtfConfirm,
    regime
  };
}

// ═══ BACKTEST SIMULATION ═══

async function runBacktest() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  RX PRO — STRICT ENGINE BACKTEST (120 DAYS)');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Symbols: ${SYMBOLS.join(', ')}`);
  console.log(`  Capital: $${CAPITAL} | Position: $${POS_SIZE} | Max concurrent: ${MAX_CONCURRENT}`);
  console.log(`  TP: 1.5x ATR | SL: 1.0x ATR | R:R 1.5:1`);
  console.log(`  Cost buffer: ${COST_BUFFER_PCT * 100}% | Cooldown: ${COOLDOWN_BARS} bars | Timeout: ${TRADE_TIMEOUT_BARS} bars`);
  console.log('');

  // Fetch data
  console.log('Fetching data from Binance...');
  const data = {};
  for (const sym of SYMBOLS) {
    console.log(`  ${sym}:`);
    process.stdout.write('    5m...  ');
    data[sym] = { kl5m: await fetchKlines(sym, '5m', DAYS + 5) };
    console.log(`${data[sym].kl5m.length} candles`);
    process.stdout.write('    15m... ');
    data[sym].kl15m = await fetchKlines(sym, '15m', DAYS + 5);
    console.log(`${data[sym].kl15m.length} candles`);
    process.stdout.write('    1h...  ');
    data[sym].kl1h = await fetchKlines(sym, '1h', DAYS + 10);
    console.log(`${data[sym].kl1h.length} candles`);
  }
  console.log('');

  // Simulation state
  let capital = CAPITAL;
  let peakCapital = CAPITAL;
  let maxDrawdown = 0;
  const trades = [];
  const openPositions = [];
  const cooldowns = {}; // sym -> last signal bar index

  // Process each 5m bar chronologically across all symbols
  // Build a merged timeline
  const timeline = [];
  for (const sym of SYMBOLS) {
    const kl = data[sym].kl5m;
    // Skip first 280 bars for lookback
    for (let i = 280; i < kl.length; i++) {
      timeline.push({ sym, idx: i, time: kl[i].t, bar: kl[i] });
    }
  }
  timeline.sort((a, b) => a.time - b.time);

  console.log(`Processing ${timeline.length} bar events across ${SYMBOLS.length} symbols...`);
  let signalCount = 0;
  let barCount = 0;
  const progressStep = Math.floor(timeline.length / 20);

  for (const event of timeline) {
    barCount++;
    if (barCount % progressStep === 0) {
      process.stdout.write(`  ${Math.round(barCount / timeline.length * 100)}%`);
    }

    const { sym, idx } = event;
    const kl5m = data[sym].kl5m;
    const currentBar = kl5m[idx];

    // ═══ Check open positions for TP/SL/Timeout ═══
    for (let p = openPositions.length - 1; p >= 0; p--) {
      const pos = openPositions[p];
      if (pos.sym !== sym) continue; // only check positions for current symbol against its own bars

      pos.barsHeld++;
      const high = currentBar.h;
      const low = currentBar.l;

      let exitPrice = null;
      let exitType = null;

      if (pos.dir === 'BUY') {
        if (low <= pos.sl) { exitPrice = pos.sl; exitType = 'SL'; }
        else if (high >= pos.tp) { exitPrice = pos.tp; exitType = 'TP'; }
      } else {
        if (high >= pos.sl) { exitPrice = pos.sl; exitType = 'SL'; }
        else if (low <= pos.tp) { exitPrice = pos.tp; exitType = 'TP'; }
      }

      // Timeout
      if (!exitPrice && pos.barsHeld >= TRADE_TIMEOUT_BARS) {
        exitPrice = currentBar.c;
        exitType = 'TIMEOUT';
      }

      if (exitPrice) {
        const pnlPct = pos.dir === 'BUY'
          ? (exitPrice - pos.entry) / pos.entry
          : (pos.entry - exitPrice) / pos.entry;
        const pnlDollar = POS_SIZE * pnlPct - (POS_SIZE * COST_BUFFER_PCT); // deduct fees
        capital += pnlDollar;
        if (capital > peakCapital) peakCapital = capital;
        const dd = (peakCapital - capital) / peakCapital * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;

        trades.push({
          sym: pos.sym,
          dir: pos.dir,
          entry: pos.entry,
          exit: exitPrice,
          exitType,
          pnl: pnlDollar,
          pnlPct: pnlPct * 100,
          barsHeld: pos.barsHeld,
          durationMin: pos.barsHeld * 5,
          entryTime: pos.entryTime,
          exitTime: currentBar.t,
          score: pos.score,
          htfTrend: pos.htfTrend,
          regime: pos.regime
        });

        openPositions.splice(p, 1);
      }
    }

    // ═══ Check for new signals ═══
    // Cooldown check
    const cdKey = sym;
    if (cooldowns[cdKey] && (idx - cooldowns[cdKey]) < COOLDOWN_BARS) continue;

    // Max concurrent check
    if (openPositions.length >= MAX_CONCURRENT) continue;

    // Check if we already have a position in this symbol
    if (openPositions.some(p => p.sym === sym)) continue;

    const sig = genSignalStrict(idx, kl5m, data[sym].kl15m, data[sym].kl1h);
    if (!sig) continue;

    signalCount++;
    cooldowns[cdKey] = idx;

    // Open position
    const entry = sig.entry;
    let tp, sl;
    if (sig.signal === 'BUY') {
      tp = entry + sig.tpDist + sig.costBuffer;
      sl = entry - sig.slDist - sig.costBuffer;
    } else {
      tp = entry - sig.tpDist - sig.costBuffer;
      sl = entry + sig.slDist + sig.costBuffer;
    }

    openPositions.push({
      sym,
      dir: sig.signal,
      entry,
      tp,
      sl,
      score: sig.score,
      htfTrend: sig.htfTrend,
      regime: sig.regime,
      entryTime: currentBar.t,
      barsHeld: 0
    });
  }

  // Close any remaining open positions at last price
  for (const pos of openPositions) {
    const lastBar = data[pos.sym].kl5m.at(-1);
    const exitPrice = lastBar.c;
    const pnlPct = pos.dir === 'BUY'
      ? (exitPrice - pos.entry) / pos.entry
      : (pos.entry - exitPrice) / pos.entry;
    const pnlDollar = POS_SIZE * pnlPct - (POS_SIZE * COST_BUFFER_PCT);
    capital += pnlDollar;
    trades.push({
      sym: pos.sym,
      dir: pos.dir,
      entry: pos.entry,
      exit: exitPrice,
      exitType: 'OPEN_END',
      pnl: pnlDollar,
      pnlPct: pnlPct * 100,
      barsHeld: pos.barsHeld,
      durationMin: pos.barsHeld * 5,
      entryTime: pos.entryTime,
      exitTime: lastBar.t,
      score: pos.score,
      htfTrend: pos.htfTrend,
      regime: pos.regime
    });
  }

  console.log('\n');

  // ═══════════════════════════════════════════
  // RESULTS
  // ═══════════════════════════════════════════

  const totalTrades = trades.length;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = totalTrades > 0 ? (wins.length / totalTrades * 100).toFixed(1) : 0;
  const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
  const totalPnLPct = (totalPnL / CAPITAL * 100).toFixed(2);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? 'Inf' : '0.00';
  const avgDuration = totalTrades > 0 ? (trades.reduce((s, t) => s + t.durationMin, 0) / totalTrades).toFixed(0) : 0;
  const expectancy = totalTrades > 0 ? (totalPnL / totalTrades).toFixed(2) : 0;

  const startDate = new Date(data[SYMBOLS[0]].kl5m[280].t);
  const endDate = new Date(data[SYMBOLS[0]].kl5m.at(-1).t);
  const actualDays = (endDate - startDate) / 86400000;
  const sigsPerDay = (totalTrades / actualDays).toFixed(1);

  // Best/worst trade
  const bestTrade = trades.length > 0 ? trades.reduce((best, t) => t.pnl > best.pnl ? t : best, trades[0]) : null;
  const worstTrade = trades.length > 0 ? trades.reduce((worst, t) => t.pnl < worst.pnl ? t : worst, trades[0]) : null;

  // Consecutive wins/losses
  let maxConsecWins = 0, maxConsecLosses = 0, cw = 0, cl = 0;
  for (const t of trades) {
    if (t.pnl > 0) { cw++; cl = 0; if (cw > maxConsecWins) maxConsecWins = cw; }
    else { cl++; cw = 0; if (cl > maxConsecLosses) maxConsecLosses = cl; }
  }

  // Exit type breakdown
  const exitTypes = {};
  for (const t of trades) { exitTypes[t.exitType] = (exitTypes[t.exitType] || 0) + 1; }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  BACKTEST RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Period: ${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)} (${actualDays.toFixed(0)} days)`);
  console.log('');
  console.log('  --- OVERVIEW ---');
  console.log(`  Total Trades:        ${totalTrades}`);
  console.log(`  Signals/Day:         ${sigsPerDay}`);
  console.log(`  Win Rate:            ${winRate}% (${wins.length}W / ${losses.length}L)`);
  console.log(`  Total PnL:           $${totalPnL.toFixed(2)} (${totalPnLPct}%)`);
  console.log(`  Final Capital:       $${capital.toFixed(2)}`);
  console.log(`  Profit Factor:       ${profitFactor}`);
  console.log(`  Max Drawdown:        ${maxDrawdown.toFixed(2)}%`);
  console.log(`  Avg Trade Duration:  ${avgDuration} min (${(avgDuration / 60).toFixed(1)} hours)`);
  console.log(`  Expectancy/Trade:    $${expectancy}`);
  console.log('');
  console.log('  --- TRADE EXITS ---');
  for (const [type, count] of Object.entries(exitTypes)) {
    console.log(`    ${type}: ${count} (${(count / totalTrades * 100).toFixed(1)}%)`);
  }
  console.log('');
  console.log('  --- EXTREMES ---');
  if (bestTrade) console.log(`  Best Trade:          $${bestTrade.pnl.toFixed(2)} (${bestTrade.sym} ${bestTrade.dir} on ${new Date(bestTrade.entryTime).toISOString().slice(0, 16)})`);
  if (worstTrade) console.log(`  Worst Trade:         $${worstTrade.pnl.toFixed(2)} (${worstTrade.sym} ${worstTrade.dir} on ${new Date(worstTrade.entryTime).toISOString().slice(0, 16)})`);
  console.log(`  Max Consec Wins:     ${maxConsecWins}`);
  console.log(`  Max Consec Losses:   ${maxConsecLosses}`);
  console.log(`  Avg Win:             $${wins.length > 0 ? (grossProfit / wins.length).toFixed(2) : '0.00'}`);
  console.log(`  Avg Loss:            $${losses.length > 0 ? (-grossLoss / losses.length).toFixed(2) : '0.00'}`);

  // PnL by pair
  console.log('');
  console.log('  --- PnL BY PAIR ---');
  for (const sym of SYMBOLS) {
    const symTrades = trades.filter(t => t.sym === sym);
    const symPnL = symTrades.reduce((s, t) => s + t.pnl, 0);
    const symWins = symTrades.filter(t => t.pnl > 0).length;
    const symWR = symTrades.length > 0 ? (symWins / symTrades.length * 100).toFixed(1) : 0;
    console.log(`    ${sym}: ${symTrades.length} trades, WR ${symWR}%, PnL $${symPnL.toFixed(2)}`);
  }

  // PnL by day of week
  console.log('');
  console.log('  --- PnL BY DAY OF WEEK ---');
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const byDay = {};
  for (const t of trades) {
    const d = new Date(t.entryTime).getUTCDay();
    if (!byDay[d]) byDay[d] = { pnl: 0, count: 0, wins: 0 };
    byDay[d].pnl += t.pnl;
    byDay[d].count++;
    if (t.pnl > 0) byDay[d].wins++;
  }
  for (let d = 0; d < 7; d++) {
    const info = byDay[d];
    if (!info) { console.log(`    ${dayNames[d].padEnd(10)}: 0 trades`); continue; }
    console.log(`    ${dayNames[d].padEnd(10)}: ${info.count} trades, WR ${(info.wins / info.count * 100).toFixed(0)}%, PnL $${info.pnl.toFixed(2)}`);
  }

  // PnL by hour of day (UTC)
  console.log('');
  console.log('  --- PnL BY HOUR (UTC) ---');
  const byHour = {};
  for (const t of trades) {
    const h = new Date(t.entryTime).getUTCHours();
    if (!byHour[h]) byHour[h] = { pnl: 0, count: 0, wins: 0 };
    byHour[h].pnl += t.pnl;
    byHour[h].count++;
    if (t.pnl > 0) byHour[h].wins++;
  }
  for (let h = 0; h < 24; h++) {
    const info = byHour[h];
    if (!info) continue;
    console.log(`    ${String(h).padStart(2, '0')}:00  ${String(info.count).padStart(3)} trades  WR ${(info.wins / info.count * 100).toFixed(0).padStart(3)}%  PnL $${info.pnl.toFixed(2)}`);
  }

  // Weekly PnL breakdown
  console.log('');
  console.log('  --- WEEKLY PnL BREAKDOWN ---');
  const weeklyPnL = {};
  for (const t of trades) {
    const d = new Date(t.entryTime);
    // ISO week: get Monday of the week
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d);
    monday.setUTCDate(diff);
    const weekKey = monday.toISOString().slice(0, 10);
    if (!weeklyPnL[weekKey]) weeklyPnL[weekKey] = { pnl: 0, count: 0, wins: 0 };
    weeklyPnL[weekKey].pnl += t.pnl;
    weeklyPnL[weekKey].count++;
    if (t.pnl > 0) weeklyPnL[weekKey].wins++;
  }
  const weeks = Object.keys(weeklyPnL).sort();
  let cumPnL = 0;
  for (const w of weeks) {
    const info = weeklyPnL[w];
    cumPnL += info.pnl;
    const bar = info.pnl >= 0 ? '+'.repeat(Math.min(20, Math.round(info.pnl / 2))) : '-'.repeat(Math.min(20, Math.round(-info.pnl / 2)));
    console.log(`    ${w}  ${String(info.count).padStart(3)} trades  WR ${(info.wins / info.count * 100).toFixed(0).padStart(3)}%  PnL $${info.pnl.toFixed(2).padStart(8)}  Cum $${cumPnL.toFixed(2).padStart(9)}  ${bar}`);
  }

  // Regime breakdown
  console.log('');
  console.log('  --- PnL BY REGIME ---');
  const byRegime = {};
  for (const t of trades) {
    const r = t.regime || 'UNKNOWN';
    if (!byRegime[r]) byRegime[r] = { pnl: 0, count: 0, wins: 0 };
    byRegime[r].pnl += t.pnl;
    byRegime[r].count++;
    if (t.pnl > 0) byRegime[r].wins++;
  }
  for (const [regime, info] of Object.entries(byRegime)) {
    console.log(`    ${regime.padEnd(12)}: ${info.count} trades, WR ${(info.wins / info.count * 100).toFixed(0)}%, PnL $${info.pnl.toFixed(2)}`);
  }

  // Direction breakdown
  console.log('');
  console.log('  --- PnL BY DIRECTION ---');
  const buyTrades = trades.filter(t => t.dir === 'BUY');
  const sellTrades = trades.filter(t => t.dir === 'SELL');
  const buyPnL = buyTrades.reduce((s, t) => s + t.pnl, 0);
  const sellPnL = sellTrades.reduce((s, t) => s + t.pnl, 0);
  const buyWR = buyTrades.length > 0 ? (buyTrades.filter(t => t.pnl > 0).length / buyTrades.length * 100).toFixed(1) : 0;
  const sellWR = sellTrades.length > 0 ? (sellTrades.filter(t => t.pnl > 0).length / sellTrades.length * 100).toFixed(1) : 0;
  console.log(`    BUY:  ${buyTrades.length} trades, WR ${buyWR}%, PnL $${buyPnL.toFixed(2)}`);
  console.log(`    SELL: ${sellTrades.length} trades, WR ${sellWR}%, PnL $${sellPnL.toFixed(2)}`);

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  BACKTEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
}

runBacktest().catch(e => { console.error('Fatal error:', e); process.exit(1); });
