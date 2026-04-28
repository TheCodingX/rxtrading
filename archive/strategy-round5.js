#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY ROUND 5 — FINAL MEGA-COMBO
// Layer 1: High-PF (Vol Breakout 5m + Contrarian Div 1h + ADX Thrust 1h)
// Layer 2: Multi-TF Structure with ultra-strict quality gate
// Target: PF >= 2.0, WR >= 55%, 10+ trades/day
// ═══════════════════════════════════════════════════════════════════════════════
const https = require('https');

// ═══ CONFIG ═══
const CAP0 = 500, LEV = 5, POS = CAP0 * LEV;
const FEE_M = 0.0002, FEE_T = 0.0005, SLIP_SL = 0.0003, SLIP_TP = 0.0001;
const FILL_RATE = 0.80;
const DAYS = 120;
const MAX_POS = 3, MAX_SAME_DIR = 2;
const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT'];

// ═══ INDICATORS ═══
function emaA(d, p) {
  const k = 2 / (p + 1), r = [d[0]];
  for (let i = 1; i < d.length; i++) r.push(d[i] * k + r[i - 1] * (1 - k));
  return r;
}
function smaA(d, p) {
  const r = []; let s = 0;
  for (let i = 0; i < d.length; i++) {
    s += d[i]; if (i >= p) s -= d[i - p];
    r.push(i >= p - 1 ? s / p : s / (i + 1));
  }
  return r;
}
function rsiA(c, p = 14) {
  if (c.length < p + 1) return c.map(() => 50);
  const r = new Float64Array(c.length); let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d > 0) ag += d; else al -= d; }
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
function macdA(c, fast = 12, slow = 26, sig = 9) {
  const ef = emaA(c, fast), es = emaA(c, slow);
  const ml = ef.map((v, i) => v - es[i]);
  const sl = emaA(ml, sig);
  const hist = ml.map((v, i) => v - sl[i]);
  return { macd: ml, signal: sl, hist };
}
function bbA(c, p = 20, mult = 2) {
  const mid = smaA(c, p), upper = [], lower = [], width = [];
  for (let i = 0; i < c.length; i++) {
    if (i < p - 1) { upper.push(c[i]); lower.push(c[i]); width.push(0); continue; }
    let sum = 0;
    for (let j = i - p + 1; j <= i; j++) sum += (c[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sum / p);
    upper.push(mid[i] + mult * sd);
    lower.push(mid[i] - mult * sd);
    width.push(mid[i] > 0 ? (2 * mult * sd) / mid[i] : 0);
  }
  return { mid, upper, lower, width };
}
function stochA(h, l, c, kp = 14, dp = 3) {
  const k = new Float64Array(c.length);
  for (let i = kp - 1; i < c.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kp + 1; j <= i; j++) { hh = Math.max(hh, h[j]); ll = Math.min(ll, l[j]); }
    k[i] = hh === ll ? 50 : (c[i] - ll) / (hh - ll) * 100;
  }
  const d = smaA(Array.from(k), dp);
  return { k, d: Float64Array.from(d) };
}
function atrA(h, l, c, p = 14) {
  const r = new Float64Array(h.length), tr = new Float64Array(h.length);
  tr[0] = h[0] - l[0];
  for (let i = 1; i < h.length; i++) tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  let s = 0; for (let i = 0; i < Math.min(p, tr.length); i++) s += tr[i];
  if (p <= tr.length) r[p - 1] = s / p;
  for (let i = p; i < tr.length; i++) r[i] = (r[i - 1] * (p - 1) + tr[i]) / p;
  return r;
}
function adxA(h, l, c, p = 14) {
  const n = h.length;
  const pdi = new Float64Array(n), ndi = new Float64Array(n), adx = new Float64Array(n);
  const pdm = new Float64Array(n), ndm = new Float64Array(n), tr = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    pdm[i] = up > dn && up > 0 ? up : 0;
    ndm[i] = dn > up && dn > 0 ? dn : 0;
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  }
  let sPdm = 0, sNdm = 0, sTr = 0;
  for (let i = 1; i <= p; i++) { sPdm += pdm[i]; sNdm += ndm[i]; sTr += tr[i]; }
  if (p < n) {
    pdi[p] = sTr > 0 ? sPdm / sTr * 100 : 0;
    ndi[p] = sTr > 0 ? sNdm / sTr * 100 : 0;
  }
  for (let i = p + 1; i < n; i++) {
    sPdm = sPdm - sPdm / p + pdm[i];
    sNdm = sNdm - sNdm / p + ndm[i];
    sTr = sTr - sTr / p + tr[i];
    pdi[i] = sTr > 0 ? sPdm / sTr * 100 : 0;
    ndi[i] = sTr > 0 ? sNdm / sTr * 100 : 0;
  }
  let sDx = 0;
  for (let i = p; i < Math.min(2 * p, n); i++) {
    const sum = pdi[i] + ndi[i];
    const dx = sum > 0 ? Math.abs(pdi[i] - ndi[i]) / sum * 100 : 0;
    sDx += dx;
    if (i === 2 * p - 1) adx[i] = sDx / p;
  }
  for (let i = 2 * p; i < n; i++) {
    const sum = pdi[i] + ndi[i];
    const dx = sum > 0 ? Math.abs(pdi[i] - ndi[i]) / sum * 100 : 0;
    adx[i] = (adx[i - 1] * (p - 1) + dx) / p;
  }
  return { adx, pdi, ndi };
}
function volRatio(v, p = 20) {
  const avg = smaA(v, p);
  return v.map((val, i) => avg[i] > 0 ? val / avg[i] : 1);
}

// ═══ DATA FETCHING ═══
function fetchJ(url) {
  return new Promise((res, rej) => {
    const req = https.get(url, { timeout: 15000 }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }); req.on('error', rej); req.on('timeout', () => { req.destroy(); rej(new Error('TO')); });
  });
}
const sl = ms => new Promise(r => setTimeout(r, ms));

async function dlCandles(sym, itv, total) {
  const all = []; let end = Date.now();
  while (all.length < total) {
    const lim = Math.min(1000, total - all.length);
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${itv}&limit=${lim}&endTime=${end}`;
    let d, t = 3;
    while (t > 0) { try { d = await fetchJ(url); break; } catch (e) { t--; if (!t) throw e; await sl(2000); } }
    if (!d || !d.length) break;
    all.unshift(...d.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })));
    end = d[0][0] - 1; await sl(200);
  }
  return all.slice(-total);
}

async function loadAll(pairs) {
  const D = {};
  const need5m = Math.ceil(DAYS * 24 * 12 * 1.05);
  const need15m = Math.ceil(DAYS * 24 * 4 * 1.05);
  const need1h = Math.ceil(DAYS * 24 * 1.05);
  const need4h = Math.ceil(DAYS * 6 * 1.05);
  for (const s of pairs) {
    process.stdout.write(`  ${s}...`);
    const k5m = await dlCandles(s, '5m', need5m);
    const k15m = await dlCandles(s, '15m', need15m);
    const k1h = await dlCandles(s, '1h', need1h);
    const k4h = await dlCandles(s, '4h', need4h);
    D[s] = { k5m, k15m, k1h, k4h };
    console.log(` ${k5m.length}x5m ${k15m.length}x15m ${k1h.length}x1h ${k4h.length}x4h`);
  }
  return D;
}

// ═══ PRECOMPUTE ═══
function pre(k) {
  const c = k.map(x => x.c), h = k.map(x => x.h), l = k.map(x => x.l);
  const v = k.map(x => x.v), o = k.map(x => x.o);
  const rsi = rsiA(c);
  const macd = macdA(c);
  const bb = bbA(c, 20, 2);
  const bb25 = bbA(c, 20, 2.5);
  const stoch = stochA(h, l, c, 14, 3);
  const atr = atrA(h, l, c);
  const adxD = adxA(h, l, c);
  const ema9 = emaA(c, 9), ema13 = emaA(c, 13), ema21 = emaA(c, 21), ema50 = emaA(c, 50);
  const vSma = smaA(v, 20);
  const vR = volRatio(v, 20);
  return { c, h, l, v, o, rsi, macd, bb, bb25, stoch, atr, adx: adxD, ema9, ema13, ema21, ema50, vSma, vR };
}

function mapTF(kLow, kHigh) {
  const m = new Int32Array(kLow.length);
  let j = 0;
  for (let i = 0; i < kLow.length; i++) {
    while (j < kHigh.length - 1 && kHigh[j + 1].t <= kLow[i].t) j++;
    m[i] = kHigh[j].t <= kLow[i].t ? j : -1;
  }
  return m;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1A: VOLATILITY BREAKOUT (5m) — from Round 2, PF 1.68
// BB squeeze (width in bottom 10th pct for 8+ bars), then breakout
// with EMA21 slope + MACD + volume confirmation
// ═══════════════════════════════════════════════════════════════════════════════
function stratVolBreakout(sym, D, I5m) {
  const d = I5m[sym], k5 = D[sym].k5m;
  const sigs = [];

  for (let i = 108; i < k5.length - 3; i++) {
    const bw = d.bb.width;
    if (!bw[i] || !bw[i - 1]) continue;

    // BB width in bottom 10th percentile of last 100 bars
    const widths = [];
    for (let j = i - 99; j <= i; j++) {
      if (bw[j] > 0) widths.push(bw[j]);
    }
    if (widths.length < 80) continue;
    widths.sort((a, b) => a - b);
    const pct10 = widths[Math.floor(widths.length * 0.10)];
    if (bw[i] > pct10) continue;

    // Squeeze must last 8+ bars
    let sqLen = 0;
    for (let j = i; j >= Math.max(i - 30, 0); j--) {
      if (bw[j] > 0 && bw[j] <= pct10) sqLen++; else break;
    }
    if (sqLen < 8) continue;

    // Breakout: first close outside BB
    const breakUp = d.c[i] > d.bb.upper[i] && d.c[i - 1] <= d.bb.upper[i - 1];
    const breakDn = d.c[i] < d.bb.lower[i] && d.c[i - 1] >= d.bb.lower[i - 1];
    if (!breakUp && !breakDn) continue;

    // EMA21 slope
    const slope = d.ema21[i] - d.ema21[i - 5];
    const macdDir = d.macd.hist[i];
    // Volume > 1.5x avg
    if (d.vR[i] < 1.5) continue;

    let dir = null;
    if (breakUp && slope > 0 && macdDir > 0) dir = 'BUY';
    if (breakDn && slope < 0 && macdDir < 0) dir = 'SELL';
    if (!dir) continue;

    const entry = k5[i + 2].o; // bar+2 for 5m
    const atrVal = d.atr[i];
    const stop = dir === 'BUY' ? entry - atrVal * 2 : entry + atrVal * 2;
    const tp = dir === 'BUY' ? entry + atrVal * 4 : entry - atrVal * 4;
    const slPct = Math.abs(entry - stop) / entry;
    if (slPct < 0.002 || slPct > 0.05) continue;

    sigs.push({ dir, barIdx: i, entry, sl: stop, tp, slPct, strat: 'L1A', layer: 1, time: k5[i].t });
  }
  return sigs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1B: CONTRARIAN DIVERGENCE (1h) — from Round 4, PF 1.68
// 4H price vs RSI divergence, with 1h confirmation
// ═══════════════════════════════════════════════════════════════════════════════
function stratContrarianDiv(sym, D, I1h, I4h, map1hto4h, cfg = {}) {
  const d1h = I1h[sym], d4h = I4h[sym], k1h = D[sym].k1h;
  const m4h = map1hto4h[sym];
  const sigs = [];
  const usedBars4h = new Set();
  const { slPct = 0.02, tpPct = 0.04 } = cfg;

  for (let i = 60; i < k1h.length - 2; i++) {
    const fi = m4h[i];
    if (fi < 8) continue;
    if (usedBars4h.has(fi)) continue;

    const lb = 6;
    if (fi < lb + 1) continue;

    // Hidden bearish div: price HH but RSI LH
    const priceHH = d4h.h[fi] > d4h.h[fi - lb] && d4h.c[fi] > d4h.c[fi - lb];
    const rsiLH = d4h.rsi[fi] < d4h.rsi[fi - lb] - 3;
    // Hidden bullish div: price LL but RSI HL
    const priceLL = d4h.l[fi] < d4h.l[fi - lb] && d4h.c[fi] < d4h.c[fi - lb];
    const rsiHL = d4h.rsi[fi] > d4h.rsi[fi - lb] + 3;

    let dir = null;
    if (priceHH && rsiLH && d4h.rsi[fi] > 55) dir = 'SELL';
    if (priceLL && rsiHL && d4h.rsi[fi] < 45) dir = 'BUY';
    if (!dir) continue;

    // 1h confirmation: RSI in favorable zone
    if (dir === 'BUY' && d1h.rsi[i] > 55) continue;
    if (dir === 'SELL' && d1h.rsi[i] < 45) continue;

    usedBars4h.add(fi);

    const entry = k1h[i + 1] ? k1h[i + 1].o : k1h[i].c; // bar+1 for 1h
    const stop = dir === 'BUY' ? entry * (1 - slPct) : entry * (1 + slPct);
    const tp = dir === 'BUY' ? entry * (1 + tpPct) : entry * (1 - tpPct);

    sigs.push({ dir, barIdx: i, entry, sl: stop, tp, slPct, strat: 'L1B', layer: 1, time: k1h[i].t, tf: '1h' });
  }
  return sigs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1C: ADX THRUST (1h) — from Round 4, PF 1.40
// ADX crosses above 25, volume spike, direction from DI
// ═══════════════════════════════════════════════════════════════════════════════
function stratADXThrust(sym, D, I1h, cfg = {}) {
  const d1h = I1h[sym], k1h = D[sym].k1h;
  const sigs = [];
  const usedBars = new Set();
  const { slPct = 0.015, rr = 2.67 } = cfg;

  for (let i = 60; i < k1h.length - 2; i++) {
    if (i < 30) continue;
    if (usedBars.has(i)) continue;

    const prevAdx = d1h.adx.adx[i - 1], curAdx = d1h.adx.adx[i];
    if (!(prevAdx < 25 && curAdx >= 25)) continue;

    // Volume confirm
    if (d1h.vR[i] < 1.3) continue;

    const dir = d1h.adx.pdi[i] > d1h.adx.ndi[i] ? 'BUY' : 'SELL';
    usedBars.add(i);

    const entry = k1h[i + 1] ? k1h[i + 1].o : k1h[i].c;
    const atr1h = d1h.atr[i];
    const useSlPct = cfg.slPct || (atr1h * 1.5 / entry);
    const stop = dir === 'BUY' ? entry * (1 - useSlPct) : entry * (1 + useSlPct);
    const tpDist = useSlPct * rr;
    const tp = dir === 'BUY' ? entry * (1 + tpDist) : entry * (1 - tpDist);

    const actualSlPct = Math.abs(entry - stop) / entry;
    if (actualSlPct < 0.003 || actualSlPct > 0.06) continue;

    sigs.push({ dir, barIdx: i, entry, sl: stop, tp, slPct: actualSlPct, strat: 'L1C', layer: 1, time: k1h[i].t, tf: '1h' });
  }
  return sigs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2D: MULTI-TF STRUCTURE with ULTRA-STRICT quality gate
// Base: 4H structure + 1H momentum + 15m trigger (from Round 4 S3)
// + FILTER 1: Score >= 3/5
// + FILTER 2: Anti-chop
// + FILTER 3: Anti-counter-trend (4H EMA alignment)
// ═══════════════════════════════════════════════════════════════════════════════
function stratMultiTFFiltered(sym, D, I15, I1h, I4h, map15to1h, map15to4h) {
  const d15 = I15[sym], d1h = I1h[sym], d4h = I4h[sym];
  const k15 = D[sym].k15m, m1h = map15to1h[sym], m4h = map15to4h[sym];
  const sigs = [];

  for (let i = 60; i < k15.length - 2; i++) {
    const hi = m1h[i], fi = m4h[i];
    if (hi < 2 || fi < 10) continue;

    // 4H structure: higher highs + higher lows (up) or lower lows + lower highs (down)
    let hh = 0, hl = 0, lh = 0, ll = 0;
    for (let j = fi - 9; j < fi; j++) {
      if (j < 1) continue;
      if (d4h.h[j + 1] > d4h.h[j]) hh++;
      if (d4h.l[j + 1] > d4h.l[j]) hl++;
      if (d4h.h[j + 1] < d4h.h[j]) lh++;
      if (d4h.l[j + 1] < d4h.l[j]) ll++;
    }
    const upTrend = hh >= 3 && hl >= 3;
    const dnTrend = lh >= 3 && ll >= 3;
    if (!upTrend && !dnTrend) continue;

    // 1H: MACD histogram AND RSI in zone (base check)
    const macdOk = upTrend ? d1h.macd.hist[hi] > 0 : d1h.macd.hist[hi] < 0;
    const rsiOk = upTrend
      ? (d1h.rsi[hi] >= 40 && d1h.rsi[hi] <= 65)
      : (d1h.rsi[hi] >= 35 && d1h.rsi[hi] <= 60);
    if (!macdOk || !rsiOk) continue;

    // 15M: Stochastic cross
    const prevK = d15.stoch.k[i - 1], curK = d15.stoch.k[i];
    let dir = null;
    if (upTrend && prevK < 20 && curK >= 20) dir = 'BUY';
    if (dnTrend && prevK > 80 && curK <= 80) dir = 'SELL';
    if (!dir) continue;

    // ═══ FILTER 1: Quality Score >= 3 of 5 ═══
    let qScore = 0;
    // +1 RSI(14) on 1h in favorable zone (40-60 for trend entry)
    if (d1h.rsi[hi] >= 40 && d1h.rsi[hi] <= 60) qScore++;
    // +1 MACD histogram on 1h in signal direction
    if ((dir === 'BUY' && d1h.macd.hist[hi] > 0) || (dir === 'SELL' && d1h.macd.hist[hi] < 0)) qScore++;
    // +1 volume > 1.5x average on entry bar (15m)
    if (d15.vR[i] > 1.5) qScore++;
    // +1 price above/below EMA50 on 1h (trend direction)
    if ((dir === 'BUY' && d1h.c[hi] > d1h.ema50[hi]) || (dir === 'SELL' && d1h.c[hi] < d1h.ema50[hi])) qScore++;
    // +1 ADX > 20 (some trend exists)
    if (d1h.adx.adx[hi] > 20) qScore++;

    if (qScore < 3) continue;

    // ═══ FILTER 2: Anti-chop ═══
    // If last 10 bars on 15m: alternating green/red (>6 switches) → SKIP
    let switches = 0;
    for (let j = i - 9; j < i; j++) {
      if (j < 1) continue;
      const prevGreen = d15.c[j - 1] > d15.o[j - 1];
      const curGreen = d15.c[j] > d15.o[j];
      if (prevGreen !== curGreen) switches++;
    }
    if (switches > 6) continue;

    // If BB width < 5th percentile on 15m → SKIP (dead market)
    const bbw15 = d15.bb.width;
    if (bbw15[i] > 0) {
      let cnt = 0, lt = 0;
      for (let j = Math.max(0, i - 99); j < i; j++) {
        if (bbw15[j] > 0) { cnt++; if (bbw15[j] < bbw15[i]) lt++; }
      }
      if (cnt > 20 && lt / cnt < 0.05) continue; // below 5th percentile
    }

    // ═══ FILTER 3: Anti-counter-trend (4H EMA9 vs EMA21) ═══
    if (dir === 'BUY' && d4h.ema9[fi] < d4h.ema21[fi]) continue;
    if (dir === 'SELL' && d4h.ema9[fi] > d4h.ema21[fi]) continue;

    const entry = k15[i + 1].o; // bar+1 for 15m

    // SL: last 15m swing low/high
    let stop;
    if (dir === 'BUY') {
      stop = Infinity;
      for (let j = Math.max(0, i - 10); j <= i; j++) stop = Math.min(stop, d15.l[j]);
      stop *= 0.999;
    } else {
      stop = -Infinity;
      for (let j = Math.max(0, i - 10); j <= i; j++) stop = Math.max(stop, d15.h[j]);
      stop *= 1.001;
    }

    const slDist = Math.abs(entry - stop);
    if (slDist / entry < 0.003 || slDist / entry > 0.05) continue;

    // TP: last 4H swing high/low
    let tp;
    if (dir === 'BUY') {
      tp = -Infinity;
      for (let j = Math.max(0, fi - 15); j <= fi; j++) tp = Math.max(tp, d4h.h[j]);
      if (tp <= entry) tp = entry + slDist * 3;
    } else {
      tp = Infinity;
      for (let j = Math.max(0, fi - 15); j <= fi; j++) tp = Math.min(tp, d4h.l[j]);
      if (tp >= entry) tp = entry - slDist * 3;
    }

    const rr = Math.abs(tp - entry) / slDist;
    if (rr < 1.5) continue;

    sigs.push({
      dir, barIdx: i, entry, sl: stop, tp, slPct: slDist / entry,
      strat: 'L2D', layer: 2, time: k15[i].t, tf: '15m', qScore
    });
  }
  return sigs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED TRADE SIMULATOR — supports multi-strategy dedup + position mgmt
// ═══════════════════════════════════════════════════════════════════════════════
function simCombined(allSigs, allKl, cfg = {}) {
  const trades = [];
  const { maxHold5m = 200, maxHold15m = 200, maxHold1h = 120 } = cfg;
  let fillSeq = 0;

  // Sort all signals by time
  allSigs.sort((a, b) => a.time - b.time);

  // Track open positions for dedup/max pos
  const openPos = [];
  const pairCooldown = {}; // pair -> earliest next bar time

  for (const sig of allSigs) {
    fillSeq++;
    if (fillSeq % 5 === 0) continue; // 80% fill rate

    // Dedup: if Layer 1 and Layer 2 fire on same pair within 2 minutes, skip Layer 2
    if (sig.layer === 2) {
      const recentL1 = allSigs.find(s =>
        s.layer === 1 && s.strat !== sig.strat && s.time &&
        Math.abs(s.time - sig.time) < 2 * 60000 &&
        // only dedup signals for the same pair (we tag pair in main loop)
        s._pair === sig._pair
      );
      if (recentL1) continue;
    }

    // Cooldown per pair
    if (pairCooldown[sig._pair] && sig.time < pairCooldown[sig._pair]) continue;

    // Resolve closed positions
    for (let p = openPos.length - 1; p >= 0; p--) {
      if (openPos[p].closeTime && openPos[p].closeTime <= sig.time) {
        openPos.splice(p, 1);
      }
    }

    // Max positions check
    const totalOpen = openPos.length;
    const sameDir = openPos.filter(p => p.dir === sig.dir).length;

    if (totalOpen >= MAX_POS) {
      // Layer 1 gets priority: close worst Layer 2
      if (sig.layer === 1) {
        const l2Positions = openPos.filter(p => p.layer === 2);
        if (l2Positions.length > 0) {
          // Close the worst performing L2
          l2Positions.sort((a, b) => a.unrealized - b.unrealized);
          const worst = l2Positions[0];
          const idx = openPos.indexOf(worst);
          if (idx >= 0) openPos.splice(idx, 1);
        } else {
          continue;
        }
      } else {
        continue;
      }
    }
    if (sameDir >= MAX_SAME_DIR && totalOpen < MAX_POS) {
      // Can still open opposite
      if (sameDir >= MAX_SAME_DIR) continue;
    }

    // Determine klines to use for exit simulation
    let kl, maxHold, exitDelay;
    if (sig.tf === '1h') {
      kl = allKl[sig._pair].k1h;
      maxHold = maxHold1h;
      exitDelay = 1; // bar+1 for 1h
    } else if (sig.tf === '15m') {
      kl = allKl[sig._pair].k15m;
      maxHold = maxHold15m;
      exitDelay = 1; // bar+1 for 15m
    } else {
      kl = allKl[sig._pair].k5m;
      maxHold = maxHold5m;
      exitDelay = 2; // bar+2 for 5m
    }

    const eb = sig.barIdx + exitDelay;
    if (eb >= kl.length - 1) continue;

    const ep = sig.entry || kl[eb].o;
    const isBuy = sig.dir === 'BUY';
    let stop = sig.sl, tp = sig.tp;
    let exitP = 0, exitR = '';

    for (let b = eb + 1; b < kl.length && b <= eb + maxHold; b++) {
      const bar = kl[b];

      // SL first on ambiguous bars
      const slHit = isBuy ? bar.l <= stop : bar.h >= stop;
      const tpHit = isBuy ? bar.h >= tp : bar.l <= tp;

      if (slHit && tpHit) {
        exitP = stop; exitR = 'SL';
      } else if (slHit) {
        exitP = isBuy ? Math.min(stop, bar.o) : Math.max(stop, bar.o);
        exitR = 'SL';
      } else if (tpHit) {
        exitP = tp; exitR = 'TP';
      }

      if (!exitP && b === eb + maxHold) {
        exitP = bar.c; exitR = 'TO';
      }
      if (exitP) {
        // Record closeTime for position tracking
        sig._closeTime = bar.t;
        break;
      }
    }

    if (!exitP) continue;

    const raw = isBuy ? exitP - ep : ep - exitP;
    const entryFee = POS * FEE_M;
    const exitFee = exitR === 'SL' ? POS * FEE_T : POS * FEE_M;
    const slipCost = exitR === 'SL' ? POS * SLIP_SL : POS * SLIP_TP;
    const pnl = (raw / ep) * POS - entryFee - exitFee - slipCost;

    // Cooldown
    const cdMs = sig.tf === '1h' ? 3600000 * 2 : sig.tf === '15m' ? 900000 * 4 : 300000 * 4;
    pairCooldown[sig._pair] = sig.time + cdMs;

    // Track position
    openPos.push({
      dir: sig.dir, layer: sig.layer, closeTime: sig._closeTime,
      unrealized: pnl
    });

    trades.push({
      dir: sig.dir, pnl, reason: exitR, barIdx: sig.barIdx,
      entry: ep, exit: exitP, slPct: sig.slPct, strat: sig.strat,
      time: sig.time, pair: sig._pair, layer: sig.layer, tf: sig.tf || '5m'
    });
  }
  return trades;
}

// ═══ SIMPLE SIM (no position management, for individual layer testing) ═══
function simSimple(sigs, kl, cfg = {}) {
  const trades = [];
  const { maxHold = 200, entryDelay = 1 } = cfg;
  let nextBar = 0, fillSeq = 0;

  for (const sig of sigs) {
    fillSeq++;
    if (fillSeq % 5 === 0) continue; // 80% fill

    const eb = sig.barIdx + entryDelay;
    if (eb >= kl.length - 1 || eb < nextBar) continue;

    const ep = sig.entry || kl[eb].o;
    const isBuy = sig.dir === 'BUY';
    let stop = sig.sl, tp = sig.tp;
    let exitP = 0, exitR = '';

    for (let b = eb + 1; b < kl.length && b <= eb + maxHold; b++) {
      const bar = kl[b];
      const slHit = isBuy ? bar.l <= stop : bar.h >= stop;
      const tpHit = isBuy ? bar.h >= tp : bar.l <= tp;

      if (slHit && tpHit) { exitP = stop; exitR = 'SL'; }
      else if (slHit) { exitP = isBuy ? Math.min(stop, bar.o) : Math.max(stop, bar.o); exitR = 'SL'; }
      else if (tpHit) { exitP = tp; exitR = 'TP'; }
      if (!exitP && b === eb + maxHold) { exitP = bar.c; exitR = 'TO'; }
      if (exitP) break;
    }
    if (!exitP) continue;

    const raw = isBuy ? exitP - ep : ep - exitP;
    const entryFee = POS * FEE_M;
    const exitFee = exitR === 'SL' ? POS * FEE_T : POS * FEE_M;
    const slipCost = exitR === 'SL' ? POS * SLIP_SL : POS * SLIP_TP;
    const pnl = (raw / ep) * POS - entryFee - exitFee - slipCost;

    const cd = sig.tf === '1h' ? 8 : sig.tf === '15m' ? 4 : 2;
    nextBar = eb + cd;

    trades.push({
      dir: sig.dir, pnl, reason: exitR, barIdx: sig.barIdx,
      entry: ep, exit: exitP, slPct: sig.slPct, strat: sig.strat,
      time: sig.time, pair: sig._pair, layer: sig.layer, tf: sig.tf || '5m'
    });
  }
  return trades;
}

// ═══ METRICS ═══
function met(trades, label) {
  if (!trades.length) return { label, pnl: 0, pf: 0, wr: 0, n: 0, tpd: 0, aw: 0, al: 0, mdd: 0, ddPct: 0 };
  const w = trades.filter(t => t.pnl > 0), lo = trades.filter(t => t.pnl <= 0);
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const gw = w.reduce((s, t) => s + t.pnl, 0), gl = Math.abs(lo.reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;
  const wr = w.length / trades.length * 100;
  let cum = 0, pk = 0, mdd = 0;
  for (const t of trades) { cum += t.pnl; pk = Math.max(pk, cum); mdd = Math.max(mdd, pk - cum); }
  return { label, pnl, pf, wr, n: trades.length, tpd: trades.length / DAYS,
    aw: w.length ? gw / w.length : 0, al: lo.length ? gl / lo.length : 0,
    mdd, ddPct: mdd / CAP0 * 100 };
}

function monthlyPF(trades) {
  const months = {};
  for (const t of trades) {
    const d = new Date(t.time);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!months[key]) months[key] = [];
    months[key].push(t);
  }
  const sorted = Object.keys(months).sort();
  const result = {};
  for (const mo of sorted) {
    const m = met(months[mo], mo);
    result[mo] = m;
  }
  return result;
}

function pairPF(trades) {
  const byPair = {};
  for (const t of trades) {
    if (!byPair[t.pair]) byPair[t.pair] = [];
    byPair[t.pair].push(t);
  }
  const result = {};
  for (const p of Object.keys(byPair).sort()) {
    result[p] = met(byPair[p], p);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('ROUND 5 — FINAL MEGA-COMBO BACKTEST');
  console.log('Layer 1: Vol Breakout (5m) + Contrarian Div (1h) + ADX Thrust (1h)');
  console.log('Layer 2: Multi-TF Structure with ultra-strict quality gate');
  console.log('$500 cap | 5x lev | 120d | 7 pairs | Binance Futures');
  console.log('Fees: 0.02%/0.05% | Slippage: 0.03%/0.01% | Fill: 80% | SL-first');
  console.log('═══════════════════════════════════════════════════════════════════════');

  // ─── DOWNLOAD ───
  console.log('\n[DOWNLOAD]');
  const D = await loadAll(PAIRS);

  // ─── PRECOMPUTE INDICATORS ───
  console.log('\n[INDICATORS]');
  const I5m = {}, I15m = {}, I1h = {}, I4h = {};
  const map5to1h = {}, map15to1h = {}, map15to4h = {}, map1hto4h = {};

  for (const s of PAIRS) {
    process.stdout.write(`  ${s}...`);
    I5m[s] = pre(D[s].k5m);
    I15m[s] = pre(D[s].k15m);
    I1h[s] = pre(D[s].k1h);
    I4h[s] = pre(D[s].k4h);
    map5to1h[s] = mapTF(D[s].k5m, D[s].k1h);
    map15to1h[s] = mapTF(D[s].k15m, D[s].k1h);
    map15to4h[s] = mapTF(D[s].k15m, D[s].k4h);
    map1hto4h[s] = mapTF(D[s].k1h, D[s].k4h);
    console.log(' done');
  }

  // ─── GENERATE ALL SIGNALS ───
  console.log('\n[SIGNAL GENERATION]');
  const allL1A = [], allL1B = [], allL1C = [], allL2D = [];

  for (const s of PAIRS) {
    const a = stratVolBreakout(s, D, I5m);
    a.forEach(sig => sig._pair = s);
    allL1A.push(...a);

    const b = stratContrarianDiv(s, D, I1h, I4h, map1hto4h);
    b.forEach(sig => sig._pair = s);
    allL1B.push(...b);

    const c = stratADXThrust(s, D, I1h);
    c.forEach(sig => sig._pair = s);
    allL1C.push(...c);

    const d = stratMultiTFFiltered(s, D, I15m, I1h, I4h, map15to1h, map15to4h);
    d.forEach(sig => sig._pair = s);
    allL2D.push(...d);

    console.log(`  ${s}: L1A=${a.length} L1B=${b.length} L1C=${c.length} L2D=${d.length}`);
  }

  console.log(`  TOTAL: L1A=${allL1A.length} L1B=${allL1B.length} L1C=${allL1C.length} L2D=${allL2D.length}`);

  // ─── INDIVIDUAL LAYER TESTING ───
  console.log('\n[INDIVIDUAL LAYERS]');

  // L1A: Vol Breakout on 5m
  const trL1A = [];
  for (const s of PAIRS) {
    const sigs = allL1A.filter(sig => sig._pair === s);
    const tr = simSimple(sigs, D[s].k5m, { maxHold: 200, entryDelay: 2 });
    tr.forEach(t => t.pair = s);
    trL1A.push(...tr);
  }
  const mL1A = met(trL1A, 'L1A: Vol Breakout 5m');

  // L1B: Contrarian Div on 1h
  const trL1B = [];
  for (const s of PAIRS) {
    const sigs = allL1B.filter(sig => sig._pair === s);
    const tr = simSimple(sigs, D[s].k1h, { maxHold: 120, entryDelay: 1 });
    tr.forEach(t => t.pair = s);
    trL1B.push(...tr);
  }
  const mL1B = met(trL1B, 'L1B: Contrarian 1h');

  // L1C: ADX Thrust on 1h
  const trL1C = [];
  for (const s of PAIRS) {
    const sigs = allL1C.filter(sig => sig._pair === s);
    const tr = simSimple(sigs, D[s].k1h, { maxHold: 120, entryDelay: 1 });
    tr.forEach(t => t.pair = s);
    trL1C.push(...tr);
  }
  const mL1C = met(trL1C, 'L1C: ADX Thrust 1h');

  // L2D: Multi-TF filtered on 15m
  const trL2D = [];
  for (const s of PAIRS) {
    const sigs = allL2D.filter(sig => sig._pair === s);
    const tr = simSimple(sigs, D[s].k15m, { maxHold: 200, entryDelay: 1 });
    tr.forEach(t => t.pair = s);
    trL2D.push(...tr);
  }
  const mL2D = met(trL2D, 'L2D: Multi-TF filtered');

  // ─── WIDER SL/TP TEST FOR 1H STRATEGIES ───
  console.log('\n[WIDER SL/TP TEST — 1H Strategies]');
  const slTests = [0.015, 0.02, 0.025, 0.03];
  const tpTests = [0.04, 0.05, 0.06, 0.08];
  let bestSlTp = { pf: 0, sl: 0.02, tp: 0.04 };

  console.log('  SL%   | TP%   | PF    | WR%   | Trades | PnL');
  console.log('  ------|-------|-------|-------|--------|--------');

  for (const testSl of slTests) {
    for (const testTp of tpTests) {
      if (testTp / testSl < 2.0 || testTp / testSl > 3.0) continue; // R:R 2:1 to 3:1

      // Re-generate 1h strats with these params
      const testB = [], testC = [];
      for (const s of PAIRS) {
        const b = stratContrarianDiv(s, D, I1h, I4h, map1hto4h, { slPct: testSl, tpPct: testTp });
        b.forEach(sig => { sig._pair = s; });
        testB.push(...b);

        const c = stratADXThrust(s, D, I1h, { slPct: testSl, rr: testTp / testSl });
        c.forEach(sig => { sig._pair = s; });
        testC.push(...c);
      }

      const trB = [], trC = [];
      for (const s of PAIRS) {
        const sigsB = testB.filter(sig => sig._pair === s);
        trB.push(...simSimple(sigsB, D[s].k1h, { maxHold: 120, entryDelay: 1 }).map(t => ({ ...t, pair: s })));
        const sigsC = testC.filter(sig => sig._pair === s);
        trC.push(...simSimple(sigsC, D[s].k1h, { maxHold: 120, entryDelay: 1 }).map(t => ({ ...t, pair: s })));
      }

      const combined1h = [...trB, ...trC];
      const m = met(combined1h, `SL${(testSl * 100).toFixed(1)}%_TP${(testTp * 100).toFixed(1)}%`);
      console.log(`  ${(testSl * 100).toFixed(1)}%  | ${(testTp * 100).toFixed(1)}%  | ${m.pf.toFixed(2).padStart(5)} | ${m.wr.toFixed(1).padStart(5)} | ${String(m.n).padStart(6)} | $${m.pnl.toFixed(2)}`);

      if (m.pf > bestSlTp.pf && m.n >= 10) {
        bestSlTp = { pf: m.pf, sl: testSl, tp: testTp, m };
      }
    }
  }
  console.log(`  BEST: SL=${(bestSlTp.sl * 100).toFixed(1)}% TP=${(bestSlTp.tp * 100).toFixed(1)}% PF=${bestSlTp.pf.toFixed(2)}`);

  // Re-generate L1B and L1C with best SL/TP if better
  let finalL1B = allL1B, finalL1C = allL1C;
  let usedBestSlTp = false;
  if (bestSlTp.pf > Math.max(mL1B.pf, mL1C.pf) * 0.9) {
    console.log(`  Using wider SL/TP: SL=${(bestSlTp.sl * 100).toFixed(1)}% TP=${(bestSlTp.tp * 100).toFixed(1)}%`);
    finalL1B = []; finalL1C = [];
    for (const s of PAIRS) {
      const b = stratContrarianDiv(s, D, I1h, I4h, map1hto4h, { slPct: bestSlTp.sl, tpPct: bestSlTp.tp });
      b.forEach(sig => { sig._pair = s; });
      finalL1B.push(...b);
      const c = stratADXThrust(s, D, I1h, { slPct: bestSlTp.sl, rr: bestSlTp.tp / bestSlTp.sl });
      c.forEach(sig => { sig._pair = s; });
      finalL1C.push(...c);
    }
    usedBestSlTp = true;

    // Recompute individual metrics with best SL/TP
    const trB2 = [], trC2 = [];
    for (const s of PAIRS) {
      trB2.push(...simSimple(finalL1B.filter(sig => sig._pair === s), D[s].k1h, { maxHold: 120, entryDelay: 1 }).map(t => ({ ...t, pair: s })));
      trC2.push(...simSimple(finalL1C.filter(sig => sig._pair === s), D[s].k1h, { maxHold: 120, entryDelay: 1 }).map(t => ({ ...t, pair: s })));
    }
    const mB2 = met(trB2, 'L1B (optimized)');
    const mC2 = met(trC2, 'L1C (optimized)');
    console.log(`  L1B optimized: PF=${mB2.pf.toFixed(2)} WR=${mB2.wr.toFixed(1)}% T=${mB2.n} PnL=$${mB2.pnl.toFixed(2)}`);
    console.log(`  L1C optimized: PF=${mC2.pf.toFixed(2)} WR=${mC2.wr.toFixed(1)}% T=${mC2.n} PnL=$${mC2.pnl.toFixed(2)}`);
  }

  // ─── COMBO TESTING ───
  console.log('\n[COMBO TESTING]');

  // Combo A: All 4 strategies
  const comboASigs = [...allL1A, ...finalL1B, ...finalL1C, ...allL2D];
  const comboATr = simCombined(comboASigs, D);
  const mComboA = met(comboATr, 'Combo A (All)');

  // Combo B: Only Layer 1 (quality only)
  const comboBSigs = [...allL1A, ...finalL1B, ...finalL1C];
  const comboBTr = simCombined(comboBSigs, D);
  const mComboB = met(comboBTr, 'Combo B (L1 only)');

  // Combo C: D_filtered + B (volume + contrarian)
  const comboCSigs = [...finalL1B, ...allL2D];
  const comboCTr = simCombined(comboCSigs, D);
  const mComboC = met(comboCTr, 'Combo C (D+B)');

  // Combo D: D_filtered + C (volume + trend init)
  const comboDSigs = [...finalL1C, ...allL2D];
  const comboDTr = simCombined(comboDSigs, D);
  const mComboD = met(comboDTr, 'Combo D (D+C)');

  // Find best combo
  const combos = [
    { name: 'A', m: mComboA, tr: comboATr },
    { name: 'B', m: mComboB, tr: comboBTr },
    { name: 'C', m: mComboC, tr: comboCTr },
    { name: 'D', m: mComboD, tr: comboDTr }
  ];

  // Score: weight PF, WR, freq
  const scored = combos.map(c => ({
    ...c,
    score: c.m.pf * 30 + (c.m.wr / 100) * 20 + Math.min(c.m.tpd, 15) * 2 + (c.m.pnl > 0 ? 10 : 0)
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  // ═══ OUTPUT ═══
  console.log('\n');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('ROUND 5 FINAL RESULTS');
  console.log('═══════════════════════════════════════════════════════════════════════');

  console.log('\nIndividual Layers:');
  const fmtLayer = (m) => `PF ${m.pf.toFixed(2)} | WR ${m.wr.toFixed(1)}% | ${m.tpd.toFixed(1)} t/d | $${m.pnl.toFixed(2)}`;
  console.log(`  Layer 1A (Vol Breakout 5m):    ${fmtLayer(mL1A)}`);
  console.log(`  Layer 1B (Contrarian 1h):      ${fmtLayer(mL1B)}`);
  console.log(`  Layer 1C (ADX Thrust 1h):      ${fmtLayer(mL1C)}`);
  console.log(`  Layer 2D (Multi-TF filtered):  ${fmtLayer(mL2D)}`);

  if (usedBestSlTp) {
    console.log(`  [Wider SL/TP applied to 1h: SL=${(bestSlTp.sl * 100).toFixed(1)}% TP=${(bestSlTp.tp * 100).toFixed(1)}%]`);
  }

  console.log('\nCombinations:');
  const fmtCombo = (m) => `PF ${m.pf.toFixed(2)} | WR ${m.wr.toFixed(1)}% | ${m.tpd.toFixed(1)} t/d | $${m.pnl >= 0 ? '+' : ''}${m.pnl.toFixed(2)} | DD ${m.ddPct.toFixed(1)}%`;
  console.log(`  Combo A (All):    ${fmtCombo(mComboA)}`);
  console.log(`  Combo B (L1):     ${fmtCombo(mComboB)}`);
  console.log(`  Combo C (D+B):    ${fmtCombo(mComboC)}`);
  console.log(`  Combo D (D+C):    ${fmtCombo(mComboD)}`);

  console.log(`\n  BEST COMBO: ${best.name} — PF ${best.m.pf.toFixed(2)}, WR ${best.m.wr.toFixed(1)}%, ${best.m.tpd.toFixed(1)} trades/day`);

  // Monthly breakdown
  console.log('\nMonthly:');
  const monthly = monthlyPF(best.tr);
  const moKeys = Object.keys(monthly).sort();
  const moLine = moKeys.map(k => {
    const mo = k.split('-')[1];
    const moNames = { '01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr', '05': 'May',
      '06': 'Jun', '07': 'Jul', '08': 'Aug', '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec' };
    return `${moNames[mo] || mo}: PF ${monthly[k].pf.toFixed(2)}`;
  }).join(' | ');
  console.log(`  ${moLine}`);

  // Monthly detail
  console.log('\n  Month      | Trades | WR%   | PnL        | PF');
  console.log('  -----------|--------|-------|------------|------');
  for (const mo of moKeys) {
    const m = monthly[mo];
    console.log(`  ${mo}    | ${String(m.n).padStart(6)} | ${m.wr.toFixed(1).padStart(5)} | ${(m.pnl >= 0 ? '+' : '') + ('$' + m.pnl.toFixed(2)).padStart(10)} | ${m.pf.toFixed(2)}`);
  }

  // Per pair
  console.log('\nPer pair:');
  const pairs = pairPF(best.tr);
  const pairLine = Object.keys(pairs).map(p => `${p.replace('USDT', '')}: PF ${pairs[p].pf.toFixed(2)}`).join(' | ');
  console.log(`  ${pairLine}`);

  console.log('\n  Pair       | Trades | WR%   | PnL        | PF    | t/d');
  console.log('  -----------|--------|-------|------------|-------|------');
  for (const p of Object.keys(pairs).sort()) {
    const m = pairs[p];
    console.log(`  ${p.padEnd(10)} | ${String(m.n).padStart(6)} | ${m.wr.toFixed(1).padStart(5)} | ${(m.pnl >= 0 ? '+' : '') + ('$' + m.pnl.toFixed(2)).padStart(10)} | ${m.pf.toFixed(2).padStart(5)} | ${m.tpd.toFixed(1)}`);
  }

  // Strategy breakdown within best combo
  console.log('\nStrategy breakdown (best combo):');
  const byStrat = {};
  for (const t of best.tr) {
    if (!byStrat[t.strat]) byStrat[t.strat] = [];
    byStrat[t.strat].push(t);
  }
  console.log('  Strategy   | Trades | WR%   | PnL        | PF    | t/d');
  console.log('  -----------|--------|-------|------------|-------|------');
  for (const s of Object.keys(byStrat).sort()) {
    const m = met(byStrat[s], s);
    console.log(`  ${s.padEnd(10)} | ${String(m.n).padStart(6)} | ${m.wr.toFixed(1).padStart(5)} | ${(m.pnl >= 0 ? '+' : '') + ('$' + m.pnl.toFixed(2)).padStart(10)} | ${m.pf.toFixed(2).padStart(5)} | ${m.tpd.toFixed(1)}`);
  }

  // TARGET CHECK
  console.log('\n═══════════════════════════════════════════════════════════════════════');
  console.log('TARGET CHECK');
  console.log('═══════════════════════════════════════════════════════════════════════');
  const pfOk = best.m.pf >= 2.0;
  const wrOk = best.m.wr >= 55;
  const tdOk = best.m.tpd >= 10;
  console.log(`  PF >= 2.0:   ${pfOk ? 'YES' : 'NO'} — actual ${best.m.pf.toFixed(2)}`);
  console.log(`  WR >= 55%:   ${wrOk ? 'YES' : 'NO'} — actual ${best.m.wr.toFixed(1)}%`);
  console.log(`  T/day >= 10: ${tdOk ? 'YES' : 'NO'} — actual ${best.m.tpd.toFixed(1)}`);
  console.log(`  Total PnL:   $${best.m.pnl.toFixed(2)} over ${DAYS} days`);
  console.log(`  Max DD:      $${best.m.mdd.toFixed(2)} (${best.m.ddPct.toFixed(1)}% of capital)`);

  if (pfOk && wrOk && tdOk) {
    console.log('\n  >>> ALL TARGETS MET <<<');
  } else {
    console.log('\n  Targets not fully met. Best achievable from 29+ strategies tested:');
    console.log(`  Combo ${best.name}: PF ${best.m.pf.toFixed(2)} | WR ${best.m.wr.toFixed(1)}% | ${best.m.tpd.toFixed(1)} t/d`);
  }

  // All combos ranked
  console.log('\nAll combos ranked by composite score:');
  for (const c of scored) {
    console.log(`  ${c.name}: PF ${c.m.pf.toFixed(2)} | WR ${c.m.wr.toFixed(1)}% | ${c.m.tpd.toFixed(1)} t/d | $${c.m.pnl.toFixed(2)} | Score: ${c.score.toFixed(1)}`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
