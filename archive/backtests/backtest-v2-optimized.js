#!/usr/bin/env node
/**
 * OPTIMIZED BACKTEST v2 — Tests parameter changes to maximize PnL + signal volume
 * Changes vs baseline:
 * 1. Remove toxic pairs (APT, NEAR, AVAX for scalp; APT, NEAR, SEI for strict)
 * 2. Open more hours (test wider windows)
 * 3. Open all days (scalp was blocking 3/7)
 * 4. Lower cooldown for more signals
 * 5. Implement TP1 partial + trailing stop (breakeven after TP1)
 * 6. Test lower conviction thresholds
 */

const https = require('https');

const CAPITAL = 10000;
const POSITION_SIZE = 500;
const LEVERAGE = 5;
const FEE_RATE = 0.0008;
const TIMEOUT_BARS = 50;
const DAYS = 14;

// ═══ OPTIMIZED PAIR LISTS ═══
// Removed consistently losing pairs from baseline backtest
const VIP_PAIRS_V2 = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','AVAXUSDT','ADAUSDT','DOTUSDT','LINKUSDT','FILUSDT','UNIUSDT','ARBUSDT','OPUSDT','SHIBUSDT','SUIUSDT','TIAUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT'];
// Removed APT(-59), NEAR(-34), SEI kept (was +$286 in scalp)
const SCALP_PAIRS_V2 = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','ADAUSDT','DOTUSDT','ARBUSDT','OPUSDT','SUIUSDT','FILUSDT','UNIUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT','TIAUSDT','ATOMUSDT'];

// ═══ CONFIGS TO TEST ═══
const CONFIGS = {
  strict_final: {
    mode: 'strict',
    pairs: VIP_PAIRS_V2,
    cooldown: 8,   // 40min cooldown → ~2x signals
    allowedHours: [6,7,13,14,19,20,21,22,23], // PROVEN 9 profitable hours (from baseline)
    blockedDays: [6], // Saturday blocked (proven toxic)
    minConv: 7,    // slightly relaxed — quality over quantity
    minConds: 3,
    adxMax: 22,    // slightly relaxed — only range/quiet
    useTP1Partial: true, // YES: boosts WR to >60%
    tpMult: 1.5,
    slMult: 1.0,
  },
  scalp_final: {
    mode: 'scalp',
    pairs: SCALP_PAIRS_V2,
    cooldown: 3,   // 15min cooldown for high volume
    allowedHours: [0,1,6,7,9,10,11,12,13,14,17,18,19,20,21,23], // 16h, removed H02-05(dead) H08/H16/H22(toxic)
    blockedDays: [1,2], // Mon+Tue blocked (proven toxic: -$1267 combined)
    minConv: 4,
    minConds: 2,
    adxMax: 25,
    useTP1Partial: true,
    tpMult: 1.3,
    slMult: 1.0,
    dominanceFilter: 1.3,
  },
};

// ═══ INDICATOR CALCULATIONS (same as backtest-definitive.js) ═══
function calcRSI(closes,p=14){if(closes.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}if(al===0)return 100;return 100-(100/(1+ag/al));}
function calcEMAArr(data,p){const k=2/(p+1);const r=[data[0]];for(let i=1;i<data.length;i++)r.push(data[i]*k+r[i-1]*(1-k));return r;}
function calcEMA(data,p){return calcEMAArr(data,p).at(-1);}
function calcMACD(closes){if(closes.length<35)return{h:0,ph:0,macd:0,sig:0};const e12=calcEMAArr(closes,12),e26=calcEMAArr(closes,26);const ml=e12.map((v,i)=>v-e26[i]);const sl=calcEMAArr(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1)),macd:ml.at(-1),sig:sl.at(-1)};}
function calcBB(closes,p=20,s=2){if(closes.length<p)return{u:0,m:0,l:0};const sl=closes.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+s*sd,m,l:m-s*sd};}
function calcStoch(H,L,C,kp=14){if(C.length<kp+3)return{k:50,d:50};const kArr=[];for(let i=kp;i<=C.length;i++){const sh=H.slice(i-kp,i),sl=L.slice(i-kp,i);const hi=Math.max(...sh),lo=Math.min(...sl);kArr.push(hi===lo?50:((C[i-1]-lo)/(hi-lo))*100);}const dArr=[];for(let i=2;i<kArr.length;i++)dArr.push((kArr[i]+kArr[i-1]+kArr[i-2])/3);return{k:kArr.at(-1)||50,d:dArr.at(-1)||50};}
function calcATR(H,L,C,p=14){if(C.length<p+1)return 0;const trs=[];for(let i=1;i<C.length;i++)trs.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));if(trs.length<p)return trs.reduce((a,b)=>a+b)/trs.length;let atr=trs.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<trs.length;i++)atr=(atr*(p-1)+trs[i])/p;return atr;}
function wilderSmooth(arr,period){if(arr.length<period)return arr.map(()=>0);const r=[];let s=arr.slice(0,period).reduce((a,b)=>a+b)/period;for(let i=0;i<period;i++)r.push(0);r[period-1]=s;for(let i=period;i<arr.length;i++){s=(s*(period-1)+arr[i])/period;r.push(s);}return r;}
function calcADX(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pdm=[],mdm=[],tr=[];for(let i=1;i<H.length;i++){const u=H[i]-H[i-1],d=L[i-1]-L[i];pdm.push(u>d&&u>0?u:0);mdm.push(d>u&&d>0?d:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}const smTR=wilderSmooth(tr,p),smPDM=wilderSmooth(pdm,p),smMDM=wilderSmooth(mdm,p);const pdi=smPDM.map((v,i)=>smTR[i]?v/smTR[i]*100:0);const mdi=smMDM.map((v,i)=>smTR[i]?v/smTR[i]*100:0);const dx=pdi.map((v,i)=>{const s=v+mdi[i];return s?Math.abs(v-mdi[i])/s*100:0;});const dxV=dx.slice(p-1);const adxArr=dxV.length>=p?wilderSmooth(dxV,p):dxV;return{adx:adxArr.at(-1)||15,pdi:pdi.at(-1)||0,mdi:mdi.at(-1)||0};}
function calcOBV(C,V){if(C.length<2)return{obv:0,slope:0,rising:false};let obv=0;const arr=[0];for(let i=1;i<C.length;i++){if(C[i]>C[i-1])obv+=V[i];else if(C[i]<C[i-1])obv-=V[i];arr.push(obv);}const n=Math.min(arr.length,20);const recent=arr.slice(-n);let sumX=0,sumY=0,sumXY=0,sumX2=0;for(let i=0;i<n;i++){sumX+=i;sumY+=recent[i];sumXY+=i*recent[i];sumX2+=i*i;}const slope=(n*sumXY-sumX*sumY)/(n*sumX2-sumX*sumX||1);return{obv:arr.at(-1),slope,rising:slope>0};}
function calcKeltner(H,L,C,emaLen=20,atrLen=14,mult=2){if(C.length<Math.max(emaLen,atrLen)+1)return{upper:0,mid:0,lower:0,width:0,position:0.5};const mid=calcEMA(C,emaLen);const atr=calcATR(H,L,C,atrLen);const upper=mid+mult*atr;const lower=mid-mult*atr;const width=upper-lower;const position=width>0?(C.at(-1)-lower)/width:0.5;return{upper,mid,lower,width,position};}
function calcVWAP(klines){let cumVol=0,cumVolPrice=0;const vwapArr=[];for(const k of klines){const typPrice=(parseFloat(k[2])+parseFloat(k[3])+parseFloat(k[4]))/3;const vol=parseFloat(k[5]);cumVol+=vol;cumVolPrice+=(typPrice*vol);vwapArr.push(cumVolPrice/cumVol);}return vwapArr;}
function calcParabolicSAR(H,L,C){if(C.length<5)return{sar:C.at(-1),trend:'BUY',recentFlip:false};let af=0.02,maxAf=0.2,sar=L[0],ep=H[0],isUp=true;let lastFlipIdx=0;for(let i=1;i<C.length;i++){const pSar=sar+af*(ep-sar);if(isUp){sar=Math.min(pSar,L[i-1],i>1?L[i-2]:L[i-1]);if(L[i]<sar){isUp=false;sar=ep;ep=L[i];af=0.02;lastFlipIdx=i;}else{if(H[i]>ep){ep=H[i];af=Math.min(af+0.02,maxAf);}sar=pSar;}}else{sar=Math.max(pSar,H[i-1],i>1?H[i-2]:H[i-1]);if(H[i]>sar){isUp=true;sar=ep;ep=H[i];af=0.02;lastFlipIdx=i;}else{if(L[i]<ep){ep=L[i];af=Math.min(af+0.02,maxAf);}sar=pSar;}}}const recentFlip=(C.length-1-lastFlipIdx)<=5;return{sar,trend:isUp?'BUY':'SELL',recentFlip};}
function detectRSIDivergence(C,H,L,period=14){if(C.length<period+25)return{bull:false,bear:false};const rsiArr=[];let ag=0,al=0;for(let i=1;i<=period;i++){const d=C[i]-C[i-1];if(d>0)ag+=d;else al+=Math.abs(d);}ag/=period;al/=period;rsiArr.push(al===0?100:100-(100/(1+ag/al)));for(let i=period+1;i<C.length;i++){const d=C[i]-C[i-1];ag=(ag*(period-1)+(d>0?d:0))/period;al=(al*(period-1)+(d<0?Math.abs(d):0))/period;rsiArr.push(al===0?100:100-(100/(1+ag/al)));}const lookback=Math.min(30,L.length-5);const start=L.length-lookback;let bull=false,bear=false;for(let i=start+5;i<L.length-3;i++){if(L[i]<L[i-3]&&L[i]<L[i+3]){for(let j=i+5;j<Math.min(i+20,L.length-1);j++){if(j+2<L.length&&L[j]<L[j-2]&&L[j]<L[j+2]){const rsiI=rsiArr[i-period]||50;const rsiJ=rsiArr[j-period]||50;if(L[j]<L[i]&&rsiJ>rsiI){bull=true;break;}}}}if(bull)break;}for(let i=start+5;i<H.length-3;i++){if(H[i]>H[i-3]&&H[i]>H[i+3]){for(let j=i+5;j<Math.min(i+20,H.length-1);j++){if(j+2<H.length&&H[j]>H[j-2]&&H[j]>H[j+2]){const rsiI=rsiArr[i-period]||50;const rsiJ=rsiArr[j-period]||50;if(H[j]>H[i]&&rsiJ<rsiI){bear=true;break;}}}}if(bear)break;}return{bull,bear};}
function detectMACDDivergence(C){if(C.length<40)return{bull:false,bear:false};const mac=calcMACD(C);const bull=mac.h>mac.ph&&mac.h<0&&C.at(-1)<C.at(-5);const bear=mac.h<mac.ph&&mac.h>0&&C.at(-1)>C.at(-5);return{bull,bear};}
function detectRegime(H,L,C,adxPre,atrPre){const adx=adxPre||calcADX(H,L,C);const atr=atrPre||calcATR(H,L,C,14);const avgP=C.slice(-20).reduce((a,b)=>a+b)/20;const atrPct=atr/avgP*100;if(adx.adx>25&&atrPct>1.5)return{regime:'TRENDING'};if(adx.adx<20&&atrPct<0.8)return{regime:'QUIET'};if(atrPct>2)return{regime:'VOLATILE'};return{regime:'RANGING'};}
function detectOrderBlocks(H,L,C,V,lookback=50){if(C.length<lookback)return{bullOB:null,bearOB:null};const tail=C.length-lookback;let bullOB=null,bearOB=null;const avgV=V.slice(tail).reduce((a,b)=>a+b)/(lookback||1);for(let i=tail+2;i<C.length-1;i++){const body=Math.abs(C[i]-C[i-1]);const prevBody=Math.abs(C[i-1]-C[i-2]);const isImbalance=prevBody>0&&body>prevBody*2;const isHighVol=V[i]>avgV*1.5;if(isImbalance&&isHighVol){if(C[i]>C[i-1])bullOB={price:Math.min(C[i-1],L[i]),high:H[i],idx:i};else bearOB={price:Math.max(C[i-1],H[i]),low:L[i],idx:i};}}const cur=C.at(-1);const atr=calcATR(H,L,C,14);if(bullOB&&(cur-bullOB.price)>atr*2)bullOB=null;if(bullOB&&(bullOB.price-cur)>atr*1)bullOB=null;if(bearOB&&(bearOB.price-cur)>atr*2)bearOB=null;if(bearOB&&(cur-bearOB.price)>atr*1)bearOB=null;return{bullOB,bearOB};}
function findPivotLevels(H,L,C,lookback=50){const start=Math.max(0,C.length-lookback);const cur=C.at(-1);let nearestSup=null,nearestRes=null;for(let i=start+2;i<C.length-2;i++){if(L[i]<L[i-1]&&L[i]<L[i-2]&&L[i]<L[i+1]&&L[i]<L[i+2]){if(L[i]<cur&&(!nearestSup||L[i]>nearestSup))nearestSup=L[i];}if(H[i]>H[i-1]&&H[i]>H[i-2]&&H[i]>H[i+1]&&H[i]>H[i+2]){if(H[i]>cur&&(!nearestRes||H[i]<nearestRes))nearestRes=H[i];}}return{nearestSup,nearestRes};}

// ═══ SIGNAL GENERATION — Same scoring as app.html but with configurable params ═══
function generateSignal(C5,H5,L5,V5,C15,H15,L15,V15,C1h,H1h,L1h,V1h,kl5raw,hourUTC,config) {
  const isStrict = (config.mode === 'strict');
  const isScalp = (config.mode === 'scalp');
  const cur = C5.at(-1);
  let B=0,S=0;
  const inds=[];

  // HTF
  let htfTrend='NEUTRAL';
  if(C1h.length>25){const ema9h=calcEMA(C1h,9),ema21h=calcEMA(C1h,21),ema50h=calcEMA(C1h,50);const rsi1h=calcRSI(C1h,14);const mac1h=calcMACD(C1h);const adx1h=calcADX(H1h,L1h,C1h);const obv1h=calcOBV(C1h,V1h);let hB=0,hS=0;if(ema9h>ema21h)hB+=2;else hS+=2;if(C1h.at(-1)>ema50h)hB+=1;else hS+=1;if(mac1h.h>0)hB+=1.5;else hS+=1.5;if(mac1h.h>mac1h.ph)hB+=1;else hS+=1;if(rsi1h>50)hB+=1;else hS+=1;if(adx1h.adx>20&&adx1h.pdi>adx1h.mdi)hB+=1.5;else if(adx1h.adx>20&&adx1h.mdi>adx1h.pdi)hS+=1.5;if(obv1h.rising)hB+=1;else hS+=1;if(hB>hS+2)htfTrend='BUY';else if(hS>hB+2)htfTrend='SELL';}

  // MTF
  let mtfConfirm='NEUTRAL';
  if(C15.length>25){const ema9_15=calcEMA(C15,9),ema21_15=calcEMA(C15,21);const mac15=calcMACD(C15);let mB=0,mS=0;if(ema9_15>ema21_15)mB+=1;else mS+=1;if(mac15.h>0)mB+=1;else mS+=1;const rsi15=calcRSI(C15,14);if(rsi15>50)mB+=0.5;else if(rsi15<50)mS+=0.5;if(mB>mS)mtfConfirm='BUY';else if(mS>mB)mtfConfirm='SELL';}

  // 5m indicators
  const rsi=calcRSI(C5,14);const mac=calcMACD(C5);
  const ea9=calcEMAArr(C5,9),ea21=calcEMAArr(C5,21);
  const e9=ea9.at(-1),e21=ea21.at(-1),e9p=ea9.at(-2),e21p=ea21.at(-2);
  const e50=calcEMA(C5,50);
  const bb=calcBB(C5,20,2);
  const avgV=V5.slice(-20).reduce((a,b)=>a+b)/20,lv=V5.at(-1),vr=lv/avgV;
  const adxData=calcADX(H5,L5,C5);
  const obvData=calcOBV(C5,V5);
  const stFull=calcStoch(H5,L5,C5,14);
  let atr=calcATR(H5,L5,C5,14);
  const rsiDiv=detectRSIDivergence(C5,H5,L5,14);
  const macdDiv=detectMACDDivergence(C5);
  let regimeData=detectRegime(H5,L5,C5,adxData,atr);
  const regime=regimeData.regime||'RANGING';
  const isTrending=(regime==='TRENDING');
  const isVolatile=(regime==='VOLATILE');
  const kc=calcKeltner(H5,L5,C5,20,14,2);
  let orderBlocks={bullOB:null,bearOB:null};
  try{orderBlocks=detectOrderBlocks(H5,L5,C5,V5,50);}catch(e){}

  // ═══ SCORING (same as app.html for each mode) ═══
  if(isStrict&&isTrending){
    if(e9>e21&&e9p<=e21p){B+=2.5;}else if(e9<e21&&e9p>=e21p){S+=2.5;}
    else if(e9>e21){B+=0.5;}else{S+=0.5;}
    if(cur>e50)B+=0.5;else S+=0.5;
    if(mac.h>0&&mac.ph<0)B+=2;else if(mac.h<0&&mac.ph>0)S+=2;
    else if(mac.h>0&&mac.h>mac.ph)B+=1;else if(mac.h<0&&mac.h<mac.ph)S+=1;
    if(adxData.pdi>adxData.mdi){B+=2;inds.push({s:'BUY'});}else{S+=2;inds.push({s:'SELL'});}
    if(obvData.rising){B+=1;inds.push({s:'BUY'});}else{S+=1;inds.push({s:'SELL'});}
    const psar=calcParabolicSAR(H5,L5,C5);
    if(psar.recentFlip){if(psar.trend==='BUY'){B+=1.5;inds.push({s:'BUY'});}else{S+=1.5;inds.push({s:'SELL'});}}
    else{if(psar.trend==='BUY'){B+=0.5;inds.push({s:'BUY'});}else{S+=0.5;inds.push({s:'SELL'});}}
    const vwapArr=calcVWAP(kl5raw.slice(-50));const vwap=vwapArr.at(-1);
    if(cur>vwap&&vr>0.7){B+=0.5;inds.push({s:'BUY'});}else if(cur<vwap&&vr>0.7){S+=0.5;inds.push({s:'SELL'});}
    if(kc.position>1.0){B+=1;inds.push({s:'BUY'});}else if(kc.position<0){S+=1;inds.push({s:'SELL'});}
    if(orderBlocks.bullOB&&cur<=orderBlocks.bullOB.price*1.005){B+=1.5;inds.push({s:'BUY'});}
    else if(orderBlocks.bearOB&&cur>=orderBlocks.bearOB.price*0.995){S+=1.5;inds.push({s:'SELL'});}
    if(rsiDiv.bull){B+=2.5;inds.push({s:'BUY'});}else if(rsiDiv.bear){S+=2.5;inds.push({s:'SELL'});}
    if(macdDiv.bull){B+=2;inds.push({s:'BUY'});}else if(macdDiv.bear){S+=2;inds.push({s:'SELL'});}
    // Add counts for trend-following mode
    if(e9>e21)inds.push({s:'BUY'});else inds.push({s:'SELL'});
    if(cur>e50)inds.push({s:'BUY'});else inds.push({s:'SELL'});
    if(mac.h>0)inds.push({s:'BUY'});else if(mac.h<0)inds.push({s:'SELL'});
  } else if(isStrict&&!isTrending){
    if(rsi<25){B+=4;inds.push({s:'BUY'});}
    else if(rsi<30){B+=3;inds.push({s:'BUY'});}
    else if(rsi<35){B+=2;inds.push({s:'BUY'});}
    else if(rsi>75){S+=4;inds.push({s:'SELL'});}
    else if(rsi>70){S+=3;inds.push({s:'SELL'});}
    else if(rsi>65){S+=2;inds.push({s:'SELL'});}
    if(stFull.k<20){B+=3;inds.push({s:'BUY'});}
    else if(stFull.k<30){B+=2;inds.push({s:'BUY'});}
    else if(stFull.k>80){S+=3;inds.push({s:'SELL'});}
    else if(stFull.k>70){S+=2;inds.push({s:'SELL'});}
    const bbR=bb.u-bb.l;const bbPos=bbR>0?(cur-bb.l)/bbR:0.5;
    if(bbPos<0.1){B+=3;inds.push({s:'BUY'});}
    else if(bbPos<0.2){B+=2;inds.push({s:'BUY'});}
    else if(bbPos>0.9){S+=3;inds.push({s:'SELL'});}
    else if(bbPos>0.8){S+=2;inds.push({s:'SELL'});}
    const mom3=(cur-(C5[C5.length-4]||cur))/Math.max(atr,0.0001);
    if(mom3<-1){B+=2;inds.push({s:'BUY'});}else if(mom3<-0.5){B+=1;inds.push({s:'BUY'});}
    else if(mom3>1){S+=2;inds.push({s:'SELL'});}else if(mom3>0.5){S+=1;inds.push({s:'SELL'});}
    let bearRun=0,bullRun=0;
    for(let ci=Math.max(0,C5.length-4);ci<C5.length;ci++){if(C5[ci]<(C5[ci-1]||C5[ci]))bearRun++;else bearRun=0;if(C5[ci]>(C5[ci-1]||C5[ci]))bullRun++;else bullRun=0;}
    if(bearRun>=4){B+=2;inds.push({s:'BUY'});}else if(bearRun>=3){B+=1;inds.push({s:'BUY'});}
    if(bullRun>=4){S+=2;inds.push({s:'SELL'});}else if(bullRun>=3){S+=1;inds.push({s:'SELL'});}
    const emaDist=(cur-e21)/Math.max(atr,0.0001);
    if(emaDist<-1.5){B+=1.5;inds.push({s:'BUY'});}else if(emaDist<-0.8){B+=0.8;inds.push({s:'BUY'});}
    else if(emaDist>1.5){S+=1.5;inds.push({s:'SELL'});}else if(emaDist>0.8){S+=0.8;inds.push({s:'SELL'});}
    if(mac.h>0&&mac.ph<=0){B+=1.5;inds.push({s:'BUY'});}else if(mac.h<0&&mac.ph>=0){S+=1.5;inds.push({s:'SELL'});}
    if(obvData.rising&&B>S){B+=1;inds.push({s:'BUY'});}else if(!obvData.rising&&S>B){S+=1;inds.push({s:'SELL'});}
    if(vr>1.5){if(B>S)B*=1.15;else S*=1.15;}
    if(kc.position<0.05){B+=2;inds.push({s:'BUY'});}else if(kc.position<0.15){B+=1;inds.push({s:'BUY'});}
    else if(kc.position>0.95){S+=2;inds.push({s:'SELL'});}else if(kc.position>0.85){S+=1;inds.push({s:'SELL'});}
    if(rsiDiv.bull){B+=3;inds.push({s:'BUY'});}else if(rsiDiv.bear){S+=3;inds.push({s:'SELL'});}
    if(macdDiv.bull){B+=2;inds.push({s:'BUY'});}else if(macdDiv.bear){S+=2;inds.push({s:'SELL'});}
  } else if(isScalp){
    const stochK=stFull.k||50;const bbRange=bb.u-bb.l;const bbP=bbRange>0?(cur-bb.l)/bbRange:0.5;
    const mom3val=(cur-(C5[C5.length-4]||cur))/Math.max(atr,0.0001);
    const emaDist21=(cur-e21)/Math.max(atr,0.0001);
    const last4=C5.slice(-4);
    const scalpBullExh=last4.length>=4&&last4.every((x,i)=>i===0||x>last4[i-1]);
    const scalpBearExh=last4.length>=4&&last4.every((x,i)=>i===0||x<last4[i-1]);
    if(rsi<25){B+=4;inds.push({s:'BUY'});}else if(rsi<30){B+=3;inds.push({s:'BUY'});}
    else if(rsi<38){B+=2;inds.push({s:'BUY'});}else if(rsi<45){B+=1;inds.push({s:'BUY'});}
    else if(rsi>75){S+=4;inds.push({s:'SELL'});}else if(rsi>70){S+=3;inds.push({s:'SELL'});}
    else if(rsi>62){S+=2;inds.push({s:'SELL'});}else if(rsi>55){S+=1;inds.push({s:'SELL'});}
    if(stochK<20){B+=3;inds.push({s:'BUY'});}else if(stochK<35){B+=1.5;inds.push({s:'BUY'});}
    else if(stochK>80){S+=3;inds.push({s:'SELL'});}else if(stochK>65){S+=1.5;inds.push({s:'SELL'});}
    if(bbP<0.1){B+=3;inds.push({s:'BUY'});}else if(bbP<0.25){B+=2;inds.push({s:'BUY'});}
    else if(bbP>0.9){S+=3;inds.push({s:'SELL'});}else if(bbP>0.75){S+=2;inds.push({s:'SELL'});}
    if(mom3val<-0.8){B+=2;inds.push({s:'BUY'});}else if(mom3val<-0.3){B+=1;inds.push({s:'BUY'});}
    else if(mom3val>0.8){S+=2;inds.push({s:'SELL'});}else if(mom3val>0.3){S+=1;inds.push({s:'SELL'});}
    if(scalpBearExh){B+=2;inds.push({s:'BUY'});}else if(scalpBullExh){S+=2;inds.push({s:'SELL'});}
    else{const l3=C5.slice(-3);if(l3.length>=3&&l3.every((x,i)=>i===0||x<l3[i-1])){B+=1;inds.push({s:'BUY'});}else if(l3.length>=3&&l3.every((x,i)=>i===0||x>l3[i-1])){S+=1;inds.push({s:'SELL'});}}
    if(emaDist21<-1.2){B+=1.5;inds.push({s:'BUY'});}else if(emaDist21<-0.6){B+=0.8;inds.push({s:'BUY'});}
    else if(emaDist21>1.2){S+=1.5;inds.push({s:'SELL'});}else if(emaDist21>0.6){S+=0.8;inds.push({s:'SELL'});}
    if(mac.h>0&&mac.ph<0){S+=1;inds.push({s:'SELL'});}else if(mac.h<0&&mac.ph>0){B+=1;inds.push({s:'BUY'});}
    else if(mac.h>0&&mac.h>mac.ph){S+=0.5;inds.push({s:'SELL'});}else if(mac.h<0&&mac.h<mac.ph){B+=0.5;inds.push({s:'BUY'});}
    if(obvData.rising&&B>S){B+=0.8;inds.push({s:'BUY'});}else if(!obvData.rising&&S>B){S+=0.8;inds.push({s:'SELL'});}
    if(kc.position<0.05){B+=1.5;inds.push({s:'BUY'});}else if(kc.position<0.2){B+=0.8;inds.push({s:'BUY'});}
    else if(kc.position>0.95){S+=1.5;inds.push({s:'SELL'});}else if(kc.position>0.8){S+=0.8;inds.push({s:'SELL'});}
    if(rsiDiv.bull){B+=2;inds.push({s:'BUY'});}else if(rsiDiv.bear){S+=2;inds.push({s:'SELL'});}
    if(vr>1.5){if(B>S)B*=1.15;else S*=1.15;}
  }

  if(!isScalp){if(vr>1.5&&B>S)B*=1.1;else if(vr>1.5&&S>B)S*=1.1;}

  const buyInds=inds.filter(i=>i.s==='BUY').length;
  const sellInds=inds.filter(i=>i.s==='SELL').length;

  let signal='NEUTRAL';let conf=50;

  if(isStrict){
    if(isTrending){/* block in strict mean-reversion */}
    else if(B>S&&B>=config.minConv&&buyInds>=config.minConds)signal='BUY';
    else if(S>B&&S>=config.minConv&&sellInds>=config.minConds)signal='SELL';
    if(signal!=='NEUTRAL'&&adxData.adx>config.adxMax)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&!config.allowedHours.includes(hourUTC))signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&isVolatile)signal='NEUTRAL';
    // Volatility floor
    if(signal!=='NEUTRAL'){const atr15=C15.length>15?calcATR(H15,L15,C15,14):atr;if(atr15/cur<0.0008)signal='NEUTRAL';}
    if(signal!=='NEUTRAL'){
      const convScore=signal==='BUY'?B:S;const condCount=signal==='BUY'?buyInds:sellInds;
      conf=Math.min(90,Math.round(50+convScore*2.5+condCount*1.5));
      if(htfTrend===signal)conf=Math.min(90,conf+5);
      if(mtfConfirm===signal)conf=Math.min(90,conf+3);
      if(rsiDiv.bull&&signal==='BUY')conf=Math.min(90,conf+4);
      if(rsiDiv.bear&&signal==='SELL')conf=Math.min(90,conf+4);
    }
  } else if(isScalp){
    if(B>S&&B>=config.minConv&&buyInds>=config.minConds)signal='BUY';
    else if(S>B&&S>=config.minConv&&sellInds>=config.minConds)signal='SELL';
    if(signal!=='NEUTRAL'&&adxData.adx>config.adxMax)signal='NEUTRAL';
    const scalpMaxConv=Math.max(B,S);
    if(signal==='BUY'&&mtfConfirm==='SELL'&&scalpMaxConv<7)signal='NEUTRAL';
    if(signal==='SELL'&&mtfConfirm==='BUY'&&scalpMaxConv<7)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&!config.allowedHours.includes(hourUTC))signal='NEUTRAL';
    const domFilter=config.dominanceFilter||1.4;
    if(signal!=='NEUTRAL'&&Math.max(B,S)<Math.min(B,S)*domFilter)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&vr<0.3)signal='NEUTRAL';
    if(signal!=='NEUTRAL'){
      const maxConv=Math.max(B,S);const condCount=signal==='BUY'?buyInds:sellInds;
      conf=Math.min(88,Math.max(52,Math.round(48+maxConv*2.5+condCount*2)));
      if(htfTrend===signal)conf=Math.min(88,conf+4);
      if(mtfConfirm===signal)conf=Math.min(88,conf+3);
    }
  }

  // TP/SL
  let atr15=atr;if(H15.length>15)try{const a=calcATR(H15,L15,C15,14);if(a>0)atr15=a;}catch(e){}
  let atr1h=atr;if(H1h.length>15)try{const a=calcATR(H1h,L1h,C1h,14);if(a>0)atr1h=a;}catch(e){}
  const blendedATR=Math.max(atr15,atr1h/4);
  const useATR=isScalp?(atr15||blendedATR):blendedATR;
  let tpDist=useATR*config.tpMult;
  let slDist=useATR*config.slMult;
  const minTP=cur*(isScalp?0.0015:0.0012);
  if(tpDist<minTP)tpDist=minTP;if(slDist<minTP*(isScalp?1:0.67))slDist=minTP*(isScalp?1:0.67);
  const costBuffer=cur*0.0008;

  // S/R filter
  if(signal!=='NEUTRAL'){try{let pH=H5,pL=L5,pC=C5;if(H1h.length>20){pH=H1h;pL=L1h;pC=C1h;}const pivots=findPivotLevels(pH,pL,pC,50);if(signal==='BUY'&&pivots.nearestRes){const d=pivots.nearestRes-cur;if(d>0&&d<tpDist*0.7){if(d>slDist*1.2)tpDist=d*0.92;else signal='NEUTRAL';}}if(signal==='SELL'&&pivots.nearestSup){const d=cur-pivots.nearestSup;if(d>0&&d<tpDist*0.7){if(d>slDist*1.2)tpDist=d*0.92;else signal='NEUTRAL';}}}catch(e){}}

  const tp=signal==='BUY'?cur+tpDist+costBuffer:signal==='SELL'?cur-tpDist-costBuffer:null;
  const sl=signal==='BUY'?cur-slDist-costBuffer:signal==='SELL'?cur+slDist+costBuffer:null;
  const tp1Dist=tpDist*(isScalp?0.50:0.60);
  const tp1=signal==='BUY'?cur+tp1Dist+costBuffer:signal==='SELL'?cur-tp1Dist-costBuffer:null;

  return{signal,confidence:conf,B,S,entry:cur,tp,tp1,sl,tpDist,slDist,tp1Dist,atr,regime,adx:adxData.adx,rsi,vr,htfTrend,mtfConfirm};
}

// ═══ DATA FETCHING ═══
function fetchJSON(url){return new Promise((resolve,reject)=>{https.get(url,(res)=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});}).on('error',reject);});}
async function getKlines(sym,interval,limit,endTime){let url=`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;if(endTime)url+=`&endTime=${endTime}`;try{return await fetchJSON(url);}catch(e){return[];}}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function fetchAllData(sym,days){
  const now=Date.now();const barsNeeded=(days*24*60)/5;const warmup=280;
  const all5m=[];let endT=now;
  while(all5m.length<barsNeeded+warmup){const batch=await getKlines(sym,'5m',1000,endT);if(!batch||!batch.length)break;all5m.unshift(...batch);endT=batch[0][0]-1;await sleep(100);}
  const all15m=[];endT=now;const bars15m=Math.ceil((days*24*60)/15)+100;
  while(all15m.length<bars15m){const batch=await getKlines(sym,'15m',1000,endT);if(!batch||!batch.length)break;all15m.unshift(...batch);endT=batch[0][0]-1;await sleep(100);}
  const all1h=await getKlines(sym,'1h',Math.min(500,days*24+50));await sleep(100);
  return{kl5:all5m,kl15:all15m,kl1h:all1h||[]};
}

// ═══ BACKTESTING ENGINE WITH TP1 PARTIAL + TRAILING STOP ═══
async function runBacktest(configName){
  const config=CONFIGS[configName];
  const pairs=config.pairs;
  const cooldownBars=config.cooldown;
  const useTP1=config.useTP1Partial;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  BACKTEST: ${configName.toUpperCase()} — ${DAYS} days, ${pairs.length} pairs`);
  console.log(`  Hours: ${config.allowedHours.length}/24 | Cooldown: ${cooldownBars} bars | Conv: ${config.minConv} | ADX<${config.adxMax}`);
  console.log(`  TP1 Partial: ${useTP1?'YES':'NO'} | Blocked days: ${config.blockedDays.length?config.blockedDays.join(','):'None'}`);
  console.log(`${'═'.repeat(70)}\n`);

  const allTrades=[];
  const pnlByHour=new Array(24).fill(0);
  const tradesByHour=new Array(24).fill(0);
  const tradesByPair={};
  const tradesByDay=new Array(7).fill(null).map(()=>({trades:0,pnl:0,wins:0}));

  for(const sym of pairs){
    process.stdout.write(`  ${sym}...`);
    let data;try{data=await fetchAllData(sym,DAYS);}catch(e){console.log(` ERR`);continue;}
    if(!data.kl5||data.kl5.length<300){console.log(` skip`);continue;}

    const testStart=Date.now()-DAYS*24*60*60*1000;
    let startIdx=280;
    for(let i=280;i<data.kl5.length;i++){if(data.kl5[i][0]>=testStart){startIdx=i;break;}}

    const trades=[];let lastSignalBar=-cooldownBars;let openTrade=null;

    for(let i=startIdx;i<data.kl5.length;i++){
      const bar=data.kl5[i];const barTime=bar[0];
      const barH=parseFloat(bar[2]),barL=parseFloat(bar[3]),barC=parseFloat(bar[4]);
      const hourUTC=new Date(barTime).getUTCHours();
      const dayOfWeek=new Date(barTime).getUTCDay();

      // Check open trade (WITH TP1 partial system)
      if(openTrade){
        openTrade.barsHeld++;

        if(openTrade.signal==='BUY'){
          // Check TP1 first (partial close)
          if(useTP1&&!openTrade.tp1Hit&&barH>=openTrade.tp1){
            openTrade.tp1Hit=true;
            openTrade.tp1Pnl=((openTrade.tp1-openTrade.entry)/openTrade.entry)*LEVERAGE*(POSITION_SIZE*0.5)-(POSITION_SIZE*0.5*FEE_RATE);
            openTrade.sl=openTrade.entry; // Move SL to breakeven for remaining 50%
          }
          if(barL<=openTrade.sl){
            openTrade.exitPrice=openTrade.sl;openTrade.exitReason=openTrade.tp1Hit?'TP1+BE':'SL';
            const remaining=openTrade.tp1Hit?0.5:1;
            openTrade.pnl=((openTrade.sl-openTrade.entry)/openTrade.entry)*LEVERAGE*(POSITION_SIZE*remaining)-(POSITION_SIZE*remaining*FEE_RATE);
            if(openTrade.tp1Hit)openTrade.pnl+=openTrade.tp1Pnl;
            trades.push(openTrade);openTrade=null;
          }else if(barH>=openTrade.tp){
            openTrade.exitPrice=openTrade.tp;openTrade.exitReason=openTrade.tp1Hit?'TP1+TP2':'TP';
            const remaining=openTrade.tp1Hit?0.5:1;
            openTrade.pnl=((openTrade.tp-openTrade.entry)/openTrade.entry)*LEVERAGE*(POSITION_SIZE*remaining)-(POSITION_SIZE*remaining*FEE_RATE);
            if(openTrade.tp1Hit)openTrade.pnl+=openTrade.tp1Pnl;
            trades.push(openTrade);openTrade=null;
          }else if(openTrade.barsHeld>=TIMEOUT_BARS){
            openTrade.exitPrice=barC;openTrade.exitReason='TIMEOUT';
            const remaining=openTrade.tp1Hit?0.5:1;
            openTrade.pnl=((barC-openTrade.entry)/openTrade.entry)*LEVERAGE*(POSITION_SIZE*remaining)-(POSITION_SIZE*remaining*FEE_RATE);
            if(openTrade.tp1Hit)openTrade.pnl+=openTrade.tp1Pnl;
            trades.push(openTrade);openTrade=null;
          }
        }else{ // SELL
          if(useTP1&&!openTrade.tp1Hit&&barL<=openTrade.tp1){
            openTrade.tp1Hit=true;
            openTrade.tp1Pnl=((openTrade.entry-openTrade.tp1)/openTrade.entry)*LEVERAGE*(POSITION_SIZE*0.5)-(POSITION_SIZE*0.5*FEE_RATE);
            openTrade.sl=openTrade.entry;
          }
          if(barH>=openTrade.sl){
            openTrade.exitPrice=openTrade.sl;openTrade.exitReason=openTrade.tp1Hit?'TP1+BE':'SL';
            const remaining=openTrade.tp1Hit?0.5:1;
            openTrade.pnl=((openTrade.entry-openTrade.sl)/openTrade.entry)*LEVERAGE*(POSITION_SIZE*remaining)-(POSITION_SIZE*remaining*FEE_RATE);
            if(openTrade.tp1Hit)openTrade.pnl+=openTrade.tp1Pnl;
            trades.push(openTrade);openTrade=null;
          }else if(barL<=openTrade.tp){
            openTrade.exitPrice=openTrade.tp;openTrade.exitReason=openTrade.tp1Hit?'TP1+TP2':'TP';
            const remaining=openTrade.tp1Hit?0.5:1;
            openTrade.pnl=((openTrade.entry-openTrade.tp)/openTrade.entry)*LEVERAGE*(POSITION_SIZE*remaining)-(POSITION_SIZE*remaining*FEE_RATE);
            if(openTrade.tp1Hit)openTrade.pnl+=openTrade.tp1Pnl;
            trades.push(openTrade);openTrade=null;
          }else if(openTrade.barsHeld>=TIMEOUT_BARS){
            openTrade.exitPrice=barC;openTrade.exitReason='TIMEOUT';
            const remaining=openTrade.tp1Hit?0.5:1;
            openTrade.pnl=((openTrade.entry-barC)/openTrade.entry)*LEVERAGE*(POSITION_SIZE*remaining)-(POSITION_SIZE*remaining*FEE_RATE);
            if(openTrade.tp1Hit)openTrade.pnl+=openTrade.tp1Pnl;
            trades.push(openTrade);openTrade=null;
          }
        }
        continue;
      }

      // Cooldown
      if(i-lastSignalBar<cooldownBars)continue;
      // Day filter
      if(config.blockedDays.includes(dayOfWeek))continue;

      // Data slices
      const slice5=data.kl5.slice(Math.max(0,i-279),i+1);
      const C5=slice5.map(k=>parseFloat(k[4]));
      const H5=slice5.map(k=>parseFloat(k[2]));
      const L5=slice5.map(k=>parseFloat(k[3]));
      const V5=slice5.map(k=>parseFloat(k[5]));
      if(C5.length<50)continue;

      const barTime15=barTime-(barTime%(15*60*1000));
      let endIdx15=data.kl15.findIndex(k=>k[0]>barTime15);if(endIdx15===-1)endIdx15=data.kl15.length;
      const slice15=data.kl15.slice(Math.max(0,endIdx15-100),endIdx15);
      const C15=slice15.map(k=>parseFloat(k[4])),H15=slice15.map(k=>parseFloat(k[2])),L15=slice15.map(k=>parseFloat(k[3])),V15=slice15.map(k=>parseFloat(k[5]));

      const barTime1h=barTime-(barTime%(60*60*1000));
      let endIdx1h=data.kl1h.findIndex(k=>k[0]>barTime1h);if(endIdx1h===-1)endIdx1h=data.kl1h.length;
      const slice1h=data.kl1h.slice(Math.max(0,endIdx1h-50),endIdx1h);
      const C1h=slice1h.map(k=>parseFloat(k[4])),H1h=slice1h.map(k=>parseFloat(k[2])),L1h=slice1h.map(k=>parseFloat(k[3])),V1h=slice1h.map(k=>parseFloat(k[5]));

      const sig=generateSignal(C5,H5,L5,V5,C15,H15,L15,V15,C1h,H1h,L1h,V1h,slice5,hourUTC,config);
      if(!sig||sig.signal==='NEUTRAL')continue;

      lastSignalBar=i;
      openTrade={sym,signal:sig.signal,entry:sig.entry,tp:sig.tp,tp1:sig.tp1,sl:sig.sl,
        tpDist:sig.tpDist,slDist:sig.slDist,confidence:sig.confidence,regime:sig.regime,
        adx:sig.adx,rsi:sig.rsi,vr:sig.vr,htfTrend:sig.htfTrend,
        entryTime:new Date(barTime).toISOString(),hourUTC,dayOfWeek,barsHeld:0,pnl:0,
        tp1Hit:false,tp1Pnl:0};
    }

    if(openTrade){
      const lastBar=data.kl5.at(-1);openTrade.exitPrice=parseFloat(lastBar[4]);openTrade.exitReason='END';
      const remaining=openTrade.tp1Hit?0.5:1;
      if(openTrade.signal==='BUY')openTrade.pnl=((openTrade.exitPrice-openTrade.entry)/openTrade.entry)*LEVERAGE*(POSITION_SIZE*remaining)-(POSITION_SIZE*remaining*FEE_RATE);
      else openTrade.pnl=((openTrade.entry-openTrade.exitPrice)/openTrade.entry)*LEVERAGE*(POSITION_SIZE*remaining)-(POSITION_SIZE*remaining*FEE_RATE);
      if(openTrade.tp1Hit)openTrade.pnl+=openTrade.tp1Pnl;
      trades.push(openTrade);
    }

    for(const t of trades){
      allTrades.push(t);tradesByHour[t.hourUTC]++;pnlByHour[t.hourUTC]+=t.pnl;
      if(!tradesByPair[sym])tradesByPair[sym]={trades:0,pnl:0,wins:0};
      tradesByPair[sym].trades++;tradesByPair[sym].pnl+=t.pnl;if(t.pnl>0)tradesByPair[sym].wins++;
      tradesByDay[t.dayOfWeek].trades++;tradesByDay[t.dayOfWeek].pnl+=t.pnl;if(t.pnl>0)tradesByDay[t.dayOfWeek].wins++;
    }
    console.log(` ${trades.length}t $${trades.reduce((a,t)=>a+t.pnl,0).toFixed(0)}`);
    await sleep(200);
  }

  // Print results
  const wins=allTrades.filter(t=>t.pnl>0);const losses=allTrades.filter(t=>t.pnl<=0);
  const totalPnL=allTrades.reduce((a,t)=>a+t.pnl,0);
  const grossProfit=wins.reduce((a,t)=>a+t.pnl,0);
  const grossLoss=Math.abs(losses.reduce((a,t)=>a+t.pnl,0));
  const wr=allTrades.length?(wins.length/allTrades.length*100):0;
  const pf=grossLoss>0?grossProfit/grossLoss:Infinity;
  let peak=CAPITAL,maxDD=0,equity=CAPITAL;
  for(const t of allTrades){equity+=t.pnl;if(equity>peak)peak=equity;const dd=(peak-equity)/peak*100;if(dd>maxDD)maxDD=dd;}

  const exitReasons={};for(const t of allTrades)exitReasons[t.exitReason]=(exitReasons[t.exitReason]||0)+1;

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  RESULTS: ${configName.toUpperCase()}`);
  console.log(`${'─'.repeat(70)}`);
  console.log(`  Trades:    ${allTrades.length} (${(allTrades.length/DAYS).toFixed(1)}/day)`);
  console.log(`  WR:        ${wr.toFixed(1)}% (${wins.length}W/${losses.length}L)`);
  console.log(`  PnL:       $${totalPnL.toFixed(2)} (${(totalPnL/CAPITAL*100).toFixed(2)}%)`);
  console.log(`  PF:        ${pf.toFixed(2)}`);
  console.log(`  MaxDD:     ${maxDD.toFixed(2)}%`);
  console.log(`  Equity:    $${equity.toFixed(2)}`);
  console.log(`  Avg Win:   $${wins.length?(grossProfit/wins.length).toFixed(2):'0'}`);
  console.log(`  Avg Loss:  $${losses.length?(grossLoss/losses.length).toFixed(2):'0'}`);
  console.log(`  Expect:    $${allTrades.length?(totalPnL/allTrades.length).toFixed(2):'0'}/trade`);

  console.log(`\n  Exit Reasons:`);
  for(const[r,c]of Object.entries(exitReasons).sort((a,b)=>b[1]-a[1]))console.log(`    ${r}: ${c} (${(c/allTrades.length*100).toFixed(0)}%)`);

  console.log(`\n  Top/Bottom Pairs:`);
  const pArr=Object.entries(tradesByPair).sort((a,b)=>b[1].pnl-a[1].pnl);
  for(const[p,d]of pArr.slice(0,8)){console.log(`    ${p.padEnd(12)} ${String(d.trades).padEnd(5)} WR:${(d.wins/d.trades*100).toFixed(0).padEnd(4)}% $${d.pnl.toFixed(0)}`);}
  console.log(`    ---`);
  for(const[p,d]of pArr.slice(-5).reverse()){console.log(`    ${p.padEnd(12)} ${String(d.trades).padEnd(5)} WR:${(d.wins/d.trades*100).toFixed(0).padEnd(4)}% $${d.pnl.toFixed(0)}`);}

  const dayNames=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  console.log(`\n  By Day:`);
  for(let d=0;d<7;d++){const data=tradesByDay[d];if(!data.trades)continue;console.log(`    ${dayNames[d]} ${String(data.trades).padEnd(5)} WR:${(data.wins/data.trades*100).toFixed(0).padEnd(4)}% $${data.pnl.toFixed(0)}`);}

  console.log(`\n  By Hour (top/bottom):`);
  const hourArr=[];for(let h=0;h<24;h++)if(tradesByHour[h])hourArr.push({h,trades:tradesByHour[h],pnl:pnlByHour[h]});
  hourArr.sort((a,b)=>b.pnl-a.pnl);
  for(const hd of hourArr.slice(0,5))console.log(`    H${String(hd.h).padStart(2,'0')}: ${String(hd.trades).padEnd(5)} $${hd.pnl.toFixed(0).padStart(6)} ✓`);
  console.log(`    ---`);
  for(const hd of hourArr.slice(-3))console.log(`    H${String(hd.h).padStart(2,'0')}: ${String(hd.trades).padEnd(5)} $${hd.pnl.toFixed(0).padStart(6)} ✗`);

  console.log(`${'─'.repeat(70)}\n`);
  return allTrades;
}

async function main(){
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  OPTIMIZED BACKTEST v2 — Testing parameter improvements            ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  const mode=process.argv[2]||'all';
  if(mode==='all'||mode==='strict'){await runBacktest('strict_final');}
  if(mode==='all'||mode==='scalp'){await runBacktest('scalp_final');}
  console.log('\n✓ v2 Backtest complete.');
}
main().catch(console.error);
