#!/usr/bin/env node
'use strict';
// v42 MAX MACRO OVERLAY — applies macro filters on v42 PRO Pearson signals
// Philosophy: base signal = v42 PRO Pearson (proven). Overlay = filter out
// signals when macro regime is adverse. Goal: DD↓ without killing PF/t-d.
//
// Macro features:
//   T1 VIX level + VIX percentile (risk-off filter)
//   T2 DXY 4h change (dollar strength filter)
//   T3 SPX 1h return sign (risk-on alignment for longs, inversion for shorts)
//   T4 BTC-SPX rolling correlation 30d (regime: decoupled vs coupled)
//   T5 DVOL BTC level + zscore (crypto vol regime; switch to mean-rev in high vol)
//
// Ablation: baseline (v42 PRO Pearson) + each gate individually + FULL.

const fs=require('fs');const path=require('path');
const PAIRS=['ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT','SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'];
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

// Macro data loaders + lookup (all daily forward-fill to any timestamp)
function loadJson(p){if(!fs.existsSync(p))return null;return JSON.parse(fs.readFileSync(p,'utf8'));}
function makeLookup(series){
  if(!series)return null;
  const ts=series.map(r=>r.t).sort((a,b)=>a-b);
  const bs=new Map();for(const r of series)bs.set(r.t,r);
  return{
    series,ts,
    at(t){// forward-fill previous value
      let lo=0,hi=ts.length-1,b=-1;
      while(lo<=hi){const m=(lo+hi)>>1;if(ts[m]<=t){b=m;lo=m+1;}else hi=m-1;}
      return b>=0?bs.get(ts[b]):null;
    }
  };
}
function rollingZ(series,key,lookbackDays){
  // returns function (t)->zscore of value at t relative to past lookbackDays
  const sorted=series.slice().sort((a,b)=>a.t-b.t);
  const vals=sorted.map(r=>r[key]).filter(v=>v!=null&&isFinite(v));
  return function(t){
    let idx=-1;for(let i=0;i<sorted.length;i++){if(sorted[i].t<=t)idx=i;else break;}
    if(idx<20)return 0;
    const start=Math.max(0,idx-lookbackDays);
    const win=[];for(let i=start;i<=idx;i++){const v=sorted[i][key];if(v!=null&&isFinite(v))win.push(v);}
    if(win.length<10)return 0;
    const mu=win.reduce((s,x)=>s+x,0)/win.length;
    const sd=Math.sqrt(win.reduce((s,x)=>s+(x-mu)**2,0)/win.length);
    const cur=sorted[idx][key];
    return sd>0?(cur-mu)/sd:0;
  };
}
function percentileRank(series,key,lookbackDays){
  const sorted=series.slice().sort((a,b)=>a.t-b.t);
  return function(t){
    let idx=-1;for(let i=0;i<sorted.length;i++){if(sorted[i].t<=t)idx=i;else break;}
    if(idx<10)return 0.5;
    const start=Math.max(0,idx-lookbackDays);
    const win=[];for(let i=start;i<=idx;i++){const v=sorted[i][key];if(v!=null&&isFinite(v))win.push(v);}
    if(win.length<5)return 0.5;
    const cur=sorted[idx][key];
    let rank=0;for(const v of win)if(v<=cur)rank++;
    return rank/win.length;
  };
}

// Build macro feature resolvers per timestamp
function buildMacroResolver(){
  const spx=loadJson('/tmp/tradfi-spx.json');
  const vix=loadJson('/tmp/tradfi-vix.json');
  const dxy=loadJson('/tmp/tradfi-dxy.json');
  const gold=loadJson('/tmp/tradfi-gold.json');
  const tnx=loadJson('/tmp/tradfi-tnx.json');
  const dvolBtc=loadJson('/tmp/deribit-dvol-btc.json');
  const dvolEth=loadJson('/tmp/deribit-dvol-eth.json');
  const lSpx=makeLookup(spx),lVix=makeLookup(vix),lDxy=makeLookup(dxy),lGold=makeLookup(gold),lTnx=makeLookup(tnx);
  const lDvolB=makeLookup(dvolBtc),lDvolE=makeLookup(dvolEth);
  const vixP90=vix?percentileRank(vix,'c',90):null;
  const dvolBZ30=dvolBtc?rollingZ(dvolBtc,'c',24*30):null;
  return{
    // VIX filters
    vixLevel:t=>lVix&&lVix.at(t)?lVix.at(t).c:null,
    vixP90:t=>vixP90?vixP90(t):0.5,
    // DXY change 4h ago (we have daily, so compare today vs 1d ago — proxy for macro dollar thrust)
    dxyChg1d:t=>{if(!lDxy)return 0;const cur=lDxy.at(t);if(!cur)return 0;const prev=lDxy.at(t-86400000);return prev?((cur.c-prev.c)/prev.c)*100:0;},
    // SPX daily return
    spxRet1d:t=>{if(!lSpx)return 0;const cur=lSpx.at(t);if(!cur)return 0;const prev=lSpx.at(t-86400000);return prev?((cur.c-prev.c)/prev.c)*100:0;},
    // DVOL BTC level + zscore
    dvolBtcLvl:t=>lDvolB&&lDvolB.at(t)?lDvolB.at(t).c:null,
    dvolBtcZ:t=>dvolBZ30?dvolBZ30(t):0,
    // TNX level
    tnxLvl:t=>lTnx&&lTnx.at(t)?lTnx.at(t).c:null
  };
}

// Generate v42 PRO signals (same as backtest-v42-pro.js but returns signals+parsed)
async function genAllSignals(allData,PAIRS){
  const signals=[];const parsed={};
  const TRAIN_D=120,TEST_D=30,STEP_D=30,firstTs=Math.min(...Object.values(allData).map(d=>d.b1h[0].t));
  const nW=Math.floor((274-TRAIN_D-TEST_D)/STEP_D)+1;
  for(let w=0;w<nW;w++){
    const trs=firstTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;
    const pm={};
    for(const pair of PAIRS){if(!allData[pair])continue;const tB=allData[pair].b1h.filter(b=>b.t>=trs&&b.t<tre);if(tB.length<300)continue;const Fm=momFeatures(tB);const Fr=revFeatures(tB);const fwd=new Float64Array(Fm.n).fill(NaN);for(let i=50;i<Fm.n-2;i++)fwd[i]=(Fm.c[i+2]-Fm.c[i])/Fm.c[i]*100;const coM=pearson(Fm.fs,fwd,50,Fm.n-2);const coR=pearson(Fr.fs,fwd,50,Fr.n-2);const selM=coM.map((c,i)=>({idx:i,corr:c,abs:Math.abs(c)})).filter(x=>x.abs>=0.011).sort((a,b)=>b.abs-a.abs).slice(0,6);const selR=coR.map((c,i)=>({idx:i,corr:c,abs:Math.abs(c)})).filter(x=>x.abs>=0.011).sort((a,b)=>b.abs-a.abs).slice(0,6);if(selM.length<2)continue;let tcM=[];for(let i=55;i<Fm.n;i++){if(Fm.adx[i]<22)continue;let comp=0;for(const{idx,corr}of selM)comp+=corr*Fm.fs[idx][i];tcM.push(Math.abs(comp));}tcM.sort((a,b)=>a-b);let tcR=[];for(let i=55;i<Fr.n;i++){if(Fr.adx[i]<22)continue;let comp=0;for(const{idx,corr}of selR)comp+=corr*Fr.fs[idx][i];tcR.push(Math.abs(comp));}tcR.sort((a,b)=>a-b);const thrM=tcM[Math.floor(tcM.length*0.55)]||0.001;const thrR=tcR[Math.floor(tcR.length*0.55)]||0.001;pm[pair]={selM,selR,thrM,thrR};}
    if(Object.keys(pm).length<4)continue;
    for(const pair of PAIRS){if(!pm[pair])continue;const teB=allData[pair].b1h.filter(b=>b.t>=tes&&b.t<tee);if(teB.length<50)continue;const te4=allData[pair].b4h.filter(b=>b.t>=tes-4*3600000&&b.t<tee);const Fm=momFeatures(teB);const Fr=revFeatures(teB);if(!parsed[pair])parsed[pair]={t:[...Fm.t],o:[...Fm.o],h:[...Fm.h],l:[...Fm.l],c:[...Fm.c],atr:[...Fm.atr]};else{for(let i=0;i<Fm.t.length;i++){parsed[pair].t.push(Fm.t[i]);parsed[pair].o.push(Fm.o[i]);parsed[pair].h.push(Fm.h[i]);parsed[pair].l.push(Fm.l[i]);parsed[pair].c.push(Fm.c[i]);parsed[pair].atr.push(Fm.atr[i]);}}const{selM,selR,thrM,thrR}=pm[pair];const trend4=compute4HTrend(te4);const t4=te4.map(b=>b.t);let last=-3;for(let i=55;i<Fm.n-60-1;i++){if(i-last<2)continue;if(Fm.adx[i]<22)continue;let compM=0;for(const{idx,corr}of selM)compM+=corr*Fm.fs[idx][i];let compR=0;for(const{idx,corr}of selR)compR+=corr*Fr.fs[idx][i];const passM=Math.abs(compM)>=thrM;const passR=Math.abs(compR)>=thrR;const dirM=compM>0?1:-1;const dirR=-1*(compR>0?1:-1);let finalDir=0,absComp=0,thrUsed=0;if(passM&&passR&&dirM===dirR){finalDir=dirM;absComp=Math.max(Math.abs(compM),Math.abs(compR));thrUsed=Math.max(thrM,thrR);}else if(passM){finalDir=dirM;absComp=Math.abs(compM);thrUsed=thrM;}else if(passR){finalDir=dirR;absComp=Math.abs(compR);thrUsed=thrR;}if(finalDir===0)continue;const b4=findPrev(t4,Fm.t[i]);if(b4<0||trend4[b4]!==finalDir)continue;const absIdx=parsed[pair].t.length-Fm.n+i;const confRatio=absComp/thrUsed;const hr=new Date(Fm.t[i]).getUTCHours();
      signals.push({pair,ts:Fm.t[i],dir:finalDir,absIdx,atr:Fm.atr[i],confRatio,hr});last=i;}}
  }
  signals.sort((a,b)=>a.ts-b.ts);
  return{signals,parsed};
}

function runWithOverlay(signals,parsed,overlay,macro){
  const SKIP=new Set([0,7,10,11,12,13,17,18]);
  const MAXP=4,MAXCL=3;
  const tierThr=[5,15,30];const tierMul=[0.3,1.0,1.2,1.5];
  let cap=INIT_CAP;const trades=[];const slots=new Array(MAXP).fill(null);const prng=P(SEED);
  let overlayBlocks=0;
  const vpct={};for(const p of Object.keys(parsed)){const pd=parsed[p];const aps=[];for(let i=50;i<pd.c.length;i++){if(pd.c[i]>0&&pd.atr[i]>0)aps.push(pd.atr[i]/pd.c[i]);}aps.sort((a,b)=>a-b);vpct[p]={p66:aps[Math.floor(aps.length*0.66)]||0};}
  function getTier(pctAbove){if(pctAbove<tierThr[0])return 1;if(pctAbove<tierThr[1])return 2;if(pctAbove<tierThr[2])return 3;return 4;}
  function cls(si,j,reason){const pos=slots[si];const pd=parsed[pos.pair];let ep2;if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(reason==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;const fE=pos.sz*FEE_E,fX=pos.sz*(reason==='TP'?FEE_TP:FEE_SL);const pnl=g-fE-fX;cap+=pnl;trades.push({pnl,type:reason,pair:pos.pair,date:new Date(pd.t[j]).toISOString().slice(0,10),tier:pos.tier});slots[si]=null;}
  function advance(upTs){for(let si=0;si<MAXP;si++){const pos=slots[si];if(!pos)continue;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upTs;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){cls(si,j,'SL');break;}if(hT){cls(si,j,'TP');break;}pos.nc=j+1;}if(slots[si]&&slots[si].nc>slots[si].exp){cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}}
  for(const sig of signals){
    if(cap<=0)break;
    if(SKIP.has(sig.hr))continue;
    // ── MACRO OVERLAY ──
    if(overlay&&macro){
      const t=sig.ts;
      if(overlay.vixHigh){const lv=macro.vixLevel(t);if(lv!=null&&lv>28){overlayBlocks++;continue;}}
      if(overlay.vixSpike){const p=macro.vixP90(t);if(p>0.90){overlayBlocks++;continue;}}
      if(overlay.dxyThrust){const d=macro.dxyChg1d(t);if(d>0.8&&sig.dir===1){overlayBlocks++;continue;}if(d<-0.8&&sig.dir===-1){overlayBlocks++;continue;}}
      if(overlay.spxAlign){const s=macro.spxRet1d(t);if((sig.dir===1&&s<-1.5)||(sig.dir===-1&&s>1.5)){overlayBlocks++;continue;}}
      if(overlay.dvolRegime){const z=macro.dvolBtcZ(t);if(z>1.5){overlayBlocks++;continue;}}
    }
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
  return{trades,overlayBlocks};
}

async function main(){
  console.log('v42 MAX MACRO OVERLAY — ablación por fuente macro');
  console.log('='.repeat(88));
  // Load everything
  const allData={};
  for(const pair of PAIRS){const b1m=load1m(pair);if(!b1m||b1m.length<50000)continue;const b1h=aggTF(b1m,60);const b4h=aggTF(b1m,240);allData[pair]={b1h,b4h};}
  console.log(`Loaded ${Object.keys(allData).length}/${PAIRS.length} pairs`);
  const macro=buildMacroResolver();
  // Sanity: verify macro data loaded
  console.log('Macro data status:');
  ['tradfi-spx','tradfi-vix','tradfi-dxy','tradfi-gold','tradfi-tnx','deribit-dvol-btc','deribit-dvol-eth'].forEach(k=>{const p='/tmp/'+k+'.json';if(fs.existsSync(p)){const d=JSON.parse(fs.readFileSync(p,'utf8'));console.log(`  ${k}: ${d.length} rows`);}else console.log(`  ${k}: ✗ MISSING`);});

  const{signals,parsed}=await genAllSignals(allData,PAIRS);
  console.log(`\nSignals (v42 PRO base): ${signals.length}`);

  // Configurations
  const configs=[
    {name:'v42 PRO baseline',overlay:null},
    {name:'+VIX level >28',overlay:{vixHigh:true}},
    {name:'+VIX spike P90',overlay:{vixSpike:true}},
    {name:'+DXY thrust ±0.8%',overlay:{dxyThrust:true}},
    {name:'+SPX align ±1.5%',overlay:{spxAlign:true}},
    {name:'+DVOL BTC z>1.5',overlay:{dvolRegime:true}},
    {name:'ALL macro filters',overlay:{vixHigh:true,vixSpike:true,dxyThrust:true,spxAlign:true,dvolRegime:true}},
    {name:'VIX spike + DVOL',overlay:{vixSpike:true,dvolRegime:true}},
    {name:'DXY + SPX',overlay:{dxyThrust:true,spxAlign:true}}
  ];
  const results=[];
  console.log('\nConfig                     Trades Block  PF    WR     DD   Sh    PnL     t/d     vs BASE');
  console.log('-'.repeat(92));
  let baselineRef=null;
  for(const cfg of configs){
    const r=runWithOverlay(signals,parsed,cfg.overlay,macro);
    const s=st(r.trades);
    const ddP=(s.mdd/(INIT_CAP+s.pnl))*100;
    const tpd=s.n/150;
    if(!baselineRef)baselineRef={s,ddP,tpd};
    const dPF=(s.pf-baselineRef.s.pf).toFixed(2);
    const dDD=(ddP-baselineRef.ddP).toFixed(0);
    const marker=(s.pf>=1.35&&ddP<=26&&tpd>=5)?'★':' ';
    console.log(`${cfg.name.padEnd(26)} ${String(s.n).padStart(4)}   ${String(r.overlayBlocks).padStart(4)} ${s.pf.toFixed(2)}  ${s.wr.toFixed(1).padStart(4)}%  ${ddP.toFixed(0).padStart(3)}%  ${s.sharpe.toFixed(1).padStart(4)}  $${s.pnl.toFixed(0).padStart(5)}  ${tpd.toFixed(2)}   ΔPF${dPF>=0?'+':''}${dPF} ΔDD${dDD>=0?'+':''}${dDD}pp ${marker}`);
    results.push({name:cfg.name,s,ddP,tpd,blocks:r.overlayBlocks,config:cfg});
  }
  // Gate check
  const winners=results.filter(r=>r.s.pf>=1.35&&r.ddP<=26&&r.tpd>=5);
  console.log('\n'+'='.repeat(88));
  if(winners.length){
    const best=winners.sort((a,b)=>b.s.sharpe-a.s.sharpe)[0];
    console.log(`🏆 v42 MAX PASS: ${best.name} — PF ${best.s.pf.toFixed(2)} DD ${best.ddP.toFixed(0)}% t/d ${best.tpd.toFixed(2)}`);
    console.log('   → Deploy v42 MAX como default, mantener v41 STABLE y v42 PRO como fallback toggles');
  } else {
    console.log('✗ NO variant passes gate (PF≥1.35 AND DD≤26% AND t/d≥5)');
    console.log('   → v42 MAX DESCARTADO. Default queda v42 PRO. Reportar features que mostraron edge aislado:');
    // Report DD improvements regardless of PF gate
    const ddBetter=results.slice(1).filter(r=>r.ddP<baselineRef.ddP-3).sort((a,b)=>a.ddP-b.ddP).slice(0,3);
    if(ddBetter.length){
      console.log('\n   Top 3 overlays by DD reduction (DD >3pp mejor que baseline):');
      for(const r of ddBetter){
        const dPF=(r.s.pf-baselineRef.s.pf).toFixed(2);
        const dDD=(r.ddP-baselineRef.ddP).toFixed(0);
        console.log(`     ${r.name}: ΔPF${dPF>=0?'+':''}${dPF} ΔDD${dDD}pp — candidato v42 PRO+ opcional`);
      }
    } else console.log('   Ningún overlay baja DD >3pp. Edge macro = ~0 en este dataset.');
  }
  fs.writeFileSync('/tmp/v42-max-overlay-result.json',JSON.stringify(results,null,2));
}
main().catch(e=>{console.error(e);process.exit(1);});
