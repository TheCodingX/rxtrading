#!/usr/bin/env node
'use strict';
// APEX V37 — 3 EXPERIMENTS
// 1. ENSEMBLE: V16 + V34 paralelo, independent capital, measure correlation
// 2. DYNAMIC SIZING: V34 scales POS_SIZE by signal confidence (0.5x - 2x)
// 3. REGIME FILTER: V34 with per-regime thresholds (bull/bear/chop)
//
// Same data period: 2025-07-01 → 2026-03-31 (274d), 16 pairs, walk-forward 5 windows
const fs=require('fs');
const path=require('path');
const https=require('https');

const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT'];
const KLINES_DIR='/tmp/binance-klines-1m';
const METRICS_DIR='/tmp/binance-metrics';
const INIT_CAP=500,POS_SIZE_BASE=2500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002,SEED=314159265;
const CLUSTERS={BTCUSDT:'L1',ETHUSDT:'L1',BNBUSDT:'L1',SOLUSDT:'L1alt',AVAXUSDT:'L1alt',NEARUSDT:'L1alt',APTUSDT:'L1alt',LTCUSDT:'POW',TRXUSDT:'L1other',XRPUSDT:'alt',ADAUSDT:'alt',DOTUSDT:'alt',ATOMUSDT:'alt',LINKUSDT:'defi',UNIUSDT:'defi',DOGEUSDT:'meme'};

function P(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function hg(u){return new Promise((r,j)=>{https.get(u,s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}

function load1m(pair){
  const dir=path.join(KLINES_DIR,pair);if(!fs.existsSync(dir))return null;
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.csv')).sort();const bars=[];
  for(const f of files){const content=fs.readFileSync(path.join(dir,f),'utf8');const lines=content.split('\n');const start=lines[0].startsWith('open_time')?1:0;for(let i=start;i<lines.length;i++){const l=lines[i].trim();if(!l)continue;const p=l.split(',');if(p.length<11)continue;bars.push([+p[0],+p[1],+p[2],+p[3],+p[4],+p[5],+p[6],+p[7],+p[8],+p[9],+p[10]]);}}
  bars.sort((a,b)=>a[0]-b[0]);return bars;
}

function aggTo1h(bars1m){
  const out=[];let start=0;while(start<bars1m.length&&(bars1m[start][0]%3600000)!==0)start++;
  for(let i=start;i<bars1m.length;i+=60){
    const grp=bars1m.slice(i,i+60);if(grp.length<60)break;
    let high=-Infinity,low=Infinity,volume=0,qvolume=0,count=0,takerBuy=0;
    let imbalances=[],maxAvgTrade=0,minuteImbSum=0;
    for(const b of grp){if(b[2]>high)high=b[2];if(b[3]<low)low=b[3];volume+=b[5];qvolume+=b[7];count+=b[8];takerBuy+=b[9];const imb=b[5]>0?(2*b[9]-b[5])/b[5]:0;imbalances.push(imb);minuteImbSum+=imb;const avgSize=b[8]>0?b[7]/b[8]:0;if(avgSize>maxAvgTrade)maxAvgTrade=avgSize;}
    const open=grp[0][1],close=grp[grp.length-1][4];const takerSell=volume-takerBuy;
    const takerImb=volume>0?(takerBuy-takerSell)/volume:0;const apm=count/60;const meanImb=minuteImbSum/60;
    const varImb=imbalances.reduce((a,x)=>a+(x-meanImb)**2,0)/60;
    const dirConsist=imbalances.filter(x=>Math.sign(x)===Math.sign(takerImb)).length/60;
    out.push({t:grp[0][0],ct:grp[grp.length-1][6],o:open,h:high,l:low,c:close,v:volume,qv:qvolume,cnt:count,tbv:takerBuy,tsv:takerSell,ti:takerImb,apm,lts:maxAvgTrade,vi:varImb,mi:meanImb,dc:dirConsist});
  }
  return out;
}

function loadMetrics(pair){
  const dir=path.join(METRICS_DIR,pair);if(!fs.existsSync(dir))return[];
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.csv')&&f.startsWith(`${pair}-metrics-`));const out=[];
  for(const f of files){let content;try{content=fs.readFileSync(path.join(dir,f),'utf8');}catch(e){continue;}const lines=content.split('\n');for(let i=1;i<lines.length;i++){const l=lines[i].trim();if(!l)continue;const p=l.split(',');if(p.length<8)continue;const ts=new Date(p[0].replace(' ','T')+'Z').getTime();out.push({t:ts,oi:parseFloat(p[2])||0,oiv:parseFloat(p[3])||0,topAcct:parseFloat(p[4])||1,topPos:parseFloat(p[5])||1,lsAcct:parseFloat(p[6])||1,taker:parseFloat(p[7])||1});}}
  out.sort((a,b)=>a.t-b.t);return out;
}

async function gF(s,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1000`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1].fundingTime)+1;await new Promise(r=>setTimeout(r,250));}return a;}
async function gPI(s,iv,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/premiumIndexKlines?symbol=${s}&interval=${iv}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1500`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1][6])+1;await new Promise(r=>setTimeout(r,200));}return a;}

const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const rs=(c,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;};
const bb=(c,p=20,m2=2)=>{const mid=sm(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};};
const mcd=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};};
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

// V16 features set (baseline)
function buildV16Features(bars1h,metrics,fr,piKl){
  const n=bars1h.length;
  const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);
  for(let i=0;i<n;i++){const b=bars1h[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;}
  const atr2=at(h,l,c),adx2=ax(h,l,c),mc=mcd(c),e9=em(c,9),e21=em(c,21),e50=em(c,50),r14=rs(c,14),r7=rs(c,7),bbd=bb(c,20,2);const vsma=sm(v,20);
  const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));
  function gfr(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}
  const piT=piKl.map(k=>+k[0]),piC=piKl.map(k=>+k[4]);
  function gB(bt){let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?piC[b]:0;}
  function gBz(bt){let lo2=0,hi2=piT.length-1,b=-1;while(lo2<=hi2){const m=(lo2+hi2)>>1;if(piT[m]<=bt){b=m;lo2=m+1;}else hi2=m-1;}if(b<50)return 0;const w=piC.slice(b-49,b+1),mn=w.reduce((a,x)=>a+x,0)/w.length,sd=Math.sqrt(w.reduce((a,x)=>a+(x-mn)**2,0)/w.length);return sd>0?(piC[b]-mn)/sd:0;}
  const fs2=[],nm=[];const F=(name,fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);nm.push(name);};
  // V16 feature set (NO orderflow, NO institutional metrics)
  F('RSI14',i=>(50-r14[i])/50);F('RSI7',i=>(50-r7[i])/50);
  F('MACDh',i=>mc.hist[i]/(atr2[i]||1));F('MACDs',i=>i>0?(mc.hist[i]-mc.hist[i-1])/(atr2[i]||1):0);
  F('BBpos',i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);
  F('BBw',i=>!isNaN(bbd.up[i])&&bbd.mid[i]?(bbd.up[i]-bbd.dn[i])/bbd.mid[i]:0);
  F('ADXv',i=>(adx2.adx[i]-25)/25);F('E9_21',i=>(e9[i]-e21[i])/(atr2[i]||1));F('E21_50',i=>(e21[i]-e50[i])/(atr2[i]||1));
  F('Ret1',i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F('Ret3',i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F('Ret6',i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F('Ret12',i=>i>=12?(c[i]-c[i-12])/c[i-12]*100:0);
  F('VolR',i=>vsma[i]>0?v[i]/vsma[i]-1:0);F('ClsP',i=>h[i]!==l[i]?(c[i]-l[i])/(h[i]-l[i])-0.5:0);
  F('FR',i=>-gfr(t[i])*1000);F('HrSin',i=>Math.sin(new Date(t[i]).getUTCHours()/24*2*Math.PI));
  F('Basis',i=>-gB(t[i])*10000);F('BasisZ',i=>-gBz(t[i]));F('BasisVsFR',i=>(-gB(t[i])*10000)+(-gfr(t[i])*1000));
  return{fs:fs2,nm,n,adx:adx2.adx,atr:atr2,t,o,h,l,c,v};
}

// V34 features set (V16 + orderflow + institutional)
function buildV34Features(bars1h,metrics,fr,piKl){
  const n=bars1h.length;
  const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);
  const ti=new Float64Array(n),apm=new Float64Array(n),lts=new Float64Array(n),vi=new Float64Array(n),mi=new Float64Array(n),dc=new Float64Array(n),tbv=new Float64Array(n),tsv=new Float64Array(n);
  for(let i=0;i<n;i++){const b=bars1h[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;ti[i]=b.ti;apm[i]=b.apm;lts[i]=b.lts;vi[i]=b.vi;mi[i]=b.mi;dc[i]=b.dc;tbv[i]=b.tbv;tsv[i]=b.tsv;}
  const atr2=at(h,l,c),adx2=ax(h,l,c),mc=mcd(c),e9=em(c,9),e21=em(c,21),e50=em(c,50),r14=rs(c,14),r7=rs(c,7),bbd=bb(c,20,2);
  const vsma=sm(v,20),apmSma=sm(apm,20),ltsSma=sm(lts,50);
  const ofi4h=new Float64Array(n);for(let i=0;i<n;i++){let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=tbv[j]-tsv[j];ofi4h[i]=s;}
  const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));
  function gfr(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}
  const piT=piKl.map(k=>+k[0]),piC=piKl.map(k=>+k[4]);
  function gB(bt){let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?piC[b]:0;}
  function gBz(bt){let lo2=0,hi2=piT.length-1,b=-1;while(lo2<=hi2){const m=(lo2+hi2)>>1;if(piT[m]<=bt){b=m;lo2=m+1;}else hi2=m-1;}if(b<50)return 0;const w=piC.slice(b-49,b+1),mn=w.reduce((a,x)=>a+x,0)/w.length,sd=Math.sqrt(w.reduce((a,x)=>a+(x-mn)**2,0)/w.length);return sd>0?(piC[b]-mn)/sd:0;}
  const mT=metrics.map(x=>x.t);
  function gM(bt,lookbackMinutes){let lo=0,hi=mT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(mT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}if(b<0)return null;const lb=Math.floor(lookbackMinutes/5);return{cur:metrics[b],prev:(b-lb>=0?metrics[b-lb]:null)};}
  const fs2=[],nm=[];const F=(name,fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);nm.push(name);};
  // V16 baseline
  F('RSI14',i=>(50-r14[i])/50);F('RSI7',i=>(50-r7[i])/50);
  F('MACDh',i=>mc.hist[i]/(atr2[i]||1));F('MACDs',i=>i>0?(mc.hist[i]-mc.hist[i-1])/(atr2[i]||1):0);
  F('BBpos',i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);
  F('BBw',i=>!isNaN(bbd.up[i])&&bbd.mid[i]?(bbd.up[i]-bbd.dn[i])/bbd.mid[i]:0);
  F('ADXv',i=>(adx2.adx[i]-25)/25);F('E9_21',i=>(e9[i]-e21[i])/(atr2[i]||1));F('E21_50',i=>(e21[i]-e50[i])/(atr2[i]||1));
  F('Ret1',i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F('Ret3',i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F('Ret6',i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F('Ret12',i=>i>=12?(c[i]-c[i-12])/c[i-12]*100:0);
  F('VolR',i=>vsma[i]>0?v[i]/vsma[i]-1:0);F('ClsP',i=>h[i]!==l[i]?(c[i]-l[i])/(h[i]-l[i])-0.5:0);
  F('FR',i=>-gfr(t[i])*1000);F('HrSin',i=>Math.sin(new Date(t[i]).getUTCHours()/24*2*Math.PI));
  F('Basis',i=>-gB(t[i])*10000);F('BasisZ',i=>-gBz(t[i]));F('BasisVsFR',i=>(-gB(t[i])*10000)+(-gfr(t[i])*1000));
  // Orderflow
  F('TakerImb',i=>ti[i]);
  F('TakerImb4',i=>{let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=ti[j];return s/4;});
  F('OFI4h',i=>ofi4h[i]/(vsma[i]*4||1));
  F('TradeInt',i=>apmSma[i]>0?apm[i]/apmSma[i]-1:0);
  F('TakeTox',i=>vi[i]);F('DirCons',i=>dc[i]-0.5);
  // Institutional
  F('OIchg1h',i=>{const m=gM(t[i],60);if(!m||!m.prev||m.prev.oi===0)return 0;return(m.cur.oi-m.prev.oi)/m.prev.oi*100;});
  F('OIchg4h',i=>{const m=gM(t[i],240);if(!m||!m.prev||m.prev.oi===0)return 0;return(m.cur.oi-m.prev.oi)/m.prev.oi*100;});
  F('TopPosLSR',i=>{const m=gM(t[i],0);if(!m||m.cur.topPos<=0)return 0;return(1/m.cur.topPos-1);});
  F('LSAcct',i=>{const m=gM(t[i],0);if(!m||m.cur.lsAcct<=0)return 0;return(1/m.cur.lsAcct-1);});
  F('MetaTaker',i=>{const m=gM(t[i],0);if(!m||m.cur.taker<=0)return 0;return Math.log(m.cur.taker);});
  return{fs:fs2,nm,n,adx:adx2.adx,atr:atr2,t,o,h,l,c,v};
}

function pearson(fs,fwd,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],y=fwd[i];if(isNaN(x)||isNaN(y))continue;sx+=x;sy+=y;sxy+=x*y;sx2+=x*x;sy2+=y*y;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}

// Regime detector: 3-state HMM proxy via volatility + ADX
// bull-trend: ADX>25, positive Ret6
// bear-trend: ADX>25, negative Ret6
// chop: ADX<25
function detectRegime(c,adx,atr,i){
  if(i<20)return 'chop';
  const ret6=(c[i]-c[i-6])/c[i-6];
  const vol=atr[i]/c[i];
  if(adx[i]<22)return 'chop';
  return ret6>0?'bull':'bear';
}

function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,sharpe:0,mdd:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));const byDay={};for(const x of t){const d=x.date;if(!byDay[d])byDay[d]=0;byDay[d]+=x.pnl;}const dailyR=Object.values(byDay);const meanD=dailyR.reduce((a,x)=>a+x,0)/dailyR.length;const varD=dailyR.reduce((a,x)=>a+(x-meanD)**2,0)/dailyR.length;const sharpe=varD>0?meanD/Math.sqrt(varD)*Math.sqrt(365):0;let cum=0,pk=0,mdd=0;for(const x of t){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,sharpe,mdd};}

// Engine: flexible sizing, cluster constraint
function engine(sigs,parsed,prng,cfg){
  let cap=INIT_CAP,pk=INIT_CAP,mdd=0;const trades=[];
  const slots=new Array(cfg.maxPos).fill(null);
  function cls(si,j,reason){const pos=slots[si];const pd=parsed[pos.pair];let ep2;if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(reason==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;const f=pos.sz*FEE_E+pos.sz*(reason==='TP'?FEE_TP:FEE_SL);cap+=g-f;pk=Math.max(pk,cap);const dd=pk>0?(pk-cap)/pk:0;if(dd>mdd)mdd=dd;trades.push({dir:pos.dir,pnl:g-f,type:reason,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10),sz:pos.sz,engine:pos.engine||''});slots[si]=null;}
  function advance(upToTs){for(let si=0;si<cfg.maxPos;si++){const pos=slots[si];if(!pos)continue;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upToTs;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){cls(si,j,'SL');break;}if(hT){cls(si,j,'TP');break;}pos.nc=j+1;}if(slots[si]&&slots[si].nc>slots[si].exp){cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}}
  sigs.sort((a,b)=>a.ts-b.ts);
  for(const sig of sigs){if(cap<=0)break;const d=parsed[sig.pair];const eb=sig.bar+1;if(eb>=d.c.length)continue;advance(d.t[eb]);let freeSlot=-1;const clusterCounts={};for(let si=0;si<cfg.maxPos;si++)if(slots[si])clusterCounts[CLUSTERS[slots[si].pair]]=(clusterCounts[CLUSTERS[slots[si].pair]]||0)+1;for(let si=0;si<cfg.maxPos;si++){if(slots[si])continue;let pairConflict=false;for(let sj=0;sj<cfg.maxPos;sj++)if(slots[sj]&&slots[sj].pair===sig.pair){pairConflict=true;break;}if(pairConflict)continue;const cl=CLUSTERS[sig.pair]||'other';if((clusterCounts[cl]||0)>=cfg.maxCluster)continue;freeSlot=si;break;}if(freeSlot===-1)continue;if(prng()>=0.75)continue;if(cap<50)continue;const ep=d.o[eb],atrA=d.atr[sig.bar],ap=atrA/d.c[sig.bar];if(ap<=0||isNaN(ap))continue;let sl=Math.max(0.003,Math.min(0.03,ap*cfg.slM)),tp=Math.max(0.005,Math.min(0.08,sl*cfg.tpR));
    // Dynamic sizing: scale by signal confidence (0.5x to 2x base)
    const sizeMult=cfg.dynSize?Math.max(0.5,Math.min(2.0,sig.conf)):1.0;
    const sz=POS_SIZE_BASE*sizeMult;
    slots[freeSlot]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-sl):ep*(1+sl),tpP:sig.dir===1?ep*(1+tp):ep*(1-tp),qty:sz/ep,eb,exp:eb+cfg.to,nc:eb+1,sz,engine:sig.engine};}
  advance(Infinity);for(let si=0;si<cfg.maxPos;si++){if(slots[si]){const pd=parsed[slots[si].pair];cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}
  return{trades,cap,mdd};
}

// Generate signals for one engine type (V16 or V34 features) over all pairs & windows
function runEngine(engineName,buildFeaturesFn,allData,cfg,firstTs,nW,TRAIN_D,TEST_D,STEP_D){
  const allTrades=[];
  for(let w=0;w<nW;w++){
    const trs=firstTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;
    const pm={};
    for(const pair of PAIRS){
      if(!allData[pair])continue;
      const trBars=allData[pair].bars1h.filter(b=>b.t>=trs&&b.t<tre);if(trBars.length<300)continue;
      const trMetrics=allData[pair].metrics.filter(m=>m.t>=trs-86400000&&m.t<tre);
      const F=buildFeaturesFn(trBars,trMetrics,allData[pair].fr,allData[pair].pi);
      const fwd=new Float64Array(F.n).fill(NaN);for(let i=50;i<F.n-cfg.fwd;i++)fwd[i]=(F.c[i+cfg.fwd]-F.c[i])/F.c[i]*100;
      const co=pearson(F.fs,fwd,50,F.n-cfg.fwd);
      const sel=co.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,8);
      if(sel.length<2)continue;
      // Regime-conditional thresholds: compute thr per regime if enabled
      let thrBull=null,thrBear=null,thrChop=null,thrGlobal;
      if(cfg.regime){
        const tcBull=[],tcBear=[],tcChop=[];
        for(let i=55;i<F.n;i++){if(F.adx[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];const r=detectRegime(F.c,F.adx,F.atr,i);if(r==='bull')tcBull.push(Math.abs(comp));else if(r==='bear')tcBear.push(Math.abs(comp));else tcChop.push(Math.abs(comp));}
        tcBull.sort((a,b)=>a-b);tcBear.sort((a,b)=>a-b);tcChop.sort((a,b)=>a-b);
        thrBull=tcBull[Math.floor(tcBull.length*cfg.thrP/100)]||0.001;
        thrBear=tcBear[Math.floor(tcBear.length*cfg.thrP/100)]||0.001;
        thrChop=tcChop[Math.floor(tcChop.length*(cfg.thrChop||cfg.thrP)/100)]||0.001;
      }
      let tc=[];for(let i=55;i<F.n;i++){if(F.adx[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];tc.push(Math.abs(comp));}
      tc.sort((a,b)=>a-b);thrGlobal=tc[Math.floor(tc.length*cfg.thrP/100)]||0.001;
      // Max composite for confidence normalization
      const maxComp=tc[tc.length-1]||1;
      pm[pair]={sel,thr:thrGlobal,thrBull,thrBear,thrChop,maxComp};
    }
    if(Object.keys(pm).length<4)continue;
    const sigs=[],tPar={};
    for(const pair of PAIRS){
      if(!pm[pair]||!allData[pair])continue;
      const teBars=allData[pair].bars1h.filter(b=>b.t>=tes&&b.t<tee);if(teBars.length<50)continue;
      const teMetrics=allData[pair].metrics.filter(m=>m.t>=tes-86400000&&m.t<tee);
      const F=buildFeaturesFn(teBars,teMetrics,allData[pair].fr,allData[pair].pi);
      tPar[pair]={t:F.t,o:F.o,h:F.h,l:F.l,c:F.c,atr:F.atr};
      const{sel,thr,thrBull,thrBear,thrChop,maxComp}=pm[pair];let last=-3;
      for(let i=55;i<F.n-cfg.to-1;i++){
        if(i-last<2)continue;if(F.adx[i]<cfg.adxF)continue;
        let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];
        const absComp=Math.abs(comp);
        let effThr=thr;
        if(cfg.regime){const r=detectRegime(F.c,F.adx,F.atr,i);if(r==='bull')effThr=thrBull;else if(r==='bear')effThr=thrBear;else effThr=thrChop;}
        if(absComp<effThr)continue;
        const dir=comp>0?1:-1;
        // Confidence: normalized |comp| in [0.5, 2.0] range
        const conf=Math.max(0.5,Math.min(2.0,absComp/effThr));
        sigs.push({bar:i,dir,ts:F.t[i],pair,conf,engine:engineName});last=i;
      }
    }
    allTrades.push(...engine(sigs,tPar,P(SEED+w),cfg).trades);
  }
  return allTrades;
}

// Correlation of daily PnL between two trade sets
function corrDaily(t1,t2){
  const d1={},d2={},allDates=new Set();
  for(const t of t1){d1[t.date]=(d1[t.date]||0)+t.pnl;allDates.add(t.date);}
  for(const t of t2){d2[t.date]=(d2[t.date]||0)+t.pnl;allDates.add(t.date);}
  const dates=[...allDates].sort();
  const x=dates.map(d=>d1[d]||0),y=dates.map(d=>d2[d]||0);
  if(x.length<10)return 0;
  const mx=x.reduce((a,v)=>a+v,0)/x.length,my=y.reduce((a,v)=>a+v,0)/y.length;
  let sxy=0,sxx=0,syy=0;for(let i=0;i<x.length;i++){sxy+=(x[i]-mx)*(y[i]-my);sxx+=(x[i]-mx)**2;syy+=(y[i]-my)**2;}
  return(sxx*syy>0)?sxy/Math.sqrt(sxx*syy):0;
}

async function main(){
  console.log('═'.repeat(80));console.log('APEX V37 — ENSEMBLE + DYNAMIC SIZING + REGIME FILTER');console.log('═'.repeat(80));
  const allData={};
  console.log('\nLoading data (1m → 1H, metrics, funding, basis)...');
  for(const pair of PAIRS){
    process.stdout.write(pair+' ');
    const bars1m=load1m(pair);if(!bars1m||bars1m.length<10000){console.log('[SKIP]');continue;}
    const bars1h=aggTo1h(bars1m);const metrics=loadMetrics(pair);
    const firstTs=bars1h[0].t,lastTs=bars1h[bars1h.length-1].t;
    const fr=await gF(pair,firstTs,lastTs);const pi=await gPI(pair,'1h',firstTs,lastTs);
    allData[pair]={bars1h,metrics,fr,pi};
  }
  console.log('\n');
  const firstTs=Math.min(...Object.values(allData).map(d=>d.bars1h[0].t));
  const lastTs=Math.max(...Object.values(allData).map(d=>d.bars1h[d.bars1h.length-1].t));
  const totalDays=(lastTs-firstTs)/86400000;
  console.log(`Range: ${new Date(firstTs).toISOString().slice(0,10)} → ${new Date(lastTs).toISOString().slice(0,10)} (${totalDays.toFixed(0)}d)\n`);
  const TRAIN_D=120,TEST_D=30,STEP_D=30;
  const nW=Math.floor((totalDays-TRAIN_D-TEST_D)/STEP_D)+1;

  // CONFIG: shared engine params
  const cfgV16={name:'V16',thrP:68,maxPos:1,maxCluster:3,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,dynSize:false,regime:false};
  const cfgV34={name:'V34',thrP:68,maxPos:3,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,dynSize:false,regime:false};
  const cfgV34_dyn={name:'V34-dyn',thrP:68,maxPos:3,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,dynSize:true,regime:false};
  const cfgV34_regime={name:'V34-reg',thrP:68,thrChop:75,maxPos:3,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,dynSize:false,regime:true};
  const cfgV34_dyn_regime={name:'V34-dyn+reg',thrP:68,thrChop:75,maxPos:3,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,dynSize:true,regime:true};

  console.log('TEST 1: Running V16 engine alone...');
  const tradesV16=runEngine('V16',buildV16Features,allData,cfgV16,firstTs,nW,TRAIN_D,TEST_D,STEP_D);
  const sV16=st(tradesV16);
  console.log(`  V16 alone: ${sV16.n}t, ${(sV16.n/(nW*TEST_D)).toFixed(2)} t/d, PF ${sV16.pf.toFixed(2)}, WR ${sV16.wr.toFixed(1)}%, Sharpe ${sV16.sharpe.toFixed(1)}, DD $${sV16.mdd.toFixed(0)}, $${sV16.pnl.toFixed(0)}`);

  console.log('\nTEST 1b: Running V34 engine alone...');
  const tradesV34=runEngine('V34',buildV34Features,allData,cfgV34,firstTs,nW,TRAIN_D,TEST_D,STEP_D);
  const sV34=st(tradesV34);
  console.log(`  V34 alone: ${sV34.n}t, ${(sV34.n/(nW*TEST_D)).toFixed(2)} t/d, PF ${sV34.pf.toFixed(2)}, WR ${sV34.wr.toFixed(1)}%, Sharpe ${sV34.sharpe.toFixed(1)}, DD $${sV34.mdd.toFixed(0)}, $${sV34.pnl.toFixed(0)}`);

  console.log('\nTEST 1c: ENSEMBLE V16 + V34 (parallel independent capital)...');
  const corrDR=corrDaily(tradesV16,tradesV34);
  // Combined = simply concatenate trades. Assumes each engine has own $500 capital.
  const ensembleTrades=[...tradesV16,...tradesV34];
  const sEns=st(ensembleTrades);
  const overlapDays={};for(const t of tradesV16)overlapDays[t.date]=(overlapDays[t.date]||{v16:0,v34:0}),overlapDays[t.date].v16++;for(const t of tradesV34){if(!overlapDays[t.date])overlapDays[t.date]={v16:0,v34:0};overlapDays[t.date].v34++;}
  const sharedDays=Object.values(overlapDays).filter(x=>x.v16>0&&x.v34>0).length;
  console.log(`  Ensemble: ${sEns.n}t, ${(sEns.n/(nW*TEST_D)).toFixed(2)} t/d, PF ${sEns.pf.toFixed(2)}, WR ${sEns.wr.toFixed(1)}%, Sharpe ${sEns.sharpe.toFixed(1)}, DD $${sEns.mdd.toFixed(0)}, $${sEns.pnl.toFixed(0)}`);
  console.log(`  Daily return correlation V16↔V34: ${corrDR.toFixed(3)} (${corrDR<0.5?'GOOD - low corr':corrDR<0.8?'MEDIUM':'HIGH'})`);
  console.log(`  Days with trades from both: ${sharedDays}/${Object.keys(overlapDays).length}`);

  console.log('\nTEST 2: V34 with DYNAMIC SIZING (size scaled by confidence 0.5x-2x)...');
  const tradesDyn=runEngine('V34-dyn',buildV34Features,allData,cfgV34_dyn,firstTs,nW,TRAIN_D,TEST_D,STEP_D);
  const sDyn=st(tradesDyn);
  const avgSz=tradesDyn.reduce((a,t)=>a+t.sz,0)/(tradesDyn.length||1);
  console.log(`  V34-dyn: ${sDyn.n}t, ${(sDyn.n/(nW*TEST_D)).toFixed(2)} t/d, PF ${sDyn.pf.toFixed(2)}, WR ${sDyn.wr.toFixed(1)}%, Sharpe ${sDyn.sharpe.toFixed(1)}, DD $${sDyn.mdd.toFixed(0)}, $${sDyn.pnl.toFixed(0)}, avgSz $${avgSz.toFixed(0)}`);

  console.log('\nTEST 3: V34 with REGIME-CONDITIONAL thresholds...');
  const tradesReg=runEngine('V34-reg',buildV34Features,allData,cfgV34_regime,firstTs,nW,TRAIN_D,TEST_D,STEP_D);
  const sReg=st(tradesReg);
  console.log(`  V34-reg: ${sReg.n}t, ${(sReg.n/(nW*TEST_D)).toFixed(2)} t/d, PF ${sReg.pf.toFixed(2)}, WR ${sReg.wr.toFixed(1)}%, Sharpe ${sReg.sharpe.toFixed(1)}, DD $${sReg.mdd.toFixed(0)}, $${sReg.pnl.toFixed(0)}`);

  console.log('\nTEST 2+3 COMBO: V34 with DYNAMIC SIZING + REGIME...');
  const tradesDynReg=runEngine('V34-DR',buildV34Features,allData,cfgV34_dyn_regime,firstTs,nW,TRAIN_D,TEST_D,STEP_D);
  const sDR=st(tradesDynReg);
  console.log(`  V34-dyn+reg: ${sDR.n}t, ${(sDR.n/(nW*TEST_D)).toFixed(2)} t/d, PF ${sDR.pf.toFixed(2)}, WR ${sDR.wr.toFixed(1)}%, Sharpe ${sDR.sharpe.toFixed(1)}, DD $${sDR.mdd.toFixed(0)}, $${sDR.pnl.toFixed(0)}`);

  console.log('\nTEST 4: ULTIMATE ENSEMBLE V16 + V34-dyn+reg...');
  const ultimateTrades=[...tradesV16,...tradesDynReg];
  const sUlt=st(ultimateTrades);
  const corrUlt=corrDaily(tradesV16,tradesDynReg);
  console.log(`  Ultimate: ${sUlt.n}t, ${(sUlt.n/(nW*TEST_D)).toFixed(2)} t/d, PF ${sUlt.pf.toFixed(2)}, WR ${sUlt.wr.toFixed(1)}%, Sharpe ${sUlt.sharpe.toFixed(1)}, DD $${sUlt.mdd.toFixed(0)}, $${sUlt.pnl.toFixed(0)}`);
  console.log(`  Correlation V16↔V34-dyn+reg: ${corrUlt.toFixed(3)}`);

  console.log('\n'+'═'.repeat(80));console.log('FINAL SUMMARY — TARGETS: PF>=1.65, t/d>=3, WR high');console.log('═'.repeat(80));
  const all=[
    {name:'V16 alone',s:sV16,tpd:sV16.n/(nW*TEST_D)},
    {name:'V34 alone',s:sV34,tpd:sV34.n/(nW*TEST_D)},
    {name:'Ensemble V16+V34',s:sEns,tpd:sEns.n/(nW*TEST_D),corr:corrDR},
    {name:'V34 dyn-size',s:sDyn,tpd:sDyn.n/(nW*TEST_D)},
    {name:'V34 regime',s:sReg,tpd:sReg.n/(nW*TEST_D)},
    {name:'V34 dyn+reg',s:sDR,tpd:sDR.n/(nW*TEST_D)},
    {name:'V16 + V34-dyn+reg',s:sUlt,tpd:sUlt.n/(nW*TEST_D),corr:corrUlt}
  ];
  console.log('Engine'.padEnd(22)+'Trades  t/d   PF    WR%   Sharpe DD      PnL');
  for(const r of all){
    const marker=(r.s.pf>=1.65&&r.tpd>=3.0)?' ★★★':'';
    console.log(`${r.name.padEnd(22)}${r.s.n.toString().padStart(5)}t ${r.tpd.toFixed(2).padStart(4)} ${r.s.pf.toFixed(2).padStart(5)} ${r.s.wr.toFixed(1).padStart(5)} ${r.s.sharpe.toFixed(1).padStart(5)} $${r.s.mdd.toFixed(0).padStart(5)} $${r.s.pnl.toFixed(0).padStart(5)}${marker}`);
  }
  const winners=all.filter(r=>r.s.pf>=1.65&&r.tpd>=3.0);
  if(winners.length){console.log(`\n★★★ ${winners.length} ENGINES MEET TARGET PF>=1.65 @ t/d>=3:`);for(const r of winners)console.log(`  ${r.name}: PF ${r.s.pf.toFixed(2)} @ ${r.tpd.toFixed(2)} t/d, WR ${r.s.wr.toFixed(1)}%, Sharpe ${r.s.sharpe.toFixed(1)}`);}
  // Best by Sharpe among those with 3+ t/d
  const at3pd=all.filter(r=>r.tpd>=3.0);
  if(at3pd.length){console.log('\nBest configs @ 3+ t/d (sorted by PF):');at3pd.sort((a,b)=>b.s.pf-a.s.pf);for(const r of at3pd.slice(0,5))console.log(`  ${r.name}: PF ${r.s.pf.toFixed(2)} @ ${r.tpd.toFixed(2)} t/d, Sharpe ${r.s.sharpe.toFixed(1)}, $${r.s.pnl.toFixed(0)}`);}
  console.log('\n'+'═'.repeat(80)+'\n');
}
main().catch(e=>{console.error('FATAL:',e.message,e.stack);process.exit(1);});
