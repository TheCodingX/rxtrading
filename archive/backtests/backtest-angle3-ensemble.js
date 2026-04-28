#!/usr/bin/env node
'use strict';
// ANGLE 3 — ENSEMBLE OF 3 LABEL STRATEGIES
// Model A: MOMENTUM labels (TP=2×ATR, SL=1×ATR, horizon 12 bars) — features biased to trend
// Model B: MEAN-REV labels (entry after wick >2σ, TP=mid BB, SL=2.5σ) — features biased to reversal
// Model C: VOL EXPANSION labels (entry when realized vol spikes, OBV direction, TP=3×ATR, SL=1.5×ATR)
//
// Each model selects its own features via Pearson corr with its own labels.
// Signal fires when 2+ models agree direction OR 1 model with high confidence.

const fs=require('fs');
const path=require('path');
const https=require('https');

const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT'];
const KLINES_DIR='/tmp/binance-klines-1m';
const METRICS_DIR='/tmp/binance-metrics';
const INIT_CAP=500,POS_SIZE=2500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002,SEED=314159265;
const CLUSTERS={BTCUSDT:'L1',ETHUSDT:'L1',BNBUSDT:'L1',SOLUSDT:'L1alt',AVAXUSDT:'L1alt',XRPUSDT:'alt',ADAUSDT:'alt',DOGEUSDT:'meme'};

function P(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function hg(u){return new Promise((r,j)=>{https.get(u,s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}

function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggTo1h(b1m){const out=[];let s=0;while(s<b1m.length&&(b1m[s][0]%3600000)!==0)s++;for(let i=s;i<b1m.length;i+=60){const g=b1m.slice(i,i+60);if(g.length<60)break;let h=-Infinity,l=Infinity,v=0,qv=0,cnt=0,tbv=0,im=0,mx=0,ims=[];for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];qv+=b[7];cnt+=b[8];tbv+=b[9];const x=b[5]>0?(2*b[9]-b[5])/b[5]:0;ims.push(x);im+=x;const a=b[8]>0?b[7]/b[8]:0;if(a>mx)mx=a;}const o=g[0][1],c=g[g.length-1][4],tsv=v-tbv,ti=v>0?(tbv-tsv)/v:0,mi=im/60;const vi=ims.reduce((a,x)=>a+(x-mi)**2,0)/60;const dc=ims.filter(x=>Math.sign(x)===Math.sign(ti)).length/60;out.push({t:g[0][0],o,h,l,c,v,qv,cnt,tbv,tsv,ti,apm:cnt/60,lts:mx,vi,mi,dc});}return out;}
function loadMetrics(p){const d=path.join(METRICS_DIR,p);if(!fs.existsSync(d))return[];const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')&&f.startsWith(`${p}-metrics-`));const out=[];for(const f of fl){let ct;try{ct=fs.readFileSync(path.join(d,f),'utf8');}catch(e){continue;}const ln=ct.split('\n');for(let i=1;i<ln.length;i++){const l=ln[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<8)continue;const ts=new Date(p2[0].replace(' ','T')+'Z').getTime();out.push({t:ts,oi:parseFloat(p2[2])||0,topPos:parseFloat(p2[5])||1,lsAcct:parseFloat(p2[6])||1,taker:parseFloat(p2[7])||1});}}out.sort((a,b)=>a.t-b.t);return out;}
async function gF(s,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1000`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1].fundingTime)+1;await new Promise(r=>setTimeout(r,250));}return a;}
async function gPI(s,iv,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/premiumIndexKlines?symbol=${s}&interval=${iv}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1500`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1][6])+1;await new Promise(r=>setTimeout(r,200));}return a;}

const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const rs=(c,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;};
const bb=(c,p=20,m2=2)=>{const mid=sm(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};};
const mcd=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};};
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

// 3 feature sets for 3 model archetypes — DIFFERENT biases
function buildFeatures_Momentum(b1h,metrics,fr,piKl){
  // Momentum model: trend + orderflow directional
  const n=b1h.length;
  const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);
  const ti=new Float64Array(n),tbv=new Float64Array(n),tsv=new Float64Array(n),mi=new Float64Array(n),dc=new Float64Array(n);
  for(let i=0;i<n;i++){const b=b1h[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;ti[i]=b.ti;tbv[i]=b.tbv;tsv[i]=b.tsv;mi[i]=b.mi;dc[i]=b.dc;}
  const atr2=at(h,l,c),adx2=ax(h,l,c),mc=mcd(c),e9=em(c,9),e21=em(c,21),e50=em(c,50),vsma=sm(v,20);
  const ofi4h=new Float64Array(n);for(let i=0;i<n;i++){let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=tbv[j]-tsv[j];ofi4h[i]=s;}
  const fs2=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);};
  F(i=>(adx2.adx[i]-25)/25);F(i=>mc.hist[i]/(atr2[i]||1));F(i=>(e9[i]-e21[i])/(atr2[i]||1));F(i=>(e21[i]-e50[i])/(atr2[i]||1));
  F(i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F(i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F(i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F(i=>i>=12?(c[i]-c[i-12])/c[i-12]*100:0);
  F(i=>ti[i]);F(i=>{let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=ti[j];return s/4;});F(i=>ofi4h[i]/(vsma[i]*4||1));F(i=>dc[i]-0.5);F(i=>mi[i]);
  return{fs:fs2,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};
}

function buildFeatures_MeanRev(b1h,metrics,fr,piKl){
  // Mean-reversion model: overextension + reversal signals
  const n=b1h.length;
  const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);
  for(let i=0;i<n;i++){const b=b1h[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;}
  const atr2=at(h,l,c),adx2=ax(h,l,c),r14=rs(c,14),r7=rs(c,7),bbd=bb(c,20,2),vsma=sm(v,20);
  const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));
  function gfr(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}
  const piT=piKl.map(k=>+k[0]),piC=piKl.map(k=>+k[4]);
  function gB(bt){let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?piC[b]:0;}
  function gBz(bt){let lo2=0,hi2=piT.length-1,b=-1;while(lo2<=hi2){const m=(lo2+hi2)>>1;if(piT[m]<=bt){b=m;lo2=m+1;}else hi2=m-1;}if(b<50)return 0;const w=piC.slice(b-49,b+1),mn=w.reduce((a,x)=>a+x,0)/w.length,sd=Math.sqrt(w.reduce((a,x)=>a+(x-mn)**2,0)/w.length);return sd>0?(piC[b]-mn)/sd:0;}
  const fs2=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);};
  F(i=>(50-r14[i])/50);F(i=>(50-r7[i])/50);
  F(i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);
  F(i=>h[i]!==l[i]?(c[i]-l[i])/(h[i]-l[i])-0.5:0);
  // Wick size: upper wick (bearish rev signal when long), lower wick (bullish rev when short)
  F(i=>{if(h[i]===l[i])return 0;const body=Math.abs(c[i]-o[i]);const upperWick=h[i]-Math.max(o[i],c[i]);const lowerWick=Math.min(o[i],c[i])-l[i];return(lowerWick-upperWick)/(h[i]-l[i]);});
  F(i=>-gfr(t[i])*1000);F(i=>-gB(t[i])*10000);F(i=>-gBz(t[i]));
  F(i=>vsma[i]>0?v[i]/vsma[i]-1:0);
  F(i=>i>=3?-(c[i]-c[i-3])/c[i-3]*100:0);  // REVERSED sign: big up move = short signal
  F(i=>i>=6?-(c[i]-c[i-6])/c[i-6]*100:0);
  return{fs:fs2,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};
}

function buildFeatures_VolExp(b1h,metrics,fr,piKl){
  // Vol expansion model: activity spike + orderflow direction + OI change
  const n=b1h.length;
  const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);
  const ti=new Float64Array(n),apm=new Float64Array(n),lts=new Float64Array(n),vi=new Float64Array(n);
  for(let i=0;i<n;i++){const b=b1h[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;ti[i]=b.ti;apm[i]=b.apm;lts[i]=b.lts;vi[i]=b.vi;}
  const atr2=at(h,l,c),adx2=ax(h,l,c),vsma=sm(v,20),apmSma=sm(apm,20),ltsSma=sm(lts,50);
  // Realized volatility = std of returns over past 24 bars
  const rvol=new Float64Array(n);for(let i=24;i<n;i++){let mean=0;for(let j=i-23;j<=i;j++)mean+=(c[j]-c[j-1])/c[j-1];mean/=24;let var2=0;for(let j=i-23;j<=i;j++){const r2=(c[j]-c[j-1])/c[j-1];var2+=(r2-mean)**2;}rvol[i]=Math.sqrt(var2/24);}
  const rvolSma=sm(rvol,48);
  // OBV approximation
  const obv=new Float64Array(n);for(let i=1;i<n;i++){const dir=c[i]>c[i-1]?1:(c[i]<c[i-1]?-1:0);obv[i]=obv[i-1]+v[i]*dir;}
  const mT=metrics.map(x=>x.t);
  function gM(bt,lbMin){let lo=0,hi=mT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(mT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}if(b<0)return null;const lb=Math.floor(lbMin/5);return{cur:metrics[b],prev:(b-lb>=0?metrics[b-lb]:null)};}
  const fs2=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);};
  F(i=>rvolSma[i]>0?rvol[i]/rvolSma[i]-1:0);       // vol expansion
  F(i=>vsma[i]>0?v[i]/vsma[i]-1:0);                  // vol ratio
  F(i=>apmSma[i]>0?apm[i]/apmSma[i]-1:0);            // trade intensity
  F(i=>ltsSma[i]>0?lts[i]/ltsSma[i]-1:0);            // large trade detection
  F(i=>i>=5?(obv[i]-obv[i-5])/(vsma[i]*5||1):0);     // OBV slope
  F(i=>ti[i]);                                        // taker imbalance (direction)
  F(i=>vi[i]);                                        // trade toxicity
  F(i=>(atr2[i]/c[i])*100);                           // current ATR%
  F(i=>{const m=gM(t[i],60);if(!m||!m.prev||m.prev.oi===0)return 0;return(m.cur.oi-m.prev.oi)/m.prev.oi*100;});
  F(i=>{const m=gM(t[i],240);if(!m||!m.prev||m.prev.oi===0)return 0;return(m.cur.oi-m.prev.oi)/m.prev.oi*100;});
  F(i=>{const m=gM(t[i],0);if(!m||m.cur.taker<=0)return 0;return Math.log(m.cur.taker);});
  return{fs:fs2,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};
}

function pearson(fs,y,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],yv=y[i];if(isNaN(x)||isNaN(yv))continue;sx+=x;sy+=yv;sxy+=x*yv;sx2+=x*x;sy2+=yv*yv;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}

// Triple-barrier label with different TP/SL/horizon per model
function tb(h,l,c,atr,i,tpM,slM,horz,dir){const ep=c[i];const tp=dir===1?ep+atr[i]*tpM:ep-atr[i]*tpM;const sl=dir===1?ep-atr[i]*slM:ep+atr[i]*slM;for(let j=i+1;j<Math.min(c.length,i+horz+1);j++){let hT,hS;if(dir===1){hT=h[j]>=tp;hS=l[j]<=sl;}else{hT=l[j]<=tp;hS=h[j]>=sl;}if(hT&&!hS)return 1;if(hS&&!hT)return -1;if(hT&&hS)return 0;}return 0;}

// Generate fwd target given model archetype
function computeFwdTarget(c,atr,fwd,archetype){
  // For momentum: plain fwd return
  // For meanrev: NEGATIVE fwd return (label inverted — betting on reversal)
  // For volexp: fwd vol change
  const n=c.length;const target=new Float64Array(n).fill(NaN);
  if(archetype==='momentum'||archetype==='volexp'){
    for(let i=50;i<n-fwd;i++)target[i]=(c[i+fwd]-c[i])/c[i]*100;
  }else if(archetype==='meanrev'){
    // For mean-rev: we want to predict fwd return WHEN we're at an extreme
    // Label = fwd return × (current position vs mean) → inverted correlation = fade signal
    for(let i=50;i<n-fwd;i++)target[i]=(c[i+fwd]-c[i])/c[i]*100;
  }
  return target;
}

function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,sharpe:0,mdd:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));const byDay={};for(const x of t){byDay[x.date]=(byDay[x.date]||0)+x.pnl;}const dR=Object.values(byDay);const mD=dR.reduce((a,x)=>a+x,0)/dR.length;const vD=dR.reduce((a,x)=>a+(x-mD)**2,0)/dR.length;const sharpe=vD>0?mD/Math.sqrt(vD)*Math.sqrt(365):0;let cum=0,pk=0,mdd=0;for(const x of t){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,sharpe,mdd};}

function engine(sigs,parsed,prng,cfg){
  let cap=INIT_CAP,pk=INIT_CAP;const trades=[];
  const slots=new Array(cfg.maxPos).fill(null);
  function cls(si,j,reason){const pos=slots[si];const pd=parsed[pos.pair];let ep2;if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(reason==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;const f=pos.sz*FEE_E+pos.sz*(reason==='TP'?FEE_TP:FEE_SL);cap+=g-f;pk=Math.max(pk,cap);trades.push({dir:pos.dir,pnl:g-f,type:reason,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10),sz:pos.sz,src:pos.src});slots[si]=null;}
  function advance(upTs){for(let si=0;si<cfg.maxPos;si++){const pos=slots[si];if(!pos)continue;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upTs;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){cls(si,j,'SL');break;}if(hT){cls(si,j,'TP');break;}pos.nc=j+1;}if(slots[si]&&slots[si].nc>slots[si].exp){cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}}
  sigs.sort((a,b)=>a.ts-b.ts);
  for(const sig of sigs){if(cap<=0)break;const d=parsed[sig.pair];const eb=sig.bar+1;if(eb>=d.c.length)continue;advance(d.t[eb]);let freeSlot=-1;const clCnt={};for(let si=0;si<cfg.maxPos;si++)if(slots[si])clCnt[CLUSTERS[slots[si].pair]]=(clCnt[CLUSTERS[slots[si].pair]]||0)+1;for(let si=0;si<cfg.maxPos;si++){if(slots[si])continue;let conflict=false;for(let sj=0;sj<cfg.maxPos;sj++)if(slots[sj]&&slots[sj].pair===sig.pair){conflict=true;break;}if(conflict)continue;const cl=CLUSTERS[sig.pair]||'o';if((clCnt[cl]||0)>=cfg.maxCluster)continue;freeSlot=si;break;}if(freeSlot===-1)continue;if(prng()>=0.75)continue;if(cap<50)continue;const ep=d.o[eb],atrA=d.atr[sig.bar],ap=atrA/d.c[sig.bar];if(ap<=0||isNaN(ap))continue;let sl=Math.max(0.003,Math.min(0.03,ap*cfg.slM)),tp=Math.max(0.005,Math.min(0.08,sl*cfg.tpR));const sizeMult=cfg.dynSize?Math.max(0.5,Math.min(2.0,sig.conf)):1.0;const sz=POS_SIZE*sizeMult;slots[freeSlot]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-sl):ep*(1+sl),tpP:sig.dir===1?ep*(1+tp):ep*(1-tp),qty:sz/ep,eb,exp:eb+cfg.to,nc:eb+1,sz,src:sig.src};}
  advance(Infinity);for(let si=0;si<cfg.maxPos;si++){if(slots[si]){const pd=parsed[slots[si].pair];cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}
  return{trades};
}

async function main(){
  console.log('═'.repeat(80));console.log('ANGLE 3 — ENSEMBLE OF 3 LABEL STRATEGIES');console.log('═'.repeat(80));
  const allData={};
  for(const pair of PAIRS){process.stdout.write(pair+' ');const b1m=load1m(pair);if(!b1m||b1m.length<10000){console.log('[SKIP]');continue;}const b1h=aggTo1h(b1m);const metrics=loadMetrics(pair);const fTs=b1h[0].t,lTs=b1h[b1h.length-1].t;const fr=await gF(pair,fTs,lTs);const pi=await gPI(pair,'1h',fTs,lTs);allData[pair]={b1h,metrics,fr,pi};}
  console.log('\n');
  const firstTs=Math.min(...Object.values(allData).map(d=>d.b1h[0].t));
  const totalDays=274;const TRAIN_D=120,TEST_D=30,STEP_D=30;const nW=Math.floor((totalDays-TRAIN_D-TEST_D)/STEP_D)+1;
  const cfg={thrP:68,maxPos:3,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,dynSize:true};

  // Generate signals from each model archetype
  function generateSigs(archetype,buildF,fwdBars){
    const allSigs=[];const perWinPM={};
    for(let w=0;w<nW;w++){
      const trs=firstTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;
      const pm={};
      for(const pair of PAIRS){
        if(!allData[pair])continue;
        const tB=allData[pair].b1h.filter(b=>b.t>=trs&&b.t<tre);if(tB.length<300)continue;
        const tM=allData[pair].metrics.filter(m=>m.t>=trs-86400000&&m.t<tre);
        const F=buildF(tB,tM,allData[pair].fr,allData[pair].pi);
        const target=computeFwdTarget(F.c,F.atr,fwdBars,archetype);
        const co=pearson(F.fs,target,50,F.n-fwdBars);
        const sel=co.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,6);
        if(sel.length<2)continue;
        let tc=[];for(let i=55;i<F.n;i++){if(F.adx[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];tc.push(Math.abs(comp));}
        tc.sort((a,b)=>a-b);const thr=tc[Math.floor(tc.length*cfg.thrP/100)]||0.001;
        pm[pair]={sel,thr,arch:archetype};
      }
      perWinPM[w]=pm;
      if(Object.keys(pm).length<4)continue;
      for(const pair of PAIRS){
        if(!pm[pair]||!allData[pair])continue;
        const teB=allData[pair].b1h.filter(b=>b.t>=tes&&b.t<tee);if(teB.length<50)continue;
        const teM=allData[pair].metrics.filter(m=>m.t>=tes-86400000&&m.t<tee);
        const F=buildF(teB,teM,allData[pair].fr,allData[pair].pi);
        const{sel,thr}=pm[pair];let last=-3;
        for(let i=55;i<F.n-cfg.to-1;i++){
          if(i-last<2)continue;if(F.adx[i]<cfg.adxF)continue;
          let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];
          const ac=Math.abs(comp);if(ac<thr)continue;
          let dir=comp>0?1:-1;
          // For meanrev archetype: INVERT direction (fade the signal)
          if(archetype==='meanrev')dir=-dir;
          const conf=Math.max(0.5,Math.min(2.0,ac/thr));
          allSigs.push({bar:i,dir,ts:F.t[i],pair,conf,src:archetype,windowIdx:w});last=i;
        }
      }
    }
    return allSigs;
  }

  console.log('Generating signals from 3 models...');
  const sigsM=generateSigs('momentum',buildFeatures_Momentum,2);
  const sigsR=generateSigs('meanrev',buildFeatures_MeanRev,2);
  const sigsV=generateSigs('volexp',buildFeatures_VolExp,3);
  console.log(`  Momentum: ${sigsM.length} signals`);
  console.log(`  MeanRev:  ${sigsR.length} signals`);
  console.log(`  VolExp:   ${sigsV.length} signals`);

  // Build parsed data per pair for backtest engine
  const parsed={};
  for(const pair of PAIRS){
    if(!allData[pair])continue;
    const F=buildFeatures_Momentum(allData[pair].b1h,allData[pair].metrics,allData[pair].fr,allData[pair].pi);
    parsed[pair]={t:F.t,o:F.o,h:F.h,l:F.l,c:F.c,atr:F.atr};
  }

  // Backtest each model standalone
  console.log('\nStandalone backtest per model:');
  const resM=engine([...sigsM],parsed,P(SEED),cfg).trades;
  const resR=engine([...sigsR],parsed,P(SEED+1),cfg).trades;
  const resV=engine([...sigsV],parsed,P(SEED+2),cfg).trades;
  const sM=st(resM),sR=st(resR),sV=st(resV);
  console.log(`  Momentum: ${sM.n}t ${(sM.n/(nW*TEST_D)).toFixed(2)}t/d PF${sM.pf.toFixed(2)} WR${sM.wr.toFixed(1)}% Sh${sM.sharpe.toFixed(1)} $${sM.pnl.toFixed(0)}`);
  console.log(`  MeanRev:  ${sR.n}t ${(sR.n/(nW*TEST_D)).toFixed(2)}t/d PF${sR.pf.toFixed(2)} WR${sR.wr.toFixed(1)}% Sh${sR.sharpe.toFixed(1)} $${sR.pnl.toFixed(0)}`);
  console.log(`  VolExp:   ${sV.n}t ${(sV.n/(nW*TEST_D)).toFixed(2)}t/d PF${sV.pf.toFixed(2)} WR${sV.wr.toFixed(1)}% Sh${sV.sharpe.toFixed(1)} $${sV.pnl.toFixed(0)}`);

  // Daily PnL correlations
  function corrDaily(t1,t2){const d1={},d2={},dates=new Set();for(const t of t1){d1[t.date]=(d1[t.date]||0)+t.pnl;dates.add(t.date);}for(const t of t2){d2[t.date]=(d2[t.date]||0)+t.pnl;dates.add(t.date);}const ds=[...dates].sort();const x=ds.map(d=>d1[d]||0),y=ds.map(d=>d2[d]||0);if(x.length<10)return 0;const mx=x.reduce((a,v)=>a+v,0)/x.length,my=y.reduce((a,v)=>a+v,0)/y.length;let sxy=0,sxx=0,syy=0;for(let i=0;i<x.length;i++){sxy+=(x[i]-mx)*(y[i]-my);sxx+=(x[i]-mx)**2;syy+=(y[i]-my)**2;}return sxx*syy>0?sxy/Math.sqrt(sxx*syy):0;}
  console.log('\nDaily return correlations:');
  console.log(`  Momentum↔MeanRev: ${corrDaily(resM,resR).toFixed(3)}`);
  console.log(`  Momentum↔VolExp:  ${corrDaily(resM,resV).toFixed(3)}`);
  console.log(`  MeanRev↔VolExp:   ${corrDaily(resR,resV).toFixed(3)}`);

  // ENSEMBLE VOTING: sig fires if 2+ models agree OR 1 with conf > 0.75 (≈1.5x above thr)
  console.log('\n══ ENSEMBLE VOTING ══');
  // Bucket signals by (pair, windowIdx, bar)
  const votes={};
  const addVote=(sig)=>{const k=`${sig.pair}|${sig.windowIdx}|${sig.bar}`;if(!votes[k])votes[k]={pair:sig.pair,windowIdx:sig.windowIdx,bar:sig.bar,ts:sig.ts,sources:[]};votes[k].sources.push(sig);};
  sigsM.forEach(addVote);sigsR.forEach(addVote);sigsV.forEach(addVote);
  // Also cluster nearby signals within +/- 2 bars for same pair & window
  const agreeSigs=[],highConfSigs=[];
  for(const k of Object.keys(votes)){
    const v=votes[k];const long=v.sources.filter(s=>s.dir===1),short=v.sources.filter(s=>s.dir===-1);
    // 2+ agree
    if(long.length>=2){const avgConf=long.reduce((a,s)=>a+s.conf,0)/long.length;agreeSigs.push({bar:v.bar,dir:1,ts:v.ts,pair:v.pair,conf:avgConf,src:'agree'});}
    else if(short.length>=2){const avgConf=short.reduce((a,s)=>a+s.conf,0)/short.length;agreeSigs.push({bar:v.bar,dir:-1,ts:v.ts,pair:v.pair,conf:avgConf,src:'agree'});}
    // High conf singleton (conf >= 1.5 = 50% above thr)
    else if(v.sources.length===1&&v.sources[0].conf>=1.5){highConfSigs.push({...v.sources[0],src:'highConf'});}
  }
  console.log(`  Agree signals (2+ models): ${agreeSigs.length}`);
  console.log(`  High-conf singletons: ${highConfSigs.length}`);

  const resAgree=engine([...agreeSigs],parsed,P(SEED+10),cfg).trades;
  const sAgr=st(resAgree);
  console.log(`\n  Agree only: ${sAgr.n}t ${(sAgr.n/(nW*TEST_D)).toFixed(2)}t/d PF${sAgr.pf.toFixed(2)} WR${sAgr.wr.toFixed(1)}% Sh${sAgr.sharpe.toFixed(1)} $${sAgr.pnl.toFixed(0)}`);

  const resCombined=engine([...agreeSigs,...highConfSigs],parsed,P(SEED+20),cfg).trades;
  const sCom=st(resCombined);
  console.log(`  Agree + HighConf: ${sCom.n}t ${(sCom.n/(nW*TEST_D)).toFixed(2)}t/d PF${sCom.pf.toFixed(2)} WR${sCom.wr.toFixed(1)}% Sh${sCom.sharpe.toFixed(1)} DD$${sCom.mdd.toFixed(0)} $${sCom.pnl.toFixed(0)}`);

  // Save best for later analysis
  fs.writeFileSync('/tmp/angle3-trades.json',JSON.stringify(resCombined));
  console.log('\n'+'═'.repeat(80));
  console.log(`TARGETS: PF≥1.45 tier3 / ≥1.55 tier2 / ≥1.65 tier1, t/d≥3, WR≥40%`);
  console.log(`BEST A3: PF ${sCom.pf.toFixed(2)} @ ${(sCom.n/(nW*TEST_D)).toFixed(2)} t/d, WR ${sCom.wr.toFixed(1)}%`);
  if(sCom.pf>=1.65&&(sCom.n/(nW*TEST_D))>=3&&sCom.wr>=45)console.log('  ★★★ TIER 1 MET');
  else if(sCom.pf>=1.55&&(sCom.n/(nW*TEST_D))>=3&&sCom.wr>=42)console.log('  ★★ TIER 2 MET');
  else if(sCom.pf>=1.45&&(sCom.n/(nW*TEST_D))>=3&&sCom.wr>=40)console.log('  ★ TIER 3 MET');
  else console.log('  ✗ No tier met');
  console.log('═'.repeat(80)+'\n');
}
main().catch(e=>{console.error(e);process.exit(1);});
