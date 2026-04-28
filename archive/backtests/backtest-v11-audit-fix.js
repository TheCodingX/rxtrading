#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// BACKTEST v11 AUDIT FIX — Exact replica of app.html genSig logic
// Tests VIP (strict) and Scalp modes over 150 days of real Binance 5m data
// ═══════════════════════════════════════════════════════════════════════

const https = require('https');

// ═══ CONFIG ═══
const DAYS = 150;
const TRADE_SIZE = 500;
const LEVERAGE = 5;
const MIN_CONFIDENCE = 60;
const VIP_COOLDOWN_BARS = 36;
const SCALP_COOLDOWN_BARS = 12;

const VIP_PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','ADAUSDT','LINKUSDT','DOTUSDT','DOGEUSDT','ARBUSDT','OPUSDT'];
const SCALP_ONLY = ['SUIUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT','TIAUSDT','ATOMUSDT','XRPUSDT','AVAXUSDT'];
const SCALP_PAIRS = [...VIP_PAIRS, ...SCALP_ONLY];

// ═══ INDICATOR FUNCTIONS (exact copy from app.html) ═══

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
  if (adx.adx > 25 && atrPct > 1.5) return { regime: 'TRENDING', label: 'TENDENCIA FUERTE', cls: 'trending' };
  if (adx.adx < 20 && atrPct < 0.8) return { regime: 'QUIET', label: 'MERCADO QUIETO', cls: 'quiet' };
  if (atrPct > 2) return { regime: 'VOLATILE', label: 'ALTA VOLATILIDAD', cls: 'volatile' };
  return { regime: 'RANGING', label: 'RANGO LATERAL', cls: 'ranging' };
}

function checkMomentum(C, H, L, lookback = 5) {
  if (!C || C.length < lookback + 1) return { bullish: false, bearish: false, strength: 0, consecutiveUp: 0, consecutiveDn: 0 };
  const recent = C.slice(-lookback);
  let upCandles = 0, dnCandles = 0;
  let tempUp = 0, tempDn = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > recent[i - 1]) { upCandles++; tempUp++; tempDn = 0; }
    else { dnCandles++; tempDn++; tempUp = 0; }
  }
  return { bullish: upCandles > dnCandles, bearish: dnCandles > upCandles, strength: (upCandles - dnCandles) / (lookback - 1), consecutiveUp: tempUp, consecutiveDn: tempDn };
}

// ═══ DATA FETCHING ═══

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

async function getKlines(sym, interval, limit, endTime) {
  let url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
  if (endTime) url += `&endTime=${endTime}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchJSON(url);
    } catch (e) {
      if (attempt < 2) await sleep(1000 * (attempt + 1));
      else throw e;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══ SIGNAL GENERATION — Exact replica of app.html genSig ═══

function genSig(kl5, kl15, kl1h, mode, sym) {
  const isStrict = (mode === 'strict');
  const isScalp = (mode === 'scalp');

  if (!kl5 || !kl5.length) return null;
  const C = kl5.map(k => parseFloat(k[4])), H = kl5.map(k => parseFloat(k[2])), L = kl5.map(k => parseFloat(k[3])), V = kl5.map(k => parseFloat(k[5]));
  const C15 = kl15 ? kl15.map(k => parseFloat(k[4])) : [];
  const H15 = kl15 ? kl15.map(k => parseFloat(k[2])) : [];
  const L15 = kl15 ? kl15.map(k => parseFloat(k[3])) : [];
  const V15 = kl15 ? kl15.map(k => parseFloat(k[5])) : [];
  const cur = C.at(-1);
  let B = 0, S = 0;

  // Parse 1H data
  const C1h = (kl1h && kl1h.length > 15) ? kl1h.map(k => parseFloat(k[4])) : [];
  const H1h = (kl1h && kl1h.length > 15) ? kl1h.map(k => parseFloat(k[2])) : [];
  const L1h = (kl1h && kl1h.length > 15) ? kl1h.map(k => parseFloat(k[3])) : [];
  const V1h = (kl1h && kl1h.length > 15) ? kl1h.map(k => parseFloat(k[5])) : [];

  // STEP 1: HTF Trend (1H)
  let htfTrend = 'NEUTRAL';
  let htfStrength = 0;
  if (kl1h && kl1h.length > 25) {
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

  // STEP 2: 15m Confirmation
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

  // Regime detection
  const adxData = calcADX(H, L, C);
  let atr = calcATR(H, L, C, 14);
  let regimeData = { regime: 'RANGING', label: 'RANGO LATERAL', cls: 'ranging' };
  try { regimeData = detectRegime(H, L, C, adxData, atr); } catch (e) { }
  const regime = regimeData.regime || 'RANGING';
  const isVolatile = (regime === 'VOLATILE');

  let signal = 'NEUTRAL';
  let conf = 50;
  let score = 0;
  let indCount = 0;
  let tpMult, slMult;

  if (isStrict) {
    // ═══ MOTOR 1: VIP PRECISION v9 ═══
    const rsiS = calcRSI(C, 7); const mac = calcMACD(C);
    const ea5 = calcEMAArr(C, 5), ea13 = calcEMAArr(C, 13);
    const e5 = ea5.at(-1), e13 = ea13.at(-1);
    const bbS = calcBB(C, 10, 1.8); const bbSR = bbS.u - bbS.l; const bbSPos = bbSR > 0 ? (cur - bbS.l) / bbSR : 0.5;
    const vwapArr = calcVWAP(kl5.slice(-50)); const vwap = vwapArr.at(-1);
    const avgV = V.slice(-20).reduce((a, b) => a + b) / 20, lv = V.at(-1), vr = lv / avgV;
    const stS = calcStoch(H, L, C, 7); const stK = stS.k || 50, stD = stS.d || 50;
    const psar = calcParabolicSAR(H, L, C);
    const kc = calcKeltner(H, L, C, 20, 14, 2);
    const mfi = calcMFI(H, L, C, V, 7);

    let bScore = 0, sScore = 0, bInds = 0, sInds = 0;

    // RSI(7)
    if (rsiS < 25) { bScore += 3; bInds++; }
    else if (rsiS < 40) { bScore += 2; bInds++; }
    else if (rsiS < 48) { bScore += 1; bInds++; }
    else if (rsiS > 75) { sScore += 3; sInds++; }
    else if (rsiS > 60) { sScore += 2; sInds++; }
    else if (rsiS > 52) { sScore += 1; sInds++; }

    // Stoch(7)
    const stCrossUp = stK > stD && stK < 35; const stCrossDown = stK < stD && stK > 65;
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
    if (vr > 1.5) { const vSig = rsiS < 50 ? 'BUY' : 'SELL'; if (vSig === 'BUY') { bScore += 2; bInds++; } else { sScore += 2; sInds++; } }
    else if (vr > 0.8) { const vSig = rsiS < 50 ? 'BUY' : 'SELL'; if (vSig === 'BUY') bScore += 0.5; else sScore += 0.5; }

    // Keltner
    if (kc.position < 0.25) { bScore += 1.5; bInds++; }
    else if (kc.position > 0.75) { sScore += 1.5; sInds++; }

    // PSAR
    if (psar.trend === 'BUY') { bScore += 1; bInds++; } else { sScore += 1; sInds++; }

    // MFI
    if (mfi < 35) { bScore += 1.5; bInds++; }
    else if (mfi > 65) { sScore += 1.5; sInds++; }

    // NOTE: Session timing & AIS weights NOT applied in backtest (no real-time clock, no AIS state)

    // VIP PRECISION DECISION v11
    const minScore = 7;
    const minInds = 5;

    if (htfTrend === 'BUY' && bScore >= minScore && bInds >= minInds) { signal = 'BUY'; score = bScore; indCount = bInds; }
    else if (htfTrend === 'SELL' && sScore >= minScore && sInds >= minInds) { signal = 'SELL'; score = sScore; indCount = sInds; }
    else if (htfTrend === 'NEUTRAL') {
      if (bScore >= minScore + 2 && bInds >= minInds && bScore > sScore + 2) { signal = 'BUY'; score = bScore; indCount = bInds; }
      else if (sScore >= minScore + 2 && sInds >= minInds && sScore > bScore + 2) { signal = 'SELL'; score = sScore; indCount = sInds; }
    }

    if (signal !== 'NEUTRAL' && isVolatile && adxData.adx > 45) signal = 'NEUTRAL';

    // POST-SIGNAL FILTERS VIP v11
    if (signal !== 'NEUTRAL') {
      const rsiCheck = calcRSI(C, 7);
      const bbCheck = calcBB(C, 10, 1.8);
      const bbPosCheck = (bbCheck.u - bbCheck.l) > 0 ? (cur - bbCheck.l) / (bbCheck.u - bbCheck.l) : 0.5;
      const isMeanReversion = (signal === 'BUY' && (rsiCheck < 35 || bbPosCheck < 0.20)) || (signal === 'SELL' && (rsiCheck > 65 || bbPosCheck > 0.80));

      // FILTER 1: Volatility Quality
      const atrPctCheck = (calcATR(H, L, C, 7) / cur) * 100;
      if (atrPctCheck < 0.05 || atrPctCheck > 0.8) signal = 'NEUTRAL';

      // FILTER 2: Momentum — ONLY for trend-following
      if (signal !== 'NEUTRAL' && !isMeanReversion) {
        const mom = checkMomentum(C, H, L, 5);
        if (signal === 'BUY' && mom.consecutiveDn >= 4) signal = 'NEUTRAL';
        if (signal === 'SELL' && mom.consecutiveUp >= 4) signal = 'NEUTRAL';
      }

      // FILTER 3: Volume confirmation
      if (signal !== 'NEUTRAL') {
        const avgVCheck = V.slice(-20).reduce((a, b) => a + b) / 20;
        const vrCheck = V.at(-1) / avgVCheck;
        if (vrCheck < 0.4) signal = 'NEUTRAL';
      }
    }

    if (signal !== 'NEUTRAL') {
      const maxScore = 22;
      conf = Math.round(65 + (score / maxScore) * 28);
      if (htfTrend === signal) conf += 5;
      if (mtfConfirm === signal) conf += 3;
      conf = Math.min(95, Math.max(55, conf));
    }

    B = signal === 'BUY' ? score : 0;
    S = signal === 'SELL' ? score : 0;
    tpMult = 2.0;
    slMult = 1.0;

  } else if (isScalp) {
    // ═══ MOTOR 2: SCALP MODE ═══
    const scalpGate = mtfConfirm;

    const rsiS = calcRSI(C, 7);
    const mac = calcMACD(C);
    const ea5 = calcEMAArr(C, 5), ea13 = calcEMAArr(C, 13);
    const e5 = ea5.at(-1), e13 = ea13.at(-1);
    const bbS = calcBB(C, 10, 1.8);
    const bbSR = bbS.u - bbS.l;
    const bbSPos = bbSR > 0 ? (cur - bbS.l) / bbSR : 0.5;
    const vwapArr = calcVWAP(kl5.slice(-50)); const vwap = vwapArr.at(-1);
    const avgV = V.slice(-20).reduce((a, b) => a + b) / 20, lv = V.at(-1), vr = lv / avgV;
    const stS = calcStoch(H, L, C, 7);
    const stK = stS.k || 50;
    const stD = stS.d || 50;
    const psar = calcParabolicSAR(H, L, C);
    const kc = calcKeltner(H, L, C, 20, 14, 2);
    const mfi = calcMFI(H, L, C, V, 7);

    let bScore = 0, sScore = 0, bInds = 0, sInds = 0;

    // 1. RSI(7) — scalp thresholds
    if (rsiS < 25) { bScore += 3; bInds++; }
    else if (rsiS < 35) { bScore += 2; bInds++; }
    else if (rsiS < 45) { bScore += 1; bInds++; }
    else if (rsiS > 75) { sScore += 3; sInds++; }
    else if (rsiS > 65) { sScore += 2; sInds++; }
    else if (rsiS > 55) { sScore += 1; sInds++; }

    // 2. Stoch K(7) — widened thresholds
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
    if (vwap && cur < vwap) { bScore += 1; bInds++; } else if (vwap && cur > vwap) { sScore += 1; sInds++; }

    // 7. Volume
    if (vr > 1.5) { const vSig = rsiS < 50 ? 'BUY' : 'SELL'; if (vSig === 'BUY') { bScore += 2; bInds++; } else { sScore += 2; sInds++; } }
    else if (vr > 0.8) { const vSig = rsiS < 50 ? 'BUY' : 'SELL'; if (vSig === 'BUY') { bScore += 0.5; } else { sScore += 0.5; } }

    // 8. Keltner
    if (kc.position < 0.25) { bScore += 1.5; bInds++; }
    else if (kc.position > 0.75) { sScore += 1.5; sInds++; }

    // 9. PSAR
    if (psar.trend === 'BUY') { bScore += 1; bInds++; } else { sScore += 1; sInds++; }

    // 10. MFI(7)
    if (mfi < 35) { bScore += 1.5; bInds++; }
    else if (mfi > 65) { sScore += 1.5; sInds++; }

    // SCALP v8.5 — Score 6, min 4 inds
    const minScore = 6;
    const minInds = 4;

    // SCALP v10 — TREND-FOLLOWING decision
    // 1. Double alignment (15m + 1H) -> score -1
    if (scalpGate === 'BUY' && htfTrend === 'BUY' && bScore >= minScore - 1 && bInds >= minInds - 1) { signal = 'BUY'; score = bScore; indCount = bInds; }
    else if (scalpGate === 'SELL' && htfTrend === 'SELL' && sScore >= minScore - 1 && sInds >= minInds - 1) { signal = 'SELL'; score = sScore; indCount = sInds; }
    // 2. Only 15m aligned
    else if (scalpGate === 'BUY' && bScore >= minScore && bInds >= minInds) { signal = 'BUY'; score = bScore; indCount = bInds; }
    else if (scalpGate === 'SELL' && sScore >= minScore && sInds >= minInds) { signal = 'SELL'; score = sScore; indCount = sInds; }
    // 3. Gate neutral -> +1 score
    else if (scalpGate === 'NEUTRAL') {
      if (bScore >= minScore + 1 && bInds >= minInds && bScore > sScore + 1.5) { signal = 'BUY'; score = bScore; indCount = bInds; }
      else if (sScore >= minScore + 1 && sInds >= minInds && sScore > bScore + 1.5) { signal = 'SELL'; score = sScore; indCount = sInds; }
    }
    // CONTRA 1H: allow mean-reversion with +2 score extra
    if (signal !== 'NEUTRAL' && htfTrend !== 'NEUTRAL' && signal !== htfTrend) {
      if (score < minScore + 2) signal = 'NEUTRAL';
    }

    if (signal !== 'NEUTRAL' && isVolatile && adxData.adx > 45) signal = 'NEUTRAL';

    // POST-SIGNAL FILTERS SCALP v11
    if (signal !== 'NEUTRAL') {
      const rsiCheck = calcRSI(C, 7);
      const bbCheck = calcBB(C, 10, 1.8);
      const bbPosCheck = (bbCheck.u - bbCheck.l) > 0 ? (cur - bbCheck.l) / (bbCheck.u - bbCheck.l) : 0.5;
      const isMeanReversion = (signal === 'BUY' && (rsiCheck < 35 || bbPosCheck < 0.20)) || (signal === 'SELL' && (rsiCheck > 65 || bbPosCheck > 0.80));

      // FILTER 1: Volume minimum (0.3x average)
      if (vr < 0.3) signal = 'NEUTRAL';

      // FILTER 2: Momentum — ONLY for trend-following
      if (signal !== 'NEUTRAL' && !isMeanReversion) {
        const mom = checkMomentum(C, H, L, 5);
        if (signal === 'BUY' && mom.consecutiveDn >= 4) signal = 'NEUTRAL';
        if (signal === 'SELL' && mom.consecutiveUp >= 4) signal = 'NEUTRAL';
      }
    }

    if (signal !== 'NEUTRAL') {
      const maxScore = 22;
      conf = Math.round(50 + (score / maxScore) * 40);
      if (mtfConfirm === signal) conf += 3;
      if (htfTrend === signal) conf += 5;
      conf = Math.min(90, Math.max(50, conf));
    }

    B = signal === 'BUY' ? score : 0;
    S = signal === 'SELL' ? score : 0;
    tpMult = 1.8;
    slMult = 1.0;
  }

  // TP/SL CALCULATION
  let atr15 = atr;
  if (kl15 && kl15.length > 15 && H15.length > 15 && L15.length > 15) {
    const _a15 = calcATR(H15, L15, C15, 14);
    if (_a15 > 0) atr15 = _a15;
  }
  let atr1h = atr;
  if (H1h.length > 15 && L1h.length > 15 && C1h.length > 15) {
    const _a1h = calcATR(H1h, L1h, C1h, 14);
    if (_a1h > 0) atr1h = _a1h;
  }

  const useATR = isScalp ? calcATR(H, L, C, 14) || atr : Math.max(atr15, atr1h / 4);

  let tpDist = useATR * tpMult;
  let slDist = useATR * slMult;

  const minTPdist = cur * 0.002;
  if (tpDist < minTPdist) tpDist = minTPdist;
  if (slDist < cur * 0.001) slDist = cur * 0.001;

  const costBuffer = cur * 0.0008;

  // FIX: TP closer (conservative), SL no buffer
  const tpBuy = cur + tpDist - costBuffer;
  const tpSell = cur - tpDist + costBuffer;
  const slBuy = cur - slDist;
  const slSell = cur + slDist;

  return { signal, confidence: conf, B, S, entry: cur, tp: signal === 'BUY' ? tpBuy : signal === 'SELL' ? tpSell : null, sl: signal === 'BUY' ? slBuy : signal === 'SELL' ? slSell : null, tpDist, slDist, score, atr: useATR, symbol: sym };
}

// ═══ BACKTEST ENGINE ═══

async function fetchAllData(sym, days) {
  // Fetch 5m candles in chunks (max 1000 per request)
  const barsNeeded = days * 288; // 288 5m bars per day
  const now = Date.now();
  const startTime = now - days * 24 * 60 * 60 * 1000;

  let allKlines = [];
  let endTime = now;

  while (allKlines.length < barsNeeded) {
    const remaining = barsNeeded - allKlines.length;
    const limit = Math.min(remaining + 280, 1000); // +280 for indicator warmup
    const klines = await getKlines(sym, '5m', limit, endTime);
    if (!klines || klines.length === 0) break;
    allKlines = klines.concat(allKlines);
    endTime = klines[0][0] - 1;
    await sleep(100);
  }

  // Also fetch 15m and 1h for the same period
  let all15m = [];
  endTime = now;
  const bars15m = Math.ceil(days * 96) + 100; // 96 per day + warmup
  while (all15m.length < bars15m) {
    const limit = Math.min(bars15m - all15m.length + 100, 1000);
    const klines = await getKlines(sym, '15m', limit, endTime);
    if (!klines || klines.length === 0) break;
    all15m = klines.concat(all15m);
    endTime = klines[0][0] - 1;
    await sleep(100);
  }

  let all1h = [];
  endTime = now;
  const bars1h = Math.ceil(days * 24) + 50; // 24 per day + warmup
  while (all1h.length < bars1h) {
    const limit = Math.min(bars1h - all1h.length + 50, 1000);
    const klines = await getKlines(sym, '1h', limit, endTime);
    if (!klines || klines.length === 0) break;
    all1h = klines.concat(all1h);
    endTime = klines[0][0] - 1;
    await sleep(100);
  }

  return { kl5: allKlines, kl15: all15m, kl1h: all1h };
}

function walkForwardEval(kl5, entry, tp, sl, signal, entryIdx) {
  // Walk forward from entryIdx+1 to check TP/SL hit
  for (let i = entryIdx + 1; i < kl5.length; i++) {
    const high = parseFloat(kl5[i][2]);
    const low = parseFloat(kl5[i][3]);

    if (signal === 'BUY') {
      if (low <= sl) return { result: 'SL', exitPrice: sl, bars: i - entryIdx };
      if (high >= tp) return { result: 'TP', exitPrice: tp, bars: i - entryIdx };
    } else {
      if (high >= sl) return { result: 'SL', exitPrice: sl, bars: i - entryIdx };
      if (low <= tp) return { result: 'TP', exitPrice: tp, bars: i - entryIdx };
    }
  }
  // If neither hit, evaluate at last close
  const lastClose = parseFloat(kl5[kl5.length - 1][4]);
  const pnl = signal === 'BUY' ? lastClose - entry : entry - lastClose;
  return { result: pnl > 0 ? 'TP' : 'SL', exitPrice: lastClose, bars: kl5.length - 1 - entryIdx };
}

async function backtestSymbol(sym, mode, data) {
  const { kl5, kl15, kl1h } = data;
  const trades = [];
  const cooldownBars = mode === 'strict' ? VIP_COOLDOWN_BARS : SCALP_COOLDOWN_BARS;
  let lastSignalBar = -cooldownBars - 1;

  // Need at least 280 bars warmup for indicators
  const startIdx = 280;

  for (let i = startIdx; i < kl5.length - 50; i++) {
    // Cooldown check
    if (i - lastSignalBar < cooldownBars) continue;

    // Extract window of 280 bars for 5m
    const window5 = kl5.slice(Math.max(0, i - 279), i + 1);

    // Find corresponding 15m and 1h windows
    const barTime = kl5[i][0];
    const w15 = kl15.filter(k => k[0] <= barTime).slice(-100);
    const w1h = kl1h.filter(k => k[0] <= barTime).slice(-50);

    const sig = genSig(window5, w15, w1h, mode, sym);
    if (!sig || sig.signal === 'NEUTRAL') continue;
    if (sig.confidence < MIN_CONFIDENCE) continue;

    // Walk forward to evaluate
    const evalResult = walkForwardEval(kl5, sig.entry, sig.tp, sig.sl, sig.signal, i);

    const priceDiff = sig.signal === 'BUY' ? evalResult.exitPrice - sig.entry : sig.entry - evalResult.exitPrice;
    const pctMove = priceDiff / sig.entry;
    const pnl = TRADE_SIZE * LEVERAGE * pctMove;

    trades.push({
      signal: sig.signal,
      entry: sig.entry,
      tp: sig.tp,
      sl: sig.sl,
      exitPrice: evalResult.exitPrice,
      result: evalResult.result,
      pnl,
      pctMove,
      bars: evalResult.bars,
      score: sig.score,
      confidence: sig.confidence,
      time: new Date(kl5[i][0]).toISOString()
    });

    lastSignalBar = i;
  }

  return trades;
}

function analyzeResults(trades, label) {
  if (trades.length === 0) return { label, trades: 0, wins: 0, losses: 0, wr: 0, pf: 0, totalPnl: 0, avgWin: 0, avgLoss: 0, maxConsLoss: 0, maxDD: 0, sigPerDay: 0 };

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;
  const avgWin = wins.length > 0 ? grossWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

  // Max consecutive losses
  let maxConsLoss = 0, curConsLoss = 0;
  for (const t of trades) {
    if (t.pnl <= 0) { curConsLoss++; maxConsLoss = Math.max(maxConsLoss, curConsLoss); }
    else curConsLoss = 0;
  }

  // Max drawdown
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity - peak);
  }

  // Signals per day
  const firstTime = new Date(trades[0].time).getTime();
  const lastTime = new Date(trades[trades.length - 1].time).getTime();
  const daySpan = Math.max(1, (lastTime - firstTime) / (24 * 60 * 60 * 1000));
  const sigPerDay = trades.length / daySpan;

  return {
    label,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    wr: (wins.length / trades.length * 100),
    pf,
    totalPnl,
    avgWin,
    avgLoss,
    maxConsLoss,
    maxDD,
    sigPerDay
  };
}

function printReport(results, mode) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  ${mode === 'strict' ? 'VIP PRECISION' : 'SCALP ENGINE'} — BACKTEST RESULTS (${DAYS} days)`);
  console.log(`  Trade Size: $${TRADE_SIZE} x ${LEVERAGE}x leverage | Min Confidence: ${MIN_CONFIDENCE}%`);
  console.log(`  Cooldown: ${mode === 'strict' ? VIP_COOLDOWN_BARS : SCALP_COOLDOWN_BARS} bars | TP: ${mode === 'strict' ? '2.0' : '1.8'} ATR, SL: 1.0 ATR`);
  console.log(`${'═'.repeat(80)}\n`);

  console.log(`${'Symbol'.padEnd(12)} ${'Trades'.padStart(7)} ${'Wins'.padStart(6)} ${'Loss'.padStart(6)} ${'WR%'.padStart(7)} ${'PF'.padStart(7)} ${'PnL($)'.padStart(10)} ${'AvgWin'.padStart(8)} ${'AvgLoss'.padStart(8)} ${'MaxCL'.padStart(6)} ${'MaxDD'.padStart(10)} ${'Sig/d'.padStart(6)}`);
  console.log(`${'─'.repeat(105)}`);

  const allTrades = [];
  const symbolsToRemove = [];

  for (const r of results) {
    allTrades.push(...r.allTrades);
    const flag = r.stats.totalPnl < 0 ? ' ✗' : '';
    if (r.stats.totalPnl < 0) symbolsToRemove.push(r.symbol);
    console.log(
      `${(r.symbol + flag).padEnd(12)} ${String(r.stats.trades).padStart(7)} ${String(r.stats.wins).padStart(6)} ${String(r.stats.losses).padStart(6)} ${r.stats.wr.toFixed(1).padStart(7)} ${r.stats.pf.toFixed(2).padStart(7)} ${('$' + r.stats.totalPnl.toFixed(2)).padStart(10)} ${('$' + r.stats.avgWin.toFixed(2)).padStart(8)} ${('$' + r.stats.avgLoss.toFixed(2)).padStart(8)} ${String(r.stats.maxConsLoss).padStart(6)} ${('$' + r.stats.maxDD.toFixed(2)).padStart(10)} ${r.stats.sigPerDay.toFixed(1).padStart(6)}`
    );
  }

  const overall = analyzeResults(allTrades, 'OVERALL');
  console.log(`${'─'.repeat(105)}`);
  console.log(
    `${'OVERALL'.padEnd(12)} ${String(overall.trades).padStart(7)} ${String(overall.wins).padStart(6)} ${String(overall.losses).padStart(6)} ${overall.wr.toFixed(1).padStart(7)} ${overall.pf.toFixed(2).padStart(7)} ${('$' + overall.totalPnl.toFixed(2)).padStart(10)} ${('$' + overall.avgWin.toFixed(2)).padStart(8)} ${('$' + overall.avgLoss.toFixed(2)).padStart(8)} ${String(overall.maxConsLoss).padStart(6)} ${('$' + overall.maxDD.toFixed(2)).padStart(10)} ${overall.sigPerDay.toFixed(1).padStart(6)}`
  );

  if (symbolsToRemove.length > 0) {
    console.log(`\n  ⚠ REMOVE (negative PnL): ${symbolsToRemove.join(', ')}`);
  } else {
    console.log(`\n  ✓ All symbols profitable!`);
  }

  return overall;
}

// ═══ MAIN ═══

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  BACKTEST v11 AUDIT FIX — Exact genSig Logic from app.html');
  console.log('  150 days | Real Binance 5m/15m/1h data');
  console.log('  VIP: score>=7, 5 inds, HTF gate, TP 2.0/SL 1.0 ATR');
  console.log('  Scalp: score>=6, 4 inds, 15m+1H gate, TP 1.8/SL 1.0 ATR');
  console.log('  Post-filters: mean-rev vs trend-follow, vol quality, momentum');
  console.log('  Cost buffer: TP closer by 0.08%, SL no buffer');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ═══ VIP BACKTEST ═══
  console.log('Fetching VIP data...');
  const vipResults = [];
  for (const sym of VIP_PAIRS) {
    process.stdout.write(`  ${sym}... `);
    try {
      const data = await fetchAllData(sym, DAYS);
      console.log(`${data.kl5.length} 5m bars, ${data.kl15.length} 15m bars, ${data.kl1h.length} 1h bars`);
      const trades = await backtestSymbol(sym, 'strict', data);
      const stats = analyzeResults(trades, sym);
      vipResults.push({ symbol: sym, stats, allTrades: trades });
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      vipResults.push({ symbol: sym, stats: analyzeResults([], sym), allTrades: [] });
    }
    await sleep(200);
  }
  const vipOverall = printReport(vipResults, 'strict');

  // ═══ SCALP BACKTEST ═══
  console.log('\n\nFetching Scalp data...');
  const scalpResults = [];
  for (const sym of SCALP_PAIRS) {
    process.stdout.write(`  ${sym}... `);
    try {
      // Reuse VIP data if already fetched
      const vipData = vipResults.find(v => v.symbol === sym);
      let data;
      if (vipData && vipData.allTrades !== undefined && vipData.stats.trades >= 0) {
        // Need to re-fetch since we didn't store the raw data
        data = await fetchAllData(sym, DAYS);
      } else {
        data = await fetchAllData(sym, DAYS);
      }
      console.log(`${data.kl5.length} 5m bars, ${data.kl15.length} 15m bars, ${data.kl1h.length} 1h bars`);
      const trades = await backtestSymbol(sym, 'scalp', data);
      const stats = analyzeResults(trades, sym);
      scalpResults.push({ symbol: sym, stats, allTrades: trades });
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
      scalpResults.push({ symbol: sym, stats: analyzeResults([], sym), allTrades: [] });
    }
    await sleep(200);
  }
  const scalpOverall = printReport(scalpResults, 'scalp');

  // ═══ COMBINED SUMMARY ═══
  console.log(`\n\n${'═'.repeat(80)}`);
  console.log('  COMBINED SUMMARY');
  console.log(`${'═'.repeat(80)}`);
  console.log(`  VIP:   ${vipOverall.trades} trades | WR ${vipOverall.wr.toFixed(1)}% | PF ${vipOverall.pf.toFixed(2)} | PnL $${vipOverall.totalPnl.toFixed(2)} | ${vipOverall.sigPerDay.toFixed(1)} sig/day`);
  console.log(`  Scalp: ${scalpOverall.trades} trades | WR ${scalpOverall.wr.toFixed(1)}% | PF ${scalpOverall.pf.toFixed(2)} | PnL $${scalpOverall.totalPnl.toFixed(2)} | ${scalpOverall.sigPerDay.toFixed(1)} sig/day`);
  const totalPnl = vipOverall.totalPnl + scalpOverall.totalPnl;
  const totalTrades = vipOverall.trades + scalpOverall.trades;
  console.log(`  TOTAL: ${totalTrades} trades | PnL $${totalPnl.toFixed(2)}`);
  console.log(`${'═'.repeat(80)}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
