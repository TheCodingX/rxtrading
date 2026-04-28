#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY ROUND 3 — Relaxed D + Trend C + Sniper Entry + Trailing + Filters
// Target: PF >= 2.0, WR >= 55%, 10+ trades/day
// Building on Round 2 best: D (PF 1.68, WR 52.6%, 1.4/day) + C (PF 1.13, 4.7/day)
// ═══════════════════════════════════════════════════════════════════════════════
const https = require('https');

// ─── CONFIG ───
const PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT'];
const DAYS = 120;
const INIT_CAP = 500, LEV = 5;
const FEE_MAKER = 0.0002, FEE_TAKER = 0.0005, SLIP_SL = 0.0003;
const FILL_RATE = 0.80;
const MAX_POSITIONS = 3;
const TIMEOUT_BARS = 200;
const ENTRY_DELAY = 2;

// ─── HTTP FETCH ───
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Parse error: ' + d.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getKlines(sym, interval, days) {
  const end = Date.now(), start = end - days * 86400000;
  let all = [], t = start;
  const base = 'https://api.binance.com/api/v3/klines';
  while (t < end) {
    const url = `${base}?symbol=${sym}&interval=${interval}&startTime=${Math.floor(t)}&limit=1000`;
    let retries = 3, k;
    while (retries > 0) {
      try { k = await fetchJSON(url); break; }
      catch (e) { retries--; if (retries === 0) { console.error(`  FAIL ${sym} ${interval}: ${e.message}`); return all; } await sleep(2000); }
    }
    if (!k || !k.length) break;
    all = all.concat(k);
    t = parseInt(k[k.length - 1][6]) + 1;
    await sleep(150);
  }
  return all;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseKlines(klines) {
  return klines.map(k => ({
    t: parseInt(k[0]), o: parseFloat(k[1]), h: parseFloat(k[2]),
    l: parseFloat(k[3]), c: parseFloat(k[4]), v: parseFloat(k[5]),
    tClose: parseInt(k[6])
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATORS
// ═══════════════════════════════════════════════════════════════════════════════

function sma(arr, p) {
  const r = new Array(arr.length); let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i]; if (i >= p) sum -= arr[i - p];
    r[i] = i < p - 1 ? NaN : sum / p;
  }
  return r;
}

function ema(arr, p) {
  const r = new Array(arr.length); const m = 2 / (p + 1);
  r[0] = arr[0];
  for (let i = 1; i < arr.length; i++) r[i] = arr[i] * m + r[i - 1] * (1 - m);
  return r;
}

function rsi(closes, p = 14) {
  const r = new Array(closes.length).fill(NaN);
  if (closes.length < p + 1) return r;
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) ag += d; else al -= d; }
  ag /= p; al /= p;
  r[p] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
    r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return r;
}

function bbandsP(closes, p = 20, mult = 2) {
  const mid = sma(closes, p), up = new Array(closes.length), dn = new Array(closes.length);
  const width = new Array(closes.length);
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(mid[i])) { up[i] = NaN; dn[i] = NaN; width[i] = NaN; continue; }
    let ss = 0;
    for (let j = i - p + 1; j <= i; j++) ss += (closes[j] - mid[i]) ** 2;
    const std = Math.sqrt(ss / p);
    up[i] = mid[i] + mult * std;
    dn[i] = mid[i] - mult * std;
    width[i] = mid[i] > 0 ? (up[i] - dn[i]) / mid[i] : 0;
  }
  return { mid, up, dn, width };
}

function macd(closes, f = 12, s = 26, sig = 9) {
  const ef = ema(closes, f), es = ema(closes, s);
  const line = ef.map((v, i) => v - es[i]);
  const signal = ema(line, sig);
  const hist = line.map((v, i) => v - signal[i]);
  return { line, signal, hist };
}

function adxCalc(highs, lows, closes, p = 14) {
  const n = closes.length;
  const tr = [0], pdm = [0], ndm = [0];
  for (let i = 1; i < n; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    const up = highs[i] - highs[i - 1], dn = lows[i - 1] - lows[i];
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
  }
  const atrArr = ema(tr, p), spdm = ema(pdm, p), sndm = ema(ndm, p);
  const pdi = spdm.map((v, i) => atrArr[i] ? v / atrArr[i] * 100 : 0);
  const ndi = sndm.map((v, i) => atrArr[i] ? v / atrArr[i] * 100 : 0);
  const dx = pdi.map((v, i) => { const s = v + ndi[i]; return s ? Math.abs(v - ndi[i]) / s * 100 : 0; });
  return { adx: ema(dx, p), pdi, ndi, atr: atrArr };
}

function atr(highs, lows, closes, p = 14) {
  const tr = [0];
  for (let i = 1; i < closes.length; i++)
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  return ema(tr, p);
}

function volRatio(volumes, p = 20) {
  const avg = sma(volumes, p);
  return volumes.map((v, i) => isNaN(avg[i]) || avg[i] === 0 ? 1 : v / avg[i]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR PRE-COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

function computeIndicators(kl, bbPeriod = 20) {
  const c = kl.map(k => k.c), h = kl.map(k => k.h), l = kl.map(k => k.l);
  const o = kl.map(k => k.o), v = kl.map(k => k.v);
  return {
    c, h, l, o, v,
    rsi14: rsi(c, 14),
    rsi7: rsi(c, 7),
    macdData: macd(c),
    bb: bbandsP(c, bbPeriod, 2),
    ema9: ema(c, 9), ema21: ema(c, 21), ema50: ema(c, 50),
    adxData: adxCalc(h, l, c, 14),
    atr14: atr(h, l, c, 14),
    volR: volRatio(v, 20),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE — Enhanced with trailing, split exits, ATR-based SL/TP
// ═══════════════════════════════════════════════════════════════════════════════

function runBacktest(allSignals, allKl, cfg = {}) {
  const defaultSlPct = cfg.sl || 0.005;
  const defaultTpPct = cfg.tp || 0.015;
  const useTrailing = cfg.trailing || false;
  const trailATRMult = cfg.trailATRMult || 2.0;
  const trailSplit = cfg.trailSplit || false; // 50% fixed TP, 50% trailing
  const useATRSLTP = cfg.atrSLTP || false;
  const atrSLMult = cfg.atrSLMult || 1.0;
  const atrRR = cfg.atrRR || 2.5;

  const positions = [];
  const trades = [];
  let fillSeq = 0;

  // Pre-compute ATR for trailing/dynamic SL
  const atrCache = {};
  for (const pair of PAIRS) {
    if (allKl[pair]) {
      const c = allKl[pair].map(k => k.c);
      const h = allKl[pair].map(k => k.h);
      const l = allKl[pair].map(k => k.l);
      atrCache[pair] = atr(h, l, c, 14);
    }
  }

  const sortedSigs = allSignals.slice().sort((a, b) => {
    const tA = allKl[a.pair][Math.min(a.bar, allKl[a.pair].length - 1)].t;
    const tB = allKl[b.pair][Math.min(b.bar, allKl[b.pair].length - 1)].t;
    return tA - tB;
  });

  for (const sig of sortedSigs) {
    const kl = allKl[sig.pair];
    const entryBar = sig.bar + ENTRY_DELAY;
    if (entryBar >= kl.length) continue;

    fillSeq++;
    if (fillSeq % 5 === 0) continue; // 80% fill rate

    if (positions.length >= MAX_POSITIONS) {
      resolvePositions(positions, trades, allKl, kl[entryBar].t, atrCache, trailATRMult);
      if (positions.length >= MAX_POSITIONS) continue;
    }

    const entryPrice = kl[entryBar].o;
    let useSlPct = sig.sl || defaultSlPct;
    let useTpPct = sig.tp || defaultTpPct;

    // ATR-based dynamic SL/TP
    if (useATRSLTP && atrCache[sig.pair] && entryBar < atrCache[sig.pair].length) {
      const atrVal = atrCache[sig.pair][entryBar];
      if (atrVal > 0 && entryPrice > 0) {
        useSlPct = (atrVal * atrSLMult) / entryPrice;
        useTpPct = (atrVal * atrSLMult * atrRR) / entryPrice;
      }
    }

    const slPrice = sig.dir === 1 ? entryPrice * (1 - useSlPct) : entryPrice * (1 + useSlPct);

    // Position sizing: risk 2% of capital per trade
    const maxRisk = INIT_CAP * 0.02;
    const slDist = useSlPct * entryPrice;
    const qtyByRisk = slDist > 0 ? maxRisk / slDist : 0;
    const qtyByLev = (INIT_CAP * LEV) / entryPrice;
    const qty = Math.min(qtyByRisk, qtyByLev);
    if (qty <= 0) continue;

    if (trailSplit) {
      // Split position: 50% fixed TP, 50% trailing
      const halfQty = qty / 2;
      const tpPrice = sig.dir === 1 ? entryPrice * (1 + useTpPct) : entryPrice * (1 - useTpPct);

      // Fixed TP half
      positions.push({
        pair: sig.pair, dir: sig.dir, entry: entryPrice,
        sl: slPrice, tp: tpPrice, qty: halfQty, bar: entryBar,
        slPct: useSlPct, tpPct: useTpPct, posSize: halfQty * entryPrice,
        trailing: false, highWater: entryPrice, lowWater: entryPrice,
        stratLabel: sig.stratLabel || ''
      });

      // Trailing half
      positions.push({
        pair: sig.pair, dir: sig.dir, entry: entryPrice,
        sl: slPrice, tp: null, qty: halfQty, bar: entryBar,
        slPct: useSlPct, tpPct: useTpPct, posSize: halfQty * entryPrice,
        trailing: true, highWater: entryPrice, lowWater: entryPrice,
        stratLabel: sig.stratLabel || ''
      });
    } else if (useTrailing) {
      positions.push({
        pair: sig.pair, dir: sig.dir, entry: entryPrice,
        sl: slPrice, tp: null, qty, bar: entryBar,
        slPct: useSlPct, tpPct: useTpPct, posSize: qty * entryPrice,
        trailing: true, highWater: entryPrice, lowWater: entryPrice,
        stratLabel: sig.stratLabel || ''
      });
    } else {
      const tpPrice = sig.dir === 1 ? entryPrice * (1 + useTpPct) : entryPrice * (1 - useTpPct);
      positions.push({
        pair: sig.pair, dir: sig.dir, entry: entryPrice,
        sl: slPrice, tp: tpPrice, qty, bar: entryBar,
        slPct: useSlPct, tpPct: useTpPct, posSize: qty * entryPrice,
        trailing: false, highWater: entryPrice, lowWater: entryPrice,
        stratLabel: sig.stratLabel || ''
      });
    }
  }

  resolveAllPositions(positions, trades, allKl, atrCache, trailATRMult);
  return computeStats(trades);
}

function resolvePositions(positions, trades, allKl, currentTime, atrCache, trailATRMult) {
  for (let p = positions.length - 1; p >= 0; p--) {
    const pos = positions[p];
    const kl = allKl[pos.pair];
    let closed = false;
    for (let j = pos.bar + 1; j < kl.length && j <= pos.bar + TIMEOUT_BARS; j++) {
      if (kl[j].t > currentTime) break;
      updateTrailing(pos, kl[j], atrCache, trailATRMult, j);
      const result = checkExit(pos, kl[j]);
      if (result) {
        recordTrade(trades, pos, result, kl[j].t);
        positions.splice(p, 1);
        closed = true;
        break;
      }
    }
    if (!closed && pos.bar + TIMEOUT_BARS < kl.length) {
      const exitBar = Math.min(pos.bar + TIMEOUT_BARS, kl.length - 1);
      if (kl[exitBar].t <= currentTime) {
        recordTrade(trades, pos, { type: 'TO', price: kl[exitBar].c }, kl[exitBar].t);
        positions.splice(p, 1);
      }
    }
  }
}

function resolveAllPositions(positions, trades, allKl, atrCache, trailATRMult) {
  while (positions.length > 0) {
    const pos = positions.pop();
    const kl = allKl[pos.pair];
    let closed = false;
    for (let j = pos.bar + 1; j < kl.length && j <= pos.bar + TIMEOUT_BARS; j++) {
      updateTrailing(pos, kl[j], atrCache, trailATRMult, j);
      const result = checkExit(pos, kl[j]);
      if (result) {
        recordTrade(trades, pos, result, kl[j].t);
        closed = true;
        break;
      }
    }
    if (!closed) {
      const exitBar = Math.min(pos.bar + TIMEOUT_BARS, kl.length - 1);
      recordTrade(trades, pos, { type: 'TO', price: kl[exitBar].c }, kl[exitBar].t);
    }
  }
}

function updateTrailing(pos, bar, atrCache, trailATRMult, barIdx) {
  if (!pos.trailing) return;
  if (pos.dir === 1) {
    if (bar.h > pos.highWater) {
      pos.highWater = bar.h;
      const atrVal = atrCache && atrCache[pos.pair] && barIdx < atrCache[pos.pair].length
        ? atrCache[pos.pair][barIdx] : 0;
      if (atrVal > 0) {
        const newTrail = pos.highWater - atrVal * trailATRMult;
        if (newTrail > pos.sl) pos.sl = newTrail;
      }
    }
  } else {
    if (bar.l < pos.lowWater) {
      pos.lowWater = bar.l;
      const atrVal = atrCache && atrCache[pos.pair] && barIdx < atrCache[pos.pair].length
        ? atrCache[pos.pair][barIdx] : 0;
      if (atrVal > 0) {
        const newTrail = pos.lowWater + atrVal * trailATRMult;
        if (newTrail < pos.sl) pos.sl = newTrail;
      }
    }
  }
}

function checkExit(pos, bar) {
  let hitSL = false, hitTP = false;
  if (pos.dir === 1) {
    hitSL = bar.l <= pos.sl;
    hitTP = pos.tp !== null && bar.h >= pos.tp;
  } else {
    hitSL = bar.h >= pos.sl;
    hitTP = pos.tp !== null && bar.l <= pos.tp;
  }
  if (hitSL && hitTP) hitTP = false;
  if (hitSL) {
    const slip = pos.dir === 1 ? (1 - SLIP_SL) : (1 + SLIP_SL);
    return { type: pos.trailing ? 'TRAIL' : 'SL', price: pos.sl * slip };
  }
  if (hitTP) return { type: 'TP', price: pos.tp };
  return null;
}

function recordTrade(trades, pos, result, exitTime) {
  const pnl = pos.dir === 1
    ? (result.price - pos.entry) * pos.qty
    : (pos.entry - result.price) * pos.qty;
  const posSize = pos.posSize || (pos.qty * pos.entry);
  const fees = posSize * FEE_MAKER + posSize * (result.type === 'SL' || result.type === 'TRAIL' ? FEE_TAKER : FEE_MAKER);
  const net = pnl - fees;
  trades.push({
    pair: pos.pair, dir: pos.dir, entry: pos.entry,
    exit: result.price, pnl: net, type: result.type,
    slPct: pos.slPct, tpPct: pos.tpPct,
    exitTime: exitTime || 0,
    stratLabel: pos.stratLabel || ''
  });
}

function computeStats(trades) {
  if (trades.length === 0) return {
    pf: 0, wr: 0, trades: 0, tradesPerDay: 0, pnl: 0,
    maxDD: 0, avgWin: 0, avgLoss: 0, grossProfit: 0, grossLoss: 0,
    perPair: {}, perMonth: {}, rawTrades: []
  };
  let grossProfit = 0, grossLoss = 0, wins = 0;
  let equity = INIT_CAP, peak = INIT_CAP, maxDD = 0;
  const perPair = {};
  const perMonth = {};

  for (const t of trades) {
    if (t.pnl > 0) { grossProfit += t.pnl; wins++; }
    else grossLoss += Math.abs(t.pnl);
    equity += t.pnl;
    peak = Math.max(peak, equity);
    const dd = (peak - equity) / peak;
    maxDD = Math.max(maxDD, dd);

    if (!perPair[t.pair]) perPair[t.pair] = { gp: 0, gl: 0, n: 0, w: 0 };
    const pp = perPair[t.pair];
    pp.n++;
    if (t.pnl > 0) { pp.gp += t.pnl; pp.w++; } else pp.gl += Math.abs(t.pnl);

    if (t.exitTime) {
      const d = new Date(t.exitTime);
      const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!perMonth[mk]) perMonth[mk] = { gp: 0, gl: 0, n: 0, w: 0 };
      const pm = perMonth[mk];
      pm.n++;
      if (t.pnl > 0) { pm.gp += t.pnl; pm.w++; } else pm.gl += Math.abs(t.pnl);
    }
  }

  return {
    pf: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    wr: trades.length > 0 ? (wins / trades.length * 100) : 0,
    trades: trades.length,
    tradesPerDay: trades.length / DAYS,
    pnl: equity - INIT_CAP,
    maxDD: maxDD * 100,
    avgWin: wins > 0 ? grossProfit / wins : 0,
    avgLoss: (trades.length - wins) > 0 ? grossLoss / (trades.length - wins) : 0,
    grossProfit, grossLoss, perPair, perMonth,
    rawTrades: trades
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY D — RELAXED VOLATILITY CONTRACTION BREAKOUT
// Params: squeezeDuration, widthPctile, volMult, bbPeriod
// ═══════════════════════════════════════════════════════════════════════════════

function strategyDRelaxed(kl, ind, params = {}) {
  const squeezeDur = params.squeezeDur || 5;
  const widthPctile = params.widthPctile || 0.20;
  const volMult = params.volMult || 1.3;
  const signals = [];
  const { c, h, l, o, bb, ema21, macdData, volR } = ind;

  for (let i = 108; i < kl.length - 3; i++) {
    if (isNaN(bb.width[i]) || isNaN(bb.width[i - 1])) continue;

    // BB width percentile over last 100 bars
    const widths = [];
    for (let j = i - 99; j <= i; j++) {
      if (!isNaN(bb.width[j])) widths.push(bb.width[j]);
    }
    if (widths.length < 80) continue;
    widths.sort((a, b) => a - b);
    const threshold = widths[Math.floor(widths.length * widthPctile)];
    const inSqueeze = bb.width[i] <= threshold;
    if (!inSqueeze) continue;

    // Squeeze duration check (relaxed from 8)
    let squeezeDuration = 0;
    for (let j = i; j >= Math.max(i - 30, 0); j--) {
      if (!isNaN(bb.width[j]) && bb.width[j] <= threshold) squeezeDuration++;
      else break;
    }
    if (squeezeDuration < squeezeDur) continue;

    // Breakout: first close outside BB
    const breakUp = c[i] > bb.up[i] && c[i - 1] <= bb.up[i - 1];
    const breakDn = c[i] < bb.dn[i] && c[i - 1] >= bb.dn[i - 1];
    if (!breakUp && !breakDn) continue;

    // Direction confirmation
    const ema21Slope = ema21[i] - ema21[i - 5];
    const macdDir = macdData.hist[i];

    // Volume check (relaxed)
    if (volR[i] < volMult) continue;

    if (breakUp && ema21Slope > 0 && macdDir > 0) {
      signals.push({ pair: null, bar: i, dir: 1, stratLabel: 'D' });
    }
    if (breakDn && ema21Slope < 0 && macdDir < 0) {
      signals.push({ pair: null, bar: i, dir: -1, stratLabel: 'D' });
    }
  }
  return signals;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY C — TREND CONTINUATION ON PULLBACK (Relaxed)
// ═══════════════════════════════════════════════════════════════════════════════

function strategyCRelaxed(kl, ind, params = {}) {
  const adxThresh = params.adxThresh || 25;
  const emaTouchPct = params.emaTouchPct || 0.002;
  const signals = [];
  const { c, h, l, o, rsi14, ema9, ema21, ema50, adxData } = ind;

  for (let i = 60; i < kl.length - 3; i++) {
    if (isNaN(adxData.adx[i]) || isNaN(ema50[i]) || isNaN(rsi14[i])) continue;

    // Uptrend (relaxed ADX threshold)
    const uptrend = adxData.adx[i] > adxThresh && ema9[i] > ema21[i] && ema21[i] > ema50[i]
      && adxData.pdi[i] > adxData.ndi[i];
    // Downtrend
    const downtrend = adxData.adx[i] > adxThresh && ema9[i] < ema21[i] && ema21[i] < ema50[i]
      && adxData.ndi[i] > adxData.pdi[i];

    if (uptrend) {
      const touchedEMA21 = l[i] <= ema21[i] * (1 + emaTouchPct) && c[i] > ema21[i] * (1 - emaTouchPct);
      const rsiPullback = rsi14[i] >= 35 && rsi14[i] <= 58;
      const greenCandle = c[i] > o[i];
      const wasPullingBack = i > 0 && (c[i - 1] < o[i - 1] || l[i - 1] <= ema21[i - 1] * (1 + emaTouchPct));

      if (touchedEMA21 && rsiPullback && greenCandle && wasPullingBack) {
        signals.push({ pair: null, bar: i, dir: 1, stratLabel: 'C' });
      }
    }

    if (downtrend) {
      const touchedEMA21 = h[i] >= ema21[i] * (1 - emaTouchPct) && c[i] < ema21[i] * (1 + emaTouchPct);
      const rsiPullback = rsi14[i] >= 42 && rsi14[i] <= 65;
      const redCandle = c[i] < o[i];
      const wasPullingBack = i > 0 && (c[i - 1] > o[i - 1] || h[i - 1] >= ema21[i - 1] * (1 - emaTouchPct));

      if (touchedEMA21 && rsiPullback && redCandle && wasPullingBack) {
        signals.push({ pair: null, bar: i, dir: -1, stratLabel: 'C' });
      }
    }
  }
  return signals;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SNIPER ENTRY FILTER
// After main signal fires, wait for micro pullback then momentum candle
// ═══════════════════════════════════════════════════════════════════════════════

function sniperFilter(signals, kl, ind) {
  const filtered = [];
  const { c, h, l, o, rsi7 } = ind;

  for (const sig of signals) {
    const i = sig.bar;
    // Look ahead up to 6 bars for a pullback + re-entry
    let found = false;
    for (let j = i + 1; j <= Math.min(i + 6, kl.length - 4); j++) {
      if (sig.dir === 1) {
        // Pullback: bar makes lower low or red candle
        const isPullback = c[j] < c[j - 1] || l[j] < l[j - 1];
        if (isPullback) {
          // Next bar or same bar shows momentum (green candle closing above prev high)
          for (let k = j; k <= Math.min(j + 2, kl.length - 4); k++) {
            if (c[k] > o[k] && c[k] > h[k - 1]) {
              filtered.push({ ...sig, bar: k, stratLabel: sig.stratLabel + '-S' });
              found = true;
              break;
            }
          }
          if (found) break;
        }
      } else {
        const isPullback = c[j] > c[j - 1] || h[j] > h[j - 1];
        if (isPullback) {
          for (let k = j; k <= Math.min(j + 2, kl.length - 4); k++) {
            if (c[k] < o[k] && c[k] < l[k - 1]) {
              filtered.push({ ...sig, bar: k, stratLabel: sig.stratLabel + '-S' });
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }
    }
    // If no sniper entry found within window, use original signal (don't lose it)
    if (!found) filtered.push(sig);
  }
  return filtered;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGIME FILTER
// ═══════════════════════════════════════════════════════════════════════════════

function classifyRegime(ind, i) {
  const { rsi14, adxData, bb } = ind;
  if (i < 20 || isNaN(adxData.adx[i])) return 'UNKNOWN';

  const adxVal = adxData.adx[i];
  const rsiVal = rsi14[i];
  const bbWidth = bb.width[i];

  // Collect recent stats
  let rsiMidCount = 0, adxLowCount = 0, bbNarrowCount = 0;
  const widths = [];
  for (let j = Math.max(0, i - 19); j <= i; j++) {
    if (!isNaN(rsi14[j]) && rsi14[j] >= 40 && rsi14[j] <= 60) rsiMidCount++;
    if (!isNaN(adxData.adx[j]) && adxData.adx[j] < 20) adxLowCount++;
    if (!isNaN(bb.width[j])) widths.push(bb.width[j]);
  }

  // BB width percentile (need wider context)
  let bbLow = false;
  if (widths.length >= 15) {
    const sorted = widths.slice().sort((a, b) => a - b);
    bbLow = bbWidth <= sorted[Math.floor(sorted.length * 0.25)];
    if (bbLow) bbNarrowCount++;
  }

  // ATR percentile for chop detection
  const atrPct = ind.c[i] > 0 ? ind.atr14[i] / ind.c[i] : 0;
  const atrPcts = [];
  for (let j = Math.max(0, i - 99); j <= i; j++) {
    if (ind.c[j] > 0) atrPcts.push(ind.atr14[j] / ind.c[j]);
  }
  let atrHigh = false;
  if (atrPcts.length >= 50) {
    const sorted = atrPcts.slice().sort((a, b) => a - b);
    atrHigh = atrPct >= sorted[Math.floor(sorted.length * 0.80)];
  }

  // CHOPPY: high ATR + low ADX = don't trade
  if (atrHigh && adxVal < 20) return 'CHOPPY';

  // RANGING: multiple range indicators
  const rangeScore = (rsiMidCount >= 3 ? 1 : 0) + (adxLowCount >= 3 ? 1 : 0) + (bbNarrowCount >= 1 ? 1 : 0);
  if (rangeScore >= 2) return 'RANGING';

  // TRENDING: strong ADX + EMA alignment
  const { ema9, ema21 } = ind;
  let emaConsistent = 0;
  for (let j = Math.max(0, i - 9); j <= i; j++) {
    if (!isNaN(ema9[j]) && !isNaN(ema21[j])) {
      if (ema9[j] > ema21[j] || ema9[j] < ema21[j]) emaConsistent++;
    }
  }
  if (adxVal > 25 && emaConsistent >= 8) return 'TRENDING';

  return 'MIXED';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIME FILTER — Skip dead hours + first/last 5 min of each hour
// ═══════════════════════════════════════════════════════════════════════════════

function timeFilter(signals, kl, bestHoursSet) {
  return signals.filter(sig => {
    const bar = kl[sig.bar];
    if (!bar) return false;
    const d = new Date(bar.t);
    const hour = d.getUTCHours();
    const minute = d.getUTCMinutes();

    // Skip if not in best hours
    if (bestHoursSet && !bestHoursSet.has(hour)) return false;

    // Skip first/last 5 min of each hour (institutional noise)
    if (minute < 5 || minute >= 55) return false;

    return true;
  });
}

// Best trading hours (UTC) — high volume sessions
// London: 7-16, NY: 13-21, Asian: 0-4 — skip 4-7 (dead) and 21-0 (dead)
const BEST_HOURS = new Set([0, 1, 2, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

// ═══════════════════════════════════════════════════════════════════════════════
// PRINTING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function printResult(label, stats, cfg = null) {
  if (!stats || stats.trades === 0) {
    console.log(`\n${label}: NO TRADES`);
    return;
  }
  console.log(`\n${label}`);
  if (cfg) {
    let cfgStr = '';
    for (const [k, v] of Object.entries(cfg)) {
      if (v !== undefined && v !== null && v !== false) {
        cfgStr += `${k}=${typeof v === 'number' ? (v < 1 ? (v * 100).toFixed(1) + '%' : v.toFixed ? v.toFixed(2) : v) : v}, `;
      }
    }
    if (cfgStr) console.log(`  Config: ${cfgStr.slice(0, -2)}`);
  }
  console.log(`  PF: ${stats.pf.toFixed(2)} | WR: ${stats.wr.toFixed(1)}% | Trades/day: ${stats.tradesPerDay.toFixed(1)} | PnL: $${stats.pnl.toFixed(0)} | Max DD: ${stats.maxDD.toFixed(1)}%`);
  console.log(`  Avg Win: $${stats.avgWin.toFixed(2)} | Avg Loss: $${stats.avgLoss.toFixed(2)} | Total trades: ${stats.trades}`);

  // Per pair
  let pairLine = '  Per pair:';
  for (const pair of PAIRS) {
    const pp = stats.perPair[pair];
    if (pp && pp.n > 0) {
      const pf = pp.gl > 0 ? (pp.gp / pp.gl).toFixed(2) : (pp.gp > 0 ? '999' : '0.00');
      pairLine += ` ${pair.replace('USDT', '')} PF ${pf}(${pp.n})`;
    }
  }
  console.log(pairLine);

  // Monthly
  const months = Object.keys(stats.perMonth).sort();
  if (months.length > 0) {
    console.log('  Monthly:');
    for (const m of months) {
      const pm = stats.perMonth[m];
      const mpf = pm.gl > 0 ? (pm.gp / pm.gl).toFixed(2) : (pm.gp > 0 ? '999' : '0.00');
      const mwr = pm.n > 0 ? (pm.w / pm.n * 100).toFixed(1) : '0.0';
      const mpnl = pm.gp - pm.gl;
      console.log(`    ${m}: PF ${mpf} | WR ${mwr}% | PnL $${mpnl.toFixed(0)} | ${pm.n} trades`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

(async () => {
  const startRun = Date.now();
  console.log('='.repeat(70));
  console.log('  STRATEGY ROUND 3 — D(relaxed) + C(trend) + Filters + Trailing');
  console.log('  Capital: $500 | Leverage: 5x | Dynamic position sizing');
  console.log('  Fees: 0.02% maker, 0.05% taker, 0.03% SL slippage');
  console.log('  Entry: OPEN of bar+2 | Fill rate: 80% | Max 3 positions');
  console.log('  Target: PF >= 2.0, WR >= 55%, 10+ trades/day');
  console.log('='.repeat(70) + '\n');

  // ─── FETCH ALL DATA ───
  console.log('FETCHING DATA...');
  const allKl5m = {}, allKl15m = {}, allKl1h = {};
  const allInd5m = {}, allInd15m = {};

  for (const pair of PAIRS) {
    process.stdout.write(`  ${pair}: `);
    process.stdout.write('5m');
    const raw5m = await getKlines(pair, '5m', DAYS + 5);
    allKl5m[pair] = parseKlines(raw5m);
    process.stdout.write(`(${allKl5m[pair].length}) `);

    process.stdout.write('15m');
    const raw15m = await getKlines(pair, '15m', DAYS + 5);
    allKl15m[pair] = parseKlines(raw15m);
    process.stdout.write(`(${allKl15m[pair].length}) `);

    console.log('OK');
  }

  // ─── COMPUTE INDICATORS ───
  console.log('\nCOMPUTING INDICATORS...');
  for (const pair of PAIRS) {
    allInd5m[pair] = computeIndicators(allKl5m[pair]);
    allInd15m[pair] = computeIndicators(allKl15m[pair]);
    process.stdout.write(`  ${pair} `);
  }
  console.log('DONE\n');

  // Also compute BB with different periods for D exploration
  const bbPeriods = { 15: {}, 20: {}, 25: {} };
  for (const pair of PAIRS) {
    const c = allKl5m[pair].map(k => k.c);
    for (const p of [15, 25]) {
      bbPeriods[p][pair] = bbandsP(c, p, 2);
    }
    bbPeriods[20][pair] = allInd5m[pair].bb; // already computed
  }

  // Also compute 15m indicators with different BB
  const allInd15mBB = {};
  for (const pair of PAIRS) {
    allInd15mBB[pair] = computeIndicators(allKl15m[pair]);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // APPROACH 1: RELAX STRATEGY D
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('=' .repeat(70));
  console.log('APPROACH 1: RELAX STRATEGY D (Volatility Breakout)');
  console.log('='.repeat(70));

  const dConfigs = [];
  for (const squeezeDur of [4, 5, 6]) {
    for (const widthPctile of [0.15, 0.20, 0.25]) {
      for (const volMult of [1.2, 1.3]) {
        for (const bbPeriod of [15, 20, 25]) {
          dConfigs.push({ squeezeDur, widthPctile, volMult, bbPeriod });
        }
      }
    }
  }

  let bestD = null, bestDCfg = null, bestDSigs = null;
  const slGridD = [0.005, 0.007, 0.010, 0.015];
  const tpGridD = [0.010, 0.015, 0.020, 0.030];

  console.log(`  Testing ${dConfigs.length} D configs x ${slGridD.length * tpGridD.length} SL/TP combos...`);

  for (const dcfg of dConfigs) {
    const sigsByPair = {};
    let totalSigs = 0;

    for (const pair of PAIRS) {
      // Use the appropriate BB period
      const indCopy = { ...allInd5m[pair], bb: bbPeriods[dcfg.bbPeriod][pair] };
      // 5m signals
      const sigs5m = strategyDRelaxed(allKl5m[pair], indCopy, dcfg);
      sigs5m.forEach(s => s.pair = pair);

      // 15m signals (for dual timeframe)
      const sigs15m = strategyDRelaxed(allKl15m[pair], allInd15mBB[pair], dcfg);
      // Map 15m bar indices to approximate 5m equivalents
      for (const sig of sigs15m) {
        const sigTime = allKl15m[pair][sig.bar] ? allKl15m[pair][sig.bar].t : 0;
        let best5mBar = -1;
        for (let j = 0; j < allKl5m[pair].length; j++) {
          if (allKl5m[pair][j].t >= sigTime) { best5mBar = j; break; }
        }
        if (best5mBar >= 0 && best5mBar < allKl5m[pair].length - 3) {
          sigs5m.push({ ...sig, bar: best5mBar, pair, stratLabel: 'D-15m' });
        }
      }

      sigsByPair[pair] = sigs5m;
      totalSigs += sigs5m.length;
    }

    // Quick test with middle SL/TP
    const allSigs = [];
    for (const pair of PAIRS) {
      for (const sig of sigsByPair[pair]) {
        allSigs.push({ ...sig, sl: 0.007, tp: 0.020 });
      }
    }
    const quickStats = runBacktest(allSigs, allKl5m, { sl: 0.007, tp: 0.020 });

    if (!bestD || quickStats.pf > bestD.pf || (quickStats.pf === bestD.pf && quickStats.tradesPerDay > bestD.tradesPerDay)) {
      bestD = quickStats;
      bestDCfg = dcfg;
      bestDSigs = sigsByPair;
    }
  }

  // Now grid search the best D config
  console.log(`  Best D config: squeeze=${bestDCfg.squeezeDur}, width=${(bestDCfg.widthPctile*100)}%, vol=${bestDCfg.volMult}x, bb=${bestDCfg.bbPeriod}`);
  console.log(`  Quick test: PF=${bestD.pf.toFixed(2)}, trades/day=${bestD.tradesPerDay.toFixed(1)}`);

  let bestDGrid = null;
  for (const sl of slGridD) {
    for (const tp of tpGridD) {
      if (tp <= sl) continue;
      const allSigs = [];
      for (const pair of PAIRS) {
        for (const sig of bestDSigs[pair]) {
          allSigs.push({ ...sig, sl, tp });
        }
      }
      const stats = runBacktest(allSigs, allKl5m, { sl, tp });
      if (!bestDGrid || stats.pf > bestDGrid.stats.pf) {
        bestDGrid = { stats, cfg: { sl, tp, ...bestDCfg } };
      }
    }
  }
  printResult('APPROACH 1 — RELAXED D (Volatility Breakout)', bestDGrid.stats, bestDGrid.cfg);

  // Save best D signals for combined
  const bestDSignalsFlat = [];
  for (const pair of PAIRS) {
    for (const sig of bestDSigs[pair]) {
      bestDSignalsFlat.push({ ...sig, pair });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // APPROACH 2: TREND CONTINUATION (C) AS COMPLEMENTARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('APPROACH 2: TREND CONTINUATION (C) — Complementary');
  console.log('='.repeat(70));

  const cConfigs = [
    { adxThresh: 25, emaTouchPct: 0.002 },
    { adxThresh: 25, emaTouchPct: 0.003 },
    { adxThresh: 22, emaTouchPct: 0.002 },
    { adxThresh: 22, emaTouchPct: 0.003 },
    { adxThresh: 28, emaTouchPct: 0.002 },
  ];

  let bestC = null, bestCCfg = null, bestCSigs = null;
  const slGridC = [0.005, 0.007, 0.010, 0.015];
  const tpGridC = [0.010, 0.015, 0.020, 0.030];

  for (const ccfg of cConfigs) {
    const sigsByPair = {};
    let totalSigs = 0;
    for (const pair of PAIRS) {
      sigsByPair[pair] = strategyCRelaxed(allKl5m[pair], allInd5m[pair], ccfg);
      sigsByPair[pair].forEach(s => s.pair = pair);
      totalSigs += sigsByPair[pair].length;
    }

    // Quick test
    const allSigs = [];
    for (const pair of PAIRS) {
      for (const sig of sigsByPair[pair]) allSigs.push({ ...sig, sl: 0.007, tp: 0.020 });
    }
    const stats = runBacktest(allSigs, allKl5m, { sl: 0.007, tp: 0.020 });

    if (!bestC || stats.pf > bestC.pf || (stats.pf === bestC.pf && stats.tradesPerDay > bestC.tradesPerDay)) {
      bestC = stats;
      bestCCfg = ccfg;
      bestCSigs = sigsByPair;
    }
  }

  // Grid search best C
  let bestCGrid = null;
  for (const sl of slGridC) {
    for (const tp of tpGridC) {
      if (tp <= sl) continue;
      const allSigs = [];
      for (const pair of PAIRS) {
        for (const sig of bestCSigs[pair]) allSigs.push({ ...sig, sl, tp });
      }
      const stats = runBacktest(allSigs, allKl5m, { sl, tp });
      if (!bestCGrid || stats.pf > bestCGrid.stats.pf) {
        bestCGrid = { stats, cfg: { sl, tp, ...bestCCfg } };
      }
    }
  }
  printResult('APPROACH 2 — TREND CONTINUATION (C)', bestCGrid.stats, bestCGrid.cfg);

  const bestCSignalsFlat = [];
  for (const pair of PAIRS) {
    for (const sig of bestCSigs[pair]) bestCSignalsFlat.push({ ...sig, pair });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // APPROACH 3: SNIPER ENTRY FILTER
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('APPROACH 3: SNIPER ENTRY FILTER (applied to D + C)');
  console.log('='.repeat(70));

  // Apply sniper to D signals
  const sniperDSigs = {};
  for (const pair of PAIRS) {
    if (bestDSigs[pair]) {
      sniperDSigs[pair] = sniperFilter(bestDSigs[pair], allKl5m[pair], allInd5m[pair]);
      sniperDSigs[pair].forEach(s => s.pair = pair);
    }
  }
  let allSniperD = [];
  for (const pair of PAIRS) {
    if (sniperDSigs[pair]) {
      for (const sig of sniperDSigs[pair]) allSniperD.push({ ...sig, sl: bestDGrid.cfg.sl, tp: bestDGrid.cfg.tp });
    }
  }
  const sniperDStats = runBacktest(allSniperD, allKl5m, { sl: bestDGrid.cfg.sl, tp: bestDGrid.cfg.tp });
  printResult('APPROACH 3a — D with Sniper Entry', sniperDStats);

  // Apply sniper to C signals
  const sniperCSigs = {};
  for (const pair of PAIRS) {
    if (bestCSigs[pair]) {
      sniperCSigs[pair] = sniperFilter(bestCSigs[pair], allKl5m[pair], allInd5m[pair]);
      sniperCSigs[pair].forEach(s => s.pair = pair);
    }
  }
  let allSniperC = [];
  for (const pair of PAIRS) {
    if (sniperCSigs[pair]) {
      for (const sig of sniperCSigs[pair]) allSniperC.push({ ...sig, sl: bestCGrid.cfg.sl, tp: bestCGrid.cfg.tp });
    }
  }
  const sniperCStats = runBacktest(allSniperC, allKl5m, { sl: bestCGrid.cfg.sl, tp: bestCGrid.cfg.tp });
  printResult('APPROACH 3b — C with Sniper Entry', sniperCStats);

  // ═══════════════════════════════════════════════════════════════════════════
  // APPROACH 4: TRAILING STOP OPTIMIZATION
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('APPROACH 4: TRAILING STOP OPTIMIZATION');
  console.log('='.repeat(70));

  // Test trailing on D+C combined signals
  const combinedSignals = [...bestDSignalsFlat, ...bestCSignalsFlat];
  const bestSL = Math.min(bestDGrid.cfg.sl, bestCGrid.cfg.sl);

  // 4a: Tight trailing (1.0x ATR)
  const trail1 = runBacktest(combinedSignals.map(s => ({ ...s, sl: bestSL })), allKl5m,
    { sl: bestSL, trailing: true, trailATRMult: 1.0 });
  printResult('APPROACH 4a — Tight Trailing (1.0x ATR)', trail1);

  // 4b: Medium trailing (1.5x ATR)
  const trail15 = runBacktest(combinedSignals.map(s => ({ ...s, sl: bestSL })), allKl5m,
    { sl: bestSL, trailing: true, trailATRMult: 1.5 });
  printResult('APPROACH 4b — Medium Trailing (1.5x ATR)', trail15);

  // 4c: Loose trailing (2.0x ATR)
  const trail2 = runBacktest(combinedSignals.map(s => ({ ...s, sl: bestSL })), allKl5m,
    { sl: bestSL, trailing: true, trailATRMult: 2.0 });
  printResult('APPROACH 4c — Loose Trailing (2.0x ATR)', trail2);

  // 4d: Hybrid (50% fixed TP, 50% trailing)
  const trailHybrid = runBacktest(combinedSignals.map(s => ({ ...s, sl: bestSL, tp: 0.020 })), allKl5m,
    { sl: bestSL, tp: 0.020, trailSplit: true, trailATRMult: 1.5 });
  printResult('APPROACH 4d — Hybrid (50% fixed TP + 50% trailing 1.5x ATR)', trailHybrid);

  // Find best trailing config
  const trailResults = [
    { stats: trail1, cfg: { trailATRMult: 1.0 }, label: '1.0x' },
    { stats: trail15, cfg: { trailATRMult: 1.5 }, label: '1.5x' },
    { stats: trail2, cfg: { trailATRMult: 2.0 }, label: '2.0x' },
    { stats: trailHybrid, cfg: { trailSplit: true, trailATRMult: 1.5 }, label: 'hybrid' },
  ];
  const bestTrail = trailResults.sort((a, b) => b.stats.pf - a.stats.pf)[0];
  console.log(`  >> Best trailing: ${bestTrail.label} with PF ${bestTrail.stats.pf.toFixed(2)}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // APPROACH 5: TIME FILTERS
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('APPROACH 5: TIME FILTERS');
  console.log('='.repeat(70));

  // Without time filter
  const noTimeStats = runBacktest(combinedSignals.map(s => ({ ...s, sl: bestSL, tp: 0.020 })), allKl5m,
    { sl: bestSL, tp: 0.020 });
  console.log(`  No time filter: PF=${noTimeStats.pf.toFixed(2)} | Trades/day=${noTimeStats.tradesPerDay.toFixed(1)}`);

  // With time filter
  const timeFilteredSigs = [];
  for (const pair of PAIRS) {
    const pairSigs = combinedSignals.filter(s => s.pair === pair);
    const filtered = timeFilter(pairSigs, allKl5m[pair], BEST_HOURS);
    timeFilteredSigs.push(...filtered);
  }
  const timeStats = runBacktest(timeFilteredSigs.map(s => ({ ...s, sl: bestSL, tp: 0.020 })), allKl5m,
    { sl: bestSL, tp: 0.020 });
  printResult('APPROACH 5 — Time Filtered (best 18 hours, skip :00-:05/:55-:60)', timeStats);

  // ═══════════════════════════════════════════════════════════════════════════
  // APPROACH 6: REGIME FILTER
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('APPROACH 6: REGIME FILTER (D in ranging, C in trending, skip chop)');
  console.log('='.repeat(70));

  const regimeFilteredSigs = [];
  let regimeStats = { ranging: 0, trending: 0, choppy: 0, mixed: 0, passed: 0, total: 0 };

  for (const pair of PAIRS) {
    for (const sig of combinedSignals.filter(s => s.pair === pair)) {
      regimeStats.total++;
      const regime = classifyRegime(allInd5m[pair], sig.bar);

      if (regime === 'CHOPPY') { regimeStats.choppy++; continue; }

      const isD = sig.stratLabel && sig.stratLabel.startsWith('D');
      const isC = sig.stratLabel && sig.stratLabel.startsWith('C');

      if (regime === 'RANGING') {
        regimeStats.ranging++;
        if (isD) { regimeFilteredSigs.push(sig); regimeStats.passed++; }
        // Also allow C if regime is just mildly ranging
      } else if (regime === 'TRENDING') {
        regimeStats.trending++;
        if (isC) { regimeFilteredSigs.push(sig); regimeStats.passed++; }
        // Also allow D breakouts in trending (breakout from consolidation within trend)
        if (isD) { regimeFilteredSigs.push(sig); regimeStats.passed++; }
      } else {
        regimeStats.mixed++;
        // MIXED: allow both
        regimeFilteredSigs.push(sig);
        regimeStats.passed++;
      }
    }
  }

  console.log(`  Regime breakdown: ranging=${regimeStats.ranging}, trending=${regimeStats.trending}, choppy=${regimeStats.choppy}, mixed=${regimeStats.mixed}`);
  console.log(`  Signals: ${regimeStats.total} total -> ${regimeStats.passed} passed (${regimeStats.choppy} blocked by chop)`);

  const regimeResult = runBacktest(regimeFilteredSigs.map(s => ({ ...s, sl: bestSL, tp: 0.020 })), allKl5m,
    { sl: bestSL, tp: 0.020 });
  printResult('APPROACH 6 — Regime Filtered D+C', regimeResult);

  // ═══════════════════════════════════════════════════════════════════════════
  // APPROACH 7: DYNAMIC SL/TP BASED ON ATR
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('APPROACH 7: DYNAMIC SL/TP BASED ON ATR');
  console.log('='.repeat(70));

  const atrSLMults = [0.5, 0.8, 1.0, 1.2, 1.5];
  const atrRRs = [2.0, 2.5, 3.0, 3.5];

  let bestATR = null, bestATRCfg = null;
  for (const atrSLMult of atrSLMults) {
    for (const atrRR of atrRRs) {
      const stats = runBacktest(combinedSignals, allKl5m, {
        atrSLTP: true, atrSLMult, atrRR
      });
      if (!bestATR || stats.pf > bestATR.pf) {
        bestATR = stats;
        bestATRCfg = { atrSLMult, atrRR };
      }
    }
  }
  printResult(`APPROACH 7 — Dynamic ATR SL/TP (best: SL=${bestATRCfg.atrSLMult}xATR, R:R=${bestATRCfg.atrRR})`, bestATR, bestATRCfg);

  // ═══════════════════════════════════════════════════════════════════════════
  // COMBINED: D + C with ALL optimizations
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('COMBINED: D(relaxed) + C(trend) + Regime + Time + Best SL/TP + Trail');
  console.log('='.repeat(70));

  // Step 1: Start with D (relaxed) + C signals
  let combinedAll = [...bestDSignalsFlat, ...bestCSignalsFlat];
  console.log(`  Step 1 - Raw D+C signals: ${combinedAll.length}`);

  // Step 2: Apply regime filter
  const combinedRegime = [];
  for (const sig of combinedAll) {
    const regime = classifyRegime(allInd5m[sig.pair], sig.bar);
    if (regime === 'CHOPPY') continue;
    const isD = sig.stratLabel && sig.stratLabel.startsWith('D');
    const isC = sig.stratLabel && sig.stratLabel.startsWith('C');
    if (regime === 'RANGING' && (isD || !isC)) { combinedRegime.push(sig); continue; }
    if (regime === 'TRENDING') { combinedRegime.push(sig); continue; }
    if (regime === 'MIXED') { combinedRegime.push(sig); continue; }
  }
  console.log(`  Step 2 - After regime filter: ${combinedRegime.length}`);

  // Step 3: Apply time filter
  const combinedTime = [];
  for (const pair of PAIRS) {
    const pairSigs = combinedRegime.filter(s => s.pair === pair);
    const filtered = timeFilter(pairSigs, allKl5m[pair], BEST_HOURS);
    combinedTime.push(...filtered);
  }
  console.log(`  Step 3 - After time filter: ${combinedTime.length}`);

  // Step 4: Apply sniper entry
  const combinedSniper = [];
  for (const pair of PAIRS) {
    const pairSigs = combinedTime.filter(s => s.pair === pair);
    const sniped = sniperFilter(pairSigs, allKl5m[pair], allInd5m[pair]);
    sniped.forEach(s => s.pair = pair);
    combinedSniper.push(...sniped);
  }
  console.log(`  Step 4 - After sniper filter: ${combinedSniper.length}`);

  // Step 5: Test with multiple exit strategies
  console.log('\n  Testing exit strategies on combined signals...');

  // 5a: Fixed SL/TP grid search
  let bestCombined = null, bestCombinedCfg = null;
  const combSLGrid = [0.005, 0.007, 0.010, 0.012, 0.015];
  const combTPGrid = [0.010, 0.015, 0.020, 0.025, 0.030];

  for (const sl of combSLGrid) {
    for (const tp of combTPGrid) {
      if (tp <= sl) continue;
      const stats = runBacktest(combinedSniper.map(s => ({ ...s, sl, tp })), allKl5m, { sl, tp });
      if (!bestCombined || stats.pf > bestCombined.pf) {
        bestCombined = stats;
        bestCombinedCfg = { sl, tp, mode: 'fixed' };
      }
    }
  }
  console.log(`  Fixed SL/TP best: PF=${bestCombined.pf.toFixed(2)}, WR=${bestCombined.wr.toFixed(1)}%, trades/day=${bestCombined.tradesPerDay.toFixed(1)}`);

  // 5b: ATR-based SL/TP
  for (const atrSLMult of [0.8, 1.0, 1.2]) {
    for (const atrRR of [2.0, 2.5, 3.0]) {
      const stats = runBacktest(combinedSniper, allKl5m, { atrSLTP: true, atrSLMult, atrRR });
      if (stats.pf > bestCombined.pf) {
        bestCombined = stats;
        bestCombinedCfg = { atrSLMult, atrRR, mode: 'atr' };
      }
    }
  }
  console.log(`  After ATR test: PF=${bestCombined.pf.toFixed(2)}, mode=${bestCombinedCfg.mode}`);

  // 5c: Trailing variants
  for (const trailMult of [1.0, 1.5, 2.0]) {
    const sl = bestCombinedCfg.sl || 0.010;
    const stats = runBacktest(combinedSniper.map(s => ({ ...s, sl })), allKl5m,
      { sl, trailing: true, trailATRMult: trailMult });
    if (stats.pf > bestCombined.pf) {
      bestCombined = stats;
      bestCombinedCfg = { sl, trailATRMult: trailMult, mode: 'trailing' };
    }
  }

  // 5d: Hybrid (50% fixed + 50% trailing)
  for (const trailMult of [1.0, 1.5, 2.0]) {
    const sl = bestCombinedCfg.sl || 0.010;
    const tp = 0.020;
    const stats = runBacktest(combinedSniper.map(s => ({ ...s, sl, tp })), allKl5m,
      { sl, tp, trailSplit: true, trailATRMult: trailMult });
    if (stats.pf > bestCombined.pf) {
      bestCombined = stats;
      bestCombinedCfg = { sl, tp, trailATRMult: trailMult, mode: 'hybrid' };
    }
  }
  console.log(`  After trailing test: PF=${bestCombined.pf.toFixed(2)}, mode=${bestCombinedCfg.mode}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL COMBINED RESULT
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('  FINAL COMBINED RESULT');
  console.log('='.repeat(70));

  printResult('COMBINED: D(relaxed) + C(trend) + Regime + Time + Sniper + Best Exit', bestCombined, bestCombinedCfg);

  // Also run without sniper for comparison
  let bestNoSniper = null, bestNoSniperCfg = null;
  for (const sl of [0.005, 0.007, 0.010, 0.015]) {
    for (const tp of [0.010, 0.015, 0.020, 0.030]) {
      if (tp <= sl) continue;
      const stats = runBacktest(combinedTime.map(s => ({ ...s, sl, tp })), allKl5m, { sl, tp });
      if (!bestNoSniper || stats.pf > bestNoSniper.pf) {
        bestNoSniper = stats;
        bestNoSniperCfg = { sl, tp };
      }
    }
  }
  printResult('COMPARISON: D+C + Regime + Time (NO sniper)', bestNoSniper, bestNoSniperCfg);

  // Also plain D+C without any filters
  let bestPlain = null, bestPlainCfg = null;
  for (const sl of [0.005, 0.007, 0.010, 0.015]) {
    for (const tp of [0.010, 0.015, 0.020, 0.030]) {
      if (tp <= sl) continue;
      const stats = runBacktest(combinedAll.map(s => ({ ...s, sl, tp })), allKl5m, { sl, tp });
      if (!bestPlain || stats.pf > bestPlain.pf) {
        bestPlain = stats;
        bestPlainCfg = { sl, tp };
      }
    }
  }
  printResult('COMPARISON: Plain D+C (no filters)', bestPlain, bestPlainCfg);

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY TABLE
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('  ROUND 3 SUMMARY');
  console.log('='.repeat(70));

  const summary = [
    { label: '1-Relaxed D', s: bestDGrid.stats },
    { label: '2-Trend C', s: bestCGrid.stats },
    { label: '3a-D+Sniper', s: sniperDStats },
    { label: '3b-C+Sniper', s: sniperCStats },
    { label: '4-Best Trail', s: bestTrail.stats },
    { label: '5-Time Filter', s: timeStats },
    { label: '6-Regime', s: regimeResult },
    { label: '7-ATR SL/TP', s: bestATR },
    { label: 'COMBINED', s: bestCombined },
    { label: 'No-Sniper', s: bestNoSniper },
    { label: 'Plain D+C', s: bestPlain },
  ];

  console.log('  Approach          | PF    | WR    | Tr/day | PnL     | MaxDD');
  console.log('  ' + '-'.repeat(65));
  for (const r of summary) {
    if (!r.s || r.s.trades === 0) {
      console.log(`  ${r.label.padEnd(20)}| N/A`);
      continue;
    }
    console.log(`  ${r.label.padEnd(20)}| ${r.s.pf.toFixed(2).padStart(5)} | ${r.s.wr.toFixed(1).padStart(5)}% | ${r.s.tradesPerDay.toFixed(1).padStart(5)}  | $${r.s.pnl.toFixed(0).padStart(6)} | ${r.s.maxDD.toFixed(1).padStart(5)}%`);
  }

  const elapsed = ((Date.now() - startRun) / 1000).toFixed(1);
  console.log(`\nCompleted in ${elapsed}s`);
})();
