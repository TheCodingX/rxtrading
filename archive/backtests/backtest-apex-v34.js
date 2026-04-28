#!/usr/bin/env node
'use strict';
// APEX V34 — 1H TIMEFRAME (like V16) + ORDERFLOW from 1m + META-LABELING + MULTI-SLOT
// Hypothesis: V33's 15m failed because edge/noise ratio is unfavorable at that TF.
// V34: Keep V16's 1H framework (proven) but ADD orderflow features from 1m aggregation.
// This way we only ADD alpha, don't change the underlying TF that V16 proved works.
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

function load1m(pair){
  const dir=path.join(KLINES_DIR,pair);if(!fs.existsSync(dir))return null;
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.csv')).sort();
  const bars=[];
  for(const f of files){
    const content=fs.readFileSync(path.join(dir,f),'utf8');
    const lines=content.split('\n');const start=lines[0].startsWith('open_time')?1:0;
    for(let i=start;i<lines.length;i++){const l=lines[i].trim();if(!l)continue;const p=l.split(',');if(p.length<11)continue;bars.push([+p[0],+p[1],+p[2],+p[3],+p[4],+p[5],+p[6],+p[7],+p[8],+p[9],+p[10]]);}
  }
  bars.sort((a,b)=>a[0]-b[0]);return bars;
}

// Aggregate 1m → 1H (60 one-minute bars) with orderflow microstructure
function aggTo1h(bars1m){
  const out=[];
  // Find the first 1m bar that starts on an hour boundary
  let start=0;while(start<bars1m.length&&(bars1m[start][0]%3600000)!==0)start++;
  for(let i=start;i<bars1m.length;i+=60){
    const grp=bars1m.slice(i,i+60);if(grp.length<60)break;
    const openTs=grp[0][0],closeTs=grp[grp.length-1][6];
    let high=-Infinity,low=Infinity,volume=0,qvolume=0,count=0,takerBuy=0;
    let tradeCounts=[],imbalances=[],maxAvgTrade=0,minuteImbSum=0;
    for(const b of grp){
      if(b[2]>high)high=b[2];if(b[3]<low)low=b[3];
      volume+=b[5];qvolume+=b[7];count+=b[8];takerBuy+=b[9];
      tradeCounts.push(b[8]);const imb=b[5]>0?(2*b[9]-b[5])/b[5]:0;imbalances.push(imb);minuteImbSum+=imb;
      const avgSize=b[8]>0?b[7]/b[8]:0;if(avgSize>maxAvgTrade)maxAvgTrade=avgSize;
    }
    const open=grp[0][1],close=grp[grp.length-1][4];
    const takerSell=volume-takerBuy;
    const takerImb=volume>0?(takerBuy-takerSell)/volume:0;
    const avgCountPerMin=count/60;
    const meanImb=minuteImbSum/60;
    const varImb=imbalances.reduce((a,x)=>a+(x-meanImb)**2,0)/60;
    // Count how many 1m bars have same sign as hour's net direction
    const dirConsist=imbalances.filter(x=>Math.sign(x)===Math.sign(takerImb)).length/60;
    out.push({t:openTs,ct:closeTs,o:open,h:high,l:low,c:close,v:volume,qv:qvolume,cnt:count,tbv:takerBuy,tsv:takerSell,ti:takerImb,apm:avgCountPerMin,lts:maxAvgTrade,vi:varImb,mi:meanImb,dc:dirConsist});
  }
  return out;
}

function loadMetrics(pair){
  const dir=path.join(METRICS_DIR,pair);if(!fs.existsSync(dir))return[];
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.csv')&&f.startsWith(`${pair}-metrics-`));
  const out=[];
  for(const f of files){let content;try{content=fs.readFileSync(path.join(dir,f),'utf8');}catch(e){continue;}
    const lines=content.split('\n');for(let i=1;i<lines.length;i++){const l=lines[i].trim();if(!l)continue;const p=l.split(',');if(p.length<8)continue;const ts=new Date(p[0].replace(' ','T')+'Z').getTime();out.push({t:ts,oi:parseFloat(p[2])||0,oiv:parseFloat(p[3])||0,topAcct:parseFloat(p[4])||1,topPos:parseFloat(p[5])||1,lsAcct:parseFloat(p[6])||1,taker:parseFloat(p[7])||1});}}
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

// Build features for 1H bars: V16 baseline + orderflow + institutional = 34 features
function buildFeatures(bars1h,metrics,fr,piKl){
  const n=bars1h.length;
  const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);
  const ti=new Float64Array(n),apm=new Float64Array(n),lts=new Float64Array(n),vi=new Float64Array(n),mi=new Float64Array(n),dc=new Float64Array(n),tbv=new Float64Array(n),tsv=new Float64Array(n);
  for(let i=0;i<n;i++){const b=bars1h[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;ti[i]=b.ti;apm[i]=b.apm;lts[i]=b.lts;vi[i]=b.vi;mi[i]=b.mi;dc[i]=b.dc;tbv[i]=b.tbv;tsv[i]=b.tsv;}
  const atr2=at(h,l,c),adx2=ax(h,l,c),mc=mcd(c),e9=em(c,9),e21=em(c,21),e50=em(c,50),r14=rs(c,14),r7=rs(c,7),bbd=bb(c,20,2);
  const vsma=sm(v,20),apmSma=sm(apm,20),ltsSma=sm(lts,50);
  // OFI cumulative
  const ofi4h=new Float64Array(n),ofi1d=new Float64Array(n);
  for(let i=0;i<n;i++){let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=tbv[j]-tsv[j];ofi4h[i]=s;
    let s2=0;for(let j=Math.max(0,i-23);j<=i;j++)s2+=tbv[j]-tsv[j];ofi1d[i]=s2;}
  // Funding & premium index lookups
  const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));
  function gfr(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}
  const piT=piKl.map(k=>+k[0]),piC=piKl.map(k=>+k[4]);
  function gB(bt){let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?piC[b]:0;}
  function gBz(bt){let lo2=0,hi2=piT.length-1,b=-1;while(lo2<=hi2){const m=(lo2+hi2)>>1;if(piT[m]<=bt){b=m;lo2=m+1;}else hi2=m-1;}if(b<50)return 0;const w=piC.slice(b-49,b+1),mn=w.reduce((a,x)=>a+x,0)/w.length,sd=Math.sqrt(w.reduce((a,x)=>a+(x-mn)**2,0)/w.length);return sd>0?(piC[b]-mn)/sd:0;}
  // Metrics lookup
  const mT=metrics.map(x=>x.t);
  function gM(bt,lookbackMinutes){let lo=0,hi=mT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(mT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}if(b<0)return null;const lb=Math.floor(lookbackMinutes/5);return{cur:metrics[b],prev:(b-lb>=0?metrics[b-lb]:null)};}

  const fs2=[],nm=[];
  const F=(name,fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);nm.push(name);};
  // V16 baseline (17)
  F('RSI14',i=>(50-r14[i])/50);F('RSI7',i=>(50-r7[i])/50);
  F('MACDh',i=>mc.hist[i]/(atr2[i]||1));F('MACDs',i=>i>0?(mc.hist[i]-mc.hist[i-1])/(atr2[i]||1):0);
  F('BBpos',i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);
  F('BBw',i=>!isNaN(bbd.up[i])&&bbd.mid[i]?(bbd.up[i]-bbd.dn[i])/bbd.mid[i]:0);
  F('ADXv',i=>(adx2.adx[i]-25)/25);F('E9_21',i=>(e9[i]-e21[i])/(atr2[i]||1));F('E21_50',i=>(e21[i]-e50[i])/(atr2[i]||1));
  F('Ret1',i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F('Ret3',i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F('Ret6',i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F('Ret12',i=>i>=12?(c[i]-c[i-12])/c[i-12]*100:0);
  F('VolR',i=>vsma[i]>0?v[i]/vsma[i]-1:0);F('ClsP',i=>h[i]!==l[i]?(c[i]-l[i])/(h[i]-l[i])-0.5:0);
  F('FR',i=>-gfr(t[i])*1000);F('HrSin',i=>Math.sin(new Date(t[i]).getUTCHours()/24*2*Math.PI));
  F('Basis',i=>-gB(t[i])*10000);F('BasisZ',i=>-gBz(t[i]));F('BasisVsFR',i=>(-gB(t[i])*10000)+(-gfr(t[i])*1000));
  // ORDERFLOW from 1m aggregation (8) — NEW
  F('TakerImb',i=>ti[i]);
  F('TakerImb4',i=>{let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=ti[j];return s/4;});
  F('OFI4h',i=>ofi4h[i]/(vsma[i]*4||1));
  F('OFI1d',i=>ofi1d[i]/(vsma[i]*24||1));
  F('TradeInt',i=>apmSma[i]>0?apm[i]/apmSma[i]-1:0);
  F('LargeTr',i=>ltsSma[i]>0?lts[i]/ltsSma[i]-1:0);
  F('TakeTox',i=>vi[i]);
  F('DirCons',i=>dc[i]-0.5);
  // INSTITUTIONAL (6)
  F('OIchg1h',i=>{const m=gM(t[i],60);if(!m||!m.prev||m.prev.oi===0)return 0;return(m.cur.oi-m.prev.oi)/m.prev.oi*100;});
  F('OIchg4h',i=>{const m=gM(t[i],240);if(!m||!m.prev||m.prev.oi===0)return 0;return(m.cur.oi-m.prev.oi)/m.prev.oi*100;});
  F('TopPosLSR',i=>{const m=gM(t[i],0);if(!m||m.cur.topPos<=0)return 0;return(1/m.cur.topPos-1);});
  F('LSAcct',i=>{const m=gM(t[i],0);if(!m||m.cur.lsAcct<=0)return 0;return(1/m.cur.lsAcct-1);});
  F('MetaTaker',i=>{const m=gM(t[i],0);if(!m||m.cur.taker<=0)return 0;return Math.log(m.cur.taker);});
  F('TopPosSlp',i=>{const m=gM(t[i],60);if(!m||!m.prev)return 0;return-(m.cur.topPos-m.prev.topPos)*5;});
  return{fs:fs2,nm,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};
}

function pearson(fs,fwd,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],y=fwd[i];if(isNaN(x)||isNaN(y))continue;sx+=x;sy+=y;sxy+=x*y;sx2+=x*x;sy2+=y*y;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}

function tripleBarrier(ph,pl,pc,atr,startI,tpMult,slMult,horizon,dir){const ep=pc[startI];const tp=dir===1?ep+atr[startI]*tpMult:ep-atr[startI]*tpMult;const sl=dir===1?ep-atr[startI]*slMult:ep+atr[startI]*slMult;for(let j=startI+1;j<Math.min(pc.length,startI+horizon+1);j++){let hT,hS;if(dir===1){hT=ph[j]>=tp;hS=pl[j]<=sl;}else{hT=pl[j]<=tp;hS=ph[j]>=sl;}if(hT&&!hS)return 1;if(hS&&!hT)return -1;if(hT&&hS)return 0;}return 0;}

function logistic(X,y,iters=80,lr=0.1,reg=0.01){const nF=X[0].length,n=X.length;const w=new Float64Array(nF).fill(0);let b=0;for(let it=0;it<iters;it++){const grad=new Float64Array(nF).fill(0);let gb=0;for(let i=0;i<n;i++){let z=b;for(let j=0;j<nF;j++)z+=w[j]*X[i][j];const p=1/(1+Math.exp(-z));const err=p-y[i];gb+=err;for(let j=0;j<nF;j++)grad[j]+=err*X[i][j];}b-=lr*gb/n;for(let j=0;j<nF;j++)w[j]-=lr*(grad[j]/n+reg*w[j]);}return{w,b,predict:x=>{let z=b;for(let j=0;j<x.length;j++)z+=w[j]*x[j];return 1/(1+Math.exp(-z));}};}

function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,tp:0,sl:0,to:0,sharpe:0,mdd:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));const byDay={};for(const x of t){const d=x.date;if(!byDay[d])byDay[d]=0;byDay[d]+=x.pnl;}const dailyR=Object.values(byDay);const meanD=dailyR.reduce((a,x)=>a+x,0)/dailyR.length;const varD=dailyR.reduce((a,x)=>a+(x-meanD)**2,0)/dailyR.length;const sharpe=varD>0?meanD/Math.sqrt(varD)*Math.sqrt(365):0;let cum=0,pk=0,mdd=0;for(const x of t){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,tp:t.filter(x=>x.type==='TP').length,sl:t.filter(x=>x.type==='SL').length,to:t.filter(x=>x.type==='TO').length,sharpe,mdd};}

function engine(sigs,parsed,prng,cfg){
  let cap=INIT_CAP,pk=INIT_CAP,mdd=0;const trades=[];
  const slots=new Array(cfg.maxPos).fill(null);
  function cls(si,j,reason){const pos=slots[si];const pd=parsed[pos.pair];let ep2;if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(reason==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty,f=POS_SIZE*FEE_E+POS_SIZE*(reason==='TP'?FEE_TP:FEE_SL);cap+=g-f;pk=Math.max(pk,cap);const dd=pk>0?(pk-cap)/pk:0;if(dd>mdd)mdd=dd;trades.push({dir:pos.dir,pnl:g-f,type:reason,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10),confP:pos.confP||0});slots[si]=null;}
  function advance(upToTs){for(let si=0;si<cfg.maxPos;si++){const pos=slots[si];if(!pos)continue;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upToTs;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){cls(si,j,'SL');break;}if(hT){cls(si,j,'TP');break;}pos.nc=j+1;}if(slots[si]&&slots[si].nc>slots[si].exp){cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}}
  sigs.sort((a,b)=>a.ts-b.ts);
  for(const sig of sigs){if(cap<=0)break;const d=parsed[sig.pair];const eb=sig.bar+1;if(eb>=d.c.length)continue;advance(d.t[eb]);let freeSlot=-1;const clusterCounts={};for(let si=0;si<cfg.maxPos;si++)if(slots[si])clusterCounts[CLUSTERS[slots[si].pair]]=(clusterCounts[CLUSTERS[slots[si].pair]]||0)+1;for(let si=0;si<cfg.maxPos;si++){if(slots[si])continue;let pairConflict=false;for(let sj=0;sj<cfg.maxPos;sj++)if(slots[sj]&&slots[sj].pair===sig.pair){pairConflict=true;break;}if(pairConflict)continue;const cl=CLUSTERS[sig.pair]||'other';if((clusterCounts[cl]||0)>=cfg.maxCluster)continue;freeSlot=si;break;}if(freeSlot===-1)continue;if(prng()>=0.75)continue;if(cap<50)continue;const ep=d.o[eb],atrA=d.atr[sig.bar],ap=atrA/d.c[sig.bar];if(ap<=0||isNaN(ap))continue;let sl=Math.max(0.003,Math.min(0.03,ap*cfg.slM)),tp=Math.max(0.005,Math.min(0.08,sl*cfg.tpR));slots[freeSlot]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-sl):ep*(1+sl),tpP:sig.dir===1?ep*(1+tp):ep*(1-tp),qty:POS_SIZE/ep,eb,exp:eb+cfg.to,nc:eb+1,confP:sig.confP};}
  advance(Infinity);for(let si=0;si<cfg.maxPos;si++){if(slots[si]){const pd=parsed[slots[si].pair];cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}
  return{trades,cap,mdd};
}

async function main(){
  console.log('═'.repeat(80));console.log('APEX V34 — 1H + ORDERFLOW (from 1m) + META-LABELING + MULTI-SLOT');console.log('═'.repeat(80));
  console.log('\nLoading 1m klines → aggregating to 1H + metrics + fetching funding/basis...');
  const allData={};
  for(const pair of PAIRS){
    process.stdout.write(pair+' ');
    const bars1m=load1m(pair);if(!bars1m||bars1m.length<10000){console.log('[SKIP]');continue;}
    const bars1h=aggTo1h(bars1m);
    const metrics=loadMetrics(pair);
    const firstTs=bars1h[0].t,lastTs=bars1h[bars1h.length-1].t;
    const fr=await gF(pair,firstTs,lastTs);
    const pi=await gPI(pair,'1h',firstTs,lastTs);
    allData[pair]={bars1h,metrics,fr,pi};
    process.stdout.write(`(1h:${bars1h.length} fr:${fr.length} pi:${pi.length}) `);
  }
  console.log('\n');
  const firstTs=Math.min(...Object.values(allData).map(d=>d.bars1h[0].t));
  const lastTs=Math.max(...Object.values(allData).map(d=>d.bars1h[d.bars1h.length-1].t));
  const totalDays=(lastTs-firstTs)/86400000;
  console.log(`Range: ${new Date(firstTs).toISOString().slice(0,10)} → ${new Date(lastTs).toISOString().slice(0,10)} (${totalDays.toFixed(0)}d)\n`);
  const TRAIN_D=120,TEST_D=30,STEP_D=30;
  const nW=Math.floor((totalDays-TRAIN_D-TEST_D)/STEP_D)+1;
  console.log(`Windows: ${nW} (train ${TRAIN_D}d / test ${TEST_D}d)\n`);

  const cfgs=[
    // Baseline: V34-P68-mp3 (PF 1.40 @ 2.09 t/d) - try to push t/d while holding PF
    {name:'V34-P68-mp4',thrP:68,metaP:0,maxPos:4,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,tpBar:2.5,slBar:1.5,horz:24},
    {name:'V34-P68-mp5',thrP:68,metaP:0,maxPos:5,maxCluster:3,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,tpBar:2.5,slBar:1.5,horz:24},
    // Lower thresh + meta barely filtering
    {name:'V34-P50-M50-mp3',thrP:50,metaP:0.50,maxPos:3,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,tpBar:2.5,slBar:1.5,horz:24},
    {name:'V34-P45-M50-mp3',thrP:45,metaP:0.50,maxPos:3,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,tpBar:2.5,slBar:1.5,horz:24},
    {name:'V34-P40-M50-mp3',thrP:40,metaP:0.50,maxPos:3,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,tpBar:2.5,slBar:1.5,horz:24},
    {name:'V34-P35-M51-mp3',thrP:35,metaP:0.51,maxPos:3,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,tpBar:2.5,slBar:1.5,horz:24},
    {name:'V34-P30-M51-mp3',thrP:30,metaP:0.51,maxPos:3,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,tpBar:2.5,slBar:1.5,horz:24},
    {name:'V34-P30-M52-mp3',thrP:30,metaP:0.52,maxPos:3,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,tpBar:2.5,slBar:1.5,horz:24},
    {name:'V34-P25-M52-mp3',thrP:25,metaP:0.52,maxPos:3,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,tpBar:2.5,slBar:1.5,horz:24},
    // mp4 variants
    {name:'V34-P40-M50-mp4',thrP:40,metaP:0.50,maxPos:4,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,tpBar:2.5,slBar:1.5,horz:24},
    {name:'V34-P35-M51-mp4',thrP:35,metaP:0.51,maxPos:4,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,tpBar:2.5,slBar:1.5,horz:24},
    {name:'V34-P30-M52-mp4',thrP:30,metaP:0.52,maxPos:4,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,tpBar:2.5,slBar:1.5,horz:24},
    // Higher maxCluster to allow more BTC/ETH concurrent
    {name:'V34-P35-M50-mp4-c3',thrP:35,metaP:0.50,maxPos:4,maxCluster:3,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,tpBar:2.5,slBar:1.5,horz:24},
    // Tighter SL
    {name:'V34-P40-M52-SL15',thrP:40,metaP:0.52,maxPos:3,maxCluster:2,slM:1.5,tpR:3,mc:0.011,adxF:22,to:60,fwd:2,tpBar:3,slBar:1.5,horz:18},
    {name:'V34-P35-M52-SL15',thrP:35,metaP:0.52,maxPos:3,maxCluster:2,slM:1.5,tpR:3,mc:0.011,adxF:22,to:60,fwd:2,tpBar:3,slBar:1.5,horz:18}
  ];

  const results=[];
  for(const cfg of cfgs){
    const allOOS=[];
    for(let w=0;w<nW;w++){
      const trs=firstTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;
      const pm={};
      for(const pair of PAIRS){
        if(!allData[pair])continue;
        const trBars=allData[pair].bars1h.filter(b=>b.t>=trs&&b.t<tre);if(trBars.length<300)continue;
        const trMetrics=allData[pair].metrics.filter(m=>m.t>=trs-86400000&&m.t<tre);
        const F=buildFeatures(trBars,trMetrics,allData[pair].fr,allData[pair].pi);
        const fwd=new Float64Array(F.n).fill(NaN);for(let i=50;i<F.n-cfg.fwd;i++)fwd[i]=(F.c[i+cfg.fwd]-F.c[i])/F.c[i]*100;
        const co=pearson(F.fs,fwd,50,F.n-cfg.fwd);
        const sel=co.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,8);
        if(sel.length<2)continue;
        let tc=[];for(let i=55;i<F.n;i++){if(F.adx[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];tc.push(Math.abs(comp));}
        tc.sort((a,b)=>a-b);const thr=tc[Math.floor(tc.length*cfg.thrP/100)]||0.001;
        let meta=null;
        if(cfg.metaP>0){
          const mX=[],mY=[];
          for(let i=55;i<F.n-cfg.horz-1;i++){if(F.adx[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];if(Math.abs(comp)<thr)continue;const dir=comp>0?1:-1;const lbl=tripleBarrier(F.h,F.l,F.c,F.atr,i,cfg.tpBar,cfg.slBar,cfg.horz,dir);if(lbl===0)continue;const mf=[Math.abs(comp)/thr-1,F.adx[i]/30-1,F.atr[i]/F.c[i]*100];for(const{idx}of sel.slice(0,6))mf.push(F.fs[idx][i]);mX.push(mf);mY.push(lbl===1?1:0);}
          if(mX.length>=30)meta=logistic(mX,mY,60,0.1,0.01);
        }
        pm[pair]={sel,thr,meta};
      }
      if(Object.keys(pm).length<4)continue;
      const sigs=[],tPar={};
      for(const pair of PAIRS){
        if(!pm[pair]||!allData[pair])continue;
        const teBars=allData[pair].bars1h.filter(b=>b.t>=tes&&b.t<tee);if(teBars.length<50)continue;
        const teMetrics=allData[pair].metrics.filter(m=>m.t>=tes-86400000&&m.t<tee);
        const F=buildFeatures(teBars,teMetrics,allData[pair].fr,allData[pair].pi);
        tPar[pair]={t:F.t,o:F.o,h:F.h,l:F.l,c:F.c,atr:F.atr};
        const{sel,thr,meta}=pm[pair];let last=-3;
        for(let i=55;i<F.n-cfg.to-1;i++){
          if(i-last<2)continue;if(F.adx[i]<cfg.adxF)continue;
          let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];
          if(Math.abs(comp)<thr)continue;
          const dir=comp>0?1:-1;let confP=0.5;
          if(meta&&cfg.metaP>0){const mf=[Math.abs(comp)/thr-1,F.adx[i]/30-1,F.atr[i]/F.c[i]*100];for(const{idx}of sel.slice(0,6))mf.push(F.fs[idx][i]);confP=meta.predict(mf);if(confP<cfg.metaP)continue;}
          sigs.push({bar:i,dir,ts:F.t[i],pair,confP});last=i;
        }
      }
      allOOS.push(...engine(sigs,tPar,P(SEED+w),cfg).trades);
    }
    if(!allOOS.length){results.push({cfg,s:{n:0,pf:0,wr:0,pnl:0,sharpe:0,mdd:0},tpd:0});continue;}
    const s=st(allOOS);const tpd=s.n/(nW*TEST_D);
    const pairsStat={};for(const t of allOOS){if(!pairsStat[t.pair])pairsStat[t.pair]=[];pairsStat[t.pair].push(t);}
    let pp=0;for(const p of Object.keys(pairsStat)){const s2=st(pairsStat[p]);if(s2.pnl>0)pp++;}
    const mos={};for(const t of allOOS){const m=t.date?.slice(0,7)||'?';if(!mos[m])mos[m]=[];mos[m].push(t);}
    let pm2=0;for(const m of Object.keys(mos)){const s2=st(mos[m]);if(s2.pnl>0)pm2++;}
    results.push({cfg,s,tpd,pp,pm:pm2,np:Object.keys(pairsStat).length,nm:Object.keys(mos).length,trades:allOOS});
    console.log(`${cfg.name.padEnd(22)} ${s.n.toString().padStart(4)}t ${tpd.toFixed(2).padStart(4)}t/d WR${s.wr.toFixed(1).padStart(4)}% PF${s.pf.toFixed(2).padStart(5)} Sh${s.sharpe.toFixed(1).padStart(4)} DD$${s.mdd.toFixed(0).padStart(4)} $${s.pnl.toFixed(0).padStart(6)} P${pp}/${Object.keys(pairsStat).length}`);
  }
  console.log('\n'+'═'.repeat(80));console.log('V34 SUMMARY — TARGETS: PF>=1.65, t/d>=3, WR>42.3%');console.log('═'.repeat(80));
  const valid=results.filter(r=>r.s.n>=50);
  const winners=valid.filter(r=>r.tpd>=3.0&&r.s.pf>=1.65&&r.s.wr>42.3);
  const bestPF=[...valid].sort((a,b)=>b.s.pf-a.s.pf)[0];
  const best3pd=[...valid.filter(r=>r.tpd>=3.0)].sort((a,b)=>b.s.pf-a.s.pf)[0];
  if(bestPF)console.log(`Highest PF:     ${bestPF.cfg.name.padEnd(22)} PF${bestPF.s.pf.toFixed(2)} @ ${bestPF.tpd.toFixed(2)} t/d WR${bestPF.s.wr.toFixed(1)}% (${bestPF.s.n}t)`);
  if(best3pd)console.log(`Best @ 3+ t/d:  ${best3pd.cfg.name.padEnd(22)} PF${best3pd.s.pf.toFixed(2)} @ ${best3pd.tpd.toFixed(2)} t/d WR${best3pd.s.wr.toFixed(1)}% (${best3pd.s.n}t)`);
  if(winners.length){console.log(`\n★★★ ${winners.length} configs MEET ALL TARGETS:`);for(const r of winners)console.log(`  ${r.cfg.name}: PF${r.s.pf.toFixed(2)} @ ${r.tpd.toFixed(2)}t/d WR${r.s.wr.toFixed(1)}% Sh${r.s.sharpe.toFixed(1)} DD$${r.s.mdd.toFixed(0)}`);}
  const best=winners[0]||best3pd||bestPF;
  if(best){console.log('\n'+'═'.repeat(80));console.log(`DETAILED: ${best.cfg.name}`);console.log('═'.repeat(80));
    const tr=best.trades;const mos={};for(const t of tr){const m=t.date?.slice(0,7)||'?';if(!mos[m])mos[m]=[];mos[m].push(t);}
    console.log('Monthly:');for(const m of Object.keys(mos).sort()){const s2=st(mos[m]);console.log(`  ${m}: ${s2.n}t WR${s2.wr.toFixed(1)}% PF${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}
    const pairsR={};for(const t of tr){if(!pairsR[t.pair])pairsR[t.pair]=[];pairsR[t.pair].push(t);}
    console.log('\nPer Pair:');for(const p of Object.keys(pairsR).sort()){const s2=st(pairsR[p]);console.log(`  ${p.padEnd(10)}: ${s2.n}t WR${s2.wr.toFixed(1)}% PF${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}}
  console.log('\n'+'═'.repeat(80)+'\n');
}
main().catch(e=>{console.error('FATAL:',e.message,e.stack);process.exit(1);});
