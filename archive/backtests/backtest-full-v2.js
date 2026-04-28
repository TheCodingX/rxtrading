#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════
// COMPREHENSIVE BACKTESTING v2 — Post-bugfix, with optimization tests
// Real Binance data, exact same logic as corrected app.html
// Tests: baseline + optimized hour filters + R:R variants + timeout variants
// ══════════════════════════════════════════════════════════════════════

const https = require('https');

const CAPITAL = 10000;
const POS_SIZE = 500;
const LEVERAGE = 5;
const FEE_RT = 0.0008;
const DAYS_TARGET = 14;

const VIP_PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','ADAUSDT','DOTUSDT','LINKUSDT','APTUSDT','NEARUSDT','ATOMUSDT','FILUSDT','UNIUSDT','ARBUSDT','OPUSDT','SHIBUSDT','TRXUSDT','SUIUSDT','SEIUSDT','TIAUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT'];
const SCALP_PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','DOTUSDT','NEARUSDT','APTUSDT'];
const FREE_PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];

const COOLDOWNS = { strict: 24, scalp: 12, frequent: 8 };

// ═══ INDICATOR FUNCTIONS (exact copy from app.html) ═══
function calcRSI(closes,p=14){if(closes.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}if(al===0)return 100;return 100-(100/(1+ag/al));}
function calcEMAArr(data,p){const k=2/(p+1);const r=[data[0]];for(let i=1;i<data.length;i++)r.push(data[i]*k+r[i-1]*(1-k));return r;}
function calcEMA(data,p){return calcEMAArr(data,p).at(-1);}
function calcMACD(closes){if(closes.length<35)return{h:0,ph:0,macd:0,sig:0};const e12=calcEMAArr(closes,12),e26=calcEMAArr(closes,26);const ml=e12.map((v,i)=>v-e26[i]);const sl=calcEMAArr(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1)),macd:ml.at(-1),sig:sl.at(-1)};}
function calcBB(closes,p=20,s=2){if(closes.length<p)return{u:0,m:0,l:0};const sl=closes.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+s*sd,m,l:m-s*sd};}
function calcStoch(H,L,C,kp=14){if(C.length<kp+3)return{k:50,d:50};const kArr=[];for(let i=kp;i<=C.length;i++){const sh=H.slice(i-kp,i),sl=L.slice(i-kp,i);const hi=Math.max(...sh),lo=Math.min(...sl);kArr.push(hi===lo?50:((C[i-1]-lo)/(hi-lo))*100);}const dArr=[];for(let i=2;i<kArr.length;i++)dArr.push((kArr[i]+kArr[i-1]+kArr[i-2])/3);return{k:kArr.at(-1)||50,d:dArr.at(-1)||50};}
function calcATR(H,L,C,p=14){if(C.length<p+1)return 0;const trs=[];for(let i=1;i<C.length;i++)trs.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));if(trs.length<p)return trs.reduce((a,b)=>a+b)/trs.length;let atr=trs.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<trs.length;i++)atr=(atr*(p-1)+trs[i])/p;return atr;}
function calcADX(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pdm=[],mdm=[],tr=[];for(let i=1;i<H.length;i++){const u=H[i]-H[i-1],d=L[i-1]-L[i];pdm.push(u>d&&u>0?u:0);mdm.push(d>u&&d>0?d:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}function ws(a,p){if(a.length<p)return a.map(()=>0);const r=[];let s=a.slice(0,p).reduce((x,y)=>x+y)/p;for(let i=0;i<p;i++)r.push(0);r[p-1]=s;for(let i=p;i<a.length;i++){s=(s*(p-1)+a[i])/p;r.push(s);}return r;}const sT=ws(tr,p),sP=ws(pdm,p),sM=ws(mdm,p);const pi=sP.map((v,i)=>sT[i]?v/sT[i]*100:0);const mi=sM.map((v,i)=>sT[i]?v/sT[i]*100:0);const dx=pi.map((v,i)=>{const s=v+mi[i];return s?Math.abs(v-mi[i])/s*100:0;});const dV=dx.slice(p-1);const aA=dV.length>=p?ws(dV,p):dV;return{adx:aA.at(-1)||15,pdi:pi.at(-1)||0,mdi:mi.at(-1)||0};}
function calcOBV(C,V){if(C.length<2)return{obv:0,slope:0,rising:false};let o=0;const a=[0];for(let i=1;i<C.length;i++){if(C[i]>C[i-1])o+=V[i];else if(C[i]<C[i-1])o-=V[i];a.push(o);}const n=Math.min(a.length,20);const r=a.slice(-n);let sX=0,sY=0,sXY=0,sX2=0;for(let i=0;i<n;i++){sX+=i;sY+=r[i];sXY+=i*r[i];sX2+=i*i;}const sl=(n*sXY-sX*sY)/(n*sX2-sX*sX||1);return{obv:a.at(-1),slope:sl,rising:sl>0};}
function calcParabolicSAR(H,L,C){if(C.length<5)return{sar:C.at(-1),trend:'BUY',recentFlip:false};let af=0.02,mx=0.2,sar=L[0],ep=H[0],up=true,lf=0;for(let i=1;i<C.length;i++){const p=sar+af*(ep-sar);if(up){sar=Math.min(p,L[i-1],i>1?L[i-2]:L[i-1]);if(L[i]<sar){up=false;sar=ep;ep=L[i];af=0.02;lf=i;}else{if(H[i]>ep){ep=H[i];af=Math.min(af+0.02,mx);}sar=p;}}else{sar=Math.max(p,H[i-1],i>1?H[i-2]:H[i-1]);if(H[i]>sar){up=true;sar=ep;ep=H[i];af=0.02;lf=i;}else{if(L[i]<ep){ep=L[i];af=Math.min(af+0.02,mx);}sar=p;}}}return{sar,trend:up?'BUY':'SELL',recentFlip:(C.length-1-lf)<=5};}
function calcKeltner(H,L,C,el=20,al=14,m=2){if(C.length<Math.max(el,al)+1)return{position:0.5};const mid=calcEMA(C,el);const a=calcATR(H,L,C,al);const u=mid+m*a,lo=mid-m*a,r=u-lo;return{position:r>0?(C.at(-1)-lo)/r:0.5};}
function detectRegime(H,L,C,adx,atr){const avg=C.slice(-20).reduce((a,b)=>a+b)/20;const p=atr/avg*100;if(adx.adx>25&&p>1.5)return{regime:'TRENDING'};if(adx.adx<20&&p<0.8)return{regime:'QUIET'};if(p>2)return{regime:'VOLATILE'};return{regime:'RANGING'};}
function detectRSIDivergence(C,H,L,p=14){if(C.length<30)return{bull:false,bear:false};const ra=[];for(let i=p+1;i<=C.length;i++)ra.push(calcRSI(C.slice(0,i),p));if(ra.length<10)return{bull:false,bear:false};const w=3,len=Math.min(ra.length,C.length);const cR=C.slice(-len),rR=ra.slice(-len);let bu=false,be=false;for(let i=len-1-w;i>=Math.max(0,len-10);i--){if(cR.at(-1)<cR[i]&&rR.at(-1)>rR[i])bu=true;if(cR.at(-1)>cR[i]&&rR.at(-1)<rR[i])be=true;}return{bull:bu,bear:be};}
function detectOrderBlocks(H,L,C,V,lb=50){let bOB=null,sOB=null;const n=Math.min(lb,C.length-1);for(let i=C.length-n;i<C.length-1;i++){const b=Math.abs(C[i]-(C[i-1]||C[i]));const a=C.slice(Math.max(0,i-10),i).reduce((s,c,j,arr)=>j>0?s+Math.abs(c-arr[j-1]):s,0)/10;if(b>a*2){if(C[i]>(C[i-1]||C[i])){if(!sOB||L[i]>sOB.price)sOB={price:L[i]};}else{if(!bOB||H[i]<bOB.price)bOB={price:H[i]};}}}return{bullOB:bOB,bearOB:sOB};}
function findPivotLevels(H,L,C,lb=50){const n=Math.min(lb,H.length);let nR=null,nS=null;const cur=C.at(-1);for(let i=H.length-n;i<H.length-2;i++){if(i<1)continue;if(H[i]>H[i-1]&&H[i]>H[i+1]){const d=H[i]-cur;if(d>0&&(!nR||d<nR-cur))nR=H[i];}if(L[i]<L[i-1]&&L[i]<L[i+1]){const d=cur-L[i];if(d>0&&(!nS||cur-L[i]<cur-nS))nS=L[i];}}return{nearestRes:nR,nearestSup:nS};}

// ═══ DATA FETCHING ═══
function fetchJSON(url){return new Promise((res,rej)=>{https.get(url,{timeout:15000},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}});}).on('error',rej).on('timeout',function(){this.destroy();rej(new Error('timeout'))})});}

async function getKlines(sym, tf, limit) {
  // Use startTime to get more data (Binance max 1000 per request)
  const allKlines = [];
  const interval = tf === '5m' ? 300000 : tf === '15m' ? 900000 : 3600000;
  let endTime = Date.now();
  const targetBars = Math.min(limit, 4032); // ~14 days of 5m

  while (allKlines.length < targetBars) {
    const batchSize = Math.min(1000, targetBars - allKlines.length);
    const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${batchSize}&endTime=${endTime}`;
    for (let att = 0; att < 3; att++) {
      try {
        const data = await fetchJSON(url);
        if (Array.isArray(data) && data.length > 0) {
          allKlines.unshift(...data);
          endTime = data[0][0] - 1; // Before first candle of this batch
          break;
        }
      } catch(e) {}
      await new Promise(r => setTimeout(r, 1000));
    }
    if (allKlines.length < 100 && targetBars > 1000) break; // API issue
    if (endTime < Date.now() - 30 * 24 * 3600000) break; // Don't go back > 30d
    await new Promise(r => setTimeout(r, 150)); // Rate limit
  }
  return allKlines.length > 0 ? allKlines : null;
}

// ═══ SIGNAL GENERATION ═══
function genSig(C5, H5, L5, V5, C15, H15, L15, C1h, H1h, L1h, V1h, barIdx, mode, hourUTC, opts = {}) {
  const isStrict = (mode === 'strict');
  const isScalp = (mode === 'scalp');
  if (barIdx < 50) return null;

  const cSlice = C5.slice(Math.max(0, barIdx - 279), barIdx + 1);
  const hSlice = H5.slice(Math.max(0, barIdx - 279), barIdx + 1);
  const lSlice = L5.slice(Math.max(0, barIdx - 279), barIdx + 1);
  const vSlice = V5.slice(Math.max(0, barIdx - 279), barIdx + 1);
  const cur = cSlice.at(-1);
  if (!cur || cur <= 0) return null;

  let B = 0, S = 0, buyInds = 0, sellInds = 0;

  // HTF Trend
  let htfTrend = 'NEUTRAL';
  if (C1h.length > 25) {
    let hB=0,hS=0;
    const e9h=calcEMA(C1h,9),e21h=calcEMA(C1h,21),e50h=calcEMA(C1h,50);
    const r1h=calcRSI(C1h,14),m1h=calcMACD(C1h),a1h=calcADX(H1h,L1h,C1h),o1h=calcOBV(C1h,V1h);
    if(e9h>e21h)hB+=2;else hS+=2;
    if(C1h.at(-1)>e50h)hB+=1;else hS+=1;
    if(m1h.h>0)hB+=1.5;else hS+=1.5;
    if(m1h.h>m1h.ph)hB+=1;else hS+=1;
    if(r1h>50)hB+=1;else hS+=1;
    if(a1h.adx>20&&a1h.pdi>a1h.mdi)hB+=1.5;else if(a1h.adx>20&&a1h.mdi>a1h.pdi)hS+=1.5;
    if(o1h.rising)hB+=1;else hS+=1;
    if(hB>hS+2)htfTrend='BUY';else if(hS>hB+2)htfTrend='SELL';
  }

  // MTF Confirm
  let mtfConfirm = 'NEUTRAL';
  if (C15.length > 25) {
    let mB=0,mS=0;
    if(calcEMA(C15,9)>calcEMA(C15,21))mB++;else mS++;
    if(calcMACD(C15).h>0)mB++;else mS++;
    const r15=calcRSI(C15,14);if(r15>50)mB+=0.5;else if(r15<50)mS+=0.5;
    if(mB>mS)mtfConfirm='BUY';else if(mS>mB)mtfConfirm='SELL';
  }

  // 5m Indicators
  const rsi=calcRSI(cSlice,14);
  const mac=calcMACD(cSlice);
  const ea9=calcEMAArr(cSlice,9),ea21=calcEMAArr(cSlice,21);
  const e9=ea9.at(-1),e21=ea21.at(-1),e9p=ea9.at(-2),e21p=ea21.at(-2);
  const e50=calcEMA(cSlice,50);
  const bb=calcBB(cSlice,20,2);
  const avgV=vSlice.slice(-20).reduce((a,b)=>a+b)/20;
  const vr=vSlice.at(-1)/avgV;
  const adxData=calcADX(hSlice,lSlice,cSlice);
  const obvData=calcOBV(cSlice,vSlice);
  const psar=calcParabolicSAR(hSlice,lSlice,cSlice);
  const stFull=calcStoch(hSlice,lSlice,cSlice,14);
  const kc=calcKeltner(hSlice,lSlice,cSlice,20,14,2);
  let orderBlocks={bullOB:null,bearOB:null};
  try{orderBlocks=detectOrderBlocks(hSlice,lSlice,cSlice,vSlice,50);}catch(e){}
  let atr=calcATR(hSlice,lSlice,cSlice,14);
  const rsiDiv=detectRSIDivergence(cSlice,hSlice,lSlice,14);
  let regime='RANGING';
  try{regime=detectRegime(hSlice,lSlice,cSlice,adxData,atr).regime||'RANGING';}catch(e){}
  const isTrending=(regime==='TRENDING'),isVolatile=(regime==='VOLATILE');

  // ═══ SCORING ═══
  if(isStrict && isTrending) {
    if(e9>e21&&e9p<=e21p){B+=2.5;}else if(e9<e21&&e9p>=e21p){S+=2.5;}else if(e9>e21){B+=0.5;}else{S+=0.5;}
    if(cur>e50){B+=0.5;}else{S+=0.5;}
    if(mac.h>0&&mac.ph<0){B+=2;}else if(mac.h<0&&mac.ph>0){S+=2;}else if(mac.h>0&&mac.h>mac.ph){B+=1;}else if(mac.h<0&&mac.h<mac.ph){S+=1;}
    if(adxData.pdi>adxData.mdi){B+=2;}else{S+=2;}
    if(obvData.rising){B+=1;}else{S+=1;}
    if(psar.recentFlip){if(psar.trend==='BUY')B+=1.5;else S+=1.5;}else{if(psar.trend==='BUY')B+=0.5;else S+=0.5;}
    if(cur>e50&&vr>0.7){B+=0.5;}else if(cur<e50&&vr>0.7){S+=0.5;}
    if(kc.position>1.0)B+=1;else if(kc.position<0)S+=1;else if(kc.position>0.7)B+=0.3;else if(kc.position<0.3)S+=0.3;
    if(orderBlocks.bullOB&&cur<=orderBlocks.bullOB.price*1.005)B+=1.5;else if(orderBlocks.bearOB&&cur>=orderBlocks.bearOB.price*0.995)S+=1.5;
    if(rsiDiv.bull)B+=2.5;else if(rsiDiv.bear)S+=2.5;
    buyInds=Math.round(B/1.5);sellInds=Math.round(S/1.5);
  } else if(isStrict && !isTrending) {
    if(rsi<25){B+=4;buyInds++;}else if(rsi<30){B+=3;buyInds++;}else if(rsi<35){B+=2;buyInds++;}
    else if(rsi>75){S+=4;sellInds++;}else if(rsi>70){S+=3;sellInds++;}else if(rsi>65){S+=2;sellInds++;}
    if(stFull.k<20){B+=3;buyInds++;}else if(stFull.k<30){B+=2;buyInds++;}
    else if(stFull.k>80){S+=3;sellInds++;}else if(stFull.k>70){S+=2;sellInds++;}
    const bbR=bb.u-bb.l,bbP=bbR>0?(cur-bb.l)/bbR:0.5;
    if(bbP<0.1){B+=3;buyInds++;}else if(bbP<0.2){B+=2;buyInds++;}
    else if(bbP>0.9){S+=3;sellInds++;}else if(bbP>0.8){S+=2;sellInds++;}
    const m3=(cur-(cSlice[cSlice.length-4]||cur))/Math.max(atr,0.0001);
    if(m3<-1){B+=2;buyInds++;}else if(m3<-0.5){B+=1;buyInds++;}
    else if(m3>1){S+=2;sellInds++;}else if(m3>0.5){S+=1;sellInds++;}
    let bR=0,uR=0;for(let ci=Math.max(0,cSlice.length-4);ci<cSlice.length;ci++){if(cSlice[ci]<(cSlice[ci-1]||cSlice[ci]))bR++;else bR=0;if(cSlice[ci]>(cSlice[ci-1]||cSlice[ci]))uR++;else uR=0;}
    if(bR>=4){B+=2;buyInds++;}else if(bR>=3){B+=1;buyInds++;}
    if(uR>=4){S+=2;sellInds++;}else if(uR>=3){S+=1;sellInds++;}
    const ed=(cur-e21)/Math.max(atr,0.0001);
    if(ed<-1.5){B+=1.5;buyInds++;}else if(ed<-0.8){B+=0.8;buyInds++;}
    else if(ed>1.5){S+=1.5;sellInds++;}else if(ed>0.8){S+=0.8;sellInds++;}
    if(mac.h>0&&mac.ph<=0){B+=1.5;buyInds++;}else if(mac.h<0&&mac.ph>=0){S+=1.5;sellInds++;}
    if(obvData.rising&&B>S){B+=1;buyInds++;}else if(!obvData.rising&&S>B){S+=1;sellInds++;}
    if(vr>1.5){if(B>S)B*=1.1;else S*=1.1;}
  } else if(isScalp) {
    const sk=stFull.k||50,bR2=bb.u-bb.l,bP2=bR2>0?(cur-bb.l)/bR2:0.5;
    const m3v=(cur-(cSlice[cSlice.length-4]||cur))/Math.max(atr,0.0001);
    const ed2=(cur-e21)/Math.max(atr,0.0001);
    const l4=cSlice.slice(-4);
    const sBE=l4.length>=4&&l4.every((x,i)=>i===0||x<l4[i-1]);
    const sUE=l4.length>=4&&l4.every((x,i)=>i===0||x>l4[i-1]);
    if(rsi<25){B+=4;buyInds++;}else if(rsi<30){B+=3;buyInds++;}else if(rsi<35){B+=2;buyInds++;}else if(rsi<40){B+=1;buyInds++;}
    else if(rsi>75){S+=4;sellInds++;}else if(rsi>70){S+=3;sellInds++;}else if(rsi>65){S+=2;sellInds++;}else if(rsi>60){S+=1;sellInds++;}
    if(sk<20){B+=3;buyInds++;}else if(sk<30){B+=1.5;buyInds++;}else if(sk>80){S+=3;sellInds++;}else if(sk>70){S+=1.5;sellInds++;}
    if(bP2<0.1){B+=3;buyInds++;}else if(bP2<0.2){B+=2;buyInds++;}else if(bP2>0.9){S+=3;sellInds++;}else if(bP2>0.8){S+=2;sellInds++;}
    if(m3v<-1){B+=2;buyInds++;}else if(m3v<-0.5){B+=1;buyInds++;}else if(m3v>1){S+=2;sellInds++;}else if(m3v>0.5){S+=1;sellInds++;}
    if(sBE){B+=2;buyInds++;}else if(sUE){S+=2;sellInds++;}
    if(ed2<-1.5){B+=1.5;buyInds++;}else if(ed2>1.5){S+=1.5;sellInds++;}
    if(mac.h>0&&mac.ph<0){S+=1;sellInds++;}else if(mac.h<0&&mac.ph>0){B+=1;buyInds++;}
    if(vr>1.5){if(B>S)B*=1.1;else S*=1.1;}
  } else {
    // FREE — corrected (no TDZ bugs)
    const fSk=stFull.k||50,fBR=bb.u-bb.l,fBP=fBR>0?(cur-bb.l)/fBR:0.5;
    if(rsi<28){B+=3;buyInds++;}else if(rsi<35){B+=2;buyInds++;}else if(rsi<40){B+=1;buyInds++;}
    else if(rsi>72){S+=3;sellInds++;}else if(rsi>65){S+=2;sellInds++;}else if(rsi>60){S+=1;sellInds++;}
    if(fSk<25){B+=2;buyInds++;}else if(fSk<35){B+=1;buyInds++;}else if(fSk>75){S+=2;sellInds++;}else if(fSk>65){S+=1;sellInds++;}
    if(fBP<0.15){B+=2;buyInds++;}else if(fBP<0.25){B+=1;buyInds++;}else if(fBP>0.85){S+=2;sellInds++;}else if(fBP>0.75){S+=1;sellInds++;}
    const fm3=(cur-(cSlice[cSlice.length-4]||cur))/Math.max(atr,0.0001);
    if(fm3<-0.8){B+=1;buyInds++;}else if(fm3>0.8){S+=1;sellInds++;}
    if(mac.h>0&&mac.ph<0){B+=1;buyInds++;}else if(mac.h<0&&mac.ph>0){S+=1;sellInds++;}
    if(obvData.rising)B+=0.5;else S+=0.5;
    if(vr>1.5){if(B>S)B*=1.1;else S*=1.1;}
  }

  // ═══ DECISION ENGINE ═══
  let signal='NEUTRAL',conf=0;

  // Get blocked hours from opts
  const extraBlockedHours = opts.extraBlockedHours || [];
  const tpMult = opts.tpMult || (isScalp ? 1.0 : 1.5);
  const slMult = opts.slMult || 1.0;

  if(isStrict){
    if(isTrending){}
    else if(B>S&&B>=8&&buyInds>=3)signal='BUY';
    else if(S>B&&S>=8&&sellInds>=3)signal='SELL';
    if(signal!=='NEUTRAL'&&adxData.adx>20)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&(hourUTC===8||hourUTC===21||hourUTC===22))signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&extraBlockedHours.includes(hourUTC))signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&isVolatile)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&atr/cur<0.0008)signal='NEUTRAL';
    if(signal!=='NEUTRAL'){
      const cs=signal==='BUY'?B:S,cc=signal==='BUY'?buyInds:sellInds;
      conf=Math.min(85,Math.round(50+cs*2.5+cc*1.5));
      if(htfTrend===signal)conf=Math.min(85,conf+5);
      if(mtfConfirm===signal)conf=Math.min(85,conf+3);
      if(rsiDiv.bull&&signal==='BUY')conf=Math.min(85,conf+3);
      if(rsiDiv.bear&&signal==='SELL')conf=Math.min(85,conf+3);
    }
  } else if(isScalp){
    if(B>S&&B>=6&&buyInds>=3)signal='BUY';
    else if(S>B&&S>=6&&sellInds>=3)signal='SELL';
    if(signal!=='NEUTRAL'&&adxData.adx>20)signal='NEUTRAL';
    if(signal==='BUY'&&mtfConfirm==='SELL')signal='NEUTRAL';
    if(signal==='SELL'&&mtfConfirm==='BUY')signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&hourUTC>=0&&hourUTC<6)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&extraBlockedHours.includes(hourUTC))signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&vr<0.3)signal='NEUTRAL';
    if(signal!=='NEUTRAL')conf=Math.min(85,Math.max(55,Math.round(50+Math.max(B,S)*3)));
  } else {
    if(B>S&&B>=5&&buyInds>=2)signal='BUY';
    else if(S>B&&S>=5&&sellInds>=2)signal='SELL';
    if(signal!=='NEUTRAL'&&isTrending)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&isVolatile)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&adxData.adx>30)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&hourUTC>=0&&hourUTC<6)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&extraBlockedHours.includes(hourUTC))signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&vr<0.4)signal='NEUTRAL';
    if(signal!=='NEUTRAL'){
      const cs=signal==='BUY'?B:S,cc=signal==='BUY'?buyInds:sellInds;
      conf=Math.min(75,Math.round(40+cs*2+cc*1.5));
    }
  }

  // TP/SL
  let atr15=atr,atr1h=atr*3.46;
  if(C15.length>15){const a=calcATR(H15,L15,C15,14);if(a>0)atr15=a;}
  if(C1h.length>15){const a=calcATR(H1h,L1h,C1h,14);if(a>0)atr1h=a;}
  const blATR=Math.max(atr15,atr1h/4);
  let useATR=isScalp?(atr15||blATR):blATR;
  let tpDist=useATR*tpMult, slDist=useATR*slMult;
  if(isScalp){const m=cur*0.0015;if(tpDist<m)tpDist=m;if(slDist<m)slDist=m;}
  else{const m=cur*0.0012;if(tpDist<m)tpDist=m;if(slDist<m*0.67)slDist=m*0.67;}
  if(!isStrict&&!isScalp&&tpDist<slDist*1.2)tpDist=slDist*1.2;
  const cb=cur*0.0008;

  return{signal,conf,B,S,buyInds,sellInds,entry:cur,
    tp:signal==='BUY'?cur+tpDist+cb:signal==='SELL'?cur-tpDist-cb:null,
    sl:signal==='BUY'?cur-slDist-cb:signal==='SELL'?cur+slDist+cb:null,
    tpDist,slDist,atr,regime,adx:adxData.adx,rsi,vr,hourUTC};
}

// ═══ TRADE SIMULATOR ═══
function simulate(signals, H5, L5, C5, mode, timeoutBars = 50) {
  const trades=[], cds={}, cd=COOLDOWNS[mode];
  for(const s of signals){
    const last=cds[s.sym]||-999;
    if(s.barIdx-last<cd)continue;
    const h=H5[s.sym],l=L5[s.sym],c=C5[s.sym];
    let ep=null,eb=null,er=null;
    for(let j=s.barIdx+1;j<Math.min(s.barIdx+1+timeoutBars,c.length);j++){
      if(s.signal==='BUY'){if(l[j]<=s.sl){ep=s.sl;eb=j;er='SL';break;}if(h[j]>=s.tp){ep=s.tp;eb=j;er='TP';break;}}
      else{if(h[j]>=s.sl){ep=s.sl;eb=j;er='SL';break;}if(l[j]<=s.tp){ep=s.tp;eb=j;er='TP';break;}}
    }
    if(!ep){eb=Math.min(s.barIdx+timeoutBars,c.length-1);ep=c[eb];er='TIMEOUT';}
    const pp=s.signal==='BUY'?(ep-s.entry)/s.entry:(s.entry-ep)/s.entry;
    trades.push({sym:s.sym,dir:s.signal,entry:s.entry,exitPrice:ep,barIdx:s.barIdx,exitBar:eb,exitReason:er,
      duration:(eb-s.barIdx)*5,pnlPct:pp*100,pnlNet:(pp*POS_SIZE*LEVERAGE)-(POS_SIZE*LEVERAGE*FEE_RT),
      conf:s.conf,regime:s.regime,adx:s.adx,rsi:s.rsi,hour:s.hourUTC});
    cds[s.sym]=s.barIdx;
  }
  return trades;
}

function analyze(trades, name, days) {
  if(!trades.length){console.log(`\n  ${name}: NO TRADES`);return null;}
  const w=trades.filter(t=>t.pnlNet>0),l=trades.filter(t=>t.pnlNet<=0);
  const wr=w.length/trades.length*100;
  const total=trades.reduce((s,t)=>s+t.pnlNet,0);
  const gp=w.reduce((s,t)=>s+t.pnlNet,0),gl=Math.abs(l.reduce((s,t)=>s+t.pnlNet,0));
  const pf=gl>0?gp/gl:99;
  const avgDur=trades.reduce((s,t)=>s+t.duration,0)/trades.length;
  let eq=CAPITAL,pk=CAPITAL,mdd=0;
  const daily={};
  for(const t of trades){eq+=t.pnlNet;pk=Math.max(pk,eq);mdd=Math.max(mdd,(pk-eq)/pk*100);const d=Math.floor(t.barIdx/288);daily[d]=(daily[d]||0)+t.pnlNet;}
  const avgW=w.length?gp/w.length:0,avgL=l.length?gl/l.length:0;
  const exp=(wr/100*avgW)-((1-wr/100)*avgL);
  let mcw=0,mcl=0,cw2=0,cl2=0;
  for(const t of trades){if(t.pnlNet>0){cw2++;cl2=0;mcw=Math.max(mcw,cw2);}else{cl2++;cw2=0;mcl=Math.max(mcl,cl2);}}

  const byReason={},byPair={},byHour={},byRegime={};
  for(const t of trades){
    byReason[t.exitReason]=byReason[t.exitReason]||{n:0,p:0};byReason[t.exitReason].n++;byReason[t.exitReason].p+=t.pnlNet;
    byPair[t.sym]=byPair[t.sym]||{n:0,w:0,p:0};byPair[t.sym].n++;if(t.pnlNet>0)byPair[t.sym].w++;byPair[t.sym].p+=t.pnlNet;
    byHour[t.hour]=byHour[t.hour]||{n:0,w:0,p:0};byHour[t.hour].n++;if(t.pnlNet>0)byHour[t.hour].w++;byHour[t.hour].p+=t.pnlNet;
    byRegime[t.regime]=byRegime[t.regime]||{n:0,w:0,p:0};byRegime[t.regime].n++;if(t.pnlNet>0)byRegime[t.regime].w++;byRegime[t.regime].p+=t.pnlNet;
  }

  const dRet=Object.values(daily);
  const avgD=dRet.reduce((s,v)=>s+v,0)/dRet.length;
  const stdD=Math.sqrt(dRet.reduce((s,v)=>s+Math.pow(v-avgD,2),0)/dRet.length);
  const sharpe=stdD>0?(avgD/stdD)*Math.sqrt(365):0;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${name}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Trades: ${trades.length} (BUY:${trades.filter(t=>t.dir==='BUY').length} SELL:${trades.filter(t=>t.dir==='SELL').length}) | ${(trades.length/days).toFixed(1)} señales/día`);
  console.log(`  WR: ${wr.toFixed(1)}% | PnL: $${total.toFixed(2)} (${(total/CAPITAL*100).toFixed(2)}%) | PF: ${pf.toFixed(2)} | MaxDD: ${mdd.toFixed(2)}%`);
  console.log(`  Avg Duration: ${avgDur.toFixed(0)}min | Expectancy: $${exp.toFixed(2)}/trade | Sharpe: ${sharpe.toFixed(2)}`);
  console.log(`  Avg Win: $${avgW.toFixed(2)} | Avg Loss: $${avgL.toFixed(2)} | ConsWins: ${mcw} | ConsLoss: ${mcl}`);

  console.log(`  Exit: ${Object.entries(byReason).map(([k,v])=>`${k}=${v.n}($${v.p.toFixed(0)})`).join(' | ')}`);
  console.log(`  Regime: ${Object.entries(byRegime).sort((a,b)=>b[1].p-a[1].p).map(([k,v])=>`${k}=${v.n}t WR${(v.w/v.n*100).toFixed(0)}% $${v.p.toFixed(0)}`).join(' | ')}`);

  const ps=Object.entries(byPair).sort((a,b)=>b[1].p-a[1].p);
  console.log(`  Top 3: ${ps.slice(0,3).map(([k,v])=>`${k}=${v.n}t WR${(v.w/v.n*100).toFixed(0)}% $${v.p.toFixed(0)}`).join(' | ')}`);
  console.log(`  Bot 3: ${ps.slice(-3).map(([k,v])=>`${k}=${v.n}t WR${(v.w/v.n*100).toFixed(0)}% $${v.p.toFixed(0)}`).join(' | ')}`);

  console.log(`  Hours:`);
  Object.entries(byHour).sort((a,b)=>parseInt(a[0])-parseInt(b[0])).forEach(([h,d])=>{
    const bar=d.p>0?'🟢':'🔴';
    console.log(`    H${h.padStart(2,'0')}: ${bar} ${d.n}t WR=${(d.w/d.n*100).toFixed(0)}% $${d.p.toFixed(0)}`);
  });

  console.log(`  Daily:`);
  Object.entries(daily).sort((a,b)=>parseInt(a[0])-parseInt(b[0])).forEach(([d,p])=>{
    console.log(`    Day${d}: ${p>0?'🟢':'🔴'} $${p.toFixed(2)}`);
  });

  return{trades:trades.length,wr,total,pf,mdd,avgDur,exp,sharpe,spd:trades.length/days,byHour,byPair};
}

// ═══ MAIN ═══
async function main() {
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('  BACKTESTING v2 — POST-BUGFIX, 14-DAY REAL DATA');
  console.log(`  Capital: $${CAPITAL} | Pos: $${POS_SIZE} | Lev: ${LEVERAGE}x | Fee: ${FEE_RT*100}%`);
  console.log('══════════════════════════════════════════════════════════════════════\n');

  const allPairs=[...new Set([...VIP_PAIRS,...SCALP_PAIRS,...FREE_PAIRS])];
  console.log(`Fetching ${allPairs.length} pairs × 3 timeframes (paginated for 14 days)...\n`);

  const data={};
  for(const sym of allPairs){
    process.stdout.write(`  ${sym}... `);
    try{
      const [k5,k15,k1h]=await Promise.all([
        getKlines(sym,'5m',4032),  // 14d
        getKlines(sym,'15m',1500), // 15d
        getKlines(sym,'1h',400)    // 16d
      ]);
      if(!k5||k5.length<500){console.log(`SKIP (${k5?.length||0})`);continue;}
      data[sym]={
        C5:k5.map(k=>parseFloat(k[4])),H5:k5.map(k=>parseFloat(k[2])),L5:k5.map(k=>parseFloat(k[3])),V5:k5.map(k=>parseFloat(k[5])),ts:k5.map(k=>k[0]),
        C15:k15?k15.map(k=>parseFloat(k[4])):[],H15:k15?k15.map(k=>parseFloat(k[2])):[],L15:k15?k15.map(k=>parseFloat(k[3])):[],
        C1h:k1h?k1h.map(k=>parseFloat(k[4])):[],H1h:k1h?k1h.map(k=>parseFloat(k[2])):[],L1h:k1h?k1h.map(k=>parseFloat(k[3])):[],V1h:k1h?k1h.map(k=>parseFloat(k[5])):[]
      };
      console.log(`OK (${k5.length} bars = ${(k5.length/288).toFixed(1)}d)`);
    }catch(e){console.log(`ERR: ${e.message}`);}
    await new Promise(r=>setTimeout(r,250));
  }

  const actualDays = Math.min(...Object.values(data).map(d => d.C5.length / 288));
  console.log(`\nData ready. Coverage: ~${actualDays.toFixed(1)} days\n`);

  // ═══ BASELINE TESTS ═══
  const configs = [
    { name: 'VIP INSTITUCIONAL (baseline)', mode: 'strict', pairs: VIP_PAIRS, opts: {} },
    { name: 'VIP INSTITUCIONAL (block H17,H19)', mode: 'strict', pairs: VIP_PAIRS, opts: { extraBlockedHours: [17, 19] } },
    { name: 'SCALP MODE (baseline)', mode: 'scalp', pairs: SCALP_PAIRS, opts: {} },
    { name: 'SCALP MODE (block H21)', mode: 'scalp', pairs: SCALP_PAIRS, opts: { extraBlockedHours: [21] } },
    { name: 'SCALP MODE (R:R 1.2:1)', mode: 'scalp', pairs: SCALP_PAIRS, opts: { tpMult: 1.2, slMult: 1.0 } },
    { name: 'FREE MODE (baseline)', mode: 'frequent', pairs: FREE_PAIRS, opts: {} },
    { name: 'FREE + block H7,H8,H16,H17,H22', mode: 'frequent', pairs: FREE_PAIRS, opts: { extraBlockedHours: [7, 8, 16, 17, 22] } },
  ];

  const summaries = [];

  for (const cfg of configs) {
    console.log(`\n⏳ ${cfg.name}...`);
    const sigs = [];
    for (const sym of cfg.pairs) {
      if (!data[sym]) continue;
      const d = data[sym];
      const start = Math.max(280, d.C5.length - Math.round(actualDays * 288));
      for (let i = start; i < d.C5.length - 1; i++) {
        const h = new Date(d.ts[i]).getUTCHours();
        const s = genSig(d.C5, d.H5, d.L5, d.V5, d.C15, d.H15, d.L15, d.C1h, d.H1h, d.L1h, d.V1h, i, cfg.mode, h, cfg.opts);
        if (s && s.signal !== 'NEUTRAL') sigs.push({ ...s, sym, barIdx: i, hourUTC: h });
      }
    }
    sigs.sort((a, b) => a.barIdx - b.barIdx);
    const H5m = {}, L5m = {}, C5m = {};
    for (const sym of cfg.pairs) { if (data[sym]) { H5m[sym] = data[sym].H5; L5m[sym] = data[sym].L5; C5m[sym] = data[sym].C5; } }

    // Test different timeouts
    const trades = simulate(sigs, H5m, L5m, C5m, cfg.mode, 50);
    const r = analyze(trades, cfg.name, actualDays);
    if (r) summaries.push({ name: cfg.name, ...r });

    // Extra: test timeout 30 and 80 for baseline configs
    if (cfg.name.includes('baseline')) {
      for (const to of [30, 80]) {
        const t2 = simulate(sigs, H5m, L5m, C5m, cfg.mode, to);
        if (t2.length > 0) {
          const w2 = t2.filter(t => t.pnlNet > 0);
          const tot2 = t2.reduce((s, t) => s + t.pnlNet, 0);
          const gl2 = Math.abs(t2.filter(t => t.pnlNet <= 0).reduce((s, t) => s + t.pnlNet, 0));
          const gp2 = w2.reduce((s, t) => s + t.pnlNet, 0);
          console.log(`  → Timeout ${to}: ${t2.length}t WR=${(w2.length/t2.length*100).toFixed(1)}% PnL=$${tot2.toFixed(0)} PF=${(gl2>0?gp2/gl2:99).toFixed(2)}`);
        }
      }
    }
  }

  // ═══ EXECUTIVE SUMMARY ═══
  console.log(`\n${'═'.repeat(80)}`);
  console.log('  RESUMEN EJECUTIVO — TODOS LOS MOTORES Y VARIANTES');
  console.log(`${'═'.repeat(80)}`);
  console.log(`\n  ${'Config'.padEnd(42)} ${'Tr'.padStart(5)} ${'WR%'.padStart(6)} ${'PnL$'.padStart(9)} ${'PnL%'.padStart(7)} ${'PF'.padStart(6)} ${'DD%'.padStart(6)} ${'S/D'.padStart(5)} ${'Exp$'.padStart(6)}`);
  console.log('  '+'─'.repeat(92));
  for(const s of summaries){
    console.log(`  ${s.name.padEnd(42)} ${String(s.trades).padStart(5)} ${s.wr.toFixed(1).padStart(6)} ${('$'+s.total.toFixed(0)).padStart(9)} ${(s.total/CAPITAL*100).toFixed(1).padStart(6)}% ${s.pf.toFixed(2).padStart(6)} ${s.mdd.toFixed(1).padStart(5)}% ${s.spd.toFixed(1).padStart(5)} ${('$'+s.exp.toFixed(2)).padStart(6)}`);
  }

  console.log(`\n  VEREDICTO:`);
  for(const s of summaries){
    const verdict = s.total > 0 && s.pf > 1.1 ? '✅ RENTABLE' : s.total > 0 ? '⚠️ MARGINAL' : '❌ NO RENTABLE';
    console.log(`    ${verdict} — ${s.name}`);
  }

  console.log('\n  Done.');
}

main().catch(console.error);
