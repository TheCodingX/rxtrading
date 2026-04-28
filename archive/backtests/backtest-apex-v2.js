#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════
// APEX V2 — Structural Pattern Engine (Zero-Bias)
// ═══════════════════════════════════════════════════════════════════════
//
// V1 showed: confluence scoring alone has NO edge after realistic costs.
// V2 changes:
//   1. Remove confirmation bar (was delaying entry past the edge)
//   2. HTF is scored (+5/+2/-3) not mandatory (allows neutral-trend trades)
//   3. Add TRAILING STOP (move SL to breakeven after 1x R profit)
//   4. Add structural patterns: Pullback, Breakout, Divergence
//   5. Raw signal quality diagnostic (detects if signals have edge)
//   6. Wider grid with more configurations
//
// Same zero-bias guarantees as V1 (see BIAS CHECKLIST at bottom)
// ═══════════════════════════════════════════════════════════════════════

const https = require('https');

// ── CONFIG ───────────────────────────────────────────────────────────
const END_TS = new Date('2026-04-15T00:00:00Z').getTime();
const DAYS = 300, IS_DAYS = 200;
const PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT'];

const INIT_CAP = 500, POS_SIZE = 2500, MAX_POS = 1;
const FEE_ENTRY = 0.0004, FEE_TP = 0.0002, FEE_SL = 0.0005;
const SLIP_ENTRY = 0.00005, SLIP_SL = 0.0003;
const ENTRY_DELAY = 2, TIMEOUT = 120, COOLDOWN = 4;
const FILL_RATE = 0.80, PRNG_SEED = 314159265;

// Grid — 3 strategy types × parameter space
const GRID = {
  // Strategy type: 'confluence', 'pullback', 'breakout'
  strategy: ['confluence', 'pullback', 'breakout'],
  slATRMult: [0.8, 1.0, 1.3, 1.6, 2.0],
  tpRatio: [1.3, 1.5, 2.0, 2.5, 3.0],
  trailing: [false, true]
};

// ── UTILITIES ────────────────────────────────────────────────────────
function createPRNG(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function httpGet(url) {
  return new Promise((res, rej) => {
    https.get(url, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d));}catch(e){rej(e);}}); }).on('error',rej);
  });
}

async function getKlines(sym, intv, startTs, endTs) {
  let all = [], cur = startTs;
  while (cur < endTs) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${intv}&startTime=${Math.floor(cur)}&endTime=${Math.floor(endTs)}&limit=1500`;
    const k = await httpGet(url);
    if (!k.length) break;
    all = all.concat(k); cur = parseInt(k[k.length-1][6]) + 1;
    await new Promise(r => setTimeout(r, 180));
  }
  return all;
}

function parse(klines) {
  const n = klines.length;
  const o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n);
  const c = new Float64Array(n), v = new Float64Array(n), t = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = +klines[i][0]; o[i] = +klines[i][1]; h[i] = +klines[i][2];
    l[i] = +klines[i][3]; c[i] = +klines[i][4]; v[i] = +klines[i][5];
  }
  return { o, h, l, c, v, t, n };
}

// ── INDICATORS ───────────────────────────────────────────────────────
function calcSMA(a,p){const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;}
function calcEMA(a,p){const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;}
function calcRSI(c,p=14){const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;}
function calcBB(c,p=20,m=2){const mid=calcSMA(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const std=Math.sqrt(sq/p);up[i]=mid[i]+m*std;dn[i]=mid[i]-m*std;}return{mid,up,dn};}
function calcMACD(c){const ef=calcEMA(c,12),es=calcEMA(c,26),line=new Float64Array(c.length);for(let i=0;i<c.length;i++)line[i]=ef[i]-es[i];const sig=calcEMA(line,9),hist=new Float64Array(c.length);for(let i=0;i<c.length;i++)hist[i]=line[i]-sig[i];return{hist};}
function calcStochK(h,l,c,kp=14){const n=c.length,k=new Float64Array(n).fill(NaN);for(let i=kp-1;i<n;i++){let hh=-Infinity,ll=Infinity;for(let j=i-kp+1;j<=i;j++){if(h[j]>hh)hh=h[j];if(l[j]<ll)ll=l[j];}k[i]=hh===ll?50:(c[i]-ll)/(hh-ll)*100;}return k;}
function calcADX(h,l,c,p=14){const n=c.length,tr=new Float64Array(n),pdm=new Float64Array(n),ndm=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pdm[i]=u>d&&u>0?u:0;ndm[i]=d>u&&d>0?d:0;}const atr=calcEMA(tr,p),sp=calcEMA(pdm,p),sn=calcEMA(ndm,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:calcEMA(dx,p),atr};}
function calcATR(h,l,c,p=14){const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return calcEMA(tr,p);}
function calcZScore(c,p=20){const mid=calcSMA(c,p),r=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i]))continue;let sq=0;for(let j=Math.max(0,i-p+1);j<=i;j++)sq+=(c[j]-mid[i])**2;const std=Math.sqrt(sq/p);r[i]=std?(c[i]-mid[i])/std:0;}return r;}

// Highest High / Lowest Low over a lookback window
function calcHH(h, p) { const r = new Float64Array(h.length); for(let i=0;i<h.length;i++){let hh=-Infinity;for(let j=Math.max(0,i-p+1);j<=i;j++)if(h[j]>hh)hh=h[j];r[i]=hh;}return r; }
function calcLL(l, p) { const r = new Float64Array(l.length); for(let i=0;i<l.length;i++){let ll=Infinity;for(let j=Math.max(0,i-p+1);j<=i;j++)if(l[j]<ll)ll=l[j];r[i]=ll;}return r; }

// ── HTF HELPERS ──────────────────────────────────────────────────────
function precomputeHTF(kl1h) {
  if (!kl1h || kl1h.length < 25) return null;
  const ct = kl1h.map(k => parseInt(k[6]));
  const cl = new Float64Array(kl1h.map(k => +k[4]));
  const hi = new Float64Array(kl1h.map(k => +k[2]));
  const lo = new Float64Array(kl1h.map(k => +k[3]));
  const e9 = calcEMA(cl, 9), e21 = calcEMA(cl, 21);
  const trends = new Int8Array(cl.length);
  for (let i = 21; i < cl.length; i++) trends[i] = e9[i] > e21[i] ? 1 : -1;
  const a = calcADX(hi, lo, cl);
  return { ct, trends, adx: a.adx };
}

function htfLookup(htf, barTime) {
  if (!htf) return -1;
  let lo = 0, hi = htf.ct.length - 1, best = -1;
  while (lo <= hi) { const m = (lo+hi)>>1; if (htf.ct[m] <= barTime) { best = m; lo = m+1; } else hi = m-1; }
  return best;
}

// ── SIGNAL GENERATION — 3 Strategy Types ─────────────────────────────

// Strategy 1: Confluence Scorer V2 (HTF scored, no confirmation bar)
function genConfluence(d5, htf, slATRMult, tpRatio) {
  const { c, h, l, v, o, t, n } = d5;
  const r14 = calcRSI(c,14), sk = calcStochK(h,l,c,14);
  const bb = calcBB(c,20,2), mac = calcMACD(c);
  const vSma = calcSMA(v,20), e9 = calcEMA(c,9), e21 = calcEMA(c,21);
  const adxD = calcADX(h,l,c,14), atr14 = calcATR(h,l,c,14);
  const zsc = calcZScore(c,20);
  const sigs = [];
  let lastBar = -COOLDOWN - 1;
  const MIN_SCORE = 10; // Fixed for confluence

  for (let i = 55; i < n - TIMEOUT - ENTRY_DELAY; i++) {
    if (i - lastBar < COOLDOWN) continue;
    const barTime = t[i];
    const hi2 = htfLookup(htf, barTime);
    if (hi2 < 21) continue;
    const htfTr = htf.trends[hi2];
    const volR = vSma[i] > 0 ? v[i] / vSma[i] : 1;

    // ── LONG ──
    {
      let sc = 0;
      // HTF (scored, not mandatory)
      if (htfTr === 1) sc += 5;
      else if (htfTr === 0) sc += 2;
      else sc -= 3; // contra-trend penalty
      // Indicators
      if (r14[i] < 25) sc += 3; else if (r14[i] < 35) sc += 2; else if (r14[i] < 45) sc += 1;
      if (!isNaN(sk[i]) && sk[i] < 15) sc += 3; else if (!isNaN(sk[i]) && sk[i] < 25) sc += 2;
      if (!isNaN(bb.dn[i]) && c[i] <= bb.dn[i]) sc += 2;
      if (i > 0 && mac.hist[i] > mac.hist[i-1] && mac.hist[i-1] < 0) sc += 2;
      if (volR > 2.0) sc += 3; else if (volR > 1.5) sc += 1;
      if (zsc[i] < -2) sc += 2;
      if (e9[i] > e21[i]) sc += 1;
      if (adxD.adx[i] > 20) sc += 1;

      if (sc >= MIN_SCORE) {
        const atrPct = atr14[i] / c[i];
        let slPct = Math.max(0.002, Math.min(0.025, atrPct * slATRMult));
        let tpPct = Math.max(0.003, Math.min(0.06, slPct * tpRatio));
        sigs.push({ bar: i, dir: 1, sl: slPct, tp: tpPct, ts: barTime, type: 'CONF' });
        lastBar = i;
      }
    }

    // ── SHORT ──
    {
      let sc = 0;
      if (htfTr === -1) sc += 5; else if (htfTr === 0) sc += 2; else sc -= 3;
      if (r14[i] > 75) sc += 3; else if (r14[i] > 65) sc += 2; else if (r14[i] > 55) sc += 1;
      if (!isNaN(sk[i]) && sk[i] > 85) sc += 3; else if (!isNaN(sk[i]) && sk[i] > 75) sc += 2;
      if (!isNaN(bb.up[i]) && c[i] >= bb.up[i]) sc += 2;
      if (i > 0 && mac.hist[i] < mac.hist[i-1] && mac.hist[i-1] > 0) sc += 2;
      if (volR > 2.0) sc += 3; else if (volR > 1.5) sc += 1;
      if (zsc[i] > 2) sc += 2;
      if (e9[i] < e21[i]) sc += 1;
      if (adxD.adx[i] > 20) sc += 1;

      if (sc >= MIN_SCORE) {
        const atrPct = atr14[i] / c[i];
        let slPct = Math.max(0.002, Math.min(0.025, atrPct * slATRMult));
        let tpPct = Math.max(0.003, Math.min(0.06, slPct * tpRatio));
        sigs.push({ bar: i, dir: -1, sl: slPct, tp: tpPct, ts: barTime, type: 'CONF' });
        lastBar = i;
      }
    }
  }
  return sigs;
}

// Strategy 2: Trend Pullback (buy the dip in uptrend)
function genPullback(d5, htf, slATRMult, tpRatio) {
  const { c, h, l, v, o, t, n } = d5;
  const r14 = calcRSI(c,14), e21 = calcEMA(c,21), e50 = calcEMA(c,50);
  const atr14 = calcATR(h,l,c,14), vSma = calcSMA(v,20);
  const adxD = calcADX(h,l,c,14);
  const sigs = [];
  let lastBar = -COOLDOWN - 1;

  for (let i = 55; i < n - TIMEOUT - ENTRY_DELAY; i++) {
    if (i - lastBar < COOLDOWN) continue;
    const barTime = t[i];
    const hi2 = htfLookup(htf, barTime);
    if (hi2 < 21) continue;
    const htfTr = htf.trends[hi2];

    // LONG pullback: 1H uptrend, 5m price touched EMA21, RSI recovering from dip
    if (htfTr === 1 && adxD.adx[i] > 20) {
      // Price near or below EMA21 (within 0.3%)
      const dist21 = (c[i] - e21[i]) / e21[i];
      const isTrending = e21[i] > e50[i]; // EMA21 above EMA50 = uptrend
      const isPullback = dist21 < 0.003 && dist21 > -0.01; // Price near EMA21
      const rsiDip = r14[i] > 30 && r14[i] < 45; // RSI pulling back, not extreme
      const rsiTurning = i > 0 && r14[i] > r14[i-1]; // RSI turning up
      const volNormal = vSma[i] > 0 ? v[i] / vSma[i] : 1;

      if (isTrending && isPullback && rsiDip && rsiTurning && volNormal > 0.8) {
        const atrPct = atr14[i] / c[i];
        let slPct = Math.max(0.002, Math.min(0.025, atrPct * slATRMult));
        let tpPct = Math.max(0.003, Math.min(0.06, slPct * tpRatio));
        sigs.push({ bar: i, dir: 1, sl: slPct, tp: tpPct, ts: barTime, type: 'PB' });
        lastBar = i;
      }
    }

    // SHORT pullback: 1H downtrend, 5m price near EMA21 from below, RSI dropping
    if (htfTr === -1 && adxD.adx[i] > 20) {
      const dist21 = (c[i] - e21[i]) / e21[i];
      const isTrending = e21[i] < e50[i];
      const isPullback = dist21 > -0.003 && dist21 < 0.01;
      const rsiDip = r14[i] < 70 && r14[i] > 55;
      const rsiTurning = i > 0 && r14[i] < r14[i-1];
      const volNormal = vSma[i] > 0 ? v[i] / vSma[i] : 1;

      if (isTrending && isPullback && rsiDip && rsiTurning && volNormal > 0.8) {
        const atrPct = atr14[i] / c[i];
        let slPct = Math.max(0.002, Math.min(0.025, atrPct * slATRMult));
        let tpPct = Math.max(0.003, Math.min(0.06, slPct * tpRatio));
        sigs.push({ bar: i, dir: -1, sl: slPct, tp: tpPct, ts: barTime, type: 'PB' });
        lastBar = i;
      }
    }
  }
  return sigs;
}

// Strategy 3: Breakout (price breaks range with volume)
function genBreakout(d5, htf, slATRMult, tpRatio) {
  const { c, h, l, v, o, t, n } = d5;
  const hh20 = calcHH(h, 20), ll20 = calcLL(l, 20);
  const hh50 = calcHH(h, 50), ll50 = calcLL(l, 50);
  const atr14 = calcATR(h,l,c,14), vSma = calcSMA(v,20);
  const adxD = calcADX(h,l,c,14), mac = calcMACD(c);
  const sigs = [];
  let lastBar = -COOLDOWN - 1;

  for (let i = 55; i < n - TIMEOUT - ENTRY_DELAY; i++) {
    if (i - lastBar < COOLDOWN) continue;
    const barTime = t[i];
    const hi2 = htfLookup(htf, barTime);
    if (hi2 < 21) continue;
    const htfTr = htf.trends[hi2];
    const volR = vSma[i] > 0 ? v[i] / vSma[i] : 1;

    // LONG breakout: close above 20-bar high with volume, ADX rising, HTF not bearish
    if (htfTr !== -1 && c[i] > hh20[i-1] && volR > 1.8 && adxD.adx[i] > 22) {
      const macdOk = mac.hist[i] > 0 && mac.hist[i] > mac.hist[i-1];
      if (macdOk) {
        const atrPct = atr14[i] / c[i];
        let slPct = Math.max(0.003, Math.min(0.025, atrPct * slATRMult));
        // SL: halfway back into the range, or ATR-based
        const rangeSL = (c[i] - ll20[i]) / c[i] * 0.5;
        slPct = Math.max(slPct, Math.min(0.025, rangeSL));
        let tpPct = Math.max(0.004, Math.min(0.06, slPct * tpRatio));
        sigs.push({ bar: i, dir: 1, sl: slPct, tp: tpPct, ts: barTime, type: 'BO' });
        lastBar = i;
      }
    }

    // SHORT breakout: close below 20-bar low with volume
    if (htfTr !== 1 && c[i] < ll20[i-1] && volR > 1.8 && adxD.adx[i] > 22) {
      const macdOk = mac.hist[i] < 0 && mac.hist[i] < mac.hist[i-1];
      if (macdOk) {
        const atrPct = atr14[i] / c[i];
        let slPct = Math.max(0.003, Math.min(0.025, atrPct * slATRMult));
        const rangeSL = (hh20[i] - c[i]) / c[i] * 0.5;
        slPct = Math.max(slPct, Math.min(0.025, rangeSL));
        let tpPct = Math.max(0.004, Math.min(0.06, slPct * tpRatio));
        sigs.push({ bar: i, dir: -1, sl: slPct, tp: tpPct, ts: barTime, type: 'BO' });
        lastBar = i;
      }
    }
  }
  return sigs;
}

// ── ENGINE — with optional trailing stop ─────────────────────────────
function runEngine(signals, allParsed, prng, useTrailing) {
  let capital = INIT_CAP, peak = INIT_CAP, maxDD = 0;
  const trades = [];
  let pos = null;
  const sorted = signals.slice().sort((a, b) => a.ts - b.ts);

  function closePos(pd, j, type) {
    let exitP;
    if (type === 'SL') {
      exitP = pos.dir === 1 ? pos.slP * (1 - SLIP_SL) : pos.slP * (1 + SLIP_SL);
    } else if (type === 'TP') {
      exitP = pos.tpP;
    } else {
      exitP = pd.c[j]; // timeout
    }
    const gross = pos.dir === 1 ? (exitP - pos.ep) * pos.qty : (pos.ep - exitP) * pos.qty;
    const fee = POS_SIZE * FEE_ENTRY + POS_SIZE * (type === 'TP' ? FEE_TP : FEE_SL);
    const net = gross - fee;
    capital += net; peak = Math.max(peak, capital);
    const dd = peak > 0 ? (peak - capital) / peak : 0;
    if (dd > maxDD) maxDD = dd;
    trades.push({ dir: pos.dir, pnl: net, type, pair: pos.pair,
      bars: j - pos.eb, date: new Date(pd.t[j]).toISOString().slice(0,10) });
    pos = null;
  }

  function advancePos(maxTime) {
    if (!pos) return;
    const pd = allParsed[pos.pair];
    for (let j = pos.nc; j < pd.n && j <= pos.exp && pd.t[j] <= maxTime; j++) {
      // Trailing stop: after reaching 1x SL distance in profit, move SL to breakeven
      if (useTrailing) {
        const mfe = pos.dir === 1
          ? (pd.h[j] - pos.ep) / pos.ep
          : (pos.ep - pd.l[j]) / pos.ep;
        if (mfe >= pos.slDist && !pos.trailed) {
          // Move SL to breakeven + small buffer
          pos.slP = pos.dir === 1
            ? pos.ep * (1 + 0.0005)  // breakeven + 0.05%
            : pos.ep * (1 - 0.0005);
          pos.trailed = true;
        }
      }

      let hitSL, hitTP;
      if (pos.dir === 1) { hitSL = pd.l[j] <= pos.slP; hitTP = pd.h[j] >= pos.tpP; }
      else               { hitSL = pd.h[j] >= pos.slP; hitTP = pd.l[j] <= pos.tpP; }
      if (hitSL && hitTP) hitTP = false;

      if (hitSL) { closePos(pd, j, 'SL'); return; }
      if (hitTP) { closePos(pd, j, 'TP'); return; }
      pos.nc = j + 1;
    }
    if (pos && pos.nc > pos.exp) {
      const pd = allParsed[pos.pair];
      const eb = Math.min(pos.exp, pd.n - 1);
      closePos(pd, eb, 'TO');
    }
  }

  for (const sig of sorted) {
    if (capital <= 0) break;
    const d = allParsed[sig.pair];
    const entryBar = sig.bar + ENTRY_DELAY;
    if (entryBar >= d.n) continue;

    advancePos(d.t[entryBar]);
    if (pos) continue;
    if (prng() >= FILL_RATE) continue;
    if (capital < POS_SIZE / 5 * 0.5) continue;

    const ep = d.o[entryBar] * (sig.dir === 1 ? 1 + SLIP_ENTRY : 1 - SLIP_ENTRY);
    const qty = POS_SIZE / ep;
    const slP = sig.dir === 1 ? ep * (1 - sig.sl) : ep * (1 + sig.sl);
    const tpP = sig.dir === 1 ? ep * (1 + sig.tp) : ep * (1 - sig.tp);
    pos = { pair: sig.pair, dir: sig.dir, ep, slP, tpP, qty,
            eb: entryBar, exp: entryBar + TIMEOUT, nc: entryBar + 1,
            slDist: sig.sl, trailed: false };
  }

  // Close remaining
  if (pos) {
    const pd = allParsed[pos.pair];
    for (let j = pos.nc; j < pd.n && j <= pos.exp; j++) {
      if (useTrailing) {
        const mfe = pos.dir === 1 ? (pd.h[j] - pos.ep) / pos.ep : (pos.ep - pd.l[j]) / pos.ep;
        if (mfe >= pos.slDist && !pos.trailed) {
          pos.slP = pos.dir === 1 ? pos.ep * 1.0005 : pos.ep * 0.9995;
          pos.trailed = true;
        }
      }
      let hitSL, hitTP;
      if (pos.dir === 1) { hitSL = pd.l[j] <= pos.slP; hitTP = pd.h[j] >= pos.tpP; }
      else               { hitSL = pd.h[j] >= pos.slP; hitTP = pd.l[j] <= pos.tpP; }
      if (hitSL && hitTP) hitTP = false;
      if (hitSL || hitTP) { closePos(pd, j, hitSL ? 'SL' : 'TP'); break; }
    }
    if (pos) {
      const eb = Math.min(pos.exp, allParsed[pos.pair].n - 1);
      closePos(allParsed[pos.pair], eb, 'TO');
    }
  }
  return { trades, finalCap: capital, maxDD };
}

// ── RAW SIGNAL QUALITY DIAGNOSTIC ────────────────────────────────────
// Tests raw signal outcomes WITHOUT engine constraints (unlimited capital, 100% fill)
function rawDiagnostic(signals, allParsed) {
  let tp = 0, sl = 0, to = 0;
  for (const sig of signals) {
    const d = allParsed[sig.pair];
    const entryBar = sig.bar + ENTRY_DELAY;
    if (entryBar >= d.n) continue;
    const ep = d.o[entryBar];
    const slP = sig.dir === 1 ? ep * (1 - sig.sl) : ep * (1 + sig.sl);
    const tpP = sig.dir === 1 ? ep * (1 + sig.tp) : ep * (1 - sig.tp);
    let hit = 'TO';
    for (let j = entryBar + 1; j < d.n && j <= entryBar + TIMEOUT; j++) {
      let hitSL = sig.dir === 1 ? d.l[j] <= slP : d.h[j] >= slP;
      let hitTP = sig.dir === 1 ? d.h[j] >= tpP : d.l[j] <= tpP;
      if (hitSL && hitTP) hitTP = false;
      if (hitSL) { hit = 'SL'; break; }
      if (hitTP) { hit = 'TP'; break; }
    }
    if (hit === 'TP') tp++; else if (hit === 'SL') sl++; else to++;
  }
  const total = tp + sl + to;
  const wr = (tp + sl) > 0 ? tp / (tp + sl) * 100 : 0;
  return { tp, sl, to, total, wr };
}

// ── STATS ────────────────────────────────────────────────────────────
function stats(trades) {
  if (!trades.length) return { pf:0, wr:0, pnl:0, n:0, w:0, tp:0, sl:0, to:0, avgW:0, avgL:0, avgBars:0 };
  const w = trades.filter(t=>t.pnl>0), lo = trades.filter(t=>t.pnl<=0);
  const gw = w.reduce((s,t)=>s+t.pnl,0), gl = Math.abs(lo.reduce((s,t)=>s+t.pnl,0));
  return { pf: gl>0?gw/gl:gw>0?99:0, wr: w.length/trades.length*100, pnl: gw-gl,
    n: trades.length, w: w.length, tp: trades.filter(t=>t.type==='TP').length,
    sl: trades.filter(t=>t.type==='SL').length, to: trades.filter(t=>t.type==='TO').length,
    avgW: w.length?gw/w.length:0, avgL: lo.length?gl/lo.length:0,
    avgBars: trades.reduce((s,t)=>s+(t.bars||0),0)/trades.length };
}

// ── MAIN ─────────────────────────────────────────────────────────────
async function main() {
  const BAR = '═'.repeat(72);
  console.log(`\n${BAR}`);
  console.log('  APEX V2 — Structural Pattern Engine (Zero-Bias)');
  console.log(BAR);
  console.log(`  Fixes from V1: No confirmation bar | HTF scored not mandatory`);
  console.log(`  New: 3 strategy types | Trailing stop | Raw diagnostic`);
  console.log(`  Period: ${DAYS}d → ${new Date(END_TS).toISOString().slice(0,10)} | ${IS_DAYS}d IS + ${DAYS-IS_DAYS}d OOS`);
  console.log(`  Costs: Entry ${(FEE_ENTRY*100).toFixed(2)}% | TP ${(FEE_TP*100).toFixed(2)}% | SL ${(FEE_SL*100).toFixed(2)}% + ${(SLIP_SL*100).toFixed(2)}% slip`);
  console.log(BAR);

  // Download data
  console.log('\n  == DATA DOWNLOAD ==');
  const startTs = END_TS - DAYS * 86400000;
  const splitTs = startTs + IS_DAYS * 86400000;
  const allData = {};
  for (const pair of PAIRS) {
    process.stdout.write(`    ${pair}: `);
    const [kl5m, kl1h] = await Promise.all([
      getKlines(pair, '5m', startTs, END_TS),
      getKlines(pair, '1h', startTs, END_TS)
    ]);
    console.log(`5m=${kl5m.length} 1h=${kl1h.length}`);
    allData[pair] = { kl5m, kl1h };
  }

  function splitByTime(kl, st) {
    return { is: kl.filter(k => parseInt(k[0]) < st), oos: kl.filter(k => parseInt(k[0]) >= st) };
  }

  const generators = { confluence: genConfluence, pullback: genPullback, breakout: genBreakout };

  // ── RAW SIGNAL DIAGNOSTIC (IS) ──
  console.log('\n  == RAW SIGNAL DIAGNOSTIC (IS, no engine, no costs) ==');
  console.log('    Strategy   | Pair      | Signals | TP    | SL    | TO    | Raw WR%');
  console.log('    ' + '─'.repeat(68));

  for (const strat of GRID.strategy) {
    for (const pair of PAIRS) {
      const sp5 = splitByTime(allData[pair].kl5m, splitTs);
      const sp1 = splitByTime(allData[pair].kl1h, splitTs);
      const d5 = parse(sp5.is), htf = precomputeHTF(sp1.is);
      const sigs = generators[strat](d5, htf, 1.0, 2.0); // Default params
      for (const s of sigs) s.pair = pair;
      const raw = rawDiagnostic(sigs, { [pair]: d5 });
      if (raw.total >= 5)
        console.log(`    ${strat.padEnd(12)} | ${pair.padEnd(9)} | ${String(raw.total).padStart(7)} | ${String(raw.tp).padStart(5)} | ${String(raw.sl).padStart(5)} | ${String(raw.to).padStart(5)} | ${raw.wr.toFixed(1).padStart(6)}%`);
    }
  }

  // ── IN-SAMPLE GRID SEARCH ──
  console.log(`\n  == IN-SAMPLE GRID SEARCH (${IS_DAYS}d, all ${PAIRS.length} pairs) ==`);
  console.log('    Strat  | slATR | tpR  | Trail | Trades | WR%    | PF     | Net$      | MaxDD%');
  console.log('    ' + '─'.repeat(80));

  const isResults = [];
  let bestISPF = 0;

  for (const strat of GRID.strategy) {
    for (const slATRMult of GRID.slATRMult) {
      for (const tpRatio of GRID.tpRatio) {
        for (const trailing of GRID.trailing) {
          const allSigs = [];
          const isParsed = {};
          for (const pair of PAIRS) {
            const sp5 = splitByTime(allData[pair].kl5m, splitTs);
            const sp1 = splitByTime(allData[pair].kl1h, splitTs);
            const d5 = parse(sp5.is);
            const htf = precomputeHTF(sp1.is);
            isParsed[pair] = d5;
            const sigs = generators[strat](d5, htf, slATRMult, tpRatio);
            for (const s of sigs) s.pair = pair;
            allSigs.push(...sigs);
          }
          if (allSigs.length < 15) continue;
          const prng = createPRNG(PRNG_SEED);
          const res = runEngine(allSigs, isParsed, prng, trailing);
          const s = stats(res.trades);
          if (s.n < 15) continue;

          const entry = { strat, slATRMult, tpRatio, trailing, ...s, maxDD: res.maxDD };
          isResults.push(entry);
          const isBest = s.pf > bestISPF;
          if (isBest) bestISPF = s.pf;
          // Only print if PF > 0.7 (reduce noise)
          if (s.pf >= 0.7)
            console.log(`    ${strat.slice(0,6).padEnd(7)}| ${slATRMult.toFixed(1).padStart(5)} | ${tpRatio.toFixed(1).padStart(4)} | ${trailing?'  Y':'  N'} ${String('|').padStart(2)} ${String(s.n).padStart(6)} | ${s.wr.toFixed(1).padStart(5)}% | ${s.pf.toFixed(2).padStart(6)} | ${s.pnl.toFixed(2).padStart(9)} | ${(res.maxDD*100).toFixed(1).padStart(5)}%${isBest?' ◄':''}`);
        }
      }
    }
  }

  if (!isResults.length) { console.log('\n    No viable combos.'); return; }

  // Top 5 by PF
  const viable = isResults.filter(r => r.n >= 25).sort((a,b) => b.pf - a.pf);
  const top = viable.slice(0, 8);

  console.log('\n    TOP 8 IS:');
  console.log('    # | Strategy  | Params            | Trades | WR%    | PF     | Net$');
  console.log('    ' + '─'.repeat(72));
  for (let i = 0; i < top.length; i++) {
    const t = top[i];
    const p = `sl=${t.slATRMult} tp=${t.tpRatio} tr=${t.trailing?'Y':'N'}`;
    console.log(`    ${i+1} | ${t.strat.slice(0,9).padEnd(10)}| ${p.padEnd(17)} | ${String(t.n).padStart(6)} | ${t.wr.toFixed(1).padStart(5)}% | ${t.pf.toFixed(2).padStart(6)} | ${t.pnl.toFixed(2).padStart(9)}`);
  }

  // ── OOS VALIDATION ──
  console.log(`\n  == OUT-OF-SAMPLE VALIDATION (${DAYS-IS_DAYS}d) ==`);
  console.log('    # | Strategy  | Params            | OOS Tr | OOS WR | OOS PF | OOS Net   | IS→OOS');
  console.log('    ' + '─'.repeat(85));

  const oosResults = [];
  for (let i = 0; i < top.length; i++) {
    const t = top[i];
    const allSigs = [], oosParsed = {};
    for (const pair of PAIRS) {
      const sp5 = splitByTime(allData[pair].kl5m, splitTs);
      const sp1 = splitByTime(allData[pair].kl1h, splitTs);
      const d5 = parse(sp5.oos), htf = precomputeHTF(sp1.oos);
      oosParsed[pair] = d5;
      const sigs = generators[t.strat](d5, htf, t.slATRMult, t.tpRatio);
      for (const s of sigs) s.pair = pair;
      allSigs.push(...sigs);
    }
    const prng = createPRNG(PRNG_SEED + 1);
    const res = runEngine(allSigs, oosParsed, prng, t.trailing);
    const s = stats(res.trades);
    oosResults.push({ ...t, oos: s, oosDD: res.maxDD });
    const p = `sl=${t.slATRMult} tp=${t.tpRatio} tr=${t.trailing?'Y':'N'}`;
    console.log(`    ${i+1} | ${t.strat.slice(0,9).padEnd(10)}| ${p.padEnd(17)} | ${String(s.n).padStart(6)} | ${s.wr.toFixed(1).padStart(5)}% | ${s.pf.toFixed(2).padStart(6)} | ${s.pnl.toFixed(2).padStart(9)} | ${t.pf.toFixed(2)}→${s.pf.toFixed(2)}`);
  }

  // Best OOS
  const best = oosResults.filter(r => r.oos.n >= 8).sort((a,b) => (b.oos.pf||0) - (a.oos.pf||0))[0];
  if (!best) { console.log('\n    No sufficient OOS results.'); return; }

  // ── DETAILED BREAKDOWN ──
  const allSigs = [], oosParsed = {};
  for (const pair of PAIRS) {
    const sp5 = splitByTime(allData[pair].kl5m, splitTs);
    const sp1 = splitByTime(allData[pair].kl1h, splitTs);
    const d5 = parse(sp5.oos), htf = precomputeHTF(sp1.oos);
    oosParsed[pair] = d5;
    const sigs = generators[best.strat](d5, htf, best.slATRMult, best.tpRatio);
    for (const s of sigs) s.pair = pair;
    allSigs.push(...sigs);
  }
  const bestRun = runEngine(allSigs, oosParsed, createPRNG(PRNG_SEED+1), best.trailing);

  // Monthly
  const months = {};
  for (const t of bestRun.trades) { const mo = t.date?.slice(0,7)||'?'; if(!months[mo])months[mo]=[]; months[mo].push(t); }
  console.log(`\n  == BEST OOS: ${best.strat} sl=${best.slATRMult} tp=${best.tpRatio} trail=${best.trailing} ==`);
  console.log('\n    Monthly:');
  let profMo = 0;
  for (const mo of Object.keys(months).sort()) {
    const s = stats(months[mo]); if (s.pnl > 0) profMo++;
    console.log(`    ${mo}: ${s.n} trades | WR ${s.wr.toFixed(1)}% | PF ${s.pf.toFixed(2)} | $${s.pnl.toFixed(2)}`);
  }

  // Per pair
  const pairs = {};
  for (const t of bestRun.trades) { if(!pairs[t.pair])pairs[t.pair]=[]; pairs[t.pair].push(t); }
  console.log('\n    Per Pair:');
  let profPr = 0;
  for (const pair of Object.keys(pairs).sort()) {
    const s = stats(pairs[pair]); if (s.pnl > 0) profPr++;
    console.log(`    ${pair.padEnd(10)}: ${s.n} trades | WR ${s.wr.toFixed(1)}% | PF ${s.pf.toFixed(2)} | $${s.pnl.toFixed(2)}`);
  }

  // ── VERDICT ──
  const oosS = best.oos;
  const deg = best.pf > 0 ? ((oosS.pf - best.pf) / best.pf * 100) : -100;
  let level = 'BELOW MINIMUM';
  if (oosS.pf >= 1.0) level = 'BREAKEVEN';
  if (oosS.pf >= 1.3) level = 'MINIMUM';
  if (oosS.pf >= 1.6) level = 'TARGET';
  if (oosS.pf >= 2.0) level = 'EXCEPTIONAL';

  console.log(`\n${BAR}`);
  console.log('  FINAL VERDICT');
  console.log(BAR);
  console.log(`  Strategy:     ${best.strat} | sl=${best.slATRMult} tp=${best.tpRatio} trail=${best.trailing}`);
  console.log(`  OOS PF:       ${oosS.pf.toFixed(2)} | WR: ${oosS.wr.toFixed(1)}% | Net: $${oosS.pnl.toFixed(2)}`);
  console.log(`  OOS MaxDD:    ${(best.oosDD*100).toFixed(1)}% | Trades: ${oosS.n} (TP:${oosS.tp} SL:${oosS.sl} TO:${oosS.to})`);
  console.log(`  IS→OOS PF:    ${best.pf.toFixed(2)} → ${oosS.pf.toFixed(2)} (${deg>0?'+':''}${deg.toFixed(0)}%)`);
  console.log(`  Monthly:      ${profMo}/${Object.keys(months).length} profitable`);
  console.log(`  Pairs:        ${profPr}/${Object.keys(pairs).length} profitable`);
  console.log(`  Level:        [${level}]`);
  console.log(BAR);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
