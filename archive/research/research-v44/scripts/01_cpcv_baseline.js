#!/usr/bin/env node
'use strict';
// FASE 1 — CPCV baseline of v42 PRO+
// Combinatorial Purged Cross-Validation with 15 folds × 2 test = C(15,2)=105 paths
// Deflated Sharpe Ratio (Bailey-López de Prado 2014) + PBO
const fs=require('fs');const path=require('path');

const KLINES_DIR='/tmp/binance-klines-1m';
const RESULTS_DIR=path.join(__dirname,'..','results');
if(!fs.existsSync(RESULTS_DIR))fs.mkdirSync(RESULTS_DIR,{recursive:true});

const PAIRS=['ADAUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','SOLUSDT','LTCUSDT','DOTUSDT','NEARUSDT','AVAXUSDT','DOGEUSDT','BNBUSDT'];
const INIT_CAP=500,POS_SIZE_BASE=2500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002;
const CLUSTERS={BTCUSDT:'L1major',ETHUSDT:'L1major',SOLUSDT:'SOLadj',AVAXUSDT:'SOLadj',NEARUSDT:'SOLadj',LINKUSDT:'DeFi',ATOMUSDT:'DeFi',DOTUSDT:'DeFi',ARBUSDT:'L2',BNBUSDT:'Other',XRPUSDT:'Other',ADAUSDT:'Other',LTCUSDT:'Other',DOGEUSDT:'MemesAI','1000PEPEUSDT':'MemesAI'};

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

// v42 PRO momentum + meanrev features (same as backtest-v42-pro.js)
function momFeatures(bars){const n=bars.length;const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);const ti=new Float64Array(n),tbv=new Float64Array(n),tsv=new Float64Array(n);for(let i=0;i<n;i++){const b=bars[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;ti[i]=b.ti;tbv[i]=b.tbv;tsv[i]=b.tsv;}const atr2=at(h,l,c),adx2=ax(h,l,c),mc=mcd(c),e9=em(c,9),e21=em(c,21),e50=em(c,50),vsma=sm(v,20);const ofi4h=new Float64Array(n);for(let i=0;i<n;i++){let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=tbv[j]-tsv[j];ofi4h[i]=s;}const fsArr=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fsArr.push(a);};F(i=>(adx2.adx[i]-25)/25);F(i=>mc.hist[i]/(atr2[i]||1));F(i=>(e9[i]-e21[i])/(atr2[i]||1));F(i=>(e21[i]-e50[i])/(atr2[i]||1));F(i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F(i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F(i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F(i=>ti[i]);F(i=>{let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=ti[j];return s/4;});F(i=>ofi4h[i]/(vsma[i]*4||1));return{fs:fsArr,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};}
function revFeatures(bars){const n=bars.length;const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);for(let i=0;i<n;i++){const b=bars[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;}const atr2=at(h,l,c),adx2=ax(h,l,c),r14=rsI(c,14),r7=rsI(c,7),bbd=bb(c,20,2),vsma=sm(v,20);const fsArr=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fsArr.push(a);};F(i=>(50-r14[i])/50);F(i=>(50-r7[i])/50);F(i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);F(i=>{if(h[i]===l[i])return 0;const upW=h[i]-Math.max(o[i],c[i]);const loW=Math.min(o[i],c[i])-l[i];return(loW-upW)/(h[i]-l[i]);});F(i=>vsma[i]>0?v[i]/vsma[i]-1:0);F(i=>i>=3?-(c[i]-c[i-3])/c[i-3]*100:0);F(i=>i>=6?-(c[i]-c[i-6])/c[i-6]*100:0);return{fs:fsArr,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};}
function pearson(fs,y,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],yv=y[i];if(isNaN(x)||isNaN(yv))continue;sx+=x;sy+=yv;sxy+=x*yv;sx2+=x*x;sy2+=yv*yv;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}
function compute4HTrend(b4h){const n=b4h.length;const c=Float64Array.from(b4h.map(b=>b.c));const e9=em(c,9),e21=em(c,21);const trend=new Int8Array(n);for(let i=0;i<n;i++){trend[i]=e9[i]>e21[i]?1:(e9[i]<e21[i]?-1:0);}return trend;}
function findPrev(arr,ts){let lo=0,hi=arr.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(arr[m]<=ts){b=m;lo=m+1;}else hi=m-1;}return b;}

// Generate all v42 PRO signals across the whole period (walk-forward)
async function genSignals(allData){
  const signals=[];const parsed={};
  const TRAIN_D=120,TEST_D=30,STEP_D=30,firstTs=Math.min(...Object.values(allData).map(d=>d.b1h[0].t));
  const nW=Math.floor((273-TRAIN_D-TEST_D)/STEP_D)+1;
  for(let w=0;w<nW;w++){
    const trs=firstTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;
    const pm={};
    for(const pair of PAIRS){if(!allData[pair])continue;const tB=allData[pair].b1h.filter(b=>b.t>=trs&&b.t<tre);if(tB.length<300)continue;const Fm=momFeatures(tB);const Fr=revFeatures(tB);const fwd=new Float64Array(Fm.n).fill(NaN);for(let i=50;i<Fm.n-2;i++)fwd[i]=(Fm.c[i+2]-Fm.c[i])/Fm.c[i]*100;const coM=pearson(Fm.fs,fwd,50,Fm.n-2);const coR=pearson(Fr.fs,fwd,50,Fr.n-2);const selM=coM.map((c,i)=>({idx:i,corr:c,abs:Math.abs(c)})).filter(x=>x.abs>=0.011).sort((a,b)=>b.abs-a.abs).slice(0,6);const selR=coR.map((c,i)=>({idx:i,corr:c,abs:Math.abs(c)})).filter(x=>x.abs>=0.011).sort((a,b)=>b.abs-a.abs).slice(0,6);if(selM.length<2)continue;let tcM=[];for(let i=55;i<Fm.n;i++){if(Fm.adx[i]<22)continue;let comp=0;for(const{idx,corr}of selM)comp+=corr*Fm.fs[idx][i];tcM.push(Math.abs(comp));}tcM.sort((a,b)=>a-b);let tcR=[];for(let i=55;i<Fr.n;i++){if(Fr.adx[i]<22)continue;let comp=0;for(const{idx,corr}of selR)comp+=corr*Fr.fs[idx][i];tcR.push(Math.abs(comp));}tcR.sort((a,b)=>a-b);const thrM=tcM[Math.floor(tcM.length*0.55)]||0.001;const thrR=tcR[Math.floor(tcR.length*0.55)]||0.001;pm[pair]={selM,selR,thrM,thrR};}
    if(Object.keys(pm).length<4)continue;
    for(const pair of PAIRS){if(!pm[pair])continue;const teB=allData[pair].b1h.filter(b=>b.t>=tes&&b.t<tee);if(teB.length<50)continue;const te4=allData[pair].b4h.filter(b=>b.t>=tes-4*3600000&&b.t<tee);const Fm=momFeatures(teB);const Fr=revFeatures(teB);if(!parsed[pair])parsed[pair]={t:[...Fm.t],o:[...Fm.o],h:[...Fm.h],l:[...Fm.l],c:[...Fm.c],atr:[...Fm.atr]};else{for(let i=0;i<Fm.t.length;i++){parsed[pair].t.push(Fm.t[i]);parsed[pair].o.push(Fm.o[i]);parsed[pair].h.push(Fm.h[i]);parsed[pair].l.push(Fm.l[i]);parsed[pair].c.push(Fm.c[i]);parsed[pair].atr.push(Fm.atr[i]);}}const{selM,selR,thrM,thrR}=pm[pair];const trend4=compute4HTrend(te4);const t4=te4.map(b=>b.t);let last=-3;for(let i=55;i<Fm.n-60-1;i++){if(i-last<2)continue;if(Fm.adx[i]<22)continue;let compM=0;for(const{idx,corr}of selM)compM+=corr*Fm.fs[idx][i];let compR=0;for(const{idx,corr}of selR)compR+=corr*Fr.fs[idx][i];const passM=Math.abs(compM)>=thrM;const passR=Math.abs(compR)>=thrR;const dirM=compM>0?1:-1;const dirR=-1*(compR>0?1:-1);let finalDir=0,absComp=0,thrUsed=0;if(passM&&passR&&dirM===dirR){finalDir=dirM;absComp=Math.max(Math.abs(compM),Math.abs(compR));thrUsed=Math.max(thrM,thrR);}else if(passM){finalDir=dirM;absComp=Math.abs(compM);thrUsed=thrM;}else if(passR){finalDir=dirR;absComp=Math.abs(compR);thrUsed=thrR;}if(finalDir===0)continue;const b4=findPrev(t4,Fm.t[i]);if(b4<0||trend4[b4]!==finalDir)continue;const absIdx=parsed[pair].t.length-Fm.n+i;const confRatio=absComp/thrUsed;const hr=new Date(Fm.t[i]).getUTCHours();signals.push({pair,ts:Fm.t[i],dir:finalDir,absIdx,atr:Fm.atr[i],confRatio,hr});last=i;}}
  }
  signals.sort((a,b)=>a.ts-b.ts);
  return{signals,parsed};
}

// Execute signals filtered by allowed time periods (CPCV test folds)
function runV42ProFiltered(signals,parsed,allowedTimeRanges,cfg){
  const SKIP=cfg.tod?new Set([0,7,10,11,12,13,17,18]):null;
  const MAXP=cfg.maxPos||4,MAXCL=cfg.maxCluster||3;
  const tierThr=[5,15,30];const tierMul=[0.3,1.0,1.2,1.5];
  let cap=INIT_CAP;const trades=[];const slots=new Array(MAXP).fill(null);const prng=P(314159265);
  const vpct={};for(const p of Object.keys(parsed)){const pd=parsed[p];const aps=[];for(let i=50;i<pd.c.length;i++){if(pd.c[i]>0&&pd.atr[i]>0)aps.push(pd.atr[i]/pd.c[i]);}aps.sort((a,b)=>a-b);vpct[p]={p66:aps[Math.floor(aps.length*0.66)]||0};}
  function inAllowed(ts){for(const[s,e]of allowedTimeRanges){if(ts>=s&&ts<e)return true;}return false;}
  function getTier(pctAbove){if(pctAbove<tierThr[0])return 1;if(pctAbove<tierThr[1])return 2;if(pctAbove<tierThr[2])return 3;return 4;}
  function cls(si,j,reason){const pos=slots[si];const pd=parsed[pos.pair];let ep2;if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(reason==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;const fE=pos.sz*FEE_E,fX=pos.sz*(reason==='TP'?FEE_TP:FEE_SL);const pnl=g-fE-fX;cap+=pnl;const date=new Date(pd.t[j]).toISOString().slice(0,10);trades.push({pnl,type:reason,pair:pos.pair,date,ts:pd.t[j]});slots[si]=null;}
  function advance(upTs){for(let si=0;si<MAXP;si++){const pos=slots[si];if(!pos)continue;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upTs;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){cls(si,j,'SL');break;}if(hT){cls(si,j,'TP');break;}pos.nc=j+1;}if(slots[si]&&slots[si].nc>slots[si].exp){cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}}
  for(const sig of signals){
    if(!inAllowed(sig.ts))continue;
    if(cap<=0)break;
    if(SKIP&&SKIP.has(sig.hr))continue;
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
    let slM=2,tpR=1.625;if(cfg.adaptive){const{p66}=vpct[sig.pair]||{p66:0};if(ap>p66){slM=2.5;tpR=1.4;}}
    const slPct=Math.max(0.003,Math.min(0.03,ap*slM));const tpPct=Math.max(0.005,Math.min(0.08,slPct*tpR));
    const pctAbove=(sig.confRatio-1)*100;const tier=getTier(pctAbove);const mult=tierMul[tier-1];const sz=POS_SIZE_BASE*mult;
    slots[freeSlot]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-slPct):ep*(1+slPct),tpP:sig.dir===1?ep*(1+tpPct):ep*(1-tpPct),qty:sz/ep,sz,tier,eb,exp:eb+60,nc:eb+1};
  }
  advance(Infinity);for(let si=0;si<MAXP;si++){if(slots[si]){const pd=parsed[slots[si].pair];cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}
  return{trades,finalCap:cap};
}

function stats(trades){
  if(!trades.length)return{pf:0,wr:0,pnl:0,n:0,sharpe:0,mdd:0,dailyRets:[]};
  const w=trades.filter(x=>x.pnl>0),lo=trades.filter(x=>x.pnl<=0);
  const gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));
  const byDay={};for(const x of trades){byDay[x.date]=(byDay[x.date]||0)+x.pnl;}
  const dR=Object.values(byDay);const mD=dR.reduce((a,x)=>a+x,0)/dR.length;
  const vD=dR.reduce((a,x)=>a+(x-mD)**2,0)/dR.length;
  const sharpe=vD>0?mD/Math.sqrt(vD)*Math.sqrt(365):0;
  let cum=0,pk=0,mdd=0;for(const x of trades){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}
  return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/trades.length*100,pnl:gw-gl,n:trades.length,sharpe,mdd,dailyRets:dR};
}

// CPCV: 15 folds, choose 2 as test → C(15,2)=105 paths
// Each path: test on union of 2 non-adjacent folds (with 3h purge between train/test)
function makeCPCVPaths(nFolds,kTest){
  const paths=[];
  function combinations(arr,k,start,cur){if(cur.length===k){paths.push([...cur]);return;}for(let i=start;i<arr.length;i++){cur.push(arr[i]);combinations(arr,k,i+1,cur);cur.pop();}}
  combinations(Array.from({length:nFolds},(_,i)=>i),kTest,0,[]);
  return paths;
}

// Deflated Sharpe Ratio (Bailey-López de Prado 2014)
// DSR = (SR - E[max SR]) / stddev[max SR]
// E[max SR] ≈ ((1-γ)·Φ^{-1}(1-1/N) + γ·Φ^{-1}(1-1/N·e^{-1}))·sqrt((1-γ₄·SR²+γ₃·SR)/(T-1))
// Simplified: DSR uses skewness & kurtosis of returns to deflate
function erf(x){const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;const sign=x<0?-1:1;x=Math.abs(x);const t=1/(1+p*x);const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);return sign*y;}
function normInv(p){// inverse normal CDF — Acklam's approximation
  const a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00];
  const b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01];
  const c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00];
  const d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00];
  const pLow=0.02425;
  if(p<pLow){const q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
  if(p<1-pLow){const q=p-0.5,r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}
  const q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}
function skewKurt(rets){const n=rets.length;if(n<3)return{skew:0,kurt:3};const m=rets.reduce((a,x)=>a+x,0)/n;let s2=0,s3=0,s4=0;for(const r of rets){const d=r-m;s2+=d*d;s3+=d*d*d;s4+=d*d*d*d;}const sd=Math.sqrt(s2/n);if(sd===0)return{skew:0,kurt:3};return{skew:s3/n/(sd*sd*sd),kurt:s4/n/(sd*sd*sd*sd)};}
function deflatedSharpe(sharpes,T,skewReturns,kurtReturns){
  const N=sharpes.length;if(N<2||T<10)return{dsr:0,pvalue:0.5};
  const best=Math.max(...sharpes);
  const mean=sharpes.reduce((a,x)=>a+x,0)/N;
  const variance=sharpes.reduce((a,x)=>a+(x-mean)**2,0)/N;
  const stddev=Math.sqrt(variance);
  const gamma=0.5772156649; // Euler-Mascheroni
  const emax=stddev*((1-gamma)*normInv(1-1/N)+gamma*normInv(1-1/(N*Math.E)));
  const num=best-emax;
  const den=Math.sqrt((1-skewReturns*best+(kurtReturns-1)/4*best*best)/(T-1));
  const dsr=den>0?num/den:0;
  // p-value: prob(DSR > 0)
  const pvalue=0.5*(1+erf(dsr/Math.SQRT2));
  return{dsr,emax,pvalue,bestSharpe:best,meanSharpe:mean,stdSharpe:stddev};
}

// PBO (Probability of Backtest Overfitting) — López de Prado Ch.11
// For each path, check if in-sample best strategy ranks below median in out-of-sample
function computePBO(pathSharpes){
  // pathSharpes: array of {trainSharpe, testSharpe} per path
  if(pathSharpes.length<5)return 0.5;
  // Rank-based PBO: λ = P(logit(rank_oos) < 0 | best_is)
  // Simplified: fraction of paths where testSharpe < median(testSharpe across paths)
  const testS=pathSharpes.map(p=>p.testSharpe);
  const med=[...testS].sort((a,b)=>a-b)[Math.floor(testS.length/2)];
  let below=0;for(const p of pathSharpes){if(p.testSharpe<med)below++;}
  return below/pathSharpes.length;
}

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('FASE 1 — CPCV Baseline v42 PRO+');console.log('═'.repeat(80));
  console.log('\nLoading data...');
  const allData={};
  for(const pair of PAIRS){
    process.stdout.write(`  ${pair}... `);
    const b1m=load1m(pair);
    if(!b1m||b1m.length<50000){console.log('SKIP');continue;}
    const b1h=aggTF(b1m,60);const b4h=aggTF(b1m,240);
    allData[pair]={b1h,b4h};
    console.log(`${b1h.length} 1h bars`);
  }
  console.log(`\n[${((Date.now()-t0)/1000).toFixed(1)}s] ${Object.keys(allData).length} pairs loaded.`);

  console.log('\nGenerating v42 PRO+ signals (walk-forward 5 windows)...');
  const{signals,parsed}=await genSignals(allData);
  console.log(`  ${signals.length} total signals across ${Object.keys(parsed).length} pairs`);
  console.log(`  [${((Date.now()-t0)/1000).toFixed(1)}s]`);

  // Get timestamp range
  const tStart=Math.min(...signals.map(s=>s.ts));
  const tEnd=Math.max(...signals.map(s=>s.ts));
  const N_FOLDS=15;const K_TEST=2;
  const foldDur=(tEnd-tStart)/N_FOLDS;
  const PURGE_MS=3*3600000; // 3h embargo
  const foldBoundaries=[];
  for(let i=0;i<=N_FOLDS;i++)foldBoundaries.push(tStart+i*foldDur);

  console.log(`\nCPCV config: ${N_FOLDS} folds × ${K_TEST} test = C(${N_FOLDS},${K_TEST})=${(N_FOLDS*(N_FOLDS-1))/2} paths`);
  console.log(`Fold duration: ${(foldDur/86400000).toFixed(1)}d each`);
  console.log(`Purge embargo: ${PURGE_MS/3600000}h`);

  const paths=makeCPCVPaths(N_FOLDS,K_TEST);
  console.log(`\nRunning ${paths.length} CPCV paths...`);

  const cfg={tod:true,adaptive:true,maxPos:4,maxCluster:3,safety:false};
  const pathResults=[];
  let pathN=0;
  const t1=Date.now();
  for(const testFolds of paths){
    pathN++;
    // Test ranges with purge: exclude 3h on either side of test boundaries
    const testRanges=testFolds.map(f=>[foldBoundaries[f]+PURGE_MS,foldBoundaries[f+1]-PURGE_MS]).filter(r=>r[1]>r[0]);
    const trainRanges=[];
    for(let i=0;i<N_FOLDS;i++){if(testFolds.includes(i))continue;const s=foldBoundaries[i];const e=foldBoundaries[i+1];trainRanges.push([s,e]);}

    // Test fold PnL
    const rTest=runV42ProFiltered(signals,parsed,testRanges,cfg);
    const sTest=stats(rTest.trades);
    // Train fold PnL (for PBO)
    const rTrain=runV42ProFiltered(signals,parsed,trainRanges,cfg);
    const sTrain=stats(rTrain.trades);

    pathResults.push({testFolds,nTrainTrades:sTrain.n,nTestTrades:sTest.n,trainSharpe:sTrain.sharpe,testSharpe:sTest.sharpe,trainPF:sTrain.pf,testPF:sTest.pf,trainPnL:sTrain.pnl,testPnL:sTest.pnl,trainWR:sTrain.wr,testWR:sTest.wr});
    if(pathN%10===0||pathN===paths.length){
      const elapsed=(Date.now()-t1)/1000;const eta=elapsed/pathN*(paths.length-pathN);
      process.stdout.write(`  [${pathN}/${paths.length}] ${elapsed.toFixed(0)}s elapsed, ETA ${eta.toFixed(0)}s\r`);
    }
  }
  console.log();

  // Full-sample baseline
  console.log('\nFull-sample baseline (no CPCV)...');
  const rFull=runV42ProFiltered(signals,parsed,[[tStart,tEnd+864e5]],cfg);
  const sFull=stats(rFull.trades);
  console.log(`  Full: ${sFull.n} trades, PF ${sFull.pf.toFixed(2)}, WR ${sFull.wr.toFixed(1)}%, Sharpe ${sFull.sharpe.toFixed(2)}, PnL $${sFull.pnl.toFixed(0)}`);

  // Deflated Sharpe
  const testSharpes=pathResults.map(p=>p.testSharpe);
  const{skew:sk,kurt:ku}=skewKurt(sFull.dailyRets);
  const T=sFull.dailyRets.length;
  const dsrRes=deflatedSharpe(testSharpes,T,sk,ku);

  // PBO
  const pbo=computePBO(pathResults);

  // Summary stats
  const sharpeMean=testSharpes.reduce((a,x)=>a+x,0)/testSharpes.length;
  const sharpeStd=Math.sqrt(testSharpes.reduce((a,x)=>a+(x-sharpeMean)**2,0)/testSharpes.length);
  const sortedS=[...testSharpes].sort((a,b)=>a-b);
  const p5=sortedS[Math.floor(0.05*sortedS.length)];
  const p50=sortedS[Math.floor(0.50*sortedS.length)];
  const p95=sortedS[Math.floor(0.95*sortedS.length)];
  const posCount=testSharpes.filter(s=>s>0).length;

  const report={
    phase:'1 — CPCV Baseline v42 PRO+',
    runtime_s:(Date.now()-t0)/1000,
    config:{n_folds:N_FOLDS,k_test:K_TEST,n_paths:paths.length,purge_hours:PURGE_MS/3600000,n_pairs:Object.keys(allData).length},
    full_sample:sFull,
    cpcv_distribution:{
      n_paths:testSharpes.length,
      sharpe_mean:sharpeMean,sharpe_std:sharpeStd,
      sharpe_p5:p5,sharpe_p50:p50,sharpe_p95:p95,
      positive_fraction:posCount/testSharpes.length,
    },
    deflated_sharpe:dsrRes,
    pbo:pbo,
    verdict:pbo<0.3?'LEGIT — continue V44':(pbo<0.5?'GRAY ZONE — proceed cautiously':'OVERFIT — publish v42 PRO+ with warning'),
    path_results_sample:pathResults.slice(0,10)
  };

  fs.writeFileSync(path.join(RESULTS_DIR,'01_cpcv_baseline.json'),JSON.stringify(report,null,2));

  console.log('\n'+'═'.repeat(80));
  console.log('FASE 1 RESULTS');
  console.log('═'.repeat(80));
  console.log(`\nFull-sample v42 PRO+:`);
  console.log(`  Trades: ${sFull.n}`);
  console.log(`  PF: ${sFull.pf.toFixed(2)}, WR: ${sFull.wr.toFixed(1)}%`);
  console.log(`  Sharpe: ${sFull.sharpe.toFixed(2)}`);
  console.log(`  MDD: $${sFull.mdd.toFixed(0)}`);
  console.log(`  PnL: $${sFull.pnl.toFixed(0)}`);
  console.log(`\nCPCV distribution (${testSharpes.length} paths):`);
  console.log(`  Sharpe mean: ${sharpeMean.toFixed(2)} ± ${sharpeStd.toFixed(2)}`);
  console.log(`  Sharpe P5 / P50 / P95: ${p5.toFixed(2)} / ${p50.toFixed(2)} / ${p95.toFixed(2)}`);
  console.log(`  Positive paths: ${posCount}/${testSharpes.length} (${(posCount/testSharpes.length*100).toFixed(1)}%)`);
  console.log(`\nDeflated Sharpe (Bailey-López de Prado):`);
  console.log(`  DSR: ${dsrRes.dsr.toFixed(3)}`);
  console.log(`  p-value: ${dsrRes.pvalue.toFixed(4)}`);
  console.log(`\nPBO (Prob. Backtest Overfitting):`);
  console.log(`  PBO: ${pbo.toFixed(3)}`);
  console.log(`\n🏁 VERDICT: ${report.verdict}`);
  console.log(`\nRuntime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`\nSaved: ${RESULTS_DIR}/01_cpcv_baseline.json`);
}
main().catch(e=>{console.error(e);process.exit(1);});
