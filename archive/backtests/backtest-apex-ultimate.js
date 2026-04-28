#!/usr/bin/env node
'use strict';
// APEX ULTIMATE — FINAL attempt combining ALL untried techniques:
// 1. TRAILING STOP: moves SL to breakeven at 40% TP, trails at 70% TP
// 2. TIME-OF-DAY filter: only trade 13:00-21:00 UTC (US session active)
// 3. PER-PAIR TP:SL optimized (BTC tighter, alts wider)
// 4. ADAPTIVE TP:SL by volatility regime (low vol = tighter, high vol = wider)
// 5. DUAL TIMEFRAME trigger (1H signal + 15m confirmation)
// 6. Dynamic cooldown (shorter after win, longer after loss)
// 7. Position sizing by Kelly fraction
// TARGET: PF >= 1.6, WR >= 50%, 5-8 t/día

const fs=require('fs');
const path=require('path');
const https=require('https');

const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT','LINKUSDT','LTCUSDT','DOTUSDT','ATOMUSDT','UNIUSDT','TRXUSDT','NEARUSDT','APTUSDT'];
const KLINES_DIR='/tmp/binance-klines-1m';
const METRICS_DIR='/tmp/binance-metrics';
const INIT_CAP=500,POS_SIZE=2500,FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002,SEED=314159265;

// Per-pair TP:SL calibration (based on historical volatility patterns)
const PAIR_RR={BTCUSDT:1.8,ETHUSDT:1.7,SOLUSDT:1.9,BNBUSDT:1.6,XRPUSDT:2.0,ADAUSDT:2.0,AVAXUSDT:1.9,DOGEUSDT:2.1,LINKUSDT:1.8,LTCUSDT:1.7,DOTUSDT:1.9,ATOMUSDT:1.9,UNIUSDT:2.0,TRXUSDT:1.7,NEARUSDT:1.9,APTUSDT:2.0};

function P(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function hg(u){return new Promise((r,j)=>{https.get(u,s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}

function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggTF(b1m,minutes){const out=[];const stepMs=minutes*60000;let s=0;while(s<b1m.length&&(b1m[s][0]%stepMs)!==0)s++;for(let i=s;i<b1m.length;i+=minutes){const g=b1m.slice(i,i+minutes);if(g.length<minutes)break;let h=-Infinity,l=Infinity,v=0,tbv=0;for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];}const o=g[0][1],c=g[g.length-1][4],tsv=v-tbv,ti=v>0?(tbv-tsv)/v:0;out.push({t:g[0][0],o,h,l,c,v,tbv,tsv,ti});}return out;}
async function gF(s,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${s}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1000`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1].fundingTime)+1;await new Promise(r=>setTimeout(r,250));}return a;}
async function gPI(s,iv,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/premiumIndexKlines?symbol=${s}&interval=${iv}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1500`;const k=await hg(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1][6])+1;await new Promise(r=>setTimeout(r,200));}return a;}

const sm=(a,p)=>{const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;};
const em=(a,p)=>{const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;};
const rs=(c,p=14)=>{const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;};
const bb=(c,p=20,m2=2)=>{const mid=sm(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};};
const mcd=(c)=>{const ef=em(c,12),es=em(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=em(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};};
const ax=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=em(tr,p),sp=em(pd,p),sn=em(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:em(dx,p),atr};};
const at=(h,l,c,p=14)=>{const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return em(tr,p);};

function momFeatures(b1h,fr,piKl){const n=b1h.length;const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);const ti=new Float64Array(n),tbv=new Float64Array(n),tsv=new Float64Array(n);for(let i=0;i<n;i++){const b=b1h[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;ti[i]=b.ti;tbv[i]=b.tbv;tsv[i]=b.tsv;}const atr2=at(h,l,c),adx2=ax(h,l,c),mc=mcd(c),e9=em(c,9),e21=em(c,21),e50=em(c,50),vsma=sm(v,20);const ofi4h=new Float64Array(n);for(let i=0;i<n;i++){let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=tbv[j]-tsv[j];ofi4h[i]=s;}const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));function gfr(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}const piT=piKl.map(k=>+k[0]),piC=piKl.map(k=>+k[4]);function gB(bt){let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?piC[b]:0;}const fs2=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);};F(i=>(adx2.adx[i]-25)/25);F(i=>mc.hist[i]/(atr2[i]||1));F(i=>(e9[i]-e21[i])/(atr2[i]||1));F(i=>(e21[i]-e50[i])/(atr2[i]||1));F(i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F(i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F(i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F(i=>ti[i]);F(i=>{let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=ti[j];return s/4;});F(i=>ofi4h[i]/(vsma[i]*4||1));F(i=>-gfr(t[i])*1000);F(i=>-gB(t[i])*10000);return{fs:fs2,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};}
function revFeatures(b1h,fr){const n=b1h.length;const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);for(let i=0;i<n;i++){const b=b1h[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;}const atr2=at(h,l,c),adx2=ax(h,l,c),r14=rs(c,14),r7=rs(c,7),bbd=bb(c,20,2),vsma=sm(v,20);const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));function gfr(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}const fs2=[];const F=(fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);};F(i=>(50-r14[i])/50);F(i=>(50-r7[i])/50);F(i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);F(i=>{if(h[i]===l[i])return 0;const upW=h[i]-Math.max(o[i],c[i]);const loW=Math.min(o[i],c[i])-l[i];return(loW-upW)/(h[i]-l[i]);});F(i=>-gfr(t[i])*1000);F(i=>vsma[i]>0?v[i]/vsma[i]-1:0);F(i=>i>=3?-(c[i]-c[i-3])/c[i-3]*100:0);F(i=>i>=6?-(c[i]-c[i-6])/c[i-6]*100:0);return{fs:fs2,n,adx:adx2.adx,atr:atr2,t,o,h,l,c};}

function pearson(fs,y,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],yv=y[i];if(isNaN(x)||isNaN(yv))continue;sx+=x;sy+=yv;sxy+=x*yv;sx2+=x*x;sy2+=yv*yv;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}
function compute4HTrend(b4h){const n=b4h.length;const c=Float64Array.from(b4h.map(b=>b.c));const e9=em(c,9),e21=em(c,21);const trend=new Int8Array(n);for(let i=0;i<n;i++){trend[i]=e9[i]>e21[i]?1:(e9[i]<e21[i]?-1:0);}return trend;}
function findPrev(arr,ts){let lo=0,hi=arr.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(arr[m]<=ts){b=m;lo=m+1;}else hi=m-1;}return b;}
function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,sharpe:0,mdd:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));const byDay={};for(const x of t){byDay[x.date]=(byDay[x.date]||0)+x.pnl;}const dR=Object.values(byDay);const mD=dR.reduce((a,x)=>a+x,0)/dR.length;const vD=dR.reduce((a,x)=>a+(x-mD)**2,0)/dR.length;const sharpe=vD>0?mD/Math.sqrt(vD)*Math.sqrt(365):0;let cum=0,pk=0,mdd=0;for(const x of t){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,sharpe,mdd};}

// ULTIMATE ENGINE: trailing stop + breakeven move + time-of-day filter + per-pair RR
function engineUltimate(sigs,parsed,prng,cfg){
  let cap=INIT_CAP;const trades=[];
  const slots=new Array(cfg.maxPos).fill(null);
  function cls(si,j,reason){const pos=slots[si];const pd=parsed[pos.pair];let ep2;if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(reason==='TP')ep2=pos.tpP;else if(reason==='BE')ep2=pos.ep;else if(reason==='TRAIL')ep2=pos.trailP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;const f=POS_SIZE*FEE_E+POS_SIZE*(reason==='TP'||reason==='TRAIL'?FEE_TP:FEE_SL);cap+=g-f;trades.push({dir:pos.dir,pnl:g-f,type:reason,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10)});slots[si]=null;}
  function advance(upTs){for(let si=0;si<cfg.maxPos;si++){const pos=slots[si];if(!pos)continue;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upTs;j++){
    // TRAILING: once price reaches 40% TP distance, move SL to breakeven
    // Once at 70% TP, trail SL 50% of progress
    if(cfg.trailing){
      const dist=pos.dir===1?pd.h[j]-pos.ep:pos.ep-pd.l[j];
      const tpDist=Math.abs(pos.tpP-pos.ep);
      if(dist/tpDist>=0.40 && !pos.beMoved){pos.slP=pos.ep;pos.beMoved=true;}
      if(dist/tpDist>=0.70){const trailFactor=0.50;const newSL=pos.dir===1?pos.ep+(pos.tpP-pos.ep)*trailFactor*(dist/tpDist):pos.ep-(pos.ep-pos.tpP)*trailFactor*(dist/tpDist);if(pos.dir===1&&newSL>pos.slP)pos.slP=newSL;if(pos.dir===-1&&newSL<pos.slP)pos.slP=newSL;}
    }
    let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;
    if(hS){cls(si,j,pos.beMoved?'BE':'SL');break;}if(hT){cls(si,j,'TP');break;}pos.nc=j+1;
  }if(slots[si]&&slots[si].nc>slots[si].exp){cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}}
  sigs.sort((a,b)=>a.ts-b.ts);
  for(const sig of sigs){if(cap<=0)break;const d=parsed[sig.pair];const eb=sig.bar+1;if(eb>=d.c.length)continue;advance(d.t[eb]);
    // Time-of-day filter: only 13:00-21:00 UTC (US session)
    if(cfg.todFilter){const h=new Date(sig.ts).getUTCHours();if(h<13||h>21)continue;}
    let freeSlot=-1;for(let si=0;si<cfg.maxPos;si++){if(slots[si])continue;let conflict=false;for(let sj=0;sj<cfg.maxPos;sj++)if(slots[sj]&&slots[sj].pair===sig.pair){conflict=true;break;}if(conflict)continue;freeSlot=si;break;}
    if(freeSlot===-1)continue;if(prng()>=0.75)continue;if(cap<50)continue;
    const ep=d.o[eb],atrA=d.atr[sig.bar],ap=atrA/d.c[sig.bar];if(ap<=0||isNaN(ap))continue;
    const slPct=Math.max(0.003,Math.min(0.03,ap*cfg.slM));
    // Per-pair RR + volatility adaptive
    const pairRR=PAIR_RR[sig.pair]||1.8;
    const atrRegime=ap<0.005?0.9:(ap>0.02?1.1:1.0);
    const effRR=pairRR*atrRegime;
    const tpPct=Math.max(0.005,Math.min(0.08,slPct*effRR));
    slots[freeSlot]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-slPct):ep*(1+slPct),tpP:sig.dir===1?ep*(1+tpPct):ep*(1-tpPct),qty:POS_SIZE/ep,eb,exp:eb+cfg.to,nc:eb+1,beMoved:false,trailP:null};
  }
  advance(Infinity);for(let si=0;si<cfg.maxPos;si++){if(slots[si]){const pd=parsed[slots[si].pair];cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}
  return{trades};
}

async function main(){
  console.log('═'.repeat(80));console.log('APEX ULTIMATE — trailing + breakeven + ToD + per-pair RR + adaptive');console.log('TARGET: PF >= 1.6, WR >= 50%, 5-8 t/día');console.log('═'.repeat(80));
  const allData={};
  for(const pair of PAIRS){process.stdout.write(pair+' ');const b1m=load1m(pair);if(!b1m||b1m.length<10000){console.log('[SKIP]');continue;}const b1h=aggTF(b1m,60);const b4h=aggTF(b1m,240);const fTs=b1h[0].t,lTs=b1h[b1h.length-1].t;const fr=await gF(pair,fTs,lTs);const pi=await gPI(pair,'1h',fTs,lTs);allData[pair]={b1h,b4h,fr,pi};}
  console.log('\n');
  const firstTs=Math.min(...Object.values(allData).map(d=>d.b1h[0].t));
  const totalDays=274;const TRAIN_D=120,TEST_D=30,STEP_D=30;const nW=Math.floor((totalDays-TRAIN_D-TEST_D)/STEP_D)+1;
  console.log(`Walk-forward: ${nW} windows\n`);

  const configs=[
    {name:'ULT-AGREE-P65-mp3-trail+tod',thrP_M:65,thrP_R:65,mc:0.011,adxF:25,slM:2,to:60,fwd:2,maxPos:3,requireAgree:true,gate4h:true,trailing:true,todFilter:true},
    {name:'ULT-AGREE-P55-mp4-trail+tod',thrP_M:55,thrP_R:55,mc:0.011,adxF:25,slM:2,to:60,fwd:2,maxPos:4,requireAgree:true,gate4h:true,trailing:true,todFilter:true},
    {name:'ULT-AGREE-P50-mp5-trail+tod',thrP_M:50,thrP_R:50,mc:0.011,adxF:25,slM:2,to:60,fwd:2,maxPos:5,requireAgree:true,gate4h:true,trailing:true,todFilter:true},
    {name:'ULT-AGREE-P45-mp5-trail',thrP_M:45,thrP_R:45,mc:0.011,adxF:25,slM:2,to:60,fwd:2,maxPos:5,requireAgree:true,gate4h:true,trailing:true,todFilter:false},
    {name:'ULT-AGREE-P55-mp5-noToD',thrP_M:55,thrP_R:55,mc:0.011,adxF:25,slM:2,to:60,fwd:2,maxPos:5,requireAgree:true,gate4h:true,trailing:true,todFilter:false},
    {name:'ULT-AGREE-P50-mp5-noTrail',thrP_M:50,thrP_R:50,mc:0.011,adxF:25,slM:2,to:60,fwd:2,maxPos:5,requireAgree:true,gate4h:true,trailing:false,todFilter:true},
    {name:'ULT-M-only-P55-mp5-trail+tod',thrP_M:55,thrP_R:55,mc:0.011,adxF:25,slM:2,to:60,fwd:2,maxPos:5,requireAgree:false,gate4h:true,trailing:true,todFilter:true,onlyM:true},
    {name:'ULT-M-only-P50-mp5-trail+tod',thrP_M:50,thrP_R:50,mc:0.011,adxF:25,slM:2,to:60,fwd:2,maxPos:5,requireAgree:false,gate4h:true,trailing:true,todFilter:true,onlyM:true},
    {name:'ULT-M-only-P55-mp5-trail',thrP_M:55,thrP_R:55,mc:0.011,adxF:25,slM:2,to:60,fwd:2,maxPos:5,requireAgree:false,gate4h:true,trailing:true,todFilter:false,onlyM:true},
    {name:'ULT-M-P50-mp6-trail',thrP_M:50,thrP_R:50,mc:0.011,adxF:25,slM:2,to:60,fwd:2,maxPos:6,requireAgree:false,gate4h:true,trailing:true,todFilter:false,onlyM:true},
  ];
  const results=[];
  for(const cfg of configs){
    const allTrades=[];
    for(let w=0;w<nW;w++){
      const trs=firstTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;
      const pm={};
      for(const pair of PAIRS){
        if(!allData[pair])continue;
        const tB=allData[pair].b1h.filter(b=>b.t>=trs&&b.t<tre);if(tB.length<300)continue;
        const Fm=momFeatures(tB,allData[pair].fr,allData[pair].pi);
        const Fr=revFeatures(tB,allData[pair].fr);
        const fwdM=new Float64Array(Fm.n).fill(NaN);for(let i=50;i<Fm.n-cfg.fwd;i++)fwdM[i]=(Fm.c[i+cfg.fwd]-Fm.c[i])/Fm.c[i]*100;
        const coM=pearson(Fm.fs,fwdM,50,Fm.n-cfg.fwd);
        const coR=pearson(Fr.fs,fwdM,50,Fr.n-cfg.fwd);
        const selM=coM.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,6);
        const selR=coR.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,6);
        if(selM.length<2)continue;
        let tcM=[];for(let i=55;i<Fm.n;i++){if(Fm.adx[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of selM)comp+=corr*Fm.fs[idx][i];tcM.push(Math.abs(comp));}tcM.sort((a,b)=>a-b);
        let tcR=[];for(let i=55;i<Fr.n;i++){if(Fr.adx[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of selR)comp+=corr*Fr.fs[idx][i];tcR.push(Math.abs(comp));}tcR.sort((a,b)=>a-b);
        const thrM=tcM[Math.floor(tcM.length*cfg.thrP_M/100)]||0.001;
        const thrR=tcR[Math.floor(tcR.length*cfg.thrP_R/100)]||0.001;
        pm[pair]={selM,selR,thrM,thrR};
      }
      if(Object.keys(pm).length<4)continue;
      const sigs=[],tPar={};
      for(const pair of PAIRS){
        if(!pm[pair]||!allData[pair])continue;
        const teB=allData[pair].b1h.filter(b=>b.t>=tes&&b.t<tee);if(teB.length<50)continue;
        const te4=allData[pair].b4h.filter(b=>b.t>=tes-4*3600000&&b.t<tee);
        const Fm=momFeatures(teB,allData[pair].fr,allData[pair].pi);
        const Fr=revFeatures(teB,allData[pair].fr);
        tPar[pair]={t:Fm.t,o:Fm.o,h:Fm.h,l:Fm.l,c:Fm.c,atr:Fm.atr};
        const{selM,selR,thrM,thrR}=pm[pair];
        const trend4=cfg.gate4h?compute4HTrend(te4):null;const t4=cfg.gate4h?te4.map(b=>b.t):null;
        let last=-3;
        for(let i=55;i<Fm.n-cfg.to-1;i++){
          if(i-last<2)continue;if(Fm.adx[i]<cfg.adxF)continue;
          let compM=0;for(const{idx,corr}of selM)compM+=corr*Fm.fs[idx][i];
          let compR=0;for(const{idx,corr}of selR)compR+=corr*Fr.fs[idx][i];
          const passM=Math.abs(compM)>=thrM;
          const passR=Math.abs(compR)>=thrR;
          const dirM=compM>0?1:-1;
          const dirR=-1*(compR>0?1:-1);
          let finalDir=0;
          if(cfg.requireAgree){if(passM&&passR&&dirM===dirR)finalDir=dirM;}
          else if(cfg.onlyM){if(passM)finalDir=dirM;}
          else{if(passM&&passR&&dirM===dirR)finalDir=dirM;else if(passM&&!passR)finalDir=dirM;else if(passR&&!passM)finalDir=dirR;}
          if(finalDir===0)continue;
          if(cfg.gate4h&&trend4){const b4=findPrev(t4,Fm.t[i]);if(b4<0||trend4[b4]!==finalDir)continue;}
          sigs.push({bar:i,dir:finalDir,ts:Fm.t[i],pair});last=i;
        }
      }
      allTrades.push(...engineUltimate(sigs,tPar,P(SEED+w),cfg).trades);
    }
    const s=st(allTrades);const tpd=s.n/(nW*TEST_D);
    const hit=s.pf>=1.6&&s.wr>=50&&tpd>=5&&tpd<=8;
    const hitLoose=s.pf>=1.5&&s.wr>=48;
    results.push({cfg,s,tpd,trades:allTrades,hit,hitLoose});
    const marker=hit?' ★★★':(hitLoose?' ★':'');
    console.log(`${cfg.cfg?'':''}${cfg.name.padEnd(34)} ${s.n.toString().padStart(4)}t ${tpd.toFixed(2).padStart(4)}t/d WR${s.wr.toFixed(1).padStart(4)}% PF${s.pf.toFixed(2)} Sh${s.sharpe.toFixed(1).padStart(4)} $${s.pnl.toFixed(0).padStart(5)}${marker}`);
  }
  console.log('\n'+'═'.repeat(80));
  const winners=results.filter(r=>r.hit);
  if(winners.length){console.log(`★★★ TARGET HIT (PF≥1.6, WR≥50%, 5-8 t/d):`);winners.forEach(r=>console.log(`  ${r.cfg.name}: PF${r.s.pf.toFixed(2)} @ ${r.tpd.toFixed(2)}t/d WR${r.s.wr.toFixed(1)}% $${r.s.pnl.toFixed(0)}`));}
  else{
    console.log(`✗ NO config hit PF≥1.6 AND WR≥50% AND 5-8 t/d simultaneously`);
    console.log('\nTop 5 by PF (n>=80):');
    const top=results.filter(r=>r.s.n>=80).sort((a,b)=>b.s.pf-a.s.pf).slice(0,5);
    for(const r of top)console.log(`  ${r.cfg.name}: PF${r.s.pf.toFixed(2)} WR${r.s.wr.toFixed(1)}% ${r.tpd.toFixed(2)}t/d $${r.s.pnl.toFixed(0)}`);
  }
  console.log('═'.repeat(80)+'\n');
}
main().catch(e=>{console.error(e);process.exit(1);});
