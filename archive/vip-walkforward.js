// ═══════════════════════════════════════════════════════════════════
// VIP STRICT MODE — INSTITUTIONAL WALK-FORWARD VALIDATION
// Exact replica of app.html genSig() strict mode logic
// Including ALL 21 Hard Rules, regime detection, divergences,
// order blocks, Keltner, PSAR, VWAP, OBV — NOTHING omitted
// ═══════════════════════════════════════════════════════════════════

const https = require('https');
const SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];

function fetchJSON(url){return new Promise((res,rej)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}});}).on('error',rej)});}
async function getKlines(sym,tf,limit){try{return await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`);}catch(e){return null;}}

// ═══ INDICATOR LIBRARY (exact copy from app.html) ═══
function calcRSI(C,p=14){if(C.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=C[i]-C[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<C.length;i++){const d=C[i]-C[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}if(al===0)return 100;return 100-(100/(1+ag/al));}
function calcEMAArr(d,p){const k=2/(p+1);const r=[d[0]];for(let i=1;i<d.length;i++)r.push(d[i]*k+r[i-1]*(1-k));return r;}
function calcEMA(d,p){return calcEMAArr(d,p).at(-1);}
function calcMACD(C){if(C.length<35)return{h:0,ph:0};const e12=calcEMAArr(C,12),e26=calcEMAArr(C,26);const ml=e12.map((v,i)=>v-e26[i]);const sl=calcEMAArr(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1))};}
function calcATR(H,L,C,p=14){if(C.length<p+1)return 0;const trs=[];for(let i=1;i<C.length;i++)trs.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));if(trs.length<p)return trs.reduce((a,b)=>a+b)/trs.length;let atr=trs.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<trs.length;i++)atr=(atr*(p-1)+trs[i])/p;return atr;}
function calcStoch(H,L,C,kp=14){if(C.length<kp+3)return{k:50,d:50};const kA=[];for(let i=kp;i<=C.length;i++){const sh=H.slice(i-kp,i),sl=L.slice(i-kp,i);const hi=Math.max(...sh),lo=Math.min(...sl);kA.push(hi===lo?50:((C[i-1]-lo)/(hi-lo))*100);}const dA=[];for(let i=2;i<kA.length;i++)dA.push((kA[i]+kA[i-1]+kA[i-2])/3);return{k:kA.at(-1)||50,d:dA.at(-1)||50};}
function calcBB(C,p=20,s=2){if(C.length<p)return{u:0,m:0,l:0};const sl=C.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+s*sd,m,l:m-s*sd};}
function calcADX(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pdm=[],mdm=[],tr=[];for(let i=1;i<H.length;i++){const u=H[i]-H[i-1],d=L[i-1]-L[i];pdm.push(u>d&&u>0?u:0);mdm.push(d>u&&d>0?d:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}function ws(a,p){if(a.length<p)return a.map(()=>0);const r=[];let s=a.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=0;i<p;i++)r.push(0);r[p-1]=s;for(let i=p;i<a.length;i++){s=(s*(p-1)+a[i])/p;r.push(s);}return r;}const sT=ws(tr,p),sP=ws(pdm,p),sM=ws(mdm,p);const pdi=sP.map((v,i)=>sT[i]?v/sT[i]*100:0);const mdi=sM.map((v,i)=>sT[i]?v/sT[i]*100:0);const dx=pdi.map((v,i)=>{const s=v+mdi[i];return s?Math.abs(v-mdi[i])/s*100:0;});const dxV=dx.slice(p-1);const adxA=dxV.length>=p?ws(dxV,p):dxV;return{adx:adxA.at(-1)||15,pdi:pdi.at(-1)||0,mdi:mdi.at(-1)||0};}

function calcOBV(C,V){
  if(C.length<2)return{obv:0,slope:0,rising:false};
  let obv=0;const arr=[0];
  for(let i=1;i<C.length;i++){
    if(C[i]>C[i-1])obv+=V[i];else if(C[i]<C[i-1])obv-=V[i];
    arr.push(obv);
  }
  // Linear regression slope on last 20
  const n=Math.min(20,arr.length);const sl=arr.slice(-n);
  let sx=0,sy=0,sxx=0,sxy=0;
  for(let i=0;i<n;i++){sx+=i;sy+=sl[i];sxx+=i*i;sxy+=i*sl[i];}
  const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx||1);
  return{obv,slope,rising:slope>0};
}

function calcParabolicSAR(H,L,C){
  if(C.length<5)return{sar:C.at(-1),trend:'BUY',recentFlip:false};
  let af=0.02,maxAf=0.2,sar=L[0],ep=H[0],isUp=true;
  let lastFlipIdx=0;
  for(let i=1;i<C.length;i++){
    const prevSar=sar;
    sar=prevSar+af*(ep-prevSar);
    if(isUp){
      if(L[i]<sar){isUp=false;sar=ep;ep=L[i];af=0.02;lastFlipIdx=i;}
      else{if(H[i]>ep){ep=H[i];af=Math.min(af+0.02,maxAf);}sar=Math.min(sar,L[i-1],i>1?L[i-2]:L[i-1]);}
    }else{
      if(H[i]>sar){isUp=true;sar=ep;ep=H[i];af=0.02;lastFlipIdx=i;}
      else{if(L[i]<ep){ep=L[i];af=Math.min(af+0.02,maxAf);}sar=Math.max(sar,H[i-1],i>1?H[i-2]:H[i-1]);}
    }
  }
  return{sar,trend:isUp?'BUY':'SELL',recentFlip:(C.length-1-lastFlipIdx)<=3};
}

function calcVWAP(klines){
  let cumVol=0;let cumVolPrice=0;const vwapArr=[];
  for(const k of klines){
    const tp=(parseFloat(k[2])+parseFloat(k[3])+parseFloat(k[4]))/3;
    const v=parseFloat(k[5]);cumVol+=v;cumVolPrice+=tp*v;
    vwapArr.push(cumVol>0?cumVolPrice/cumVol:tp);
  }
  return vwapArr;
}

function calcKeltner(H,L,C,emaLen=20,atrLen=14,mult=2){
  if(C.length<Math.max(emaLen,atrLen)+1)return{upper:0,mid:0,lower:0,width:0,position:0.5,atr:0};
  const mid=calcEMA(C,emaLen);const atr=calcATR(H,L,C,atrLen);
  const upper=mid+mult*atr;const lower=mid-mult*atr;
  const width=(upper-lower)/mid;const cur=C.at(-1);
  const position=(upper-lower)>0?(cur-lower)/(upper-lower):0.5;
  return{upper,mid,lower,width,position,atr};
}

function detectOrderBlocks(H,L,C,V,lookback=50){
  if(C.length<lookback)return{bullOB:null,bearOB:null};
  const tail=C.length-lookback;
  let bullOB=null,bearOB=null;
  const avgV=V.slice(tail).reduce((a,b)=>a+b)/(lookback||1);
  const atr=calcATR(H,L,C,14);
  for(let i=tail+2;i<C.length-1;i++){
    const body=Math.abs(C[i]-C[i-1]);const range=H[i]-L[i];
    if(range<atr*0.5)continue;
    const isImbalance=body>range*0.6&&V[i]>avgV*1.2;
    if(!isImbalance)continue;
    if(C[i]>C[i-1]){
      bearOB={price:L[i],high:H[i],idx:i,vol:V[i]};
    }else{
      bullOB={price:H[i],low:L[i],idx:i,vol:V[i]};
    }
  }
  const cur=C.at(-1);
  if(bullOB&&Math.abs(cur-bullOB.price)>atr*2)bullOB=null;
  if(bearOB&&Math.abs(cur-bearOB.price)>atr*2)bearOB=null;
  return{bullOB,bearOB};
}

function detectRegime(H,L,C,adxPre,atrPre){
  const adx=adxPre||calcADX(H,L,C);const atr=atrPre||calcATR(H,L,C,14);
  const avgP=C.slice(-20).reduce((a,b)=>a+b)/20;const atrPct=atr/avgP*100;
  if(adx.adx>25&&(adx.pdi>adx.mdi*1.3||adx.mdi>adx.pdi*1.3))
    return{regime:'TRENDING',label:'TENDENCIA',cls:'trending'};
  if(atrPct>2.5)return{regime:'VOLATILE',label:'VOLATIL',cls:'volatile'};
  if(atrPct<0.5||adx.adx<15)return{regime:'QUIET',label:'QUIETO',cls:'quiet'};
  return{regime:'RANGING',label:'RANGO LATERAL',cls:'ranging'};
}

function detectRSIDivergence(C,H,L,period=14){
  if(C.length<period+25)return{bull:false,bear:false};
  const rsiArr=[];let ag=0,al=0;
  for(let i=1;i<=period;i++){const d=C[i]-C[i-1];if(d>0)ag+=d;else al+=Math.abs(d);}
  ag/=period;al/=period;
  for(let i=0;i<period+1;i++)rsiArr.push(50);
  for(let i=period+1;i<C.length;i++){
    const d=C[i]-C[i-1];ag=(ag*(period-1)+(d>0?d:0))/period;al=(al*(period-1)+(d<0?Math.abs(d):0))/period;
    rsiArr.push(al===0?100:100-(100/(1+ag/al)));
  }
  const len=Math.min(rsiArr.length,40);const start=rsiArr.length-len;
  function findSwings(arr,s,n,w=3){
    const hi=[],lo=[];
    for(let i=s+w;i<s+n-w;i++){
      let isH=true,isL=true;
      for(let j=1;j<=w;j++){if(arr[i-j]>=arr[i]||arr[i+j]>=arr[i])isH=false;if(arr[i-j]<=arr[i]||arr[i+j]<=arr[i])isL=false;}
      if(isH)hi.push({idx:i,val:arr[i]});if(isL)lo.push({idx:i,val:arr[i]});
    }
    return{hi,lo};
  }
  const pSwings=findSwings(L,start,len);const rSwings=findSwings(rsiArr,start,len);
  let bull=false,bear=false;
  // Bullish: lower lows in price but higher RSI lows
  for(let i=0;i<pSwings.lo.length-1;i++){
    for(let j=i+1;j<pSwings.lo.length;j++){
      if(pSwings.lo[j].idx-pSwings.lo[i].idx<5)continue;
      if(L[pSwings.lo[j].idx]<L[pSwings.lo[i].idx]){
        const rL1=rSwings.lo.filter(r=>Math.abs(r.idx-pSwings.lo[i].idx)<=4).sort((a,b)=>a.val-b.val)[0];
        const rL2=rSwings.lo.filter(r=>Math.abs(r.idx-pSwings.lo[j].idx)<=4).sort((a,b)=>a.val-b.val)[0];
        if(rL1&&rL2&&rL2.val>rL1.val)bull=true;
      }
    }
  }
  const pSwingsH=findSwings(H,start,len);
  for(let i=0;i<pSwingsH.hi.length-1;i++){
    for(let j=i+1;j<pSwingsH.hi.length;j++){
      if(pSwingsH.hi[j].idx-pSwingsH.hi[i].idx<5)continue;
      if(H[pSwingsH.hi[j].idx]>H[pSwingsH.hi[i].idx]){
        const rH1=rSwings.hi.filter(r=>Math.abs(r.idx-pSwingsH.hi[i].idx)<=4).sort((a,b)=>b.val-a.val)[0];
        const rH2=rSwings.hi.filter(r=>Math.abs(r.idx-pSwingsH.hi[j].idx)<=4).sort((a,b)=>b.val-a.val)[0];
        if(rH1&&rH2&&rH2.val<rH1.val)bear=true;
      }
    }
  }
  return{bull,bear};
}

function detectMACDDivergence(C){
  if(C.length<40)return{bull:false,bear:false};
  const e12=calcEMAArr(C,12),e26=calcEMAArr(C,26);
  const macdLine=e12.map((v,i)=>v-e26[i]);
  const len=Math.min(macdLine.length,40);const start=macdLine.length-len;
  function findSwings(arr,s,n,w=3){
    const hi=[],lo=[];
    for(let i=s+w;i<s+n-w;i++){
      let isH=true,isL=true;
      for(let j=1;j<=w;j++){if(arr[i-j]>=arr[i]||arr[i+j]>=arr[i])isH=false;if(arr[i-j]<=arr[i]||arr[i+j]<=arr[i])isL=false;}
      if(isH)hi.push({idx:i,val:arr[i]});if(isL)lo.push({idx:i,val:arr[i]});
    }
    return{hi,lo};
  }
  const pSwings=findSwings(C,start,len);const mSwings=findSwings(macdLine,start,len);
  let bull=false,bear=false;
  for(let i=0;i<pSwings.lo.length-1;i++){
    for(let j=i+1;j<pSwings.lo.length;j++){
      if(pSwings.lo[j].idx-pSwings.lo[i].idx<5)continue;
      if(C[pSwings.lo[j].idx]<C[pSwings.lo[i].idx]){
        const m1=mSwings.lo.filter(r=>Math.abs(r.idx-pSwings.lo[i].idx)<=4).sort((a,b)=>a.val-b.val)[0];
        const m2=mSwings.lo.filter(r=>Math.abs(r.idx-pSwings.lo[j].idx)<=4).sort((a,b)=>a.val-b.val)[0];
        if(m1&&m2&&m2.val>m1.val)bull=true;
      }
    }
  }
  for(let i=0;i<pSwings.hi.length-1;i++){
    for(let j=i+1;j<pSwings.hi.length;j++){
      if(pSwings.hi[j].idx-pSwings.hi[i].idx<5)continue;
      if(C[pSwings.hi[j].idx]>C[pSwings.hi[i].idx]){
        const m1=mSwings.hi.filter(r=>Math.abs(r.idx-pSwings.hi[i].idx)<=4).sort((a,b)=>b.val-a.val)[0];
        const m2=mSwings.hi.filter(r=>Math.abs(r.idx-pSwings.hi[j].idx)<=4).sort((a,b)=>b.val-a.val)[0];
        if(m1&&m2&&m2.val<m1.val)bear=true;
      }
    }
  }
  return{bull,bear};
}

function findPivotLevels(H,L,C,lookback=50){
  const n=Math.min(lookback,C.length);const start=C.length-n;
  const sups=[],ress=[];
  for(let i=start+2;i<C.length-2;i++){
    if(L[i]<=L[i-1]&&L[i]<=L[i-2]&&L[i]<=L[i+1]&&L[i]<=(L[i+2]||Infinity))sups.push(L[i]);
    if(H[i]>=H[i-1]&&H[i]>=H[i-2]&&H[i]>=H[i+1]&&H[i]>=(H[i+2]||0))ress.push(H[i]);
  }
  const cur=C.at(-1);
  const nearestRes=ress.filter(r=>r>cur).sort((a,b)=>a-b)[0]||null;
  const nearestSup=sups.filter(s=>s<cur).sort((a,b)=>b-a)[0]||null;
  return{nearestRes,nearestSup,supports:sups,resistances:ress};
}

// ═══════════════════════════════════════════════════════════════════
// EXACT REPLICA of genSig() strict mode — bar-by-bar
// ═══════════════════════════════════════════════════════════════════
function genStrictSignal(C,H,L,V,kl5raw,C15,H15,L15,kl15raw,C1h,H1h,L1h,V1h,sym,hourUTC){
  const cur=C.at(-1);
  let B=0,S=0;
  const buyIndsList=[], sellIndsList=[];

  // ═══ STEP 1: 1H Trend ═══
  let htfTrend='NEUTRAL',htfStrength=0;
  if(C1h.length>25){
    const ema9h=calcEMA(C1h,9),ema21h=calcEMA(C1h,21),ema50h=calcEMA(C1h,50);
    const rsi1h=calcRSI(C1h,14);const mac1h=calcMACD(C1h);
    const adx1h=calcADX(H1h,L1h,C1h);const obv1h=calcOBV(C1h,V1h);
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

  // ═══ STEP 2: 15m Confirm ═══
  let mtfConfirm='NEUTRAL';
  if(C15.length>25){
    const e9_15=calcEMA(C15,9),e21_15=calcEMA(C15,21);
    const rsi15=calcRSI(C15,14);const mac15=calcMACD(C15);
    let mB=0,mS=0;
    if(e9_15>e21_15)mB+=1;else mS+=1;
    if(mac15.h>0)mB+=1;else mS+=1;
    if(rsi15>50)mB+=0.5;else if(rsi15<50)mS+=0.5;
    if(mB>mS)mtfConfirm='BUY';else if(mS>mB)mtfConfirm='SELL';
  }

  // ═══ STEP 3: 5m Indicators ═══
  const rsi=calcRSI(C,14);
  const mac=calcMACD(C);
  const ea9=calcEMAArr(C,9),ea21=calcEMAArr(C,21);
  const e9=ea9.at(-1),e21=ea21.at(-1),e9p=ea9.at(-2),e21p=ea21.at(-2);
  const e50=calcEMA(C,50);
  const bb=calcBB(C,20,2);
  const vwapArr=calcVWAP(kl5raw.slice(-50));const vwap=vwapArr.at(-1);
  const avgV=V.slice(-20).reduce((a,b)=>a+b)/20;const vr=V.at(-1)/avgV;
  const adxData=calcADX(H,L,C);
  const obvData=calcOBV(C,V);
  const psar=calcParabolicSAR(H,L,C);
  const stFull=calcStoch(H,L,C,14);
  let atr=calcATR(H,L,C,14);
  const rsiDiv=detectRSIDivergence(C,H,L,14);
  const macdDiv=detectMACDDivergence(C);

  // Regime detection
  let regime='RANGING';let regimeData={regime:'RANGING'};
  try{regimeData=detectRegime(H,L,C,adxData,atr);regime=regimeData.regime||'RANGING';}catch(e){}
  const isTrending=(regime==='TRENDING');
  const isQuiet=(regime==='QUIET');
  const isVolatile=(regime==='VOLATILE');

  // Keltner + Order Blocks
  const kc=calcKeltner(H,L,C,20,14,2);
  let orderBlocks={bullOB:null,bearOB:null};
  try{orderBlocks=detectOrderBlocks(H,L,C,V,50);}catch(e){}

  const isDeadHours=hourUTC>=0&&hourUTC<6;

  // ═══ TRENDING SCORING — BLOCKED (V13 mega: 0% WR) ═══
  if(isTrending){
    // Block trending mode entirely
  } else {
    // ═══ RANGING/QUIET SCORING — Hybrid Mean-Reversion ═══
    if(rsi<32){B+=2.5;buyIndsList.push('RSI');}
    else if(rsi>68){S+=2.5;sellIndsList.push('RSI');}

    if(stFull.k>stFull.d&&stFull.k<25){B+=2;buyIndsList.push('Stoch');}
    else if(stFull.k<stFull.d&&stFull.k>75){S+=2;sellIndsList.push('Stoch');}

    const bb15=C15.length>20?calcBB(C15,20,2):bb;
    if(cur<=bb15.l*1.002){B+=2;buyIndsList.push('BB');}
    else if(cur>=bb15.u*0.998){S+=2;sellIndsList.push('BB');}

    if(rsiDiv.bull){B+=3;buyIndsList.push('RSIDiv');}
    else if(rsiDiv.bear){S+=3;sellIndsList.push('RSIDiv');}
    if(macdDiv.bull){B+=2.5;buyIndsList.push('MACDDiv');}
    else if(macdDiv.bear){S+=2.5;sellIndsList.push('MACDDiv');}

    if(mac.h>0&&mac.ph<0){B+=1.5;buyIndsList.push('MACDx');}
    else if(mac.h<0&&mac.ph>0){S+=1.5;sellIndsList.push('MACDx');}

    if(obvData.rising){B+=0.8;buyIndsList.push('OBV');}
    else{S+=0.8;sellIndsList.push('OBV');}

    if(e9>e21){B+=0.5;buyIndsList.push('EMA');}
    else{S+=0.5;sellIndsList.push('EMA');}

    if(cur>vwap&&vr>0.5){B+=0.5;buyIndsList.push('VWAP');}
    else if(cur<vwap&&vr>0.5){S+=0.5;sellIndsList.push('VWAP');}

    if(psar.recentFlip){
      if(psar.trend==='BUY'){B+=1;buyIndsList.push('PSAR');}
      else{S+=1;sellIndsList.push('PSAR');}
    }else{
      if(psar.trend==='BUY'){B+=0.3;buyIndsList.push('psar');}
      else{S+=0.3;sellIndsList.push('psar');}
    }

    if(kc.position<=0.05){B+=1.5;buyIndsList.push('KC');}
    else if(kc.position>=0.95){S+=1.5;sellIndsList.push('KC');}

    if(orderBlocks.bullOB&&cur<=orderBlocks.bullOB.price*1.003){B+=2;buyIndsList.push('OB');}
    else if(orderBlocks.bearOB&&cur>=orderBlocks.bearOB.price*0.997){S+=2;sellIndsList.push('OB');}
  }

  // Volume multiplier
  if(vr>1.5&&B>S)B*=1.1;
  else if(vr>1.5&&S>B)S*=1.1;

  // Candle exhaustion
  const last4C=C.slice(-4);
  const bullExhausted=last4C.every((c,i)=>i===0||c>last4C[i-1]);
  const bearExhausted=last4C.every((c,i)=>i===0||c<last4C[i-1]);

  // ═══ SIGNAL DECISION ═══
  let tot=Math.max(1,B+S);
  let conf=Math.min(99,Math.round((Math.max(B,S)/tot)*100));
  const isLowLiq=!['BTCUSDT','ETHUSDT'].includes(sym);
  if(isLowLiq)conf=Math.max(0,conf-3);
  let signal='NEUTRAL';

  const buyInds=buyIndsList.length;
  const sellInds=sellIndsList.length;

  // Price action
  const mom3=(C.at(-1)-C[C.length-4])/atr;
  let buyPressure=0,sellPressure=0;
  for(let i=C.length-5;i<C.length;i++){
    const open=i>0?C[i-1]:C[i];const body=C[i]-open;
    const uw=H[i]-Math.max(C[i],open);const lw=Math.min(C[i],open)-L[i];
    if(body>0){buyPressure+=body+lw*0.5;sellPressure+=uw*0.3;}
    else{sellPressure+=Math.abs(body)+uw*0.5;buyPressure+=lw*0.3;}
  }
  const flowRatio=buyPressure/Math.max(0.001,sellPressure);
  const flowBull=flowRatio>1.4;const flowBear=flowRatio<0.7;

  // Score thresholds
  const thr=isTrending?4:2;const confReq=55;const minInds=isTrending?3:2;

  if(isTrending){/* blocked */}
  else if(B>S&&B>=thr&&conf>=confReq&&buyInds>=minInds)signal='BUY';
  else if(S>B&&S>=thr&&conf>=confReq&&sellInds>=minInds)signal='SELL';

  // ═══ ALL 21 HARD RULES ═══
  // Rule 1
  if(isTrending&&signal==='BUY'&&htfTrend==='SELL')signal='NEUTRAL';
  if(isTrending&&signal==='SELL'&&htfTrend==='BUY')signal='NEUTRAL';
  // Rule 2
  if(signal==='BUY'&&mtfConfirm==='SELL'&&htfTrend!=='BUY')signal='NEUTRAL';
  if(signal==='SELL'&&mtfConfirm==='BUY'&&htfTrend!=='SELL')signal='NEUTRAL';
  // Rule 3
  if(signal!=='NEUTRAL'&&vr<0.5)signal='NEUTRAL';
  // Rule 4
  if(signal!=='NEUTRAL'&&isDeadHours)signal='NEUTRAL';
  // Rule 5
  if(signal!=='NEUTRAL'&&isVolatile)signal='NEUTRAL';
  // Rule 6
  if(signal==='BUY'&&bullExhausted)signal='NEUTRAL';
  if(signal==='SELL'&&bearExhausted)signal='NEUTRAL';
  // Rule 7
  const rsiCapBuy=isTrending?80:65;const rsiCapSell=isTrending?20:35;
  if(signal==='BUY'&&rsi>rsiCapBuy)signal='NEUTRAL';
  if(signal==='SELL'&&rsi<rsiCapSell)signal='NEUTRAL';
  // Rule 8
  const distFromEMA=Math.abs(cur-e21)/atr;
  if(signal==='BUY'&&cur>e21&&distFromEMA>2.0)signal='NEUTRAL';
  if(signal==='SELL'&&cur<e21&&distFromEMA>2.0)signal='NEUTRAL';
  // Rule 9
  if(signal==='BUY'&&mom3<-0.5&&flowBear)signal='NEUTRAL';
  if(signal==='SELL'&&mom3>0.5&&flowBull)signal='NEUTRAL';
  // Rule 10
  if(!isTrending&&htfStrength>=4){
    if(signal==='BUY'&&htfTrend==='SELL')signal='NEUTRAL';
    if(signal==='SELL'&&htfTrend==='BUY')signal='NEUTRAL';
  }
  // Rule 12
  if(signal!=='NEUTRAL'&&isTrending&&C1h.length>20){
    const adx1hC=calcADX(H1h,L1h,C1h);
    if(adx1hC.adx<18)signal='NEUTRAL';
  }
  // Rule 13
  if(signal!=='NEUTRAL'&&!isTrending){
    const lastBody=(C.at(-1)-(C.at(-2)||C.at(-1)))/atr;
    if(signal==='BUY'&&lastBody<-0.7)signal='NEUTRAL';
    if(signal==='SELL'&&lastBody>0.7)signal='NEUTRAL';
  }
  // Rule 14
  if(signal!=='NEUTRAL'&&!isTrending){
    if(signal==='BUY'&&rsi>55)signal='NEUTRAL';
    if(signal==='SELL'&&rsi<38)signal='NEUTRAL';
  }
  // Rule 16
  if(signal!=='NEUTRAL'&&adxData.adx<15)signal='NEUTRAL';
  // Rule 17
  if(signal!=='NEUTRAL'&&!isTrending&&adxData.adx>=18&&adxData.adx<=25)signal='NEUTRAL';
  if(signal!=='NEUTRAL'&&!isTrending&&adxData.adx>30)signal='NEUTRAL';
  // Rule 18
  if(signal!=='NEUTRAL'&&!isTrending){
    const scoreMargin=signal==='BUY'?B-S:S-B;
    if(scoreMargin<2.0)signal='NEUTRAL';
  }
  // Rule 15
  if(signal!=='NEUTRAL'&&!isTrending){
    const c1=C.at(-1)||0,c3=C.at(-3)||0,c4=C.at(-4)||0;
    const shortMom=(c1-c3)/atr;const longMom=(c1-c4)/atr;
    if(signal==='BUY'&&shortMom<-0.3&&longMom<-0.3)signal='NEUTRAL';
    if(signal==='SELL'&&shortMom>0.3&&longMom>0.3)signal='NEUTRAL';
  }
  // Rule 19
  if(signal!=='NEUTRAL'&&isQuiet){
    if(htfTrend!==signal)signal='NEUTRAL';
    if(signal==='BUY'&&!rsiDiv.bull&&!macdDiv.bull)signal='NEUTRAL';
  }
  // Rule 20
  if(signal==='SELL'&&sym==='BTCUSDT'&&!isTrending)signal='NEUTRAL';
  // Rule 21
  if(signal!=='NEUTRAL'){
    if(hourUTC===7||hourUTC===13||hourUTC===23)signal='NEUTRAL';
  }

  // Rule 11: Min volatility
  let atr15=atr;
  if(H15.length>15&&L15.length>15&&C15.length>15){const a=calcATR(H15,L15,C15,14);if(a>0)atr15=a;}
  let atr1h=atr;
  if(H1h.length>15&&L1h.length>15&&C1h.length>15){const a=calcATR(H1h,L1h,C1h,14);if(a>0)atr1h=a;}
  if(signal!=='NEUTRAL'){const volPct=atr15/cur;if(volPct<0.0008)signal='NEUTRAL';}

  // ═══ TP/SL Calculation ═══
  const blendedATR=Math.max(atr15,atr1h/4);
  const useATR=blendedATR;
  let tpDist,slDist;
  if(isQuiet){tpDist=useATR*0.55;slDist=useATR*0.80;}
  else{tpDist=useATR*0.65;slDist=useATR*0.80;}

  const minTPdist=cur*0.0012;
  if(tpDist<minTPdist)tpDist=minTPdist;
  if(slDist<minTPdist*0.67)slDist=minTPdist*0.67;
  if(tpDist<slDist*1.2){}// strict doesn't enforce R:R

  const costBuffer=cur*0.0008;

  // S/R awareness
  if(signal!=='NEUTRAL'){
    try{
      let pH=H,pL=L,pC=C;
      if(H1h.length>20){pH=H1h;pL=L1h;pC=C1h;}
      const pivots=findPivotLevels(pH,pL,pC,50);
      if(signal==='BUY'&&pivots.nearestRes){
        const d=pivots.nearestRes-cur;
        if(d>0&&d<tpDist*0.7){
          if(d>slDist*1.2)tpDist=d*0.92;else signal='NEUTRAL';
        }
      }
      if(signal==='SELL'&&pivots.nearestSup){
        const d=cur-pivots.nearestSup;
        if(d>0&&d<tpDist*0.7){
          if(d>slDist*1.2)tpDist=d*0.92;else signal='NEUTRAL';
        }
      }
    }catch(e){}
  }

  const tp1Dist=tpDist*0.60;
  return{signal,entry:cur,tpDist,slDist,tp1Dist,atr,atr15,conf,B,S,regime,
    buyInds,sellInds,rsi,adx:adxData.adx,htfTrend,mtfConfirm,vr,
    rsiDivBull:rsiDiv.bull,rsiDivBear:rsiDiv.bear,
    triggers:[...buyIndsList,...sellIndsList]};
}

// ═══════════════════════════════════════════════════════════════════
// WALK-FORWARD BACKTEST ENGINE
// ═══════════════════════════════════════════════════════════════════
let DATA={};
async function loadData(){
  for(const sym of SYMS){
    process.stdout.write(`  ${sym}...`);
    const [k5,k15,k1h]=await Promise.all([
      getKlines(sym,'5m',1000),getKlines(sym,'15m',400),getKlines(sym,'1h',200)
    ]);
    if(!k5||k5.length<400){console.log(' SKIP');continue;}
    DATA[sym]={
      raw5:k5,
      C:k5.map(k=>+k[4]),H:k5.map(k=>+k[2]),L:k5.map(k=>+k[3]),V:k5.map(k=>+k[5]),T:k5.map(k=>k[0]),
      C15:k15?k15.map(k=>+k[4]):[],H15:k15?k15.map(k=>+k[2]):[],L15:k15?k15.map(k=>+k[3]):[],T15:k15?k15.map(k=>k[0]):[],
      raw15:k15||[],
      C1h:k1h?k1h.map(k=>+k[4]):[],H1h:k1h?k1h.map(k=>+k[2]):[],L1h:k1h?k1h.map(k=>+k[3]):[],V1h:k1h?k1h.map(k=>+k[5]):[],T1h:k1h?k1h.map(k=>k[0]):[],
      len:k5.length
    };
    console.log(` ${k5.length}`);await new Promise(r=>setTimeout(r,200));
  }
}

function evalTradePartialTP(sig, fH, fL, fC, maxBars){
  const entry=sig.entry;const tp1=sig.tp1Dist;const sl=sig.slDist;
  const costBuf=entry*0.0008;
  const tp1P=sig.signal==='BUY'?entry+tp1+costBuf:entry-tp1-costBuf;
  const slP=sig.signal==='BUY'?entry-sl-costBuf:entry+sl+costBuf;
  const tpFullP=sig.signal==='BUY'?entry+sig.tpDist+costBuf:entry-sig.tpDist-costBuf;
  let tp1Hit=false,res='TO',pnl=0;

  for(let i=0;i<Math.min(maxBars,fH.length);i++){
    if(sig.signal==='BUY'){
      if(!tp1Hit){
        if(fL[i]<=slP){res='SL';pnl=-(sl+costBuf)/entry*100;break;}
        if(fH[i]>=tp1P){tp1Hit=true;}
      }
      if(tp1Hit){
        // After TP1: SL moves to breakeven for remaining 50%
        if(fL[i]<=entry){
          pnl=(tp1/entry*100)*0.5;// 50% at TP1, rest at breakeven
          res='TP1+BE';break;
        }
        if(fH[i]>=tpFullP){
          pnl=(tp1/entry*100)*0.5+(sig.tpDist/entry*100)*0.5;
          res='TP1+FULL';break;
        }
      }
    }else{
      if(!tp1Hit){
        if(fH[i]>=slP){res='SL';pnl=-(sl+costBuf)/entry*100;break;}
        if(fL[i]<=tp1P){tp1Hit=true;}
      }
      if(tp1Hit){
        if(fH[i]>=entry){
          pnl=(tp1/entry*100)*0.5;
          res='TP1+BE';break;
        }
        if(fL[i]<=tpFullP){
          pnl=(tp1/entry*100)*0.5+(sig.tpDist/entry*100)*0.5;
          res='TP1+FULL';break;
        }
      }
    }
  }
  if(res==='TO'){
    const last=fC[Math.min(maxBars,fH.length)-1]||entry;
    const uPnl=sig.signal==='BUY'?last-entry:entry-last;
    pnl=tp1Hit?(tp1/entry*100)*0.5+(uPnl/entry*100)*0.5:(uPnl-costBuf)/entry*100;
  }
  return{res,pnl,tp1Hit};
}

function runBacktest(startPct,endPct,label){
  const LB=280,FUT=48;
  const signals=[];
  const lastSigBar={};

  for(const sym of Object.keys(DATA)){
    const d=DATA[sym];
    const rS=Math.floor(d.len*startPct),rE=Math.floor(d.len*endPct);
    const bS=Math.max(LB,rS),bE=rE-FUT;
    if(bE<=bS)continue;

    for(let bar=bS;bar<bE;bar++){
      // Minimum 8-bar cooldown per symbol
      const lb=lastSigBar[sym]||-999;
      if(bar-lb<8)continue;

      const c=d.C.slice(bar-279,bar+1),h=d.H.slice(bar-279,bar+1),l=d.L.slice(bar-279,bar+1),v=d.V.slice(bar-279,bar+1);
      const kl5raw=d.raw5.slice(bar-49,bar+1);
      const bt=d.T[bar];const hUTC=new Date(bt).getUTCHours();

      // Align 15m data
      let c15e=0;for(let j=d.T15.length-1;j>=0;j--){if(d.T15[j]<=bt){c15e=j+1;break;}}
      const c15=d.C15.slice(Math.max(0,c15e-100),c15e);
      const h15=d.H15.slice(Math.max(0,c15e-100),c15e);
      const l15=d.L15.slice(Math.max(0,c15e-100),c15e);
      const kl15raw=d.raw15.slice(Math.max(0,c15e-100),c15e);

      // Align 1h data
      let c1e=0;for(let j=d.T1h.length-1;j>=0;j--){if(d.T1h[j]<=bt){c1e=j+1;break;}}
      const c1h=d.C1h.slice(Math.max(0,c1e-50),c1e);
      const h1h=d.H1h.slice(Math.max(0,c1e-50),c1e);
      const l1h=d.L1h.slice(Math.max(0,c1e-50),c1e);
      const v1h=d.V1h.slice(Math.max(0,c1e-50),c1e);

      const sig=genStrictSignal(c,h,l,v,kl5raw,c15,h15,l15,kl15raw,c1h,h1h,l1h,v1h,sym,hUTC);
      if(!sig||sig.signal==='NEUTRAL')continue;

      lastSigBar[sym]=bar;

      // Future bars for evaluation
      const fH=[],fL=[],fC=[];
      for(let f=bar+1;f<=Math.min(bar+FUT,d.len-1);f++){fH.push(d.H[f]);fL.push(d.L[f]);fC.push(d.C[f]);}

      const ev=evalTradePartialTP(sig,fH,fL,fC,24);

      signals.push({
        sym,bar,time:new Date(bt).toISOString().slice(0,16),
        signal:sig.signal,conf:sig.conf,entry:sig.entry,
        regime:sig.regime,rsi:sig.rsi,adx:sig.adx,
        htfTrend:sig.htfTrend,mtfConfirm:sig.mtfConfirm,
        B:sig.B,S:sig.S,buyInds:sig.buyInds,sellInds:sig.sellInds,
        vr:sig.vr,triggers:sig.triggers,
        rsiDivBull:sig.rsiDivBull,rsiDivBear:sig.rsiDivBear,
        tpDist:sig.tpDist,slDist:sig.slDist,tp1Dist:sig.tp1Dist,
        ...ev
      });
    }
  }

  // Stats
  const total=signals.length;
  const wins=signals.filter(s=>s.pnl>0).length;
  const losses=signals.filter(s=>s.pnl<=0).length;
  const wr=total>0?wins/total*100:0;
  const pnl=signals.reduce((a,s)=>a+s.pnl,0);
  const len=Object.values(DATA)[0]?.len||1000;
  const days=len*(endPct-startPct)/288;
  const spd=total/Math.max(0.5,days);

  return{signals,total,wins,losses,wr,pnl,spd,days,label};
}

async function main(){
  console.log('═'.repeat(70));
  console.log('  VIP STRICT MODE — INSTITUTIONAL WALK-FORWARD VALIDATION');
  console.log('  Exact replica of app.html genSig() with ALL 21 Hard Rules');
  console.log('═'.repeat(70)+'\n');

  await loadData();

  // ═══ WALK-FORWARD: Train on first 50%, Test on last 50% ═══
  console.log('\n  Running walk-forward validation...\n');

  const train=runBacktest(0,0.5,'TRAIN (0-50%)');
  const test=runBacktest(0.5,1.0,'TEST (50-100%)');
  const full=runBacktest(0,1.0,'FULL (0-100%)');

  function printStats(r){
    console.log(`  ${r.label}:`);
    console.log(`    Signals: ${r.total} (${r.spd.toFixed(1)} s/d over ${r.days.toFixed(1)} days)`);
    console.log(`    WR: ${r.wr.toFixed(1)}% (${r.wins}W / ${r.losses}L)`);
    console.log(`    PnL: ${r.pnl>=0?'+':''}${r.pnl.toFixed(2)}%`);
    console.log(`    Avg PnL/trade: ${r.total>0?(r.pnl/r.total).toFixed(3):'0'}%`);
  }

  printStats(train);console.log();
  printStats(test);console.log();
  printStats(full);

  // ═══ ROBUSTNESS — Quarterly breakdown ═══
  console.log('\n'+'═'.repeat(70));
  console.log('  ROBUSTNESS — Performance across time windows');
  console.log('═'.repeat(70)+'\n');

  const windows=[
    {name:'Q1 (0-25%)',s:0,e:0.25},{name:'Q2 (25-50%)',s:0.25,e:0.50},
    {name:'Q3 (50-75%)',s:0.50,e:0.75},{name:'Q4 (75-100%)',s:0.75,e:1.0},
  ];
  for(const w of windows){
    const r=runBacktest(w.s,w.e,w.name);
    const wrTag=r.wr>=55?'✓':'✗';const pnlTag=r.pnl>0?'✓':'✗';
    console.log(`  ${w.name.padEnd(15)} | ${wrTag} WR=${r.wr.toFixed(1).padStart(5)}% | ${pnlTag} PnL=${(r.pnl>=0?'+':'')+r.pnl.toFixed(2).padStart(7)}% | ${r.spd.toFixed(1).padStart(4)} s/d | ${r.total} sigs (${r.wins}W/${r.losses}L)`);
  }

  // ═══ BREAKDOWN BY SYMBOL ═══
  console.log('\n'+'═'.repeat(70));
  console.log('  BREAKDOWN BY SYMBOL');
  console.log('═'.repeat(70)+'\n');

  for(const sym of Object.keys(DATA)){
    const sigs=full.signals.filter(s=>s.sym===sym);
    const w=sigs.filter(s=>s.pnl>0).length;const l=sigs.length-w;
    const wr=sigs.length>0?w/sigs.length*100:0;
    const pnl=sigs.reduce((a,s)=>a+s.pnl,0);
    const wrTag=wr>=55?'✓':'✗';const pnlTag=pnl>0?'✓':'✗';
    console.log(`  ${sym.padEnd(10)} | ${wrTag} WR=${wr.toFixed(1).padStart(5)}% | ${pnlTag} PnL=${(pnl>=0?'+':'')+pnl.toFixed(2).padStart(7)}% | ${sigs.length} sigs (${w}W/${l}L)`);
  }

  // ═══ BREAKDOWN BY SIGNAL TYPE ═══
  console.log('\n'+'═'.repeat(70));
  console.log('  BREAKDOWN BY DIRECTION');
  console.log('═'.repeat(70)+'\n');

  for(const dir of ['BUY','SELL']){
    const sigs=full.signals.filter(s=>s.signal===dir);
    const w=sigs.filter(s=>s.pnl>0).length;const l=sigs.length-w;
    const wr=sigs.length>0?w/sigs.length*100:0;
    const pnl=sigs.reduce((a,s)=>a+s.pnl,0);
    console.log(`  ${dir.padEnd(6)} | WR=${wr.toFixed(1)}% | PnL=${(pnl>=0?'+':'')+pnl.toFixed(2)}% | ${sigs.length} sigs (${w}W/${l}L)`);
  }

  // ═══ BREAKDOWN BY REGIME ═══
  console.log('\n'+'═'.repeat(70));
  console.log('  BREAKDOWN BY MARKET REGIME');
  console.log('═'.repeat(70)+'\n');

  for(const reg of ['RANGING','QUIET','TRENDING','VOLATILE']){
    const sigs=full.signals.filter(s=>s.regime===reg);
    if(sigs.length===0){console.log(`  ${reg.padEnd(10)} | No signals`);continue;}
    const w=sigs.filter(s=>s.pnl>0).length;const l=sigs.length-w;
    const wr=w/sigs.length*100;const pnl=sigs.reduce((a,s)=>a+s.pnl,0);
    console.log(`  ${reg.padEnd(10)} | WR=${wr.toFixed(1)}% | PnL=${(pnl>=0?'+':'')+pnl.toFixed(2)}% | ${sigs.length} sigs (${w}W/${l}L)`);
  }

  // ═══ BREAKDOWN BY EXIT TYPE ═══
  console.log('\n'+'═'.repeat(70));
  console.log('  BREAKDOWN BY EXIT TYPE');
  console.log('═'.repeat(70)+'\n');

  for(const exitType of ['SL','TP1+BE','TP1+FULL','TO']){
    const sigs=full.signals.filter(s=>s.res===exitType);
    if(sigs.length===0)continue;
    const w=sigs.filter(s=>s.pnl>0).length;const pnl=sigs.reduce((a,s)=>a+s.pnl,0);
    const avgPnl=pnl/sigs.length;
    console.log(`  ${exitType.padEnd(10)} | ${sigs.length} trades | Avg PnL: ${(avgPnl>=0?'+':'')+avgPnl.toFixed(3)}% | Total: ${(pnl>=0?'+':'')+pnl.toFixed(2)}%`);
  }

  // ═══ BREAKDOWN BY TRIGGER INDICATORS ═══
  console.log('\n'+'═'.repeat(70));
  console.log('  WHICH INDICATORS TRIGGER WINNING SIGNALS?');
  console.log('═'.repeat(70)+'\n');

  const allTriggers=['RSI','Stoch','BB','RSIDiv','MACDDiv','MACDx','OBV','EMA','VWAP','PSAR','psar','KC','OB'];
  for(const trig of allTriggers){
    const withTrig=full.signals.filter(s=>s.triggers.includes(trig));
    const woTrig=full.signals.filter(s=>!s.triggers.includes(trig));
    if(withTrig.length<2)continue;
    const wrWith=withTrig.filter(s=>s.pnl>0).length/withTrig.length*100;
    const pnlWith=withTrig.reduce((a,s)=>a+s.pnl,0);
    const wrWo=woTrig.length>0?woTrig.filter(s=>s.pnl>0).length/woTrig.length*100:0;
    console.log(`  ${trig.padEnd(10)} | WITH: WR=${wrWith.toFixed(1)}% PnL=${(pnlWith>=0?'+':'')+pnlWith.toFixed(2)}% (${withTrig.length}) | WITHOUT: WR=${wrWo.toFixed(1)}% (${woTrig.length})`);
  }

  // ═══ HOUR-BY-HOUR ANALYSIS ═══
  console.log('\n'+'═'.repeat(70));
  console.log('  HOUR-BY-HOUR PERFORMANCE (UTC)');
  console.log('═'.repeat(70)+'\n');

  for(let h=6;h<24;h++){
    const sigs=full.signals.filter(s=>{
      const hr=new Date(DATA[s.sym].T[s.bar]).getUTCHours();
      return hr===h;
    });
    if(sigs.length===0)continue;
    const w=sigs.filter(s=>s.pnl>0).length;
    const wr=w/sigs.length*100;const pnl=sigs.reduce((a,s)=>a+s.pnl,0);
    const bar='█'.repeat(Math.round(wr/5));
    console.log(`  H${String(h).padStart(2,'0')} | WR=${wr.toFixed(0).padStart(3)}% ${bar.padEnd(20)} | PnL=${(pnl>=0?'+':'')+pnl.toFixed(2).padStart(6)}% | ${sigs.length} sigs`);
  }

  // ═══ INDIVIDUAL SIGNALS LOG (full dataset) ═══
  console.log('\n'+'═'.repeat(70));
  console.log('  SIGNAL LOG — All signals on FULL dataset');
  console.log('═'.repeat(70)+'\n');

  console.log('  #  | Time             | Sym       | Dir  | Conf | Regime   | RSI  | ADX  | 1H     | 15m    | B/S      | Result   | PnL%');
  console.log('  '+'-'.repeat(130));
  for(let i=0;i<full.signals.length;i++){
    const s=full.signals[i];
    const pnlStr=(s.pnl>=0?'+':'')+s.pnl.toFixed(3);
    const resultColor=s.pnl>0?'WIN':'LOSS';
    console.log(`  ${String(i+1).padStart(3)} | ${s.time} | ${s.sym.padEnd(9)} | ${s.signal.padEnd(4)} | ${String(s.conf).padStart(4)}% | ${s.regime.padEnd(8)} | ${s.rsi.toFixed(0).padStart(4)} | ${s.adx.toFixed(0).padStart(4)} | ${s.htfTrend.padEnd(6)} | ${s.mtfConfirm.padEnd(6)} | ${s.B.toFixed(1)}/${s.S.toFixed(1)} | ${(s.res||'TO').padEnd(8)} | ${pnlStr.padStart(7)}% ${resultColor}`);
  }

  // ═══ FINAL VERDICT ═══
  console.log('\n'+'═'.repeat(70));
  console.log('  FINAL VERDICT — INSTITUTIONAL QUALITY ASSESSMENT');
  console.log('═'.repeat(70)+'\n');

  const testWR=test.wr;const testPnl=test.pnl;const fullWR=full.wr;const fullPnl=full.pnl;
  const avgPnlPerTrade=full.total>0?full.pnl/full.total:0;
  const profitFactor=full.signals.filter(s=>s.pnl>0).reduce((a,s)=>a+s.pnl,0)/Math.abs(full.signals.filter(s=>s.pnl<0).reduce((a,s)=>a+s.pnl,0)||1);
  const maxDD=(() => {
    let peak=0,dd=0,maxDD=0;
    for(const s of full.signals){peak+=s.pnl;if(peak>dd)dd=peak;const drawdown=dd-peak;if(drawdown>maxDD)maxDD=drawdown;}
    return maxDD;
  })();
  const sharpe=(() => {
    const rets=full.signals.map(s=>s.pnl);if(rets.length<2)return 0;
    const avg=rets.reduce((a,b)=>a+b)/rets.length;
    const std=Math.sqrt(rets.reduce((a,b)=>a+Math.pow(b-avg,2),0)/(rets.length-1));
    return std>0?avg/std*Math.sqrt(252):0;
  })();

  console.log(`  Total signals: ${full.total} over ${full.days.toFixed(1)} days (${full.spd.toFixed(1)} signals/day)`);
  console.log(`  Walk-Forward WR: ${testWR.toFixed(1)}% (unseen test data)`);
  console.log(`  Walk-Forward PnL: ${testPnl>=0?'+':''}${testPnl.toFixed(2)}% (unseen test data)`);
  console.log(`  Full WR: ${fullWR.toFixed(1)}%`);
  console.log(`  Full PnL: ${fullPnl>=0?'+':''}${fullPnl.toFixed(2)}%`);
  console.log(`  Avg PnL/trade: ${avgPnlPerTrade>=0?'+':''}${avgPnlPerTrade.toFixed(3)}%`);
  console.log(`  Profit Factor: ${profitFactor.toFixed(2)}`);
  console.log(`  Max Drawdown: -${maxDD.toFixed(2)}%`);
  console.log(`  Sharpe Ratio: ${sharpe.toFixed(2)}`);
  console.log();
  console.log(`  ${fullWR>=55?'✓':'✗'} Win Rate ≥ 55%`);
  console.log(`  ${fullPnl>0?'✓':'✗'} Positive PnL`);
  console.log(`  ${profitFactor>1?'✓':'✗'} Profit Factor > 1.0`);
  console.log(`  ${testPnl>0?'✓':'✗'} Profitable on unseen data`);
  console.log(`  ${Math.abs(testWR-train.wr)<15?'✓':'✗'} WR stable (train vs test delta < 15%)`);
  console.log(`  ${maxDD<20?'✓':'✗'} Max Drawdown < 20%`);

  console.log('\n'+'═'.repeat(70));
}

main().catch(console.error);
