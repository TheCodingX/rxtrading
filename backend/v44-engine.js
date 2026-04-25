// ══════════════════════════════════════════════════════════════════════
// APEX V44 FUNDING CARRY — Server-side engine (port from frontend app.html)
// Runs 24/7 on backend, publishes to /api/public-signals
// Source: research-v44/apex-x/scripts/apex_elite_engine.js (validated OOS 365d)
// ══════════════════════════════════════════════════════════════════════

const SAFE_FUNDING_PARAMS = Object.freeze({
  TP_BPS: 30, SL_BPS: 25, HOLD_H: 4,
  P80_Q: 0.80, P20_Q: 0.20,
  F_POS_MIN: 0.005, F_NEG_MAX: -0.002,
  SIZE_PCT: 0.10,
  ELITE_M1_ENABLED: true,
  Z_LOW: 1.0, Z_MID: 2.0, Z_HIGH: 3.0,
  SIZE_MULT_LOW: 0.7, SIZE_MULT_NORMAL: 1.0,
  SIZE_MULT_HIGH: 1.35, SIZE_MULT_EXTREME: 1.6,
  Z_LOOKBACK_H: 720,
  ELITE_M2_ENABLED: true,
  SETTLEMENT_HOURS: [0, 8, 16],
  WINDOW_HOURS_OFFSET: [-1, 0, 1],
  SETTLEMENT_MIN_OFFSET: 30,
  ULTRA_A_ENABLED: true,
  QUALITY_THRESHOLD: 1.101,
  WINDOW_WEIGHT_MID: 1.0,
  WINDOW_WEIGHT_PRE: 0.85,
  WINDOW_WEIGHT_POST: 0.75,
  ULTRA_B_ENABLED: true,
  LEVERAGE: 3.0,
  MAX_MARGIN_UTIL: 0.60,
  MAX_TRADE_LOSS_PCT: 2.0,
  ULTRA_C_ENABLED: true,
  UNIVERSE: ['ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT','SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT']
});

function computeFundingProxy(bars1h){
  const n = bars1h.length;
  if(n < 60) return null;
  const closes = bars1h.map(b => b.c);
  const ema = new Float64Array(n);
  ema[0] = closes[0];
  const alpha = 2 / (50 + 1);
  for(let i = 1; i < n; i++) ema[i] = closes[i] * alpha + ema[i-1] * (1 - alpha);
  const premium = closes.map((v, i) => (v - ema[i]) / ema[i]);
  const funding = new Float64Array(n);
  const w = 8;
  for(let i = w; i < n; i++){
    let s = 0;
    for(let j = i - w + 1; j <= i; j++) s += premium[j];
    funding[i] = s / w;
  }
  return funding;
}

function fundingZScore(fundArr, idx, lookback){
  if(idx < lookback) return 0;
  let sum = 0;
  for(let j = idx - lookback + 1; j <= idx; j++) sum += fundArr[j];
  const mean = sum / lookback;
  let vsum = 0;
  for(let j = idx - lookback + 1; j <= idx; j++) vsum += (fundArr[j] - mean) ** 2;
  const std = Math.sqrt(vsum / lookback);
  return std > 0 ? (fundArr[idx] - mean) / std : 0;
}

function sizeMultFromZ(z){
  const p = SAFE_FUNDING_PARAMS;
  if(!p.ELITE_M1_ENABLED) return 1.0;
  const absZ = Math.abs(z);
  if(absZ >= p.Z_HIGH) return p.SIZE_MULT_EXTREME;
  if(absZ >= p.Z_MID) return p.SIZE_MULT_HIGH;
  if(absZ < p.Z_LOW) return p.SIZE_MULT_LOW;
  return p.SIZE_MULT_NORMAL;
}

function confidenceScore(z, windowType){
  const p = SAFE_FUNDING_PARAMS;
  const zAbs = Math.abs(z);
  let w = p.WINDOW_WEIGHT_MID;
  if(windowType === 'PRE') w = p.WINDOW_WEIGHT_PRE;
  else if(windowType === 'POST') w = p.WINDOW_WEIGHT_POST;
  return zAbs * w;
}

function passQualityFilter(z, windowType){
  const p = SAFE_FUNDING_PARAMS;
  if(!p.ULTRA_A_ENABLED) return true;
  return confidenceScore(z, windowType) >= p.QUALITY_THRESHOLD;
}

function getWindowTypeForHour(hr){
  const p = SAFE_FUNDING_PARAMS;
  for(const sh of p.SETTLEMENT_HOURS){
    if(hr === sh) return 'MID';
    if(hr === ((sh - 1 + 24) % 24)) return 'PRE';
    if(hr === ((sh + 1) % 24)) return 'POST';
  }
  return null;
}

function isEligibleHour(hr){
  return getWindowTypeForHour(hr) !== null;
}

function evaluateFundingCarry(pair, bars1h){
  const p = SAFE_FUNDING_PARAMS;
  if(!bars1h || bars1h.length < p.Z_LOOKBACK_H + 50) return null;
  const idx = bars1h.length - 1;
  const bar = bars1h[idx];
  const hr = new Date(bar.t).getUTCHours();
  const windowType = getWindowTypeForHour(hr);
  if(!windowType) return null;

  const fundArr = computeFundingProxy(bars1h);
  if(!fundArr) return null;
  const f = fundArr[idx];
  if(!isFinite(f)) return null;

  const fWin = Array.from(fundArr.slice(Math.max(0, idx - 168), idx)).filter(isFinite);
  if(fWin.length < 50) return null;
  const sorted = [...fWin].sort((a, b) => a - b);
  const p80 = sorted[Math.floor(sorted.length * p.P80_Q)] || 0;
  const p20 = sorted[Math.floor(sorted.length * p.P20_Q)] || 0;

  let dir = 0;
  if(f > p80 && f > p.F_POS_MIN) dir = -1;
  else if(f < p20 && f < p.F_NEG_MAX) dir = 1;
  if(dir === 0) return null;

  const z = fundingZScore(fundArr, idx, p.Z_LOOKBACK_H);
  const sizeMult = sizeMultFromZ(z);
  if(!passQualityFilter(z, windowType)) return null;

  const entry = bar.c;
  const tp = dir === 1 ? entry * (1 + p.TP_BPS / 10000) : entry * (1 - p.TP_BPS / 10000);
  const sl = dir === 1 ? entry * (1 - p.SL_BPS / 10000) : entry * (1 + p.SL_BPS / 10000);

  const baseConf = Math.min(85, 50 + Math.abs(f - (dir === 1 ? p20 : p80)) * 1000);
  const zBoost = sizeMult >= 1.6 ? 15 : (sizeMult >= 1.35 ? 8 : 3);
  const confidence = Math.min(98, Math.round(baseConf + zBoost));

  return {
    symbol: pair,
    signal: dir === 1 ? 'BUY' : 'SELL',
    confidence,
    entry, tp, sl,
    funding: f,
    funding_zscore: z,
    size_multiplier: sizeMult,
    quality_score: confidenceScore(z, windowType),
    window_type: windowType,
    leverage: p.LEVERAGE,
    hold_hours: p.HOLD_H,
    timestamp: Date.now(),
    engine: 'APEX_V44_SERVER'
  };
}

// Fetch 1h klines from Binance Futures (preferred) with spot fallback
async function fetchBars1h(symbol, limit = 800){
  const tryFetch = async (url) => {
    const r = await fetch(url);
    if(!r.ok) return null;
    const arr = await r.json();
    if(!Array.isArray(arr) || arr.length === 0) return null;
    return arr.map(k => ({ t: parseInt(k[0]), c: parseFloat(k[4]) }));
  };
  // 2026-04-25: cadena de fallbacks por geo-blocking de Binance desde Render (HTTP 451).
  // Browser-like UA porque algunos exchanges bloquean default node fetch UA.
  const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const fetchOpts = { headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' } };

  // 1. Binance fapi (mejor calidad, falla por 451 desde Render)
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=${limit}`, fetchOpts);
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map(k => ({ t: parseInt(k[0]), c: parseFloat(k[4]) }));
      }
    }
  } catch(e){}

  // 2. OKX (perpetual swap, no geo-block desde US/EU)
  try {
    const okxSym = symbol.endsWith('USDT') ? `${symbol.slice(0, -4)}-USDT-SWAP` : symbol;
    const r = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${okxSym}&bar=1H&limit=${Math.min(limit, 300)}`, fetchOpts);
    if (r.ok) {
      const j = await r.json();
      const arr = j?.data;
      if (Array.isArray(arr) && arr.length > 0) {
        // OKX: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm] — newest first
        return arr.map(k => ({ t: parseInt(k[0]), c: parseFloat(k[4]) })).reverse();
      }
    }
  } catch(e){}

  // 3. Bybit (funciona desde algunas regiones, no todas)
  try {
    const r = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=${Math.min(limit, 1000)}`, fetchOpts);
    if (r.ok) {
      const j = await r.json();
      const list = j?.result?.list;
      if (Array.isArray(list) && list.length > 0) {
        return list.map(k => ({ t: parseInt(k[0]), c: parseFloat(k[4]) })).reverse();
      }
    }
  } catch(e){}

  // 4. CryptoCompare (universal, fallback final)
  try {
    if (symbol.endsWith('USDT')) {
      const base = symbol.slice(0, -4);
      const r = await fetch(`https://min-api.cryptocompare.com/data/v2/histohour?fsym=${base}&tsym=USDT&limit=${Math.min(limit, 2000)}`, fetchOpts);
      if (r.ok) {
        const j = await r.json();
        const arr = j?.Data?.Data;
        if (Array.isArray(arr) && arr.length > 0) {
          return arr.map(k => ({ t: parseInt(k.time) * 1000, c: parseFloat(k.close) }));
        }
      }
    }
  } catch(e){}

  // 5. Binance spot fallback (último intento)
  try {
    const bars = await tryFetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`);
    if(bars) return bars;
  } catch(e){}
  return null;
}

// Scan all pairs in the validated universe. Returns array of signals (non-null only).
async function scanAllPairs(){
  const p = SAFE_FUNDING_PARAMS;
  const hr = new Date().getUTCHours();
  if(!isEligibleHour(hr)){
    return { scanned: 0, signals: [], reason: 'outside_window', next_window_utc: findNextEligibleHour(hr) };
  }
  const results = await Promise.all(p.UNIVERSE.map(async (sym) => {
    try {
      const bars = await fetchBars1h(sym, 800);
      if(!bars || bars.length < p.Z_LOOKBACK_H + 50) return null;
      return evaluateFundingCarry(sym, bars);
    } catch(e){ return null; }
  }));
  const signals = results.filter(Boolean);
  return { scanned: p.UNIVERSE.length, signals, window_type: getWindowTypeForHour(hr), reason: 'ok' };
}

function findNextEligibleHour(fromHr){
  const p = SAFE_FUNDING_PARAMS;
  const eligible = new Set();
  for(const sh of p.SETTLEMENT_HOURS){
    for(const off of p.WINDOW_HOURS_OFFSET) eligible.add((sh + off + 24) % 24);
  }
  for(let h = fromHr + 1; h < fromHr + 25; h++){
    if(eligible.has(h % 24)) return h % 24;
  }
  return p.SETTLEMENT_HOURS[0];
}

module.exports = {
  SAFE_FUNDING_PARAMS,
  evaluateFundingCarry,
  fetchBars1h,
  scanAllPairs,
  isEligibleHour,
  getWindowTypeForHour,
  findNextEligibleHour
};
