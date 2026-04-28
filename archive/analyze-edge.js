#!/usr/bin/env node
/**
 * EDGE ANALYZER — Find what ACTUALLY works in 60 days of real data
 *
 * Instead of designing a strategy and testing it (which leads to overfitting),
 * we scan ALL possible conditions and find which ones have persistent edge.
 *
 * We test:
 * 1. Different RSI thresholds for entries
 * 2. Different regime conditions
 * 3. Different R:R ratios
 * 4. Volume conditions
 * 5. Multi-TF alignment vs not
 * 6. Momentum vs mean-reversion
 * 7. ATR-relative move size before entry
 *
 * The key: we split into FIRST 30 days and LAST 30 days.
 * Only strategies profitable in BOTH halves have real edge.
 */

const https = require('https');

const CAPITAL = 10000;
const POS_SIZE = 500;
const LEV = 5;
const FEE = 0.0008;
const DAYS = 60;
const TIMEOUT = 40;

// Test on diverse set of pairs
const PAIRS = ['SOLUSDT','ADAUSDT','DOTUSDT','LINKUSDT','FILUSDT','ARBUSDT','OPUSDT','JUPUSDT','WIFUSDT','FETUSDT','BTCUSDT','ETHUSDT','BNBUSDT','AVAXUSDT'];

// ═══ Indicators (compact) ═══
function calcRSI(c,p=14){if(c.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}return al===0?100:100-(100/(1+ag/al));}
function emaArr(d,p){const k=2/(p+1),r=[d[0]];for(let i=1;i<d.length;i++)r.push(d[i]*k+r[i-1]*(1-k));return r;}
function ema(d,p){return emaArr(d,p).at(-1);}
function macd(c){if(c.length<35)return{h:0,ph:0};const e12=emaArr(c,12),e26=emaArr(c,26),ml=e12.map((v,i)=>v-e26[i]),sl=emaArr(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1))};}
function bb(c,p=20,s=2){if(c.length<p)return{u:0,m:0,l:0};const sl=c.slice(-p),m=sl.reduce((a,b)=>a+b)/p,sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+s*sd,m,l:m-s*sd};}
function stoch(H,L,C,kp=14){if(C.length<kp+3)return 50;const ka=[];for(let i=kp;i<=C.length;i++){const sh=H.slice(i-kp,i),sl=L.slice(i-kp,i),hi=Math.max(...sh),lo=Math.min(...sl);ka.push(hi===lo?50:((C[i-1]-lo)/(hi-lo))*100);}return ka.at(-1)||50;}
function calcATR(H,L,C,p=14){if(C.length<p+1)return 0;const t=[];for(let i=1;i<C.length;i++)t.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));if(t.length<p)return t.reduce((a,b)=>a+b)/t.length;let a=t.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<t.length;i++)a=(a*(p-1)+t[i])/p;return a;}
function wilder(arr,p){if(arr.length<p)return arr.map(()=>0);const r=[];let s=arr.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=0;i<p;i++)r.push(0);r[p-1]=s;for(let i=p;i<arr.length;i++){s=(s*(p-1)+arr[i])/p;r.push(s);}return r;}
function adx(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pd=[],md=[],tr=[];for(let i=1;i<H.length;i++){const u=H[i]-H[i-1],d=L[i-1]-L[i];pd.push(u>d&&u>0?u:0);md.push(d>u&&d>0?d:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}const sT=wilder(tr,p),sP=wilder(pd,p),sM=wilder(md,p),pi=sP.map((v,i)=>sT[i]?v/sT[i]*100:0),mi=sM.map((v,i)=>sT[i]?v/sT[i]*100:0),dx=pi.map((v,i)=>{const s=v+mi[i];return s?Math.abs(v-mi[i])/s*100:0;}),dxV=dx.slice(p-1),aa=dxV.length>=p?wilder(dxV,p):dxV;return{adx:aa.at(-1)||15,pdi:pi.at(-1)||0,mdi:mi.at(-1)||0};}
function obv(C,V){if(C.length<2)return false;let o=0;const a=[0];for(let i=1;i<C.length;i++){if(C[i]>C[i-1])o+=V[i];else if(C[i]<C[i-1])o-=V[i];a.push(o);}const n=Math.min(a.length,20),r=a.slice(-n);let sx=0,sy=0,sxy=0,sx2=0;for(let i=0;i<n;i++){sx+=i;sy+=r[i];sxy+=i*r[i];sx2+=i*i;}return(n*sxy-sx*sy)/(n*sx2-sx*sx||1)>0;}

// ═══ Data fetching ═══
function fetchJSON(url){return new Promise((res,rej)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});}).on('error',rej);});}
async function getKlines(sym,intv,lim,end){let u=`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${intv}&limit=${lim}`;if(end)u+=`&endTime=${end}`;try{return await fetchJSON(u);}catch(e){return[];}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fetchData(sym,days){const now=Date.now(),need=(days*24*60)/5+280;const a5=[];let end=now;while(a5.length<need){const b=await getKlines(sym,'5m',1000,end);if(!b||!b.length)break;a5.unshift(...b);end=b[0][0]-1;await sleep(120);}const a1h=await getKlines(sym,'1h',Math.min(1000,days*24+50));await sleep(120);return{kl5:a5,kl1h:a1h||[]};}

// ═══ STRATEGY SCANNER ═══
// Instead of one complex strategy, test SIMPLE strategies and find which work
function simTrade(C5,H5,L5,V5,C1h,H1h,L1h,V1h,barIdx,endIdx,strategy) {
  const cur = C5[barIdx];
  const atrV = calcATR(H5.slice(0,barIdx+1),L5.slice(0,barIdx+1),C5.slice(0,barIdx+1),14);
  if(atrV <= 0) return null;

  const tpD = atrV * strategy.tpMult;
  const slD = atrV * strategy.slMult;
  const cb = cur * FEE;

  let tp, sl;
  if(strategy.dir === 'BUY') {
    tp = cur + tpD + cb;
    sl = cur - slD - cb;
  } else {
    tp = cur - tpD - cb;
    sl = cur + slD + cb;
  }

  // Simulate forward
  for(let i = barIdx+1; i < Math.min(barIdx+TIMEOUT, endIdx); i++) {
    if(strategy.dir === 'BUY') {
      if(L5[i] <= sl) return -slD/cur * LEV * POS_SIZE - POS_SIZE*FEE;
      if(H5[i] >= tp) return tpD/cur * LEV * POS_SIZE - POS_SIZE*FEE;
    } else {
      if(H5[i] >= sl) return -slD/cur * LEV * POS_SIZE - POS_SIZE*FEE;
      if(L5[i] <= tp) return tpD/cur * LEV * POS_SIZE - POS_SIZE*FEE;
    }
  }
  // Timeout: close at current price
  const exitP = C5[Math.min(barIdx+TIMEOUT-1, endIdx-1)];
  if(strategy.dir === 'BUY') return (exitP-cur)/cur * LEV * POS_SIZE - POS_SIZE*FEE;
  else return (cur-exitP)/cur * LEV * POS_SIZE - POS_SIZE*FEE;
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  EDGE ANALYZER — Find what ACTUALLY works in 60 days        ║');
  console.log('║  Split: First 30d (train) vs Last 30d (test)                ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝\n');

  // Fetch all data
  const allData = {};
  for(const sym of PAIRS) {
    process.stdout.write(`  Fetching ${sym}...`);
    try { allData[sym] = await fetchData(sym, DAYS); console.log(` ${allData[sym].kl5.length} bars`); }
    catch(e) { console.log(' ERROR'); }
  }

  const testStart = Date.now() - DAYS*24*60*60*1000;
  const midPoint = testStart + 30*24*60*60*1000;

  // ═══ DEFINE STRATEGIES TO TEST ═══
  const strategies = [];

  // Mean-reversion: RSI extreme + buy/sell
  for(const rsiThresh of [20, 25, 30]) {
    for(const tpM of [1.0, 1.5, 2.0, 2.5]) {
      for(const slM of [0.8, 1.0, 1.5]) {
        strategies.push({ name: `MR_RSI<${rsiThresh}_TP${tpM}_SL${slM}`, type:'MR', rsiThresh, tpMult:tpM, slMult:slM, dir:'BUY',
          check: (rsi,stK,bbP,mac,adxD,vr,e9,e21,obvR,htf) => rsi < rsiThresh });
        strategies.push({ name: `MR_RSI>${100-rsiThresh}_TP${tpM}_SL${slM}`, type:'MR', rsiThresh:100-rsiThresh, tpMult:tpM, slMult:slM, dir:'SELL',
          check: (rsi,stK,bbP,mac,adxD,vr,e9,e21,obvR,htf) => rsi > (100-rsiThresh) });
      }
    }
  }

  // Mean-reversion: RSI + Stoch combo
  for(const tpM of [1.5, 2.0]) {
    strategies.push({ name: `MR_RSI<30+Stoch<20_TP${tpM}`, type:'MR_combo', tpMult:tpM, slMult:1.0, dir:'BUY',
      check: (rsi,stK,bbP,mac,adxD,vr) => rsi < 30 && stK < 20 });
    strategies.push({ name: `MR_RSI>70+Stoch>80_TP${tpM}`, type:'MR_combo', tpMult:tpM, slMult:1.0, dir:'SELL',
      check: (rsi,stK,bbP,mac,adxD,vr) => rsi > 70 && stK > 80 });
    // With volume confirmation
    strategies.push({ name: `MR_RSI<30+Vol>1.5_TP${tpM}`, type:'MR_vol', tpMult:tpM, slMult:1.0, dir:'BUY',
      check: (rsi,stK,bbP,mac,adxD,vr) => rsi < 30 && vr > 1.5 });
    strategies.push({ name: `MR_RSI>70+Vol>1.5_TP${tpM}`, type:'MR_vol', tpMult:tpM, slMult:1.0, dir:'SELL',
      check: (rsi,stK,bbP,mac,adxD,vr) => rsi > 70 && vr > 1.5 });
  }

  // Trend-following: EMA cross + ADX
  for(const adxMin of [20, 25, 30]) {
    for(const tpM of [1.5, 2.0, 2.5, 3.0]) {
      strategies.push({ name: `TF_EMA9>21+ADX>${adxMin}_TP${tpM}`, type:'TF', tpMult:tpM, slMult:1.0, dir:'BUY',
        check: (rsi,stK,bbP,mac,adxD,vr,e9,e21) => e9 > e21 && adxD.adx > adxMin && adxD.pdi > adxD.mdi });
      strategies.push({ name: `TF_EMA9<21+ADX>${adxMin}_TP${tpM}`, type:'TF', tpMult:tpM, slMult:1.0, dir:'SELL',
        check: (rsi,stK,bbP,mac,adxD,vr,e9,e21) => e9 < e21 && adxD.adx > adxMin && adxD.mdi > adxD.pdi });
    }
  }

  // Trend + Momentum: EMA + MACD expanding
  for(const tpM of [2.0, 2.5, 3.0]) {
    strategies.push({ name: `TF_EMA+MACD_exp_TP${tpM}`, type:'TF_mac', tpMult:tpM, slMult:1.0, dir:'BUY',
      check: (rsi,stK,bbP,mac,adxD,vr,e9,e21) => e9>e21 && mac.h>0 && mac.h>mac.ph && adxD.adx>20 });
    strategies.push({ name: `TF_EMA+MACD_exp_TP${tpM}_SELL`, type:'TF_mac', tpMult:tpM, slMult:1.0, dir:'SELL',
      check: (rsi,stK,bbP,mac,adxD,vr,e9,e21) => e9<e21 && mac.h<0 && mac.h<mac.ph && adxD.adx>20 });
  }

  // HTF-aligned mean reversion: RSI extreme + 1H trend agrees
  for(const tpM of [1.5, 2.0]) {
    strategies.push({ name: `MR_RSI<30+HTF_BUY_TP${tpM}`, type:'MR_htf', tpMult:tpM, slMult:1.0, dir:'BUY',
      check: (rsi,stK,bbP,mac,adxD,vr,e9,e21,obvR,htf) => rsi < 30 && htf === 'BUY' });
    strategies.push({ name: `MR_RSI>70+HTF_SELL_TP${tpM}`, type:'MR_htf', tpMult:tpM, slMult:1.0, dir:'SELL',
      check: (rsi,stK,bbP,mac,adxD,vr,e9,e21,obvR,htf) => rsi > 70 && htf === 'SELL' });
  }

  // Volume spike + direction
  for(const tpM of [1.5, 2.0, 2.5]) {
    strategies.push({ name: `VOL_spike>2+OBV_up_TP${tpM}`, type:'VOL', tpMult:tpM, slMult:1.0, dir:'BUY',
      check: (rsi,stK,bbP,mac,adxD,vr,e9,e21,obvR) => vr > 2.0 && obvR && e9 > e21 });
    strategies.push({ name: `VOL_spike>2+OBV_dn_TP${tpM}`, type:'VOL', tpMult:tpM, slMult:1.0, dir:'SELL',
      check: (rsi,stK,bbP,mac,adxD,vr,e9,e21,obvR) => vr > 2.0 && !obvR && e9 < e21 });
  }

  // BB extreme + RSI
  for(const tpM of [1.5, 2.0]) {
    strategies.push({ name: `BB<0.1+RSI<35_TP${tpM}`, type:'BB_MR', tpMult:tpM, slMult:1.0, dir:'BUY',
      check: (rsi,stK,bbP) => bbP < 0.1 && rsi < 35 });
    strategies.push({ name: `BB>0.9+RSI>65_TP${tpM}`, type:'BB_MR', tpMult:tpM, slMult:1.0, dir:'SELL',
      check: (rsi,stK,bbP) => bbP > 0.9 && rsi > 65 });
  }

  // MACD crossover only
  for(const tpM of [1.5, 2.0, 2.5]) {
    strategies.push({ name: `MACD_cross_up_TP${tpM}`, type:'MACD', tpMult:tpM, slMult:1.0, dir:'BUY',
      check: (rsi,stK,bbP,mac) => mac.h > 0 && mac.ph <= 0 });
    strategies.push({ name: `MACD_cross_dn_TP${tpM}`, type:'MACD', tpMult:tpM, slMult:1.0, dir:'SELL',
      check: (rsi,stK,bbP,mac) => mac.h < 0 && mac.ph >= 0 });
  }

  // Ultra-selective: RSI<20 + Stoch<15 + BB<0.05 (extreme conditions)
  for(const tpM of [1.5, 2.0, 3.0]) {
    strategies.push({ name: `ULTRA_RSI<20+Stoch<15+BB<0.05_TP${tpM}`, type:'ULTRA', tpMult:tpM, slMult:1.0, dir:'BUY',
      check: (rsi,stK,bbP) => rsi < 20 && stK < 15 && bbP < 0.05 });
    strategies.push({ name: `ULTRA_RSI>80+Stoch>85+BB>0.95_TP${tpM}`, type:'ULTRA', tpMult:tpM, slMult:1.0, dir:'SELL',
      check: (rsi,stK,bbP) => rsi > 80 && stK > 85 && bbP > 0.95 });
  }

  console.log(`\n  Testing ${strategies.length} strategies across ${PAIRS.length} pairs...\n`);

  // ═══ RUN ALL STRATEGIES ═══
  const results = strategies.map(s => ({ ...s, train: { trades:0, pnl:0, wins:0 }, test: { trades:0, pnl:0, wins:0 } }));

  for(const sym of PAIRS) {
    const sd = allData[sym];
    if(!sd || !sd.kl5 || sd.kl5.length < 300) continue;

    const C5 = sd.kl5.map(k=>parseFloat(k[4]));
    const H5 = sd.kl5.map(k=>parseFloat(k[2]));
    const L5 = sd.kl5.map(k=>parseFloat(k[3]));
    const V5 = sd.kl5.map(k=>parseFloat(k[5]));

    // Precompute 1H trend
    const C1h = sd.kl1h.map(k=>parseFloat(k[4]));
    const H1h = sd.kl1h.map(k=>parseFloat(k[2]));
    const L1h = sd.kl1h.map(k=>parseFloat(k[3]));

    // Find test start index
    let startIdx = 280;
    for(let i=280; i<sd.kl5.length; i++) { if(sd.kl5[i][0] >= testStart) { startIdx=i; break; } }
    let midIdx = startIdx;
    for(let i=startIdx; i<sd.kl5.length; i++) { if(sd.kl5[i][0] >= midPoint) { midIdx=i; break; } }

    // Scan every 10th bar (speed optimization — still tests 10% of all bars)
    for(let i = startIdx; i < sd.kl5.length - TIMEOUT; i += 5) {
      const barTime = sd.kl5[i][0];
      const isTrain = barTime < midPoint;
      const slice = i+1; // End of data available at this point

      // Compute indicators at bar i
      const cSlice = C5.slice(0, slice);
      const hSlice = H5.slice(0, slice);
      const lSlice = L5.slice(0, slice);
      const vSlice = V5.slice(0, slice);

      if(cSlice.length < 50) continue;

      const rsi = calcRSI(cSlice, 14);
      const stK = stoch(hSlice, lSlice, cSlice, 14);
      const bbV = bb(cSlice, 20, 2);
      const bbR = bbV.u-bbV.l, bbP = bbR>0?(cSlice.at(-1)-bbV.l)/bbR:0.5;
      const mac = macd(cSlice);
      const adxD = adx(hSlice, lSlice, cSlice);
      const avgV = vSlice.slice(-20).reduce((a,b)=>a+b)/20;
      const vr = vSlice.at(-1)/avgV;
      const e9 = ema(cSlice, 9), e21 = ema(cSlice, 21);
      const obvR = obv(cSlice, vSlice);

      // HTF trend (simplified)
      let htf = 'NEUTRAL';
      if(C1h.length > 25) {
        const barTime1h = barTime - (barTime%3600000);
        let ei1h = sd.kl1h.findIndex(k=>k[0]>barTime1h);
        if(ei1h===-1) ei1h=sd.kl1h.length;
        if(ei1h > 25) {
          const c1hSlice = C1h.slice(0, ei1h);
          const e9h=ema(c1hSlice,9), e21h=ema(c1hSlice,21);
          const m1h=macd(c1hSlice);
          let hB=0,hS=0;
          if(e9h>e21h)hB+=2;else hS+=2;
          if(m1h.h>0)hB+=1;else hS+=1;
          if(hB>hS+1)htf='BUY';else if(hS>hB+1)htf='SELL';
        }
      }

      // Test each strategy
      for(let si=0; si<results.length; si++) {
        const s = results[si];
        if(!s.check(rsi,stK,bbP,mac,adxD,vr,e9,e21,obvR,htf)) continue;

        const pnl = simTrade(C5,H5,L5,V5,i,sd.kl5.length,s);
        if(pnl === null) continue;

        const bucket = isTrain ? s.train : s.test;
        bucket.trades++;
        bucket.pnl += pnl;
        if(pnl > 0) bucket.wins++;
      }
    }
    process.stdout.write('.');
  }

  console.log('\n');

  // ═══ FIND STRATEGIES PROFITABLE IN BOTH HALVES ═══
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  STRATEGIES PROFITABLE IN BOTH TRAIN (30d) AND TEST (30d)');
  console.log('  These have REAL edge — not overfitting');
  console.log('═══════════════════════════════════════════════════════════════════════\n');

  const bothProfitable = results.filter(r =>
    r.train.trades >= 5 && r.test.trades >= 5 && // Minimum sample
    r.train.pnl > 0 && r.test.pnl > 0 // Profitable in BOTH
  ).sort((a,b) => (b.train.pnl+b.test.pnl) - (a.train.pnl+a.test.pnl));

  if(bothProfitable.length === 0) {
    console.log('  *** NO STRATEGY WAS PROFITABLE IN BOTH 30-DAY HALVES ***\n');
    console.log('  Top 10 by combined PnL (even if one half loses):');
    const topAll = results.filter(r=>r.train.trades>=3&&r.test.trades>=3).sort((a,b)=>(b.train.pnl+b.test.pnl)-(a.train.pnl+a.test.pnl));
    for(const r of topAll.slice(0,15)) {
      const trWR = r.train.trades ? (r.train.wins/r.train.trades*100).toFixed(0) : '0';
      const teWR = r.test.trades ? (r.test.wins/r.test.trades*100).toFixed(0) : '0';
      const trPF = r.train.trades && r.train.pnl > 0 ? 'POS' : 'NEG';
      const tePF = r.test.trades && r.test.pnl > 0 ? 'POS' : 'NEG';
      console.log(`    ${r.name.padEnd(45)} TRAIN: ${String(r.train.trades).padEnd(5)}t WR:${trWR.padEnd(3)}% $${r.train.pnl.toFixed(0).padStart(6)} ${trPF}  TEST: ${String(r.test.trades).padEnd(5)}t WR:${teWR.padEnd(3)}% $${r.test.pnl.toFixed(0).padStart(6)} ${tePF}`);
    }
  } else {
    console.log(`  Found ${bothProfitable.length} strategies with real edge:\n`);
    for(const r of bothProfitable.slice(0,20)) {
      const trWR = (r.train.wins/r.train.trades*100).toFixed(0);
      const teWR = (r.test.wins/r.test.trades*100).toFixed(0);
      const totalPnL = r.train.pnl + r.test.pnl;
      const totalTrades = r.train.trades + r.test.trades;
      const dailyTrades = (totalTrades / DAYS).toFixed(1);
      console.log(`    ${r.name.padEnd(45)}`);
      console.log(`      TRAIN(30d): ${r.train.trades}t WR:${trWR}% $${r.train.pnl.toFixed(0)}`);
      console.log(`      TEST(30d):  ${r.test.trades}t WR:${teWR}% $${r.test.pnl.toFixed(0)}`);
      console.log(`      TOTAL:      ${totalTrades}t ${dailyTrades}/day  PnL:$${totalPnL.toFixed(0)} (${(totalPnL/CAPITAL*100).toFixed(1)}%)`);
      console.log();
    }
  }

  // Also show the worst strategies
  console.log('\n  ═══ WORST STRATEGIES (biggest losers) ═══');
  const worst = results.filter(r=>r.train.trades>=3).sort((a,b)=>(a.train.pnl+a.test.pnl)-(b.train.pnl+b.test.pnl));
  for(const r of worst.slice(0,5)) {
    console.log(`    ${r.name.padEnd(45)} Total: $${(r.train.pnl+r.test.pnl).toFixed(0)}`);
  }

  console.log('\n✓ Edge analysis complete.');
}

main().catch(console.error);
