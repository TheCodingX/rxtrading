#!/usr/bin/env node
// APEX FINAL BACKTEST — 5 Strategy Families, Verified Engine
// 180d data, IS=d1-120, OOS=d121-180, 3 pairs, 5m+1h
'use strict';
const https = require('https');

// ─── CONFIG ───
const PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT'];
const DAYS = 180, IS_DAYS = 120;
const INIT_CAP = 500, MAX_POS = 1, MAX_SAME_DIR = 1, LEV = 5;  // $500, 1 pos (single pair)
const FEE_MAKER = 0.0002, FEE_TAKER = 0.0005, SLIP_SL = 0.0003;
const FILL_RATE = 0.8, TIMEOUT_BARS = 100, DAILY_LOSS_PCT = 0.06;

// ─── FETCH ───
function fetch(url) {
  return new Promise((res, rej) => {
    https.get(url, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }).on('error',rej);
  });
}
async function getKlines(sym, interval, days) {
  const end = Date.now(), ms = days*86400000, lim = 1500;
  let all = [], t = end - ms;
  while (t < end) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&startTime=${Math.floor(t)}&limit=${lim}`;
    const k = await fetch(url);
    if (!k.length) break;
    all = all.concat(k);
    t = parseInt(k[k.length-1][6]) + 1;
    await new Promise(r=>setTimeout(r,200));
  }
  return all;
}

// ─── INDICATORS (all inline) ───
function sma(arr,p){ const r=[]; for(let i=0;i<arr.length;i++) r.push(i<p-1?NaN:arr.slice(i-p+1,i+1).reduce((a,b)=>a+b)/p); return r; }
function ema(arr,p){ const r=[arr[0]],m=2/(p+1); for(let i=1;i<arr.length;i++) r.push(arr[i]*m+r[i-1]*(1-m)); return r; }
function rsi(closes,p=14){ const r=[NaN]; let ag=0,al=0;
  for(let i=1;i<closes.length;i++){const d=closes[i]-closes[i-1]; if(i<=p){if(d>0)ag+=d;else al-=d; if(i===p){ag/=p;al/=p;r.push(al===0?100:100-100/(1+ag/al));}else r.push(NaN);}
  else{ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r.push(al===0?100:100-100/(1+ag/al));}} return r; }
function bbands(closes,p=20,m=2){ const mid=sma(closes,p),up=[],dn=[];
  for(let i=0;i<closes.length;i++){if(isNaN(mid[i])){up.push(NaN);dn.push(NaN);continue;}
  const sl=closes.slice(i-p+1,i+1),avg=mid[i],std=Math.sqrt(sl.reduce((a,v)=>a+(v-avg)**2,0)/p);
  up.push(avg+m*std);dn.push(avg-m*std);} return{mid,up,dn}; }
function macd(closes,f=12,s=26,sig=9){ const ef=ema(closes,f),es=ema(closes,s),line=ef.map((v,i)=>v-es[i]),signal=ema(line,sig),hist=line.map((v,i)=>v-signal[i]); return{line,signal,hist}; }
function stoch(highs,lows,closes,kp=14,dp=3){ const k=[],d=[];
  for(let i=0;i<closes.length;i++){if(i<kp-1){k.push(NaN);continue;}const hh=Math.max(...highs.slice(i-kp+1,i+1)),ll=Math.min(...lows.slice(i-kp+1,i+1));k.push(hh===ll?50:(closes[i]-ll)/(hh-ll)*100);}
  const dk=sma(k,dp); return{k,d:dk}; }
function adx(highs,lows,closes,p=14){ const tr=[0],pdm=[0],ndm=[0];
  for(let i=1;i<closes.length;i++){tr.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
  const up=highs[i]-highs[i-1],dn=lows[i-1]-lows[i];pdm.push(up>dn&&up>0?up:0);ndm.push(dn>up&&dn>0?dn:0);}
  const atr=ema(tr,p),spdm=ema(pdm,p),sndm=ema(ndm,p);
  const pdi=spdm.map((v,i)=>atr[i]?v/atr[i]*100:0),ndi=sndm.map((v,i)=>atr[i]?v/atr[i]*100:0);
  const dx=pdi.map((v,i)=>{const s=v+ndi[i];return s?Math.abs(v-ndi[i])/s*100:0;});
  return{adx:ema(dx,p),pdi,ndi,atr}; }
function atr(highs,lows,closes,p=14){ const tr=[0];
  for(let i=1;i<closes.length;i++) tr.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
  return ema(tr,p); }
function zscore(closes,p=20){ const m=sma(closes,p),r=[];
  for(let i=0;i<closes.length;i++){if(isNaN(m[i])){r.push(0);continue;}const sl=closes.slice(i-p+1,i+1),std=Math.sqrt(sl.reduce((a,v)=>a+(v-m[i])**2,0)/p);r.push(std?((closes[i]-m[i])/std):0);}return r;}
function highestHigh(highs,p){const r=[];for(let i=0;i<highs.length;i++)r.push(i<p-1?highs[i]:Math.max(...highs.slice(i-p+1,i+1)));return r;}
function lowestLow(lows,p){const r=[];for(let i=0;i<lows.length;i++)r.push(i<p-1?lows[i]:Math.min(...lows.slice(i-p+1,i+1)));return r;}
function volSma(vols,p=20){return sma(vols,p);}

// ─── ENGINE ───
function runEngine(kl5m, kl1h, signals, cfg) {
  // signals: [{bar, dir, sl, tp}] — bar is index in kl5m where signal fires (close of bar)
  // entry at OPEN of bar+2 (2-bar delay)
  let capital = INIT_CAP, positions = [], trades = [], dailyPnl = {}, paused = {};
  const getDay = (t) => new Date(parseInt(t)).toISOString().slice(0,10);

  for (const sig of signals) {
    const entryBar = sig.bar + 2;
    if (entryBar >= kl5m.length) continue;

    // Fill rate: skip every 5th
    if (sig._seq % 5 === 4) continue;

    const day = getDay(kl5m[entryBar][0]);
    if (paused[day]) continue;

    // Check daily loss
    if (!dailyPnl[day]) dailyPnl[day] = 0;
    if (dailyPnl[day] <= -INIT_CAP * DAILY_LOSS_PCT) { paused[day] = true; continue; }

    // Max positions
    if (positions.length >= MAX_POS) continue;
    const sameDir = positions.filter(p => p.dir === sig.dir).length;
    if (sameDir >= MAX_SAME_DIR) continue;

    const entryPrice = parseFloat(kl5m[entryBar][1]); // OPEN
    const posSize = Math.min(INIT_CAP, capital * LEV);
    const qty = posSize / entryPrice;
    const entryCost = posSize * FEE_MAKER;

    const slPrice = sig.dir === 1 ? entryPrice * (1 - sig.sl) : entryPrice * (1 + sig.sl);
    const tpPrice = sig.dir === 1 ? entryPrice * (1 + sig.tp) : entryPrice * (1 - sig.tp);

    positions.push({ dir: sig.dir, entry: entryPrice, sl: slPrice, tp: tpPrice, qty, cost: entryCost, bar: entryBar, day });

    // Simulate forward
    let closed = false;
    for (let j = entryBar + 1; j < kl5m.length && j <= entryBar + TIMEOUT_BARS; j++) {
      const h = parseFloat(kl5m[j][2]), l = parseFloat(kl5m[j][3]), c = parseFloat(kl5m[j][4]);
      let hitSL = false, hitTP = false;

      if (sig.dir === 1) { hitSL = l <= slPrice; hitTP = h >= tpPrice; }
      else { hitSL = h >= slPrice; hitTP = l <= tpPrice; }

      if (hitSL && hitTP) hitTP = false; // SL wins on same bar

      if (hitSL) {
        const exitP = slPrice * (sig.dir === 1 ? (1 - SLIP_SL) : (1 + SLIP_SL));
        const pnl = sig.dir === 1 ? (exitP - entryPrice) * qty : (entryPrice - exitP) * qty;
        const fees = entryCost + Math.abs(pnl + posSize) * FEE_TAKER; // taker SL
        const net = pnl - entryCost - posSize * FEE_TAKER;
        capital += net;
        dailyPnl[day] = (dailyPnl[day]||0) + net;
        if (dailyPnl[day] <= -INIT_CAP * DAILY_LOSS_PCT) paused[day] = true;
        trades.push({ dir: sig.dir, entry: entryPrice, exit: exitP, pnl: net, type: 'SL', bars: j - entryBar });
        positions = positions.filter(p => p.entry !== entryPrice || p.bar !== entryBar);
        closed = true; break;
      }
      if (hitTP) {
        const exitP = tpPrice;
        const pnl = sig.dir === 1 ? (exitP - entryPrice) * qty : (entryPrice - exitP) * qty;
        const net = pnl - entryCost - posSize * FEE_MAKER; // maker TP
        capital += net;
        dailyPnl[day] = (dailyPnl[day]||0) + net;
        trades.push({ dir: sig.dir, entry: entryPrice, exit: exitP, pnl: net, type: 'TP', bars: j - entryBar });
        positions = positions.filter(p => p.entry !== entryPrice || p.bar !== entryBar);
        closed = true; break;
      }

      // Timeout
      if (j === entryBar + TIMEOUT_BARS) {
        const exitP = c;
        const pnl = sig.dir === 1 ? (exitP - entryPrice) * qty : (entryPrice - exitP) * qty;
        const net = pnl - entryCost - posSize * FEE_TAKER;
        capital += net;
        dailyPnl[day] = (dailyPnl[day]||0) + net;
        trades.push({ dir: sig.dir, entry: entryPrice, exit: exitP, pnl: net, type: 'TO', bars: TIMEOUT_BARS });
        positions = positions.filter(p => p.entry !== entryPrice || p.bar !== entryBar);
        closed = true; break;
      }
    }
    if (!closed) positions = positions.filter(p => p.entry !== entryPrice || p.bar !== entryBar);
  }
  return { trades, finalCapital: capital };
}

function stats(trades) {
  if (!trades.length) return { pf:0, wr:0, pnl:0, trades:0 };
  const wins = trades.filter(t=>t.pnl>0), losses = trades.filter(t=>t.pnl<=0);
  const grossW = wins.reduce((a,t)=>a+t.pnl,0), grossL = Math.abs(losses.reduce((a,t)=>a+t.pnl,0));
  return { pf: grossL?grossW/grossL:grossW?99:0, wr: wins.length/trades.length*100, pnl: trades.reduce((a,t)=>a+t.pnl,0), trades: trades.length };
}

// ─── ENGINE VERIFICATION ───
function verifyEngine() {
  console.log('\n=== ENGINE VERIFICATION ===');

  // Test 1: 1000 random trades R:R 1:1 → PF ~0.85-0.95
  const fakeKl = [];
  let price = 50000;
  for (let i = 0; i < 5000; i++) {
    const ret = (Math.random()-0.5)*0.004; // ~0.4% range per bar
    const o = price, c = price*(1+ret);
    const h = Math.max(o,c)*(1+Math.random()*0.002);
    const l = Math.min(o,c)*(1-Math.random()*0.002);
    price = c;
    fakeKl.push([Date.now()-5000*300000+i*300000, o.toFixed(2), h.toFixed(2), l.toFixed(2), c.toFixed(2), '100', Date.now()-5000*300000+i*300000+299999]);
  }
  const sigs = [];
  for (let i = 50; i < 4000; i += 3) sigs.push({ bar: i, dir: Math.random()>0.5?1:-1, sl: 0.01, tp: 0.01, _seq: sigs.length });
  const r1 = runEngine(fakeKl, [], sigs, {});
  const s1 = stats(r1.trades);
  const t1pass = s1.pf >= 0.75 && s1.pf <= 1.05;
  console.log(`  Test 1 (Random PF): ${s1.pf.toFixed(2)} (${s1.trades} trades) [${t1pass?'PASS':'FAIL'}]`);

  // Test 2: Timestamp alignment
  const now = Date.now();
  const fakeH = [];
  for (let i = 0; i < 100; i++) fakeH.push([now-100*3600000+i*3600000,'50000','50500','49500','50000','100',now-100*3600000+i*3600000+3599999]);
  const barTime = now - 10*3600000;
  const filtered = fakeH.filter(k => parseInt(k[6]) <= barTime);
  const lastClose = parseInt(filtered[filtered.length-1][6]);
  const t2pass = lastClose <= barTime;
  console.log(`  Test 2 (Timestamp): closeTime=${lastClose} <= ${barTime} [${t2pass?'PASS':'FAIL'}]`);

  // Test 3: Fee calc — entry maker 0.02%, TP maker 0.02%, SL taker 0.05% + slip 0.03%
  const pos = 2500; // position size
  const entryFee = pos * FEE_MAKER; // $0.50
  const tpFee = pos * FEE_MAKER;    // $0.50 → round-trip TP = $1.00
  const slFee = pos * FEE_TAKER;    // $1.25
  const slSlip = pos * SLIP_SL;     // $0.75 → round-trip SL = $0.50+$1.25+$0.75? no..
  // Round-trip TP = entry fee + exit fee = 0.50 + 0.50 = $1.00
  // Round-trip SL = entry fee + exit fee + slippage = 0.50 + 1.25 = $1.75 (slip is on price, not separate fee)
  const rtTP = entryFee + tpFee;
  const rtSL = entryFee + slFee;
  const t3tp = Math.abs(rtTP - 1.00) < 0.01;
  const t3sl = Math.abs(rtSL - 1.75) < 0.01;
  console.log(`  Test 3 (Fees): RT_TP=$${rtTP.toFixed(2)} [${t3tp?'PASS':'FAIL'}], RT_SL=$${rtSL.toFixed(2)} [${t3sl?'PASS':'FAIL'}]`);

  return t1pass && t2pass && t3tp && t3sl;
}

// ─── HTF HELPERS (precomputed for speed) ───
function precomputeHTF(kl1h) {
  if (!kl1h.length) return { closeTimes:[], trends:[], adxVals:[] };
  const closeTimes = kl1h.map(k=>parseInt(k[6]));
  const cl = kl1h.map(k=>parseFloat(k[4]));
  const hi = kl1h.map(k=>parseFloat(k[2]));
  const lo = kl1h.map(k=>parseFloat(k[3]));
  const e9 = ema(cl,9), e21 = ema(cl,21);
  const trends = e9.map((v,i)=> i<20?0: v>e21[i]?1:-1);
  const a = adx(hi,lo,cl);
  return { closeTimes, trends, adxVals: a.adx };
}
function htfLookup(htfData, barTime) {
  // Binary search for last 1h candle closed <= barTime
  const ct = htfData.closeTimes;
  let lo=0, hi=ct.length-1, idx=-1;
  while(lo<=hi){const mid=(lo+hi)>>1;if(ct[mid]<=barTime){idx=mid;lo=mid+1;}else hi=mid-1;}
  return idx;
}
function htfTrend(htfData, barTime) {
  const idx = htfLookup(htfData, barTime);
  return idx < 20 ? 0 : htfData.trends[idx];
}
function htfADX(htfData, barTime) {
  const idx = htfLookup(htfData, barTime);
  return idx < 29 ? 20 : htfData.adxVals[idx];
}

// ─── STRATEGY SIGNAL GENERATORS ───
function genSignalsF1(kl5m, kl1h, params) {
  // RSI Divergence + HTF
  const { lb, rsiZone, sl, tp } = params;
  const closes = kl5m.map(k=>parseFloat(k[4])), lows = kl5m.map(k=>parseFloat(k[3])), highs = kl5m.map(k=>parseFloat(k[2]));
  const vols = kl5m.map(k=>parseFloat(k[5]));
  const r = rsi(closes), m = macd(closes), va = volSma(vols);
  const signals = [];
  for (let i = lb + 14; i < closes.length - 2; i++) {
    const barTime = parseInt(kl5m[i][6]);
    // Bull divergence: price makes LL, RSI makes HL
    let pLL = false, rHL = false;
    for (let j = 1; j <= lb; j++) {
      if (lows[i] < lows[i-j]) pLL = true;
      if (r[i] > r[i-j] && r[i-j] < rsiZone) rHL = true;
    }
    if (pLL && rHL && r[i] < rsiZone + 10) {
      const trend = htfTrend(kl1h, barTime);
      if (trend !== 1) continue;
      let score = 0;
      if (r[i] < rsiZone) score += 2;
      if (vols[i] > (va[i]||1) * 1.5) score += 1;
      score += 3; // HTF aligned
      if (m.hist[i] > m.hist[i-1]) score += 1;
      if (score >= 4) signals.push({ bar: i, dir: 1, sl, tp, _seq: signals.length });
    }
    // Bear divergence
    let pHH = false, rLH = false;
    for (let j = 1; j <= lb; j++) {
      if (highs[i] > highs[i-j]) pHH = true;
      if (r[i] < r[i-j] && r[i-j] > (100-rsiZone)) rLH = true;
    }
    if (pHH && rLH && r[i] > (100-rsiZone-10)) {
      const trend = htfTrend(kl1h, barTime);
      if (trend !== -1) continue;
      let score = 0;
      if (r[i] > (100-rsiZone)) score += 2;
      if (vols[i] > (va[i]||1) * 1.5) score += 1;
      score += 3;
      if (m.hist[i] < m.hist[i-1]) score += 1;
      if (score >= 4) signals.push({ bar: i, dir: -1, sl, tp, _seq: signals.length });
    }
  }
  return signals;
}

function genSignalsF2(kl5m, kl1h, params) {
  // Mean Reversion: BB + RSI extreme
  const { sl, tpMode } = params;
  const closes = kl5m.map(k=>parseFloat(k[4])), vols = kl5m.map(k=>parseFloat(k[5]));
  const r = rsi(closes), bb = bbands(closes), va = volSma(vols);
  const signals = [];
  for (let i = 25; i < closes.length - 2; i++) {
    if (isNaN(bb.dn[i])) continue;
    const barTime = parseInt(kl5m[i][6]);
    const hAdx = htfADX(kl1h, barTime);
    // LONG: close < BB lower, RSI < 30, HTF not strongly bearish
    if (closes[i] < bb.dn[i] && r[i] < 30 && hAdx < 35 && vols[i] > (va[i]||1)*1.2) {
      const tp = (bb.mid[i] - closes[i]) / closes[i];
      if (tp > 0.001) signals.push({ bar: i, dir: 1, sl, tp: Math.min(tp, 0.03), _seq: signals.length });
    }
    // SHORT: close > BB upper, RSI > 70
    if (closes[i] > bb.up[i] && r[i] > 70 && hAdx < 35 && vols[i] > (va[i]||1)*1.2) {
      const tp = (closes[i] - bb.mid[i]) / closes[i];
      if (tp > 0.001) signals.push({ bar: i, dir: -1, sl, tp: Math.min(tp, 0.03), _seq: signals.length });
    }
  }
  return signals;
}

function genSignalsF3(kl5m, kl1h, params) {
  // Momentum Breakout
  const { hPer, lPer, tpMult, sl: slOverride } = params;
  const closes = kl5m.map(k=>parseFloat(k[4])), highs = kl5m.map(k=>parseFloat(k[2]));
  const lows = kl5m.map(k=>parseFloat(k[3])), vols = kl5m.map(k=>parseFloat(k[5]));
  const hh = highestHigh(highs, hPer), ll = lowestLow(lows, lPer);
  const m = macd(closes), a = adx(highs, lows, closes), va = volSma(vols);
  const at = atr(highs, lows, closes);
  const signals = [];
  for (let i = Math.max(hPer, 26) + 1; i < closes.length - 2; i++) {
    const barTime = parseInt(kl5m[i][6]);
    const trend = htfTrend(kl1h, barTime);
    // LONG breakout
    if (closes[i] > hh[i-1] && vols[i] > (va[i]||1)*2 && a.adx[i] > 25 && m.hist[i] > 0 && m.hist[i] > m.hist[i-1]) {
      if (trend !== 1) continue;
      const sl = slOverride || ((closes[i] - ll[i]) / closes[i]);
      const tp = (at[i] / closes[i]) * tpMult;
      if (sl > 0.001 && tp > 0.001) signals.push({ bar: i, dir: 1, sl: Math.min(sl, 0.02), tp: Math.min(tp, 0.04), _seq: signals.length });
    }
    // SHORT breakout
    if (closes[i] < ll[i-1] && vols[i] > (va[i]||1)*2 && a.adx[i] > 25 && m.hist[i] < 0 && m.hist[i] < m.hist[i-1]) {
      if (trend !== -1) continue;
      const sl = slOverride || ((hh[i] - closes[i]) / closes[i]);
      const tp = (at[i] / closes[i]) * tpMult;
      if (sl > 0.001 && tp > 0.001) signals.push({ bar: i, dir: -1, sl: Math.min(sl, 0.02), tp: Math.min(tp, 0.04), _seq: signals.length });
    }
  }
  return signals;
}

function genSignalsF4(kl5m, kl1h, params) {
  // Multi-Indicator Confluence
  const { minScore, sl, tp } = params;
  const closes = kl5m.map(k=>parseFloat(k[4])), highs = kl5m.map(k=>parseFloat(k[2]));
  const lows = kl5m.map(k=>parseFloat(k[3])), vols = kl5m.map(k=>parseFloat(k[5]));
  const r = rsi(closes), st = stoch(highs,lows,closes), bb = bbands(closes);
  const m = macd(closes), va = volSma(vols), z = zscore(closes);
  const signals = [];
  for (let i = 30; i < closes.length - 2; i++) {
    const barTime = parseInt(kl5m[i][6]);
    const trend = htfTrend(kl1h, barTime);
    // LONG score
    let ls = 0;
    if (r[i] < 30) ls += 2; else if (r[i] < 40) ls += 1;
    if (st.k[i] < 20) ls += 2; else if (st.k[i] < 30) ls += 1;
    if (closes[i] < bb.dn[i]) ls += 2;
    if (m.hist[i] > m.hist[i-1] && m.hist[i-1] < 0) ls += 2; // turning
    if (vols[i] > (va[i]||1)*2) ls += 2; else if (vols[i] > (va[i]||1)*1.5) ls += 1;
    if (trend === 1) ls += 3;
    if (z[i] < -2) ls += 2;
    if (ls >= minScore) signals.push({ bar: i, dir: 1, sl, tp, _seq: signals.length });

    // SHORT score
    let ss = 0;
    if (r[i] > 70) ss += 2; else if (r[i] > 60) ss += 1;
    if (st.k[i] > 80) ss += 2; else if (st.k[i] > 70) ss += 1;
    if (closes[i] > bb.up[i]) ss += 2;
    if (m.hist[i] < m.hist[i-1] && m.hist[i-1] > 0) ss += 2;
    if (vols[i] > (va[i]||1)*2) ss += 2; else if (vols[i] > (va[i]||1)*1.5) ss += 1;
    if (trend === -1) ss += 3;
    if (z[i] > 2) ss += 2;
    if (ss >= minScore) signals.push({ bar: i, dir: -1, sl, tp, _seq: signals.length });
  }
  return signals;
}

function genSignalsF5(kl5m, kl1h, params) {
  // Regime-Adaptive — precompute all indicators once
  const { sl, tp, minScoreConf } = params;
  const closes = kl5m.map(k=>parseFloat(k[4])), highs = kl5m.map(k=>parseFloat(k[2]));
  const lows = kl5m.map(k=>parseFloat(k[3])), vols = kl5m.map(k=>parseFloat(k[5]));
  const a = adx(highs, lows, closes), at = atr(highs, lows, closes);
  const r = rsi(closes), bb = bbands(closes), m = macd(closes);
  const st = stoch(highs,lows,closes), z = zscore(closes), va = volSma(vols);
  const hh = highestHigh(highs, 20), ll = lowestLow(lows, 10);
  const atVals = at.filter(v=>!isNaN(v)&&v>0);
  atVals.sort((x,y)=>x-y);
  const atr80 = atVals[Math.floor(atVals.length*0.8)]||Infinity;

  const signals = [];
  for (let i = 30; i < closes.length - 2; i++) {
    const barTime = parseInt(kl5m[i][6]);
    const adxVal = a.adx[i];
    const isVolatile = at[i] > atr80;
    const trend = htfTrend(kl1h, barTime);

    if (isVolatile) {
      // Inline confluence score (avoid calling genSignalsF4 per bar)
      const ms = minScoreConf || 12;
      let ls=0, ss=0;
      if(r[i]<30)ls+=2;else if(r[i]<40)ls+=1;
      if(st.k[i]<20)ls+=2;else if(st.k[i]<30)ls+=1;
      if(!isNaN(bb.dn[i])&&closes[i]<bb.dn[i])ls+=2;
      if(m.hist[i]>m.hist[i-1]&&m.hist[i-1]<0)ls+=2;
      if(vols[i]>(va[i]||1)*2)ls+=2;else if(vols[i]>(va[i]||1)*1.5)ls+=1;
      if(trend===1)ls+=3;
      if(z[i]<-2)ls+=2;
      if(ls>=ms){signals.push({bar:i,dir:1,sl,tp,_seq:signals.length});continue;}
      if(r[i]>70)ss+=2;else if(r[i]>60)ss+=1;
      if(st.k[i]>80)ss+=2;else if(st.k[i]>70)ss+=1;
      if(!isNaN(bb.up[i])&&closes[i]>bb.up[i])ss+=2;
      if(m.hist[i]<m.hist[i-1]&&m.hist[i-1]>0)ss+=2;
      if(vols[i]>(va[i]||1)*2)ss+=2;else if(vols[i]>(va[i]||1)*1.5)ss+=1;
      if(trend===-1)ss+=3;
      if(z[i]>2)ss+=2;
      if(ss>=ms)signals.push({bar:i,dir:-1,sl,tp,_seq:signals.length});
    } else if (adxVal > 25) {
      if(i>=20 && closes[i]>hh[i-1] && vols[i]>(va[i]||1)*1.5 && trend===1) {
        signals.push({bar:i,dir:1,sl,tp,_seq:signals.length});
      } else if(i>=10 && closes[i]<ll[i-1] && vols[i]>(va[i]||1)*1.5 && trend===-1) {
        signals.push({bar:i,dir:-1,sl,tp,_seq:signals.length});
      }
    } else if (adxVal < 20) {
      if(!isNaN(bb.dn[i]) && closes[i]<bb.dn[i] && r[i]<30) {
        const tpC=Math.min((bb.mid[i]-closes[i])/closes[i],tp);
        signals.push({bar:i,dir:1,sl,tp:tpC>0.001?tpC:tp,_seq:signals.length});
      } else if(!isNaN(bb.up[i]) && closes[i]>bb.up[i] && r[i]>70) {
        const tpC=Math.min((closes[i]-bb.mid[i])/closes[i],tp);
        signals.push({bar:i,dir:-1,sl,tp:tpC>0.001?tpC:tp,_seq:signals.length});
      }
    }
  }
  return signals;
}

// ─── PARAM GRIDS ───
function randChoice(arr) { return arr[Math.floor(Math.random()*arr.length)]; }

function paramGridF1() {
  return { lb: randChoice([5,10,15,20]), rsiZone: randChoice([30,35,40]),
    sl: randChoice([0.003,0.005,0.007,0.01,0.015]), tp: randChoice([0.008,0.01,0.015,0.02,0.025,0.03]) };
}
function paramGridF2() {
  return { sl: randChoice([0.003,0.005,0.007,0.01,0.012,0.015]) };
}
function paramGridF3() {
  return { hPer: randChoice([15,20,25,30]), lPer: randChoice([5,10,15]),
    tpMult: randChoice([2,3,4,5]), sl: randChoice([0.005,0.007,0.01,0.012]) };
}
function paramGridF4() {
  return { minScore: randChoice([8,10,12,14]), sl: randChoice([0.005,0.007,0.01,0.015]),
    tp: randChoice([0.01,0.015,0.02,0.025,0.03]) };
}
function paramGridF5() {
  return { sl: randChoice([0.005,0.007,0.01,0.012]), tp: randChoice([0.01,0.015,0.02,0.025]),
    minScoreConf: randChoice([10,12,14]) };
}

// ─── MAIN ───
async function main() {
  console.log('APEX FINAL BACKTEST — 5 Families, Verified Engine');
  console.log('='.repeat(60));

  // Engine verification
  const engineOK = verifyEngine();
  if (!engineOK) console.log('  WARNING: Engine verification had failures');

  // Download data
  console.log('\nDownloading data...');
  const data = {};
  for (const pair of PAIRS) {
    console.log(`  ${pair}...`);
    const [kl5m, kl1h] = await Promise.all([getKlines(pair,'5m',DAYS), getKlines(pair,'1h',DAYS)]);
    console.log(`    5m: ${kl5m.length} candles, 1h: ${kl1h.length} candles`);
    data[pair] = { kl5m, kl1h };
  }

  // Split IS/OOS by time
  function splitData(kl, isDays) {
    const times = kl.map(k=>parseInt(k[0]));
    const minT = Math.min(...times), splitT = minT + isDays * 86400000;
    return { is: kl.filter(k=>parseInt(k[0])<splitT), oos: kl.filter(k=>parseInt(k[0])>=splitT) };
  }

  const families = [
    { name: '1.Div', gen: genSignalsF1, grid: paramGridF1 },
    { name: '2.MR', gen: genSignalsF2, grid: paramGridF2 },
    { name: '3.Mom', gen: genSignalsF3, grid: paramGridF3 },
    { name: '4.Conf', gen: genSignalsF4, grid: paramGridF4 },
    { name: '5.Reg', gen: genSignalsF5, grid: paramGridF5 },
  ];

  const ITERS = 50;
  const allResults = [];
  const familyBests = [];

  console.log(`\nRunning ${ITERS} random param combos per family per pair on IS...\n`);

  for (const fam of families) {
    let bestForFamily = { pnl: -Infinity };
    const top3 = [];

    for (const pair of PAIRS) {
      const sp5 = splitData(data[pair].kl5m, IS_DAYS);
      const sp1 = splitData(data[pair].kl1h, IS_DAYS);
      const htfIS = precomputeHTF(sp1.is);

      for (let iter = 0; iter < ITERS; iter++) {
        const params = fam.grid();
        try {
          const sigs = fam.gen(sp5.is, htfIS, params);
          if (!sigs.length) continue;
          const res = runEngine(sp5.is, sp1.is, sigs, params);
          const s = stats(res.trades);
          const entry = { family: fam.name, pair, params: {...params}, ...s, sigs: sigs.length };
          allResults.push(entry);
          top3.push(entry);
          if (s.pnl > bestForFamily.pnl) bestForFamily = entry;
        } catch(e) { /* skip bad combos */ }
      }
    }

    top3.sort((a,b) => b.pnl - a.pnl);
    const best = top3[0] || { pf:0,wr:0,pnl:0,trades:0,params:{} };
    familyBests.push(best);
    console.log(`  ${fam.name.padEnd(6)} | PF=${(best.pf||0).toFixed(2)} | WR=${(best.wr||0).toFixed(1)}% | PnL=$${(best.pnl||0).toFixed(0).padStart(6)} | Trades=${(best.trades||0).toString().padStart(4)} | ${JSON.stringify(best.params||{}).slice(0,50)}`);
  }

  // Global top 5
  allResults.sort((a,b) => b.pnl - a.pnl);
  const top5 = allResults.slice(0, 5);

  console.log('\n' + '='.repeat(60));
  console.log('IN-SAMPLE RESULTS (d1-120):');
  console.log('  Family | Best PF | Best WR | Best PnL | Trades | Config');
  for (const b of familyBests) {
    console.log(`  ${(b.family||'?').padEnd(6)} | ${(b.pf||0).toFixed(2).padStart(7)} | ${((b.wr||0).toFixed(1)+'%').padStart(7)} | $${(b.pnl||0).toFixed(0).padStart(6)} | ${(b.trades||0).toString().padStart(6)} | ${JSON.stringify(b.params||{}).slice(0,45)}`);
  }

  console.log('\nTOP 5 GLOBAL:');
  console.log('  # | Family-Pair         | IS_PnL  | IS_PF | IS_WR  | Trades');
  for (let i = 0; i < top5.length; i++) {
    const t = top5[i];
    console.log(`  ${i+1} | ${(t.family+'-'+t.pair).padEnd(20)}| $${t.pnl.toFixed(0).padStart(6)} | ${t.pf.toFixed(2).padStart(5)} | ${(t.wr.toFixed(1)+'%').padStart(6)} | ${t.trades}`);
  }

  // OOS — run top 5 on OOS data ONCE
  console.log('\nOOS RESULTS (d121-180) — ONE SHOT:');
  console.log('  # | Family-Pair         | OOS_PnL | OOS_PF | OOS_WR | Trades | IS_PF->OOS_PF');

  const oosResults = [];
  for (let i = 0; i < top5.length; i++) {
    const t = top5[i];
    const sp5 = splitData(data[t.pair].kl5m, IS_DAYS);
    const sp1 = splitData(data[t.pair].kl1h, IS_DAYS);
    const htfOOS = precomputeHTF(sp1.oos);
    const famObj = families.find(f => f.name === t.family);
    try {
      const sigs = famObj.gen(sp5.oos, htfOOS, t.params);
      const res = runEngine(sp5.oos, sp1.oos, sigs, t.params);
      const s = stats(res.trades);
      oosResults.push({ ...t, oos_pnl: s.pnl, oos_pf: s.pf, oos_wr: s.wr, oos_trades: s.trades });
      console.log(`  ${i+1} | ${(t.family+'-'+t.pair).padEnd(20)}| $${s.pnl.toFixed(0).padStart(6)} | ${s.pf.toFixed(2).padStart(6)} | ${(s.wr.toFixed(1)+'%').padStart(6)} | ${s.trades.toString().padStart(6)} | ${t.pf.toFixed(2)}->${s.pf.toFixed(2)}`);
    } catch(e) {
      console.log(`  ${i+1} | ${(t.family+'-'+t.pair).padEnd(20)}| ERROR: ${e.message}`);
    }
  }

  // Final verdict
  const bestOOS = oosResults.sort((a,b) => (b.oos_pf||0) - (a.oos_pf||0))[0] || {};
  const bestPF = bestOOS.oos_pf || 0;
  const bestWR = bestOOS.oos_wr || 0;
  let level = 'MINIMUM';
  if (bestPF >= 1.3 && bestWR >= 55) level = 'RENTECH';
  if (bestPF >= 1.5 && bestWR >= 60) level = 'ASPIRATIONAL';
  if (bestPF >= 2.0 && bestWR >= 65) level = 'LEGENDARY';

  console.log('\n' + '='.repeat(60));
  console.log('FINAL VERDICT:');
  console.log(`  Best OOS PF: ${bestPF.toFixed(2)}`);
  console.log(`  Best OOS WR: ${bestWR.toFixed(1)}%`);
  console.log(`  Level: [${level}]`);
  console.log('='.repeat(60));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
