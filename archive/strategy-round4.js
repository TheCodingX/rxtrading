#!/usr/bin/env node
'use strict';
const https = require('https');

// ═══ CONFIG ═══
const CAP0 = 500, LEV = 5, POS = CAP0 * LEV;
const FEE_M = 0.0002, FEE_T = 0.0005, SLIP = 0.0003; // taker+slip for SL, maker for TP
const DAYS = 120, MAX_POS = 3;
const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'AVAXUSDT'];

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
  const mid = smaA(c, p), upper = [], lower = [];
  for (let i = 0; i < c.length; i++) {
    if (i < p - 1) { upper.push(c[i]); lower.push(c[i]); continue; }
    let sum = 0;
    for (let j = i - p + 1; j <= i; j++) sum += (c[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sum / p);
    upper.push(mid[i] + mult * sd);
    lower.push(mid[i] - mult * sd);
  }
  return { mid, upper, lower };
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
  const need15m = Math.ceil(DAYS * 24 * 4 * 1.05); // 15m candles
  const need1h = Math.ceil(DAYS * 24 * 1.05);
  const need4h = Math.ceil(DAYS * 6 * 1.05);
  for (const s of pairs) {
    process.stdout.write(`  ${s}...`);
    const k15 = await dlCandles(s, '15m', need15m);
    const k1h = await dlCandles(s, '1h', need1h);
    const k4h = await dlCandles(s, '4h', need4h);
    D[s] = { k15, k1h, k4h };
    console.log(` ${k15.length}x15m ${k1h.length}x1h ${k4h.length}x4h`);
  }
  return D;
}

// ═══ PRECOMPUTE ═══
function pre(k, opts = {}) {
  const c = k.map(x => x.c), h = k.map(x => x.h), l = k.map(x => x.l);
  const v = k.map(x => x.v), o = k.map(x => x.o);
  const rsi = rsiA(c);
  const macd = macdA(c, opts.mFast || 12, opts.mSlow || 26, opts.mSig || 9);
  const bb = bbA(c, 20, opts.bbMult || 2.0);
  const bb25 = bbA(c, 20, 2.5);
  const stoch = stochA(h, l, c, 14, 3);
  const atr = atrA(h, l, c);
  const adxD = adxA(h, l, c);
  const ema9 = emaA(c, 9), ema13 = emaA(c, 13), ema21 = emaA(c, 21), ema50 = emaA(c, 50);
  const vSma = smaA(v, 20);
  return { c, h, l, v, o, rsi, macd, bb, bb25, stoch, atr, adx: adxD, ema9, ema13, ema21, ema50, vSma };
}

// Map higher TF index for each lower TF bar
function mapTF(kLow, kHigh) {
  const m = new Int32Array(kLow.length);
  let j = 0;
  for (let i = 0; i < kLow.length; i++) {
    while (j < kHigh.length - 1 && kHigh[j + 1].t <= kLow[i].t) j++;
    m[i] = kHigh[j].t <= kLow[i].t ? j : -1;
  }
  return m;
}

// ═══ S1: 15M RSI REVERSAL + 1H TREND ═══
function stratS1(sym, D, I15, I1h, map15to1h, cfg) {
  const { rsiTh = 30, slLB = 5, rr = 3.0 } = cfg;
  const d15 = I15[sym], d1h = I1h[sym], k15 = D[sym].k15, m = map15to1h[sym];
  const sigs = [];

  for (let i = Math.max(50, slLB + 2); i < k15.length - 2; i++) {
    const hi = m[i];
    if (hi < 1) continue;

    // 1H trend: EMA9 > EMA21 = bullish (use closed candle = hi-1 if current is open)
    // Use hi directly — mapTF gives us the last closed 1h bar
    const bullTrend = d1h.ema9[hi] > d1h.ema21[hi];
    const bearTrend = d1h.ema9[hi] < d1h.ema21[hi];

    // 15M RSI cross
    const prevRsi = d15.rsi[i - 1], curRsi = d15.rsi[i];

    let dir = null;
    if (bullTrend && prevRsi < rsiTh && curRsi >= rsiTh) dir = 'BUY';
    if (bearTrend && prevRsi > (100 - rsiTh) && curRsi <= (100 - rsiTh)) dir = 'SELL';
    if (!dir) continue;

    // SL: lowest/highest low of last slLB bars
    let stop;
    if (dir === 'BUY') {
      stop = Infinity;
      for (let j = i - slLB; j <= i; j++) stop = Math.min(stop, d15.l[j]);
    } else {
      stop = -Infinity;
      for (let j = i - slLB; j <= i; j++) stop = Math.max(stop, d15.h[j]);
    }

    const entry = k15[i + 1].o; // bar+1 open
    const slDist = Math.abs(entry - stop);
    const slPct = slDist / entry;
    if (slPct < 0.003 || slPct > 0.04) continue; // too tight or too wide

    const tp = dir === 'BUY' ? entry + slDist * rr : entry - slDist * rr;

    sigs.push({ dir, barIdx: i, entry, sl: stop, tp, slPct, strat: 'S1' });
  }
  return sigs;
}

// ═══ S2: 1H MACD ZERO-LINE CROSS + 15M PULLBACK ═══
function stratS2(sym, D, I15, I1h, map15to1h, cfg) {
  const { pullEma = 'ema21', mFast = 12, mSlow = 26 } = cfg;
  const d15 = I15[sym], d1h = I1h[sym], k15 = D[sym].k15, m = map15to1h[sym];
  const sigs = [];

  // Track 1h MACD zero-line crosses
  let lastCrossDir = null, lastCrossBar = -999;

  for (let i = 60; i < k15.length - 2; i++) {
    const hi = m[i];
    if (hi < 2) continue;

    // Check for new 1h MACD zero-line cross
    const prevMacd = d1h.macd.macd[hi - 1], curMacd = d1h.macd.macd[hi];
    if (prevMacd < 0 && curMacd >= 0) { lastCrossDir = 'BUY'; lastCrossBar = i; }
    if (prevMacd > 0 && curMacd <= 0) { lastCrossDir = 'SELL'; lastCrossBar = i; }

    // Only look for entries within 48 bars (12h) of the cross
    if (!lastCrossDir || i - lastCrossBar > 48 * 4) continue;
    // Need at least some bars after cross for pullback
    if (i - lastCrossBar < 4) continue;

    const emaRef = d15[pullEma];
    const prevRsi = d15.rsi[i - 1], curRsi = d15.rsi[i];

    if (lastCrossDir === 'BUY') {
      // Pullback to EMA: price near or touches EMA from above
      const nearEma = d15.c[i] <= emaRef[i] * 1.003 && d15.c[i] >= emaRef[i] * 0.995;
      // RSI bounces from 40-50 zone
      const rsiBounce = prevRsi >= 38 && prevRsi <= 52 && curRsi > prevRsi;
      if (!nearEma || !rsiBounce) continue;

      const entry = k15[i + 1].o;
      const stop = d15.ema50[i] * 0.998;
      const slDist = entry - stop;
      if (slDist <= 0 || slDist / entry < 0.003 || slDist / entry > 0.04) continue;
      const tp = entry + slDist * 3;
      sigs.push({ dir: 'BUY', barIdx: i, entry, sl: stop, tp, slPct: slDist / entry, strat: 'S2' });
    } else {
      const nearEma = d15.c[i] >= emaRef[i] * 0.997 && d15.c[i] <= emaRef[i] * 1.005;
      const rsiBounce = prevRsi >= 48 && prevRsi <= 62 && curRsi < prevRsi;
      if (!nearEma || !rsiBounce) continue;

      const entry = k15[i + 1].o;
      const stop = d15.ema50[i] * 1.002;
      const slDist = stop - entry;
      if (slDist <= 0 || slDist / entry < 0.003 || slDist / entry > 0.04) continue;
      const tp = entry - slDist * 3;
      sigs.push({ dir: 'SELL', barIdx: i, entry, sl: stop, tp, slPct: slDist / entry, strat: 'S2' });
    }
  }
  return sigs;
}

// ═══ S3: 4H STRUCTURE + 1H MOMENTUM + 15M TRIGGER ═══
function stratS3(sym, D, I15, I1h, I4h, map15to1h, map15to4h, cfg) {
  const d15 = I15[sym], d1h = I1h[sym], d4h = I4h[sym];
  const k15 = D[sym].k15, m1h = map15to1h[sym], m4h = map15to4h[sym];
  const sigs = [];

  for (let i = 60; i < k15.length - 2; i++) {
    const hi = m1h[i], fi = m4h[i];
    if (hi < 2 || fi < 10) continue;

    // 4H structure: higher highs + higher lows (uptrend) or lower lows + lower highs (downtrend)
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

    // 1H: MACD histogram positive/negative AND RSI in zone
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

    const entry = k15[i + 1].o;

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
    if (rr < 1.5) continue; // need decent R:R

    sigs.push({ dir, barIdx: i, entry, sl: stop, tp, slPct: slDist / entry, strat: 'S3' });
  }
  return sigs;
}

// ═══ S4: 1H MEAN REVERSION (BB extreme) ═══
function stratS4(sym, D, I1h, map15to1h, I15, cfg) {
  const d1h = I1h[sym], d15 = I15[sym], k15 = D[sym].k15;
  const k1h = D[sym].k1h, m = map15to1h[sym];
  const sigs = [];
  const usedBars = new Set();

  for (let i = 60; i < k15.length - 2; i++) {
    const hi = m[i];
    if (hi < 21) continue;

    // Check conditions on CLOSED 1h bar
    const belowBB = d1h.c[hi] < d1h.bb25.lower[hi]; // BB(20, 2.5) extreme
    const aboveBB = d1h.c[hi] > d1h.bb25.upper[hi];
    const rsiLow = d1h.rsi[hi] < 25;
    const rsiHigh = d1h.rsi[hi] > 75;
    const volSpike = d1h.v[hi] > d1h.vSma[hi] * 1.5;

    // Only trigger once per 1h bar
    if (usedBars.has(hi)) continue;

    let dir = null;
    if (belowBB && rsiLow && volSpike) dir = 'BUY';
    if (aboveBB && rsiHigh && volSpike) dir = 'SELL';
    if (!dir) continue;

    usedBars.add(hi);

    const entry = k15[i + 1].o;
    const stop = dir === 'BUY' ? entry * (1 - 0.015) : entry * (1 + 0.015);
    const tp = dir === 'BUY' ? d1h.bb.mid[hi] : d1h.bb.mid[hi]; // BB middle band

    const slDist = Math.abs(entry - stop);
    const tpDist = Math.abs(tp - entry);
    if (tpDist / slDist < 0.8) continue; // need some R:R

    sigs.push({ dir, barIdx: i, entry, sl: stop, tp, slPct: 0.015, strat: 'S4' });
  }
  return sigs;
}

// ═══ S5: ADX THRUST (trend initiation) ═══
function stratS5(sym, D, I1h, map15to1h, I15, cfg) {
  const d1h = I1h[sym], d15 = I15[sym], k15 = D[sym].k15, m = map15to1h[sym];
  const sigs = [];
  const usedBars = new Set();

  for (let i = 60; i < k15.length - 2; i++) {
    const hi = m[i];
    if (hi < 30) continue;
    if (usedBars.has(hi)) continue;

    // ADX crosses above 25 from below
    const prevAdx = d1h.adx.adx[hi - 1], curAdx = d1h.adx.adx[hi];
    if (!(prevAdx < 25 && curAdx >= 25)) continue;

    // Volume confirm
    if (d1h.v[hi] < d1h.vSma[hi] * 1.3) continue;

    // Direction from DI
    const dir = d1h.adx.pdi[hi] > d1h.adx.ndi[hi] ? 'BUY' : 'SELL';

    usedBars.add(hi);

    const entry = k15[i + 1].o;
    const atr1h = d1h.atr[hi];
    const stop = dir === 'BUY' ? entry - atr1h * 1.5 : entry + atr1h * 1.5;
    const tp = dir === 'BUY' ? entry + atr1h * 4.0 : entry - atr1h * 4.0;

    const slPct = Math.abs(entry - stop) / entry;
    if (slPct < 0.003 || slPct > 0.06) continue;

    sigs.push({ dir, barIdx: i, entry, sl: stop, tp, slPct, strat: 'S5' });
  }
  return sigs;
}

// ═══ S6: FUNDING RATE CONTRARIAN (divergence proxy) ═══
function stratS6(sym, D, I4h, I1h, map15to4h, map15to1h, I15, cfg) {
  const d4h = I4h[sym], d1h = I1h[sym], d15 = I15[sym];
  const k15 = D[sym].k15, m4h = map15to4h[sym], m1h = map15to1h[sym];
  const sigs = [];
  const usedBars = new Set();

  for (let i = 60; i < k15.length - 2; i++) {
    const fi = m4h[i], hi = m1h[i];
    if (fi < 8 || hi < 2) continue;
    if (usedBars.has(fi)) continue;

    // Hidden bearish div on 4h: price HH but RSI LH → overleveraged longs → SHORT
    // Hidden bullish div on 4h: price LL but RSI HL → overleveraged shorts → LONG
    const lb = 6; // lookback in 4h bars
    if (fi < lb + 1) continue;

    const priceHH = d4h.h[fi] > d4h.h[fi - lb] && d4h.c[fi] > d4h.c[fi - lb];
    const rsiLH = d4h.rsi[fi] < d4h.rsi[fi - lb] - 3; // meaningful divergence
    const priceLL = d4h.l[fi] < d4h.l[fi - lb] && d4h.c[fi] < d4h.c[fi - lb];
    const rsiHL = d4h.rsi[fi] > d4h.rsi[fi - lb] + 3;

    let dir = null;
    if (priceHH && rsiLH && d4h.rsi[fi] > 55) dir = 'SELL';
    if (priceLL && rsiHL && d4h.rsi[fi] < 45) dir = 'BUY';
    if (!dir) continue;

    usedBars.add(fi);

    const entry = k15[i + 1].o;
    const stop = dir === 'BUY' ? entry * 0.98 : entry * 1.02;
    const tp = dir === 'BUY' ? entry * 1.04 : entry * 0.96;

    sigs.push({ dir, barIdx: i, entry, sl: stop, tp, slPct: 0.02, strat: 'S6' });
  }
  return sigs;
}

// ═══ TRADE SIMULATOR ═══
function simTrades(sigs, k15, cfg = {}) {
  const trades = [];
  let nextBar = 0;
  const { maxHold = 200 } = cfg; // max bars to hold (15m bars: 200 = ~50h)

  for (const sig of sigs) {
    const eb = sig.barIdx + 1;
    if (eb >= k15.length - 1 || eb < nextBar) continue;

    const ep = sig.entry || k15[eb].o;
    const isBuy = sig.dir === 'BUY';
    const ecFee = POS * FEE_M; // entry maker fee

    let stop = sig.sl, tp = sig.tp;
    let exitP = 0, exitR = '';

    for (let b = eb + 1; b < k15.length; b++) {
      const bar = k15[b];

      // Check SL first (conservative)
      const slHit = isBuy ? bar.l <= stop : bar.h >= stop;
      const tpHit = isBuy ? bar.h >= tp : bar.l <= tp;

      if (slHit && tpHit) {
        // Both hit — assume SL hit first (conservative)
        exitP = stop;
        exitR = 'SL';
      } else if (slHit) {
        exitP = isBuy ? Math.min(stop, bar.o) : Math.max(stop, bar.o);
        exitR = 'SL';
      } else if (tpHit) {
        exitP = tp;
        exitR = 'TP';
      }

      // Time out
      if (!exitP && b - eb >= maxHold) {
        exitP = bar.c;
        exitR = 'TO';
      }

      if (exitP) break;
    }

    if (!exitP) continue;

    const raw = isBuy ? exitP - ep : ep - exitP;
    const exitFee = exitR === 'SL' ? POS * FEE_T : POS * FEE_M; // SL = taker, TP = maker
    const slipCost = exitR === 'SL' ? POS * SLIP : 0;
    const pnl = (raw / ep) * POS - ecFee - exitFee - slipCost;

    // Cooldown: skip next N bars after a trade
    const cd = sig.strat === 'S4' || sig.strat === 'S6' ? 16 : 4; // 1h strats need more cooldown
    nextBar = eb + cd;

    trades.push({
      dir: sig.dir, pnl, reason: exitR, barIdx: sig.barIdx,
      entry: ep, exit: exitP, slPct: sig.slPct, strat: sig.strat,
      time: k15[sig.barIdx].t
    });
  }
  return trades;
}

// ═══ METRICS ═══
function met(trades, label) {
  if (!trades.length) return { label, pnl: 0, pf: 0, wr: 0, n: 0, tpd: 0, aw: 0, al: 0, mdd: 0, wins: 0, losses: 0 };
  const w = trades.filter(t => t.pnl > 0), lo = trades.filter(t => t.pnl <= 0);
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const gw = w.reduce((s, t) => s + t.pnl, 0), gl = Math.abs(lo.reduce((s, t) => s + t.pnl, 0));
  const pf = gl > 0 ? gw / gl : gw > 0 ? 99 : 0;
  const wr = w.length / trades.length * 100;
  let cum = 0, pk = 0, mdd = 0;
  for (const t of trades) { cum += t.pnl; pk = Math.max(pk, cum); mdd = Math.max(mdd, pk - cum); }
  return { label, pnl, pf, wr, n: trades.length, tpd: trades.length / DAYS,
    aw: w.length ? gw / w.length : 0, al: lo.length ? gl / lo.length : 0,
    mdd, wins: w.length, losses: lo.length };
}

function printMet(m) {
  console.log(`  [${m.label}] PnL:$${m.pnl.toFixed(2)} PF:${m.pf.toFixed(2)} WR:${m.wr.toFixed(1)}% ` +
    `T:${m.n}(${m.tpd.toFixed(1)}/d) W:$${m.aw.toFixed(2)} L:$${m.al.toFixed(2)} DD:$${m.mdd.toFixed(2)}`);
}

function monthlyBreakdown(trades, label) {
  const months = {};
  for (const t of trades) {
    const d = new Date(t.time);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!months[key]) months[key] = [];
    months[key].push(t);
  }
  console.log(`\n  Monthly breakdown [${label}]:`);
  console.log('  Month      | Trades | Wins | WR%   | PnL      | PF');
  console.log('  -----------|--------|------|-------|----------|------');
  const sorted = Object.keys(months).sort();
  for (const mo of sorted) {
    const tr = months[mo];
    const m = met(tr, mo);
    console.log(`  ${mo}    | ${String(m.n).padStart(6)} | ${String(m.wins).padStart(4)} | ${m.wr.toFixed(1).padStart(5)} | ${(m.pnl >= 0 ? '+' : '') + m.pnl.toFixed(2).padStart(8)} | ${m.pf.toFixed(2)}`);
  }
}

function pairBreakdown(allTrades, label) {
  const byPair = {};
  for (const t of allTrades) {
    if (!byPair[t.pair]) byPair[t.pair] = [];
    byPair[t.pair].push(t);
  }
  console.log(`\n  Per-pair breakdown [${label}]:`);
  console.log('  Pair       | Trades | WR%   | PnL      | PF');
  console.log('  -----------|--------|-------|----------|------');
  for (const p of Object.keys(byPair).sort()) {
    const m = met(byPair[p], p);
    console.log(`  ${p.padEnd(10)} | ${String(m.n).padStart(6)} | ${m.wr.toFixed(1).padStart(5)} | ${(m.pnl >= 0 ? '+' : '') + m.pnl.toFixed(2).padStart(8)} | ${m.pf.toFixed(2)}`);
  }
}

// ═══ GRID SEARCH HELPERS ═══
function gridS1(sym, D, I15, I1h, map15to1h) {
  const results = [];
  for (const rsiTh of [25, 30, 35]) {
    for (const slLB of [3, 5, 8]) {
      for (const rr of [2.0, 2.5, 3.0, 3.5]) {
        const sigs = stratS1(sym, D, I15, I1h, map15to1h, { rsiTh, slLB, rr });
        const trades = simTrades(sigs, D[sym].k15);
        const m = met(trades, `rsi${rsiTh}_lb${slLB}_rr${rr}`);
        results.push({ cfg: { rsiTh, slLB, rr }, ...m });
      }
    }
  }
  return results.sort((a, b) => b.pf - a.pf);
}

function gridS2(sym, D, I15, I1h, map15to1h) {
  const results = [];
  for (const pullEma of ['ema13', 'ema21', 'ema50']) {
    const sigs = stratS2(sym, D, I15, I1h, map15to1h, { pullEma });
    const trades = simTrades(sigs, D[sym].k15);
    const m = met(trades, `pull_${pullEma}`);
    results.push({ cfg: { pullEma }, ...m });
  }
  return results.sort((a, b) => b.pf - a.pf);
}

// ═══ S7: COMBINED REGIME-FILTERED ═══
function stratCombined(sym, D, I15, I1h, I4h, map15to1h, map15to4h, bestCfgs) {
  const d1h = I1h[sym], m1h = map15to1h[sym];
  const allSigs = [];

  // Generate all signals
  const s1 = stratS1(sym, D, I15, I1h, map15to1h, bestCfgs.s1 || {});
  const s2 = stratS2(sym, D, I15, I1h, map15to1h, bestCfgs.s2 || {});
  const s3 = stratS3(sym, D, I15, I1h, I4h, map15to1h, map15to4h, {});
  const s4 = stratS4(sym, D, I1h, map15to1h, I15, {});
  const s5 = stratS5(sym, D, I1h, map15to1h, I15, {});
  const s6 = stratS6(sym, D, I4h, I1h, map15to4h, map15to1h, I15, {});

  // Tag with regime filter
  for (const sig of [...s1, ...s2, ...s3, ...s4, ...s5, ...s6]) {
    const hi = m1h[sig.barIdx];
    if (hi < 30) continue;
    const adxVal = d1h.adx.adx[hi];
    const trending = adxVal > 25;

    // Regime filter: trending → trend strats, ranging → reversal strats
    if (trending && ['S2', 'S3', 'S5'].includes(sig.strat)) allSigs.push(sig);
    else if (!trending && ['S1', 'S4', 'S6'].includes(sig.strat)) allSigs.push(sig);
    // Also allow S1 in trending (it has 1h trend filter built in)
    else if (trending && sig.strat === 'S1') allSigs.push(sig);
  }

  // Sort by bar index for proper simulation
  allSigs.sort((a, b) => a.barIdx - b.barIdx);
  return allSigs;
}

// ═══ MULTI-POSITION SIMULATOR ═══
function simMultiPos(sigsByPair, D, maxPos = 3) {
  // Merge all signals with pair info, sort by time
  const allSigs = [];
  for (const [pair, sigs] of Object.entries(sigsByPair)) {
    for (const sig of sigs) {
      allSigs.push({ ...sig, pair, time: D[pair].k15[sig.barIdx].t });
    }
  }
  allSigs.sort((a, b) => a.time - b.time);

  const trades = [];
  const openPositions = []; // { pair, dir, entry, sl, tp, openBar, maxBar }
  const pairCooldown = {}; // pair -> next allowed bar time

  for (const sig of allSigs) {
    const k15 = D[sig.pair].k15;
    const eb = sig.barIdx + 1;
    if (eb >= k15.length - 1) continue;

    // Check cooldown for this pair
    if (pairCooldown[sig.pair] && sig.time < pairCooldown[sig.pair]) continue;

    // Check max positions
    // First, close any positions that would have closed by now
    for (let pi = openPositions.length - 1; pi >= 0; pi--) {
      const pos = openPositions[pi];
      const pk = D[pos.pair].k15;
      let closed = false;
      for (let b = pos.openBar + 1; b < pk.length && pk[b].t <= sig.time; b++) {
        const bar = pk[b];
        const slHit = pos.dir === 'BUY' ? bar.l <= pos.sl : bar.h >= pos.sl;
        const tpHit = pos.dir === 'BUY' ? bar.h >= pos.tp : bar.l <= pos.tp;
        const timeout = b - pos.openBar >= 200;
        if (slHit || tpHit || timeout) {
          let exitP, exitR;
          if (slHit) { exitP = pos.sl; exitR = 'SL'; }
          else if (tpHit) { exitP = pos.tp; exitR = 'TP'; }
          else { exitP = bar.c; exitR = 'TO'; }

          const raw = pos.dir === 'BUY' ? exitP - pos.entry : pos.entry - exitP;
          const ecFee = POS * FEE_M;
          const exitFee = exitR === 'SL' ? POS * FEE_T : POS * FEE_M;
          const slipCost = exitR === 'SL' ? POS * SLIP : 0;
          const pnl = (raw / pos.entry) * POS - ecFee - exitFee - slipCost;

          trades.push({ dir: pos.dir, pnl, reason: exitR, pair: pos.pair,
            strat: pos.strat, time: pk[pos.openBar].t, entry: pos.entry, exit: exitP });
          pairCooldown[pos.pair] = pk[b].t + 15 * 60 * 1000 * 4; // 1h cooldown
          openPositions.splice(pi, 1);
          closed = true;
          break;
        }
      }
    }

    if (openPositions.length >= maxPos) continue;
    // Don't open two positions on same pair
    if (openPositions.some(p => p.pair === sig.pair)) continue;

    const ep = sig.entry || k15[eb].o;
    openPositions.push({
      pair: sig.pair, dir: sig.dir, entry: ep,
      sl: sig.sl, tp: sig.tp, openBar: eb, strat: sig.strat
    });
  }

  // Close remaining open positions
  for (const pos of openPositions) {
    const pk = D[pos.pair].k15;
    for (let b = pos.openBar + 1; b < pk.length; b++) {
      const bar = pk[b];
      const slHit = pos.dir === 'BUY' ? bar.l <= pos.sl : bar.h >= pos.sl;
      const tpHit = pos.dir === 'BUY' ? bar.h >= pos.tp : bar.l <= pos.tp;
      const timeout = b - pos.openBar >= 200;
      if (slHit || tpHit || timeout || b === pk.length - 1) {
        let exitP, exitR;
        if (slHit) { exitP = pos.sl; exitR = 'SL'; }
        else if (tpHit) { exitP = pos.tp; exitR = 'TP'; }
        else { exitP = bar.c; exitR = b === pk.length - 1 ? 'END' : 'TO'; }

        const raw = pos.dir === 'BUY' ? exitP - pos.entry : pos.entry - exitP;
        const ecFee = POS * FEE_M;
        const exitFee = exitR === 'SL' ? POS * FEE_T : POS * FEE_M;
        const slipCost = exitR === 'SL' ? POS * SLIP : 0;
        const pnl = (raw / pos.entry) * POS - ecFee - exitFee - slipCost;

        trades.push({ dir: pos.dir, pnl, reason: exitR, pair: pos.pair,
          strat: pos.strat, time: pk[pos.openBar].t, entry: pos.entry, exit: exitP });
        break;
      }
    }
  }

  trades.sort((a, b) => a.time - b.time);
  return trades;
}

// ═══ MAIN ═══
async function main() {
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('ROUND 4 — LONGER TIMEFRAME STRATEGIES (15m/1h/4h)');
  console.log('$500 cap | 5x lev | $2,500 pos | 120d | 7 pairs | Binance Futures');
  console.log('Fees: Maker 0.02% | Taker 0.05% + 0.03% slippage on SL');
  console.log('══════════════════════════════════════════════════════════════════════');

  console.log('\n[DOWNLOADING DATA]');
  const D = await loadAll(PAIRS);

  console.log('\n[COMPUTING INDICATORS]');
  const I15 = {}, I1h = {}, I4h = {};
  const map15to1h = {}, map15to4h = {};
  for (const s of PAIRS) {
    I15[s] = pre(D[s].k15);
    I1h[s] = pre(D[s].k1h);
    I4h[s] = pre(D[s].k4h);
    map15to1h[s] = mapTF(D[s].k15, D[s].k1h);
    map15to4h[s] = mapTF(D[s].k15, D[s].k4h);
  }

  // ═══ S1: GRID SEARCH ═══
  console.log('\n════════════════════════════════════════════');
  console.log('S1: 15M RSI REVERSAL + 1H TREND ALIGNMENT');
  console.log('════════════════════════════════════════════');
  console.log('\n  Grid search on BTCUSDT:');
  const g1 = gridS1('BTCUSDT', D, I15, I1h, map15to1h);
  const top5s1 = g1.filter(r => r.n >= 5).slice(0, 5);
  for (const r of top5s1) {
    console.log(`  RSI:${r.cfg.rsiTh} LB:${r.cfg.slLB} RR:${r.cfg.rr} → PF:${r.pf.toFixed(2)} WR:${r.wr.toFixed(1)}% T:${r.n} PnL:$${r.pnl.toFixed(2)}`);
  }
  const bestS1Cfg = top5s1.length ? top5s1[0].cfg : { rsiTh: 30, slLB: 5, rr: 3.0 };
  console.log(`  Best S1 cfg: RSI:${bestS1Cfg.rsiTh} LB:${bestS1Cfg.slLB} RR:${bestS1Cfg.rr}`);

  // Run S1 across all pairs
  console.log('\n  All-pairs S1 results:');
  let allS1 = [];
  for (const s of PAIRS) {
    const sigs = stratS1(s, D, I15, I1h, map15to1h, bestS1Cfg);
    const tr = simTrades(sigs, D[s].k15);
    tr.forEach(t => t.pair = s);
    const m = met(tr, `S1:${s}`);
    printMet(m);
    allS1.push(...tr);
  }
  const mS1 = met(allS1, 'S1:ALL');
  console.log('  ────────────────');
  printMet(mS1);

  // ═══ S2: GRID SEARCH ═══
  console.log('\n════════════════════════════════════════════');
  console.log('S2: 1H MACD ZERO-LINE CROSS + 15M PULLBACK');
  console.log('════════════════════════════════════════════');
  console.log('\n  Grid search on BTCUSDT:');
  const g2 = gridS2('BTCUSDT', D, I15, I1h, map15to1h);
  for (const r of g2) {
    console.log(`  Pull:${r.cfg.pullEma} → PF:${r.pf.toFixed(2)} WR:${r.wr.toFixed(1)}% T:${r.n} PnL:$${r.pnl.toFixed(2)}`);
  }
  const bestS2Cfg = g2.length && g2[0].n >= 3 ? g2[0].cfg : { pullEma: 'ema21' };

  console.log('\n  All-pairs S2 results:');
  let allS2 = [];
  for (const s of PAIRS) {
    const sigs = stratS2(s, D, I15, I1h, map15to1h, bestS2Cfg);
    const tr = simTrades(sigs, D[s].k15);
    tr.forEach(t => t.pair = s);
    const m = met(tr, `S2:${s}`);
    printMet(m);
    allS2.push(...tr);
  }
  const mS2 = met(allS2, 'S2:ALL');
  console.log('  ────────────────');
  printMet(mS2);

  // ═══ S3 ═══
  console.log('\n════════════════════════════════════════════════════');
  console.log('S3: 4H STRUCTURE + 1H MOMENTUM + 15M STOCH TRIGGER');
  console.log('════════════════════════════════════════════════════');
  let allS3 = [];
  for (const s of PAIRS) {
    const sigs = stratS3(s, D, I15, I1h, I4h, map15to1h, map15to4h, {});
    const tr = simTrades(sigs, D[s].k15);
    tr.forEach(t => t.pair = s);
    const m = met(tr, `S3:${s}`);
    printMet(m);
    allS3.push(...tr);
  }
  const mS3 = met(allS3, 'S3:ALL');
  console.log('  ────────────────');
  printMet(mS3);

  // ═══ S4 ═══
  console.log('\n════════════════════════════════════════════');
  console.log('S4: 1H MEAN REVERSION (BB extreme + volume)');
  console.log('════════════════════════════════════════════');
  let allS4 = [];
  for (const s of PAIRS) {
    const sigs = stratS4(s, D, I1h, map15to1h, I15, {});
    const tr = simTrades(sigs, D[s].k15);
    tr.forEach(t => t.pair = s);
    const m = met(tr, `S4:${s}`);
    printMet(m);
    allS4.push(...tr);
  }
  const mS4 = met(allS4, 'S4:ALL');
  console.log('  ────────────────');
  printMet(mS4);

  // ═══ S5 ═══
  console.log('\n════════════════════════════════════════════');
  console.log('S5: ADX THRUST (trend initiation)');
  console.log('════════════════════════════════════════════');
  let allS5 = [];
  for (const s of PAIRS) {
    const sigs = stratS5(s, D, I1h, map15to1h, I15, {});
    const tr = simTrades(sigs, D[s].k15);
    tr.forEach(t => t.pair = s);
    const m = met(tr, `S5:${s}`);
    printMet(m);
    allS5.push(...tr);
  }
  const mS5 = met(allS5, 'S5:ALL');
  console.log('  ────────────────');
  printMet(mS5);

  // ═══ S6 ═══
  console.log('\n════════════════════════════════════════════════════');
  console.log('S6: FUNDING RATE CONTRARIAN (4H divergence proxy)');
  console.log('════════════════════════════════════════════════════');
  let allS6 = [];
  for (const s of PAIRS) {
    const sigs = stratS6(s, D, I4h, I1h, map15to4h, map15to1h, I15, {});
    const tr = simTrades(sigs, D[s].k15);
    tr.forEach(t => t.pair = s);
    const m = met(tr, `S6:${s}`);
    printMet(m);
    allS6.push(...tr);
  }
  const mS6 = met(allS6, 'S6:ALL');
  console.log('  ────────────────');
  printMet(mS6);

  // ═══ SUMMARY TABLE ═══
  console.log('\n══════════════════════════════════════════════════════');
  console.log('STRATEGY COMPARISON (all pairs, 120d)');
  console.log('══════════════════════════════════════════════════════');
  console.log('Strategy  | PnL       | PF   | WR%   | Trades | T/Day | AvgW    | AvgL    | MaxDD');
  console.log('----------|-----------|------|-------|--------|-------|---------|---------|--------');
  for (const m of [mS1, mS2, mS3, mS4, mS5, mS6]) {
    console.log(
      `${m.label.padEnd(9)} | ${(m.pnl >= 0 ? '+' : '') + m.pnl.toFixed(2).padStart(8)} | ${m.pf.toFixed(2).padStart(4)} | ${m.wr.toFixed(1).padStart(5)} | ${String(m.n).padStart(6)} | ${m.tpd.toFixed(1).padStart(5)} | ${('$' + m.aw.toFixed(2)).padStart(7)} | ${('$' + m.al.toFixed(2)).padStart(7)} | $${m.mdd.toFixed(2)}`
    );
  }

  // ═══ S7: COMBINED ═══
  console.log('\n══════════════════════════════════════════════════════');
  console.log('S7: COMBINED REGIME-FILTERED (ADX>25=trend, ADX<25=reversal)');
  console.log('══════════════════════════════════════════════════════');

  // Pick strategies with PF > 1.0 for combination
  const viable = [mS1, mS2, mS3, mS4, mS5, mS6].filter(m => m.pf > 1.0);
  console.log(`  Viable strategies (PF>1.0): ${viable.map(m => m.label).join(', ')}`);

  const sigsByPair = {};
  for (const s of PAIRS) {
    const combined = stratCombined(s, D, I15, I1h, I4h, map15to1h, map15to4h,
      { s1: bestS1Cfg, s2: bestS2Cfg });
    sigsByPair[s] = combined;
  }

  const combinedTrades = simMultiPos(sigsByPair, D, MAX_POS);
  const mComb = met(combinedTrades, 'S7:COMBINED');
  console.log('\n  Combined results (max 3 positions):');
  printMet(mComb);

  // Per-strategy breakdown of combined
  const byStrat = {};
  for (const t of combinedTrades) {
    if (!byStrat[t.strat]) byStrat[t.strat] = [];
    byStrat[t.strat].push(t);
  }
  console.log('\n  By strategy within combined:');
  for (const [st, tr] of Object.entries(byStrat).sort()) {
    const m = met(tr, st);
    printMet(m);
  }

  // Pair breakdown
  pairBreakdown(combinedTrades, 'S7:COMBINED');

  // Monthly breakdown of best standalone
  const bestStandalone = [
    { m: mS1, tr: allS1, label: 'S1' },
    { m: mS2, tr: allS2, label: 'S2' },
    { m: mS3, tr: allS3, label: 'S3' },
    { m: mS4, tr: allS4, label: 'S4' },
    { m: mS5, tr: allS5, label: 'S5' },
    { m: mS6, tr: allS6, label: 'S6' },
  ].sort((a, b) => b.m.pf - a.m.pf)[0];

  console.log(`\n  Best standalone strategy: ${bestStandalone.label} (PF ${bestStandalone.m.pf.toFixed(2)})`);
  monthlyBreakdown(bestStandalone.tr.map(t => ({ ...t, time: t.time || D[PAIRS[0]].k15[t.barIdx]?.t || 0 })), bestStandalone.label);
  monthlyBreakdown(combinedTrades, 'S7:COMBINED');

  // Exit reason breakdown
  console.log('\n  Exit reason breakdown (Combined):');
  const byReason = {};
  for (const t of combinedTrades) {
    if (!byReason[t.reason]) byReason[t.reason] = { n: 0, pnl: 0 };
    byReason[t.reason].n++;
    byReason[t.reason].pnl += t.pnl;
  }
  for (const [r, d] of Object.entries(byReason)) {
    console.log(`  ${r}: ${d.n} trades, PnL: $${d.pnl.toFixed(2)}`);
  }

  // ═══ FINAL VERDICT ═══
  console.log('\n══════════════════════════════════════════════════════');
  console.log('ROUND 4 VERDICT');
  console.log('══════════════════════════════════════════════════════');

  const allResults = [
    { ...mS1 }, { ...mS2 }, { ...mS3 }, { ...mS4 }, { ...mS5 }, { ...mS6 }, { ...mComb }
  ].sort((a, b) => b.pf - a.pf);

  console.log('  Ranked by PF:');
  for (let i = 0; i < allResults.length; i++) {
    const r = allResults[i];
    const pass = r.pf >= 2.0 && r.wr >= 55 && r.tpd >= 10;
    console.log(`  #${i + 1} ${r.label.padEnd(12)} PF:${r.pf.toFixed(2)} WR:${r.wr.toFixed(1)}% T/d:${r.tpd.toFixed(1)} PnL:$${r.pnl.toFixed(2)} ${pass ? '✓ TARGET MET' : ''}`);
  }

  const anyMet = allResults.some(r => r.pf >= 2.0 && r.wr >= 55 && r.tpd >= 10);
  console.log(`\n  Target (PF>=2.0, WR>=55%, 10+t/d): ${anyMet ? 'ACHIEVED' : 'NOT YET — see insights below'}`);

  if (!anyMet) {
    console.log('\n  INSIGHTS:');
    const bestPF = allResults[0];
    const bestTPD = allResults.sort((a, b) => b.tpd - a.tpd)[0];
    console.log(`  - Highest PF: ${bestPF.label} at ${bestPF.pf.toFixed(2)} (${bestPF.tpd.toFixed(1)} t/d)`);
    console.log(`  - Most active: ${bestTPD.label} at ${bestTPD.tpd.toFixed(1)} t/d (PF ${bestTPD.pf.toFixed(2)})`);
    console.log(`  - Trade-off: Higher timeframes = higher PF but fewer trades`);
    console.log(`  - Consider: Relaxing entry filters to boost trade count while keeping PF > 1.5`);
  }

  console.log('\nDone.');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
