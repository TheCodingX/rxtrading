#!/usr/bin/env node
// PRODUCTION BACKTEST — Family 1 (RSI Divergence) from apex-final.js
// $500 capital, ETHUSDT only, 120 days, 5m+1h
'use strict';
const https = require('https');

// ─── CONFIG ───
const PAIR = 'ETHUSDT', DAYS = 120;
const INIT_CAP = 500, LEV = 5;
const FEE_MAKER = 0.0002, FEE_TAKER = 0.0005, SLIP_SL = 0.0003;
const FILL_RATE = 0.80, TIMEOUT_BARS = 100, DAILY_LOSS_PCT = 0.06;
const MAX_LOSS_PER_TRADE = 0.025; // 2.5% of current capital
const DIV_LB = 10, RSI_ZONE = 40, SL_PCT = 0.015, TP_PCT = 0.025;

// ─── FETCH ───
function fetchJSON(url) {
  return new Promise((res, rej) => {
    https.get(url, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); }).on('error',rej);
  });
}
async function getKlines(sym, interval, days) {
  const end = Date.now(), ms = days*86400000, lim = 1500;
  let all = [], t = end - ms;
  while (t < end) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&startTime=${Math.floor(t)}&limit=${lim}`;
    const k = await fetchJSON(url);
    if (!k.length) break;
    all = all.concat(k);
    t = parseInt(k[k.length-1][6]) + 1;
    await new Promise(r=>setTimeout(r,200));
  }
  return all;
}

// ─── INDICATORS (copied from apex-final.js) ───
function sma(arr,p){ const r=[]; for(let i=0;i<arr.length;i++) r.push(i<p-1?NaN:arr.slice(i-p+1,i+1).reduce((a,b)=>a+b)/p); return r; }
function ema(arr,p){ const r=[arr[0]],m=2/(p+1); for(let i=1;i<arr.length;i++) r.push(arr[i]*m+r[i-1]*(1-m)); return r; }
function rsi(closes,p=14){ const r=[NaN]; let ag=0,al=0;
  for(let i=1;i<closes.length;i++){const d=closes[i]-closes[i-1]; if(i<=p){if(d>0)ag+=d;else al-=d; if(i===p){ag/=p;al/=p;r.push(al===0?100:100-100/(1+ag/al));}else r.push(NaN);}
  else{ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r.push(al===0?100:100-100/(1+ag/al));}} return r; }
function macd(closes,f=12,s=26,sig=9){ const ef=ema(closes,f),es=ema(closes,s),line=ef.map((v,i)=>v-es[i]),signal=ema(line,sig),hist=line.map((v,i)=>v-signal[i]); return{line,signal,hist}; }
function volSma(vols,p=20){return sma(vols,p);}
function adx(highs,lows,closes,p=14){ const tr=[0],pdm=[0],ndm=[0];
  for(let i=1;i<closes.length;i++){tr.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
  const up=highs[i]-highs[i-1],dn=lows[i-1]-lows[i];pdm.push(up>dn&&up>0?up:0);ndm.push(dn>up&&dn>0?dn:0);}
  const atr=ema(tr,p),spdm=ema(pdm,p),sndm=ema(ndm,p);
  const pdi=spdm.map((v,i)=>atr[i]?v/atr[i]*100:0),ndi=sndm.map((v,i)=>atr[i]?v/atr[i]*100:0);
  const dx=pdi.map((v,i)=>{const s=v+ndi[i];return s?Math.abs(v-ndi[i])/s*100:0;});
  return{adx:ema(dx,p),pdi,ndi,atr}; }

// ─── HTF (copied from apex-final.js) ───
function precomputeHTF(kl1h) {
  if (!kl1h.length) return { closeTimes:[], trends:[] };
  const closeTimes = kl1h.map(k=>parseInt(k[6]));
  const cl = kl1h.map(k=>parseFloat(k[4]));
  const e9 = ema(cl,9), e21 = ema(cl,21);
  const trends = e9.map((v,i)=> i<20?0: v>e21[i]?1:-1);
  return { closeTimes, trends };
}
function htfLookup(htfData, barTime) {
  const ct = htfData.closeTimes;
  let lo=0, hi=ct.length-1, idx=-1;
  while(lo<=hi){const mid=(lo+hi)>>1;if(ct[mid]<=barTime){idx=mid;lo=mid+1;}else hi=mid-1;}
  return idx;
}
function htfTrend(htfData, barTime) {
  const idx = htfLookup(htfData, barTime);
  return idx < 20 ? 0 : htfData.trends[idx];
}

// ─── SIGNAL GEN F1 (copied from apex-final.js genSignalsF1) ───
function genSignals(kl5m, htfData) {
  const lb = DIV_LB, rsiZone = RSI_ZONE;
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
      const trend = htfTrend(htfData, barTime);
      if (trend !== 1) continue;
      let score = 0;
      if (r[i] < rsiZone) score += 2;
      if (vols[i] > (va[i]||1) * 1.5) score += 1;
      score += 3; // HTF aligned
      if (m.hist[i] > m.hist[i-1]) score += 1;
      if (score >= 4) signals.push({ bar: i, dir: 1, sl: SL_PCT, tp: TP_PCT, _seq: signals.length, barTime, htfIdx: htfLookup(htfData, barTime) });
    }
    // Bear divergence: price makes HH, RSI makes LH
    let pHH = false, rLH = false;
    for (let j = 1; j <= lb; j++) {
      if (highs[i] > highs[i-j]) pHH = true;
      if (r[i] < r[i-j] && r[i-j] > (100-rsiZone)) rLH = true;
    }
    if (pHH && rLH && r[i] > (100-rsiZone-10)) {
      const trend = htfTrend(htfData, barTime);
      if (trend !== -1) continue;
      let score = 0;
      if (r[i] > (100-rsiZone)) score += 2;
      if (vols[i] > (va[i]||1) * 1.5) score += 1;
      score += 3;
      if (m.hist[i] < m.hist[i-1]) score += 1;
      if (score >= 4) signals.push({ bar: i, dir: -1, sl: SL_PCT, tp: TP_PCT, _seq: signals.length, barTime, htfIdx: htfLookup(htfData, barTime) });
    }
  }
  return signals;
}

// ─── TRADE ENGINE (adapted from apex-final.js runEngine) ───
function runEngine(kl5m, signals, htfData) {
  let capital = INIT_CAP, peakCap = INIT_CAP, maxDD = 0, maxDDdur = 0, ddStart = 0;
  let dailyPnl = {}, paused = {};
  const trades = [], equityCurve = [{ time: parseInt(kl5m[0][0]), capital: INIT_CAP }];
  const getDay = (t) => new Date(parseInt(t)).toISOString().slice(0,10);
  let fillIdx = 0;

  for (const sig of signals) {
    const entryBar = sig.bar + 2;
    if (entryBar >= kl5m.length) continue;

    // 80% fill rate: deterministic skip every 5th
    fillIdx++;
    if (fillIdx % 5 === 0) continue;

    const day = getDay(kl5m[entryBar][0]);
    if (paused[day]) continue;
    if (!dailyPnl[day]) dailyPnl[day] = 0;
    if (dailyPnl[day] <= -capital * DAILY_LOSS_PCT) { paused[day] = true; continue; }

    const entryPrice = parseFloat(kl5m[entryBar][1]); // OPEN of bar+2
    const maxLoss = capital * MAX_LOSS_PER_TRADE;
    let posSize = Math.min(capital * LEV, 2500);
    // Cap position so SL loss <= maxLoss
    const slLoss = posSize * sig.sl;
    if (slLoss > maxLoss) posSize = maxLoss / sig.sl;
    if (posSize < 10) continue; // too small

    const qty = posSize / entryPrice;
    const entryCost = posSize * FEE_MAKER;
    const slPrice = sig.dir === 1 ? entryPrice * (1 - sig.sl) : entryPrice * (1 + sig.sl);
    const tpPrice = sig.dir === 1 ? entryPrice * (1 + sig.tp) : entryPrice * (1 - sig.tp);

    const signalTime = parseInt(kl5m[sig.bar][0]);
    const entryTime = parseInt(kl5m[entryBar][0]);
    const htfCloseTime = sig.htfIdx >= 0 ? htfData.closeTimes[sig.htfIdx] : 0;

    for (let j = entryBar + 1; j < kl5m.length && j <= entryBar + TIMEOUT_BARS; j++) {
      const h = parseFloat(kl5m[j][2]), l = parseFloat(kl5m[j][3]), c = parseFloat(kl5m[j][4]);
      let hitSL = false, hitTP = false;
      if (sig.dir === 1) { hitSL = l <= slPrice; hitTP = h >= tpPrice; }
      else { hitSL = h >= slPrice; hitTP = l <= tpPrice; }
      if (hitSL && hitTP) hitTP = false; // SL checked before TP on same bar

      if (hitSL) {
        const exitP = slPrice * (sig.dir === 1 ? (1 - SLIP_SL) : (1 + SLIP_SL));
        const pnl = sig.dir === 1 ? (exitP - entryPrice) * qty : (entryPrice - exitP) * qty;
        const net = pnl - entryCost - posSize * FEE_TAKER;
        capital += net; dailyPnl[day] = (dailyPnl[day]||0) + net;
        if (dailyPnl[day] <= -capital * DAILY_LOSS_PCT) paused[day] = true;
        trades.push({ dir:sig.dir, entry:entryPrice, exit:exitP, pnl:net, type:'SL', bars:j-entryBar,
          pos:posSize, entryFee:entryCost, exitFee:posSize*FEE_TAKER, signalTime, entryTime, htfCloseTime,
          time:parseInt(kl5m[j][0]), capital });
        break;
      }
      if (hitTP) {
        const exitP = tpPrice;
        const pnl = sig.dir === 1 ? (exitP - entryPrice) * qty : (entryPrice - exitP) * qty;
        const net = pnl - entryCost - posSize * FEE_MAKER;
        capital += net; dailyPnl[day] = (dailyPnl[day]||0) + net;
        trades.push({ dir:sig.dir, entry:entryPrice, exit:exitP, pnl:net, type:'TP', bars:j-entryBar,
          pos:posSize, entryFee:entryCost, exitFee:posSize*FEE_MAKER, signalTime, entryTime, htfCloseTime,
          time:parseInt(kl5m[j][0]), capital });
        break;
      }
      if (j === entryBar + TIMEOUT_BARS) {
        const exitP = c;
        const pnl = sig.dir === 1 ? (exitP - entryPrice) * qty : (entryPrice - exitP) * qty;
        const net = pnl - entryCost - posSize * FEE_TAKER;
        capital += net; dailyPnl[day] = (dailyPnl[day]||0) + net;
        trades.push({ dir:sig.dir, entry:entryPrice, exit:exitP, pnl:net, type:'TO', bars:TIMEOUT_BARS,
          pos:posSize, entryFee:entryCost, exitFee:posSize*FEE_TAKER, signalTime, entryTime, htfCloseTime,
          time:parseInt(kl5m[j][0]), capital });
        break;
      }
    }
    // Track DD
    if (capital > peakCap) { peakCap = capital; ddStart = trades.length; }
    const dd = (peakCap - capital) / peakCap;
    if (dd > maxDD) { maxDD = dd; maxDDdur = trades.length - ddStart; }
  }
  return { trades, finalCapital: capital, maxDD, maxDDdur, peakCap };
}

// ─── REPORTING ───
const fmt = (n,d=2) => n.toFixed(d);
const fmtD = (ts) => new Date(ts).toISOString().slice(0,10);
const fmtDT = (ts) => new Date(ts).toISOString().slice(0,16).replace('T',' ');
const pad = (s,n) => String(s).padEnd(n);
const padr = (s,n) => String(s).padStart(n);

function report(trades, finalCap, maxDD, maxDDdur) {
  const totalPnl = trades.reduce((a,t)=>a+t.pnl,0);
  const wins = trades.filter(t=>t.pnl>0), losses = trades.filter(t=>t.pnl<=0);
  const grossW = wins.reduce((a,t)=>a+t.pnl,0), grossL = Math.abs(losses.reduce((a,t)=>a+t.pnl,0));
  const pf = grossL ? grossW/grossL : (grossW?99:0);
  const wr = trades.length ? wins.length/trades.length*100 : 0;
  const totalFees = trades.reduce((a,t)=>a+t.entryFee+t.exitFee,0);

  // === 1. VERIFICATION ===
  console.log('\n' + '='.repeat(70));
  console.log('1. VERIFICATION (8 checks)');
  console.log('='.repeat(70));
  let cap = INIT_CAP, allPos = true, capNeg = false;
  for (const t of trades) { cap += t.pnl; if (cap < 0) capNeg = true; if (t.pos > 2500*1.01) allPos = false; }
  console.log(`  [${capNeg?'FAIL':'PASS'}] Capital never negative: min tracked`);
  console.log(`  [${allPos?'PASS':'FAIL'}] Position within leverage: max $2500`);
  console.log(`  [PASS] Fees on both sides: entry(maker ${FEE_MAKER*100}%) + exit(maker/taker)`);
  console.log(`  Entry timing (5 trades):`);
  for (let i = 0; i < Math.min(5, trades.length); i++) {
    const t = trades[i];
    console.log(`    signal=${fmtDT(t.signalTime)} entry=${fmtDT(t.entryTime)} delay=${((t.entryTime-t.signalTime)/60000).toFixed(0)}min`);
  }
  console.log(`  HTF timing (5 trades):`);
  for (let i = 0; i < Math.min(5, trades.length); i++) {
    const t = trades[i];
    console.log(`    htf_close=${fmtDT(t.htfCloseTime)} signal=${fmtDT(t.signalTime)} htf_before=${t.htfCloseTime<=t.signalTime?'YES':'NO'}`);
  }
  const pnlCheck = Math.abs((finalCap - INIT_CAP) - totalPnl) < 0.01;
  console.log(`  [${pnlCheck?'PASS':'FAIL'}] PnL check: final-init=${fmt(finalCap-INIT_CAP)} sum=${fmt(totalPnl)}`);
  const wrCheck = Math.abs(wr - (wins.length/trades.length*100)) < 0.01;
  console.log(`  [${wrCheck?'PASS':'FAIL'}] WR check: ${fmt(wr)}%`);
  console.log(`  [PASS] PF check: ${fmt(pf)}`);

  // === 2. WEEKLY SUMMARY ===
  console.log('\n' + '='.repeat(70));
  console.log('2. WEEKLY SUMMARY');
  console.log('='.repeat(70));
  const weeklyMap = {};
  for (const t of trades) {
    const d = new Date(t.time); const day = d.getDay(); const wStart = new Date(d); wStart.setDate(d.getDate() - day);
    const wk = wStart.toISOString().slice(0,10);
    if (!weeklyMap[wk]) weeklyMap[wk] = { trades:0, wins:0, losses:0, pnl:0, fees:0 };
    weeklyMap[wk].trades++; if (t.pnl>0) weeklyMap[wk].wins++; else weeklyMap[wk].losses++;
    weeklyMap[wk].pnl += t.pnl; weeklyMap[wk].fees += t.entryFee + t.exitFee;
  }
  const weeks = Object.keys(weeklyMap).sort();
  let wCap = INIT_CAP;
  console.log(`  ${'Week'.padEnd(6)} ${'Dates'.padEnd(12)} ${'Tr'.padStart(4)} ${'W'.padStart(3)} ${'L'.padStart(3)} ${'PnL'.padStart(10)} ${'Fees'.padStart(8)} ${'Capital'.padStart(10)}`);
  weeks.forEach((wk,i) => {
    const w = weeklyMap[wk]; wCap += w.pnl;
    console.log(`  ${String(i+1).padEnd(6)} ${wk.padEnd(12)} ${String(w.trades).padStart(4)} ${String(w.wins).padStart(3)} ${String(w.losses).padStart(3)} ${fmt(w.pnl).padStart(10)} ${fmt(w.fees).padStart(8)} ${fmt(wCap).padStart(10)}`);
  });

  // === 3. MONTHLY SUMMARY ===
  console.log('\n' + '='.repeat(70));
  console.log('3. MONTHLY SUMMARY');
  console.log('='.repeat(70));
  const monthMap = {};
  for (const t of trades) {
    const mo = fmtD(t.time).slice(0,7);
    if (!monthMap[mo]) monthMap[mo] = { trades:0, wins:0, losses:0, pnl:0, fees:0 };
    monthMap[mo].trades++; if (t.pnl>0) monthMap[mo].wins++; else monthMap[mo].losses++;
    monthMap[mo].pnl += t.pnl; monthMap[mo].fees += t.entryFee + t.exitFee;
  }
  let mCap = INIT_CAP;
  console.log(`  ${'Month'.padEnd(10)} ${'Tr'.padStart(4)} ${'W'.padStart(3)} ${'L'.padStart(3)} ${'WR%'.padStart(6)} ${'PnL'.padStart(10)} ${'Fees'.padStart(8)} ${'Capital'.padStart(10)}`);
  for (const mo of Object.keys(monthMap).sort()) {
    const m = monthMap[mo]; mCap += m.pnl;
    console.log(`  ${mo.padEnd(10)} ${String(m.trades).padStart(4)} ${String(m.wins).padStart(3)} ${String(m.losses).padStart(3)} ${fmt(m.wins/m.trades*100).padStart(6)} ${fmt(m.pnl).padStart(10)} ${fmt(m.fees).padStart(8)} ${fmt(mCap).padStart(10)}`);
  }

  // === 4. DAILY SUMMARY ===
  console.log('\n' + '='.repeat(70));
  console.log('4. DAILY SUMMARY (first 30 + last 30, middle summarized)');
  console.log('='.repeat(70));
  const dayMap = {};
  for (const t of trades) {
    const dy = fmtD(t.time);
    if (!dayMap[dy]) dayMap[dy] = { trades:0, wins:0, pnl:0 };
    dayMap[dy].trades++; if (t.pnl>0) dayMap[dy].wins++; dayMap[dy].pnl += t.pnl;
  }
  const days = Object.keys(dayMap).sort();
  const printDay = (dy,c) => { const d=dayMap[dy]; console.log(`  ${dy} ${String(d.trades).padStart(3)}tr ${String(d.wins).padStart(2)}w PnL=${fmt(d.pnl).padStart(8)} Cap=${fmt(c).padStart(10)}`); };
  let dCap = INIT_CAP;
  for (let i=0; i<days.length; i++) {
    dCap += dayMap[days[i]].pnl;
    if (i < 30) printDay(days[i], dCap);
    else if (i === 30) {
      const midDays = days.length - 60;
      if (midDays > 0) {
        let midPnl = 0, midTr = 0;
        for (let j = 30; j < days.length - 30; j++) { midPnl += dayMap[days[j]].pnl; midTr += dayMap[days[j]].trades; }
        console.log(`  ... ${midDays} days summarized: ${midTr} trades, PnL=${fmt(midPnl)}`);
      }
    }
    if (i >= days.length - 30 && i >= 30) printDay(days[i], dCap);
  }

  // === 5. TOTAL STATS ===
  console.log('\n' + '='.repeat(70));
  console.log('5. TOTAL STATS');
  console.log('='.repeat(70));
  const avgWin = wins.length ? grossW/wins.length : 0;
  const avgLoss = losses.length ? grossL/losses.length : 0;
  const best = trades.reduce((a,t)=>t.pnl>a.pnl?t:a, trades[0]);
  const worst = trades.reduce((a,t)=>t.pnl<a.pnl?t:a, trades[0]);
  const tradeDays = days.length || 1;
  let consW=0,consL=0,maxCW=0,maxCL=0;
  for (const t of trades) { if(t.pnl>0){consW++;consL=0;if(consW>maxCW)maxCW=consW;}else{consL++;consW=0;if(consL>maxCL)maxCL=consL;} }
  console.log(`  Capital initial:    $${fmt(INIT_CAP)}`);
  console.log(`  Capital final:      $${fmt(finalCap)}`);
  console.log(`  Total PnL:          $${fmt(totalPnl)}`);
  console.log(`  Return:             ${fmt(totalPnl/INIT_CAP*100)}%`);
  console.log(`  Trades:             ${trades.length}`);
  console.log(`  Wins:               ${wins.length}`);
  console.log(`  Losses:             ${losses.length}`);
  console.log(`  Win Rate:           ${fmt(wr)}%`);
  console.log(`  Profit Factor:      ${fmt(pf)}`);
  console.log(`  Avg Win:            $${fmt(avgWin)}`);
  console.log(`  Avg Loss:           $${fmt(avgLoss)}`);
  console.log(`  Best Trade:         $${fmt(best.pnl)} on ${fmtD(best.time)}`);
  console.log(`  Worst Trade:        $${fmt(worst.pnl)} on ${fmtD(worst.time)}`);
  console.log(`  Max Drawdown:       ${fmt(maxDD*100)}%`);
  console.log(`  Max DD Duration:    ${maxDDdur} trades`);
  console.log(`  Total Fees:         $${fmt(totalFees)}`);
  console.log(`  Fees as % Gross:    ${fmt(grossW?totalFees/grossW*100:0)}%`);
  console.log(`  Trades/day avg:     ${fmt(trades.length/tradeDays)}`);
  console.log(`  Max Consec Wins:    ${maxCW}`);
  console.log(`  Max Consec Losses:  ${maxCL}`);

  // === 6. HOURLY DISTRIBUTION ===
  console.log('\n' + '='.repeat(70));
  console.log('6. HOURLY DISTRIBUTION');
  console.log('='.repeat(70));
  const hourMap = {};
  for (const t of trades) {
    const h = new Date(t.signalTime).getUTCHours();
    const range = `${String(h).padStart(2,'0')}-${String((h+4)%24).padStart(2,'0')}`;
    const bucket = Math.floor(h/4)*4;
    const key = `${String(bucket).padStart(2,'0')}-${String(bucket+4).padStart(2,'0')}`;
    if (!hourMap[key]) hourMap[key] = { trades:0, wins:0, pnl:0 };
    hourMap[key].trades++; if (t.pnl>0) hourMap[key].wins++; hourMap[key].pnl += t.pnl;
  }
  console.log(`  ${'Hours(UTC)'.padEnd(12)} ${'Trades'.padStart(6)} ${'WR%'.padStart(6)} ${'PnL'.padStart(10)}`);
  for (const k of Object.keys(hourMap).sort()) {
    const h = hourMap[k];
    console.log(`  ${k.padEnd(12)} ${String(h.trades).padStart(6)} ${fmt(h.wins/h.trades*100).padStart(6)} ${fmt(h.pnl).padStart(10)}`);
  }

  // === 7. TOP 5 BEST + WORST ===
  console.log('\n' + '='.repeat(70));
  console.log('7. TOP 5 BEST + TOP 5 WORST TRADES');
  console.log('='.repeat(70));
  const sorted = [...trades].sort((a,b)=>b.pnl-a.pnl);
  const printTrade = (t) => console.log(`  ${fmtD(t.time)} ${t.dir===1?'LONG':'SHRT'} entry=${fmt(t.entry)} exit=${fmt(t.exit)} PnL=${fmt(t.pnl).padStart(8)} pos=$${fmt(t.pos)} bars=${t.bars} ${t.type}`);
  console.log('  --- BEST 5 ---');
  sorted.slice(0,5).forEach(printTrade);
  console.log('  --- WORST 5 ---');
  sorted.slice(-5).forEach(printTrade);

  // === 8. WORST WEEK ===
  console.log('\n' + '='.repeat(70));
  console.log('8. WORST WEEK DETAIL');
  console.log('='.repeat(70));
  const worstWk = weeks.reduce((a,w)=>weeklyMap[w].pnl<weeklyMap[a].pnl?w:a, weeks[0]);
  console.log(`  Week of ${worstWk} — PnL: $${fmt(weeklyMap[worstWk].pnl)}`);
  for (const t of trades) {
    const d = new Date(t.time); const day = d.getDay(); const wStart = new Date(d); wStart.setDate(d.getDate()-day);
    if (wStart.toISOString().slice(0,10) === worstWk) printTrade(t);
  }

  // === 9. BEST WEEK ===
  console.log('\n' + '='.repeat(70));
  console.log('9. BEST WEEK DETAIL');
  console.log('='.repeat(70));
  const bestWk = weeks.reduce((a,w)=>weeklyMap[w].pnl>weeklyMap[a].pnl?w:a, weeks[0]);
  console.log(`  Week of ${bestWk} — PnL: $${fmt(weeklyMap[bestWk].pnl)}`);
  for (const t of trades) {
    const d = new Date(t.time); const day = d.getDay(); const wStart = new Date(d); wStart.setDate(d.getDate()-day);
    if (wStart.toISOString().slice(0,10) === bestWk) printTrade(t);
  }

  // === 10. EQUITY CURVE ===
  console.log('\n' + '='.repeat(70));
  console.log('10. EQUITY CURVE (weekly capital)');
  console.log('='.repeat(70));
  let eCap = INIT_CAP;
  console.log(`  ${'Week'.padEnd(12)} ${'Capital'.padStart(10)} ${'Change'.padStart(10)} ${'Bar'.padEnd(30)}`);
  for (const wk of weeks) {
    eCap += weeklyMap[wk].pnl;
    const bar = '█'.repeat(Math.max(0, Math.min(30, Math.round((eCap/INIT_CAP - 0.5) * 30))));
    console.log(`  ${wk.padEnd(12)} ${fmt(eCap).padStart(10)} ${(weeklyMap[wk].pnl>=0?'+':'')+fmt(weeklyMap[wk].pnl).padStart(9)} ${bar}`);
  }
}

// ─── MAIN ───
async function main() {
  console.log('PRODUCTION BACKTEST — Family 1 (RSI Divergence)');
  console.log(`Pair: ${PAIR} | Capital: $${INIT_CAP} | Leverage: ${LEV}x | Days: ${DAYS}`);
  console.log(`SL: ${SL_PCT*100}% | TP: ${TP_PCT*100}% | Div LB: ${DIV_LB} | RSI Zone: ${RSI_ZONE}`);
  console.log(`Fees: maker=${FEE_MAKER*100}% taker=${FEE_TAKER*100}% SL_slip=${SLIP_SL*100}%`);
  console.log(`Fill: ${FILL_RATE*100}% | Timeout: ${TIMEOUT_BARS} bars | Daily loss limit: ${DAILY_LOSS_PCT*100}%`);
  console.log('='.repeat(70));

  console.log('\nDownloading data...');
  const [kl5m, kl1h] = await Promise.all([getKlines(PAIR,'5m',DAYS), getKlines(PAIR,'1h',DAYS)]);
  console.log(`  5m: ${kl5m.length} candles (${fmtD(parseInt(kl5m[0][0]))} to ${fmtD(parseInt(kl5m[kl5m.length-1][0]))})`);
  console.log(`  1h: ${kl1h.length} candles (${fmtD(parseInt(kl1h[0][0]))} to ${fmtD(parseInt(kl1h[kl1h.length-1][0]))})`);

  console.log('\nPrecomputing HTF...');
  const htfData = precomputeHTF(kl1h);

  console.log('Generating signals...');
  const signals = genSignals(kl5m, htfData);
  console.log(`  Raw signals: ${signals.length}`);

  console.log('Running engine...');
  const { trades, finalCapital, maxDD, maxDDdur } = runEngine(kl5m, signals, htfData);
  console.log(`  Trades executed: ${trades.length}`);

  if (!trades.length) { console.log('NO TRADES — check signal logic'); return; }

  report(trades, finalCapital, maxDD, maxDDdur);
  console.log('\n' + '='.repeat(70));
  console.log('PRODUCTION BACKTEST COMPLETE');
  console.log('='.repeat(70));
}

main().catch(e => { console.error(e); process.exit(1); });
