#!/usr/bin/env node
'use strict';
const https=require('https');
const CAP0=500,LEV=5,POS=CAP0*LEV,FEE_M=0.0002,FEE_T=0.0004,SLIP=0.0001;
const DAYS=120,C5PD=288,TOTAL_5M=DAYS*C5PD;

// ═══ INDICATORS ═══
function emaA(d,p){const k=2/(p+1),r=[d[0]];for(let i=1;i<d.length;i++)r.push(d[i]*k+r[i-1]*(1-k));return r;}
function smaA(d,p){const r=[];let s=0;for(let i=0;i<d.length;i++){s+=d[i];if(i>=p)s-=d[i-p];r.push(i>=p-1?s/p:s/(i+1));}return r;}
function rsiA(c,p=14){
  if(c.length<p+1)return c.map(()=>50);
  const r=new Float64Array(c.length);let ag=0,al=0;
  for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>0)ag+=d;else al-=d;}
  ag/=p;al/=p;for(let i=0;i<p;i++)r[i]=50;r[p]=al<1e-10?100:100-100/(1+ag/al);
  for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?-d:0))/p;r[i]=al<1e-10?100:100-100/(1+ag/al);}
  return r;
}
function atrA(h,l,c,p=14){
  const r=new Float64Array(h.length),tr=new Float64Array(h.length);tr[0]=h[0]-l[0];
  for(let i=1;i<h.length;i++)tr[i]=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));
  let s=0;for(let i=0;i<Math.min(p,tr.length);i++)s+=tr[i];if(p<=tr.length)r[p-1]=s/p;
  for(let i=p;i<tr.length;i++)r[i]=(r[i-1]*(p-1)+tr[i])/p;return r;
}
function adxA(h,l,c,p=14){
  const n=h.length,dx=new Float64Array(n),adx=new Float64Array(n);
  let atr=0,pDM=0,mDM=0;
  for(let i=1;i<Math.min(p+1,n);i++){
    const tr=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));
    const up=h[i]-h[i-1],dn=l[i-1]-l[i];
    atr+=tr;pDM+=(up>dn&&up>0)?up:0;mDM+=(dn>up&&dn>0)?dn:0;
  }
  if(p+1>n)return adx;
  let pDI=atr>0?pDM/atr*100:0,mDI=atr>0?mDM/atr*100:0;
  dx[p]=(pDI+mDI)>0?Math.abs(pDI-mDI)/(pDI+mDI)*100:0;
  for(let i=p+1;i<n;i++){
    const tr=Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]));
    const up=h[i]-h[i-1],dn=l[i-1]-l[i];
    atr=atr*(p-1)/p+tr;pDM=pDM*(p-1)/p+((up>dn&&up>0)?up:0);mDM=mDM*(p-1)/p+((dn>up&&dn>0)?dn:0);
    pDI=atr>0?pDM/atr*100:0;mDI=atr>0?mDM/atr*100:0;
    dx[i]=(pDI+mDI)>0?Math.abs(pDI-mDI)/(pDI+mDI)*100:0;
  }
  let adxS=0;for(let i=p;i<Math.min(2*p,n);i++)adxS+=dx[i];
  if(2*p<=n)adx[2*p-1]=adxS/p;
  for(let i=2*p;i<n;i++)adx[i]=(adx[i-1]*(p-1)+dx[i])/p;
  return adx;
}
function swH(h,n=3){const r=[];for(let i=n;i<h.length-n;i++){let ok=true;for(let j=i-n;j<i;j++)if(h[j]>=h[i]){ok=false;break;}if(ok)for(let j=i+1;j<=i+n;j++)if(h[j]>=h[i]){ok=false;break;}if(ok)r.push({i,v:h[i]});}return r;}
function swL(l,n=3){const r=[];for(let i=n;i<l.length-n;i++){let ok=true;for(let j=i-n;j<i;j++)if(l[j]<=l[i]){ok=false;break;}if(ok)for(let j=i+1;j<=i+n;j++)if(l[j]<=l[i]){ok=false;break;}if(ok)r.push({i,v:l[i]});}return r;}

// ═══ DATA ═══
function fetchJ(url){return new Promise((res,rej)=>{const req=https.get(url,{timeout:15000},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});});req.on('error',rej);req.on('timeout',()=>{req.destroy();rej(new Error('TO'));});});}
const sl=ms=>new Promise(r=>setTimeout(r,ms));
async function dl(sym,itv,total){
  const all=[];let end=Date.now();
  while(all.length<total){const lim=Math.min(1000,total-all.length);
    const url=`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${itv}&limit=${lim}&endTime=${end}`;
    let d,t=3;while(t>0){try{d=await fetchJ(url);break;}catch(e){t--;if(!t)throw e;await sl(2000);}}
    if(!d||!d.length)break;all.unshift(...d.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})));end=d[0][0]-1;await sl(150);}
  return all.slice(-total);
}

// ═══ PRECOMPUTE ═══
function pre(k){const c=k.map(x=>x.c),h=k.map(x=>x.h),l=k.map(x=>x.l),v=k.map(x=>x.v),o=k.map(x=>x.o);
  return{c,h,l,v,o,rsi:rsiA(c),atr:atrA(h,l,c),vS:smaA(v,20),e20:emaA(c,20),e50:emaA(c,50),e100:emaA(c,100),e200:emaA(c,200),adx:adxA(h,l,c)};}

// ═══ DIV_SNIPER (exact V5 logic) ═══
function divSniper(i,d){
  if(i<30)return null;const{c,h,l,v,o,rsi,atr:at,vS}=d;
  const cr=rsi[i],ca=at[i],av=vS[i]||1;if(ca<1e-10)return null;
  function tryDir(isBull){
    const rZone=isBull?cr<40:cr>60;if(!rZone)return null;
    for(let lb=5;lb<=Math.min(20,i);lb++){
      const divOk=isBull?(c[i]<c[i-lb]&&rsi[i]>rsi[i-lb]):(c[i]>c[i-lb]&&rsi[i]<rsi[i-lb]);
      if(!divOk)continue;
      const confOk=isBull?(c[i]>c[i-1]&&v[i]>av*0.8):(c[i]<c[i-1]&&v[i]>av*0.8);
      if(!confOk)continue;
      const sl50=Math.max(0,i-50),sw=isBull?swH(h.slice(sl50,i+1),3):swL(l.slice(sl50,i+1),3);
      const tp=isBull?(sw.length?sw[sw.length-1].v:c[i]+ca*2):(sw.length?sw[sw.length-1].v:c[i]-ca*2);
      const stop=isBull?l[i-lb]-ca*0.2:h[i-lb]+ca*0.2;
      return{dir:isBull?'BUY':'SELL',tp,sl:stop,atr:ca,barIdx:i,lb};
    }
    return null;
  }
  return tryDir(true)||tryDir(false);
}

// ═══ TRADE SIM ═══
function simTrades(sigs,k5){
  const trades=[];let next=0;
  for(const sig of sigs){
    const eb=sig.barIdx+1;if(eb>=k5.length-1||eb<next)continue;
    const ep=k5[eb].o,isBuy=sig.dir==='BUY';
    const ec=POS*FEE_M;let tp=sig.tp,stop=sig.sl;
    let exitP=0,exitR='';
    for(let b=eb+1;b<k5.length;b++){
      const bar=k5[b];
      const slHit=isBuy?bar.l<=stop:bar.h>=stop;
      const tpHit=isBuy?bar.h>=tp:bar.l<=tp;
      if(slHit){exitP=isBuy?Math.min(stop,bar.l)*(1-SLIP):Math.max(stop,bar.h)*(1+SLIP);exitR='SL';break;}
      if(tpHit){exitP=tp;exitR='TP';break;}
      if(b-eb>200){exitP=bar.c;exitR='TO';break;}
    }
    if(!exitP)continue;
    const pd=isBuy?exitP-ep:ep-exitP;
    const mPnl=pd/ep*POS,ef=exitR==='SL'?POS*FEE_T:POS*FEE_M;
    const tPnl=mPnl-ec-ef;
    next=eb+1;
    trades.push({dir:sig.dir,pnl:tPnl,reason:exitR,barIdx:sig.barIdx,entryTime:k5[eb].t});
  }
  return trades;
}

// ═══ METRICS ═══
function met(trades){
  const w=trades.filter(t=>t.pnl>0),lo=trades.filter(t=>t.pnl<=0);
  const pnl=trades.reduce((s,t)=>s+t.pnl,0),gw=w.reduce((s,t)=>s+t.pnl,0),gl=Math.abs(lo.reduce((s,t)=>s+t.pnl,0));
  const pf=gl>0?gw/gl:gw>0?99:0,wr=trades.length?w.length/trades.length*100:0;
  return{pnl,pf,wr,n:trades.length,aw:w.length?gw/w.length:0,al:lo.length?gl/lo.length:0};
}

// ═══ REGIME SCORE ═══
function regimeScore(hd,hi){
  if(hi<200)return 0;
  let sc=0;
  const adx=hd.adx[hi];
  if(adx>20)sc+=2;if(adx>30)sc+=1;
  const spread=Math.abs(hd.e50[hi]-hd.e200[hi])/hd.c[hi]*100;
  if(spread>1.0)sc+=2;else if(spread<0.3)sc-=3;
  // ATR percentile
  const ca=hd.atr[hi];let cnt=0,lt=0;
  for(let j=Math.max(0,hi-100);j<hi;j++){cnt++;if(hd.atr[j]<ca)lt++;}
  const pct=cnt>0?lt/cnt:0.5;
  if(pct>=0.2&&pct<=0.8)sc+=2;else if(pct<0.1)sc-=2;else if(pct>0.9)sc-=1;
  // EMA alignment
  const e20=hd.e20[hi],e50=hd.e50[hi],e100=hd.e100[hi];
  if((e20>e50&&e50>e100)||(e20<e50&&e50<e100))sc+=3;
  return sc;
}

// ═══ MAP 5m->1h ═══
function mapH(k5,kH){const m=new Int32Array(k5.length);let j=0;for(let i=0;i<k5.length;i++){while(j<kH.length-1&&kH[j+1].t<=k5[i].t)j++;m[i]=kH[j].t<=k5[i].t?j:-1;}return m;}

// ═══ MAIN ═══
async function main(){
  const dt=s=>new Date(s).toISOString().slice(0,10);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('DIAGNOSIS: DIV_SNIPER — V3 vs V5 PF Degradation');
  console.log('═══════════════════════════════════════════════════════════════');

  // STEP 1
  console.log('\n── STEP 1: DATA PERIODS ──');
  console.log('  V3: DAYS=120, endTime=Date.now() at time of run (dynamic)');
  console.log('  V5: DAYS=120, endTime=Date.now() at time of run (dynamic)');
  console.log('  Both use identical download logic → same period if run same day');
  console.log('  V3 PF 1.91 vs V5 PF 0.27 — if run on different days, data differs');
  console.log('  Running NOW with 120d lookback for diagnosis...\n');

  // Download
  console.log('[DOWNLOAD] BTCUSDT 5m + 1h...');
  const k5=await dl('BTCUSDT','5m',TOTAL_5M);
  const k1h=await dl('BTCUSDT','1h',Math.ceil(DAYS*24*1.2));
  console.log(`  5m: ${k5.length} bars (${dt(k5[0].t)} to ${dt(k5[k5.length-1].t)})`);
  console.log(`  1h: ${k1h.length} bars (${dt(k1h[0].t)} to ${dt(k1h[k1h.length-1].t)})`);

  // Precompute
  const d5=pre(k5),dH=pre(k1h),mp=mapH(k5,k1h);

  // STEP 2: Block analysis
  console.log('\n── STEP 2: 20-DAY BLOCK ANALYSIS ──');
  const blockSize=20*C5PD; // 20 days of 5m bars
  const blockSizeH=20*24;
  const blocks=[];
  for(let b=0;b<6;b++){
    const s5=b*blockSize,e5=Math.min((b+1)*blockSize,k5.length);
    if(s5>=k5.length)break;
    const bk5=k5.slice(s5,e5);
    const bd5=pre(bk5);
    // generate signals on block
    const sigs=[];
    for(let i=50;i<bk5.length-2;i++){
      const sig=divSniper(i,bd5);
      if(sig)sigs.push(sig);
    }
    const trades=simTrades(sigs,bk5);
    const m=met(trades);
    // regime indicators from 1h
    const sH=Math.floor(s5/12),eH=Math.min(Math.floor(e5/12),k1h.length);
    let adxSum=0,spreadSum=0,atrPctSum=0,adxN=0;
    for(let j=Math.max(28,sH);j<eH;j++){
      adxSum+=dH.adx[j];
      spreadSum+=Math.abs(dH.e50[j]-dH.e200[j])/dH.c[j]*100;
      atrPctSum+=dH.atr[j]/dH.c[j]*100;
      adxN++;
    }
    const btcChg=adxN>0?((k1h[Math.min(eH-1,k1h.length-1)].c-k1h[sH].c)/k1h[sH].c*100):0;
    blocks.push({
      b:b+1,start:dt(bk5[0].t),end:dt(bk5[bk5.length-1].t),
      ...m,adxAvg:adxN?adxSum/adxN:0,spreadAvg:adxN?spreadSum/adxN:0,
      atrPct:adxN?atrPctSum/adxN:0,btcChg
    });
  }

  console.log('Block | Dates                | PnL      | PF   | WR%  | Trades | ADX  | EMAsprd | ATR%  | BTC%');
  console.log('------|----------------------|----------|------|------|--------|------|---------|-------|------');
  for(const bl of blocks){
    console.log(`  ${bl.b}   | ${bl.start} - ${bl.end} | $${bl.pnl.toFixed(2).padStart(7)} | ${bl.pf.toFixed(2).padStart(4)} | ${bl.wr.toFixed(1).padStart(4)}% | ${String(bl.n).padStart(6)} | ${bl.adxAvg.toFixed(1).padStart(4)} | ${bl.spreadAvg.toFixed(2).padStart(7)} | ${bl.atrPct.toFixed(2).padStart(5)} | ${bl.btcChg>=0?'+':''}${bl.btcChg.toFixed(1)}%`);
  }
  const pfGt1=blocks.filter(b=>b.pf>1.0).length;
  const pfGt15=blocks.filter(b=>b.pf>1.5).length;
  const pnlGood=blocks.filter(b=>b.pf>1.0).reduce((s,b)=>s+b.pnl,0);
  console.log(`\nBlocks with PF > 1.0: ${pfGt1} of ${blocks.length}`);
  console.log(`Blocks with PF > 1.5: ${pfGt15} of ${blocks.length}`);
  console.log(`PnL if only trading PF>1.0 blocks: $${pnlGood.toFixed(2)}`);

  // STEP 3: Regime filter
  console.log('\n── STEP 3: REGIME FILTER TEST ──');
  // Full 120d signals
  const allSigs=[];
  for(let i=50;i<k5.length-2;i++){
    const sig=divSniper(i,d5);
    if(sig){sig.hi=mp[i];allSigs.push(sig);}
  }
  const allTrades=simTrades(allSigs,k5);
  const mAll=met(allTrades);

  // Filtered runs
  const results=[{label:'No filter',m:mAll,daysActive:DAYS}];
  for(const thresh of [3,4,5]){
    const fSigs=allSigs.filter(s=>{
      const hi=s.hi;
      if(hi<0||hi>=k1h.length)return false;
      return regimeScore(dH,hi)>=thresh;
    });
    const fTrades=simTrades(fSigs,k5);
    const fm=met(fTrades);
    // estimate active days
    const activeBars=new Set();
    for(const s of fSigs){const day=Math.floor(s.barIdx/C5PD);activeBars.add(day);}
    results.push({label:`regime >= ${thresh}`,m:fm,daysActive:activeBars.size});
  }

  console.log('Config          | PnL      | PF   | WR%  | Trades | Days_active');
  console.log('----------------|----------|------|------|--------|------------');
  for(const r of results){
    console.log(`${r.label.padEnd(16)}| $${r.m.pnl.toFixed(2).padStart(7)} | ${r.m.pf.toFixed(2).padStart(4)} | ${r.m.wr.toFixed(1).padStart(4)}% | ${String(r.m.n).padStart(6)} | ${String(r.daysActive).padStart(3)}`);
  }

  // Extra: win/loss breakdown
  console.log('\n── EXTRA: SIGNAL QUALITY ──');
  const byDir={BUY:{w:0,l:0,gw:0,gl:0},SELL:{w:0,l:0,gw:0,gl:0}};
  for(const t of allTrades){
    const d=byDir[t.dir];
    if(t.pnl>0){d.w++;d.gw+=t.pnl;}else{d.l++;d.gl+=Math.abs(t.pnl);}
  }
  for(const dir of ['BUY','SELL']){
    const d=byDir[dir],n=d.w+d.l;
    console.log(`  ${dir}: ${n} trades, WR ${n?(d.w/n*100).toFixed(1):'0'}%, PF ${d.gl>0?(d.gw/d.gl).toFixed(2):'∞'}, AvgW $${d.w?((d.gw/d.w).toFixed(2)):'0'}, AvgL $${d.l?((d.gl/d.l).toFixed(2)):'0'}`);
  }
  const byReason={TP:0,SL:0,TO:0};
  for(const t of allTrades)byReason[t.reason]=(byReason[t.reason]||0)+1;
  console.log(`  Exit reasons: TP=${byReason.TP||0} SL=${byReason.SL||0} TO=${byReason.TO||0}`);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('DIAGNOSIS COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
}
main().catch(e=>{console.error('FATAL:',e);process.exit(1);});
