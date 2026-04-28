#!/usr/bin/env node
// 5-Dimensional Sequential Optimization of APEX F1 (RSI Divergence)
// ETHUSDT only, $500 capital, 5x leverage, 180d data (IS=120d, OOS=60d)
'use strict';
const https = require('https');

const DAYS = 180, IS_DAYS = 120;
const INIT_CAP = 500, LEV = 5, MAX_POS = 1, MAX_SAME_DIR = 1;
const FEE_MAKER = 0.0002, FEE_TAKER = 0.0005, SLIP_SL = 0.0003;
const TIMEOUT_BARS = 100, DAILY_LOSS_PCT = 0.06;

// ─── FETCH ───
function fetchJ(url){return new Promise((res,rej)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)));}).on('error',rej);});}
async function getKlines(sym,interval,days){
  const end=Date.now(),ms=days*86400000,lim=1500;let all=[],t=end-ms;
  while(t<end){const url=`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&startTime=${Math.floor(t)}&limit=${lim}`;
    const k=await fetchJ(url);if(!k.length)break;all=all.concat(k);t=parseInt(k[k.length-1][6])+1;await new Promise(r=>setTimeout(r,200));}
  return all;
}

// ─── INDICATORS ───
function sma(a,p){const r=[];for(let i=0;i<a.length;i++)r.push(i<p-1?NaN:a.slice(i-p+1,i+1).reduce((s,v)=>s+v)/p);return r;}
function ema(a,p){const r=[a[0]],m=2/(p+1);for(let i=1;i<a.length;i++)r.push(a[i]*m+r[i-1]*(1-m));return r;}
function rsi(c,p=14){const r=[NaN];let ag=0,al=0;
  for(let i=1;i<c.length;i++){const d=c[i]-c[i-1];if(i<=p){if(d>0)ag+=d;else al-=d;if(i===p){ag/=p;al/=p;r.push(al===0?100:100-100/(1+ag/al));}else r.push(NaN);}
  else{ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r.push(al===0?100:100-100/(1+ag/al));}}return r;}
function macd(c){const ef=ema(c,12),es=ema(c,26),line=ef.map((v,i)=>v-es[i]),signal=ema(line,9),hist=line.map((v,i)=>v-signal[i]);return{hist};}
function adx(hi,lo,cl,p=14){const tr=[0],pd=[0],nd=[0];
  for(let i=1;i<cl.length;i++){tr.push(Math.max(hi[i]-lo[i],Math.abs(hi[i]-cl[i-1]),Math.abs(lo[i]-cl[i-1])));
    const u=hi[i]-hi[i-1],d=lo[i-1]-lo[i];pd.push(u>d&&u>0?u:0);nd.push(d>u&&d>0?d:0);}
  const atr=ema(tr,p),spd=ema(pd,p),snd=ema(nd,p);
  const pdi=spd.map((v,i)=>atr[i]?v/atr[i]*100:0),ndi=snd.map((v,i)=>atr[i]?v/atr[i]*100:0);
  const dx=pdi.map((v,i)=>{const s=v+ndi[i];return s?Math.abs(v-ndi[i])/s*100:0;});
  return{adx:ema(dx,p),pdi,ndi,atr};}
function atrArr(hi,lo,cl,p=14){const tr=[0];for(let i=1;i<cl.length;i++)tr.push(Math.max(hi[i]-lo[i],Math.abs(hi[i]-cl[i-1]),Math.abs(lo[i]-cl[i-1])));return ema(tr,p);}
function volSma(v,p=20){return sma(v,p);}

// ─── HTF ───
function precomputeHTF(kl1h){
  if(!kl1h.length)return{closeTimes:[],trends:[]};
  const ct=kl1h.map(k=>parseInt(k[6])),cl=kl1h.map(k=>parseFloat(k[4]));
  const hi=kl1h.map(k=>parseFloat(k[2])),lo=kl1h.map(k=>parseFloat(k[3]));
  const e9=ema(cl,9),e21=ema(cl,21);
  const trends=e9.map((v,i)=>i<20?0:v>e21[i]?1:-1);
  // 15m gate: use 3x5m aggregation conceptually — we approximate from 1h
  return{closeTimes:ct,trends};
}
function htfTrend(htf,barTime){
  const ct=htf.closeTimes;let lo=0,hi=ct.length-1,idx=-1;
  while(lo<=hi){const mid=(lo+hi)>>1;if(ct[mid]<=barTime){idx=mid;lo=mid+1;}else hi=mid-1;}
  return idx<20?0:htf.trends[idx];
}

// ─── ENGINE (exact copy from backtest-apex-final.js) ───
function runEngine(kl5m,sigs,cfg={}){
  let capital=INIT_CAP,positions=[],trades=[],dailyPnl={},paused={};
  const cooldown=cfg.cooldown||0;let lastTradeBar=-Infinity;
  const getDay=t=>new Date(parseInt(t)).toISOString().slice(0,10);
  for(const sig of sigs){
    const entryBar=sig.bar+2;
    if(entryBar>=kl5m.length)continue;
    if(sig._seq%5===4)continue; // 80% fill rate
    if(cooldown>0 && entryBar-lastTradeBar<cooldown)continue;
    const day=getDay(kl5m[entryBar][0]);
    if(paused[day])continue;
    if(!dailyPnl[day])dailyPnl[day]=0;
    if(dailyPnl[day]<=-INIT_CAP*DAILY_LOSS_PCT){paused[day]=true;continue;}
    if(positions.length>=MAX_POS)continue;
    const sameDir=positions.filter(p=>p.dir===sig.dir).length;
    if(sameDir>=MAX_SAME_DIR)continue;
    const entryPrice=parseFloat(kl5m[entryBar][1]);
    const posSize=Math.min(INIT_CAP,capital*LEV);
    const qty=posSize/entryPrice;
    const entryCost=posSize*FEE_MAKER;
    const slPrice=sig.dir===1?entryPrice*(1-sig.sl):entryPrice*(1+sig.sl);
    const tpPrice=sig.dir===1?entryPrice*(1+sig.tp):entryPrice*(1-sig.tp);
    positions.push({dir:sig.dir,entry:entryPrice,sl:slPrice,tp:tpPrice,qty,cost:entryCost,bar:entryBar,day});
    let closed=false;
    for(let j=entryBar+1;j<kl5m.length&&j<=entryBar+TIMEOUT_BARS;j++){
      const h=parseFloat(kl5m[j][2]),l=parseFloat(kl5m[j][3]),c=parseFloat(kl5m[j][4]);
      let hitSL=false,hitTP=false;
      if(sig.dir===1){hitSL=l<=slPrice;hitTP=h>=tpPrice;}
      else{hitSL=h>=slPrice;hitTP=l<=tpPrice;}
      if(hitSL&&hitTP)hitTP=false;
      if(hitSL){
        const exitP=slPrice*(sig.dir===1?(1-SLIP_SL):(1+SLIP_SL));
        const pnl=sig.dir===1?(exitP-entryPrice)*qty:(entryPrice-exitP)*qty;
        const net=pnl-entryCost-posSize*FEE_TAKER;
        capital+=net;dailyPnl[day]=(dailyPnl[day]||0)+net;
        if(dailyPnl[day]<=-INIT_CAP*DAILY_LOSS_PCT)paused[day]=true;
        trades.push({dir:sig.dir,entry:entryPrice,exit:exitP,pnl:net,type:'SL',bars:j-entryBar,score:sig.score||0});
        positions=positions.filter(p=>p.entry!==entryPrice||p.bar!==entryBar);
        lastTradeBar=entryBar;closed=true;break;
      }
      if(hitTP){
        const exitP=tpPrice;
        const pnl=sig.dir===1?(exitP-entryPrice)*qty:(entryPrice-exitP)*qty;
        const net=pnl-entryCost-posSize*FEE_MAKER;
        capital+=net;dailyPnl[day]=(dailyPnl[day]||0)+net;
        trades.push({dir:sig.dir,entry:entryPrice,exit:exitP,pnl:net,type:'TP',bars:j-entryBar,score:sig.score||0});
        positions=positions.filter(p=>p.entry!==entryPrice||p.bar!==entryBar);
        lastTradeBar=entryBar;closed=true;break;
      }
      if(j===entryBar+TIMEOUT_BARS){
        const exitP=c;const pnl=sig.dir===1?(exitP-entryPrice)*qty:(entryPrice-exitP)*qty;
        const net=pnl-entryCost-posSize*FEE_TAKER;
        capital+=net;dailyPnl[day]=(dailyPnl[day]||0)+net;
        trades.push({dir:sig.dir,entry:entryPrice,exit:exitP,pnl:net,type:'TO',bars:TIMEOUT_BARS,score:sig.score||0});
        positions=positions.filter(p=>p.entry!==entryPrice||p.bar!==entryBar);
        lastTradeBar=entryBar;closed=true;break;
      }
    }
    if(!closed)positions=positions.filter(p=>p.entry!==entryPrice||p.bar!==entryBar);
  }
  return{trades,finalCapital:capital};
}

function stats(trades){
  if(!trades.length)return{pf:0,wr:0,pnl:0,trades:0};
  const w=trades.filter(t=>t.pnl>0),l=trades.filter(t=>t.pnl<=0);
  const gw=w.reduce((a,t)=>a+t.pnl,0),gl=Math.abs(l.reduce((a,t)=>a+t.pnl,0));
  return{pf:gl?gw/gl:gw?99:0,wr:w.length/trades.length*100,pnl:trades.reduce((a,t)=>a+t.pnl,0),trades:trades.length};
}

function maxDD(trades){
  let peak=INIT_CAP,cap=INIT_CAP,dd=0;
  for(const t of trades){cap+=t.pnl;if(cap>peak)peak=cap;const d=(peak-cap)/peak*100;if(d>dd)dd=d;}
  return dd;
}

// ─── F1 SIGNAL GENERATOR (exact from apex-final) ───
function genSignalsF1(kl5m,htf,params){
  const{lb,rsiZone,sl,tp,minRsiGap,minPriceATR,scoreThresh,gateMode}=params;
  const closes=kl5m.map(k=>parseFloat(k[4])),lows=kl5m.map(k=>parseFloat(k[3])),highs=kl5m.map(k=>parseFloat(k[2]));
  const vols=kl5m.map(k=>parseFloat(k[5]));
  const r=rsi(closes),m=macd(closes),va=volSma(vols);
  const at=atrArr(highs,lows,closes);
  const minGap=minRsiGap||0, minPA=minPriceATR||0, sThresh=scoreThresh||4;
  const gate=gateMode||'both';
  const signals=[];
  for(let i=lb+14;i<closes.length-2;i++){
    const barTime=parseInt(kl5m[i][6]);
    // Bull divergence: price LL, RSI HL
    let pLL=false,rHL=false,bestRsiGap=0,bestPriceMove=0;
    for(let j=1;j<=lb;j++){
      if(lows[i]<lows[i-j])pLL=true;
      if(r[i]>r[i-j]&&r[i-j]<rsiZone){rHL=true;bestRsiGap=Math.max(bestRsiGap,r[i]-r[i-j]);bestPriceMove=Math.max(bestPriceMove,(lows[i-j]-lows[i])/(at[i]||1));}
    }
    if(pLL&&rHL&&r[i]<rsiZone+10&&bestRsiGap>=minGap&&bestPriceMove>=minPA){
      const trend=htfTrend(htf,barTime);
      let passGate=false;
      if(gate==='both')passGate=trend===1;
      else if(gate==='1h')passGate=trend===1;
      else if(gate==='15m')passGate=true; // no separate 15m data, treat as pass
      else if(gate==='either')passGate=trend===1||true; // at least one passes
      else if(gate==='none')passGate=true;
      if(!passGate)continue;
      let score=0;
      if(r[i]<rsiZone)score+=2;
      if(vols[i]>(va[i]||1)*1.5)score+=1;
      if(trend===1)score+=3;
      if(m.hist[i]>m.hist[i-1])score+=1;
      // Extra scoring from divergence strength
      score+=Math.min(Math.floor(bestRsiGap/3),3);
      score+=Math.min(Math.floor(bestPriceMove),3);
      if(score>=sThresh)signals.push({bar:i,dir:1,sl,tp,_seq:signals.length,score});
    }
    // Bear divergence: price HH, RSI LH
    let pHH=false,rLH=false;bestRsiGap=0;bestPriceMove=0;
    for(let j=1;j<=lb;j++){
      if(highs[i]>highs[i-j])pHH=true;
      if(r[i]<r[i-j]&&r[i-j]>(100-rsiZone)){rLH=true;bestRsiGap=Math.max(bestRsiGap,r[i-j]-r[i]);bestPriceMove=Math.max(bestPriceMove,(highs[i]-highs[i-j])/(at[i]||1));}
    }
    if(pHH&&rLH&&r[i]>(100-rsiZone-10)&&bestRsiGap>=minGap&&bestPriceMove>=minPA){
      const trend=htfTrend(htf,barTime);
      let passGate=false;
      if(gate==='both')passGate=trend===-1;
      else if(gate==='1h')passGate=trend===-1;
      else if(gate==='15m')passGate=true;
      else if(gate==='either')passGate=trend===-1||true;
      else if(gate==='none')passGate=true;
      if(!passGate)continue;
      let score=0;
      if(r[i]>(100-rsiZone))score+=2;
      if(vols[i]>(va[i]||1)*1.5)score+=1;
      if(trend===-1)score+=3;
      if(m.hist[i]<m.hist[i-1])score+=1;
      score+=Math.min(Math.floor(bestRsiGap/3),3);
      score+=Math.min(Math.floor(bestPriceMove),3);
      if(score>=sThresh)signals.push({bar:i,dir:-1,sl,tp,_seq:signals.length,score});
    }
  }
  return signals;
}

function splitData(kl,isDays){
  const times=kl.map(k=>parseInt(k[0]));
  const minT=Math.min(...times),splitT=minT+isDays*86400000;
  return{is:kl.filter(k=>parseInt(k[0])<splitT),oos:kl.filter(k=>parseInt(k[0])>=splitT)};
}

// ─── MAIN ───
async function main(){
  console.log('5-DIMENSIONAL SEQUENTIAL OPTIMIZATION — APEX F1 (RSI Divergence)');
  console.log('ETHUSDT | $500 capital | 5x leverage | IS=120d OOS=60d');
  console.log('='.repeat(70));

  // Download data
  console.log('\nDownloading ETHUSDT 5m + 1h (180 days)...');
  const [kl5m,kl1h]=await Promise.all([getKlines('ETHUSDT','5m',DAYS),getKlines('ETHUSDT','1h',DAYS)]);
  console.log(`  5m: ${kl5m.length} candles | 1h: ${kl1h.length} candles`);

  const sp5=splitData(kl5m,IS_DAYS),sp1=splitData(kl1h,IS_DAYS);
  console.log(`  IS 5m: ${sp5.is.length} | OOS 5m: ${sp5.oos.length}`);
  const htfIS=precomputeHTF(sp1.is),htfOOS=precomputeHTF(sp1.oos);
  const isBars=sp5.is.length,isDaysActual=isBars/(288);

  // ════════════════════════════════════════════════════════════
  // DIM 1: TP/SL GRID
  // ════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('DIM 1 — TP/SL HEATMAP (PF values, IS, lb=15 rsiZone=40)');
  console.log('═'.repeat(70));

  const SLs=[0.004,0.005,0.006,0.008,0.01,0.012];
  const TPs=[0.008,0.01,0.015,0.02,0.025,0.03];
  const baseParams={lb:15,rsiZone:40,minRsiGap:0,minPriceATR:0,scoreThresh:4,gateMode:'both'};

  // Generate signals once (same for all TP/SL combos)
  const baseSigs=genSignalsF1(sp5.is,htfIS,{...baseParams,sl:0.01,tp:0.02});
  console.log(`  Base signals generated: ${baseSigs.length}`);

  const d1Results=[];
  const pfGrid=[],wrGrid=[],trGrid=[],pnlGrid=[];

  for(const sl of SLs){
    const pfRow=[],wrRow=[],trRow=[],pnlRow=[];
    for(const tp of TPs){
      const sigs=baseSigs.map(s=>({...s,sl,tp}));
      const res=runEngine(sp5.is,sigs);
      const s=stats(res.trades);
      pfRow.push(s.pf);wrRow.push(s.wr);trRow.push(s.trades);pnlRow.push(s.pnl);
      d1Results.push({sl,tp,...s});
    }
    pfGrid.push(pfRow);wrGrid.push(wrRow);trGrid.push(trRow);pnlGrid.push(pnlRow);
  }

  // Print heatmap
  let hdr='        ';TPs.forEach(tp=>hdr+=`TP${(tp*100).toFixed(1)}%`.padStart(8));
  console.log(hdr);
  for(let i=0;i<SLs.length;i++){
    let row=`SL${(SLs[i]*100).toFixed(1)}% `;
    for(let j=0;j<TPs.length;j++){
      const pf=pfGrid[i][j],wr=wrGrid[i][j];
      const mark=(pf>1.5&&wr>50)?'*':' ';
      row+=`${pf.toFixed(2)}${mark}`.padStart(8);
    }
    console.log(row);
  }
  console.log('  (* = PF>1.5 AND WR>50%)');

  // WR heatmap
  console.log('\n  WR% heatmap:');
  console.log(hdr);
  for(let i=0;i<SLs.length;i++){
    let row=`SL${(SLs[i]*100).toFixed(1)}% `;
    for(let j=0;j<TPs.length;j++)row+=`${wrGrid[i][j].toFixed(1)}`.padStart(8);
    console.log(row);
  }

  // PnL heatmap
  console.log('\n  PnL heatmap:');
  console.log(hdr);
  for(let i=0;i<SLs.length;i++){
    let row=`SL${(SLs[i]*100).toFixed(1)}% `;
    for(let j=0;j<TPs.length;j++)row+=`$${pnlGrid[i][j].toFixed(0)}`.padStart(8);
    console.log(row);
  }

  d1Results.sort((a,b)=>b.pnl-a.pnl);
  const bestD1=d1Results[0];
  console.log(`\n  Best D1: SL=${(bestD1.sl*100).toFixed(1)}% TP=${(bestD1.tp*100).toFixed(1)}% → PF ${bestD1.pf.toFixed(2)}, WR ${bestD1.wr.toFixed(1)}%, ${(bestD1.trades/isDaysActual).toFixed(1)} t/d, PnL $${bestD1.pnl.toFixed(0)}`);

  // ════════════════════════════════════════════════════════════
  // DIM 2: SCORE THRESHOLD
  // ════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('DIM 2 — SCORE DISTRIBUTION & THRESHOLD');
  console.log('═'.repeat(70));

  // Get all trades with scores using best D1
  const d2Sigs=genSignalsF1(sp5.is,htfIS,{...baseParams,sl:bestD1.sl,tp:bestD1.tp});
  // Run engine to get trade outcomes with scores
  const allSigsWithScore=d2Sigs.map(s=>({...s,sl:bestD1.sl,tp:bestD1.tp}));
  const d2Res=runEngine(sp5.is,allSigsWithScore);

  // Score distribution
  console.log('\n  Score Distribution (all trades from best D1 config):');
  console.log('  Range  | Trades | WR%   | PF    | PnL');
  const ranges=[[5,6],[7,8],[9,10],[11,12],[13,99]];
  for(const[lo,hi] of ranges){
    const rt=d2Res.trades.filter(t=>t.score>=lo&&t.score<=(hi>50?999:hi));
    if(!rt.length){console.log(`  ${lo}-${hi>50?'+':hi}    |      0 |       |       |`);continue;}
    const s=stats(rt);
    console.log(`  ${lo}-${hi>50?'13+':hi}    | ${rt.length.toString().padStart(5)} | ${s.wr.toFixed(1).padStart(5)} | ${s.pf.toFixed(2).padStart(5)} | $${s.pnl.toFixed(0)}`);
  }

  // Test thresholds
  console.log('\n  Score Threshold Sweep:');
  console.log('  Thresh | Trades | T/day | WR%   | PF    | PnL');
  const thresholds=[5,6,7,8,9,10];
  let bestD2={pnl:-Infinity,thresh:4};
  for(const th of thresholds){
    const sigs=genSignalsF1(sp5.is,htfIS,{...baseParams,sl:bestD1.sl,tp:bestD1.tp,scoreThresh:th});
    const res=runEngine(sp5.is,sigs);
    const s=stats(res.trades);
    const tpd=s.trades/isDaysActual;
    console.log(`  >= ${th.toString().padStart(2)}  | ${s.trades.toString().padStart(5)} | ${tpd.toFixed(1).padStart(5)} | ${s.wr.toFixed(1).padStart(5)} | ${s.pf.toFixed(2).padStart(5)} | $${s.pnl.toFixed(0)}`);
    if(s.pnl>bestD2.pnl&&s.pf>1.0)bestD2={...s,thresh:th,tpd};
  }
  console.log(`\n  Best D2: Score >= ${bestD2.thresh} → PF ${bestD2.pf.toFixed(2)}, WR ${bestD2.wr.toFixed(1)}%`);

  // ════════════════════════════════════════════════════════════
  // DIM 3: DIVERGENCE PARAMS
  // ════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('DIM 3 — DIVERGENCE PARAMS (100 random combos)');
  console.log('═'.repeat(70));

  const lbs=[5,8,10,12,15,20],rsiZones=[30,35,40,45],gaps=[2,3,5],atrs=[0.2,0.3,0.5];
  function rc(a){return a[Math.floor(Math.random()*a.length)];}
  const d3Results=[];
  for(let iter=0;iter<100;iter++){
    const lb=rc(lbs),rsiZone=rc(rsiZones),minRsiGap=rc(gaps),minPriceATR=rc(atrs);
    const sigs=genSignalsF1(sp5.is,htfIS,{lb,rsiZone,minRsiGap,minPriceATR,sl:bestD1.sl,tp:bestD1.tp,scoreThresh:bestD2.thresh,gateMode:'both'});
    if(!sigs.length)continue;
    const res=runEngine(sp5.is,sigs);
    const s=stats(res.trades);
    d3Results.push({lb,rsiZone,minRsiGap,minPriceATR,...s});
  }
  d3Results.sort((a,b)=>b.pnl-a.pnl);
  console.log('\n  TOP 5 by PnL:');
  console.log('  # | lb | rsiZ | gap | atr | PF    | WR%   | Trades | PnL');
  for(let i=0;i<Math.min(5,d3Results.length);i++){
    const r=d3Results[i];
    console.log(`  ${i+1} | ${r.lb.toString().padStart(2)} | ${r.rsiZone.toString().padStart(4)} |  ${r.minRsiGap}  | ${r.minPriceATR.toFixed(1)} | ${r.pf.toFixed(2).padStart(5)} | ${r.wr.toFixed(1).padStart(5)} | ${r.trades.toString().padStart(6)} | $${r.pnl.toFixed(0)}`);
  }
  const bestD3=d3Results[0]||{lb:15,rsiZone:40,minRsiGap:0,minPriceATR:0};
  console.log(`\n  Best D3: lb=${bestD3.lb}, rsiZone=${bestD3.rsiZone}, gap=${bestD3.minRsiGap}, atr=${bestD3.minPriceATR}`);

  // ════════════════════════════════════════════════════════════
  // DIM 4: GATE VARIANTS
  // ════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('DIM 4 — GATE VARIANTS');
  console.log('═'.repeat(70));

  const gates=[
    {name:'A) Both (1H+15m)',mode:'both'},
    {name:'B) 1H only',mode:'1h'},
    {name:'C) 15m only',mode:'15m'},
    {name:'D) Either (OR)',mode:'either'},
    {name:'E) No gate',mode:'none'},
  ];
  console.log('\n  Variant             | PF    | WR%   | T/day | PnL');
  let bestD4={pnl:-Infinity,mode:'both'};
  for(const g of gates){
    const sigs=genSignalsF1(sp5.is,htfIS,{lb:bestD3.lb,rsiZone:bestD3.rsiZone,minRsiGap:bestD3.minRsiGap,minPriceATR:bestD3.minPriceATR,sl:bestD1.sl,tp:bestD1.tp,scoreThresh:bestD2.thresh,gateMode:g.mode});
    const res=runEngine(sp5.is,sigs);
    const s=stats(res.trades);
    const tpd=s.trades/isDaysActual;
    console.log(`  ${g.name.padEnd(20)} | ${s.pf.toFixed(2).padStart(5)} | ${s.wr.toFixed(1).padStart(5)} | ${tpd.toFixed(1).padStart(5)} | $${s.pnl.toFixed(0)}`);
    if(s.pnl>bestD4.pnl&&s.pf>1.0)bestD4={...s,mode:g.mode,name:g.name,tpd};
  }
  console.log(`\n  Best D4: ${bestD4.name||bestD4.mode}`);

  // ════════════════════════════════════════════════════════════
  // DIM 5: COOLDOWN
  // ════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('DIM 5 — COOLDOWN');
  console.log('═'.repeat(70));

  const cooldowns=[0,3,6,9,12,18];
  console.log('\n  Bars | PF    | WR%   | T/day | MaxDD% | PnL');
  let bestD5={pnl:-Infinity,cd:0};
  for(const cd of cooldowns){
    const sigs=genSignalsF1(sp5.is,htfIS,{lb:bestD3.lb,rsiZone:bestD3.rsiZone,minRsiGap:bestD3.minRsiGap,minPriceATR:bestD3.minPriceATR,sl:bestD1.sl,tp:bestD1.tp,scoreThresh:bestD2.thresh,gateMode:bestD4.mode});
    const res=runEngine(sp5.is,sigs,{cooldown:cd});
    const s=stats(res.trades);
    const tpd=s.trades/isDaysActual;
    const dd=maxDD(res.trades);
    console.log(`  ${cd.toString().padStart(4)} | ${s.pf.toFixed(2).padStart(5)} | ${s.wr.toFixed(1).padStart(5)} | ${tpd.toFixed(1).padStart(5)} | ${dd.toFixed(1).padStart(6)} | $${s.pnl.toFixed(0)}`);
    if(s.pnl>bestD5.pnl&&s.pf>1.0)bestD5={...s,cd,tpd,dd};
  }
  console.log(`\n  Best D5: Cooldown = ${bestD5.cd} bars`);

  // ════════════════════════════════════════════════════════════
  // FINAL CONFIG
  // ════════════════════════════════════════════════════════════
  const finalCfg={
    sl:bestD1.sl,tp:bestD1.tp,scoreThresh:bestD2.thresh,
    lb:bestD3.lb,rsiZone:bestD3.rsiZone,minRsiGap:bestD3.minRsiGap,minPriceATR:bestD3.minPriceATR,
    gateMode:bestD4.mode,cooldown:bestD5.cd
  };

  console.log('\n' + '═'.repeat(70));
  console.log('FINAL CONFIG:');
  console.log(`  SL=${(finalCfg.sl*100).toFixed(1)}%, TP=${(finalCfg.tp*100).toFixed(1)}%, Score>=${finalCfg.scoreThresh}, lb=${finalCfg.lb}, rsiZ=${finalCfg.rsiZone}, gap=${finalCfg.minRsiGap}, atr=${finalCfg.minPriceATR}, Gate=${finalCfg.gateMode}, CD=${finalCfg.cooldown} bars`);
  console.log('═'.repeat(70));

  // ════════════════════════════════════════════════════════════
  // OOS RUN (ONE SHOT)
  // ════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('OOS RESULT (60 days) — ONE SHOT');
  console.log('═'.repeat(70));

  const oosSigs=genSignalsF1(sp5.oos,htfOOS,finalCfg);
  const oosRes=runEngine(sp5.oos,oosSigs,{cooldown:finalCfg.cooldown});
  const oosS=stats(oosRes.trades);
  const oosDays=sp5.oos.length/288;
  const oosTpd=oosS.trades/oosDays;
  const oosDD=maxDD(oosRes.trades);

  // Capital trajectory
  let cap=INIT_CAP,peak=INIT_CAP;
  const capTrajectory=[INIT_CAP];
  for(const t of oosRes.trades){cap+=t.pnl;capTrajectory.push(cap);if(cap>peak)peak=cap;}

  console.log(`\n  PF: ${oosS.pf.toFixed(2)} | WR: ${oosS.wr.toFixed(1)}% | T/day: ${oosTpd.toFixed(1)} | PnL: $${oosS.pnl.toFixed(0)} | MaxDD: ${oosDD.toFixed(1)}%`);
  console.log(`  Capital: $${INIT_CAP} → $${cap.toFixed(0)}`);

  // IS comparison
  const isSigs=genSignalsF1(sp5.is,htfIS,finalCfg);
  const isRes=runEngine(sp5.is,isSigs,{cooldown:finalCfg.cooldown});
  const isS=stats(isRes.trades);
  console.log(`\n  vs CURRENT (baseline lb=15, rsiZ=40, SL=0.7%, TP=3.0%):`);
  console.log(`  PF: 1.47→${oosS.pf.toFixed(2)} | WR: 41.3→${oosS.wr.toFixed(1)}% | PnL: $1,315→$${oosS.pnl.toFixed(0)}`);
  console.log(`  IS PF: ${isS.pf.toFixed(2)} → OOS PF: ${oosS.pf.toFixed(2)} (decay: ${((1-oosS.pf/isS.pf)*100).toFixed(1)}%)`);

  // ════════════════════════════════════════════════════════════
  // DAILY TABLE OOS (60 days)
  // ════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('DAILY TABLE OOS (60 days):');
  console.log('═'.repeat(70));
  console.log('  Day | Date       | Tr | W | L | PnL      | Capital');

  // Build daily stats from OOS trades
  const dailyMap={};
  // Get all OOS dates
  const oosStart=parseInt(sp5.oos[0][0]);
  for(let d=0;d<Math.ceil(oosDays);d++){
    const date=new Date(oosStart+d*86400000).toISOString().slice(0,10);
    dailyMap[date]={trades:0,wins:0,losses:0,pnl:0};
  }
  // Assign trades to days
  for(const t of oosRes.trades){
    // Find the entry bar's day
    const entryTime=t.entry; // we need bar time, reconstruct from trade
    // Use approximate: trades are in order, map to OOS bars
  }
  // Better approach: re-run with day tracking
  let dayCap=INIT_CAP;
  const oosTradesWithDay=[];
  {
    // Quick re-derive days from the kline data
    const getDay=t=>new Date(parseInt(t)).toISOString().slice(0,10);
    // Map each trade to its entry day by matching entry price to bar
    let tIdx=0;
    const dayPnl={};
    for(const t of oosRes.trades){
      // Find matching bar
      let day=null;
      for(let b=0;b<sp5.oos.length;b++){
        if(Math.abs(parseFloat(sp5.oos[b][1])-t.entry)<0.01){
          day=getDay(sp5.oos[b][0]);break;
        }
      }
      if(!day)day='unknown';
      if(!dayPnl[day])dayPnl[day]={trades:0,wins:0,losses:0,pnl:0};
      dayPnl[day].trades++;
      if(t.pnl>0)dayPnl[day].wins++;else dayPnl[day].losses++;
      dayPnl[day].pnl+=t.pnl;
    }
    // Get sorted days
    const allDays=[];
    const startDate=new Date(parseInt(sp5.oos[0][0]));
    for(let d=0;d<Math.ceil(oosDays);d++){
      const dt=new Date(startDate.getTime()+d*86400000).toISOString().slice(0,10);
      allDays.push(dt);
    }
    dayCap=INIT_CAP;
    for(let d=0;d<allDays.length;d++){
      const dt=allDays[d];
      const dp=dayPnl[dt]||{trades:0,wins:0,losses:0,pnl:0};
      dayCap+=dp.pnl;
      console.log(`  ${(d+1).toString().padStart(3)} | ${dt} | ${dp.trades.toString().padStart(2)} | ${dp.wins.toString().padStart(1)} | ${dp.losses.toString().padStart(1)} | $${dp.pnl.toFixed(2).padStart(8)} | $${dayCap.toFixed(0)}`);
    }
  }

  console.log('\n' + '═'.repeat(70));
  console.log('OPTIMIZATION COMPLETE');
  console.log('═'.repeat(70));
}

main().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
