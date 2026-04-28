#!/usr/bin/env node
/**
 * EDGE FINDER v2 — Simple, direct, no bugs
 * Tests specific entry conditions on real data with simple TP/SL
 * Split: first 30 days vs last 30 days
 */
const https = require('https');
const DAYS=60, LEV=5, POS=500, FEE=0.0008, TIMEOUT=40;

function fetchJSON(url){return new Promise((res,rej)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});}).on('error',rej);});}
async function getKlines(sym,intv,lim,end){let u=`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${intv}&limit=${lim}`;if(end)u+=`&endTime=${end}`;try{return await fetchJSON(u);}catch(e){return[];}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function calcRSI(c,p=14){if(c.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}return al===0?100:100-(100/(1+ag/al));}
function emaA(d,p){const k=2/(p+1),r=[d[0]];for(let i=1;i<d.length;i++)r.push(d[i]*k+r[i-1]*(1-k));return r;}
function ema(d,p){return emaA(d,p).at(-1);}
function macd(c){if(c.length<35)return{h:0,ph:0};const e12=emaA(c,12),e26=emaA(c,26),ml=e12.map((v,i)=>v-e26[i]),sl=emaA(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1))};}
function bb(c,p=20){if(c.length<p)return{u:0,m:0,l:0};const s=c.slice(-p),m=s.reduce((a,b)=>a+b)/p,sd=Math.sqrt(s.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+2*sd,m,l:m-2*sd};}
function stoch(H,L,C){if(C.length<17)return 50;const s=14,sh=H.slice(-s),sl=L.slice(-s),hi=Math.max(...sh),lo=Math.min(...sl);return hi===lo?50:((C.at(-1)-lo)/(hi-lo))*100;}
function atr(H,L,C,p=14){if(C.length<p+1)return 0;const t=[];for(let i=1;i<C.length;i++)t.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));let a=t.slice(0,p).reduce((s,v)=>s+v)/p;for(let i=p;i<t.length;i++)a=(a*(p-1)+t[i])/p;return a;}
function wilder(a,p){if(a.length<p)return a.map(()=>0);const r=[];let s=a.slice(0,p).reduce((x,y)=>x+y)/p;for(let i=0;i<p;i++)r.push(0);r[p-1]=s;for(let i=p;i<a.length;i++){s=(s*(p-1)+a[i])/p;r.push(s);}return r;}
function adx(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pd=[],md=[],tr=[];for(let i=1;i<H.length;i++){const u=H[i]-H[i-1],d=L[i-1]-L[i];pd.push(u>d&&u>0?u:0);md.push(d>u&&d>0?d:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}const sT=wilder(tr,p),sP=wilder(pd,p),sM=wilder(md,p);const pi=sP.map((v,i)=>sT[i]?v/sT[i]*100:0),mi=sM.map((v,i)=>sT[i]?v/sT[i]*100:0);return{adx:(()=>{const dx=pi.map((v,i)=>{const s=v+mi[i];return s?Math.abs(v-mi[i])/s*100:0;});const dxV=dx.slice(p-1);const aa=dxV.length>=p?wilder(dxV,p):dxV;return aa.at(-1)||15;})(),pdi:pi.at(-1)||0,mdi:mi.at(-1)||0};}

// Simulate a single trade
function simTrade(H,L,C,idx,dir,tpMult,slMult) {
  const entry = C[idx];
  const a = atr(H.slice(0,idx+1),L.slice(0,idx+1),C.slice(0,idx+1),14);
  if(a<=0) return null;
  const tpD=a*tpMult, slD=a*slMult, cb=entry*FEE;
  for(let i=idx+1; i<Math.min(idx+TIMEOUT,C.length); i++) {
    if(dir==='BUY') {
      if(L[i]<=entry-slD-cb) return -(slD/entry)*LEV*POS - POS*FEE;
      if(H[i]>=entry+tpD+cb) return (tpD/entry)*LEV*POS - POS*FEE;
    } else {
      if(H[i]>=entry+slD+cb) return -(slD/entry)*LEV*POS - POS*FEE;
      if(L[i]<=entry-tpD-cb) return (tpD/entry)*LEV*POS - POS*FEE;
    }
  }
  const ex=C[Math.min(idx+TIMEOUT-1,C.length-1)];
  return dir==='BUY' ? (ex-entry)/entry*LEV*POS-POS*FEE : (entry-ex)/entry*LEV*POS-POS*FEE;
}

async function main() {
  const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','ADAUSDT','DOTUSDT','LINKUSDT','ARBUSDT','OPUSDT','FILUSDT','JUPUSDT','WIFUSDT','FETUSDT','AVAXUSDT'];

  console.log('═══ EDGE FINDER — 60 days, split 30/30, 14 pairs ═══\n');

  // Fetch data
  const data = {};
  for(const sym of PAIRS) {
    process.stdout.write(`${sym}..`);
    const now=Date.now(), need=DAYS*288+280;
    const a=[];let end=now;
    while(a.length<need){const b=await getKlines(sym,'5m',1000,end);if(!b||!b.length)break;a.unshift(...b);end=b[0][0]-1;await sleep(100);}
    data[sym]={C:a.map(k=>parseFloat(k[4])),H:a.map(k=>parseFloat(k[2])),L:a.map(k=>parseFloat(k[3])),V:a.map(k=>parseFloat(k[5])),T:a.map(k=>k[0])};
    process.stdout.write(`${a.length} `);
  }

  const testStart=Date.now()-DAYS*86400000;
  const mid=testStart+30*86400000;

  // Define strategies: {name, check(C,H,L,V,i)->dir|null, tpMult, slMult}
  const strats = [];

  // RSI mean-reversion
  for(const th of [20,25,30]) {
    for(const tp of [1.0,1.5,2.0,2.5,3.0]) {
      for(const sl of [0.8,1.0,1.5]) {
        strats.push({name:`RSI<${th}_BUY_R${tp}/${sl}`, tp, sl, fn:(C,H,L,V,i)=>{
          const r=calcRSI(C.slice(0,i+1));return r<th?'BUY':null;}});
        strats.push({name:`RSI>${100-th}_SELL_R${tp}/${sl}`, tp, sl, fn:(C,H,L,V,i)=>{
          const r=calcRSI(C.slice(0,i+1));return r>(100-th)?'SELL':null;}});
      }
    }
  }

  // EMA trend-following
  for(const tp of [1.5,2.0,2.5,3.0]) {
    strats.push({name:`EMA9>21_BUY_R${tp}`, tp, sl:1.0, fn:(C,H,L,V,i)=>{
      const c=C.slice(0,i+1);return ema(c,9)>ema(c,21)?'BUY':null;}});
    strats.push({name:`EMA9<21_SELL_R${tp}`, tp, sl:1.0, fn:(C,H,L,V,i)=>{
      const c=C.slice(0,i+1);return ema(c,9)<ema(c,21)?'SELL':null;}});
  }

  // MACD cross
  for(const tp of [1.5,2.0,2.5]) {
    strats.push({name:`MACD_cross_up_R${tp}`, tp, sl:1.0, fn:(C,H,L,V,i)=>{
      const m=macd(C.slice(0,i+1));return m.h>0&&m.ph<=0?'BUY':null;}});
    strats.push({name:`MACD_cross_dn_R${tp}`, tp, sl:1.0, fn:(C,H,L,V,i)=>{
      const m=macd(C.slice(0,i+1));return m.h<0&&m.ph>=0?'SELL':null;}});
  }

  // RSI + EMA combo (mean-reversion WITH trend)
  for(const tp of [1.5,2.0,2.5]) {
    strats.push({name:`RSI<30+EMA9>21_BUY_R${tp}`, tp, sl:1.0, fn:(C,H,L,V,i)=>{
      const c=C.slice(0,i+1);return calcRSI(c)<30&&ema(c,9)>ema(c,21)?'BUY':null;}});
    strats.push({name:`RSI>70+EMA9<21_SELL_R${tp}`, tp, sl:1.0, fn:(C,H,L,V,i)=>{
      const c=C.slice(0,i+1);return calcRSI(c)>70&&ema(c,9)<ema(c,21)?'SELL':null;}});
    // Against trend (pure mean-reversion)
    strats.push({name:`RSI<30+EMA9<21_BUY_R${tp}`, tp, sl:1.0, fn:(C,H,L,V,i)=>{
      const c=C.slice(0,i+1);return calcRSI(c)<30&&ema(c,9)<ema(c,21)?'BUY':null;}});
    strats.push({name:`RSI>70+EMA9>21_SELL_R${tp}`, tp, sl:1.0, fn:(C,H,L,V,i)=>{
      const c=C.slice(0,i+1);return calcRSI(c)>70&&ema(c,9)>ema(c,21)?'SELL':null;}});
  }

  // Volume spike
  for(const tp of [1.5,2.0,2.5]) {
    strats.push({name:`VolSpike>2+RSI<35_BUY_R${tp}`, tp, sl:1.0, fn:(C,H,L,V,i)=>{
      const avg=V.slice(Math.max(0,i-20),i).reduce((a,b)=>a+b)/20;
      return V[i]>avg*2&&calcRSI(C.slice(0,i+1))<35?'BUY':null;}});
  }

  // ADX trend filter
  for(const tp of [2.0,2.5,3.0]) {
    strats.push({name:`ADX>25+DI_BUY_R${tp}`, tp, sl:1.0, fn:(C,H,L,V,i)=>{
      const a=adx(H.slice(0,i+1),L.slice(0,i+1),C.slice(0,i+1));
      return a.adx>25&&a.pdi>a.mdi?'BUY':null;}});
    strats.push({name:`ADX>25+DI_SELL_R${tp}`, tp, sl:1.0, fn:(C,H,L,V,i)=>{
      const a=adx(H.slice(0,i+1),L.slice(0,i+1),C.slice(0,i+1));
      return a.adx>25&&a.mdi>a.pdi?'SELL':null;}});
  }

  // BB extreme
  for(const tp of [1.5,2.0]) {
    strats.push({name:`BB<0.05_BUY_R${tp}`, tp, sl:1.0, fn:(C,H,L,V,i)=>{
      const c=C.slice(0,i+1),b=bb(c);const r=b.u-b.l;const p=r>0?(c.at(-1)-b.l)/r:0.5;
      return p<0.05?'BUY':null;}});
    strats.push({name:`BB>0.95_SELL_R${tp}`, tp, sl:1.0, fn:(C,H,L,V,i)=>{
      const c=C.slice(0,i+1),b=bb(c);const r=b.u-b.l;const p=r>0?(c.at(-1)-b.l)/r:0.5;
      return p>0.95?'SELL':null;}});
  }

  console.log(`\n\n  Testing ${strats.length} strategies...\n`);

  // Initialize results
  const res = strats.map(s=>({...s, train:{n:0,pnl:0,w:0}, test:{n:0,pnl:0,w:0}}));

  // Test
  let totalChecks=0, totalFires=0;
  for(const sym of PAIRS) {
    const d=data[sym]; if(!d)continue;
    const si0=d.T.findIndex(t=>t>=testStart); if(si0<50)continue;

    for(let i=Math.max(si0,280); i<d.C.length-TIMEOUT; i+=3) { // every 3rd bar
      totalChecks++;
      const isTrain = d.T[i] < mid;

      for(let si=0; si<res.length; si++) {
        const dir = res[si].fn(d.C,d.H,d.L,d.V,i);
        if(!dir) continue;
        totalFires++;

        const pnl = simTrade(d.H,d.L,d.C,i,dir,res[si].tp,res[si].sl);
        if(pnl===null) continue;

        const bucket = isTrain ? res[si].train : res[si].test;
        bucket.n++; bucket.pnl+=pnl; if(pnl>0) bucket.w++;
      }
    }
    process.stdout.write('.');
  }

  console.log(`\n\n  Total checks: ${totalChecks}, Total fires: ${totalFires}\n`);

  // Find profitable in BOTH halves
  const both = res.filter(r=>r.train.n>=10&&r.test.n>=10&&r.train.pnl>0&&r.test.pnl>0)
    .sort((a,b)=>(b.train.pnl+b.test.pnl)-(a.train.pnl+a.test.pnl));

  console.log('═══ PROFITABLE IN BOTH HALVES (real edge) ═══\n');
  if(!both.length) {
    console.log('  NONE found.\n');
  } else {
    for(const r of both.slice(0,20)) {
      const tw=r.train.n?(r.train.w/r.train.n*100).toFixed(0):'?';
      const ew=r.test.n?(r.test.w/r.test.n*100).toFixed(0):'?';
      console.log(`  ${r.name}`);
      console.log(`    TRAIN: ${r.train.n}t WR:${tw}% $${r.train.pnl.toFixed(0)} | TEST: ${r.test.n}t WR:${ew}% $${r.test.pnl.toFixed(0)} | TOTAL: $${(r.train.pnl+r.test.pnl).toFixed(0)}`);
    }
  }

  // Top 15 by combined (even if one half loses)
  const top = res.filter(r=>r.train.n>=5&&r.test.n>=5).sort((a,b)=>(b.train.pnl+b.test.pnl)-(a.train.pnl+a.test.pnl));
  console.log('\n═══ TOP 15 BY COMBINED PNL ═══\n');
  for(const r of top.slice(0,15)) {
    const tw=r.train.n?(r.train.w/r.train.n*100).toFixed(0):'?';
    const ew=r.test.n?(r.test.w/r.test.n*100).toFixed(0):'?';
    const trP=r.train.pnl>0?'✓':'✗';
    const teP=r.test.pnl>0?'✓':'✗';
    console.log(`  ${r.name.padEnd(40)} TR:${String(r.train.n).padEnd(5)} WR:${tw.padEnd(3)}% $${r.train.pnl.toFixed(0).padStart(6)}${trP} | TE:${String(r.test.n).padEnd(5)} WR:${ew.padEnd(3)}% $${r.test.pnl.toFixed(0).padStart(6)}${teP}`);
  }

  // Bottom 5
  console.log('\n═══ BOTTOM 5 (worst) ═══\n');
  for(const r of top.slice(-5)) {
    console.log(`  ${r.name.padEnd(40)} TOTAL: $${(r.train.pnl+r.test.pnl).toFixed(0)}`);
  }
}

main().catch(console.error);
