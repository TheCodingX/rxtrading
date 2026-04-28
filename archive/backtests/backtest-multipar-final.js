#!/usr/bin/env node
// MULTI-PAR SIMULTANEOUS BACKTEST — Compound Growth, Shared Capital
// Reuses verified engine logic from backtest-apex-final.js
'use strict';
const https = require('https');

// ─── CONFIG ───
const PAIRS = ['ETHUSDT','SOLUSDT','BTCUSDT','DOGEUSDT','XRPUSDT']; // priority order by OOS PF
const DAYS = 180, IS_DAYS = 120;
const INIT_CAP = 2500, LEV = 5;
const FEE_MAKER = 0.0002, FEE_TAKER = 0.0005, SLIP_SL = 0.0003;
const FILL_RATE = 0.8, TIMEOUT_BARS = 100, DAILY_LOSS_PCT = 0.06;
const SL = 0.015, TP = 0.025, RSI_ZONE = 40, LOOKBACK = 10;

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
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&startTime=${Math.floor(t)}&limit=1500`;
    const k = await fetchJSON(url);
    if (!k.length) break;
    all = all.concat(k);
    t = parseInt(k[k.length-1][6]) + 1;
    await new Promise(r=>setTimeout(r,200));
  }
  return all;
}

// ─── INDICATORS ───
function sma(arr,p){const r=[];for(let i=0;i<arr.length;i++)r.push(i<p-1?NaN:arr.slice(i-p+1,i+1).reduce((a,b)=>a+b)/p);return r;}
function ema(arr,p){const r=[arr[0]],m=2/(p+1);for(let i=1;i<arr.length;i++)r.push(arr[i]*m+r[i-1]*(1-m));return r;}
function rsi(closes,p=14){const r=[NaN];let ag=0,al=0;
  for(let i=1;i<closes.length;i++){const d=closes[i]-closes[i-1];if(i<=p){if(d>0)ag+=d;else al-=d;if(i===p){ag/=p;al/=p;r.push(al===0?100:100-100/(1+ag/al));}else r.push(NaN);}
  else{ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r.push(al===0?100:100-100/(1+ag/al));}}return r;}
function macd(closes){const ef=ema(closes,12),es=ema(closes,26),line=ef.map((v,i)=>v-es[i]),signal=ema(line,9),hist=line.map((v,i)=>v-signal[i]);return{hist};}
function volSma(vols,p=20){return sma(vols,p);}

// ─── HTF ───
function precomputeHTF(kl1h) {
  if (!kl1h.length) return {closeTimes:[],trends:[]};
  const ct = kl1h.map(k=>parseInt(k[6]));
  const cl = kl1h.map(k=>parseFloat(k[4]));
  const e9 = ema(cl,9), e21 = ema(cl,21);
  const trends = e9.map((v,i)=> i<20?0: v>e21[i]?1:-1);
  return {closeTimes:ct, trends};
}
function htfTrend(htf, barTime) {
  const ct = htf.closeTimes;
  let lo=0, hi=ct.length-1, idx=-1;
  while(lo<=hi){const mid=(lo+hi)>>1;if(ct[mid]<=barTime){idx=mid;lo=mid+1;}else hi=mid-1;}
  return idx < 20 ? 0 : htf.trends[idx];
}

// ─── DIVERGENCE SIGNAL GENERATOR (F1 from apex-final) ───
function genDivSignals(kl5m, htfData) {
  const closes = kl5m.map(k=>parseFloat(k[4])), lows = kl5m.map(k=>parseFloat(k[3]));
  const highs = kl5m.map(k=>parseFloat(k[2])), vols = kl5m.map(k=>parseFloat(k[5]));
  const r = rsi(closes), m = macd(closes), va = volSma(vols);
  const signals = [];
  for (let i = LOOKBACK + 14; i < closes.length - 2; i++) {
    const barTime = parseInt(kl5m[i][6]);
    // ─ Bull divergence: 2 swing lows (3-bar pivot), price LL + RSI HL ─
    let swingLows = [];
    for (let j = i - LOOKBACK; j <= i; j++) {
      if (j >= 3 && lows[j-1] < lows[j-2] && lows[j-1] < lows[j-3] && lows[j-1] < lows[j] && lows[j-1] < (j>=4?lows[j-4]:Infinity))
        swingLows.push(j-1);
    }
    if (swingLows.length >= 2) {
      const s1 = swingLows[swingLows.length-2], s2 = swingLows[swingLows.length-1];
      if (lows[s2] < lows[s1] && r[s2] > r[s1] && r[s2] < RSI_ZONE + 10 && r[s1] < RSI_ZONE) {
        // Confirmation: next candle bullish + volume
        if (closes[i] > closes[i-1] && vols[i] > (va[i]||1)*0.8) {
          const trend = htfTrend(htfData, barTime);
          if (trend === 1) {
            let score = 5; // base
            if (r[i] < RSI_ZONE) score += 2;
            if (vols[i] > (va[i]||1)*1.5) score += 1;
            score += 3; // HTF aligned
            if (m.hist[i] > m.hist[i-1]) score += 1;
            signals.push({bar:i, dir:1, sl:SL, tp:TP, score, _seq:signals.length, time:barTime});
          }
        }
      }
    }
    // ─ Bear divergence ─
    let swingHighs = [];
    for (let j = i - LOOKBACK; j <= i; j++) {
      if (j >= 3 && highs[j-1] > highs[j-2] && highs[j-1] > highs[j-3] && highs[j-1] > highs[j] && highs[j-1] > (j>=4?highs[j-4]:-Infinity))
        swingHighs.push(j-1);
    }
    if (swingHighs.length >= 2) {
      const s1 = swingHighs[swingHighs.length-2], s2 = swingHighs[swingHighs.length-1];
      if (highs[s2] > highs[s1] && r[s2] < r[s1] && r[s2] > (100-RSI_ZONE-10) && r[s1] > (100-RSI_ZONE)) {
        if (closes[i] < closes[i-1] && vols[i] > (va[i]||1)*0.8) {
          const trend = htfTrend(htfData, barTime);
          if (trend === -1) {
            let score = 5;
            if (r[i] > (100-RSI_ZONE)) score += 2;
            if (vols[i] > (va[i]||1)*1.5) score += 1;
            score += 3;
            if (m.hist[i] < m.hist[i-1]) score += 1;
            signals.push({bar:i, dir:-1, sl:SL, tp:TP, score, _seq:signals.length, time:barTime});
          }
        }
      }
    }
  }
  return signals;
}

// ─── MULTI-PAIR SIMULTANEOUS ENGINE ───
function runMultiPairEngine(pairData, maxPos, maxSameDir, scoreSizing=false) {
  let capital = INIT_CAP, peakCap = INIT_CAP, maxDD = 0, minCap = INIT_CAP;
  const positions = []; // {pair, dir, entry, sl, tp, qty, cost, entryBar, day, score}
  const trades = [], rejections = {max_pos:0, max_dir:0, fill:0, margin:0, daily:0, min_notional:0};
  let totalSignals = 0;
  const dailyPnl = {}, paused = {};
  const weeklyPnl = {}; // week# -> pnl
  const scoreStats = {}; // score -> {wins, losses, grossW, grossL}
  const getDay = t => new Date(t).toISOString().slice(0,10);
  const getWeek = t => { const d = new Date(t); const jan1 = new Date(d.getFullYear(),0,1); return Math.ceil(((d-jan1)/86400000+jan1.getDay()+1)/7); };

  // Merge all 5m bars across pairs into a unified timeline
  const allBarTimes = new Set();
  for (const p of PAIRS) {
    if (!pairData[p]) continue;
    for (const k of pairData[p].oos5m) allBarTimes.add(parseInt(k[0]));
  }
  const sortedTimes = [...allBarTimes].sort((a,b)=>a-b);

  // Build bar index per pair: time -> index
  const barIdx = {};
  for (const p of PAIRS) {
    if (!pairData[p]) continue;
    barIdx[p] = {};
    pairData[p].oos5m.forEach((k,i) => barIdx[p][parseInt(k[0])] = i);
  }

  // Pre-generate all signals per pair, store with bar time
  const signalsByTime = {}; // time -> [{pair, signal}]
  for (const p of PAIRS) {
    if (!pairData[p]) continue;
    const sigs = pairData[p].oosSignals;
    for (const sig of sigs) {
      const entryBarIdx = sig.bar + 2;
      if (entryBarIdx >= pairData[p].oos5m.length) continue;
      const entryTime = parseInt(pairData[p].oos5m[entryBarIdx][0]);
      if (!signalsByTime[entryTime]) signalsByTime[entryTime] = [];
      signalsByTime[entryTime].push({pair:p, sig, entryBarIdx});
    }
  }

  // Iterate bar-by-bar through unified timeline
  for (const t of sortedTimes) {
    const day = getDay(t);

    // 1. Update open positions — check SL/TP/timeout
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const pos = positions[pi];
      const kl = pairData[pos.pair].oos5m;
      const idx = barIdx[pos.pair][t];
      if (idx === undefined) continue;
      if (idx <= pos.entryBar) continue;
      const barsHeld = idx - pos.entryBar;
      const h = parseFloat(kl[idx][2]), l = parseFloat(kl[idx][3]), c = parseFloat(kl[idx][4]);
      let hitSL = pos.dir === 1 ? l <= pos.sl : h >= pos.sl;
      let hitTP = pos.dir === 1 ? h >= pos.tp : l <= pos.tp;
      if (hitSL && hitTP) hitTP = false;
      let exitP, feeType, tradeType;
      if (hitSL) {
        exitP = pos.dir === 1 ? pos.sl*(1-SLIP_SL) : pos.sl*(1+SLIP_SL);
        feeType = FEE_TAKER; tradeType = 'SL';
      } else if (hitTP) {
        exitP = pos.dir === 1 ? pos.tp : pos.tp;
        feeType = FEE_MAKER; tradeType = 'TP';
      } else if (barsHeld >= TIMEOUT_BARS) {
        exitP = c; feeType = FEE_TAKER; tradeType = 'TO';
      } else continue;

      const posSize = pos.qty * pos.entry;
      const pnl = pos.dir === 1 ? (exitP - pos.entry)*pos.qty : (pos.entry - exitP)*pos.qty;
      const net = pnl - pos.cost - posSize * feeType;
      capital += net;
      if (capital > peakCap) peakCap = capital;
      const dd = (peakCap - capital) / peakCap * 100;
      if (dd > maxDD) maxDD = dd;
      if (capital < minCap) minCap = capital;
      dailyPnl[day] = (dailyPnl[day]||0) + net;
      if (dailyPnl[day] <= -INIT_CAP * DAILY_LOSS_PCT) paused[day] = true;
      const wk = getWeek(t);
      weeklyPnl[wk] = (weeklyPnl[wk]||0) + net;
      // Score stats
      const sc = pos.score || 5;
      if (!scoreStats[sc]) scoreStats[sc] = {wins:0,losses:0,grossW:0,grossL:0,trades:0};
      scoreStats[sc].trades++;
      if (net > 0) { scoreStats[sc].wins++; scoreStats[sc].grossW += net; }
      else { scoreStats[sc].losses++; scoreStats[sc].grossL += Math.abs(net); }
      trades.push({pair:pos.pair, dir:pos.dir, entry:pos.entry, exit:exitP, pnl:net, type:tradeType, score:sc});
      positions.splice(pi, 1);
    }

    // 2. Process new signals at this bar time (priority order: PAIRS array)
    const sigs = signalsByTime[t];
    if (!sigs) continue;
    // Sort by pair priority
    sigs.sort((a,b) => PAIRS.indexOf(a.pair) - PAIRS.indexOf(b.pair));

    for (const {pair, sig, entryBarIdx} of sigs) {
      totalSignals++;
      if (paused[day]) { rejections.daily++; continue; }

      // Fill rate: 80% deterministic
      if (sig._seq % 5 === 4) { rejections.fill++; continue; }

      // Max positions
      if (positions.length >= maxPos) { rejections.max_pos++; continue; }
      const sameDir = positions.filter(p => p.dir === sig.dir).length;
      if (sameDir >= maxSameDir) { rejections.max_dir++; continue; }

      // Margin check
      const posSize = Math.min(INIT_CAP, capital * LEV);
      if (posSize < 100) { rejections.margin++; continue; }
      if (capital <= 0) { rejections.margin++; continue; }

      const entryPrice = parseFloat(pairData[pair].oos5m[entryBarIdx][1]); // OPEN
      // Score-based sizing
      let sizeMult = 1.0;
      if (scoreSizing) {
        const sc = sig.score || 5;
        if (sc <= 6) sizeMult = 0.8;
        else if (sc === 7) sizeMult = 1.0;
        else sizeMult = 1.3;
      }
      const adjPosSize = posSize * sizeMult;
      const qty = adjPosSize / entryPrice;
      const entryCost = adjPosSize * FEE_MAKER;
      const slPrice = sig.dir === 1 ? entryPrice*(1-SL) : entryPrice*(1+SL);
      const tpPrice = sig.dir === 1 ? entryPrice*(1+TP) : entryPrice*(1-TP);

      positions.push({pair, dir:sig.dir, entry:entryPrice, sl:slPrice, tp:tpPrice, qty, cost:entryCost,
        entryBar:entryBarIdx, day, score:sig.score||5});
    }
  }

  // Close any remaining open positions at last available price
  for (const pos of positions) {
    const kl = pairData[pos.pair].oos5m;
    const c = parseFloat(kl[kl.length-1][4]);
    const posSize = pos.qty * pos.entry;
    const pnl = pos.dir === 1 ? (c-pos.entry)*pos.qty : (pos.entry-c)*pos.qty;
    const net = pnl - pos.cost - posSize * FEE_TAKER;
    capital += net;
    trades.push({pair:pos.pair, dir:pos.dir, entry:pos.entry, exit:c, pnl:net, type:'EO', score:pos.score||5});
  }

  return {trades, capital, maxDD, minCap, rejections, totalSignals, weeklyPnl, scoreStats};
}

// ─── STATS ───
function stats(trades) {
  if (!trades.length) return {pf:0,wr:0,pnl:0,count:0};
  const wins = trades.filter(t=>t.pnl>0), losses = trades.filter(t=>t.pnl<=0);
  const gW = wins.reduce((a,t)=>a+t.pnl,0), gL = Math.abs(losses.reduce((a,t)=>a+t.pnl,0));
  return {pf:gL?gW/gL:gW?99:0, wr:wins.length/trades.length*100, pnl:trades.reduce((a,t)=>a+t.pnl,0), count:trades.length};
}

// ─── COMPOUND GROWTH ───
function compoundGrowth(weeklyPnlMap, reinvestPct=0.65) {
  const weeks = Object.keys(weeklyPnlMap).sort((a,b)=>a-b);
  let capital = INIT_CAP, cumPnl = 0;
  const rows = [];
  for (let i = 0; i < weeks.length; i++) {
    const wPnl = weeklyPnlMap[weeks[i]];
    const reinvest = wPnl > 0 ? wPnl * reinvestPct : 0;
    cumPnl += wPnl;
    capital += reinvest;
    rows.push({week:i+1, capital:capital.toFixed(0), pnlWeek:wPnl.toFixed(2), pnlCumul:cumPnl.toFixed(2)});
  }
  return {rows, finalCapital: capital, cumPnl};
}

// ─── MAIN ───
async function main() {
  console.log('MULTI-PAR SIMULTANEOUS BACKTEST — Compound Growth');
  console.log('='.repeat(60));
  console.log(`Pairs: ${PAIRS.join(', ')} (priority order)`);
  console.log(`Config: RSI(14) div, lb=${LOOKBACK}, rsiZone=${RSI_ZONE}, SL=${SL*100}%, TP=${TP*100}%`);
  console.log(`Capital: $${INIT_CAP}, Leverage: ${LEV}x, Fill: ${FILL_RATE*100}%\n`);

  // Download data
  console.log('Downloading data...');
  const pairData = {};
  for (const pair of PAIRS) {
    process.stdout.write(`  ${pair}... `);
    const [kl5m, kl1h] = await Promise.all([getKlines(pair,'5m',DAYS), getKlines(pair,'1h',DAYS)]);
    console.log(`5m:${kl5m.length} 1h:${kl1h.length}`);
    // Split IS/OOS
    const times5 = kl5m.map(k=>parseInt(k[0]));
    const minT = Math.min(...times5), splitT = minT + IS_DAYS * 86400000;
    const is5m = kl5m.filter(k=>parseInt(k[0])<splitT);
    const oos5m = kl5m.filter(k=>parseInt(k[0])>=splitT);
    const oos1h = kl1h.filter(k=>parseInt(k[0])>=splitT - 30*86400000); // include some warmup
    const htf = precomputeHTF(oos1h);
    // Generate OOS signals
    const oosSignals = genDivSignals(oos5m, htf);
    pairData[pair] = {kl5m, kl1h, is5m, oos5m, oos1h, htf, oosSignals};
    console.log(`    OOS signals: ${oosSignals.length}`);
  }

  // ─── 1. INDIVIDUAL PAIR RESULTS (theoretical sum) ───
  console.log('\n' + '='.repeat(60));
  console.log('INDIVIDUAL PAIR RESULTS (OOS d121-180, independent):');
  let indivSum = 0;
  for (const pair of PAIRS) {
    const pd = pairData[pair];
    // Run single-pair engine (no position conflicts)
    const result = runMultiPairEngine({[pair]:pd}, 3, 2);
    const s = stats(result.trades);
    indivSum += s.pnl;
    console.log(`  ${pair}: PF ${s.pf.toFixed(2)} | WR ${s.wr.toFixed(1)}% | $${s.pnl.toFixed(0)} | ${s.count} trades`);
  }
  console.log(`  Individual sum: $${indivSum.toFixed(0)} (theoretical)`);

  // ─── 2. MULTI-PAR SIMULTANEOUS ───
  console.log('\n' + '='.repeat(60));
  const r3 = runMultiPairEngine(pairData, 3, 2);
  const s3 = stats(r3.trades);
  const oosDays = 60;
  console.log('MULTI-PAR SIMULTANEOUS (OOS d121-180):');
  console.log(`  Individual sum: $${indivSum.toFixed(0)} (theoretical)`);
  console.log(`  Simultaneous:   $${s3.pnl.toFixed(0)} (actual with shared capital)`);
  console.log(`  Difference:     ${((s3.pnl/indivSum-1)*100).toFixed(1)}%`);
  console.log(`  PF: ${s3.pf.toFixed(2)} | WR: ${s3.wr.toFixed(1)}% | Trades: ${s3.count} | Trades/day: ${(s3.count/oosDays).toFixed(1)}`);
  console.log(`  Max DD: ${r3.maxDD.toFixed(1)}% | Capital min: $${r3.minCap.toFixed(0)}`);

  // ─── 3. REJECTION LOG ───
  console.log('\nREJECTION LOG:');
  const exec = r3.trades.length;
  const rej = r3.totalSignals - exec;
  console.log(`  Total signals: ${r3.totalSignals}`);
  console.log(`  Executed: ${exec} (${(exec/r3.totalSignals*100).toFixed(0)}%)`);
  const rj = r3.rejections;
  console.log(`  Rejected: ${rej} — max_pos:${rj.max_pos} max_dir:${rj.max_dir} fill:${rj.fill} margin:${rj.margin} daily:${rj.daily} min_notional:${rj.min_notional}`);

  // ─── 4. MAX POSITIONS TEST ───
  console.log('\nMAX POSITIONS TEST:');
  for (const mp of [3, 4, 5]) {
    const res = runMultiPairEngine(pairData, mp, 2);
    const st = stats(res.trades);
    console.log(`  maxPos=${mp}: PnL $${st.pnl.toFixed(0)}, PF ${st.pf.toFixed(2)}, WR ${st.wr.toFixed(1)}%, DD ${res.maxDD.toFixed(1)}%, Trades ${st.count}`);
  }

  // ─── 5. SCORE DISTRIBUTION ───
  console.log('\nSCORE DISTRIBUTION:');
  console.log('  Score | Trades | WR%   | PF    | PnL');
  const scores = Object.keys(r3.scoreStats).sort((a,b)=>a-b);
  for (const sc of scores) {
    const ss = r3.scoreStats[sc];
    const wr = ss.trades ? (ss.wins/ss.trades*100) : 0;
    const pf = ss.grossL ? (ss.grossW/ss.grossL) : (ss.grossW?99:0);
    const pnl = ss.grossW - ss.grossL;
    console.log(`  ${sc.toString().padStart(5)} | ${ss.trades.toString().padStart(6)} | ${wr.toFixed(1).padStart(5)} | ${pf.toFixed(2).padStart(5)} | $${pnl.toFixed(0)}`);
  }

  // ─── 6. SCORE-BASED SIZING ───
  console.log('\nSCORE SIZING:');
  const rFixed = runMultiPairEngine(pairData, 3, 2, false);
  const rVar = runMultiPairEngine(pairData, 3, 2, true);
  const sFixed = stats(rFixed.trades), sVar = stats(rVar.trades);
  console.log(`  Fixed:    PnL $${sFixed.pnl.toFixed(0)}, PF ${sFixed.pf.toFixed(2)}`);
  console.log(`  Variable: PnL $${sVar.pnl.toFixed(0)}, PF ${sVar.pf.toFixed(2)} (${((sVar.pnl/sFixed.pnl-1)*100).toFixed(1)}%)`);

  // ─── 7. COMPOUND GROWTH ───
  // Use best config result
  const bestResult = r3;
  const compound = compoundGrowth(bestResult.weeklyPnl, 0.65);
  console.log('\nCOMPOUND (65% weekly reinvestment):');
  console.log('  Week | Capital  | PnL_week  | PnL_cumul');
  for (const row of compound.rows) {
    console.log(`  ${row.week.toString().padStart(4)} | $${row.capital.padStart(7)} | $${row.pnlWeek.padStart(8)} | $${row.pnlCumul.padStart(8)}`);
  }

  // ─── FINAL SUMMARY ───
  const linearPnl = s3.pnl;
  const compoundPnl = compound.cumPnl;
  console.log('\n' + '='.repeat(60));
  console.log('FINAL:');
  console.log(`  Linear PnL (60d OOS):    $${linearPnl.toFixed(0)}`);
  console.log(`  Compound PnL (65% wkly): $${compoundPnl.toFixed(0)}`);
  console.log(`  Projected 120d linear:   $${(linearPnl*2).toFixed(0)}`);
  console.log(`  Projected 120d compound: $${(compound.finalCapital * (compoundPnl/INIT_CAP + 1)).toFixed(0)} (est)`);
  console.log('='.repeat(60));
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
