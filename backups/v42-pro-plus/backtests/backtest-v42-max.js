#!/usr/bin/env node
'use strict';
// v42 MAX unified pipeline: GBM scoring + orderflow-lite features + HMM 3-state regime
// Single walk-forward 274d, ablation A / A+B / A+E / FULL
// Universe: v42 PRO 15 pairs
// GATE vs v42 PRO baseline (PF 1.30 DD 24%): PF>1.35 AND DD<=26%

const fs=require('fs');const path=require('path');
const PAIRS=['ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT','SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'];
const KLINES_DIR='/tmp/binance-klines-1m';
const INIT_CAP=500,POS_SIZE_BASE=2500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002,SEED=314159265;
const CLUSTERS={BTCUSDT:'L1major',ETHUSDT:'L1major',SOLUSDT:'SOLadj',AVAXUSDT:'SOLadj',SUIUSDT:'SOLadj',APTUSDT:'SOLadj',SEIUSDT:'SOLadj',NEARUSDT:'SOLadj',UNIUSDT:'DeFi',LINKUSDT:'DeFi',INJUSDT:'DeFi',RUNEUSDT:'DeFi',JUPUSDT:'DeFi',FILUSDT:'DeFi',ATOMUSDT:'DeFi',DOTUSDT:'DeFi',ARBUSDT:'L2',OPUSDT:'L2',POLUSDT:'L2',BNBUSDT:'Other',XRPUSDT:'Other',ADAUSDT:'Other',LTCUSDT:'Other',TRXUSDT:'Other',TIAUSDT:'Other',DOGEUSDT:'MemesAI','1000PEPEUSDT':'MemesAI',WLDUSDT:'MemesAI',FETUSDT:'MemesAI',RENDERUSDT:'MemesAI'};
function P(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggTF(b1m,m){const o=[];const s=m*60000;let i0=0;while(i0<b1m.length&&(b1m[i0][0]%s)!==0)i0++;for(let i=i0;i<b1m.length;i+=m){const g=b1m.slice(i,i+m);if(g.length<m)break;let h=-Infinity,l=Infinity,v=0,tbv=0,qv=0;for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];qv+=b[7];}const c=g[g.length-1][4],tsv=v-tbv,ti=v>0?(tbv-tsv)/v:0;o.push({t:g[0][0],o:g[0][1],h,l,c,v,tbv,tsv,ti,qv});}return o;}
const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const rsI=(c,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;};
const bb=(c,p=20,m2=2)=>{const mid=sm(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};};
const mcd=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};};
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

// Features: V41 base (10) + orderflow-lite (5) = 15 features
function allFeatures(bars){
  const n=bars.length;const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);const ti=new Float64Array(n),tbv=new Float64Array(n),tsv=new Float64Array(n);
  for(let i=0;i<n;i++){const b=bars[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;ti[i]=b.ti;tbv[i]=b.tbv;tsv[i]=b.tsv;}
  const atr2=at(h,l,c),adx2=ax(h,l,c),mc=mcd(c),e9=em(c,9),e21=em(c,21),e50=em(c,50),vsma=sm(v,20);
  const ofi4h=new Float64Array(n);for(let i=0;i<n;i++){let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=tbv[j]-tsv[j];ofi4h[i]=s;}
  // Orderflow-lite (derived from existing taker data):
  // F10: tick imbalance 5h = sum(buy-sell)/volume 5-bar
  const tibuy5=new Float64Array(n);for(let i=0;i<n;i++){let nb=0,vv=0;for(let j=Math.max(0,i-4);j<=i;j++){nb+=tbv[j]-tsv[j];vv+=v[j];}tibuy5[i]=vv>0?nb/vv:0;}
  // F11: tick imbalance 24h
  const tibuy24=new Float64Array(n);for(let i=23;i<n;i++){let nb=0,vv=0;for(let j=i-23;j<=i;j++){nb+=tbv[j]-tsv[j];vv+=v[j];}tibuy24[i]=vv>0?nb/vv:0;}
  // F12: VPIN proxy = |buy-sell|/vol rolling 12h
  const vpin12=new Float64Array(n);for(let i=11;i<n;i++){let nb=0,vv=0;for(let j=i-11;j<=i;j++){nb+=Math.abs(tbv[j]-tsv[j]);vv+=v[j];}vpin12[i]=vv>0?nb/vv:0;}
  // F13: Large trade flag (volume >2sd over 24h rolling mean)
  const largeVol=new Float64Array(n);for(let i=24;i<n;i++){let su=0,sq=0,cnt=0;for(let j=i-23;j<=i;j++){su+=v[j];sq+=v[j]*v[j];cnt++;}const mu=su/cnt,sd=Math.sqrt(sq/cnt-mu*mu);largeVol[i]=sd>0?(v[i]-mu)/sd:0;}
  // F14: Trade intensity — count of high-vol bars in 12h window
  const tradeInt=new Float64Array(n);for(let i=12;i<n;i++){let cnt=0;for(let j=i-11;j<=i;j++){if(largeVol[j]>1.5)cnt++;}tradeInt[i]=cnt/12;}
  const fs2=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);};
  // V41 base 10
  F(i=>(adx2.adx[i]-25)/25);F(i=>mc.hist[i]/(atr2[i]||1));F(i=>(e9[i]-e21[i])/(atr2[i]||1));F(i=>(e21[i]-e50[i])/(atr2[i]||1));F(i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F(i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F(i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F(i=>ti[i]);F(i=>{let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=ti[j];return s/4;});F(i=>ofi4h[i]/(vsma[i]*4||1));
  // Orderflow-lite 5
  F(i=>tibuy5[i]);F(i=>tibuy24[i]);F(i=>vpin12[i]);F(i=>largeVol[i]);F(i=>tradeInt[i]);
  return{fs:fs2,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};
}

// Shallow regression tree (depth d, greedy MSE split, bootstrap supported)
// Input: X [samples][features], y [samples], weight [samples]
function buildTree(X,y,maxDepth,minLeaf){
  const n=X.length;const nf=X[0].length;
  function leafValue(idx){if(!idx.length)return 0;let s=0;for(const i of idx)s+=y[i];return s/idx.length;}
  function split(idx,depth){
    if(depth>=maxDepth||idx.length<2*minLeaf){return{leaf:true,val:leafValue(idx)};}
    let bestFeat=-1,bestThr=0,bestLoss=Infinity,bestL=null,bestR=null;
    // Compute parent SSE
    let parentMean=0;for(const i of idx)parentMean+=y[i];parentMean/=idx.length;
    let parentSSE=0;for(const i of idx)parentSSE+=(y[i]-parentMean)**2;
    // Sample feature subset (sqrt n_features for speed)
    const nSample=Math.max(3,Math.floor(Math.sqrt(nf)));
    const featSet=[];const seen=new Set();while(featSet.length<nSample){const f=Math.floor(Math.random()*nf);if(!seen.has(f)){seen.add(f);featSet.push(f);}}
    for(const f of featSet){
      // Extract values for this feature, sort
      const vals=idx.map(i=>[X[i][f],y[i],i]).sort((a,b)=>a[0]-b[0]);
      let leftSum=0,leftN=0;const rightSum=vals.reduce((s,v)=>s+v[1],0);const rightN=vals.length;
      let leftSum2=0,rightSum2=vals.reduce((s,v)=>s+v[1]*v[1],0);
      for(let k=0;k<vals.length-1;k++){
        const[xv,yv]=vals[k];leftSum+=yv;leftSum2+=yv*yv;
        const newRN=rightN-k-1;const newLN=k+1;
        if(newLN<minLeaf||newRN<minLeaf)continue;
        if(vals[k+1][0]===xv)continue;
        const rSum=rightSum-leftSum,rSum2=rightSum2-leftSum2;
        const lMean=leftSum/newLN,rMean=rSum/newRN;
        const lSSE=leftSum2-newLN*lMean*lMean;
        const rSSE=rSum2-newRN*rMean*rMean;
        const loss=lSSE+rSSE;
        if(loss<bestLoss){
          bestLoss=loss;bestFeat=f;bestThr=(xv+vals[k+1][0])/2;
          bestL=vals.slice(0,k+1).map(v=>v[2]);bestR=vals.slice(k+1).map(v=>v[2]);
        }
      }
    }
    if(bestFeat===-1||bestLoss>=parentSSE)return{leaf:true,val:parentMean};
    return{leaf:false,feat:bestFeat,thr:bestThr,L:split(bestL,depth+1),R:split(bestR,depth+1)};
  }
  return split([...Array(n).keys()],0);
}
function predictTree(tree,x){let n=tree;while(!n.leaf){n=x[n.feat]<=n.thr?n.L:n.R;}return n.val;}

// GBM: fit a series of shallow trees with shrinkage on residuals
function trainGBM(X,y,opts){
  const{nEst=80,maxDepth=3,minLeaf=30,lr=0.08,subsample=0.7}=opts||{};
  const n=X.length;
  // Initial prediction = mean
  let pred=new Float64Array(n);let mu=0;for(const v of y)mu+=v;mu/=n;for(let i=0;i<n;i++)pred[i]=mu;
  const trees=[];trees.push({leaf:true,val:mu});
  for(let t=0;t<nEst;t++){
    // Residuals
    const resid=new Array(n);for(let i=0;i<n;i++)resid[i]=y[i]-pred[i];
    // Bootstrap subsample
    const sampIdx=[];for(let i=0;i<n;i++)if(Math.random()<subsample)sampIdx.push(i);
    if(sampIdx.length<100)continue;
    const sX=sampIdx.map(i=>X[i]);const sY=sampIdx.map(i=>resid[i]);
    const tree=buildTree(sX,sY,maxDepth,minLeaf);
    trees.push(tree);
    for(let i=0;i<n;i++)pred[i]+=lr*predictTree(tree,X[i]);
  }
  return{trees,lr,mu};
}
function predictGBM(model,x){let p=model.mu;for(let i=1;i<model.trees.length;i++)p+=model.lr*predictTree(model.trees[i],x);return p;}

// HMM 3-state Gaussian (univariate). Features combined to scalar = realized vol × (ADX strength).
// Estados: 0=bear-trend, 1=chop, 2=bull-trend
// Simplified: kmeans-init, fixed params (no Baum-Welch). Good enough for regime classification.
function fitHMM3(seqVals){
  // k-means init to 3 clusters sorted
  const sorted=[...seqVals].sort((a,b)=>a-b);
  const q=[sorted[Math.floor(sorted.length/6)],sorted[Math.floor(sorted.length/2)],sorted[Math.floor(sorted.length*5/6)]];
  const means=q;const stds=[0,0,0];const cnts=[0,0,0];const sumSq=[0,0,0];
  for(const v of seqVals){
    let best=0,bd=Math.abs(v-means[0]);for(let k=1;k<3;k++){const d=Math.abs(v-means[k]);if(d<bd){bd=d;best=k;}}
    cnts[best]++;sumSq[best]+=(v-means[best])**2;
  }
  for(let k=0;k<3;k++)stds[k]=cnts[k]>0?Math.max(1e-6,Math.sqrt(sumSq[k]/cnts[k])):1;
  // Transition matrix: biased to stay (sticky)
  const A=[[0.92,0.06,0.02],[0.05,0.90,0.05],[0.02,0.06,0.92]];
  return{means,stds,A};
}
function viterbi(seqVals,hmm){
  const n=seqVals.length;const{means,stds,A}=hmm;
  const K=3;const logA=A.map(r=>r.map(p=>Math.log(Math.max(1e-12,p))));
  const gauss=(x,mu,sd)=>{const d=(x-mu)/sd;return -0.5*d*d-Math.log(sd)-0.9189;};
  const delta=new Float64Array(n*K).fill(-Infinity);const psi=new Int8Array(n*K);
  for(let k=0;k<K;k++)delta[k]=gauss(seqVals[0],means[k],stds[k]);
  for(let t=1;t<n;t++){
    for(let j=0;j<K;j++){
      let best=-Infinity,bi=0;
      for(let i=0;i<K;i++){const v=delta[(t-1)*K+i]+logA[i][j];if(v>best){best=v;bi=i;}}
      delta[t*K+j]=best+gauss(seqVals[t],means[j],stds[j]);
      psi[t*K+j]=bi;
    }
  }
  // Backtrack
  const states=new Int8Array(n);let best=-Infinity,bi=0;
  for(let k=0;k<K;k++){if(delta[(n-1)*K+k]>best){best=delta[(n-1)*K+k];bi=k;}}
  states[n-1]=bi;
  for(let t=n-2;t>=0;t--)states[t]=psi[(t+1)*K+states[t+1]];
  // Smooth: min 6h dwell
  const smoothed=new Int8Array(n);smoothed[0]=states[0];
  let runStart=0;
  for(let t=1;t<n;t++){
    if(states[t]!==smoothed[t-1]){
      // Check if prev run < 6 bars
      if(t-runStart<6){smoothed[t]=smoothed[t-1];}
      else{smoothed[t]=states[t];runStart=t;}
    } else smoothed[t]=smoothed[t-1];
  }
  return smoothed;
}

// Compute HMM observation: log realized vol × ADX
function hmmObs(bars){
  const n=bars.length;
  const c=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n);
  for(let i=0;i<n;i++){const b=bars[i];c[i]=b.c;h[i]=b.h;l[i]=b.l;}
  const adxR=ax(h,l,c);
  const obs=new Float64Array(n);
  for(let i=12;i<n;i++){
    let sum=0,cnt=0;for(let j=i-11;j<=i;j++){const r=c[j]>c[j-1]?Math.log(c[j]/c[j-1]):0;sum+=r*r;cnt++;}
    const rv=Math.sqrt(sum/cnt);
    const adxN=(adxR.adx[i]||15)/50;
    obs[i]=Math.log(Math.max(1e-6,rv))+Math.log(Math.max(0.1,adxN));
  }
  return obs;
}

function compute4HTrend(b4h){const n=b4h.length;const c=Float64Array.from(b4h.map(b=>b.c));const e9=em(c,9),e21=em(c,21);const trend=new Int8Array(n);for(let i=0;i<n;i++){trend[i]=e9[i]>e21[i]?1:(e9[i]<e21[i]?-1:0);}return trend;}
function findPrev(arr,ts){let lo=0,hi=arr.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(arr[m]<=ts){b=m;lo=m+1;}else hi=m-1;}return b;}
function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,sharpe:0,mdd:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));const byDay={};for(const x of t){byDay[x.date]=(byDay[x.date]||0)+x.pnl;}const dR=Object.values(byDay);const mD=dR.reduce((a,x)=>a+x,0)/dR.length;const vD=dR.reduce((a,x)=>a+(x-mD)**2,0)/dR.length;const sharpe=vD>0?mD/Math.sqrt(vD)*Math.sqrt(365):0;let cum=0,pk=0,mdd=0;for(const x of t){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,sharpe,mdd};}

async function genGBMSignals(allData,useOrderflow,useHMM){
  // Walk-forward 120/30/30 × 5 windows
  const TRAIN_D=120,TEST_D=30,STEP_D=30,firstTs=Math.min(...Object.values(allData).map(d=>d.b1h[0].t));
  const nW=Math.floor((274-TRAIN_D-TEST_D)/STEP_D)+1;
  const signals=[];const parsed={};const importance={};
  for(let w=0;w<nW;w++){
    const trs=firstTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;
    process.stdout.write(`W${w+1}/${nW} `);
    for(const pair of PAIRS){
      if(!allData[pair])continue;
      const tB=allData[pair].b1h.filter(b=>b.t>=trs&&b.t<tre);if(tB.length<300)continue;
      const F=allFeatures(tB);
      // Restrict features
      const nFeat=useOrderflow?15:10;
      // Build training set
      const X=[],Y=[];
      for(let i=55;i<F.n-2;i++){
        if(F.adx[i]<22)continue;
        const row=[];for(let f=0;f<nFeat;f++)row.push(F.fs[f][i]);
        const ret=(F.c[i+2]-F.c[i])/F.c[i]*100;
        X.push(row);Y.push(ret);
      }
      if(X.length<200)continue;
      const model=trainGBM(X,Y,{nEst:60,maxDepth:3,minLeaf:40,lr:0.08,subsample:0.7});
      // Score on test window
      const teB=allData[pair].b1h.filter(b=>b.t>=tes&&b.t<tee);if(teB.length<50)continue;
      const te4=allData[pair].b4h.filter(b=>b.t>=tes-4*3600000&&b.t<tee);
      const F2=allFeatures(teB);
      // HMM observation on TRAIN window, apply Viterbi on TEST with fit
      let trendState=null;
      if(useHMM){
        const obsTr=hmmObs(tB);const obsTrC=[];for(let i=12;i<obsTr.length;i++)obsTrC.push(obsTr[i]);
        const hmm=fitHMM3(obsTrC);
        const obsTe=hmmObs(teB);const obsTeC=[];for(let i=12;i<obsTe.length;i++)obsTeC.push(obsTe[i]);
        const states=viterbi(obsTeC,hmm);
        trendState=new Int8Array(F2.n);for(let i=12;i<F2.n&&i-12<states.length;i++)trendState[i]=states[i-12];
      }
      if(!parsed[pair])parsed[pair]={t:[...F2.t],o:[...F2.o],h:[...F2.h],l:[...F2.l],c:[...F2.c],atr:[...F2.atr]};else{for(let i=0;i<F2.t.length;i++){parsed[pair].t.push(F2.t[i]);parsed[pair].o.push(F2.o[i]);parsed[pair].h.push(F2.h[i]);parsed[pair].l.push(F2.l[i]);parsed[pair].c.push(F2.c[i]);parsed[pair].atr.push(F2.atr[i]);}}
      const trend4=compute4HTrend(te4);const t4=te4.map(b=>b.t);
      // Collect training-set scores for threshold calibration
      const trainScores=[];
      for(let i=55;i<F.n;i++){
        if(F.adx[i]<22)continue;
        const row=[];for(let f=0;f<nFeat;f++)row.push(F.fs[f][i]);
        const sc=predictGBM(model,row);trainScores.push(Math.abs(sc));
      }
      trainScores.sort((a,b)=>a-b);
      const thr=trainScores[Math.floor(trainScores.length*0.55)]||0.05;
      let last=-3;
      for(let i=55;i<F2.n-60-1;i++){
        if(i-last<2)continue;if(F2.adx[i]<22)continue;
        const row=[];for(let f=0;f<nFeat;f++)row.push(F2.fs[f][i]);
        const sc=predictGBM(model,row);
        const absSc=Math.abs(sc);
        if(absSc<thr)continue;
        const dir=sc>0?1:-1;
        const b4=findPrev(t4,F2.t[i]);if(b4<0||trend4[b4]!==dir)continue;
        // HMM gate: only trend states (0 or 2)
        if(useHMM){
          const regime=trendState?trendState[i]:1;
          if(regime===1)continue; // chop = skip momentum
        }
        const absIdx=parsed[pair].t.length-F2.n+i;
        const confRatio=absSc/thr;
        const hr=new Date(F2.t[i]).getUTCHours();
        signals.push({pair,ts:F2.t[i],dir,absIdx,atr:F2.atr[i],confRatio,hr});last=i;
      }
    }
  }
  process.stdout.write('\n');
  signals.sort((a,b)=>a.ts-b.ts);
  return{signals,parsed};
}

function run(signals,parsed){
  const SKIP=new Set([0,7,10,11,12,13,17,18]);
  const MAXP=4,MAXCL=3;
  const tierThr=[5,15,30];const tierMul=[0.3,1.0,1.2,1.5];
  let cap=INIT_CAP;const trades=[];const slots=new Array(MAXP).fill(null);const prng=P(SEED);
  const vpct={};for(const p of Object.keys(parsed)){const pd=parsed[p];const aps=[];for(let i=50;i<pd.c.length;i++){if(pd.c[i]>0&&pd.atr[i]>0)aps.push(pd.atr[i]/pd.c[i]);}aps.sort((a,b)=>a-b);vpct[p]={p66:aps[Math.floor(aps.length*0.66)]||0};}
  function getTier(pctAbove){if(pctAbove<tierThr[0])return 1;if(pctAbove<tierThr[1])return 2;if(pctAbove<tierThr[2])return 3;return 4;}
  function cls(si,j,reason){const pos=slots[si];const pd=parsed[pos.pair];let ep2;if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(reason==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;const fE=pos.sz*FEE_E,fX=pos.sz*(reason==='TP'?FEE_TP:FEE_SL);const pnl=g-fE-fX;cap+=pnl;trades.push({pnl,type:reason,pair:pos.pair,date:new Date(pd.t[j]).toISOString().slice(0,10),tier:pos.tier});slots[si]=null;}
  function advance(upTs){for(let si=0;si<MAXP;si++){const pos=slots[si];if(!pos)continue;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upTs;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){cls(si,j,'SL');break;}if(hT){cls(si,j,'TP');break;}pos.nc=j+1;}if(slots[si]&&slots[si].nc>slots[si].exp){cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}}
  for(const sig of signals){
    if(cap<=0)break;
    if(SKIP.has(sig.hr))continue;
    const pd=parsed[sig.pair];if(!pd)continue;
    const eb=sig.absIdx+1;if(eb>=pd.c.length)continue;
    advance(pd.t[eb]);
    const clCnts={};for(const s of slots)if(s)clCnts[CLUSTERS[s.pair]||'o']=(clCnts[CLUSTERS[s.pair]||'o']||0)+1;
    const cl=CLUSTERS[sig.pair]||'o';if((clCnts[cl]||0)>=MAXCL)continue;
    let pairConflict=false;for(const s of slots)if(s&&s.pair===sig.pair){pairConflict=true;break;}
    if(pairConflict)continue;
    let freeSlot=-1;for(let si=0;si<MAXP;si++)if(!slots[si]){freeSlot=si;break;}
    if(freeSlot===-1)continue;
    if(prng()>=0.75)continue;if(cap<50)continue;
    const ep=pd.o[eb],atrA=pd.atr[sig.absIdx],ap=atrA/pd.c[sig.absIdx];if(ap<=0||isNaN(ap))continue;
    let slM=2,tpR=1.625;const{p66}=vpct[sig.pair]||{p66:0};if(ap>p66){slM=2.5;tpR=1.4;}
    const slPct=Math.max(0.003,Math.min(0.03,ap*slM));const tpPct=Math.max(0.005,Math.min(0.08,slPct*tpR));
    const pctAbove=(sig.confRatio-1)*100;const tier=getTier(pctAbove);const mult=tierMul[tier-1];const sz=POS_SIZE_BASE*mult;
    slots[freeSlot]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-slPct):ep*(1+slPct),tpP:sig.dir===1?ep*(1+tpPct):ep*(1-tpPct),qty:sz/ep,sz,tier,eb,exp:eb+60,nc:eb+1};
  }
  advance(Infinity);for(let si=0;si<MAXP;si++){if(slots[si]){const pd=parsed[slots[si].pair];cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}
  return{trades};
}

async function runVariant(name,allData,useOF,useHMM){
  console.log(`\n── ${name} (orderflow:${useOF} hmm:${useHMM}) ──`);
  const{signals,parsed}=await genGBMSignals(allData,useOF,useHMM);
  console.log(`Signals: ${signals.length}`);
  const r=run(signals,parsed);
  const s=st(r.trades);
  const ddP=(s.mdd/(INIT_CAP+s.pnl))*100;
  const tpd=s.n/150;
  console.log(`${name.padEnd(18)} ${s.n}t PF${s.pf.toFixed(2)} WR${s.wr.toFixed(1)}% DD${ddP.toFixed(0)}% Sh${s.sharpe.toFixed(1)} $${s.pnl.toFixed(0)} t/d${tpd.toFixed(2)}`);
  return{name,signals:signals.length,s,ddP,tpd};
}

async function main(){
  console.log('v42 MAX ABLATION — GBM + orderflow-lite + HMM regime');
  console.log('='.repeat(80));
  // Deterministic RNG for Math.random() used in tree bootstrap/feature sampling
  const rng=P(SEED);const oldRand=Math.random;Math.random=rng;
  const allData={};
  for(const pair of PAIRS){const b1m=load1m(pair);if(!b1m||b1m.length<50000)continue;const b1h=aggTF(b1m,60);const b4h=aggTF(b1m,240);allData[pair]={b1h,b4h};}
  console.log(`Loaded ${Object.keys(allData).length}/15 pairs`);
  const results=[];
  results.push(await runVariant('A (GBM only)',allData,false,false));
  results.push(await runVariant('A+B (GBM+OF)',allData,true,false));
  results.push(await runVariant('A+E (GBM+HMM)',allData,false,true));
  results.push(await runVariant('A+B+E (FULL)',allData,true,true));
  Math.random=oldRand;

  console.log('\n'+'='.repeat(80));
  console.log('SUMMARY — v42 MAX variants vs v42 PRO baseline (PF 1.30, DD 24%, 5.14 t/d)');
  console.log('='.repeat(80));
  console.log('Variant             Trades  PF    WR     DD   Sh    PnL    t/d    GATE(PF>1.35,DD<=26%)');
  console.log('-'.repeat(96));
  for(const r of results){
    const pass=r.s.pf>1.35&&r.ddP<=26;
    console.log(`${r.name.padEnd(20)} ${String(r.s.n).padStart(4)}  ${r.s.pf.toFixed(2)}  ${r.s.wr.toFixed(1).padStart(4)}%  ${r.ddP.toFixed(0).padStart(3)}%  ${r.s.sharpe.toFixed(1).padStart(4)}  $${r.s.pnl.toFixed(0).padStart(5)}  ${r.tpd.toFixed(2)}  ${pass?'★ PASS':'✗ FAIL'}`);
  }
  // Best
  const best=results.filter(r=>r.s.pf>1.35&&r.ddP<=26).sort((a,b)=>b.s.sharpe-a.s.sharpe)[0];
  if(best){
    console.log(`\n🏆 v42 MAX WINNER: ${best.name} — activate as optional UI engine`);
  } else {
    console.log('\n✗ NO v42 MAX variant passes gate. DESCARTAR. Default remains v42 PRO.');
  }
  fs.writeFileSync('/tmp/v42-max-result.json',JSON.stringify(results,null,2));
}
main().catch(e=>{console.error(e);process.exit(1);});
