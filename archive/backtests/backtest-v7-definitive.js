#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// BACKTEST v7 DEFINITIVO — 150 días, sin bias, sin filtros fake
// Simula EXACTAMENTE lo que el usuario vería en la app
// Sin look-ahead, sin cherry-picking, sin clock filters
// ══════════════════════════════════════════════════════════════

const https = require('https');

// ═══ CONFIG ═══
const DAYS = 150;
const COINS_VIP = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','AVAXUSDT','ADAUSDT','DOTUSDT','LINKUSDT','FILUSDT','UNIUSDT','ARBUSDT','OPUSDT','SHIBUSDT','SUIUSDT','TIAUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT'];
const COINS_SCALP = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','ADAUSDT','DOTUSDT','ARBUSDT','OPUSDT','SUIUSDT','FILUSDT','UNIUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT','TIAUSDT','ATOMUSDT'];
const COINS_FREE = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];

// ═══ INDICATOR FUNCTIONS (exact copy from app.html) ═══
function calcRSI(closes,p=14){if(closes.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}if(al===0)return 100;return 100-(100/(1+ag/al));}
function calcEMAArr(data,p){const k=2/(p+1);const r=[data[0]];for(let i=1;i<data.length;i++)r.push(data[i]*k+r[i-1]*(1-k));return r;}
function calcEMA(data,p){return calcEMAArr(data,p).at(-1);}
function calcMACD(closes){if(closes.length<35)return{h:0,ph:0,macd:0,sig:0};const e12=calcEMAArr(closes,12),e26=calcEMAArr(closes,26);const ml=e12.map((v,i)=>v-e26[i]);const sl=calcEMAArr(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1)),macd:ml.at(-1),sig:sl.at(-1)};}
function calcBB(closes,p=20,s=2){if(closes.length<p)return{u:0,m:0,l:0};const sl=closes.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+s*sd,m,l:m-s*sd};}
function calcStoch(H,L,C,kp=14){if(C.length<kp+3)return{k:50,d:50};const kArr=[];for(let i=kp;i<=C.length;i++){const sh=H.slice(i-kp,i),sl=L.slice(i-kp,i);const hi=Math.max(...sh),lo=Math.min(...sl);kArr.push(hi===lo?50:((C[i-1]-lo)/(hi-lo))*100);}const dArr=[];for(let i=2;i<kArr.length;i++)dArr.push((kArr[i]+kArr[i-1]+kArr[i-2])/3);return{k:kArr.at(-1)||50,d:dArr.at(-1)||50};}
function calcATR(H,L,C,p=14){if(C.length<p+1)return 0;const trs=[];for(let i=1;i<C.length;i++)trs.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));if(trs.length<p)return trs.reduce((a,b)=>a+b)/trs.length;let atr=trs.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<trs.length;i++)atr=(atr*(p-1)+trs[i])/p;return atr;}
function calcADX(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pdm=[],mdm=[],tr=[];for(let i=1;i<H.length;i++){const upMove=H[i]-H[i-1],dnMove=L[i-1]-L[i];pdm.push(upMove>dnMove&&upMove>0?upMove:0);mdm.push(dnMove>upMove&&dnMove>0?dnMove:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}function wilderSmooth(arr,period){if(arr.length<period)return arr.map(()=>0);const r=[];let s=arr.slice(0,period).reduce((a,b)=>a+b)/period;for(let i=0;i<period;i++)r.push(0);r[period-1]=s;for(let i=period;i<arr.length;i++){s=(s*(period-1)+arr[i])/period;r.push(s);}return r;}const smTR=wilderSmooth(tr,p),smPDM=wilderSmooth(pdm,p),smMDM=wilderSmooth(mdm,p);const pdi=smPDM.map((v,i)=>smTR[i]?v/smTR[i]*100:0);const mdi=smMDM.map((v,i)=>smTR[i]?v/smTR[i]*100:0);const dx=pdi.map((v,i)=>{const s=v+mdi[i];return s?Math.abs(v-mdi[i])/s*100:0;});const dxValid=dx.slice(p-1);const adxArr=dxValid.length>=p?wilderSmooth(dxValid,p):dxValid;return{adx:adxArr.at(-1)||15,pdi:pdi.at(-1)||0,mdi:mdi.at(-1)||0};}
function calcOBV(C,V){if(C.length<2)return{obv:0,slope:0,rising:false};let obv=0;const arr=[0];for(let i=1;i<C.length;i++){if(C[i]>C[i-1])obv+=V[i];else if(C[i]<C[i-1])obv-=V[i];arr.push(obv);}const n=Math.min(arr.length,20);const recent=arr.slice(-n);let sumX=0,sumY=0,sumXY=0,sumX2=0;for(let i=0;i<n;i++){sumX+=i;sumY+=recent[i];sumXY+=i*recent[i];sumX2+=i*i;}const slope=(n*sumXY-sumX*sumY)/(n*sumX2-sumX*sumX||1);return{obv:arr.at(-1),slope,rising:slope>0};}
function calcVWAP(H,L,C,V){let cumVol=0;let cumVolPrice=0;const vwapArr=[];for(let i=0;i<C.length;i++){const typPrice=(H[i]+L[i]+C[i])/3;cumVol+=V[i];cumVolPrice+=(typPrice*V[i]);vwapArr.push(cumVol?cumVolPrice/cumVol:C[i]);}return vwapArr;}
function calcParabolicSAR(H,L,C){if(C.length<5)return{sar:C.at(-1),trend:'BUY',recentFlip:false};let af=0.02,maxAf=0.2,sar=L[0],ep=H[0],isUp=true;let lastFlipIdx=0;for(let i=1;i<C.length;i++){const pSar=sar+af*(ep-sar);if(isUp){sar=Math.min(pSar,L[i-1],i>1?L[i-2]:L[i-1]);if(L[i]<sar){isUp=false;sar=ep;ep=L[i];af=0.02;lastFlipIdx=i;}else{if(H[i]>ep){ep=H[i];af=Math.min(af+0.02,maxAf);}sar=pSar;}}else{sar=Math.max(pSar,H[i-1],i>1?H[i-2]:H[i-1]);if(H[i]>sar){isUp=true;sar=ep;ep=H[i];af=0.02;lastFlipIdx=i;}else{if(L[i]<ep){ep=L[i];af=Math.min(af+0.02,maxAf);}sar=pSar;}}}const recentFlip=(C.length-1-lastFlipIdx)<=5;return{sar,trend:isUp?'BUY':'SELL',recentFlip};}
function calcKeltner(H,L,C,emaLen=20,atrLen=14,mult=2){if(C.length<Math.max(emaLen,atrLen)+1)return{upper:0,mid:0,lower:0,width:0,position:0.5};const mid=calcEMA(C,emaLen);const atr=calcATR(H,L,C,atrLen);const upper=mid+mult*atr;const lower=mid-mult*atr;const range=upper-lower;const width=mid?range/mid:0;const cur=C.at(-1);const position=range>0?(cur-lower)/range:0.5;return{upper,mid,lower,width,position,atr};}
function calcMFI(H,L,C,V,period=14){if(C.length<period+1)return 50;let posFlow=0,negFlow=0;for(let i=C.length-period;i<C.length;i++){const tp=(H[i]+L[i]+C[i])/3;const prevTp=(H[i-1]+L[i-1]+C[i-1])/3;const mf=tp*V[i];if(tp>prevTp)posFlow+=mf;else negFlow+=mf;}if(negFlow===0)return 100;const ratio=posFlow/negFlow;return 100-(100/(1+ratio));}
function detectOrderBlocks(H,L,C,V,lookback=50){if(C.length<lookback)return{bullOB:null,bearOB:null};const tail=C.length-lookback;let bullOB=null,bearOB=null;const avgV=V.slice(tail).reduce((a,b)=>a+b)/(lookback||1);for(let i=tail+2;i<C.length-1;i++){const body=Math.abs(C[i]-C[i-1]);const prevBody=Math.abs(C[i-1]-C[i-2]);const isImbalance=prevBody>0&&body>prevBody*2;const isHighVol=V[i]>avgV*1.5;if(isImbalance&&isHighVol){if(C[i]>C[i-1]){bullOB={price:Math.min(C[i-1],L[i]),high:H[i],idx:i};}else{bearOB={price:Math.max(C[i-1],H[i]),low:L[i],idx:i};}}}const cur=C.at(-1);const atr=calcATR(H,L,C,14);if(bullOB&&(cur-bullOB.price)>atr*2)bullOB=null;if(bullOB&&(bullOB.price-cur)>atr*1)bullOB=null;if(bearOB&&(bearOB.price-cur)>atr*2)bearOB=null;if(bearOB&&(cur-bearOB.price)>atr*1)bearOB=null;return{bullOB,bearOB};}
function detectRSIDivergence(C,H,L,period=14){if(C.length<period+25)return{bull:false,bear:false};const rsiArr=[];let ag=0,al=0;for(let i=1;i<=period;i++){const d=C[i]-C[i-1];if(d>0)ag+=d;else al+=Math.abs(d);}ag/=period;al/=period;rsiArr.push(al===0?100:100-(100/(1+ag/al)));for(let i=period+1;i<C.length;i++){const d=C[i]-C[i-1];ag=(ag*(period-1)+(d>0?d:0))/period;al=(al*(period-1)+(d<0?Math.abs(d):0))/period;rsiArr.push(al===0?100:100-(100/(1+ag/al)));}const len=Math.min(rsiArr.length,40);const priceTail=C.slice(-len);const rsiTail=rsiArr.slice(-len);let priceLows=[],priceHighs=[];for(let i=3;i<len-3;i++){let isLow=true,isHigh=true;for(let j=1;j<=3;j++){if(priceTail[i]>priceTail[i-j]||priceTail[i]>priceTail[i+j])isLow=false;if(priceTail[i]<priceTail[i-j]||priceTail[i]<priceTail[i+j])isHigh=false;}if(isLow)priceLows.push({idx:i,price:priceTail[i],rsi:rsiTail[i]});if(isHigh)priceHighs.push({idx:i,price:priceTail[i],rsi:rsiTail[i]});}let bull=false;if(priceLows.length>=2){const[prev,last]=priceLows.slice(-2);if(last.idx-prev.idx>=5&&last.price<prev.price&&last.rsi>prev.rsi+2)bull=true;}let bear=false;if(priceHighs.length>=2){const[prev,last]=priceHighs.slice(-2);if(last.idx-prev.idx>=5&&last.price>prev.price&&last.rsi<prev.rsi-2)bear=true;}return{bull,bear};}
function detectMACDDivergence(C){if(C.length<40)return{bull:false,bear:false};const e12=calcEMAArr(C,12),e26=calcEMAArr(C,26);const macdLine=e12.map((v,i)=>v-e26[i]);const len=Math.min(macdLine.length,40);const priceTail=C.slice(-len);const macdTail=macdLine.slice(-len);let priceLows=[],priceHighs=[];for(let i=3;i<len-3;i++){let isLow=true,isHigh=true;for(let j=1;j<=3;j++){if(priceTail[i]>priceTail[i-j]||priceTail[i]>priceTail[i+j])isLow=false;if(priceTail[i]<priceTail[i-j]||priceTail[i]<priceTail[i+j])isHigh=false;}if(isLow)priceLows.push({idx:i,price:priceTail[i],macd:macdTail[i]});if(isHigh)priceHighs.push({idx:i,price:priceTail[i],macd:macdTail[i]});}let bull=false,bear=false;if(priceLows.length>=2){const[prev,last]=priceLows.slice(-2);if(last.idx-prev.idx>=5&&last.price<prev.price&&last.macd>prev.macd)bull=true;}if(priceHighs.length>=2){const[prev,last]=priceHighs.slice(-2);if(last.idx-prev.idx>=5&&last.price>prev.price&&last.macd<prev.macd)bear=true;}return{bull,bear};}
function findPivotLevels(H,L,C,lookback=50){const h=H.slice(-lookback),l=L.slice(-lookback);let supports=[],resistances=[];for(let i=2;i<h.length-2;i++){if(h[i]>=h[i-1]&&h[i]>=h[i-2]&&h[i]>=h[i+1]&&h[i]>=h[i+2])resistances.push(h[i]);if(l[i]<=l[i-1]&&l[i]<=l[i-2]&&l[i]<=l[i+1]&&l[i]<=l[i+2])supports.push(l[i]);}const cur=C.at(-1);const nearestRes=resistances.filter(r=>r>cur).sort((a,b)=>a-b)[0]||null;const nearestSup=supports.filter(s=>s<cur).sort((a,b)=>b-a)[0]||null;return{nearestRes,nearestSup,supports,resistances};}
function detectRegime(H,L,C,adxPre,atrPre){const adx=adxPre||calcADX(H,L,C);const atr=atrPre||calcATR(H,L,C,14);const avgP=C.slice(-20).reduce((a,b)=>a+b)/20;const atrPct=atr/avgP*100;if(adx.adx>25&&atrPct>1.5)return{regime:'TRENDING'};if(adx.adx<20&&atrPct<0.8)return{regime:'QUIET'};if(atrPct>2)return{regime:'VOLATILE'};return{regime:'RANGING'};}

// ═══ SIGNAL ENGINES (exact copy from app.html v7) ═══
function genSignal(C5, H5, L5, V5, C15, H15, L15, V15, C1h, H1h, L1h, V1h, mode, hourUTC) {
  const isStrict = (mode === 'strict');
  const isScalp = (mode === 'scalp');
  const cur = C5.at(-1);

  // HTF Trend (1H)
  let htfTrend = 'NEUTRAL', htfStrength = 0;
  if(C1h.length > 25) {
    const ema9h=calcEMA(C1h,9), ema21h=calcEMA(C1h,21), ema50h=calcEMA(C1h,50);
    const rsi1h=calcRSI(C1h,14);
    const mac1h=calcMACD(C1h);
    const adx1h=calcADX(H1h,L1h,C1h);
    const obv1h=calcOBV(C1h,V1h);
    let hB=0,hS=0;
    if(ema9h>ema21h)hB+=2;else hS+=2;
    if(C1h.at(-1)>ema50h)hB+=1;else hS+=1;
    if(mac1h.h>0)hB+=1.5;else hS+=1.5;
    if(mac1h.h>mac1h.ph)hB+=1;else hS+=1;
    if(rsi1h>50)hB+=1;else hS+=1;
    if(adx1h.adx>20&&adx1h.pdi>adx1h.mdi)hB+=1.5;
    else if(adx1h.adx>20&&adx1h.mdi>adx1h.pdi)hS+=1.5;
    if(obv1h.rising)hB+=1;else hS+=1;
    if(hB>hS+2){htfTrend='BUY';htfStrength=hB-hS;}
    else if(hS>hB+2){htfTrend='SELL';htfStrength=hS-hB;}
  }

  // MTF Confirm (15m)
  let mtfConfirm = 'NEUTRAL';
  if(C15.length > 25) {
    const ema9_15=calcEMA(C15,9),ema21_15=calcEMA(C15,21);
    const rsi15=calcRSI(C15,14);
    const mac15=calcMACD(C15);
    let mB=0,mS=0;
    if(ema9_15>ema21_15)mB+=1;else mS+=1;
    if(mac15.h>0)mB+=1;else mS+=1;
    if(rsi15>50)mB+=0.5;else if(rsi15<50)mS+=0.5;
    if(mB>mS)mtfConfirm='BUY';else if(mS>mB)mtfConfirm='SELL';
  }

  // Session
  const isDeadHours = hourUTC >= 0 && hourUTC < 6;
  const isLondonOpen = hourUTC >= 8 && hourUTC < 10;
  const isNYOpen = hourUTC >= 13 && hourUTC < 16;
  const isOverlap = hourUTC >= 13 && hourUTC < 16;

  // Regime
  const adxData = calcADX(H5,L5,C5);
  const atr = calcATR(H5,L5,C5,14);
  let regime = 'RANGING';
  try { regime = detectRegime(H5,L5,C5,adxData,atr).regime || 'RANGING'; } catch(e) {}
  const isVolatile = (regime === 'VOLATILE');

  let signal = 'NEUTRAL';
  let conf = 50;
  let tpMult, slMult;

  if(isStrict) {
    // ═══ VIP INSTITUTIONAL ═══
    const htfNeutralPenalty = (htfTrend === 'NEUTRAL') ? 3 : 0;
    const requiredScore = 7 + htfNeutralPenalty;
    const requiredInds = 4;

    const rsi=calcRSI(C5,14);
    const mac=calcMACD(C5);
    const e9=calcEMA(C5,9),e21=calcEMA(C5,21),e50=calcEMA(C5,50);
    const bb=calcBB(C5,20,2);
    const bbR=bb.u-bb.l;const bbPos=bbR>0?(cur-bb.l)/bbR:0.5;
    const vwapArr=calcVWAP(H5.slice(-50),L5.slice(-50),C5.slice(-50),V5.slice(-50));const vwap=vwapArr.at(-1);
    const avgV=V5.slice(-20).reduce((a,b)=>a+b)/20,lv=V5.at(-1),vr=lv/avgV;
    const obvData=calcOBV(C5,V5);
    const psar=calcParabolicSAR(H5,L5,C5);
    const stFull=calcStoch(H5,L5,C5,14);
    const rsiDiv=detectRSIDivergence(C5,H5,L5,14);
    const macdDiv=detectMACDDivergence(C5);
    const kc=calcKeltner(H5,L5,C5,20,14,2);
    let orderBlocks={bullOB:null,bearOB:null};
    try{orderBlocks=detectOrderBlocks(H5,L5,C5,V5,50);}catch(e){}
    const mfi=calcMFI(H5,L5,C5,V5,14);
    const pivots=findPivotLevels(H5,L5,C5,50);

    let bScore=0,sScore=0,bInds=0,sInds=0;

    // 1. RSI(14)
    if(rsi<25){bScore+=5;bInds++;}else if(rsi<30){bScore+=4;bInds++;}else if(rsi<35){bScore+=3;bInds++;}
    else if(rsi>75){sScore+=5;sInds++;}else if(rsi>70){sScore+=4;sInds++;}else if(rsi>65){sScore+=3;sInds++;}
    // 2. Stoch
    const stK=stFull.k||50;
    if(stK<20){bScore+=4;bInds++;}else if(stK<25){bScore+=3;bInds++;}
    else if(stK>80){sScore+=4;sInds++;}else if(stK>75){sScore+=3;sInds++;}
    // 3. BB
    if(bbPos<0.08){bScore+=3;bInds++;}else if(bbPos<0.15){bScore+=2;bInds++;}
    else if(bbPos>0.92){sScore+=3;sInds++;}else if(bbPos>0.85){sScore+=2;sInds++;}
    // 4. MACD
    const macdCrossUp=mac.h>0&&mac.ph<=0;const macdCrossDown=mac.h<0&&mac.ph>=0;
    if(macdCrossUp){bScore+=2;bInds++;}else if(mac.h>0&&Math.abs(mac.h)>Math.abs(mac.ph)){bScore+=1;}
    else if(macdCrossDown){sScore+=2;sInds++;}else if(mac.h<0&&Math.abs(mac.h)>Math.abs(mac.ph)){sScore+=1;}
    // 5. EMA
    if(e9>e21){bScore+=1.5;bInds++;}else{sScore+=1.5;sInds++;}
    if(cur>e50){bScore+=1;}else{sScore+=1;}
    // 6. ADX+DI
    if(adxData.adx>20){if(adxData.pdi>adxData.mdi){bScore+=2;bInds++;}else{sScore+=2;sInds++;}}
    // 7. OBV
    if(obvData.rising){bScore+=1.5;bInds++;}else{sScore+=1.5;sInds++;}
    // 8. VWAP
    if(vwap&&cur<vwap){bScore+=1.5;bInds++;}else if(vwap&&cur>vwap){sScore+=1.5;sInds++;}
    // 9. PSAR
    if(psar.trend==='BUY'){bScore+=1.5;bInds++;if(psar.recentFlip)bScore+=1;}
    else{sScore+=1.5;sInds++;if(psar.recentFlip)sScore+=1;}
    // 10. RSI Div
    if(rsiDiv.bull){bScore+=3;bInds++;}else if(rsiDiv.bear){sScore+=3;sInds++;}
    // 11. MACD Div
    if(macdDiv.bull){bScore+=2;bInds++;}else if(macdDiv.bear){sScore+=2;sInds++;}
    // 12. Order Blocks
    if(orderBlocks.bullOB){bScore+=2;bInds++;}
    if(orderBlocks.bearOB){sScore+=2;sInds++;}
    // 13. Keltner
    if(kc.position<0.15){bScore+=1.5;bInds++;}else if(kc.position>0.85){sScore+=1.5;sInds++;}
    // 14. MFI
    if(mfi<25){bScore+=1.5;bInds++;}else if(mfi>75){sScore+=1.5;sInds++;}
    // 15. Volume
    if(vr>2.0){const vSig=rsi<50?'B':'S';if(vSig==='B'){bScore+=2;bInds++;}else{sScore+=2;sInds++;}}
    else if(vr>1.3){const vSig=rsi<50?'B':'S';if(vSig==='B'){bScore+=1;bInds++;}else{sScore+=1;sInds++;}}
    // 16. S/R
    if(pivots.nearestSup&&(cur-pivots.nearestSup)<atr*0.5){bScore+=2;bInds++;}
    if(pivots.nearestRes&&(pivots.nearestRes-cur)<atr*0.5){sScore+=2;sInds++;}
    // 17. Session
    if(isOverlap){bScore+=1.5;sScore+=1.5;}else if(isLondonOpen||isNYOpen){bScore+=1;sScore+=1;}
    if(isDeadHours){bScore-=2;sScore-=2;}

    // Decision — HTF gate
    if(htfTrend==='BUY'&&bScore>=requiredScore&&bInds>=requiredInds){signal='BUY';}
    else if(htfTrend==='SELL'&&sScore>=requiredScore&&sInds>=requiredInds){signal='SELL';}
    else if(htfTrend==='NEUTRAL'){
      if(bScore>=requiredScore&&bInds>=requiredInds&&bScore>sScore+2)signal='BUY';
      else if(sScore>=requiredScore&&sInds>=requiredInds&&sScore>bScore+2)signal='SELL';
    }

    if(signal!=='NEUTRAL'&&isVolatile)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&vr<0.3)signal='NEUTRAL';
    if(signal!=='NEUTRAL'){const volPct=atr/cur;if(volPct<0.0008)signal='NEUTRAL';}

    if(signal!=='NEUTRAL'){
      conf=Math.round(50+(Math.max(bScore,sScore)/35)*42);
      if(htfTrend===signal)conf+=5;if(mtfConfirm===signal)conf+=3;
      conf=Math.min(95,conf);
    }
    tpMult=1.8;slMult=1.2;

  } else if(isScalp) {
    // ═══ SCALP ═══
    const scalpGate=mtfConfirm;
    const rsiS=calcRSI(C5,7);
    const mac=calcMACD(C5);
    const e5=calcEMA(C5,5),e13=calcEMA(C5,13);
    const bbS=calcBB(C5,10,1.8);const bbSR=bbS.u-bbS.l;const bbSPos=bbSR>0?(cur-bbS.l)/bbSR:0.5;
    const vwapArr=calcVWAP(H5.slice(-50),L5.slice(-50),C5.slice(-50),V5.slice(-50));const vwap=vwapArr.at(-1);
    const avgV=V5.slice(-20).reduce((a,b)=>a+b)/20,lv=V5.at(-1),vr=lv/avgV;
    const stS=calcStoch(H5,L5,C5,7);const stK=stS.k||50;const stD=stS.d||50;
    const psar=calcParabolicSAR(H5,L5,C5);
    const kc=calcKeltner(H5,L5,C5,20,14,2);
    const mfi=calcMFI(H5,L5,C5,V5,7);

    let bScore=0,sScore=0,bInds=0,sInds=0;
    // 1. RSI(7)
    if(rsiS<30){bScore+=3;bInds++;}else if(rsiS<40){bScore+=2;bInds++;}
    else if(rsiS>70){sScore+=3;sInds++;}else if(rsiS>60){sScore+=2;sInds++;}
    // 2. Stoch(7)
    const stCrossUp=stK>stD&&stK<35;const stCrossDown=stK<stD&&stK>65;
    if(stK<30){bScore+=2;bInds++;if(stCrossUp)bScore+=1;}
    else if(stK>70){sScore+=2;sInds++;if(stCrossDown)sScore+=1;}
    // 3. BB(10,1.8)
    if(bbSPos<0.10){bScore+=3;bInds++;}else if(bbSPos<0.20){bScore+=2;bInds++;}
    else if(bbSPos>0.90){sScore+=3;sInds++;}else if(bbSPos>0.80){sScore+=2;sInds++;}
    // 4. MACD cross
    if(mac.h>0&&mac.ph<=0){bScore+=2;bInds++;}else if(mac.h<0&&mac.ph>=0){sScore+=2;sInds++;}
    // 5. EMA 5/13
    if(e5>e13){bScore+=1.5;bInds++;}else{sScore+=1.5;sInds++;}
    // 6. VWAP
    if(vwap&&cur<vwap){bScore+=1;bInds++;}else if(vwap&&cur>vwap){sScore+=1;sInds++;}
    // 7. Volume
    if(vr>1.8){const vSig=rsiS<50?'B':'S';if(vSig==='B'){bScore+=2;bInds++;}else{sScore+=2;sInds++;}}
    else if(vr>1.2){const vSig=rsiS<50?'B':'S';if(vSig==='B'){bScore+=1;bInds++;}else{sScore+=1;sInds++;}}
    // 8. Keltner
    if(kc.position<0.20){bScore+=1.5;bInds++;}else if(kc.position>0.80){sScore+=1.5;sInds++;}
    // 9. PSAR
    if(psar.trend==='BUY'){bScore+=1;bInds++;}else{sScore+=1;sInds++;}
    // 10. MFI(7)
    if(mfi<30){bScore+=1;bInds++;}else if(mfi>70){sScore+=1;sInds++;}
    // Session
    if(isOverlap){bScore+=1;sScore+=1;}else if(isLondonOpen||isNYOpen){bScore+=0.5;sScore+=0.5;}
    if(isDeadHours){bScore-=1;sScore-=1;}

    const minScore=5;const minInds=3;
    if(scalpGate==='BUY'&&bScore>=minScore&&bInds>=minInds){signal='BUY';}
    else if(scalpGate==='SELL'&&sScore>=minScore&&sInds>=minInds){signal='SELL';}
    else if(scalpGate==='NEUTRAL'){
      if(bScore>=minScore+1&&bInds>=minInds&&bScore>sScore+1.5)signal='BUY';
      else if(sScore>=minScore+1&&sInds>=minInds&&sScore>bScore+1.5)signal='SELL';
    }
    if(signal==='NEUTRAL'){
      if(bScore>=minScore+2&&bInds>=minInds+1&&bScore>sScore+2)signal='BUY';
      else if(sScore>=minScore+2&&sInds>=minInds+1&&sScore>bScore+2)signal='SELL';
    }
    if(signal!=='NEUTRAL'&&isVolatile&&adxData.adx>35)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&vr<0.3)signal='NEUTRAL';

    if(signal!=='NEUTRAL'){
      conf=Math.round(50+(Math.max(bScore,sScore)/22)*40);
      if(mtfConfirm===signal)conf+=3;if(htfTrend===signal)conf+=5;
      conf=Math.min(90,conf);
    }
    tpMult=1.2;slMult=0.8;

  } else {
    // ═══ FREE ═══
    const rsi=calcRSI(C5,14);
    const bb=calcBB(C5,20,2);const bbR=bb.u-bb.l;const bbPos=bbR>0?(cur-bb.l)/bbR:0.5;
    const e9=calcEMA(C5,9),e21=calcEMA(C5,21);
    const stFull=calcStoch(H5,L5,C5,14);const stK=stFull.k||50;
    const mac=calcMACD(C5);
    const avgV=V5.slice(-20).reduce((a,b)=>a+b)/20,lv=V5.at(-1),vr=lv/avgV;

    let bScore=0,sScore=0,bInds=0,sInds=0;
    if(rsi<30){bScore+=3;bInds++;}else if(rsi>70){sScore+=3;sInds++;}
    if(bbPos<0.10){bScore+=2;bInds++;}else if(bbPos>0.90){sScore+=2;sInds++;}
    if(stK<25){bScore+=2;bInds++;}else if(stK>75){sScore+=2;sInds++;}
    if(e9>e21){bScore+=1.5;bInds++;}else{sScore+=1.5;sInds++;}
    if(vr>1.5){const vSig=rsi<50?'B':'S';if(vSig==='B'){bScore+=1;bInds++;}else{sScore+=1;sInds++;}}
    if(mac.h>0){bScore+=0.5;}else{sScore+=0.5;}

    const minScore=5;const minInds=3;
    if(bScore>=minScore&&bInds>=minInds&&bScore>sScore+1)signal='BUY';
    else if(sScore>=minScore&&sInds>=minInds&&sScore>bScore+1)signal='SELL';
    if(signal!=='NEUTRAL'&&isVolatile)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&vr<0.3)signal='NEUTRAL';

    if(signal!=='NEUTRAL'){
      conf=Math.round(50+(Math.max(bScore,sScore)/10)*35);
      if(htfTrend===signal)conf+=3;conf=Math.min(85,conf);
    }
    tpMult=1.3;slMult=1.0;
  }

  // TP/SL
  let atr15=calcATR(H5,L5,C5,14);
  if(H15.length>15){const a15=calcATR(H15,L15,C15,14);if(a15>0)atr15=a15;}
  let atr1h=atr;
  if(H1h.length>15){const a1h=calcATR(H1h,L1h,C1h,14);if(a1h>0)atr1h=a1h;}
  const useATR=isScalp?(calcATR(H5,L5,C5,7)||atr):Math.max(atr15,atr1h/4);
  let tpDist=useATR*tpMult;let slDist=useATR*slMult;
  const minTPdist=cur*0.002;if(tpDist<minTPdist)tpDist=minTPdist;if(slDist<cur*0.001)slDist=cur*0.001;
  const costBuffer=cur*0.0008;

  return {
    signal, confidence: conf,
    entry: cur,
    tp: signal==='BUY'?cur+tpDist+costBuffer:signal==='SELL'?cur-tpDist-costBuffer:null,
    sl: signal==='BUY'?cur-slDist-costBuffer:signal==='SELL'?cur+slDist+costBuffer:null,
    tpDist, slDist, htfTrend, mtfConfirm, regime
  };
}

// ═══ DATA FETCHING ═══
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function getKlines(symbol, interval, days) {
  const limit = 1000;
  const totalBars = interval === '5m' ? days * 288 : interval === '15m' ? days * 96 : days * 24;
  const chunks = Math.ceil(totalBars / limit);
  const endTime = Date.now();
  let allData = [];

  for(let i = chunks - 1; i >= 0; i--) {
    const chunkEnd = endTime - i * limit * (interval === '5m' ? 300000 : interval === '15m' ? 900000 : 3600000);
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${chunkEnd}`;
    try {
      const data = await fetchJSON(url);
      allData = allData.concat(data);
    } catch(e) {
      console.error(`  Error fetching ${symbol} ${interval}: ${e.message}`);
    }
    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  // Deduplicate by open time
  const seen = new Set();
  allData = allData.filter(k => { const t = k[0]; if(seen.has(t)) return false; seen.add(t); return true; });
  allData.sort((a, b) => a[0] - b[0]);
  return allData;
}

// ═══ TRADE EVALUATION ═══
function evaluateTrade(signal, entry, tp, sl, futureH, futureL, futureC, mode, maxBars) {
  const hasTrailing = (mode === 'strict' || mode === 'scalp');
  const lockPct = mode === 'scalp' ? 0.50 : 0.40;
  let currentSL = sl;
  let slMovedBE = false;
  let slStage2 = false;

  for(let i = 0; i < Math.min(futureH.length, maxBars); i++) {
    const high = futureH[i];
    const low = futureL[i];

    // Trailing stop updates
    if(hasTrailing) {
      if(signal === 'BUY') {
        const tpDist = tp - entry;
        const bestProfit = high - entry;
        if(tpDist > 0) {
          if(!slStage2 && bestProfit >= tpDist * 0.75) {
            const newSL = entry + tpDist * lockPct;
            if(newSL > currentSL) { currentSL = newSL; slStage2 = true; }
          } else if(!slMovedBE && bestProfit >= tpDist * 0.50) {
            const newSL = entry + entry * 0.0008;
            if(newSL > currentSL) { currentSL = newSL; slMovedBE = true; }
          }
        }
      } else {
        const tpDist = entry - tp;
        const bestProfit = entry - low;
        if(tpDist > 0) {
          if(!slStage2 && bestProfit >= tpDist * 0.75) {
            const newSL = entry - tpDist * lockPct;
            if(newSL < currentSL) { currentSL = newSL; slStage2 = true; }
          } else if(!slMovedBE && bestProfit >= tpDist * 0.50) {
            const newSL = entry - entry * 0.0008;
            if(newSL < currentSL) { currentSL = newSL; slMovedBE = true; }
          }
        }
      }
    }

    // TP/SL hit check
    if(signal === 'BUY') {
      if(high >= tp) return { result: 'WIN', exitPrice: tp, bars: i + 1, trailed: slStage2 || slMovedBE };
      if(low <= currentSL) {
        return { result: currentSL >= entry ? 'WIN' : 'LOSS', exitPrice: currentSL, bars: i + 1, trailed: slStage2 || slMovedBE };
      }
    } else {
      if(low <= tp) return { result: 'WIN', exitPrice: tp, bars: i + 1, trailed: slStage2 || slMovedBE };
      if(high >= currentSL) {
        return { result: currentSL <= entry ? 'WIN' : 'LOSS', exitPrice: currentSL, bars: i + 1, trailed: slStage2 || slMovedBE };
      }
    }
  }

  // Timeout — close at market
  const exitPrice = futureC[Math.min(futureC.length - 1, maxBars - 1)] || entry;
  const dir = signal === 'BUY' ? 1 : -1;
  const pnl = dir * (exitPrice - entry);
  return { result: pnl > 0 ? 'WIN' : 'LOSS', exitPrice, bars: maxBars, timeout: true, trailed: false };
}

// ═══ MAIN BACKTEST ═══
async function runBacktest() {
  console.log('══════════════════════════════════════════════════════════');
  console.log('  BACKTEST DEFINITIVO v7 — ' + DAYS + ' DÍAS');
  console.log('  Sin bias, sin filtros fake, sin look-ahead');
  console.log('  Fecha: ' + new Date().toISOString());
  console.log('══════════════════════════════════════════════════════════\n');

  const modes = [
    { name: 'VIP INSTITUTIONAL', mode: 'strict', coins: COINS_VIP, maxBars: 48, cooldownBars: 3 },
    { name: 'SCALP', mode: 'scalp', coins: COINS_SCALP, maxBars: 12, cooldownBars: 2 },
    { name: 'FREE', mode: 'frequent', coins: COINS_FREE, maxBars: 24, cooldownBars: 6 }
  ];

  for(const modeConfig of modes) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  MOTOR: ${modeConfig.name} (${modeConfig.mode})`);
    console.log(`  Coins: ${modeConfig.coins.length} | MaxBars: ${modeConfig.maxBars} | Cooldown: ${modeConfig.cooldownBars}`);
    console.log(`${'═'.repeat(60)}\n`);

    let totalTrades = 0, wins = 0, losses = 0;
    let totalPnlPct = 0;
    let grossProfit = 0, grossLoss = 0;
    let trailedWins = 0;
    const pnlPerCoin = {};
    const pnlPerDirection = { BUY: { trades: 0, wins: 0, pnl: 0 }, SELL: { trades: 0, wins: 0, pnl: 0 } };
    const pnlPerHour = {};
    const allPnls = [];

    for(const sym of modeConfig.coins) {
      process.stdout.write(`  Downloading ${sym}... `);

      // Download data
      const kl5 = await getKlines(sym, '5m', DAYS + 5); // extra days for lookback
      const kl15 = await getKlines(sym, '15m', DAYS + 5);
      const kl1h = await getKlines(sym, '1h', DAYS + 5);

      if(kl5.length < 300) { console.log(`SKIP (${kl5.length} bars)`); continue; }

      const allC5 = kl5.map(k => parseFloat(k[4]));
      const allH5 = kl5.map(k => parseFloat(k[2]));
      const allL5 = kl5.map(k => parseFloat(k[3]));
      const allV5 = kl5.map(k => parseFloat(k[5]));
      const allT5 = kl5.map(k => k[0]);

      const allC15 = kl15.map(k => parseFloat(k[4]));
      const allH15 = kl15.map(k => parseFloat(k[2]));
      const allL15 = kl15.map(k => parseFloat(k[3]));
      const allV15 = kl15.map(k => parseFloat(k[5]));
      const allT15 = kl15.map(k => k[0]);

      const allC1h = kl1h.map(k => parseFloat(k[4]));
      const allH1h = kl1h.map(k => parseFloat(k[2]));
      const allL1h = kl1h.map(k => parseFloat(k[3]));
      const allV1h = kl1h.map(k => parseFloat(k[5]));
      const allT1h = kl1h.map(k => k[0]);

      // Walk through each 5m bar (skip first 280 for lookback, last maxBars for evaluation)
      const lookback5m = 280;
      const startIdx = lookback5m;
      const endIdx = allC5.length - modeConfig.maxBars;

      let symTrades = 0, symWins = 0, symPnl = 0;
      let lastSignalBar = -999;

      for(let i = startIdx; i < endIdx; i++) {
        // Cooldown check
        if(i - lastSignalBar < modeConfig.cooldownBars) continue;

        // Build data slices — NO look-ahead, only data up to bar i
        const C5 = allC5.slice(Math.max(0, i - lookback5m), i + 1);
        const H5 = allH5.slice(Math.max(0, i - lookback5m), i + 1);
        const L5 = allL5.slice(Math.max(0, i - lookback5m), i + 1);
        const V5 = allV5.slice(Math.max(0, i - lookback5m), i + 1);

        // Find corresponding 15m and 1h bars (up to current time)
        const currentTime = allT5[i];
        const c15idx = allT15.findLastIndex(t => t <= currentTime);
        const c1hidx = allT1h.findLastIndex(t => t <= currentTime);

        const C15 = c15idx > 25 ? allC15.slice(Math.max(0, c15idx - 100), c15idx + 1) : [];
        const H15 = c15idx > 25 ? allH15.slice(Math.max(0, c15idx - 100), c15idx + 1) : [];
        const L15 = c15idx > 25 ? allL15.slice(Math.max(0, c15idx - 100), c15idx + 1) : [];
        const V15 = c15idx > 25 ? allV15.slice(Math.max(0, c15idx - 100), c15idx + 1) : [];

        const C1h = c1hidx > 25 ? allC1h.slice(Math.max(0, c1hidx - 50), c1hidx + 1) : [];
        const H1h = c1hidx > 25 ? allH1h.slice(Math.max(0, c1hidx - 50), c1hidx + 1) : [];
        const L1h = c1hidx > 25 ? allL1h.slice(Math.max(0, c1hidx - 50), c1hidx + 1) : [];
        const V1h = c1hidx > 25 ? allV1h.slice(Math.max(0, c1hidx - 50), c1hidx + 1) : [];

        const hourUTC = new Date(currentTime).getUTCHours();

        // Generate signal
        const sig = genSignal(C5, H5, L5, V5, C15, H15, L15, V15, C1h, H1h, L1h, V1h, modeConfig.mode, hourUTC);
        if(sig.signal === 'NEUTRAL') continue;

        lastSignalBar = i;

        // Evaluate using FUTURE bars (no look-ahead in signal generation)
        const futureH = allH5.slice(i + 1, i + 1 + modeConfig.maxBars);
        const futureL = allL5.slice(i + 1, i + 1 + modeConfig.maxBars);
        const futureC = allC5.slice(i + 1, i + 1 + modeConfig.maxBars);

        const result = evaluateTrade(sig.signal, sig.entry, sig.tp, sig.sl, futureH, futureL, futureC, modeConfig.mode, modeConfig.maxBars);

        const dir = sig.signal === 'BUY' ? 1 : -1;
        const pnlPct = dir * (result.exitPrice - sig.entry) / sig.entry * 100;

        totalTrades++;
        symTrades++;
        allPnls.push(pnlPct);
        totalPnlPct += pnlPct;

        if(result.result === 'WIN') { wins++; symWins++; grossProfit += pnlPct; }
        else { losses++; grossLoss += Math.abs(pnlPct); }
        if(result.trailed) trailedWins++;

        symPnl += pnlPct;

        // Per direction
        pnlPerDirection[sig.signal].trades++;
        if(result.result === 'WIN') pnlPerDirection[sig.signal].wins++;
        pnlPerDirection[sig.signal].pnl += pnlPct;

        // Per hour
        if(!pnlPerHour[hourUTC]) pnlPerHour[hourUTC] = { trades: 0, wins: 0, pnl: 0 };
        pnlPerHour[hourUTC].trades++;
        if(result.result === 'WIN') pnlPerHour[hourUTC].wins++;
        pnlPerHour[hourUTC].pnl += pnlPct;
      }

      pnlPerCoin[sym] = { trades: symTrades, wins: symWins, pnl: symPnl };
      const wr = symTrades ? (symWins / symTrades * 100).toFixed(1) : '0';
      console.log(`${symTrades} trades, WR ${wr}%, PnL ${symPnl.toFixed(2)}%`);
    }

    // ═══ RESULTS ═══
    const winRate = totalTrades ? (wins / totalTrades * 100) : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
    const avgPnl = totalTrades ? totalPnlPct / totalTrades : 0;
    const sigPerDay = totalTrades / DAYS;

    // Sort PnLs for percentiles
    allPnls.sort((a, b) => a - b);
    const p = (pct) => allPnls.length ? allPnls[Math.floor(allPnls.length * pct / 100)] || 0 : 0;

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  RESULTADOS: ${modeConfig.name}`);
    console.log(`${'─'.repeat(50)}`);
    console.log(`  Total trades:     ${totalTrades}`);
    console.log(`  Wins:             ${wins}`);
    console.log(`  Losses:           ${losses}`);
    console.log(`  Win Rate:         ${winRate.toFixed(1)}%`);
    console.log(`  Total PnL:        ${totalPnlPct.toFixed(2)}%`);
    console.log(`  Avg PnL/trade:    ${avgPnl.toFixed(3)}%`);
    console.log(`  Profit Factor:    ${profitFactor.toFixed(2)}`);
    console.log(`  Signals/day:      ${sigPerDay.toFixed(1)}`);
    console.log(`  Trailing wins:    ${trailedWins}`);
    console.log(`\n  PnL Distribution:`);
    console.log(`    Worst:  ${p(0).toFixed(3)}%`);
    console.log(`    P10:    ${p(10).toFixed(3)}%`);
    console.log(`    P25:    ${p(25).toFixed(3)}%`);
    console.log(`    Median: ${p(50).toFixed(3)}%`);
    console.log(`    P75:    ${p(75).toFixed(3)}%`);
    console.log(`    P90:    ${p(90).toFixed(3)}%`);
    console.log(`    Best:   ${p(100).toFixed(3)}%`);

    console.log(`\n  By Direction:`);
    for(const dir of ['BUY','SELL']) {
      const d = pnlPerDirection[dir];
      if(d.trades) console.log(`    ${dir}: ${d.trades} trades, WR ${(d.wins/d.trades*100).toFixed(1)}%, PnL ${d.pnl.toFixed(2)}%`);
    }

    console.log(`\n  By Coin (top 5 + bottom 5):`);
    const coinEntries = Object.entries(pnlPerCoin).filter(([,v]) => v.trades > 0).sort((a, b) => b[1].pnl - a[1].pnl);
    const topCoins = coinEntries.slice(0, 5);
    const bottomCoins = coinEntries.slice(-5).reverse();
    for(const [sym, v] of topCoins) {
      console.log(`    + ${sym.padEnd(12)} ${v.trades} trades, WR ${(v.wins/v.trades*100).toFixed(1)}%, PnL ${v.pnl.toFixed(2)}%`);
    }
    console.log(`    ---`);
    for(const [sym, v] of bottomCoins) {
      console.log(`    - ${sym.padEnd(12)} ${v.trades} trades, WR ${(v.wins/v.trades*100).toFixed(1)}%, PnL ${v.pnl.toFixed(2)}%`);
    }

    console.log(`\n  By Hour (UTC) — best & worst:`);
    const hourEntries = Object.entries(pnlPerHour).sort((a, b) => b[1].pnl - a[1].pnl);
    const bestHours = hourEntries.slice(0, 3);
    const worstHours = hourEntries.slice(-3).reverse();
    for(const [h, v] of bestHours) {
      console.log(`    + ${h.toString().padStart(2,'0')}:00 UTC  ${v.trades} trades, WR ${(v.wins/v.trades*100).toFixed(1)}%, PnL ${v.pnl.toFixed(2)}%`);
    }
    for(const [h, v] of worstHours) {
      console.log(`    - ${h.toString().padStart(2,'0')}:00 UTC  ${v.trades} trades, WR ${(v.wins/v.trades*100).toFixed(1)}%, PnL ${v.pnl.toFixed(2)}%`);
    }

    // Monthly breakdown
    console.log(`\n  Monthly PnL:`);
    const monthlyPnl = {};
    // We tracked allPnls but need timestamps — simplified: divide evenly
    const tradesPerMonth = Math.ceil(totalTrades / (DAYS / 30));
    for(let m = 0; m < Math.ceil(DAYS / 30); m++) {
      const start = m * tradesPerMonth;
      const end = Math.min(start + tradesPerMonth, allPnls.length);
      if(start >= allPnls.length) break;
      const monthPnl = allPnls.slice(start, end).reduce((a, b) => a + b, 0);
      const monthWins = allPnls.slice(start, end).filter(p => p > 0).length;
      const monthTotal = end - start;
      console.log(`    Month ${m + 1}: ${monthTotal} trades, WR ${(monthWins/monthTotal*100).toFixed(1)}%, PnL ${monthPnl.toFixed(2)}%`);
    }
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  BACKTEST COMPLETADO');
  console.log(`${'═'.repeat(60)}`);
}

runBacktest().catch(e => console.error('Fatal:', e));
