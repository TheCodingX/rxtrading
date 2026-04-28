#!/usr/bin/env node
'use strict';
/**
 * ROUND 7 — MULTI-TIMEFRAME SIGNAL MULTIPLICATION
 *
 * KEY INSIGHT: Run the SAME high-PF strategy on MULTIPLE timeframes simultaneously.
 * Each timeframe generates INDEPENDENT signals (a 15m divergence != a 1h divergence).
 *
 * Strategy A: Contrarian Divergence on 15m, 1h, 4h
 * Strategy B: Volatility Breakout on 5m, 15m, 1h
 * Strategy C: Momentum Thrust (ADX) on 15m, 1h
 *
 * Target: PF >= 1.5 AND 13+ trades/day across 7 pairs
 * $500 capital, 5x leverage, real fees, 120 days
 */

const https = require('https');

// ═══ CONFIG ═══
const CAP0 = 500, LEV = 5, POS = CAP0 * LEV;
const FEE_M = 0.0002, FEE_T = 0.0005, SLIP = 0.0003;
const DAYS = 120, MAX_POS = 5, MAX_SAME_DIR = 3;
const FILL_RATE = 0.80, FUNDING_8H = 0.0001;
const PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT'];

// ═══ INDICATORS ═══
function emaA(d,p){if(!d.length)return[];const k=2/(p+1),r=[d[0]];for(let i=1;i<d.length;i++)r.push(d[i]*k+r[i-1]*(1-k));return r;}
function smaA(d,p){const r=[];let s=0;for(let i=0;i<d.length;i++){s+=d[i];if(i>=p)s-=d[i-p];r.push(i>=p-1?s/p:s/(i+1));}return r;}
function rsiA(c,p=14){if(c.length<p+1)return c.map(()=>50);const r=new Float64Array(c.length);let ag=0,al=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>0)ag+=d;else al-=d;}ag/=p;al/=p;for(let i=0;i<p;i++)r[i]=50;r[p]=al<1e-10?100:100-100/(1+ag/al);for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al<1e-10?100:100-100/(1+ag/al);}return r;}
function macdA(c){const e12=emaA(c,12),e26=emaA(c,26);const ml=e12.map((v,i)=>v-e26[i]);const s=emaA(ml,9);return{line:ml,signal:s,hist:ml.map((v,i)=>v-s[i])};}
function bbA(c,p=20,mult=2){const mid=smaA(c,p),u=[],lo=[],w=[];for(let i=0;i<c.length;i++){if(i<p-1){u.push(c[i]);lo.push(c[i]);w.push(0);continue;}let s=0;for(let j=i-p+1;j<=i;j++)s+=(c[j]-mid[i])**2;const sd=Math.sqrt(s/p);u.push(mid[i]+mult*sd);lo.push(mid[i]-mult*sd);w.push(mid[i]>0?(2*mult*sd)/mid[i]:0);}return{mid,upper:u,lower:lo,width:w};}
function atrA(h,l,c,p=14){const r=new Float64Array(h.length),tr=new Float64Array(h.length);tr[0]=h[0]-l[0];for(let i=1;i<h.length;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));let s=0;for(let i=0;i<Math.min(p,tr.length);i++)s+=tr[i];if(p<=tr.length)r[p-1]=s/p;for(let i=p;i<tr.length;i++)r[i]=(r[i-1]*(p-1)+tr[i])/p;return r;}
function adxA(h,l,c,p=14){const n=h.length,adx=new Float64Array(n),pdi=new Float64Array(n),ndi=new Float64Array(n);if(n<p*2+1)return{adx,pdi,ndi};const pdm=new Float64Array(n),ndm=new Float64Array(n),tr=new Float64Array(n);for(let i=1;i<n;i++){const u=h[i]-h[i-1],d=l[i-1]-l[i];pdm[i]=u>d&&u>0?u:0;ndm[i]=d>u&&d>0?d:0;tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));}let smTR=0,smP=0,smN=0;for(let i=1;i<=p;i++){smTR+=tr[i];smP+=pdm[i];smN+=ndm[i];}const dx=new Float64Array(n);for(let i=p;i<n;i++){if(i>p){smTR=smTR-smTR/p+tr[i];smP=smP-smP/p+pdm[i];smN=smN-smN/p+ndm[i];}pdi[i]=smTR>0?smP/smTR*100:0;ndi[i]=smTR>0?smN/smTR*100:0;const s=pdi[i]+ndi[i];dx[i]=s>0?Math.abs(pdi[i]-ndi[i])/s*100:0;}let as=0;for(let i=p;i<2*p;i++)as+=dx[i];as/=p;adx[2*p-1]=as;for(let i=2*p;i<n;i++){as=(as*(p-1)+dx[i])/p;adx[i]=as;}return{adx,pdi,ndi};}
function stochA(h,l,c,kp=5,dp=3){const k=new Float64Array(c.length);for(let i=kp-1;i<c.length;i++){let hh=-Infinity,ll=Infinity;for(let j=i-kp+1;j<=i;j++){hh=Math.max(hh,h[j]);ll=Math.min(ll,l[j]);}k[i]=hh===ll?50:(c[i]-ll)/(hh-ll)*100;}const d=smaA(Array.from(k),dp);return{k,d:Float64Array.from(d)};}

// ═══ DATA FETCHING ═══
function fetchJ(url){return new Promise((res,rej)=>{const req=https.get(url,{timeout:30000},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});});req.on('error',rej);req.on('timeout',()=>{req.destroy();rej(new Error('TO'));});});}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function dlCandles(sym,itv,total){
  const all=[];let end=Date.now();
  while(all.length<total){
    const lim=Math.min(1000,total-all.length);
    const url=`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${itv}&limit=${lim}&endTime=${end}`;
    let d,t=5;
    while(t>0){try{d=await fetchJ(url);break;}catch(e){t--;if(!t)throw e;await sleep(3000+Math.random()*2000);}}
    if(!d||!d.length)break;
    all.unshift(...d.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})));
    end=d[0][0]-1;await sleep(200);
  }
  return all.slice(-total);
}

let DATA_CACHE = null;
async function loadAllData(){
  if(DATA_CACHE) return DATA_CACHE;
  const D={};
  const n5=Math.ceil(DAYS*24*12*1.05),n15=Math.ceil(DAYS*24*4*1.05),n1h=Math.ceil(DAYS*24*1.05),n4h=Math.ceil(DAYS*6*1.05);
  for(const sym of PAIRS){
    process.stdout.write(`  ${sym}...`);
    const k5m=await dlCandles(sym,'5m',n5);
    const k15m=await dlCandles(sym,'15m',n15);
    const k1h=await dlCandles(sym,'1h',n1h);
    const k4h=await dlCandles(sym,'4h',n4h);
    D[sym]={k5m,k15m,k1h,k4h};
    console.log(` ${k5m.length}x5m ${k15m.length}x15m ${k1h.length}x1h ${k4h.length}x4h`);
  }
  DATA_CACHE=D;return D;
}

// ═══ PRECOMPUTE ═══
function precompute(k){
  const c=k.map(x=>x.c),h=k.map(x=>x.h),l=k.map(x=>x.l),v=k.map(x=>x.v),o=k.map(x=>x.o);
  return{c,h,l,v,o,rsi:rsiA(c),macd:macdA(c),bb:bbA(c,20,2),bb25:bbA(c,20,2.5),e9:emaA(c,9),e21:emaA(c,21),e50:emaA(c,50),atr:atrA(h,l,c,14),...adxA(h,l,c,14),vSma:smaA(v,20),stoch:stochA(h,l,c,5,3)};
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY A: CONTRARIAN DIVERGENCE — relaxed for more signals
// ═══════════════════════════════════════════════════════════════════════════════
function stratContrarian(ind,tf,cfg){
  const{c,h,l,v,o,rsi,vSma}=ind;
  const{slPct,tpPct,volMult=1.0,rsiOB=65,rsiOS=35,divLB=8}=cfg;
  const sigs=[];
  for(let i=Math.max(30,divLB+2);i<c.length-1;i++){
    if(isNaN(rsi[i])||isNaN(rsi[i-divLB]))continue;
    // Volume filter (relaxed)
    if(volMult>1.0&&vSma[i]>0&&v[i]<vSma[i]*volMult)continue;

    // Check MULTIPLE lookbacks for divergence (more signals)
    let bullDiv=false, bearDiv=false;
    for(let lb=divLB;lb<=divLB+4&&lb<i;lb+=2){
      if(i-lb<0)continue;
      // Bullish: price lower low, RSI higher low
      if(l[i]<l[i-lb]&&rsi[i]>rsi[i-lb]+2&&rsi[i]<rsiOS) bullDiv=true;
      // Bearish: price higher high, RSI lower high
      if(h[i]>h[i-lb]&&rsi[i]<rsi[i-lb]-2&&rsi[i]>rsiOB) bearDiv=true;
    }

    let dir=null;
    if(bullDiv&&c[i]>=o[i]) dir='BUY';  // bullish candle confirm
    if(bearDiv&&c[i]<=o[i]) dir='SELL'; // bearish candle confirm
    if(!dir)continue;

    sigs.push({dir,barIdx:i,tf,strat:'A_CONTRA',slPct,tpPct,time:0,pair:null});
  }
  return sigs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY B: VOLATILITY BREAKOUT — BB squeeze then breakout
// ═══════════════════════════════════════════════════════════════════════════════
function stratVolBreakout(ind,tf,cfg){
  const{c,h,l,v,o,bb,e21,macd,vSma}=ind;
  const{slPct,tpPct,volMult=1.2,sqBars=6,sqPct=0.12}=cfg;
  const sigs=[];
  for(let i=105;i<c.length-1;i++){
    if(isNaN(bb.width[i]))continue;
    // BB width percentile check
    const widths=[];
    for(let j=i-99;j<=i;j++){if(j>=0&&!isNaN(bb.width[j]))widths.push(bb.width[j]);}
    if(widths.length<50)continue;
    widths.sort((a,b)=>a-b);
    const th=widths[Math.floor(widths.length*sqPct)];
    if(bb.width[i]>th)continue;
    // Squeeze duration
    let dur=0;for(let j=i;j>=Math.max(i-40,0);j--){if(!isNaN(bb.width[j])&&bb.width[j]<=th)dur++;else break;}
    if(dur<sqBars)continue;
    // Breakout: close crosses BB
    const bUp=c[i]>bb.upper[i]&&c[i-1]<=bb.upper[i-1];
    const bDn=c[i]<bb.lower[i]&&c[i-1]>=bb.lower[i-1];
    if(!bUp&&!bDn)continue;
    // Volume
    if(volMult>1.0&&vSma[i]>0&&v[i]<vSma[i]*volMult)continue;
    // Direction confirmation (relaxed: just MACD hist direction)
    let dir=null;
    if(bUp&&macd.hist[i]>0) dir='BUY';
    if(bDn&&macd.hist[i]<0) dir='SELL';
    if(!dir)continue;
    sigs.push({dir,barIdx:i,tf,strat:'B_VOLBR',slPct,tpPct,time:0,pair:null});
  }
  return sigs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY C: MOMENTUM THRUST — ADX cross + DI + EMA
// ═══════════════════════════════════════════════════════════════════════════════
function stratMomentumThrust(ind,tf,cfg){
  const{c,v,vSma,adx,pdi,ndi,e9,e21}=ind;
  const{slPct,tpPct,volMult=1.0,adxTh=20}=cfg;
  const sigs=[];
  for(let i=35;i<c.length-1;i++){
    if(isNaN(adx[i])||adx[i]===0||isNaN(adx[i-1]))continue;
    // ADX cross above threshold OR ADX rising above threshold
    const cross=adx[i-1]<adxTh&&adx[i]>=adxTh;
    const rising=adx[i]>=adxTh&&adx[i]>adx[i-1]&&(i>=2?adx[i-1]>adx[i-2]:true);
    if(!cross&&!rising)continue;
    // Volume
    if(volMult>1.0&&vSma[i]>0&&v[i]<vSma[i]*volMult)continue;
    // Direction
    let dir=null;
    if(pdi[i]>ndi[i]&&e9[i]>e21[i]) dir='BUY';
    if(ndi[i]>pdi[i]&&e9[i]<e21[i]) dir='SELL';
    if(!dir)continue;
    sigs.push({dir,barIdx:i,tf,strat:'C_MOMTH',slPct,tpPct,time:0,pair:null});
  }
  return sigs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY D: RSI MEAN REVERSION — Stochastic + RSI extremes at BB bands
// (Additional strategy to boost frequency)
// ═══════════════════════════════════════════════════════════════════════════════
function stratMeanRev(ind,tf,cfg){
  const{c,h,l,v,o,rsi,bb25,vSma,stoch}=ind;
  const{slPct,tpPct,volMult=1.0,rsiTh=25}=cfg;
  const sigs=[];
  for(let i=30;i<c.length-1;i++){
    if(isNaN(rsi[i])||isNaN(stoch.k[i]))continue;
    // Volume
    if(volMult>1.0&&vSma[i]>0&&v[i]<vSma[i]*volMult)continue;

    let dir=null;
    // LONG: RSI < threshold + stoch cross up from <20 + price at/below lower BB
    if(rsi[i]<rsiTh&&stoch.k[i]>stoch.d[i]&&stoch.k[i-1]<=stoch.d[i-1]&&
       c[i]<=bb25.lower[i]*1.002&&c[i]>o[i]) dir='BUY';
    // SHORT: RSI > (100-threshold) + stoch cross down from >80 + price at/above upper BB
    if(rsi[i]>(100-rsiTh)&&stoch.k[i]<stoch.d[i]&&stoch.k[i-1]>=stoch.d[i-1]&&
       c[i]>=bb25.upper[i]*0.998&&c[i]<o[i]) dir='SELL';
    if(!dir)continue;
    sigs.push({dir,barIdx:i,tf,strat:'D_MREV',slPct,tpPct,time:0,pair:null});
  }
  return sigs;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY E: EMA CROSS TREND — EMA9/21 cross with trend filter
// (High frequency, moderate quality)
// ═══════════════════════════════════════════════════════════════════════════════
function stratEmaCross(ind,tf,cfg){
  const{c,h,l,v,o,e9,e21,e50,adx,pdi,ndi,rsi,vSma}=ind;
  const{slPct,tpPct,volMult=1.0,adxMin=15}=cfg;
  const sigs=[];
  for(let i=55;i<c.length-1;i++){
    if(isNaN(adx[i])||isNaN(e50[i]))continue;
    // Need some trend (ADX > adxMin)
    if(adx[i]<adxMin)continue;
    // Volume
    if(volMult>1.0&&vSma[i]>0&&v[i]<vSma[i]*volMult)continue;

    let dir=null;
    // EMA9 crosses above EMA21, price above EMA50, RSI not overbought
    if(e9[i]>e21[i]&&e9[i-1]<=e21[i-1]&&c[i]>e50[i]&&rsi[i]<70&&rsi[i]>40) dir='BUY';
    // EMA9 crosses below EMA21, price below EMA50, RSI not oversold
    if(e9[i]<e21[i]&&e9[i-1]>=e21[i-1]&&c[i]<e50[i]&&rsi[i]>30&&rsi[i]<60) dir='SELL';
    if(!dir)continue;
    sigs.push({dir,barIdx:i,tf,strat:'E_EMAC',slPct,tpPct,time:0,pair:null});
  }
  return sigs;
}

// ═══ DEDUP ═══
const TF_PRI={'4h':4,'1h':3,'15m':2,'5m':1};
function dedup(sigs){
  sigs.sort((a,b)=>a.time-b.time||(TF_PRI[b.tf]||0)-(TF_PRI[a.tf]||0));
  const recent=[],kept=[];
  const WIN=2*3600000; // 2h dedup window
  for(const sig of sigs){
    while(recent.length>0&&sig.time-recent[0].time>WIN)recent.shift();
    // Same pair+direction+higher TF already exists -> skip
    const dominated=recent.find(r=>r.pair===sig.pair&&r.dir===sig.dir&&TF_PRI[r.tf]>=TF_PRI[sig.tf]);
    if(dominated)continue;
    // Remove lower TF signals this one dominates
    for(let j=recent.length-1;j>=0;j--){
      if(recent[j].pair===sig.pair&&recent[j].dir===sig.dir&&TF_PRI[recent[j].tf]<TF_PRI[sig.tf])recent.splice(j,1);
    }
    recent.push({pair:sig.pair,dir:sig.dir,time:sig.time,tf:sig.tf});
    kept.push(sig);
  }
  return kept;
}

// Binary search: find first index where k[idx].t >= target
function bsearch(k,target){
  let lo=0,hi=k.length-1;
  while(lo<hi){const m=(lo+hi)>>1;if(k[m].t<target)lo=m+1;else hi=m;}
  return lo<k.length&&k[lo].t>=target?lo:-1;
}
// Find first index where k[idx].t > target
function bsearchGT(k,target){
  let lo=0,hi=k.length-1;
  while(lo<hi){const m=(lo+hi)>>1;if(k[m].t<=target)lo=m+1;else hi=m;}
  return lo<k.length&&k[lo].t>target?lo:-1;
}

// ═══ SIMPLE TRADE SIMULATOR (per pair, sequential, no cross-pair position limits) ═══
function simTradesSimple(sigs,D){
  const trades=[];
  sigs.sort((a,b)=>a.time-b.time);
  const symCD={};

  for(const sig of sigs){
    const sym=sig.pair;
    const k5m=D[sym].k5m;
    const kTF=D[sym][`k${sig.tf}`];

    // Binary search for entry bar on signal TF
    const eIdx=bsearchGT(kTF,sig.time);
    if(eIdx<0||eIdx>=kTF.length)continue;

    const ep=kTF[eIdx].o,eTime=kTF[eIdx].t;
    if(symCD[sym]&&eTime<symCD[sym])continue;
    if(Math.random()>FILL_RATE)continue;

    const isBuy=sig.dir==='BUY';
    const slP=isBuy?ep*(1-sig.slPct):ep*(1+sig.slPct);
    const tpP=isBuy?ep*(1+sig.tpPct):ep*(1-sig.tpPct);
    const tfMs=sig.tf==='4h'?14400000:sig.tf==='1h'?3600000:sig.tf==='15m'?900000:300000;
    const maxMs=tfMs*200;

    // Binary search for 5m start
    const s5=bsearch(k5m,eTime);
    if(s5<0)continue;

    let exitP=0,exitR='',exitT=0;
    for(let j=s5+1;j<k5m.length;j++){
      const b=k5m[j];
      if(b.t-eTime>maxMs){exitP=b.c;exitR='TO';exitT=b.t;break;}
      const slH=isBuy?b.l<=slP:b.h>=slP;
      const tpH=isBuy?b.h>=tpP:b.l<=tpP;
      if(slH&&tpH){exitP=slP;exitR='SL';exitT=b.t;break;}
      if(slH){exitP=isBuy?Math.min(slP,b.o):Math.max(slP,b.o);exitR='SL';exitT=b.t;break;}
      if(tpH){exitP=tpP;exitR='TP';exitT=b.t;break;}
    }
    if(!exitP)continue;

    const raw=isBuy?exitP-ep:ep-exitP;
    const eC=POS*FEE_M,xC=exitR==='SL'?POS*FEE_T:POS*FEE_M;
    const slipC=exitR==='SL'?POS*SLIP:0;
    const hH=(exitT-eTime)/3600000;
    const fC=hH>8?Math.floor(hH/8)*POS*FUNDING_8H:0;
    const pnl=(raw/ep)*POS-eC-xC-slipC-fC;

    symCD[sym]=exitT+tfMs*2;
    trades.push({sym,dir:sig.dir,strat:sig.strat,tf:sig.tf,pnl,reason:exitR,
      entryPrice:ep,exitPrice:exitP,entryTime:eTime,exitTime:exitT,holdHours:hH});
  }
  return trades;
}

// ═══ COMBINED SIMULATOR with position limits ═══
function simTradesCombined(sigs,D){
  const trades=[];
  sigs.sort((a,b)=>a.time-b.time);
  const symCD={};
  let active=[]; // {dir, exitTime}
  let dailyLoss=0,curDay=-1;

  for(const sig of sigs){
    const sym=sig.pair;
    const k5m=D[sym].k5m;
    const kTF=D[sym][`k${sig.tf}`];

    const eIdx=bsearchGT(kTF,sig.time);
    if(eIdx<0||eIdx>=kTF.length)continue;

    const ep=kTF[eIdx].o,eTime=kTF[eIdx].t;
    if(symCD[sym]&&eTime<symCD[sym])continue;
    if(Math.random()>FILL_RATE)continue;

    // Daily loss
    const day=Math.floor(eTime/86400000);
    if(day!==curDay){dailyLoss=0;curDay=day;}
    if(dailyLoss>=CAP0*0.06)continue;

    // Position limits
    active=active.filter(p=>p.exitTime>eTime);
    if(active.length>=MAX_POS)continue;
    const sd=active.filter(p=>p.dir===sig.dir).length;
    if(sd>=MAX_SAME_DIR)continue;

    const isBuy=sig.dir==='BUY';
    const slP=isBuy?ep*(1-sig.slPct):ep*(1+sig.slPct);
    const tpP=isBuy?ep*(1+sig.tpPct):ep*(1-sig.tpPct);
    const tfMs=sig.tf==='4h'?14400000:sig.tf==='1h'?3600000:sig.tf==='15m'?900000:300000;
    const maxMs=tfMs*200;

    const s5=bsearch(k5m,eTime);
    if(s5<0)continue;

    let exitP=0,exitR='',exitT=0;
    for(let j=s5+1;j<k5m.length;j++){
      const b=k5m[j];
      if(b.t-eTime>maxMs){exitP=b.c;exitR='TO';exitT=b.t;break;}
      const slH=isBuy?b.l<=slP:b.h>=slP;
      const tpH=isBuy?b.h>=tpP:b.l<=tpP;
      if(slH&&tpH){exitP=slP;exitR='SL';exitT=b.t;break;}
      if(slH){exitP=isBuy?Math.min(slP,b.o):Math.max(slP,b.o);exitR='SL';exitT=b.t;break;}
      if(tpH){exitP=tpP;exitR='TP';exitT=b.t;break;}
    }
    if(!exitP)continue;

    const raw=isBuy?exitP-ep:ep-exitP;
    const pnl=(raw/ep)*POS-POS*FEE_M-(exitR==='SL'?POS*FEE_T:POS*FEE_M)-(exitR==='SL'?POS*SLIP:0);
    const hH=(exitT-eTime)/3600000;
    const fC=hH>8?Math.floor(hH/8)*POS*FUNDING_8H:0;
    const netPnl=pnl-fC;

    if(netPnl<0)dailyLoss+=Math.abs(netPnl);
    symCD[sym]=exitT+tfMs; // shorter cooldown: 1 bar
    active.push({dir:sig.dir,exitTime:exitT});
    trades.push({sym,dir:sig.dir,strat:sig.strat,tf:sig.tf,pnl:netPnl,reason:exitR,
      entryPrice:ep,exitPrice:exitP,entryTime:eTime,exitTime:exitT,holdHours:hH});
  }
  return trades;
}

// ═══ METRICS ═══
function met(trades,label){
  if(!trades.length)return{label,pnl:0,pf:0,wr:0,n:0,tpd:0,mddPct:0};
  const w=trades.filter(t=>t.pnl>0),lo=trades.filter(t=>t.pnl<=0);
  const pnl=trades.reduce((s,t)=>s+t.pnl,0);
  const gw=w.reduce((s,t)=>s+t.pnl,0),gl=Math.abs(lo.reduce((s,t)=>s+t.pnl,0));
  const pf=gl>0?gw/gl:gw>0?99:0;
  const wr=w.length/trades.length*100;
  let cum=0,pk=0,mdd=0;
  for(const t of trades){cum+=t.pnl;pk=Math.max(pk,cum);mdd=Math.max(mdd,pk-cum);}
  return{label,pnl,pf,wr,n:trades.length,tpd:trades.length/DAYS,mddPct:mdd/CAP0*100};
}

function row(m){
  return`  ${m.label.padEnd(24)}${m.pf.toFixed(2).padStart(5)} ${(m.wr.toFixed(1)+'%').padStart(6)} ${m.tpd.toFixed(1).padStart(6)} ${'$'+m.pnl.toFixed(0).padStart(6)} ${(m.mddPct.toFixed(1)+'%').padStart(7)}`;
}

// ═══ MAIN ═══
async function main(){
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  ROUND 7 — MULTI-TIMEFRAME SIGNAL MULTIPLICATION');
  console.log('  Target: PF >= 1.5 AND 13+ trades/day');
  console.log('  $500 x 5x | 120 days | Real fees | 7 pairs');
  console.log('═══════════════════════════════════════════════════════════════════');

  console.log('\n[1/5] Downloading data (5m,15m,1h,4h x 7 pairs)...');
  const D=await loadAllData();

  console.log('\n[2/5] Precomputing indicators...');
  const I={};
  for(const sym of PAIRS){
    I[sym]={'5m':precompute(D[sym].k5m),'15m':precompute(D[sym].k15m),
            '1h':precompute(D[sym].k1h),'4h':precompute(D[sym].k4h)};
  }

  console.log('\n[3/5] Grid search (optimizing PF*sqrt(T/day) for balanced quality+frequency)...');

  // Generate signals for a strat×TF×config, return raw signals
  function genSigs(stratFn,tf,cfg){
    const sigs=[];
    for(const sym of PAIRS){
      const raw=stratFn(I[sym][tf],tf,cfg);
      const kTF=D[sym][`k${tf}`];
      for(const s of raw){s.pair=sym;s.time=kTF[s.barIdx].t;}
      sigs.push(...raw);
    }
    return sigs;
  }

  // Grid search: TWO modes
  // 1. Find best PF config (for quality)
  // 2. Find best T/day config with PF>1.0 (for frequency)
  // Return the one that maximizes PF * min(tpd, 5) (caps frequency benefit)
  function gridSearch(stratFn,sName,tf,combos){
    let bestScore=-Infinity,bestCfg=null,bestM=null;
    for(const cfg of combos){
      const sigs=genSigs(stratFn,tf,cfg);
      if(!sigs.length)continue;
      const trades=simTradesSimple(sigs,D);
      const m=met(trades,`${sName}_${tf}`);
      if(m.n<5||m.pf<1.0)continue; // REQUIRE profitable
      // Score: PF * ln(1+tpd) — rewards frequency with diminishing returns
      const score=m.pf*Math.log(1+m.tpd);
      if(score>bestScore){bestScore=score;bestCfg=cfg;bestM=m;}
    }
    return{cfg:bestCfg,m:bestM||met([],`${sName}_${tf}`)};
  }

  // ─── Build grids ───
  function makeGridA(tf){
    const combos=[];
    const slVals=tf==='4h'?[0.025,0.030,0.040]:tf==='1h'?[0.012,0.018,0.025]:
                 [0.006,0.008,0.012];
    const tpVals=tf==='4h'?[0.06,0.08,0.10]:tf==='1h'?[0.030,0.045,0.060]:
                 [0.015,0.025,0.035];
    const vols=tf==='4h'?[1.0]:tf==='1h'?[1.0,1.2]:[1.0,1.2];
    const obs=tf==='4h'?[55,60,65]:tf==='1h'?[60,65,70]:[60,65,70];
    const oss=tf==='4h'?[35,40,45]:tf==='1h'?[30,35,40]:[30,35,40];
    const lbs=[4,6,8,12];
    for(const sl of slVals)for(const tp of tpVals)for(const vol of vols)
      for(const ob of obs)for(const os of oss)for(const lb of lbs)
        combos.push({slPct:sl,tpPct:tp,volMult:vol,rsiOB:ob,rsiOS:os,divLB:lb});
    return combos;
  }

  function makeGridB(tf){
    const combos=[];
    const slVals=tf==='1h'?[0.015,0.020,0.025]:
                 [0.008,0.012,0.015];
    const tpVals=tf==='1h'?[0.04,0.06,0.08]:
                 [0.025,0.035,0.045];
    const vols=[1.0,1.3];
    const sqB=[5,8];
    const sqP=[0.10,0.15];
    for(const sl of slVals)for(const tp of tpVals)for(const vol of vols)
      for(const sb of sqB)for(const sp of sqP)
        combos.push({slPct:sl,tpPct:tp,volMult:vol,sqBars:sb,sqPct:sp});
    return combos;
  }

  function makeGridC(tf){
    const combos=[];
    const slVals=tf==='1h'?[0.012,0.018,0.025]:
                 [0.006,0.010,0.014];
    const tpVals=tf==='1h'?[0.03,0.045,0.06]:
                 [0.015,0.025,0.035];
    const vols=[1.0,1.2];
    const ths=tf==='1h'?[18,20,22,25]:[15,18,20,22];
    for(const sl of slVals)for(const tp of tpVals)for(const vol of vols)
      for(const th of ths)
        combos.push({slPct:sl,tpPct:tp,volMult:vol,adxTh:th});
    return combos;
  }

  function makeGridD(tf){
    const combos=[];
    const slVals=tf==='1h'?[0.012,0.018,0.025]:tf==='15m'?[0.008,0.012]:
                 [0.004,0.007];
    const tpVals=tf==='1h'?[0.03,0.05]:tf==='15m'?[0.020,0.030]:
                 [0.012,0.020];
    const vols=[1.0,1.2];
    const rsiThs=[20,25,30,35];
    for(const sl of slVals)for(const tp of tpVals)for(const vol of vols)
      for(const rt of rsiThs)
        combos.push({slPct:sl,tpPct:tp,volMult:vol,rsiTh:rt});
    return combos;
  }

  function makeGridE(tf){
    const combos=[];
    const slVals=tf==='1h'?[0.012,0.018,0.025]:tf==='15m'?[0.006,0.010,0.014]:
                 [0.004,0.006,0.009];
    const tpVals=tf==='1h'?[0.03,0.05,0.07]:tf==='15m'?[0.018,0.028,0.038]:
                 [0.012,0.018,0.025];
    const vols=[1.0,1.2];
    const adxMins=tf==='1h'?[15,20,25]:[12,15,18,20];
    for(const sl of slVals)for(const tp of tpVals)for(const vol of vols)
      for(const am of adxMins)
        combos.push({slPct:sl,tpPct:tp,volMult:vol,adxMin:am});
    return combos;
  }

  // Run all grid searches
  const allStrats=[
    {fn:stratContrarian,name:'A_CONTRA',tfs:['15m','1h','4h'],mkGrid:makeGridA},
    {fn:stratVolBreakout,name:'B_VOLBR',tfs:['15m','1h'],mkGrid:makeGridB},
    {fn:stratMomentumThrust,name:'C_MOMTH',tfs:['15m','1h'],mkGrid:makeGridC},
    {fn:stratMeanRev,name:'D_MREV',tfs:['15m','1h'],mkGrid:makeGridD},
    {fn:stratEmaCross,name:'E_EMAC',tfs:['15m','1h'],mkGrid:makeGridE},
  ];

  const bestCfgs={};
  const indivResults={};

  for(const st of allStrats){
    console.log(`\n  ${st.name}:`);
    for(const tf of st.tfs){
      const combos=st.mkGrid(tf);
      process.stdout.write(`    ${tf} (${combos.length} combos)...`);
      const{cfg,m}=gridSearch(st.fn,st.name,tf,combos);
      const key=`${st.name}_${tf}`;
      bestCfgs[key]=cfg;
      indivResults[key]=m;
      if(cfg)console.log(` PF:${m.pf.toFixed(2)} WR:${m.wr.toFixed(1)}% T/d:${m.tpd.toFixed(1)} PnL:$${m.pnl.toFixed(0)} SL:${(cfg.slPct*100).toFixed(1)}% TP:${(cfg.tpPct*100).toFixed(1)}%`);
      else console.log(' no valid config found');
    }
  }

  // ─── PRINT INDIVIDUAL RESULTS ───
  console.log('\n[4/5] Individual Results\n');
  console.log('  INDIVIDUAL STRATEGY x TIMEFRAME:');
  console.log('  '+'-'.repeat(66));
  console.log('  Strategy x TF              PF     WR     T/day    PnL   Max DD');
  console.log('  '+'-'.repeat(66));
  for(const key of Object.keys(indivResults).sort()){
    console.log(row(indivResults[key]));
  }
  console.log('  '+'-'.repeat(66));

  // ─── COMBINE with dedup ───
  console.log('\n[5/5] Combining all strategies with dedup...');

  // Generate all signals with best configs
  const allSigSets={};
  for(const key of Object.keys(bestCfgs)){
    if(!bestCfgs[key])continue;
    const parts=key.split('_');
    const tf=parts[parts.length-1];
    const sName=parts.slice(0,-1).join('_');
    const stDef=allStrats.find(s=>s.name===sName);
    if(!stDef)continue;
    allSigSets[key]=genSigs(stDef.fn,tf,bestCfgs[key]);
  }

  // Full combined
  let allSigs=[];
  for(const sigs of Object.values(allSigSets))allSigs.push(...sigs);
  console.log(`  Total raw signals: ${allSigs.length}`);
  const dd=dedup(allSigs);
  console.log(`  After dedup: ${dd.length}`);

  const combinedTrades=simTradesCombined(dd,D);
  const cm=met(combinedTrades,'COMBINED');

  console.log('\n  ═══════════════════════════════════════════════════════════════');
  console.log('  COMBINED (all strategies x all TFs with dedup):');
  console.log(`  PF: ${cm.pf.toFixed(2)} | WR: ${cm.wr.toFixed(1)}% | T/day: ${cm.tpd.toFixed(1)} | PnL: $${cm.pnl.toFixed(0)} | Max DD: ${cm.mddPct.toFixed(1)}%`);
  console.log('  ═══════════════════════════════════════════════════════════════');

  // Strat breakdown in combined
  const sb={};
  for(const t of combinedTrades){
    const k=`${t.strat}_${t.tf}`;
    if(!sb[k])sb[k]=[];
    sb[k].push(t);
  }
  console.log('\n  STRATEGY BREAKDOWN (within combined):');
  console.log('  Strategy x TF              PF     WR     T/day    PnL   Max DD');
  console.log('  '+'-'.repeat(66));
  for(const key of Object.keys(sb).sort()){console.log(row(met(sb[key],key)));}

  // Monthly
  const months={};
  for(const t of combinedTrades){
    const d=new Date(t.entryTime);
    const k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    if(!months[k])months[k]=[];months[k].push(t);
  }
  console.log('\n  MONTHLY BREAKDOWN:');
  console.log('  Month    | Trades | WR%   | PF    | PnL');
  console.log('  ---------|--------|-------|-------|----------');
  for(const mo of Object.keys(months).sort()){
    const m=met(months[mo],mo);
    console.log(`  ${mo}   | ${String(m.n).padStart(6)} | ${m.wr.toFixed(1).padStart(5)} | ${m.pf.toFixed(2).padStart(5)} | ${(m.pnl>=0?'+':'')}$${m.pnl.toFixed(2)}`);
  }

  // Per-pair
  const bp={};
  for(const t of combinedTrades){if(!bp[t.sym])bp[t.sym]=[];bp[t.sym].push(t);}
  console.log('\n  PER-PAIR BREAKDOWN:');
  console.log('  Pair       | Trades | WR%   | PF    | PnL');
  console.log('  -----------|--------|-------|-------|----------');
  for(const p of Object.keys(bp).sort()){
    const m=met(bp[p],p);
    console.log(`  ${p.padEnd(10)} | ${String(m.n).padStart(6)} | ${m.wr.toFixed(1).padStart(5)} | ${m.pf.toFixed(2).padStart(5)} | ${(m.pnl>=0?'+':'')}$${m.pnl.toFixed(2)}`);
  }

  // Exit reasons
  const er={};
  for(const t of combinedTrades){if(!er[t.reason])er[t.reason]=[];er[t.reason].push(t);}
  console.log('\n  EXIT REASONS:');
  for(const[r,tr]of Object.entries(er)){
    const m=met(tr,r);
    console.log(`  ${r}: ${m.n} trades, WR:${m.wr.toFixed(1)}%, PF:${m.pf.toFixed(2)}, PnL:$${m.pnl.toFixed(0)}`);
  }

  // ─── TARGET CHECK ───
  console.log('\n  ═══════════════════════════════════════════════════════════════');
  console.log('  TARGET CHECK:');
  console.log(`    PF >= 1.5:   ${cm.pf>=1.5?'YES':'NO'} (${cm.pf.toFixed(2)})`);
  console.log(`    T/day >= 13: ${cm.tpd>=13?'YES':'NO'} (${cm.tpd.toFixed(1)})`);
  console.log('  ═══════════════════════════════════════════════════════════════');

  // If not met, try subset combos
  if(cm.pf<1.5||cm.tpd<13){
    console.log('\n  ALTERNATIVE SEARCH: best combo for 13+ t/day...');

    // Only use profitable strat×TF combos
    const profitableKeys=Object.keys(allSigSets).filter(k=>{
      const m=indivResults[k];
      return m&&m.pf>=0.95; // include borderline ones too
    });
    console.log(`  Searching subsets of ${profitableKeys.length} profitable components...`);

    const keys=profitableKeys;
    let altBestPF=0,altBestM=null,altBestK=[];
    let maxTpd=0,maxTpdM=null,maxTpdK=[];
    let bestHigh=0,bestHighM=null,bestHighK=[];

    const totalMasks=1<<keys.length;
    for(let mask=1;mask<totalMasks;mask++){
      let sigs=[];
      const used=[];
      for(let b=0;b<keys.length;b++){
        if(mask&(1<<b)){sigs.push(...allSigSets[keys[b]]);used.push(keys[b]);}
      }
      const dd2=dedup(sigs);
      const tr=simTradesCombined(dd2,D);
      const m=met(tr,'');
      if(m.tpd>=13&&m.pf>altBestPF){altBestPF=m.pf;altBestM=m;altBestK=used;}
      if(m.tpd>maxTpd){maxTpd=m.tpd;maxTpdM=m;maxTpdK=used;}
      if(m.n>=20&&m.pf>bestHigh){bestHigh=m.pf;bestHighM=m;bestHighK=used;}
    }

    if(altBestM){
      console.log(`\n  BEST COMBO with 13+ t/day:`);
      console.log(`    Components: ${altBestK.join(' + ')}`);
      console.log(`    PF: ${altBestM.pf.toFixed(2)} | WR: ${altBestM.wr.toFixed(1)}% | T/day: ${altBestM.tpd.toFixed(1)} | PnL: $${altBestM.pnl.toFixed(0)} | DD: ${altBestM.mddPct.toFixed(1)}%`);
    }

    console.log(`\n  Highest T/day combo:`);
    if(maxTpdM)console.log(`    ${maxTpdK.join(' + ')}\n    PF:${maxTpdM.pf.toFixed(2)} T/d:${maxTpdM.tpd.toFixed(1)} PnL:$${maxTpdM.pnl.toFixed(0)}`);

    console.log(`\n  Highest PF combo (20+ trades):`);
    if(bestHighM)console.log(`    ${bestHighK.join(' + ')}\n    PF:${bestHighM.pf.toFixed(2)} T/d:${bestHighM.tpd.toFixed(1)} PnL:$${bestHighM.pnl.toFixed(0)}`);
  }

  console.log('\n  Done.');
}

main().catch(e=>{console.error('FATAL:',e);process.exit(1);});
