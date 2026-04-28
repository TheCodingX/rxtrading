#!/usr/bin/env node
'use strict';
// FASE 4 — DD Reduction multi-layer
// Técnica 8: HRP Sizing (López de Prado 2016) — recursive bisection on correlation cluster tree
// Técnica 9: Entropy Filter — Shannon entropy of returns, skip high-entropy days
// Técnica 10: DD Exposure Brake — rolling DD-based size scaling + stop
const fs=require('fs');const path=require('path');

const KLINES_DIR='/tmp/binance-klines-1m';
const MODELS_DIR=path.join(__dirname,'..','models');
const RESULTS_DIR=path.join(__dirname,'..','results');

const PAIRS=['ADAUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','SOLUSDT','LTCUSDT','DOTUSDT','NEARUSDT','AVAXUSDT','DOGEUSDT','BNBUSDT'];

function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggTF(b1m,m){const o=[];const s=m*60000;let i0=0;while(i0<b1m.length&&(b1m[i0][0]%s)!==0)i0++;for(let i=i0;i<b1m.length;i+=m){const g=b1m.slice(i,i+m);if(g.length<m)break;let h=-Infinity,l=Infinity,v=0,tbv=0;for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];}const c=g[g.length-1][4];o.push({t:g[0][0],o:g[0][1],h,l,c,v,tbv,tsv:v-tbv});}return o;}

// ═══ Técnica 8: HRP (Hierarchical Risk Parity) ═══
// Build correlation matrix, cluster via single-linkage, allocate via recursive bisection
function pearsonCorr(a,b){if(a.length!==b.length||a.length<10)return 0;const n=a.length;let sa=0,sb=0;for(let i=0;i<n;i++){sa+=a[i];sb+=b[i];}sa/=n;sb/=n;let sab=0,saa=0,sbb=0;for(let i=0;i<n;i++){const da=a[i]-sa;const db=b[i]-sb;sab+=da*db;saa+=da*da;sbb+=db*db;}const d=Math.sqrt(saa*sbb);return d>0?sab/d:0;}

function correlationMatrix(returns){
  const pairs=Object.keys(returns);
  const n=pairs.length;
  const M=Array.from({length:n},()=>new Array(n).fill(0));
  for(let i=0;i<n;i++){
    for(let j=0;j<n;j++){
      if(i===j){M[i][j]=1;continue;}
      M[i][j]=pearsonCorr(returns[pairs[i]],returns[pairs[j]]);
    }
  }
  return{pairs,M};
}

function corrDistance(corr){
  // d = sqrt(0.5·(1-ρ))
  const n=corr.length;
  const D=Array.from({length:n},()=>new Array(n).fill(0));
  for(let i=0;i<n;i++)for(let j=0;j<n;j++)D[i][j]=Math.sqrt(0.5*(1-corr[i][j]));
  return D;
}

function singleLinkage(D){
  // Single-linkage hierarchical clustering
  const n=D.length;
  const clusters=Array.from({length:n},(_,i)=>[i]);
  const linkage=[];
  const active=new Set(Array.from({length:n},(_,i)=>i));
  while(active.size>1){
    let minD=Infinity,pI=-1,pJ=-1;
    const arr=Array.from(active);
    for(let a=0;a<arr.length;a++){
      for(let b=a+1;b<arr.length;b++){
        let d=Infinity;
        for(const i of clusters[arr[a]]){
          for(const j of clusters[arr[b]]){if(D[i][j]<d)d=D[i][j];}
        }
        if(d<minD){minD=d;pI=arr[a];pJ=arr[b];}
      }
    }
    linkage.push({a:pI,b:pJ,d:minD});
    clusters[pI]=[...clusters[pI],...clusters[pJ]];
    active.delete(pJ);
  }
  return{linkage,order:clusters[Array.from(active)[0]]};
}

function hrpWeights(cov,order){
  // Recursive bisection on quasi-diagonalized covariance
  const n=order.length;
  const weights=new Array(n).fill(1/n);
  function ivp(indices){
    // Inverse-variance portfolio weights
    const vs=indices.map(i=>cov[i][i]);
    const iv=vs.map(v=>v>0?1/v:0);
    const s=iv.reduce((a,x)=>a+x,0);
    return iv.map(x=>s>0?x/s:1/indices.length);
  }
  function varCluster(indices,w){
    let s=0;for(let a=0;a<indices.length;a++){for(let b=0;b<indices.length;b++){s+=w[a]*w[b]*cov[indices[a]][indices[b]];}}return s;
  }
  function bisect(orderIdx){
    if(orderIdx.length<=1){return;}
    const mid=Math.floor(orderIdx.length/2);
    const left=orderIdx.slice(0,mid);const right=orderIdx.slice(mid);
    const wL=ivp(left);const wR=ivp(right);
    const vL=varCluster(left,wL);const vR=varCluster(right,wR);
    const alpha=vR/(vL+vR);
    for(const i of left)weights[order.indexOf(i)]*=alpha;
    for(const i of right)weights[order.indexOf(i)]*=(1-alpha);
    bisect(left);bisect(right);
  }
  bisect(order);
  return weights;
}

// ═══ Técnica 9: Shannon Entropy Filter ═══
function shannonEntropy(returns,nBins=10){
  if(returns.length<10)return 0;
  const mn=Math.min(...returns),mx=Math.max(...returns);
  if(mx===mn)return 0;
  const binSz=(mx-mn)/nBins;
  const counts=new Array(nBins).fill(0);
  for(const r of returns){const b=Math.min(nBins-1,Math.floor((r-mn)/binSz));counts[b]++;}
  const total=returns.length;let H=0;
  for(const c of counts){if(c===0)continue;const p=c/total;H-=p*Math.log2(p);}
  return H; // max entropy = log2(nBins)
}

function buildEntropyFilter(bars1h,rollingDays=30){
  const n=bars1h.length;
  const closes=bars1h.map(b=>b.c);
  const returns=[];
  for(let i=1;i<n;i++)returns.push((closes[i]-closes[i-1])/closes[i-1]);
  const window=rollingDays*24; // 1h bars
  const entropy=new Float64Array(n);
  for(let i=window;i<n;i++){
    entropy[i]=shannonEntropy(returns.slice(i-window,i));
  }
  // Threshold: P80 of entropy (excluding NaN/0)
  const valid=Array.from(entropy).filter(x=>x>0).sort((a,b)=>a-b);
  const p80=valid[Math.floor(valid.length*0.80)]||0;
  return{entropy,p80};
}

// ═══ Técnica 10: DD Exposure Brake ═══
// Rolling DD over 14d → scale down if > thresholds
// 14d DD > 15%: size × 0.5
// 14d DD > 25%: stop 24h
// 30d DD > 35%: stop 72h + review
class DDBrake{
  constructor(){this.dailyPnL={};this.peak=0;this.equity=0;this.stopUntil=0;}
  recordDaily(date,pnl){this.dailyPnL[date]=(this.dailyPnL[date]||0)+pnl;this.equity+=pnl;if(this.equity>this.peak)this.peak=this.equity;}
  ddFromRolling(days,now){
    const nowDate=new Date(now);
    let pk=0,cum=0,mdd=0;
    const dates=Object.keys(this.dailyPnL).filter(d=>(nowDate-new Date(d))/86400000<=days).sort();
    for(const d of dates){cum+=this.dailyPnL[d];if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}
    return mdd;
  }
  getSizeScale(now,capital){
    if(now<this.stopUntil)return 0;
    const dd14=this.ddFromRolling(14,now);
    const dd30=this.ddFromRolling(30,now);
    const pctPeak=this.peak>0?this.equity/this.peak:1;
    if(dd30>0.35*capital){this.stopUntil=now+72*3600000;return 0;}
    if(dd14>0.25*capital){this.stopUntil=now+24*3600000;return 0;}
    if(dd14>0.15*capital)return 0.5;
    if(pctPeak<0.8)return 0.7;
    return 1;
  }
}

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('FASE 4 — DD Reduction (HRP + Entropy + Exposure Brake)');console.log('═'.repeat(80));

  // Load returns per pair
  console.log('\n[1/3] Loading returns for correlation matrix...');
  const returns={};
  const allBars={};
  for(const pair of PAIRS){
    const b1m=load1m(pair);if(!b1m||b1m.length<50000){continue;}
    const b1h=aggTF(b1m,60);
    allBars[pair]=b1h;
    const rets=[];for(let i=1;i<b1h.length;i++)rets.push(Math.log(b1h[i].c/b1h[i-1].c));
    returns[pair]=rets;
  }
  console.log(`  ${Object.keys(returns).length} pairs, ${Object.values(returns)[0].length} returns each`);

  // HRP weights
  console.log('\n[2/3] HRP Hierarchical Risk Parity...');
  const{pairs:corrPairs,M:corrM}=correlationMatrix(returns);
  const D=corrDistance(corrM);
  const{linkage,order}=singleLinkage(D);
  // Build covariance (returns × std)
  const stds=corrPairs.map(p=>{const r=returns[p];const m=r.reduce((a,x)=>a+x,0)/r.length;const v=r.reduce((a,x)=>a+(x-m)**2,0)/r.length;return Math.sqrt(v);});
  const cov=corrM.map((row,i)=>row.map((c,j)=>c*stds[i]*stds[j]));
  const weights=hrpWeights(cov,order);
  const hrpAlloc={};corrPairs.forEach((p,i)=>{hrpAlloc[p]=weights[order.indexOf(i)];});
  console.log('  HRP weights:');
  for(const[p,w]of Object.entries(hrpAlloc).sort((a,b)=>b[1]-a[1])){
    console.log(`    ${p.padEnd(14)} ${(w*100).toFixed(1)}%`);
  }

  // Entropy filter
  console.log('\n[3/3] Shannon Entropy Filter per-pair...');
  const entropyResults={};
  for(const pair of Object.keys(allBars)){
    const{entropy,p80}=buildEntropyFilter(allBars[pair],30);
    const flagged=Array.from(entropy).filter(x=>x>=p80&&x>0).length;
    entropyResults[pair]={p80,flagged,total:entropy.length};
    process.stdout.write(`  ${pair}: P80 entropy ${p80.toFixed(2)} bits, flagged ${flagged}/${entropy.length}\n`);
  }

  // DD brake simulation (just verify logic works)
  console.log('\n[DD Brake] Logic validation...');
  const brake=new DDBrake();
  const testNow=Date.now();
  brake.recordDaily('2026-03-01',-50);
  brake.recordDaily('2026-03-02',-30);
  brake.recordDaily('2026-03-03',-80);
  const scale14=brake.getSizeScale(testNow,500);
  console.log(`  Simulated -$160 losses over 3d, capital $500 → size scale: ${scale14}`);

  const summary={
    phase:'4 — DD Reduction',
    runtime_s:(Date.now()-t0)/1000,
    hrp:{weights:hrpAlloc,order:order.map(i=>corrPairs[i]),n_linkage_steps:linkage.length},
    correlation_avg:corrM.flat().filter(x=>x!==1&&x!==0).reduce((a,x)=>a+x,0)/(corrM.length*corrM.length-corrM.length),
    entropy:entropyResults,
    dd_brake:{thresholds:{'14d':'15%→0.5x, 25%→stop 24h','30d':'35%→stop 72h'}}
  };
  fs.writeFileSync(path.join(RESULTS_DIR,'04_dd_reduction.json'),JSON.stringify(summary,null,2));

  console.log('\n'+'═'.repeat(80));console.log('FASE 4 COMPLETE');console.log('═'.repeat(80));
  console.log(`Runtime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`\nHRP weights range: ${(Math.min(...weights)*100).toFixed(1)}% to ${(Math.max(...weights)*100).toFixed(1)}%`);
  console.log(`Avg correlation: ${summary.correlation_avg.toFixed(3)}`);
  console.log(`Entropy threshold: ${(Object.values(entropyResults).reduce((a,v)=>a+v.p80,0)/Object.keys(entropyResults).length).toFixed(2)} bits avg`);
  console.log(`\nSaved: ${RESULTS_DIR}/04_dd_reduction.json`);
}
main().catch(e=>{console.error(e);process.exit(1);});
