#!/usr/bin/env node
'use strict';
// ANGLE 2 — MAKER-ONLY EXECUTION
// Apply to V34-dyn: entry as limit order at signal bar's close, wait up to 3 bars for fill
// Fee model: maker fee 0.0002 (Binance default) or -0.0001 (VIP rebate) instead of taker 0.0005
// If limit doesn't fill in 3 bars → skip trade (no cross-spread)
//
// Fill logic: signal at bar i, price ref = signal_close
//   LONG:  fill if any bar i+1..i+3 has low <= signal_close
//   SHORT: fill if any bar i+1..i+3 has high >= signal_close
//
// This is realistic because at signal, we observe current price and place LIMIT at mid/bid.
// Orders only fill on pullback to our level.

const fs=require('fs');
const path=require('path');
const https=require('https');

const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT'];
const KLINES_DIR='/tmp/binance-klines-1m';
const METRICS_DIR='/tmp/binance-metrics';
const INIT_CAP=500,POS_SIZE_BASE=2500,SEED=314159265;
const CLUSTERS={BTCUSDT:'L1',ETHUSDT:'L1',BNBUSDT:'L1',SOLUSDT:'L1alt',AVAXUSDT:'L1alt',XRPUSDT:'alt',ADAUSDT:'alt',DOGEUSDT:'meme'};

function P(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function hg(u){return new Promise((r,j)=>{https.get(u,s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}

function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const start=ct[0].startsWith('open_time')?1:0;for(let i=start;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}

function aggTo1h(b1m){const out=[];let start=0;while(start<b1m.length&&(b1m[start][0]%3600000)!==0)start++;for(let i=start;i<b1m.length;i+=60){const grp=b1m.slice(i,i+60);if(grp.length<60)break;let h=-Infinity,l=Infinity,vol=0,qv=0,count=0,tbv=0,imbSum=0,maxAvg=0,imbs=[];for(const b of grp){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];vol+=b[5];qv+=b[7];count+=b[8];tbv+=b[9];const imb=b[5]>0?(2*b[9]-b[5])/b[5]:0;imbs.push(imb);imbSum+=imb;const avg=b[8]>0?b[7]/b[8]:0;if(avg>maxAvg)maxAvg=avg;}const o=grp[0][1],c=grp[grp.length-1][4],tsv=vol-tbv;const ti=vol>0?(tbv-tsv)/vol:0;const mi=imbSum/60;const vi=imbs.reduce((a,x)=>a+(x-mi)**2,0)/60;const dc=imbs.filter(x=>Math.sign(x)===Math.sign(ti)).length/60;out.push({t:grp[0][0],o,h,l,c,v:vol,qv,cnt:count,tbv,tsv,ti,apm:count/60,lts:maxAvg,vi,mi,dc});}return out;}

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

function buildV34Features(b1h,metrics,fr,piKl){
  const n=b1h.length;
  const o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);
  const ti=new Float64Array(n),apm=new Float64Array(n),lts=new Float64Array(n),vi=new Float64Array(n),mi=new Float64Array(n),dc=new Float64Array(n),tbv=new Float64Array(n),tsv=new Float64Array(n);
  for(let i=0;i<n;i++){const b=b1h[i];t[i]=b.t;o[i]=b.o;h[i]=b.h;l[i]=b.l;c[i]=b.c;v[i]=b.v;ti[i]=b.ti;apm[i]=b.apm;lts[i]=b.lts;vi[i]=b.vi;mi[i]=b.mi;dc[i]=b.dc;tbv[i]=b.tbv;tsv[i]=b.tsv;}
  const atr2=at(h,l,c),adx2=ax(h,l,c),mc=mcd(c),e9=em(c,9),e21=em(c,21),e50=em(c,50),r14=rs(c,14),r7=rs(c,7),bbd=bb(c,20,2);
  const vsma=sm(v,20),apmSma=sm(apm,20),ltsSma=sm(lts,50);
  const ofi4h=new Float64Array(n);for(let i=0;i<n;i++){let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=tbv[j]-tsv[j];ofi4h[i]=s;}
  const frt=fr.map(f=>+f.fundingTime),frr=fr.map(f=>parseFloat(f.fundingRate));
  function gfr(bt){let lo=0,hi=frt.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(frt[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?frr[b]:0;}
  const piT=piKl.map(k=>+k[0]),piC=piKl.map(k=>+k[4]);
  function gB(bt){let lo=0,hi=piT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(piT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}return b>=0?piC[b]:0;}
  function gBz(bt){let lo2=0,hi2=piT.length-1,b=-1;while(lo2<=hi2){const m=(lo2+hi2)>>1;if(piT[m]<=bt){b=m;lo2=m+1;}else hi2=m-1;}if(b<50)return 0;const w=piC.slice(b-49,b+1),mn=w.reduce((a,x)=>a+x,0)/w.length,sd=Math.sqrt(w.reduce((a,x)=>a+(x-mn)**2,0)/w.length);return sd>0?(piC[b]-mn)/sd:0;}
  const mT=metrics.map(x=>x.t);
  function gM(bt,lbMin){let lo=0,hi=mT.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(mT[m]<=bt){b=m;lo=m+1;}else hi=m-1;}if(b<0)return null;const lb=Math.floor(lbMin/5);return{cur:metrics[b],prev:(b-lb>=0?metrics[b-lb]:null)};}
  const fs2=[],nm=[];const F=(n2,fn)=>{const a=new Float64Array(n);for(let i=50;i<n;i++){const x=fn(i);a[i]=isNaN(x)||!isFinite(x)?0:x;}fs2.push(a);nm.push(n2);};
  F('RSI14',i=>(50-r14[i])/50);F('RSI7',i=>(50-r7[i])/50);F('MACDh',i=>mc.hist[i]/(atr2[i]||1));F('MACDs',i=>i>0?(mc.hist[i]-mc.hist[i-1])/(atr2[i]||1):0);F('BBpos',i=>!isNaN(bbd.up[i])&&bbd.up[i]!==bbd.dn[i]?0.5-(c[i]-bbd.dn[i])/(bbd.up[i]-bbd.dn[i]):0);F('BBw',i=>!isNaN(bbd.up[i])&&bbd.mid[i]?(bbd.up[i]-bbd.dn[i])/bbd.mid[i]:0);F('ADXv',i=>(adx2.adx[i]-25)/25);F('E9_21',i=>(e9[i]-e21[i])/(atr2[i]||1));F('E21_50',i=>(e21[i]-e50[i])/(atr2[i]||1));
  F('Ret1',i=>i>=1?(c[i]-c[i-1])/c[i-1]*100:0);F('Ret3',i=>i>=3?(c[i]-c[i-3])/c[i-3]*100:0);F('Ret6',i=>i>=6?(c[i]-c[i-6])/c[i-6]*100:0);F('Ret12',i=>i>=12?(c[i]-c[i-12])/c[i-12]*100:0);
  F('VolR',i=>vsma[i]>0?v[i]/vsma[i]-1:0);F('ClsP',i=>h[i]!==l[i]?(c[i]-l[i])/(h[i]-l[i])-0.5:0);
  F('FR',i=>-gfr(t[i])*1000);F('HrSin',i=>Math.sin(new Date(t[i]).getUTCHours()/24*2*Math.PI));F('Basis',i=>-gB(t[i])*10000);F('BasisZ',i=>-gBz(t[i]));F('BasisVsFR',i=>(-gB(t[i])*10000)+(-gfr(t[i])*1000));
  F('TakerImb',i=>ti[i]);F('TakerImb4',i=>{let s=0;for(let j=Math.max(0,i-3);j<=i;j++)s+=ti[j];return s/4;});F('OFI4h',i=>ofi4h[i]/(vsma[i]*4||1));F('TradeInt',i=>apmSma[i]>0?apm[i]/apmSma[i]-1:0);F('TakeTox',i=>vi[i]);F('DirCons',i=>dc[i]-0.5);
  F('OIchg1h',i=>{const m=gM(t[i],60);if(!m||!m.prev||m.prev.oi===0)return 0;return(m.cur.oi-m.prev.oi)/m.prev.oi*100;});F('OIchg4h',i=>{const m=gM(t[i],240);if(!m||!m.prev||m.prev.oi===0)return 0;return(m.cur.oi-m.prev.oi)/m.prev.oi*100;});F('TopPosLSR',i=>{const m=gM(t[i],0);if(!m||m.cur.topPos<=0)return 0;return(1/m.cur.topPos-1);});F('LSAcct',i=>{const m=gM(t[i],0);if(!m||m.cur.lsAcct<=0)return 0;return(1/m.cur.lsAcct-1);});F('MetaTaker',i=>{const m=gM(t[i],0);if(!m||m.cur.taker<=0)return 0;return Math.log(m.cur.taker);});
  return{fs:fs2,nm,n,adx:adx2.adx,atr:atr2,t,o,h,l,c,v};
}

function pearson(fs,fwd,s,e){const co=[];for(let f=0;f<fs.length;f++){let sx=0,sy=0,sxy=0,sx2=0,sy2=0,cnt=0;for(let i=s;i<e;i++){const x=fs[f][i],y=fwd[i];if(isNaN(x)||isNaN(y))continue;sx+=x;sy+=y;sxy+=x*y;sx2+=x*x;sy2+=y*y;cnt++;}if(cnt<80){co.push(0);continue;}const num=cnt*sxy-sx*sy,den=Math.sqrt((cnt*sx2-sx*sx)*(cnt*sy2-sy*sy));co.push(den>0?num/den:0);}return co;}

function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,sharpe:0,mdd:0,filled:0,skipped:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));const byDay={};for(const x of t){byDay[x.date]=(byDay[x.date]||0)+x.pnl;}const dR=Object.values(byDay);const mD=dR.reduce((a,x)=>a+x,0)/dR.length;const vD=dR.reduce((a,x)=>a+(x-mD)**2,0)/dR.length;const sharpe=vD>0?mD/Math.sqrt(vD)*Math.sqrt(365):0;let cum=0,pk=0,mdd=0;for(const x of t){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,sharpe,mdd};}

// Maker engine: limit order at signal close; wait N bars for fill
// FEE_MAKER = 0.0002 (default maker, or 0 if VIP+BNB discount, or -0.0001 if VIP rebate)
function makerEngine(sigs,parsed,prng,cfg){
  let cap=INIT_CAP,pk=INIT_CAP;const trades=[];let nFilled=0,nSkipped=0;
  const slots=new Array(cfg.maxPos).fill(null);
  const FEE_M=cfg.feeMaker,FEE_T=0.0005,SLIP_SL=0.0002;
  function cls(si,j,reason){const pos=slots[si];const pd=parsed[pos.pair];let ep2;
    if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);
    else if(reason==='TP')ep2=pos.tpP;  // TP is maker (limit exit)
    else ep2=pd.c[j];
    const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;
    // Entry is maker, exit: TP=maker, SL=taker, TO=market (taker)
    const feeE=pos.sz*FEE_M, feeX=pos.sz*(reason==='TP'?FEE_M:FEE_T);
    cap+=g-feeE-feeX;pk=Math.max(pk,cap);
    trades.push({dir:pos.dir,pnl:g-feeE-feeX,type:reason,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10),sz:pos.sz});slots[si]=null;}
  function advance(upToTs){for(let si=0;si<cfg.maxPos;si++){const pos=slots[si];if(!pos)continue;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upToTs;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){cls(si,j,'SL');break;}if(hT){cls(si,j,'TP');break;}pos.nc=j+1;}if(slots[si]&&slots[si].nc>slots[si].exp){cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}}
  sigs.sort((a,b)=>a.ts-b.ts);
  for(const sig of sigs){if(cap<=0)break;const d=parsed[sig.pair];const sb=sig.bar;if(sb+cfg.fillBars>=d.c.length)continue;
    // MAKER FILL CHECK: limit placed at signal close (or mid)
    const limitPrice=d.c[sb];  // post limit at signal bar close
    let fillBar=-1;
    for(let j=sb+1;j<=Math.min(sb+cfg.fillBars,d.c.length-1);j++){
      if(sig.dir===1){if(d.l[j]<=limitPrice){fillBar=j;break;}}
      else{if(d.h[j]>=limitPrice){fillBar=j;break;}}
    }
    if(fillBar===-1){nSkipped++;continue;}
    nFilled++;
    advance(d.t[fillBar]);
    let freeSlot=-1;const clCnt={};for(let si=0;si<cfg.maxPos;si++)if(slots[si])clCnt[CLUSTERS[slots[si].pair]]=(clCnt[CLUSTERS[slots[si].pair]]||0)+1;
    for(let si=0;si<cfg.maxPos;si++){if(slots[si])continue;let conflict=false;for(let sj=0;sj<cfg.maxPos;sj++)if(slots[sj]&&slots[sj].pair===sig.pair){conflict=true;break;}if(conflict)continue;const cl=CLUSTERS[sig.pair]||'o';if((clCnt[cl]||0)>=cfg.maxCluster)continue;freeSlot=si;break;}
    if(freeSlot===-1)continue;
    if(prng()>=0.85)continue; // slightly higher (maker fills pre-screened)
    if(cap<50)continue;
    const ep=limitPrice;
    const atrA=d.atr[sb],ap=atrA/ep;if(ap<=0||isNaN(ap))continue;
    const slPct=Math.max(0.003,Math.min(0.03,ap*cfg.slM)),tpPct=Math.max(0.005,Math.min(0.08,slPct*cfg.tpR));
    const sizeMult=cfg.dynSize?Math.max(0.5,Math.min(2.0,sig.conf)):1.0;
    const sz=POS_SIZE_BASE*sizeMult;
    slots[freeSlot]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-slPct):ep*(1+slPct),tpP:sig.dir===1?ep*(1+tpPct):ep*(1-tpPct),qty:sz/ep,eb:fillBar,exp:fillBar+cfg.to,nc:fillBar+1,sz};
  }
  advance(Infinity);for(let si=0;si<cfg.maxPos;si++){if(slots[si]){const pd=parsed[slots[si].pair];cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}
  return{trades,nFilled,nSkipped};
}

// Taker engine (baseline for comparison) — same as V34 original
function takerEngine(sigs,parsed,prng,cfg){
  let cap=INIT_CAP,pk=INIT_CAP;const trades=[];
  const slots=new Array(cfg.maxPos).fill(null);
  const FEE_E=0.0002,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_SL=0.0002;
  function cls(si,j,reason){const pos=slots[si];const pd=parsed[pos.pair];let ep2;if(reason==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);else if(reason==='TP')ep2=pos.tpP;else ep2=pd.c[j];const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;const f=pos.sz*FEE_E+pos.sz*(reason==='TP'?FEE_TP:FEE_SL);cap+=g-f;pk=Math.max(pk,cap);trades.push({dir:pos.dir,pnl:g-f,type:reason,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10),sz:pos.sz});slots[si]=null;}
  function advance(upToTs){for(let si=0;si<cfg.maxPos;si++){const pos=slots[si];if(!pos)continue;const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.c.length&&j<=pos.exp&&pd.t[j]<=upToTs;j++){let hS,hT;if(pos.dir===1){hS=pd.l[j]<=pos.slP;hT=pd.h[j]>=pos.tpP;}else{hS=pd.h[j]>=pos.slP;hT=pd.l[j]<=pos.tpP;}if(hS&&hT)hT=false;if(hS){cls(si,j,'SL');break;}if(hT){cls(si,j,'TP');break;}pos.nc=j+1;}if(slots[si]&&slots[si].nc>slots[si].exp){cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}}
  sigs.sort((a,b)=>a.ts-b.ts);
  for(const sig of sigs){if(cap<=0)break;const d=parsed[sig.pair];const eb=sig.bar+1;if(eb>=d.c.length)continue;advance(d.t[eb]);let freeSlot=-1;const clCnt={};for(let si=0;si<cfg.maxPos;si++)if(slots[si])clCnt[CLUSTERS[slots[si].pair]]=(clCnt[CLUSTERS[slots[si].pair]]||0)+1;for(let si=0;si<cfg.maxPos;si++){if(slots[si])continue;let conflict=false;for(let sj=0;sj<cfg.maxPos;sj++)if(slots[sj]&&slots[sj].pair===sig.pair){conflict=true;break;}if(conflict)continue;const cl=CLUSTERS[sig.pair]||'o';if((clCnt[cl]||0)>=cfg.maxCluster)continue;freeSlot=si;break;}if(freeSlot===-1)continue;if(prng()>=0.75)continue;if(cap<50)continue;const ep=d.o[eb],atrA=d.atr[sig.bar],ap=atrA/d.c[sig.bar];if(ap<=0||isNaN(ap))continue;let sl=Math.max(0.003,Math.min(0.03,ap*cfg.slM)),tp=Math.max(0.005,Math.min(0.08,sl*cfg.tpR));const sizeMult=cfg.dynSize?Math.max(0.5,Math.min(2.0,sig.conf)):1.0;const sz=POS_SIZE_BASE*sizeMult;slots[freeSlot]={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-sl):ep*(1+sl),tpP:sig.dir===1?ep*(1+tp):ep*(1-tp),qty:sz/ep,eb,exp:eb+cfg.to,nc:eb+1,sz};}
  advance(Infinity);for(let si=0;si<cfg.maxPos;si++){if(slots[si]){const pd=parsed[slots[si].pair];cls(si,Math.min(slots[si].exp,pd.c.length-1),'TO');}}
  return{trades};
}

function runExperiment(engineFn,name,allData,cfg,firstTs,nW,TRAIN_D,TEST_D,STEP_D){
  const allTrades=[];let totalFilled=0,totalSkipped=0;
  for(let w=0;w<nW;w++){
    const trs=firstTs+w*STEP_D*864e5,tre=trs+TRAIN_D*864e5,tes=tre,tee=tes+TEST_D*864e5;
    const pm={};
    for(const pair of PAIRS){
      if(!allData[pair])continue;
      const tB=allData[pair].b1h.filter(b=>b.t>=trs&&b.t<tre);if(tB.length<300)continue;
      const tM=allData[pair].metrics.filter(m=>m.t>=trs-86400000&&m.t<tre);
      const F=buildV34Features(tB,tM,allData[pair].fr,allData[pair].pi);
      const fwd=new Float64Array(F.n).fill(NaN);for(let i=50;i<F.n-cfg.fwd;i++)fwd[i]=(F.c[i+cfg.fwd]-F.c[i])/F.c[i]*100;
      const co=pearson(F.fs,fwd,50,F.n-cfg.fwd);
      const sel=co.map((c2,i)=>({idx:i,corr:c2,abs:Math.abs(c2)})).filter(x=>x.abs>=cfg.mc).sort((a,b)=>b.abs-a.abs).slice(0,8);
      if(sel.length<2)continue;
      let tc=[];for(let i=55;i<F.n;i++){if(F.adx[i]<cfg.adxF)continue;let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];tc.push(Math.abs(comp));}
      tc.sort((a,b)=>a-b);const thr=tc[Math.floor(tc.length*cfg.thrP/100)]||0.001;
      pm[pair]={sel,thr};
    }
    if(Object.keys(pm).length<4)continue;
    const sigs=[],tPar={};
    for(const pair of PAIRS){
      if(!pm[pair]||!allData[pair])continue;
      const teB=allData[pair].b1h.filter(b=>b.t>=tes&&b.t<tee);if(teB.length<50)continue;
      const teM=allData[pair].metrics.filter(m=>m.t>=tes-86400000&&m.t<tee);
      const F=buildV34Features(teB,teM,allData[pair].fr,allData[pair].pi);
      tPar[pair]={t:F.t,o:F.o,h:F.h,l:F.l,c:F.c,atr:F.atr};
      const{sel,thr}=pm[pair];let last=-3;
      for(let i=55;i<F.n-cfg.to-1;i++){
        if(i-last<2)continue;if(F.adx[i]<cfg.adxF)continue;
        let comp=0;for(const{idx,corr}of sel)comp+=corr*F.fs[idx][i];
        const ac=Math.abs(comp);if(ac<thr)continue;
        const dir=comp>0?1:-1;const conf=Math.max(0.5,Math.min(2.0,ac/thr));
        sigs.push({bar:i,dir,ts:F.t[i],pair,conf});last=i;
      }
    }
    const r=engineFn(sigs,tPar,P(SEED+w),cfg);
    allTrades.push(...r.trades);
    if(r.nFilled)totalFilled+=r.nFilled;if(r.nSkipped)totalSkipped+=r.nSkipped;
  }
  return{trades:allTrades,totalFilled,totalSkipped};
}

async function main(){
  console.log('═'.repeat(80));console.log('ANGLE 2 — MAKER-ONLY EXECUTION on V34-dyn');console.log('═'.repeat(80));
  const allData={};
  for(const pair of PAIRS){process.stdout.write(pair+' ');const b1m=load1m(pair);if(!b1m||b1m.length<10000){console.log('[SKIP]');continue;}const b1h=aggTo1h(b1m);const metrics=loadMetrics(pair);const fTs=b1h[0].t,lTs=b1h[b1h.length-1].t;const fr=await gF(pair,fTs,lTs);const pi=await gPI(pair,'1h',fTs,lTs);allData[pair]={b1h,metrics,fr,pi};}
  console.log('\n');
  const firstTs=Math.min(...Object.values(allData).map(d=>d.b1h[0].t));
  const totalDays=274;const TRAIN_D=120,TEST_D=30,STEP_D=30;const nW=Math.floor((totalDays-TRAIN_D-TEST_D)/STEP_D)+1;
  const baseCfg={thrP:68,maxPos:3,maxCluster:2,slM:2,tpR:3,mc:0.011,adxF:22,to:84,fwd:2,dynSize:true};

  console.log('BASELINE — V34-dyn TAKER (current production):');
  const rT=runExperiment(takerEngine,'taker',allData,baseCfg,firstTs,nW,TRAIN_D,TEST_D,STEP_D);
  const sT=st(rT.trades);
  console.log(`  ${sT.n}t, ${(sT.n/(nW*TEST_D)).toFixed(2)} t/d, PF ${sT.pf.toFixed(2)}, WR ${sT.wr.toFixed(1)}%, Sharpe ${sT.sharpe.toFixed(1)}, DD $${sT.mdd.toFixed(0)}, PnL $${sT.pnl.toFixed(0)}`);

  console.log('\nMAKER variants (different fillBars + feeMaker):');
  const variants=[
    {fillBars:1,feeMaker:0.0002,label:'M-FB1-std'},
    {fillBars:2,feeMaker:0.0002,label:'M-FB2-std'},
    {fillBars:3,feeMaker:0.0002,label:'M-FB3-std'},
    {fillBars:5,feeMaker:0.0002,label:'M-FB5-std'},
    {fillBars:3,feeMaker:0.0,label:'M-FB3-zero'},       // Zero fee (VIP+BNB discount)
    {fillBars:3,feeMaker:-0.0001,label:'M-FB3-rebate'}, // VIP rebate
  ];
  const results=[];
  for(const v of variants){
    const cfg={...baseCfg,fillBars:v.fillBars,feeMaker:v.feeMaker};
    const r=runExperiment(makerEngine,v.label,allData,cfg,firstTs,nW,TRAIN_D,TEST_D,STEP_D);
    const s=st(r.trades);
    const fillRate=r.totalFilled/(r.totalFilled+r.totalSkipped);
    console.log(`  ${v.label.padEnd(15)} ${s.n}t ${(s.n/(nW*TEST_D)).toFixed(2)}t/d WR${s.wr.toFixed(1)}% PF${s.pf.toFixed(2)} Sh${s.sharpe.toFixed(1)} DD$${s.mdd.toFixed(0)} $${s.pnl.toFixed(0)} fill:${(fillRate*100).toFixed(0)}%`);
    results.push({v,trades:r.trades,s,tpd:s.n/(nW*TEST_D),fillRate});
  }

  // Best maker result
  const best=results.length?[...results].sort((a,b)=>b.s.pf-a.s.pf)[0]:null;
  if(best){
    console.log('\n'+'═'.repeat(80));
    console.log(`BEST MAKER: ${best.v.label} — PF ${best.s.pf.toFixed(2)} @ ${best.tpd.toFixed(2)} t/d`);
    console.log(`Delta vs taker baseline: PF ${((best.s.pf-sT.pf)/sT.pf*100).toFixed(1)}%, PnL $${(best.s.pnl-sT.pnl).toFixed(0)}, Sharpe Δ${(best.s.sharpe-sT.sharpe).toFixed(2)}`);
    fs.writeFileSync('/tmp/angle2-trades.json',JSON.stringify(best.trades));
    console.log('Saved to /tmp/angle2-trades.json');
  }
  console.log('═'.repeat(80)+'\n');
}
main().catch(e=>{console.error(e);process.exit(1);});
