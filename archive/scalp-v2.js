// ═══════════════════════════════════════════════════════════════════════
// SCALP OPTIMIZER v2 — Mathematical approach
// ═══════════════════════════════════════════════════════════════════════
// Key insight: WR>80% requires TP1 << SL geometrically.
// For PnL>0, signals must provide directional edge BEYOND random walk.
// Approach: % based TP/SL + trailing stop after TP1 + quality filters
// Walk-forward: Train on first 50%, Validate on last 50%
// ═══════════════════════════════════════════════════════════════════════

const https = require('https');
const SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','DOTUSDT','NEARUSDT','APTUSDT'];

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
function calcParabolicSAR(H,L,C){if(C.length<5)return{trend:'BUY',recentFlip:false};let af=.02,maxAf=.2,sar=L[0],ep=H[0],isUp=true,lastFlip=0;for(let i=1;i<C.length;i++){const p=sar+af*(ep-sar);if(isUp){sar=Math.min(p,L[i-1],i>1?L[i-2]:L[i-1]);if(L[i]<sar){isUp=false;sar=ep;ep=L[i];af=.02;lastFlip=i;}else{if(H[i]>ep){ep=H[i];af=Math.min(af+.02,maxAf);}sar=p;}}else{sar=Math.max(p,H[i-1],i>1?H[i-2]:H[i-1]);if(H[i]>sar){isUp=true;sar=ep;ep=H[i];af=.02;lastFlip=i;}else{if(L[i]<ep){ep=L[i];af=Math.min(af+.02,maxAf);}sar=p;}}}return{trend:isUp?'BUY':'SELL',recentFlip:(C.length-1-lastFlip)<=5};}
function calcKeltner(H,L,C){if(C.length<21)return{position:0.5};const mid=calcEMA(C,20);const atr=calcATR(H,L,C,14);const u=mid+2*atr,lo=mid-2*atr;const r=u-lo;return{position:r>0?(C.at(-1)-lo)/r:0.5};}

// ─── Signal with quality score ───
function genSignal(C,H,L,V, C15,H15,L15, C1h,H1h,L1h,V1h, sym,hourUTC, filterCfg) {
  const cur = C.at(-1);
  if(!cur) return null;

  const rsi=calcRSI(C,14), mac=calcMACD(C);
  const ea9=calcEMAArr(C,9),ea21=calcEMAArr(C,21);
  const e9=ea9.at(-1),e21=ea21.at(-1),e9p=ea9.at(-2),e21p=ea21.at(-2);
  const e50=calcEMA(C,50);
  const adx=calcADX(H,L,C);
  const obv=calcOBV(C,V);
  const atr=calcATR(H,L,C,14);
  const avgV=V.slice(-20).reduce((a,b)=>a+b)/20;
  const vr=V.at(-1)/avgV;
  const stoch=calcStoch(H,L,C,14);
  const bb=calcBB(C,20,2);
  const psar=calcParabolicSAR(H,L,C);
  const kc=calcKeltner(H,L,C);

  // HTF
  let htfTrend='N',htfStr=0;
  if(C1h&&C1h.length>25){
    const e9h=calcEMA(C1h,9),e21h=calcEMA(C1h,21),e50h=calcEMA(C1h,50);
    const m1h=calcMACD(C1h),adx1h=calcADX(H1h,L1h,C1h),obv1h=calcOBV(C1h,V1h),rsi1h=calcRSI(C1h,14);
    let hB=0,hS=0;
    if(e9h>e21h)hB+=2;else hS+=2;
    if(C1h.at(-1)>e50h)hB+=1;else hS+=1;
    if(m1h.h>0)hB+=1.5;else hS+=1.5;
    if(m1h.h>(m1h.ph||0))hB+=1;else hS+=1;
    if(rsi1h>50)hB+=1;else hS+=1;
    if(adx1h.adx>20&&adx1h.pdi>adx1h.mdi)hB+=1.5;
    else if(adx1h.adx>20)hS+=1.5;
    if(obv1h.rising)hB+=1;else hS+=1;
    if(hB>hS+2){htfTrend='B';htfStr=hB-hS;}
    else if(hS>hB+2){htfTrend='S';htfStr=hS-hB;}
  }

  // MTF 15m
  let mtf='N';
  if(C15.length>25){
    const e9_15=calcEMA(C15,9),e21_15=calcEMA(C15,21),m15=calcMACD(C15),rsi15=calcRSI(C15,14);
    let mB=0,mS=0;
    if(e9_15>e21_15)mB++;else mS++;
    if(m15.h>0)mB++;else mS++;
    if(rsi15>55)mB+=0.5;else if(rsi15<45)mS+=0.5;
    if(mB>mS)mtf='B';else if(mS>mB)mtf='S';
  }

  // ═══ COMPREHENSIVE SCORING — 12 indicators ═══
  let B=0,S=0,bI=0,sI=0;

  // RSI
  if(rsi<30){B+=2.5;bI++;}else if(rsi>70){S+=2.5;sI++;}
  // MACD cross
  if(mac.h>0&&mac.ph<0){B+=2;bI++;}else if(mac.h<0&&mac.ph>0){S+=2;sI++;}
  // MACD direction
  else if(mac.h>0){B+=0.5;bI++;}else if(mac.h<0){S+=0.5;sI++;}
  // EMA cross
  if(e9>e21&&e9p<=e21p){B+=2.5;bI++;}else if(e9<e21&&e9p>=e21p){S+=2.5;sI++;}
  else if(e9>e21){B+=0.5;bI++;}else{S+=0.5;sI++;}
  // EMA50
  if(cur>e50){B+=0.5;bI++;}else{S+=0.5;sI++;}
  // ADX
  if(adx.adx>25&&adx.pdi>adx.mdi){B+=1.5;bI++;}
  else if(adx.adx>25&&adx.mdi>adx.pdi){S+=1.5;sI++;}
  // OBV
  if(obv.rising){B+=0.8;bI++;}else{S+=0.8;sI++;}
  // Stoch
  if(stoch.k<25&&stoch.k>stoch.d){B+=1.5;bI++;}
  else if(stoch.k>75&&stoch.k<stoch.d){S+=1.5;sI++;}
  // BB
  const bbR=bb.u-bb.l;const bbP=bbR>0?(cur-bb.l)/bbR:0.5;
  if(bbP<0.1){B+=1.5;bI++;}else if(bbP>0.9){S+=1.5;sI++;}
  // PSAR
  if(psar.recentFlip){if(psar.trend==='BUY'){B+=1.5;bI++;}else{S+=1.5;sI++;}}
  else{if(psar.trend==='BUY'){B+=0.3;bI++;}else{S+=0.3;sI++;}}
  // Keltner
  if(kc.position<0.05){B+=1;bI++;}else if(kc.position>0.95){S+=1;sI++;}
  // Volume amplifier
  if(vr>1.5&&B>S)B*=1.15;else if(vr>1.5&&S>B)S*=1.15;

  // Momentum
  const mom3=(C.at(-1)-(C.at(-4)||C.at(-1)))/Math.max(atr,0.0001);
  // Candle exhaustion
  const l4=C.slice(-4);
  const bullExh=l4.length>=4&&l4.every((c,i)=>i===0||c>l4[i-1]);
  const bearExh=l4.length>=4&&l4.every((c,i)=>i===0||c<l4[i-1]);

  // Score & margin
  const score = Math.max(B,S);
  const margin = B > S ? B - S : S - B;
  let signal = 'NEUTRAL';

  // Base threshold
  const thr = filterCfg.scoreThr || 1.0;
  const minInd = filterCfg.minInds || 1;

  if(B>S&&B>=thr&&bI>=minInd) signal='BUY';
  else if(S>B&&S>=thr&&sI>=minInd) signal='SELL';

  // ═══ SAFETY RULES (always applied) ═══
  if(signal!=='NEUTRAL'&&hourUTC>=0&&hourUTC<6) signal='NEUTRAL'; // Dead hours
  if(signal!=='NEUTRAL'&&vr<0.4) signal='NEUTRAL'; // Dead volume

  // ═══ QUALITY FILTERS (configurable) ═══
  if(signal!=='NEUTRAL') {
    // Anti-1H trend
    if(filterCfg.antiHTF) {
      if(signal==='BUY'&&htfTrend==='S') signal='NEUTRAL';
      if(signal==='SELL'&&htfTrend==='B') signal='NEUTRAL';
    }
    // Require HTF alignment
    if(filterCfg.reqHTF) {
      if(signal==='BUY'&&htfTrend!=='B') signal='NEUTRAL';
      if(signal==='SELL'&&htfTrend!=='S') signal='NEUTRAL';
    }
    // Require MTF alignment
    if(filterCfg.reqMTF) {
      if(signal==='BUY'&&mtf==='S') signal='NEUTRAL';
      if(signal==='SELL'&&mtf==='B') signal='NEUTRAL';
    }
    // Require MTF confirmation (must match, not just not-against)
    if(filterCfg.reqMTFconfirm) {
      if(signal==='BUY'&&mtf!=='B') signal='NEUTRAL';
      if(signal==='SELL'&&mtf!=='S') signal='NEUTRAL';
    }
    // Score margin
    if(filterCfg.minMargin && margin < filterCfg.minMargin) signal='NEUTRAL';
    // Exhaustion
    if(filterCfg.exhFilter) {
      if(signal==='BUY'&&bullExh) signal='NEUTRAL';
      if(signal==='SELL'&&bearExh) signal='NEUTRAL';
    }
    // Momentum contradiction
    if(filterCfg.momFilter) {
      if(signal==='BUY'&&mom3<-0.3) signal='NEUTRAL';
      if(signal==='SELL'&&mom3>0.3) signal='NEUTRAL';
    }
    // RSI cap
    if(filterCfg.rsiCap) {
      if(signal==='BUY'&&rsi>filterCfg.rsiCapBuy) signal='NEUTRAL';
      if(signal==='SELL'&&rsi<filterCfg.rsiCapSell) signal='NEUTRAL';
    }
    // BB position
    if(filterCfg.bbFilter) {
      if(signal==='BUY'&&bbP>0.65) signal='NEUTRAL';
      if(signal==='SELL'&&bbP<0.35) signal='NEUTRAL';
    }
    // Stoch filter
    if(filterCfg.stochFilt) {
      if(signal==='BUY'&&stoch.k>75) signal='NEUTRAL';
      if(signal==='SELL'&&stoch.k<25) signal='NEUTRAL';
    }
    // Hour blocks
    if(filterCfg.blockH&&filterCfg.blockH.includes(hourUTC)) signal='NEUTRAL';
    // ADX floor
    if(filterCfg.adxFloor&&adx.adx<filterCfg.adxFloor) signal='NEUTRAL';
    // Only BUY
    if(filterCfg.onlyBuy&&signal==='SELL') signal='NEUTRAL';
    // EMA distance
    if(filterCfg.emaDist) {
      const d=Math.abs(cur-e21)/Math.max(atr,0.0001);
      if(d>filterCfg.emaDist) signal='NEUTRAL';
    }
  }

  return { signal, entry: cur, atr, B, S, margin, score, rsi, adx: adx.adx, vr, stochK: stoch.k, bbP, htfTrend, mtf, mom3 };
}

// ─── Evaluate with 3 strategies ───
// Strategy A: Fixed TP/SL with partial TP
// Strategy B: Trailing stop after TP1
// Strategy C: Time-decay exit (close after N bars regardless)
function evalTradeMulti(signal, entry, cfg, futureCandles, costPerSide) {
  const results = {};
  const cost = entry * costPerSide * 2; // round trip

  // ═══ Strategy A: Fixed % TP/SL with partial TP ═══
  {
    const tp1Pct = cfg.tp1Pct;
    const tp2Pct = cfg.tp2Pct;
    const slPct = cfg.slPct;
    const tp1 = signal==='BUY' ? entry*(1+tp1Pct/100) : entry*(1-tp1Pct/100);
    const tp2 = signal==='BUY' ? entry*(1+tp2Pct/100) : entry*(1-tp2Pct/100);
    const sl = signal==='BUY' ? entry*(1-slPct/100) : entry*(1+slPct/100);
    let tp1Hit=false;
    let res='TO', pnl=0;
    for(const {h,l,c} of futureCandles) {
      if(signal==='BUY') {
        if(!tp1Hit) {
          if(l<=sl){res='SL';pnl=-(slPct/100)*entry-cost;break;}
          if(h>=tp1){tp1Hit=true;}
        }
        if(tp1Hit) {
          if(h>=tp2){res='TP2';pnl=((tp1Pct/100)*0.5+(tp2Pct/100)*0.5)*entry-cost;break;}
          if(l<=entry){res='TP1BE';pnl=(tp1Pct/100)*0.5*entry-cost;break;}
        }
      } else {
        if(!tp1Hit) {
          if(h>=sl){res='SL';pnl=-(slPct/100)*entry-cost;break;}
          if(l<=tp1){tp1Hit=true;}
        }
        if(tp1Hit) {
          if(l<=tp2){res='TP2';pnl=((tp1Pct/100)*0.5+(tp2Pct/100)*0.5)*entry-cost;break;}
          if(h>=entry){res='TP1BE';pnl=(tp1Pct/100)*0.5*entry-cost;break;}
        }
      }
    }
    if(res==='TO') {
      const last=futureCandles.at(-1)?.c||entry;
      const uPnl=signal==='BUY'?last-entry:entry-last;
      if(tp1Hit) pnl=(tp1Pct/100)*0.5*entry+uPnl*0.5-cost;
      else pnl=uPnl-cost;
    }
    const pnlPct = pnl / entry * 100;
    results.A = { res, pnlPct, win: res!=='SL'&&!(res==='TO'&&pnlPct<0) };
  }

  // ═══ Strategy B: Trailing stop after TP1 ═══
  {
    const tp1Pct = cfg.tp1Pct;
    const slPct = cfg.slPct;
    const trailPct = cfg.trailPct || 0.08; // trailing stop distance
    const tp1 = signal==='BUY' ? entry*(1+tp1Pct/100) : entry*(1-tp1Pct/100);
    const sl = signal==='BUY' ? entry*(1-slPct/100) : entry*(1+slPct/100);
    let tp1Hit=false, bestPrice=entry, trailStop=0;
    let res='TO', pnl=0;
    for(const {h,l,c} of futureCandles) {
      if(signal==='BUY') {
        if(!tp1Hit) {
          if(l<=sl){res='SL';pnl=-(slPct/100)*entry-cost;break;}
          if(h>=tp1){tp1Hit=true;bestPrice=h;trailStop=h*(1-trailPct/100);}
        }
        if(tp1Hit) {
          if(h>bestPrice){bestPrice=h;trailStop=h*(1-trailPct/100);}
          if(l<=Math.max(trailStop,entry)){
            const exitP=Math.max(trailStop,entry);
            const fullPnl=exitP-entry;
            pnl=(tp1Pct/100)*0.5*entry+fullPnl*0.5-cost;
            res=fullPnl>0?'TRAIL':'TP1BE';break;
          }
        }
      } else {
        if(!tp1Hit) {
          if(h>=sl){res='SL';pnl=-(slPct/100)*entry-cost;break;}
          if(l<=tp1){tp1Hit=true;bestPrice=l;trailStop=l*(1+trailPct/100);}
        }
        if(tp1Hit) {
          if(l<bestPrice){bestPrice=l;trailStop=l*(1+trailPct/100);}
          if(h>=Math.min(trailStop,entry)){
            const exitP=Math.min(trailStop,entry);
            const fullPnl=entry-exitP;
            pnl=(tp1Pct/100)*0.5*entry+fullPnl*0.5-cost;
            res=fullPnl>0?'TRAIL':'TP1BE';break;
          }
        }
      }
    }
    if(res==='TO') {
      const last=futureCandles.at(-1)?.c||entry;
      const uPnl=signal==='BUY'?last-entry:entry-last;
      if(tp1Hit) pnl=(tp1Pct/100)*0.5*entry+uPnl*0.5-cost;
      else pnl=uPnl-cost;
    }
    const pnlPct = pnl / entry * 100;
    results.B = { res, pnlPct, win: res!=='SL'&&!(res==='TO'&&pnlPct<0) };
  }

  // ═══ Strategy C: Time exit — close at bar N, partial at TP1 ═══
  {
    const tp1Pct = cfg.tp1Pct;
    const slPct = cfg.slPct;
    const exitBar = cfg.exitBar || 6;
    const tp1 = signal==='BUY' ? entry*(1+tp1Pct/100) : entry*(1-tp1Pct/100);
    const sl = signal==='BUY' ? entry*(1-slPct/100) : entry*(1+slPct/100);
    let tp1Hit=false;
    let res='TO', pnl=0;
    for(let i=0; i<futureCandles.length&&i<exitBar; i++) {
      const {h,l,c}=futureCandles[i];
      if(signal==='BUY') {
        if(!tp1Hit) {
          if(l<=sl){res='SL';pnl=-(slPct/100)*entry-cost;break;}
          if(h>=tp1) tp1Hit=true;
        }
        // At exit bar, close everything
        if(i===exitBar-1||i===futureCandles.length-1) {
          const uPnl = c - entry;
          if(tp1Hit) pnl=(tp1Pct/100)*0.5*entry+uPnl*0.5-cost;
          else pnl=uPnl-cost;
          res=tp1Hit?'TP1+TIME':'TIME';break;
        }
      } else {
        if(!tp1Hit) {
          if(h>=sl){res='SL';pnl=-(slPct/100)*entry-cost;break;}
          if(l<=tp1) tp1Hit=true;
        }
        if(i===exitBar-1||i===futureCandles.length-1) {
          const uPnl = entry - c;
          if(tp1Hit) pnl=(tp1Pct/100)*0.5*entry+uPnl*0.5-cost;
          else pnl=uPnl-cost;
          res=tp1Hit?'TP1+TIME':'TIME';break;
        }
      }
    }
    const pnlPct = pnl / entry * 100;
    results.C = { res, pnlPct, win: res!=='SL'&&!(res==='TO'&&pnlPct<0)&&!((res==='TIME'||res==='TP1+TIME')&&pnlPct<0) };
  }

  return results;
}

// ─── Data ───
let DATA = {};
async function loadData() {
  console.log('  Cargando data...\n');
  for(const sym of SYMS) {
    process.stdout.write(`    ${sym}...`);
    const [kl5,kl15,kl1h] = await Promise.all([
      getKlines(sym,'5m',1000), getKlines(sym,'15m',400), getKlines(sym,'1h',200)
    ]);
    if(!kl5||kl5.length<400){console.log(' SKIP');continue;}
    DATA[sym]={
      C5:kl5.map(k=>+k[4]),H5:kl5.map(k=>+k[2]),L5:kl5.map(k=>+k[3]),V5:kl5.map(k=>+k[5]),T5:kl5.map(k=>k[0]),
      C15:kl15?kl15.map(k=>+k[4]):[],H15:kl15?kl15.map(k=>+k[2]):[],L15:kl15?kl15.map(k=>+k[3]):[],T15:kl15?kl15.map(k=>k[0]):[],
      C1h:kl1h?kl1h.map(k=>+k[4]):[],H1h:kl1h?kl1h.map(k=>+k[2]):[],L1h:kl1h?kl1h.map(k=>+k[3]):[],V1h:kl1h?kl1h.map(k=>+k[5]):[],T1h:kl1h?kl1h.map(k=>k[0]):[],
      len:kl5.length
    };
    console.log(` ${kl5.length} bars`);
    await new Promise(r=>setTimeout(r,200));
  }
}

// ─── Run backtest ───
function runTest(startPct, endPct, tradeCfg, filterCfg, cooldown, costPerSide, strategy) {
  let wins=0,losses=0,totalPnl=0,count=0;
  const LB=280, EW=tradeCfg.evalWindow||24;
  for(const sym of Object.keys(DATA)) {
    const d=DATA[sym],len=d.len;
    const rS=Math.floor(len*startPct),rE=Math.floor(len*endPct);
    const bS=Math.max(LB,rS),bE=rE-EW;
    if(bE<=bS) continue;
    let lastBar=-999;
    for(let bar=bS;bar<bE;bar++) {
      if(bar-lastBar<cooldown)continue;
      const c5=d.C5.slice(Math.max(0,bar-279),bar+1);
      const h5=d.H5.slice(Math.max(0,bar-279),bar+1);
      const l5=d.L5.slice(Math.max(0,bar-279),bar+1);
      const v5=d.V5.slice(Math.max(0,bar-279),bar+1);
      const bt=d.T5[bar],hUTC=new Date(bt).getUTCHours();
      let c15e=0;for(let j=d.T15.length-1;j>=0;j--){if(d.T15[j]<=bt){c15e=j+1;break;}}
      const c15=d.C15.slice(Math.max(0,c15e-100),c15e);
      const h15=d.H15.slice(Math.max(0,c15e-100),c15e);
      const l15=d.L15.slice(Math.max(0,c15e-100),c15e);
      let c1e=0;for(let j=d.T1h.length-1;j>=0;j--){if(d.T1h[j]<=bt){c1e=j+1;break;}}
      const c1h=d.C1h.slice(Math.max(0,c1e-50),c1e);
      const h1h=d.H1h.slice(Math.max(0,c1e-50),c1e);
      const l1h=d.L1h.slice(Math.max(0,c1e-50),c1e);
      const v1h=d.V1h.slice(Math.max(0,c1e-50),c1e);
      const sig=genSignal(c5,h5,l5,v5,c15,h15,l15,c1h,h1h,l1h,v1h,sym,hUTC,filterCfg);
      if(!sig||sig.signal==='NEUTRAL')continue;
      lastBar=bar;count++;
      const fc=[];
      for(let f=bar+1;f<=Math.min(bar+EW,d.len-1);f++)fc.push({h:d.H5[f],l:d.L5[f],c:d.C5[f]});
      const ev=evalTradeMulti(sig.signal,sig.entry,tradeCfg,fc,costPerSide);
      const r=ev[strategy];
      totalPnl+=r.pnlPct;
      if(r.win)wins++;else losses++;
    }
  }
  const total=wins+losses;
  const wr=total>0?wins/total*100:0;
  const days=Object.keys(DATA).length>0?(Object.values(DATA)[0].len*(endPct-startPct))/288:1;
  return{wins,losses,total:count,wr,totalPnl,sigsPerDay:count/Math.max(0.5,days),days};
}

// ═══ MAIN ═══
async function main() {
  console.log('═'.repeat(70));
  console.log('  SCALP v2 OPTIMIZER — 3 Strategies × Filters × Walk-Forward');
  console.log('  Targets: WR>80% | PnL>+20% (4d) | 300+ sigs/day');
  console.log('═'.repeat(70)+'\n');
  await loadData();
  console.log(`\n  ${Object.keys(DATA).length} pares listos\n`);

  // ═══ SEARCH SPACE ═══
  const tp1Pcts = [0.04, 0.06, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25, 0.30];
  const tp2Pcts = [0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.80, 1.0];
  const slPcts  = [0.20, 0.30, 0.40, 0.50, 0.60, 0.80, 1.0, 1.5, 2.0];
  const trailPcts = [0.05, 0.08, 0.10, 0.15, 0.20];
  const exitBars = [3, 6, 9, 12, 18, 24];
  const costs = [0.02, 0.04, 0.06]; // per side
  const cooldowns = [2, 3, 4];
  const evalWindows = [12, 18, 24, 36];

  const filterPresets = [
    { id: 'none', cfg: {} },
    { id: 'anti1h', cfg: { antiHTF: true } },
    { id: 'req1h', cfg: { reqHTF: true } },
    { id: 'req15m', cfg: { reqMTF: true } },
    { id: 'req15mc', cfg: { reqMTFconfirm: true } },
    { id: 'req_both', cfg: { reqHTF: true, reqMTFconfirm: true } },
    { id: 'margin05', cfg: { antiHTF: true, minMargin: 0.5 } },
    { id: 'margin10', cfg: { antiHTF: true, minMargin: 1.0 } },
    { id: 'margin15', cfg: { antiHTF: true, minMargin: 1.5 } },
    { id: 'quality1', cfg: { antiHTF: true, exhFilter: true, momFilter: true } },
    { id: 'quality2', cfg: { antiHTF: true, exhFilter: true, momFilter: true, minMargin: 0.5 } },
    { id: 'quality3', cfg: { antiHTF: true, reqMTF: true, exhFilter: true } },
    { id: 'quality4', cfg: { reqHTF: true, reqMTFconfirm: true, exhFilter: true, momFilter: true } },
    { id: 'bb+stoch', cfg: { antiHTF: true, bbFilter: true, stochFilt: true } },
    { id: 'rsi60', cfg: { antiHTF: true, rsiCap: true, rsiCapBuy: 60, rsiCapSell: 40 } },
    { id: 'rsi55', cfg: { antiHTF: true, rsiCap: true, rsiCapBuy: 55, rsiCapSell: 45 } },
    { id: 'hours', cfg: { antiHTF: true, blockH: [6,7,11,12,15,16,17,18,19] } },
    { id: 'adx12', cfg: { antiHTF: true, adxFloor: 12 } },
    { id: 'adx15', cfg: { antiHTF: true, adxFloor: 15 } },
    { id: 'buyonly', cfg: { onlyBuy: true, antiHTF: true } },
    { id: 'ultra', cfg: { reqHTF: true, reqMTFconfirm: true, exhFilter: true, momFilter: true, minMargin: 1.0 } },
    { id: 'mega', cfg: { reqHTF: true, reqMTFconfirm: true, exhFilter: true, momFilter: true, bbFilter: true, stochFilt: true } },
    { id: 'scr2', cfg: { antiHTF: true, scoreThr: 2.0, minInds: 2 } },
    { id: 'scr3', cfg: { antiHTF: true, scoreThr: 3.0, minInds: 2 } },
    { id: 'scr2q', cfg: { antiHTF: true, scoreThr: 2.0, minInds: 2, exhFilter: true, momFilter: true } },
    { id: 'ema15', cfg: { antiHTF: true, emaDist: 1.5 } },
    { id: 'ema20', cfg: { antiHTF: true, emaDist: 2.0 } },
  ];

  // ═══ PHASE 1: Strategy A — Fixed TP/SL + Partial TP ═══
  console.log('═══ FASE 1: Strategy A (Fixed TP/SL + Partial TP) — TRAIN ═══\n');
  let bestA = [], testedA = 0;

  for(const costPS of costs) {
    for(const tp1 of tp1Pcts) {
      for(const tp2 of tp2Pcts) {
        if(tp2 <= tp1) continue; // tp2 must be > tp1
        for(const sl of slPcts) {
          for(const fp of filterPresets) {
            testedA++;
            if(testedA%2000===0) process.stdout.write(`    A: ${(testedA/1000).toFixed(0)}K tested, best WR=${bestA[0]?.wr?.toFixed(1)||'?'}% PnL=${bestA[0]?.pnl?.toFixed(2)||'?'}%\r`);

            const cfg = { tp1Pct: tp1, tp2Pct: tp2, slPct: sl, evalWindow: 24 };
            const r = runTest(0, 0.5, cfg, fp.cfg, 2, costPS, 'A');
            if(r.total < 30) continue;

            bestA.push({ tp1, tp2, sl, cost: costPS, filter: fp.id, wr: r.wr, pnl: r.totalPnl, spd: r.sigsPerDay, total: r.total, filterCfg: fp.cfg });
            bestA.sort((a,b) => {
              const sA = (a.wr>=80?50:0) + a.wr*0.5 + (a.pnl>0?a.pnl*2:a.pnl*5) + (a.spd>=300?20:a.spd>=150?10:0);
              const sB = (b.wr>=80?50:0) + b.wr*0.5 + (b.pnl>0?b.pnl*2:b.pnl*5) + (b.spd>=300?20:b.spd>=150?10:0);
              return sB - sA;
            });
            if(bestA.length > 50) bestA.length = 50;
          }
        }
      }
    }
  }

  console.log(`\n    Strategy A: ${testedA} combos tested. Top 10:\n`);
  console.log('    TP1%  | TP2%  | SL%   | Cost | WR%   |  PnL%    | S/Day | Filter');
  console.log('    '+'-'.repeat(70));
  for(let i=0;i<Math.min(10,bestA.length);i++){
    const r=bestA[i];
    console.log(`    ${r.tp1.toFixed(2).padStart(5)} | ${r.tp2.toFixed(2).padStart(5)} | ${r.sl.toFixed(2).padStart(5)} | ${r.cost.toFixed(2).padStart(4)} | ${r.wr.toFixed(1).padStart(5)}% | ${(r.pnl>=0?'+':'')+r.pnl.toFixed(2).padStart(7)}% | ${r.spd.toFixed(0).padStart(5)} | ${r.filter}`);
  }

  // ═══ PHASE 2: Strategy B — Trailing Stop ═══
  console.log('\n═══ FASE 2: Strategy B (Trailing Stop after TP1) — TRAIN ═══\n');
  let bestB = [], testedB = 0;

  for(const costPS of costs) {
    for(const tp1 of tp1Pcts) {
      for(const sl of slPcts) {
        for(const trail of trailPcts) {
          for(const fp of filterPresets) {
            testedB++;
            if(testedB%2000===0) process.stdout.write(`    B: ${(testedB/1000).toFixed(0)}K tested, best WR=${bestB[0]?.wr?.toFixed(1)||'?'}% PnL=${bestB[0]?.pnl?.toFixed(2)||'?'}%\r`);

            const cfg = { tp1Pct: tp1, slPct: sl, trailPct: trail, evalWindow: 24 };
            const r = runTest(0, 0.5, cfg, fp.cfg, 2, costPS, 'B');
            if(r.total < 30) continue;

            bestB.push({ tp1, sl, trail, cost: costPS, filter: fp.id, wr: r.wr, pnl: r.totalPnl, spd: r.sigsPerDay, total: r.total, filterCfg: fp.cfg });
            bestB.sort((a,b) => {
              const sA = (a.wr>=80?50:0) + a.wr*0.5 + (a.pnl>0?a.pnl*2:a.pnl*5) + (a.spd>=300?20:a.spd>=150?10:0);
              const sB = (b.wr>=80?50:0) + b.wr*0.5 + (b.pnl>0?b.pnl*2:b.pnl*5) + (b.spd>=300?20:b.spd>=150?10:0);
              return sB - sA;
            });
            if(bestB.length > 50) bestB.length = 50;
          }
        }
      }
    }
  }

  console.log(`\n    Strategy B: ${testedB} combos tested. Top 10:\n`);
  console.log('    TP1%  | SL%   | Trail | Cost | WR%   |  PnL%    | S/Day | Filter');
  console.log('    '+'-'.repeat(70));
  for(let i=0;i<Math.min(10,bestB.length);i++){
    const r=bestB[i];
    console.log(`    ${r.tp1.toFixed(2).padStart(5)} | ${r.sl.toFixed(2).padStart(5)} | ${r.trail.toFixed(2).padStart(5)} | ${r.cost.toFixed(2).padStart(4)} | ${r.wr.toFixed(1).padStart(5)}% | ${(r.pnl>=0?'+':'')+r.pnl.toFixed(2).padStart(7)}% | ${r.spd.toFixed(0).padStart(5)} | ${r.filter}`);
  }

  // ═══ PHASE 3: Strategy C — Time Exit ═══
  console.log('\n═══ FASE 3: Strategy C (Time Exit) — TRAIN ═══\n');
  let bestC = [], testedC = 0;

  for(const costPS of costs) {
    for(const tp1 of tp1Pcts) {
      for(const sl of slPcts) {
        for(const eb of exitBars) {
          for(const fp of filterPresets) {
            testedC++;
            if(testedC%2000===0) process.stdout.write(`    C: ${(testedC/1000).toFixed(0)}K tested, best WR=${bestC[0]?.wr?.toFixed(1)||'?'}% PnL=${bestC[0]?.pnl?.toFixed(2)||'?'}%\r`);

            const cfg = { tp1Pct: tp1, slPct: sl, exitBar: eb, evalWindow: Math.max(24, eb+6) };
            const r = runTest(0, 0.5, cfg, fp.cfg, 2, costPS, 'C');
            if(r.total < 30) continue;

            bestC.push({ tp1, sl, exitBar: eb, cost: costPS, filter: fp.id, wr: r.wr, pnl: r.totalPnl, spd: r.sigsPerDay, total: r.total, filterCfg: fp.cfg });
            bestC.sort((a,b) => {
              const sA = (a.wr>=80?50:0) + a.wr*0.5 + (a.pnl>0?a.pnl*2:a.pnl*5) + (a.spd>=300?20:a.spd>=150?10:0);
              const sB = (b.wr>=80?50:0) + b.wr*0.5 + (b.pnl>0?b.pnl*2:b.pnl*5) + (b.spd>=300?20:b.spd>=150?10:0);
              return sB - sA;
            });
            if(bestC.length > 50) bestC.length = 50;
          }
        }
      }
    }
  }

  console.log(`\n    Strategy C: ${testedC} combos tested. Top 10:\n`);
  console.log('    TP1%  | SL%   | Exit | Cost | WR%   |  PnL%    | S/Day | Filter');
  console.log('    '+'-'.repeat(70));
  for(let i=0;i<Math.min(10,bestC.length);i++){
    const r=bestC[i];
    console.log(`    ${r.tp1.toFixed(2).padStart(5)} | ${r.sl.toFixed(2).padStart(5)} | ${String(r.exitBar).padStart(4)} | ${r.cost.toFixed(2).padStart(4)} | ${r.wr.toFixed(1).padStart(5)}% | ${(r.pnl>=0?'+':'')+r.pnl.toFixed(2).padStart(7)}% | ${r.spd.toFixed(0).padStart(5)} | ${r.filter}`);
  }

  // ═══ PHASE 4: WALK-FORWARD VALIDATION ═══
  console.log('\n' + '═'.repeat(70));
  console.log('  FASE 4: WALK-FORWARD VALIDATION (TEST set — never seen data)');
  console.log('═'.repeat(70) + '\n');

  const allCandidates = [];

  // Validate top 15 from each strategy
  for(const r of bestA.slice(0,15)) {
    const cfg = { tp1Pct: r.tp1, tp2Pct: r.tp2, slPct: r.sl, evalWindow: 24 };
    const t = runTest(0.5, 1.0, cfg, r.filterCfg, 2, r.cost, 'A');
    allCandidates.push({ strat: 'A', ...r, tWR: t.wr, tPnl: t.totalPnl, tSpd: t.sigsPerDay, tTotal: t.total });
  }
  for(const r of bestB.slice(0,15)) {
    const cfg = { tp1Pct: r.tp1, slPct: r.sl, trailPct: r.trail, evalWindow: 24 };
    const t = runTest(0.5, 1.0, cfg, r.filterCfg, 2, r.cost, 'B');
    allCandidates.push({ strat: 'B', ...r, tWR: t.wr, tPnl: t.totalPnl, tSpd: t.sigsPerDay, tTotal: t.total });
  }
  for(const r of bestC.slice(0,15)) {
    const cfg = { tp1Pct: r.tp1, slPct: r.sl, exitBar: r.exitBar, evalWindow: Math.max(24, r.exitBar+6) };
    const t = runTest(0.5, 1.0, cfg, r.filterCfg, 2, r.cost, 'C');
    allCandidates.push({ strat: 'C', ...r, tWR: t.wr, tPnl: t.totalPnl, tSpd: t.sigsPerDay, tTotal: t.total });
  }

  // Sort by combined score on TEST data
  allCandidates.sort((a,b) => {
    const sA = (a.tWR>=80?50:0) + a.tWR*0.5 + (a.tPnl>0?a.tPnl*2:a.tPnl*5) + (a.tSpd>=300?20:a.tSpd>=150?10:0);
    const sB = (b.tWR>=80?50:0) + b.tWR*0.5 + (b.tPnl>0?b.tPnl*2:b.tPnl*5) + (b.tSpd>=300?20:b.tSpd>=150?10:0);
    return sB - sA;
  });

  console.log('    TOP 20 WALK-FORWARD VALIDATED CONFIGS:\n');
  console.log('    S | TP1%  | TP2/Tr/Ex | SL%   | Cost | TRAIN WR | TRAIN PnL | TEST WR | TEST PnL | T.S/Day | Filter');
  console.log('    '+'-'.repeat(105));
  for(let i=0;i<Math.min(20,allCandidates.length);i++){
    const r=allCandidates[i];
    const p2 = r.strat==='A' ? r.tp2?.toFixed(2) : r.strat==='B' ? `t${r.trail?.toFixed(2)}` : `b${r.exitBar}`;
    console.log(`    ${r.strat} | ${r.tp1.toFixed(2).padStart(5)} | ${String(p2).padStart(9)} | ${r.sl.toFixed(2).padStart(5)} | ${r.cost.toFixed(2).padStart(4)} | ${r.wr.toFixed(1).padStart(7)}% | ${(r.pnl>=0?'+':'')+r.pnl.toFixed(2).padStart(8)}% | ${r.tWR.toFixed(1).padStart(6)}% | ${(r.tPnl>=0?'+':'')+r.tPnl.toFixed(2).padStart(7)}% | ${r.tSpd.toFixed(0).padStart(6)}  | ${r.filter}`);
  }

  // ═══ BEST OVERALL ═══
  const best = allCandidates[0];
  if(best) {
    console.log('\n' + '═'.repeat(70));
    console.log('  MEJOR CONFIG ENCONTRADA');
    console.log('═'.repeat(70));
    console.log(`  Strategy: ${best.strat}`);
    console.log(`  TP1: ${best.tp1}% | ${best.strat==='A'?'TP2: '+best.tp2+'%':best.strat==='B'?'Trail: '+best.trail+'%':'ExitBar: '+best.exitBar} | SL: ${best.sl}% | Cost: ${best.cost}%/side`);
    console.log(`  Filter: ${best.filter} → ${JSON.stringify(best.filterCfg)}`);
    console.log(`  TRAIN: WR=${best.wr.toFixed(1)}% | PnL=${best.pnl>=0?'+':''}${best.pnl.toFixed(2)}% | ${best.spd.toFixed(0)} s/d`);
    console.log(`  TEST:  WR=${best.tWR.toFixed(1)}% | PnL=${best.tPnl>=0?'+':''}${best.tPnl.toFixed(2)}% | ${best.tSpd.toFixed(0)} s/d`);

    // Full range
    let fullCfg;
    if(best.strat==='A') fullCfg = { tp1Pct: best.tp1, tp2Pct: best.tp2, slPct: best.sl, evalWindow: 24 };
    else if(best.strat==='B') fullCfg = { tp1Pct: best.tp1, slPct: best.sl, trailPct: best.trail, evalWindow: 24 };
    else fullCfg = { tp1Pct: best.tp1, slPct: best.sl, exitBar: best.exitBar, evalWindow: Math.max(24, best.exitBar+6) };

    const full = runTest(0, 1.0, fullCfg, best.filterCfg, 2, best.cost, best.strat);
    console.log(`  FULL:  WR=${full.wr.toFixed(1)}% | PnL=${full.totalPnl>=0?'+':''}${full.totalPnl.toFixed(2)}% | ${full.sigsPerDay.toFixed(0)} s/d | ${full.total} signals\n`);

    console.log('  TARGETS:');
    console.log(`  ${full.wr>80?'[OK]':'[!!]'} WR > 80%: ${full.wr.toFixed(1)}%`);
    console.log(`  ${full.totalPnl>20?'[OK]':'[!!]'} PnL > +20%: ${full.totalPnl>=0?'+':''}${full.totalPnl.toFixed(2)}%`);
    console.log(`  ${full.sigsPerDay>300?'[OK]':'[!!]'} Sigs/Day > 300: ${full.sigsPerDay.toFixed(0)}/dia`);
  }

  console.log('\n' + '═'.repeat(70) + '\n');
}

main().catch(console.error);
