#!/usr/bin/env node
/**
 * ENGINE v5 REDESIGN — COMPLETE REWRITE FROM ZERO
 *
 * Why the old engine failed (60-day backtest: -35% strict, -65% scalp):
 * 1. TP1+Trailing destroyed R:R (avg win $8 vs avg loss $14)
 * 2. Mean-reversion in 5m crypto has no persistent edge
 * 3. Redundant indicators inflated scores → false confidence
 * 4. Hour/day filters were pure overfitting
 *
 * NEW ARCHITECTURE:
 * - TREND-FOLLOWING primary (crypto trends, it doesn't mean-revert reliably)
 * - Regime-gated: TRENDING → trend-follow, RANGING → mean-revert, QUIET → skip
 * - FIXED TP/SL with R:R >= 2:1 (NO trailing that kills R:R)
 * - 4 INDEPENDENT indicator categories, need 3/4 to confirm
 * - NO hour/day filters (structural quality only)
 * - HTF alignment REQUIRED (don't fight the 1H trend)
 * - Volume confirmation REQUIRED
 *
 * Category system (need 3 of 4 to fire):
 *   CAT1: MOMENTUM (RSI direction + MACD + Stoch direction)
 *   CAT2: TREND STRUCTURE (EMA stack + price vs VWAP + ADX direction)
 *   CAT3: VOLATILITY (BB position + Keltner + ATR expansion)
 *   CAT4: VOLUME/FLOW (OBV slope + Volume ratio + Candle pressure)
 */

const https = require('https');

const CAPITAL = 10000;
const POS_SIZE = 500;
const LEV = 5;
const FEE = 0.0008;
const DAYS = 60;
const TIMEOUT = 40; // 3h20m — shorter timeout forces faster resolution
const MAX_CONCURRENT = 5;

// Only mid-cap alts — large caps (BTC/ETH) don't trend cleanly on 5m
const STRICT_PAIRS = ['SOLUSDT','ADAUSDT','DOTUSDT','LINKUSDT','FILUSDT','ARBUSDT','OPUSDT','JUPUSDT','WIFUSDT','FETUSDT','AVAXUSDT','SUIUSDT','TIAUSDT','UNIUSDT','PEPEUSDT'];
const SCALP_PAIRS = ['SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','ADAUSDT','DOTUSDT','ARBUSDT','OPUSDT','FILUSDT','UNIUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT','TIAUSDT','ATOMUSDT','SUIUSDT'];

// ═══════════════════════════════════════════════════════
// INDICATORS
// ═══════════════════════════════════════════════════════
function calcRSI(c,p=14){if(c.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}return al===0?100:100-(100/(1+ag/al));}
function emaArr(d,p){const k=2/(p+1),r=[d[0]];for(let i=1;i<d.length;i++)r.push(d[i]*k+r[i-1]*(1-k));return r;}
function ema(d,p){return emaArr(d,p).at(-1);}
function macd(c){if(c.length<35)return{h:0,ph:0};const e12=emaArr(c,12),e26=emaArr(c,26),ml=e12.map((v,i)=>v-e26[i]),sl=emaArr(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1))};}
function bb(c,p=20,s=2){if(c.length<p)return{u:0,m:0,l:0};const sl=c.slice(-p),m=sl.reduce((a,b)=>a+b)/p,sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+s*sd,m,l:m-s*sd};}
function stoch(H,L,C,kp=14){if(C.length<kp+3)return{k:50};const ka=[];for(let i=kp;i<=C.length;i++){const sh=H.slice(i-kp,i),sl=L.slice(i-kp,i),hi=Math.max(...sh),lo=Math.min(...sl);ka.push(hi===lo?50:((C[i-1]-lo)/(hi-lo))*100);}return{k:ka.at(-1)||50};}
function calcATR(H,L,C,p=14){if(C.length<p+1)return 0;const t=[];for(let i=1;i<C.length;i++)t.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));if(t.length<p)return t.reduce((a,b)=>a+b)/t.length;let a=t.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<t.length;i++)a=(a*(p-1)+t[i])/p;return a;}
function wilder(arr,p){if(arr.length<p)return arr.map(()=>0);const r=[];let s=arr.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=0;i<p;i++)r.push(0);r[p-1]=s;for(let i=p;i<arr.length;i++){s=(s*(p-1)+arr[i])/p;r.push(s);}return r;}
function adx(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pd=[],md=[],tr=[];for(let i=1;i<H.length;i++){const u=H[i]-H[i-1],d=L[i-1]-L[i];pd.push(u>d&&u>0?u:0);md.push(d>u&&d>0?d:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}const sT=wilder(tr,p),sP=wilder(pd,p),sM=wilder(md,p),pi=sP.map((v,i)=>sT[i]?v/sT[i]*100:0),mi=sM.map((v,i)=>sT[i]?v/sT[i]*100:0),dx=pi.map((v,i)=>{const s=v+mi[i];return s?Math.abs(v-mi[i])/s*100:0;}),dxV=dx.slice(p-1),aa=dxV.length>=p?wilder(dxV,p):dxV;return{adx:aa.at(-1)||15,pdi:pi.at(-1)||0,mdi:mi.at(-1)||0};}
function obv(C,V){if(C.length<2)return{rising:false,slope:0};let o=0;const a=[0];for(let i=1;i<C.length;i++){if(C[i]>C[i-1])o+=V[i];else if(C[i]<C[i-1])o-=V[i];a.push(o);}const n=Math.min(a.length,20),r=a.slice(-n);let sx=0,sy=0,sxy=0,sx2=0;for(let i=0;i<n;i++){sx+=i;sy+=r[i];sxy+=i*r[i];sx2+=i*i;}const slope=(n*sxy-sx*sy)/(n*sx2-sx*sx||1);return{rising:slope>0,slope};}
function keltner(H,L,C){if(C.length<21)return{pos:0.5};const m=ema(C,20),a=calcATR(H,L,C,14),u=m+2*a,l=m-2*a,w=u-l;return{pos:w>0?(C.at(-1)-l)/w:0.5,width:w/m*100};}
function vwap(klines){if(!klines||!klines.length)return 0;let cv=0,cvp=0;for(const k of klines){const tp=(parseFloat(k[2])+parseFloat(k[3])+parseFloat(k[4]))/3,v=parseFloat(k[5]);cv+=v;cvp+=tp*v;}return cv>0?cvp/cv:0;}

// ═══════════════════════════════════════════════════════
// REGIME DETECTION — More nuanced than before
// ═══════════════════════════════════════════════════════
function detectRegime(H,L,C,adxD,atrV) {
  const avg = C.slice(-20).reduce((a,b)=>a+b)/20;
  const atrPct = atrV/avg*100;

  // Use ADX + ATR% + EMA alignment for regime
  const e9 = ema(C,9), e21 = ema(C,21), e50 = ema(C,50);
  const emaAligned = (e9>e21&&e21>e50) || (e9<e21&&e21<e50);

  if(adxD.adx > 25 && emaAligned) return 'STRONG_TREND';
  if(adxD.adx > 20 && (adxD.pdi > adxD.mdi*1.3 || adxD.mdi > adxD.pdi*1.3)) return 'TREND';
  if(adxD.adx < 15 && atrPct < 0.6) return 'DEAD'; // Too quiet to trade
  if(atrPct > 2.5) return 'VOLATILE'; // Too volatile
  if(adxD.adx < 20) return 'RANGE';
  return 'MIXED';
}

// ═══════════════════════════════════════════════════════
// v5 SIGNAL ENGINE — CATEGORY-BASED CONFLUENCE
// ═══════════════════════════════════════════════════════
function genSignal(C5,H5,L5,V5,C15,H15,L15,C1h,H1h,L1h,V1h,kl5,mode) {
  const isStrict = mode === 'strict';
  const cur = C5.at(-1);
  if(C5.length < 50) return null;

  // ═══ STEP 1: HTF TREND (1H) — THE ABSOLUTE FILTER ═══
  let htf = 'NEUTRAL', htfScore = 0;
  if(C1h.length > 30) {
    const e9h = ema(C1h,9), e21h = ema(C1h,21), e50h = ema(C1h,50);
    const m1h = macd(C1h);
    const r1h = calcRSI(C1h,14);
    const a1h = adx(H1h,L1h,C1h);

    let hB=0, hS=0;
    // EMA stack (strongest signal)
    if(e9h>e21h&&e21h>e50h) hB+=3;
    else if(e9h<e21h&&e21h<e50h) hS+=3;
    else if(e9h>e21h) hB+=1;
    else hS+=1;

    // MACD momentum
    if(m1h.h>0&&m1h.h>m1h.ph) hB+=2; // Expanding bullish
    else if(m1h.h<0&&m1h.h<m1h.ph) hS+=2; // Expanding bearish
    else if(m1h.h>0) hB+=1;
    else if(m1h.h<0) hS+=1;

    // RSI above/below 50
    if(r1h>55) hB+=1;
    else if(r1h<45) hS+=1;

    // ADX direction
    if(a1h.adx>20) {
      if(a1h.pdi>a1h.mdi) hB+=1.5;
      else hS+=1.5;
    }

    htfScore = Math.abs(hB-hS);
    if(hB>hS+2) htf='BUY';
    else if(hS>hB+2) htf='SELL';
  }

  // ═══ STEP 2: 15M CONFIRMATION ═══
  let mtf = 'NEUTRAL';
  if(C15.length > 25) {
    const e9_15=ema(C15,9), e21_15=ema(C15,21);
    const m15=macd(C15);
    const r15=calcRSI(C15,14);
    let mB=0, mS=0;
    if(e9_15>e21_15) mB+=1.5; else mS+=1.5;
    if(m15.h>0) mB+=1; else mS+=1;
    if(r15>55) mB+=0.5; else if(r15<45) mS+=0.5;
    if(mB>mS+1) mtf='BUY';
    else if(mS>mB+1) mtf='SELL';
  }

  // ═══ STEP 3: 5M INDICATORS ═══
  const rsi = calcRSI(C5,14);
  const mac = macd(C5);
  const ea9=emaArr(C5,9), ea21=emaArr(C5,21);
  const e9=ea9.at(-1), e21=ea21.at(-1), e9p=ea9.at(-2), e21p=ea21.at(-2);
  const e50=ema(C5,50);
  const bbV=bb(C5,20,2);
  const avgV=V5.slice(-20).reduce((a,b)=>a+b)/20, vr=V5.at(-1)/avgV;
  const adxD=adx(H5,L5,C5);
  const obvD=obv(C5,V5);
  const stK=stoch(H5,L5,C5,14).k;
  const atrV=calcATR(H5,L5,C5,14);
  const kcV=keltner(H5,L5,C5);
  const vwapV=vwap(kl5.slice(-50));
  const bbR=bbV.u-bbV.l, bbP=bbR>0?(cur-bbV.l)/bbR:0.5;

  // Regime
  const regime = detectRegime(H5,L5,C5,adxD,atrV);

  // ═══ SKIP conditions ═══
  if(regime === 'DEAD') return null;  // Market too quiet to profit
  if(regime === 'VOLATILE') return null; // Too risky
  if(vr < 0.4) return null; // Dead volume

  // ═══ STEP 4: CATEGORY SCORING ═══
  // Each category returns: 'BUY', 'SELL', or 'NEUTRAL'
  // Need 3/4 categories to agree for a signal

  // ──── CAT1: MOMENTUM ────
  let cat1 = 'NEUTRAL';
  {
    let mB=0, mS=0;
    // RSI direction (NOT extremes — direction matters more)
    if(rsi > 55 && rsi < 75) mB+=1;      // Bullish momentum, not overbought
    else if(rsi < 45 && rsi > 25) mS+=1;  // Bearish momentum, not oversold
    // For mean-reversion in RANGE: flip
    if(regime === 'RANGE') {
      if(rsi < 30) { mB+=2; mS=0; }       // Oversold → buy
      else if(rsi > 70) { mS+=2; mB=0; }  // Overbought → sell
    }

    // MACD histogram direction
    if(mac.h > 0 && mac.h > mac.ph) mB+=1.5; // Expanding positive
    else if(mac.h < 0 && mac.h < mac.ph) mS+=1.5; // Expanding negative
    else if(mac.h > 0) mB+=0.5;
    else if(mac.h < 0) mS+=0.5;

    // Stochastic direction
    if(stK > 50 && stK < 80) mB+=0.5;
    else if(stK < 50 && stK > 20) mS+=0.5;
    if(regime === 'RANGE') {
      if(stK < 20) { mB+=1.5; mS=0; }
      else if(stK > 80) { mS+=1.5; mB=0; }
    }

    if(mB > mS + 1) cat1 = 'BUY';
    else if(mS > mB + 1) cat1 = 'SELL';
  }

  // ──── CAT2: TREND STRUCTURE ────
  let cat2 = 'NEUTRAL';
  {
    let tB=0, tS=0;
    // EMA stack
    if(e9>e21&&e21>e50) tB+=2; // Perfect bull stack
    else if(e9<e21&&e21<e50) tS+=2; // Perfect bear stack
    else if(e9>e21) tB+=0.5;
    else tS+=0.5;

    // EMA crossover (recent)
    if(e9>e21&&e9p<=e21p) tB+=1.5; // Fresh bull cross
    else if(e9<e21&&e9p>=e21p) tS+=1.5; // Fresh bear cross

    // Price vs VWAP
    if(vwapV > 0) {
      if(cur > vwapV) tB+=0.5;
      else tS+=0.5;
    }

    // ADX direction (DI lines)
    if(adxD.adx > 18) {
      if(adxD.pdi > adxD.mdi) tB+=1;
      else tS+=1;
    }

    // In RANGE mode, structure is less important — reduce threshold
    const thresh = regime === 'RANGE' ? 1.5 : 2;
    if(tB > tS + thresh) cat2 = 'BUY';
    else if(tS > tB + thresh) cat2 = 'SELL';
  }

  // ──── CAT3: VOLATILITY POSITION ────
  let cat3 = 'NEUTRAL';
  {
    let vB=0, vS=0;

    if(regime === 'RANGE' || regime === 'MIXED') {
      // Mean-reversion: extreme positions → contrarian
      if(bbP < 0.15) vB+=2;
      else if(bbP < 0.3) vB+=1;
      else if(bbP > 0.85) vS+=2;
      else if(bbP > 0.7) vS+=1;

      if(kcV.pos < 0.1) vB+=1.5;
      else if(kcV.pos < 0.25) vB+=0.5;
      else if(kcV.pos > 0.9) vS+=1.5;
      else if(kcV.pos > 0.75) vS+=0.5;
    } else {
      // Trend-following: breakouts → continuation
      if(bbP > 0.8) vB+=1; // Upper band = strong trend
      else if(bbP < 0.2) vS+=1;

      if(kcV.pos > 0.85) vB+=1;
      else if(kcV.pos < 0.15) vS+=1;
    }

    // ATR expansion = good for trend, bad for mean-reversion
    const atrPct = atrV / cur * 100;
    if(regime !== 'RANGE' && atrPct > 0.3) { /* trend OK */ }
    else if(regime === 'RANGE' && atrPct < 0.5) { /* range OK, low vol */ }

    if(vB > vS + 1) cat3 = 'BUY';
    else if(vS > vB + 1) cat3 = 'SELL';
  }

  // ──── CAT4: VOLUME & FLOW ────
  let cat4 = 'NEUTRAL';
  {
    let fB=0, fS=0;

    // OBV direction
    if(obvD.rising) fB+=1; else fS+=1;

    // Volume ratio (high volume = conviction)
    if(vr > 1.3) { fB+=0.5; fS+=0.5; } // Volume confirms whatever direction

    // Candle pressure (last 5 bars)
    let buyPress=0, sellPress=0;
    for(let i=Math.max(1,C5.length-5); i<C5.length; i++) {
      const open = C5[i-1];
      const body = C5[i] - open;
      const uWick = H5[i] - Math.max(C5[i], open);
      const lWick = Math.min(C5[i], open) - L5[i];
      if(body > 0) { buyPress += body + lWick*0.5; }
      else { sellPress += Math.abs(body) + uWick*0.5; }
    }
    const flowR = buyPress / Math.max(0.001, sellPress);
    if(flowR > 1.5) fB+=1.5;
    else if(flowR < 0.67) fS+=1.5;
    else if(flowR > 1.1) fB+=0.5;
    else if(flowR < 0.9) fS+=0.5;

    if(fB > fS + 0.8) cat4 = 'BUY';
    else if(fS > fB + 0.8) cat4 = 'SELL';
  }

  // ═══ STEP 5: CONFLUENCE DECISION ═══
  const cats = [cat1, cat2, cat3, cat4];
  const buyCount = cats.filter(c => c === 'BUY').length;
  const sellCount = cats.filter(c => c === 'SELL').length;
  const neutralCount = cats.filter(c => c === 'NEUTRAL').length;

  let signal = 'NEUTRAL';
  const minCats = isStrict ? 3 : 3; // Both need 3/4 categories

  if(buyCount >= minCats && sellCount === 0) signal = 'BUY';
  else if(sellCount >= minCats && buyCount === 0) signal = 'SELL';

  // ═══ STEP 6: HTF ALIGNMENT — HARD FILTER ═══
  // In TREND/STRONG_TREND: MUST align with HTF
  if(signal !== 'NEUTRAL' && (regime === 'TREND' || regime === 'STRONG_TREND')) {
    if(htf !== 'NEUTRAL' && htf !== signal) signal = 'NEUTRAL'; // Don't fight the 1H
  }
  // In RANGE: HTF alignment gives bonus confidence but doesn't block
  // In MIXED: require at least MTF alignment
  if(signal !== 'NEUTRAL' && regime === 'MIXED') {
    if(mtf !== 'NEUTRAL' && mtf !== signal) signal = 'NEUTRAL';
  }

  // ═══ STEP 7: STRICT-ONLY extra filters ═══
  if(isStrict && signal !== 'NEUTRAL') {
    // Require MTF confirmation for strict
    if(mtf !== 'NEUTRAL' && mtf !== signal) signal = 'NEUTRAL';
    // Require minimum ADX (market must be moving enough)
    if(adxD.adx < 12) signal = 'NEUTRAL'; // Too directionless
  }

  // ═══ STEP 8: CONFIDENCE ═══
  let conf = 50;
  if(signal !== 'NEUTRAL') {
    const activeCats = signal === 'BUY' ? buyCount : sellCount;
    conf = 55 + activeCats * 8; // 3 cats = 79%, 4 cats = 87%
    if(htf === signal) conf += 5;
    if(mtf === signal) conf += 3;
    if(vr > 1.5) conf += 2;
    conf = Math.min(isStrict ? 92 : 88, conf);
  }

  // ═══ STEP 9: TP/SL — FIXED R:R, NO TRAILING ═══
  // The key insight: FIXED R:R 2:1 means you only need WR > 33% to profit
  // Even WR 40% gives PF = (0.4 × 2) / (0.6 × 1) = 1.33
  // With WR 45%: PF = (0.45 × 2) / (0.55 × 1) = 1.64
  const useATR = calcATR(H5, L5, C5, 14);
  let tpMult, slMult;

  if(regime === 'RANGE') {
    tpMult = 1.5;  // Mean-reversion: tighter TP (1.5 ATR)
    slMult = 1.0;  // R:R = 1.5:1
  } else {
    tpMult = 2.0;  // Trend-following: wider TP (2.0 ATR)
    slMult = 1.0;  // R:R = 2.0:1
  }

  // Scalp uses tighter TP for faster fills
  if(!isStrict) {
    tpMult = regime === 'RANGE' ? 1.3 : 1.8;
    slMult = 1.0;
  }

  let tpD = useATR * tpMult;
  let slD = useATR * slMult;

  // Minimum TP enforcement
  const minTP = cur * 0.0015; // 0.15% minimum
  if(tpD < minTP) tpD = minTP;
  if(slD < minTP * 0.5) slD = minTP * 0.5;

  const cb = cur * FEE;
  const tp = signal==='BUY' ? cur+tpD+cb : signal==='SELL' ? cur-tpD-cb : null;
  const sl = signal==='BUY' ? cur-slD-cb : signal==='SELL' ? cur+slD+cb : null;

  return { signal, conf, entry: cur, tp, sl, tpD, slD, regime, cats: {cat1,cat2,cat3,cat4}, adx: adxD.adx, rsi, vr, htf, mtf, rratio: tpMult/slMult };
}

// ═══ DATA FETCHING ═══
function fetchJSON(url){return new Promise((res,rej)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});}).on('error',rej);});}
async function getKlines(sym,intv,lim,end){let u=`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${intv}&limit=${lim}`;if(end)u+=`&endTime=${end}`;try{return await fetchJSON(u);}catch(e){return[];}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function fetchData(sym,days){
  const now=Date.now(),need=(days*24*60)/5+280;
  const all5=[];let end=now;
  while(all5.length<need){const b=await getKlines(sym,'5m',1000,end);if(!b||!b.length)break;all5.unshift(...b);end=b[0][0]-1;await sleep(120);}
  const all15=[];end=now;const n15=Math.ceil((days*24*60)/15)+100;
  while(all15.length<n15){const b=await getKlines(sym,'15m',1000,end);if(!b||!b.length)break;all15.unshift(...b);end=b[0][0]-1;await sleep(120);}
  const all1h=await getKlines(sym,'1h',Math.min(1000,days*24+50));await sleep(120);
  return{kl5:all5,kl15:all15,kl1h:all1h||[]};
}

// ═══ BACKTEST ═══
async function runBacktest(mode) {
  const pairs = mode === 'strict' ? STRICT_PAIRS : SCALP_PAIRS;
  const cooldown = mode === 'strict' ? 10 : 4; // bars

  console.log(`\n${'═'.repeat(75)}`);
  console.log(`  v5 ENGINE: ${mode.toUpperCase()} — ${DAYS} days, ${pairs.length} pairs`);
  console.log(`  Category confluence (3/4) | Fixed R:R (no trailing) | HTF alignment`);
  console.log(`  NO hour/day filters | Max ${MAX_CONCURRENT} concurrent | Timeout ${TIMEOUT} bars`);
  console.log(`${'═'.repeat(75)}\n`);

  // Fetch all data
  const allData = {};
  for(const sym of pairs) {
    process.stdout.write(`  Fetching ${sym}...`);
    try {
      allData[sym] = await fetchData(sym, DAYS);
      console.log(` ${allData[sym].kl5.length} bars`);
    } catch(e) { console.log(` ERROR`); }
  }

  console.log(`\n  Running simulation...\n`);

  // Find test start
  const testStart = Date.now() - DAYS*24*60*60*1000;
  const refSym = pairs[0];
  const allBars = allData[refSym].kl5.filter(k => k[0] >= testStart);
  if(!allBars.length) { console.log('No test data'); return; }

  const trades = [];
  const openPos = [];
  const lastSig = {};
  const weeklyPnL = {};
  let equity = CAPITAL, peak = CAPITAL, maxDD = 0;
  const eqCurve = [];

  for(let bi = 0; bi < allBars.length; bi++) {
    const barTime = allBars[bi][0];
    const weekNum = Math.floor((barTime - testStart) / (7*24*60*60*1000));
    if(!weeklyPnL[weekNum]) weeklyPnL[weekNum] = { pnl:0, trades:0, wins:0 };

    // ═══ Check open positions — SIMPLE TP/SL (no trailing!) ═══
    for(let pi = openPos.length-1; pi >= 0; pi--) {
      const pos = openPos[pi];
      const sd = allData[pos.sym];
      if(!sd) continue;
      const sbi = sd.kl5.findIndex(k => k[0] === barTime);
      if(sbi < 0) continue;

      const bH=parseFloat(sd.kl5[sbi][2]), bL=parseFloat(sd.kl5[sbi][3]), bC=parseFloat(sd.kl5[sbi][4]);
      pos.barsHeld++;
      let pnl, reason;

      if(pos.signal === 'BUY') {
        if(bL <= pos.sl) { pnl = ((pos.sl-pos.entry)/pos.entry)*LEV*POS_SIZE - POS_SIZE*FEE; reason='SL'; }
        else if(bH >= pos.tp) { pnl = ((pos.tp-pos.entry)/pos.entry)*LEV*POS_SIZE - POS_SIZE*FEE; reason='TP'; }
        else if(pos.barsHeld >= TIMEOUT) { pnl = ((bC-pos.entry)/pos.entry)*LEV*POS_SIZE - POS_SIZE*FEE; reason='TIMEOUT'; }
        else continue;
      } else {
        if(bH >= pos.sl) { pnl = ((pos.entry-pos.sl)/pos.entry)*LEV*POS_SIZE - POS_SIZE*FEE; reason='SL'; }
        else if(bL <= pos.tp) { pnl = ((pos.entry-pos.tp)/pos.entry)*LEV*POS_SIZE - POS_SIZE*FEE; reason='TP'; }
        else if(pos.barsHeld >= TIMEOUT) { pnl = ((pos.entry-bC)/pos.entry)*LEV*POS_SIZE - POS_SIZE*FEE; reason='TIMEOUT'; }
        else continue;
      }

      trades.push({ sym:pos.sym, signal:pos.signal, entry:pos.entry, pnl, reason, barsHeld:pos.barsHeld, reg:pos.reg, hourUTC:pos.hourUTC, dayOfWeek:pos.dayOfWeek, cats:pos.cats, rratio:pos.rratio });
      weeklyPnL[weekNum].trades++; weeklyPnL[weekNum].pnl += pnl; if(pnl>0) weeklyPnL[weekNum].wins++;
      equity += pnl;
      openPos.splice(pi, 1);
    }

    if(equity > peak) peak = equity;
    const dd = (peak-equity)/peak*100;
    if(dd > maxDD) maxDD = dd;
    if(bi % 288 === 0) eqCurve.push({ day: Math.floor(bi/288), equity });

    if(openPos.length >= MAX_CONCURRENT) continue;

    // Generate signals
    const hourUTC = new Date(barTime).getUTCHours();
    const dayOfWeek = new Date(barTime).getUTCDay();

    for(const sym of pairs) {
      if(openPos.length >= MAX_CONCURRENT) break;
      if(openPos.some(p => p.sym === sym)) continue;
      const sd = allData[sym];
      if(!sd || !sd.kl5) continue;
      const lb = lastSig[sym] || -cooldown;
      if(bi - lb < cooldown) continue;

      const sbi = sd.kl5.findIndex(k => k[0] === barTime);
      if(sbi < 280) continue;

      const s5 = sd.kl5.slice(sbi-279, sbi+1);
      const C5=s5.map(k=>parseFloat(k[4])), H5=s5.map(k=>parseFloat(k[2])), L5=s5.map(k=>parseFloat(k[3])), V5=s5.map(k=>parseFloat(k[5]));
      if(C5.length<50) continue;

      const bt15=barTime-(barTime%(15*60*1000));
      let ei15=sd.kl15.findIndex(k=>k[0]>bt15);if(ei15===-1)ei15=sd.kl15.length;
      const s15=sd.kl15.slice(Math.max(0,ei15-100),ei15);
      const C15=s15.map(k=>parseFloat(k[4])),H15=s15.map(k=>parseFloat(k[2])),L15=s15.map(k=>parseFloat(k[3]));

      const bt1h=barTime-(barTime%3600000);
      let ei1h=sd.kl1h.findIndex(k=>k[0]>bt1h);if(ei1h===-1)ei1h=sd.kl1h.length;
      const s1h=sd.kl1h.slice(Math.max(0,ei1h-50),ei1h);
      const C1h=s1h.map(k=>parseFloat(k[4])),H1h=s1h.map(k=>parseFloat(k[2])),L1h=s1h.map(k=>parseFloat(k[3])),V1h=s1h.map(k=>parseFloat(k[5]));

      const sig = genSignal(C5,H5,L5,V5,C15,H15,L15,C1h,H1h,L1h,V1h,s5,mode);
      if(!sig || sig.signal === 'NEUTRAL') continue;

      lastSig[sym] = bi;
      openPos.push({ sym, signal:sig.signal, entry:sig.entry, tp:sig.tp, sl:sig.sl, barsHeld:0, reg:sig.regime, hourUTC, dayOfWeek, cats:sig.cats, rratio:sig.rratio });
    }
  }

  // Close remaining
  for(const pos of openPos) {
    const sd = allData[pos.sym]; if(!sd) continue;
    const bC = parseFloat(sd.kl5.at(-1)[4]);
    const pnl = pos.signal==='BUY' ? ((bC-pos.entry)/pos.entry)*LEV*POS_SIZE-POS_SIZE*FEE : ((pos.entry-bC)/pos.entry)*LEV*POS_SIZE-POS_SIZE*FEE;
    trades.push({ sym:pos.sym, signal:pos.signal, entry:pos.entry, pnl, reason:'END', barsHeld:pos.barsHeld, reg:pos.reg, hourUTC:pos.hourUTC, dayOfWeek:pos.dayOfWeek, cats:pos.cats, rratio:pos.rratio });
    equity += pnl;
  }

  // ═══ RESULTS ═══
  const wins=trades.filter(t=>t.pnl>0), losses=trades.filter(t=>t.pnl<=0);
  const totalPnL=trades.reduce((a,t)=>a+t.pnl,0);
  const gP=wins.reduce((a,t)=>a+t.pnl,0), gL=Math.abs(losses.reduce((a,t)=>a+t.pnl,0));
  const wr=trades.length?wins.length/trades.length*100:0;
  const pf=gL>0?gP/gL:Infinity;
  const avgW=wins.length?gP/wins.length:0, avgL=losses.length?gL/losses.length:0;

  console.log(`\n${'═'.repeat(75)}`);
  console.log(`  v5 RESULTS: ${mode.toUpperCase()} — ${DAYS} DAYS`);
  console.log(`${'═'.repeat(75)}`);
  console.log(`  Trades:      ${trades.length} (${(trades.length/DAYS).toFixed(1)}/day)`);
  console.log(`  Win Rate:    ${wr.toFixed(1)}%  (${wins.length}W / ${losses.length}L)`);
  console.log(`  PnL:         $${totalPnL.toFixed(2)}  (${(totalPnL/CAPITAL*100).toFixed(2)}%)`);
  console.log(`  PF:          ${pf.toFixed(2)}`);
  console.log(`  MaxDD:       ${maxDD.toFixed(2)}%`);
  console.log(`  Avg Win:     $${avgW.toFixed(2)}`);
  console.log(`  Avg Loss:    $${avgL.toFixed(2)}`);
  console.log(`  Eff R:R:     ${avgL>0?(avgW/avgL).toFixed(2):'N/A'}`);
  console.log(`  Expectancy:  $${trades.length?(totalPnL/trades.length).toFixed(2):'0'}/trade`);
  console.log(`  Equity:      $${equity.toFixed(2)}`);

  const reasons={};for(const t of trades)reasons[t.reason]=(reasons[t.reason]||0)+1;
  console.log(`\n  Exit:`);
  for(const[r,c]of Object.entries(reasons).sort((a,b)=>b[1]-a[1]))console.log(`    ${r.padEnd(10)} ${c} (${(c/trades.length*100).toFixed(0)}%)`);

  console.log(`\n  ═══ WEEKLY (consistency) ═══`);
  const weeks=Object.entries(weeklyPnL).sort((a,b)=>parseInt(a[0])-parseInt(b[0]));
  let pw=0;
  for(const[w,d]of weeks){
    const bar=d.pnl>=0?'█'.repeat(Math.min(30,Math.round(d.pnl/15))):'▒'.repeat(Math.min(30,Math.round(Math.abs(d.pnl)/15)));
    const wwr=d.trades?(d.wins/d.trades*100).toFixed(0):'0';
    console.log(`    W${(parseInt(w)+1).toString().padStart(2)}: $${d.pnl.toFixed(0).padStart(7)} ${d.trades}t WR:${wwr}% ${d.pnl>=0?'+':'-'}${bar}`);
    if(d.pnl>0)pw++;
  }
  console.log(`    Profitable: ${pw}/${weeks.length} (${(pw/weeks.length*100).toFixed(0)}%)`);

  const byPair={};for(const t of trades){if(!byPair[t.sym])byPair[t.sym]={n:0,pnl:0,w:0};byPair[t.sym].n++;byPair[t.sym].pnl+=t.pnl;if(t.pnl>0)byPair[t.sym].w++;}
  const pa=Object.entries(byPair).sort((a,b)=>b[1].pnl-a[1].pnl);
  console.log(`\n  Pairs (top/bottom):`);
  for(const[p,d]of pa.slice(0,8))console.log(`    ${p.padEnd(12)} ${String(d.n).padEnd(4)} WR:${(d.w/d.n*100).toFixed(0).padEnd(3)}% $${d.pnl.toFixed(0)}`);
  console.log(`    ---`);
  for(const[p,d]of pa.slice(-5).reverse())console.log(`    ${p.padEnd(12)} ${String(d.n).padEnd(4)} WR:${(d.w/d.n*100).toFixed(0).padEnd(3)}% $${d.pnl.toFixed(0)}`);

  const byReg={};for(const t of trades){if(!byReg[t.reg])byReg[t.reg]={n:0,pnl:0,w:0};byReg[t.reg].n++;byReg[t.reg].pnl+=t.pnl;if(t.pnl>0)byReg[t.reg].w++;}
  console.log(`\n  Regime:`);
  for(const[r,d]of Object.entries(byReg))console.log(`    ${r.padEnd(14)} ${String(d.n).padEnd(4)} WR:${(d.w/d.n*100).toFixed(0).padEnd(3)}% $${d.pnl.toFixed(0)}`);

  // Category analysis
  const catStats = {BUY_all4:0, BUY_3:0, SELL_all4:0, SELL_3:0};
  const catPnL = {all4:0, three:0};
  for(const t of trades) {
    const c = t.cats;
    const all4 = [c.cat1,c.cat2,c.cat3,c.cat4].filter(x=>x===t.signal).length === 4;
    if(all4) { catPnL.all4 += t.pnl; } else { catPnL.three += t.pnl; }
  }
  console.log(`\n  Category confluence:`);
  console.log(`    4/4 cats PnL: $${catPnL.all4.toFixed(0)}`);
  console.log(`    3/4 cats PnL: $${catPnL.three.toFixed(0)}`);

  console.log(`\n  Equity:`);
  for(const e of eqCurve){
    const pct=((e.equity-CAPITAL)/CAPITAL*100).toFixed(1);
    const bar=e.equity>=CAPITAL?'█'.repeat(Math.min(40,Math.round((e.equity-CAPITAL)/25))):'▒'.repeat(Math.min(40,Math.round((CAPITAL-e.equity)/25)));
    console.log(`    D${String(e.day).padStart(2)}: $${e.equity.toFixed(0).padStart(7)} (${pct.padStart(6)}%) ${bar}`);
  }

  let mw=0,ml=0,cw=0,cl=0;for(const t of trades){if(t.pnl>0){cw++;cl=0;if(cw>mw)mw=cw;}else{cl++;cw=0;if(cl>ml)ml=cl;}}
  console.log(`\n  Consec wins: ${mw} | Consec losses: ${ml}`);
  console.log(`  Best: $${Math.max(...trades.map(t=>t.pnl)).toFixed(2)} | Worst: $${Math.min(...trades.map(t=>t.pnl)).toFixed(2)}`);
  console.log(`${'═'.repeat(75)}\n`);
}

async function main() {
  const mode = process.argv[2] || 'strict';
  console.log('╔═══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  v5 ENGINE REDESIGN — 60-DAY BACKTEST — NO LOOK-AHEAD BIAS              ║');
  console.log('║  Category confluence | Fixed R:R 2:1 | HTF alignment | No trailing      ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════╝');
  await runBacktest(mode);
}

main().catch(console.error);
