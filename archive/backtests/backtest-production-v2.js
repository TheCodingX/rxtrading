#!/usr/bin/env node
'use strict';
// APEX Production Backtest V2 — 6-Month Schedule Analysis
// ETHUSDT, 4 trading schedules, full monthly/weekly breakdown
const https = require('https');

// ─── CONFIG ───
const DAYS = 180, INIT_CAP = 500, LEV = 5, MAX_POS = 1;
const FEE_MAKER = 0.0002, FEE_TAKER = 0.0005, SLIP_SL = 0.0003;
const DAILY_LOSS_PCT = 0.06, TIMEOUT_BARS = 100;
const SL_PCT = 0.007, TP_PCT = 0.03;
const DIV_LB = 15, RSI_ZONE = 40, MIN_SCORE = 6, MIN_INDS = 4;

// ─── SCHEDULES (UTC hours) ───
const SCHEDULES = {
  '24/7':  null,
  'A(00-10)': h => h >= 0 && h < 10,
  'B(08-18)': h => h >= 8 && h < 18,
  'C(00-08+12-14)': h => (h >= 0 && h < 8) || (h >= 12 && h < 14),
};

// ─── FETCH ───
function fetchJSON(url) {
  return new Promise((res, rej) => {
    https.get(url, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{res(JSON.parse(d))}catch(e){rej(e)} }); }).on('error',rej);
  });
}
async function getKlines(sym, interval, days) {
  const end = Date.now(), ms = days*86400000;
  let all = [], t = end - ms;
  while (t < end) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&startTime=${Math.floor(t)}&limit=1000`;
    const k = await fetchJSON(url);
    if (!k.length) break;
    all = all.concat(k);
    t = parseInt(k[k.length-1][6]) + 1;
    await new Promise(r=>setTimeout(r,250));
  }
  return all;
}

// ─── INDICATORS ───
function sma(a,p){const r=[];for(let i=0;i<a.length;i++)r.push(i<p-1?NaN:a.slice(i-p+1,i+1).reduce((s,v)=>s+v)/p);return r;}
function ema(a,p){if(!a.length)return[];const r=[a[0]],m=2/(p+1);for(let i=1;i<a.length;i++)r.push(a[i]*m+r[i-1]*(1-m));return r;}
function rsi(c,p=14){const r=[NaN];let ag=0,al=0;for(let i=1;i<c.length;i++){const d=c[i]-c[i-1];if(i<=p){if(d>0)ag+=d;else al-=d;if(i===p){ag/=p;al/=p;r.push(al===0?100:100-100/(1+ag/al));}else r.push(NaN);}else{ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r.push(al===0?100:100-100/(1+ag/al));}}return r;}
function bbands(c,p=10,m=2){const mid=sma(c,p),up=[],dn=[];for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up.push(NaN);dn.push(NaN);continue;}const sl=c.slice(i-p+1,i+1),std=Math.sqrt(sl.reduce((a,v)=>a+(v-mid[i])**2,0)/p);up.push(mid[i]+m*std);dn.push(mid[i]-m*std);}return{mid,up,dn};}
function macd(c,f=12,s=26,sig=9){const ef=ema(c,f),es=ema(c,s),line=ef.map((v,i)=>v-es[i]),signal=ema(line,sig),hist=line.map((v,i)=>v-signal[i]);return{line,signal,hist};}
function stochK(h,l,c,p=7){const r=[];for(let i=0;i<c.length;i++){if(i<p-1){r.push(NaN);continue;}const hh=Math.max(...h.slice(i-p+1,i+1)),ll=Math.min(...l.slice(i-p+1,i+1));r.push(hh===ll?50:(c[i]-ll)/(hh-ll)*100);}return r;}
function mfi(h,l,c,v,p=7){const tp=c.map((x,i)=>(h[i]+l[i]+x)/3),mf=tp.map((x,i)=>x*v[i]);const r=[];for(let i=0;i<c.length;i++){if(i<p){r.push(NaN);continue;}let pos=0,neg=0;for(let j=i-p+1;j<=i;j++){if(j>0&&tp[j]>tp[j-1])pos+=mf[j];else neg+=mf[j];}r.push(neg===0?100:100-100/(1+pos/neg));}return r;}
function psar(h,l,af0=0.02,afMax=0.2){const r=[];let bull=true,ep=l[0],sar=h[0],af=af0;r.push(sar);for(let i=1;i<h.length;i++){let nSar=sar+af*(ep-sar);if(bull){nSar=Math.min(nSar,l[i-1],i>1?l[i-2]:l[i-1]);if(l[i]<nSar){bull=false;nSar=ep;ep=l[i];af=af0;}else{if(h[i]>ep){ep=h[i];af=Math.min(af+af0,afMax);}}}else{nSar=Math.max(nSar,h[i-1],i>1?h[i-2]:h[i-1]);if(h[i]>nSar){bull=true;nSar=ep;ep=h[i];af=af0;}else{if(l[i]<ep){ep=l[i];af=Math.min(af+af0,afMax);}}}sar=nSar;r.push(sar);}return r;}
function keltner(c,h,l,p=10,m=1.5){const mid=ema(c,p),tr=h.map((x,i)=>i===0?x-l[i]:Math.max(x-l[i],Math.abs(x-c[i-1]),Math.abs(l[i]-c[i-1])));const atr=ema(tr,p);return{mid,up:mid.map((v,i)=>v+m*atr[i]),dn:mid.map((v,i)=>v-m*atr[i])};}
function vwap(c,v){let cumPV=0,cumV=0;return c.map((x,i)=>{cumPV+=x*v[i];cumV+=v[i];return cumV?cumPV/cumV:x;});}

// ─── HTF (1H) — EMA9/21 + MACD + RSI gate ───
function precomputeHTF(kl1h) {
  const ct = kl1h.map(k=>parseInt(k[6]));
  const cl = kl1h.map(k=>parseFloat(k[4]));
  const e9 = ema(cl,9), e21 = ema(cl,21);
  const m = macd(cl);
  const r = rsi(cl,14);
  const trends = cl.map((_,i) => {
    if (i < 25) return 0;
    let s = 0;
    if (e9[i] > e21[i]) s++; else s--;
    if (m.hist[i] > 0) s++; else s--;
    if (r[i] > 50) s++; else s--;
    return s >= 2 ? 1 : s <= -2 ? -1 : 0;
  });
  return { ct, trends };
}
function htfTrend(htf, barTime) {
  const ct = htf.ct;
  let lo=0, hi=ct.length-1, idx=-1;
  while(lo<=hi){const mid=(lo+hi)>>1;if(ct[mid]<=barTime){idx=mid;lo=mid+1;}else hi=mid-1;}
  return idx < 25 ? 0 : htf.trends[idx];
}

// ─── 10-INDICATOR SCORING ───
function precomputeScoring(closes, highs, lows, vols) {
  return {
    r7: rsi(closes, 7), sk7: stochK(highs, lows, closes, 7),
    bb10: bbands(closes, 10, 2), m: macd(closes),
    e5: ema(closes, 5), e13: ema(closes, 13),
    vw: vwap(closes, vols), volSma20: sma(vols, 20),
    kc: keltner(closes, highs, lows, 10, 1.5),
    ps: psar(highs, lows), mf7: mfi(highs, lows, closes, vols, 7),
  };
}

function scoreBar(ind, closes, vols, i, dir) {
  let score = 0, inds = 0;
  const { r7, sk7, bb10, m, e5, e13, vw, volSma20, kc, ps, mf7 } = ind;
  const chk = (cond, valid) => { if (valid) { inds++; if (cond) score++; } };
  if (dir === 1) {
    chk(r7[i] < 35, !isNaN(r7[i])); chk(sk7[i] < 25, !isNaN(sk7[i]));
    chk(closes[i] < bb10.dn[i], !isNaN(bb10.dn[i]));
    chk(i > 0 && m.hist[i] > m.hist[i-1], true);
    chk(e5[i] > e13[i], true); chk(closes[i] < vw[i], true);
    chk(vols[i] > (volSma20[i]||0) * 1.5, !isNaN(volSma20[i]));
    chk(closes[i] < kc.dn[i], true); chk(closes[i] > ps[i], true);
    chk(mf7[i] < 30, !isNaN(mf7[i]));
  } else {
    chk(r7[i] > 65, !isNaN(r7[i])); chk(sk7[i] > 75, !isNaN(sk7[i]));
    chk(closes[i] > bb10.up[i], !isNaN(bb10.up[i]));
    chk(i > 0 && m.hist[i] < m.hist[i-1], true);
    chk(e5[i] < e13[i], true); chk(closes[i] > vw[i], true);
    chk(vols[i] > (volSma20[i]||0) * 1.5, !isNaN(volSma20[i]));
    chk(closes[i] > kc.up[i], true); chk(closes[i] < ps[i], true);
    chk(mf7[i] > 70, !isNaN(mf7[i]));
  }
  return { score, inds };
}

// ─── SIGNAL GENERATION ───
function generateSignals(kl5m, htf, scheduleFn) {
  const closes = kl5m.map(k=>parseFloat(k[4]));
  const highs = kl5m.map(k=>parseFloat(k[2]));
  const lows = kl5m.map(k=>parseFloat(k[3]));
  const vols = kl5m.map(k=>parseFloat(k[5]));
  const r14 = rsi(closes, 14);
  const ind = precomputeScoring(closes, highs, lows, vols);
  const signals = [];

  for (let i = DIV_LB + 14; i < closes.length - 2; i++) {
    const barTime = parseInt(kl5m[i][6]);
    if (scheduleFn) { const h = new Date(barTime).getUTCHours(); if (!scheduleFn(h)) continue; }

    // Bull divergence: price LL, RSI HL
    let pLL = false, rHL = false;
    for (let j = 1; j <= DIV_LB; j++) {
      if (lows[i] < lows[i-j]) pLL = true;
      if (r14[i] > r14[i-j] && r14[i-j] < RSI_ZONE) rHL = true;
    }
    if (pLL && rHL && r14[i] < RSI_ZONE + 10) {
      if (htfTrend(htf, barTime) === 1) {
        const s = scoreBar(ind, closes, vols, i, 1);
        if (s.score >= MIN_SCORE && s.inds >= MIN_INDS)
          signals.push({ bar: i, dir: 1, _seq: signals.length });
      }
    }
    // Bear divergence: price HH, RSI LH
    let pHH = false, rLH = false;
    for (let j = 1; j <= DIV_LB; j++) {
      if (highs[i] > highs[i-j]) pHH = true;
      if (r14[i] < r14[i-j] && r14[i-j] > (100 - RSI_ZONE)) rLH = true;
    }
    if (pHH && rLH && r14[i] > (100 - RSI_ZONE - 10)) {
      if (htfTrend(htf, barTime) === -1) {
        const s = scoreBar(ind, closes, vols, i, -1);
        if (s.score >= MIN_SCORE && s.inds >= MIN_INDS)
          signals.push({ bar: i, dir: -1, _seq: signals.length });
      }
    }
  }
  return signals;
}

// ─── TRADE ENGINE ───
function runEngine(kl5m, signals) {
  let capital = INIT_CAP, peak = capital, maxDD = 0;
  let positions = [], trades = [];
  const dailyPnl = {}, paused = {};
  const getDay = t => new Date(parseInt(t)).toISOString().slice(0,10);

  for (const sig of signals) {
    const entryBar = sig.bar + 2;
    if (entryBar >= kl5m.length) continue;
    if (sig._seq % 5 === 4) continue; // 80% fill
    const day = getDay(kl5m[entryBar][0]);
    if (paused[day]) continue;
    if (!dailyPnl[day]) dailyPnl[day] = 0;
    if (dailyPnl[day] <= -capital * DAILY_LOSS_PCT) { paused[day] = true; continue; }
    if (positions.length >= MAX_POS) continue;

    const entryPrice = parseFloat(kl5m[entryBar][1]);
    const posSize = Math.min(capital * LEV, 25000);
    if (posSize <= 0) continue;
    const qty = posSize / entryPrice;
    const entryCost = posSize * FEE_MAKER;
    const slP = sig.dir === 1 ? entryPrice * (1 - SL_PCT) : entryPrice * (1 + SL_PCT);
    const tpP = sig.dir === 1 ? entryPrice * (1 + TP_PCT) : entryPrice * (1 - TP_PCT);
    const entryTime = parseInt(kl5m[entryBar][0]);
    positions.push(1);

    let closed = false;
    for (let j = entryBar + 1; j < kl5m.length && j <= entryBar + TIMEOUT_BARS; j++) {
      const h = parseFloat(kl5m[j][2]), l = parseFloat(kl5m[j][3]), c = parseFloat(kl5m[j][4]);
      let hitSL = sig.dir === 1 ? l <= slP : h >= slP;
      let hitTP = sig.dir === 1 ? h >= tpP : l <= tpP;
      if (hitSL && hitTP) hitTP = false;

      let net, exitP, typ;
      if (hitSL) {
        exitP = slP * (sig.dir === 1 ? (1 - SLIP_SL) : (1 + SLIP_SL));
        const pnl = sig.dir === 1 ? (exitP - entryPrice) * qty : (entryPrice - exitP) * qty;
        net = pnl - entryCost - posSize * FEE_TAKER; typ = 'SL';
      } else if (hitTP) {
        exitP = tpP;
        const pnl = sig.dir === 1 ? (tpP - entryPrice) * qty : (entryPrice - tpP) * qty;
        net = pnl - entryCost - posSize * FEE_MAKER; typ = 'TP';
      } else if (j === entryBar + TIMEOUT_BARS) {
        exitP = c;
        const pnl = sig.dir === 1 ? (c - entryPrice) * qty : (entryPrice - c) * qty;
        net = pnl - entryCost - posSize * FEE_TAKER; typ = 'TO';
      } else continue;

      capital += net; dailyPnl[day] = (dailyPnl[day]||0) + net;
      if (dailyPnl[day] <= -capital * DAILY_LOSS_PCT) paused[day] = true;
      if (capital > peak) peak = capital;
      const dd = peak > 0 ? (peak - capital) / peak : 0;
      if (dd > maxDD) maxDD = dd;
      trades.push({ dir: sig.dir, entry: entryPrice, exit: exitP, pnl: net, type: typ, bars: j-entryBar, time: entryTime, exitTime: parseInt(kl5m[j][0]) });
      positions = []; closed = true; break;
    }
    if (!closed) positions = [];
  }
  return { trades, finalCapital: capital, maxDD };
}

// ─── ANALYSIS HELPERS ───
function monthlyBreakdown(trades) {
  const months = {};
  for (const t of trades) { const m = new Date(t.time).toISOString().slice(0,7); (months[m] = months[m]||[]).push(t); }
  return Object.entries(months).sort().map(([m, ts]) => {
    const w = ts.filter(t=>t.pnl>0).length;
    return { month: m, trades: ts.length, wins: w, wr: ts.length?w/ts.length*100:0, pnl: ts.reduce((a,t)=>a+t.pnl,0) };
  });
}
function weeklyBreakdown(trades) {
  if (!trades.length) return [];
  const start = trades[0].time, weeks = {};
  for (const t of trades) {
    const w = Math.floor((t.time - start) / (7*86400000));
    if (!weeks[w]) weeks[w] = { trades: [], startDate: new Date(start + w*7*86400000).toISOString().slice(0,10) };
    weeks[w].trades.push(t);
  }
  return Object.entries(weeks).sort((a,b)=>+a[0]-+b[0]).map(([w, d]) => {
    const pnl = d.trades.reduce((a,t)=>a+t.pnl,0);
    const wr = d.trades.length ? d.trades.filter(t=>t.pnl>0).length/d.trades.length*100 : 0;
    return { week: +w+1, start: d.startDate, trades: d.trades.length, wr, pnl };
  });
}
function worstDrawdownPeriod(trades) {
  let cap = INIT_CAP, peak = INIT_CAP, peakIdx = 0, worstDD = 0, ws = 0, we = 0;
  for (let i = 0; i < trades.length; i++) {
    cap += trades[i].pnl;
    if (cap > peak) { peak = cap; peakIdx = i; }
    const dd = peak > 0 ? (peak - cap) / peak : 0;
    if (dd > worstDD) { worstDD = dd; ws = peakIdx; we = i; }
  }
  const ddt = trades.slice(ws, we + 1);
  return { ddPct: worstDD*100, startDate: trades[ws]?new Date(trades[ws].time).toISOString().slice(0,10):'N/A',
    endDate: trades[we]?new Date(trades[we].exitTime).toISOString().slice(0,10):'N/A',
    trades: ddt.length, pnl: ddt.reduce((a,t)=>a+t.pnl,0),
    wins: ddt.filter(t=>t.pnl>0).length, losses: ddt.filter(t=>t.pnl<=0).length };
}

// ─── MAIN ───
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   APEX PRODUCTION BACKTEST V2 — 6-Month Schedule Test  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  console.log('\nDownloading 180 days ETHUSDT data from Binance spot API...');
  const [kl5m, kl1h] = await Promise.all([getKlines('ETHUSDT','5m',DAYS), getKlines('ETHUSDT','1h',DAYS)]);
  console.log(`  5m candles: ${kl5m.length}  |  1h candles: ${kl1h.length}`);
  const startPrice = parseFloat(kl5m[0][1]), endPrice = parseFloat(kl5m[kl5m.length-1][4]);
  const bnh = ((endPrice - startPrice) / startPrice * 100);
  console.log(`  ETH: $${startPrice.toFixed(2)} → $${endPrice.toFixed(2)} (B&H: ${bnh>=0?'+':''}${bnh.toFixed(1)}%)`);
  console.log(`  Period: ${new Date(parseInt(kl5m[0][0])).toISOString().slice(0,10)} → ${new Date(parseInt(kl5m[kl5m.length-1][6])).toISOString().slice(0,10)}`);

  const htf = precomputeHTF(kl1h);
  const results = {};
  console.log('\nRunning schedules...');

  for (const [name, fn] of Object.entries(SCHEDULES)) {
    const sigs = generateSignals(kl5m, htf, fn);
    const eng = runEngine(kl5m, sigs);
    const n = eng.trades.length, wins = eng.trades.filter(t=>t.pnl>0);
    const grossW = wins.reduce((a,t)=>a+t.pnl,0), grossL = Math.abs(eng.trades.filter(t=>t.pnl<=0).reduce((a,t)=>a+t.pnl,0));
    const pnl = eng.trades.reduce((a,t)=>a+t.pnl,0);
    const days = n > 1 ? (eng.trades[n-1].exitTime - eng.trades[0].time) / 86400000 : 1;
    results[name] = { signals: sigs.length, trades: n, tpd: n/Math.max(days,1), pnl, pf: grossL?grossW/grossL:grossW?99:0,
      wr: n?wins.length/n*100:0, maxDD: eng.maxDD*100, finalCap: eng.finalCapital,
      avgWin: wins.length?grossW/wins.length:0, avgLoss: eng.trades.filter(t=>t.pnl<=0).length?grossL/eng.trades.filter(t=>t.pnl<=0).length:0,
      expectancy: n?pnl/n:0, trades_list: eng.trades };
    console.log(`  ${name.padEnd(18)} → ${sigs.length} sigs, ${n} trades, PnL: $${pnl.toFixed(2)}`);
  }

  // 1. SCHEDULE COMPARISON
  console.log('\n' + '═'.repeat(105));
  console.log('1. SCHEDULE COMPARISON');
  console.log('═'.repeat(105));
  console.log('Schedule          │ Signals │ Trades │ Tr/Day │   PnL ($) │    PF │  WR(%) │ MaxDD(%) │ Final Cap');
  console.log('──────────────────┼─────────┼────────┼────────┼───────────┼───────┼────────┼──────────┼──────────');
  let bestSched = null, bestPnl = -Infinity;
  for (const [name, r] of Object.entries(results)) {
    console.log(`${name.padEnd(18)}│ ${r.signals.toString().padStart(7)} │ ${r.trades.toString().padStart(6)} │ ${r.tpd.toFixed(2).padStart(6)} │ ${((r.pnl>=0?'+':'')+r.pnl.toFixed(2)).padStart(9)} │ ${r.pf.toFixed(2).padStart(5)} │ ${r.wr.toFixed(1).padStart(6)} │ ${r.maxDD.toFixed(1).padStart(8)} │ $${r.finalCap.toFixed(0)}`);
    if (r.pnl > bestPnl) { bestPnl = r.pnl; bestSched = name; }
  }
  console.log(`\n  ★ Best schedule: ${bestSched} (PnL: $${bestPnl.toFixed(2)})`);
  const best = results[bestSched];

  // 2. MONTHLY
  console.log('\n' + '═'.repeat(80));
  console.log(`2. MONTHLY BREAKDOWN — ${bestSched}`);
  console.log('═'.repeat(80));
  const monthly = monthlyBreakdown(best.trades_list);
  console.log('Month    │ Trades │ Wins │  WR(%) │    PnL ($) │ Cum PnL');
  console.log('─────────┼────────┼──────┼────────┼────────────┼────────');
  let cum = 0;
  for (const m of monthly) { cum += m.pnl; console.log(`${m.month}  │ ${m.trades.toString().padStart(6)} │ ${m.wins.toString().padStart(4)} │ ${m.wr.toFixed(1).padStart(6)} │ ${((m.pnl>=0?'+':'')+m.pnl.toFixed(2)).padStart(10)} │ $${cum.toFixed(2)}`); }

  // 3. WEEKLY
  console.log('\n' + '═'.repeat(80));
  console.log(`3. WEEKLY BREAKDOWN — ${bestSched}`);
  console.log('═'.repeat(80));
  const weekly = weeklyBreakdown(best.trades_list);
  console.log('Week │ Start      │ Trades │  WR(%) │    PnL ($) │ Cum PnL');
  console.log('─────┼────────────┼────────┼────────┼────────────┼────────');
  cum = 0;
  for (const w of weekly) { cum += w.pnl; console.log(`W${w.week.toString().padStart(3)}│ ${w.start} │ ${w.trades.toString().padStart(6)} │ ${w.wr.toFixed(1).padStart(6)} │ ${((w.pnl>=0?'+':'')+w.pnl.toFixed(2)).padStart(10)} │ $${cum.toFixed(2)}`); }

  // 4. FULL STATS
  console.log('\n' + '═'.repeat(80));
  console.log(`4. FULL STATISTICS — ${bestSched}`);
  console.log('═'.repeat(80));
  console.log(`  Total Trades:      ${best.trades}`);
  console.log(`  Win Rate:          ${best.wr.toFixed(1)}%`);
  console.log(`  Profit Factor:     ${best.pf.toFixed(3)}`);
  console.log(`  Net PnL:           $${best.pnl.toFixed(2)} (${((best.finalCap-INIT_CAP)/INIT_CAP*100).toFixed(1)}% return)`);
  console.log(`  Final Capital:     $${best.finalCap.toFixed(2)} (from $${INIT_CAP})`);
  console.log(`  Avg Win:           $${best.avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:          $${best.avgLoss.toFixed(2)}`);
  console.log(`  Expectancy:        $${best.expectancy.toFixed(2)} per trade`);
  console.log(`  Trades/Day:        ${best.tpd.toFixed(2)}`);
  console.log(`  Max Drawdown:      ${best.maxDD.toFixed(1)}%`);
  console.log(`  Longs:             ${best.trades_list.filter(t=>t.dir===1).length}`);
  console.log(`  Shorts:            ${best.trades_list.filter(t=>t.dir===-1).length}`);
  console.log(`  TP exits:          ${best.trades_list.filter(t=>t.type==='TP').length}`);
  console.log(`  SL exits:          ${best.trades_list.filter(t=>t.type==='SL').length}`);
  console.log(`  Timeout exits:     ${best.trades_list.filter(t=>t.type==='TO').length}`);
  console.log(`  Avg bars in trade: ${best.trades?(best.trades_list.reduce((a,t)=>a+t.bars,0)/best.trades).toFixed(1):'0'}`);

  // 5. TOP 5 BEST & WORST
  console.log('\n' + '═'.repeat(90));
  console.log('5. TOP 5 BEST & WORST TRADES');
  console.log('═'.repeat(90));
  const sorted = [...best.trades_list].sort((a,b)=>b.pnl-a.pnl);
  console.log('  BEST:');
  console.log('  # │ Dir   │ Entry     │ Exit      │   PnL ($) │ Type │ Date');
  for (let i = 0; i < Math.min(5, sorted.length); i++) { const t = sorted[i]; console.log(`  ${i+1} │ ${t.dir===1?'LONG ':'SHORT'} │ $${t.entry.toFixed(2).padStart(8)} │ $${t.exit.toFixed(2).padStart(8)} │ ${('+'+t.pnl.toFixed(2)).padStart(9)} │ ${t.type.padStart(4)} │ ${new Date(t.time).toISOString().slice(0,10)}`); }
  console.log('  WORST:');
  const worst5 = sorted.slice(-Math.min(5,sorted.length)).reverse();
  for (let i = 0; i < worst5.length; i++) { const t = worst5[i]; console.log(`  ${i+1} │ ${t.dir===1?'LONG ':'SHORT'} │ $${t.entry.toFixed(2).padStart(8)} │ $${t.exit.toFixed(2).padStart(8)} │ ${t.pnl.toFixed(2).padStart(9)} │ ${t.type.padStart(4)} │ ${new Date(t.time).toISOString().slice(0,10)}`); }

  // 6. WORST DRAWDOWN
  console.log('\n' + '═'.repeat(80));
  console.log('6. WORST DRAWDOWN PERIOD');
  console.log('═'.repeat(80));
  const dd = worstDrawdownPeriod(best.trades_list);
  console.log(`  Max Drawdown:   ${dd.ddPct.toFixed(1)}%`);
  console.log(`  Period:         ${dd.startDate} → ${dd.endDate}`);
  console.log(`  Trades in DD:   ${dd.trades} (${dd.wins}W / ${dd.losses}L)`);
  console.log(`  PnL during DD:  $${dd.pnl.toFixed(2)}`);

  // 7. BUY & HOLD
  console.log('\n' + '═'.repeat(80));
  console.log('7. BUY & HOLD COMPARISON');
  console.log('═'.repeat(80));
  const sr = (best.finalCap - INIT_CAP) / INIT_CAP * 100;
  console.log(`  ETH B&H Return:    ${bnh>=0?'+':''}${bnh.toFixed(1)}% ($${(INIT_CAP*bnh/100).toFixed(2)})`);
  console.log(`  Strategy Return:   ${sr>=0?'+':''}${sr.toFixed(1)}% ($${best.pnl.toFixed(2)})`);
  console.log(`  Alpha:             ${(sr-bnh)>=0?'+':''}${(sr-bnh).toFixed(1)}%`);
  console.log(`  ETH Start:         $${startPrice.toFixed(2)}`);
  console.log(`  ETH End:           $${endPrice.toFixed(2)}`);
  console.log('\n' + '═'.repeat(60));
  console.log('  BACKTEST COMPLETE');
  console.log('═'.repeat(60));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
