#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// BACKTEST v8 DEFINITIVO — 60 días reales Binance
// SIN filtros temporales, SIN bias, SIN look-ahead
// Simula exactamente como un usuario real con autotrading
// ═══════════════════════════════════════════════════════════════

const https = require('https');

const DAYS = 60;
const VIP_SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];
const SCALP_SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','ADAUSDT','DOTUSDT','ARBUSDT','OPUSDT','SUIUSDT','FILUSDT','UNIUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT','TIAUSDT','ATOMUSDT'];
const FREE_SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];

// ═══ INDICATOR FUNCTIONS (exact copy from app.html) ═══
function calcEMA(arr, p) { if(!arr||arr.length<p) return arr?arr[arr.length-1]||0:0; let m=2/(p+1),e=arr[0]; for(let i=1;i<arr.length;i++) e=arr[i]*m+e*(1-m); return e; }
function calcEMAArr(arr, p) { if(!arr||!arr.length) return []; let m=2/(p+1),res=[arr[0]]; for(let i=1;i<arr.length;i++) res.push(arr[i]*m+res[i-1]*(1-m)); return res; }
function calcRSI(c,p=14){ if(!c||c.length<p+1)return 50; let g=0,l=0; for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1]; if(d>0)g+=d;else l-=d;} g/=p;l/=p; if(l===0)return 100; const rs=g/l; return 100-100/(1+rs); }
function calcMACD(c){ if(!c||c.length<26)return{m:0,s:0,h:0,ph:0}; const e12=calcEMAArr(c,12),e26=calcEMAArr(c,26); const ml=[]; for(let i=0;i<c.length;i++) ml.push((e12[i]||0)-(e26[i]||0)); const sl=calcEMAArr(ml,9); const h=(ml.at(-1)||0)-(sl.at(-1)||0); const ph=(ml.at(-2)||0)-(sl.at(-2)||0); return{m:ml.at(-1)||0,s:sl.at(-1)||0,h,ph}; }
function calcBB(c,p=20,k=2){ if(!c||c.length<p)return{u:c?c.at(-1)||0:0,m:0,l:0}; const sl=c.slice(-p); const m=sl.reduce((a,b)=>a+b)/p; const std=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/p); return{u:m+k*std,m,l:m-k*std}; }
function calcStoch(h,l,c,p=14){ if(!h||h.length<p)return{k:50,d:50}; const hh=Math.max(...h.slice(-p)),ll=Math.min(...l.slice(-p)); const k=hh!==ll?((c.at(-1)-ll)/(hh-ll))*100:50; return{k,d:k}; }
function calcATR(h,l,c,p=14){ if(!h||h.length<p+1)return 0; let trs=[]; for(let i=1;i<h.length;i++){ trs.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1]))); } const sl=trs.slice(-p); return sl.reduce((a,b)=>a+b)/sl.length; }
function calcADX(h,l,c,p=14){ if(!h||h.length<p*2)return{adx:0,pdi:0,mdi:0}; let pdm=[],mdm=[],tr=[]; for(let i=1;i<h.length;i++){ const up=h[i]-h[i-1],dn=l[i-1]-l[i]; pdm.push(up>dn&&up>0?up:0); mdm.push(dn>up&&dn>0?dn:0); tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]))); } const atr=calcEMA(tr,p)||1; const sPDM=calcEMA(pdm,p); const sMDM=calcEMA(mdm,p); const pdi=(sPDM/atr)*100; const mdi=(sMDM/atr)*100; const dx=pdi+mdi>0?Math.abs(pdi-mdi)/(pdi+mdi)*100:0; return{adx:dx,pdi,mdi}; }
function calcOBV(c,v){ if(!c||c.length<2)return{value:0,rising:false}; let obv=0; for(let i=1;i<c.length;i++){ if(c[i]>c[i-1])obv+=v[i]; else if(c[i]<c[i-1])obv-=v[i]; } const prev5=c.length>6?c.slice(-6,-1):c; let obv5=0; for(let i=1;i<prev5.length;i++){if(prev5[i]>prev5[i-1])obv5+=v[v.length-prev5.length+i]||0;} return{value:obv,rising:obv>obv5}; }
function calcParabolicSAR(h,l,c){ if(!h||h.length<3)return{sar:c?c.at(-1)||0:0,trend:'BUY',recentFlip:false}; let trend='BUY',af=0.02,ep=h[0],sar=l[0],prevSar=sar; for(let i=1;i<h.length;i++){ prevSar=sar; sar=sar+af*(ep-sar); if(trend==='BUY'){if(l[i]<sar){trend='SELL';sar=ep;ep=l[i];af=0.02;}else{if(h[i]>ep){ep=h[i];af=Math.min(af+0.02,0.2);}}}else{if(h[i]>sar){trend='BUY';sar=ep;ep=h[i];af=0.02;}else{if(l[i]<ep){ep=l[i];af=Math.min(af+0.02,0.2);}}} } return{sar,trend,recentFlip:Math.abs(sar-prevSar)/(c.at(-1)||1)>0.003}; }
function calcVWAP(klines){ if(!klines||!klines.length)return[0]; let cumVol=0,cumTP=0; return klines.map(k=>{const h=parseFloat(k[2]),l=parseFloat(k[3]),c=parseFloat(k[4]),v=parseFloat(k[5]); const tp=(h+l+c)/3; cumVol+=v; cumTP+=tp*v; return cumVol>0?cumTP/cumVol:c;}); }
function calcKeltner(h,l,c,emaPer=20,atrPer=14,mult=2){ const ema=calcEMA(c,emaPer); const atr=calcATR(h,l,c,atrPer); const upper=ema+mult*atr; const lower=ema-mult*atr; const width=upper-lower; const pos=width>0?(c.at(-1)-lower)/width:0.5; return{upper,ema,lower,position:pos,width}; }
function calcMFI(h,l,c,v,p=14){ if(!h||h.length<p+1)return 50; let posF=0,negF=0; for(let i=h.length-p;i<h.length;i++){ const tp=(h[i]+l[i]+c[i])/3; const ptp=(h[i-1]+l[i-1]+c[i-1])/3; const mf=tp*v[i]; if(tp>ptp)posF+=mf; else negF+=mf; } if(negF===0)return 100; return 100-100/(1+posF/negF); }
function detectRSIDivergence(c,h,l,p=14){ if(!c||c.length<30)return{bull:false,bear:false}; const rsis=[]; for(let i=20;i<c.length;i++){ rsis.push(calcRSI(c.slice(0,i+1),p)); } if(rsis.length<10)return{bull:false,bear:false}; const r=rsis.slice(-10); const pr=c.slice(-10); const bull=pr.at(-1)<pr[0]&&r.at(-1)>r[0]; const bear=pr.at(-1)>pr[0]&&r.at(-1)<r[0]; return{bull,bear}; }
function detectMACDDivergence(c){ if(!c||c.length<40)return{bull:false,bear:false}; const m1=calcMACD(c.slice(0,-5)); const m2=calcMACD(c); const bull=c.at(-1)<c.at(-6)&&m2.h>m1.h; const bear=c.at(-1)>c.at(-6)&&m2.h<m1.h; return{bull,bear}; }
function detectOrderBlocks(h,l,c,v,lookback=50){ const res={bullOB:null,bearOB:null}; const s=Math.max(0,c.length-lookback); for(let i=s+2;i<c.length;i++){ if(c[i]>c[i-1]&&c[i-1]<c[i-2]&&v[i]>v[i-1]*1.5){ const dist=Math.abs(c.at(-1)-l[i-1])/c.at(-1); if(dist<0.02)res.bullOB={price:l[i-1],idx:i-1}; } if(c[i]<c[i-1]&&c[i-1]>c[i-2]&&v[i]>v[i-1]*1.5){ const dist=Math.abs(h[i-1]-c.at(-1))/c.at(-1); if(dist<0.02)res.bearOB={price:h[i-1],idx:i-1}; } } return res; }
function findPivotLevels(h,l,c,lookback=50){ const s=Math.max(0,h.length-lookback); let sups=[],ress=[]; for(let i=s+2;i<h.length-2;i++){ if(l[i]<l[i-1]&&l[i]<l[i-2]&&l[i]<l[i+1]&&l[i]<l[i+2])sups.push(l[i]); if(h[i]>h[i-1]&&h[i]>h[i-2]&&h[i]>h[i+1]&&h[i]>h[i+2])ress.push(h[i]); } const cur=c.at(-1); sups=sups.filter(s=>s<cur).sort((a,b)=>b-a); ress=ress.filter(r=>r>cur).sort((a,b)=>a-b); return{nearestSup:sups[0]||null,nearestRes:ress[0]||null}; }
function detectRegime(h,l,c,adxData,atr){ const volPct=atr/(c.at(-1)||1); if(adxData.adx>30&&volPct>0.015)return{regime:'VOLATILE',label:'ALTA VOLATILIDAD',cls:'volatile'}; if(adxData.adx>25)return{regime:'TRENDING',label:'TENDENCIA FUERTE',cls:'trending'}; if(adxData.adx>20)return{regime:'WEAK_TREND',label:'TENDENCIA DÉBIL',cls:'weak'}; return{regime:'RANGING',label:'RANGO LATERAL',cls:'ranging'}; }

// ═══ DATA FETCHING ═══
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function getKlines(sym, interval, limit, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}${endTime ? '&endTime=' + endTime : ''}`;
  try {
    const data = await fetchJSON(url);
    return data;
  } catch(e) { return null; }
}

// ═══ SIGNAL GENERATION (exact v8 logic from app.html) ═══
async function genSig(sym, kl5, kl15, kl1h, mode, hourUTC) {
  const isStrict = (mode === 'strict');
  const isScalp = (mode === 'scalp');

  if(!kl5 || !kl5.length) return null;
  const C = kl5.map(k => parseFloat(k[4])), H = kl5.map(k => parseFloat(k[2])), L = kl5.map(k => parseFloat(k[3])), V = kl5.map(k => parseFloat(k[5]));
  const C15 = kl15 ? kl15.map(k => parseFloat(k[4])) : [];
  const H15 = kl15 ? kl15.map(k => parseFloat(k[2])) : [];
  const L15 = kl15 ? kl15.map(k => parseFloat(k[3])) : [];
  const V15 = kl15 ? kl15.map(k => parseFloat(k[5])) : [];
  const cur = C.at(-1);
  let B = 0, S = 0;

  // HTF Trend (1H)
  const C1h = (kl1h && kl1h.length > 15) ? kl1h.map(k => parseFloat(k[4])) : [];
  const H1h = (kl1h && kl1h.length > 15) ? kl1h.map(k => parseFloat(k[2])) : [];
  const L1h = (kl1h && kl1h.length > 15) ? kl1h.map(k => parseFloat(k[3])) : [];
  const V1h = (kl1h && kl1h.length > 15) ? kl1h.map(k => parseFloat(k[5])) : [];

  let htfTrend = 'NEUTRAL', htfStrength = 0;
  if(kl1h && kl1h.length > 25) {
    const ema9h = calcEMA(C1h,9), ema21h = calcEMA(C1h,21), ema50h = calcEMA(C1h,50);
    const rsi1h = calcRSI(C1h,14); const mac1h = calcMACD(C1h);
    const adx1h = calcADX(H1h,L1h,C1h); const obv1h = calcOBV(C1h,V1h);
    let hB=0, hS=0;
    if(ema9h > ema21h) hB+=2; else hS+=2;
    if(C1h.at(-1) > ema50h) hB+=1; else hS+=1;
    if(mac1h.h > 0) hB+=1.5; else hS+=1.5;
    if(mac1h.h > mac1h.ph) hB+=1; else hS+=1;
    if(rsi1h > 50) hB+=1; else hS+=1;
    if(adx1h.adx > 20 && adx1h.pdi > adx1h.mdi) hB+=1.5;
    else if(adx1h.adx > 20 && adx1h.mdi > adx1h.pdi) hS+=1.5;
    if(obv1h.rising) hB+=1; else hS+=1;
    if(hB > hS + 2) { htfTrend = 'BUY'; htfStrength = hB - hS; }
    else if(hS > hB + 2) { htfTrend = 'SELL'; htfStrength = hS - hB; }
  }

  // 15m Confirmation
  let mtfConfirm = 'NEUTRAL';
  if(C15.length > 25) {
    const ema9_15 = calcEMA(C15,9), ema21_15 = calcEMA(C15,21);
    const rsi15 = calcRSI(C15,14); const mac15 = calcMACD(C15);
    let mB=0, mS=0;
    if(ema9_15 > ema21_15) mB+=1; else mS+=1;
    if(mac15.h > 0) mB+=1; else mS+=1;
    if(rsi15 > 50) mB+=0.5; else if(rsi15 < 50) mS+=0.5;
    if(mB > mS) mtfConfirm = 'BUY';
    else if(mS > mB) mtfConfirm = 'SELL';
  }

  // Session timing
  const isDeadHours = hourUTC >= 0 && hourUTC < 6;
  const isLondonOpen = hourUTC >= 8 && hourUTC < 10;
  const isNYOpen = hourUTC >= 13 && hourUTC < 16;
  const isOverlap = hourUTC >= 13 && hourUTC < 16;

  // Regime
  const adxData = calcADX(H, L, C);
  let atr = calcATR(H, L, C, 14);
  let regimeData = {regime:'RANGING',label:'RANGO',cls:'ranging'};
  try { regimeData = detectRegime(H, L, C, adxData, atr); } catch(e) {}
  const isVolatile = (regimeData.regime === 'VOLATILE');

  let signal = 'NEUTRAL', conf = 50, score = 0, indCount = 0, tpMult, slMult;

  if(isStrict) {
    // ═══ VIP INSTITUTIONAL v8 ═══
    const htfNeutralPenalty = (htfTrend === 'NEUTRAL') ? 3 : 0;
    const requiredScore = 7 + htfNeutralPenalty;
    const requiredInds = 4;

    const rsi=calcRSI(C,14); const mac=calcMACD(C);
    const ea9=calcEMAArr(C,9),ea21=calcEMAArr(C,21);
    const e9=ea9.at(-1),e21=ea21.at(-1); const e50=calcEMA(C,50);
    const bb=calcBB(C,20,2); const bbR=bb.u-bb.l; const bbPos=bbR>0?(cur-bb.l)/bbR:0.5;
    const vwapArr=calcVWAP(kl5.slice(-50)); const vwap=vwapArr.at(-1);
    const avgV=V.slice(-20).reduce((a,b)=>a+b)/20,lv=V.at(-1),vr=lv/avgV;
    const obvData=calcOBV(C,V); const psar=calcParabolicSAR(H,L,C);
    const stFull=calcStoch(H,L,C,14);
    const rsiDiv=detectRSIDivergence(C,H,L,14); const macdDiv=detectMACDDivergence(C);
    const kc=calcKeltner(H,L,C,20,14,2);
    let orderBlocks={bullOB:null,bearOB:null};
    try{orderBlocks=detectOrderBlocks(H,L,C,V,50);}catch(e){}
    const mfi=calcMFI(H,L,C,V,14); const pivots=findPivotLevels(H,L,C,50);

    let bScore=0,sScore=0,bInds=0,sInds=0;

    // 1. RSI(14)
    if(rsi<25){bScore+=5;bInds++;}else if(rsi<30){bScore+=4;bInds++;}else if(rsi<35){bScore+=3;bInds++;}
    else if(rsi>75){sScore+=5;sInds++;}else if(rsi>70){sScore+=4;sInds++;}else if(rsi>65){sScore+=3;sInds++;}
    // 2. Stoch(14)
    const stK=stFull.k||50;
    if(stK<20){bScore+=4;bInds++;}else if(stK<25){bScore+=3;bInds++;}
    else if(stK>80){sScore+=4;sInds++;}else if(stK>75){sScore+=3;sInds++;}
    // 3. BB(20,2)
    if(bbPos<0.08){bScore+=3;bInds++;}else if(bbPos<0.15){bScore+=2;bInds++;}
    else if(bbPos>0.92){sScore+=3;sInds++;}else if(bbPos>0.85){sScore+=2;sInds++;}
    // 4. MACD
    const macdCrossUp=mac.h>0&&mac.ph<=0; const macdCrossDown=mac.h<0&&mac.ph>=0;
    if(macdCrossUp){bScore+=2;bInds++;}else if(macdCrossDown){sScore+=2;sInds++;}
    // 5. EMA 9/21 + EMA50
    if(e9>e21){bScore+=1.5;bInds++;}else{sScore+=1.5;sInds++;}
    if(cur>e50){bScore+=1;}else{sScore+=1;}
    // 6. ADX
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
    if(vr>2.0){const vSig=rsi<50?'BUY':'SELL';if(vSig==='BUY'){bScore+=2;bInds++;}else{sScore+=2;sInds++;}}
    else if(vr>1.3){const vSig=rsi<50?'BUY':'SELL';if(vSig==='BUY'){bScore+=1;bInds++;}else{sScore+=1;sInds++;}}
    // 16. Support/Resistance
    if(pivots.nearestSup&&(cur-pivots.nearestSup)<atr*0.5){bScore+=2;bInds++;}
    if(pivots.nearestRes&&(pivots.nearestRes-cur)<atr*0.5){sScore+=2;sInds++;}
    // 17. Session (v8: reduced penalties)
    if(isOverlap){bScore+=1.5;sScore+=1.5;}else if(isLondonOpen||isNYOpen){bScore+=1;sScore+=1;}
    if(isDeadHours){bScore-=0.5;sScore-=0.5;}

    // v8: Toxic hours -1 (was -3)
    if(hourUTC>=20&&hourUTC<=23){bScore-=1;sScore-=1;}

    // v8: Score threshold = requiredScore — más señales, WR por R:R
    const vipMinScore = requiredScore;
    if(htfTrend==='BUY'&&bScore>=vipMinScore&&bInds>=requiredInds){signal='BUY';score=bScore;indCount=bInds;}
    else if(htfTrend==='SELL'&&sScore>=vipMinScore&&sInds>=requiredInds){signal='SELL';score=sScore;indCount=sInds;}
    else if(htfTrend==='NEUTRAL'){
      if(bScore>=vipMinScore&&bInds>=requiredInds&&bScore>sScore+2){signal='BUY';score=bScore;indCount=bInds;}
      else if(sScore>=vipMinScore&&sInds>=requiredInds&&sScore>bScore+2){signal='SELL';score=sScore;indCount=sInds;}
    }

    if(signal!=='NEUTRAL'&&vr<0.1)signal='NEUTRAL';

    if(signal!=='NEUTRAL'){
      const maxScore=30;
      conf=Math.round(55+(score/maxScore)*38);
      if(htfTrend===signal)conf+=5;
      if(mtfConfirm===signal)conf+=3;
      conf=Math.min(95,conf);
    }
    B=signal==='BUY'?score:0; S=signal==='SELL'?score:0;
    tpMult=0.4; slMult=1.2;

  } else if(isScalp) {
    // ═══ SCALP v8 ═══
    const scalpGate = mtfConfirm;
    const rsiS=calcRSI(C,7); const mac=calcMACD(C);
    const ea5=calcEMAArr(C,5),ea13=calcEMAArr(C,13);
    const e5=ea5.at(-1),e13=ea13.at(-1);
    const bbS=calcBB(C,10,1.8); const bbSR=bbS.u-bbS.l; const bbSPos=bbSR>0?(cur-bbS.l)/bbSR:0.5;
    const vwapArr=calcVWAP(kl5.slice(-50)); const vwap=vwapArr.at(-1);
    const avgV=V.slice(-20).reduce((a,b)=>a+b)/20,lv=V.at(-1),vr=lv/avgV;
    const stS=calcStoch(H,L,C,7); const stK=stS.k||50,stD=stS.d||50;
    const psar=calcParabolicSAR(H,L,C);
    const kc=calcKeltner(H,L,C,20,14,2);
    const mfi=calcMFI(H,L,C,V,7);

    let bScore=0,sScore=0,bInds=0,sInds=0;

    // 1. RSI(7)
    if(rsiS<30){bScore+=3;bInds++;}else if(rsiS<40){bScore+=2;bInds++;}
    else if(rsiS>70){sScore+=3;sInds++;}else if(rsiS>60){sScore+=2;sInds++;}
    // 2. Stoch(7)
    const stCrossUp=stK>stD&&stK<35; const stCrossDown=stK<stD&&stK>65;
    if(stK<30){bScore+=2;bInds++;if(stCrossUp)bScore+=1;}
    else if(stK>70){sScore+=2;sInds++;if(stCrossDown)sScore+=1;}
    // 3. BB(10,1.8)
    if(bbSPos<0.10){bScore+=3;bInds++;}else if(bbSPos<0.20){bScore+=2;bInds++;}
    else if(bbSPos>0.90){sScore+=3;sInds++;}else if(bbSPos>0.80){sScore+=2;sInds++;}
    // 4. MACD
    if(mac.h>0&&mac.ph<=0){bScore+=2;bInds++;}else if(mac.h<0&&mac.ph>=0){sScore+=2;sInds++;}
    // 5. EMA 5/13
    if(e5>e13){bScore+=1.5;bInds++;}else{sScore+=1.5;sInds++;}
    // 6. VWAP
    if(vwap&&cur<vwap){bScore+=1;bInds++;}else if(vwap&&cur>vwap){sScore+=1;sInds++;}
    // 7. Volume
    if(vr>1.8){const vSig=rsiS<50?'BUY':'SELL';if(vSig==='BUY'){bScore+=2;bInds++;}else{sScore+=2;sInds++;}}
    else if(vr>1.2){const vSig=rsiS<50?'BUY':'SELL';if(vSig==='BUY'){bScore+=1;bInds++;}else{sScore+=1;sInds++;}}
    // 8. Keltner
    if(kc.position<0.20){bScore+=1.5;bInds++;}else if(kc.position>0.80){sScore+=1.5;sInds++;}
    // 9. PSAR
    if(psar.trend==='BUY'){bScore+=1;bInds++;}else{sScore+=1;sInds++;}
    // 10. MFI(7)
    if(mfi<30){bScore+=1;bInds++;}else if(mfi>70){sScore+=1;sInds++;}

    // Session (v8: no 15-18 penalty)
    if(isOverlap){bScore+=1;sScore+=1;}else if(isLondonOpen||isNYOpen){bScore+=0.5;sScore+=0.5;}
    if(isDeadHours){bScore-=0.5;sScore-=0.5;}

    // v8: Score threshold 5
    const minScore=5,minInds=3;
    if(scalpGate==='BUY'&&bScore>=minScore&&bInds>=minInds){signal='BUY';score=bScore;indCount=bInds;}
    else if(scalpGate==='SELL'&&sScore>=minScore&&sInds>=minInds){signal='SELL';score=sScore;indCount=sInds;}
    else if(scalpGate==='NEUTRAL'){
      if(bScore>=minScore+1&&bInds>=minInds&&bScore>sScore+1.5){signal='BUY';score=bScore;indCount=bInds;}
      else if(sScore>=minScore+1&&sInds>=minInds&&sScore>bScore+1.5){signal='SELL';score=sScore;indCount=sInds;}
    }
    if(signal==='NEUTRAL'){
      if(bScore>=minScore+2&&bInds>=minInds+1&&bScore>sScore+2){signal='BUY';score=bScore;indCount=bInds;}
      else if(sScore>=minScore+2&&sInds>=minInds+1&&sScore>bScore+2){signal='SELL';score=sScore;indCount=sInds;}
    }

    if(signal!=='NEUTRAL'&&isVolatile&&adxData.adx>40)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&vr<0.15)signal='NEUTRAL';

    if(signal!=='NEUTRAL'){
      const maxScore=22;
      conf=Math.round(50+(score/maxScore)*40);
      if(mtfConfirm===signal)conf+=3;
      if(htfTrend===signal)conf+=5;
      conf=Math.min(90,conf);
    }
    B=signal==='BUY'?score:0; S=signal==='SELL'?score:0;
    tpMult=1.5; slMult=0.5;

  } else {
    // ═══ FREE v8 ═══
    const rsi=calcRSI(C,14);
    const bb=calcBB(C,20,2); const bbR=bb.u-bb.l; const bbPos=bbR>0?(cur-bb.l)/bbR:0.5;
    const ea9=calcEMAArr(C,9),ea21=calcEMAArr(C,21);
    const e9=ea9.at(-1),e21=ea21.at(-1);
    const stFull=calcStoch(H,L,C,14); const stK=stFull.k||50;
    const mac=calcMACD(C);
    const avgV=V.slice(-20).reduce((a,b)=>a+b)/20,lv=V.at(-1),vr=lv/avgV;

    let bScore=0,sScore=0,bInds=0,sInds=0;
    if(rsi<30){bScore+=3;bInds++;}else if(rsi>70){sScore+=3;sInds++;}
    if(bbPos<0.10){bScore+=2;bInds++;}else if(bbPos>0.90){sScore+=2;sInds++;}
    if(stK<25){bScore+=2;bInds++;}else if(stK>75){sScore+=2;sInds++;}
    if(e9>e21){bScore+=1.5;bInds++;}else{sScore+=1.5;sInds++;}
    if(vr>1.5){const vSig=rsi<50?'BUY':'SELL';if(vSig==='BUY'){bScore+=1;bInds++;}else{sScore+=1;sInds++;}}
    if(mac.h>0){bScore+=0.5;}else{sScore+=0.5;}

    const minScore=5,minInds=3;
    if(bScore>=minScore&&bInds>=minInds&&bScore>sScore+1){signal='BUY';score=bScore;indCount=bInds;}
    else if(sScore>=minScore&&sInds>=minInds&&sScore>bScore+1){signal='SELL';score=sScore;indCount=sInds;}

    if(signal!=='NEUTRAL'&&isVolatile)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&vr<0.15)signal='NEUTRAL';

    if(signal!=='NEUTRAL'){
      conf=Math.round(50+(score/10)*35);
      if(htfTrend===signal)conf+=3;
      conf=Math.min(85,conf);
    }
    B=signal==='BUY'?score:0; S=signal==='SELL'?score:0;
    tpMult=1.5; slMult=1.0;
  }

  // TP/SL
  let atr15=atr;
  if(kl15&&kl15.length>15&&H15.length>15&&L15.length>15){const _a=calcATR(H15,L15,C15,14);if(_a>0)atr15=_a;}
  let atr1h=atr;
  if(H1h.length>15&&L1h.length>15&&C1h.length>15){const _a=calcATR(H1h,L1h,C1h,14);if(_a>0)atr1h=_a;}
  const useATR=isScalp?calcATR(H,L,C,7)||atr:Math.max(atr15,atr1h/4);

  let tpDist=useATR*tpMult, slDist=useATR*slMult;
  const minTPdist=cur*0.002;
  if(tpDist<minTPdist)tpDist=minTPdist;
  if(slDist<cur*0.001)slDist=cur*0.001;
  const costBuffer=cur*0.0008;

  const tp=signal==='BUY'?cur+tpDist+costBuffer:signal==='SELL'?cur-tpDist-costBuffer:null;
  const sl=signal==='BUY'?cur-slDist-costBuffer:signal==='SELL'?cur+slDist+costBuffer:null;

  return{signal,confidence:conf,entry:cur,tp,sl,tpDist,slDist,atr};
}

// ═══ BACKTEST ENGINE ═══
async function runBacktest(mode, symbols, label) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${label} — ${DAYS} DÍAS REALES BINANCE`);
  console.log(`  Modo: ${mode} | Pares: ${symbols.length} | Sin filtros ni bias`);
  console.log(`${'═'.repeat(60)}\n`);

  const cdBars = mode === 'strict' ? 25 : mode === 'scalp' ? 15 : 60;
  const cdMs = cdBars * 5 * 60 * 1000;

  const endTime = Date.now();
  const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
  const barMs = 5 * 60 * 1000;

  let totalSignals = 0, wins = 0, losses = 0;
  let totalProfit = 0, grossProfit = 0, grossLoss = 0;
  let maxConsecWin = 0, maxConsecLoss = 0, curConsecWin = 0, curConsecLoss = 0;
  let balance = 10000;
  const tradeAmt = 500, leverage = 5;
  let peakBal = balance, maxDD = 0;
  const dailyPnL = {};

  // Process each symbol
  for(const sym of symbols) {
    process.stdout.write(`  Cargando ${sym}...`);

    // Download ALL 5m candles for the period
    let allKlines5 = [];
    let fetchEnd = endTime;
    while(true) {
      const batch = await getKlines(sym, '5m', 1000, fetchEnd);
      if(!batch || !batch.length) break;
      allKlines5 = batch.concat(allKlines5);
      const firstTime = batch[0][0];
      if(firstTime <= startTime) break;
      fetchEnd = firstTime - 1;
      await new Promise(r => setTimeout(r, 100));
    }

    // Also download 15m and 1h
    let allKlines15 = [];
    fetchEnd = endTime;
    while(true) {
      const batch = await getKlines(sym, '15m', 1000, fetchEnd);
      if(!batch || !batch.length) break;
      allKlines15 = batch.concat(allKlines15);
      if(batch[0][0] <= startTime) break;
      fetchEnd = batch[0][0] - 1;
      await new Promise(r => setTimeout(r, 100));
    }

    let allKlines1h = [];
    fetchEnd = endTime;
    const batch1h = await getKlines(sym, '1h', 1000, fetchEnd);
    if(batch1h) allKlines1h = batch1h;
    await new Promise(r => setTimeout(r, 100));

    // Filter to our date range
    allKlines5 = allKlines5.filter(k => k[0] >= startTime && k[0] <= endTime);
    allKlines15 = allKlines15.filter(k => k[0] >= startTime - 100 * 15 * 60 * 1000);
    allKlines1h = allKlines1h.filter(k => k[0] >= startTime - 50 * 60 * 60 * 1000);

    console.log(` ${allKlines5.length} velas 5m`);

    // Walk through bar by bar
    let lastSignalTime = 0;
    const lookback5 = 280;
    const lookback15 = 100;
    const lookback1h = 50;

    for(let i = lookback5; i < allKlines5.length; i++) {
      const barTime = allKlines5[i][0];

      // Cooldown check
      if(barTime - lastSignalTime < cdMs) continue;

      // Get window of candles up to current bar (NO look-ahead)
      const kl5 = allKlines5.slice(Math.max(0, i - lookback5), i + 1);
      const kl15 = allKlines15.filter(k => k[0] <= barTime).slice(-lookback15);
      const kl1h = allKlines1h.filter(k => k[0] <= barTime).slice(-lookback1h);

      const hourUTC = new Date(barTime).getUTCHours();

      const sig = await genSig(sym, kl5, kl15, kl1h, mode, hourUTC);
      if(!sig || sig.signal === 'NEUTRAL') continue;
      if(sig.confidence < 65) continue; // Min confidence like real autotrading

      lastSignalTime = barTime;
      totalSignals++;

      // Evaluate: walk forward to see if TP or SL is hit first
      const entry = sig.entry;
      const tp = sig.tp;
      const sl = sig.sl;
      let result = null;
      let exitPrice = entry;

      // SOLO TP/SL PURO — Sin trailing, 100% replicable
      for(let j = i + 1; j < allKlines5.length && j < i + 500; j++) {
        const candleH = parseFloat(allKlines5[j][2]);
        const candleL = parseFloat(allKlines5[j][3]);

        if(sig.signal === 'BUY') {
          if(candleH >= tp) { result = 'WIN'; exitPrice = tp; break; }
          if(candleL <= sl) { result = 'LOSS'; exitPrice = sl; break; }
        } else {
          if(candleL <= tp) { result = 'WIN'; exitPrice = tp; break; }
          if(candleH >= sl) { result = 'LOSS'; exitPrice = sl; break; }
        }
      }

      // Timeout — evaluate at last candle
      if(!result) {
        const lastC = parseFloat(allKlines5[Math.min(i + 499, allKlines5.length - 1)][4]);
        const pct = sig.signal === 'BUY' ? (lastC - entry) / entry : (entry - lastC) / entry;
        result = pct > 0 ? 'WIN' : 'LOSS';
        exitPrice = lastC;
      }

      // Calculate PnL
      const pctMove = sig.signal === 'BUY' ? (exitPrice - entry) / entry : (entry - exitPrice) / entry;
      const pnl = tradeAmt * leverage * pctMove;
      balance += pnl;
      totalProfit += pnl;

      if(pnl > 0) {
        grossProfit += pnl;
        wins++;
        curConsecWin++;
        curConsecLoss = 0;
        if(curConsecWin > maxConsecWin) maxConsecWin = curConsecWin;
      } else {
        grossLoss += Math.abs(pnl);
        losses++;
        curConsecLoss++;
        curConsecWin = 0;
        if(curConsecLoss > maxConsecLoss) maxConsecLoss = curConsecLoss;
      }

      if(balance > peakBal) peakBal = balance;
      const dd = ((peakBal - balance) / peakBal) * 100;
      if(dd > maxDD) maxDD = dd;

      // Track daily
      const day = new Date(barTime).toISOString().split('T')[0];
      if(!dailyPnL[day]) dailyPnL[day] = { pnl: 0, trades: 0, wins: 0 };
      dailyPnL[day].pnl += pnl;
      dailyPnL[day].trades++;
      if(pnl > 0) dailyPnL[day].wins++;
    }
  }

  // ═══ RESULTS ═══
  const wr = totalSignals > 0 ? (wins / totalSignals * 100) : 0;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  const avgWin = wins > 0 ? grossProfit / wins : 0;
  const avgLoss = losses > 0 ? grossLoss / losses : 0;
  const sigPerDay = totalSignals / DAYS;
  const pnlPct = (totalProfit / 10000) * 100;

  const days = Object.keys(dailyPnL).sort();
  const profitDays = days.filter(d => dailyPnL[d].pnl > 0).length;
  const lossDays = days.filter(d => dailyPnL[d].pnl <= 0).length;

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  RESULTADOS: ${label}`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`  Señales totales:     ${totalSignals}`);
  console.log(`  Señales/día:         ${sigPerDay.toFixed(1)}`);
  console.log(`  Wins: ${wins} | Losses: ${losses}`);
  console.log(`  Win Rate:            ${wr.toFixed(1)}%`);
  console.log(`  Profit Factor:       ${pf.toFixed(2)}`);
  console.log(`  PnL Total:           ${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`);
  console.log(`  Balance final:       $${balance.toFixed(2)}`);
  console.log(`  Avg Win:             +$${avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:            -$${avgLoss.toFixed(2)}`);
  console.log(`  Avg Win/Avg Loss:    ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : '∞'}:1`);
  console.log(`  Max Drawdown:        ${maxDD.toFixed(1)}%`);
  console.log(`  Max Consec Wins:     ${maxConsecWin}`);
  console.log(`  Max Consec Losses:   ${maxConsecLoss}`);
  console.log(`  Días profit/loss:    ${profitDays}/${lossDays}`);
  console.log(`  Daily WR:            ${((profitDays / (profitDays + lossDays)) * 100).toFixed(1)}%`);
  console.log(`${'─'.repeat(50)}`);

  // Show worst/best 5 days
  const sortedDays = days.map(d => ({day: d, ...dailyPnL[d]})).sort((a, b) => a.pnl - b.pnl);
  console.log(`\n  TOP 5 PEORES DÍAS:`);
  sortedDays.slice(0, 5).forEach(d => console.log(`    ${d.day}: ${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2)} (${d.trades} trades, WR ${((d.wins/d.trades)*100).toFixed(0)}%)`));
  console.log(`\n  TOP 5 MEJORES DÍAS:`);
  sortedDays.slice(-5).reverse().forEach(d => console.log(`    ${d.day}: +$${d.pnl.toFixed(2)} (${d.trades} trades, WR ${((d.wins/d.trades)*100).toFixed(0)}%)`));

  return { label, totalSignals, sigPerDay, wr, pf, pnlPct, balance, maxDD, avgWin, avgLoss };
}

// ═══ MAIN ═══
(async () => {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║  BACKTEST v8 DEFINITIVO — 60 DÍAS REALES BINANCE     ║');
  console.log('║  Sin filtros temporales, sin bias, sin look-ahead    ║');
  console.log('║  Trailing stop v3, R:R optimizado, cooldowns v8      ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`\n  Período: ${new Date(Date.now() - DAYS*24*60*60*1000).toISOString().split('T')[0]} → ${new Date().toISOString().split('T')[0]}`);
  console.log(`  Capital inicial: $10,000 | Trade size: $500 x5 leverage\n`);

  const results = [];

  results.push(await runBacktest('strict', VIP_SYMBOLS, 'VIP PRECISION INSTITUCIONAL'));
  results.push(await runBacktest('scalp', SCALP_SYMBOLS, 'SCALP MODE'));
  results.push(await runBacktest('frequent', FREE_SYMBOLS, 'FREE MODE'));

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  RESUMEN COMPARATIVO');
  console.log(`${'═'.repeat(60)}`);
  console.log(`  ${'Motor'.padEnd(30)} ${'Señales/d'.padStart(10)} ${'WR%'.padStart(7)} ${'PF'.padStart(7)} ${'PnL%'.padStart(10)} ${'MaxDD%'.padStart(8)}`);
  console.log(`  ${'─'.repeat(72)}`);
  results.forEach(r => {
    console.log(`  ${r.label.padEnd(30)} ${r.sigPerDay.toFixed(1).padStart(10)} ${r.wr.toFixed(1).padStart(6)}% ${r.pf.toFixed(2).padStart(7)} ${(r.pnlPct>=0?'+':'')+r.pnlPct.toFixed(1).padStart(9)}% ${r.maxDD.toFixed(1).padStart(7)}%`);
  });
  console.log(`${'═'.repeat(60)}\n`);
})();
