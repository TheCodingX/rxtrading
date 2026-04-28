#!/usr/bin/env node
'use strict';
// V39 — AGREE SCALED (multi-pair × multi-timeframe)
// Extension of validated AGREE-P65-SL2-mp3 winner
// Streams: 1H (P65/SL2/TP3.25), 30m (P70/SL1/TP2), 15m (P75/SL0.8/TP1.6)
// Per-pair filter: embargo-split select pairs with PF>1.2 in first 150d, eval on rest
// Risk-parity sizing + Maker-only fills + Max 3 concurrent positions total

const fs=require('fs');
const path=require('path');
const https=require('https');

const ALL_PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT','LINKUSDT','LTCUSDT','DOTUSDT','ATOMUSDT','UNIUSDT','TRXUSDT','NEARUSDT','APTUSDT','POLUSDT','FILUSDT','ARBUSDT','OPUSDT','INJUSDT','SUIUSDT','TIAUSDT','SEIUSDT','RUNEUSDT','1000PEPEUSDT','WLDUSDT','FETUSDT','RENDERUSDT','JUPUSDT'];
const KLINES_DIR='/tmp/binance-klines-1m';
const INIT_CAP=500,POS_SIZE_BASE=2500,FEE_MAKER=-0.0001,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002,SEED=314159265;
const TOTAL_DAYS=274;

function P(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function hg(u){return new Promise((r,j)=>{https.get(u,s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}
function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggTF(b1m,minutes){const out=[];const stepMs=minutes*60000;let s=0;while(s<b1m.length&&(b1m[s][0]%stepMs)!==0)s++;for(let i=s;i<b1m.length;i+=minutes){const g=b1m.slice(i,i+minutes);if(g.length<minutes)break;let h=-Infinity,l=Infinity,v=0,tbv=0;for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];}const o=g[0][1],c=g[g.length-1][4],tsv=v-tbv;const ti=v>0?(tbv-tsv)/v:0;out.push({t:g[0][0],o,h,l,c,v,tbv,tsv,ti});}return out;}
async function gF(s,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1000`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1].fundingTime)+1;await new Promise(r=>setTimeout(r,200));}return a;}
async function gPI(s,iv,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/premiumIndexKlines?symbol=${s}&interval=${iv}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1500`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1][6])+1;await new Promise(r=>setTimeout(r,180));}return a;}

const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const rsI=(c,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;};
const bb=(c,p=20,m2=2)=>{const mid=sm(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};};
const mcd=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};};
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

// AGREE Momentum features (same as AGREE-P65-SL2-mp3)
function momFeatures(bars,fr,piKl){const n=bars.length;const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);const ti=new Float64Array(n),tbv=new Float64Array(n),tsv=new Float64Array(n);for(let i=0;i<n;i++){const b=bars[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;ti[i]=b.ti;tbv[i]=b.tbv;tsv[i]=b.tsv;}const atr2=at(h,l,c),adx2=ax(h,l,c),mc=mcd(c),e9=em(c,9),e21=em(c,21),e50=em(c,50),vsma=sm(v,20);const ofi4h=new Float64Array(n);for(let i=0;i<n;i++){let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=tbv[j]-tsv[j];ofi4h[i]=s;}const frt=fr?fr.map(f=>+f.fundingTime):[],frr=fr?fr.map(f=>parseFloat(f.fundingRate)):[];function gfr(bt){if(!frt.length)return 0;let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}const piT=piKl?piKl.map(k=>+k[0]):[],piC=piKl?piKl.map(k=>+k[4]):[];function gB(bt){if(!piT.length)return 0;let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?piC[b]:0;}const fs2=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);};F(i=>(adx2.adx[i]-25)/25);F(i=>mc.hist[i]/(atr2[i]||1));F(i=>(e9[i]-e21[i])/(atr2[i]||1));F(i=>(e21[i]-e50[i])/(atr2[i]||1));F(i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F(i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F(i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F(i=>ti[i]);F(i=>{let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=ti[j];return s/4;});F(i=>ofi4h[i]/(vsma[i]*4||1));F(i=>-gfr(t[i])*1000);F(i=>-gB(t[i])*10000);return{fs:fs2,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};}
function revFeatures(bars,fr){const n=bars.length;const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);for(let i=0;i<n;i++){const b=bars[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;}const atr2=at(h,l,c),adx2=ax(h,l,c),r14=rsI(c,14),r7=rsI(c,7),bbd=bb(c,20,2),vsma=sm(v,20);const frt=fr?fr.map(f=>+f.fundingTime):[],frr=fr?fr.map(f=>parseFloat(f.fundingRate)):[];function gfr(bt){if(!frt.length)return 0;let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}const fs2=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);};F(i=>(50-r14[i])/50);F(i=>(50-r7[i])/50);F(i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);F(i=>{if(h[i]===l[i])return 0;const upW=h[i]-Math.max(o[i],c[i]);const loW=Math.min(o[i],c[i])-l[i];return(loW-upW)/(h[i]-l[i]);});F(i=>-gfr(t[i])*1000);F(i=>vsma[i]>0?v[i]/vsma[i]-1:0);F(i=>i>=3?-(c[i]-c[i-3])/c[i-3]*100:0);F(i=>i>=6?-(c[i]-c[i-6])/c[i-6]*100:0);return{fs:fs2,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};}
function pearson(fs,y,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],yv=y[i];if(isNaN(x)||isNaN(yv))continue;sx+=x;sy+=yv;sxy+=x*yv;sx2+=x*x;sy2+=yv*yv;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}
function compute4HTrend(b4h){const n=b4h.length;const c=Float64Array.from(b4h.map(b=>b.c));const e9=em(c,9),e21=em(c,21);const trend=new Int8Array(n);for(let i=0;i<n;i++){trend[i]=e9[i]>e21[i]?1:(e9[i]<e21[i]?-1:0);}return trend;}
function findPrev(arr,ts){let lo=0,hi=arr.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(arr[m]<=ts){b=m;lo=m+1;}else hi=m-1;}return b;}
function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,sharpe:0,mdd:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));const byDay={};for(const x of t){byDay[x.date]=(byDay[x.date]||0)+x.pnl;}const dR=Object.values(byDay);const mD=dR.reduce((a,x)=>a+x,0)/dR.length;const vD=dR.reduce((a,x)=>a+(x-mD)**2,0)/dR.length;const sharpe=vD>0?mD/Math.sqrt(vD)*Math.sqrt(365):0;let cum=0,pk=0,mdd=0;for(const x of t){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,sharpe,mdd};}

// Risk parity: pair sizing inversely proportional to 30d vol
function computeVolFactors(allData){
  const factors={};
  for(const p of Object.keys(allData)){
    const b1h=allData[p].b1h;if(!b1h||b1h.length<720)continue;
    const c=b1h.slice(-720);  // last 30d
    const rets=[];for(let i=1;i<c.length;i++)rets.push((c[i].c-c[i-1].c)/c[i-1].c);
    const mean=rets.reduce((a,x)=>a+x,0)/rets.length;
    const variance=rets.reduce((a,x)=>a+(x-mean)**2,0)/rets.length;
    factors[p]=Math.sqrt(variance);
  }
  // Normalize: avg factor = 1, lower vol = higher size, higher vol = smaller size
  const avg=Object.values(factors).reduce((a,x)=>a+x,0)/Object.keys(factors).length;
  const normalized={};for(const p of Object.keys(factors))normalized[p]=Math.max(0.5,Math.min(1.5,avg/factors[p]));
  return normalized;
}

// Maker fill simulation: at signal bar close, place limit at close price.
// Check if next bar's low (long) or high (short) reaches price → fill. Else skip.
function makerFill(parsed,pair,sigBar,dir){
  const pd=parsed[pair];const ep=pd.c[sigBar];
  const fb=sigBar+1;if(fb>=pd.c.length)return null;
  if(dir===1){if(pd.l[fb]<=ep)return{bar:fb,price:ep};}
  else{if(pd.h[fb]>=ep)return{bar:fb,price:ep};}
  return null;
}

// Generate signals for one TF with AGREE logic
function genAGREE(pair,bars,fr,piKl,trend4,t4,cfg){
  const Fm=momFeatures(bars,fr,piKl);
  const Fr=revFeatures(bars,fr);
  const sigs=[];
  // Train on first 150d (bar index ~ 150d*bars_per_day)
  const barsPerDay=cfg.tfMin===60?24:(cfg.tfMin===30?48:96);
  const splitIdx=Math.floor(150*barsPerDay);
  if(Fm.n<splitIdx+100)return{sigs,tpPair:null};
  // Train signals up to splitIdx for feature selection
  const fwd=new Float64Array(Fm.n).fill(NaN);for(let i=50;i<Fm.n-cfg.fwdBars;i++)fwd[i]=(Fm.c[i+cfg.fwdBars]-Fm.c[i])/Fm.c[i]*100;
  const coM=pearson(Fm.fs,fwd,50,Math.min(splitIdx,Fm.n-cfg.fwdBars));
  const coR=pearson(Fr.fs,fwd,50,Math.min(splitIdx,Fm.n-cfg.fwdBars));
  const selM=coM.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,6);
  const selR=coR.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,6);
  if(selM.length<2)return{sigs,tpPair:null};
  // Compute thresholds from training slice
  let tcM=[];for(let i=55;i<splitIdx;i++){if(Fm.adx[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of selM)comp+=corr*Fm.fs[idx][i];tcM.push(Math.abs(comp));}tcM.sort((a,b)=>a-b);
  let tcR=[];for(let i=55;i<splitIdx;i++){if(Fr.adx[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of selR)comp+=corr*Fr.fs[idx][i];tcR.push(Math.abs(comp));}tcR.sort((a,b)=>a-b);
  const thrM=tcM[Math.floor(tcM.length*cfg.thrP/100)]||0.001;
  const thrR=tcR[Math.floor(tcR.length*cfg.thrP/100)]||0.001;
  // Generate signals on FULL data (for per-pair eval we'll split)
  let last=-5;
  for(let i=Math.max(55,splitIdx);i<Fm.n-cfg.to-1;i++){
    if(i-last<2)continue;if(Fm.adx[i]<cfg.adxF)continue;
    let compM=0;for(const{idx,corr}of selM)compM+=corr*Fm.fs[idx][i];
    let compR=0;for(const{idx,corr}of selR)compR+=corr*Fr.fs[idx][i];
    if(Math.abs(compM)<thrM||Math.abs(compR)<thrR)continue;
    const dirM=compM>0?1:-1,dirR=-1*(compR>0?1:-1);
    if(dirM!==dirR)continue;
    const finalDir=dirM;
    // 4H gate
    if(cfg.gate4h&&trend4){const b4=findPrev(t4,Fm.t[i]);if(b4<0||trend4[b4]!==finalDir)continue;}
    sigs.push({bar:i,dir:finalDir,ts:Fm.t[i],pair,tfMin:cfg.tfMin,atr:Fm.atr[i],entryPrice:Fm.c[i]});last=i;
  }
  // Per-pair PF on first 150d for filtering
  let tpPair=null;
  // Compute in-sample PF for pair filter (training range only — avoid look-ahead)
  const trainSigs=[];let trLast=-5;
  for(let i=55;i<splitIdx-cfg.to-1;i++){
    if(i-trLast<2)continue;if(Fm.adx[i]<cfg.adxF)continue;
    let compM=0;for(const{idx,corr}of selM)compM+=corr*Fm.fs[idx][i];
    let compR=0;for(const{idx,corr}of selR)compR+=corr*Fr.fs[idx][i];
    if(Math.abs(compM)<thrM||Math.abs(compR)<thrR)continue;
    const dirM=compM>0?1:-1,dirR=-1*(compR>0?1:-1);
    if(dirM!==dirR)continue;
    const finalDir=dirM;
    if(cfg.gate4h&&trend4){const b4=findPrev(t4,Fm.t[i]);if(b4<0||trend4[b4]!==finalDir)continue;}
    trainSigs.push({bar:i,dir:finalDir,atrVal:Fm.atr[i]});trLast=i;
  }
  // Simulate trades on train to get pair PF
  let gw=0,gl=0,nT=0;
  for(const s of trainSigs){
    const ep=Fm.c[s.bar];const ap=s.atrVal/ep;if(!isFinite(ap)||ap<=0)continue;
    const slPct=Math.max(0.003,Math.min(0.03,ap*cfg.slM));
    const tpPct=Math.max(0.005,Math.min(0.08,slPct*cfg.tpR));
    const slP=s.dir===1?ep*(1-slPct):ep*(1+slPct),tpP=s.dir===1?ep*(1+tpPct):ep*(1-tpPct);
    let outcome=null;
    for(let j=s.bar+1;j<Math.min(s.bar+cfg.to+1,Fm.n);j++){
      let hS,hT;
      if(s.dir===1){hS=Fm.l[j]<=slP;hT=Fm.h[j]>=tpP;}else{hS=Fm.h[j]>=slP;hT=Fm.l[j]<=tpP;}
      if(hS&&hT)hT=false;
      if(hS){outcome='L';break;}if(hT){outcome='W';break;}
    }
    if(outcome==='W'){gw+=tpPct*POS_SIZE_BASE;nT++;}
    else if(outcome==='L'){gl+=slPct*POS_SIZE_BASE;nT++;}
  }
  tpPair={trainPF:gl>0?gw/gl:0,nTrain:nT};
  return{sigs,tpPair,selM,selR,thrM,thrR};
}

function st_bytime(trades){
  if(!trades.length)return{byDay:{}};
  const byDay={};for(const t of trades){byDay[t.date]=(byDay[t.date]||0)+t.pnl;}
  return{byDay};
}
function corrDaily(t1,t2){const d1={},d2={},dates=new Set();for(const t of t1){d1[t.date]=(d1[t.date]||0)+t.pnl;dates.add(t.date);}for(const t of t2){d2[t.date]=(d2[t.date]||0)+t.pnl;dates.add(t.date);}const ds=[...dates].sort();const x=ds.map(d=>d1[d]||0),y=ds.map(d=>d2[d]||0);if(x.length<10)return 0;const mx=x.reduce((a,v)=>a+v,0)/x.length,my=y.reduce((a,v)=>a+v,0)/y.length;let sxy=0,sxx=0,syy=0;for(let i=0;i<x.length;i++){sxy+=(x[i]-mx)*(y[i]-my);sxx+=(x[i]-mx)**2;syy+=(y[i]-my)**2;}return sxx*syy>0?sxy/Math.sqrt(sxx*syy):0;}

async function main(){
  console.log('═'.repeat(80));
  console.log('V39 — AGREE SCALED (30 pares × 3 timeframes, maker fills, risk-parity)');
  console.log('Embargo split: first 150d pair select (PF>1.2), eval on 150-274d OOS');
  console.log('═'.repeat(80));
  const allData={};const loaded=[];const missing=[];
  console.log('\nLoading 1m klines + aggregating all TFs + fetching FR/PI...');
  for(const pair of ALL_PAIRS){
    const b1m=load1m(pair);
    if(!b1m||b1m.length<50000){missing.push(pair);continue;}
    const b1h=aggTF(b1m,60);const b30m=aggTF(b1m,30);const b15m=aggTF(b1m,15);const b4h=aggTF(b1m,240);
    const fTs=b1h[0].t,lTs=b1h[b1h.length-1].t;
    let fr=[],pi=[];
    try{fr=await gF(pair,fTs,lTs);}catch(e){}
    try{pi=await gPI(pair,'1h',fTs,lTs);}catch(e){}
    allData[pair]={b1h,b30m,b15m,b4h,fr,pi,b1mLen:b1m.length};
    loaded.push(pair);
    process.stdout.write(`${pair}:${b1h.length}h `);
  }
  console.log(`\n\nLOADED: ${loaded.length}/${ALL_PAIRS.length} pairs | MISSING: ${missing.join(',')||'none'}\n`);

  const volFactors=computeVolFactors(allData);

  // Stream configs
  const streams=[
    {name:'AGREE-1H',tfMin:60,thrP:65,slM:2,tpR:1.625,adxF:25,fwdBars:2,to:60,gate4h:true,mc:0.011},
    {name:'AGREE-30m',tfMin:30,thrP:70,slM:1.0,tpR:2.0,adxF:25,fwdBars:4,to:80,gate4h:true,mc:0.011},
    {name:'AGREE-15m',tfMin:15,thrP:75,slM:0.8,tpR:2.0,adxF:25,fwdBars:8,to:96,gate4h:true,mc:0.011},
  ];

  // Per-stream per-pair signal generation (with 150d embargo for selection)
  const allSignalsPerStream={};const pairPFPerStream={};
  for(const stream of streams){
    console.log(`Generating ${stream.name}...`);
    const sigsAll=[];const pairPF={};
    for(const pair of loaded){
      if(!allData[pair])continue;
      const bars=stream.tfMin===60?allData[pair].b1h:(stream.tfMin===30?allData[pair].b30m:allData[pair].b15m);
      if(!bars||bars.length<1500)continue;
      const trend4=stream.gate4h?compute4HTrend(allData[pair].b4h):null;
      const t4=stream.gate4h?allData[pair].b4h.map(b=>b.t):null;
      const{sigs,tpPair}=genAGREE(pair,bars,allData[pair].fr,allData[pair].pi,trend4,t4,stream);
      if(tpPair)pairPF[pair]=tpPair;
      sigsAll.push(...sigs);
    }
    allSignalsPerStream[stream.name]=sigsAll;
    pairPFPerStream[stream.name]=pairPF;
  }

  // Embargo filter: select pairs per stream with trainPF>=1.2
  console.log('\n── Pair filter (train PF>=1.2) ──');
  const selectedPairsPerStream={};
  for(const stream of streams){
    const pairPF=pairPFPerStream[stream.name];
    const keep=Object.keys(pairPF).filter(p=>pairPF[p].trainPF>=1.2&&pairPF[p].nTrain>=5).sort((a,b)=>pairPF[b].trainPF-pairPF[a].trainPF);
    selectedPairsPerStream[stream.name]=new Set(keep);
    console.log(`${stream.name}: ${keep.length}/${Object.keys(pairPF).length} pairs kept. Top 10:`);
    for(const p of keep.slice(0,10))console.log(`  ${p}: trainPF=${pairPF[p].trainPF.toFixed(2)} nTrain=${pairPF[p].nTrain}`);
  }

  // Combined engine: merge all filtered signals, execute with max 3 concurrent
  const combinedSigs=[];
  for(const stream of streams){
    const keep=selectedPairsPerStream[stream.name];
    for(const sig of allSignalsPerStream[stream.name])if(keep.has(sig.pair))combinedSigs.push({...sig,streamName:stream.name,tpR:stream.tpR,slM:stream.slM,to:stream.to});
  }
  combinedSigs.sort((a,b)=>a.ts-b.ts);
  console.log(`\nTotal filtered signals: ${combinedSigs.length} (1H:${combinedSigs.filter(s=>s.streamName==='AGREE-1H').length} 30m:${combinedSigs.filter(s=>s.streamName==='AGREE-30m').length} 15m:${combinedSigs.filter(s=>s.streamName==='AGREE-15m').length})`);

  // Build parsed TF arrays for execution (per TF per pair)
  const parsedByTF={};
  for(const stream of streams){
    parsedByTF[stream.tfMin]={};
    for(const pair of loaded){
      const bars=stream.tfMin===60?allData[pair].b1h:(stream.tfMin===30?allData[pair].b30m:allData[pair].b15m);
      if(!bars||bars.length<100)continue;
      const n=bars.length;
      const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),t=new Float64Array(n);
      for(let i=0;i<n;i++){o[i]=bars[i].o;h[i]=bars[i].h;l[i]=bars[i].l;c[i]=bars[i].c;t[i]=bars[i].t;}
      parsedByTF[stream.tfMin][pair]={o,h,l,c,t};
    }
  }

  // EXECUTION: max 3 concurrent positions, 1 per pair, maker fills
  const allTrades=[];const tradesPerStream={'AGREE-1H':[],'AGREE-30m':[],'AGREE-15m':[]};
  let cap=INIT_CAP;const slots=[null,null,null];
  const prng=P(SEED);
  function advanceSlots(upTs){
    for(let si=0;si<3;si++){
      const pos=slots[si];if(!pos)continue;
      const pd=parsedByTF[pos.tfMin][pos.pair];
      for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upTs;j++){
        let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}
        if(hS&&hT)hT=false;
        if(hS){closePos(si,j,'SL',pd);break;}
        if(hT){closePos(si,j,'TP',pd);break;}
        pos.nc=j+1;
      }
      if(slots[si]&&slots[si].nc>slots[si].exp){closePos(si,Math.min(slots[si].exp,pd.c.length-1),'TO',pd);}
    }
  }
  function closePos(si,j,reason,pd){
    const pos=slots[si];let ep2;
    if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);
    else if(reason==='TP')ep2=pos.tpP;
    else ep2=pd.c[j];
    const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;
    // Maker entry + maker TP (limit) - taker SL + slippage
    const feeE=pos.sz*FEE_MAKER, feeX=pos.sz*(reason==='TP'?FEE_MAKER:FEE_SL);
    const tradePnL=g-feeE-feeX;
    cap+=tradePnL;
    const trade={dir:pos.dir,pnl:tradePnL,type:reason,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10),sz:pos.sz,stream:pos.stream};
    allTrades.push(trade);
    tradesPerStream[pos.stream].push(trade);
    slots[si]=null;
  }

  for(const sig of combinedSigs){
    if(cap<=0)break;
    const pd=parsedByTF[sig.tfMin][sig.pair];if(!pd)continue;
    const eb=sig.bar;if(eb>=pd.c.length-1)continue;
    advanceSlots(pd.t[eb]);
    // Constraint: max 1 position per pair across all streams
    let pairConflict=false;for(const s of slots)if(s&&s.pair===sig.pair){pairConflict=true;break;}
    if(pairConflict)continue;
    // Find free slot
    let freeSlot=-1;for(let si=0;si<3;si++)if(!slots[si]){freeSlot=si;break;}
    if(freeSlot===-1)continue;
    if(prng()>=0.75)continue;
    if(cap<50)continue;
    // Maker fill simulation: limit at signal bar close, check if next bar touches
    const fill=makerFill(parsedByTF[sig.tfMin],sig.pair,sig.bar,sig.dir);
    if(!fill)continue;
    const ep=fill.price;
    const ap=sig.atr/ep;if(ap<=0||!isFinite(ap))continue;
    const slPct=Math.max(0.003,Math.min(0.04,ap*sig.slM));
    const tpPct=Math.max(0.005,Math.min(0.08,slPct*sig.tpR));
    // Risk parity sizing
    const volFact=volFactors[sig.pair]||1.0;
    const sz=POS_SIZE_BASE*volFact;
    slots[freeSlot]={
      pair:sig.pair,dir:sig.dir,ep,
      slP:sig.dir===1?ep*(1-slPct):ep*(1+slPct),
      tpP:sig.dir===1?ep*(1+tpPct):ep*(1-tpPct),
      qty:sz/ep,sz,eb:fill.bar,exp:fill.bar+sig.to,nc:fill.bar+1,
      stream:sig.streamName,tfMin:sig.tfMin
    };
  }
  advanceSlots(Infinity);
  for(let si=0;si<3;si++){if(slots[si]){const pd=parsedByTF[slots[si].tfMin][slots[si].pair];closePos(si,Math.min(slots[si].exp,pd.c.length-1),'TO',pd);}}

  // RESULTS
  console.log('\n'+'═'.repeat(80));console.log('RESULTS V39');console.log('═'.repeat(80));
  // Per-stream metrics
  console.log('\nPer-stream:');
  for(const streamName of ['AGREE-1H','AGREE-30m','AGREE-15m']){
    const tr=tradesPerStream[streamName];const s=st(tr);
    const tpd=s.n/TOTAL_DAYS;
    console.log(`  ${streamName}: ${s.n}t ${tpd.toFixed(2)}t/d WR${s.wr.toFixed(1)}% PF${s.pf.toFixed(2)} Sh${s.sharpe.toFixed(1)} DD$${s.mdd.toFixed(0)} $${s.pnl.toFixed(0)}`);
  }
  // Correlation matrix
  console.log('\nCorrelation matrix (daily PnL):');
  const names=['AGREE-1H','AGREE-30m','AGREE-15m'];
  console.log('           '+names.map(n=>n.padEnd(12)).join(''));
  for(const a of names){const row=names.map(b=>corrDaily(tradesPerStream[a],tradesPerStream[b]).toFixed(3).padEnd(12));console.log(a.padEnd(11)+row.join(''));}
  // Combined
  const sCombined=st(allTrades);
  const tpdCombined=sCombined.n/TOTAL_DAYS;
  console.log('\nCOMBINED (all streams, max 3 concurrent, 1-per-pair):');
  console.log(`  ${sCombined.n}t ${tpdCombined.toFixed(2)}t/d WR${sCombined.wr.toFixed(1)}% PF${sCombined.pf.toFixed(2)} Sh${sCombined.sharpe.toFixed(1)} DD$${sCombined.mdd.toFixed(0)} $${sCombined.pnl.toFixed(0)}`);
  // Per-pair breakdown (top 10 by PnL)
  const byPair={};for(const t of allTrades)(byPair[t.pair]=byPair[t.pair]||[]).push(t);
  const pairStats=Object.keys(byPair).map(p=>({p,s:st(byPair[p])})).sort((a,b)=>b.s.pnl-a.s.pnl);
  console.log('\nTop 10 pairs by PnL (combined):');
  for(const{p,s} of pairStats.slice(0,10))console.log(`  ${p.padEnd(10)}: ${s.n}t WR${s.wr.toFixed(1)}% PF${s.pf.toFixed(2)} $${s.pnl.toFixed(0)}`);
  console.log('\nBottom 5 pairs by PnL:');
  for(const{p,s} of pairStats.slice(-5))console.log(`  ${p.padEnd(10)}: ${s.n}t WR${s.wr.toFixed(1)}% PF${s.pf.toFixed(2)} $${s.pnl.toFixed(0)}`);

  // VERDICT
  console.log('\n'+'═'.repeat(80));
  const piso=sCombined.pf>=1.4&&sCombined.wr>=45&&tpdCombined>=3;
  const aceptable=sCombined.pf>=1.5&&sCombined.wr>=48&&tpdCombined>=4;
  const optimo=sCombined.pf>=1.6&&sCombined.wr>=50&&tpdCombined>=5;
  if(optimo)console.log('★★★ ÓPTIMO — PF≥1.6, WR≥50%, t/d≥5');
  else if(aceptable)console.log('★★ ACEPTABLE — PF≥1.5, WR≥48%, t/d≥4');
  else if(piso)console.log('★ PISO — PF≥1.4, WR≥45%, t/d≥3');
  else console.log('✗ No alcanzó ni el PISO. Cerrar y ir Opción A (AGREE-P65-SL2-mp3 puro)');
  console.log('═'.repeat(80)+'\n');
}
main().catch(e=>{console.error(e);process.exit(1);});
