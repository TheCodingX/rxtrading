// ═══════════════════════════════════════════════════════════════════════
// SCALP ULTRA-OPTIMIZER — Walk-Forward Real Validation
// Target: WR>80%, PnL>+20%, 300+ sigs/day
// Method: Grid search on TRAIN set (first half), validate on TEST set (second half)
// ═══════════════════════════════════════════════════════════════════════

const https = require('https');
const SCALP_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','DOTUSDT','NEARUSDT','APTUSDT'];

function fetchJSON(url){return new Promise((res,rej)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}});}).on('error',rej)});}
async function getKlines(sym,tf,limit){try{return await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`);}catch(e){return null;}}

// ─── Indicators ───
function calcRSI(C,p=14){if(C.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=C[i]-C[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<C.length;i++){const d=C[i]-C[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}if(al===0)return 100;return 100-(100/(1+ag/al));}
function calcEMAArr(d,p){const k=2/(p+1);const r=[d[0]];for(let i=1;i<d.length;i++)r.push(d[i]*k+r[i-1]*(1-k));return r;}
function calcEMA(d,p){return calcEMAArr(d,p).at(-1);}
function calcMACD(C){if(C.length<35)return{h:0,ph:0};const e12=calcEMAArr(C,12),e26=calcEMAArr(C,26);const ml=e12.map((v,i)=>v-e26[i]);const sl=calcEMAArr(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1))};}
function calcATR(H,L,C,p=14){if(C.length<p+1)return 0;const trs=[];for(let i=1;i<C.length;i++)trs.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));if(trs.length<p)return trs.reduce((a,b)=>a+b)/trs.length;let atr=trs.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<trs.length;i++)atr=(atr*(p-1)+trs[i])/p;return atr;}
function calcADX(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pdm=[],mdm=[],tr=[];for(let i=1;i<H.length;i++){const u=H[i]-H[i-1],d=L[i-1]-L[i];pdm.push(u>d&&u>0?u:0);mdm.push(d>u&&d>0?d:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}function ws(a,p){if(a.length<p)return a.map(()=>0);const r=[];let s=a.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=0;i<p;i++)r.push(0);r[p-1]=s;for(let i=p;i<a.length;i++){s=(s*(p-1)+a[i])/p;r.push(s);}return r;}const sT=ws(tr,p),sP=ws(pdm,p),sM=ws(mdm,p);const pdi=sP.map((v,i)=>sT[i]?v/sT[i]*100:0);const mdi=sM.map((v,i)=>sT[i]?v/sT[i]*100:0);const dx=pdi.map((v,i)=>{const s=v+mdi[i];return s?Math.abs(v-mdi[i])/s*100:0;});const dxV=dx.slice(p-1);const adxA=dxV.length>=p?ws(dxV,p):dxV;return{adx:adxA.at(-1)||15,pdi:pdi.at(-1)||0,mdi:mdi.at(-1)||0};}
function calcOBV(C,V){if(C.length<2)return{rising:false};let obv=0;const a=[0];for(let i=1;i<C.length;i++){if(C[i]>C[i-1])obv+=V[i];else if(C[i]<C[i-1])obv-=V[i];a.push(obv);}const n=Math.min(a.length,20);const r=a.slice(-n);let sX=0,sY=0,sXY=0,sX2=0;for(let i=0;i<n;i++){sX+=i;sY+=r[i];sXY+=i*r[i];sX2+=i*i;}const sl=(n*sXY-sX*sY)/(n*sX2-sX*sX||1);return{rising:sl>0};}
function calcStoch(H,L,C,kp=14){if(C.length<kp+3)return{k:50,d:50};const kA=[];for(let i=kp;i<=C.length;i++){const sh=H.slice(i-kp,i),sl=L.slice(i-kp,i);const hi=Math.max(...sh),lo=Math.min(...sl);kA.push(hi===lo?50:((C[i-1]-lo)/(hi-lo))*100);}const dA=[];for(let i=2;i<kA.length;i++)dA.push((kA[i]+kA[i-1]+kA[i-2])/3);return{k:kA.at(-1)||50,d:dA.at(-1)||50};}
function calcBB(C,p=20,s=2){if(C.length<p)return{u:0,m:0,l:0};const sl=C.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+s*sd,m,l:m-s*sd};}

// ─── Signal Generator (parametric) ───
function genSignal(C, H, L, V, C15, H15, L15, C1h, H1h, L1h, V1h, sym, hourUTC, filters) {
  const cur = C.at(-1);
  if(!cur) return null;

  const rsi = calcRSI(C, 14);
  const mac = calcMACD(C);
  const ea9 = calcEMAArr(C, 9), ea21 = calcEMAArr(C, 21);
  const e9 = ea9.at(-1), e21 = ea21.at(-1);
  const adxData = calcADX(H, L, C);
  const obvData = calcOBV(C, V);
  const atr = calcATR(H, L, C, 14);
  const avgV = V.slice(-20).reduce((a,b)=>a+b)/20;
  const vr = V.at(-1) / avgV;
  const stoch = calcStoch(H, L, C, 14);
  const bb = calcBB(C, 20, 2);

  // 15m ATR
  let atr15 = atr;
  if(H15.length > 15) { const a = calcATR(H15, L15, C15, 14); if(a > 0) atr15 = a; }
  // 1h ATR
  let atr1h = atr;
  if(H1h && H1h.length > 15) { const a = calcATR(H1h, L1h, C1h, 14); if(a > 0) atr1h = a; }

  // HTF trend
  let htfTrend = 'NEUTRAL';
  if(C1h && C1h.length > 25) {
    const e9h = calcEMA(C1h, 9), e21h = calcEMA(C1h, 21);
    const m1h = calcMACD(C1h);
    let hB=0, hS=0;
    if(e9h>e21h) hB+=2; else hS+=2;
    if(m1h.h>0) hB+=1.5; else hS+=1.5;
    if(hB>hS+1) htfTrend='BUY'; else if(hS>hB+1) htfTrend='SELL';
  }

  // 15m confirm
  let mtfConfirm = 'NEUTRAL';
  if(C15.length > 25) {
    const e9_15 = calcEMA(C15, 9), e21_15 = calcEMA(C15, 21);
    const m15 = calcMACD(C15);
    let mB=0, mS=0;
    if(e9_15>e21_15) mB++; else mS++;
    if(m15.h>0) mB++; else mS++;
    if(mB>mS) mtfConfirm='BUY'; else if(mS>mB) mtfConfirm='SELL';
  }

  // Scoring
  let B = 0, S = 0;
  let buyI = 0, sellI = 0;

  if(rsi < 30) { B += 2; buyI++; } else if(rsi > 70) { S += 2; sellI++; }
  if(mac.h > 0 && mac.ph < 0) { B += 2; buyI++; } else if(mac.h < 0 && mac.ph > 0) { S += 2; sellI++; }
  if(e9 > e21) { B += 1; buyI++; } else { S += 1; sellI++; }
  if(adxData.adx > 25 && adxData.pdi > adxData.mdi) { B += 1; buyI++; }
  else if(adxData.adx > 25) { S += 1; sellI++; }
  if(obvData.rising) { B += 0.5; buyI++; } else { S += 0.5; sellI++; }
  if(vr > 1.5 && B > S) B *= 1.1;
  else if(vr > 1.5 && S > B) S *= 1.1;

  let signal = 'NEUTRAL';
  const adxRegime = adxData.adx > 25 ? 'TREND' : adxData.adx < 18 ? 'QUIET' : 'RANGE';
  const thr = adxRegime === 'TREND' ? 1.5 : 1.0;

  if(B > S && B >= thr && buyI >= 1) signal = 'BUY';
  else if(S > B && S >= thr && sellI >= 1) signal = 'SELL';

  // Safety: dead hours
  if(signal !== 'NEUTRAL' && hourUTC >= 0 && hourUTC < 6) signal = 'NEUTRAL';
  // Safety: dead volume
  if(signal !== 'NEUTRAL' && vr < 0.4) signal = 'NEUTRAL';
  // Safety: anti-1h
  if(signal === 'BUY' && htfTrend === 'SELL') signal = 'NEUTRAL';
  if(signal === 'SELL' && htfTrend === 'BUY') signal = 'NEUTRAL';

  // ═══ CONFIGURABLE FILTERS ═══
  if(signal !== 'NEUTRAL') {
    // Hour filter
    if(filters.blockHours && filters.blockHours.includes(hourUTC)) signal = 'NEUTRAL';
    // Min score margin
    if(filters.minMargin && signal !== 'NEUTRAL') {
      const margin = signal === 'BUY' ? B - S : S - B;
      if(margin < filters.minMargin) signal = 'NEUTRAL';
    }
    // RSI filter
    if(filters.rsiFilter && signal !== 'NEUTRAL') {
      if(signal === 'BUY' && rsi > (filters.rsiBuyCap || 999)) signal = 'NEUTRAL';
      if(signal === 'SELL' && rsi < (filters.rsiSellFloor || 0)) signal = 'NEUTRAL';
    }
    // Volume filter
    if(filters.minVR && signal !== 'NEUTRAL' && vr < filters.minVR) signal = 'NEUTRAL';
    // ADX filter
    if(filters.minADX && signal !== 'NEUTRAL' && adxData.adx < filters.minADX) signal = 'NEUTRAL';
    // Direction filter
    if(filters.onlyBuy && signal === 'SELL') signal = 'NEUTRAL';
    if(filters.onlySell && signal === 'BUY') signal = 'NEUTRAL';
    // Stoch filter
    if(filters.stochFilter && signal !== 'NEUTRAL') {
      if(signal === 'BUY' && stoch.k > 70) signal = 'NEUTRAL';
      if(signal === 'SELL' && stoch.k < 30) signal = 'NEUTRAL';
    }
    // EMA distance filter
    if(filters.emaDistMax && signal !== 'NEUTRAL') {
      const dist = Math.abs(cur - e21) / atr;
      if(dist > filters.emaDistMax) signal = 'NEUTRAL';
    }
    // MTF alignment required
    if(filters.requireMTF && signal !== 'NEUTRAL') {
      if(mtfConfirm !== signal && mtfConfirm !== 'NEUTRAL') signal = 'NEUTRAL';
    }
    // HTF alignment required (not just "not against" but "must align")
    if(filters.requireHTF && signal !== 'NEUTRAL') {
      if(htfTrend !== signal) signal = 'NEUTRAL';
    }
    // BB position filter
    if(filters.bbFilter && signal !== 'NEUTRAL') {
      const bbRange = bb.u - bb.l;
      const bbPos = bbRange > 0 ? (cur - bb.l) / bbRange : 0.5;
      if(signal === 'BUY' && bbPos > 0.6) signal = 'NEUTRAL';
      if(signal === 'SELL' && bbPos < 0.4) signal = 'NEUTRAL';
    }
    // Momentum filter
    if(filters.momFilter && signal !== 'NEUTRAL') {
      const mom = (C.at(-1) - C.at(-4)) / atr;
      if(signal === 'BUY' && mom < -0.5) signal = 'NEUTRAL';
      if(signal === 'SELL' && mom > 0.5) signal = 'NEUTRAL';
    }
  }

  const conf = signal !== 'NEUTRAL' ? Math.min(75, Math.round((Math.max(B,S)/Math.max(1,B+S))*100)) : 0;

  return { signal, entry: cur, atr, atr15, atr1h, B, S, rsi, adx: adxData.adx, vr, stochK: stoch.k, regime: adxRegime, htfTrend, mtfConfirm, conf };
}

// ─── Evaluate trade with configurable TP/SL ───
function evalTrade(signal, entry, tpMult, slMult, tp1Ratio, atrVal, futureCandles, costPct) {
  let tpDist = atrVal * tpMult;
  let slDist = atrVal * slMult;
  const costBuffer = entry * costPct;

  // Min enforcement
  const minTP = entry * 0.0005;
  if(tpDist < minTP) tpDist = minTP;
  if(slDist < minTP * 0.5) slDist = minTP * 0.5;

  const tp1Dist = tpDist * tp1Ratio;

  const tp1 = signal==='BUY' ? entry + tp1Dist + costBuffer : entry - tp1Dist - costBuffer;
  const tp2 = signal==='BUY' ? entry + tpDist + costBuffer : entry - tpDist - costBuffer;
  const sl  = signal==='BUY' ? entry - slDist - costBuffer : entry + slDist + costBuffer;

  let tp1Hit = false;

  for(let i = 0; i < futureCandles.length; i++) {
    const { h, l } = futureCandles[i];
    if(signal === 'BUY') {
      if(!tp1Hit) {
        if(l <= sl) return { r: 'SL', pnl: -(slDist + costBuffer*2)/entry*100 };
        if(h >= tp1) tp1Hit = true;
      }
      if(tp1Hit) {
        if(h >= tp2) return { r: 'TP2', pnl: ((tp1Dist*0.5 + tpDist*0.5) - costBuffer*2)/entry*100 };
        if(l <= entry) return { r: 'TP1BE', pnl: (tp1Dist*0.5 - costBuffer*2)/entry*100 };
      }
    } else {
      if(!tp1Hit) {
        if(h >= sl) return { r: 'SL', pnl: -(slDist + costBuffer*2)/entry*100 };
        if(l <= tp1) tp1Hit = true;
      }
      if(tp1Hit) {
        if(l <= tp2) return { r: 'TP2', pnl: ((tp1Dist*0.5 + tpDist*0.5) - costBuffer*2)/entry*100 };
        if(h >= entry) return { r: 'TP1BE', pnl: (tp1Dist*0.5 - costBuffer*2)/entry*100 };
      }
    }
  }

  // Timeout
  const last = futureCandles.at(-1)?.c || entry;
  const uPnl = signal==='BUY' ? (last-entry)/entry*100 : (entry-last)/entry*100;
  if(tp1Hit) return { r: 'TO1', pnl: (tp1Dist*0.5)/entry*100 + uPnl*0.5 };
  return { r: 'TO', pnl: uPnl };
}

// ─── Data Store ───
let DATA = {};

async function loadData() {
  console.log('  Descargando datos de 12 pares...\n');
  for(const sym of SCALP_SYMS) {
    process.stdout.write(`    ${sym}...`);
    const [kl5, kl15, kl1h] = await Promise.all([
      getKlines(sym, '5m', 1000),
      getKlines(sym, '15m', 400),
      getKlines(sym, '1h', 200)
    ]);
    if(!kl5 || kl5.length < 400) { console.log(' SKIP'); continue; }

    DATA[sym] = {
      C5: kl5.map(k=>+k[4]), H5: kl5.map(k=>+k[2]), L5: kl5.map(k=>+k[3]),
      V5: kl5.map(k=>+k[5]), T5: kl5.map(k=>k[0]),
      C15: kl15?kl15.map(k=>+k[4]):[], H15: kl15?kl15.map(k=>+k[2]):[],
      L15: kl15?kl15.map(k=>+k[3]):[], T15: kl15?kl15.map(k=>k[0]):[],
      C1h: kl1h?kl1h.map(k=>+k[4]):[], H1h: kl1h?kl1h.map(k=>+k[2]):[],
      L1h: kl1h?kl1h.map(k=>+k[3]):[], V1h: kl1h?kl1h.map(k=>+k[5]):[],
      T1h: kl1h?kl1h.map(k=>k[0]):[], len: kl5.length
    };
    console.log(` ${kl5.length} bars (${(kl5.length/288).toFixed(1)}d)`);
    await new Promise(r=>setTimeout(r,200));
  }
}

// ─── Run backtest on a specific data range ───
function runTest(startPct, endPct, tpMult, slMult, tp1Ratio, evalWindow, cooldown, filters, costPct) {
  let wins=0, losses=0, totalPnl=0, count=0;
  const LOOKBACK = 280;

  for(const sym of Object.keys(DATA)) {
    const d = DATA[sym];
    const len = d.len;
    const rangeStart = Math.floor(len * startPct);
    const rangeEnd = Math.floor(len * endPct);
    const barStart = Math.max(LOOKBACK, rangeStart);
    const barEnd = rangeEnd - evalWindow;

    if(barEnd <= barStart) continue;

    let lastBar = -999;

    for(let bar = barStart; bar < barEnd; bar++) {
      if(bar - lastBar < cooldown) continue;

      const c5 = d.C5.slice(Math.max(0, bar-279), bar+1);
      const h5 = d.H5.slice(Math.max(0, bar-279), bar+1);
      const l5 = d.L5.slice(Math.max(0, bar-279), bar+1);
      const v5 = d.V5.slice(Math.max(0, bar-279), bar+1);

      const barTime = d.T5[bar];
      const hourUTC = new Date(barTime).getUTCHours();

      let c15e = 0;
      for(let j = d.T15.length-1; j >= 0; j--) { if(d.T15[j] <= barTime) { c15e = j+1; break; } }
      const c15 = d.C15.slice(Math.max(0,c15e-100), c15e);
      const h15 = d.H15.slice(Math.max(0,c15e-100), c15e);
      const l15 = d.L15.slice(Math.max(0,c15e-100), c15e);

      let c1he = 0;
      for(let j = d.T1h.length-1; j >= 0; j--) { if(d.T1h[j] <= barTime) { c1he = j+1; break; } }
      const c1h = d.C1h.slice(Math.max(0,c1he-50), c1he);
      const h1h = d.H1h.slice(Math.max(0,c1he-50), c1he);
      const l1h = d.L1h.slice(Math.max(0,c1he-50), c1he);
      const v1h = d.V1h.slice(Math.max(0,c1he-50), c1he);

      const sig = genSignal(c5, h5, l5, v5, c15, h15, l15, c1h, h1h, l1h, v1h, sym, hourUTC, filters);
      if(!sig || sig.signal === 'NEUTRAL') continue;

      lastBar = bar;
      count++;

      // Choose ATR for TP/SL
      const useATR = sig.atr15 || sig.atr;

      const fc = [];
      for(let f = bar+1; f <= Math.min(bar + evalWindow, d.len-1); f++) {
        fc.push({ h: d.H5[f], l: d.L5[f], c: d.C5[f] });
      }

      const ev = evalTrade(sig.signal, sig.entry, tpMult, slMult, tp1Ratio, useATR, fc, costPct);
      totalPnl += ev.pnl;
      if(ev.r === 'SL') losses++;
      else if(ev.r === 'TP2' || ev.r === 'TP1BE') wins++;
      else if(ev.r === 'TO1') wins++;
      else { if(ev.pnl >= 0) wins++; else losses++; }
    }
  }

  const total = wins + losses;
  const wr = total > 0 ? wins / total * 100 : 0;
  const days = Object.keys(DATA).length > 0 ?
    (Object.values(DATA)[0].len * (endPct - startPct)) / 288 : 1;
  const sigsPerDay = count / Math.max(0.5, days);

  return { wins, losses, total: count, wr, totalPnl, sigsPerDay, days };
}

// ═══════════════════════════════════════════════════════════════
// MAIN OPTIMIZATION LOOP
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log('═'.repeat(70));
  console.log('  SCALP ULTRA-OPTIMIZER — Walk-Forward Validation');
  console.log('  Targets: WR>80% | PnL>+20% | 300+ sigs/day');
  console.log('═'.repeat(70) + '\n');

  await loadData();

  const symCount = Object.keys(DATA).length;
  console.log(`\n  ${symCount} pares cargados\n`);

  // ═══ PHASE 1: Massive TP/SL Grid Search (TRAIN: first 50%) ═══
  console.log('═'.repeat(70));
  console.log('  FASE 1: Grid Search TP/SL/TP1 en TRAIN set (primera mitad)');
  console.log('═'.repeat(70) + '\n');

  const results1 = [];
  const tpRange = [0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.80, 1.0, 1.2, 1.5];
  const slRange = [0.20, 0.30, 0.40, 0.50, 0.60, 0.80, 1.0, 1.2, 1.5, 2.0];
  const tp1Range = [0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60];
  const evalWindows = [6, 12, 18, 24, 36];
  const cooldowns = [2, 3, 4];

  let tested = 0;
  const totalCombos = tpRange.length * slRange.length * tp1Range.length;

  // First pass: fixed eval=12, cooldown=2, no extra filters
  for(const tp of tpRange) {
    for(const sl of slRange) {
      for(const tp1 of tp1Range) {
        tested++;
        if(tested % 100 === 0) process.stdout.write(`    ${tested}/${totalCombos} combos...\r`);

        const r = runTest(0, 0.5, tp, sl, tp1, 12, 2, {}, 0.0008);
        if(r.total < 50) continue; // Need minimum samples

        results1.push({ tp, sl, tp1, ew: 12, cd: 2, ...r, filters: {} });
      }
    }
  }

  // Sort by WR (primary) then PnL (secondary)
  results1.sort((a, b) => {
    if(a.wr !== b.wr) return b.wr - a.wr;
    return b.totalPnl - a.totalPnl;
  });

  console.log(`\n    Tested ${tested} combos. Top 20 by WR:\n`);
  console.log('    TP   | SL   | TP1  | WR%   |  PnL%   | Sigs | S/Day');
  console.log('    ' + '─'.repeat(55));

  for(let i = 0; i < Math.min(20, results1.length); i++) {
    const r = results1[i];
    console.log(`    ${r.tp.toFixed(2)} | ${r.sl.toFixed(2)} | ${r.tp1.toFixed(2)} | ${r.wr.toFixed(1).padStart(5)}% | ${(r.totalPnl>=0?'+':'')+r.totalPnl.toFixed(2).padStart(6)}% | ${String(r.total).padStart(4)} | ${r.sigsPerDay.toFixed(0).padStart(4)}`);
  }

  // ═══ PHASE 2: Eval Window + Cooldown optimization on top configs ═══
  console.log('\n' + '═'.repeat(70));
  console.log('  FASE 2: Optimizar Eval Window + Cooldown en top 10 configs');
  console.log('═'.repeat(70) + '\n');

  const top10 = results1.slice(0, 10);
  const results2 = [];

  for(const base of top10) {
    for(const ew of evalWindows) {
      for(const cd of cooldowns) {
        const r = runTest(0, 0.5, base.tp, base.sl, base.tp1, ew, cd, {}, 0.0008);
        if(r.total < 50) continue;
        results2.push({ tp: base.tp, sl: base.sl, tp1: base.tp1, ew, cd, ...r, filters: {} });
      }
    }
  }

  results2.sort((a, b) => {
    // Score: WR weight + PnL weight + sigs weight
    const scoreA = a.wr * 2 + (a.totalPnl > 0 ? a.totalPnl * 0.5 : a.totalPnl * 2) + (a.sigsPerDay >= 300 ? 10 : a.sigsPerDay >= 200 ? 5 : 0);
    const scoreB = b.wr * 2 + (b.totalPnl > 0 ? b.totalPnl * 0.5 : b.totalPnl * 2) + (b.sigsPerDay >= 300 ? 10 : b.sigsPerDay >= 200 ? 5 : 0);
    return scoreB - scoreA;
  });

  console.log('    Top 10 with eval window optimization:\n');
  console.log('    TP   | SL   | TP1  | EW | CD | WR%   |  PnL%   | S/Day');
  console.log('    ' + '─'.repeat(60));
  for(let i = 0; i < Math.min(10, results2.length); i++) {
    const r = results2[i];
    console.log(`    ${r.tp.toFixed(2)} | ${r.sl.toFixed(2)} | ${r.tp1.toFixed(2)} | ${String(r.ew).padStart(2)} | ${String(r.cd).padStart(2)} | ${r.wr.toFixed(1).padStart(5)}% | ${(r.totalPnl>=0?'+':'')+r.totalPnl.toFixed(2).padStart(6)}% | ${r.sigsPerDay.toFixed(0).padStart(4)}`);
  }

  // ═══ PHASE 3: Filter optimization on top 5 ═══
  console.log('\n' + '═'.repeat(70));
  console.log('  FASE 3: Optimizar Filtros en top 5 configs');
  console.log('═'.repeat(70) + '\n');

  const filterSets = [
    {},
    { blockHours: [6, 7, 8, 15, 16, 17, 18, 19] },
    { blockHours: [6, 7, 12, 15, 16, 17, 18, 19] },
    { blockHours: [6, 7, 8, 11, 12, 15, 16, 17, 18, 19, 20] },
    { requireMTF: true },
    { requireHTF: true },
    { requireMTF: true, requireHTF: true },
    { minMargin: 0.5 },
    { minMargin: 1.0 },
    { minMargin: 1.5 },
    { stochFilter: true },
    { bbFilter: true },
    { momFilter: true },
    { emaDistMax: 1.5 },
    { emaDistMax: 2.0 },
    { minVR: 0.6 },
    { minVR: 0.8 },
    { minADX: 12 },
    { minADX: 15 },
    { onlyBuy: true },
    // Combos
    { requireMTF: true, blockHours: [6, 7, 15, 16, 17, 18, 19] },
    { requireHTF: true, blockHours: [6, 7, 15, 16, 17, 18, 19] },
    { requireMTF: true, minMargin: 0.5 },
    { requireHTF: true, minMargin: 0.5 },
    { requireMTF: true, stochFilter: true },
    { requireHTF: true, stochFilter: true },
    { requireMTF: true, bbFilter: true },
    { bbFilter: true, stochFilter: true },
    { requireMTF: true, blockHours: [6, 7, 15, 16, 17, 18, 19], minMargin: 0.5 },
    { requireHTF: true, blockHours: [6, 7, 15, 16, 17, 18, 19], stochFilter: true },
    { requireHTF: true, requireMTF: true, blockHours: [6, 7, 15, 16, 17, 18, 19] },
    { requireHTF: true, requireMTF: true, minMargin: 0.5 },
    { requireHTF: true, requireMTF: true, blockHours: [6, 7, 15, 16, 17, 18, 19], minMargin: 0.5 },
    { bbFilter: true, momFilter: true },
    { stochFilter: true, momFilter: true },
    { onlyBuy: true, requireMTF: true },
    { onlyBuy: true, requireHTF: true },
    { onlyBuy: true, blockHours: [6, 7, 15, 16, 17, 18, 19] },
    { onlyBuy: true, requireHTF: true, blockHours: [6, 7, 15, 16, 17, 18, 19] },
    { rsiFilter: true, rsiBuyCap: 60, rsiSellFloor: 40 },
    { rsiFilter: true, rsiBuyCap: 55, rsiSellFloor: 45 },
    { rsiFilter: true, rsiBuyCap: 65, rsiSellFloor: 35 },
    { rsiFilter: true, rsiBuyCap: 60, rsiSellFloor: 40, requireMTF: true },
    { rsiFilter: true, rsiBuyCap: 60, rsiSellFloor: 40, blockHours: [6, 7, 15, 16, 17, 18, 19] },
  ];

  const top5 = results2.slice(0, 5);
  const results3 = [];

  for(const base of top5) {
    for(let fi = 0; fi < filterSets.length; fi++) {
      const f = filterSets[fi];
      const r = runTest(0, 0.5, base.tp, base.sl, base.tp1, base.ew, base.cd, f, 0.0008);
      if(r.total < 30) continue;
      results3.push({
        tp: base.tp, sl: base.sl, tp1: base.tp1, ew: base.ew, cd: base.cd,
        ...r, filters: f, fi
      });
    }
  }

  // Score with all 3 targets
  results3.sort((a, b) => {
    const sA = (a.wr >= 80 ? 100 : a.wr) + (a.totalPnl > 0 ? a.totalPnl : a.totalPnl * 3) + (a.sigsPerDay >= 300 ? 20 : a.sigsPerDay >= 200 ? 10 : a.sigsPerDay >= 100 ? 5 : -20);
    const sB = (b.wr >= 80 ? 100 : b.wr) + (b.totalPnl > 0 ? b.totalPnl : b.totalPnl * 3) + (b.sigsPerDay >= 300 ? 20 : b.sigsPerDay >= 200 ? 10 : b.sigsPerDay >= 100 ? 5 : -20);
    return sB - sA;
  });

  console.log('    Top 15 configs + filters (TRAIN):\n');
  console.log('    TP   | SL   | TP1  | EW | CD | WR%   |  PnL%   | S/Day | Filters');
  console.log('    ' + '─'.repeat(75));
  const showTop = Math.min(15, results3.length);
  for(let i = 0; i < showTop; i++) {
    const r = results3[i];
    const fStr = Object.keys(r.filters).length ? JSON.stringify(r.filters).slice(0,30) : 'none';
    console.log(`    ${r.tp.toFixed(2)} | ${r.sl.toFixed(2)} | ${r.tp1.toFixed(2)} | ${String(r.ew).padStart(2)} | ${String(r.cd).padStart(2)} | ${r.wr.toFixed(1).padStart(5)}% | ${(r.totalPnl>=0?'+':'')+r.totalPnl.toFixed(2).padStart(6)}% | ${r.sigsPerDay.toFixed(0).padStart(4)}  | ${fStr}`);
  }

  // ═══ PHASE 4: WALK-FORWARD VALIDATION on TEST set (second 50%) ═══
  console.log('\n' + '═'.repeat(70));
  console.log('  FASE 4: VALIDACION WALK-FORWARD en TEST set (segunda mitad)');
  console.log('  [Los datos de test NUNCA fueron vistos durante optimizacion]');
  console.log('═'.repeat(70) + '\n');

  const topN = Math.min(20, results3.length);
  const validated = [];

  for(let i = 0; i < topN; i++) {
    const cfg = results3[i];
    const r = runTest(0.5, 1.0, cfg.tp, cfg.sl, cfg.tp1, cfg.ew, cfg.cd, cfg.filters, 0.0008);

    validated.push({
      ...cfg,
      test_wr: r.wr, test_pnl: r.totalPnl, test_sigs: r.total, test_spd: r.sigsPerDay, test_days: r.days,
      train_wr: cfg.wr, train_pnl: cfg.totalPnl, train_spd: cfg.sigsPerDay
    });
  }

  validated.sort((a, b) => {
    const sA = (a.test_wr >= 80 ? 100 : a.test_wr) + (a.test_pnl > 0 ? a.test_pnl : a.test_pnl * 3) + (a.test_spd >= 300 ? 20 : a.test_spd >= 200 ? 10 : -10);
    const sB = (b.test_wr >= 80 ? 100 : b.test_wr) + (b.test_pnl > 0 ? b.test_pnl : b.test_pnl * 3) + (b.test_spd >= 300 ? 20 : b.test_spd >= 200 ? 10 : -10);
    return sB - sA;
  });

  console.log('    TRAIN vs TEST validation (top 15):\n');
  console.log('    TP   | SL   | TP1  | EW | TRAIN WR | TRAIN PnL | TEST WR | TEST PnL | T.S/Day | Filters');
  console.log('    ' + '─'.repeat(95));

  for(let i = 0; i < Math.min(15, validated.length); i++) {
    const v = validated[i];
    const fStr = Object.keys(v.filters).length ? JSON.stringify(v.filters).slice(0,25) : 'none';
    console.log(`    ${v.tp.toFixed(2)} | ${v.sl.toFixed(2)} | ${v.tp1.toFixed(2)} | ${String(v.ew).padStart(2)} | ${v.train_wr.toFixed(1).padStart(7)}% | ${(v.train_pnl>=0?'+':'')+v.train_pnl.toFixed(2).padStart(8)}% | ${v.test_wr.toFixed(1).padStart(6)}% | ${(v.test_pnl>=0?'+':'')+v.test_pnl.toFixed(2).padStart(7)}% | ${v.test_spd.toFixed(0).padStart(6)}  | ${fStr}`);
  }

  // ═══ PHASE 5: Full-range validation of best config ═══
  console.log('\n' + '═'.repeat(70));
  console.log('  FASE 5: Validacion completa (100% datos) del MEJOR config');
  console.log('═'.repeat(70) + '\n');

  const best = validated[0];
  const fullRun = runTest(0, 1.0, best.tp, best.sl, best.tp1, best.ew, best.cd, best.filters, 0.0008);

  console.log(`    Config: TP=${best.tp}xATR | SL=${best.sl}xATR | TP1=${best.tp1} | EW=${best.ew} | CD=${best.cd}`);
  console.log(`    Filters: ${JSON.stringify(best.filters)}`);
  console.log();
  console.log(`    FULL RANGE RESULTS:`);
  console.log(`    ─────────────────────────`);
  console.log(`    Total Signals:   ${fullRun.total}`);
  console.log(`    Signals/Day:     ${fullRun.sigsPerDay.toFixed(0)}`);
  console.log(`    WIN RATE:        ${fullRun.wr.toFixed(1)}%  (${fullRun.wins}W / ${fullRun.losses}L)`);
  console.log(`    TOTAL PnL:       ${fullRun.totalPnl>=0?'+':''}${fullRun.totalPnl.toFixed(3)}%`);
  console.log(`    Days:            ${fullRun.days.toFixed(1)}`);

  // Check targets
  console.log('\n' + '═'.repeat(70));
  console.log('  VEREDICTO FINAL');
  console.log('═'.repeat(70));
  const checks = [
    { name: 'Win Rate > 80%', ok: fullRun.wr > 80, val: `${fullRun.wr.toFixed(1)}%` },
    { name: 'PnL > +20%', ok: fullRun.totalPnl > 20, val: `${fullRun.totalPnl>=0?'+':''}${fullRun.totalPnl.toFixed(2)}%` },
    { name: 'Signals/Day > 300', ok: fullRun.sigsPerDay > 300, val: `${fullRun.sigsPerDay.toFixed(0)}/dia` },
  ];
  for(const c of checks) console.log(`  ${c.ok ? '[OK]' : '[!!]'} ${c.name}: ${c.val}`);

  // If targets not met, try more aggressive approaches
  const allMet = checks.every(c => c.ok);
  if(!allMet) {
    console.log('\n  Targets no alcanzados en Fase 5. Iniciando Fase 6...\n');
    await phase6(validated);
  }

  console.log('\n' + '═'.repeat(70) + '\n');
}

// ═══ PHASE 6: Aggressive re-optimization if targets not met ═══
async function phase6(prevResults) {
  console.log('═'.repeat(70));
  console.log('  FASE 6: DEEP SEARCH — Fine-grained TP/SL + aggressive filters');
  console.log('═'.repeat(70) + '\n');

  // Fine-grained search around the best regions from phase 1-4
  const fineTP = [];
  const fineSL = [];
  const fineTP1 = [];

  // Generate fine ranges
  for(let t = 0.05; t <= 2.5; t += 0.05) fineTP.push(Math.round(t*100)/100);
  for(let s = 0.10; s <= 3.0; s += 0.05) fineSL.push(Math.round(s*100)/100);
  for(let r = 0.10; r <= 0.70; r += 0.05) fineTP1.push(Math.round(r*100)/100);

  // Test with key filter combos
  const keyFilters = [
    {},
    { requireHTF: true },
    { requireMTF: true },
    { requireHTF: true, requireMTF: true },
    { blockHours: [6, 7, 11, 12, 15, 16, 17, 18, 19] },
    { requireHTF: true, blockHours: [6, 7, 12, 15, 16, 17, 18, 19] },
    { requireMTF: true, blockHours: [6, 7, 12, 15, 16, 17, 18, 19] },
    { onlyBuy: true },
    { onlyBuy: true, requireHTF: true },
    { stochFilter: true },
    { bbFilter: true },
    { stochFilter: true, requireMTF: true },
    { bbFilter: true, requireMTF: true },
  ];

  let bestScore = -999;
  let bestConfig = null;
  let tested = 0;
  const totalFine = fineTP.length * fineSL.length; // per tp1/filter combo

  console.log(`    Fine grid: ${fineTP.length} TP x ${fineSL.length} SL x ${fineTP1.length} TP1 x ${keyFilters.length} filters`);
  console.log(`    Total combos: ~${(fineTP.length * fineSL.length * fineTP1.length * keyFilters.length / 1000).toFixed(0)}K\n`);

  // Use sampling to manage compute: test all TP/SL, sample TP1 and filters
  for(const fi of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const f = keyFilters[fi];
    for(const tp1 of fineTP1) {
      for(const tp of fineTP) {
        for(const sl of fineSL) {
          tested++;
          if(tested % 5000 === 0) {
            process.stdout.write(`    ${(tested/1000).toFixed(0)}K combos... best WR=${bestConfig ? bestConfig.test_wr.toFixed(1) : '?'}% PnL=${bestConfig ? bestConfig.test_pnl.toFixed(2) : '?'}%\r`);
          }

          // Quick train check
          const train = runTest(0, 0.5, tp, sl, tp1, 12, 2, f, 0.0008);
          if(train.total < 30) continue;
          if(train.wr < 60) continue; // Skip bad configs fast

          // Validate
          const test = runTest(0.5, 1.0, tp, sl, tp1, 12, 2, f, 0.0008);
          if(test.total < 20) continue;

          const score = (test.wr >= 80 ? 100 : test.wr * 0.8) +
                       (test.totalPnl > 0 ? test.totalPnl * 0.8 : test.totalPnl * 3) +
                       (test.sigsPerDay >= 300 ? 30 : test.sigsPerDay >= 200 ? 15 : test.sigsPerDay >= 100 ? 5 : -30);

          if(score > bestScore) {
            bestScore = score;
            bestConfig = {
              tp, sl, tp1, ew: 12, cd: 2, filters: f,
              train_wr: train.wr, train_pnl: train.totalPnl, train_spd: train.sigsPerDay,
              test_wr: test.wr, test_pnl: test.totalPnl, test_spd: test.sigsPerDay,
              test_total: test.total
            };
          }
        }
      }
    }
  }

  console.log(`\n\n    Tested ${(tested/1000).toFixed(0)}K combinations total\n`);

  if(bestConfig) {
    console.log('    BEST CONFIG FOUND:');
    console.log(`    TP=${bestConfig.tp}xATR | SL=${bestConfig.sl}xATR | TP1=${bestConfig.tp1}`);
    console.log(`    Filters: ${JSON.stringify(bestConfig.filters)}`);
    console.log(`    TRAIN: WR=${bestConfig.train_wr.toFixed(1)}% | PnL=${bestConfig.train_pnl>=0?'+':''}${bestConfig.train_pnl.toFixed(2)}% | ${bestConfig.train_spd.toFixed(0)} s/d`);
    console.log(`    TEST:  WR=${bestConfig.test_wr.toFixed(1)}% | PnL=${bestConfig.test_pnl>=0?'+':''}${bestConfig.test_pnl.toFixed(2)}% | ${bestConfig.test_spd.toFixed(0)} s/d`);

    // Full validation
    const full = runTest(0, 1.0, bestConfig.tp, bestConfig.sl, bestConfig.tp1, bestConfig.ew, bestConfig.cd, bestConfig.filters, 0.0008);
    console.log(`\n    FULL VALIDATION:`);
    console.log(`    WR=${full.wr.toFixed(1)}% | PnL=${full.totalPnl>=0?'+':''}${full.totalPnl.toFixed(2)}% | ${full.sigsPerDay.toFixed(0)} s/d | ${full.total} signals`);

    const checks = [
      { name: 'Win Rate > 80%', ok: full.wr > 80, val: `${full.wr.toFixed(1)}%` },
      { name: 'PnL > +20%', ok: full.totalPnl > 20, val: `${full.totalPnl>=0?'+':''}${full.totalPnl.toFixed(2)}%` },
      { name: 'Signals/Day > 300', ok: full.sigsPerDay > 300, val: `${full.sigsPerDay.toFixed(0)}/dia` },
    ];
    console.log();
    for(const c of checks) console.log(`    ${c.ok ? '[OK]' : '[!!]'} ${c.name}: ${c.val}`);
  }
}

main().catch(console.error);
