#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════
// BACKTEST AUDIT ENGINE v2 — Real Binance data, exact genSig() logic
// Tests: strict (VIP), scalp, frequent (free) modes
// Period: 14 days of 5m candles
// ══════════════════════════════════════════════════════════════

const https = require('https');

// ═══ PAIR LISTS (exact from app.html) ═══
const VIP_SCAN_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','ADAUSDT','DOTUSDT','LINKUSDT','APTUSDT','NEARUSDT','ATOMUSDT','FILUSDT','UNIUSDT','ARBUSDT','OPUSDT','SHIBUSDT','TRXUSDT','SUIUSDT','SEIUSDT','TIAUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT'];
const SCALP_SCAN_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','DOTUSDT','NEARUSDT','APTUSDT'];
const PUB_SCAN_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];

// ═══ INDICATOR CALCULATIONS (exact replicas from app.html) ═══

function calcRSI(closes, p=14) {
  if(closes.length < p+1) return 50;
  let g=0, l=0;
  for(let i=1; i<=p; i++) {
    const d = closes[i] - closes[i-1];
    if(d > 0) g += d; else l += Math.abs(d);
  }
  let ag = g/p, al = l/p;
  for(let i=p+1; i<closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag*(p-1) + (d>0?d:0)) / p;
    al = (al*(p-1) + (d<0?Math.abs(d):0)) / p;
  }
  if(al === 0) return 100;
  return 100 - (100/(1 + ag/al));
}

function calcEMAArr(data, p) {
  const k = 2/(p+1);
  const r = [data[0]];
  for(let i=1; i<data.length; i++) r.push(data[i]*k + r[i-1]*(1-k));
  return r;
}
function calcEMA(data, p) { return calcEMAArr(data, p).at(-1); }

function calcMACD(closes) {
  if(closes.length < 35) return {h:0, ph:0, macd:0, sig:0};
  const e12 = calcEMAArr(closes, 12), e26 = calcEMAArr(closes, 26);
  const ml = e12.map((v,i) => v - e26[i]);
  const sl = calcEMAArr(ml, 9);
  return {h: ml.at(-1)-sl.at(-1), ph: (ml.at(-2)||0)-(sl.at(-2)||sl.at(-1)), macd: ml.at(-1), sig: sl.at(-1)};
}

function calcBB(closes, p=20, s=2) {
  if(closes.length < p) return {u:0, m:0, l:0};
  const sl = closes.slice(-p);
  const m = sl.reduce((a,b) => a+b) / p;
  const sd = Math.sqrt(sl.reduce((a,b) => a + Math.pow(b-m, 2), 0) / p);
  return {u: m+s*sd, m, l: m-s*sd};
}

function calcStoch(H, L, C, kp=14) {
  if(C.length < kp+3) return {k:50, d:50};
  const kArr = [];
  for(let i=kp; i<=C.length; i++) {
    const sh = H.slice(i-kp, i), sl = L.slice(i-kp, i);
    const hi = Math.max(...sh), lo = Math.min(...sl);
    kArr.push(hi===lo ? 50 : ((C[i-1]-lo)/(hi-lo))*100);
  }
  const dArr = [];
  for(let i=2; i<kArr.length; i++) dArr.push((kArr[i]+kArr[i-1]+kArr[i-2])/3);
  return {k: kArr.at(-1)||50, d: dArr.at(-1)||50};
}

function calcATR(H, L, C, p=14) {
  if(C.length < p+1) return 0;
  const trs = [];
  for(let i=1; i<C.length; i++) trs.push(Math.max(H[i]-L[i], Math.abs(H[i]-C[i-1]), Math.abs(L[i]-C[i-1])));
  if(trs.length < p) return trs.reduce((a,b) => a+b) / trs.length;
  let atr = trs.slice(0,p).reduce((a,b) => a+b) / p;
  for(let i=p; i<trs.length; i++) atr = (atr*(p-1) + trs[i]) / p;
  return atr;
}

function calcADX(H, L, C, p=14) {
  if(C.length < p*2) return {adx:15, pdi:0, mdi:0};
  const pdm=[], mdm=[], tr=[];
  for(let i=1; i<H.length; i++) {
    const upMove = H[i]-H[i-1], dnMove = L[i-1]-L[i];
    pdm.push(upMove>dnMove && upMove>0 ? upMove : 0);
    mdm.push(dnMove>upMove && dnMove>0 ? dnMove : 0);
    tr.push(Math.max(H[i]-L[i], Math.abs(H[i]-C[i-1]), Math.abs(L[i]-C[i-1])));
  }
  function wilderSmooth(arr, period) {
    if(arr.length < period) return arr.map(() => 0);
    const r = [];
    let s = arr.slice(0, period).reduce((a,b) => a+b) / period;
    for(let i=0; i<period; i++) r.push(0);
    r[period-1] = s;
    for(let i=period; i<arr.length; i++) { s = (s*(period-1)+arr[i])/period; r.push(s); }
    return r;
  }
  const smTR = wilderSmooth(tr, p), smPDM = wilderSmooth(pdm, p), smMDM = wilderSmooth(mdm, p);
  const pdi = smPDM.map((v,i) => smTR[i] ? v/smTR[i]*100 : 0);
  const mdi = smMDM.map((v,i) => smTR[i] ? v/smTR[i]*100 : 0);
  const dx = pdi.map((v,i) => { const s=v+mdi[i]; return s ? Math.abs(v-mdi[i])/s*100 : 0; });
  const dxValid = dx.slice(p-1);
  const adxArr = dxValid.length >= p ? wilderSmooth(dxValid, p) : dxValid;
  return {adx: adxArr.at(-1)||15, pdi: pdi.at(-1)||0, mdi: mdi.at(-1)||0};
}

function calcOBV(C, V) {
  if(C.length < 2) return {obv:0, slope:0, rising:false};
  let obv = 0; const arr = [0];
  for(let i=1; i<C.length; i++) {
    if(C[i]>C[i-1]) obv+=V[i];
    else if(C[i]<C[i-1]) obv-=V[i];
    arr.push(obv);
  }
  const n = Math.min(arr.length, 20);
  const recent = arr.slice(-n);
  let sumX=0, sumY=0, sumXY=0, sumX2=0;
  for(let i=0; i<n; i++) { sumX+=i; sumY+=recent[i]; sumXY+=i*recent[i]; sumX2+=i*i; }
  const slope = (n*sumXY - sumX*sumY) / (n*sumX2 - sumX*sumX || 1);
  return {obv: arr.at(-1), slope, rising: slope>0};
}

function detectRegime(H, L, C, adxData, atr) {
  const len = Math.min(C.length, 20);
  const avgP = C.slice(-len).reduce((a,b) => a+b) / len;
  const atrPct = atr / avgP * 100;
  if(adxData.adx > 25 && atrPct > 1.5) return {regime:'TRENDING'};
  if(adxData.adx < 20 && atrPct < 0.8) return {regime:'QUIET'};
  if(atrPct > 2) return {regime:'VOLATILE'};
  return {regime:'RANGING'};
}

// ═══ DATA FETCHING ═══
function fetchKlines(sym, interval, limit, startTime) {
  return new Promise((resolve, reject) => {
    let url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
    if(startTime) url += `&startTime=${startTime}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if(parsed.code) { reject(new Error(parsed.msg || 'API error')); return; }
          resolve(parsed);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchAllKlines(sym, interval, totalCandles) {
  const allCandles = [];
  const msPerCandle = {'5m': 300000, '15m': 900000, '1h': 3600000}[interval] || 300000;
  const now = Date.now();
  let startTime = now - totalCandles * msPerCandle;

  while(allCandles.length < totalCandles) {
    const limit = Math.min(totalCandles - allCandles.length, 1000);
    try {
      const data = await fetchKlines(sym, interval, limit, startTime);
      if(!Array.isArray(data) || data.length === 0) break;
      allCandles.push(...data);
      startTime = data[data.length-1][0] + msPerCandle;
    } catch(e) {
      console.error(`  Fetch error ${sym} ${interval}: ${e.message}`);
      break;
    }
    await new Promise(r => setTimeout(r, 120));
  }
  return allCandles;
}

// ═══ SIGNAL GENERATION (exact replica) ═══
function genSigBacktest(C5, H5, L5, V5, C15, H15, L15, C1h, H1h, L1h, timestamps5, mode, sym) {
  const isStrict = mode === 'strict';
  const isScalp = mode === 'scalp';
  if(!C5 || C5.length < 100) return null;

  const C = C5, H = H5, L = L5, V = V5;
  const cur = C.at(-1);

  const rsi = calcRSI(C, 14);
  const mac = calcMACD(C);
  const bb = calcBB(C, 20, 2);
  const stFull = calcStoch(H, L, C, 14);
  const atr = calcATR(H, L, C, 14);
  const adxData = calcADX(H, L, C, 14);
  const obvData = calcOBV(C, V);
  const e9 = calcEMA(C, 9);
  const e21 = calcEMA(C, 21);
  const e50 = C.length >= 50 ? calcEMA(C, 50) : e21;
  const e9p = C.length > 10 ? calcEMA(C.slice(0,-1), 9) : e9;
  const e21p = C.length > 22 ? calcEMA(C.slice(0,-1), 21) : e21;

  const volSlice = V.slice(-20);
  const avgVol = volSlice.reduce((a,b) => a+b) / volSlice.length;
  const vr = avgVol > 0 ? V.at(-1) / avgVol : 1;

  const regimeData = detectRegime(H, L, C, adxData, atr);
  const isTrending = regimeData.regime === 'TRENDING';
  const isVolatile = regimeData.regime === 'VOLATILE';

  // HTF Trend (1H)
  let htfTrend = 'NEUTRAL';
  if(C1h && C1h.length > 25) {
    const ema9h = calcEMA(C1h, 9), ema21h = calcEMA(C1h, 21);
    const ema50h = C1h.length >= 50 ? calcEMA(C1h, 50) : ema21h;
    const rsi1h = calcRSI(C1h, 14);
    const mac1h = calcMACD(C1h);
    const adx1h = calcADX(H1h, L1h, C1h, 14);
    let hB=0, hS=0;
    if(ema9h > ema21h) hB+=2; else hS+=2;
    if(C1h.at(-1) > ema50h) hB+=1; else hS+=1;
    if(mac1h.h > 0) hB+=1.5; else hS+=1.5;
    if(mac1h.h > mac1h.ph) hB+=1; else hS+=1;
    if(rsi1h > 50) hB+=1; else hS+=1;
    if(adx1h.adx > 20 && adx1h.pdi > adx1h.mdi) hB+=1.5;
    else if(adx1h.adx > 20 && adx1h.mdi > adx1h.pdi) hS+=1.5;
    if(hB > hS + 2) htfTrend = 'BUY';
    else if(hS > hB + 2) htfTrend = 'SELL';
  }

  // MTF Confirm (15m)
  let mtfConfirm = 'NEUTRAL';
  if(C15 && C15.length > 25) {
    const ema9_15 = calcEMA(C15, 9), ema21_15 = calcEMA(C15, 21);
    const mac15 = calcMACD(C15);
    const rsi15 = calcRSI(C15, 14);
    let mB=0, mS=0;
    if(ema9_15 > ema21_15) mB+=1; else mS+=1;
    if(mac15.h > 0) mB+=1; else mS+=1;
    if(rsi15 > 50) mB+=0.5; else if(rsi15 < 50) mS+=0.5;
    if(mB > mS) mtfConfirm = 'BUY';
    else if(mS > mB) mtfConfirm = 'SELL';
  }

  let B=0, S=0;
  let buyInds=0, sellInds=0;
  const hourUTC = new Date(timestamps5.at(-1)).getUTCHours();

  if(isStrict && isTrending) {
    if(e9>e21&&e9p<=e21p){B+=2.5;buyInds++;}
    else if(e9<e21&&e9p>=e21p){S+=2.5;sellInds++;}
    else if(e9>e21){B+=0.5;buyInds++;}
    else{S+=0.5;sellInds++;}
    if(cur>e50){B+=0.5;buyInds++;}else{S+=0.5;sellInds++;}
    if(mac.h>0&&mac.ph<0){B+=2;buyInds++;}
    else if(mac.h<0&&mac.ph>0){S+=2;sellInds++;}
    else if(mac.h>0&&mac.h>mac.ph){B+=1;buyInds++;}
    else if(mac.h<0&&mac.h<mac.ph){S+=1;sellInds++;}
    if(adxData.pdi>adxData.mdi){B+=2;buyInds++;}
    else{S+=2;sellInds++;}
    if(obvData.rising){B+=1;buyInds++;}else{S+=1;sellInds++;}
  } else if(isStrict && !isTrending) {
    if(rsi<25){B+=4;buyInds++;}
    else if(rsi<30){B+=3;buyInds++;}
    else if(rsi<35){B+=2;buyInds++;}
    else if(rsi>75){S+=4;sellInds++;}
    else if(rsi>70){S+=3;sellInds++;}
    else if(rsi>65){S+=2;sellInds++;}

    if(stFull.k<20){B+=3;buyInds++;}
    else if(stFull.k<30){B+=2;buyInds++;}
    else if(stFull.k>80){S+=3;sellInds++;}
    else if(stFull.k>70){S+=2;sellInds++;}

    const bbR = bb.u - bb.l;
    const bbPos = bbR > 0 ? (cur - bb.l)/bbR : 0.5;
    if(bbPos<0.1){B+=3;buyInds++;}
    else if(bbPos<0.2){B+=2;buyInds++;}
    else if(bbPos>0.9){S+=3;sellInds++;}
    else if(bbPos>0.8){S+=2;sellInds++;}

    const mom3 = (cur - (C[C.length-4]||cur)) / Math.max(atr, 0.0001);
    if(mom3<-1){B+=2;buyInds++;}
    else if(mom3<-0.5){B+=1;buyInds++;}
    else if(mom3>1){S+=2;sellInds++;}
    else if(mom3>0.5){S+=1;sellInds++;}

    let bearRun=0, bullRun=0;
    for(let ci=Math.max(0,C.length-4); ci<C.length; ci++) {
      if(C[ci]<(C[ci-1]||C[ci])) bearRun++; else bearRun=0;
      if(C[ci]>(C[ci-1]||C[ci])) bullRun++; else bullRun=0;
    }
    if(bearRun>=4){B+=2;buyInds++;}
    else if(bearRun>=3){B+=1;buyInds++;}
    if(bullRun>=4){S+=2;sellInds++;}
    else if(bullRun>=3){S+=1;sellInds++;}

    const emaDist = (cur-e21)/Math.max(atr,0.0001);
    if(emaDist<-1.5){B+=1.5;buyInds++;}
    else if(emaDist<-0.8){B+=0.8;buyInds++;}
    else if(emaDist>1.5){S+=1.5;sellInds++;}
    else if(emaDist>0.8){S+=0.8;sellInds++;}

    if(mac.h>0&&mac.ph<=0){B+=1.5;buyInds++;}
    else if(mac.h<0&&mac.ph>=0){S+=1.5;sellInds++;}

    if(obvData.rising&&B>S){B+=1;buyInds++;}
    else if(!obvData.rising&&S>B){S+=1;sellInds++;}

    if(vr>1.5){if(B>S)B*=1.1;else S*=1.1;}
  } else if(isScalp) {
    if(rsi<25){B+=4;buyInds++;}
    else if(rsi<30){B+=3;buyInds++;}
    else if(rsi<35){B+=2;buyInds++;}
    else if(rsi<40){B+=1;buyInds++;}
    else if(rsi>75){S+=4;sellInds++;}
    else if(rsi>70){S+=3;sellInds++;}
    else if(rsi>65){S+=2;sellInds++;}
    else if(rsi>60){S+=1;sellInds++;}

    if(stFull.k<20){B+=3;buyInds++;}
    else if(stFull.k<30){B+=1.5;buyInds++;}
    else if(stFull.k>80){S+=3;sellInds++;}
    else if(stFull.k>70){S+=1.5;sellInds++;}

    const bbRange = bb.u - bb.l;
    const bbP = bbRange > 0 ? (cur - bb.l)/bbRange : 0.5;
    if(bbP<0.1){B+=3;buyInds++;}
    else if(bbP<0.2){B+=2;buyInds++;}
    else if(bbP>0.9){S+=3;sellInds++;}
    else if(bbP>0.8){S+=2;sellInds++;}

    const mom3val = (cur - (C[C.length-4]||cur)) / Math.max(atr, 0.0001);
    if(mom3val<-1.0){B+=2;buyInds++;}
    else if(mom3val<-0.5){B+=1;buyInds++;}
    else if(mom3val>1.0){S+=2;sellInds++;}
    else if(mom3val>0.5){S+=1;sellInds++;}

    const last4 = C.slice(-4);
    const scalpBullExh = last4.length>=4 && last4.every((x,i)=>i===0||x>last4[i-1]);
    const scalpBearExh = last4.length>=4 && last4.every((x,i)=>i===0||x<last4[i-1]);
    if(scalpBearExh){B+=2;buyInds++;}
    else if(scalpBullExh){S+=2;sellInds++;}

    const emaDist21 = (cur - e21) / Math.max(atr, 0.0001);
    if(emaDist21<-1.5){B+=1.5;buyInds++;}
    else if(emaDist21>1.5){S+=1.5;sellInds++;}

    if(mac.h>0&&mac.ph<0){S+=1;sellInds++;}
    else if(mac.h<0&&mac.ph>0){B+=1;buyInds++;}
  } else {
    if(rsi<28){B+=3;buyInds++;}
    else if(rsi<35){B+=2;buyInds++;}
    else if(rsi<40){B+=1;buyInds++;}
    else if(rsi>72){S+=3;sellInds++;}
    else if(rsi>65){S+=2;sellInds++;}
    else if(rsi>60){S+=1;sellInds++;}

    const freeStoch = stFull.k || 50;
    if(freeStoch<25){B+=2;buyInds++;}
    else if(freeStoch<35){B+=1;buyInds++;}
    else if(freeStoch>75){S+=2;sellInds++;}
    else if(freeStoch>65){S+=1;sellInds++;}

    const freeBBR = bb.u - bb.l;
    const freeBBPos = freeBBR > 0 ? (cur - bb.l)/freeBBR : 0.5;
    if(freeBBPos<0.15){B+=2;buyInds++;}
    else if(freeBBPos<0.25){B+=1;buyInds++;}
    else if(freeBBPos>0.85){S+=2;sellInds++;}
    else if(freeBBPos>0.75){S+=1;sellInds++;}

    const freeMom3 = (cur - (C[C.length-4]||cur)) / Math.max(atr, 0.0001);
    if(freeMom3<-0.8){B+=1;buyInds++;}
    else if(freeMom3>0.8){S+=1;sellInds++;}

    if(mac.h>0&&mac.ph<0){B+=1;buyInds++;}
    else if(mac.h<0&&mac.ph>0){S+=1;sellInds++;}

    if(obvData.rising){B+=0.5;buyInds++;}
    else{S+=0.5;sellInds++;}

    if(vr > 1.5 && B > S) B *= 1.1;
    else if(vr > 1.5 && S > B) S *= 1.1;
  }

  // ═══ DECISION ═══
  let signal = 'NEUTRAL';
  let conf = 0;

  if(isStrict) {
    if(!isTrending && B > S && B >= 8 && buyInds >= 3) signal='BUY';
    else if(!isTrending && S > B && S >= 8 && sellInds >= 3) signal='SELL';
    if(signal !== 'NEUTRAL' && adxData.adx > 20) signal='NEUTRAL';
    if(signal !== 'NEUTRAL' && !([6,7,9,13,14,15,20,23].includes(hourUTC))) signal='NEUTRAL';
    if(signal !== 'NEUTRAL' && isVolatile) signal='NEUTRAL';
    if(signal !== 'NEUTRAL') {
      const a15 = C15 && C15.length > 15 ? calcATR(H15, L15, C15, 14) : atr;
      if(a15/cur < 0.0008) signal='NEUTRAL';
    }
    if(signal !== 'NEUTRAL') {
      const cs = signal==='BUY'?B:S, cc = signal==='BUY'?buyInds:sellInds;
      conf = Math.min(85, Math.round(50+cs*2.5+cc*1.5));
      if(htfTrend===signal) conf=Math.min(85,conf+5);
      if(mtfConfirm===signal) conf=Math.min(85,conf+3);
    }
  } else if(isScalp) {
    if(B > S && B >= 6 && buyInds >= 3) signal='BUY';
    else if(S > B && S >= 6 && sellInds >= 3) signal='SELL';
    if(signal !== 'NEUTRAL' && adxData.adx > 20) signal='NEUTRAL';
    if(signal === 'BUY' && mtfConfirm === 'SELL') signal='NEUTRAL';
    if(signal === 'SELL' && mtfConfirm === 'BUY') signal='NEUTRAL';
    if(signal !== 'NEUTRAL' && !([6,7,11,12,13,15,20,22,23].includes(hourUTC))) signal='NEUTRAL';
    if(signal !== 'NEUTRAL' && vr < 0.3) signal='NEUTRAL';
    if(signal !== 'NEUTRAL') {
      conf = Math.min(85, Math.max(55, Math.round(50+Math.max(B,S)*3)));
    }
  } else {
    if(B > S && B >= 5 && buyInds >= 2) signal='BUY';
    else if(S > B && S >= 5 && sellInds >= 2) signal='SELL';
    if(signal !== 'NEUTRAL' && isTrending) signal='NEUTRAL';
    if(signal !== 'NEUTRAL' && isVolatile) signal='NEUTRAL';
    if(signal !== 'NEUTRAL' && adxData.adx > 30) signal='NEUTRAL';
    if(signal !== 'NEUTRAL' && !([6,10,18,20,21,23].includes(hourUTC))) signal='NEUTRAL';
    if(signal !== 'NEUTRAL' && vr < 0.4) signal='NEUTRAL';
    if(signal !== 'NEUTRAL') {
      const cs = signal==='BUY'?B:S, cc = signal==='BUY'?buyInds:sellInds;
      conf = Math.min(75, Math.round(40+cs*2+cc*1.5));
    }
  }

  // ═══ TP/SL ═══
  let atr15 = atr;
  if(C15 && C15.length > 15) { const a=calcATR(H15,L15,C15,14); if(a>0)atr15=a; }
  let atr1h = atr;
  if(C1h && C1h.length > 15) { const a=calcATR(H1h,L1h,C1h,14); if(a>0)atr1h=a; }
  const blendedATR = Math.max(atr15, atr1h/4);

  let tpDist, slDist;
  if(isScalp) { tpDist = (atr15||blendedATR)*1.0; slDist = (atr15||blendedATR)*1.0; }
  else if(isStrict) { tpDist = blendedATR*1.5; slDist = blendedATR*1.0; }
  else { tpDist = blendedATR*1.5; slDist = blendedATR*1.0; }

  if(isScalp) {
    const m = cur*0.0015; if(tpDist<m)tpDist=m; if(slDist<m)slDist=m;
  } else {
    const m = cur*0.0012; if(tpDist<m)tpDist=m; if(slDist<m*0.67)slDist=m*0.67;
  }
  if(!isStrict && !isScalp && tpDist < slDist*1.2) tpDist = slDist*1.2;

  const cb = cur * 0.0008;
  let tp, sl;
  if(signal==='BUY') { tp=cur+tpDist+cb; sl=cur-slDist-cb; }
  else if(signal==='SELL') { tp=cur-tpDist-cb; sl=cur+slDist+cb; }

  return { signal, confidence:conf, entry:cur, tp, sl, tpDist, slDist, B, S, buyInds, sellInds, regime:regimeData.regime, hourUTC, adx:adxData.adx, rsi, atr:blendedATR };
}

// ═══ TRADE SIMULATION ═══
function simulateTrade(sig, futureCandles, timeout=50) {
  const entry = sig.entry, tp = sig.tp, sl = sig.sl;
  const isBuy = sig.signal === 'BUY';
  for(let i=0; i<Math.min(futureCandles.length, timeout); i++) {
    const c = futureCandles[i];
    if(isBuy) {
      if(c.l <= sl) return {result:'SL', exitPrice:sl, bars:i+1, exitTime:c.t};
      if(c.h >= tp) return {result:'TP', exitPrice:tp, bars:i+1, exitTime:c.t};
    } else {
      if(c.h >= sl) return {result:'SL', exitPrice:sl, bars:i+1, exitTime:c.t};
      if(c.l <= tp) return {result:'TP', exitPrice:tp, bars:i+1, exitTime:c.t};
    }
  }
  const li = Math.min(futureCandles.length-1, timeout-1);
  if(li < 0) return null;
  return {result:'TIMEOUT', exitPrice:futureCandles[li].c, bars:li+1, exitTime:futureCandles[li].t};
}

// ═══ MAIN BACKTEST ═══
async function runBacktest(mode, symbols, timeoutBars) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  BACKTESTING: ${mode.toUpperCase()} | ${symbols.length} pairs | 14 days`);
  console.log(`${'═'.repeat(70)}`);

  const cooldown = mode==='strict' ? 24 : mode==='scalp' ? 12 : 8;
  const allData = {};

  for(const sym of symbols) {
    process.stdout.write(`  ${sym}...`);
    try {
      const [kl5, kl15, kl1h] = await Promise.all([
        fetchAllKlines(sym, '5m', 4032),
        fetchAllKlines(sym, '15m', 1344),
        fetchAllKlines(sym, '1h', 336)
      ]);
      if(!kl5 || kl5.length < 300) { console.log(` skip`); continue; }
      allData[sym] = {
        kl5: kl5.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})),
        kl15: kl15.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})),
        kl1h: kl1h.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}))
      };
      console.log(` ${kl5.length}c`);
    } catch(e) { console.log(` ERR: ${e.message}`); }
    await new Promise(r=>setTimeout(r,200));
  }

  const resultsByTimeout = {};
  for(const timeout of timeoutBars) {
    const allTrades = [];
    const sigCounts = {total:0, buy:0, sell:0};
    const symStats = {}, hourStats = {}, regimeStats = {}, dayStats = {};
    const dayOfWeekStats = {};

    for(const sym of Object.keys(allData)) {
      const {kl5, kl15, kl1h} = allData[sym];
      let lastSigBar = -cooldown;
      if(!symStats[sym]) symStats[sym] = {trades:0,wins:0,pnl:0,losses:0};

      for(let i=280; i<kl5.length - timeout - 1; i++) {
        if(i - lastSigBar < cooldown) continue;

        const w = kl5.slice(Math.max(0,i-279), i+1);
        const C5=w.map(k=>k.c), H5=w.map(k=>k.h), L5=w.map(k=>k.l), V5=w.map(k=>k.v), T5=w.map(k=>k.t);
        const ct = kl5[i].t;
        const c15 = kl15.filter(k=>k.t<=ct).slice(-100);
        const c1h = kl1h.filter(k=>k.t<=ct).slice(-50);

        const sig = genSigBacktest(C5,H5,L5,V5, c15.map(k=>k.c),c15.map(k=>k.h),c15.map(k=>k.l), c1h.map(k=>k.c),c1h.map(k=>k.h),c1h.map(k=>k.l), T5, mode, sym);
        if(!sig) continue;
        sigCounts.total++;
        if(sig.signal==='NEUTRAL') continue;
        sigCounts[sig.signal.toLowerCase()]++;

        const fc = kl5.slice(i+1, i+1+timeout).map(k=>({h:k.h,l:k.l,c:k.c,t:k.t}));
        const res = simulateTrade(sig, fc, timeout);
        if(!res) continue;

        let pnlPct = sig.signal==='BUY' ? (res.exitPrice-sig.entry)/sig.entry*100 : (sig.entry-res.exitPrice)/sig.entry*100;
        pnlPct -= 0.08;

        const trade = {sym, signal:sig.signal, entry:sig.entry, exit:res.exitPrice, result:res.result, pnlPct, bars:res.bars, duration:res.bars*5, conf:sig.confidence, regime:sig.regime, hour:sig.hourUTC, adx:sig.adx, rsi:sig.rsi, entryTime:new Date(kl5[i].t).toISOString(), B:sig.B, S:sig.S};
        allTrades.push(trade);
        lastSigBar = i;

        symStats[sym].trades++; symStats[sym].pnl+=pnlPct;
        if(res.result==='TP'){symStats[sym].wins++;} else{symStats[sym].losses++;}

        if(!hourStats[sig.hourUTC]) hourStats[sig.hourUTC]={trades:0,wins:0,pnl:0};
        hourStats[sig.hourUTC].trades++; hourStats[sig.hourUTC].pnl+=pnlPct;
        if(res.result==='TP') hourStats[sig.hourUTC].wins++;

        if(!regimeStats[sig.regime]) regimeStats[sig.regime]={trades:0,wins:0,pnl:0};
        regimeStats[sig.regime].trades++; regimeStats[sig.regime].pnl+=pnlPct;
        if(res.result==='TP') regimeStats[sig.regime].wins++;

        const dk = new Date(kl5[i].t).toISOString().slice(0,10);
        if(!dayStats[dk]) dayStats[dk]={trades:0,wins:0,pnl:0};
        dayStats[dk].trades++; dayStats[dk].pnl+=pnlPct;
        if(res.result==='TP') dayStats[dk].wins++;

        const dow = new Date(kl5[i].t).getUTCDay();
        if(!dayOfWeekStats[dow]) dayOfWeekStats[dow]={trades:0,wins:0,pnl:0};
        dayOfWeekStats[dow].trades++; dayOfWeekStats[dow].pnl+=pnlPct;
        if(res.result==='TP') dayOfWeekStats[dow].wins++;
      }
    }

    const n = allTrades.length;
    if(n===0){console.log(`  ${timeout}b: NO TRADES`); resultsByTimeout[timeout]={totalTrades:0}; continue;}

    const wins=allTrades.filter(t=>t.result==='TP').length;
    const losses=allTrades.filter(t=>t.result==='SL').length;
    const timeouts=allTrades.filter(t=>t.result==='TIMEOUT').length;
    const wr=wins/n*100;
    const totalPnl=allTrades.reduce((s,t)=>s+t.pnlPct,0);
    const gp=allTrades.filter(t=>t.pnlPct>0).reduce((s,t)=>s+t.pnlPct,0);
    const gl=Math.abs(allTrades.filter(t=>t.pnlPct<0).reduce((s,t)=>s+t.pnlPct,0));
    const pf=gl>0?gp/gl:99;
    const avgDur=allTrades.reduce((s,t)=>s+t.duration,0)/n;

    let eq=10000,peak=10000,maxDD=0;
    for(const t of allTrades){eq+=500*5*(t.pnlPct/100);if(eq>peak)peak=eq;const dd=(peak-eq)/peak*100;if(dd>maxDD)maxDD=dd;}

    const best=allTrades.reduce((b,t)=>t.pnlPct>b.pnlPct?t:b,allTrades[0]);
    const worst=allTrades.reduce((b,t)=>t.pnlPct<b.pnlPct?t:b,allTrades[0]);

    let mcw=0,mcl=0,cw=0,cl=0;
    for(const t of allTrades){if(t.result==='TP'){cw++;cl=0;if(cw>mcw)mcw=cw;}else{cl++;cw=0;if(cl>mcl)mcl=cl;}}

    const avgW=wins>0?allTrades.filter(t=>t.pnlPct>0).reduce((s,t)=>s+t.pnlPct,0)/wins:0;
    const lossCount=n-wins;
    const avgL=lossCount>0?Math.abs(allTrades.filter(t=>t.pnlPct<0).reduce((s,t)=>s+t.pnlPct,0))/lossCount:0;
    const expect=(wr/100)*avgW-(1-wr/100)*avgL;

    const dailyPnls=Object.values(dayStats).map(d=>d.pnl);
    const avgD=dailyPnls.reduce((s,v)=>s+v,0)/dailyPnls.length;
    const stdD=Math.sqrt(dailyPnls.reduce((s,v)=>s+Math.pow(v-avgD,2),0)/dailyPnls.length);
    const sharpe=stdD>0?(avgD/stdD)*Math.sqrt(365):0;

    console.log(`\n  ┌─── ${mode.toUpperCase()} | Timeout=${timeout}b (${(timeout*5/60).toFixed(1)}h) ───┐`);
    console.log(`  │ Trades: ${n} (${wins}W/${losses}L/${timeouts}T) | B:${sigCounts.buy} S:${sigCounts.sell}`);
    console.log(`  │ WR: ${wr.toFixed(1)}% | PnL: ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)}% | Equity: $${eq.toFixed(0)}`);
    console.log(`  │ PF: ${pf.toFixed(3)} | MaxDD: ${maxDD.toFixed(2)}% | AvgDur: ${avgDur.toFixed(0)}min`);
    console.log(`  │ AvgWin: +${avgW.toFixed(3)}% | AvgLoss: -${avgL.toFixed(3)}%`);
    console.log(`  │ Expect: ${expect>=0?'+':''}${expect.toFixed(4)}%/trade | Sharpe: ${sharpe.toFixed(2)}`);
    console.log(`  │ ConsWins: ${mcw} | ConsLoss: ${mcl} | Trades/Day: ${(n/14).toFixed(1)}`);
    console.log(`  │ Best: ${best.sym} ${best.signal} +${best.pnlPct.toFixed(3)}%`);
    console.log(`  │ Worst: ${worst.sym} ${worst.signal} ${worst.pnlPct.toFixed(3)}%`);
    console.log(`  └${'─'.repeat(50)}`);

    console.log(`\n  BY SYMBOL:`);
    console.log(`  ${'Sym'.padEnd(12)} ${'#'.padStart(5)} ${'WR%'.padStart(6)} ${'PnL%'.padStart(8)}`);
    Object.entries(symStats).filter(([,v])=>v.trades>0).sort((a,b)=>b[1].pnl-a[1].pnl)
      .forEach(([s,d])=>console.log(`  ${s.padEnd(12)} ${String(d.trades).padStart(5)} ${(d.wins/d.trades*100).toFixed(1).padStart(6)} ${(d.pnl>=0?'+':'')+d.pnl.toFixed(2).padStart(7)}`));

    console.log(`\n  BY HOUR (UTC):`);
    console.log(`  ${'H'.padEnd(4)} ${'#'.padStart(5)} ${'WR%'.padStart(6)} ${'PnL%'.padStart(8)}`);
    for(let h=0;h<24;h++){const d=hourStats[h];if(!d)continue;console.log(`  ${String(h).padEnd(4)} ${String(d.trades).padStart(5)} ${(d.wins/d.trades*100).toFixed(1).padStart(6)} ${(d.pnl>=0?'+':'')+d.pnl.toFixed(2).padStart(7)}`);}

    console.log(`\n  BY REGIME:`);
    Object.entries(regimeStats).forEach(([r,d])=>console.log(`  ${r.padEnd(12)} ${String(d.trades).padStart(5)} WR:${(d.wins/d.trades*100).toFixed(1)}% PnL:${(d.pnl>=0?'+':'')+d.pnl.toFixed(2)}%`));

    console.log(`\n  BY DAY OF WEEK:`);
    const dows = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    for(let d=0;d<7;d++){const s=dayOfWeekStats[d];if(!s)continue;console.log(`  ${dows[d].padEnd(5)} ${String(s.trades).padStart(5)} WR:${(s.wins/s.trades*100).toFixed(1)}% PnL:${(s.pnl>=0?'+':'')+s.pnl.toFixed(2)}%`);}

    console.log(`\n  EQUITY CURVE:`);
    let rp=0;
    Object.entries(dayStats).sort().forEach(([day,d])=>{rp+=d.pnl;const bar=d.pnl>=0?'█'.repeat(Math.min(40,Math.round(d.pnl*3))):'░'.repeat(Math.min(40,Math.round(-d.pnl*3)));console.log(`  ${day} ${String(d.trades).padStart(3)}t WR${(d.wins/d.trades*100).toFixed(0).padStart(3)}% ${(d.pnl>=0?'+':'')+d.pnl.toFixed(2).padStart(7)}% cum:${(rp>=0?'+':'')+rp.toFixed(2).padStart(7)}% ${bar}`);});

    resultsByTimeout[timeout] = {totalTrades:n,wins,losses,timeouts,wr,totalPnlPct:totalPnl,pf,maxDD,avgDuration:avgDur,avgWin:avgW,avgLoss:avgL,expectancy:expect,sharpe,equity:eq,maxConsWins:mcw,maxConsLosses:mcl,symStats,hourStats,regimeStats,dayOfWeekStats};
  }
  return resultsByTimeout;
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  RXTRADING — COMPLETE BACKTEST AUDIT                       ║');
  console.log('║  14 days | Real Binance data | $10K capital | 5x leverage  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const all = {};
  for(const [mode, syms] of [['strict',VIP_SCAN_SYMS],['scalp',SCALP_SCAN_SYMS],['frequent',PUB_SCAN_SYMS]]) {
    try { all[mode] = await runBacktest(mode, syms, [30,50,80]); }
    catch(e) { console.error(`${mode} ERROR: ${e.stack}`); }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  COMPARATIVE SUMMARY (Timeout=50)');
  console.log('═'.repeat(70));
  console.log(`  ${'Mode'.padEnd(12)} ${'Trades'.padStart(7)} ${'WR%'.padStart(7)} ${'PnL%'.padStart(9)} ${'PF'.padStart(7)} ${'MaxDD%'.padStart(8)} ${'Sharpe'.padStart(8)} ${'Expect'.padStart(8)}`);
  for(const m of ['strict','scalp','frequent']){
    const r=all[m]?.[50];
    if(!r||r.totalTrades===0){console.log(`  ${m.padEnd(12)} NO DATA`);continue;}
    console.log(`  ${m.padEnd(12)} ${String(r.totalTrades).padStart(7)} ${r.wr.toFixed(1).padStart(7)} ${(r.totalPnlPct>=0?'+':'')+r.totalPnlPct.toFixed(2).padStart(8)} ${r.pf.toFixed(2).padStart(7)} ${r.maxDD.toFixed(2).padStart(8)} ${r.sharpe.toFixed(2).padStart(8)} ${r.expectancy.toFixed(4).padStart(8)}`);
  }

  console.log(`\n  TIMEOUT SENSITIVITY:`);
  for(const m of ['strict','scalp','frequent']){
    console.log(`  ${m.toUpperCase()}:`);
    for(const t of [30,50,80]){const r=all[m]?.[t];if(!r||r.totalTrades===0)continue;console.log(`    ${t}b: ${r.totalTrades}t WR:${r.wr.toFixed(1)}% PnL:${(r.totalPnlPct>=0?'+':'')+r.totalPnlPct.toFixed(2)}% PF:${r.pf.toFixed(2)} DD:${r.maxDD.toFixed(2)}%`);}
  }
  console.log('\nDone!');
}

main().catch(console.error);
