#!/usr/bin/env node
'use strict';
// V46 T6+T5 Bootstrap CI + Monte Carlo
// 2000 bootstrap iter for PF and PnL CI
// 1000 MC shuffles for DD distribution

const fs = require('fs');
const path = require('path');
const KLINES_DIR = '/tmp/binance-klines-1h';
const FUND_DIR = '/tmp/binance-funding';
const OUT_DIR = path.join(__dirname, '..', 'results');

const COSTS = { fee_taker:0.0005, fee_maker:0.0002, slip_entry:0.0002, slip_sl:0.0002, slip_timestop:0.0005 };
const PAIRS = ['ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT','SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'];

const data={}, funding={};
for(const p of PAIRS){
  const fk=path.join(KLINES_DIR,`${p}.json`);
  if(!fs.existsSync(fk)) continue;
  data[p]=JSON.parse(fs.readFileSync(fk,'utf8')).map(b=>({t:b[0],o:b[1],h:b[2],l:b[3],c:b[4]}));
  const ff=path.join(FUND_DIR,`${p}.json`);
  if(fs.existsSync(ff)) funding[p]=JSON.parse(fs.readFileSync(ff,'utf8'));
}
function proxyFunding(bars){
  const n=bars.length, c=bars.map(b=>b.c);
  const ema=new Float64Array(n); ema[0]=c[0]; const a=2/51;
  for(let i=1;i<n;i++) ema[i]=c[i]*a+ema[i-1]*(1-a);
  const prem=c.map((v,i)=>(v-ema[i])/ema[i]);
  const f=new Float64Array(n);
  for(let i=8;i<n;i++){ let s=0; for(let j=i-7;j<=i;j++) s+=prem[j]; f[i]=s/8; }
  return f;
}
const fundCache={};
for(const p of PAIRS) if(data[p]) fundCache[p]=proxyFunding(data[p]);

// === T6 + T5 run, capture all trades with PnL ===
const pairOutcomes={}; PAIRS.forEach(p=>pairOutcomes[p]=[]);
const globalOutcomes=[];
function bayesPostWR(pair){
  const pa=pairOutcomes[pair];
  if(pa.length<10) return null;
  const pa_w=pa.filter(o=>o===1).length, pa_n=pa.length;
  if(globalOutcomes.length<50) return pa_w/pa_n;
  const gl_w=globalOutcomes.filter(o=>o===1).length, gl_n=globalOutcomes.length;
  return (gl_w*0.10+pa_w)/(gl_w*0.10+(gl_n-gl_w)*0.10+pa_n);
}
function t6Mul(pair){
  const wr=bayesPostWR(pair);
  if(wr===null) return 1.0;
  if(wr>0.72) return 1.25;
  if(wr<0.62) return 0.70;
  return 1.0;
}
const recentEvents=[];
const HAWKES_MU=1.0, HAWKES_ALPHA=0.3, HAWKES_BETA=1.0, HAWKES_LAMBDA_THRESHOLD=2.0;
const HAWKES_DECAY_WINDOW_H=12;
function t5Mul(currentTs){
  let sum=HAWKES_MU;
  const cutoff=currentTs-HAWKES_DECAY_WINDOW_H*3600*1000;
  while(recentEvents.length>0 && recentEvents[0]<cutoff) recentEvents.shift();
  for(const ts of recentEvents){
    const dh=(currentTs-ts)/3600000;
    sum+=HAWKES_ALPHA*Math.exp(-HAWKES_BETA*dh);
  }
  if(sum > HAWKES_LAMBDA_THRESHOLD*1.5) return 0.55;
  if(sum > HAWKES_LAMBDA_THRESHOLD) return 0.80;
  return 1.10;
}

function pairSizeMultV45(rpf){
  if(rpf===null) return 1.0;
  if(rpf>=2.5) return 1.6; if(rpf>=2.0) return 1.4; if(rpf>=1.5) return 1.2;
  if(rpf>=1.2) return 1.0; if(rpf>=1.0) return 0.85; if(rpf>=0.8) return 0.65;
  return 0.45;
}
function termStructureBoost(fund, idx, dir){
  if(idx<168) return 1.0;
  const f24=[]; for(let j=idx-24;j<idx;j++) if(isFinite(fund[j])) f24.push(fund[j]);
  const f7d=[]; for(let j=idx-168;j<idx;j++) if(isFinite(fund[j])) f7d.push(fund[j]);
  if(f24.length<12 || f7d.length<80) return 1.0;
  const m24=f24.reduce((a,b)=>a+b,0)/f24.length;
  const m7d=f7d.reduce((a,b)=>a+b,0)/f7d.length;
  const std=Math.sqrt(f7d.reduce((s,v)=>s+(v-m7d)**2,0)/f7d.length);
  const aligned=dir===1?-(m24-m7d):(m24-m7d);
  const norm=std>0?aligned/std:0;
  return 1.0+Math.max(0,Math.min(0.30,norm*0.15));
}
function realFundingPay(pair, dir, sizeUSD, openTs, closeTs){
  const arr=funding[pair]; if(!arr) return 0;
  let total=0;
  for(const [ft,rate] of arr) if(ft>=openTs && ft<=closeTs) total+=rate;
  return -total*sizeUSD*dir;
}

const INIT_CAP=500, SIZE_PCT=0.10, TP_BPS=30, SL_BPS=25, HOLD_H=4;
const trades=[]; const dailyPnL={};
let cap=INIT_CAP;
const tradesByPair={}; PAIRS.forEach(p=>tradesByPair[p]=[]);
function rollingPF(arr, ts){
  const cE=ts-7*86400000, cS=cE-90*86400000;
  const w=arr.filter(t=>t.ts>=cS && t.ts<=cE);
  if(w.length<30) return null;
  const wins=w.filter(t=>t.pnl>0);
  const gp=wins.reduce((s,t)=>s+t.pnl,0);
  const gl=-w.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0);
  return gl>0?gp/gl:999;
}

const stream=[];
for(const pair of PAIRS){
  if(!data[pair]) continue;
  for(let i=50;i<data[pair].length-HOLD_H;i++) stream.push({pair,i,t:data[pair][i].t});
}
stream.sort((a,b)=>a.t-b.t);
const posBy={}; PAIRS.forEach(p=>posBy[p]=null);

for(const evt of stream){
  const {pair,i,t}=evt;
  const bars=data[pair], fund=fundCache[pair];
  const hr=new Date(t).getUTCHours();
  const pos=posBy[pair];
  if(pos){
    const dir=pos.dir, h=bars[i].h, l=bars[i].l;
    const hitTP=(dir===1 && h>=pos.tpP) || (dir===-1 && l<=pos.tpP);
    const hitSL=(dir===1 && l<=pos.slP) || (dir===-1 && h>=pos.slP);
    const elapsed=i-pos.entryI;
    if(hitTP || hitSL || elapsed>=HOLD_H){
      let exitP, exitFee, type;
      if(hitTP){ exitP=pos.tpP; exitFee=pos.size*COSTS.fee_taker; type='TP'; }
      else if(hitSL){ exitP=dir===1?pos.slP*(1-COSTS.slip_sl):pos.slP*(1+COSTS.slip_sl); exitFee=pos.size*COSTS.fee_taker; type='SL'; }
      else { const c=bars[i].c; exitP=dir===1?c*(1-COSTS.slip_timestop):c*(1+COSTS.slip_timestop); exitFee=pos.size*COSTS.fee_taker; type='TIMESTOP'; }
      const pnlPct=dir===1?(exitP-pos.entryFill)/pos.entryFill:(pos.entryFill-exitP)/pos.entryFill;
      const gross=pos.size*pnlPct;
      const fp=realFundingPay(pair,dir,pos.size,pos.openTs,bars[i].t);
      const net=gross-exitFee+fp-pos.fee_entry;
      cap+=net;
      const dk=new Date(bars[i].t).toISOString().slice(0,10);
      dailyPnL[dk]=(dailyPnL[dk]||0)+net;
      const tr={pnl:net, ts:bars[i].t, pair, dir, type};
      trades.push(tr); tradesByPair[pair].push(tr);
      const outcome=net>0?1:0;
      pairOutcomes[pair].push(outcome);
      if(pairOutcomes[pair].length>30) pairOutcomes[pair].shift();
      globalOutcomes.push(outcome);
      if(globalOutcomes.length>200) globalOutcomes.shift();
      posBy[pair]=null;
    }
    if(posBy[pair]) continue;
  }
  if(posBy[pair]) continue;
  if(hr!==0 && hr!==8 && hr!==16) continue;
  if(!isFinite(fund[i])) continue;
  const fW=[]; for(let j=Math.max(0,i-168); j<i; j++) if(isFinite(fund[j])) fW.push(fund[j]);
  if(fW.length<50) continue;
  const sorted=[...fW].sort((a,b)=>a-b);
  const p80=sorted[Math.floor(sorted.length*0.8)]||0;
  const p20=sorted[Math.floor(sorted.length*0.2)]||0;
  let dir=0;
  if(fund[i]>p80 && fund[i]>0.005) dir=-1;
  else if(fund[i]<p20 && fund[i]<-0.002) dir=1;
  if(dir===0) continue;
  let sizeMult=1.0;
  sizeMult*=pairSizeMultV45(rollingPF(tradesByPair[pair], t));
  sizeMult*=termStructureBoost(fund, i, dir);
  sizeMult*=t6Mul(pair);
  sizeMult*=t5Mul(t);
  sizeMult=Math.min(2.0, sizeMult);
  const eR=bars[i].c;
  const eF=dir===1?eR*(1+COSTS.slip_entry):eR*(1-COSTS.slip_entry);
  const finalSize=cap*SIZE_PCT*sizeMult;
  const tpP=dir===1?eF*(1+TP_BPS/10000):eF*(1-TP_BPS/10000);
  const slP=dir===1?eF*(1-SL_BPS/10000):eF*(1+SL_BPS/10000);
  const fee=finalSize*COSTS.fee_taker;
  posBy[pair]={entryRaw:eR, entryFill:eF, dir, entryI:i, size:finalSize, sizeMult, tpP, slP, fee_entry:fee, pair, openTs:bars[i].t};
  recentEvents.push(t);
}

console.log(`Trades: ${trades.length}`);

// === Bootstrap PF and PnL CI ===
function computePFPnl(arr){
  const w=arr.filter(t=>t.pnl>0);
  const gp=w.reduce((s,t)=>s+t.pnl,0);
  const gl=-arr.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl,0);
  return { pf: gl>0 ? gp/gl : 999, pnl: arr.reduce((s,t)=>s+t.pnl,0) };
}

let _rng = 314159;
function rand(){ _rng=(_rng*1103515245+12345)&0x7fffffff; return _rng/0x7fffffff; }

const N_BOOT=2000;
const pfBoot=[], pnlBoot=[];
for(let it=0; it<N_BOOT; it++){
  const sample=[];
  for(let i=0; i<trades.length; i++) sample.push(trades[Math.floor(rand()*trades.length)]);
  const r=computePFPnl(sample);
  pfBoot.push(r.pf);
  pnlBoot.push(r.pnl);
}
pfBoot.sort((a,b)=>a-b);
pnlBoot.sort((a,b)=>a-b);
const pfMean=pfBoot.reduce((a,b)=>a+b,0)/N_BOOT;
const pfP025=pfBoot[Math.floor(N_BOOT*0.025)];
const pfP975=pfBoot[Math.floor(N_BOOT*0.975)];
const pnlMean=pnlBoot.reduce((a,b)=>a+b,0)/N_BOOT;
const pnlP025=pnlBoot[Math.floor(N_BOOT*0.025)];
const pnlP975=pnlBoot[Math.floor(N_BOOT*0.975)];

console.log('═'.repeat(80));
console.log('BOOTSTRAP CI (2000 iter, 95% CI):');
console.log(`  PF:  mean=${pfMean.toFixed(3)}  CI95=[${pfP025.toFixed(3)}, ${pfP975.toFixed(3)}]`);
console.log(`  PnL: mean=$${pnlMean.toFixed(0)}  CI95=[$${pnlP025.toFixed(0)}, $${pnlP975.toFixed(0)}]`);
console.log(`  GATE: CI lower PF ≥1.40 → ${pfP025>=1.40 ? 'PASS ✅' : 'FAIL'}`);

// === Monte Carlo: shuffle trade order, compute DD distribution ===
const N_MC=1000;
const ddMC=[];
for(let it=0; it<N_MC; it++){
  // Shuffle trades using Fisher-Yates
  const shuffled=trades.slice();
  for(let i=shuffled.length-1; i>0; i--){
    const j=Math.floor(rand()*(i+1));
    [shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];
  }
  let cum=0, pk=0, mdd=0;
  for(const t of shuffled){
    cum += t.pnl;
    if(cum>pk) pk=cum;
    if(pk-cum>mdd) mdd=pk-cum;
  }
  ddMC.push(mdd);
}
ddMC.sort((a,b)=>a-b);
const ddMean=ddMC.reduce((a,b)=>a+b,0)/N_MC;
const ddP50=ddMC[Math.floor(N_MC*0.5)];
const ddP95=ddMC[Math.floor(N_MC*0.95)];
const ddP99=ddMC[Math.floor(N_MC*0.99)];

console.log('═'.repeat(80));
console.log('MONTE CARLO SHUFFLE (1000 iter, DD distribution):');
console.log(`  Mean DD: $${ddMean.toFixed(2)} (${(ddMean/INIT_CAP*100).toFixed(2)}%)`);
console.log(`  P50 DD:  $${ddP50.toFixed(2)} (${(ddP50/INIT_CAP*100).toFixed(2)}%)`);
console.log(`  P95 DD:  $${ddP95.toFixed(2)} (${(ddP95/INIT_CAP*100).toFixed(2)}%)`);
console.log(`  P99 DD:  $${ddP99.toFixed(2)} (${(ddP99/INIT_CAP*100).toFixed(2)}%)`);
console.log(`  GATE: P95 DD ≤4% → ${(ddP95/INIT_CAP*100)<=4.0 ? 'PASS ✅' : 'FAIL'}`);

// === PnL p5 from MC ===
const pnlMCSorted = [...pnlBoot];  // already sorted
const pnlP5 = pnlMCSorted[Math.floor(N_BOOT*0.05)];
console.log(`  Bootstrap PnL p5: $${pnlP5.toFixed(0)} → ${pnlP5>0 ? 'PASS ✅ (95% paths positive)' : 'FAIL'}`);

const out={
  trades:trades.length,
  bootstrap:{ pfMean, pfCI95:[pfP025,pfP975], pnlMean, pnlCI95:[pnlP025,pnlP975], pnlP5 },
  mc:{ ddMean, ddP50, ddP95, ddP99 },
  gates:{
    ciLowerPF: pfP025 >= 1.40,
    p95DD: ddP95/INIT_CAP*100 <= 4.0,
    pnlP5positive: pnlP5 > 0
  }
};
fs.writeFileSync(path.join(OUT_DIR, 'v46_t6_t5_bootstrap.json'), JSON.stringify(out, null, 2));
console.log('═'.repeat(80));
console.log('✓ Saved');
