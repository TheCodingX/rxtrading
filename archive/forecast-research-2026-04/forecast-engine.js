/**
 * AI FORECAST — Ensemble Engine (3 modelos independientes)
 * Fecha: 2026-04-24
 *
 * Filosofía: mostrar predicciones SOLO cuando 3 modelos coinciden con
 * confidence ≥ threshold (default 0.85). Priorizamos precision sobre recall —
 * pocas predicciones pero acertadas.
 *
 * Modelos:
 *   1) Momentum  — MTF trend + RSI + MACD divergence + funding regime
 *   2) Microstructure — volume delta (proxy de orderflow) + taker/maker proxy + OI proxy
 *   3) Macro — BTC dominance direction + regime (fearGreed)
 *
 * Output: { dir: 'UP'|'DOWN'|null, confidence: 0-1, drivers: [...], raw: {...} }
 */

'use strict';

// ─────────── Indicadores técnicos base ───────────
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let up = 0, dn = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) up += d; else dn -= d;
  }
  let avgU = up / period, avgD = dn / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) { avgU = (avgU * (period - 1) + d) / period; avgD = (avgD * (period - 1)) / period; }
    else      { avgU = (avgU * (period - 1)) / period;     avgD = (avgD * (period - 1) - d) / period; }
  }
  if (avgD === 0) return 100;
  const rs = avgU / avgD;
  return 100 - 100 / (1 + rs);
}

function ema(arr, period) {
  if (arr.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k));
  return out;
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return { macd: 0, signal: 0, hist: 0 };
  const efast = ema(closes, fast);
  const eslow = ema(closes, slow);
  const macdLine = efast.map((v, i) => v - eslow[i]);
  const signalLine = ema(macdLine.slice(slow - 1), signal);
  const m = macdLine.at(-1);
  const s = signalLine.at(-1);
  return { macd: m, signal: s, hist: m - s };
}

function atr(h, l, c, period = 14) {
  if (h.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < h.length; i++) {
    trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  }
  let a = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

// ─────────── MODELO 1: Momentum (MTF) ───────────
// Inputs: klines 1h, 4h, 1d (close-only arrays); funding rate actual (optional)
function scoreMomentum({ kl1h, kl4h, kl1d, funding = 0 }) {
  const c1h = kl1h.map(k => +k[4]);
  const c4h = kl4h.map(k => +k[4]);
  const c1d = kl1d.map(k => +k[4]);

  if (c1h.length < 30 || c4h.length < 30 || c1d.length < 30) {
    return { p: 0.5, signals: [], usable: false };
  }

  const signals = [];

  // EMA cross 1h
  const ema1h20 = ema(c1h, 20).at(-1);
  const ema1h50 = ema(c1h, 50).at(-1);
  const mtfBias1h = ema1h20 > ema1h50 ? 1 : -1;
  signals.push({ n: 'EMA20>50 1h', v: mtfBias1h });

  // EMA cross 4h
  const ema4h20 = ema(c4h, 20).at(-1);
  const ema4h50 = ema(c4h, 50).at(-1);
  const mtfBias4h = ema4h20 > ema4h50 ? 1 : -1;
  signals.push({ n: 'EMA20>50 4h', v: mtfBias4h });

  // EMA cross 1d
  const ema1d10 = ema(c1d, 10).at(-1);
  const ema1d30 = ema(c1d, 30).at(-1);
  const mtfBias1d = ema1d10 > ema1d30 ? 1 : -1;
  signals.push({ n: 'EMA10>30 1d', v: mtfBias1d });

  const mtfAlign = (mtfBias1h + mtfBias4h + mtfBias1d) / 3;

  // RSI 4h (bias directional)
  const r4h = rsi(c4h, 14);
  let rsiBias = 0;
  if (r4h > 55 && r4h < 70) rsiBias = 1;       // bull not overbought
  else if (r4h < 45 && r4h > 30) rsiBias = -1; // bear not oversold
  else if (r4h >= 70) rsiBias = -0.5;          // overbought → bearish mean-revert
  else if (r4h <= 30) rsiBias = 0.5;           // oversold → bullish mean-revert
  signals.push({ n: `RSI 4h ${r4h.toFixed(1)}`, v: rsiBias });

  // MACD 4h histogram direction
  const m4h = macd(c4h);
  const macdBias = m4h.hist > 0 ? 1 : -1;
  signals.push({ n: `MACD 4h hist ${m4h.hist.toFixed(4)}`, v: macdBias });

  // Funding regime (extreme funding = mean-revert bias)
  let fundingBias = 0;
  if (funding > 0.0004) fundingBias = -0.5;       // extreme positive funding → shorts squeezed eventually → down
  else if (funding < -0.0004) fundingBias = 0.5;  // extreme negative → longs squeezed → up
  else fundingBias = 0;
  signals.push({ n: `Funding ${(funding*10000).toFixed(2)}bps`, v: fundingBias });

  // Ponderar: MTF align es el driver más fuerte
  const raw = 0.45 * mtfAlign + 0.25 * rsiBias + 0.20 * macdBias + 0.10 * fundingBias;
  // Map [-1..1] → P(UP) [0..1] via sigmoid
  const p = 1 / (1 + Math.exp(-3 * raw));
  return { p, signals, usable: true, mtfAlign };
}

// ─────────── MODELO 2: Microstructure ───────────
// Sin acceso a trades tick-by-tick usamos proxies:
//   - Volume-weighted delta: Δ = ΣvolumeClose_up - ΣvolumeClose_down (últimas N velas 1h)
//   - Taker buy ratio (desde klines Binance index 9: takerBuyBaseVol)
//   - Volume acceleration (últimas 3 velas vs promedio 20)
function scoreMicrostructure({ kl1h }) {
  if (!kl1h || kl1h.length < 30) return { p: 0.5, signals: [], usable: false };
  const k = kl1h;
  const last = k.slice(-20);
  let posDelta = 0, negDelta = 0, takerBuyVol = 0, totalVol = 0;
  for (const bar of last) {
    const open = +bar[1], close = +bar[4], vol = +bar[5], takerBuy = +(bar[9] || 0);
    if (close > open) posDelta += vol;
    else if (close < open) negDelta += vol;
    takerBuyVol += takerBuy;
    totalVol += vol;
  }
  const volDelta = (posDelta - negDelta) / Math.max(1, posDelta + negDelta);
  const takerRatio = totalVol > 0 ? (takerBuyVol / totalVol) : 0.5; // 0.5 = neutro
  const takerBias = (takerRatio - 0.5) * 2; // [-1, 1]

  // Volume acceleration
  const last3Avg = last.slice(-3).reduce((s, b) => s + +b[5], 0) / 3;
  const prev17Avg = last.slice(0, 17).reduce((s, b) => s + +b[5], 0) / 17;
  const volAccel = prev17Avg > 0 ? (last3Avg - prev17Avg) / prev17Avg : 0;

  // Último candle direction as tiebreaker
  const lastBar = k.at(-1);
  const lastDir = +lastBar[4] > +lastBar[1] ? 1 : -1;

  const signals = [
    { n: `Vol delta ${(volDelta*100).toFixed(1)}%`, v: volDelta },
    { n: `Taker buy ${(takerRatio*100).toFixed(1)}%`, v: takerBias },
    { n: `Vol accel ${(volAccel*100).toFixed(1)}%`, v: Math.sign(volAccel) * Math.min(1, Math.abs(volAccel)) },
    { n: 'Last bar dir', v: lastDir }
  ];

  // Ponderar: taker ratio es la señal microstructura más directa
  const raw = 0.40 * takerBias + 0.30 * volDelta + 0.20 * Math.sign(volAccel) + 0.10 * lastDir;
  const p = 1 / (1 + Math.exp(-3 * raw));
  return { p, signals, usable: true, volDelta, takerBias };
}

// ─────────── MODELO 3: Macro ───────────
// Inputs: btc direction (last 24h change %), fearGreed index (0-100), overall regime
function scoreMacro({ btc24hChgPct = 0, fearGreed = 50, spxBias = 0 }) {
  const signals = [];

  // BTC direction
  let btcBias = 0;
  if (btc24hChgPct > 2) btcBias = 1;
  else if (btc24hChgPct > 0.5) btcBias = 0.5;
  else if (btc24hChgPct < -2) btcBias = -1;
  else if (btc24hChgPct < -0.5) btcBias = -0.5;
  signals.push({ n: `BTC 24h ${btc24hChgPct.toFixed(2)}%`, v: btcBias });

  // Fear & Greed (contra-trend en extremos)
  let fgBias = 0;
  if (fearGreed >= 75) fgBias = -0.5;       // greed extrema → corrección probable
  else if (fearGreed >= 55) fgBias = 0.3;   // greed moderada → bull bias
  else if (fearGreed <= 25) fgBias = 0.5;   // miedo extremo → rebote probable
  else if (fearGreed <= 45) fgBias = -0.3;  // miedo moderado → bear bias
  signals.push({ n: `F&G ${fearGreed}`, v: fgBias });

  // SPX correlation (simplified: +1 bull, 0 neutral, -1 bear)
  signals.push({ n: `SPX bias ${spxBias}`, v: spxBias });

  const raw = 0.50 * btcBias + 0.30 * fgBias + 0.20 * spxBias;
  const p = 1 / (1 + Math.exp(-2 * raw));
  return { p, signals, usable: true };
}

// ─────────── Ensemble + Gate ───────────
// Threshold configurable. El gate exige:
//   1) Los 3 modelos usables (suficientes datos)
//   2) Los 3 modelos coinciden en dirección (todos P>0.5 o todos <0.5)
//   3) Confidence ponderada ≥ minConfidence
//
// Peso default: momentum 0.45, microstructure 0.30, macro 0.25
function ensembleForecast(opts, minConfidence = 0.85) {
  const momentum = scoreMomentum(opts.momentum || {});
  const micro = scoreMicrostructure(opts.micro || {});
  const macroScore = scoreMacro(opts.macro || {});

  const allUsable = momentum.usable && micro.usable && macroScore.usable;
  if (!allUsable) {
    return { active: false, reason: 'insufficient_data', models: { momentum, micro, macro: macroScore } };
  }

  const pM = momentum.p;
  const pU = micro.p;
  const pMa = macroScore.p;

  // Check directional agreement: todos >0.5 o todos <0.5
  const ups = (pM > 0.5 ? 1 : 0) + (pU > 0.5 ? 1 : 0) + (pMa > 0.5 ? 1 : 0);
  const agree = ups === 3 || ups === 0;

  // Weighted confidence (probabilidad promedio direccional)
  const weighted = 0.45 * pM + 0.30 * pU + 0.25 * pMa;
  const confidence = ups === 3 ? weighted : (1 - weighted);
  const direction = ups === 3 ? 'UP' : 'DOWN';

  if (!agree) {
    return { active: false, reason: 'model_disagreement', confidence: Math.max(weighted, 1 - weighted), models: { momentum, micro, macro: macroScore } };
  }
  if (confidence < minConfidence) {
    return { active: false, reason: 'confidence_below_threshold', confidence, direction, models: { momentum, micro, macro: macroScore } };
  }

  // Drivers: top signals from each model
  const drivers = [
    ...(momentum.signals || []).map(s => ({ model: 'momentum', ...s })),
    ...(micro.signals || []).map(s => ({ model: 'microstructure', ...s })),
    ...(macroScore.signals || []).map(s => ({ model: 'macro', ...s }))
  ].filter(d => Math.abs(d.v) > 0.2)
   .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
   .slice(0, 5);

  return {
    active: true,
    direction,
    confidence,
    drivers,
    models: {
      momentum: { p: pM, signals: momentum.signals },
      micro: { p: pU, signals: micro.signals },
      macro: { p: pMa, signals: macroScore.signals }
    }
  };
}

module.exports = {
  rsi, ema, macd, atr,
  scoreMomentum, scoreMicrostructure, scoreMacro,
  ensembleForecast
};
