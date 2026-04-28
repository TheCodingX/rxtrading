#!/usr/bin/env node
'use strict';
// Mejora Recalibration: isotonic (PAVA) calibration of APEX v41 confidence score
// Goal: fix T3/T4 non-monotonicity flagged in Mejora 2. In-sample upper-bound.
// Steps:
//   1) Replay V41 signals + uniform backtest, collect (rawScore, win) pairs per trade
//   2) WR by decile of raw score — monotonicity check
//   3) Fit PAVA: raw → empirical P(win), monotone non-decreasing
//   4) Re-tier using calibrated score, re-run with V41 tiered sizing
//   5) Report deltas vs V41 uniform & V41 tiered (compact/aggressive & wide/conservative)

const fs=require('fs');
const path=require('path');

const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT','LINKUSDT','LTCUSDT','DOTUSDT','ATOMUSDT','UNIUSDT','TRXUSDT','NEARUSDT','APTUSDT','POLUSDT','FILUSDT','ARBUSDT','OPUSDT','INJUSDT','SUIUSDT','TIAUSDT','SEIUSDT','RUNEUSDT','1000PEPEUSDT','WLDUSDT','FETUSDT','RENDERUSDT','JUPUSDT'];
const KLINES_DIR='/tmp/binance-klines-1m';
const INIT_CAP=500,POS_SIZE_BASE=2500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002,SEED=314159265;
const CLUSTERS={BTCUSDT:'L1major',ETHUSDT:'L1major',SOLUSDT:'SOLadj',AVAXUSDT:'SOLadj',SUIUSDT:'SOLadj',APTUSDT:'SOLadj',SEIUSDT:'SOLadj',NEARUSDT:'SOLadj',UNIUSDT:'DeFi',LINKUSDT:'DeFi',INJUSDT:'DeFi',RUNEUSDT:'DeFi',JUPUSDT:'DeFi',FILUSDT:'DeFi',ATOMUSDT:'DeFi',DOTUSDT:'DeFi',ARBUSDT:'L2',OPUSDT:'L2',POLUSDT:'L2',BNBUSDT:'Other',XRPUSDT:'Other',ADAUSDT:'Other',LTCUSDT:'Other',TRXUSDT:'Other',TIAUSDT:'Other',DOGEUSDT:'MemesAI','1000PEPEUSDT':'MemesAI',WLDUSDT:'MemesAI',FETUSDT:'MemesAI',RENDERUSDT:'MemesAI'};

function P(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggTF(b1m,m){const o=[];const s=m*60000;let i0=0;while(i0<b1m.length&&(b1m[i0][0]%s)!==0)i0++;for(let i=i0;i<b1m.length;i+=m){const g=b1m.slice(i,i+m);if(g.length<m)break;let h=-Infinity,l=Infinity,v=0,tbv=0;for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];}const c=g[g.length-1][4],tsv=v-tbv,ti=v>0?(tbv-tsv)/v:0;o.push({t:g[0][0],o:g[0][1],h,l,c,v,tbv,tsv,ti});}return o;}
const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const rsI=(c,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;};
const bb=(c,p=20,m2=2)=>{const mid=sm(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};};
const mcd=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};};
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

function momFeatures(bars){const n=bars.length;const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);const ti=new Float64Array(n),tbv=new Float64Array(n),tsv=new Float64Array(n);for(let i=0;i<n;i++){const b=bars[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;ti[i]=b.ti;tbv[i]=b.tbv;tsv[i]=b.tsv;}const atr2=at(h,l,c),adx2=ax(h,l,c),mc=mcd(c),e9=em(c,9),e21=em(c,21),e50=em(c,50),vsma=sm(v,20);const ofi4h=new Float64Array(n);for(let i=0;i<n;i++){let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=tbv[j]-tsv[j];ofi4h[i]=s;}const fs2=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);};F(i=>(adx2.adx[i]-25)/25);F(i=>mc.hist[i]/(atr2[i]||1));F(i=>(e9[i]-e21[i])/(atr2[i]||1));F(i=>(e21[i]-e50[i])/(atr2[i]||1));F(i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F(i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F(i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F(i=>ti[i]);F(i=>{let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=ti[j];return s/4;});F(i=>ofi4h[i]/(vsma[i]*4||1));return{fs:fs2,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};}
function revFeatures(bars){const n=bars.length;const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);for(let i=0;i<n;i++){const b=bars[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;}const atr2=at(h,l,c),adx2=ax(h,l,c),r14=rsI(c,14),r7=rsI(c,7),bbd=bb(c,20,2),vsma=sm(v,20);const fs2=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);};F(i=>(50-r14[i])/50);F(i=>(50-r7[i])/50);F(i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);F(i=>{if(h[i]===l[i])return 0;const upW=h[i]-Math.max(o[i],c[i]);const loW=Math.min(o[i],c[i])-l[i];return(loW-upW)/(h[i]-l[i]);});F(i=>vsma[i]>0?v[i]/vsma[i]-1:0);F(i=>i>=3?-(c[i]-c[i-3])/c[i-3]*100:0);F(i=>i>=6?-(c[i]-c[i-6])/c[i-6]*100:0);return{fs:fs2,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};}
function pearson(fs,y,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],yv=y[i];if(isNaN(x)||isNaN(yv))continue;sx+=x;sy+=yv;sxy+=x*yv;sx2+=x*x;sy2+=yv*yv;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}
function compute4HTrend(b4h){const n=b4h.length;const c=Float64Array.from(b4h.map(b=>b.c));const e9=em(c,9),e21=em(c,21);const trend=new Int8Array(n);for(let i=0;i<n;i++){trend[i]=e9[i]>e21[i]?1:(e9[i]<e21[i]?-1:0);}return trend;}
function findPrev(arr,ts){let lo=0,hi=arr.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(arr[m]<=ts){b=m;lo=m+1;}else hi=m-1;}return b;}
function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,sharpe:0,mdd:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));const byDay={};for(const x of t){byDay[x.date]=(byDay[x.date]||0)+x.pnl;}const dR=Object.values(byDay);const mD=dR.reduce((a,x)=>a+x,0)/dR.length;const vD=dR.reduce((a,x)=>a+(x-mD)**2,0)/dR.length;const sharpe=vD>0?mD/Math.sqrt(vD)*Math.sqrt(365):0;let cum=0,pk=0,mdd=0;for(const x of t){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,sharpe,mdd};}

// Generate walk-forward signals; keep raw absComp and thr separately
async function genAllSignals(allData){
  const signals=[];const parsed={};
  const TRAIN_D=120,TEST_D=30,STEP_D=30,firstTs=Math.min(...Object.values(allData).map(d=>d.b1h[0].t));
  const nW=Math.floor((274-TRAIN_D-TEST_D)/STEP_D)+1;
  for(let w=0;w<nW;w++){
    const trs=firstTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;
    const pm={};
    for(const pair of PAIRS){if(!allData[pair])continue;const tB=allData[pair].b1h.filter(b=>b.t>=trs&&b.t<tre);if(tB.length<300)continue;const Fm=momFeatures(tB);const Fr=revFeatures(tB);const fwd=new Float64Array(Fm.n).fill(NaN);for(let i=50;i<Fm.n-2;i++)fwd[i]=(Fm.c[i+2]-Fm.c[i])/Fm.c[i]*100;const coM=pearson(Fm.fs,fwd,50,Fm.n-2);const coR=pearson(Fr.fs,fwd,50,Fr.n-2);const selM=coM.map((c,i)=>({idx:i,corr:c,abs:Math.abs(c)})).filter(x=>x.abs>=0.011).sort((a,b)=>b.abs-a.abs).slice(0,6);const selR=coR.map((c,i)=>({idx:i,corr:c,abs:Math.abs(c)})).filter(x=>x.abs>=0.011).sort((a,b)=>b.abs-a.abs).slice(0,6);if(selM.length<2)continue;let tcM=[];for(let i=55;i<Fm.n;i++){if(Fm.adx[i]<22)continue;let comp=0;for(const{idx,corr}of selM)comp+=corr*Fm.fs[idx][i];tcM.push(Math.abs(comp));}tcM.sort((a,b)=>a-b);let tcR=[];for(let i=55;i<Fr.n;i++){if(Fr.adx[i]<22)continue;let comp=0;for(const{idx,corr}of selR)comp+=corr*Fr.fs[idx][i];tcR.push(Math.abs(comp));}tcR.sort((a,b)=>a-b);const thrM=tcM[Math.floor(tcM.length*0.55)]||0.001;const thrR=tcR[Math.floor(tcR.length*0.55)]||0.001;pm[pair]={selM,selR,thrM,thrR};}
    if(Object.keys(pm).length<8)continue;
    for(const pair of PAIRS){if(!pm[pair])continue;const teB=allData[pair].b1h.filter(b=>b.t>=tes&&b.t<tee);if(teB.length<50)continue;const te4=allData[pair].b4h.filter(b=>b.t>=tes-4*3600000&&b.t<tee);const Fm=momFeatures(teB);const Fr=revFeatures(teB);if(!parsed[pair])parsed[pair]={t:[...Fm.t],o:[...Fm.o],h:[...Fm.h],l:[...Fm.l],c:[...Fm.c],atr:[...Fm.atr]};else{for(let i=0;i<Fm.t.length;i++){parsed[pair].t.push(Fm.t[i]);parsed[pair].o.push(Fm.o[i]);parsed[pair].h.push(Fm.h[i]);parsed[pair].l.push(Fm.l[i]);parsed[pair].c.push(Fm.c[i]);parsed[pair].atr.push(Fm.atr[i]);}}const{selM,selR,thrM,thrR}=pm[pair];const trend4=compute4HTrend(te4);const t4=te4.map(b=>b.t);let last=-3;for(let i=55;i<Fm.n-60-1;i++){if(i-last<2)continue;if(Fm.adx[i]<22)continue;let compM=0;for(const{idx,corr}of selM)compM+=corr*Fm.fs[idx][i];let compR=0;for(const{idx,corr}of selR)compR+=corr*Fr.fs[idx][i];const passM=Math.abs(compM)>=thrM;const passR=Math.abs(compR)>=thrR;const dirM=compM>0?1:-1;const dirR=-1*(compR>0?1:-1);let finalDir=0,absComp=0,thrUsed=0;if(passM&&passR&&dirM===dirR){finalDir=dirM;absComp=Math.max(Math.abs(compM),Math.abs(compR));thrUsed=Math.max(thrM,thrR);}else if(passM){finalDir=dirM;absComp=Math.abs(compM);thrUsed=thrM;}else if(passR){finalDir=dirR;absComp=Math.abs(compR);thrUsed=thrR;}if(finalDir===0)continue;const b4=findPrev(t4,Fm.t[i]);if(b4<0||trend4[b4]!==finalDir)continue;const absIdx=parsed[pair].t.length-Fm.n+i;const confRatio=absComp/thrUsed;const hr=new Date(Fm.t[i]).getUTCHours();
      signals.push({pair,ts:Fm.t[i],dir:finalDir,absIdx,atr:Fm.atr[i],confRatio,wIdx:w,hr});last=i;}}
  }
  signals.sort((a,b)=>a.ts-b.ts);
  return{signals,parsed};
}

// PAVA isotonic regression: input sorted (x,y) pairs, output non-decreasing fit
// Returns {xs, ys} breakpoints; evaluate with linear interp
function pava(xRaw,yRaw){
  // Sort by x
  const pairs=xRaw.map((x,i)=>[x,yRaw[i]]).sort((a,b)=>a[0]-b[0]);
  const n=pairs.length;
  // Bin small inputs to reduce variance: group into 30 equal-count bins
  const nBins=Math.min(30,Math.floor(n/20));
  const bins=[];
  const perBin=Math.ceil(n/nBins);
  for(let b=0;b<nBins;b++){
    const s=b*perBin,e=Math.min(n,s+perBin);
    if(s>=e)break;
    let sumX=0,sumY=0,cnt=0;
    for(let i=s;i<e;i++){sumX+=pairs[i][0];sumY+=pairs[i][1];cnt++;}
    bins.push({x:sumX/cnt,y:sumY/cnt,w:cnt});
  }
  // PAVA: merge adjacent violators
  const stack=[];
  for(const b of bins){
    let cur={...b};
    while(stack.length>0 && stack[stack.length-1].y>=cur.y){
      const prev=stack.pop();
      const totalW=prev.w+cur.w;
      cur={x:(prev.x*prev.w+cur.x*cur.w)/totalW,y:(prev.y*prev.w+cur.y*cur.w)/totalW,w:totalW};
    }
    stack.push(cur);
  }
  const xs=stack.map(s=>s.x),ys=stack.map(s=>s.y);
  return{xs,ys};
}
function pavaEval(cal,x){
  const{xs,ys}=cal;
  if(x<=xs[0])return ys[0];
  if(x>=xs[xs.length-1])return ys[ys.length-1];
  let lo=0,hi=xs.length-1;
  while(hi-lo>1){const m=(lo+hi)>>1;if(xs[m]<=x)lo=m;else hi=m;}
  const f=(x-xs[lo])/(xs[hi]-xs[lo]);
  return ys[lo]+f*(ys[hi]-ys[lo]);
}

// Engine: accepts scoreFn(sig) → score for tier assignment
// noCapBreak=true disables cap-zero exit (for calibration data collection)
function run(signals,parsed,scoreFn,tierThresholds,sizeMults,maxPos,clusterMap,maxCluster,skipHoursSet,adaptive,noCapBreak){
  let cap=INIT_CAP;const trades=[];const slots=new Array(maxPos).fill(null);
  const prng=P(SEED);
  // Vol-regime atr% percentiles per pair for adaptive stops
  const vpct={};
  for(const p of Object.keys(parsed)){
    const pd=parsed[p];
    const aps=[];
    for(let i=50;i<pd.c.length;i++){if(pd.c[i]>0&&pd.atr[i]>0)aps.push(pd.atr[i]/pd.c[i]);}
    aps.sort((a,b)=>a-b);
    vpct[p]={p33:aps[Math.floor(aps.length*0.33)]||0,p66:aps[Math.floor(aps.length*0.66)]||0};
  }
  function getTier(score){
    if(score<tierThresholds[0])return 1;
    if(score<tierThresholds[1])return 2;
    if(score<tierThresholds[2])return 3;
    return 4;
  }
  function cls(si,j,reason){const pos=slots[si];const pd=parsed[pos.pair];let ep2;if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(reason==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;const fE=pos.sz*FEE_E, fX=pos.sz*(reason==='TP'?FEE_TP:FEE_SL);const pnl=g-fE-fX;cap+=pnl;trades.push({pnl,type:reason,pair:pos.pair,date:new Date(pd.t[j]).toISOString().slice(0,10),tier:pos.tier,sz:pos.sz,rawScore:pos.rawScore,calScore:pos.calScore,win:pnl>0?1:0});slots[si]=null;}
  function advance(upTs){for(let si=0;si<maxPos;si++){const pos=slots[si];if(!pos)continue;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upTs;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){cls(si,j,'SL');break;}if(hT){cls(si,j,'TP');break;}pos.nc=j+1;}if(slots[si]&&slots[si].nc>slots[si].exp){cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}}
  const dbg={tot:0,capBreak:0,ebSkip:0,todSkip:0,clSkip:0,pairSkip:0,slotSkip:0,prngSkip:0,capSkip:0,apSkip:0,entered:0};
  for(const sig of signals){dbg.tot++;if(cap<=0&&!noCapBreak){dbg.capBreak++;break;}
    // ToD filter FIRST (using sig.hr precomputed at gen time) — matches mejora4 exactly
    if(skipHoursSet&&skipHoursSet.has(sig.hr)){dbg.todSkip++;continue;}
    const pd=parsed[sig.pair];const eb=sig.absIdx+1;if(eb>=pd.c.length){dbg.ebSkip++;continue;}
    advance(pd.t[eb]);
    const clCnts={};for(const s of slots)if(s)clCnts[clusterMap[s.pair]||'o']=(clCnts[clusterMap[s.pair]||'o']||0)+1;
    const cl=clusterMap[sig.pair]||'o';if((clCnts[cl]||0)>=maxCluster){dbg.clSkip++;continue;}
    let pairConflict=false;for(const s of slots)if(s&&s.pair===sig.pair){pairConflict=true;break;}
    if(pairConflict){dbg.pairSkip++;continue;}
    let freeSlot=-1;for(let si=0;si<maxPos;si++)if(!slots[si]){freeSlot=si;break;}
    if(freeSlot===-1){dbg.slotSkip++;continue;}
    if(prng()>=0.75){dbg.prngSkip++;continue;}if(cap<50&&!noCapBreak){dbg.capSkip++;continue;}
    const ep=pd.o[eb],atrA=pd.atr[sig.absIdx],ap=atrA/pd.c[sig.absIdx];if(ap<=0||isNaN(ap)){dbg.apSkip++;continue;}
    dbg.entered++;
    // Adaptive stops by vol regime
    let slM=2,tpR=1.625;
    if(adaptive){const{p66}=vpct[sig.pair]||{p66:0};if(ap>p66){slM=2.5;tpR=1.4;}}
    const slPct=Math.max(0.003,Math.min(0.03,ap*slM));const tpPct=Math.max(0.005,Math.min(0.08,slPct*tpR));
    const rawS=(sig.confRatio-1)*100;
    const calS=scoreFn?scoreFn(sig):rawS;
    const tier=getTier(calS);
    const mult=sizeMults[tier-1];
    const sz=POS_SIZE_BASE*mult;
    slots[freeSlot]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-slPct):ep*(1+slPct),tpP:sig.dir===1?ep*(1+tpPct):ep*(1-tpPct),qty:sz/ep,sz,tier,rawScore:rawS,calScore:calS,eb,exp:eb+60,nc:eb+1};
  }
  advance(Infinity);for(let si=0;si<maxPos;si++){if(slots[si]){const pd=parsed[slots[si].pair];cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}
  return{trades,dbg};
}

function decileReport(trades,scoreKey){
  const sorted=[...trades].sort((a,b)=>a[scoreKey]-b[scoreKey]);
  const n=sorted.length;
  const perBin=Math.ceil(n/10);
  const rows=[];
  for(let d=0;d<10;d++){
    const s=d*perBin,e=Math.min(n,s+perBin);
    if(s>=e)break;
    const bin=sorted.slice(s,e);
    const wins=bin.filter(x=>x.win).length;
    const wr=wins/bin.length*100;
    const avgS=bin.reduce((a,x)=>a+x[scoreKey],0)/bin.length;
    rows.push({d:d+1,n:bin.length,wr,avgS});
  }
  return rows;
}

async function main(){
  console.log('Mejora Recalibration: isotonic (PAVA) calibration of confidence score');
  console.log('─'.repeat(80));
  const allData={};
  for(const pair of PAIRS){const b1m=load1m(pair);if(!b1m||b1m.length<50000)continue;const b1h=aggTF(b1m,60);const b4h=aggTF(b1m,240);allData[pair]={b1h,b4h};}
  console.log(`Loaded ${Object.keys(allData).length}/30 pairs`);
  const{signals,parsed}=await genAllSignals(allData);
  console.log(`Signals: ${signals.length}`);

  const SKIP=new Set([0,7,10,11,12,13,17,18]);
  const MAXP=4,MAXCL=3;

  // ── SANITY: mejora2 equivalent — no ToD, no adaptive ──
  console.log('\n── SANITY CHECK: mejora2-equivalent baseline ──');
  const sanity=run(signals,parsed,null,[999,999,999],[1,1,1,1],MAXP,CLUSTERS,MAXCL,null,false);
  const ss=st(sanity.trades);
  const ssDD=(ss.mdd/(INIT_CAP+ss.pnl))*100;
  console.log(`mejora2-equiv: ${ss.n}t PF${ss.pf.toFixed(2)} WR${ss.wr.toFixed(1)}% DD${ssDD.toFixed(0)}% $${ss.pnl.toFixed(0)}`);

  // Isolate ToD vs adaptive
  const sTOD=run(signals,parsed,null,[999,999,999],[1,1,1,1],MAXP,CLUSTERS,MAXCL,SKIP,false);
  const sT=st(sTOD.trades);console.log(`+ToD only:     ${sT.n}t PF${sT.pf.toFixed(2)} WR${sT.wr.toFixed(1)}% $${sT.pnl.toFixed(0)}`);
  console.log(`   dbg: ${JSON.stringify(sTOD.dbg)}`);
  const sADP=run(signals,parsed,null,[999,999,999],[1,1,1,1],MAXP,CLUSTERS,MAXCL,null,true);
  const sA=st(sADP.trades);console.log(`+Adaptive only:${sA.n}t PF${sA.pf.toFixed(2)} WR${sA.wr.toFixed(1)}% $${sA.pnl.toFixed(0)}`);
  if(ss.n<500){console.log('✗ SANITY FAIL. Aborting.');return;}

  // ── PASS 1: V41 uniform sizing to collect (rawScore, win) pairs (NO CAP BREAK) ──
  console.log('\n── PASS 1: V41 baseline calibration pass (no cap break) ──');
  const v41Uniform=run(signals,parsed,null,[999,999,999],[1,1,1,1],MAXP,CLUSTERS,MAXCL,SKIP,true,true);
  const sU=st(v41Uniform.trades);
  const ddU=(sU.mdd/(INIT_CAP+sU.pnl))*100;
  console.log(`V41-uniform: ${sU.n}t PF${sU.pf.toFixed(2)} WR${sU.wr.toFixed(1)}% DD${ddU.toFixed(0)}% Sh${sU.sharpe.toFixed(1)} $${sU.pnl.toFixed(0)}`);

  // Decile WR by raw score
  console.log('\n── WR BY DECILE OF RAW SCORE ──');
  const rawDec=decileReport(v41Uniform.trades,'rawScore');
  let strictMono=true,t34Mono=true;
  for(let i=0;i<rawDec.length;i++){
    const r=rawDec[i];
    const prev=i>0?rawDec[i-1].wr:-Infinity;
    if(r.wr<prev)strictMono=false;
    console.log(`  D${r.d}: n=${r.n} avgScore=${r.avgS.toFixed(1)} WR=${r.wr.toFixed(1)}%`);
  }
  console.log(`Strict decile monotonicity: ${strictMono?'★ YES':'✗ NO'}`);

  // ── PASS 2: Fit PAVA on raw→win ──
  console.log('\n── FITTING PAVA (isotonic) ──');
  const xRaw=v41Uniform.trades.map(t=>t.rawScore);
  const yRaw=v41Uniform.trades.map(t=>t.win);
  const cal=pava(xRaw,yRaw);
  console.log(`PAVA breakpoints: ${cal.xs.length}`);
  console.log('  x → p(win):');
  for(let i=0;i<cal.xs.length;i++){
    console.log(`    ${cal.xs[i].toFixed(1).padStart(7)} → ${(cal.ys[i]*100).toFixed(1)}%`);
  }

  const calScoreFn=(sig)=>{const rs=(sig.confRatio-1)*100;return pavaEval(cal,rs)*100;}; // 0..100 scale

  // Sanity: decile WR under CALIBRATED score
  console.log('\n── PASS 3: decile WR under CALIBRATED score (uniform sizing) ──');
  const v41Cal=run(signals,parsed,calScoreFn,[999,999,999],[1,1,1,1],MAXP,CLUSTERS,MAXCL,SKIP,true);
  // decile by calScore
  const calDec=decileReport(v41Cal.trades,'calScore');
  let calMono=true;
  for(let i=0;i<calDec.length;i++){
    const r=calDec[i];
    const prev=i>0?calDec[i-1].wr:-Infinity;
    if(r.wr<prev)calMono=false;
    console.log(`  D${r.d}: n=${r.n} avgP=${r.avgS.toFixed(1)} WR=${r.wr.toFixed(1)}%`);
  }
  console.log(`Calibrated decile monotonicity: ${calMono?'★ YES':'✗ NO'}`);

  // Threshold choice on calibrated P(win): percentiles of calibrated score
  const calScores=v41Uniform.trades.map(t=>pavaEval(cal,t.rawScore)*100).sort((a,b)=>a-b);
  const p25=calScores[Math.floor(calScores.length*0.25)];
  const p50=calScores[Math.floor(calScores.length*0.50)];
  const p75=calScores[Math.floor(calScores.length*0.75)];
  console.log(`\nCalibrated score percentiles: P25=${p25.toFixed(1)} P50=${p50.toFixed(1)} P75=${p75.toFixed(1)}`);

  // ── PASS 4: V41 tiered (wide/conservative) with RAW vs CAL ──
  console.log('\n── PASS 4: TIER BACKTESTS (V41 stack: cluster+ToD+adaptive) ──');
  const tierCfgs=[
    {name:'V41 deployed (raw wide/cons)',scoreFn:null,thr:[5,15,30],mul:[0.3,1.0,1.2,1.5]},
    {name:'Recalibrated (pct thresholds)',scoreFn:calScoreFn,thr:[p25,p50,p75],mul:[0.3,1.0,1.2,1.5]},
    {name:'Recalibrated (aggressive)',scoreFn:calScoreFn,thr:[p25,p50,p75],mul:[0.5,1.0,1.4,1.8]},
    {name:'Recalibrated (T3+T4 merged)',scoreFn:calScoreFn,thr:[p25,p50,9999],mul:[0.3,1.0,1.3,1.3]}
  ];
  const results=[];
  for(const cfg of tierCfgs){
    const r=run(signals,parsed,cfg.scoreFn,cfg.thr,cfg.mul,MAXP,CLUSTERS,MAXCL,SKIP,true);
    const s=st(r.trades);
    const ddP=(s.mdd/(INIT_CAP+s.pnl))*100;
    const tpd=s.n/150;
    results.push({name:cfg.name,s,ddP,tpd,trades:r.trades});
    console.log(`  ${cfg.name.padEnd(32)} ${s.n}t PF${s.pf.toFixed(2)} WR${s.wr.toFixed(1)}% DD${ddP.toFixed(0)}% Sh${s.sharpe.toFixed(1)} $${s.pnl.toFixed(0)} t/d${tpd.toFixed(2)}`);
  }

  // Tier breakdown comparison: deployed vs recalibrated
  console.log('\n── TIER BREAKDOWN ──');
  for(const r of results){
    console.log(`\n${r.name}:`);
    for(let t=1;t<=4;t++){
      const tt=r.trades.filter(x=>x.tier===t);
      if(!tt.length){console.log(`  Tier ${t}: (empty)`);continue;}
      const ts=st(tt);
      const wr=tt.filter(x=>x.win).length/tt.length*100;
      console.log(`  Tier ${t}: n=${tt.length} WR${wr.toFixed(1)}% PF${ts.pf.toFixed(2)} Sh${ts.sharpe.toFixed(1)} pnl$${ts.pnl.toFixed(0)}`);
    }
  }

  // Deltas vs V41 deployed (row 0)
  console.log('\n── DELTAS vs V41 DEPLOYED (wide/conservative + raw score) ──');
  const base=results[0];
  for(let i=1;i<results.length;i++){
    const r=results[i];
    const dPF=(r.s.pf-base.s.pf);
    const dDD=(r.ddP-base.ddP);
    const dWR=(r.s.wr-base.s.wr);
    const dPnL=(r.s.pnl-base.s.pnl);
    const dTPD=(r.tpd-base.tpd);
    console.log(`  ${r.name}: ΔPF${dPF>=0?'+':''}${dPF.toFixed(2)} ΔDD${dDD>=0?'+':''}${dDD.toFixed(0)}pp ΔWR${dWR>=0?'+':''}${dWR.toFixed(1)}pp ΔPnL$${dPnL.toFixed(0)} Δt/d${dTPD>=0?'+':''}${dTPD.toFixed(2)}`);
  }

  // Verdict
  const bestRecal=results.slice(1).sort((a,b)=>b.s.sharpe-a.s.sharpe)[0];
  console.log('\n── VERDICT ──');
  console.log(`Best recal variant by Sharpe: ${bestRecal.name}`);
  const vs=bestRecal.s,vd=bestRecal.ddP,vt=bestRecal.tpd;
  const meets=(vs.pf>=1.30)&&(vd<=base.ddP+2)&&(vt>=base.tpd-0.3);
  if(calMono&&meets)console.log('★ ACCEPT: calibrated monotonic + PF≥1.30 + DD no peor + freq mantenida');
  else if(!calMono)console.log('✗ REJECT: calibración no logra monotonicidad en deciles');
  else if(vs.pf<1.30)console.log(`✗ REJECT: PF ${vs.pf.toFixed(2)} < 1.30`);
  else if(vd>base.ddP+2)console.log(`✗ REJECT: DD ${vd.toFixed(0)}% > deployed+2pp`);
  else console.log('? MIXED — evaluar trade-offs');
}
main().catch(e=>{console.error(e);process.exit(1);});
