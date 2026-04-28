// ══════════════════════════════════════════════════════════════════
// RX PRO — FULL BACKTESTING ENGINE (Real Binance Data, 14 Days)
// Replicates genSig() logic EXACTLY for strict, scalp, frequent modes
// ══════════════════════════════════════════════════════════════════

const https = require('https');

// ═══ CONFIGURATION ═══
const CAPITAL = 10000;
const POS_SIZE = 500;
const LEVERAGE = 5;
const FEE_RT = 0.0008; // 0.08% round-trip
const TIMEOUT_CANDLES = 50; // 4h10m default
const TF = '5m';
const DAYS = 14;
const CANDLES_NEEDED = DAYS * 24 * 12 + 280; // 14 days + warmup

const VIP_SCAN_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','AVAXUSDT','ADAUSDT','DOTUSDT','LINKUSDT','APTUSDT','NEARUSDT','FILUSDT','UNIUSDT','ARBUSDT','OPUSDT','SHIBUSDT','SUIUSDT','SEIUSDT','TIAUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT'];
const SCALP_SCAN_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','DOTUSDT','NEARUSDT','APTUSDT','ARBUSDT','OPUSDT','SUIUSDT','SEIUSDT','FILUSDT','UNIUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT','TIAUSDT','ATOMUSDT'];
const FREE_SCAN_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];

// Cooldowns in candles
const COOLDOWN = { strict: 24, scalp: 12, frequent: 8 };

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
function calcKeltner(H,L,C,emaLen=20,atrLen=14,mult=2){if(C.length<Math.max(emaLen,atrLen)+1)return{upper:0,mid:0,lower:0,width:0,position:0.5};const mid=calcEMA(C,emaLen);const atr=calcATR(H,L,C,atrLen);const upper=mid+mult*atr;const lower=mid-mult*atr;const range=upper-lower;const width=mid?range/mid:0;const cur=C.at(-1);const position=range>0?(cur-lower)/range:0.5;return{upper,mid,lower,width,position,atr};}
function calcVWAP(klines){let cumVol=0;let cumVolPrice=0;const vwapArr=[];for(const k of klines){const typPrice=(k[2]+k[3]+k[4])/3;const vol=k[5];cumVol+=vol;cumVolPrice+=(typPrice*vol);vwapArr.push(cumVolPrice/cumVol);}return vwapArr;}
function calcParabolicSAR(H,L,C){if(C.length<5)return{sar:C.at(-1),trend:'BUY',recentFlip:false};let af=0.02,maxAf=0.2,sar=L[0],ep=H[0],isUp=true;let lastFlipIdx=0;for(let i=1;i<C.length;i++){const pSar=sar+af*(ep-sar);if(isUp){sar=Math.min(pSar,L[i-1],i>1?L[i-2]:L[i-1]);if(L[i]<sar){isUp=false;sar=ep;ep=L[i];af=0.02;lastFlipIdx=i;}else{if(H[i]>ep){ep=H[i];af=Math.min(af+0.02,maxAf);}sar=pSar;}}else{sar=Math.max(pSar,H[i-1],i>1?H[i-2]:H[i-1]);if(H[i]>sar){isUp=true;sar=ep;ep=H[i];af=0.02;lastFlipIdx=i;}else{if(L[i]<ep){ep=L[i];af=Math.min(af+0.02,maxAf);}sar=pSar;}}}const recentFlip=(C.length-1-lastFlipIdx)<=5;return{sar,trend:isUp?'BUY':'SELL',recentFlip};}
function detectRegime(H,L,C,adxPre,atrPre){const adx=adxPre||calcADX(H,L,C);const atr=atrPre||calcATR(H,L,C,14);const avgP=C.slice(-20).reduce((a,b)=>a+b)/20;const atrPct=atr/avgP*100;if(adx.adx>25&&atrPct>1.5)return{regime:'TRENDING',label:'TENDENCIA',cls:'trending'};if(adx.adx<20&&atrPct<0.8)return{regime:'QUIET',label:'QUIETO',cls:'quiet'};if(atrPct>2)return{regime:'VOLATILE',label:'VOLATIL',cls:'volatile'};return{regime:'RANGING',label:'RANGO',cls:'ranging'};}
function detectRSIDivergence(C,H,L,period=14){if(C.length<period+25)return{bull:false,bear:false};const rsiArr=[];let ag=0,al=0;for(let i=1;i<=period;i++){const d=C[i]-C[i-1];if(d>0)ag+=d;else al+=Math.abs(d);}ag/=period;al/=period;rsiArr.push(al===0?100:100-(100/(1+ag/al)));for(let i=period+1;i<C.length;i++){const d=C[i]-C[i-1];ag=(ag*(period-1)+(d>0?d:0))/period;al=(al*(period-1)+(d<0?Math.abs(d):0))/period;rsiArr.push(al===0?100:100-(100/(1+ag/al)));}const len=Math.min(rsiArr.length,40);const priceTail=C.slice(-len);const rsiTail=rsiArr.slice(-len);let priceLows=[],priceHighs=[];for(let i=3;i<len-3;i++){let isLow=true,isHigh=true;for(let j=1;j<=3;j++){if(priceTail[i]>priceTail[i-j]||priceTail[i]>priceTail[i+j])isLow=false;if(priceTail[i]<priceTail[i-j]||priceTail[i]<priceTail[i+j])isHigh=false;}if(isLow)priceLows.push({idx:i,price:priceTail[i],rsi:rsiTail[i]});if(isHigh)priceHighs.push({idx:i,price:priceTail[i],rsi:rsiTail[i]});}let bull=false;if(priceLows.length>=2){const[prev,last]=priceLows.slice(-2);if(last.idx-prev.idx>=5&&last.price<prev.price&&last.rsi>prev.rsi+2)bull=true;}let bear=false;if(priceHighs.length>=2){const[prev,last]=priceHighs.slice(-2);if(last.idx-prev.idx>=5&&last.price>prev.price&&last.rsi<prev.rsi-2)bear=true;}return{bull,bear};}
function detectMACDDivergence(C){if(C.length<40)return{bull:false,bear:false};const e12=calcEMAArr(C,12),e26=calcEMAArr(C,26);const macdLine=e12.map((v,i)=>v-e26[i]);const len=Math.min(macdLine.length,40);const priceTail=C.slice(-len);const macdTail=macdLine.slice(-len);let priceLows=[],priceHighs=[];for(let i=3;i<len-3;i++){let isLow=true,isHigh=true;for(let j=1;j<=3;j++){if(priceTail[i]>priceTail[i-j]||priceTail[i]>priceTail[i+j])isLow=false;if(priceTail[i]<priceTail[i-j]||priceTail[i]<priceTail[i+j])isHigh=false;}if(isLow)priceLows.push({idx:i,price:priceTail[i],macd:macdTail[i]});if(isHigh)priceHighs.push({idx:i,price:priceTail[i],macd:macdTail[i]});}let bull=false,bear=false;if(priceLows.length>=2){const[prev,last]=priceLows.slice(-2);if(last.idx-prev.idx>=5&&last.price<prev.price&&last.macd>prev.macd)bull=true;}if(priceHighs.length>=2){const[prev,last]=priceHighs.slice(-2);if(last.idx-prev.idx>=5&&last.price>prev.price&&last.macd<prev.macd)bear=true;}return{bull,bear};}
function detectOrderBlocks(H,L,C,V,lookback=50){if(C.length<lookback)return{bullOB:null,bearOB:null};const tail=C.length-lookback;let bullOB=null,bearOB=null;const avgV=V.slice(tail).reduce((a,b)=>a+b)/(lookback||1);for(let i=tail+2;i<C.length-1;i++){const body=Math.abs(C[i]-C[i-1]);const prevBody=Math.abs(C[i-1]-C[i-2]);const isImbalance=prevBody>0&&body>prevBody*2;const isHighVol=V[i]>avgV*1.5;if(isImbalance&&isHighVol){if(C[i]>C[i-1]){bullOB={price:Math.min(C[i-1],L[i]),high:H[i],idx:i};}else{bearOB={price:Math.max(C[i-1],H[i]),low:L[i],idx:i};}}}const cur=C.at(-1);const atr=calcATR(H,L,C,14);if(bullOB&&(cur-bullOB.price)>atr*2)bullOB=null;if(bullOB&&(bullOB.price-cur)>atr*1)bullOB=null;if(bearOB&&(bearOB.price-cur)>atr*2)bearOB=null;if(bearOB&&(cur-bearOB.price)>atr*1)bearOB=null;return{bullOB,bearOB};}
function findPivotLevels(H,L,C,lookback=50){const h=H.slice(-lookback),l=L.slice(-lookback);let supports=[],resistances=[];for(let i=2;i<h.length-2;i++){if(h[i]>=h[i-1]&&h[i]>=h[i-2]&&h[i]>=h[i+1]&&h[i]>=h[i+2])resistances.push(h[i]);if(l[i]<=l[i-1]&&l[i]<=l[i-2]&&l[i]<=l[i+1]&&l[i]<=l[i+2])supports.push(l[i]);}const cur=C.at(-1);const nearestRes=resistances.filter(r=>r>cur).sort((a,b)=>a-b)[0]||null;const nearestSup=supports.filter(s=>s<cur).sort((a,b)=>b-a)[0]||null;return{nearestRes,nearestSup,supports,resistances};}

// ═══ BINANCE API ═══
function fetchKlines(sym, interval, limit=1000, endTime=null) {
  return new Promise((resolve, reject) => {
    let url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function getAllKlines(sym, interval, totalCandles) {
  let all = [];
  let endTime = null;
  while (all.length < totalCandles) {
    const limit = Math.min(1000, totalCandles - all.length);
    const batch = await fetchKlines(sym, interval, limit, endTime);
    if (!batch || !batch.length) break;
    all = batch.concat(all);
    endTime = batch[0][0] - 1;
    await sleep(100);
  }
  return all.slice(-totalCandles);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══ SIGNAL GENERATION (exact replica of genSig) ═══
function genSigFromData(C5, H5, L5, V5, C15, H15, L15, C1h, H1h, L1h, V1h, sym, mode, hourUTC, dayOfWeek) {
  const isStrict = mode === 'strict';
  const isScalp = mode === 'scalp';
  const cur = C5.at(-1);
  let B = 0, S = 0;
  const inds = [];

  // HTF Trend (1H)
  let htfTrend = 'NEUTRAL', htfStrength = 0;
  if (C1h.length > 25) {
    const ema9h = calcEMA(C1h,9), ema21h = calcEMA(C1h,21), ema50h = calcEMA(C1h,50);
    const rsi1h = calcRSI(C1h,14);
    const mac1h = calcMACD(C1h);
    const adx1h = calcADX(H1h,L1h,C1h);
    const obv1h = calcOBV(C1h,V1h);
    let hB=0, hS=0;
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
    inds.push({n:'HTF',v:htfTrend,s:'NEUTRAL'});
  }

  // MTF Confirm (15m)
  let mtfConfirm = 'NEUTRAL';
  if (C15.length > 25) {
    const ema9_15=calcEMA(C15,9),ema21_15=calcEMA(C15,21);
    const rsi15=calcRSI(C15,14);
    const mac15=calcMACD(C15);
    let mB=0,mS=0;
    if(ema9_15>ema21_15)mB+=1;else mS+=1;
    if(mac15.h>0)mB+=1;else mS+=1;
    if(rsi15>50)mB+=0.5;else if(rsi15<50)mS+=0.5;
    if(mB>mS)mtfConfirm='BUY';
    else if(mS>mB)mtfConfirm='SELL';
    inds.push({n:'MTF',v:mtfConfirm,s:'NEUTRAL'});
  }

  // 5m Indicators
  const rsi = calcRSI(C5,14);
  const mac = calcMACD(C5);
  const ea9 = calcEMAArr(C5,9), ea21 = calcEMAArr(C5,21);
  const e9 = ea9.at(-1), e21 = ea21.at(-1), e9p = ea9.at(-2), e21p = ea21.at(-2);
  const e50 = calcEMA(C5,50);
  const bb = calcBB(C5,20,2);
  const avgV = V5.slice(-20).reduce((a,b)=>a+b)/20;
  const lv = V5.at(-1);
  const vr = lv/avgV;
  const adxData = calcADX(H5,L5,C5);
  const obvData = calcOBV(C5,V5);
  const psar = calcParabolicSAR(H5,L5,C5);
  const stFull = calcStoch(H5,L5,C5,14);
  let atr = calcATR(H5,L5,C5,14);
  const rsiDiv = detectRSIDivergence(C5,H5,L5,14);
  const macdDiv = detectMACDDivergence(C5);

  let regimeData = detectRegime(H5,L5,C5,adxData,atr);
  const regime = regimeData.regime || 'RANGING';
  const isTrending = regime === 'TRENDING';
  const isQuiet = regime === 'QUIET';
  const isVolatile = regime === 'VOLATILE';

  const kc = calcKeltner(H5,L5,C5,20,14,2);
  let orderBlocks = {bullOB:null,bearOB:null};
  try { orderBlocks = detectOrderBlocks(H5,L5,C5,V5,50); } catch(e) {}

  // ═══ SCORING BY MODE ═══
  if (isStrict && isTrending) {
    // Trend-following mode for strict
    if(e9>e21&&e9p<=e21p){B+=2.5;inds.push({n:'EMA',v:'Cross↑',s:'BUY'});}
    else if(e9<e21&&e9p>=e21p){S+=2.5;inds.push({n:'EMA',v:'Cross↓',s:'SELL'});}
    else if(e9>e21){B+=0.5;inds.push({n:'EMA',v:'Bull',s:'BUY'});}
    else{S+=0.5;inds.push({n:'EMA',v:'Bear',s:'SELL'});}
    if(cur>e50){B+=0.5;inds.push({n:'E50',v:'Above',s:'BUY'});}else{S+=0.5;inds.push({n:'E50',v:'Below',s:'SELL'});}
    if(mac.h>0&&mac.ph<0){B+=2;inds.push({n:'MACD',v:'Cross+',s:'BUY'});}
    else if(mac.h<0&&mac.ph>0){S+=2;inds.push({n:'MACD',v:'Cross-',s:'SELL'});}
    else if(mac.h>0&&mac.h>mac.ph){B+=1;inds.push({n:'MACD',v:'Exp+',s:'BUY'});}
    else if(mac.h<0&&mac.h<mac.ph){S+=1;inds.push({n:'MACD',v:'Exp-',s:'SELL'});}
    else{inds.push({n:'MACD',v:'flat',s:'NEUTRAL'});}
    if(adxData.pdi>adxData.mdi){B+=2;inds.push({n:'ADX',v:'+DI',s:'BUY'});}else{S+=2;inds.push({n:'ADX',v:'-DI',s:'SELL'});}
    if(obvData.rising){B+=1;inds.push({n:'OBV',v:'↑',s:'BUY'});}else{S+=1;inds.push({n:'OBV',v:'↓',s:'SELL'});}
    if(psar.recentFlip){if(psar.trend==='BUY'){B+=1.5;inds.push({n:'PSAR',v:'Flip↑',s:'BUY'});}else{S+=1.5;inds.push({n:'PSAR',v:'Flip↓',s:'SELL'});}}
    else{if(psar.trend==='BUY'){B+=0.5;inds.push({n:'PSAR',v:'Bull',s:'BUY'});}else{S+=0.5;inds.push({n:'PSAR',v:'Bear',s:'SELL'});}}
    if(cur>calcEMA(C5,50)&&vr>0.7){B+=0.5;}else if(cur<calcEMA(C5,50)&&vr>0.7){S+=0.5;}
    if(kc.position>1.0){B+=1;inds.push({n:'KC',v:'Break↑',s:'BUY'});}
    else if(kc.position<0){S+=1;inds.push({n:'KC',v:'Break↓',s:'SELL'});}
    else if(kc.position>0.7){B+=0.3;}else if(kc.position<0.3){S+=0.3;}
    if(orderBlocks.bullOB&&cur<=orderBlocks.bullOB.price*1.005){B+=1.5;inds.push({n:'OB',v:'Bull',s:'BUY'});}
    else if(orderBlocks.bearOB&&cur>=orderBlocks.bearOB.price*0.995){S+=1.5;inds.push({n:'OB',v:'Bear',s:'SELL'});}
    if(rsiDiv.bull){B+=2.5;inds.push({n:'RDiv',v:'Bull',s:'BUY'});}else if(rsiDiv.bear){S+=2.5;inds.push({n:'RDiv',v:'Bear',s:'SELL'});}
    if(macdDiv.bull){B+=2;inds.push({n:'MDiv',v:'Bull',s:'BUY'});}else if(macdDiv.bear){S+=2;inds.push({n:'MDiv',v:'Bear',s:'SELL'});}
  } else if (isStrict && !isTrending) {
    // Mean-reversion for strict
    if(rsi<25){B+=4;inds.push({n:'RSI',v:rsi.toFixed(1),s:'BUY'});}
    else if(rsi<30){B+=3;inds.push({n:'RSI',v:rsi.toFixed(1),s:'BUY'});}
    else if(rsi<35){B+=2;inds.push({n:'RSI',v:rsi.toFixed(1),s:'BUY'});}
    else if(rsi>75){S+=4;inds.push({n:'RSI',v:rsi.toFixed(1),s:'SELL'});}
    else if(rsi>70){S+=3;inds.push({n:'RSI',v:rsi.toFixed(1),s:'SELL'});}
    else if(rsi>65){S+=2;inds.push({n:'RSI',v:rsi.toFixed(1),s:'SELL'});}
    else{inds.push({n:'RSI',v:rsi.toFixed(1),s:'NEUTRAL'});}

    if(stFull.k<20){B+=3;inds.push({n:'Stoch',v:stFull.k.toFixed(0),s:'BUY'});}
    else if(stFull.k<30){B+=2;inds.push({n:'Stoch',v:stFull.k.toFixed(0),s:'BUY'});}
    else if(stFull.k>80){S+=3;inds.push({n:'Stoch',v:stFull.k.toFixed(0),s:'SELL'});}
    else if(stFull.k>70){S+=2;inds.push({n:'Stoch',v:stFull.k.toFixed(0),s:'SELL'});}
    else{inds.push({n:'Stoch',v:stFull.k.toFixed(0),s:'NEUTRAL'});}

    const bbR=bb.u-bb.l;const bbPos=bbR>0?(cur-bb.l)/bbR:0.5;
    if(bbPos<0.1){B+=3;inds.push({n:'BB',v:'low',s:'BUY'});}
    else if(bbPos<0.2){B+=2;inds.push({n:'BB',v:'low',s:'BUY'});}
    else if(bbPos>0.9){S+=3;inds.push({n:'BB',v:'high',s:'SELL'});}
    else if(bbPos>0.8){S+=2;inds.push({n:'BB',v:'high',s:'SELL'});}
    else{inds.push({n:'BB',v:'mid',s:'NEUTRAL'});}

    const mom3=(cur-(C5[C5.length-4]||cur))/Math.max(atr,0.0001);
    if(mom3<-1){B+=2;inds.push({n:'Mom',v:'exh↓',s:'BUY'});}
    else if(mom3<-0.5){B+=1;inds.push({n:'Mom',v:'weak↓',s:'BUY'});}
    else if(mom3>1){S+=2;inds.push({n:'Mom',v:'exh↑',s:'SELL'});}
    else if(mom3>0.5){S+=1;inds.push({n:'Mom',v:'weak↑',s:'SELL'});}
    else{inds.push({n:'Mom',v:'flat',s:'NEUTRAL'});}

    let bearRun=0,bullRun=0;
    for(let ci=Math.max(0,C5.length-4);ci<C5.length;ci++){
      if(C5[ci]<(C5[ci-1]||C5[ci]))bearRun++;else bearRun=0;
      if(C5[ci]>(C5[ci-1]||C5[ci]))bullRun++;else bullRun=0;
    }
    if(bearRun>=4){B+=2;inds.push({n:'Candle',v:'4bear',s:'BUY'});}
    else if(bearRun>=3){B+=1;inds.push({n:'Candle',v:'3bear',s:'BUY'});}
    if(bullRun>=4){S+=2;inds.push({n:'Candle',v:'4bull',s:'SELL'});}
    else if(bullRun>=3){S+=1;inds.push({n:'Candle',v:'3bull',s:'SELL'});}

    const emaDist=(cur-e21)/Math.max(atr,0.0001);
    if(emaDist<-1.5){B+=1.5;inds.push({n:'EMAd',v:'vlow',s:'BUY'});}
    else if(emaDist<-0.8){B+=0.8;inds.push({n:'EMAd',v:'low',s:'BUY'});}
    else if(emaDist>1.5){S+=1.5;inds.push({n:'EMAd',v:'vhigh',s:'SELL'});}
    else if(emaDist>0.8){S+=0.8;inds.push({n:'EMAd',v:'high',s:'SELL'});}

    if(mac.h>0&&mac.ph<=0){B+=1.5;inds.push({n:'MACD',v:'cross↑',s:'BUY'});}
    else if(mac.h<0&&mac.ph>=0){S+=1.5;inds.push({n:'MACD',v:'cross↓',s:'SELL'});}
    else{inds.push({n:'MACD',v:'flat',s:'NEUTRAL'});}

    if(obvData.rising&&B>S){B+=1;inds.push({n:'OBV',v:'↑',s:'BUY'});}
    else if(!obvData.rising&&S>B){S+=1;inds.push({n:'OBV',v:'↓',s:'SELL'});}
    else{inds.push({n:'OBV',v:obvData.rising?'↑':'↓',s:'NEUTRAL'});}

    if(vr>1.5){if(B>S)B*=1.15;else S*=1.15;}

    if(kc.position<0.05){B+=2;inds.push({n:'KC',v:'exLow',s:'BUY'});}
    else if(kc.position<0.15){B+=1;inds.push({n:'KC',v:'low',s:'BUY'});}
    else if(kc.position>0.95){S+=2;inds.push({n:'KC',v:'exHigh',s:'SELL'});}
    else if(kc.position>0.85){S+=1;inds.push({n:'KC',v:'high',s:'SELL'});}
    else{inds.push({n:'KC',v:'mid',s:'NEUTRAL'});}

    if(rsiDiv.bull){B+=3;inds.push({n:'RDiv',v:'bull',s:'BUY'});}
    else if(rsiDiv.bear){S+=3;inds.push({n:'RDiv',v:'bear',s:'SELL'});}
    if(macdDiv.bull){B+=2;inds.push({n:'MDiv',v:'bull',s:'BUY'});}
    else if(macdDiv.bear){S+=2;inds.push({n:'MDiv',v:'bear',s:'SELL'});}

  } else if (isScalp) {
    // Scalp mode scoring
    const stochK=stFull.k||50;
    const bbRange=bb.u-bb.l;const bbP=bbRange>0?(cur-bb.l)/bbRange:0.5;
    const mom3val=(cur-(C5[C5.length-4]||cur))/Math.max(atr,0.0001);
    const emaDist21=(cur-e21)/Math.max(atr,0.0001);
    const last4=C5.slice(-4);
    const scalpBullExh=last4.length>=4&&last4.every((x,i)=>i===0||x>last4[i-1]);
    const scalpBearExh=last4.length>=4&&last4.every((x,i)=>i===0||x<last4[i-1]);

    if(rsi<25){B+=4;inds.push({n:'RSI',v:rsi.toFixed(1),s:'BUY'});}
    else if(rsi<30){B+=3;inds.push({n:'RSI',v:rsi.toFixed(1),s:'BUY'});}
    else if(rsi<38){B+=2;inds.push({n:'RSI',v:rsi.toFixed(1),s:'BUY'});}
    else if(rsi<45){B+=1;inds.push({n:'RSI',v:rsi.toFixed(1),s:'BUY'});}
    else if(rsi>75){S+=4;inds.push({n:'RSI',v:rsi.toFixed(1),s:'SELL'});}
    else if(rsi>70){S+=3;inds.push({n:'RSI',v:rsi.toFixed(1),s:'SELL'});}
    else if(rsi>62){S+=2;inds.push({n:'RSI',v:rsi.toFixed(1),s:'SELL'});}
    else if(rsi>55){S+=1;inds.push({n:'RSI',v:rsi.toFixed(1),s:'SELL'});}
    else{inds.push({n:'RSI',v:rsi.toFixed(1),s:'NEUTRAL'});}

    if(stochK<20){B+=3;inds.push({n:'Stoch',v:stochK.toFixed(0),s:'BUY'});}
    else if(stochK<35){B+=1.5;inds.push({n:'Stoch',v:stochK.toFixed(0),s:'BUY'});}
    else if(stochK>80){S+=3;inds.push({n:'Stoch',v:stochK.toFixed(0),s:'SELL'});}
    else if(stochK>65){S+=1.5;inds.push({n:'Stoch',v:stochK.toFixed(0),s:'SELL'});}
    else{inds.push({n:'Stoch',v:stochK.toFixed(0),s:'NEUTRAL'});}

    if(bbP<0.1){B+=3;inds.push({n:'BB',v:'low',s:'BUY'});}
    else if(bbP<0.25){B+=2;inds.push({n:'BB',v:'low',s:'BUY'});}
    else if(bbP>0.9){S+=3;inds.push({n:'BB',v:'high',s:'SELL'});}
    else if(bbP>0.75){S+=2;inds.push({n:'BB',v:'high',s:'SELL'});}
    else{inds.push({n:'BB',v:'mid',s:'NEUTRAL'});}

    if(mom3val<-0.8){B+=2;inds.push({n:'Mom',v:'exh↓',s:'BUY'});}
    else if(mom3val<-0.3){B+=1;inds.push({n:'Mom',v:'low',s:'BUY'});}
    else if(mom3val>0.8){S+=2;inds.push({n:'Mom',v:'exh↑',s:'SELL'});}
    else if(mom3val>0.3){S+=1;inds.push({n:'Mom',v:'high',s:'SELL'});}
    else{inds.push({n:'Mom',v:'flat',s:'NEUTRAL'});}

    if(scalpBearExh){B+=2;inds.push({n:'Candle',v:'4bear',s:'BUY'});}
    else if(scalpBullExh){S+=2;inds.push({n:'Candle',v:'4bull',s:'SELL'});}
    else{
      const l3=C5.slice(-3);
      if(l3.length>=3&&l3.every((x,i)=>i===0||x<l3[i-1])){B+=1;inds.push({n:'Candle',v:'3bear',s:'BUY'});}
      else if(l3.length>=3&&l3.every((x,i)=>i===0||x>l3[i-1])){S+=1;inds.push({n:'Candle',v:'3bull',s:'SELL'});}
      else{inds.push({n:'Candle',v:'mix',s:'NEUTRAL'});}
    }

    if(emaDist21<-1.2){B+=1.5;inds.push({n:'EMAd',v:'vlow',s:'BUY'});}
    else if(emaDist21<-0.6){B+=0.8;inds.push({n:'EMAd',v:'low',s:'BUY'});}
    else if(emaDist21>1.2){S+=1.5;inds.push({n:'EMAd',v:'vhigh',s:'SELL'});}
    else if(emaDist21>0.6){S+=0.8;inds.push({n:'EMAd',v:'high',s:'SELL'});}

    if(mac.h>0&&mac.ph<0){S+=1;inds.push({n:'MACD',v:'cross↑→S',s:'SELL'});}
    else if(mac.h<0&&mac.ph>0){B+=1;inds.push({n:'MACD',v:'cross↓→B',s:'BUY'});}
    else if(mac.h>0&&mac.h>mac.ph){S+=0.5;inds.push({n:'MACD',v:'exp+',s:'SELL'});}
    else if(mac.h<0&&mac.h<mac.ph){B+=0.5;inds.push({n:'MACD',v:'exp-',s:'BUY'});}
    else{inds.push({n:'MACD',v:'flat',s:'NEUTRAL'});}

    if(obvData.rising&&B>S){B+=0.8;inds.push({n:'OBV',v:'↑',s:'BUY'});}
    else if(!obvData.rising&&S>B){S+=0.8;inds.push({n:'OBV',v:'↓',s:'SELL'});}
    else{inds.push({n:'OBV',v:obvData.rising?'↑':'↓',s:'NEUTRAL'});}

    if(kc.position<0.05){B+=1.5;inds.push({n:'KC',v:'exLow',s:'BUY'});}
    else if(kc.position<0.2){B+=0.8;inds.push({n:'KC',v:'low',s:'BUY'});}
    else if(kc.position>0.95){S+=1.5;inds.push({n:'KC',v:'exHigh',s:'SELL'});}
    else if(kc.position>0.8){S+=0.8;inds.push({n:'KC',v:'high',s:'SELL'});}

    if(rsiDiv.bull){B+=2;inds.push({n:'RDiv',v:'bull',s:'BUY'});}
    else if(rsiDiv.bear){S+=2;inds.push({n:'RDiv',v:'bear',s:'SELL'});}
    if(vr>1.5){if(B>S)B*=1.15;else S*=1.15;}

  } else {
    // Free mode scoring
    const freeStoch=stFull.k||50;
    const freeBBR=bb.u-bb.l;const freeBBPos=freeBBR>0?(cur-bb.l)/freeBBR:0.5;

    if(rsi<28){B+=3;inds.push({n:'RSI',v:rsi.toFixed(1),s:'BUY'});}
    else if(rsi<35){B+=2;inds.push({n:'RSI',v:rsi.toFixed(1),s:'BUY'});}
    else if(rsi<40){B+=1;inds.push({n:'RSI',v:rsi.toFixed(1),s:'BUY'});}
    else if(rsi>72){S+=3;inds.push({n:'RSI',v:rsi.toFixed(1),s:'SELL'});}
    else if(rsi>65){S+=2;inds.push({n:'RSI',v:rsi.toFixed(1),s:'SELL'});}
    else if(rsi>60){S+=1;inds.push({n:'RSI',v:rsi.toFixed(1),s:'SELL'});}
    else{inds.push({n:'RSI',v:rsi.toFixed(1),s:'NEUTRAL'});}

    if(freeStoch<25){B+=2;inds.push({n:'Stoch',v:freeStoch.toFixed(0),s:'BUY'});}
    else if(freeStoch<35){B+=1;inds.push({n:'Stoch',v:freeStoch.toFixed(0),s:'BUY'});}
    else if(freeStoch>75){S+=2;inds.push({n:'Stoch',v:freeStoch.toFixed(0),s:'SELL'});}
    else if(freeStoch>65){S+=1;inds.push({n:'Stoch',v:freeStoch.toFixed(0),s:'SELL'});}
    else{inds.push({n:'Stoch',v:freeStoch.toFixed(0),s:'NEUTRAL'});}

    if(freeBBPos<0.15){B+=2;inds.push({n:'BB',v:'low',s:'BUY'});}
    else if(freeBBPos<0.25){B+=1;inds.push({n:'BB',v:'low',s:'BUY'});}
    else if(freeBBPos>0.85){S+=2;inds.push({n:'BB',v:'high',s:'SELL'});}
    else if(freeBBPos>0.75){S+=1;inds.push({n:'BB',v:'high',s:'SELL'});}
    else{inds.push({n:'BB',v:'mid',s:'NEUTRAL'});}

    const freeMom3=(cur-(C5[C5.length-4]||cur))/Math.max(atr,0.0001);
    if(freeMom3<-0.8){B+=1;inds.push({n:'Mom',v:'exh↓',s:'BUY'});}
    else if(freeMom3>0.8){S+=1;inds.push({n:'Mom',v:'exh↑',s:'SELL'});}
    else{inds.push({n:'Mom',v:'flat',s:'NEUTRAL'});}

    if(mac.h>0&&mac.ph<0){B+=1;inds.push({n:'MACD',v:'cross↑',s:'BUY'});}
    else if(mac.h<0&&mac.ph>0){S+=1;inds.push({n:'MACD',v:'cross↓',s:'SELL'});}
    else{inds.push({n:'MACD',v:'flat',s:'NEUTRAL'});}

    if(obvData.rising){B+=0.5;inds.push({n:'OBV',v:'↑',s:'BUY'});}
    else{S+=0.5;inds.push({n:'OBV',v:'↓',s:'SELL'});}
  }

  // Volume info (non-scalp)
  if(!isScalp){
    if(vr>1.5&&B>S)B*=1.1;
    else if(vr>1.5&&S>B)S*=1.1;
  }

  // ═══ DECISION ENGINE ═══
  const buyInds = inds.filter(i=>i.s==='BUY').length;
  const sellInds = inds.filter(i=>i.s==='SELL').length;

  // Low-liquidity penalty
  let conf = Math.min(99, Math.round((Math.max(B,S)/Math.max(1,B+S))*100));
  if(!['BTCUSDT','ETHUSDT'].includes(sym)) conf = Math.max(0, conf-3);

  // Price action
  let buyPressure=0,sellPressure=0;
  for(let i=C5.length-5;i<C5.length;i++){
    const open=i>0?C5[i-1]:C5[i];
    const body=C5[i]-open;
    const upperWick=H5[i]-Math.max(C5[i],open);
    const lowerWick=Math.min(C5[i],open)-L5[i];
    if(body>0){buyPressure+=body+lowerWick*0.5;sellPressure+=upperWick*0.3;}
    else{sellPressure+=Math.abs(body)+upperWick*0.5;buyPressure+=lowerWick*0.3;}
  }
  const flowRatio=buyPressure/Math.max(0.001,sellPressure);
  const flowBull=flowRatio>1.4;
  const flowBear=flowRatio<0.7;

  let signal = 'NEUTRAL';

  if (isStrict) {
    const vipMinConv=8, vipMinConds=3;
    if(isTrending){/* blocked */}
    else if(B>S&&B>=vipMinConv&&buyInds>=vipMinConds) signal='BUY';
    else if(S>B&&S>=vipMinConv&&sellInds>=vipMinConds) signal='SELL';

    // F1: ADX cap
    if(signal!=='NEUTRAL'&&adxData.adx>20) signal='NEUTRAL';
    // F2: Hour whitelist
    if(signal!=='NEUTRAL'){
      const vipAllowedHours=[6,7,13,14,19,20,21,22,23];
      if(!vipAllowedHours.includes(hourUTC)) signal='NEUTRAL';
    }
    // F3: Volatile
    if(signal!=='NEUTRAL'&&isVolatile) signal='NEUTRAL';
    // F4: Saturday
    if(signal!=='NEUTRAL'&&dayOfWeek===6) signal='NEUTRAL';

    // Confidence
    if(signal!=='NEUTRAL'){
      const convScore=signal==='BUY'?B:S;
      const condCount=signal==='BUY'?buyInds:sellInds;
      conf=Math.min(90,Math.round(50+convScore*2.5+condCount*1.5));
      if(htfTrend===signal)conf=Math.min(90,conf+5);
      if(mtfConfirm===signal)conf=Math.min(90,conf+3);
      if(rsiDiv.bull&&signal==='BUY')conf=Math.min(90,conf+4);
      if(rsiDiv.bear&&signal==='SELL')conf=Math.min(90,conf+4);
      if(macdDiv.bull&&signal==='BUY')conf=Math.min(90,conf+3);
      if(macdDiv.bear&&signal==='SELL')conf=Math.min(90,conf+3);
      if((signal==='BUY'&&flowBull)||(signal==='SELL'&&flowBear))conf=Math.min(90,conf+2);
    }

    // Min volatility
    if(signal!=='NEUTRAL'){
      let atr15=atr;
      if(H15.length>15&&L15.length>15&&C15.length>15){const a15=calcATR(H15,L15,C15,14);if(a15>0)atr15=a15;}
      const volPct=atr15/cur;
      if(volPct<0.0008)signal='NEUTRAL';
    }

  } else if (isScalp) {
    const scalpMinConv=5,scalpMinConds=2,scalpAdxMax=22;
    if(B>S&&B>=scalpMinConv&&buyInds>=scalpMinConds)signal='BUY';
    else if(S>B&&S>=scalpMinConv&&sellInds>=scalpMinConds)signal='SELL';

    if(signal!=='NEUTRAL'&&adxData.adx>scalpAdxMax)signal='NEUTRAL';
    const scalpMaxConv=Math.max(B,S);
    if(signal==='BUY'&&mtfConfirm==='SELL'&&scalpMaxConv<7)signal='NEUTRAL';
    if(signal==='SELL'&&mtfConfirm==='BUY'&&scalpMaxConv<7)signal='NEUTRAL';
    // Hour whitelist
    const scalpAllowedH=[0,6,7,15,20,21,23];
    if(signal!=='NEUTRAL'&&!scalpAllowedH.includes(hourUTC))signal='NEUTRAL';
    // Day filter: block Sun/Mon/Tue
    if(signal!=='NEUTRAL'&&(dayOfWeek===0||dayOfWeek===1||dayOfWeek===2))signal='NEUTRAL';
    // Dominance
    if(signal!=='NEUTRAL'&&Math.max(B,S)<Math.min(B,S)*1.4)signal='NEUTRAL';
    // Dead volume
    if(signal!=='NEUTRAL'&&vr<0.3)signal='NEUTRAL';

    if(signal!=='NEUTRAL'){
      const maxConv=Math.max(B,S);
      const condCount=signal==='BUY'?buyInds:sellInds;
      conf=Math.min(88,Math.max(52,Math.round(48+maxConv*2.5+condCount*2)));
      if(htfTrend===signal)conf=Math.min(88,conf+4);
      if(mtfConfirm===signal)conf=Math.min(88,conf+3);
      if(rsiDiv.bull&&signal==='BUY')conf=Math.min(88,conf+3);
      if(rsiDiv.bear&&signal==='SELL')conf=Math.min(88,conf+3);
    }

  } else {
    // Free mode
    const freeMinConv=5,freeMinConds=2;
    if(B>S&&B>=freeMinConv&&buyInds>=freeMinConds)signal='BUY';
    else if(S>B&&S>=freeMinConv&&sellInds>=freeMinConds)signal='SELL';

    if(signal!=='NEUTRAL'&&isTrending)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&isVolatile)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&adxData.adx>30)signal='NEUTRAL';
    const freeAllowedHours=[6,10,18,20,21,23];
    if(signal!=='NEUTRAL'&&!freeAllowedHours.includes(hourUTC))signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&vr<0.4)signal='NEUTRAL';

    if(signal!=='NEUTRAL'){
      const convScore=signal==='BUY'?B:S;
      const condCount=signal==='BUY'?buyInds:sellInds;
      conf=Math.min(75,Math.round(40+convScore*2+condCount*1.5));
    }
  }

  // ═══ TP/SL ═══
  let atr15=atr;
  if(H15.length>15&&L15.length>15&&C15.length>15){const a15=calcATR(H15,L15,C15,14);if(a15>0)atr15=a15;}
  let atr1h=atr;
  if(H1h.length>15&&L1h.length>15&&C1h.length>15){const a1h=calcATR(H1h,L1h,C1h,14);if(a1h>0)atr1h=a1h;}
  const blendedATR=Math.max(atr15,atr1h/4);

  let tpDist,slDist,useATR;
  if(isScalp){
    useATR=atr15||blendedATR;
    tpDist=useATR*1.3;slDist=useATR*1.0;
  }else if(isStrict){
    useATR=blendedATR;tpDist=useATR*1.5;slDist=useATR*1.0;
  }else{
    useATR=blendedATR;tpDist=useATR*1.5;slDist=useATR*1.0;
  }

  if(isScalp){
    const minTP=cur*0.0015;
    if(tpDist<minTP)tpDist=minTP;
    if(slDist<minTP)slDist=minTP;
  }else{
    const minTP=cur*0.0012;
    if(tpDist<minTP)tpDist=minTP;
    if(slDist<minTP*0.67)slDist=minTP*0.67;
  }
  if(!isStrict&&!isScalp&&tpDist<slDist*1.2)tpDist=slDist*1.2;

  const costBuffer=cur*0.0008;

  // S/R filter
  if(signal!=='NEUTRAL'&&(isStrict||isScalp)){
    try{
      let pivotH=H5,pivotL=L5,pivotC=C5;
      if(H1h.length>20){pivotH=H1h;pivotL=L1h;pivotC=C1h;}
      const pivots=findPivotLevels(pivotH,pivotL,pivotC,50);
      if(signal==='BUY'&&pivots.nearestRes){
        const distToRes=pivots.nearestRes-cur;
        if(distToRes>0&&distToRes<tpDist*0.7){
          if(distToRes>slDist*1.2)tpDist=distToRes*0.92;
          else signal='NEUTRAL';
        }
      }
      if(signal==='SELL'&&pivots.nearestSup){
        const distToSup=cur-pivots.nearestSup;
        if(distToSup>0&&distToSup<tpDist*0.7){
          if(distToSup>slDist*1.2)tpDist=distToSup*0.92;
          else signal='NEUTRAL';
        }
      }
    }catch(e){}
  }

  const tp=signal==='BUY'?cur+tpDist+costBuffer:signal==='SELL'?cur-tpDist-costBuffer:null;
  const sl=signal==='BUY'?cur-slDist-costBuffer:signal==='SELL'?cur+slDist+costBuffer:null;

  return { signal, confidence: conf, B, S, entry: cur, tp, sl, tpDist, slDist, regime, buyInds, sellInds };
}

// ═══ MAIN BACKTEST FUNCTION ═══
async function runBacktest(mode, symbols) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  BACKTESTING: ${mode.toUpperCase()} MODE — ${symbols.length} pairs, ${DAYS} days`);
  console.log(`${'═'.repeat(60)}`);

  const trades = [];
  const signalsGenerated = { total: 0, buy: 0, sell: 0 };
  const filtersBlocked = {};
  const hourlyStats = {};
  const dayStats = {};
  const regimeStats = {};
  const pairStats = {};

  for (const sym of symbols) {
    console.log(`  Fetching ${sym}...`);
    let kl5, kl15, kl1h;
    try {
      kl5 = await getAllKlines(sym, '5m', CANDLES_NEEDED);
      await sleep(200);
      kl15 = await getAllKlines(sym, '15m', 500);
      await sleep(200);
      kl1h = await getAllKlines(sym, '1h', 200);
      await sleep(200);
    } catch(e) {
      console.log(`  ⚠️ Failed to fetch ${sym}: ${e.message}`);
      continue;
    }

    if (!kl5 || kl5.length < 300) {
      console.log(`  ⚠️ Not enough data for ${sym} (${kl5?.length || 0} candles)`);
      continue;
    }

    const C5full = kl5.map(k => parseFloat(k[4]));
    const H5full = kl5.map(k => parseFloat(k[2]));
    const L5full = kl5.map(k => parseFloat(k[3]));
    const V5full = kl5.map(k => parseFloat(k[5]));

    // Build 15m and 1h arrays
    const C15full = kl15 ? kl15.map(k => parseFloat(k[4])) : [];
    const H15full = kl15 ? kl15.map(k => parseFloat(k[2])) : [];
    const L15full = kl15 ? kl15.map(k => parseFloat(k[3])) : [];
    const C1hfull = kl1h ? kl1h.map(k => parseFloat(k[4])) : [];
    const H1hfull = kl1h ? kl1h.map(k => parseFloat(k[2])) : [];
    const L1hfull = kl1h ? kl1h.map(k => parseFloat(k[3])) : [];
    const V1hfull = kl1h ? kl1h.map(k => parseFloat(k[5])) : [];

    // Only backtest on last 14 days (skip warmup)
    const startIdx = 280; // warmup candles
    const cooldown = COOLDOWN[mode];
    let lastSignalIdx = -cooldown - 1;
    const activeTrades = []; // track open trades

    if (!pairStats[sym]) pairStats[sym] = { trades: 0, wins: 0, pnl: 0 };

    for (let i = startIdx; i < C5full.length - TIMEOUT_CANDLES; i++) {
      const candleTime = new Date(parseInt(kl5[i][0]));
      const hourUTC = candleTime.getUTCHours();
      const dayOfWeek = candleTime.getUTCDay();

      // Check if we can open a new position (cooldown)
      if (i - lastSignalIdx < cooldown) continue;

      // Window of data for indicators
      const windowSize = 280;
      const start = Math.max(0, i - windowSize + 1);
      const C5 = C5full.slice(start, i + 1);
      const H5 = H5full.slice(start, i + 1);
      const L5 = L5full.slice(start, i + 1);
      const V5 = V5full.slice(start, i + 1);

      // Map 5m index to 15m and 1h indices
      const time5m = parseInt(kl5[i][0]);
      // Find the 15m candle that contains this 5m candle
      let idx15 = -1;
      if (kl15) {
        for (let j = kl15.length - 1; j >= 0; j--) {
          if (parseInt(kl15[j][0]) <= time5m) { idx15 = j; break; }
        }
      }
      let idx1h = -1;
      if (kl1h) {
        for (let j = kl1h.length - 1; j >= 0; j--) {
          if (parseInt(kl1h[j][0]) <= time5m) { idx1h = j; break; }
        }
      }

      const C15 = idx15 > 30 ? C15full.slice(0, idx15 + 1) : [];
      const H15 = idx15 > 30 ? H15full.slice(0, idx15 + 1) : [];
      const L15 = idx15 > 30 ? L15full.slice(0, idx15 + 1) : [];
      const C1h = idx1h > 30 ? C1hfull.slice(0, idx1h + 1) : [];
      const H1h = idx1h > 30 ? H1hfull.slice(0, idx1h + 1) : [];
      const L1h = idx1h > 30 ? L1hfull.slice(0, idx1h + 1) : [];
      const V1h = idx1h > 30 ? V1hfull.slice(0, idx1h + 1) : [];

      if (C5.length < 100) continue;

      const sig = genSigFromData(C5, H5, L5, V5, C15, H15, L15, C1h, H1h, L1h, V1h, sym, mode, hourUTC, dayOfWeek);

      signalsGenerated.total++;
      if (sig.signal === 'BUY') signalsGenerated.buy++;
      if (sig.signal === 'SELL') signalsGenerated.sell++;

      if (sig.signal === 'NEUTRAL') continue;

      // Signal generated! Simulate trade
      lastSignalIdx = i;
      const entry = sig.entry;
      const tp = sig.tp;
      const sl = sig.sl;
      const direction = sig.signal;

      // Walk forward to find exit
      let exitPrice = null;
      let exitType = null;
      let exitIdx = null;

      for (let j = i + 1; j < Math.min(i + TIMEOUT_CANDLES + 1, C5full.length); j++) {
        const high = H5full[j];
        const low = L5full[j];

        if (direction === 'BUY') {
          // Check SL first (worse case)
          if (low <= sl) { exitPrice = sl; exitType = 'SL'; exitIdx = j; break; }
          if (high >= tp) { exitPrice = tp; exitType = 'TP'; exitIdx = j; break; }
        } else {
          if (high >= sl) { exitPrice = sl; exitType = 'SL'; exitIdx = j; break; }
          if (low <= tp) { exitPrice = tp; exitType = 'TP'; exitIdx = j; break; }
        }
      }

      // Timeout
      if (!exitPrice) {
        exitIdx = Math.min(i + TIMEOUT_CANDLES, C5full.length - 1);
        exitPrice = C5full[exitIdx];
        exitType = 'TIMEOUT';
      }

      const dir = direction === 'BUY' ? 1 : -1;
      const rawPnlPct = dir * (exitPrice - entry) / entry;
      const netPnlPct = rawPnlPct - FEE_RT; // subtract fees
      const pnlDollars = POS_SIZE * LEVERAGE * netPnlPct;
      const durationCandles = exitIdx - i;
      const durationMin = durationCandles * 5;

      const trade = {
        sym, direction, entry, tp, sl, exitPrice, exitType,
        rawPnlPct, netPnlPct, pnlDollars, durationMin,
        confidence: sig.confidence, regime: sig.regime,
        hour: hourUTC, day: dayOfWeek,
        time: candleTime.toISOString(),
        B: sig.B, S: sig.S
      };
      trades.push(trade);

      // Stats
      pairStats[sym].trades++;
      pairStats[sym].pnl += pnlDollars;
      if (exitType === 'TP') pairStats[sym].wins++;
      else if (exitType === 'TIMEOUT' && netPnlPct > 0) pairStats[sym].wins++;

      if (!hourlyStats[hourUTC]) hourlyStats[hourUTC] = { trades: 0, wins: 0, pnl: 0 };
      hourlyStats[hourUTC].trades++;
      hourlyStats[hourUTC].pnl += pnlDollars;
      if (exitType === 'TP' || (exitType === 'TIMEOUT' && netPnlPct > 0)) hourlyStats[hourUTC].wins++;

      if (!dayStats[dayOfWeek]) dayStats[dayOfWeek] = { trades: 0, wins: 0, pnl: 0 };
      dayStats[dayOfWeek].trades++;
      dayStats[dayOfWeek].pnl += pnlDollars;
      if (exitType === 'TP' || (exitType === 'TIMEOUT' && netPnlPct > 0)) dayStats[dayOfWeek].wins++;

      if (!regimeStats[sig.regime]) regimeStats[sig.regime] = { trades: 0, wins: 0, pnl: 0 };
      regimeStats[sig.regime].trades++;
      regimeStats[sig.regime].pnl += pnlDollars;
      if (exitType === 'TP' || (exitType === 'TIMEOUT' && netPnlPct > 0)) regimeStats[sig.regime].wins++;
    }
  }

  // ═══ COMPUTE METRICS ═══
  const totalTrades = trades.length;
  const wins = trades.filter(t => t.netPnlPct > 0).length;
  const losses = trades.filter(t => t.netPnlPct <= 0).length;
  const wr = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
  const totalPnl = trades.reduce((s, t) => s + t.pnlDollars, 0);
  const totalPnlPct = totalPnl / CAPITAL * 100;
  const grossProfit = trades.filter(t => t.pnlDollars > 0).reduce((s, t) => s + t.pnlDollars, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnlDollars < 0).reduce((s, t) => s + t.pnlDollars, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const avgWin = wins > 0 ? grossProfit / wins : 0;
  const avgLoss = losses > 0 ? grossLoss / losses : 0;
  const expectancy = (wr/100 * avgWin) - ((1 - wr/100) * avgLoss);
  const avgDuration = totalTrades > 0 ? trades.reduce((s, t) => s + t.durationMin, 0) / totalTrades : 0;

  // Max drawdown
  let equity = CAPITAL;
  let peak = CAPITAL;
  let maxDD = 0;
  const equityCurve = [CAPITAL];
  for (const t of trades) {
    equity += t.pnlDollars;
    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Consecutive wins/losses
  let maxConsecWins = 0, maxConsecLosses = 0, cw = 0, cl = 0;
  for (const t of trades) {
    if (t.netPnlPct > 0) { cw++; cl = 0; if (cw > maxConsecWins) maxConsecWins = cw; }
    else { cl++; cw = 0; if (cl > maxConsecLosses) maxConsecLosses = cl; }
  }

  // Best/worst trade
  const bestTrade = trades.length > 0 ? trades.reduce((best, t) => t.pnlDollars > best.pnlDollars ? t : best, trades[0]) : null;
  const worstTrade = trades.length > 0 ? trades.reduce((worst, t) => t.pnlDollars < worst.pnlDollars ? t : worst, trades[0]) : null;

  // Sharpe ratio (daily)
  const dailyPnl = {};
  for (const t of trades) {
    const day = t.time.slice(0, 10);
    if (!dailyPnl[day]) dailyPnl[day] = 0;
    dailyPnl[day] += t.pnlDollars;
  }
  const dailyReturns = Object.values(dailyPnl);
  const avgDaily = dailyReturns.length > 0 ? dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length : 0;
  const stdDaily = dailyReturns.length > 1 ? Math.sqrt(dailyReturns.reduce((s, v) => s + (v - avgDaily) ** 2, 0) / (dailyReturns.length - 1)) : 0;
  const sharpe = stdDaily > 0 ? (avgDaily / stdDaily) * Math.sqrt(365) : 0;

  // ═══ PRINT RESULTS ═══
  console.log(`\n  RESULTADOS ${mode.toUpperCase()}`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  Total trades:      ${totalTrades}`);
  console.log(`  Señales generadas: ${signalsGenerated.total} (BUY: ${signalsGenerated.buy}, SELL: ${signalsGenerated.sell})`);
  console.log(`  Win Rate:          ${wr.toFixed(1)}%`);
  console.log(`  PnL Total:         $${totalPnl.toFixed(2)} (${totalPnlPct.toFixed(2)}%)`);
  console.log(`  Profit Factor:     ${pf.toFixed(2)}`);
  console.log(`  Max Drawdown:      ${maxDD.toFixed(2)}%`);
  console.log(`  Avg Trade Duration: ${avgDuration.toFixed(0)} min`);
  console.log(`  Expectancy:        $${expectancy.toFixed(2)}/trade`);
  console.log(`  Sharpe Ratio:      ${sharpe.toFixed(2)}`);
  console.log(`  Max Consec Wins:   ${maxConsecWins}`);
  console.log(`  Max Consec Losses: ${maxConsecLosses}`);
  console.log(`  Gross Profit:      $${grossProfit.toFixed(2)}`);
  console.log(`  Gross Loss:        $${grossLoss.toFixed(2)}`);
  console.log(`  Avg Win:           $${avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:          $${avgLoss.toFixed(2)}`);
  console.log(`  Final Equity:      $${equity.toFixed(2)}`);

  if (bestTrade) {
    console.log(`\n  MEJOR TRADE: ${bestTrade.sym} ${bestTrade.direction} | +$${bestTrade.pnlDollars.toFixed(2)} | ${bestTrade.exitType} | ${bestTrade.durationMin}min | ${bestTrade.time}`);
  }
  if (worstTrade) {
    console.log(`  PEOR TRADE:  ${worstTrade.sym} ${worstTrade.direction} | $${worstTrade.pnlDollars.toFixed(2)} | ${worstTrade.exitType} | ${worstTrade.durationMin}min | ${worstTrade.time}`);
  }

  // PnL by pair
  console.log(`\n  PnL POR PAR:`);
  const sortedPairs = Object.entries(pairStats).sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [sym, stats] of sortedPairs) {
    if (stats.trades === 0) continue;
    const wr = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(1) : '0.0';
    console.log(`    ${sym.padEnd(12)} | ${stats.trades.toString().padStart(3)} trades | WR: ${wr.padStart(5)}% | PnL: $${stats.pnl.toFixed(2)}`);
  }

  // Hourly stats
  console.log(`\n  PnL POR HORA UTC:`);
  for (let h = 0; h < 24; h++) {
    const hs = hourlyStats[h];
    if (!hs || hs.trades === 0) continue;
    const wr = (hs.wins / hs.trades * 100).toFixed(0);
    const bar = hs.pnl > 0 ? '+'.repeat(Math.min(20, Math.round(hs.pnl / 10))) : '-'.repeat(Math.min(20, Math.round(Math.abs(hs.pnl) / 10)));
    console.log(`    H${h.toString().padStart(2,'0')} | ${hs.trades.toString().padStart(3)} trades | WR: ${wr.padStart(3)}% | $${hs.pnl.toFixed(2).padStart(10)} | ${bar}`);
  }

  // Day stats
  const dayNames = ['Dom','Lun','Mar','Mie','Jue','Vie','Sab'];
  console.log(`\n  PnL POR DIA:`);
  for (let d = 0; d < 7; d++) {
    const ds = dayStats[d];
    if (!ds || ds.trades === 0) continue;
    const wr = (ds.wins / ds.trades * 100).toFixed(0);
    console.log(`    ${dayNames[d]} | ${ds.trades.toString().padStart(3)} trades | WR: ${wr.padStart(3)}% | $${ds.pnl.toFixed(2)}`);
  }

  // Regime stats
  console.log(`\n  PnL POR REGIMEN:`);
  for (const [reg, stats] of Object.entries(regimeStats)) {
    if (stats.trades === 0) continue;
    const wr = (stats.wins / stats.trades * 100).toFixed(1);
    console.log(`    ${reg.padEnd(12)} | ${stats.trades.toString().padStart(3)} trades | WR: ${wr.padStart(5)}% | $${stats.pnl.toFixed(2)}`);
  }

  // Equity curve summary (by day)
  console.log(`\n  EQUITY CURVE (resumen diario):`);
  const dailyEquity = {};
  let runEq = CAPITAL;
  let tradeIdx = 0;
  for (const t of trades) {
    runEq += t.pnlDollars;
    const day = t.time.slice(0, 10);
    dailyEquity[day] = runEq;
  }
  for (const [day, eq] of Object.entries(dailyEquity)) {
    const pct = ((eq - CAPITAL) / CAPITAL * 100).toFixed(2);
    console.log(`    ${day} → $${eq.toFixed(2)} (${pct}%)`);
  }

  return {
    mode, totalTrades, wr, totalPnl, totalPnlPct, pf, maxDD, avgDuration,
    expectancy, sharpe, maxConsecWins, maxConsecLosses, equity,
    grossProfit, grossLoss, avgWin, avgLoss, trades
  };
}

// ═══ MAIN ═══
async function main() {
  console.log('══════════════════════════════════════════════════════');
  console.log('  RX PRO — FULL AUDIT BACKTEST (14 DAYS, REAL DATA)');
  console.log('  Capital: $10,000 | Position: $500 × 5x leverage');
  console.log('  Fees: 0.08% round-trip | Timeout: 50 candles');
  console.log('══════════════════════════════════════════════════════');

  const results = {};

  // Run backtests sequentially to avoid rate limits
  results.strict = await runBacktest('strict', VIP_SCAN_SYMS);
  console.log('\n\n');
  results.scalp = await runBacktest('scalp', SCALP_SCAN_SYMS);
  console.log('\n\n');
  results.frequent = await runBacktest('frequent', FREE_SCAN_SYMS);

  // ═══ COMPARATIVE TABLE ═══
  console.log(`\n\n${'═'.repeat(80)}`);
  console.log('  TABLA COMPARATIVA FINAL');
  console.log(`${'═'.repeat(80)}`);
  console.log(`  ${'Métrica'.padEnd(22)} | ${'STRICT'.padStart(12)} | ${'SCALP'.padStart(12)} | ${'FREE'.padStart(12)}`);
  console.log(`  ${'─'.repeat(22)}-+-${'─'.repeat(12)}-+-${'─'.repeat(12)}-+-${'─'.repeat(12)}`);
  console.log(`  ${'Total Trades'.padEnd(22)} | ${results.strict.totalTrades.toString().padStart(12)} | ${results.scalp.totalTrades.toString().padStart(12)} | ${results.frequent.totalTrades.toString().padStart(12)}`);
  console.log(`  ${'Win Rate'.padEnd(22)} | ${(results.strict.wr.toFixed(1)+'%').padStart(12)} | ${(results.scalp.wr.toFixed(1)+'%').padStart(12)} | ${(results.frequent.wr.toFixed(1)+'%').padStart(12)}`);
  console.log(`  ${'PnL Total'.padEnd(22)} | ${('$'+results.strict.totalPnl.toFixed(0)).padStart(12)} | ${('$'+results.scalp.totalPnl.toFixed(0)).padStart(12)} | ${('$'+results.frequent.totalPnl.toFixed(0)).padStart(12)}`);
  console.log(`  ${'PnL %'.padEnd(22)} | ${(results.strict.totalPnlPct.toFixed(2)+'%').padStart(12)} | ${(results.scalp.totalPnlPct.toFixed(2)+'%').padStart(12)} | ${(results.frequent.totalPnlPct.toFixed(2)+'%').padStart(12)}`);
  console.log(`  ${'Profit Factor'.padEnd(22)} | ${results.strict.pf.toFixed(2).padStart(12)} | ${results.scalp.pf.toFixed(2).padStart(12)} | ${results.frequent.pf.toFixed(2).padStart(12)}`);
  console.log(`  ${'Max Drawdown'.padEnd(22)} | ${(results.strict.maxDD.toFixed(2)+'%').padStart(12)} | ${(results.scalp.maxDD.toFixed(2)+'%').padStart(12)} | ${(results.frequent.maxDD.toFixed(2)+'%').padStart(12)}`);
  console.log(`  ${'Sharpe Ratio'.padEnd(22)} | ${results.strict.sharpe.toFixed(2).padStart(12)} | ${results.scalp.sharpe.toFixed(2).padStart(12)} | ${results.frequent.sharpe.toFixed(2).padStart(12)}`);
  console.log(`  ${'Avg Duration (min)'.padEnd(22)} | ${results.strict.avgDuration.toFixed(0).padStart(12)} | ${results.scalp.avgDuration.toFixed(0).padStart(12)} | ${results.frequent.avgDuration.toFixed(0).padStart(12)}`);
  console.log(`  ${'Expectancy $/trade'.padEnd(22)} | ${('$'+results.strict.expectancy.toFixed(2)).padStart(12)} | ${('$'+results.scalp.expectancy.toFixed(2)).padStart(12)} | ${('$'+results.frequent.expectancy.toFixed(2)).padStart(12)}`);
  console.log(`  ${'Max Consec Wins'.padEnd(22)} | ${results.strict.maxConsecWins.toString().padStart(12)} | ${results.scalp.maxConsecWins.toString().padStart(12)} | ${results.frequent.maxConsecWins.toString().padStart(12)}`);
  console.log(`  ${'Max Consec Losses'.padEnd(22)} | ${results.strict.maxConsecLosses.toString().padStart(12)} | ${results.scalp.maxConsecLosses.toString().padStart(12)} | ${results.frequent.maxConsecLosses.toString().padStart(12)}`);
  console.log(`  ${'Final Equity'.padEnd(22)} | ${('$'+results.strict.equity.toFixed(0)).padStart(12)} | ${('$'+results.scalp.equity.toFixed(0)).padStart(12)} | ${('$'+results.frequent.equity.toFixed(0)).padStart(12)}`);
}

main().catch(e => console.error('Fatal error:', e));
