'use strict';
// V44 engine shared module — exact same logic as /scripts/06b_integrated_v44_redesigned.js
// Extracted for reuse across validation tests. NO parameter tuning allowed.
const fs=require('fs');const path=require('path');

const INIT_CAP=500,POS_SIZE_BASE=2500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002,SEED=314159265;
const CLUSTERS={BTCUSDT:'L1major',ETHUSDT:'L1major',SOLUSDT:'SOLadj',AVAXUSDT:'SOLadj',NEARUSDT:'SOLadj',LINKUSDT:'DeFi',ATOMUSDT:'DeFi',DOTUSDT:'DeFi',ARBUSDT:'L2',BNBUSDT:'Other',XRPUSDT:'Other',ADAUSDT:'Other',LTCUSDT:'Other',DOGEUSDT:'MemesAI','1000PEPEUSDT':'MemesAI'};

function P(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function load1m(p,dir='/tmp/binance-klines-1m'){const d=path.join(dir,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggTF(b1m,m){const o=[];const s=m*60000;let i0=0;while(i0<b1m.length&&(b1m[i0][0]%s)!==0)i0++;for(let i=i0;i<b1m.length;i+=m){const g=b1m.slice(i,i+m);if(g.length<m)break;let h=-Infinity,l=Infinity,v=0,tbv=0;for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];}const c=g[g.length-1][4],tsv=v-tbv,ti=v>0?(tbv-tsv)/v:0;o.push({t:g[0][0],o:g[0][1],h,l,c,v,tbv,tsv,ti});}return o;}

const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const rsI=(c,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;};
const bb=(c,p=20,m2=2)=>{const mid=sm(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};};
const mcd=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};};
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

function momFeatures(bars){const n=bars.length;const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);const ti=new Float64Array(n),tbv=new Float64Array(n),tsv=new Float64Array(n);for(let i=0;i<n;i++){const b=bars[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;ti[i]=b.ti;tbv[i]=b.tbv;tsv[i]=b.tsv;}const atr2=at(h,l,c),adx2=ax(h,l,c),mc=mcd(c),e9=em(c,9),e21=em(c,21),e50=em(c,50),vsma=sm(v,20);const ofi4h=new Float64Array(n);for(let i=0;i<n;i++){let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=tbv[j]-tsv[j];ofi4h[i]=s;}const fsArr=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fsArr.push(a);};F(i=>(adx2.adx[i]-25)/25);F(i=>mc.hist[i]/(atr2[i]||1));F(i=>(e9[i]-e21[i])/(atr2[i]||1));F(i=>(e21[i]-e50[i])/(atr2[i]||1));F(i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F(i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F(i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F(i=>ti[i]);F(i=>{let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=ti[j];return s/4;});F(i=>ofi4h[i]/(vsma[i]*4||1));return{fs:fsArr,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};}
function revFeatures(bars){const n=bars.length;const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);for(let i=0;i<n;i++){const b=bars[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;}const atr2=at(h,l,c),adx2=ax(h,l,c),r14=rsI(c,14),r7=rsI(c,7),bbd=bb(c,20,2),vsma=sm(v,20);const fsArr=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fsArr.push(a);};F(i=>(50-r14[i])/50);F(i=>(50-r7[i])/50);F(i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);F(i=>{if(h[i]===l[i])return 0;const upW=h[i]-Math.max(o[i],c[i]);const loW=Math.min(o[i],c[i])-l[i];return(loW-upW)/(h[i]-l[i]);});F(i=>vsma[i]>0?v[i]/vsma[i]-1:0);F(i=>i>=3?-(c[i]-c[i-3])/c[i-3]*100:0);F(i=>i>=6?-(c[i]-c[i-6])/c[i-6]*100:0);return{fs:fsArr,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};}
function pearson(fs,y,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],yv=y[i];if(isNaN(x)||isNaN(yv))continue;sx+=x;sy+=yv;sxy+=x*yv;sx2+=x*x;sy2+=yv*yv;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}
function compute4HTrend(b4h){const n=b4h.length;const c=Float64Array.from(b4h.map(b=>b.c));const e9=em(c,9),e21=em(c,21);const trend=new Int8Array(n);for(let i=0;i<n;i++){trend[i]=e9[i]>e21[i]?1:(e9[i]<e21[i]?-1:0);}return trend;}
function findPrev(arr,ts){let lo=0,hi=arr.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(arr[m]<=ts){b=m;lo=m+1;}else hi=m-1;}return b;}
function shannonEntropy(rets,nBins=10){if(rets.length<10)return 0;const mn=Math.min(...rets),mx=Math.max(...rets);if(mx===mn)return 0;const bz=(mx-mn)/nBins;const c=new Array(nBins).fill(0);for(const r of rets){const b=Math.min(nBins-1,Math.floor((r-mn)/bz));c[b]++;}const t=rets.length;let H=0;for(const x of c){if(x===0)continue;const p=x/t;H-=p*Math.log2(p);}return H;}

function genSignals(allData,opts={}){
  const TRAIN_D=opts.train||120,TEST_D=opts.test||30,STEP_D=opts.step||30;
  const SPAN_D=opts.spanDays||273;
  const signals=[];const parsed={};
  const firstTs=Math.min(...Object.values(allData).map(d=>d.b1h[0].t));
  const nW=Math.max(1,Math.floor((SPAN_D-TRAIN_D-TEST_D)/STEP_D)+1);
  for(let w=0;w<nW;w++){
    const trs=firstTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;
    const pm={};
    for(const pair of Object.keys(allData)){const tB=allData[pair].b1h.filter(b=>b.t>=trs&&b.t<tre);if(tB.length<300)continue;const Fm=momFeatures(tB);const Fr=revFeatures(tB);const fwd=new Float64Array(Fm.n).fill(NaN);for(let i=50;i<Fm.n-2;i++)fwd[i]=(Fm.c[i+2]-Fm.c[i])/Fm.c[i]*100;const coM=pearson(Fm.fs,fwd,50,Fm.n-2);const coR=pearson(Fr.fs,fwd,50,Fr.n-2);const selM=coM.map((c,i)=>({idx:i,corr:c,abs:Math.abs(c)})).filter(x=>x.abs>=0.011).sort((a,b)=>b.abs-a.abs).slice(0,6);const selR=coR.map((c,i)=>({idx:i,corr:c,abs:Math.abs(c)})).filter(x=>x.abs>=0.011).sort((a,b)=>b.abs-a.abs).slice(0,6);if(selM.length<2)continue;let tcM=[];for(let i=55;i<Fm.n;i++){if(Fm.adx[i]<22)continue;let comp=0;for(const{idx,corr}of selM)comp+=corr*Fm.fs[idx][i];tcM.push(Math.abs(comp));}tcM.sort((a,b)=>a-b);let tcR=[];for(let i=55;i<Fr.n;i++){if(Fr.adx[i]<22)continue;let comp=0;for(const{idx,corr}of selR)comp+=corr*Fr.fs[idx][i];tcR.push(Math.abs(comp));}tcR.sort((a,b)=>a-b);const thrM=tcM[Math.floor(tcM.length*0.55)]||0.001;const thrR=tcR[Math.floor(tcR.length*0.55)]||0.001;pm[pair]={selM,selR,thrM,thrR};}
    if(Object.keys(pm).length<4)continue;
    for(const pair of Object.keys(allData)){if(!pm[pair])continue;const teB=allData[pair].b1h.filter(b=>b.t>=tes&&b.t<tee);if(teB.length<50)continue;const te4=allData[pair].b4h.filter(b=>b.t>=tes-4*3600000&&b.t<tee);const Fm=momFeatures(teB);const Fr=revFeatures(teB);if(!parsed[pair])parsed[pair]={t:[...Fm.t],o:[...Fm.o],h:[...Fm.h],l:[...Fm.l],c:[...Fm.c],atr:[...Fm.atr]};else{for(let i=0;i<Fm.t.length;i++){parsed[pair].t.push(Fm.t[i]);parsed[pair].o.push(Fm.o[i]);parsed[pair].h.push(Fm.h[i]);parsed[pair].l.push(Fm.l[i]);parsed[pair].c.push(Fm.c[i]);parsed[pair].atr.push(Fm.atr[i]);}}const{selM,selR,thrM,thrR}=pm[pair];const trend4=compute4HTrend(te4);const t4=te4.map(b=>b.t);let last=-3;for(let i=55;i<Fm.n-60-1;i++){if(i-last<2)continue;if(Fm.adx[i]<22)continue;let compM=0;for(const{idx,corr}of selM)compM+=corr*Fm.fs[idx][i];let compR=0;for(const{idx,corr}of selR)compR+=corr*Fr.fs[idx][i];const passM=Math.abs(compM)>=thrM;const passR=Math.abs(compR)>=thrR;const dirM=compM>0?1:-1;const dirR=-1*(compR>0?1:-1);let finalDir=0,absComp=0,thrUsed=0;if(passM&&passR&&dirM===dirR){finalDir=dirM;absComp=Math.max(Math.abs(compM),Math.abs(compR));thrUsed=Math.max(thrM,thrR);}else if(passM){finalDir=dirM;absComp=Math.abs(compM);thrUsed=thrM;}else if(passR){finalDir=dirR;absComp=Math.abs(compR);thrUsed=thrR;}if(finalDir===0)continue;const b4=findPrev(t4,Fm.t[i]);if(b4<0||trend4[b4]!==finalDir)continue;const absIdx=parsed[pair].t.length-Fm.n+i;const confRatio=absComp/thrUsed;const hr=new Date(Fm.t[i]).getUTCHours();signals.push({pair,ts:Fm.t[i],dir:finalDir,absIdx,atr:Fm.atr[i],confRatio,hr});last=i;}}
  }
  signals.sort((a,b)=>a.ts-b.ts);
  return{signals,parsed};
}

// V44 Engine — EXACT parameters frozen
const V44_PARAMS={
  tod:true,adaptive:true,maxPos:4,maxCluster:3,safety:true,
  entropy:true,useHRP:true,
  entropyPct:0.80,
  entropyWindowDays:30,
  ddWindow14:14,ddWindow30:30,
  ddThresh14:0.15,ddStop14:0.25,ddStop30:0.35,
  peakThresh:0.80,
  ksEnter:1.05,ksExit:1.10,
  slMNormal:2,tpRNormal:1.625,slMHigh:2.5,tpRHigh:1.4,
  tierThr:[5,15,30],tierMul:[0.3,1.0,1.2,1.5],
  prngGate:0.75,minCap:50,
  posSizeBase:2500
};

function runV44(signals,parsed,allBars,hrpWeights,cfgOverrides={}){
  const cfg={...V44_PARAMS,...cfgOverrides};
  const SKIP=cfg.tod?new Set([0,7,10,11,12,13,17,18]):null;
  const MAXP=cfg.maxPos,MAXCL=cfg.maxCluster;
  const tierThr=cfg.tierThr;const tierMul=cfg.tierMul;
  let cap=INIT_CAP;const trades=[];const slots=new Array(MAXP).fill(null);const prng=P(SEED);
  let peak=INIT_CAP;
  const dailyPnL={};
  const stopUntil={value:0};
  const vpct={};for(const p of Object.keys(parsed)){const pd=parsed[p];const aps=[];for(let i=50;i<pd.c.length;i++){if(pd.c[i]>0&&pd.atr[i]>0)aps.push(pd.atr[i]/pd.c[i]);}aps.sort((a,b)=>a-b);vpct[p]={p66:aps[Math.floor(aps.length*0.66)]||0};}
  const entropyThresh={};const entropySeries={};
  if(cfg.entropy){
    for(const p of Object.keys(allBars)){
      const b=allBars[p].b1h;const rets=[];for(let i=1;i<b.length;i++)rets.push((b[i].c-b[i-1].c)/b[i-1].c);
      const window=24*cfg.entropyWindowDays;const es=new Float64Array(b.length);
      for(let i=window;i<b.length;i++)es[i]=shannonEntropy(rets.slice(i-window,i));
      const valid=Array.from(es).filter(x=>x>0).sort((a,b)=>a-b);
      entropyThresh[p]=valid[Math.floor(valid.length*cfg.entropyPct)]||0;
      entropySeries[p]={ts:b.map(x=>x.t),entropy:Array.from(es)};
    }
  }
  function recordDaily(date,pnl){dailyPnL[date]=(dailyPnL[date]||0)+pnl;}
  function ddFromRolling(now,days){const nowDate=new Date(now);let pk=0,cum=0,mdd=0;const dates=Object.keys(dailyPnL).filter(d=>(nowDate-new Date(d))/86400000<=days).sort();for(const d of dates){cum+=dailyPnL[d];if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}return mdd;}
  function getSizeScale(now){if(now<stopUntil.value)return 0;const dd14=ddFromRolling(now,cfg.ddWindow14);const dd30=ddFromRolling(now,cfg.ddWindow30);if(dd30>cfg.ddStop30*INIT_CAP){stopUntil.value=now+72*3600000;return 0;}if(dd14>cfg.ddStop14*INIT_CAP){stopUntil.value=now+24*3600000;return 0;}if(dd14>cfg.ddThresh14*INIT_CAP)return 0.5;if(peak>0&&cap/peak<cfg.peakThresh)return 0.7;return 1;}
  function getTier(pctAbove){if(pctAbove<tierThr[0])return 1;if(pctAbove<tierThr[1])return 2;if(pctAbove<tierThr[2])return 3;return 4;}
  function cls(si,j,reason){const pos=slots[si];const pd=parsed[pos.pair];let ep2;if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(reason==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;const fE=pos.sz*FEE_E,fX=pos.sz*(reason==='TP'?FEE_TP:FEE_SL);const pnl=g-fE-fX;cap+=pnl;if(cap>peak)peak=cap;const date=new Date(pd.t[j]).toISOString().slice(0,10);recordDaily(date,pnl);trades.push({pnl,type:reason,pair:pos.pair,date,ts:pd.t[j],tier:pos.tier,sz:pos.sz,stream:'directional'});slots[si]=null;}
  function advance(upTs){for(let si=0;si<MAXP;si++){const pos=slots[si];if(!pos)continue;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upTs;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){cls(si,j,'SL');break;}if(hT){cls(si,j,'TP');break;}pos.nc=j+1;}if(slots[si]&&slots[si].nc>slots[si].exp){cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}}
  function getEntropy(pair,ts){if(!cfg.entropy)return 0;const es=entropySeries[pair];if(!es)return 0;let lo=0,hi=es.ts.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(es.ts[m]<=ts){b=m;lo=m+1;}else hi=m-1;}return b>=0?es.entropy[b]:0;}

  for(const sig of signals){
    if(cap<=0)break;
    if(SKIP&&SKIP.has(sig.hr))continue;
    const pd=parsed[sig.pair];if(!pd)continue;
    const eb=sig.absIdx+1;if(eb>=pd.c.length)continue;
    advance(pd.t[eb]);
    const scale=getSizeScale(pd.t[eb]);
    if(scale===0)continue;
    if(cfg.entropy&&getEntropy(sig.pair,sig.ts)>entropyThresh[sig.pair])continue;
    if(cfg.safety){const now=pd.t[eb];if(now<stopUntil.value)continue;const today=new Date(now).toISOString().slice(0,10);const todayLoss=Math.abs(Math.min(0,dailyPnL[today]||0));if(todayLoss>0.05*INIT_CAP)continue;if(cap<100)continue;let deployed=0;for(const s of slots)if(s)deployed+=s.sz;if(deployed>0.5*INIT_CAP*10)continue;}
    const clCnts={};for(const s of slots)if(s)clCnts[CLUSTERS[s.pair]||'o']=(clCnts[CLUSTERS[s.pair]||'o']||0)+1;
    if((clCnts[CLUSTERS[sig.pair]||'o']||0)>=MAXCL)continue;
    let conflict=false;for(const s of slots)if(s&&s.pair===sig.pair){conflict=true;break;}
    if(conflict)continue;
    let freeSlot=-1;for(let si=0;si<MAXP;si++)if(!slots[si]){freeSlot=si;break;}
    if(freeSlot===-1)continue;
    if(prng()>=cfg.prngGate)continue;if(cap<cfg.minCap)continue;
    const ep=pd.o[eb],atrA=pd.atr[sig.absIdx],ap=atrA/pd.c[sig.absIdx];if(ap<=0||isNaN(ap))continue;
    let slM=cfg.slMNormal,tpR=cfg.tpRNormal;if(cfg.adaptive){const{p66}=vpct[sig.pair]||{p66:0};if(ap>p66){slM=cfg.slMHigh;tpR=cfg.tpRHigh;}}
    const slPct=Math.max(0.003,Math.min(0.03,ap*slM));const tpPct=Math.max(0.005,Math.min(0.08,slPct*tpR));
    const pctAbove=(sig.confRatio-1)*100;const tier=getTier(pctAbove);const tierMult=tierMul[tier-1];
    const hrpMult=hrpWeights&&cfg.useHRP?hrpWeights[sig.pair]*Object.keys(hrpWeights).length:1;
    const sz=cfg.posSizeBase*tierMult*scale*(cfg.useHRP?hrpMult:1);
    if(sz<10)continue;
    slots[freeSlot]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-slPct):ep*(1+slPct),tpP:sig.dir===1?ep*(1+tpPct):ep*(1-tpPct),qty:sz/ep,sz,tier,eb,exp:eb+60,nc:eb+1};
  }
  advance(Infinity);for(let si=0;si<MAXP;si++){if(slots[si]){const pd=parsed[slots[si].pair];cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}
  return{trades,finalCap:cap,peakCap:peak};
}

function proxyFunding(bars1h){const n=bars1h.length;const c=bars1h.map(b=>b.c);const ema=new Float64Array(n);ema[0]=c[0];const alpha=2/(50+1);for(let i=1;i<n;i++)ema[i]=c[i]*alpha+ema[i-1]*(1-alpha);const premium=c.map((v,i)=>(v-ema[i])/ema[i]);const funding=new Float64Array(n);const w=8;for(let i=w;i<n;i++){let s=0;for(let j=i-w+1;j<=i;j++)s+=premium[j];funding[i]=s/w;}return funding;}

function runFundingStream(allData,fundings,overrides={}){
  const SIZE_PCT=overrides.sizePct||0.10;
  const TP_BPS=overrides.tpBps||30;const SL_BPS=overrides.slBps||25;const HOLD_H=overrides.holdH||4;
  const p80Q=overrides.p80||0.80;const p20Q=overrides.p20||0.20;
  const fPosMin=overrides.fPosMin||0.005;const fNegMax=overrides.fNegMax||-0.002;
  const trades=[];
  let cap=INIT_CAP;
  for(const pair of Object.keys(allData)){
    const bars=allData[pair].b1h;const fund=fundings[pair];let pos=null;
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
          cap+=pnl;trades.push({pnl,date:d.toISOString().slice(0,10),ts,pair,stream:'funding'});
          pos=null;
        }
      }
      if(!pos&&(hr===0||hr===8||hr===16)){
        const f=fund[i];const fWin=fund.slice(Math.max(0,i-168),i);
        const p80=[...fWin].sort((a,b)=>a-b)[Math.floor(fWin.length*p80Q)]||0;
        const p20=[...fWin].sort((a,b)=>a-b)[Math.floor(fWin.length*p20Q)]||0;
        let dir=0;if(f>p80&&f>fPosMin)dir=-1;else if(f<p20&&f<fNegMax)dir=1;
        if(dir!==0)pos={entry:bars[i].c,dir,entryI:i,size:cap*SIZE_PCT};
      }
    }
  }
  return{trades,finalCap:cap};
}

function statsFull(trades,capital=INIT_CAP){
  if(!trades.length)return{pf:0,wr:0,pnl:0,n:0,sharpe:0,mdd:0,mddPct:0,dailyPnL:{}};
  const w=trades.filter(x=>x.pnl>0),lo=trades.filter(x=>x.pnl<=0);
  const gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));
  const byDay={};for(const x of trades){byDay[x.date]=(byDay[x.date]||0)+x.pnl;}
  const dR=Object.values(byDay);const mD=dR.reduce((a,x)=>a+x,0)/dR.length;const vD=dR.reduce((a,x)=>a+(x-mD)**2,0)/dR.length;
  const sharpe=vD>0?mD/Math.sqrt(vD)*Math.sqrt(365):0;
  let cum=0,pk=0,mdd=0;for(const x of trades){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}
  return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/trades.length*100,pnl:gw-gl,n:trades.length,sharpe,mdd,mddPct:mdd/(capital+Math.max(0,gw-gl))*100,dailyPnL:byDay};
}

function loadHRP(resultsDir){
  try{
    const f=JSON.parse(fs.readFileSync(path.join(resultsDir,'04_dd_reduction.json'),'utf8'));
    const sumW=Object.values(f.hrp.weights).reduce((a,x)=>a+x,0);
    const norm={};for(const[p,w]of Object.entries(f.hrp.weights))norm[p]=w/sumW;
    return norm;
  }catch(e){return null;}
}

module.exports={PAIRS:['ADAUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','SOLUSDT','LTCUSDT','DOTUSDT','NEARUSDT','AVAXUSDT','DOGEUSDT','BNBUSDT'],V44_PARAMS,INIT_CAP,CLUSTERS,load1m,aggTF,genSignals,runV44,proxyFunding,runFundingStream,statsFull,loadHRP,shannonEntropy};
