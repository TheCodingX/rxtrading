// ═══════════════════════════════════════════════════════════════════
// VIP FINAL — Refine frequency + hour filters for institutional quality
// Base: Conv≥8, ADX<20, TP1.5/SL1.0 mean-reversion (proven profitable)
// Goal: 5-15 signals/day with maximum PnL per signal
// ═══════════════════════════════════════════════════════════════════

const https = require('https');
const SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','DOTUSDT','NEARUSDT','APTUSDT'];

function fetchJSON(url){return new Promise((res,rej)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}});}).on('error',rej)});}
async function getKlines(sym,tf,limit){try{return await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`);}catch(e){return null;}}

function calcRSI(C,p=14){if(C.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=C[i]-C[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<C.length;i++){const d=C[i]-C[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}if(al===0)return 100;return 100-(100/(1+ag/al));}
function calcEMAArr(d,p){const k=2/(p+1);const r=[d[0]];for(let i=1;i<d.length;i++)r.push(d[i]*k+r[i-1]*(1-k));return r;}
function calcEMA(d,p){return calcEMAArr(d,p).at(-1);}
function calcMACD(C){if(C.length<35)return{h:0,ph:0};const e12=calcEMAArr(C,12),e26=calcEMAArr(C,26);const ml=e12.map((v,i)=>v-e26[i]);const sl=calcEMAArr(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1))};}
function calcATR(H,L,C,p=14){if(C.length<p+1)return 0;const trs=[];for(let i=1;i<C.length;i++)trs.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));if(trs.length<p)return trs.reduce((a,b)=>a+b)/trs.length;let atr=trs.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<trs.length;i++)atr=(atr*(p-1)+trs[i])/p;return atr;}
function calcStoch(H,L,C,kp=14){if(C.length<kp+3)return{k:50,d:50};const kA=[];for(let i=kp;i<=C.length;i++){const sh=H.slice(i-kp,i),sl=L.slice(i-kp,i);const hi=Math.max(...sh),lo=Math.min(...sl);kA.push(hi===lo?50:((C[i-1]-lo)/(hi-lo))*100);}const dA=[];for(let i=2;i<kA.length;i++)dA.push((kA[i]+kA[i-1]+kA[i-2])/3);return{k:kA.at(-1)||50,d:dA.at(-1)||50};}
function calcBB(C,p=20,s=2){if(C.length<p)return{u:0,m:0,l:0};const sl=C.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+s*sd,m,l:m-s*sd};}
function calcADX(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pdm=[],mdm=[],tr=[];for(let i=1;i<H.length;i++){const u=H[i]-H[i-1],d=L[i-1]-L[i];pdm.push(u>d&&u>0?u:0);mdm.push(d>u&&d>0?d:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}function ws(a,p){if(a.length<p)return a.map(()=>0);const r=[];let s=a.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=0;i<p;i++)r.push(0);r[p-1]=s;for(let i=p;i<a.length;i++){s=(s*(p-1)+a[i])/p;r.push(s);}return r;}const sT=ws(tr,p),sP=ws(pdm,p),sM=ws(mdm,p);const pdi=sP.map((v,i)=>sT[i]?v/sT[i]*100:0);const mdi=sM.map((v,i)=>sT[i]?v/sT[i]*100:0);const dx=pdi.map((v,i)=>{const s=v+mdi[i];return s?Math.abs(v-mdi[i])/s*100:0;});const dxV=dx.slice(p-1);const adxA=dxV.length>=p?ws(dxV,p):dxV;return{adx:adxA.at(-1)||15,pdi:pdi.at(-1)||0,mdi:mdi.at(-1)||0};}
function calcOBV(C,V){if(C.length<2)return{obv:0,slope:0,rising:false};let obv=0;const arr=[0];for(let i=1;i<C.length;i++){if(C[i]>C[i-1])obv+=V[i];else if(C[i]<C[i-1])obv-=V[i];arr.push(obv);}const n=Math.min(20,arr.length);const sl=arr.slice(-n);let sx=0,sy=0,sxx=0,sxy=0;for(let i=0;i<n;i++){sx+=i;sy+=sl[i];sxx+=i*i;sxy+=i*sl[i];}const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx||1);return{obv,slope,rising:slope>0};}

let DATA={};
async function loadData(){
  for(const sym of SYMS){
    process.stdout.write(`  ${sym}...`);
    const [k5,k15,k1h]=await Promise.all([getKlines(sym,'5m',1000),getKlines(sym,'15m',400),getKlines(sym,'1h',200)]);
    if(!k5||k5.length<400){console.log(' SKIP');continue;}
    DATA[sym]={C:k5.map(k=>+k[4]),H:k5.map(k=>+k[2]),L:k5.map(k=>+k[3]),V:k5.map(k=>+k[5]),T:k5.map(k=>k[0]),
      C15:k15?k15.map(k=>+k[4]):[],H15:k15?k15.map(k=>+k[2]):[],L15:k15?k15.map(k=>+k[3]):[],T15:k15?k15.map(k=>k[0]):[],
      C1h:k1h?k1h.map(k=>+k[4]):[],H1h:k1h?k1h.map(k=>+k[2]):[],L1h:k1h?k1h.map(k=>+k[3]):[],V1h:k1h?k1h.map(k=>+k[5]):[],T1h:k1h?k1h.map(k=>k[0]):[],len:k5.length};
    console.log(` ${k5.length}`);await new Promise(r=>setTimeout(r,200));
  }
}

function meanRevScore(c,h,l,v,cur,atr,rsi,stoch,bb,mac,obvData,e9,e21){
  let B=0,S=0,bI=0,sI=0;
  if(rsi<25){B+=4;bI++;}else if(rsi<30){B+=3;bI++;}else if(rsi<35){B+=2;bI++;}
  else if(rsi>75){S+=4;sI++;}else if(rsi>70){S+=3;sI++;}else if(rsi>65){S+=2;sI++;}
  if(stoch.k<20){B+=3;bI++;}else if(stoch.k<30){B+=2;bI++;}
  else if(stoch.k>80){S+=3;sI++;}else if(stoch.k>70){S+=2;sI++;}
  const bbR=bb.u-bb.l;const bbP=bbR>0?(cur-bb.l)/bbR:0.5;
  if(bbP<0.1){B+=3;bI++;}else if(bbP<0.2){B+=2;bI++;}
  else if(bbP>0.9){S+=3;sI++;}else if(bbP>0.8){S+=2;sI++;}
  const mom3=(cur-(c[c.length-4]||cur))/Math.max(atr,0.0001);
  if(mom3<-1){B+=2;bI++;}else if(mom3<-0.5){B+=1;bI++;}
  else if(mom3>1){S+=2;sI++;}else if(mom3>0.5){S+=1;sI++;}
  const n=Math.min(4,c.length);let bearRun=0,bullRun=0;
  for(let i=c.length-n;i<c.length;i++){
    if(c[i]<(c[i-1]||c[i]))bearRun++;else bearRun=0;
    if(c[i]>(c[i-1]||c[i]))bullRun++;else bullRun=0;
  }
  if(bearRun>=4){B+=2;bI++;}if(bullRun>=4){S+=2;sI++;}
  if(bearRun>=3){B+=1;bI++;}if(bullRun>=3){S+=1;sI++;}
  const emaDist=(cur-e21)/Math.max(atr,0.0001);
  if(emaDist<-1.5){B+=1.5;bI++;}else if(emaDist<-0.8){B+=0.8;bI++;}
  else if(emaDist>1.5){S+=1.5;sI++;}else if(emaDist>0.8){S+=0.8;sI++;}
  if(mac.h>0&&mac.ph<=0){B+=1.5;bI++;}else if(mac.h<0&&mac.ph>=0){S+=1.5;sI++;}
  if(obvData.rising&&B>S){B+=1;bI++;}else if(!obvData.rising&&S>B){S+=1;sI++;}
  const avgV=v.slice(-20).reduce((a,b)=>a+b)/20;const vr=v.at(-1)/avgV;
  if(vr>1.5){if(B>S)B*=1.1;else S*=1.1;}
  return{B,S,bI,sI,mom3,emaDist,bbP,vr};
}

function precompute(){
  const LB=280,FUT=48;
  const allBars=[];
  for(const sym of Object.keys(DATA)){
    const d=DATA[sym];
    for(let bar=LB;bar<d.len-FUT;bar++){
      const c=d.C.slice(bar-279,bar+1),h=d.H.slice(bar-279,bar+1),l=d.L.slice(bar-279,bar+1),v=d.V.slice(bar-279,bar+1);
      const bt=d.T[bar];const hUTC=new Date(bt).getUTCHours();
      const cur=c.at(-1);
      const atr=calcATR(h,l,c,14);const adxData=calcADX(h,l,c);
      const rsi=calcRSI(c,14);const mac=calcMACD(c);
      const ea9=calcEMAArr(c,9),ea21=calcEMAArr(c,21);
      const e9=ea9.at(-1),e21=ea21.at(-1);
      const bb=calcBB(c,20,2);const stoch=calcStoch(h,l,c,14);
      const obvData=calcOBV(c,v);
      const sc=meanRevScore(c,h,l,v,cur,atr,rsi,stoch,bb,mac,obvData,e9,e21);

      // 15m
      let c15e=0;for(let j=d.T15.length-1;j>=0;j--){if(d.T15[j]<=bt){c15e=j+1;break;}}
      const c15=d.C15.slice(Math.max(0,c15e-100),c15e);
      const h15=d.H15.slice(Math.max(0,c15e-100),c15e);
      const l15=d.L15.slice(Math.max(0,c15e-100),c15e);
      let mtf15='NEUTRAL';
      if(c15.length>25){const rsi15=calcRSI(c15,14);if(rsi15<40)mtf15='BUY';else if(rsi15>60)mtf15='SELL';}

      let atr15=atr;
      if(h15.length>15&&l15.length>15&&c15.length>15){const a=calcATR(h15,l15,c15,14);if(a>0)atr15=a;}

      const fH=[],fL=[],fC=[];
      for(let f=bar+1;f<=Math.min(bar+FUT,d.len-1);f++){fH.push(d.H[f]);fL.push(d.L[f]);fC.push(d.C[f]);}

      allBars.push({sym,bar,hUTC,cur,atr,atr15,adx:adxData.adx,rsi,...sc,mtf15,fH,fL,fC,pct:bar/d.len});
    }
  }
  return allBars;
}

function evalTrade(sig,entry,atr15,tpM,slM,trailM,maxBars,fH,fL,fC){
  const tp=atr15*tpM,sl=atr15*slM;const cost=entry*0.0008;
  const tp1=tp*0.6;const trail=atr15*trailM;
  const tp1P=sig==='BUY'?entry+tp1+cost:entry-tp1-cost;
  const slP=sig==='BUY'?entry-sl-cost:entry+sl+cost;
  const tpFullP=sig==='BUY'?entry+tp+cost:entry-tp-cost;
  let tp1Hit=false;let best=sig==='BUY'?-Infinity:Infinity;
  for(let i=0;i<Math.min(maxBars,fH.length);i++){
    if(sig==='BUY'){
      if(!tp1Hit){if(fL[i]<=slP)return -(sl+cost)/entry*100;if(fH[i]>=tp1P)tp1Hit=true;}
      if(tp1Hit){best=Math.max(best,fH[i]);if(fL[i]<=best-trail-cost){const r=(fC[i]-entry-cost)/entry*100;return(tp1/entry*100)*0.5+r*0.5;}if(fH[i]>=tpFullP)return(tp1/entry*100)*0.5+(tp/entry*100)*0.5;if(fL[i]<=entry)return(tp1/entry*100)*0.5;}
    }else{
      if(!tp1Hit){if(fH[i]>=slP)return -(sl+cost)/entry*100;if(fL[i]<=tp1P)tp1Hit=true;}
      if(tp1Hit){best=Math.min(best,fL[i]);if(fH[i]>=best+trail+cost){const r=(entry-fC[i]-cost)/entry*100;return(tp1/entry*100)*0.5+r*0.5;}if(fL[i]<=tpFullP)return(tp1/entry*100)*0.5+(tp/entry*100)*0.5;if(fH[i]>=entry)return(tp1/entry*100)*0.5;}
    }
  }
  const last=fC[Math.min(maxBars,fH.length)-1]||entry;
  const uPnl=sig==='BUY'?(last-entry-cost)/entry*100:(entry-last-cost)/entry*100;
  return tp1Hit?(tp1/entry*100)*0.5+uPnl*0.5:uPnl;
}

function testConfig(allBars,startPct,endPct,cfg){
  const{minConv=8,minConds=3,adxMax=20,tpM=1.5,slM=1.0,trailM=0.1,maxBars=36,cd=8,
    deadHours=null,blockHours=null,minVR=0,mtfBlock=false}=cfg;
  let wins=0,losses=0,pnl=0;const lastBar={};const trades=[];
  for(const b of allBars){
    if(b.pct<startPct||b.pct>=endPct)continue;
    let signal='NEUTRAL';
    if(b.B>b.S&&b.B>=minConv&&b.bI>=minConds)signal='BUY';
    else if(b.S>b.B&&b.S>=minConv&&b.sI>=minConds)signal='SELL';
    if(signal==='NEUTRAL')continue;
    const lb=lastBar[b.sym]||-999;if(b.bar-lb<cd)continue;
    if(b.adx>adxMax)continue;
    if(deadHours&&b.hUTC>=deadHours[0]&&b.hUTC<deadHours[1])continue;
    if(blockHours&&blockHours.includes(b.hUTC))continue;
    if(b.vr<minVR)continue;
    if(mtfBlock){if(signal==='BUY'&&b.mtf15==='SELL')continue;if(signal==='SELL'&&b.mtf15==='BUY')continue;}
    lastBar[b.sym]=b.bar;
    const tPnl=evalTrade(signal,b.cur,b.atr15,tpM,slM,trailM,maxBars,b.fH,b.fL,b.fC);
    pnl+=tPnl;if(tPnl>0)wins++;else losses++;
    trades.push({sym:b.sym,signal,pnl:tPnl,hUTC:b.hUTC,conv:Math.max(b.B,b.S),adx:b.adx});
  }
  const total=wins+losses;const len=Object.values(DATA)[0]?.len||1000;const days=len*(endPct-startPct)/288;
  return{total,wins,losses,wr:total>0?wins/total*100:0,pnl,spd:total/Math.max(0.5,days),days,trades,
    avgPnl:total>0?pnl/total:0,pf:losses>0?(wins>0?trades.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0)/Math.abs(trades.filter(t=>t.pnl<=0).reduce((a,t)=>a+t.pnl,0)):0):Infinity};
}

async function main(){
  console.log('═'.repeat(70));
  console.log('  VIP FINAL — INSTITUTIONAL FREQUENCY OPTIMIZATION');
  console.log('═'.repeat(70)+'\n');
  await loadData();
  console.log('\n  Pre-computing...');
  const allBars=precompute();
  console.log(`  Done: ${allBars.length} bars\n`);

  // ═══ Test with various frequency controls ═══
  const configs=[
    // Base reference (proven best)
    {name:'BASE (cd=8, no filters)',cfg:{cd:8}},

    // Conviction levels with standard cd
    {name:'Conv≥9 cd=8',cfg:{minConv:9,cd:8}},
    {name:'Conv≥10 cd=8',cfg:{minConv:10,cd:8}},
    {name:'Conv≥11 cd=8',cfg:{minConv:11,cd:8}},
    {name:'Conv≥12 cd=8',cfg:{minConv:12,cd:8}},

    // Higher cooldowns (reduce frequency)
    {name:'Conv≥8 cd=18 (1.5h)',cfg:{cd:18}},
    {name:'Conv≥8 cd=24 (2h)',cfg:{cd:24}},
    {name:'Conv≥8 cd=36 (3h)',cfg:{cd:36}},
    {name:'Conv≥8 cd=48 (4h)',cfg:{cd:48}},

    // Best combos: high conv + high cd
    {name:'Conv≥10 cd=18',cfg:{minConv:10,cd:18}},
    {name:'Conv≥10 cd=24',cfg:{minConv:10,cd:24}},
    {name:'Conv≥10 cd=36',cfg:{minConv:10,cd:36}},
    {name:'Conv≥11 cd=18',cfg:{minConv:11,cd:18}},
    {name:'Conv≥11 cd=24',cfg:{minConv:11,cd:24}},
    {name:'Conv≥12 cd=18',cfg:{minConv:12,cd:18}},
    {name:'Conv≥12 cd=24',cfg:{minConv:12,cd:24}},

    // With dead hours filter
    {name:'Conv≥8 cd=24 DH[0-6]',cfg:{cd:24,deadHours:[0,6]}},
    {name:'Conv≥10 cd=18 DH[0-6]',cfg:{minConv:10,cd:18,deadHours:[0,6]}},
    {name:'Conv≥10 cd=24 DH[0-6]',cfg:{minConv:10,cd:24,deadHours:[0,6]}},

    // Block worst hours (8h=-2.16%, 21h=-2.59%, 22h=-2.22%)
    {name:'Conv≥8 cd=24 BH[8,21,22]',cfg:{cd:24,blockHours:[8,21,22]}},
    {name:'Conv≥10 cd=18 BH[8,21,22]',cfg:{minConv:10,cd:18,blockHours:[8,21,22]}},
    {name:'Conv≥10 cd=24 BH[8,21,22]',cfg:{minConv:10,cd:24,blockHours:[8,21,22]}},

    // With MTF 15m block
    {name:'Conv≥8 cd=24 +MTF',cfg:{cd:24,mtfBlock:true}},
    {name:'Conv≥10 cd=18 +MTF',cfg:{minConv:10,cd:18,mtfBlock:true}},

    // Volume filter
    {name:'Conv≥8 cd=24 VR>0.5',cfg:{cd:24,minVR:0.5}},
    {name:'Conv≥10 cd=18 VR>0.5',cfg:{minConv:10,cd:18,minVR:0.5}},

    // Combined best filters
    {name:'Conv≥10 cd=18 BH+VR',cfg:{minConv:10,cd:18,blockHours:[8,21,22],minVR:0.3}},
    {name:'Conv≥10 cd=24 BH+VR',cfg:{minConv:10,cd:24,blockHours:[8,21,22],minVR:0.3}},
    {name:'Conv≥9 cd=24 BH+VR',cfg:{minConv:9,cd:24,blockHours:[8,21,22],minVR:0.3}},
    {name:'Conv≥8 cd=36 BH+VR',cfg:{cd:36,blockHours:[8,21,22],minVR:0.3}},

    // ADX variations
    {name:'Conv≥10 cd=18 ADX<25',cfg:{minConv:10,cd:18,adxMax:25}},
    {name:'Conv≥10 cd=18 ADX<30',cfg:{minConv:10,cd:18,adxMax:30}},
    {name:'Conv≥8 cd=24 ADX<25',cfg:{cd:24,adxMax:25}},

    // TP/SL refinements on best frequency
    {name:'Conv≥10 cd=18 TP1.2/SL0.8',cfg:{minConv:10,cd:18,tpM:1.2,slM:0.8}},
    {name:'Conv≥10 cd=18 TP1.5/SL0.8',cfg:{minConv:10,cd:18,tpM:1.5,slM:0.8}},
    {name:'Conv≥10 cd=18 TP2.0/SL1.0',cfg:{minConv:10,cd:18,tpM:2.0,slM:1.0,maxBars:48}},
    {name:'Conv≥10 cd=18 TP1.0/SL0.7',cfg:{minConv:10,cd:18,tpM:1.0,slM:0.7}},
  ];

  console.log('  Config                              | TRAIN WR  PnL    S/D   N | TEST WR   PnL    S/D   N | FULL WR   PnL    S/D   N | AvgPnl  PF');
  console.log('  '+'-'.repeat(145));

  let results=[];
  for(const{name,cfg}of configs){
    const train=testConfig(allBars,0,0.5,cfg);
    const test=testConfig(allBars,0.5,1.0,cfg);
    const full=testConfig(allBars,0,1.0,cfg);
    const tr=`${train.wr.toFixed(1).padStart(5)}% ${(train.pnl>=0?'+':'')+train.pnl.toFixed(2).padStart(6)}% ${train.spd.toFixed(1).padStart(5)} ${String(train.total).padStart(3)}`;
    const te=`${test.wr.toFixed(1).padStart(5)}% ${(test.pnl>=0?'+':'')+test.pnl.toFixed(2).padStart(6)}% ${test.spd.toFixed(1).padStart(5)} ${String(test.total).padStart(3)}`;
    const fu=`${full.wr.toFixed(1).padStart(5)}% ${(full.pnl>=0?'+':'')+full.pnl.toFixed(2).padStart(6)}% ${full.spd.toFixed(1).padStart(5)} ${String(full.total).padStart(3)}`;
    const ap=`${full.avgPnl>=0?'+':''}${full.avgPnl.toFixed(3)}`;
    const pf=full.pf===Infinity?'∞':full.pf.toFixed(2);
    console.log(`  ${name.padEnd(37)} | ${tr} | ${te} | ${fu} | ${ap} ${pf}`);
    results.push({name,cfg,train,test,full});
  }

  // ═══ Find best configs in target range (5-15 s/d) ═══
  console.log('\n  ══════════════════════════════════════════════════════════════════');
  console.log('  BEST CONFIGS IN TARGET RANGE (5-20 s/d, profitable on test)');
  console.log('  ══════════════════════════════════════════════════════════════════\n');

  const inRange=results.filter(r=>r.full.spd>=5&&r.full.spd<=25&&r.test.pnl>0&&r.train.pnl>-2);
  inRange.sort((a,b)=>b.test.pnl-a.test.pnl);
  for(const r of inRange.slice(0,10)){
    console.log(`  ${r.name}`);
    console.log(`    TRAIN: WR=${r.train.wr.toFixed(1)}%, PnL=${(r.train.pnl>=0?'+':'')}${r.train.pnl.toFixed(2)}%, ${r.train.spd.toFixed(1)} s/d, ${r.train.total} sigs`);
    console.log(`    TEST:  WR=${r.test.wr.toFixed(1)}%, PnL=${(r.test.pnl>=0?'+':'')}${r.test.pnl.toFixed(2)}%, ${r.test.spd.toFixed(1)} s/d, ${r.test.total} sigs`);
    console.log(`    FULL:  WR=${r.full.wr.toFixed(1)}%, PnL=${(r.full.pnl>=0?'+':'')}${r.full.pnl.toFixed(2)}%, ${r.full.spd.toFixed(1)} s/d, ${r.full.total} sigs, PF=${r.full.pf.toFixed(2)}`);
    console.log();
  }

  // ═══ Deep analysis of the WINNER ═══
  if(inRange.length>0){
    const w=inRange[0];
    console.log('  ══════════════════════════════════════════════════════════════════');
    console.log(`  ★ WINNER: ${w.name}`);
    console.log('  ══════════════════════════════════════════════════════════════════\n');

    const full=testConfig(allBars,0,1.0,w.cfg);

    // By symbol
    const bySym={};
    for(const t of full.trades){if(!bySym[t.sym])bySym[t.sym]={w:0,l:0,pnl:0};if(t.pnl>0)bySym[t.sym].w++;else bySym[t.sym].l++;bySym[t.sym].pnl+=t.pnl;}
    console.log('  BY SYMBOL:');
    for(const[sym,d]of Object.entries(bySym).sort((a,b)=>b[1].pnl-a[1].pnl)){
      const tot=d.w+d.l;console.log(`    ${sym.padEnd(10)} ${String(tot).padStart(2)} sigs, WR=${(d.w/tot*100).toFixed(0).padStart(3)}%, PnL=${(d.pnl>=0?'+':'')}${d.pnl.toFixed(2)}%`);}

    // By direction
    console.log('\n  BY DIRECTION:');
    const byDir={BUY:{w:0,l:0,pnl:0},SELL:{w:0,l:0,pnl:0}};
    for(const t of full.trades){if(t.pnl>0)byDir[t.signal].w++;else byDir[t.signal].l++;byDir[t.signal].pnl+=t.pnl;}
    for(const[dir,d]of Object.entries(byDir)){const tot=d.w+d.l;if(!tot)continue;console.log(`    ${dir.padEnd(5)} ${tot} sigs, WR=${(d.w/tot*100).toFixed(0)}%, PnL=${(d.pnl>=0?'+':'')}${d.pnl.toFixed(2)}%`);}

    // Quarterly
    console.log('\n  QUARTERLY:');
    for(let q=0;q<4;q++){
      const r=testConfig(allBars,q*0.25,(q+1)*0.25,w.cfg);
      console.log(`    Q${q+1}: WR=${r.wr.toFixed(1).padStart(5)}%, PnL=${(r.pnl>=0?'+':'')}${r.pnl.toFixed(2).padStart(6)}%, ${r.spd.toFixed(1)} s/d, ${r.total} sigs, PF=${r.pf.toFixed(2)}`);}

    // By hour
    console.log('\n  BY HOUR (UTC):');
    const byH={};for(const t of full.trades){if(!byH[t.hUTC])byH[t.hUTC]={w:0,l:0,pnl:0};if(t.pnl>0)byH[t.hUTC].w++;else byH[t.hUTC].l++;byH[t.hUTC].pnl+=t.pnl;}
    for(let h=0;h<24;h++){const d=byH[h];if(!d)continue;const tot=d.w+d.l;console.log(`    ${String(h).padStart(2)}h: ${String(tot).padStart(2)} sigs, WR=${(d.w/tot*100).toFixed(0).padStart(3)}%, PnL=${(d.pnl>=0?'+':'')}${d.pnl.toFixed(2)}%`);}

    // PnL distribution
    const pnls=full.trades.map(t=>t.pnl).sort((a,b)=>a-b);
    console.log('\n  PnL DISTRIBUTION:');
    console.log(`    Worst:  ${pnls[0]?.toFixed(3)}%`);
    console.log(`    P10:    ${pnls[Math.floor(pnls.length*0.1)]?.toFixed(3)}%`);
    console.log(`    P25:    ${pnls[Math.floor(pnls.length*0.25)]?.toFixed(3)}%`);
    console.log(`    Median: ${pnls[Math.floor(pnls.length*0.5)]?.toFixed(3)}%`);
    console.log(`    P75:    ${pnls[Math.floor(pnls.length*0.75)]?.toFixed(3)}%`);
    console.log(`    P90:    ${pnls[Math.floor(pnls.length*0.9)]?.toFixed(3)}%`);
    console.log(`    Best:   ${pnls.at(-1)?.toFixed(3)}%`);
    console.log(`    Avg:    ${full.avgPnl.toFixed(3)}%`);
  }

  console.log('\n'+'═'.repeat(70));
}
main().catch(e=>console.error(e));
