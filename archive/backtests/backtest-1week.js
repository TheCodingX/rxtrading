// ═══════════════════════════════════════════════════════════════════
// BACKTEST REAL 1 SEMANA — 3 Modos: VIP, Scalp, Alta Frecuencia
// Replica EXACTA de app.html genSig() para cada modo
// Resultados como si un trader hubiera operado 7 días reales
// ═══════════════════════════════════════════════════════════════════

const https = require('https');
const SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','DOTUSDT','NEARUSDT','APTUSDT'];

function fetchJSON(url){return new Promise((res,rej)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}});}).on('error',rej)});}
async function getKlines(sym,tf,limit,endTime){
  let url=`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`;
  if(endTime)url+=`&endTime=${endTime}`;
  try{return await fetchJSON(url);}catch(e){return null;}
}

// ═══ INDICATOR FUNCTIONS (exact app.html replicas) ═══
function calcRSI(C,p=14){if(C.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=C[i]-C[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<C.length;i++){const d=C[i]-C[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}if(al===0)return 100;return 100-(100/(1+ag/al));}
function calcEMAArr(d,p){const k=2/(p+1);const r=[d[0]];for(let i=1;i<d.length;i++)r.push(d[i]*k+r[i-1]*(1-k));return r;}
function calcEMA(d,p){return calcEMAArr(d,p).at(-1);}
function calcMACD(C){if(C.length<35)return{h:0,ph:0};const e12=calcEMAArr(C,12),e26=calcEMAArr(C,26);const ml=e12.map((v,i)=>v-e26[i]);const sl=calcEMAArr(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1))};}
function calcATR(H,L,C,p=14){if(C.length<p+1)return 0;const trs=[];for(let i=1;i<C.length;i++)trs.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));if(trs.length<p)return trs.reduce((a,b)=>a+b)/trs.length;let atr=trs.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<trs.length;i++)atr=(atr*(p-1)+trs[i])/p;return atr;}
function calcStoch(H,L,C,kp=14){if(C.length<kp+3)return{k:50,d:50};const kA=[];for(let i=kp;i<=C.length;i++){const sh=H.slice(i-kp,i),sl=L.slice(i-kp,i);const hi=Math.max(...sh),lo=Math.min(...sl);kA.push(hi===lo?50:((C[i-1]-lo)/(hi-lo))*100);}const dA=[];for(let i=2;i<kA.length;i++)dA.push((kA[i]+kA[i-1]+kA[i-2])/3);return{k:kA.at(-1)||50,d:dA.at(-1)||50};}
function calcBB(C,p=20,s=2){if(C.length<p)return{u:0,m:0,l:0};const sl=C.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+s*sd,m,l:m-s*sd};}
function calcADX(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pdm=[],mdm=[],tr=[];for(let i=1;i<H.length;i++){const u=H[i]-H[i-1],d=L[i-1]-L[i];pdm.push(u>d&&u>0?u:0);mdm.push(d>u&&d>0?d:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}function ws(a,p){if(a.length<p)return a.map(()=>0);const r=[];let s=a.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=0;i<p;i++)r.push(0);r[p-1]=s;for(let i=p;i<a.length;i++){s=(s*(p-1)+a[i])/p;r.push(s);}return r;}const sT=ws(tr,p),sP=ws(pdm,p),sM=ws(mdm,p);const pdi=sP.map((v,i)=>sT[i]?v/sT[i]*100:0);const mdi=sM.map((v,i)=>sT[i]?v/sT[i]*100:0);const dx=pdi.map((v,i)=>{const s=v+mdi[i];return s?Math.abs(v-mdi[i])/s*100:0;});const dxV=dx.slice(p-1);const adxA=dxV.length>=p?ws(dxV,p):dxV;return{adx:adxA.at(-1)||15,pdi:pdi.at(-1)||0,mdi:mdi.at(-1)||0};}
function calcOBV(C,V){if(C.length<2)return{obv:0,slope:0,rising:false};let obv=0;const arr=[0];for(let i=1;i<C.length;i++){if(C[i]>C[i-1])obv+=V[i];else if(C[i]<C[i-1])obv-=V[i];arr.push(obv);}const n=Math.min(20,arr.length);const sl=arr.slice(-n);let sx=0,sy=0,sxx=0,sxy=0;for(let i=0;i<n;i++){sx+=i;sy+=sl[i];sxx+=i*i;sxy+=i*sl[i];}const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx||1);return{obv,slope,rising:slope>0};}
function detectRegime(H,L,C,adxPre,atrPre){const adx=adxPre||calcADX(H,L,C);const atr=atrPre||calcATR(H,L,C,14);const avgP=C.slice(-20).reduce((a,b)=>a+b)/20;const atrPct=atr/avgP*100;if(adx.adx>25&&(adx.pdi>adx.mdi*1.3||adx.mdi>adx.pdi*1.3))return'TRENDING';if(atrPct>2.5)return'VOLATILE';if(atrPct<0.5||adx.adx<15)return'QUIET';return'RANGING';}

// ═══ DATA LOADING — 7 full days ═══
let DATA={};
async function loadData(){
  const now=Date.now();
  const weekAgo=now-7*24*60*60*1000;

  for(const sym of SYMS){
    process.stdout.write(`  ${sym}...`);

    // 5m: need ~2016 bars → 2 requests of 1000
    const midTime=weekAgo+3.5*24*60*60*1000;
    const [k5a,k5b]=await Promise.all([
      getKlines(sym,'5m',1000,Math.floor(midTime)),
      getKlines(sym,'5m',1000)
    ]);
    await new Promise(r=>setTimeout(r,100));

    // 15m + 1h
    const [k15,k1h]=await Promise.all([
      getKlines(sym,'15m',700),
      getKlines(sym,'1h',200)
    ]);
    await new Promise(r=>setTimeout(r,200));

    if(!k5a||!k5b){console.log(' SKIP');continue;}

    // Stitch 5m data, dedup by timestamp
    const allK5=new Map();
    for(const k of [...k5a,...k5b])allK5.set(k[0],k);
    const k5=Array.from(allK5.values()).sort((a,b)=>a[0]-b[0]);

    DATA[sym]={
      C:k5.map(k=>+k[4]),H:k5.map(k=>+k[2]),L:k5.map(k=>+k[3]),V:k5.map(k=>+k[5]),T:k5.map(k=>k[0]),O:k5.map(k=>+k[1]),
      C15:k15?k15.map(k=>+k[4]):[],H15:k15?k15.map(k=>+k[2]):[],L15:k15?k15.map(k=>+k[3]):[],T15:k15?k15.map(k=>k[0]):[],
      C1h:k1h?k1h.map(k=>+k[4]):[],H1h:k1h?k1h.map(k=>+k[2]):[],L1h:k1h?k1h.map(k=>+k[3]):[],V1h:k1h?k1h.map(k=>+k[5]):[],T1h:k1h?k1h.map(k=>k[0]):[],
      len:k5.length
    };
    console.log(` ${k5.length} bars (${(k5.length/288).toFixed(1)} days)`);
  }
}

// ═══ TRADE EVALUATION — Partial TP + Trailing ═══
function evalTrade(sig,entry,atr15,tpM,slM,tp1Ratio,maxBars,fH,fL,fC){
  const tp=atr15*tpM,sl=atr15*slM;const cost=entry*0.0008;
  const tp1=tp*tp1Ratio;
  const trail=atr15*0.1; // trailing stop distance
  const tp1P=sig==='BUY'?entry+tp1+cost:entry-tp1-cost;
  const slP=sig==='BUY'?entry-sl-cost:entry+sl+cost;
  const tpFullP=sig==='BUY'?entry+tp+cost:entry-tp-cost;

  let tp1Hit=false;let best=sig==='BUY'?-Infinity:Infinity;
  let exitBar=-1,exitType='timeout';

  for(let i=0;i<Math.min(maxBars,fH.length);i++){
    if(sig==='BUY'){
      if(!tp1Hit){
        if(fL[i]<=slP){exitBar=i;exitType='SL';return{pnl:-(sl+cost)/entry*100,exitBar,exitType};}
        if(fH[i]>=tp1P){tp1Hit=true;exitBar=i;}
      }
      if(tp1Hit){
        best=Math.max(best,fH[i]);
        if(fL[i]<=best-trail-cost){exitType='TRAIL';const r=(fC[i]-entry-cost)/entry*100;return{pnl:(tp1/entry*100)*0.5+r*0.5,exitBar:i,exitType};}
        if(fH[i]>=tpFullP){exitType='TP_FULL';return{pnl:(tp1/entry*100)*0.5+(tp/entry*100)*0.5,exitBar:i,exitType};}
        if(fL[i]<=entry){exitType='BE';return{pnl:(tp1/entry*100)*0.5,exitBar:i,exitType};}
      }
    }else{
      if(!tp1Hit){
        if(fH[i]>=slP){exitBar=i;exitType='SL';return{pnl:-(sl+cost)/entry*100,exitBar,exitType};}
        if(fL[i]<=tp1P){tp1Hit=true;exitBar=i;}
      }
      if(tp1Hit){
        best=Math.min(best,fL[i]);
        if(fH[i]>=best+trail+cost){exitType='TRAIL';const r=(entry-fC[i]-cost)/entry*100;return{pnl:(tp1/entry*100)*0.5+r*0.5,exitBar:i,exitType};}
        if(fL[i]<=tpFullP){exitType='TP_FULL';return{pnl:(tp1/entry*100)*0.5+(tp/entry*100)*0.5,exitBar:i,exitType};}
        if(fH[i]>=entry){exitType='BE';return{pnl:(tp1/entry*100)*0.5,exitBar:i,exitType};}
      }
    }
  }
  const last=fC[Math.min(maxBars,fH.length)-1]||entry;
  const uPnl=sig==='BUY'?(last-entry-cost)/entry*100:(entry-last-cost)/entry*100;
  return{pnl:tp1Hit?(tp1/entry*100)*0.5+uPnl*0.5:uPnl,exitBar:maxBars,exitType:'timeout'};
}

// ═══ GET INDICATORS AT BAR ═══
function getIndicators(d,bar,sym){
  const lookback=280;
  const s=Math.max(0,bar-lookback+1);
  const c=d.C.slice(s,bar+1),h=d.H.slice(s,bar+1),l=d.L.slice(s,bar+1),v=d.V.slice(s,bar+1);
  const bt=d.T[bar];const hUTC=new Date(bt).getUTCHours();
  const cur=c.at(-1);
  const atr=calcATR(h,l,c,14);const adxData=calcADX(h,l,c);
  const rsi=calcRSI(c,14);const mac=calcMACD(c);
  const ea9=calcEMAArr(c,9),ea21=calcEMAArr(c,21);
  const e9=ea9.at(-1),e21=ea21.at(-1),e50=calcEMA(c,50);
  const bb=calcBB(c,20,2);const stoch=calcStoch(h,l,c,14);
  const obvData=calcOBV(c,v);
  const regime=detectRegime(h,l,c,adxData,atr);
  const avgV=v.slice(-20).reduce((a,b)=>a+b)/20;const vr=v.at(-1)/avgV;

  // 15m data
  let c15e=0;for(let j=d.T15.length-1;j>=0;j--){if(d.T15[j]<=bt){c15e=j+1;break;}}
  const c15=d.C15.slice(Math.max(0,c15e-100),c15e);
  const h15=d.H15.slice(Math.max(0,c15e-100),c15e);
  const l15=d.L15.slice(Math.max(0,c15e-100),c15e);
  let mtfConfirm='NEUTRAL';
  if(c15.length>25){let mB=0,mS=0;if(calcEMA(c15,9)>calcEMA(c15,21))mB++;else mS++;if(calcMACD(c15).h>0)mB++;else mS++;const rsi15=calcRSI(c15,14);if(rsi15>50)mB+=0.5;else mS+=0.5;if(mB>mS)mtfConfirm='BUY';else if(mS>mB)mtfConfirm='SELL';}

  // ATR15
  let atr15=atr;
  if(h15.length>15&&l15.length>15&&c15.length>15){const a=calcATR(h15,l15,c15,14);if(a>0)atr15=a;}

  // 1H trend
  let htfTrend='NEUTRAL',htfStrength=0;
  let c1e=0;for(let j=d.T1h.length-1;j>=0;j--){if(d.T1h[j]<=bt){c1e=j+1;break;}}
  const c1h=d.C1h.slice(Math.max(0,c1e-50),c1e);const h1h=d.H1h.slice(Math.max(0,c1e-50),c1e);
  const l1h=d.L1h.slice(Math.max(0,c1e-50),c1e);const v1h=d.V1h.slice(Math.max(0,c1e-50),c1e);
  if(c1h.length>25){
    let hB=0,hS=0;
    if(calcEMA(c1h,9)>calcEMA(c1h,21))hB+=2;else hS+=2;
    if(c1h.at(-1)>calcEMA(c1h,50))hB+=1;else hS+=1;
    const m1h=calcMACD(c1h);if(m1h.h>0)hB+=1.5;else hS+=1.5;if(m1h.h>m1h.ph)hB+=1;else hS+=1;
    if(calcRSI(c1h,14)>50)hB+=1;else hS+=1;
    const a1h=calcADX(h1h,l1h,c1h);if(a1h.adx>20&&a1h.pdi>a1h.mdi)hB+=1.5;else if(a1h.adx>20&&a1h.mdi>a1h.pdi)hS+=1.5;
    if(calcOBV(c1h,v1h).rising)hB+=1;else hS+=1;
    if(hB>hS+2){htfTrend='BUY';htfStrength=hB-hS;}
    else if(hS>hB+2){htfTrend='SELL';htfStrength=hS-hB;}
  }

  // Blended ATR
  let atr1h=atr;
  if(h1h.length>15&&l1h.length>15&&c1h.length>15){const a=calcATR(h1h,l1h,c1h,14);if(a>0)atr1h=a;}
  const blendedATR=Math.max(atr15,atr1h/4);

  // Momentum
  const mom3=(cur-(c[c.length-4]||cur))/Math.max(atr,0.0001);

  // Candle exhaustion
  const last4=c.slice(-4);
  const bullExhausted=last4.length>=4&&last4.every((x,i)=>i===0||x>last4[i-1]);
  const bearExhausted=last4.length>=4&&last4.every((x,i)=>i===0||x<last4[i-1]);

  return{c,h,l,v,cur,atr,atr15,atr1h,blendedATR,adxData,rsi,mac,e9,e21,e50,bb,stoch,obvData,regime,vr,hUTC,bt,mtfConfirm,htfTrend,htfStrength,mom3,bullExhausted,bearExhausted,sym};
}

// ═══════════════════════════════════════════════════════════════
// MODE 1: VIP INSTITUTIONAL (strict mode) — Mean-reversion v2
// ═══════════════════════════════════════════════════════════════
function genVIP(ind){
  const{cur,atr,adxData,rsi,mac,e21,bb,stoch,obvData,regime,vr,hUTC,atr15,blendedATR}=ind;
  if(regime==='TRENDING')return null;

  let B=0,S=0,bI=0,sI=0;
  // RSI extremes
  if(rsi<25){B+=4;bI++;}else if(rsi<30){B+=3;bI++;}else if(rsi<35){B+=2;bI++;}
  else if(rsi>75){S+=4;sI++;}else if(rsi>70){S+=3;sI++;}else if(rsi>65){S+=2;sI++;}
  // Stoch
  if(stoch.k<20){B+=3;bI++;}else if(stoch.k<30){B+=2;bI++;}
  else if(stoch.k>80){S+=3;sI++;}else if(stoch.k>70){S+=2;sI++;}
  // BB
  const bbR=bb.u-bb.l;const bbP=bbR>0?(cur-bb.l)/bbR:0.5;
  if(bbP<0.1){B+=3;bI++;}else if(bbP<0.2){B+=2;bI++;}
  else if(bbP>0.9){S+=3;sI++;}else if(bbP>0.8){S+=2;sI++;}
  // Momentum contrarian
  const mom3=(cur-(ind.c[ind.c.length-4]||cur))/Math.max(atr,0.0001);
  if(mom3<-1){B+=2;bI++;}else if(mom3<-0.5){B+=1;bI++;}
  else if(mom3>1){S+=2;sI++;}else if(mom3>0.5){S+=1;sI++;}
  // Candle exhaustion
  let bearRun=0,bullRun=0;
  for(let i=Math.max(0,ind.c.length-4);i<ind.c.length;i++){
    if(ind.c[i]<(ind.c[i-1]||ind.c[i]))bearRun++;else bearRun=0;
    if(ind.c[i]>(ind.c[i-1]||ind.c[i]))bullRun++;else bullRun=0;
  }
  if(bearRun>=4){B+=2;bI++;}else if(bearRun>=3){B+=1;bI++;}
  if(bullRun>=4){S+=2;sI++;}else if(bullRun>=3){S+=1;sI++;}
  // EMA overextension
  const emaDist=(cur-e21)/Math.max(atr,0.0001);
  if(emaDist<-1.5){B+=1.5;bI++;}else if(emaDist<-0.8){B+=0.8;bI++;}
  else if(emaDist>1.5){S+=1.5;sI++;}else if(emaDist>0.8){S+=0.8;sI++;}
  // MACD cross (confirmation)
  if(mac.h>0&&mac.ph<=0){B+=1.5;bI++;}else if(mac.h<0&&mac.ph>=0){S+=1.5;sI++;}
  // OBV
  if(obvData.rising&&B>S){B+=1;bI++;}else if(!obvData.rising&&S>B){S+=1;sI++;}
  // Volume spike
  if(vr>1.5){if(B>S)B*=1.1;else S*=1.1;}

  // Decision: Conv≥8, Conds≥3
  let signal='NEUTRAL';
  if(B>S&&B>=8&&bI>=3)signal='BUY';
  else if(S>B&&S>=8&&sI>=3)signal='SELL';
  if(signal==='NEUTRAL')return null;

  // Filters
  if(adxData.adx>20)return null;
  if(hUTC===8||hUTC===21||hUTC===22)return null;
  if(regime==='VOLATILE')return null;
  // Min volatility
  if(atr15/cur<0.0008)return null;

  const useATR=blendedATR;
  return{signal,B,S,tpM:1.5,slM:1.0,tp1Ratio:0.60,maxBars:36,useATR};
}

// ═══════════════════════════════════════════════════════════════
// MODE 2: SCALP — Mean-reversion (cross-validated)
// ═══════════════════════════════════════════════════════════════
function genScalp(ind){
  const{cur,atr,adxData,rsi,mac,e21,bb,stoch,obvData,vr,hUTC,mtfConfirm,atr15}=ind;
  let B=0,S=0,bI=0,sI=0;

  // RSI (wider range than VIP)
  if(rsi<25){B+=4;bI++;}else if(rsi<30){B+=3;bI++;}else if(rsi<35){B+=2;bI++;}else if(rsi<40){B+=1;bI++;}
  else if(rsi>75){S+=4;sI++;}else if(rsi>70){S+=3;sI++;}else if(rsi>65){S+=2;sI++;}else if(rsi>60){S+=1;sI++;}
  // Stoch
  if(stoch.k<20){B+=3;bI++;}else if(stoch.k<30){B+=1.5;bI++;}
  else if(stoch.k>80){S+=3;sI++;}else if(stoch.k>70){S+=1.5;sI++;}
  // BB
  const bbR=bb.u-bb.l;const bbP=bbR>0?(cur-bb.l)/bbR:0.5;
  if(bbP<0.1){B+=3;bI++;}else if(bbP<0.2){B+=2;bI++;}
  else if(bbP>0.9){S+=3;sI++;}else if(bbP>0.8){S+=2;sI++;}
  // Momentum contrarian
  const mom3=(cur-(ind.c[ind.c.length-4]||cur))/Math.max(atr,0.0001);
  if(mom3<-1){B+=2;bI++;}else if(mom3<-0.5){B+=1;bI++;}
  else if(mom3>1){S+=2;sI++;}else if(mom3>0.5){S+=1;sI++;}
  // Candle exhaustion
  const last4=ind.c.slice(-4);
  const scalpBearExh=last4.length>=4&&last4.every((x,i)=>i===0||x<last4[i-1]);
  const scalpBullExh=last4.length>=4&&last4.every((x,i)=>i===0||x>last4[i-1]);
  if(scalpBearExh){B+=2;bI++;}if(scalpBullExh){S+=2;sI++;}
  // EMA overextension
  const emaDist=(cur-e21)/Math.max(atr,0.0001);
  if(emaDist<-1.5){B+=1.5;bI++;}else if(emaDist>1.5){S+=1.5;sI++;}
  // MACD CONTRARIAN (scalp: cross UP → SELL)
  if(mac.h>0&&mac.ph<0){S+=1;sI++;}else if(mac.h<0&&mac.ph>0){B+=1;bI++;}
  // Volume amplifier
  if(vr>1.5){if(B>S)B*=1.1;else S*=1.1;}

  // Decision: Conv≥6, Conds≥3
  let signal='NEUTRAL';
  if(B>S&&B>=6&&bI>=3)signal='BUY';
  else if(S>B&&S>=6&&sI>=3)signal='SELL';
  if(signal==='NEUTRAL')return null;

  // Filters
  if(adxData.adx>20)return null;
  if(signal==='BUY'&&mtfConfirm==='SELL')return null;
  if(signal==='SELL'&&mtfConfirm==='BUY')return null;
  if(hUTC>=0&&hUTC<6)return null;
  if(vr<0.3)return null;

  const useATR=atr15||atr;
  return{signal,B,S,tpM:1.0,slM:1.0,tp1Ratio:0.50,maxBars:24,useATR};
}

// ═══════════════════════════════════════════════════════════════
// MODE 3: ALTA FRECUENCIA (free mode)
// ═══════════════════════════════════════════════════════════════
function genFree(ind){
  const{cur,atr,adxData,rsi,mac,e9,e21,e50,obvData,vr,hUTC,htfTrend,htfStrength,blendedATR,regime}=ind;
  const isTrending=(regime==='TRENDING');
  let B=0,S=0,bI=0,sI=0;

  // Simple scoring (exact app.html free mode)
  if(rsi<30){B+=2;bI++;}else if(rsi>70){S+=2;sI++;}
  if(mac.h>0&&mac.ph<0){B+=2;bI++;}else if(mac.h<0&&mac.ph>0){S+=2;sI++;}
  if(e9>e21){B+=1;bI++;}else{S+=1;sI++;}
  if(adxData.adx>25&&adxData.pdi>adxData.mdi){B+=1;bI++;}
  else if(adxData.adx>25){S+=1;sI++;}
  if(obvData.rising){B+=0.5;bI++;}else{S+=0.5;sI++;}
  // Volume multiplier
  if(vr>1.5){if(B>S)B*=1.1;else S*=1.1;}

  // Decision
  const freeThr=isTrending?1.5:1.0;
  let signal='NEUTRAL';
  if(B>S&&B>=freeThr&&bI>=1)signal='BUY';
  else if(S>B&&S>=freeThr&&sI>=1)signal='SELL';
  if(signal==='NEUTRAL')return null;

  // Filters
  if(signal==='BUY'&&htfTrend==='SELL'&&htfStrength>4)return null;
  if(signal==='SELL'&&htfTrend==='BUY'&&htfStrength>4)return null;
  if(vr<0.4)return null;
  if(hUTC>=0&&hUTC<6)return null;

  const useATR=blendedATR;
  return{signal,B,S,tpM:1.2,slM:0.8,tp1Ratio:0.60,maxBars:24,useATR};
}

// ═══ MAIN BACKTEST ═══
async function main(){
  console.log('═'.repeat(75));
  console.log('  BACKTEST REAL 1 SEMANA — 3 Modos de Trading');
  console.log('  VIP Institucional | Scalp Mode | Alta Frecuencia');
  console.log('═'.repeat(75)+'\n');

  await loadData();

  const totalBars=Object.values(DATA)[0]?.len||0;
  const totalDays=totalBars/288;
  console.log(`\n  Período: ${totalDays.toFixed(1)} días | ${Object.keys(DATA).length} pares | ${totalBars} barras/par\n`);

  const modes=[
    {name:'VIP INSTITUCIONAL',fn:genVIP,cd:8,trades:[],color:'\x1b[33m'},
    {name:'SCALP MODE',fn:genScalp,cd:8,trades:[],color:'\x1b[36m'},
    {name:'ALTA FRECUENCIA',fn:genFree,cd:4,trades:[],color:'\x1b[32m'}
  ];

  const LB=280;
  const FUT=48;

  for(const mode of modes){
    const lastBar={};
    let maxDD=0,peak=0,equity=0;

    for(const sym of Object.keys(DATA)){
      const d=DATA[sym];
      for(let bar=LB;bar<d.len-FUT;bar++){
        const ind=getIndicators(d,bar,sym);
        const sig=mode.fn(ind);
        if(!sig)continue;

        // Cooldown
        const lb=lastBar[sym]||-999;
        if(bar-lb<mode.cd)continue;
        lastBar[sym]=bar;

        // Future data
        const fH=[],fL=[],fC=[];
        for(let f=bar+1;f<=Math.min(bar+FUT,d.len-1);f++){fH.push(d.H[f]);fL.push(d.L[f]);fC.push(d.C[f]);}

        const result=evalTrade(sig.signal,ind.cur,sig.useATR,sig.tpM,sig.slM,sig.tp1Ratio,sig.maxBars,fH,fL,fC);

        equity+=result.pnl;
        if(equity>peak)peak=equity;
        if(peak-equity>maxDD)maxDD=peak-equity;

        mode.trades.push({
          sym,signal:sig.signal,entry:ind.cur,pnl:result.pnl,
          exitType:result.exitType,exitBar:result.exitBar,
          hUTC:ind.hUTC,adx:ind.adxData.adx,regime:ind.regime,
          conv:Math.max(sig.B,sig.S),time:new Date(ind.bt).toISOString(),
          equity
        });
      }
    }
  }

  // ═══ RESULTS ═══
  console.log('═'.repeat(75));
  console.log('  RESULTADOS — BACKTEST REAL 1 SEMANA');
  console.log('═'.repeat(75)+'\n');

  // Summary table
  console.log('  ┌─────────────────────┬────────────┬────────────┬────────────┐');
  console.log('  │ Métrica             │ VIP INST.  │ SCALP MODE │ ALTA FREC. │');
  console.log('  ├─────────────────────┼────────────┼────────────┼────────────┤');

  for(const mode of modes){
    const t=mode.trades;
    const wins=t.filter(x=>x.pnl>0);const losses=t.filter(x=>x.pnl<=0);
    mode.stats={
      total:t.length,
      wins:wins.length,losses:losses.length,
      wr:t.length?(wins.length/t.length*100):0,
      pnl:t.reduce((a,x)=>a+x.pnl,0),
      avgPnl:t.length?t.reduce((a,x)=>a+x.pnl,0)/t.length:0,
      avgWin:wins.length?wins.reduce((a,x)=>a+x.pnl,0)/wins.length:0,
      avgLoss:losses.length?losses.reduce((a,x)=>a+x.pnl,0)/losses.length:0,
      pf:losses.length?(wins.reduce((a,x)=>a+x.pnl,0)/Math.abs(losses.reduce((a,x)=>a+x.pnl,0))):Infinity,
      spd:t.length/totalDays,
      best:t.length?Math.max(...t.map(x=>x.pnl)):0,
      worst:t.length?Math.min(...t.map(x=>x.pnl)):0,
      maxDD:0
    };
    // Max drawdown
    let pk=0,dd=0;for(const tr of t){pk=Math.max(pk,pk+tr.pnl);const eq=t.slice(0,t.indexOf(tr)+1).reduce((a,x)=>a+x.pnl,0);dd=Math.max(dd,pk-eq);}
    // recalc properly
    let eqC=0,peakC=0,maxDDC=0;for(const tr of t){eqC+=tr.pnl;if(eqC>peakC)peakC=eqC;if(peakC-eqC>maxDDC)maxDDC=peakC-eqC;}
    mode.stats.maxDD=maxDDC;
  }

  const row=(label,fn)=>{
    const vals=modes.map(m=>fn(m));
    console.log(`  │ ${label.padEnd(19)} │ ${vals[0].toString().padStart(10)} │ ${vals[1].toString().padStart(10)} │ ${vals[2].toString().padStart(10)} │`);
  };

  row('Total Trades',m=>m.stats.total);
  row('Trades/Día',m=>m.stats.spd.toFixed(1));
  row('Ganadas (W)',m=>m.stats.wins);
  row('Perdidas (L)',m=>m.stats.losses);
  row('Win Rate',m=>m.stats.wr.toFixed(1)+'%');
  console.log('  ├─────────────────────┼────────────┼────────────┼────────────┤');
  row('PnL Total',m=>(m.stats.pnl>=0?'+':'')+m.stats.pnl.toFixed(2)+'%');
  row('PnL/Trade Avg',m=>(m.stats.avgPnl>=0?'+':'')+m.stats.avgPnl.toFixed(3)+'%');
  row('Avg Win',m=>'+'+m.stats.avgWin.toFixed(3)+'%');
  row('Avg Loss',m=>m.stats.avgLoss.toFixed(3)+'%');
  row('Profit Factor',m=>m.stats.pf===Infinity?'∞':m.stats.pf.toFixed(2));
  row('Mejor Trade',m=>'+'+m.stats.best.toFixed(3)+'%');
  row('Peor Trade',m=>m.stats.worst.toFixed(3)+'%');
  row('Max Drawdown',m=>m.stats.maxDD.toFixed(2)+'%');
  console.log('  └─────────────────────┴────────────┴────────────┴────────────┘');

  // ═══ PnL if trading with $1000 (each mode) ═══
  console.log('\n  💰 SIMULACIÓN CON $1,000 CAPITAL (posición 2% riesgo):');
  for(const mode of modes){
    const capital=1000;
    let bal=capital;
    for(const t of mode.trades){
      const risk=bal*0.02; // 2% risk per trade
      const posSize=risk/Math.abs(mode.trades[0]?.pnl||1); // simplified
      bal+=bal*(t.pnl/100);
    }
    const profit=bal-capital;
    console.log(`    ${mode.name.padEnd(20)}: $${capital} → $${bal.toFixed(2)} (${profit>=0?'+':''}$${profit.toFixed(2)}, ${((bal/capital-1)*100).toFixed(1)}%)`);
  }

  // ═══ DETAILED BY SYMBOL ═══
  for(const mode of modes){
    console.log(`\n  ── ${mode.name} — POR SÍMBOLO ──`);
    const bySym={};
    for(const t of mode.trades){
      if(!bySym[t.sym])bySym[t.sym]={w:0,l:0,pnl:0,n:0};
      bySym[t.sym].n++;
      if(t.pnl>0)bySym[t.sym].w++;else bySym[t.sym].l++;
      bySym[t.sym].pnl+=t.pnl;
    }
    for(const[sym,d]of Object.entries(bySym).sort((a,b)=>b[1].pnl-a[1].pnl)){
      const wr=d.n?(d.w/d.n*100).toFixed(0):'0';
      console.log(`    ${sym.padEnd(10)} ${String(d.n).padStart(3)} trades, WR=${wr.padStart(3)}%, PnL=${(d.pnl>=0?'+':'')}${d.pnl.toFixed(2)}%`);
    }
  }

  // ═══ EXIT TYPE DISTRIBUTION ═══
  for(const mode of modes){
    console.log(`\n  ── ${mode.name} — TIPO DE SALIDA ──`);
    const byExit={};
    for(const t of mode.trades){
      if(!byExit[t.exitType])byExit[t.exitType]={n:0,pnl:0};
      byExit[t.exitType].n++;
      byExit[t.exitType].pnl+=t.pnl;
    }
    for(const[et,d]of Object.entries(byExit).sort((a,b)=>b[1].n-a[1].n)){
      const pct=mode.trades.length?(d.n/mode.trades.length*100).toFixed(0):0;
      console.log(`    ${et.padEnd(10)} ${String(d.n).padStart(4)} (${String(pct).padStart(2)}%) → PnL: ${(d.pnl>=0?'+':'')}${d.pnl.toFixed(2)}%`);
    }
  }

  // ═══ BY DIRECTION ═══
  for(const mode of modes){
    console.log(`\n  ── ${mode.name} — POR DIRECCIÓN ──`);
    for(const dir of ['BUY','SELL']){
      const dt=mode.trades.filter(t=>t.signal===dir);
      const dw=dt.filter(t=>t.pnl>0).length;
      const dp=dt.reduce((a,t)=>a+t.pnl,0);
      console.log(`    ${dir.padEnd(5)} ${String(dt.length).padStart(4)} trades, WR=${dt.length?(dw/dt.length*100).toFixed(0):'0'}%, PnL=${(dp>=0?'+':'')}${dp.toFixed(2)}%`);
    }
  }

  // ═══ DAILY P&L ═══
  console.log('\n  ── PnL DIARIO ──');
  const dayMs=24*60*60*1000;
  const firstTime=Math.min(...Object.values(DATA).map(d=>d.T[280]||0));
  for(let day=0;day<Math.ceil(totalDays);day++){
    const dayStart=firstTime+day*dayMs;const dayEnd=dayStart+dayMs;
    const row=modes.map(m=>{
      const dt=m.trades.filter(t=>new Date(t.time).getTime()>=dayStart&&new Date(t.time).getTime()<dayEnd);
      const dp=dt.reduce((a,t)=>a+t.pnl,0);
      return{n:dt.length,pnl:dp};
    });
    const dateStr=new Date(dayStart).toISOString().slice(0,10);
    console.log(`    ${dateStr} | VIP: ${String(row[0].n).padStart(3)}t ${(row[0].pnl>=0?'+':'')+row[0].pnl.toFixed(2).padStart(6)}% | Scalp: ${String(row[1].n).padStart(3)}t ${(row[1].pnl>=0?'+':'')+row[1].pnl.toFixed(2).padStart(6)}% | Free: ${String(row[2].n).padStart(3)}t ${(row[2].pnl>=0?'+':'')+row[2].pnl.toFixed(2).padStart(6)}%`);
  }

  // ═══ EQUITY CURVE (simplified) ═══
  console.log('\n  ── CURVA DE EQUITY (cada 20 trades) ──');
  for(const mode of modes){
    process.stdout.write(`    ${mode.name.padEnd(20)}: `);
    let eq=0;
    for(let i=0;i<mode.trades.length;i++){
      eq+=mode.trades[i].pnl;
      if(i%20===0||i===mode.trades.length-1){
        const bar=eq>0?'█':'░';
        process.stdout.write(eq>=0?'▲':'▼');
      }
    }
    console.log(` → ${(eq>=0?'+':'')}${eq.toFixed(2)}%`);
  }

  console.log('\n'+'═'.repeat(75));
  console.log('  ✅ Backtest completado — Resultados basados en datos reales de Binance');
  console.log('═'.repeat(75));
}

main().catch(e=>console.error(e));
