// ═══════════════════════════════════════════════════════════════════
// SCALP MODE 4-DAY BACKTEST — Walk-Forward with Partial TP
// Config: TP=0.35×ATR | SL=0.15×ATR | TP1=40% of TP
// FIXED: Scalp uses FREE mode scoring + 3 safety rules (NOT strict)
// ═══════════════════════════════════════════════════════════════════

const https = require('https');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function getKlines(sym, tf, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`;
  try { return await fetchJSON(url); } catch(e) { return null; }
}

// ─── Indicator Functions (exact copy from app.html) ───
function calcRSI(closes,p=14){if(closes.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}if(al===0)return 100;return 100-(100/(1+ag/al));}
function calcEMAArr(data,p){const k=2/(p+1);const r=[data[0]];for(let i=1;i<data.length;i++)r.push(data[i]*k+r[i-1]*(1-k));return r;}
function calcEMA(data,p){return calcEMAArr(data,p).at(-1);}
function calcMACD(closes){if(closes.length<35)return{h:0,ph:0,macd:0,sig:0};const e12=calcEMAArr(closes,12),e26=calcEMAArr(closes,26);const ml=e12.map((v,i)=>v-e26[i]);const sl=calcEMAArr(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1)),macd:ml.at(-1),sig:sl.at(-1)};}
function calcBB(closes,p=20,s=2){if(closes.length<p)return{u:0,m:0,l:0};const sl=closes.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+s*sd,m,l:m-s*sd};}
function calcStoch(H,L,C,kp=14){
  if(C.length<kp+3)return{k:50,d:50};
  const kArr=[];
  for(let i=kp;i<=C.length;i++){
    const sh=H.slice(i-kp,i),sl=L.slice(i-kp,i);
    const hi=Math.max(...sh),lo=Math.min(...sl);
    kArr.push(hi===lo?50:((C[i-1]-lo)/(hi-lo))*100);
  }
  const dArr=[];for(let i=2;i<kArr.length;i++)dArr.push((kArr[i]+kArr[i-1]+kArr[i-2])/3);
  return{k:kArr.at(-1)||50,d:dArr.at(-1)||50};
}
function calcATR(H,L,C,p=14){
  if(C.length<p+1)return 0;
  const trs=[];for(let i=1;i<C.length;i++)trs.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));
  if(trs.length<p)return trs.reduce((a,b)=>a+b)/trs.length;
  let atr=trs.slice(0,p).reduce((a,b)=>a+b)/p;
  for(let i=p;i<trs.length;i++)atr=(atr*(p-1)+trs[i])/p;
  return atr;
}
function calcADX(H,L,C,p=14){
  if(C.length<p*2)return{adx:15,pdi:0,mdi:0};
  const pdm=[],mdm=[],tr=[];
  for(let i=1;i<H.length;i++){
    const upMove=H[i]-H[i-1],dnMove=L[i-1]-L[i];
    pdm.push(upMove>dnMove&&upMove>0?upMove:0);
    mdm.push(dnMove>upMove&&dnMove>0?dnMove:0);
    tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));
  }
  function wilderSmooth(arr,period){
    if(arr.length<period)return arr.map(()=>0);
    const r=[];let s=arr.slice(0,period).reduce((a,b)=>a+b)/period;
    for(let i=0;i<period;i++)r.push(0);
    r[period-1]=s;
    for(let i=period;i<arr.length;i++){s=(s*(period-1)+arr[i])/period;r.push(s);}
    return r;
  }
  const smTR=wilderSmooth(tr,p),smPDM=wilderSmooth(pdm,p),smMDM=wilderSmooth(mdm,p);
  const pdi=smPDM.map((v,i)=>smTR[i]?v/smTR[i]*100:0);
  const mdi=smMDM.map((v,i)=>smTR[i]?v/smTR[i]*100:0);
  const dx=pdi.map((v,i)=>{const s=v+mdi[i];return s?Math.abs(v-mdi[i])/s*100:0;});
  const dxValid = dx.slice(p-1);
  const adxArr=dxValid.length>=p?wilderSmooth(dxValid,p):dxValid;
  return{adx:adxArr.at(-1)||15,pdi:pdi.at(-1)||0,mdi:mdi.at(-1)||0};
}
function calcOBV(C,V){
  if(C.length<2)return{obv:0,slope:0,rising:false};
  let obv=0;const arr=[0];
  for(let i=1;i<C.length;i++){
    if(C[i]>C[i-1])obv+=V[i]; else if(C[i]<C[i-1])obv-=V[i];
    arr.push(obv);
  }
  const n=Math.min(arr.length,20);const recent=arr.slice(-n);
  let sumX=0,sumY=0,sumXY=0,sumX2=0;
  for(let i=0;i<n;i++){sumX+=i;sumY+=recent[i];sumXY+=i*recent[i];sumX2+=i*i;}
  const slope=(n*sumXY-sumX*sumY)/(n*sumX2-sumX*sumX||1);
  return{obv:arr.at(-1),slope,rising:slope>0};
}
function calcParabolicSAR(H,L,C){
  if(C.length<5)return{sar:C.at(-1),trend:'BUY',recentFlip:false};
  let af=0.02,maxAf=0.2,sar=L[0],ep=H[0],isUp=true;let lastFlipIdx=0;
  for(let i=1;i<C.length;i++){
    const pSar=sar+af*(ep-sar);
    if(isUp){
      sar=Math.min(pSar,L[i-1],i>1?L[i-2]:L[i-1]);
      if(L[i]<sar){isUp=false;sar=ep;ep=L[i];af=0.02;lastFlipIdx=i;}
      else{if(H[i]>ep){ep=H[i];af=Math.min(af+0.02,maxAf);}sar=pSar;}
    }else{
      sar=Math.max(pSar,H[i-1],i>1?H[i-2]:H[i-1]);
      if(H[i]>sar){isUp=true;sar=ep;ep=H[i];af=0.02;lastFlipIdx=i;}
      else{if(L[i]<ep){ep=L[i];af=Math.min(af+0.02,maxAf);}sar=pSar;}
    }
  }
  const recentFlip=(C.length-1-lastFlipIdx)<=5;
  return{sar,trend:isUp?'BUY':'SELL',recentFlip};
}
function calcKeltner(H,L,C,emaLen=20,atrLen=14,mult=2){
  if(C.length<Math.max(emaLen,atrLen)+1)return{upper:0,mid:0,lower:0,width:0,position:0.5};
  const mid=calcEMA(C,emaLen);const atr=calcATR(H,L,C,atrLen);
  const upper=mid+mult*atr;const lower=mid-mult*atr;const range=upper-lower;
  const width=mid?range/mid:0;const cur=C.at(-1);
  const position=range>0?(cur-lower)/range:0.5;
  return{upper,mid,lower,width,position,atr};
}
function detectOrderBlocks(H,L,C,V,lookback=50){
  if(C.length<lookback)return{bullOB:null,bearOB:null};
  const tail=C.length-lookback;let bullOB=null,bearOB=null;
  const avgV=V.slice(tail).reduce((a,b)=>a+b)/(lookback||1);
  for(let i=tail+2;i<C.length-1;i++){
    const body=Math.abs(C[i]-C[i-1]);const prevBody=Math.abs(C[i-1]-C[i-2]);
    const isImbalance=prevBody>0&&body>prevBody*2;const isHighVol=V[i]>avgV*1.5;
    if(isImbalance&&isHighVol){
      if(C[i]>C[i-1]) bullOB={price:Math.min(C[i-1],L[i]),high:H[i],idx:i};
      else bearOB={price:Math.max(C[i-1],H[i]),low:L[i],idx:i};
    }
  }
  const cur=C.at(-1);const atr=calcATR(H,L,C,14);
  if(bullOB&&(cur-bullOB.price)>atr*2)bullOB=null;
  if(bullOB&&(bullOB.price-cur)>atr*1)bullOB=null;
  if(bearOB&&(bearOB.price-cur)>atr*2)bearOB=null;
  if(bearOB&&(cur-bearOB.price)>atr*1)bearOB=null;
  return{bullOB,bearOB};
}
function detectRegime(H,L,C,adx,atrPre){
  const atr=atrPre||calcATR(H,L,C,14);
  const avgP=C.slice(-20).reduce((a,b)=>a+b)/20;
  const atrPct=atr/avgP*100;
  if(adx.adx>25&&atrPct>1.5)return{regime:'TRENDING',label:'TENDENCIA',cls:'trending'};
  if(adx.adx<20&&atrPct<0.8)return{regime:'QUIET',label:'QUIETO',cls:'quiet'};
  if(atrPct>2)return{regime:'VOLATILE',label:'VOLATIL',cls:'volatile'};
  return{regime:'RANGING',label:'RANGO',cls:'ranging'};
}
function findPivotLevels(H,L,C,lookback=50){
  const h=H.slice(-lookback),l=L.slice(-lookback);let supports=[],resistances=[];
  for(let i=2;i<h.length-2;i++){
    if(h[i]>=h[i-1]&&h[i]>=h[i-2]&&h[i]>=h[i+1]&&h[i]>=h[i+2])resistances.push(h[i]);
    if(l[i]<=l[i-1]&&l[i]<=l[i-2]&&l[i]<=l[i+1]&&l[i]<=l[i+2])supports.push(l[i]);
  }
  const cur=C.at(-1);
  const nearestRes=resistances.filter(r=>r>cur).sort((a,b)=>a-b)[0]||null;
  const nearestSup=supports.filter(s=>s<cur).sort((a,b)=>b-a)[0]||null;
  return{nearestRes,nearestSup,supports,resistances};
}

// ─── genSig — SCALP MODE (isStrict=false, isScalp=true) ───
// Uses FREE MODE scoring + 3 safety rules, then scalp TP/SL
function genSigScalp(C5, H5, L5, V5, C15, H15, L15, C1h, H1h, L1h, V1h, sym, hourUTC) {
  if(!C5 || C5.length < 50) return null;

  const C = C5, H = H5, L = L5, V = V5;
  const cur = C.at(-1);
  let B=0, S=0;
  const inds = [];

  // 5m indicators (same for all modes)
  const rsi = calcRSI(C, 14);
  const mac = calcMACD(C);
  const ea9 = calcEMAArr(C, 9), ea21 = calcEMAArr(C, 21);
  const e9 = ea9.at(-1), e21 = ea21.at(-1);
  const e50 = calcEMA(C, 50);
  const avgV = V.slice(-20).reduce((a,b)=>a+b) / 20;
  const lv = V.at(-1), vr = lv / avgV;
  const adxData = calcADX(H, L, C);
  const obvData = calcOBV(C, V);
  let atr = calcATR(H, L, C, 14);

  // HTF trend (for safety rule)
  let htfTrend = 'NEUTRAL';
  if(C1h && C1h.length > 25) {
    const ema9h=calcEMA(C1h,9),ema21h=calcEMA(C1h,21);
    const mac1h=calcMACD(C1h);
    let hB=0,hS=0;
    if(ema9h>ema21h)hB+=2;else hS+=2;
    if(mac1h.h>0)hB+=1.5;else hS+=1.5;
    if(hB>hS+1)htfTrend='BUY';
    else if(hS>hB+1)htfTrend='SELL';
  }

  // ════════════ FREE MODE SCORING (used by scalp) ════════════
  if(rsi < 30) { B += 2; inds.push({n:'RSI', s:'BUY'}); }
  else if(rsi > 70) { S += 2; inds.push({n:'RSI', s:'SELL'}); }
  else { inds.push({n:'RSI', s:'NEUTRAL'}); }

  if(mac.h > 0 && mac.ph < 0) { B += 2; inds.push({n:'MACD', s:'BUY'}); }
  else if(mac.h < 0 && mac.ph > 0) { S += 2; inds.push({n:'MACD', s:'SELL'}); }
  else { inds.push({n:'MACD', s:'NEUTRAL'}); }

  if(e9 > e21) { B += 1; inds.push({n:'EMA', s:'BUY'}); }
  else { S += 1; inds.push({n:'EMA', s:'SELL'}); }

  if(adxData.adx > 25 && adxData.pdi > adxData.mdi) { B += 1; inds.push({n:'ADX', s:'BUY'}); }
  else if(adxData.adx > 25) { S += 1; inds.push({n:'ADX', s:'SELL'}); }
  else { inds.push({n:'ADX', s:'NEUTRAL'}); }

  if(obvData.rising) { B += 0.5; inds.push({n:'OBV', s:'BUY'}); }
  else { S += 0.5; inds.push({n:'OBV', s:'SELL'}); }

  // Volume multiplier
  if(vr > 1.5 && B > S) B *= 1.1;
  else if(vr > 1.5 && S > B) S *= 1.1;

  // ════════════ FREE MODE SIGNAL DECISION ════════════
  const regimeData = detectRegime(H, L, C, adxData, atr);
  const isTrending = (regimeData.regime === 'TRENDING');
  const freeThr = isTrending ? 1.5 : 1.0;
  const freeMinInds = 1;
  const buyInds = inds.filter(i => i.s === 'BUY').length;
  const sellInds = inds.filter(i => i.s === 'SELL').length;

  let signal = 'NEUTRAL';
  let tot = Math.max(1, B + S);
  let conf = Math.min(99, Math.round((Math.max(B, S) / tot) * 100));

  if(B > S && B >= freeThr && buyInds >= freeMinInds) signal = 'BUY';
  else if(S > B && S >= freeThr && sellInds >= freeMinInds) signal = 'SELL';

  // ════════════ FREE MODE SAFETY RULES (only 3) ════════════
  // Safety Rule 1: Don't trade against VERY strong 1H trend
  if(signal === 'BUY' && htfTrend === 'SELL') signal = 'NEUTRAL';  // simplified for scalp
  if(signal === 'SELL' && htfTrend === 'BUY') signal = 'NEUTRAL';

  // Safety Rule 2: No dead volume
  if(signal !== 'NEUTRAL' && vr < 0.4) signal = 'NEUTRAL';

  // Safety Rule 3: No dead hours (00-06 UTC)
  if(signal !== 'NEUTRAL' && hourUTC >= 0 && hourUTC < 6) signal = 'NEUTRAL';

  // Free mode confidence
  if(signal !== 'NEUTRAL') conf = Math.max(40, Math.min(75, conf));

  // ════════════ SCALP TP/SL ════════════
  let atr15 = atr;
  if(H15.length > 15 && L15.length > 15 && C15.length > 15) {
    const _a15 = calcATR(H15, L15, C15, 14);
    if(_a15 > 0) atr15 = _a15;
  }
  let atr1h = atr;
  if(H1h.length > 15 && L1h.length > 15 && C1h.length > 15) {
    const _a1h = calcATR(H1h, L1h, C1h, 14);
    if(_a1h > 0) atr1h = _a1h;
  }
  const blendedATR = Math.max(atr15, atr1h / 4);

  let useATR = atr15 || blendedATR;
  let tpDist = useATR * 0.35;
  let slDist = useATR * 0.15;

  // Scalp min enforcement
  const minTPscalp = cur * 0.0008;
  if(tpDist < minTPscalp) tpDist = minTPscalp;
  if(slDist < minTPscalp * 0.6) slDist = minTPscalp * 0.6;
  if(tpDist < slDist * 1.3) tpDist = slDist * 1.3;

  const costBuffer = cur * 0.0008;

  // S/R awareness
  if(signal !== 'NEUTRAL') {
    try {
      let pivotH=H, pivotL=L, pivotC=C;
      if(H1h.length > 20) { pivotH=H1h; pivotL=L1h; pivotC=C1h; }
      const pivots = findPivotLevels(pivotH, pivotL, pivotC, 50);
      if(signal === 'BUY' && pivots.nearestRes) {
        const distToRes = pivots.nearestRes - cur;
        if(distToRes > 0 && distToRes < tpDist * 0.7) {
          if(distToRes > slDist * 1.2) tpDist = distToRes * 0.92;
          else signal = 'NEUTRAL';
        }
      }
      if(signal === 'SELL' && pivots.nearestSup) {
        const distToSup = cur - pivots.nearestSup;
        if(distToSup > 0 && distToSup < tpDist * 0.7) {
          if(distToSup > slDist * 1.2) tpDist = distToSup * 0.92;
          else signal = 'NEUTRAL';
        }
      }
    } catch(e) {}
  }

  // TP1 at 40% for scalp
  const tp1Dist = tpDist * 0.40;

  return { signal, confidence: conf, B, S, entry: cur, tpDist, slDist, tp1Dist, atr, regime: regimeData.regime, sym };
}

// ─── Walk-forward evaluation ───
function evaluateTrade(signal, entry, tpDist, slDist, tp1Dist, futureCandles) {
  const tp1 = signal==='BUY' ? entry + tp1Dist : entry - tp1Dist;
  const tp2 = signal==='BUY' ? entry + tpDist : entry - tpDist;
  const sl  = signal==='BUY' ? entry - slDist : entry + slDist;

  let tp1Hit = false;

  for(let i = 0; i < futureCandles.length; i++) {
    const { h, l } = futureCandles[i];

    if(signal === 'BUY') {
      if(!tp1Hit) {
        if(l <= sl) return { result: 'SL', pnl: -slDist/entry*100, bars: i+1 };
        if(h >= tp1) { tp1Hit = true; }
      }
      if(tp1Hit) {
        if(h >= tp2) return { result: 'TP2', pnl: ((tp1Dist*0.5 + tpDist*0.5)/entry)*100, bars: i+1 };
        if(l <= entry) return { result: 'TP1+BE', pnl: (tp1Dist*0.5/entry)*100, bars: i+1 };
      }
    } else {
      if(!tp1Hit) {
        if(h >= sl) return { result: 'SL', pnl: -slDist/entry*100, bars: i+1 };
        if(l <= tp1) { tp1Hit = true; }
      }
      if(tp1Hit) {
        if(l <= tp2) return { result: 'TP2', pnl: ((tp1Dist*0.5 + tpDist*0.5)/entry)*100, bars: i+1 };
        if(h >= entry) return { result: 'TP1+BE', pnl: (tp1Dist*0.5/entry)*100, bars: i+1 };
      }
    }
  }

  // Timeout
  const lastPrice = futureCandles.at(-1)?.c || entry;
  const unrealizedPnl = signal==='BUY' ? (lastPrice-entry)/entry*100 : (entry-lastPrice)/entry*100;
  if(tp1Hit) return { result: 'TO_TP1', pnl: (tp1Dist*0.5/entry)*100 + unrealizedPnl*0.5, bars: futureCandles.length };
  return { result: 'TIMEOUT', pnl: unrealizedPnl, bars: futureCandles.length };
}

// ─── MAIN ───
const SCALP_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','DOTUSDT','NEARUSDT','APTUSDT'];

async function runBacktest() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  SCALP MODE — 4-DAY BACKTEST (Walk-Forward, Partial TP)');
  console.log('  Config: TP=0.35xATR | SL=0.15xATR | TP1=40% of TP');
  console.log('  Mode: FREE scoring + 3 safety rules + scalp TP/SL');
  console.log('  12 pairs | 5m candles | 1h eval window (12 bars)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const LOOKBACK = 280;
  const EVAL_WINDOW = 12; // 12 bars = 1 hour max per trade
  const allResults = [];
  const pairStats = {};

  for(const sym of SCALP_SYMS) {
    process.stdout.write(`  ${sym.padEnd(12)}`);

    const [kl5, kl15, kl1h] = await Promise.all([
      getKlines(sym, '5m', 1000),
      getKlines(sym, '15m', 400),
      getKlines(sym, '1h', 200)
    ]);

    if(!kl5 || kl5.length < LOOKBACK + 100) {
      console.log(`SKIP (${kl5?.length || 0} bars)`);
      continue;
    }

    const allC5=kl5.map(k=>parseFloat(k[4])), allH5=kl5.map(k=>parseFloat(k[2]));
    const allL5=kl5.map(k=>parseFloat(k[3])), allV5=kl5.map(k=>parseFloat(k[5]));
    const allT5=kl5.map(k=>k[0]);

    const allC15=kl15?kl15.map(k=>parseFloat(k[4])):[], allH15=kl15?kl15.map(k=>parseFloat(k[2])):[];
    const allL15=kl15?kl15.map(k=>parseFloat(k[3])):[], allT15=kl15?kl15.map(k=>k[0]):[];

    const allC1h=kl1h?kl1h.map(k=>parseFloat(k[4])):[], allH1h=kl1h?kl1h.map(k=>parseFloat(k[2])):[];
    const allL1h=kl1h?kl1h.map(k=>parseFloat(k[3])):[], allV1h=kl1h?kl1h.map(k=>parseFloat(k[5])):[];
    const allT1h=kl1h?kl1h.map(k=>k[0]):[];

    const availBars = kl5.length;
    const startBar = LOOKBACK;
    const endBar = availBars - EVAL_WINDOW;
    const testBars = endBar - startBar;

    let wins=0, losses=0, tp2s=0, tp1bes=0, toTP1s=0, timeouts=0, totalPnl=0;
    const trades = [];
    let lastSignalBar = -999;

    for(let bar = startBar; bar < endBar; bar++) {
      // Cooldown: 2 bars (10 min) between signals per pair
      if(bar - lastSignalBar < 2) continue;

      const c5 = allC5.slice(Math.max(0, bar-279), bar+1);
      const h5 = allH5.slice(Math.max(0, bar-279), bar+1);
      const l5 = allL5.slice(Math.max(0, bar-279), bar+1);
      const v5 = allV5.slice(Math.max(0, bar-279), bar+1);

      const barTime = allT5[bar];
      const hourUTC = new Date(barTime).getUTCHours();

      // Find matching 15m data
      let c15End = 0;
      for(let j = allT15.length-1; j >= 0; j--) {
        if(allT15[j] <= barTime) { c15End = j+1; break; }
      }
      const c15 = allC15.slice(Math.max(0, c15End-100), c15End);
      const h15 = allH15.slice(Math.max(0, c15End-100), c15End);
      const l15 = allL15.slice(Math.max(0, c15End-100), c15End);

      // Find matching 1h data
      let c1hEnd = 0;
      for(let j = allT1h.length-1; j >= 0; j--) {
        if(allT1h[j] <= barTime) { c1hEnd = j+1; break; }
      }
      const c1h = allC1h.slice(Math.max(0, c1hEnd-50), c1hEnd);
      const h1h = allH1h.slice(Math.max(0, c1hEnd-50), c1hEnd);
      const l1h = allL1h.slice(Math.max(0, c1hEnd-50), c1hEnd);
      const v1h = allV1h.slice(Math.max(0, c1hEnd-50), c1hEnd);

      const sig = genSigScalp(c5, h5, l5, v5, c15, h15, l15, c1h, h1h, l1h, v1h, sym, hourUTC);
      if(!sig || sig.signal === 'NEUTRAL') continue;

      lastSignalBar = bar;

      // Future candles
      const futureCandles = [];
      for(let f = bar+1; f <= Math.min(bar + EVAL_WINDOW, availBars-1); f++) {
        futureCandles.push({ h: allH5[f], l: allL5[f], c: allC5[f] });
      }

      const ev = evaluateTrade(sig.signal, sig.entry, sig.tpDist, sig.slDist, sig.tp1Dist, futureCandles);

      const trade = {
        sym, signal: sig.signal, entry: sig.entry, conf: sig.confidence,
        regime: sig.regime, tpDist: sig.tpDist, slDist: sig.slDist,
        ...ev, time: new Date(barTime).toISOString(), hour: hourUTC
      };
      trades.push(trade);
      allResults.push(trade);
      totalPnl += ev.pnl;

      if(ev.result === 'SL') losses++;
      else if(ev.result === 'TP2') { wins++; tp2s++; }
      else if(ev.result === 'TP1+BE') { wins++; tp1bes++; }
      else if(ev.result === 'TO_TP1') { wins++; toTP1s++; }
      else { timeouts++; if(ev.pnl >= 0) wins++; else losses++; }
    }

    const total = wins + losses;
    const wr = total > 0 ? (wins/total*100).toFixed(1) : '-';
    const days = testBars / 288;
    pairStats[sym] = { wins, losses, tp2s, tp1bes, toTP1s, timeouts, totalPnl, total, wr, testBars, days };

    console.log(`${String(total).padStart(4)} sigs | ${String(wr).padStart(5)}% WR | PnL: ${(totalPnl>=0?'+':'')+totalPnl.toFixed(3).padStart(7)}% | ${days.toFixed(1)}d`);

    await new Promise(r => setTimeout(r, 250));
  }

  // ═══ RESULTS ═══
  console.log('\n' + '═'.repeat(65));
  console.log('  RESULTADOS AGREGADOS — BACKTEST 4 DIAS (SCALP MODE)');
  console.log('═'.repeat(65) + '\n');

  const totalTrades = allResults.length;
  const totalWins = allResults.filter(r => !['SL'].includes(r.result) && !(r.result === 'TIMEOUT' && r.pnl < 0)).length;
  const totalLosses = totalTrades - totalWins;
  const totalPnl = allResults.reduce((s,r) => s + r.pnl, 0);
  const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
  const wr = totalTrades > 0 ? (totalWins/totalTrades*100).toFixed(1) : '0';

  const slCount = allResults.filter(r => r.result === 'SL').length;
  const tp2Count = allResults.filter(r => r.result === 'TP2').length;
  const tp1beCount = allResults.filter(r => r.result === 'TP1+BE').length;
  const toTP1Count = allResults.filter(r => r.result === 'TO_TP1').length;
  const toCount = allResults.filter(r => r.result === 'TIMEOUT').length;

  // Actual days tested (max across all pairs)
  const maxDays = Math.max(...Object.values(pairStats).map(s => s.days));
  const sigsPerDay = (totalTrades / maxDays).toFixed(0);

  const avgBars = totalTrades > 0 ? (allResults.reduce((s,r) => s + r.bars, 0) / totalTrades).toFixed(1) : 0;

  console.log(`  Total Signals:     ${totalTrades}`);
  console.log(`  Signals/Day:       ~${sigsPerDay}  (across 12 pairs)`);
  console.log(`  Days Tested:       ${maxDays.toFixed(1)}`);
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  WIN RATE:          ${wr}%  (${totalWins}W / ${totalLosses}L)`);
  console.log(`  TOTAL PnL:         ${totalPnl>=0?'+':''}${totalPnl.toFixed(3)}%`);
  console.log(`  Avg PnL/Trade:     ${avgPnl>=0?'+':''}${avgPnl.toFixed(4)}%`);
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  TP2 (Full profit): ${tp2Count}  (${totalTrades>0?(tp2Count/totalTrades*100).toFixed(1):'0'}%)`);
  console.log(`  TP1+BE (Partial):  ${tp1beCount}  (${totalTrades>0?(tp1beCount/totalTrades*100).toFixed(1):'0'}%)`);
  console.log(`  SL (Stop Loss):    ${slCount}  (${totalTrades>0?(slCount/totalTrades*100).toFixed(1):'0'}%)`);
  console.log(`  Timeout w/TP1:     ${toTP1Count}`);
  console.log(`  Timeout open:      ${toCount}`);
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  Avg Resolution:    ${avgBars} bars (${(avgBars*5).toFixed(0)} min)`);

  // Per-pair table
  console.log('\n═══ PER-PAIR BREAKDOWN ═══\n');
  console.log('  PAIR         | SIGS | WR%   |   PnL%   | TP2  | TP1+BE | SL');
  console.log('  ' + '─'.repeat(60));
  for(const sym of SCALP_SYMS) {
    const s = pairStats[sym];
    if(!s) continue;
    console.log(`  ${sym.padEnd(12)} | ${String(s.total).padStart(4)} | ${String(s.wr).padStart(5)}% | ${((s.totalPnl>=0?'+':'')+s.totalPnl.toFixed(3)).padStart(8)}% | ${String(s.tp2s).padStart(4)} | ${String(s.tp1bes).padStart(6)} | ${String(s.losses).padStart(3)}`);
  }

  // Hourly
  console.log('\n═══ HOURLY PERFORMANCE ═══\n');
  const hourMap = {};
  for(const r of allResults) {
    if(!hourMap[r.hour]) hourMap[r.hour] = { w:0, l:0, pnl:0 };
    hourMap[r.hour].pnl += r.pnl;
    if(r.result !== 'SL' && !(r.result === 'TIMEOUT' && r.pnl < 0)) hourMap[r.hour].w++;
    else hourMap[r.hour].l++;
  }
  console.log('  HOUR | SIGS | WR%   | PnL%');
  console.log('  ' + '─'.repeat(35));
  for(let h=0; h<24; h++) {
    const d = hourMap[h]; if(!d) continue;
    const tot = d.w + d.l;
    console.log(`  ${String(h).padStart(4)} | ${String(tot).padStart(4)} | ${(d.w/tot*100).toFixed(1).padStart(5)}% | ${(d.pnl>=0?'+':'')}${d.pnl.toFixed(3)}%`);
  }

  // Direction
  console.log('\n═══ DIRECTION ═══\n');
  const buys = allResults.filter(r => r.signal === 'BUY');
  const sells = allResults.filter(r => r.signal === 'SELL');
  const bW = buys.filter(r => r.result !== 'SL' && !(r.result === 'TIMEOUT' && r.pnl < 0)).length;
  const sW = sells.filter(r => r.result !== 'SL' && !(r.result === 'TIMEOUT' && r.pnl < 0)).length;
  const bPnl = buys.reduce((s,r) => s + r.pnl, 0);
  const sPnl = sells.reduce((s,r) => s + r.pnl, 0);
  console.log(`  BUY:  ${buys.length} sigs | ${buys.length>0?(bW/buys.length*100).toFixed(1):'0'}% WR | PnL: ${bPnl>=0?'+':''}${bPnl.toFixed(3)}%`);
  console.log(`  SELL: ${sells.length} sigs | ${sells.length>0?(sW/sells.length*100).toFixed(1):'0'}% WR | PnL: ${sPnl>=0?'+':''}${sPnl.toFixed(3)}%`);

  // Regime
  console.log('\n═══ REGIME ═══\n');
  const regimeMap = {};
  for(const r of allResults) {
    if(!regimeMap[r.regime]) regimeMap[r.regime] = { w:0, l:0, pnl:0 };
    regimeMap[r.regime].pnl += r.pnl;
    if(r.result !== 'SL' && !(r.result === 'TIMEOUT' && r.pnl < 0)) regimeMap[r.regime].w++;
    else regimeMap[r.regime].l++;
  }
  for(const [regime, d] of Object.entries(regimeMap)) {
    const tot = d.w + d.l;
    console.log(`  ${regime.padEnd(12)} | ${tot} sigs | ${(d.w/tot*100).toFixed(1)}% WR | PnL: ${d.pnl>=0?'+':''}${d.pnl.toFixed(3)}%`);
  }

  // Verdict
  console.log('\n' + '═'.repeat(65));
  console.log('  VEREDICTO FINAL');
  console.log('═'.repeat(65));
  const wrNum = parseFloat(wr);
  const sigsNum = parseInt(sigsPerDay);
  const checks = [
    { name: 'Win Rate >= 75%', ok: wrNum >= 75, val: `${wr}%` },
    { name: 'PnL >= +20%  (4d)', ok: totalPnl >= 20, val: `${totalPnl>=0?'+':''}${totalPnl.toFixed(3)}%` },
    { name: 'Signals/Day >= 300', ok: sigsNum >= 300, val: `${sigsPerDay}/dia` }
  ];
  for(const c of checks) {
    console.log(`  ${c.ok ? '[OK]' : '[!!]'} ${c.name}: ${c.val}`);
  }
  console.log('═'.repeat(65) + '\n');
}

runBacktest().catch(console.error);
