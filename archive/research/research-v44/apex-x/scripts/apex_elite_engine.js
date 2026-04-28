'use strict';
// APEX ELITE — Funding Carry Professional
// Base: V44 validated funding carry
// Enhancements (8): z-score sizing, multi-window, dynamic TP/SL, term structure,
//                  OI-proxy filter, post-trade momentum exit, pair rotation, cross-exchange proxy
const fs=require('fs');const path=require('path');
const E=require('./apex_x_engine.js');

const INIT_CAP=500;

// V44 frozen base params
const BASE_PARAMS = {
  TP_BPS_MID: 30,        // TP baseline
  SL_BPS_MID: 25,        // SL baseline
  HOLD_H: 4,
  P80_Q: 0.80,
  P20_Q: 0.20,
  F_POS_MIN: 0.005,
  F_NEG_MAX: -0.002,
  SIZE_PCT_MID: 0.10
};

// ELITE enhancement parameters
const ELITE_PARAMS = {
  // Mejora 1: confidence sizing by funding z-score (softer extreme to preserve DD≤3%)
  Z_LOW: 1.0,    Z_MID: 2.0,   Z_HIGH: 3.0,
  SIZE_MULT_LOW: 0.7, SIZE_MULT_NORMAL: 1.0, SIZE_MULT_HIGH: 1.35, SIZE_MULT_EXTREME: 1.6,
  // Mejora 2: multi-window (3 windows per settlement hour, 20-min each = 60min total window)
  SETTLEMENT_HOURS: [0, 8, 16],
  PRE_WINDOW_MIN: -60,  // T-60 to T-30 (pre-momentum)
  MID_WINDOW_MIN: -30,  // T-30 to T+0 (peak window)
  POST_WINDOW_MIN: 0,   // T+0 to T+30 (unwind)
  // Mejora 3: dynamic TP/SL by ATR regime — conservative multipliers to preserve WR
  ATR_LOW: 0.003,  ATR_HIGH: 0.008,
  TP_MULT_LOW: 0.9, TP_MULT_HIGH: 1.25,  // softer scaling
  SL_MULT_LOW: 0.9, SL_MULT_HIGH: 1.25,
  // Mejora 4: term structure filter
  TERM_LOOKBACK_24H: 24, TERM_LOOKBACK_7D: 168,
  TERM_AGREE_MIN: 0.5,   // sign-alignment score minimum
  // Mejora 6: OI proxy via volume-delta (volume × close change)
  OI_PROXY_WINDOW: 8,    // bars
  OI_MIN_CONFIRM: 0.15,  // normalized OI change minimum
  // Mejora 7: momentum exit
  MOM_EXIT_CHECK_BARS: 1, // check after N bar (1h = bar resolution)
  MOM_EXIT_THRESHOLD: 0.5, // 50% of TP distance hit → trail tight
  // Mejora 8: pair rotation
  ROTATE_WINDOW_D: 30,   // rolling window
  ROTATE_MIN_PF: 1.2
};

const CLUSTERS = {
  BTCUSDT:'L1major',ETHUSDT:'L1major',SOLUSDT:'SOLadj',SUIUSDT:'SOLadj',NEARUSDT:'SOLadj',
  LINKUSDT:'DeFi',ATOMUSDT:'DeFi',INJUSDT:'DeFi',ARBUSDT:'L2',POLUSDT:'L2',
  XRPUSDT:'Other',ADAUSDT:'Other',TRXUSDT:'Other','1000PEPEUSDT':'MemesAI',RENDERUSDT:'MemesAI'
};

// ATR (Average True Range) computation for an array of {h,l,c} bars
function computeATR(bars, period = 14) {
  const n = bars.length;
  const atr = new Float64Array(n);
  if (n < 2) return atr;
  const tr = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i-1].c;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  // EMA of TR with period
  const alpha = 2 / (period + 1);
  atr[period] = tr.slice(1, period+1).reduce((a,b)=>a+b, 0) / period;
  for (let i = period+1; i < n; i++) atr[i] = tr[i] * alpha + atr[i-1] * (1 - alpha);
  return atr;
}

// Funding term structure: rolling means at 24h, 7d, 30d
function computeTermStructure(fundArr) {
  const n = fundArr.length;
  const f24 = new Float64Array(n);
  const f7d = new Float64Array(n);
  const f30d = new Float64Array(n);
  for (let i = 30*24; i < n; i++) {
    let s24 = 0, s7d = 0, s30d = 0;
    for (let j = i - 24 + 1; j <= i; j++) s24 += fundArr[j];
    for (let j = i - 168 + 1; j <= i; j++) s7d += fundArr[j];
    for (let j = i - 720 + 1; j <= i; j++) s30d += fundArr[j];
    f24[i] = s24 / 24;
    f7d[i] = s7d / 168;
    f30d[i] = s30d / 720;
  }
  return { f24, f7d, f30d };
}

// Z-score of funding at index i (rolling 30d)
function fundingZScore(fundArr, i, lookback = 720) {
  if (i < lookback) return 0;
  let sum = 0;
  for (let j = i - lookback + 1; j <= i; j++) sum += fundArr[j];
  const mean = sum / lookback;
  let vsum = 0;
  for (let j = i - lookback + 1; j <= i; j++) vsum += (fundArr[j] - mean) ** 2;
  const std = Math.sqrt(vsum / lookback);
  return std > 0 ? (fundArr[i] - mean) / std : 0;
}

// Volume-delta OI proxy: cumulative signed volume × price change
function computeOIProxy(bars, window = 8) {
  const n = bars.length;
  const oi = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const ret = (bars[i].c - bars[i-1].c) / bars[i-1].c;
    const signed = Math.sign(ret) * bars[i].v;
    oi[i] = oi[i-1] + signed;
  }
  // Rolling change over window
  const oiDelta = new Float64Array(n);
  for (let i = window; i < n; i++) {
    oiDelta[i] = (oi[i] - oi[i-window]) / Math.abs(oi[i-window] || 1);
  }
  return oiDelta;
}

// Main ELITE engine
function runEliteOnData(allData, pairs, cfg = {}) {
  const stages = cfg.stages || { m1_zsizing:true, m2_multiwin:true, m3_dyntp:true, m4_termstruct:false, m6_oifilter:false, m7_momexit:false, m8_rotation:false };
  const capital = cfg.capital || INIT_CAP;
  const trades = [];
  let cap = capital;
  const bp = BASE_PARAMS;
  const ep = ELITE_PARAMS;

  for (const pair of pairs) {
    const data = allData[pair];
    if (!data || !data.b1h || data.b1h.length < 218) continue;
    const bars = data.b1h;
    const fund = E.proxyFunding(bars);
    if (!fund) continue;
    const atr = computeATR(bars, 14);
    const oiDelta = stages.m6_oifilter ? computeOIProxy(bars, ep.OI_PROXY_WINDOW) : null;
    let pos = null;

    for (let i = 720; i < bars.length - bp.HOLD_H; i++) {
      const bar = bars[i];
      const ts = bar.t;
      const d = new Date(ts);
      const hr = d.getUTCHours();
      const min = d.getUTCMinutes();

      // Position exit handling
      if (pos) {
        const entry = pos.entry;
        const dir = pos.dir;
        const h = bar.h, l = bar.l;
        const tpP = pos.tpP;
        const slP = pos.slP;
        const hitTP = (dir === 1 && h >= tpP) || (dir === -1 && l <= tpP);
        const hitSL = (dir === 1 && l <= slP) || (dir === -1 && h >= slP);

        // Mejora 7: momentum exit — if >50% of TP reached in first hour, tighten SL to entry
        if (stages.m7_momexit && !pos.momTightened && i - pos.entryI >= ep.MOM_EXIT_CHECK_BARS) {
          const tpDist = Math.abs(tpP - entry);
          const curMove = dir === 1 ? (bar.c - entry) : (entry - bar.c);
          if (curMove >= tpDist * ep.MOM_EXIT_THRESHOLD) {
            // Tighten SL to entry + tiny cushion
            pos.slP = dir === 1 ? entry * 1.0005 : entry * 0.9995;
            pos.momTightened = true;
          }
        }

        const timeout = i >= pos.entryI + bp.HOLD_H;
        if (hitTP || hitSL || timeout) {
          const exitP = hitTP ? tpP : (hitSL ? slP : bar.c);
          const pnlPct = dir === 1 ? (exitP - entry) / entry : (entry - exitP) / entry;
          const pnl = pos.size * pnlPct - pos.size * 0.0008; // realistic fees
          cap += pnl;
          trades.push({
            time: ts, pair, dir, entry, exit: exitP, pnl,
            size: pos.size, zscore: pos.zscore, windowType: pos.windowType,
            type: hitTP ? 'TP' : (hitSL ? 'SL' : 'TO'),
            engine: 'APEX_ELITE'
          });
          pos = null;
        }
      }

      if (pos) continue;

      // ENTRY LOGIC — only at relevant windows (bars are hourly, use adjacent hours)
      // Mejora 2: multi-window — 3 adjacent hours per settlement (PRE=sh-1, MID=sh, POST=sh+1)
      let windowType = null;
      if (stages.m2_multiwin) {
        for (const sh of ep.SETTLEMENT_HOURS) {
          const preHr = (sh - 1 + 24) % 24;
          const postHr = (sh + 1) % 24;
          if (hr === preHr) { windowType = 'PRE'; break; }
          if (hr === sh)    { windowType = 'MID'; break; }
          if (hr === postHr){ windowType = 'POST'; break; }
        }
      } else {
        if (ep.SETTLEMENT_HOURS.includes(hr)) windowType = 'MID';
      }
      if (!windowType) continue;

      const f = fund[i];
      if (!isFinite(f)) continue;

      // Build rolling window (168h) for percentiles
      const fWin = Array.from(fund.slice(Math.max(0, i - 168), i)).filter(isFinite);
      if (fWin.length < 50) continue;
      const sorted = [...fWin].sort((a, b) => a - b);
      const p80 = sorted[Math.floor(sorted.length * bp.P80_Q)] || 0;
      const p20 = sorted[Math.floor(sorted.length * bp.P20_Q)] || 0;

      // Original entry rules
      let dir = 0;
      if (f > p80 && f > bp.F_POS_MIN) dir = -1;
      else if (f < p20 && f < bp.F_NEG_MAX) dir = 1;
      if (dir === 0) continue;

      // Mejora 4: term structure filter
      if (stages.m4_termstruct) {
        // Simple term structure: sign of 24h mean must agree with current signal direction
        // If signal is SHORT (funding high), 24h mean of funding should also be positive
        let sum24 = 0;
        for (let j = i - 24 + 1; j <= i; j++) sum24 += fund[j];
        const mean24 = sum24 / 24;
        const termSign = Math.sign(mean24);
        // Trade only if 24h avg agrees with current direction (signal sign * termSign)
        // Short signal (dir=-1) wants high funding mean → termSign > 0
        if (dir === -1 && termSign <= 0) continue;
        if (dir === 1 && termSign >= 0) continue;
      }

      // Mejora 6: OI confirmation filter
      if (stages.m6_oifilter && oiDelta) {
        const oiC = oiDelta[i];
        if (!isFinite(oiC)) continue;
        // Short signal + OI rising (bearish posicionándose) = GOOD
        // Long signal + OI rising = longs acumulando = GOOD
        if (dir === -1 && oiC > -ep.OI_MIN_CONFIRM) continue; // need OI down (shorts stacking)
        if (dir === 1 && oiC < ep.OI_MIN_CONFIRM) continue;   // need OI up (longs stacking)
      }

      // Compute confidence (z-score)
      const z = fundingZScore(fund, i);
      const absZ = Math.abs(z);

      // Mejora 1: size by z-score
      let sizeMult = ep.SIZE_MULT_NORMAL;
      if (stages.m1_zsizing) {
        if (absZ >= ep.Z_HIGH) sizeMult = ep.SIZE_MULT_EXTREME;
        else if (absZ >= ep.Z_MID) sizeMult = ep.SIZE_MULT_HIGH;
        else if (absZ < ep.Z_LOW) sizeMult = ep.SIZE_MULT_LOW;
      }

      // Mejora 3: dynamic TP/SL by volatility
      let tpBps = bp.TP_BPS_MID;
      let slBps = bp.SL_BPS_MID;
      if (stages.m3_dyntp) {
        const atrPct = atr[i] / bar.c;
        if (atrPct < ep.ATR_LOW) { tpBps *= ep.TP_MULT_LOW; slBps *= ep.SL_MULT_LOW; }
        else if (atrPct > ep.ATR_HIGH) { tpBps *= ep.TP_MULT_HIGH; slBps *= ep.SL_MULT_HIGH; }
      }

      const entry = bar.c;
      const tpP = dir === 1 ? entry * (1 + tpBps / 10000) : entry * (1 - tpBps / 10000);
      const slP = dir === 1 ? entry * (1 - slBps / 10000) : entry * (1 + slBps / 10000);
      const size = cap * bp.SIZE_PCT_MID * sizeMult;

      pos = { entry, dir, entryI: i, size, tpP, slP, zscore: z, windowType, momTightened: false };
    }
  }

  return trades;
}

function computeStats(trades, initCap = INIT_CAP, totalDays = 274) {
  if (!trades.length) return { n:0, pf:0, wr:0, dd_pct:0, sharpe:0, pnl:0, pnl_pct:0, tpd:0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gw = wins.reduce((s,t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s,t) => s + t.pnl, 0));
  const byDay = {};
  for (const t of trades) {
    const d = new Date(t.time).toISOString().slice(0,10);
    byDay[d] = (byDay[d]||0) + t.pnl;
  }
  const daily = Object.values(byDay);
  const mean = daily.reduce((a,b)=>a+b,0) / daily.length;
  const variance = daily.reduce((a,b)=>a+(b-mean)**2,0) / daily.length;
  const sharpe = variance > 0 ? mean/Math.sqrt(variance)*Math.sqrt(365) : 0;
  let cum=0, pk=0, mdd=0;
  for (const t of trades) { cum += t.pnl; if (cum > pk) pk = cum; if (pk - cum > mdd) mdd = pk - cum; }
  const pnl = gw - gl;
  return {
    n: trades.length,
    pf: gl > 0 ? gw/gl : (gw > 0 ? 99 : 0),
    wr: wins.length / trades.length * 100,
    dd_pct: mdd / (initCap + Math.max(0, pnl)) * 100,
    sharpe, pnl,
    pnl_pct: pnl / initCap * 100,
    tpd: trades.length / totalDays
  };
}

module.exports = { runEliteOnData, computeStats, BASE_PARAMS, ELITE_PARAMS, INIT_CAP };
