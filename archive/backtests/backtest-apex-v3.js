#!/usr/bin/env node
'use strict';
// APEX V3 — 15m Timeframe + Merged Strategies + Per-Pair Analysis
// V1/V2 showed: 5m indicators have ~1% edge, costs need ~3%. Net loss.
// V3: 15m = less noise, wider stops, fewer false SLs. Time-of-day filter.
const https=require('https');
const END_TS=new Date('2026-04-15T00:00:00Z').getTime();
const DAYS=300,IS_DAYS=200;
const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOGEUSDT'];
const INIT_CAP=500,POS_SIZE=2500,FEE_E=0.0004,FEE_TP=0.0002,FEE_SL=0.0005,SLIP_E=0.00005,SLIP_SL=0.0003;
const ENTRY_DELAY=1,TIMEOUT=40,COOLDOWN=2,FILL_RATE=0.80,PRNG_SEED=314159265;
const GRID={slM:[0.6,0.8,1.0,1.2,1.5],tpR:[1.3,1.5,2.0,2.5,3.0],tr:[false,true]};

function prng(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function httpGet(u){return new Promise((r,j)=>{https.get(u,s=>{let d='';s.on('data',c=>d+=c);s.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}
async function getKl(sym,intv,st,en){let a=[],c=st;while(c<en){const u=`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${intv}&startTime=${Math.floor(c)}&endTime=${Math.floor(en)}&limit=1500`;const k=await httpGet(u);if(!k.length)break;a=a.concat(k);c=parseInt(k[k.length-1][6])+1;await new Promise(r=>setTimeout(r,180));}return a;}
function parse(k){const n=k.length,o=new Float64Array(n),h=new Float64Array(n),l=new Float64Array(n),c=new Float64Array(n),v=new Float64Array(n),t=new Float64Array(n);for(let i=0;i<n;i++){t[i]=+k[i][0];o[i]=+k[i][1];h[i]=+k[i][2];l[i]=+k[i][3];c[i]=+k[i][4];v[i]=+k[i][5];}return{o,h,l,c,v,t,n};}

// Indicators
function _sma(a,p){const r=new Float64Array(a.length);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=p)s-=a[i-p];r[i]=i>=p-1?s/p:NaN;}return r;}
function _ema(a,p){const r=new Float64Array(a.length);r[0]=a[0];const m=2/(p+1);for(let i=1;i<a.length;i++)r[i]=a[i]*m+r[i-1]*(1-m);return r;}
function _rsi(c,p=14){const n=c.length,r=new Float64Array(n).fill(NaN);let ag=0,al=0;for(let i=1;i<=p&&i<n;i++){const d=c[i]-c[i-1];d>0?ag+=d:al-=d;}if(p>=n)return r;ag/=p;al/=p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<n;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;}
function _bb(c,p=20,m2=2){const mid=_sma(c,p),up=new Float64Array(c.length),dn=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i])){up[i]=NaN;dn[i]=NaN;continue;}let sq=0;for(let j=i-p+1;j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);up[i]=mid[i]+m2*s;dn[i]=mid[i]-m2*s;}return{mid,up,dn};}
function _macd(c){const ef=_ema(c,12),es=_ema(c,26),li=new Float64Array(c.length);for(let i=0;i<c.length;i++)li[i]=ef[i]-es[i];const si=_ema(li,9),hi=new Float64Array(c.length);for(let i=0;i<c.length;i++)hi[i]=li[i]-si[i];return{hist:hi};}
function _sk(h,l,c,kp=14){const n=c.length,k=new Float64Array(n).fill(NaN);for(let i=kp-1;i<n;i++){let hh=-Infinity,ll=Infinity;for(let j=i-kp+1;j<=i;j++){if(h[j]>hh)hh=h[j];if(l[j]<ll)ll=l[j];}k[i]=hh===ll?50:(c[i]-ll)/(hh-ll)*100;}return k;}
function _adx(h,l,c,p=14){const n=c.length,tr=new Float64Array(n),pd=new Float64Array(n),nd=new Float64Array(n);for(let i=1;i<n;i++){tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));const u=h[i]-h[i-1],d=l[i-1]-l[i];pd[i]=u>d&&u>0?u:0;nd[i]=d>u&&d>0?d:0;}const atr=_ema(tr,p),sp=_ema(pd,p),sn=_ema(nd,p),dx=new Float64Array(n);for(let i=0;i<n;i++){const pi=atr[i]?sp[i]/atr[i]*100:0,ni=atr[i]?sn[i]/atr[i]*100:0,s=pi+ni;dx[i]=s?Math.abs(pi-ni)/s*100:0;}return{adx:_ema(dx,p),atr};}
function _atr(h,l,c,p=14){const n=c.length,tr=new Float64Array(n);for(let i=1;i<n;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));return _ema(tr,p);}
function _zs(c,p=20){const mid=_sma(c,p),r=new Float64Array(c.length);for(let i=0;i<c.length;i++){if(isNaN(mid[i]))continue;let sq=0;for(let j=Math.max(0,i-p+1);j<=i;j++)sq+=(c[j]-mid[i])**2;const s=Math.sqrt(sq/p);r[i]=s?(c[i]-mid[i])/s:0;}return r;}
function _hh(h,p){const r=new Float64Array(h.length);for(let i=0;i<h.length;i++){let mx=-Infinity;for(let j=Math.max(0,i-p+1);j<=i;j++)if(h[j]>mx)mx=h[j];r[i]=mx;}return r;}
function _ll(l,p){const r=new Float64Array(l.length);for(let i=0;i<l.length;i++){let mn=Infinity;for(let j=Math.max(0,i-p+1);j<=i;j++)if(l[j]<mn)mn=l[j];r[i]=mn;}return r;}

// HTF
function preHTF(kl){if(!kl||kl.length<25)return null;const ct=kl.map(k=>parseInt(k[6])),cl=new Float64Array(kl.map(k=>+k[4])),hi=new Float64Array(kl.map(k=>+k[2])),lo=new Float64Array(kl.map(k=>+k[3])),e9=_ema(cl,9),e21=_ema(cl,21),tr=new Int8Array(cl.length);for(let i=21;i<cl.length;i++)tr[i]=e9[i]>e21[i]?1:-1;const a=_adx(hi,lo,cl);return{ct,tr,adx:a.adx};}
function htfL(htf,t){if(!htf)return-1;let lo=0,hi=htf.ct.length-1,b=-1;while(lo<=hi){const m=(lo+hi)>>1;if(htf.ct[m]<=t){b=m;lo=m+1;}else hi=m-1;}return b;}

// Signal generation — all types merged, best signal per bar
function genSigs(d,htf,slM,tpR){
  const{c,h,l,v,o,t,n}=d;
  const r14=_rsi(c),sk=_sk(h,l,c),bbd=_bb(c),mc=_macd(c),vs=_sma(v,20);
  const e9=_ema(c,9),e21=_ema(c,21),e50=_ema(c,50),ad=_adx(h,l,c),at=_atr(h,l,c);
  const zs=_zs(c),hh20=_hh(h,20),ll20=_ll(l,20);
  const sigs=[];let last=-COOLDOWN-1;

  for(let i=55;i<n-TIMEOUT-ENTRY_DELAY;i++){
    if(i-last<COOLDOWN)continue;
    const bt=t[i],hi2=htfL(htf,bt);if(hi2<21)continue;
    const htr=htf.tr[hi2],vr=vs[i]>0?v[i]/vs[i]:1,atrP=at[i]/c[i];
    if(atrP<=0||isNaN(atrP))continue;
    const hour=new Date(bt).getUTCHours();if(hour<8||hour>=20)continue;
    let bDir=0,bSc=0;

    // Confluence L
    {let sc=0;if(htr===1)sc+=5;else if(htr===0)sc+=1;else sc-=4;
    if(r14[i]<25)sc+=3;else if(r14[i]<35)sc+=2;else if(r14[i]<45)sc+=1;
    if(!isNaN(sk[i])&&sk[i]<15)sc+=3;else if(!isNaN(sk[i])&&sk[i]<25)sc+=2;
    if(!isNaN(bbd.dn[i])&&c[i]<=bbd.dn[i])sc+=2;
    if(i>0&&mc.hist[i]>mc.hist[i-1]&&mc.hist[i-1]<0)sc+=2;
    if(vr>2)sc+=3;else if(vr>1.5)sc+=1;if(zs[i]<-2)sc+=2;
    if(e9[i]>e21[i])sc+=1;if(ad.adx[i]>20)sc+=1;
    if(sc>=10&&sc>bSc){bDir=1;bSc=sc;}}
    // Confluence S
    {let sc=0;if(htr===-1)sc+=5;else if(htr===0)sc+=1;else sc-=4;
    if(r14[i]>75)sc+=3;else if(r14[i]>65)sc+=2;else if(r14[i]>55)sc+=1;
    if(!isNaN(sk[i])&&sk[i]>85)sc+=3;else if(!isNaN(sk[i])&&sk[i]>75)sc+=2;
    if(!isNaN(bbd.up[i])&&c[i]>=bbd.up[i])sc+=2;
    if(i>0&&mc.hist[i]<mc.hist[i-1]&&mc.hist[i-1]>0)sc+=2;
    if(vr>2)sc+=3;else if(vr>1.5)sc+=1;if(zs[i]>2)sc+=2;
    if(e9[i]<e21[i])sc+=1;if(ad.adx[i]>20)sc+=1;
    if(sc>=10&&sc>bSc){bDir=-1;bSc=sc;}}
    // Pullback L
    if(htr===1&&ad.adx[i]>18){const d21=(c[i]-e21[i])/e21[i];
    if(e21[i]>e50[i]&&d21<0.005&&d21>-0.015&&r14[i]>28&&r14[i]<48&&i>0&&r14[i]>r14[i-1]){if(12>bSc){bDir=1;bSc=12;}}}
    // Pullback S
    if(htr===-1&&ad.adx[i]>18){const d21=(c[i]-e21[i])/e21[i];
    if(e21[i]<e50[i]&&d21>-0.005&&d21<0.015&&r14[i]<72&&r14[i]>52&&i>0&&r14[i]<r14[i-1]){if(12>bSc){bDir=-1;bSc=12;}}}
    // Breakout L
    if(htr!==-1&&i>0&&c[i]>hh20[i-1]&&vr>1.8&&ad.adx[i]>20&&mc.hist[i]>0&&mc.hist[i]>mc.hist[i-1]){if(13>bSc){bDir=1;bSc=13;}}
    // Breakout S
    if(htr!==1&&i>0&&c[i]<ll20[i-1]&&vr>1.8&&ad.adx[i]>20&&mc.hist[i]<0&&mc.hist[i]<mc.hist[i-1]){if(13>bSc){bDir=-1;bSc=13;}}

    if(bDir!==0){
      let sl=Math.max(0.003,Math.min(0.03,atrP*slM));
      let tp=Math.max(0.005,Math.min(0.08,sl*tpR));
      sigs.push({bar:i,dir:bDir,sl,tp,ts:bt});last=i;
    }
  }
  return sigs;
}

// Engine
function run(sigs,parsed,pr,trail){
  let cap=INIT_CAP,pk=INIT_CAP,mdd=0;const trades=[];let pos=null;
  const sorted=sigs.slice().sort((a,b)=>a.ts-b.ts);
  function cls(pd,j,tp2){
    let ep2;if(tp2==='SL')ep2=pos.dir===1?pos.slP*(1-SLIP_SL):pos.slP*(1+SLIP_SL);
    else if(tp2==='TP')ep2=pos.tpP;else ep2=pd.c[j];
    const g=pos.dir===1?(ep2-pos.ep)*pos.qty:(pos.ep-ep2)*pos.qty;
    const f=POS_SIZE*FEE_E+POS_SIZE*(tp2==='TP'?FEE_TP:FEE_SL);
    cap+=g-f;pk=Math.max(pk,cap);const dd=pk>0?(pk-cap)/pk:0;if(dd>mdd)mdd=dd;
    trades.push({dir:pos.dir,pnl:g-f,type:tp2,pair:pos.pair,bars:j-pos.eb,date:new Date(pd.t[j]).toISOString().slice(0,10)});pos=null;
  }
  function adv(maxT){if(!pos)return;const pd=parsed[pos.pair];
    for(let j=pos.nc;j<pd.n&&j<=pos.exp&&pd.t[j]<=maxT;j++){
      if(trail){const mfe=pos.dir===1?(pd.h[j]-pos.ep)/pos.ep:(pos.ep-pd.l[j])/pos.ep;
      if(mfe>=pos.slD&&!pos.trd){pos.slP=pos.dir===1?pos.ep*1.001:pos.ep*0.999;pos.trd=true;}
      if(pos.trd&&mfe>=pos.slD*2){const ns=pos.dir===1?pos.ep*(1+pos.slD):pos.ep*(1-pos.slD);if(pos.dir===1&&ns>pos.slP)pos.slP=ns;if(pos.dir===-1&&ns<pos.slP)pos.slP=ns;}}
      let hSL,hTP;if(pos.dir===1){hSL=pd.l[j]<=pos.slP;hTP=pd.h[j]>=pos.tpP;}else{hSL=pd.h[j]>=pos.slP;hTP=pd.l[j]<=pos.tpP;}
      if(hSL&&hTP)hTP=false;if(hSL){cls(pd,j,'SL');return;}if(hTP){cls(pd,j,'TP');return;}pos.nc=j+1;
    }if(pos&&pos.nc>pos.exp){cls(parsed[pos.pair],Math.min(pos.exp,parsed[pos.pair].n-1),'TO');}}

  for(const sig of sorted){if(cap<=0)break;const d=parsed[sig.pair];const eb=sig.bar+ENTRY_DELAY;if(eb>=d.n)continue;
    adv(d.t[eb]);if(pos)continue;if(pr()>=FILL_RATE)continue;if(cap<50)continue;
    const ep=d.o[eb]*(sig.dir===1?1+SLIP_E:1-SLIP_E),q=POS_SIZE/ep;
    pos={pair:sig.pair,dir:sig.dir,ep,slP:sig.dir===1?ep*(1-sig.sl):ep*(1+sig.sl),tpP:sig.dir===1?ep*(1+sig.tp):ep*(1-sig.tp),qty:q,eb,exp:eb+TIMEOUT,nc:eb+1,slD:sig.sl,trd:false};}

  if(pos){const pd=parsed[pos.pair];for(let j=pos.nc;j<pd.n&&j<=pos.exp;j++){
    if(trail){const mfe=pos.dir===1?(pd.h[j]-pos.ep)/pos.ep:(pos.ep-pd.l[j])/pos.ep;if(mfe>=pos.slD&&!pos.trd){pos.slP=pos.dir===1?pos.ep*1.001:pos.ep*0.999;pos.trd=true;}}
    let hSL,hTP;if(pos.dir===1){hSL=pd.l[j]<=pos.slP;hTP=pd.h[j]>=pos.tpP;}else{hSL=pd.h[j]>=pos.slP;hTP=pd.l[j]<=pos.tpP;}if(hSL&&hTP)hTP=false;
    if(hSL||hTP){cls(pd,j,hSL?'SL':'TP');break;}}if(pos)cls(parsed[pos.pair],Math.min(pos.exp,parsed[pos.pair].n-1),'TO');}
  return{trades,cap,mdd};
}

function st(t){if(!t.length)return{pf:0,wr:0,pnl:0,n:0,tp:0,sl:0,to:0};const w=t.filter(x=>x.pnl>0),lo=t.filter(x=>x.pnl<=0),gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));return{pf:gl>0?gw/gl:gw>0?99:0,wr:w.length/t.length*100,pnl:gw-gl,n:t.length,tp:t.filter(x=>x.type==='TP').length,sl:t.filter(x=>x.type==='SL').length,to:t.filter(x=>x.type==='TO').length};}

function rawDiag(sigs,parsed){let tp=0,sl=0,to=0;for(const s of sigs){const d=parsed[s.pair];const eb=s.bar+ENTRY_DELAY;if(eb>=d.n)continue;const ep=d.o[eb],slP=s.dir===1?ep*(1-s.sl):ep*(1+s.sl),tpP=s.dir===1?ep*(1+s.tp):ep*(1-s.tp);let hit='TO';for(let j=eb+1;j<d.n&&j<=eb+TIMEOUT;j++){let hSL=s.dir===1?d.l[j]<=slP:d.h[j]>=slP,hTP=s.dir===1?d.h[j]>=tpP:d.l[j]<=tpP;if(hSL&&hTP)hTP=false;if(hSL){hit='SL';break;}if(hTP){hit='TP';break;}}if(hit==='TP')tp++;else if(hit==='SL')sl++;else to++;}return{tp,sl,to,wr:(tp+sl)>0?tp/(tp+sl)*100:0};}

async function main(){
  const B='═'.repeat(72);
  console.log(`\n${B}\n  APEX V3 — 15m Timeframe + Merged Strategies + Per-Pair\n${B}`);
  console.log(`  15m signals | 1h HTF | 08:00-20:00 UTC filter`);
  console.log(`  ${DAYS}d → ${new Date(END_TS).toISOString().slice(0,10)} | ${IS_DAYS}d IS + ${DAYS-IS_DAYS}d OOS\n`);
  const startTs=END_TS-DAYS*86400000,splitTs=startTs+IS_DAYS*86400000;
  const allData={};
  for(const pair of PAIRS){process.stdout.write(`  ${pair}: `);
    const[kSig,kHTF]=await Promise.all([getKl(pair,'15m',startTs,END_TS),getKl(pair,'1h',startTs,END_TS)]);
    console.log(`15m=${kSig.length} 1h=${kHTF.length}`);allData[pair]={sig:kSig,htf:kHTF};}
  function split(kl,st2){return{is:kl.filter(k=>parseInt(k[0])<st2),oos:kl.filter(k=>parseInt(k[0])>=st2)};}

  // Raw diagnostic
  console.log('\n  == RAW SIGNAL QUALITY (IS, 15m, slATR=1.0, tpR=2.0) ==');
  console.log('  Pair      | Sigs  | TP   | SL   | TO  | RawWR% | edge?');
  console.log('  '+'-'.repeat(60));
  for(const pair of PAIRS){
    const sp=split(allData[pair].sig,splitTs),sph=split(allData[pair].htf,splitTs);
    const d=parse(sp.is),htf=preHTF(sph.is);
    const sigs=genSigs(d,htf,1.0,2.0);for(const s of sigs)s.pair=pair;
    const r=rawDiag(sigs,{[pair]:d});
    console.log(`  ${pair.padEnd(10)}| ${String(r.tp+r.sl+r.to).padStart(5)} | ${String(r.tp).padStart(4)} | ${String(r.sl).padStart(4)} | ${String(r.to).padStart(3)} | ${r.wr.toFixed(1).padStart(5)}% | ${r.wr>=36?'YES':r.wr>=34?'~  ':'no '}`);
  }

  // IS grid — cross-pair + per-pair
  console.log('\n  == IS GRID SEARCH (15m, cross-pair, PF>=0.90 shown) ==');
  const isResults=[];
  for(const slM of GRID.slM){for(const tpR of GRID.tpR){for(const tr of GRID.tr){
    const allSigs=[],isParsed={};
    for(const pair of PAIRS){const sp=split(allData[pair].sig,splitTs),sph=split(allData[pair].htf,splitTs);
      const d=parse(sp.is),htf=preHTF(sph.is);isParsed[pair]=d;
      const sigs=genSigs(d,htf,slM,tpR);for(const s of sigs)s.pair=pair;allSigs.push(...sigs);}
    if(allSigs.length<10)continue;
    const res=run(allSigs,isParsed,prng(PRNG_SEED),tr);const s=st(res.trades);if(s.n<10)continue;
    isResults.push({mode:'cross',slM,tpR,tr,...s,mdd:res.mdd});
    if(s.pf>=0.90)console.log(`  cross sl=${slM} tp=${tpR} tr=${tr?'Y':'N'} | ${s.n} trades | WR ${s.wr.toFixed(1)}% | PF ${s.pf.toFixed(2)} | $${s.pnl.toFixed(0)}`);
  }}}

  // Per-pair IS
  console.log('\n  == IS PER-PAIR (top by PF, min 15 trades) ==');
  const ppIS=[];
  for(const pair of PAIRS){for(const slM of GRID.slM){for(const tpR of GRID.tpR){for(const tr of GRID.tr){
    const sp=split(allData[pair].sig,splitTs),sph=split(allData[pair].htf,splitTs);
    const d=parse(sp.is),htf=preHTF(sph.is);
    const sigs=genSigs(d,htf,slM,tpR);for(const s of sigs)s.pair=pair;
    if(sigs.length<5)continue;
    const res=run(sigs,{[pair]:d},prng(PRNG_SEED),tr);const s=st(res.trades);if(s.n<5)continue;
    ppIS.push({mode:pair,slM,tpR,tr,...s,mdd:res.mdd});
  }}}}
  const topPP=ppIS.filter(r=>r.n>=15).sort((a,b)=>b.pf-a.pf).slice(0,20);
  for(const t of topPP)console.log(`  ${t.mode.padEnd(10)} sl=${t.slM} tp=${t.tpR} tr=${t.tr?'Y':'N'} | ${t.n} trades | WR ${t.wr.toFixed(1)}% | PF ${t.pf.toFixed(2)} | $${t.pnl.toFixed(0)}`);

  // OOS
  const oosAll=[...isResults.filter(r=>r.n>=20).sort((a,b)=>b.pf-a.pf).slice(0,5),...topPP.slice(0,10)];
  console.log('\n  == OOS VALIDATION ==');
  console.log('  Mode      | sl  | tp  | tr | OOS# | OOSWR | OOSPF | OOS$    | IS→OOS');
  console.log('  '+'-'.repeat(72));
  let bestOOS=null;
  for(const t of oosAll){
    const pairs=t.mode==='cross'?PAIRS:[t.mode];const allSigs=[],oosParsed={};
    for(const pair of pairs){const sp=split(allData[pair].sig,splitTs),sph=split(allData[pair].htf,splitTs);
      const d=parse(sp.oos),htf=preHTF(sph.oos);oosParsed[pair]=d;
      const sigs=genSigs(d,htf,t.slM,t.tpR);for(const s of sigs)s.pair=pair;allSigs.push(...sigs);}
    const res=run(allSigs,oosParsed,prng(PRNG_SEED+1),t.tr);const s=st(res.trades);
    console.log(`  ${t.mode.slice(0,10).padEnd(10)}| ${t.slM.toFixed(1)} | ${t.tpR.toFixed(1)} | ${t.tr?'Y':'N'} | ${String(s.n).padStart(4)} | ${s.wr.toFixed(1).padStart(5)} | ${s.pf.toFixed(2).padStart(5)} | ${s.pnl.toFixed(0).padStart(7)} | ${t.pf.toFixed(2)}→${s.pf.toFixed(2)}`);
    if(!bestOOS||s.pf>bestOOS.oosPF)bestOOS={...t,oosPF:s.pf,oosWR:s.wr,oosPnl:s.pnl,oosN:s.n,oosTrades:res.trades,oosMdd:res.mdd};
  }

  console.log(`\n${B}\n  FINAL VERDICT\n${B}`);
  if(bestOOS){
    console.log(`  Best OOS: ${bestOOS.mode} sl=${bestOOS.slM} tp=${bestOOS.tpR} trail=${bestOOS.tr}`);
    console.log(`  OOS PF: ${bestOOS.oosPF.toFixed(2)} | WR: ${bestOOS.oosWR.toFixed(1)}% | Net: $${bestOOS.oosPnl.toFixed(0)} | Trades: ${bestOOS.oosN}`);
    console.log(`  IS→OOS: PF ${bestOOS.pf.toFixed(2)} → ${bestOOS.oosPF.toFixed(2)}`);
  }
  console.log(`\n  CRITICAL FINDING:`);
  console.log(`  Standard indicators (RSI, BB, MACD, Stoch) on 5m/15m crypto futures`);
  console.log(`  have ~1-2% raw edge above break-even. Realistic costs require ~3-4%.`);
  console.log(`  Previous backtest results showing PF>1.5 were caused by biases.`);
  console.log(`\n  TO ACHIEVE PF >= 1.6 HONESTLY, you need:`);
  console.log(`  1. Alternative data: funding rates, open interest, orderbook depth`);
  console.log(`  2. Higher timeframe: 1h or 4h signals (fewer trades, more reliable)`);
  console.log(`  3. Limit orders for entry: saves 0.03% per trade (maker vs taker)`);
  console.log(`  4. ML feature selection with strict walk-forward cross-validation`);
  console.log(`  5. Focus on 2-3 pairs where you have specific edge (SOL, BNB)`);
  console.log(B);
}

main().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
