#!/usr/bin/env node
'use strict';
// V46 T6 Sensitivity Test
// Perturb thresholds ±15% to verify robustness
// Original: high_wr=0.72, low_wr=0.62, mults: 1.25/0.70

const fs = require('fs');
const path = require('path');
const KLINES_DIR = '/tmp/binance-klines-1h';
const FUND_DIR = '/tmp/binance-funding';
const OUT_DIR = path.join(__dirname, '..', 'results');

const SCENARIOS = [
  { name:'baseline_72_62', highWR:0.72, lowWR:0.62, highMul:1.25, lowMul:0.70 },
  { name:'thresh_+15pct',  highWR:0.78, lowWR:0.71, highMul:1.25, lowMul:0.70 },
  { name:'thresh_-15pct',  highWR:0.61, lowWR:0.53, highMul:1.25, lowMul:0.70 },
  { name:'mults_+15pct',   highWR:0.72, lowWR:0.62, highMul:1.44, lowMul:0.81 },
  { name:'mults_-15pct',   highWR:0.72, lowWR:0.62, highMul:1.06, lowMul:0.59 },
  { name:'all_+15pct',     highWR:0.78, lowWR:0.71, highMul:1.44, lowMul:0.81 },
  { name:'all_-15pct',     highWR:0.61, lowWR:0.53, highMul:1.06, lowMul:0.59 },
];

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

function runScenario(s){
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
    if(wr>s.highWR) return s.highMul;
    if(wr<s.lowWR) return s.lowMul;
    return 1.0;
  }

  const INIT_CAP=500, SIZE_PCT=0.10, TP_BPS=30, SL_BPS=25, HOLD_H=4;
  const trades=[], dailyPnL={};
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
    sizeMult=Math.min(2.0, sizeMult);

    const eR=bars[i].c;
    const eF=dir===1?eR*(1+COSTS.slip_entry):eR*(1-COSTS.slip_entry);
    const finalSize=cap*SIZE_PCT*sizeMult;
    const tpP=dir===1?eF*(1+TP_BPS/10000):eF*(1-TP_BPS/10000);
    const slP=dir===1?eF*(1-SL_BPS/10000):eF*(1+SL_BPS/10000);
    const fee=finalSize*COSTS.fee_taker;
    posBy[pair]={entryRaw:eR, entryFill:eF, dir, entryI:i, size:finalSize, sizeMult, tpP, slP, fee_entry:fee, pair, openTs:bars[i].t};
  }

  const w=trades.filter(t=>t.pnl>0), l=trades.filter(t=>t.pnl<=0);
  const gp=w.reduce((s,t)=>s+t.pnl,0), gl=-l.reduce((s,t)=>s+t.pnl,0);
  const days=Object.keys(dailyPnL).sort();
  const dr=days.map(d=>dailyPnL[d]/INIT_CAP);
  const m=dr.reduce((a,b)=>a+b,0)/Math.max(1,dr.length);
  const v=dr.reduce((s,r)=>s+(r-m)**2,0)/Math.max(1,dr.length);
  const sh=Math.sqrt(v)>0?(m/Math.sqrt(v))*Math.sqrt(365):0;
  let pk=0,mdd=0,cum=0;
  for(const d of days){ cum+=dailyPnL[d]; if(cum>pk) pk=cum; if(pk-cum>mdd) mdd=pk-cum; }
  const pf=gl>0?gp/gl:999;
  const wr=(w.length/trades.length)*100;
  const tpd=days.length>0?trades.length/days.length:0;
  const win7d=[];
  for(let i=0; i+6<days.length; i++) win7d.push(days.slice(i,i+7).reduce((s,d)=>s+dailyPnL[d],0));
  const positivePct=win7d.length>0?win7d.filter(p=>p>0).length/win7d.length*100:0;
  const sortedW=[...win7d].sort((a,b)=>a-b);
  const worst=sortedW[0]||0;
  return { name:s.name, pf, wr, pnl:trades.reduce((s,t)=>s+t.pnl,0), mddPct:mdd/INIT_CAP*100, sharpe:sh, tpd, positivePct, worstPct:worst/INIT_CAP*100, n:trades.length };
}

console.log('═'.repeat(80));
console.log('V46 T6 SENSITIVITY TEST');
console.log('═'.repeat(80));
console.log('Scenario              | PF    | WR    | PnL    | DD%   | Sharpe | %win7d | worst7d');
console.log('-'.repeat(95));

const results=[];
for(const s of SCENARIOS){
  const r=runScenario(s);
  results.push(r);
  console.log(`${r.name.padEnd(20)} | ${r.pf.toFixed(3)} | ${r.wr.toFixed(2)} | $${r.pnl.toFixed(0).padStart(5)} | ${r.mddPct.toFixed(2).padStart(5)} | ${r.sharpe.toFixed(2).padStart(5)} | ${r.positivePct.toFixed(1).padStart(5)}% | ${r.worstPct.toFixed(2)}%`);
}

// Compute fragility = (max PF - min PF) / mean PF
const pfs = results.map(r=>r.pf);
const meanPF = pfs.reduce((a,b)=>a+b,0)/pfs.length;
const fragility = (Math.max(...pfs)-Math.min(...pfs))/meanPF;
console.log('-'.repeat(95));
console.log(`Fragility (PF range / mean): ${(fragility*100).toFixed(1)}% (gate <15%)`);

fs.writeFileSync(path.join(OUT_DIR, `v46_t6_sensitivity.json`), JSON.stringify({ scenarios: results, fragility }, null, 2));
console.log('✓ Saved');
