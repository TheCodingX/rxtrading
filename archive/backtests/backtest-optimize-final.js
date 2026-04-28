#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// BINANCE PRECISION — 5 STRATEGY FAMILIES × REAL CONDITIONS
// 120 days BTCUSDT Perpetual Futures
// Fees: 0.04% taker | Slippage: 0.01% | Delay: 1 bar
// Capital: $2,500 | Leverage: up to 20x
// ═══════════════════════════════════════════════════════════════

const https = require('https');
const DAYS = 120;
const SYMBOL = 'BTCUSDT';
const TRADE_AMT = 500;
const BASE_LEVERAGE = 5;

// ═══ INDICATORS ═══
function emaArr(a,p){if(!a||!a.length)return[];let m=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*m+r[i-1]*(1-m));return r;}
function ema(a,p){const r=emaArr(a,p);return r.at(-1)||0;}
function sma(a,p){if(!a||a.length<p)return 0;return a.slice(-p).reduce((s,v)=>s+v,0)/p;}
function rsi(c,p=14){if(!c||c.length<p+1)return 50;let g=0,l=0;for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l-=d;}g/=p;l/=p;if(l===0)return 100;return 100-100/(1+g/l);}
function macd(c){if(!c||c.length<26)return{h:0,ph:0,m:0,s:0};const e12=emaArr(c,12),e26=emaArr(c,26);const ml=[];for(let i=0;i<c.length;i++)ml.push((e12[i]||0)-(e26[i]||0));const sl=emaArr(ml,9);return{h:(ml.at(-1)||0)-(sl.at(-1)||0),ph:(ml.at(-2)||0)-(sl.at(-2)||0),m:ml.at(-1)||0,s:sl.at(-1)||0};}
function bb(c,p=20,k=2){if(!c||c.length<p)return{u:0,m:0,l:0,w:0};const sl=c.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const std=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/p);return{u:m+k*std,m,l:m-k*std,w:std*2*k/m};}
function stoch(h,l,c,p=14){if(!h||h.length<p)return{k:50,d:50};const hh=Math.max(...h.slice(-p)),ll=Math.min(...l.slice(-p));const k=hh!==ll?((c.at(-1)-ll)/(hh-ll))*100:50;return{k};}
function atr(h,l,c,p=14){if(!h||h.length<p+1)return 0;let t=[];for(let i=1;i<h.length;i++)t.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));return t.slice(-p).reduce((a,b)=>a+b)/p;}
function adx(h,l,c,p=14){if(!h||h.length<p*2)return{adx:0,pdi:0,mdi:0};let pd=[],md=[],tr=[];for(let i=1;i<h.length;i++){const u=h[i]-h[i-1],d=l[i-1]-l[i];pd.push(u>d&&u>0?u:0);md.push(d>u&&d>0?d:0);tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));}const a=ema(tr,p)||1;const sp=ema(pd,p),sm=ema(md,p);const pi=(sp/a)*100,mi=(sm/a)*100;const dx=pi+mi>0?Math.abs(pi-mi)/(pi+mi)*100:0;return{adx:dx,pdi:pi,mdi:mi};}
function vwap(kl){if(!kl||!kl.length)return 0;let cv=0,ct=0;kl.forEach(k=>{const h=parseFloat(k[2]),l=parseFloat(k[3]),c=parseFloat(k[4]),v=parseFloat(k[5]);cv+=v;ct+=(h+l+c)/3*v;});return cv>0?ct/cv:0;}
function bbWidth(c,p=20,k=2){const b=bb(c,p,k);return b.m>0?(b.u-b.l)/b.m:0;}
function swingHigh(H,lookback=5){const s=H.slice(-lookback*2-1,-1);let maxH=0,maxI=-1;for(let i=0;i<s.length;i++){if(s[i]>maxH){maxH=s[i];maxI=i;}}return maxH;}
function swingLow(L,lookback=5){const s=L.slice(-lookback*2-1,-1);let minL=Infinity,minI=-1;for(let i=0;i<s.length;i++){if(s[i]<minL){minL=s[i];minI=i;}}return minL;}
function fibLevels(high,low){const d=high-low;return{r236:high-d*0.236,r382:high-d*0.382,r500:high-d*0.5,r618:high-d*0.618,e1618:high+d*0.618,e2618:high+d*1.618};}

function fetchJ(u){return new Promise((r,j)=>{https.get(u,{timeout:30000},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}
async function getFK(s,t,l,e){try{return await fetchJ(`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=${t}&limit=${l}${e?'&endTime='+e:''}`);}catch{return null;}}

// ═══════════════════════════════════════════════════════════════
// STRATEGY 1: TREND FOLLOWING + PULLBACK (EMA 50/200 + Fib)
// 4h direction → 1h pullback to EMA21 → enter on bounce
// ═══════════════════════════════════════════════════════════════
function strategy1(kl1h, kl4h, cfg) {
  if(!kl1h||kl1h.length<60||!kl4h||kl4h.length<60) return null;
  const C4=kl4h.map(k=>parseFloat(k[4])),H4=kl4h.map(k=>parseFloat(k[2])),L4=kl4h.map(k=>parseFloat(k[3]));
  const C1=kl1h.map(k=>parseFloat(k[4])),H1=kl1h.map(k=>parseFloat(k[2])),L1=kl1h.map(k=>parseFloat(k[3])),V1=kl1h.map(k=>parseFloat(k[5]));
  const cur=C1.at(-1);

  // 4h trend: EMA50 > EMA200 = uptrend
  const e50_4h=ema(C4,50),e200_4h=ema(C4,200);
  const trend4h = e50_4h > e200_4h ? 'UP' : e50_4h < e200_4h ? 'DN' : 'FLAT';
  if(trend4h === 'FLAT') return null;

  // ADX on 4h must show strong trend
  const adx4h=adx(H4,L4,C4,14);
  if(adx4h.adx < cfg.adxMin) return null;

  // 1h: price pulled back to EMA21 zone (within 0.3% of EMA21)
  const e21_1h=ema(C1,21);
  const distToEMA = Math.abs(cur - e21_1h) / cur;
  if(distToEMA > cfg.pullbackZone) return null;

  // 1h: RSI not extreme (between 35-65 = pullback zone, not exhaustion)
  const rsi1h=rsi(C1,14);
  if(trend4h==='UP' && (rsi1h < 35 || rsi1h > 65)) return null;
  if(trend4h==='DN' && (rsi1h < 35 || rsi1h > 65)) return null;

  // 1h: MACD showing momentum returning (histogram positive for UP, negative for DN)
  const m1h=macd(C1);
  if(trend4h==='UP' && m1h.h <= 0) return null;
  if(trend4h==='DN' && m1h.h >= 0) return null;

  // 1h: last candle must confirm direction (green for UP, red for DN)
  const lastOpen=parseFloat(kl1h.at(-1)[1]);
  if(trend4h==='UP' && cur <= lastOpen) return null;
  if(trend4h==='DN' && cur >= lastOpen) return null;

  // Volume confirmation: above average
  const avgV=V1.slice(-20).reduce((a,b)=>a+b)/20;
  if(V1.at(-1) < avgV * cfg.volMin) return null;

  const signal = trend4h==='UP' ? 'BUY' : 'SELL';
  const atrV = atr(H1,L1,C1,14);

  // TP: Fibonacci extension from recent swing
  const swH=swingHigh(H1,10), swL=swingLow(L1,10);
  let tpDist = atrV * cfg.tpMult;
  let slDist = atrV * cfg.slMult;

  // SL below swing low (for BUY) or above swing high (for SELL)
  if(signal==='BUY'){
    const structSL = cur - swL;
    if(structSL > 0 && structSL < slDist * 2) slDist = structSL * 1.1; // use structure + buffer
  } else {
    const structSL = swH - cur;
    if(structSL > 0 && structSL < slDist * 2) slDist = structSL * 1.1;
  }

  return {signal, entry: cur, tpDist, slDist, atrV, type: 'TREND'};
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY 2: MEAN REVERSION (BB + RSI extremes)
// Enter when price pierces BB and RSI is extreme, exit at mean
// ═══════════════════════════════════════════════════════════════
function strategy2(kl1h, kl4h, cfg) {
  if(!kl1h||kl1h.length<30) return null;
  const C=kl1h.map(k=>parseFloat(k[4])),H=kl1h.map(k=>parseFloat(k[2])),L=kl1h.map(k=>parseFloat(k[3])),V=kl1h.map(k=>parseFloat(k[5]));
  const cur=C.at(-1);

  const bbD=bb(C,20,2);
  const rsiV=rsi(C,14);
  const stK=stoch(H,L,C,14).k;

  let signal='NEUTRAL';

  // BUY: price at/below lower BB + RSI oversold + Stoch oversold
  if(cur <= bbD.l * 1.002 && rsiV < cfg.rsiExtreme && stK < 25) {
    signal = 'BUY';
  }
  // SELL: price at/above upper BB + RSI overbought + Stoch overbought
  else if(cur >= bbD.u * 0.998 && rsiV > (100-cfg.rsiExtreme) && stK > 75) {
    signal = 'SELL';
  }

  if(signal==='NEUTRAL') return null;

  // Volume spike confirms exhaustion
  const avgV=V.slice(-20).reduce((a,b)=>a+b)/20;
  if(V.at(-1) < avgV * cfg.volSpike) return null;

  // TP at BB middle (mean), SL at BB extension
  const tpDist = Math.abs(cur - bbD.m);
  const atrV = atr(H,L,C,14);
  const slDist = atrV * cfg.slMult;

  if(tpDist < cur * 0.002) return null; // Too small

  return {signal, entry: cur, tpDist, slDist, atrV, type: 'MEANREV'};
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY 3: BREAKOUT (Bollinger Squeeze → Expansion)
// Enter when BB width expands after squeeze, with volume
// ═══════════════════════════════════════════════════════════════
function strategy3(kl1h, kl4h, cfg) {
  if(!kl1h||kl1h.length<30) return null;
  const C=kl1h.map(k=>parseFloat(k[4])),H=kl1h.map(k=>parseFloat(k[2])),L=kl1h.map(k=>parseFloat(k[3])),V=kl1h.map(k=>parseFloat(k[5]));
  const cur=C.at(-1);

  // BB width history — detect squeeze then expansion
  const widths=[];
  for(let i=Math.max(0,C.length-20);i<=C.length;i++){
    const slice=C.slice(0,i);
    if(slice.length>=20) widths.push(bbWidth(slice,20,2));
  }
  if(widths.length<5) return null;

  const recentWidth=widths.at(-1);
  const prevWidths=widths.slice(-6,-1);
  const avgWidth=prevWidths.reduce((a,b)=>a+b)/prevWidths.length;

  // Squeeze: recent width was below average (consolidation)
  // Expansion: current width is expanding (breakout starting)
  const wasSqueeze = prevWidths.every(w => w < avgWidth * cfg.squeezeThresh);
  const isExpanding = recentWidth > avgWidth;
  if(!wasSqueeze || !isExpanding) return null;

  // Volume confirms breakout
  const avgV=V.slice(-20).reduce((a,b)=>a+b)/20;
  if(V.at(-1) < avgV * cfg.volBreakout) return null;

  // Direction: which way did it break?
  const bbD=bb(C,20,2);
  let signal='NEUTRAL';
  if(cur > bbD.u) signal = 'BUY';
  else if(cur < bbD.l) signal = 'SELL';
  else {
    // Inside bands but expanding — use EMA direction
    if(ema(C,9) > ema(C,21)) signal = 'BUY';
    else signal = 'SELL';
  }

  // ADX confirming trend strength
  const adxD=adx(H,L,C,14);
  if(adxD.adx < cfg.adxMin) return null;

  const atrV = atr(H,L,C,14);
  const rangeHeight = Math.max(...H.slice(-20)) - Math.min(...L.slice(-20));
  const tpDist = rangeHeight * cfg.rangeProject; // Project range height
  const slDist = atrV * cfg.slMult;

  if(tpDist < cur * 0.003) return null;

  return {signal, entry: cur, tpDist, slDist, atrV, type: 'BREAKOUT'};
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY 4: MOMENTUM (ADX + MACD + Volume cascade)
// Strong trend with increasing momentum, ride the wave
// ═══════════════════════════════════════════════════════════════
function strategy4(kl1h, kl4h, cfg) {
  if(!kl1h||kl1h.length<30) return null;
  const C=kl1h.map(k=>parseFloat(k[4])),H=kl1h.map(k=>parseFloat(k[2])),L=kl1h.map(k=>parseFloat(k[3])),V=kl1h.map(k=>parseFloat(k[5]));
  const cur=C.at(-1);

  // ADX must be strong
  const adxD=adx(H,L,C,14);
  if(adxD.adx < cfg.adxStrong) return null;

  // MACD crossover with growing histogram
  const m=macd(C);
  const crossUp = m.h > 0 && m.ph <= 0;
  const crossDn = m.h < 0 && m.ph >= 0;
  const growingUp = m.h > 0 && m.h > m.ph;
  const growingDn = m.h < 0 && m.h < m.ph;

  if(!crossUp && !crossDn && !growingUp && !growingDn) return null;

  // Volume increasing: last 3 candles volume ascending
  const v3 = V.slice(-3);
  const volIncreasing = v3[2] > v3[1] && v3[1] > v3[0];
  if(cfg.reqVolIncrease && !volIncreasing) return null;

  // EMA alignment
  const e9=ema(C,9),e21=ema(C,21),e50=ema(C,50);

  let signal='NEUTRAL';
  if((crossUp || growingUp) && adxD.pdi > adxD.mdi && e9 > e21) signal = 'BUY';
  else if((crossDn || growingDn) && adxD.mdi > adxD.pdi && e9 < e21) signal = 'SELL';
  if(signal==='NEUTRAL') return null;

  const atrV = atr(H,L,C,14);
  // Trailing-style TP: use larger ATR multiple for momentum rides
  const tpDist = atrV * cfg.tpMult;
  const slDist = atrV * cfg.slMult;

  return {signal, entry: cur, tpDist, slDist, atrV, type: 'MOMENTUM'};
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY 5: MULTI-TF CONFLUENCE (4h + 1h + 15m alignment)
// Only trade when ALL 3 timeframes agree
// ═══════════════════════════════════════════════════════════════
function strategy5(kl15, kl1h, kl4h, cfg) {
  if(!kl15||kl15.length<50||!kl1h||kl1h.length<50||!kl4h||kl4h.length<50) return null;
  const C15=kl15.map(k=>parseFloat(k[4])),H15=kl15.map(k=>parseFloat(k[2])),L15=kl15.map(k=>parseFloat(k[3])),V15=kl15.map(k=>parseFloat(k[5]));
  const C1=kl1h.map(k=>parseFloat(k[4])),H1=kl1h.map(k=>parseFloat(k[2])),L1=kl1h.map(k=>parseFloat(k[3]));
  const C4=kl4h.map(k=>parseFloat(k[4])),H4=kl4h.map(k=>parseFloat(k[2])),L4=kl4h.map(k=>parseFloat(k[3]));
  const cur=C15.at(-1);

  // 4h: Structure (EMA 50 direction + price position)
  const e50_4=ema(C4,50),e200_4=ema(C4,200);
  let dir4 = 'N';
  if(e50_4 > e200_4 && C4.at(-1) > e50_4) dir4 = 'B';
  else if(e50_4 < e200_4 && C4.at(-1) < e50_4) dir4 = 'S';
  if(dir4==='N') return null;

  // 1h: Fibonacci zone (price in 38.2-61.8% retracement zone)
  const sw20H=Math.max(...H1.slice(-20)), sw20L=Math.min(...L1.slice(-20));
  const fib=fibLevels(sw20H,sw20L);
  const inFibZone = (dir4==='B' && cur >= fib.r618 && cur <= fib.r382) ||
                    (dir4==='S' && cur >= fib.r382 && cur <= fib.r236);
  if(cfg.reqFibZone && !inFibZone) return null;

  // 1h: RSI in favorable zone (not overbought for BUY, not oversold for SELL)
  const rsi1=rsi(C1,14);
  if(dir4==='B' && rsi1 > 70) return null;
  if(dir4==='S' && rsi1 < 30) return null;

  // 15m: Entry trigger — RSI bounce + MACD cross + EMA alignment
  const rsi15=rsi(C15,14);
  const m15=macd(C15);
  const e9_15=ema(C15,9),e21_15=ema(C15,21);

  let trigger = false;
  if(dir4==='B' && rsi15 > 45 && rsi15 < 65 && m15.h > 0 && e9_15 > e21_15) trigger = true;
  if(dir4==='S' && rsi15 > 35 && rsi15 < 55 && m15.h < 0 && e9_15 < e21_15) trigger = true;
  if(!trigger) return null;

  // Volume on 15m above average
  const avgV=V15.slice(-20).reduce((a,b)=>a+b)/20;
  if(V15.at(-1) < avgV * cfg.volMin) return null;

  const signal = dir4==='B' ? 'BUY' : 'SELL';
  const atrV = atr(H15,L15,C15,14);

  // TP: Fibonacci extension (1.618 of recent swing)
  const swRange = sw20H - sw20L;
  const tpDist = Math.max(atrV * cfg.tpMult, swRange * cfg.fibExtTP);
  const slDist = atrV * cfg.slMult;

  return {signal, entry: cur, tpDist, slDist, atrV, type: 'MTF'};
}

// ═══ BACKTEST ENGINE ═══
function walkForwardEval(trades, kl, sig, tp, sl, delayBars) {
  const i = trades.entryBar;
  for(let j=i+delayBars+1; j<kl.length && j<i+500; j++){
    const cH=parseFloat(kl[j][2]),cL=parseFloat(kl[j][3]),cO=parseFloat(kl[j][1]);
    if(sig==='BUY'){
      if(cH>=tp&&cL<=sl){return{r:Math.abs(cO-sl)<Math.abs(cO-tp)?'L':'W',ep:Math.abs(cO-sl)<Math.abs(cO-tp)?sl:tp};}
      if(cH>=tp) return{r:'W',ep:tp};
      if(cL<=sl) return{r:'L',ep:sl};
    } else {
      if(cL<=tp&&cH>=sl){return{r:Math.abs(cO-sl)<Math.abs(cO-tp)?'L':'W',ep:Math.abs(cO-sl)<Math.abs(cO-tp)?sl:tp};}
      if(cL<=tp) return{r:'W',ep:tp};
      if(cH>=sl) return{r:'L',ep:sl};
    }
  }
  return null;
}

// ═══ RUN COMPLETE TEST ═══
async function runStrategy(name, stratFn, cfgVariations, data, leverageOverride) {
  console.log(`\n  ═══ STRATEGY: ${name} ═══`);
  console.log(`  ${'Config'.padEnd(25)} ${'Lev'.padStart(4)} ${'#'.padStart(5)} ${'S/D'.padStart(5)} ${'WR%'.padStart(6)} ${'PF'.padStart(6)} ${'PnL$'.padStart(10)} ${'DD%'.padStart(6)} ${'AvgW$'.padStart(8)} ${'AvgL$'.padStart(8)}`);
  console.log(`  ${'─'.repeat(90)}`);

  const results = [];

  for(const cfg of cfgVariations) {
    const lev = leverageOverride || cfg.leverage || 5;
    const notional = TRADE_AMT * lev;
    const feePct = 0.0004; // taker
    const slipPct = 0.0001; // 0.01% = realistic for BTC

    // Determine which TF to iterate
    const entryTF = cfg.entryTF || '1h';
    const kl = entryTF === '15m' ? data.kl15 : entryTF === '4h' ? data.kl4h : data.kl1h;
    if(!kl || kl.length < 100) continue;

    let trades=0,wins=0,losses=0,pnl=0,gP=0,gL=0;
    let cW=0,cL=0,mCW=0,mCL=0,bal=0,peak=0,maxDD=0;
    let lastSigTime=0;
    const cdMs = (cfg.cooldownH || 4) * 3600000;

    for(let i=60; i<kl.length-2; i++){
      const bt=parseInt(kl[i][0]);
      if(bt-lastSigTime<cdMs) continue;

      // Slice data up to current bar (no look-ahead)
      const kl1hSlice = data.kl1h.filter(k=>parseInt(k[0])<=bt).slice(-100);
      const kl4hSlice = data.kl4h.filter(k=>parseInt(k[0])<=bt).slice(-100);
      const kl15Slice = data.kl15.filter(k=>parseInt(k[0])<=bt).slice(-100);

      let sig;
      if(entryTF === '15m') {
        sig = stratFn(kl15Slice, kl1hSlice, kl4hSlice, cfg);
      } else {
        sig = stratFn(kl1hSlice, kl4hSlice, cfg);
      }
      if(!sig) continue;
      lastSigTime=bt;

      // Delayed entry: next bar open + slippage
      const dBar=kl[i+1];
      if(!dBar)continue;
      const dOpen=parseFloat(dBar[1]);
      const slipDir=sig.signal==='BUY'?1:-1;
      const actualEntry=dOpen*(1+slipDir*slipPct);

      // Recalculate TP/SL from actual entry
      let tp,sl;
      if(sig.signal==='BUY'){tp=actualEntry+sig.tpDist;sl=actualEntry-sig.slDist;}
      else{tp=actualEntry-sig.tpDist;sl=actualEntry+sig.slDist;}

      // Walk forward
      const result = walkForwardEval({entryBar:i}, kl, sig.signal, tp, sl, 1);
      if(!result) continue;

      const pct=sig.signal==='BUY'?(result.ep-actualEntry)/actualEntry:(actualEntry-result.ep)/actualEntry;
      const gross=notional*pct;
      const fee=notional*feePct*2;
      const net=gross-fee;

      trades++;pnl+=net;bal+=net;
      if(net>0){wins++;gP+=net;cW++;cL=0;if(cW>mCW)mCW=cW;}
      else{losses++;gL+=Math.abs(net);cL++;cW=0;if(cL>mCL)mCL=cL;}
      if(bal>peak)peak=bal;
      const dd=peak>0?(peak-bal)/peak*100:0;if(dd>maxDD)maxDD=dd;
    }

    const wr=trades>0?wins/trades*100:0;
    const pf=gL>0?gP/gL:0;
    const star=pf>=1.5&&wr>=50?'★★★':pf>=1.3&&wr>=45?'★★':pf>=1.1&&pnl>0?'★':'';
    console.log(`  ${cfg.name.padEnd(25)} ${String(lev).padStart(3)}x ${String(trades).padStart(5)} ${(trades/DAYS).toFixed(1).padStart(5)} ${wr.toFixed(1).padStart(5)}% ${pf.toFixed(2).padStart(6)} ${((pnl>=0?'+':'')+pnl.toFixed(0)).padStart(10)} ${maxDD.toFixed(1).padStart(5)}% ${(wins>0?gP/wins:0).toFixed(1).padStart(8)} ${(losses>0?gL/losses:0).toFixed(1).padStart(8)} ${star}`);
    results.push({name:cfg.name,lev,trades,wr,pf,pnl,maxDD,avgW:wins>0?gP/wins:0,avgL:losses>0?gL/losses:0,star});
  }

  return results;
}

// ═══ MAIN ═══
(async()=>{
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  BINANCE PRECISION — 5 STRATEGY FAMILIES                ║');
  console.log('║  120 DAYS BTCUSDT FUTURES | Real fees+slip+delay        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`\n  Downloading ${DAYS} days of BTCUSDT data from Binance Futures...\n`);

  const et=Date.now(),st=et-DAYS*86400000;
  const data={kl15:[],kl1h:[],kl4h:[]};

  // Download 15m
  process.stdout.write('  15m: ');
  let fe=et;
  while(true){const b=await getFK(SYMBOL,'15m',1000,fe);if(!b||!b.length)break;data.kl15=b.concat(data.kl15);if(b[0][0]<=st)break;fe=b[0][0]-1;await new Promise(r=>setTimeout(r,100));}
  console.log(data.kl15.length + ' bars');

  // Download 1h
  process.stdout.write('  1h: ');
  fe=et;
  while(true){const b=await getFK(SYMBOL,'1h',1000,fe);if(!b||!b.length)break;data.kl1h=b.concat(data.kl1h);if(b[0][0]<=st)break;fe=b[0][0]-1;await new Promise(r=>setTimeout(r,100));}
  console.log(data.kl1h.length + ' bars');

  // Download 4h
  process.stdout.write('  4h: ');
  fe=et;
  while(true){const b=await getFK(SYMBOL,'4h',1000,fe);if(!b||!b.length)break;data.kl4h=b.concat(data.kl4h);if(b[0][0]<=st)break;fe=b[0][0]-1;await new Promise(r=>setTimeout(r,100));}
  console.log(data.kl4h.length + ' bars');

  const allResults = [];

  // ═══ STRATEGY 1: TREND FOLLOWING + PULLBACK ═══
  const s1cfgs = [
    {name:'TF-PB-3x-ADX20',tpMult:3.0,slMult:1.0,adxMin:20,pullbackZone:0.003,volMin:0.8,cooldownH:6},
    {name:'TF-PB-3x-ADX25',tpMult:3.0,slMult:1.0,adxMin:25,pullbackZone:0.004,volMin:0.8,cooldownH:6},
    {name:'TF-PB-2x-ADX20',tpMult:2.0,slMult:0.8,adxMin:20,pullbackZone:0.003,volMin:0.8,cooldownH:4},
    {name:'TF-PB-4x-ADX25',tpMult:4.0,slMult:1.2,adxMin:25,pullbackZone:0.005,volMin:1.0,cooldownH:8},
    {name:'TF-PB-2.5x-ADX18',tpMult:2.5,slMult:1.0,adxMin:18,pullbackZone:0.004,volMin:0.7,cooldownH:4},
  ];
  for(const lev of [5,10,20]){
    allResults.push(...await runStrategy('TREND FOLLOWING + PULLBACK (lev:'+lev+'x)', strategy1, s1cfgs, data, lev));
  }

  // ═══ STRATEGY 2: MEAN REVERSION ═══
  const s2cfgs = [
    {name:'MR-RSI25-Vol1.5',rsiExtreme:25,volSpike:1.5,slMult:1.5,cooldownH:8},
    {name:'MR-RSI30-Vol1.3',rsiExtreme:30,volSpike:1.3,slMult:1.2,cooldownH:6},
    {name:'MR-RSI25-Vol2.0',rsiExtreme:25,volSpike:2.0,slMult:1.0,cooldownH:12},
    {name:'MR-RSI20-Vol1.5',rsiExtreme:20,volSpike:1.5,slMult:1.5,cooldownH:12},
  ];
  for(const lev of [5,10,20]){
    allResults.push(...await runStrategy('MEAN REVERSION (lev:'+lev+'x)', strategy2, s2cfgs, data, lev));
  }

  // ═══ STRATEGY 3: BREAKOUT ═══
  const s3cfgs = [
    {name:'BO-Range1.5-ADX20',rangeProject:1.5,slMult:0.8,adxMin:20,squeezeThresh:0.9,volBreakout:1.5,cooldownH:8},
    {name:'BO-Range2.0-ADX25',rangeProject:2.0,slMult:1.0,adxMin:25,squeezeThresh:0.85,volBreakout:1.3,cooldownH:6},
    {name:'BO-Range1.0-ADX15',rangeProject:1.0,slMult:0.6,adxMin:15,squeezeThresh:0.9,volBreakout:1.2,cooldownH:4},
  ];
  for(const lev of [5,10,20]){
    allResults.push(...await runStrategy('BREAKOUT (lev:'+lev+'x)', strategy3, s3cfgs, data, lev));
  }

  // ═══ STRATEGY 4: MOMENTUM ═══
  const s4cfgs = [
    {name:'MOM-3x-ADX25-Vol',tpMult:3.0,slMult:1.0,adxStrong:25,reqVolIncrease:true,cooldownH:6},
    {name:'MOM-2x-ADX20-Vol',tpMult:2.0,slMult:0.8,adxStrong:20,reqVolIncrease:true,cooldownH:4},
    {name:'MOM-4x-ADX30',tpMult:4.0,slMult:1.2,adxStrong:30,reqVolIncrease:false,cooldownH:8},
    {name:'MOM-2.5x-ADX22',tpMult:2.5,slMult:1.0,adxStrong:22,reqVolIncrease:true,cooldownH:6},
  ];
  for(const lev of [5,10,20]){
    allResults.push(...await runStrategy('MOMENTUM (lev:'+lev+'x)', strategy4, s4cfgs, data, lev));
  }

  // ═══ STRATEGY 5: MULTI-TF CONFLUENCE ═══
  const s5cfgs = [
    {name:'MTF-3x-Fib-Vol',entryTF:'15m',tpMult:3.0,slMult:1.0,fibExtTP:0.618,volMin:0.8,reqFibZone:true,cooldownH:6},
    {name:'MTF-2x-NoFib-Vol',entryTF:'15m',tpMult:2.0,slMult:0.8,fibExtTP:0.5,volMin:0.8,reqFibZone:false,cooldownH:4},
    {name:'MTF-4x-Fib-Vol1.2',entryTF:'15m',tpMult:4.0,slMult:1.2,fibExtTP:1.0,volMin:1.2,reqFibZone:true,cooldownH:8},
    {name:'MTF-2.5x-Fib',entryTF:'15m',tpMult:2.5,slMult:1.0,fibExtTP:0.618,volMin:0.7,reqFibZone:true,cooldownH:4},
  ];
  for(const lev of [5,10,20]){
    allResults.push(...await runStrategy('MULTI-TF CONFLUENCE (lev:'+lev+'x)', strategy5, s5cfgs, data, lev));
  }

  // ═══ FINAL RESULTS ═══
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  OVERALL TOP 10 (sorted by PnL)');
  console.log(`${'═'.repeat(60)}`);
  const top = allResults.filter(r=>r.trades>=10).sort((a,b)=>b.pnl-a.pnl);
  top.slice(0,10).forEach((r,i)=>{
    console.log(`  ${(i+1)+'.'.padEnd(4)} ${r.name.padEnd(25)} ${String(r.lev).padStart(3)}x | $${r.pnl.toFixed(0).padStart(8)} | WR:${r.wr.toFixed(1)}% PF:${r.pf.toFixed(2)} | ${r.trades}t DD:${r.maxDD.toFixed(1)}% | W:$${r.avgW.toFixed(0)} L:$${r.avgL.toFixed(0)} ${r.star}`);
  });

  const target=allResults.find(r=>r.pf>=1.5&&r.wr>=50&&r.pnl>0);
  if(target) console.log(`\n  ★★★ TARGET MET: ${target.name} at ${target.lev}x — $${target.pnl.toFixed(0)}, PF ${target.pf.toFixed(2)}, WR ${target.wr.toFixed(1)}%`);

  console.log(`\n  Total configs tested: ${allResults.length}`);
  console.log(`  Profitable: ${allResults.filter(r=>r.pnl>0).length}`);
  console.log(`  PF > 1.3: ${allResults.filter(r=>r.pf>1.3).length}`);
  console.log(`  WR > 50%: ${allResults.filter(r=>r.wr>50).length}`);
  console.log('');
})();
