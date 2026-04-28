#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY ROUND 2 — Advanced Approaches × 7 Pairs × 120 Days
// Target: PF >= 2.0, WR >= 55%, 10+ trades/day
// Building on Round 1 infrastructure with more advanced signal generation
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

function bbands(closes, p = 20, mult = 2) {
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

function bbands25(closes) {
  // BB with 2.5 std for extreme detection
  return bbands(closes, 20, 2.5);
}

function macd(closes, f = 12, s = 26, sig = 9) {
  const ef = ema(closes, f), es = ema(closes, s);
  const line = ef.map((v, i) => v - es[i]);
  const signal = ema(line, sig);
  const hist = line.map((v, i) => v - signal[i]);
  return { line, signal, hist };
}

function stochFast(highs, lows, closes, kp = 5, dp = 3) {
  const k = new Array(closes.length).fill(NaN);
  for (let i = kp - 1; i < closes.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kp + 1; j <= i; j++) { hh = Math.max(hh, highs[j]); ll = Math.min(ll, lows[j]); }
    k[i] = hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100;
  }
  const d = sma(k.map(v => isNaN(v) ? 50 : v), dp);
  return { k, d };
}

function stoch(highs, lows, closes, kp = 14, dp = 3) {
  const k = new Array(closes.length).fill(NaN);
  for (let i = kp - 1; i < closes.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - kp + 1; j <= i; j++) { hh = Math.max(hh, highs[j]); ll = Math.min(ll, lows[j]); }
    k[i] = hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100;
  }
  const d = sma(k.map(v => isNaN(v) ? 50 : v), dp);
  return { k, d };
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

function obv(closes, volumes) {
  const r = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) r.push(r[i - 1] + volumes[i]);
    else if (closes[i] < closes[i - 1]) r.push(r[i - 1] - volumes[i]);
    else r.push(r[i - 1]);
  }
  return r;
}

function cmf(highs, lows, closes, volumes, p = 20) {
  const r = new Array(closes.length).fill(0);
  for (let i = p - 1; i < closes.length; i++) {
    let mfvSum = 0, volSum = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const hl = highs[j] - lows[j];
      const mfm = hl === 0 ? 0 : ((closes[j] - lows[j]) - (highs[j] - closes[j])) / hl;
      mfvSum += mfm * volumes[j]; volSum += volumes[j];
    }
    r[i] = volSum === 0 ? 0 : mfvSum / volSum;
  }
  return r;
}

function zscore(closes, p = 50) {
  const m = sma(closes, p), r = new Array(closes.length).fill(0);
  for (let i = p - 1; i < closes.length; i++) {
    let ss = 0;
    for (let j = i - p + 1; j <= i; j++) ss += (closes[j] - m[i]) ** 2;
    const std = Math.sqrt(ss / p);
    r[i] = std > 0 ? (closes[i] - m[i]) / std : 0;
  }
  return r;
}

function roc(closes, p = 3) {
  const r = new Array(closes.length).fill(0);
  for (let i = p; i < closes.length; i++) r[i] = (closes[i] - closes[i - p]) / closes[i - p];
  return r;
}

function volRatio(volumes, p = 20) {
  const avg = sma(volumes, p);
  return volumes.map((v, i) => isNaN(avg[i]) || avg[i] === 0 ? 1 : v / avg[i]);
}

function cumDelta(highs, lows, closes, opens, volumes) {
  const r = [0];
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const buyPct = hl === 0 ? 0.5 : (closes[i] - lows[i]) / hl;
    const delta = volumes[i] * (buyPct - (1 - buyPct));
    r.push(r[i - 1] + delta);
  }
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR PRE-COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

function computeIndicators(kl) {
  const c = kl.map(k => k.c), h = kl.map(k => k.h), l = kl.map(k => k.l);
  const o = kl.map(k => k.o), v = kl.map(k => k.v);
  return {
    c, h, l, o, v,
    rsi7: rsi(c, 7), rsi14: rsi(c, 14),
    stoch14: stoch(h, l, c, 14, 3),
    stoch5: stochFast(h, l, c, 5, 3),
    macdData: macd(c),
    bb: bbands(c, 20, 2),
    bb25: bbands25(c),
    ema9: ema(c, 9), ema21: ema(c, 21), ema50: ema(c, 50),
    adxData: adxCalc(h, l, c, 14),
    atr14: atr(h, l, c, 14),
    obvArr: obv(c, v),
    cmfArr: cmf(h, l, c, v, 20),
    volR: volRatio(v, 20),
    zs50: zscore(c, 50),
    roc3: roc(c, 3),
    cumDeltaArr: cumDelta(h, l, c, o, v),
    sma50: sma(c, 50)
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE — Enhanced with trailing stop support + monthly tracking
// ═══════════════════════════════════════════════════════════════════════════════

function runBacktest(allSignals, allKl5m, cfg = {}) {
  const slPct = cfg.sl || 0.005;
  const tpPct = cfg.tp || 0.015;
  const trailing = cfg.trailing || false;
  const trailATRMult = cfg.trailATRMult || 2.0;

  let capital = INIT_CAP;
  const positions = [];
  const trades = [];
  let fillSeq = 0;

  // Pre-compute ATR for trailing stops
  const atrCache = {};
  if (trailing) {
    for (const pair of PAIRS) {
      if (allKl5m[pair]) {
        const c = allKl5m[pair].map(k => k.c);
        const h = allKl5m[pair].map(k => k.h);
        const l = allKl5m[pair].map(k => k.l);
        atrCache[pair] = atr(h, l, c, 14);
      }
    }
  }

  const sortedSigs = allSignals.slice().sort((a, b) => {
    const tA = allKl5m[a.pair][Math.min(a.bar, allKl5m[a.pair].length - 1)].t;
    const tB = allKl5m[b.pair][Math.min(b.bar, allKl5m[b.pair].length - 1)].t;
    return tA - tB;
  });

  for (const sig of sortedSigs) {
    const kl = allKl5m[sig.pair];
    const entryBar = sig.bar + ENTRY_DELAY;
    if (entryBar >= kl.length) continue;

    fillSeq++;
    if (fillSeq % 5 === 0) continue; // 80% fill rate

    // Resolve positions that closed before this entry time
    if (positions.length >= MAX_POSITIONS) {
      resolvePositions(positions, trades, allKl5m, kl[entryBar].t, trailing, atrCache, trailATRMult);
      if (positions.length >= MAX_POSITIONS) continue;
    }

    const entryPrice = kl[entryBar].o;
    const useSlPct = sig.sl || slPct;
    const useTpPct = sig.tp || tpPct;
    const slPrice = sig.dir === 1 ? entryPrice * (1 - useSlPct) : entryPrice * (1 + useSlPct);
    const tpPrice = trailing ? null : (sig.dir === 1 ? entryPrice * (1 + useTpPct) : entryPrice * (1 - useTpPct));

    // Dynamic position sizing: min(capital * LEV, max_loss_pct / sl_distance)
    const maxRisk = capital * 0.02; // risk 2% of capital per trade
    const slDist = useSlPct * entryPrice;
    const qtyByRisk = slDist > 0 ? maxRisk / slDist : 0;
    const qtyByLev = (capital * LEV) / entryPrice;
    const qty = Math.min(qtyByRisk, qtyByLev);
    if (qty <= 0) continue;

    const posSize = qty * entryPrice;

    positions.push({
      pair: sig.pair, dir: sig.dir, entry: entryPrice,
      sl: slPrice, tp: tpPrice, qty, bar: entryBar,
      slPct: useSlPct, tpPct: useTpPct, posSize,
      trailing, highWater: entryPrice, lowWater: entryPrice,
      stratLabel: sig.stratLabel || ''
    });
  }

  resolveAllPositions(positions, trades, allKl5m, trailing, atrCache, trailATRMult);
  return computeStats(trades);
}

function resolvePositions(positions, trades, allKl5m, currentTime, trailing, atrCache, trailATRMult) {
  for (let p = positions.length - 1; p >= 0; p--) {
    const pos = positions[p];
    const kl = allKl5m[pos.pair];
    let closed = false;
    for (let j = pos.bar + 1; j < kl.length && j <= pos.bar + TIMEOUT_BARS; j++) {
      if (kl[j].t > currentTime) break;
      const result = checkExit(pos, kl[j], trailing, atrCache, trailATRMult, j);
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

function resolveAllPositions(positions, trades, allKl5m, trailing, atrCache, trailATRMult) {
  while (positions.length > 0) {
    const pos = positions.pop();
    const kl = allKl5m[pos.pair];
    let closed = false;
    for (let j = pos.bar + 1; j < kl.length && j <= pos.bar + TIMEOUT_BARS; j++) {
      const result = checkExit(pos, kl[j], trailing, atrCache, trailATRMult, j);
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

function checkExit(pos, bar, trailing, atrCache, trailATRMult, barIdx) {
  // Update high/low water marks for trailing
  if (trailing && pos.trailing) {
    if (pos.dir === 1) {
      if (bar.h > pos.highWater) {
        pos.highWater = bar.h;
        const atrVal = atrCache && atrCache[pos.pair] && barIdx < atrCache[pos.pair].length
          ? atrCache[pos.pair][barIdx] : 0;
        if (atrVal > 0) {
          const newTrail = pos.highWater - atrVal * trailATRMult;
          if (newTrail > pos.sl) pos.sl = newTrail; // only move up
        }
      }
    } else {
      if (bar.l < pos.lowWater) {
        pos.lowWater = bar.l;
        const atrVal = atrCache && atrCache[pos.pair] && barIdx < atrCache[pos.pair].length
          ? atrCache[pos.pair][barIdx] : 0;
        if (atrVal > 0) {
          const newTrail = pos.lowWater + atrVal * trailATRMult;
          if (newTrail < pos.sl) pos.sl = newTrail; // only move down
        }
      }
    }
  }

  let hitSL = false, hitTP = false;
  if (pos.dir === 1) {
    hitSL = bar.l <= pos.sl;
    hitTP = pos.tp !== null && bar.h >= pos.tp;
  } else {
    hitSL = bar.h >= pos.sl;
    hitTP = pos.tp !== null && bar.l <= pos.tp;
  }

  if (hitSL && hitTP) hitTP = false; // SL priority

  if (hitSL) {
    // Slippage: higher in high-ATR environments
    const slip = pos.dir === 1 ? (1 - SLIP_SL) : (1 + SLIP_SL);
    return { type: (trailing && pos.trailing) ? 'TRAIL' : 'SL', price: pos.sl * slip };
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

    // Monthly breakdown
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
// STRATEGY SIGNAL GENERATORS — ROUND 2
// ═══════════════════════════════════════════════════════════════════════════════

// ─── STRATEGY A: EXTREME SELECTIVITY (Mega Score) ───
function strategyASignals(kl, ind, threshold = 20) {
  const signals = [];
  const { c, h, l, o, v, rsi7, rsi14, stoch14, stoch5, macdData, bb, bb25,
          ema9, ema21, ema50, volR, adxData, obvArr, cmfArr, zs50, roc3, cumDeltaArr, atr14 } = ind;

  for (let i = 60; i < kl.length - 3; i++) {
    if (isNaN(rsi14[i]) || isNaN(stoch14.k[i]) || isNaN(adxData.adx[i])) continue;
    let longScore = 0, shortScore = 0;

    // RSI(7) extremes (0-3 pts)
    if (rsi7[i] < 15) longScore += 3; else if (rsi7[i] < 25) longScore += 2; else if (rsi7[i] < 35) longScore += 1;
    if (rsi7[i] > 85) shortScore += 3; else if (rsi7[i] > 75) shortScore += 2; else if (rsi7[i] > 65) shortScore += 1;

    // RSI(14) (0-2 pts)
    if (rsi14[i] < 25) longScore += 2; else if (rsi14[i] < 35) longScore += 1;
    if (rsi14[i] > 75) shortScore += 2; else if (rsi14[i] > 65) shortScore += 1;

    // Stoch(14,3) (0-2 pts)
    if (stoch14.k[i] < 15) longScore += 2; else if (stoch14.k[i] < 25) longScore += 1;
    if (stoch14.k[i] > 85) shortScore += 2; else if (stoch14.k[i] > 75) shortScore += 1;

    // Stoch(5,3) cross (0-2 pts)
    if (!isNaN(stoch5.k[i]) && !isNaN(stoch5.d[i])) {
      if (stoch5.k[i] > stoch5.d[i] && stoch5.k[i - 1] <= stoch5.d[i - 1] && stoch5.k[i] < 30) longScore += 2;
      if (stoch5.k[i] < stoch5.d[i] && stoch5.k[i - 1] >= stoch5.d[i - 1] && stoch5.k[i] > 70) shortScore += 2;
    }

    // MACD histogram direction + cross (0-3 pts)
    if (macdData.hist[i] > 0 && macdData.hist[i - 1] <= 0) longScore += 3;
    else if (macdData.hist[i] > 0 && macdData.hist[i] > macdData.hist[i - 1]) longScore += 1;
    if (macdData.hist[i] < 0 && macdData.hist[i - 1] >= 0) shortScore += 3;
    else if (macdData.hist[i] < 0 && macdData.hist[i] < macdData.hist[i - 1]) shortScore += 1;

    // BB position (0-3 pts)
    const bbRange = bb.up[i] - bb.dn[i];
    if (bbRange > 0) {
      const bbPos = (c[i] - bb.dn[i]) / bbRange;
      if (bbPos < 0.05) longScore += 3; else if (bbPos < 0.15) longScore += 2; else if (bbPos < 0.25) longScore += 1;
      if (bbPos > 0.95) shortScore += 3; else if (bbPos > 0.85) shortScore += 2; else if (bbPos > 0.75) shortScore += 1;
    }

    // EMA alignment (0-3 pts)
    if (ema9[i] > ema21[i] && ema21[i] > ema50[i]) longScore += 2;
    else if (ema9[i] > ema21[i]) longScore += 1;
    if (ema9[i] < ema21[i] && ema21[i] < ema50[i]) shortScore += 2;
    else if (ema9[i] < ema21[i]) shortScore += 1;
    // EMA9/21 cross
    if (ema9[i] > ema21[i] && ema9[i - 1] <= ema21[i - 1]) longScore += 1;
    if (ema9[i] < ema21[i] && ema9[i - 1] >= ema21[i - 1]) shortScore += 1;

    // Volume spike (0-2 pts)
    if (volR[i] > 2.5) { longScore += 2; shortScore += 2; }
    else if (volR[i] > 1.5) { longScore += 1; shortScore += 1; }

    // ADX direction (0-2 pts)
    if (adxData.adx[i] > 25) {
      if (adxData.pdi[i] > adxData.ndi[i]) longScore += 2; else shortScore += 2;
    } else if (adxData.adx[i] > 20) {
      if (adxData.pdi[i] > adxData.ndi[i]) longScore += 1; else shortScore += 1;
    }

    // OBV 5-bar trend (0-1 pt)
    if (i >= 5) {
      if (obvArr[i] > obvArr[i - 5]) longScore += 1; else shortScore += 1;
    }

    // CMF (0-2 pts)
    if (cmfArr[i] > 0.15) longScore += 2; else if (cmfArr[i] > 0.05) longScore += 1;
    if (cmfArr[i] < -0.15) shortScore += 2; else if (cmfArr[i] < -0.05) shortScore += 1;

    // Z-score (0-2 pts)
    if (zs50[i] < -2.5) longScore += 2; else if (zs50[i] < -1.5) longScore += 1;
    if (zs50[i] > 2.5) shortScore += 2; else if (zs50[i] > 1.5) shortScore += 1;

    // ROC momentum alignment (0-1 pt)
    if (roc3[i] > 0 && c[i] > c[i - 1]) longScore += 1;
    if (roc3[i] < 0 && c[i] < c[i - 1]) shortScore += 1;

    // Cumulative delta direction (0-1 pt)
    if (i >= 5) {
      if (cumDeltaArr[i] > cumDeltaArr[i - 5]) longScore += 1;
      else shortScore += 1;
    }

    // Max possible: ~30 pts per side
    if (longScore >= threshold && longScore > shortScore + 3)
      signals.push({ pair: null, bar: i, dir: 1 });
    else if (shortScore >= threshold && shortScore > longScore + 3)
      signals.push({ pair: null, bar: i, dir: -1 });
  }
  return signals;
}

// ─── STRATEGY B: INVERSE MOMENTUM (Counter-Trend Exhaustion) ───
function strategyBSignals(kl, ind) {
  const signals = [];
  const { c, h, l, o, rsi7, stoch5, volR, bb25, bb } = ind;

  for (let i = 10; i < kl.length - 3; i++) {
    if (isNaN(rsi7[i]) || isNaN(stoch5.k[i])) continue;

    // LONG: Bearish exhaustion reversal
    const rsiOversold = rsi7[i] < 15 || (rsi7[i] < 20 && rsi7[i] > rsi7[i - 1]); // extreme or reversing
    const stochBullCross = stoch5.k[i] > stoch5.d[i] && stoch5.k[i - 1] <= stoch5.d[i - 1] && stoch5.k[i] < 30;
    const volSpike = volR[i] > 2.0;
    const atBBLow = !isNaN(bb25.dn[i]) && l[i] <= bb25.dn[i]; // at 2.5 std band
    const reversalCandle = c[i] > o[i] && c[i] > (h[i] + l[i]) / 2; // close above midpoint = bullish

    let longChecks = 0;
    if (rsiOversold) longChecks++;
    if (stochBullCross) longChecks++;
    if (volSpike) longChecks++;
    if (atBBLow) longChecks++;
    if (reversalCandle) longChecks++;

    if (longChecks >= 3) { // need at least 3 of 5 conditions
      signals.push({ pair: null, bar: i, dir: 1 });
    }

    // SHORT: Bullish exhaustion reversal
    const rsiOverbought = rsi7[i] > 85 || (rsi7[i] > 80 && rsi7[i] < rsi7[i - 1]);
    const stochBearCross = stoch5.k[i] < stoch5.d[i] && stoch5.k[i - 1] >= stoch5.d[i - 1] && stoch5.k[i] > 70;
    const atBBHigh = !isNaN(bb25.up[i]) && h[i] >= bb25.up[i];
    const bearReversalCandle = c[i] < o[i] && c[i] < (h[i] + l[i]) / 2;

    let shortChecks = 0;
    if (rsiOverbought) shortChecks++;
    if (stochBearCross) shortChecks++;
    if (volSpike) shortChecks++;
    if (atBBHigh) shortChecks++;
    if (bearReversalCandle) shortChecks++;

    if (shortChecks >= 3) {
      signals.push({ pair: null, bar: i, dir: -1 });
    }
  }
  return signals;
}

// ─── STRATEGY C: TREND CONTINUATION ON PULLBACK ───
function strategyCSignals(kl, ind) {
  const signals = [];
  const { c, h, l, o, rsi14, ema9, ema21, ema50, adxData, atr14 } = ind;

  for (let i = 60; i < kl.length - 3; i++) {
    if (isNaN(adxData.adx[i]) || isNaN(ema50[i]) || isNaN(rsi14[i])) continue;

    // Strong uptrend: ADX > 30, EMA9 > EMA21 > EMA50
    const strongUptrend = adxData.adx[i] > 30 && ema9[i] > ema21[i] && ema21[i] > ema50[i]
      && adxData.pdi[i] > adxData.ndi[i];
    // Strong downtrend: ADX > 30, EMA9 < EMA21 < EMA50
    const strongDowntrend = adxData.adx[i] > 30 && ema9[i] < ema21[i] && ema21[i] < ema50[i]
      && adxData.ndi[i] > adxData.pdi[i];

    if (strongUptrend) {
      // Pullback: price touched EMA21 from above (within 0.1% of EMA21)
      const touchedEMA21 = l[i] <= ema21[i] * 1.001 && c[i] > ema21[i] * 0.998;
      // RSI pulling back (not oversold, just resting: 40-55 range)
      const rsiPullback = rsi14[i] >= 38 && rsi14[i] <= 55;
      // First green candle after pullback
      const greenCandle = c[i] > o[i];
      // Previous bar was red or close to EMA21 (pullback in progress)
      const wasPullingBack = i > 0 && (c[i - 1] < o[i - 1] || l[i - 1] <= ema21[i - 1] * 1.002);

      if (touchedEMA21 && rsiPullback && greenCandle && wasPullingBack) {
        signals.push({ pair: null, bar: i, dir: 1 });
      }
    }

    if (strongDowntrend) {
      const touchedEMA21 = h[i] >= ema21[i] * 0.999 && c[i] < ema21[i] * 1.002;
      const rsiPullback = rsi14[i] >= 45 && rsi14[i] <= 62;
      const redCandle = c[i] < o[i];
      const wasPullingBack = i > 0 && (c[i - 1] > o[i - 1] || h[i - 1] >= ema21[i - 1] * 0.998);

      if (touchedEMA21 && rsiPullback && redCandle && wasPullingBack) {
        signals.push({ pair: null, bar: i, dir: -1 });
      }
    }
  }
  return signals;
}

// ─── STRATEGY D: VOLATILITY CONTRACTION BREAKOUT ───
function strategyDSignals(kl, ind) {
  const signals = [];
  const { c, h, l, o, bb, ema21, macdData, volR } = ind;

  // Compute BB width percentile over 100 bars
  for (let i = 108; i < kl.length - 3; i++) {
    if (isNaN(bb.width[i]) || isNaN(bb.width[i - 1])) continue;

    // Check if current BB width is in bottom 10th percentile of last 100 bars
    const widths = [];
    for (let j = i - 99; j <= i; j++) {
      if (!isNaN(bb.width[j])) widths.push(bb.width[j]);
    }
    if (widths.length < 80) continue;
    widths.sort((a, b) => a - b);
    const pct10 = widths[Math.floor(widths.length * 0.10)];
    const inSqueeze = bb.width[i] <= pct10;
    if (!inSqueeze) continue;

    // Squeeze must last at least 8 bars
    let squeezeDuration = 0;
    for (let j = i; j >= Math.max(i - 30, 0); j--) {
      if (!isNaN(bb.width[j]) && bb.width[j] <= pct10) squeezeDuration++;
      else break;
    }
    if (squeezeDuration < 8) continue;

    // Breakout: first close outside BB
    const breakUp = c[i] > bb.up[i] && c[i - 1] <= bb.up[i - 1];
    const breakDn = c[i] < bb.dn[i] && c[i - 1] >= bb.dn[i - 1];
    if (!breakUp && !breakDn) continue;

    // Direction confirmation: EMA21 slope AND MACD histogram
    const ema21Slope = ema21[i] - ema21[i - 5];
    const macdDir = macdData.hist[i];

    // Volume must be > 1.5x average
    if (volR[i] < 1.5) continue;

    if (breakUp && ema21Slope > 0 && macdDir > 0) {
      signals.push({ pair: null, bar: i, dir: 1 });
    }
    if (breakDn && ema21Slope < 0 && macdDir < 0) {
      signals.push({ pair: null, bar: i, dir: -1 });
    }
  }
  return signals;
}

// ─── STRATEGY E: MULTI-TIMEFRAME MOMENTUM ALIGNMENT ───
function strategyESignals(kl5m, ind5m, kl15m, ind15m, kl1h, ind1h) {
  const signals = [];
  if (!kl15m || !kl1h || !ind15m || !ind1h) return signals;

  for (let i = 20; i < kl5m.length - 3; i++) {
    if (isNaN(ind5m.ema9[i])) continue;
    const curTime = kl5m[i].t;

    // 1H: MACD histogram positive AND increasing
    let h1Idx = -1;
    for (let j = kl1h.length - 1; j >= 0; j--) {
      if (kl1h[j].tClose < curTime) { h1Idx = j; break; }
    }
    if (h1Idx < 2) continue;
    const h1MacdUp = ind1h.macdData.hist[h1Idx] > 0 && ind1h.macdData.hist[h1Idx] > ind1h.macdData.hist[h1Idx - 1];
    const h1MacdDn = ind1h.macdData.hist[h1Idx] < 0 && ind1h.macdData.hist[h1Idx] < ind1h.macdData.hist[h1Idx - 1];

    // 15M: RSI(14) between 40-60 (room to run)
    let m15Idx = -1;
    for (let j = kl15m.length - 1; j >= 0; j--) {
      if (kl15m[j].tClose < curTime) { m15Idx = j; break; }
    }
    if (m15Idx < 2) continue;
    const rsi15 = ind15m.rsi14[m15Idx];
    if (isNaN(rsi15)) continue;
    const rsiMidLong = rsi15 >= 40 && rsi15 <= 60;
    const rsiMidShort = rsi15 >= 40 && rsi15 <= 60;

    // 5M: Price crosses above/below EMA9
    const crossAbove = ind5m.c[i] > ind5m.ema9[i] && ind5m.c[i - 1] <= ind5m.ema9[i - 1];
    const crossBelow = ind5m.c[i] < ind5m.ema9[i] && ind5m.c[i - 1] >= ind5m.ema9[i - 1];

    // All 3 must align
    if (h1MacdUp && rsiMidLong && crossAbove) {
      signals.push({ pair: null, bar: i, dir: 1 });
    }
    if (h1MacdDn && rsiMidShort && crossBelow) {
      signals.push({ pair: null, bar: i, dir: -1 });
    }
  }
  return signals;
}

// ─── STRATEGY F: PATTERN RECOGNITION (Engulfing + Pin Bar at Key Levels) ───
function strategyFSignals(kl, ind) {
  const signals = [];
  const { c, h, l, o, volR } = ind;

  for (let i = 55; i < kl.length - 3; i++) {
    // Find key levels: highest high and lowest low of last 50 bars
    let hh = -Infinity, ll = Infinity;
    for (let j = i - 50; j < i; j++) { hh = Math.max(hh, h[j]); ll = Math.min(ll, l[j]); }

    const range = hh - ll;
    if (range <= 0) continue;
    const nearHigh = Math.abs(h[i] - hh) / hh < 0.003; // within 0.3%
    const nearLow = Math.abs(l[i] - ll) / ll < 0.003;

    if (!nearHigh && !nearLow) continue;

    const bodySize = Math.abs(c[i] - o[i]);
    const candleRange = h[i] - l[i];
    if (candleRange <= 0) continue;

    // Reversal patterns at LOW (bullish)
    if (nearLow) {
      // Bullish engulfing: previous candle red, current candle green and bigger body
      const prevRed = c[i - 1] < o[i - 1];
      const curGreen = c[i] > o[i];
      const engulfing = curGreen && prevRed && c[i] > o[i - 1] && o[i] < c[i - 1];

      // Pin bar: long lower wick (>60% of range), close near high
      const lowerWick = Math.min(o[i], c[i]) - l[i];
      const pinBar = lowerWick > candleRange * 0.6 && c[i] > l[i] + candleRange * 0.7;

      if ((engulfing || pinBar) && volR[i] > 1.3) {
        signals.push({ pair: null, bar: i, dir: 1 });
      }
    }

    // Reversal patterns at HIGH (bearish)
    if (nearHigh) {
      const prevGreen = c[i - 1] > o[i - 1];
      const curRed = c[i] < o[i];
      const engulfing = curRed && prevGreen && c[i] < o[i - 1] && o[i] > c[i - 1];

      const upperWick = h[i] - Math.max(o[i], c[i]);
      const pinBar = upperWick > candleRange * 0.6 && c[i] < h[i] - candleRange * 0.7;

      if ((engulfing || pinBar) && volR[i] > 1.3) {
        signals.push({ pair: null, bar: i, dir: -1 });
      }
    }
  }
  return signals;
}

// ─── STRATEGY G: ADAPTIVE HYBRID (Meta-Strategy) ───
function strategyGSignals(kl5m, ind5m, kl15m, ind15m, kl1h, ind1h, scoreThreshold) {
  // Generate signals from B, C, D, E independently
  const sigsB = strategyBSignals(kl5m, ind5m);
  const sigsC = strategyCSignals(kl5m, ind5m);
  const sigsD = strategyDSignals(kl5m, ind5m);
  const sigsE = strategyESignals(kl5m, ind5m, kl15m, ind15m, kl1h, ind1h);

  // Tag each signal with its source
  sigsB.forEach(s => s._src = 'B');
  sigsC.forEach(s => s._src = 'C');
  sigsD.forEach(s => s._src = 'D');
  sigsE.forEach(s => s._src = 'E');

  const allSigs = [...sigsB, ...sigsC, ...sigsD, ...sigsE];

  // Group signals by bar (within 3-bar window for near-simultaneous signals)
  const barMap = {};
  for (const sig of allSigs) {
    const bucket = Math.floor(sig.bar / 3) * 3; // group within 3-bar windows
    const key = `${bucket}_${sig.dir}`;
    if (!barMap[key]) barMap[key] = { bar: sig.bar, dir: sig.dir, sources: new Set(), count: 0 };
    barMap[key].sources.add(sig._src);
    barMap[key].count++;
    if (sig.bar < barMap[key].bar) barMap[key].bar = sig.bar; // use earliest bar
  }

  // Regime filter
  const { adxData } = ind5m;
  const signals = [];
  let comboSignals = 0;

  for (const key in barMap) {
    const group = barMap[key];
    const i = group.bar;
    if (i >= kl5m.length || isNaN(adxData.adx[i])) continue;

    const adxVal = adxData.adx[i];
    const isTrending = adxVal > 25;
    const isRanging = adxVal < 20;
    const nSources = group.sources.size;
    const isCombo = nSources >= 2;

    if (isCombo) comboSignals++;

    // COMBO signals always pass regardless of regime
    if (isCombo && nSources >= scoreThreshold) {
      signals.push({ pair: null, bar: group.bar, dir: group.dir,
        stratLabel: `G-COMBO-${nSources}`, _combo: nSources });
      continue;
    }

    // Single signals: regime filter
    if (isTrending) {
      // Only C (trend) and E (momentum)
      if (group.sources.has('C') || group.sources.has('E')) {
        signals.push({ pair: null, bar: group.bar, dir: group.dir, stratLabel: 'G-TREND' });
      }
    } else if (isRanging) {
      // Only B (reversal) and D (breakout)
      if (group.sources.has('B') || group.sources.has('D')) {
        signals.push({ pair: null, bar: group.bar, dir: group.dir, stratLabel: 'G-RANGE' });
      }
    } else {
      // Middle ground: take any signal with 2+ sources
      if (nSources >= 2) {
        signals.push({ pair: null, bar: group.bar, dir: group.dir, stratLabel: 'G-MID' });
      }
    }
  }

  return { signals, comboSignals, totalSubSignals: allSigs.length };
}


// ═══════════════════════════════════════════════════════════════════════════════
// GRID SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

function gridSearch(signalsByPair, allKl5m, stratName, slGrid, tpGrid, extraCfg = {}) {
  let bestStats = null, bestCfg = null;
  let tested = 0;
  for (const sl of slGrid) {
    for (const tp of tpGrid) {
      if (!extraCfg.trailing && tp <= sl) continue;
      const allSigs = [];
      for (const pair of PAIRS) {
        if (!signalsByPair[pair]) continue;
        for (const sig of signalsByPair[pair]) {
          allSigs.push({ ...sig, pair, sl, tp: extraCfg.trailing ? undefined : tp });
        }
      }
      const cfg = { sl, tp, ...extraCfg };
      if (extraCfg.trailing) cfg.trailATRMult = tp; // reuse tp param as ATR mult for trailing
      const stats = runBacktest(allSigs, allKl5m, cfg);
      tested++;
      if (!bestStats || stats.pf > bestStats.pf || (stats.pf === bestStats.pf && stats.tradesPerDay > bestStats.tradesPerDay)) {
        bestStats = stats;
        bestCfg = { sl, tp: extraCfg.trailing ? undefined : tp, trailATRMult: extraCfg.trailing ? tp : undefined };
      }
    }
  }
  return { stats: bestStats, cfg: bestCfg, tested };
}

function printStratResult(label, name, result, extraParams = '') {
  const { stats, cfg } = result;
  if (!stats || stats.trades === 0) {
    console.log(`\n${label}: ${name}`);
    console.log('  NO TRADES GENERATED');
    return;
  }
  console.log(`\n${label}: ${name}`);
  let cfgStr = `SL=${(cfg.sl * 100).toFixed(1)}%`;
  if (cfg.tp !== undefined) cfgStr += `, TP=${(cfg.tp * 100).toFixed(1)}%`;
  if (cfg.trailATRMult !== undefined) cfgStr += `, Trail=${cfg.trailATRMult.toFixed(1)}xATR`;
  console.log(`  Best config: ${cfgStr}${extraParams ? ', ' + extraParams : ''}`);
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

  // Per month breakdown
  const months = Object.keys(stats.perMonth).sort();
  if (months.length > 0) {
    console.log('  Monthly breakdown:');
    for (const m of months) {
      const pm = stats.perMonth[m];
      const mpf = pm.gl > 0 ? (pm.gp / pm.gl).toFixed(2) : (pm.gp > 0 ? '999' : '0.00');
      const mwr = pm.n > 0 ? (pm.w / pm.n * 100).toFixed(1) : '0.0';
      const mpnl = pm.gp - pm.gl;
      console.log(`    ${m}: PF ${mpf} | WR ${mwr}% | PnL $${mpnl.toFixed(1)} | ${pm.n} trades`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

(async () => {
  const startRun = Date.now();
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  STRATEGY ROUND 2 — 7 Advanced Strategies × 7 Pairs × 120 Days');
  console.log('  Capital: $500 | Leverage: 5x | Dynamic position sizing');
  console.log('  Fees: 0.02% maker, 0.05% taker, 0.03% SL slippage');
  console.log('  Entry: OPEN of bar+2 | Fill rate: 80% | Max 3 positions');
  console.log('  Target: PF >= 2.0, WR >= 55%, 10+ trades/day');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ─── FETCH ALL DATA ───
  console.log('FETCHING DATA...');
  const allKl5m = {}, allKl15m = {}, allKl1h = {};
  const allInd5m = {}, allInd15m = {}, allInd1h = {};

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

    process.stdout.write('1h');
    const raw1h = await getKlines(pair, '1h', DAYS + 10);
    allKl1h[pair] = parseKlines(raw1h);
    process.stdout.write(`(${allKl1h[pair].length})`);
    console.log(' OK');
  }

  // ─── COMPUTE INDICATORS ───
  console.log('\nCOMPUTING INDICATORS...');
  for (const pair of PAIRS) {
    allInd5m[pair] = computeIndicators(allKl5m[pair]);
    allInd15m[pair] = computeIndicators(allKl15m[pair]);
    allInd1h[pair] = computeIndicators(allKl1h[pair]);
    process.stdout.write(`  ${pair} `);
  }
  console.log('DONE\n');

  const results = {};

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY A: EXTREME SELECTIVITY (Mega Score)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('TESTING STRATEGY A: Extreme Selectivity (Mega Score)...');
  const slGridA = [0.003, 0.005, 0.007, 0.010];
  const tpGridA = [0.020, 0.025, 0.030, 0.040];
  let bestA = null;
  for (const thresh of [16, 18, 20, 22]) {
    const sigsByPair = {};
    let totalSigs = 0;
    for (const pair of PAIRS) {
      sigsByPair[pair] = strategyASignals(allKl5m[pair], allInd5m[pair], thresh);
      totalSigs += sigsByPair[pair].length;
    }
    const result = gridSearch(sigsByPair, allKl5m, `A-thresh${thresh}`, slGridA, tpGridA);
    process.stdout.write(`  thresh=${thresh}: ${totalSigs} raw sigs, ${result.stats ? result.stats.trades : 0} trades, PF=${result.stats ? result.stats.pf.toFixed(2) : '0'} (${result.tested} combos)\n`);
    if (!bestA || (result.stats && result.stats.pf > (bestA.stats ? bestA.stats.pf : 0))) {
      bestA = { ...result, extraParams: `threshold=${thresh}` };
    }
  }
  results['A'] = bestA;

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY B: INVERSE MOMENTUM (Counter-Trend Exhaustion)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nTESTING STRATEGY B: Inverse Momentum (Counter-Trend Exhaustion)...');
  {
    const sigsByPair = {};
    let totalSigs = 0;
    for (const pair of PAIRS) {
      sigsByPair[pair] = strategyBSignals(allKl5m[pair], allInd5m[pair]);
      totalSigs += sigsByPair[pair].length;
    }
    console.log(`  Raw signals: ${totalSigs}`);
    const slGridB = [0.003, 0.005, 0.007, 0.010];
    const tpGridB = [0.006, 0.010, 0.015, 0.020];
    results['B'] = gridSearch(sigsByPair, allKl5m, 'B', slGridB, tpGridB);
    console.log(`  ${results['B'].stats ? results['B'].stats.trades : 0} trades, PF=${results['B'].stats ? results['B'].stats.pf.toFixed(2) : '0'} (${results['B'].tested} combos)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY C: TREND CONTINUATION ON PULLBACK
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nTESTING STRATEGY C: Trend Continuation on Pullback...');
  {
    const sigsByPair = {};
    let totalSigs = 0;
    for (const pair of PAIRS) {
      sigsByPair[pair] = strategyCSignals(allKl5m[pair], allInd5m[pair]);
      totalSigs += sigsByPair[pair].length;
    }
    console.log(`  Raw signals: ${totalSigs}`);
    const slGridC = [0.005, 0.007, 0.010, 0.015];
    const tpGridC = [0.010, 0.015, 0.020, 0.030];
    results['C'] = gridSearch(sigsByPair, allKl5m, 'C', slGridC, tpGridC);
    console.log(`  ${results['C'].stats ? results['C'].stats.trades : 0} trades, PF=${results['C'].stats ? results['C'].stats.pf.toFixed(2) : '0'} (${results['C'].tested} combos)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY D: VOLATILITY CONTRACTION BREAKOUT
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nTESTING STRATEGY D: Volatility Contraction Breakout...');
  {
    const sigsByPair = {};
    let totalSigs = 0;
    for (const pair of PAIRS) {
      sigsByPair[pair] = strategyDSignals(allKl5m[pair], allInd5m[pair]);
      totalSigs += sigsByPair[pair].length;
    }
    console.log(`  Raw signals: ${totalSigs}`);
    const slGridD = [0.005, 0.007, 0.010, 0.015];
    const tpGridD = [0.010, 0.015, 0.020, 0.030, 0.040];
    results['D'] = gridSearch(sigsByPair, allKl5m, 'D', slGridD, tpGridD);
    console.log(`  ${results['D'].stats ? results['D'].stats.trades : 0} trades, PF=${results['D'].stats ? results['D'].stats.pf.toFixed(2) : '0'} (${results['D'].tested} combos)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY E: MULTI-TIMEFRAME MOMENTUM ALIGNMENT (Trailing Stop)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nTESTING STRATEGY E: Multi-TF Momentum Alignment (Trailing Stop)...');
  {
    const sigsByPair = {};
    let totalSigs = 0;
    for (const pair of PAIRS) {
      sigsByPair[pair] = strategyESignals(
        allKl5m[pair], allInd5m[pair],
        allKl15m[pair], allInd15m[pair],
        allKl1h[pair], allInd1h[pair]
      );
      totalSigs += sigsByPair[pair].length;
    }
    console.log(`  Raw signals: ${totalSigs}`);
    // For trailing: sl = initial SL, tp param = ATR multiplier for trailing
    const slGridE = [0.003, 0.005, 0.007, 0.010];
    const trailMultGrid = [1.5, 2.0, 2.5, 3.0];
    results['E'] = gridSearch(sigsByPair, allKl5m, 'E', slGridE, trailMultGrid, { trailing: true });
    console.log(`  ${results['E'].stats ? results['E'].stats.trades : 0} trades, PF=${results['E'].stats ? results['E'].stats.pf.toFixed(2) : '0'} (${results['E'].tested} combos)`);

    // Also test E with fixed TP for comparison
    console.log('  Also testing E with fixed TP...');
    const slGridEfixed = [0.003, 0.005, 0.007, 0.010];
    const tpGridEfixed = [0.010, 0.015, 0.020, 0.030];
    const eFixed = gridSearch(sigsByPair, allKl5m, 'E-fixed', slGridEfixed, tpGridEfixed);
    console.log(`  E (fixed TP): ${eFixed.stats ? eFixed.stats.trades : 0} trades, PF=${eFixed.stats ? eFixed.stats.pf.toFixed(2) : '0'}`);
    // Keep whichever is better
    if (eFixed.stats && eFixed.stats.pf > (results['E'].stats ? results['E'].stats.pf : 0)) {
      results['E'] = eFixed;
      results['E'].extraParams = 'fixed-TP';
    } else {
      results['E'].extraParams = 'trailing';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY F: PATTERN RECOGNITION (Engulfing + Pin Bar at Key Levels)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nTESTING STRATEGY F: Pattern Recognition at Key Levels...');
  {
    const sigsByPair = {};
    let totalSigs = 0;
    for (const pair of PAIRS) {
      sigsByPair[pair] = strategyFSignals(allKl5m[pair], allInd5m[pair]);
      totalSigs += sigsByPair[pair].length;
    }
    console.log(`  Raw signals: ${totalSigs}`);
    const slGridF = [0.003, 0.005, 0.007, 0.010];
    const tpGridF = [0.006, 0.010, 0.015, 0.020, 0.025];
    results['F'] = gridSearch(sigsByPair, allKl5m, 'F', slGridF, tpGridF);
    console.log(`  ${results['F'].stats ? results['F'].stats.trades : 0} trades, PF=${results['F'].stats ? results['F'].stats.pf.toFixed(2) : '0'} (${results['F'].tested} combos)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGY G: ADAPTIVE HYBRID (Meta-Strategy)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\nTESTING STRATEGY G: Adaptive Hybrid (Meta-Strategy)...');
  let bestG = null;
  for (const scoreThresh of [1, 2, 3]) {
    const sigsByPair = {};
    let totalSigs = 0, totalCombos = 0, totalSubSigs = 0;
    for (const pair of PAIRS) {
      const result = strategyGSignals(
        allKl5m[pair], allInd5m[pair],
        allKl15m[pair], allInd15m[pair],
        allKl1h[pair], allInd1h[pair],
        scoreThresh
      );
      sigsByPair[pair] = result.signals;
      totalSigs += result.signals.length;
      totalCombos += result.comboSignals;
      totalSubSigs += result.totalSubSignals;
    }
    console.log(`  scoreThresh=${scoreThresh}: ${totalSigs} signals (${totalCombos} combos from ${totalSubSigs} sub-signals)`);

    const slGridG = [0.003, 0.005, 0.007, 0.010];
    const tpGridG = [0.010, 0.015, 0.020, 0.030];
    const gResult = gridSearch(sigsByPair, allKl5m, `G-t${scoreThresh}`, slGridG, tpGridG);
    process.stdout.write(`    ${gResult.stats ? gResult.stats.trades : 0} trades, PF=${gResult.stats ? gResult.stats.pf.toFixed(2) : '0'} (${gResult.tested} combos)\n`);

    if (!bestG || (gResult.stats && gResult.stats.pf > (bestG.stats ? bestG.stats.pf : 0))) {
      bestG = { ...gResult, extraParams: `comboThreshold=${scoreThresh}, combos=${totalCombos}` };
    }
  }
  results['G'] = bestG;

  // ═══════════════════════════════════════════════════════════════════════════
  // RESULTS SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n\n═══════════════════════════════════════════════════════════════════');
  console.log('  ROUND 2 RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════');

  const stratNames = {
    A: 'Extreme Selectivity (Mega Score)',
    B: 'Inverse Momentum (Counter-Trend Exhaustion)',
    C: 'Trend Continuation on Pullback',
    D: 'Volatility Contraction Breakout',
    E: 'Multi-TF Momentum Alignment',
    F: 'Pattern Recognition at Key Levels',
    G: 'Adaptive Hybrid (Meta-Strategy)'
  };

  for (const key of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
    if (results[key]) {
      printStratResult(`STRATEGY ${key}`, stratNames[key], results[key], results[key].extraParams || '');
    }
  }

  // ─── LEADERBOARD ───
  console.log('\n\n═══════════════════════════════════════════════════════════════════');
  console.log('  LEADERBOARD (sorted by PF)');
  console.log('═══════════════════════════════════════════════════════════════════');
  const board = [];
  for (const key of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
    const r = results[key];
    if (r && r.stats && r.stats.trades > 0) {
      board.push({ key, name: stratNames[key], pf: r.stats.pf, wr: r.stats.wr,
        tpd: r.stats.tradesPerDay, pnl: r.stats.pnl, dd: r.stats.maxDD, trades: r.stats.trades });
    }
  }
  board.sort((a, b) => b.pf - a.pf);
  console.log('  #  Strategy                                  PF    WR%   T/day  PnL      DD%   Trades');
  console.log('  ─────────────────────────────────────────────────────────────────────────────────────');
  for (let i = 0; i < board.length; i++) {
    const b = board[i];
    console.log(`  ${i + 1}. ${(b.key + ': ' + b.name).padEnd(42)} ${b.pf.toFixed(2).padStart(5)} ${b.wr.toFixed(1).padStart(5)}  ${b.tpd.toFixed(1).padStart(5)}  $${b.pnl.toFixed(0).padStart(6)}  ${b.dd.toFixed(1).padStart(5)}  ${String(b.trades).padStart(5)}`);
  }

  // ─── TARGET CHECK ───
  console.log('\n  TARGET CHECK (PF >= 2.0, WR >= 55%, T/day >= 10):');
  const meetsTarget = board.filter(b => b.pf >= 2.0 && b.wr >= 55 && b.tpd >= 10);
  if (meetsTarget.length > 0) {
    console.log(`  >>> ${meetsTarget.length} STRATEGIES MEET ALL TARGETS <<<`);
    for (const b of meetsTarget) console.log(`      ${b.key}: ${b.name}`);
  } else {
    console.log('  >>> NO strategy meets ALL 3 targets simultaneously <<<');
    const close = board.filter(b => b.pf >= 1.5 || b.wr >= 50 || b.tpd >= 8);
    if (close.length > 0) {
      console.log('  Closest candidates:');
      for (const b of close) {
        const flags = [];
        if (b.pf >= 2.0) flags.push('PF OK'); else flags.push(`PF ${b.pf.toFixed(2)}`);
        if (b.wr >= 55) flags.push('WR OK'); else flags.push(`WR ${b.wr.toFixed(1)}%`);
        if (b.tpd >= 10) flags.push('T/day OK'); else flags.push(`T/day ${b.tpd.toFixed(1)}`);
        console.log(`      ${b.key}: ${flags.join(' | ')}`);
      }
    }
  }

  const elapsed = ((Date.now() - startRun) / 1000).toFixed(0);
  console.log(`\nCompleted in ${elapsed}s`);
})();
