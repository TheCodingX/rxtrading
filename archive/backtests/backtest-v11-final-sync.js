#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════
 * RX PRO — Backtest v11 Final Sync
 * 150-day backtest replicating EXACT signal logic from app.html
 *
 * Motors: VIP (strict), Scalp, Free
 * Trade size: $500 x5 leverage per trade
 * Data: Binance 5m, 15m, 1h klines
 * ═══════════════════════════════════════════════════════════════════════
 */

const https = require('https');

// ═══ CONFIGURATION (exact from app.html) ═══
const VIP_SCAN_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT'];
const SCALP_SCAN_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','LINKUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','ARBUSDT','OPUSDT','SUIUSDT','JUPUSDT','PEPEUSDT'];
const FREE_SCAN_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];

const TRADE_SIZE = 500;   // $500 per trade
const LEVERAGE = 5;       // 5x leverage
const POSITION_SIZE = TRADE_SIZE * LEVERAGE; // $2500 notional

const DAYS = 150;
const CANDLES_5M_PER_DAY = 288;
const TOTAL_5M = DAYS * CANDLES_5M_PER_DAY;

// Cooldown bars (from app.html line 5051)
const CD_STRICT = 36;  // ~3h
const CD_SCALP = 12;   // ~1h
const CD_FREE = 60;    // ~5h

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

function calcVWAP(klines) {
  let cumVol = 0, cumVolPrice = 0;
  const vwapArr = [];
  for (const k of klines) {
    const typPrice = (k.h + k.l + k.c) / 3;
    const vol = k.v;
    cumVol += vol; cumVolPrice += (typPrice * vol);
    vwapArr.push(cumVol > 0 ? cumVolPrice / cumVol : k.c);
  }
  return vwapArr;
}

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
  if (adx.adx > 25 && atrPct > 1.5) return { regime: 'TRENDING' };
  if (adx.adx < 20 && atrPct < 0.8) return { regime: 'QUIET' };
  if (atrPct > 2) return { regime: 'VOLATILE' };
  return { regime: 'RANGING' };
}

function checkMomentum(C, H, L, lookback = 5) {
  if (!C || C.length < lookback + 1) return { consecutiveUp: 0, consecutiveDn: 0 };
  const recent = C.slice(-lookback);
  let tempUp = 0, tempDn = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > recent[i - 1]) { tempUp++; tempDn = 0; }
    else { tempDn++; tempUp = 0; }
  }
  return { consecutiveUp: tempUp, consecutiveDn: tempDn };
}

// ═══ DATA DOWNLOAD ═══

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function downloadKlines(sym, interval, totalCandles) {
  const all = [];
  const batchSize = 1000;
  let endTime = Date.now();

  while (all.length < totalCandles) {
    const limit = Math.min(batchSize, totalCandles - all.length);
    const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}&endTime=${endTime}`;
    let retries = 3;
    let data;
    while (retries > 0) {
      try {
        data = await fetchJSON(url);
        break;
      } catch (e) {
        retries--;
        if (retries === 0) throw e;
        await sleep(2000);
      }
    }
    if (!data || !data.length) break;
    // Each kline: [openTime, open, high, low, close, volume, closeTime, ...]
    const parsed = data.map(k => ({
      t: k[0],     // openTime
      o: parseFloat(k[1]),
      h: parseFloat(k[2]),
      l: parseFloat(k[3]),
      c: parseFloat(k[4]),
      v: parseFloat(k[5]),
    }));
    all.unshift(...parsed);
    endTime = data[0][0] - 1;
    await sleep(200); // rate limit
  }
  return all.slice(-totalCandles);
}

// ═══ SIGNAL GENERATION (exact replication from app.html) ═══

function genSigAtBar(C5, H5, L5, V5, kl5Raw, C15, H15, L15, V15, C1h, H1h, L1h, V1h, mode) {
  const isStrict = mode === 'strict';
  const isScalp = mode === 'scalp';

  const cur = C5.at(-1);
  let B = 0, S = 0;

  // ═══ STEP 1: HTF Trend (1H) ═══
  let htfTrend = 'NEUTRAL';
  let htfStrength = 0;
  if (C1h && C1h.length > 25) {
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
  if (C15 && C15.length > 25) {
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

  // ═══ Session timing (use candle time) ═══
  const candleTime = kl5Raw.at(-1).t;
  const hourUTC = new Date(candleTime).getUTCHours();
  const isDeadHours = hourUTC >= 0 && hourUTC < 6;
  const isLondonOpen = hourUTC >= 8 && hourUTC < 10;
  const isNYOpen = hourUTC >= 13 && hourUTC < 16;
  const isOverlap = hourUTC >= 13 && hourUTC < 16;

  // ═══ Regime detection ═══
  const adxData = calcADX(H5, L5, C5);
  let atr = calcATR(H5, L5, C5, 14);
  let regimeData = detectRegime(H5, L5, C5, adxData, atr);
  const regime = regimeData.regime || 'RANGING';
  const isVolatile = (regime === 'VOLATILE');

  let signal = 'NEUTRAL';
  let score = 0;
  let indCount = 0;
  let tpMult, slMult;

  if (isStrict) {
    // ═══ MOTOR 1: VIP PRECISION INSTITUCIONAL ═══
    const rsiS = calcRSI(C5, 7);
    const mac = calcMACD(C5);
    const ea5 = calcEMAArr(C5, 5), ea13 = calcEMAArr(C5, 13);
    const e5 = ea5.at(-1), e13 = ea13.at(-1);
    const bbS = calcBB(C5, 10, 1.8);
    const bbSR = bbS.u - bbS.l;
    const bbSPos = bbSR > 0 ? (cur - bbS.l) / bbSR : 0.5;
    const vwapArr = calcVWAP(kl5Raw.slice(-50));
    const vwap = vwapArr.at(-1);
    const avgV = V5.slice(-20).reduce((a, b) => a + b) / 20;
    const lv = V5.at(-1);
    const vr = lv / avgV;
    const stS = calcStoch(H5, L5, C5, 7);
    const stK = stS.k || 50, stD = stS.d || 50;
    const psar = calcParabolicSAR(H5, L5, C5);
    const kc = calcKeltner(H5, L5, C5, 20, 14, 2);
    const mfi = calcMFI(H5, L5, C5, V5, 7);

    let bScore = 0, sScore = 0, bInds = 0, sInds = 0;

    // RSI(7)
    if (rsiS < 25) { bScore += 3; bInds++; }
    else if (rsiS < 40) { bScore += 2; bInds++; }
    else if (rsiS < 48) { bScore += 1; bInds++; }
    else if (rsiS > 75) { sScore += 3; sInds++; }
    else if (rsiS > 60) { sScore += 2; sInds++; }
    else if (rsiS > 52) { sScore += 1; sInds++; }

    // Stoch(7)
    const stCrossUp = stK > stD && stK < 35;
    const stCrossDown = stK < stD && stK > 65;
    if (stK < 25) { bScore += 3; bInds++; if (stCrossUp) bScore += 1; }
    else if (stK < 40) { bScore += 1.5; bInds++; }
    else if (stK > 75) { sScore += 3; sInds++; if (stCrossDown) sScore += 1; }
    else if (stK > 60) { sScore += 1.5; sInds++; }

    // BB(10,1.8)
    if (bbSPos < 0.08) { bScore += 3; bInds++; }
    else if (bbSPos < 0.25) { bScore += 2; bInds++; }
    else if (bbSPos > 0.92) { sScore += 3; sInds++; }
    else if (bbSPos > 0.75) { sScore += 2; sInds++; }

    // MACD
    if (mac.h > 0 && mac.ph <= 0) { bScore += 2.5; bInds++; }
    else if (mac.h < 0 && mac.ph >= 0) { sScore += 2.5; sInds++; }
    else if (mac.h > 0) { bScore += 0.5; }
    else { sScore += 0.5; }

    // EMA 5/13
    if (e5 > e13) { bScore += 1.5; bInds++; } else { sScore += 1.5; sInds++; }

    // VWAP
    if (vwap && cur < vwap) { bScore += 1; bInds++; }
    else if (vwap && cur > vwap) { sScore += 1; sInds++; }

    // Volume
    if (vr > 1.5) {
      const vSig = rsiS < 50 ? 'BUY' : 'SELL';
      if (vSig === 'BUY') { bScore += 2; bInds++; } else { sScore += 2; sInds++; }
    } else if (vr > 0.8) {
      const vSig = rsiS < 50 ? 'BUY' : 'SELL';
      if (vSig === 'BUY') bScore += 0.5; else sScore += 0.5;
    }

    // Keltner
    if (kc.position < 0.25) { bScore += 1.5; bInds++; }
    else if (kc.position > 0.75) { sScore += 1.5; sInds++; }

    // PSAR
    if (psar.trend === 'BUY') { bScore += 1; bInds++; } else { sScore += 1; sInds++; }

    // MFI
    if (mfi < 35) { bScore += 1.5; bInds++; }
    else if (mfi > 65) { sScore += 1.5; sInds++; }

    // Session
    if (isOverlap) { bScore += 1; sScore += 1; }
    else if (isLondonOpen || isNYOpen) { bScore += 0.5; sScore += 0.5; }
    if (isDeadHours) { bScore -= 0.5; sScore -= 0.5; }

    // VIP PRECISION DECISION
    const minScore = 7;
    const minInds = 5;

    if (htfTrend === 'BUY' && bScore >= minScore && bInds >= minInds) { signal = 'BUY'; score = bScore; indCount = bInds; }
    else if (htfTrend === 'SELL' && sScore >= minScore && sInds >= minInds) { signal = 'SELL'; score = sScore; indCount = sInds; }
    else if (htfTrend === 'NEUTRAL') {
      if (bScore >= minScore + 2 && bInds >= minInds && bScore > sScore + 2) { signal = 'BUY'; score = bScore; indCount = bInds; }
      else if (sScore >= minScore + 2 && sInds >= minInds && sScore > bScore + 2) { signal = 'SELL'; score = sScore; indCount = sInds; }
    }

    if (signal !== 'NEUTRAL' && isVolatile && adxData.adx > 45) signal = 'NEUTRAL';

    // POST-SIGNAL FILTERS
    if (signal !== 'NEUTRAL') {
      const rsiCheck = calcRSI(C5, 7);
      const bbCheck = calcBB(C5, 10, 1.8);
      const bbPosCheck = (bbCheck.u - bbCheck.l) > 0 ? (cur - bbCheck.l) / (bbCheck.u - bbCheck.l) : 0.5;
      const isMeanReversion = (signal === 'BUY' && (rsiCheck < 35 || bbPosCheck < 0.20)) || (signal === 'SELL' && (rsiCheck > 65 || bbPosCheck > 0.80));

      // FILTER 1: VolQuality
      const atrPctCheck = (calcATR(H5, L5, C5, 7) / cur) * 100;
      if (atrPctCheck < 0.05 || atrPctCheck > 0.8) signal = 'NEUTRAL';

      // FILTER 2: Momentum (trend-only)
      if (signal !== 'NEUTRAL' && !isMeanReversion) {
        const mom = checkMomentum(C5, H5, L5, 5);
        if (signal === 'BUY' && mom.consecutiveDn >= 4) signal = 'NEUTRAL';
        if (signal === 'SELL' && mom.consecutiveUp >= 4) signal = 'NEUTRAL';
      }

      // FILTER 3: Volume 3-candle avg > 0.3x
      if (signal !== 'NEUTRAL') {
        const avgVCheck = V5.slice(-20).reduce((a, b) => a + b) / 20;
        const last3Vol = (V5.at(-1) + V5.at(-2) + V5.at(-3)) / 3;
        const vrCheck = last3Vol / avgVCheck;
        if (vrCheck < 0.3) signal = 'NEUTRAL';
      }
    }

    B = signal === 'BUY' ? score : 0;
    S = signal === 'SELL' ? score : 0;
    tpMult = 2.0;
    slMult = 1.0;

  } else if (isScalp) {
    // ═══ MOTOR 2: SCALP MODE ═══
    const scalpGate = mtfConfirm;
    const rsiS = calcRSI(C5, 7);
    const mac = calcMACD(C5);
    const ea5 = calcEMAArr(C5, 5), ea13 = calcEMAArr(C5, 13);
    const e5 = ea5.at(-1), e13 = ea13.at(-1);
    const bbS = calcBB(C5, 10, 1.8);
    const bbSR = bbS.u - bbS.l;
    const bbSPos = bbSR > 0 ? (cur - bbS.l) / bbSR : 0.5;
    const vwapArr = calcVWAP(kl5Raw.slice(-50));
    const vwap = vwapArr.at(-1);
    const avgV = V5.slice(-20).reduce((a, b) => a + b) / 20;
    const lv = V5.at(-1);
    const vr = lv / avgV;
    const stS = calcStoch(H5, L5, C5, 7);
    const stK = stS.k || 50, stD = stS.d || 50;
    const psar = calcParabolicSAR(H5, L5, C5);
    const kc = calcKeltner(H5, L5, C5, 20, 14, 2);
    const mfi = calcMFI(H5, L5, C5, V5, 7);

    let bScore = 0, sScore = 0, bInds = 0, sInds = 0;

    // 1. RSI(7) - scalp thresholds
    if (rsiS < 25) { bScore += 3; bInds++; }
    else if (rsiS < 35) { bScore += 2; bInds++; }
    else if (rsiS < 45) { bScore += 1; bInds++; }
    else if (rsiS > 75) { sScore += 3; sInds++; }
    else if (rsiS > 65) { sScore += 2; sInds++; }
    else if (rsiS > 55) { sScore += 1; sInds++; }

    // 2. Stoch(7)
    const stCrossUp = stK > stD && stK < 45;
    const stCrossDown = stK < stD && stK > 55;
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
    else if (mac.h < 0) { sScore += 0.5; }

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

    // 9. PSAR
    if (psar.trend === 'BUY') { bScore += 1; bInds++; } else { sScore += 1; sInds++; }

    // 10. MFI(7)
    if (mfi < 35) { bScore += 1.5; bInds++; }
    else if (mfi > 65) { sScore += 1.5; sInds++; }

    // Session
    if (isOverlap) { bScore += 1; sScore += 1; }
    else if (isLondonOpen || isNYOpen) { bScore += 0.5; sScore += 0.5; }
    if (isDeadHours) { bScore -= 0.5; sScore -= 0.5; }

    // SCALP DECISION
    const minScore = 6;
    const minInds = 4;

    // 1. Double alignment (15m + 1H)
    if (scalpGate === 'BUY' && htfTrend === 'BUY' && bScore >= minScore - 1 && bInds >= minInds - 1) { signal = 'BUY'; score = bScore; indCount = bInds; }
    else if (scalpGate === 'SELL' && htfTrend === 'SELL' && sScore >= minScore - 1 && sInds >= minInds - 1) { signal = 'SELL'; score = sScore; indCount = sInds; }
    // 2. Only 15m aligned
    else if (scalpGate === 'BUY' && bScore >= minScore && bInds >= minInds) { signal = 'BUY'; score = bScore; indCount = bInds; }
    else if (scalpGate === 'SELL' && sScore >= minScore && sInds >= minInds) { signal = 'SELL'; score = sScore; indCount = sInds; }
    // 3. Gate neutral
    else if (scalpGate === 'NEUTRAL') {
      if (bScore >= minScore + 1 && bInds >= minInds && bScore > sScore + 1.5) { signal = 'BUY'; score = bScore; indCount = bInds; }
      else if (sScore >= minScore + 1 && sInds >= minInds && sScore > bScore + 1.5) { signal = 'SELL'; score = sScore; indCount = sInds; }
    }
    // Against 1H: need +2 score
    if (signal !== 'NEUTRAL' && htfTrend !== 'NEUTRAL' && signal !== htfTrend) {
      if (score < minScore + 2) signal = 'NEUTRAL';
    }

    if (signal !== 'NEUTRAL' && isVolatile && adxData.adx > 45) signal = 'NEUTRAL';

    // POST-SIGNAL FILTERS
    if (signal !== 'NEUTRAL') {
      const rsiCheck = calcRSI(C5, 7);
      const bbCheck = calcBB(C5, 10, 1.8);
      const bbPosCheck = (bbCheck.u - bbCheck.l) > 0 ? (cur - bbCheck.l) / (bbCheck.u - bbCheck.l) : 0.5;
      const isMeanReversion = (signal === 'BUY' && (rsiCheck < 35 || bbPosCheck < 0.20)) || (signal === 'SELL' && (rsiCheck > 65 || bbPosCheck > 0.80));

      // FILTER 1: Volume min (vr < 0.3)
      if (vr < 0.3) signal = 'NEUTRAL';

      // FILTER 2: Momentum (trend-only)
      if (signal !== 'NEUTRAL' && !isMeanReversion) {
        const mom = checkMomentum(C5, H5, L5, 5);
        if (signal === 'BUY' && mom.consecutiveDn >= 4) signal = 'NEUTRAL';
        if (signal === 'SELL' && mom.consecutiveUp >= 4) signal = 'NEUTRAL';
      }
    }

    B = signal === 'BUY' ? score : 0;
    S = signal === 'SELL' ? score : 0;
    tpMult = 1.8;
    slMult = 1.0;

  } else {
    // ═══ MOTOR 3: FREE MODE ═══
    const rsi = calcRSI(C5, 14);
    const bb = calcBB(C5, 20, 2);
    const bbR = bb.u - bb.l;
    const bbPos = bbR > 0 ? (cur - bb.l) / bbR : 0.5;
    const ea9 = calcEMAArr(C5, 9), ea21 = calcEMAArr(C5, 21);
    const e9 = ea9.at(-1), e21 = ea21.at(-1);
    const stFull = calcStoch(H5, L5, C5, 14);
    const stK = stFull.k || 50;
    const mac = calcMACD(C5);
    const avgV = V5.slice(-20).reduce((a, b) => a + b) / 20;
    const lv = V5.at(-1);
    const vr = lv / avgV;

    let bScore = 0, sScore = 0, bInds = 0, sInds = 0;

    if (rsi < 30) { bScore += 3; bInds++; }
    else if (rsi > 70) { sScore += 3; sInds++; }

    if (bbPos < 0.10) { bScore += 2; bInds++; }
    else if (bbPos > 0.90) { sScore += 2; sInds++; }

    if (stK < 25) { bScore += 2; bInds++; }
    else if (stK > 75) { sScore += 2; sInds++; }

    if (e9 > e21) { bScore += 1.5; bInds++; } else { sScore += 1.5; sInds++; }

    if (vr > 1.5) {
      const vSig = rsi < 50 ? 'BUY' : 'SELL';
      if (vSig === 'BUY') { bScore += 1; bInds++; } else { sScore += 1; sInds++; }
    }

    if (mac.h > 0) { bScore += 0.5; } else { sScore += 0.5; }

    const minScore = 5;
    const minInds = 3;

    if (bScore >= minScore && bInds >= minInds && bScore > sScore + 1) { signal = 'BUY'; score = bScore; indCount = bInds; }
    else if (sScore >= minScore && sInds >= minInds && sScore > bScore + 1) { signal = 'SELL'; score = sScore; indCount = sInds; }

    if (signal !== 'NEUTRAL' && isVolatile) signal = 'NEUTRAL';
    if (signal !== 'NEUTRAL' && vr < 0.3) signal = 'NEUTRAL';

    B = signal === 'BUY' ? score : 0;
    S = signal === 'SELL' ? score : 0;
    tpMult = 1.3;
    slMult = 1.0;
  }

  if (signal === 'NEUTRAL') return null;

  // ═══ TP/SL CALCULATION (exact from app.html) ═══
  let atr15 = atr;
  if (H15 && H15.length > 15 && L15.length > 15 && C15.length > 15) {
    const _a15 = calcATR(H15, L15, C15, 14);
    if (_a15 > 0) atr15 = _a15;
  }
  let atr1h = atr;
  if (H1h && H1h.length > 15 && L1h.length > 15 && C1h.length > 15) {
    const _a1h = calcATR(H1h, L1h, C1h, 14);
    if (_a1h > 0) atr1h = _a1h;
  }

  // For scalp: ATR(14) on 5m; for others: max(atr15, atr1h/4)
  const useATR = isScalp ? (calcATR(H5, L5, C5, 14) || atr) : Math.max(atr15, atr1h / 4);

  let tpDist = useATR * tpMult;
  let slDist = useATR * slMult;

  // Minimums
  const minTPdist = cur * 0.002;
  if (tpDist < minTPdist) tpDist = minTPdist;
  if (slDist < cur * 0.001) slDist = cur * 0.001;

  const costBuffer = cur * 0.0008;
  const slipBuffer = cur * 0.0005;
  const totalBuffer = costBuffer + slipBuffer;

  let tp, sl;
  if (signal === 'BUY') {
    tp = cur + tpDist - totalBuffer;
    sl = cur - slDist + slipBuffer;
  } else {
    tp = cur - tpDist + totalBuffer;
    sl = cur + slDist - slipBuffer;
  }

  return { signal, score, indCount, entry: cur, tp, sl, tpDist, slDist, htfTrend, mtfConfirm };
}

// ═══ TRADE EVALUATION (no look-ahead bias) ═══

function evaluateTrade(signal, entry, tp, sl, futureCandles) {
  // Walk future candles to see if TP or SL was hit
  for (const candle of futureCandles) {
    const { o, h, l } = candle;

    if (signal === 'BUY') {
      const hitTP = h >= tp;
      const hitSL = l <= sl;

      if (hitTP && hitSL) {
        // Both hit in same candle - use open to determine which first
        // If open closer to SL → SL hit first; if open closer to TP → TP hit first
        const distToTP = tp - o;
        const distToSL = o - sl;
        if (distToSL <= distToTP) {
          // SL hit first
          return { result: 'LOSS', exitPrice: sl };
        } else {
          return { result: 'WIN', exitPrice: tp };
        }
      } else if (hitTP) {
        return { result: 'WIN', exitPrice: tp };
      } else if (hitSL) {
        return { result: 'LOSS', exitPrice: sl };
      }
    } else {
      // SELL
      const hitTP = l <= tp;
      const hitSL = h >= sl;

      if (hitTP && hitSL) {
        const distToTP = o - tp;
        const distToSL = sl - o;
        if (distToSL <= distToTP) {
          return { result: 'LOSS', exitPrice: sl };
        } else {
          return { result: 'WIN', exitPrice: tp };
        }
      } else if (hitTP) {
        return { result: 'WIN', exitPrice: tp };
      } else if (hitSL) {
        return { result: 'LOSS', exitPrice: sl };
      }
    }
  }
  // Neither hit within available candles — treat as expired at last close
  const lastClose = futureCandles.length > 0 ? futureCandles.at(-1).c : entry;
  const pnlPct = signal === 'BUY' ? (lastClose - entry) / entry : (entry - lastClose) / entry;
  return { result: pnlPct >= 0 ? 'WIN' : 'LOSS', exitPrice: lastClose, expired: true };
}

// ═══ MAP 5m index → corresponding 15m/1h index ═══

function build5mTo15mMap(kl5, kl15) {
  // For each 5m candle, find the last 15m candle that closed at or before it
  const map = new Array(kl5.length).fill(-1);
  let j = 0;
  for (let i = 0; i < kl5.length; i++) {
    while (j < kl15.length - 1 && kl15[j + 1].t <= kl5[i].t) j++;
    if (kl15[j].t <= kl5[i].t) map[i] = j;
  }
  return map;
}

function build5mTo1hMap(kl5, kl1h) {
  const map = new Array(kl5.length).fill(-1);
  let j = 0;
  for (let i = 0; i < kl5.length; i++) {
    while (j < kl1h.length - 1 && kl1h[j + 1].t <= kl5[i].t) j++;
    if (kl1h[j].t <= kl5[i].t) map[i] = j;
  }
  return map;
}

// ═══ MAIN BACKTEST ═══

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  RX PRO — Backtest v11 Final Sync (150 days)');
  console.log('  Trade size: $500 x5 leverage = $2500 notional');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Gather all unique symbols
  const allSyms = [...new Set([...VIP_SCAN_SYMS, ...SCALP_SCAN_SYMS, ...FREE_SCAN_SYMS])];
  console.log(`Downloading data for ${allSyms.length} symbols...`);

  // Need 5m candles: 150 days * 288 + 280 warmup
  const need5m = TOTAL_5M + 280;
  // 15m candles: 150 days * 96 + 100 warmup
  const need15m = DAYS * 96 + 100;
  // 1h candles: 150 days * 24 + 50 warmup
  const need1h = DAYS * 24 + 50;

  const data = {};
  for (const sym of allSyms) {
    process.stdout.write(`  ${sym}: downloading 5m...`);
    const kl5 = await downloadKlines(sym, '5m', need5m);
    process.stdout.write(` 15m...`);
    const kl15 = await downloadKlines(sym, '15m', need15m);
    process.stdout.write(` 1h...`);
    const kl1h = await downloadKlines(sym, '1h', need1h);
    console.log(` done (5m:${kl5.length}, 15m:${kl15.length}, 1h:${kl1h.length})`);
    data[sym] = { kl5, kl15, kl1h };
  }

  console.log('\nBuilding timeframe maps...');
  const maps = {};
  for (const sym of allSyms) {
    maps[sym] = {
      map15: build5mTo15mMap(data[sym].kl5, data[sym].kl15),
      map1h: build5mTo1hMap(data[sym].kl5, data[sym].kl1h),
    };
  }

  // Determine actual test start (need at least 280 warmup candles)
  const WARMUP = 280;
  // How many 5m candles to look ahead for TP/SL evaluation (up to 288 = 1 day)
  const LOOKAHEAD = 288;

  const motors = [
    { name: 'VIP (Strict)', mode: 'strict', syms: VIP_SCAN_SYMS, cdBars: CD_STRICT },
    { name: 'Scalp', mode: 'scalp', syms: SCALP_SCAN_SYMS, cdBars: CD_SCALP },
    { name: 'Free', mode: 'frequent', syms: FREE_SCAN_SYMS, cdBars: CD_FREE },
  ];

  for (const motor of motors) {
    console.log(`\n${'═'.repeat(65)}`);
    console.log(`  MOTOR: ${motor.name}`);
    console.log(`  Mode: ${motor.mode} | Pairs: ${motor.syms.length} | Cooldown: ${motor.cdBars} bars`);
    console.log(`${'═'.repeat(65)}`);

    const trades = [];
    const symTrades = {};
    const dayPnL = {};
    const cooldowns = {}; // sym -> last signal bar index

    for (const sym of motor.syms) {
      cooldowns[sym] = -Infinity;
      symTrades[sym] = [];
      const { kl5, kl15, kl1h } = data[sym];
      const { map15, map1h } = maps[sym];

      const totalBars = kl5.length;
      const testStart = WARMUP;
      const testEnd = totalBars - LOOKAHEAD;

      if (testEnd <= testStart) {
        console.log(`  ${sym}: not enough data (${totalBars} bars), skipping`);
        continue;
      }

      let signalCount = 0;
      for (let i = testStart; i < testEnd; i++) {
        // Cooldown check
        if (i - cooldowns[sym] < motor.cdBars) continue;

        // Build slices for indicator calculation (lookback 280)
        const startIdx = Math.max(0, i - 279);
        const C5 = kl5.slice(startIdx, i + 1).map(k => k.c);
        const H5 = kl5.slice(startIdx, i + 1).map(k => k.h);
        const L5 = kl5.slice(startIdx, i + 1).map(k => k.l);
        const V5 = kl5.slice(startIdx, i + 1).map(k => k.v);
        const kl5Raw = kl5.slice(startIdx, i + 1);

        // Get 15m slice up to current bar
        const i15 = map15[i];
        let C15 = null, H15 = null, L15 = null, V15 = null;
        if (i15 >= 0 && i15 >= 25) {
          const start15 = Math.max(0, i15 - 99);
          C15 = kl15.slice(start15, i15 + 1).map(k => k.c);
          H15 = kl15.slice(start15, i15 + 1).map(k => k.h);
          L15 = kl15.slice(start15, i15 + 1).map(k => k.l);
          V15 = kl15.slice(start15, i15 + 1).map(k => k.v);
        }

        // Get 1h slice up to current bar
        const i1h = map1h[i];
        let C1h = null, H1h = null, L1h = null, V1h = null;
        if (i1h >= 0 && i1h >= 25) {
          const start1h = Math.max(0, i1h - 49);
          C1h = kl1h.slice(start1h, i1h + 1).map(k => k.c);
          H1h = kl1h.slice(start1h, i1h + 1).map(k => k.h);
          L1h = kl1h.slice(start1h, i1h + 1).map(k => k.l);
          V1h = kl1h.slice(start1h, i1h + 1).map(k => k.v);
        }

        const sig = genSigAtBar(C5, H5, L5, V5, kl5Raw, C15, H15, L15, V15, C1h, H1h, L1h, V1h, motor.mode);

        if (!sig) continue;

        signalCount++;
        cooldowns[sym] = i;

        // Evaluate trade with future candles
        const futureCandles = kl5.slice(i + 1, i + 1 + LOOKAHEAD);
        const result = evaluateTrade(sig.signal, sig.entry, sig.tp, sig.sl, futureCandles);

        const pnlPct = sig.signal === 'BUY'
          ? (result.exitPrice - sig.entry) / sig.entry
          : (sig.entry - result.exitPrice) / sig.entry;
        const pnlDollar = pnlPct * POSITION_SIZE;

        const tradeDate = new Date(kl5[i].t).toISOString().slice(0, 10);

        const trade = {
          sym,
          signal: sig.signal,
          entry: sig.entry,
          tp: sig.tp,
          sl: sig.sl,
          exit: result.exitPrice,
          result: result.result,
          pnlPct,
          pnlDollar,
          score: sig.score,
          date: tradeDate,
          barIdx: i,
          expired: result.expired || false,
        };

        trades.push(trade);
        symTrades[sym].push(trade);

        if (!dayPnL[tradeDate]) dayPnL[tradeDate] = 0;
        dayPnL[tradeDate] += pnlDollar;
      }
    }

    // ═══ REPORTING ═══
    if (trades.length === 0) {
      console.log('\n  No trades generated.\n');
      continue;
    }

    const wins = trades.filter(t => t.result === 'WIN');
    const losses = trades.filter(t => t.result === 'LOSS');
    const totalPnL = trades.reduce((s, t) => s + t.pnlDollar, 0);
    const winRate = wins.length / trades.length;

    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnlDollar, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnlDollar, 0) / losses.length) : 0;
    const profitFactor = losses.length ? wins.reduce((s, t) => s + t.pnlDollar, 0) / Math.abs(losses.reduce((s, t) => s + t.pnlDollar, 0)) : Infinity;

    // Consecutive wins/losses
    let maxConsecWins = 0, maxConsecLosses = 0, cw = 0, cl = 0;
    for (const t of trades) {
      if (t.result === 'WIN') { cw++; cl = 0; maxConsecWins = Math.max(maxConsecWins, cw); }
      else { cl++; cw = 0; maxConsecLosses = Math.max(maxConsecLosses, cl); }
    }

    // Max drawdown
    let peak = 0, equity = 0, maxDD = 0;
    for (const t of trades) {
      equity += t.pnlDollar;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? (peak - equity) / peak : 0;
      if (dd > maxDD) maxDD = dd;
    }

    // Days count
    const firstDate = trades[0].date;
    const lastDate = trades.at(-1).date;
    const daySpan = (new Date(lastDate) - new Date(firstDate)) / (1000 * 86400) + 1;
    const sigsPerDay = trades.length / daySpan;

    console.log(`\n  RESULTS:`);
    console.log(`  ─────────────────────────────────────────────────`);
    console.log(`  Total trades:       ${trades.length}`);
    console.log(`  Period:             ${firstDate} → ${lastDate} (${Math.round(daySpan)} days)`);
    console.log(`  Signals/day:        ${sigsPerDay.toFixed(1)}`);
    console.log(`  Win rate:           ${(winRate * 100).toFixed(1)}%`);
    console.log(`  Profit Factor:      ${profitFactor === Infinity ? 'Inf' : profitFactor.toFixed(2)}`);
    console.log(`  Total PnL:          $${totalPnL.toFixed(2)} (${(totalPnL / TRADE_SIZE * 100).toFixed(1)}%)`);
    console.log(`  Avg win:            $${avgWin.toFixed(2)}`);
    console.log(`  Avg loss:           -$${avgLoss.toFixed(2)}`);
    console.log(`  Avg win/loss ratio: ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'Inf'}`);
    console.log(`  Max consec wins:    ${maxConsecWins}`);
    console.log(`  Max consec losses:  ${maxConsecLosses}`);
    console.log(`  Max drawdown:       ${(maxDD * 100).toFixed(1)}%`);
    console.log(`  Expired trades:     ${trades.filter(t => t.expired).length}`);

    // Per-symbol breakdown
    console.log(`\n  PER-SYMBOL BREAKDOWN:`);
    console.log(`  ${'Symbol'.padEnd(12)} ${'Trades'.padStart(6)} ${'WR%'.padStart(6)} ${'PF'.padStart(6)} ${'PnL($)'.padStart(10)}`);
    console.log(`  ${'─'.repeat(44)}`);
    for (const sym of motor.syms) {
      const st = symTrades[sym];
      if (!st || !st.length) {
        console.log(`  ${sym.padEnd(12)} ${'-'.padStart(6)} ${'-'.padStart(6)} ${'-'.padStart(6)} ${'-'.padStart(10)}`);
        continue;
      }
      const sw = st.filter(t => t.result === 'WIN');
      const sl2 = st.filter(t => t.result === 'LOSS');
      const swr = sw.length / st.length;
      const spnl = st.reduce((s, t) => s + t.pnlDollar, 0);
      const spf = sl2.length ? sw.reduce((s, t) => s + t.pnlDollar, 0) / Math.abs(sl2.reduce((s, t) => s + t.pnlDollar, 0)) : Infinity;
      console.log(`  ${sym.padEnd(12)} ${String(st.length).padStart(6)} ${(swr * 100).toFixed(1).padStart(6)} ${(spf === Infinity ? 'Inf' : spf.toFixed(2)).padStart(6)} ${spnl.toFixed(2).padStart(10)}`);
    }

    // Best/worst 5 days
    const dayEntries = Object.entries(dayPnL).sort((a, b) => b[1] - a[1]);
    console.log(`\n  BEST 5 DAYS:`);
    for (let i = 0; i < Math.min(5, dayEntries.length); i++) {
      const [date, pnl] = dayEntries[i];
      console.log(`    ${date}  $${pnl.toFixed(2)}`);
    }
    console.log(`\n  WORST 5 DAYS:`);
    for (let i = dayEntries.length - 1; i >= Math.max(0, dayEntries.length - 5); i--) {
      const [date, pnl] = dayEntries[i];
      console.log(`    ${date}  $${pnl.toFixed(2)}`);
    }

    // Monthly breakdown
    console.log(`\n  MONTHLY BREAKDOWN:`);
    const monthPnL = {};
    const monthTrades = {};
    for (const t of trades) {
      const m = t.date.slice(0, 7);
      if (!monthPnL[m]) { monthPnL[m] = 0; monthTrades[m] = { w: 0, l: 0 }; }
      monthPnL[m] += t.pnlDollar;
      if (t.result === 'WIN') monthTrades[m].w++; else monthTrades[m].l++;
    }
    console.log(`  ${'Month'.padEnd(10)} ${'Trades'.padStart(7)} ${'WR%'.padStart(6)} ${'PnL($)'.padStart(10)}`);
    console.log(`  ${'─'.repeat(37)}`);
    for (const m of Object.keys(monthPnL).sort()) {
      const mt = monthTrades[m];
      const total = mt.w + mt.l;
      const wr = mt.w / total;
      console.log(`  ${m.padEnd(10)} ${String(total).padStart(7)} ${(wr * 100).toFixed(1).padStart(6)} ${monthPnL[m].toFixed(2).padStart(10)}`);
    }
  }

  console.log(`\n${'═'.repeat(65)}`);
  console.log('  Backtest complete.');
  console.log(`${'═'.repeat(65)}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
