#!/usr/bin/env node
'use strict';
// APEX V33 — 15m TF + ORDERFLOW (from 1m klines) + META-LABELING + MULTI-SLOT
// Zero-cost data: Binance Data Vision 1m klines + 5m metrics (already downloaded)
// Goal: PF>=1.65, t/d>=3, WR high on OOS 270d walk-forward
//
// KEY INNOVATIONS vs V16:
// 1. 15m timeframe instead of 1H (edge captured before decay)
// 2. ORDERFLOW features from 1m aggregated to 15m:
//    - Taker buy/sell imbalance per 15m bar
//    - Trade intensity (count) vs rolling mean
//    - Avg trade size & variance (large trade detection)
//    - Volume-weighted order flow (VWOF)
//    - OFI proxy: sum of signed taker deltas across 15 one-minute bars
// 3. META-LABELING: primary model → direction; meta-model → P(win) filter
// 4. Triple-barrier labels for training (López de Prado)
// 5. Multi-slot (maxPos=3) with correlation cluster constraint
'use strict';
const fs=require('fs');
const path=require('path');

const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT'];
const KLINES_DIR='/tmp/binance-klines-1m';
const METRICS_DIR='/tmp/binance-metrics';
// 15m timeframe → 96 bars/day. 270 days total data (9 months July 2025 → March 2026).
const TF_MINUTES=15;
const BARS_PER_DAY=24*60/TF_MINUTES;  // 96
const INIT_CAP=500,POS_SIZE=2500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002,SEED=314159265;

// Clusters for correlation constraint (max 2 concurrent per cluster)
const CLUSTERS={BTCUSDT:'L1',ETHUSDT:'L1',BNBUSDT:'L1',SOLUSDT:'L1alt',AVAXUSDT:'L1alt',XRPUSDT:'alt',ADAUSDT:'alt',DOGEUSDT:'meme'};

function P(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}

// ===== LOAD 1m KLINES → AGGREGATE TO 15m with MICROSTRUCTURE =====
function load1m(pair){
  const dir=path.join(KLINES_DIR,pair);
  if(!fs.existsSync(dir))return null;
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.csv')).sort();
  const bars=[];
  for(const f of files){
    const content=fs.readFileSync(path.join(dir,f),'utf8');
    const lines=content.split('\n');
    // skip header if present
    const start=lines[0].startsWith('open_time')?1:0;
    for(let i=start;i<lines.length;i++){
      const l=lines[i].trim();if(!l)continue;
      const p=l.split(',');if(p.length<11)continue;
      bars.push([+p[0],+p[1],+p[2],+p[3],+p[4],+p[5],+p[6],+p[7],+p[8],+p[9],+p[10]]);
      // [openTs, open, high, low, close, volume, closeTs, qvolume, count, takerBuyVol, takerBuyQVol]
    }
  }
  bars.sort((a,b)=>a[0]-b[0]);
  return bars;
}

// Aggregate 1m bars → 15m bars with microstructure
function aggTo15m(bars1m){
  const out=[];
  for(let i=0;i<bars1m.length;i+=TF_MINUTES){
    const grp=bars1m.slice(i,i+TF_MINUTES);if(grp.length<TF_MINUTES)break;
    const openTs=grp[0][0],closeTs=grp[grp.length-1][6];
    const open=grp[0][1];
    let high=-Infinity,low=Infinity;
    let volume=0,qvolume=0,count=0,takerBuy=0,takerBuyQ=0;
    // Microstructure accumulators
    let tradeCounts=[],imbalances=[],largeTradeSize=0;
    for(const b of grp){
      if(b[2]>high)high=b[2];if(b[3]<low)low=b[3];
      volume+=b[5];qvolume+=b[7];count+=b[8];takerBuy+=b[9];takerBuyQ+=b[10];
      tradeCounts.push(b[8]);
      const imb=b[5]>0?(2*b[9]-b[5])/b[5]:0;imbalances.push(imb);
      const avgSize=b[8]>0?b[7]/b[8]:0;if(avgSize>largeTradeSize)largeTradeSize=avgSize;
    }
    const close=grp[grp.length-1][4];
    const takerSell=volume-takerBuy;
    const takerImb=volume>0?(takerBuy-takerSell)/volume:0;
    const avgCountPerMin=count/TF_MINUTES;
    // Variance of 1m imbalances (proxy for VPIN/toxicity)
    const meanImb=imbalances.reduce((a,x)=>a+x,0)/imbalances.length;
    const varImb=imbalances.reduce((a,x)=>a+(x-meanImb)**2,0)/imbalances.length;
    out.push({
      t:openTs,ct:closeTs,o:open,h:high,l:low,c:close,v:volume,qv:qvolume,
      cnt:count,tbv:takerBuy,tbqv:takerBuyQ,tsv:takerSell,
      ti:takerImb,      // 15m taker imbalance (range -1 to 1)
      apm:avgCountPerMin,  // avg count per minute
      lts:largeTradeSize,  // max avg trade size in USD
      vi:varImb,        // variance of 1m imbalances (toxicity proxy)
      mi:meanImb        // mean of 1m imbalances (direction consistency)
    });
  }
  return out;
}

// Load metrics (from V31) filtered to match 15m bar times
function loadMetrics(pair){
  const dir=path.join(METRICS_DIR,pair);
  if(!fs.existsSync(dir))return[];
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.csv')&&f.startsWith(`${pair}-metrics-`));
  const out=[];
  for(const f of files){
    let content;try{content=fs.readFileSync(path.join(dir,f),'utf8');}catch(e){continue;}
    const lines=content.split('\n');
    for(let i=1;i<lines.length;i++){
      const l=lines[i].trim();if(!l)continue;
      const p=l.split(',');if(p.length<8)continue;
      const ts=new Date(p[0].replace(' ','T')+'Z').getTime();
      out.push({t:ts,oi:parseFloat(p[2])||0,oiv:parseFloat(p[3])||0,topAcct:parseFloat(p[4])||1,topPos:parseFloat(p[5])||1,lsAcct:parseFloat(p[6])||1,taker:parseFloat(p[7])||1});
    }
  }
  out.sort((a,b)=>a.t-b.t);
  return out;
}

// Technical indicators
const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const rs=(c,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;};
const bb=(c,p=20,m2=2)=>{const mid=sm(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};};
const mcd=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};};
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

// Build feature matrix for 15m bars with orderflow + baseline + institutional
function buildFeatures(bars15,metrics){
  const n=bars15.length;
  const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);
  const ti=new Float64Array(n),apm=new Float64Array(n),lts=new Float64Array(n),vi=new Float64Array(n),mi=new Float64Array(n),tbv=new Float64Array(n),tsv=new Float64Array(n);
  for(let i=0;i<n;i++){const b=bars15[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;ti[i]=b.ti;apm[i]=b.apm;lts[i]=b.lts;vi[i]=b.vi;mi[i]=b.mi;tbv[i]=b.tbv;tsv[i]=b.tsv;}
  // Indicators
  const atr2=at(h,l,c),adx2=ax(h,l,c);
  const e9=em(c,9),e21=em(c,21),e50=em(c,50),e200=em(c,200);
  const r14=rs(c,14),r7=rs(c,7);
  const bbd=bb(c,20,2);const mc=mcd(c);
  const vsma=sm(v,20);const apmSma=sm(apm,20);const ltsSma=sm(lts,50);
  // OFI cumulative — sum of (takerBuy - takerSell) over 4 bars (1 hour)
  const ofi1h=new Float64Array(n),ofi4h=new Float64Array(n);
  for(let i=0;i<n;i++){
    let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=tbv[j]-tsv[j];ofi1h[i]=s;
    let s2=0;for(let j=Math.max(0,i-15);j<=i;j++)s2+=tbv[j]-tsv[j];ofi4h[i]=s2;
  }
  // Metrics lookup (5m resolution → for each 15m bar use last metric)
  const mT=metrics.map(m=>m.t);
  function gM(bt,lookbackMinutes){
    let lo=0,hi=mT.length-1,b=-1;
    while(lo<=hi){const m=(lo+hi)>>1;if(mT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}
    if(b<0)return null;
    const lb=Math.floor(lookbackMinutes/5); // 5m resolution
    return{cur:metrics[b],prev:(b-lb>=0?metrics[b-lb]:null)};
  }

  // Build features list
  const fs2=[],nm=[];
  const F=(name,fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);nm.push(name);};
  // === BASELINE V16-style (15 features) ===
  F('RSI14',i=>(50-r14[i])/50);
  F('RSI7',i=>(50-r7[i])/50);
  F('MACDh',i=>mc.hist[i]/(atr2[i]||1));
  F('MACDs',i=>i>0?(mc.hist[i]-mc.hist[i-1])/(atr2[i]||1):0);
  F('BBpos',i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);
  F('BBw',i=>!isNaN(bbd.up[i])&&bbd.mid[i]?(bbd.up[i]-bbd.dn[i])/bbd.mid[i]:0);
  F('ADXv',i=>(adx2.adx[i]-25)/25);
  F('E9_21',i=>(e9[i]-e21[i])/(atr2[i]||1));
  F('E21_50',i=>(e21[i]-e50[i])/(atr2[i]||1));
  F('E50_200',i=>(e50[i]-e200[i])/(atr2[i]||1));
  F('Ret1',i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);
  F('Ret4',i=>i>=4?(c[i]-c[i-4])/c[i-4]*100:0);   // 1h on 15m
  F('Ret16',i=>i>=16?(c[i]-c[i-16])/c[i-16]*100:0); // 4h
  F('ClsP',i=>h[i]!==l[i]?(c[i]-l[i])/(h[i]-l[i])-0.5:0);
  F('HrSin',i=>Math.sin(new Date(t[i]).getUTCHours()/24*2*Math.PI));
  // === ORDERFLOW from 1m aggregation (10 features) — NEW ===
  F('TakerImb',i=>ti[i]);                          // taker imbalance current bar
  F('TakerImb4',i=>{let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=ti[j];return s/4;});    // avg 1h
  F('TakerImb16',i=>{let s=0;for(let j=Math.max(0,i-15);j<=i;j++)s+=ti[j];return s/16;}); // avg 4h
  F('OFI1h',i=>ofi1h[i]/(vsma[i]||1));              // normalized order flow imbalance
  F('OFI4h',i=>ofi4h[i]/(vsma[i]*16||1));
  F('TradeInt',i=>apmSma[i]>0?apm[i]/apmSma[i]-1:0); // trade intensity vs normal
  F('LargeTr',i=>ltsSma[i]>0?lts[i]/ltsSma[i]-1:0);  // large trade detection
  F('TakeTox',i=>vi[i]);                             // toxicity: variance of 1m imbalances
  F('MeanImb',i=>mi[i]);                             // direction consistency
  F('VolR',i=>vsma[i]>0?v[i]/vsma[i]-1:0);            // volume ratio
  // === INSTITUTIONAL from metrics (7 features) ===
  F('OIchg1h',i=>{const m=gM(t[i],60);if(!m||!m.prev||m.prev.oi===0)return 0;return(m.cur.oi-m.prev.oi)/m.prev.oi*100;});
  F('OIchg4h',i=>{const m=gM(t[i],240);if(!m||!m.prev||m.prev.oi===0)return 0;return(m.cur.oi-m.prev.oi)/m.prev.oi*100;});
  F('OIvsPrice',i=>{const m=gM(t[i],60);if(!m||!m.prev||m.prev.oi===0)return 0;const oiC=(m.cur.oi-m.prev.oi)/m.prev.oi*100;const pC=i>=4?(c[i]-c[i-4])/c[i-4]*100:0;return oiC-pC;});
  F('TopPosLSR',i=>{const m=gM(t[i],0);if(!m||m.cur.topPos<=0)return 0;return(1/m.cur.topPos-1);});
  F('TopPosSlp',i=>{const m=gM(t[i],60);if(!m||!m.prev)return 0;return-(m.cur.topPos-m.prev.topPos)*5;});
  F('LSAcct',i=>{const m=gM(t[i],0);if(!m||m.cur.lsAcct<=0)return 0;return(1/m.cur.lsAcct-1);});
  F('MetaTaker',i=>{const m=gM(t[i],0);if(!m||m.cur.taker<=0)return 0;return Math.log(m.cur.taker);});
  return{fs:fs2,nm,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};
}

// Pearson for feature selection
function pearson(fs,fwd,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],y=fwd[i];if(isNaN(x)||isNaN(y))continue;sx+=x;sy+=y;sxy+=x*y;sx2+=x*x;sy2+=y*y;cnt++;}if(cnt<100){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}

// Triple-barrier labels: for each bar i, does price hit +TP×ATR, -SL×ATR, or timeout first?
// Returns: +1 if TP hit (direction correct for primary signal), -1 if SL, 0 if timeout
function tripleBarrier(pricesH,pricesL,pricesC,atr,startI,tpMult,slMult,horizon,dir){
  const ep=pricesC[startI];
  const tp=dir===1?ep+atr[startI]*tpMult:ep-atr[startI]*tpMult;
  const sl=dir===1?ep-atr[startI]*slMult:ep+atr[startI]*slMult;
  for(let j=startI+1;j<Math.min(pricesC.length,startI+horizon+1);j++){
    let hT,hS;
    if(dir===1){hT=pricesH[j]>=tp;hS=pricesL[j]<=sl;}
    else{hT=pricesL[j]<=tp;hS=pricesH[j]>=sl;}
    if(hT&&!hS)return 1;
    if(hS&&!hT)return -1;
    if(hT&&hS)return 0; // ambiguous, treat as timeout
  }
  return 0;
}

// Simple logistic regression for meta-labeling (pure JS, no deps)
function logistic(X,y,iters=80,lr=0.1,reg=0.01){
  const nF=X[0].length,n=X.length;
  const w=new Float64Array(nF).fill(0);let b=0;
  for(let it=0;it<iters;it++){
    const grad=new Float64Array(nF).fill(0);let gb=0;
    for(let i=0;i<n;i++){
      let z=b;for(let j=0;j<nF;j++)z+=w[j]*X[i][j];
      const p=1/(1+Math.exp(-z));
      const err=p-y[i];
      gb+=err;for(let j=0;j<nF;j++)grad[j]+=err*X[i][j];
    }
    b-=lr*gb/n;for(let j=0;j<nF;j++)w[j]-=lr*(grad[j]/n+reg*w[j]);
  }
  return{w,b,predict:x=>{let z=b;for(let j=0;j<x.length;j++)z+=w[j]*x[j];return 1/(1+Math.exp(-z));}};
}

function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,tp:0,sl:0,to:0,sharpe:0,mdd:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));
  // Rough Sharpe: mean / std of daily returns
  const byDay={};for(const x of t){const d=x.date;if(!byDay[d])byDay[d]=0;byDay[d]+=x.pnl;}
  const dailyR=Object.values(byDay);
  const meanD=dailyR.reduce((a,x)=>a+x,0)/dailyR.length;
  const varD=dailyR.reduce((a,x)=>a+(x-meanD)**2,0)/dailyR.length;
  const sharpe=varD>0?meanD/Math.sqrt(varD)*Math.sqrt(365):0;
  // Max DD on cumulative
  let cum=0,pk=0,mdd=0;for(const x of t){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}
  return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,tp:t.filter(x=>x.type==='TP').length,sl:t.filter(x=>x.type==='SL').length,to:t.filter(x=>x.type==='TO').length,sharpe,mdd};
}

// Execution engine multi-slot with cluster constraint
function engine(sigs,parsed,prng,cfg){
  let cap=INIT_CAP,pk=INIT_CAP,mdd=0;const trades=[];
  const slots=new Array(cfg.maxPos).fill(null);
  function cls(si,j,reason){const pos=slots[si];const pd=parsed[pos.pair];let ep2;if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(reason==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty,f=POS_SIZE*FEE_E+POS_SIZE*(reason==='TP'?FEE_TP:FEE_SL);cap+=g-f;pk=Math.max(pk,cap);const dd=pk>0?(pk-cap)/pk:0;if(dd>mdd)mdd=dd;trades.push({dir:pos.dir,pnl:g-f,type:reason,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10),confP:pos.confP||0});slots[si]=null;}
  function advance(upToTs){for(let si=0;si<cfg.maxPos;si++){const pos=slots[si];if(!pos)continue;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upToTs;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){cls(si,j,'SL');break;}if(hT){cls(si,j,'TP');break;}pos.nc=j+1;}if(slots[si]&&slots[si].nc>slots[si].exp){cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}}
  sigs.sort((a,b)=>a.ts-b.ts);
  for(const sig of sigs){if(cap<=0)break;const d=parsed[sig.pair];const eb=sig.bar+1;if(eb>=d.c.length)continue;
    advance(d.t[eb]);
    // Find free slot NOT in same cluster max, not same pair
    let freeSlot=-1;
    const clusterCounts={};for(let si=0;si<cfg.maxPos;si++)if(slots[si]){clusterCounts[CLUSTERS[slots[si].pair]]=(clusterCounts[CLUSTERS[slots[si].pair]]||0)+1;}
    for(let si=0;si<cfg.maxPos;si++){
      if(slots[si])continue;
      let pairConflict=false;for(let sj=0;sj<cfg.maxPos;sj++)if(slots[sj]&&slots[sj].pair===sig.pair){pairConflict=true;break;}
      if(pairConflict)continue;
      const cl=CLUSTERS[sig.pair]||'other';if((clusterCounts[cl]||0)>=cfg.maxCluster)continue;
      freeSlot=si;break;
    }
    if(freeSlot===-1)continue;
    if(prng()>=0.75)continue;if(cap<50)continue;
    const ep=d.o[eb],atrA=d.atr[sig.bar],ap=atrA/d.c[sig.bar];if(ap<=0||isNaN(ap))continue;
    let sl=Math.max(0.002,Math.min(0.03,ap*cfg.slM)),tp=Math.max(0.003,Math.min(0.08,sl*cfg.tpR));
    slots[freeSlot]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-sl):ep*(1+sl),tpP:sig.dir===1?ep*(1+tp):ep*(1-tp),qty:POS_SIZE/ep,eb,exp:eb+cfg.to,nc:eb+1,confP:sig.confP};
  }
  advance(Infinity);for(let si=0;si<cfg.maxPos;si++){if(slots[si]){const pd=parsed[slots[si].pair];cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}
  return{trades,cap,mdd};
}

async function main(){
  console.log('═'.repeat(80));
  console.log('APEX V33 — 15m + ORDERFLOW + META-LABELING + MULTI-SLOT');
  console.log('Zero-cost data: Binance Data Vision 1m klines + 5m metrics');
  console.log('═'.repeat(80));
  console.log('\nLoading 1m klines + aggregating to 15m + loading metrics...');
  const allData={};
  for(const pair of PAIRS){
    process.stdout.write(pair+' ');
    const bars1m=load1m(pair);if(!bars1m||bars1m.length<10000){console.log(`[SKIP: only ${bars1m?bars1m.length:0} 1m bars]`);continue;}
    const bars15=aggTo15m(bars1m);
    const metrics=loadMetrics(pair);
    process.stdout.write(`(1m:${bars1m.length} 15m:${bars15.length} m:${metrics.length}) `);
    allData[pair]={bars15,metrics};
  }
  console.log('\n');
  // Determine walk-forward windows
  const firstTs=Math.min(...Object.values(allData).map(d=>d.bars15[0].t));
  const lastTs=Math.max(...Object.values(allData).map(d=>d.bars15[d.bars15.length-1].t));
  const totalDays=(lastTs-firstTs)/86400000;
  console.log(`Data range: ${new Date(firstTs).toISOString().slice(0,10)} → ${new Date(lastTs).toISOString().slice(0,10)} (${totalDays.toFixed(0)} days)\n`);

  const TRAIN_D=60,TEST_D=30,STEP_D=30;
  const nW=Math.floor((totalDays-TRAIN_D-TEST_D)/STEP_D)+1;
  console.log(`Walk-forward windows: ${nW} (train ${TRAIN_D}d / test ${TEST_D}d / step ${STEP_D}d)\n`);

  // Config to test
  const cfgs=[
    // Higher thresholds for 15m (need P85+ to match V16's signal scarcity)
    {name:'V33-P85',thrP:85,metaP:0,maxPos:3,maxCluster:2,slM:1.5,tpR:2,mc:0.03,adxF:20,to:32,fwd:4,tpBar:2,slBar:1.5,horz:12},
    {name:'V33-P80',thrP:80,metaP:0,maxPos:3,maxCluster:2,slM:1.5,tpR:2,mc:0.03,adxF:20,to:32,fwd:4,tpBar:2,slBar:1.5,horz:12},
    {name:'V33-P75',thrP:75,metaP:0,maxPos:3,maxCluster:2,slM:1.5,tpR:2,mc:0.03,adxF:20,to:32,fwd:4,tpBar:2,slBar:1.5,horz:12},
    {name:'V33-P70',thrP:70,metaP:0,maxPos:3,maxCluster:2,slM:1.5,tpR:2,mc:0.03,adxF:20,to:32,fwd:4,tpBar:2,slBar:1.5,horz:12},
    // ADX stricter on higher thresholds
    {name:'V33-P80-ADX25',thrP:80,metaP:0,maxPos:3,maxCluster:2,slM:1.5,tpR:2,mc:0.03,adxF:25,to:32,fwd:4,tpBar:2,slBar:1.5,horz:12},
    {name:'V33-P75-ADX25',thrP:75,metaP:0,maxPos:3,maxCluster:2,slM:1.5,tpR:2,mc:0.03,adxF:25,to:32,fwd:4,tpBar:2,slBar:1.5,horz:12},
    {name:'V33-P70-ADX25',thrP:70,metaP:0,maxPos:3,maxCluster:2,slM:1.5,tpR:2,mc:0.03,adxF:25,to:32,fwd:4,tpBar:2,slBar:1.5,horz:12},
    // Meta-labeling with less aggressive filter
    {name:'V33-P75-M52',thrP:75,metaP:0.52,maxPos:3,maxCluster:2,slM:1.5,tpR:2,mc:0.03,adxF:20,to:32,fwd:4,tpBar:2,slBar:1.5,horz:12},
    {name:'V33-P70-M52',thrP:70,metaP:0.52,maxPos:3,maxCluster:2,slM:1.5,tpR:2,mc:0.03,adxF:20,to:32,fwd:4,tpBar:2,slBar:1.5,horz:12},
    {name:'V33-P65-M53',thrP:65,metaP:0.53,maxPos:3,maxCluster:2,slM:1.5,tpR:2,mc:0.03,adxF:20,to:32,fwd:4,tpBar:2,slBar:1.5,horz:12},
    // Tighter SL w/ TP 2.5x
    {name:'V33-P75-SL1',thrP:75,metaP:0,maxPos:3,maxCluster:2,slM:1.0,tpR:2.5,mc:0.03,adxF:22,to:24,fwd:4,tpBar:2.5,slBar:1.0,horz:10},
    {name:'V33-P70-SL1',thrP:70,metaP:0,maxPos:3,maxCluster:2,slM:1.0,tpR:2.5,mc:0.03,adxF:22,to:24,fwd:4,tpBar:2.5,slBar:1.0,horz:10},
    // Higher mc (strongest features only)
    {name:'V33-P75-MC05',thrP:75,metaP:0,maxPos:3,maxCluster:2,slM:1.5,tpR:2,mc:0.05,adxF:22,to:32,fwd:4,tpBar:2,slBar:1.5,horz:12},
    {name:'V33-P70-MC05',thrP:70,metaP:0,maxPos:3,maxCluster:2,slM:1.5,tpR:2,mc:0.05,adxF:22,to:32,fwd:4,tpBar:2,slBar:1.5,horz:12}
  ];

  const results=[];
  for(const cfg of cfgs){
    const allOOS=[];
    const featCache={};  // reuse features across windows per pair
    for(let w=0;w<nW;w++){
      const trs=firstTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;
      // Per-pair train + meta
      const pm={};
      for(const pair of PAIRS){
        if(!allData[pair])continue;
        const trBars=allData[pair].bars15.filter(b=>b.t>=trs&&b.t<tre);
        if(trBars.length<500)continue;
        const teMetricsFilter=allData[pair].metrics.filter(m=>m.t>=trs-86400000&&m.t<tre);
        const F=buildFeatures(trBars,teMetricsFilter);
        // fwd returns for feature selection
        const fwd=new Float64Array(F.n).fill(NaN);for(let i=50;i<F.n-cfg.fwd;i++)fwd[i]=(F.c[i+cfg.fwd]-F.c[i])/F.c[i]*100;
        const co=pearson(F.fs,fwd,50,F.n-cfg.fwd);
        const sel=co.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,15);
        if(sel.length<3)continue;
        // Threshold from training
        let tc=[];for(let i=55;i<F.n;i++){if(F.adx[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];tc.push(Math.abs(comp));}
        tc.sort((a,b)=>a-b);const thr=tc[Math.floor(tc.length*cfg.thrP/100)]||0.001;
        // Meta-labeling: train logistic regression on training signals
        let meta=null;
        if(cfg.metaP>0){
          const metaX=[],metaY=[];
          for(let i=55;i<F.n-cfg.horz-1;i++){
            if(F.adx[i]<cfg.adxF)continue;
            let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];
            if(Math.abs(comp)<thr)continue;
            const dir=comp>0?1:-1;
            // Label via triple-barrier
            const lbl=tripleBarrier(F.h,F.l,F.c,F.atr,i,cfg.tpBar,cfg.slBar,cfg.horz,dir);
            if(lbl===0)continue; // skip timeouts (ambiguous)
            // Meta features: primary confidence + feature subset values
            const mf=[Math.abs(comp)/thr-1,F.adx[i]/30-1,F.atr[i]/F.c[i]*100];
            for(const{idx}of sel.slice(0,6))mf.push(F.fs[idx][i]);
            metaX.push(mf);metaY.push(lbl===1?1:0);
          }
          if(metaX.length>=40){
            meta=logistic(metaX,metaY,60,0.1,0.01);
          }
        }
        pm[pair]={sel,thr,meta};
      }
      if(Object.keys(pm).length<4)continue;
      // TEST phase
      const sigs=[],tPar={};
      for(const pair of PAIRS){
        if(!pm[pair]||!allData[pair])continue;
        const teBars=allData[pair].bars15.filter(b=>b.t>=tes&&b.t<tee);
        if(teBars.length<50)continue;
        const teMetrics=allData[pair].metrics.filter(m=>m.t>=tes-86400000&&m.t<tee);
        const F=buildFeatures(teBars,teMetrics);
        tPar[pair]={t:F.t,o:F.o,h:F.h,l:F.l,c:F.c,atr:F.atr};
        const{sel,thr,meta}=pm[pair];
        let last=-3;
        for(let i=55;i<F.n-cfg.to-1;i++){
          if(i-last<2)continue;
          if(F.adx[i]<cfg.adxF)continue;
          let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];
          if(Math.abs(comp)<thr)continue;
          const dir=comp>0?1:-1;
          let confP=0.5;
          if(meta&&cfg.metaP>0){
            const mf=[Math.abs(comp)/thr-1,F.adx[i]/30-1,F.atr[i]/F.c[i]*100];
            for(const{idx}of sel.slice(0,6))mf.push(F.fs[idx][i]);
            confP=meta.predict(mf);
            if(confP<cfg.metaP)continue;
          }
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
    console.log(`${cfg.name.padEnd(22)} ${s.n.toString().padStart(4)}t ${tpd.toFixed(2).padStart(4)}t/d WR${s.wr.toFixed(1).padStart(4)}% PF${s.pf.toFixed(2).padStart(5)} Sh${s.sharpe.toFixed(1).padStart(4)} DD$${s.mdd.toFixed(0).padStart(4)} $${s.pnl.toFixed(0).padStart(6)} P${pp}/${Object.keys(pairsStat).length} M${pm2}/${Object.keys(mos).length}`);
  }
  console.log('\n'+'═'.repeat(80));
  console.log('V33 SUMMARY — TARGETS: PF>=1.65, t/d>=3, WR>V16 (42.3%)');
  console.log('═'.repeat(80));
  const valid=results.filter(r=>r.s.n>=50);
  const winners=valid.filter(r=>r.tpd>=3.0&&r.s.pf>=1.65&&r.s.wr>42.3);
  const near=valid.filter(r=>r.tpd>=2.5&&r.s.pf>=1.5);
  const bestPF=[...valid].sort((a,b)=>b.s.pf-a.s.pf)[0];
  const best3pd=[...valid.filter(r=>r.tpd>=3.0)].sort((a,b)=>b.s.pf-a.s.pf)[0];
  const bestWR=[...valid].sort((a,b)=>b.s.wr-a.s.wr)[0];
  if(bestPF)console.log(`Highest PF:     ${bestPF.cfg.name.padEnd(22)} PF${bestPF.s.pf.toFixed(2)} @ ${bestPF.tpd.toFixed(2)} t/d WR${bestPF.s.wr.toFixed(1)}% (${bestPF.s.n}t)`);
  if(best3pd)console.log(`Best @ 3+ t/d:  ${best3pd.cfg.name.padEnd(22)} PF${best3pd.s.pf.toFixed(2)} @ ${best3pd.tpd.toFixed(2)} t/d WR${best3pd.s.wr.toFixed(1)}% (${best3pd.s.n}t)`);
  if(bestWR)console.log(`Highest WR:     ${bestWR.cfg.name.padEnd(22)} WR${bestWR.s.wr.toFixed(1)}% @ ${bestWR.tpd.toFixed(2)} t/d PF${bestWR.s.pf.toFixed(2)} (${bestWR.s.n}t)`);
  if(winners.length){console.log(`\n★★★ ${winners.length} configs MEET ALL TARGETS:`);for(const r of winners)console.log(`  ${r.cfg.name}: PF ${r.s.pf.toFixed(2)} @ ${r.tpd.toFixed(2)} t/d WR ${r.s.wr.toFixed(1)}% Sharpe ${r.s.sharpe.toFixed(1)}`);}
  else{console.log('\n✗ No config hit PF>=1.65 AND t/d>=3 AND WR>42.3%');if(near.length)console.log(`  Closest: ${near.length} configs at 2.5+ t/d with PF>=1.5`);}
  // Best config breakdown
  const best=winners[0]||best3pd||bestPF;
  if(best){
    console.log('\n'+'═'.repeat(80));console.log(`DETAILED: ${best.cfg.name}`);console.log('═'.repeat(80));
    const tr=best.trades;
    const mos={};for(const t of tr){const m=t.date?.slice(0,7)||'?';if(!mos[m])mos[m]=[];mos[m].push(t);}
    console.log('Monthly:');for(const m of Object.keys(mos).sort()){const s2=st(mos[m]);console.log(`  ${m}: ${s2.n}t WR ${s2.wr.toFixed(1)}% PF ${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}
    const pairsR={};for(const t of tr){if(!pairsR[t.pair])pairsR[t.pair]=[];pairsR[t.pair].push(t);}
    console.log('\nPer Pair:');for(const p of Object.keys(pairsR).sort()){const s2=st(pairsR[p]);console.log(`  ${p.padEnd(10)}: ${s2.n}t WR ${s2.wr.toFixed(1)}% PF ${s2.pf.toFixed(2)} $${s2.pnl.toFixed(0)}`);}
  }
  console.log('\n'+'═'.repeat(80)+'\n');
}
main().catch(e=>{console.error('FATAL:',e.message,e.stack);process.exit(1);});
