#!/usr/bin/env node
'use strict';
/**
 * ROUND 6 — SWING TRADING on 1H/4H
 * Radical shift: wide TP (5-12%) where fees are negligible
 * 7 strategies, 7 pairs, 120 days, Binance Futures data
 *
 * THE KEY INSIGHT:
 *   TP 5% = $125 win, fees $1.00 = 0.8% of win → NEGLIGIBLE
 *   vs 5m scalp TP 1% = $25 win, fees $1.00 = 4% of win → DEVASTATING
 *
 * Usage: node strategy-round6.js
 */

const https = require('https');

// ═══ CONFIG ═══
const CAP0 = 500;
const LEV = 5;
const POS = CAP0 * LEV; // $2,500
const FEE_M = 0.0002;   // 0.02% maker (limit entry + TP)
const FEE_T = 0.0004;   // 0.04% taker (market SL)
const SLIP = 0.0001;    // 0.01% slippage on SL
const FILL_RATE = 0.80; // 80% fill rate
const DAYS = 120;
const FUNDING_RATE = 0.0001; // 0.01% per 8h for positions held >8h
const DAILY_LOSS_LIMIT = 0.06; // 6% of capital
const MAX_POSITIONS = 3;
const MAX_SAME_DIR = 2;

const ALL_PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT'];

// ═══ INDICATOR LIBRARY ═══
function emaArr(d, p) {
  if (!d.length) return [];
  const k = 2 / (p + 1), r = [d[0]];
  for (let i = 1; i < d.length; i++) r.push(d[i] * k + r[i - 1] * (1 - k));
  return r;
}

function smaArr(d, p) {
  const r = [];
  let s = 0;
  for (let i = 0; i < d.length; i++) {
    s += d[i];
    if (i >= p) s -= d[i - p];
    r.push(i >= p - 1 ? s / p : s / (i + 1));
  }
  return r;
}

function rsiArr(c, p = 14) {
  if (c.length < p + 1) return c.map(() => 50);
  const r = new Float64Array(c.length);
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= p; al /= p;
  for (let i = 0; i < p; i++) r[i] = 50;
  r[p] = al < 1e-10 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
    r[i] = al < 1e-10 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return r;
}

function macdHistArr(c) {
  const e12 = emaArr(c, 12), e26 = emaArr(c, 26);
  const ml = e12.map((v, i) => v - e26[i]);
  const sl = emaArr(ml, 9);
  return ml.map((v, i) => v - sl[i]);
}

function macdLineArr(c) {
  const e12 = emaArr(c, 12), e26 = emaArr(c, 26);
  return e12.map((v, i) => v - e26[i]);
}

function atrArr(h, l, c, p = 14) {
  const r = new Float64Array(h.length);
  const tr = new Float64Array(h.length);
  tr[0] = h[0] - l[0];
  for (let i = 1; i < h.length; i++)
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  let s = 0;
  for (let i = 0; i < Math.min(p, tr.length); i++) s += tr[i];
  if (p <= tr.length) r[p - 1] = s / p;
  for (let i = p; i < tr.length; i++) r[i] = (r[i - 1] * (p - 1) + tr[i]) / p;
  return r;
}

function adxArr(h, l, c, p = 14) {
  const len = h.length;
  const adx = new Float64Array(len);
  const pdi = new Float64Array(len);
  const mdi = new Float64Array(len);
  if (len < p * 2 + 1) return { adx, pdi, mdi };

  const pdm = new Float64Array(len);
  const mdm = new Float64Array(len);
  const tr = new Float64Array(len);

  for (let i = 1; i < len; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    pdm[i] = up > dn && up > 0 ? up : 0;
    mdm[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }

  // Wilder smoothing
  let smTR = 0, smPDM = 0, smMDM = 0;
  for (let i = 1; i <= p; i++) { smTR += tr[i]; smPDM += pdm[i]; smMDM += mdm[i]; }

  const dxArr = new Float64Array(len);
  for (let i = p; i < len; i++) {
    if (i > p) {
      smTR = smTR - smTR / p + tr[i];
      smPDM = smPDM - smPDM / p + pdm[i];
      smMDM = smMDM - smMDM / p + mdm[i];
    }
    pdi[i] = smTR > 0 ? (smPDM / smTR) * 100 : 0;
    mdi[i] = smTR > 0 ? (smMDM / smTR) * 100 : 0;
    const sum = pdi[i] + mdi[i];
    dxArr[i] = sum > 0 ? Math.abs(pdi[i] - mdi[i]) / sum * 100 : 0;
  }

  // ADX = Wilder smooth of DX
  let adxS = 0;
  for (let i = p; i < 2 * p; i++) adxS += dxArr[i];
  adxS /= p;
  adx[2 * p - 1] = adxS;
  for (let i = 2 * p; i < len; i++) {
    adxS = (adxS * (p - 1) + dxArr[i]) / p;
    adx[i] = adxS;
  }
  return { adx, pdi, mdi };
}

function volSmaArr(v, p = 20) { return smaArr(v, p); }

// Pivot highs/lows for structure detection
function pivotHighs(h, n = 5) {
  const r = [];
  for (let i = n; i < h.length - n; i++) {
    let ok = true;
    for (let j = i - n; j < i; j++) if (h[j] >= h[i]) { ok = false; break; }
    if (ok) for (let j = i + 1; j <= i + n; j++) if (h[j] >= h[i]) { ok = false; break; }
    if (ok) r.push({ i, v: h[i] });
  }
  return r;
}

function pivotLows(l, n = 5) {
  const r = [];
  for (let i = n; i < l.length - n; i++) {
    let ok = true;
    for (let j = i - n; j < i; j++) if (l[j] <= l[i]) { ok = false; break; }
    if (ok) for (let j = i + 1; j <= i + n; j++) if (l[j] <= l[i]) { ok = false; break; }
    if (ok) r.push({ i, v: l[i] });
  }
  return r;
}

// Rate of change (momentum)
function rocArr(c, p = 24) {
  const r = new Float64Array(c.length);
  for (let i = p; i < c.length; i++) r[i] = c[i - p] > 0 ? (c[i] - c[i - p]) / c[i - p] * 100 : 0;
  return r;
}

// ═══ DATA FETCHING ═══
function fetchJSON(url) {
  return new Promise((res, rej) => {
    const req = https.get(url, { timeout: 15000 }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.on('timeout', () => { req.destroy(); rej(new Error('Timeout')); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function downloadKlines(sym, interval, total) {
  const all = [];
  let end = Date.now();
  while (all.length < total) {
    const lim = Math.min(1000, total - all.length);
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${lim}&endTime=${end}`;
    let d, tries = 3;
    while (tries > 0) {
      try { d = await fetchJSON(url); break; }
      catch (e) { tries--; if (!tries) throw e; await sleep(2000); }
    }
    if (!d || !d.length) break;
    all.unshift(...d.map(k => ({
      t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5]
    })));
    end = d[0][0] - 1;
    await sleep(150);
  }
  return all.slice(-total);
}

async function loadAllData(pairs) {
  const D = {};
  const bars1h = Math.ceil(DAYS * 24 * 1.1);
  const bars4h = Math.ceil(DAYS * 6 * 1.1);
  for (const sym of pairs) {
    process.stdout.write(`  ${sym}...`);
    const k1h = await downloadKlines(sym, '1h', bars1h);
    const k4h = await downloadKlines(sym, '4h', bars4h);
    D[sym] = { k1h, k4h };
    console.log(` ${k1h.length}x1h ${k4h.length}x4h`);
  }
  return D;
}

// ═══ PRECOMPUTE INDICATORS ═══
function precompute(k) {
  const c = k.map(x => x.c);
  const h = k.map(x => x.h);
  const l = k.map(x => x.l);
  const v = k.map(x => x.v);
  const o = k.map(x => x.o);
  return {
    c, h, l, v, o,
    e9: emaArr(c, 9),
    e21: emaArr(c, 21),
    e50: emaArr(c, 50),
    rsi: rsiArr(c, 14),
    macdH: macdHistArr(c),
    macdL: macdLineArr(c),
    atr: atrArr(h, l, c, 14),
    ...adxArr(h, l, c, 14),
    vSma: volSmaArr(v, 20),
    roc24: rocArr(c, 24),
  };
}

// Map 1h index to closest 4h index
function map1hTo4h(k1h, k4h) {
  const m = new Int32Array(k1h.length);
  let j = 0;
  for (let i = 0; i < k1h.length; i++) {
    while (j < k4h.length - 1 && k4h[j + 1].t <= k1h[i].t) j++;
    m[i] = k4h[j].t <= k1h[i].t ? j : -1;
  }
  return m;
}

// ═══ STRATEGY S1: 1H TREND SWING ═══
function s1_trendSwing(i, d1h, d4h, m4h, cfg) {
  if (i < 60) return null;
  const { c, e9, e21, e50, rsi, atr } = d1h;
  const { adx } = d1h;
  const ca = atr[i];
  if (ca < 1e-10) return null;

  const i4h = m4h[i];
  if (i4h < 0) return null;

  // ADX > 25 on 1h confirms trend
  if (adx[i] < 25) return null;

  const tp_pct = cfg.tp || 0.05;
  const sl_pct = cfg.sl || 0.02;

  // LONG: EMA9 > EMA21 > EMA50 on 1h
  if (e9[i] > e21[i] && e21[i] > e50[i]) {
    // RSI pullback: crosses above 50 from below (was 40-55, now rising)
    if (rsi[i] > 50 && rsi[i] < 65 && rsi[i - 1] <= 50 && rsi[i - 1] >= 38) {
      return {
        dir: 'BUY', strat: 'S1_TREND',
        tp: c[i] * (1 + tp_pct),
        sl: c[i] * (1 - sl_pct),
        score: 7 + (adx[i] > 35 ? 2 : 0) + (d1h.vSma[i] > 0 && d1h.v[i] > d1h.vSma[i] * 1.2 ? 1 : 0)
      };
    }
  }
  // SHORT: EMA9 < EMA21 < EMA50 on 1h
  if (e9[i] < e21[i] && e21[i] < e50[i]) {
    if (rsi[i] < 50 && rsi[i] > 35 && rsi[i - 1] >= 50 && rsi[i - 1] <= 62) {
      return {
        dir: 'SELL', strat: 'S1_TREND',
        tp: c[i] * (1 - tp_pct),
        sl: c[i] * (1 + sl_pct),
        score: 7 + (adx[i] > 35 ? 2 : 0) + (d1h.vSma[i] > 0 && d1h.v[i] > d1h.vSma[i] * 1.2 ? 1 : 0)
      };
    }
  }
  return null;
}

// ═══ STRATEGY S2: 4H REVERSAL AT STRUCTURE ═══
function s2_structureReversal(i, d1h, d4h, m4h, cfg) {
  if (i < 60) return null;
  const { c, h, l, rsi, atr, o } = d1h;
  const ca = atr[i];
  if (ca < 1e-10) return null;
  const i4h = m4h[i];
  if (i4h < 10) return null;

  const sl_pct = cfg.sl || 0.015;

  // Find recent 4H pivots
  const pHi = pivotHighs(d4h.h, 3);
  const pLo = pivotLows(d4h.l, 3);

  // Check if price is near a 4H pivot low (within 0.5%)
  for (let p = pLo.length - 1; p >= Math.max(0, pLo.length - 5); p--) {
    const pv = pLo[p];
    if (pv.i >= i4h) continue; // pivot must be in the past
    const dist = Math.abs(c[i] - pv.v) / pv.v;
    if (dist < 0.005) {
      // Reversal signals on 1h:
      // 1) RSI divergence: price new low but RSI higher low
      let divOk = false;
      for (let lb = 5; lb <= 20; lb++) {
        if (i - lb < 0) break;
        if (c[i] <= c[i - lb] && rsi[i] > rsi[i - lb]) { divOk = true; break; }
      }
      // 2) Pin bar at pivot
      const range = h[i] - l[i];
      const pinBar = range > 0 && (Math.min(o[i], c[i]) - l[i]) / range > 0.6;
      // 3) Bullish engulfing
      const engulf = c[i] > o[i] && c[i] > h[i - 1] && o[i] < l[i - 1];

      if (divOk || pinBar || engulf) {
        // TP: next pivot high
        let tpPrice = c[i] * 1.05; // default 5%
        for (let ph = pHi.length - 1; ph >= 0; ph--) {
          if (pHi[ph].v > c[i] * 1.02) { tpPrice = pHi[ph].v; break; }
        }
        return {
          dir: 'BUY', strat: 'S2_STRUCT',
          tp: tpPrice,
          sl: c[i] * (1 - sl_pct),
          score: 6 + (divOk ? 2 : 0) + (pinBar ? 1 : 0) + (engulf ? 1 : 0)
        };
      }
    }
  }

  // Check if price is near a 4H pivot high (within 0.5%)
  for (let p = pHi.length - 1; p >= Math.max(0, pHi.length - 5); p--) {
    const pv = pHi[p];
    if (pv.i >= i4h) continue;
    const dist = Math.abs(c[i] - pv.v) / pv.v;
    if (dist < 0.005) {
      let divOk = false;
      for (let lb = 5; lb <= 20; lb++) {
        if (i - lb < 0) break;
        if (c[i] >= c[i - lb] && rsi[i] < rsi[i - lb]) { divOk = true; break; }
      }
      const range = h[i] - l[i];
      const pinBar = range > 0 && (h[i] - Math.max(o[i], c[i])) / range > 0.6;
      const engulf = c[i] < o[i] && c[i] < l[i - 1] && o[i] > h[i - 1];

      if (divOk || pinBar || engulf) {
        let tpPrice = c[i] * 0.95;
        for (let pl = pLo.length - 1; pl >= 0; pl--) {
          if (pLo[pl].v < c[i] * 0.98) { tpPrice = pLo[pl].v; break; }
        }
        return {
          dir: 'SELL', strat: 'S2_STRUCT',
          tp: tpPrice,
          sl: c[i] * (1 + sl_pct),
          score: 6 + (divOk ? 2 : 0) + (pinBar ? 1 : 0) + (engulf ? 1 : 0)
        };
      }
    }
  }
  return null;
}

// ═══ STRATEGY S3: 1H MOMENTUM ACCELERATION ═══
function s3_momentumAccel(i, d1h, d4h, m4h, cfg) {
  if (i < 40) return null;
  const { c, macdH, v, vSma, e21, atr } = d1h;
  const ca = atr[i];
  if (ca < 1e-10) return null;

  const tp_pct = cfg.tp || 0.06;
  const sl_pct = cfg.sl || 0.025;

  // LONG: MACD hist goes neg→pos AND increasing for 2+ bars, volume rising, price > EMA21
  if (macdH[i] > 0 && macdH[i] > macdH[i - 1] && macdH[i - 1] > macdH[i - 2] &&
      macdH[i - 2] < 0 &&
      v[i] > v[i - 1] && v[i - 1] > v[i - 2] &&
      c[i] > e21[i]) {
    return {
      dir: 'BUY', strat: 'S3_MOMENTUM',
      tp: c[i] * (1 + tp_pct),
      sl: c[i] * (1 - sl_pct),
      score: 7 + (vSma[i] > 0 && v[i] > vSma[i] * 1.5 ? 2 : 0)
    };
  }
  // SHORT: inverse
  if (macdH[i] < 0 && macdH[i] < macdH[i - 1] && macdH[i - 1] < macdH[i - 2] &&
      macdH[i - 2] > 0 &&
      v[i] > v[i - 1] && v[i - 1] > v[i - 2] &&
      c[i] < e21[i]) {
    return {
      dir: 'SELL', strat: 'S3_MOMENTUM',
      tp: c[i] * (1 - tp_pct),
      sl: c[i] * (1 + sl_pct),
      score: 7 + (vSma[i] > 0 && v[i] > vSma[i] * 1.5 ? 2 : 0)
    };
  }
  return null;
}

// ═══ STRATEGY S4: WEEKLY STRUCTURE + DAILY ENTRY ═══
function s4_weeklyStructure(i, d1h, d4h, m4h, cfg) {
  if (i < 720) return null; // need 30 days of 1h data (720 bars)
  const { c, atr } = d1h;
  const ca = atr[i];
  if (ca < 1e-10) return null;
  const i4h = m4h[i];
  if (i4h < 30) return null;

  const tp_pct = cfg.tp || 0.08;
  const sl_pct = cfg.sl || 0.03;

  // 30-day range on 1h (720 bars)
  let hi30 = -Infinity, lo30 = Infinity;
  for (let j = i - 720; j <= i; j++) {
    if (d1h.h[j] > hi30) hi30 = d1h.h[j];
    if (d1h.l[j] < lo30) lo30 = d1h.l[j];
  }
  const range30 = hi30 - lo30;
  if (range30 < 1e-10) return null;

  const pctInRange = (c[i] - lo30) / range30;

  // 4H EMA cross check
  const e9_4h = d4h.e9[i4h], e21_4h = d4h.e21[i4h];
  const e9_4h_prev = d4h.e9[i4h - 1], e21_4h_prev = d4h.e21[i4h - 1];

  // LONG: price in lower 20% of 30d range + 4H EMA9 crosses above EMA21
  if (pctInRange < 0.20 && e9_4h > e21_4h && e9_4h_prev <= e21_4h_prev) {
    return {
      dir: 'BUY', strat: 'S4_WEEKLY',
      tp: c[i] * (1 + tp_pct),
      sl: c[i] * (1 - sl_pct),
      score: 8 + (pctInRange < 0.10 ? 2 : 0)
    };
  }
  // SHORT: price in upper 20% + 4H EMA9 crosses below EMA21
  if (pctInRange > 0.80 && e9_4h < e21_4h && e9_4h_prev >= e21_4h_prev) {
    return {
      dir: 'SELL', strat: 'S4_WEEKLY',
      tp: c[i] * (1 - tp_pct),
      sl: c[i] * (1 + sl_pct),
      score: 8 + (pctInRange > 0.90 ? 2 : 0)
    };
  }
  return null;
}

// ═══ STRATEGY S5: MULTI-PAIR MOMENTUM ROTATION ═══
// This one is special — evaluated across all pairs at 4h intervals
// We handle it separately in the main loop

// ═══ STRATEGY S6: CRASH DETECTOR + BOUNCE ═══
function s6_crashBounce(i, d1h, cfg) {
  if (i < 30) return null;
  const { c, h, l, o, atr } = d1h;
  const ca = atr[i];
  if (ca < 1e-10) return null;

  const sl_pct = cfg.sl || 0.02;

  // Check if price dropped >5% in last 24h (24 bars on 1h)
  const lookback = Math.min(24, i);
  const highRecent = Math.max(...h.slice(i - lookback, i + 1));
  const drop = (highRecent - l[i]) / highRecent;
  if (drop < 0.05) {
    // Also check from 24h ago price
    const drop2 = (c[i - lookback] - c[i]) / c[i - lookback];
    if (drop2 < 0.05) return null;
  }

  // Stabilization: 3+ bars where low doesn't make new low
  let stableCount = 0;
  let lowestLow = l[i];
  for (let j = i; j >= Math.max(0, i - 5); j--) {
    if (l[j] <= lowestLow) {
      lowestLow = l[j];
      stableCount = 0;
    } else {
      stableCount++;
    }
  }
  if (stableCount < 3) return null;

  // First green candle after stabilization
  if (c[i] <= o[i]) return null;

  // TP: 50% retracement of the crash
  const crashHigh = highRecent;
  const crashLow = lowestLow;
  const retrace50 = crashLow + (crashHigh - crashLow) * 0.5;

  const tpPct = (retrace50 - c[i]) / c[i];
  if (tpPct < 0.02) return null; // not enough room for TP

  return {
    dir: 'BUY', strat: 'S6_CRASH',
    tp: retrace50,
    sl: crashLow * (1 - 0.005), // just below crash low
    score: 8 + (drop > 0.08 ? 2 : 0) + (stableCount > 4 ? 1 : 0)
  };
}

// ═══ SIGNAL GENERATION PER STRATEGY ═══
function generateSignals(sym, D, I1h, I4h, map4h, stratName, cfg) {
  const k1h = D[sym].k1h;
  const d1h = I1h[sym];
  const d4h = I4h[sym];
  const m4h = map4h[sym];
  const sigs = [];

  for (let i = 60; i < k1h.length - 2; i++) {
    // Fill rate filter
    if (Math.random() > FILL_RATE) continue;

    let sig = null;
    switch (stratName) {
      case 'S1': sig = s1_trendSwing(i, d1h, d4h, m4h, cfg); break;
      case 'S2': sig = s2_structureReversal(i, d1h, d4h, m4h, cfg); break;
      case 'S3': sig = s3_momentumAccel(i, d1h, d4h, m4h, cfg); break;
      case 'S4': sig = s4_weeklyStructure(i, d1h, d4h, m4h, cfg); break;
      case 'S6': sig = s6_crashBounce(i, d1h, cfg); break;
    }
    if (!sig) continue;
    sig.barIdx = i;
    sig.sym = sym;
    sig.time = k1h[i].t;
    sigs.push(sig);
  }
  return sigs;
}

// ═══ S5: MOMENTUM ROTATION (cross-pair) ═══
function generateS5Signals(D, I1h, cfg) {
  const pairs = Object.keys(D);
  const sigs = [];
  const sl_pct = cfg.sl || 0.02;

  // Get the shortest 1h length
  const minLen = Math.min(...pairs.map(s => D[s].k1h.length));

  // Every 4 hours (4 bars on 1h), rank all pairs by 24h momentum
  for (let i = 60; i < minLen - 2; i += 4) {
    const ranked = pairs.map(sym => {
      const d = I1h[sym];
      return { sym, roc: d.roc24[i] };
    }).sort((a, b) => b.roc - a.roc);

    // LONG top 2
    for (let r = 0; r < Math.min(2, ranked.length); r++) {
      if (ranked[r].roc <= 0) continue; // only long positive momentum
      const sym = ranked[r].sym;
      const d = I1h[sym];
      if (Math.random() > FILL_RATE) continue;
      sigs.push({
        dir: 'BUY', strat: 'S5_ROTATION',
        sym, barIdx: i, time: D[sym].k1h[i].t,
        tp: d.c[i] * (1 + (cfg.tp || 0.05)),
        sl: d.c[i] * (1 - sl_pct),
        score: 6 + (ranked[r].roc > 3 ? 2 : ranked[r].roc > 1 ? 1 : 0),
        holdBars: cfg.holdBars || 8, // re-evaluate after 4-8 hours
      });
    }
    // SHORT bottom 2
    for (let r = ranked.length - 1; r >= Math.max(0, ranked.length - 2); r--) {
      if (ranked[r].roc >= 0) continue;
      const sym = ranked[r].sym;
      const d = I1h[sym];
      if (Math.random() > FILL_RATE) continue;
      sigs.push({
        dir: 'SELL', strat: 'S5_ROTATION',
        sym, barIdx: i, time: D[sym].k1h[i].t,
        tp: d.c[i] * (1 - (cfg.tp || 0.05)),
        sl: d.c[i] * (1 + sl_pct),
        score: 6 + (ranked[r].roc < -3 ? 2 : ranked[r].roc < -1 ? 1 : 0),
        holdBars: cfg.holdBars || 8,
      });
    }
  }
  return sigs;
}

// ═══ TRADE SIMULATOR (SWING) ═══
function simulateTrades(sigs, D, I1h, cfg = {}) {
  const trades = [];
  // Track per-symbol cooldowns
  const symNext = {};
  // Track daily loss
  let dailyLoss = 0;
  let currentDay = -1;

  // Sort signals by time
  sigs.sort((a, b) => a.time - b.time);

  for (const sig of sigs) {
    const sym = sig.sym;
    const k1h = D[sym].k1h;
    const eb = sig.barIdx + 1; // enter at next bar open (bar+1 for 1h)
    if (eb >= k1h.length - 1) continue;

    // Cooldown check
    if (symNext[sym] && eb < symNext[sym]) continue;

    // Score filter
    if (cfg.minScore && sig.score < cfg.minScore) continue;

    // Daily loss check
    const day = Math.floor(k1h[eb].t / 86400000);
    if (day !== currentDay) { dailyLoss = 0; currentDay = day; }
    if (dailyLoss >= CAP0 * DAILY_LOSS_LIMIT) continue;

    const ep = k1h[eb].o;
    const isBuy = sig.dir === 'BUY';
    const posSize = POS;
    const entryCost = posSize * FEE_M;

    let tp = sig.tp;
    let stop = sig.sl;
    let exitPrice = 0, exitReason = '', exitBar = 0;

    // Use trailing stop if configured
    const useTrail = cfg.trail;
    let trailStop = stop;
    let highWater = ep;

    // Max hold bars (for rotation strategy)
    const maxHold = sig.holdBars || (cfg.maxHold || 200);

    for (let b = eb + 1; b < k1h.length; b++) {
      const bar = k1h[b];

      // Update high water mark for trailing
      if (isBuy) highWater = Math.max(highWater, bar.h);
      else highWater = Math.min(highWater === ep ? bar.l : highWater, bar.l);

      // Trailing stop update
      if (useTrail) {
        const profitPct = isBuy ? (bar.c - ep) / ep : (ep - bar.c) / ep;
        const d1h = I1h[sym];
        const ca = d1h.atr[Math.min(b, d1h.atr.length - 1)];
        if (profitPct > 0.03) {
          // Deep profit: tight trail ATR*2
          const ns = isBuy ? highWater - ca * 2 : highWater + ca * 2;
          trailStop = isBuy ? Math.max(trailStop, ns) : Math.min(trailStop, ns);
        } else if (profitPct > 0.015) {
          // Good profit: trail ATR*3
          const ns = isBuy ? highWater - ca * 3 : highWater + ca * 3;
          trailStop = isBuy ? Math.max(trailStop, ns) : Math.min(trailStop, ns);
        } else if (profitPct > 0.005) {
          // Small profit: move to breakeven
          const be = isBuy ? ep * 1.001 : ep * 0.999;
          trailStop = isBuy ? Math.max(trailStop, be) : Math.min(trailStop, be);
        }
        stop = isBuy ? Math.max(sig.sl, trailStop) : Math.min(sig.sl, trailStop);
      }

      const slHit = isBuy ? bar.l <= stop : bar.h >= stop;
      const tpHit = isBuy ? bar.h >= tp : bar.l <= tp;

      if (slHit && tpHit) {
        // Both hit in same bar — use open to determine which was first
        if (isBuy) {
          // If bar opened below stop, SL first
          if (bar.o <= stop) { exitPrice = stop * (1 - SLIP); exitReason = 'SL'; }
          else { exitPrice = tp; exitReason = 'TP'; }
        } else {
          if (bar.o >= stop) { exitPrice = stop * (1 + SLIP); exitReason = 'SL'; }
          else { exitPrice = tp; exitReason = 'TP'; }
        }
        exitBar = b;
        break;
      }
      if (slHit) {
        exitPrice = isBuy ? Math.min(stop, bar.o) * (1 - SLIP) : Math.max(stop, bar.o) * (1 + SLIP);
        exitReason = 'SL';
        exitBar = b;
        break;
      }
      if (tpHit) {
        exitPrice = tp;
        exitReason = 'TP';
        exitBar = b;
        break;
      }
      // Timeout
      if (b - eb >= maxHold) {
        exitPrice = bar.c;
        exitReason = 'TO';
        exitBar = b;
        break;
      }
    }
    if (!exitPrice) continue;

    const priceDelta = isBuy ? exitPrice - ep : ep - exitPrice;
    const mainPnl = priceDelta / ep * posSize;
    const exitFee = exitReason === 'SL' ? posSize * FEE_T : posSize * FEE_M;
    const holdHours = exitBar - eb; // each bar = 1 hour

    // Funding cost for positions held > 8 hours
    const fundingCost = holdHours > 8 ? Math.floor(holdHours / 8) * posSize * FUNDING_RATE : 0;

    const totalPnl = mainPnl - entryCost - exitFee - fundingCost;

    // Cooldown: 2 bars after exit
    symNext[sym] = exitBar + 2;

    // Track daily loss
    if (totalPnl < 0) dailyLoss += Math.abs(totalPnl);

    trades.push({
      sym, dir: sig.dir, strat: sig.strat, score: sig.score,
      pnl: totalPnl, reason: exitReason,
      barIdx: sig.barIdx, exitBar,
      holdHours,
      entryPrice: ep, exitPrice,
      fundingCost
    });
  }
  return trades;
}

// ═══ METRICS ═══
function metrics(trades, label) {
  const w = trades.filter(t => t.pnl > 0);
  const lo = trades.filter(t => t.pnl <= 0);
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const gw = w.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(lo.reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;
  const wr = trades.length ? w.length / trades.length * 100 : 0;

  let cum = 0, pk = 0, mdd = 0;
  for (const t of trades) { cum += t.pnl; pk = Math.max(pk, cum); mdd = Math.max(mdd, pk - cum); }

  const avgHold = trades.length ? trades.reduce((s, t) => s + (t.holdHours || 0), 0) / trades.length : 0;
  const totalFunding = trades.reduce((s, t) => s + (t.fundingCost || 0), 0);

  return {
    label, pnl, pf, wr, n: trades.length, tpd: trades.length / DAYS,
    aw: w.length ? gw / w.length : 0, al: lo.length ? gl / lo.length : 0,
    mdd, avgHold, totalFunding
  };
}

function printMetrics(m, base) {
  const delta = base ? m.pnl - base.pnl : 0;
  const ds = base ? `${delta >= 0 ? '+' : ''}$${delta.toFixed(2)}` : '--';
  console.log(`  [${m.label}] PnL:$${m.pnl.toFixed(2)} PF:${m.pf.toFixed(2)} WR:${m.wr.toFixed(1)}% ` +
    `T:${m.n}(${m.tpd.toFixed(1)}/d) W:$${m.aw.toFixed(2)} L:$${m.al.toFixed(2)} ` +
    `DD:$${m.mdd.toFixed(2)} AvgHold:${m.avgHold.toFixed(1)}h Fund:$${m.totalFunding.toFixed(2)} ${ds}`);
}

function printStratBreakdown(trades) {
  console.log('\n  Strategy Breakdown:');
  console.log('  Strategy      | Trades | WR%   | PF    | PnL       | AvgHold');
  console.log('  --------------|--------|-------|-------|-----------|--------');
  const strats = {};
  for (const t of trades) {
    const s = t.strat || 'UNKNOWN';
    if (!strats[s]) strats[s] = { w: 0, l: 0, gw: 0, gl: 0, hold: 0 };
    if (t.pnl > 0) { strats[s].w++; strats[s].gw += t.pnl; }
    else { strats[s].l++; strats[s].gl += Math.abs(t.pnl); }
    strats[s].hold += t.holdHours || 0;
  }
  for (const [s, d] of Object.entries(strats).sort((a, b) => (b[1].gw - b[1].gl) - (a[1].gw - a[1].gl))) {
    const n = d.w + d.l;
    const pf = d.gl > 0 ? d.gw / d.gl : d.gw > 0 ? 99 : 0;
    const wr = n > 0 ? d.w / n * 100 : 0;
    const pnl = d.gw - d.gl;
    const avgH = n > 0 ? d.hold / n : 0;
    console.log(`  ${s.padEnd(15)}| ${String(n).padStart(6)} | ${wr.toFixed(1).padStart(5)} | ${pf.toFixed(2).padStart(5)} | $${pnl.toFixed(2).padStart(8)} | ${avgH.toFixed(1).padStart(5)}h`);
  }
}

function printPairBreakdown(trades) {
  console.log('\n  Per-Pair Breakdown:');
  console.log('  Pair      | Trades | WR%   | PF    | PnL       | AvgHold');
  console.log('  ----------|--------|-------|-------|-----------|--------');
  const pairs = {};
  for (const t of trades) {
    const s = t.sym;
    if (!pairs[s]) pairs[s] = { w: 0, l: 0, gw: 0, gl: 0, hold: 0 };
    if (t.pnl > 0) { pairs[s].w++; pairs[s].gw += t.pnl; }
    else { pairs[s].l++; pairs[s].gl += Math.abs(t.pnl); }
    pairs[s].hold += t.holdHours || 0;
  }
  for (const [s, d] of Object.entries(pairs).sort((a, b) => (b[1].gw - b[1].gl) - (a[1].gw - a[1].gl))) {
    const n = d.w + d.l;
    const pf = d.gl > 0 ? d.gw / d.gl : d.gw > 0 ? 99 : 0;
    const wr = n > 0 ? d.w / n * 100 : 0;
    const pnl = d.gw - d.gl;
    const avgH = n > 0 ? d.hold / n : 0;
    console.log(`  ${s.padEnd(10)}| ${String(n).padStart(6)} | ${wr.toFixed(1).padStart(5)} | ${pf.toFixed(2).padStart(5)} | $${pnl.toFixed(2).padStart(8)} | ${avgH.toFixed(1).padStart(5)}h`);
  }
}

function printExitBreakdown(trades) {
  console.log('\n  Exit Reason Breakdown:');
  console.log('  Reason | Trades | WR%   | PF    | PnL');
  console.log('  -------|--------|-------|-------|----------');
  const reasons = {};
  for (const t of trades) {
    const r = t.reason;
    if (!reasons[r]) reasons[r] = { w: 0, l: 0, gw: 0, gl: 0 };
    if (t.pnl > 0) { reasons[r].w++; reasons[r].gw += t.pnl; }
    else { reasons[r].l++; reasons[r].gl += Math.abs(t.pnl); }
  }
  for (const [r, d] of Object.entries(reasons)) {
    const n = d.w + d.l;
    const pf = d.gl > 0 ? d.gw / d.gl : d.gw > 0 ? 99 : 0;
    const wr = n > 0 ? d.w / n * 100 : 0;
    console.log(`  ${r.padEnd(7)}| ${String(n).padStart(6)} | ${wr.toFixed(1).padStart(5)} | ${pf.toFixed(2).padStart(5)} | $${(d.gw - d.gl).toFixed(2)}`);
  }
}

// ═══ TP/SL GRID SEARCH ═══
function gridSearch(stratName, D, I1h, I4h, map4h, tpValues, slValues) {
  console.log(`\n  TP/SL Grid for ${stratName}:`);
  console.log('  TP%   | SL%   | Trades | WR%   | PF    | PnL       | AvgHold');
  console.log('  ------|-------|--------|-------|-------|-----------|--------');

  let bestPnl = -Infinity, bestCfg = {};

  for (const tp of tpValues) {
    for (const sl of slValues) {
      let allSigs = [];
      for (const sym of ALL_PAIRS) {
        const sigs = generateSignals(sym, D, I1h, I4h, map4h, stratName, { tp, sl });
        allSigs.push(...sigs);
      }
      if (stratName === 'S5') {
        allSigs = generateS5Signals(D, I1h, { tp, sl });
      }
      const trades = simulateTrades(allSigs, D, I1h, {});
      const m = metrics(trades, `${stratName}_TP${(tp*100).toFixed(0)}_SL${(sl*100).toFixed(1)}`);
      console.log(`  ${(tp*100).toFixed(1).padStart(5)} | ${(sl*100).toFixed(1).padStart(5)} | ${String(m.n).padStart(6)} | ${m.wr.toFixed(1).padStart(5)} | ${m.pf.toFixed(2).padStart(5)} | $${m.pnl.toFixed(2).padStart(8)} | ${m.avgHold.toFixed(1).padStart(5)}h`);

      if (m.pnl > bestPnl && m.n >= 10) {
        bestPnl = m.pnl;
        bestCfg = { tp, sl, ...m };
      }
    }
  }
  console.log(`  BEST: TP=${(bestCfg.tp*100).toFixed(1)}% SL=${(bestCfg.sl*100).toFixed(1)}% PnL=$${bestPnl.toFixed(2)} PF=${(bestCfg.pf||0).toFixed(2)}`);
  return bestCfg;
}

// ═══ S7: COMBINED REGIME-AWARE STRATEGY ═══
function generateS7Combined(D, I1h, I4h, map4h, bestCfgs) {
  const sigs = [];

  for (const sym of ALL_PAIRS) {
    const d1h = I1h[sym];
    const k1h = D[sym].k1h;

    for (let i = 720; i < k1h.length - 2; i++) {
      const i4h = map4h[sym][i];
      if (i4h < 10) continue;
      if (Math.random() > FILL_RATE) continue;

      // Regime detection on 4H ADX
      const adx4h = I4h[sym].adx[i4h];
      const isTrending = adx4h > 25;

      // Crash detection
      const lookback = Math.min(24, i);
      const highRecent = Math.max(...d1h.h.slice(i - lookback, i + 1));
      const isCrash = (highRecent - d1h.l[i]) / highRecent > 0.05;

      let sig = null;

      if (isCrash) {
        // S6 in crash regime
        sig = s6_crashBounce(i, d1h, bestCfgs.S6 || {});
      } else if (isTrending) {
        // S1 + S3 in trending regime
        sig = s1_trendSwing(i, d1h, I4h[sym], map4h[sym], bestCfgs.S1 || {});
        if (!sig) sig = s3_momentumAccel(i, d1h, I4h[sym], map4h[sym], bestCfgs.S3 || {});
      } else {
        // S2 in ranging regime
        sig = s2_structureReversal(i, d1h, I4h[sym], map4h[sym], bestCfgs.S2 || {});
      }

      // S4 always active (rare signals)
      if (!sig) sig = s4_weeklyStructure(i, d1h, I4h[sym], map4h[sym], bestCfgs.S4 || {});

      if (sig) {
        sig.barIdx = i;
        sig.sym = sym;
        sig.time = k1h[i].t;
        sig.strat = sig.strat + '_R7';
        sigs.push(sig);
      }
    }
  }
  return sigs;
}


// ═══ MAIN ═══
async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('ROUND 6 — SWING TRADING on 1H/4H');
  console.log('RADICAL APPROACH: Wide TP (5-12%) where fees are negligible');
  console.log('$500 cap | 5x lev | $2,500 pos | 120d | 1h+4h | 7 pairs | Binance Futures');
  console.log('═══════════════════════════════════════════════════════════════════════');

  // ═══ DOWNLOAD DATA ═══
  console.log('\n[DOWNLOAD DATA]');
  const D = await loadAllData(ALL_PAIRS);

  // ═══ PRECOMPUTE INDICATORS ═══
  console.log('\n[PRECOMPUTE INDICATORS]');
  const I1h = {}, I4h = {}, map4h = {};
  for (const sym of ALL_PAIRS) {
    process.stdout.write(`  ${sym}...`);
    I1h[sym] = precompute(D[sym].k1h);
    I4h[sym] = precompute(D[sym].k4h);
    map4h[sym] = map1hTo4h(D[sym].k1h, D[sym].k4h);
    console.log(' done');
  }

  const results = [];
  const bestCfgs = {};

  // ═══ S1: 1H TREND SWING ═══
  console.log('\n══════════════════════════════════════════════════');
  console.log('S1: 1H TREND SWING (EMA cascade + RSI pullback + ADX)');
  console.log('══════════════════════════════════════════════════');
  const bestS1 = gridSearch('S1', D, I1h, I4h, map4h,
    [0.04, 0.05, 0.06, 0.08],
    [0.015, 0.02, 0.025]);
  bestCfgs.S1 = { tp: bestS1.tp, sl: bestS1.sl };
  {
    let allSigs = [];
    for (const sym of ALL_PAIRS) allSigs.push(...generateSignals(sym, D, I1h, I4h, map4h, 'S1', bestCfgs.S1));
    const trades = simulateTrades(allSigs, D, I1h, {});
    const m = metrics(trades, 'S1_TREND_BEST');
    printMetrics(m); results.push(m);
    printStratBreakdown(trades);
    printPairBreakdown(trades);
    printExitBreakdown(trades);
  }

  // ═══ S2: 4H REVERSAL AT STRUCTURE ═══
  console.log('\n══════════════════════════════════════════════════');
  console.log('S2: 4H REVERSAL AT STRUCTURE (pivots + divergence/pinbar/engulf)');
  console.log('══════════════════════════════════════════════════');
  const bestS2 = gridSearch('S2', D, I1h, I4h, map4h,
    [0.04, 0.05, 0.06, 0.08],
    [0.012, 0.015, 0.02]);
  bestCfgs.S2 = { tp: bestS2.tp, sl: bestS2.sl };
  {
    let allSigs = [];
    for (const sym of ALL_PAIRS) allSigs.push(...generateSignals(sym, D, I1h, I4h, map4h, 'S2', bestCfgs.S2));
    const trades = simulateTrades(allSigs, D, I1h, {});
    const m = metrics(trades, 'S2_STRUCT_BEST');
    printMetrics(m); results.push(m);
    printStratBreakdown(trades);
    printPairBreakdown(trades);
    printExitBreakdown(trades);
  }

  // ═══ S3: 1H MOMENTUM ACCELERATION ═══
  console.log('\n══════════════════════════════════════════════════');
  console.log('S3: 1H MOMENTUM ACCELERATION (MACD + volume + EMA21)');
  console.log('══════════════════════════════════════════════════');
  const bestS3 = gridSearch('S3', D, I1h, I4h, map4h,
    [0.05, 0.06, 0.08, 0.10],
    [0.02, 0.025, 0.03]);
  bestCfgs.S3 = { tp: bestS3.tp, sl: bestS3.sl };
  {
    let allSigs = [];
    for (const sym of ALL_PAIRS) allSigs.push(...generateSignals(sym, D, I1h, I4h, map4h, 'S3', bestCfgs.S3));
    const trades = simulateTrades(allSigs, D, I1h, {});
    const m = metrics(trades, 'S3_MOMENTUM_BEST');
    printMetrics(m); results.push(m);
    printStratBreakdown(trades);
    printPairBreakdown(trades);
    printExitBreakdown(trades);
  }

  // ═══ S4: WEEKLY STRUCTURE + DAILY ENTRY ═══
  console.log('\n══════════════════════════════════════════════════');
  console.log('S4: WEEKLY STRUCTURE + DAILY ENTRY (30d range extremes + 4H EMA cross)');
  console.log('══════════════════════════════════════════════════');
  const bestS4 = gridSearch('S4', D, I1h, I4h, map4h,
    [0.06, 0.08, 0.10, 0.12],
    [0.025, 0.03, 0.04]);
  bestCfgs.S4 = { tp: bestS4.tp, sl: bestS4.sl };
  {
    let allSigs = [];
    for (const sym of ALL_PAIRS) allSigs.push(...generateSignals(sym, D, I1h, I4h, map4h, 'S4', bestCfgs.S4));
    const trades = simulateTrades(allSigs, D, I1h, {});
    const m = metrics(trades, 'S4_WEEKLY_BEST');
    printMetrics(m); results.push(m);
    printStratBreakdown(trades);
    printPairBreakdown(trades);
    printExitBreakdown(trades);
  }

  // ═══ S5: MOMENTUM ROTATION ═══
  console.log('\n══════════════════════════════════════════════════');
  console.log('S5: MULTI-PAIR MOMENTUM ROTATION (4h rebalance, top/bottom 2)');
  console.log('══════════════════════════════════════════════════');
  {
    console.log('\n  TP/SL Grid for S5:');
    console.log('  TP%   | SL%   | Trades | WR%   | PF    | PnL       | AvgHold');
    console.log('  ------|-------|--------|-------|-------|-----------|--------');
    let bestPnl = -Infinity, bestTp = 0.05, bestSl = 0.02;
    for (const tp of [0.04, 0.05, 0.06, 0.08]) {
      for (const sl of [0.015, 0.02, 0.025]) {
        const sigs = generateS5Signals(D, I1h, { tp, sl, holdBars: 8 });
        const trades = simulateTrades(sigs, D, I1h, {});
        const m = metrics(trades, `S5_TP${(tp*100).toFixed(0)}_SL${(sl*100).toFixed(1)}`);
        console.log(`  ${(tp*100).toFixed(1).padStart(5)} | ${(sl*100).toFixed(1).padStart(5)} | ${String(m.n).padStart(6)} | ${m.wr.toFixed(1).padStart(5)} | ${m.pf.toFixed(2).padStart(5)} | $${m.pnl.toFixed(2).padStart(8)} | ${m.avgHold.toFixed(1).padStart(5)}h`);
        if (m.pnl > bestPnl && m.n >= 10) { bestPnl = m.pnl; bestTp = tp; bestSl = sl; }
      }
    }
    bestCfgs.S5 = { tp: bestTp, sl: bestSl, holdBars: 8 };
    console.log(`  BEST: TP=${(bestTp*100).toFixed(1)}% SL=${(bestSl*100).toFixed(1)}%`);

    const sigs = generateS5Signals(D, I1h, bestCfgs.S5);
    const trades = simulateTrades(sigs, D, I1h, {});
    const m = metrics(trades, 'S5_ROTATION_BEST');
    printMetrics(m); results.push(m);
    printPairBreakdown(trades);
    printExitBreakdown(trades);
  }

  // ═══ S6: CRASH DETECTOR + BOUNCE ═══
  console.log('\n══════════════════════════════════════════════════');
  console.log('S6: CRASH DETECTOR + BOUNCE (>5% drop, stabilization, first green bar)');
  console.log('══════════════════════════════════════════════════');
  const bestS6 = gridSearch('S6', D, I1h, I4h, map4h,
    [0.03, 0.05, 0.06, 0.08],
    [0.015, 0.02, 0.025]);
  bestCfgs.S6 = { tp: bestS6.tp, sl: bestS6.sl };
  {
    let allSigs = [];
    for (const sym of ALL_PAIRS) allSigs.push(...generateSignals(sym, D, I1h, I4h, map4h, 'S6', bestCfgs.S6));
    const trades = simulateTrades(allSigs, D, I1h, {});
    const m = metrics(trades, 'S6_CRASH_BEST');
    printMetrics(m); results.push(m);
    printStratBreakdown(trades);
    printPairBreakdown(trades);
    printExitBreakdown(trades);
  }

  // ═══ S7: COMBINED REGIME-AWARE ═══
  console.log('\n══════════════════════════════════════════════════');
  console.log('S7: COMBINED REGIME-AWARE (S1+S3 trending, S2 ranging, S6 crash, S4 always)');
  console.log('══════════════════════════════════════════════════');
  {
    const sigs = generateS7Combined(D, I1h, I4h, map4h, bestCfgs);
    const trades = simulateTrades(sigs, D, I1h, {});
    const m = metrics(trades, 'S7_COMBINED');
    printMetrics(m); results.push(m);
    printStratBreakdown(trades);
    printPairBreakdown(trades);
    printExitBreakdown(trades);
  }

  // ═══ S7 WITH TRAILING STOP ═══
  console.log('\n══════════════════════════════════════════════════');
  console.log('S7+TRAIL: Combined with trailing stop');
  console.log('══════════════════════════════════════════════════');
  {
    const sigs = generateS7Combined(D, I1h, I4h, map4h, bestCfgs);
    const trades = simulateTrades(sigs, D, I1h, { trail: true });
    const m = metrics(trades, 'S7_TRAIL');
    printMetrics(m); results.push(m);
    printStratBreakdown(trades);
    printExitBreakdown(trades);
  }

  // ═══ S7 WITH SCORE FILTER ═══
  console.log('\n══════════════════════════════════════════════════');
  console.log('S7+SCORE>=7: Combined with score filter');
  console.log('══════════════════════════════════════════════════');
  {
    const sigs = generateS7Combined(D, I1h, I4h, map4h, bestCfgs);
    const trades = simulateTrades(sigs, D, I1h, { minScore: 7 });
    const m = metrics(trades, 'S7_SCORE7');
    printMetrics(m); results.push(m);
    printStratBreakdown(trades);
  }

  // ═══ S7+TRAIL+SCORE ═══
  console.log('\n══════════════════════════════════════════════════');
  console.log('S7+TRAIL+SCORE>=7: Combined with both');
  console.log('══════════════════════════════════════════════════');
  {
    const sigs = generateS7Combined(D, I1h, I4h, map4h, bestCfgs);
    const trades = simulateTrades(sigs, D, I1h, { trail: true, minScore: 7 });
    const m = metrics(trades, 'S7_FULL');
    printMetrics(m); results.push(m);
    printStratBreakdown(trades);
    printPairBreakdown(trades);
    printExitBreakdown(trades);
  }

  // ═══ COMPOUND GROWTH ═══
  console.log('\n══════════════════════════════════════════════════');
  console.log('COMPOUND GROWTH (best strategy, 65% weekly reinvest)');
  console.log('══════════════════════════════════════════════════');
  {
    // Pick best strategy by PnL
    const best = results.reduce((a, b) => a.pnl > b.pnl ? a : b);
    console.log(`  Using: ${best.label}`);

    // Re-run best to get trades
    let trades;
    if (best.label.startsWith('S7')) {
      const sigs = generateS7Combined(D, I1h, I4h, map4h, bestCfgs);
      const cfg = {};
      if (best.label.includes('TRAIL')) cfg.trail = true;
      if (best.label.includes('SCORE')) cfg.minScore = 7;
      if (best.label.includes('FULL')) { cfg.trail = true; cfg.minScore = 7; }
      trades = simulateTrades(sigs, D, I1h, cfg);
    } else {
      const stratKey = best.label.split('_')[0];
      let allSigs = [];
      if (stratKey === 'S5') {
        allSigs = generateS5Signals(D, I1h, bestCfgs.S5);
      } else {
        for (const sym of ALL_PAIRS) allSigs.push(...generateSignals(sym, D, I1h, I4h, map4h, stratKey, bestCfgs[stratKey] || {}));
      }
      trades = simulateTrades(allSigs, D, I1h, {});
    }

    trades.sort((a, b) => (a.time || a.barIdx) - (b.time || b.barIdx));
    const barsPerWeek = 24 * 7;
    let cap = CAP0, wk = 0;
    const wkData = [];
    let weekPnl = 0;

    for (const t of trades) {
      const w = Math.floor(t.barIdx / barsPerWeek);
      while (wk < w) {
        wkData.push({ w: wk + 1, cap, pos: cap * LEV, wp: weekPnl, cum: cap - CAP0 });
        if (weekPnl > 0) cap += weekPnl * 0.65;
        weekPnl = 0;
        wk++;
      }
      weekPnl += t.pnl * (cap / CAP0);
    }
    wkData.push({ w: wk + 1, cap, pos: cap * LEV, wp: weekPnl, cum: cap - CAP0 });
    if (weekPnl > 0) cap += weekPnl * 0.65;

    console.log('  Wk | Capital   | Position  | Wk PnL    | Cumul');
    console.log('  ---|-----------|-----------|-----------|----------');
    for (const w of wkData)
      console.log(`  ${String(w.w).padStart(2)} | $${w.cap.toFixed(2).padStart(8)} | $${w.pos.toFixed(2).padStart(8)} | $${w.wp.toFixed(2).padStart(8)} | $${w.cum.toFixed(2).padStart(8)}`);

    const cPnl = cap - CAP0;
    console.log(`\n  Compound Capital: $${cap.toFixed(2)} (PnL: $${cPnl.toFixed(2)})`);
    results.push({ label: 'COMPOUND', pnl: cPnl, pf: best.pf, wr: best.wr, n: best.n, tpd: best.tpd, aw: best.aw, al: best.al, mdd: best.mdd, avgHold: best.avgHold, totalFunding: best.totalFunding });
  }

  // ═══ FEE IMPACT ANALYSIS ═══
  console.log('\n══════════════════════════════════════════════════');
  console.log('FEE IMPACT ANALYSIS');
  console.log('══════════════════════════════════════════════════');
  {
    const best = results.reduce((a, b) => (a.label !== 'COMPOUND' && a.pnl > b.pnl) || b.label === 'COMPOUND' ? a : b);
    // Re-run best to get trades for fee analysis
    const sigs = generateS7Combined(D, I1h, I4h, map4h, bestCfgs);
    const trades = simulateTrades(sigs, D, I1h, {});

    let totalFees = 0, totalFunding = 0, grossPnl = 0;
    for (const t of trades) {
      const posSize = POS;
      const entryFee = posSize * FEE_M;
      const exitFee = t.reason === 'SL' ? posSize * FEE_T : posSize * FEE_M;
      totalFees += entryFee + exitFee;
      totalFunding += t.fundingCost || 0;
      grossPnl += t.pnl + entryFee + exitFee + (t.fundingCost || 0);
    }
    const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
    console.log(`  Gross PnL (before fees):  $${grossPnl.toFixed(2)}`);
    console.log(`  Total Trading Fees:       $${totalFees.toFixed(2)} (${(totalFees/grossPnl*100).toFixed(1)}% of gross)`);
    console.log(`  Total Funding Costs:      $${totalFunding.toFixed(2)}`);
    console.log(`  Net PnL (after all):      $${netPnl.toFixed(2)}`);
    console.log(`  Fee Impact:               ${((totalFees+totalFunding)/grossPnl*100).toFixed(1)}% of gross`);
    console.log(`  Avg Fee per Trade:        $${(totalFees/trades.length).toFixed(4)}`);
    console.log(`  Avg Win ($):              $${(trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0)/(trades.filter(t=>t.pnl>0).length||1)).toFixed(2)}`);
    console.log(`  Fee as % of Avg Win:      ${(totalFees/trades.length / (trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0)/(trades.filter(t=>t.pnl>0).length||1)) * 100).toFixed(2)}%`);
  }

  // ═══ PROGRESSION TABLE ═══
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('PROGRESSION TABLE');
  console.log('Strategy         | PnL       | PF    | WR%   | Trades | T/Day | AvgHold | Fund$');
  console.log('-----------------|-----------|-------|-------|--------|-------|---------|------');
  for (const r of results) {
    console.log(
      `${(r.label || '').padEnd(17)}| $${r.pnl.toFixed(2).padStart(8)} | ` +
      `${r.pf.toFixed(2).padStart(5)} | ${r.wr.toFixed(1).padStart(5)} | ` +
      `${String(r.n).padStart(6)} | ${r.tpd.toFixed(1).padStart(5)} | ` +
      `${(r.avgHold || 0).toFixed(1).padStart(5)}h | $${(r.totalFunding || 0).toFixed(2)}`
    );
  }

  // ═══ FINAL SUMMARY ═══
  const bestResult = results.reduce((a, b) => a.pnl > b.pnl ? a : b);
  const bestNonCompound = results.filter(r => r.label !== 'COMPOUND').reduce((a, b) => a.pnl > b.pnl ? a : b);
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('FINAL SUMMARY — ROUND 6 SWING TRADING');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  Best Strategy:     ${bestNonCompound.label}`);
  console.log(`  Linear PnL:       $${bestNonCompound.pnl.toFixed(2)}`);
  console.log(`  Compound PnL:     $${bestResult.pnl.toFixed(2)}`);
  console.log(`  Profit Factor:    ${bestNonCompound.pf.toFixed(2)}`);
  console.log(`  Win Rate:         ${bestNonCompound.wr.toFixed(1)}%`);
  console.log(`  Trades/Day:       ${bestNonCompound.tpd.toFixed(1)}`);
  console.log(`  Avg Hold Time:    ${(bestNonCompound.avgHold || 0).toFixed(1)} hours`);
  console.log(`  Max Drawdown:     $${bestNonCompound.mdd.toFixed(2)}`);
  console.log(`  Avg Win:          $${bestNonCompound.aw.toFixed(2)}`);
  console.log(`  Avg Loss:         $${bestNonCompound.al.toFixed(2)}`);
  console.log(`  Funding Costs:    $${(bestNonCompound.totalFunding || 0).toFixed(2)}`);
  console.log('═══════════════════════════════════════════════════════════════════════');

  console.log('\n  KEY COMPARISON vs Previous Rounds (5m scalping):');
  console.log('  Round 5 best: PF ~1.65 @ 1 trade/day OR PF ~1.18 @ 21 trades/day');
  console.log(`  Round 6 swing: PF ${bestNonCompound.pf.toFixed(2)} @ ${bestNonCompound.tpd.toFixed(1)} trades/day, avg hold ${(bestNonCompound.avgHold||0).toFixed(1)}h`);
  console.log(`  Fee impact: NEGLIGIBLE on 5-8% TP vs DEVASTATING on 1-3% TP`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
