#!/usr/bin/env node
'use strict';
// FASE 6 — V44 Integrated Backtest
// Combines: GBM predictions (FASE 3) + DD brake (FASE 4) + entropy filter + HRP sizing + funding stream (FASE 5)
// Walk-forward 274d OOS + monthly segmentation + rolling 30/60/120d + stress tests
const fs=require('fs');const path=require('path');

const KLINES_DIR='/tmp/binance-klines-1m';
const MODELS_DIR=path.join(__dirname,'..','models');
const RESULTS_DIR=path.join(__dirname,'..','results');
const REPORTS_DIR=path.join(__dirname,'..','reports');
if(!fs.existsSync(REPORTS_DIR))fs.mkdirSync(REPORTS_DIR,{recursive:true});

const PAIRS=['ADAUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','SOLUSDT','LTCUSDT','DOTUSDT','NEARUSDT','AVAXUSDT','DOGEUSDT','BNBUSDT'];
const INIT_CAP=500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002;
const CLUSTERS={BTCUSDT:'L1major',ETHUSDT:'L1major',SOLUSDT:'SOLadj',AVAXUSDT:'SOLadj',NEARUSDT:'SOLadj',LINKUSDT:'DeFi',ATOMUSDT:'DeFi',DOTUSDT:'DeFi',ARBUSDT:'L2',BNBUSDT:'Other',XRPUSDT:'Other',ADAUSDT:'Other',LTCUSDT:'Other',DOGEUSDT:'MemesAI','1000PEPEUSDT':'MemesAI'};

function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggTF(b1m,m){const o=[];const s=m*60000;let i0=0;while(i0<b1m.length&&(b1m[i0][0]%s)!==0)i0++;for(let i=i0;i<b1m.length;i+=m){const g=b1m.slice(i,i+m);if(g.length<m)break;let h=-Infinity,l=Infinity,v=0,tbv=0;for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];}const c=g[g.length-1][4];o.push({t:g[0][0],o:g[0][1],h,l,c,v,tbv,tsv:v-tbv});}return o;}

// ═══ ATR calc ═══
function atr(bars,p=14){const n=bars.length;const res=new Float64Array(n);let trPrev=0;for(let i=1;i<n;i++){const tr=Math.max(bars[i].h-bars[i].l,Math.abs(bars[i].h-bars[i-1].c),Math.abs(bars[i].l-bars[i-1].c));if(i<=p)trPrev=trPrev*(p-1)/p+tr/p;else trPrev=trPrev*(p-1)/p+tr/p;res[i]=trPrev;}return res;}

// Load GBM predictions from FASE 3 CSVs
function loadPreds(pair){
  const f=path.join(MODELS_DIR,`03_${pair}_preds.csv`);
  if(!fs.existsSync(f))return null;
  const lines=fs.readFileSync(f,'utf8').split('\n').slice(1).filter(l=>l.trim());
  const preds={};
  for(const l of lines){
    const[ts,prob,meta,lab,yb]=l.split(',');
    preds[+ts]={prob:+prob,meta:+meta,label:+lab,y_bin:+yb};
  }
  return preds;
}

// Shannon entropy for entropy filter
function shannonEntropy(returns,nBins=10){if(returns.length<10)return 0;const mn=Math.min(...returns),mx=Math.max(...returns);if(mx===mn)return 0;const binSz=(mx-mn)/nBins;const counts=new Array(nBins).fill(0);for(const r of returns){const b=Math.min(nBins-1,Math.floor((r-mn)/binSz));counts[b]++;}const total=returns.length;let H=0;for(const c of counts){if(c===0)continue;const p=c/total;H-=p*Math.log2(p);}return H;}

// Funding proxy
function proxyFunding(bars1h){const n=bars1h.length;const c=bars1h.map(b=>b.c);const ema=new Float64Array(n);ema[0]=c[0];const alpha=2/(50+1);for(let i=1;i<n;i++)ema[i]=c[i]*alpha+ema[i-1]*(1-alpha);const premium=c.map((v,i)=>(v-ema[i])/ema[i]);const funding=new Float64Array(n);const w=8;for(let i=w;i<n;i++){let s=0;for(let j=i-w+1;j<=i;j++)s+=premium[j];funding[i]=s/w;}return funding;}

// ═══ V44 Directional Engine ═══
// Uses GBM predictions (FASE 3 meta scores) as primary signal with threshold
// Combined with: entropy filter, HRP sizing, DD brake
function runV44Directional(allData,preds,hrpWeights,cfg){
  const trades=[];
  const slots=new Array(cfg.maxPos||4).fill(null);
  let cap=INIT_CAP;let peak=INIT_CAP;
  // DD tracking
  const dailyPnL={};
  const stopUntil={value:0};

  // Compute entropy per pair
  const entropyThresh={};
  const entropySeries={};
  for(const pair of Object.keys(allData)){
    const b=allData[pair].b1h;const rets=[];for(let i=1;i<b.length;i++)rets.push((b[i].c-b[i-1].c)/b[i-1].c);
    const window=24*30;const es=new Float64Array(b.length);
    for(let i=window;i<b.length;i++)es[i]=shannonEntropy(rets.slice(i-window,i));
    const valid=Array.from(es).filter(x=>x>0).sort((a,b)=>a-b);
    entropyThresh[pair]=valid[Math.floor(valid.length*0.80)]||0;
    entropySeries[pair]=es;
  }

  // Build per-pair ATR
  const atrs={};for(const p of Object.keys(allData))atrs[p]=atr(allData[p].b1h);

  // Compute per-pair percentile thresholds (top 10% → long, bottom 10% → short)
  const thresholds={};
  for(const pair of Object.keys(allData)){
    if(!preds[pair])continue;
    const probs=Object.values(preds[pair]).map(p=>p.prob).filter(x=>x!==0.5&&!isNaN(x));
    probs.sort((a,b)=>a-b);
    thresholds[pair]={
      longTh:probs[Math.floor(probs.length*0.90)]||0.7,
      shortTh:probs[Math.floor(probs.length*0.10)]||0.1,
      median:probs[Math.floor(probs.length*0.50)]||0.5
    };
  }
  // Build timeline of events (signals): sort by ts
  const events=[];
  for(const pair of Object.keys(allData)){
    const b=allData[pair].b1h;
    if(!preds[pair])continue;
    const th=thresholds[pair];
    for(let i=50;i<b.length-60;i++){
      const p=preds[pair][b[i].t];
      if(!p)continue;
      if(p.prob===0.5||isNaN(p.prob))continue;
      const hr=new Date(b[i].t).getUTCHours();
      if(cfg.tod&&new Set([0,7,10,11,12,13,17,18]).has(hr))continue;
      if(cfg.entropy&&entropySeries[pair][i]>entropyThresh[pair])continue;
      // Direction from percentile rank: top 10% prob → long, bottom 10% → short
      let dir=0;let conf=0;
      if(p.prob>=th.longTh){dir=1;conf=(p.prob-th.median)/(th.longTh-th.median);}
      else if(p.prob<=th.shortTh){dir=-1;conf=(th.median-p.prob)/(th.median-th.shortTh);}
      if(dir===0)continue;
      events.push({pair,ts:b[i].t,i,dir,conf:Math.min(2,Math.max(0.5,conf)),atr:atrs[pair][i],c:b[i].c});
    }
  }
  events.sort((a,b)=>a.ts-b.ts);

  // Helpers
  function recordDaily(date,pnl){dailyPnL[date]=(dailyPnL[date]||0)+pnl;}
  function ddFromRolling(now,days){const nowDate=new Date(now);let pk=0,cum=0,mdd=0;const dates=Object.keys(dailyPnL).filter(d=>(nowDate-new Date(d))/86400000<=days).sort();for(const d of dates){cum+=dailyPnL[d];if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}return mdd;}
  function getSizeScale(now){if(now<stopUntil.value)return 0;const dd14=ddFromRolling(now,14);const dd30=ddFromRolling(now,30);if(dd30>0.35*INIT_CAP){stopUntil.value=now+72*3600000;return 0;}if(dd14>0.25*INIT_CAP){stopUntil.value=now+24*3600000;return 0;}if(dd14>0.15*INIT_CAP)return 0.5;if(peak>0&&cap/peak<0.80)return 0.7;return 1;}
  function closePos(si,reason,j,pair){const pos=slots[si];const pd=allData[pair].b1h;let ep2;if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(reason==='TP')ep2=pos.tpP;else ep2=pd[j].c;const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;const fE=pos.sz*FEE_E,fX=pos.sz*(reason==='TP'?FEE_TP:FEE_SL);const pnl=g-fE-fX;cap+=pnl;if(cap>peak)peak=cap;const date=new Date(pd[j].t).toISOString().slice(0,10);recordDaily(date,pnl);trades.push({pnl,type:reason,pair,date,ts:pd[j].t,conf:pos.conf});slots[si]=null;}
  function advance(upTs){for(let si=0;si<slots.length;si++){const pos=slots[si];if(!pos)continue;const pd=allData[pos.pair].b1h;for(let j=pos.nc;j<pd.length&&j<=pos.exp&&pd[j].t<=upTs;j++){let hS,hT;if(pos.dir===1){hS=pd[j].l<=pos.slP;hT=pd[j].h>=pos.tpP;}else{hS=pd[j].h>=pos.slP;hT=pd[j].l<=pos.tpP;}if(hS&&hT)hT=false;if(hS){closePos(si,'SL',j,pos.pair);break;}if(hT){closePos(si,'TP',j,pos.pair);break;}pos.nc=j+1;}if(slots[si]&&slots[si].nc>slots[si].exp){closePos(si,'TO',Math.min(slots[si].exp,allData[slots[si].pair].b1h.length-1),slots[si].pair);}}}

  for(const sig of events){
    if(cap<=0)break;
    advance(sig.ts);
    // DD brake
    const scale=getSizeScale(sig.ts);
    if(scale===0)continue;
    // Cluster limit
    const clCnts={};for(const s of slots)if(s)clCnts[CLUSTERS[s.pair]||'o']=(clCnts[CLUSTERS[s.pair]||'o']||0)+1;
    if((clCnts[CLUSTERS[sig.pair]||'o']||0)>=(cfg.maxCluster||3))continue;
    // No duplicates per pair
    let conflict=false;for(const s of slots)if(s&&s.pair===sig.pair){conflict=true;break;}
    if(conflict)continue;
    // Find slot
    let freeSlot=-1;for(let si=0;si<slots.length;si++)if(!slots[si]){freeSlot=si;break;}
    if(freeSlot===-1)continue;
    if(cap<50)continue;
    // Size via HRP × DD scale × confidence
    const hrpMult=hrpWeights[sig.pair]||(1/PAIRS.length);
    // Normalize HRP to have sum = 1; then apply base size
    const baseSize=2500; // same as v42 PRO
    const sz=baseSize*hrpMult*PAIRS.length*scale*(1+sig.conf-0.5); // amplify by conf
    if(sz<10)continue;
    // ATR-based SL/TP
    const ap=sig.atr/sig.c;if(ap<=0||isNaN(ap))continue;
    const slPct=Math.max(0.003,Math.min(0.03,ap*2));
    const tpPct=Math.max(0.005,Math.min(0.08,slPct*2.0)); // 2:1 TP:SL
    const ep=sig.c;
    slots[freeSlot]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-slPct):ep*(1+slPct),tpP:sig.dir===1?ep*(1+tpPct):ep*(1-tpPct),qty:sz/ep,sz,conf:sig.conf,eb:sig.i+1,exp:sig.i+1+60,nc:sig.i+1};
  }
  advance(Infinity);
  for(let si=0;si<slots.length;si++){if(slots[si]){const pd=allData[slots[si].pair].b1h;closePos(si,'TO',Math.min(slots[si].exp,pd.length-1),slots[si].pair);}}
  return{trades,finalCap:cap,peakCap:peak};
}

// ═══ V44 Funding Carry Stream ═══
function runV44FundingCarry(allData,fundings){
  const trades=[];
  const SIZE_PCT=0.10;
  const TP_BPS=30;const SL_BPS=25;const HOLD_H=4;
  let cap=INIT_CAP;
  for(const pair of Object.keys(allData)){
    const bars=allData[pair].b1h;const fund=fundings[pair];
    let pos=null;
    for(let i=50;i<bars.length-HOLD_H;i++){
      const ts=bars[i].t;const d=new Date(ts);const hr=d.getUTCHours();
      if(pos){
        const entry=pos.entry;const dir=pos.dir;const h=bars[i].h;const l=bars[i].l;
        const tpP=dir===1?entry*(1+TP_BPS/10000):entry*(1-TP_BPS/10000);
        const slP=dir===1?entry*(1-SL_BPS/10000):entry*(1+SL_BPS/10000);
        const hitTP=(dir===1&&h>=tpP)||(dir===-1&&l<=tpP);
        const hitSL=(dir===1&&l<=slP)||(dir===-1&&h>=slP);
        const timeout=i>=pos.entryI+HOLD_H;
        if(hitTP||hitSL||timeout){
          const exitP=hitTP?tpP:(hitSL?slP:bars[i].c);
          const pnl_pct=dir===1?(exitP-entry)/entry:(entry-exitP)/entry;
          const pnl=pos.size*pnl_pct-pos.size*0.0008;
          cap+=pnl;trades.push({pnl,date:d.toISOString().slice(0,10),ts,pair,type:'funding'});
          pos=null;
        }
      }
      if(!pos&&(hr===0||hr===8||hr===16)){
        const f=fund[i];
        const fWin=fund.slice(Math.max(0,i-168),i);
        const p80=[...fWin].sort((a,b)=>a-b)[Math.floor(fWin.length*0.80)]||0;
        const p20=[...fWin].sort((a,b)=>a-b)[Math.floor(fWin.length*0.20)]||0;
        let dir=0;if(f>p80&&f>0.005)dir=-1;else if(f<p20&&f<-0.002)dir=1;
        if(dir!==0){pos={entry:bars[i].c,dir,entryI:i,size:cap*SIZE_PCT};}
      }
    }
  }
  return{trades,finalCap:cap};
}

function stats(trades,capital=INIT_CAP){
  if(!trades.length)return{pf:0,wr:0,pnl:0,n:0,sharpe:0,mdd:0,mddPct:0};
  const w=trades.filter(x=>x.pnl>0),lo=trades.filter(x=>x.pnl<=0);
  const gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));
  const byDay={};for(const x of trades){byDay[x.date]=(byDay[x.date]||0)+x.pnl;}
  const dR=Object.values(byDay);
  const mD=dR.reduce((a,x)=>a+x,0)/dR.length;const vD=dR.reduce((a,x)=>a+(x-mD)**2,0)/dR.length;
  const sharpe=vD>0?mD/Math.sqrt(vD)*Math.sqrt(365):0;
  let cum=0,pk=0,mdd=0;for(const x of trades){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}
  return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/trades.length*100,pnl:gw-gl,n:trades.length,sharpe,mdd,mddPct:mdd/(capital+Math.max(0,gw-gl))*100,dailyPnL:byDay};
}

function monthlySegmentation(trades){
  const byMonth={};for(const t of trades){const m=t.date.slice(0,7);if(!byMonth[m])byMonth[m]={trades:[],pnl:0};byMonth[m].trades.push(t);byMonth[m].pnl+=t.pnl;}
  return Object.fromEntries(Object.entries(byMonth).map(([m,v])=>[m,{...stats(v.trades),n:v.trades.length,monthPnL:v.pnl}]));
}

function rollingWindowCheck(dailyPnL,windowDays){
  const dates=Object.keys(dailyPnL).sort();
  let minPnL=Infinity,maxNegWindow=null;
  for(let i=0;i<dates.length;i++){
    let sum=0;for(let j=i;j<Math.min(i+windowDays,dates.length);j++)sum+=dailyPnL[dates[j]];
    if(sum<minPnL){minPnL=sum;maxNegWindow={start:dates[i],end:dates[Math.min(i+windowDays-1,dates.length-1)],pnl:sum};}
  }
  return{minPnL,maxNegWindow,hasNegative:minPnL<0};
}

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('FASE 6 — V44 Integrated Backtest');console.log('═'.repeat(80));

  // Load data
  console.log('\n[1/5] Loading data...');
  const allData={};
  for(const pair of PAIRS){
    const b1m=load1m(pair);if(!b1m||b1m.length<50000)continue;
    const b1h=aggTF(b1m,60);allData[pair]={b1h};
  }
  console.log(`  ${Object.keys(allData).length} pairs loaded`);

  // Load GBM predictions
  console.log('\n[2/5] Loading GBM predictions...');
  const preds={};let totalPreds=0;
  for(const pair of Object.keys(allData)){
    const p=loadPreds(pair);if(p){preds[pair]=p;totalPreds+=Object.keys(p).length;}
  }
  console.log(`  ${Object.keys(preds).length} pairs with preds, ${totalPreds} total prediction rows`);

  // Load HRP weights from FASE 4
  const fase4=JSON.parse(fs.readFileSync(path.join(RESULTS_DIR,'04_dd_reduction.json'),'utf8'));
  const hrpWeights=fase4.hrp.weights;
  // Normalize so sum = 1
  const sumW=Object.values(hrpWeights).reduce((a,x)=>a+x,0);
  const hrpNorm={};for(const[p,w]of Object.entries(hrpWeights))hrpNorm[p]=w/sumW;

  // Compute funding proxies
  console.log('\n[3/5] Computing funding proxies...');
  const fundings={};for(const pair of Object.keys(allData))fundings[pair]=proxyFunding(allData[pair].b1h);
  console.log(`  ${Object.keys(fundings).length} pairs`);

  // Run V44 directional
  console.log('\n[4/5] V44 Directional Engine (GBM + DD brake + entropy + HRP)...');
  const cfgDirectional={maxPos:4,maxCluster:3,tod:true,entropy:true,thresholdP:0.55};
  const rDir=runV44Directional(allData,preds,hrpNorm,cfgDirectional);
  const sDir=stats(rDir.trades);
  console.log(`  Directional: ${sDir.n} trades, PF ${sDir.pf.toFixed(2)}, WR ${sDir.wr.toFixed(1)}%, Sharpe ${sDir.sharpe.toFixed(2)}, DD ${sDir.mddPct.toFixed(1)}%, PnL $${sDir.pnl.toFixed(0)}`);

  // Run V44 funding stream
  console.log('\n[5/5] V44 Funding Carry Stream...');
  const rFund=runV44FundingCarry(allData,fundings);
  const sFund=stats(rFund.trades);
  console.log(`  Funding: ${sFund.n} trades, PF ${sFund.pf.toFixed(2)}, WR ${sFund.wr.toFixed(1)}%, Sharpe ${sFund.sharpe.toFixed(2)}, PnL $${sFund.pnl.toFixed(0)}`);

  // Combine streams
  console.log('\n[6/6] Combined V44 (directional + funding)...');
  const combinedTrades=[...rDir.trades.map(t=>({...t,stream:'directional'})),...rFund.trades.map(t=>({...t,stream:'funding'}))];
  combinedTrades.sort((a,b)=>a.ts-b.ts);
  const sComb=stats(combinedTrades);
  console.log(`  Combined: ${sComb.n} trades, PF ${sComb.pf.toFixed(2)}, WR ${sComb.wr.toFixed(1)}%, Sharpe ${sComb.sharpe.toFixed(2)}, DD ${sComb.mddPct.toFixed(1)}%, PnL $${sComb.pnl.toFixed(0)}`);

  // Monthly segmentation
  const monthlyDir=monthlySegmentation(rDir.trades);
  const monthlyFund=monthlySegmentation(rFund.trades);
  const monthlyComb=monthlySegmentation(combinedTrades);
  console.log('\n── Monthly segmentation (combined V44) ──');
  console.log('Month     Trades   PF     WR     PnL');
  for(const[m,v]of Object.entries(monthlyComb).sort()){
    console.log(`${m}   ${String(v.n).padStart(4)}  ${v.pf.toFixed(2).padStart(4)}  ${v.wr.toFixed(1).padStart(4)}%  $${v.pnl.toFixed(0).padStart(6)}`);
  }
  const monthsPositive=Object.values(monthlyComb).filter(m=>m.monthPnL>=0).length;
  const totalMonths=Object.keys(monthlyComb).length;

  // Rolling checks
  const r30=rollingWindowCheck(sComb.dailyPnL,30);
  const r60=rollingWindowCheck(sComb.dailyPnL,60);
  const r120=rollingWindowCheck(sComb.dailyPnL,120);
  console.log(`\n── Rolling windows ──`);
  console.log(`30d min: $${r30.minPnL.toFixed(0)} (${r30.hasNegative?'NEG':'POS'})`);
  console.log(`60d min: $${r60.minPnL.toFixed(0)} (${r60.hasNegative?'NEG':'POS'})`);
  console.log(`120d min: $${r120.minPnL.toFixed(0)} (${r120.hasNegative?'NEG':'POS'})`);

  // Tpd
  const tpd=sComb.n/273;

  // Gates evaluation
  const gates={
    pf_ge_135:sComb.pf>=1.35,
    wr_ge_48:sComb.wr>=48,
    tpd_ge_4:tpd>=4,
    dd_le_35:sComb.mddPct<=35,
    months_pos_ge_4:monthsPositive>=4,
  };
  const gatesPassed=Object.values(gates).filter(x=>x).length;

  // Save results
  const report={phase:'6 — V44 Integrated Backtest',runtime_s:(Date.now()-t0)/1000,directional:sDir,funding:sFund,combined:sComb,monthly:{directional:monthlyDir,funding:monthlyFund,combined:monthlyComb},months_positive:`${monthsPositive}/${totalMonths}`,rolling:{r30,r60,r120},tpd,gates,gates_passed:`${gatesPassed}/${Object.keys(gates).length}`,hrp_weights:hrpNorm};
  fs.writeFileSync(path.join(RESULTS_DIR,'06_integrated_backtest.json'),JSON.stringify(report,null,2));
  // Daily PnL CSV for rolling viz
  const csvLines=['date,directional_pnl,funding_pnl,combined_pnl'];
  const dDir=stats(rDir.trades).dailyPnL||{};const dFund=stats(rFund.trades).dailyPnL||{};
  const allDates=[...new Set([...Object.keys(dDir),...Object.keys(dFund)])].sort();
  for(const d of allDates)csvLines.push(`${d},${dDir[d]||0},${dFund[d]||0},${(dDir[d]||0)+(dFund[d]||0)}`);
  fs.writeFileSync(path.join(REPORTS_DIR,'06_daily_pnl.csv'),csvLines.join('\n'));

  console.log('\n'+'═'.repeat(80));console.log('FASE 6 RESULTS');console.log('═'.repeat(80));
  console.log(`Directional: ${sDir.n}t PF${sDir.pf.toFixed(2)} WR${sDir.wr.toFixed(1)}% DD${sDir.mddPct.toFixed(1)}% Sh${sDir.sharpe.toFixed(2)}`);
  console.log(`Funding:     ${sFund.n}t PF${sFund.pf.toFixed(2)} WR${sFund.wr.toFixed(1)}% Sh${sFund.sharpe.toFixed(2)}`);
  console.log(`Combined:    ${sComb.n}t PF${sComb.pf.toFixed(2)} WR${sComb.wr.toFixed(1)}% DD${sComb.mddPct.toFixed(1)}% Sh${sComb.sharpe.toFixed(2)} t/d${tpd.toFixed(2)}`);
  console.log(`\nMonthly: ${monthsPositive}/${totalMonths} positive`);
  console.log(`Rolling 30/60/120d neg: ${r30.hasNegative?'YES':'NO'} / ${r60.hasNegative?'YES':'NO'} / ${r120.hasNegative?'YES':'NO'}`);
  console.log(`\n── V44 Gates (${gatesPassed}/5 passed) ──`);
  console.log(`  PF ≥ 1.35:        ${gates.pf_ge_135?'✓':'✗'} (${sComb.pf.toFixed(2)})`);
  console.log(`  WR ≥ 48%:         ${gates.wr_ge_48?'✓':'✗'} (${sComb.wr.toFixed(1)}%)`);
  console.log(`  t/d ≥ 4:          ${gates.tpd_ge_4?'✓':'✗'} (${tpd.toFixed(2)})`);
  console.log(`  DD ≤ 35%:         ${gates.dd_le_35?'✓':'✗'} (${sComb.mddPct.toFixed(1)}%)`);
  console.log(`  Months pos ≥ 4:   ${gates.months_pos_ge_4?'✓':'✗'} (${monthsPositive}/${totalMonths})`);
  console.log(`\nRuntime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`Saved: ${RESULTS_DIR}/06_integrated_backtest.json`);
  console.log(`Daily CSV: ${REPORTS_DIR}/06_daily_pnl.csv`);
}
main().catch(e=>{console.error(e);process.exit(1);});
