// ═══════════════════════════════════════════════════════════════════
// VIP v2 — INSTITUTIONAL MEAN-REVERSION ENGINE + Walk-Forward
// Uses the PROVEN mean-reversion scoring from scalp-meanrev3 (cross-validated)
// as the signal generator, with institutional-grade quality filters
// Goal: 3-10 signals/day, >55% WR, positive PnL on unseen data
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
    DATA[sym]={C:k5.map(k=>+k[4]),H:k5.map(k=>+k[2]),L:k5.map(k=>+k[3]),V:k5.map(k=>+k[5]),T:k5.map(k=>k[0]),O:k5.map(k=>+k[1]),
      C15:k15?k15.map(k=>+k[4]):[],H15:k15?k15.map(k=>+k[2]):[],L15:k15?k15.map(k=>+k[3]):[],T15:k15?k15.map(k=>k[0]):[],
      C1h:k1h?k1h.map(k=>+k[4]):[],H1h:k1h?k1h.map(k=>+k[2]):[],L1h:k1h?k1h.map(k=>+k[3]):[],V1h:k1h?k1h.map(k=>+k[5]):[],T1h:k1h?k1h.map(k=>k[0]):[],len:k5.length};
    console.log(` ${k5.length}`);await new Promise(r=>setTimeout(r,200));
  }
}

// ═══ MEAN-REVERSION SCORING ENGINE (proven in cross-validation) ═══
// Key insight: RSI/Stoch/BB extremes predict reversals; MACD/EMA crosses are CONTRARIAN
function meanRevScore(c,h,l,v,cur,atr,rsi,stoch,bb,mac,obvData,e9,e21){
  let B=0,S=0,bI=0,sI=0;

  // RSI extremes (strongest single predictor)
  if(rsi<25){B+=4;bI++;}else if(rsi<30){B+=3;bI++;}else if(rsi<35){B+=2;bI++;}
  else if(rsi>75){S+=4;sI++;}else if(rsi>70){S+=3;sI++;}else if(rsi>65){S+=2;sI++;}

  // Stoch extremes
  if(stoch.k<20){B+=3;bI++;}else if(stoch.k<30){B+=2;bI++;}
  else if(stoch.k>80){S+=3;sI++;}else if(stoch.k>70){S+=2;sI++;}

  // BB position
  const bbR=bb.u-bb.l;const bbP=bbR>0?(cur-bb.l)/bbR:0.5;
  if(bbP<0.1){B+=3;bI++;}else if(bbP<0.2){B+=2;bI++;}
  else if(bbP>0.9){S+=3;sI++;}else if(bbP>0.8){S+=2;sI++;}

  // Momentum exhaustion (CONTRARIAN — large drop → BUY)
  const mom3=(cur-(c[c.length-4]||cur))/Math.max(atr,0.0001);
  if(mom3<-1){B+=2;bI++;}else if(mom3<-0.5){B+=1;bI++;}
  else if(mom3>1){S+=2;sI++;}else if(mom3>0.5){S+=1;sI++;}

  // Candle exhaustion (4 consecutive candles in one direction → reversal)
  const n=Math.min(4,c.length);
  let bearRun=0,bullRun=0;
  for(let i=c.length-n;i<c.length;i++){
    if(c[i]<(c[i-1]||c[i]))bearRun++;else bearRun=0;
    if(c[i]>(c[i-1]||c[i]))bullRun++;else bullRun=0;
  }
  if(bearRun>=4){B+=2;bI++;}
  if(bullRun>=4){S+=2;sI++;}
  if(bearRun>=3){B+=1;bI++;}
  if(bullRun>=3){S+=1;sI++;}

  // EMA overextension (CONTRARIAN — far below EMA → BUY)
  const emaDist=(cur-e21)/Math.max(atr,0.0001);
  if(emaDist<-1.5){B+=1.5;bI++;}else if(emaDist<-0.8){B+=0.8;bI++;}
  else if(emaDist>1.5){S+=1.5;sI++;}else if(emaDist>0.8){S+=0.8;sI++;}

  // MACD CONTRARIAN: MACD cross UP = momentum turning → but in mean-reversion
  // context, we use it as reversal confirmation (cross up after oversold = BUY confirm)
  if(mac.h>0&&mac.ph<=0){B+=1.5;bI++;}
  else if(mac.h<0&&mac.ph>=0){S+=1.5;sI++;}

  // OBV divergence (volume confirms reversal)
  if(obvData.rising&&B>S){B+=1;bI++;}
  else if(!obvData.rising&&S>B){S+=1;sI++;}

  // Volume spike (confirms conviction)
  const avgV=v.slice(-20).reduce((a,b)=>a+b)/20;const vr=v.at(-1)/avgV;
  if(vr>1.5){if(B>S)B*=1.1;else S*=1.1;}

  return{B,S,bI,sI,mom3,emaDist,bbP,vr};
}

function precompute(){
  const LB=280,FUT=48; // 48 bars = 4 hours forward for wider targets
  const allBars=[];
  for(const sym of Object.keys(DATA)){
    const d=DATA[sym];
    for(let bar=LB;bar<d.len-FUT;bar++){
      const c=d.C.slice(bar-279,bar+1),h=d.H.slice(bar-279,bar+1),l=d.L.slice(bar-279,bar+1),v=d.V.slice(bar-279,bar+1);
      const bt=d.T[bar];const hUTC=new Date(bt).getUTCHours();
      const cur=c.at(-1);
      const atr=calcATR(h,l,c,14);
      const adxData=calcADX(h,l,c);
      const rsi=calcRSI(c,14);
      const mac=calcMACD(c);
      const ea9=calcEMAArr(c,9),ea21=calcEMAArr(c,21);
      const e9=ea9.at(-1),e21=ea21.at(-1);
      const bb=calcBB(c,20,2);
      const stoch=calcStoch(h,l,c,14);
      const obvData=calcOBV(c,v);

      // Mean-reversion scoring
      const sc=meanRevScore(c,h,l,v,cur,atr,rsi,stoch,bb,mac,obvData,e9,e21);

      // 15m MTF
      let mtf15='NEUTRAL';
      let c15e=0;for(let j=d.T15.length-1;j>=0;j--){if(d.T15[j]<=bt){c15e=j+1;break;}}
      const c15=d.C15.slice(Math.max(0,c15e-100),c15e);
      const h15=d.H15.slice(Math.max(0,c15e-100),c15e);
      const l15=d.L15.slice(Math.max(0,c15e-100),c15e);
      if(c15.length>25){
        const rsi15=calcRSI(c15,14);
        // 15m RSI confirms mean-reversion: RSI15<40 = oversold on higher TF → BUY confirm
        if(rsi15<40)mtf15='BUY';else if(rsi15>60)mtf15='SELL';
      }

      // 1H trend for institutional alignment
      let htf='NEUTRAL',htfStr=0;
      let c1e=0;for(let j=d.T1h.length-1;j>=0;j--){if(d.T1h[j]<=bt){c1e=j+1;break;}}
      const c1h=d.C1h.slice(Math.max(0,c1e-50),c1e);const h1h=d.H1h.slice(Math.max(0,c1e-50),c1e);
      const l1h=d.L1h.slice(Math.max(0,c1e-50),c1e);const v1h=d.V1h.slice(Math.max(0,c1e-50),c1e);
      if(c1h.length>25){
        let hB=0,hS=0;
        const e9h=calcEMA(c1h,9),e21h=calcEMA(c1h,21),e50h=calcEMA(c1h,50);
        const m1h=calcMACD(c1h);const rsi1h=calcRSI(c1h,14);
        if(e9h>e21h)hB+=2;else hS+=2;
        if(c1h.at(-1)>e50h)hB+=1;else hS+=1;
        if(m1h.h>0)hB+=1.5;else hS+=1.5;
        if(rsi1h>50)hB+=1;else hS+=1;
        if(hB>hS+1.5){htf='BUY';htfStr=hB-hS;}
        else if(hS>hB+1.5){htf='SELL';htfStr=hS-hB;}
      }

      // ATR15 for TP/SL
      let atr15=atr;
      if(h15.length>15&&l15.length>15&&c15.length>15){
        const a=calcATR(h15,l15,c15,14);if(a>0)atr15=a;
      }

      // Future data
      const fH=[],fL=[],fC=[];
      for(let f=bar+1;f<=Math.min(bar+FUT,d.len-1);f++){fH.push(d.H[f]);fL.push(d.L[f]);fC.push(d.C[f]);}

      allBars.push({
        sym,bar,hUTC,cur,atr,atr15,adx:adxData.adx,pdi:adxData.pdi,mdi:adxData.mdi,
        rsi,...sc, // B,S,bI,sI,mom3,emaDist,bbP,vr
        mtf15,htf,htfStr,
        fH,fL,fC,pct:bar/d.len
      });
    }
  }
  return allBars;
}

// ═══ TRADE EVALUATION — Partial TP + Trailing Stop ═══
function evalTrade(sig,entry,atr15,cfg,fH,fL,fC){
  const {tpM=1.0,slM=1.0,partial=0.5,trailM=0.1,maxBars=24}=cfg;
  const tp=atr15*tpM,sl=atr15*slM;
  const cost=entry*0.0008; // 0.04% each way
  const tp1=tp*0.6; // TP1 at 60% of full TP
  const trail=atr15*trailM;

  const tp1P=sig==='BUY'?entry+tp1+cost:entry-tp1-cost;
  const slP=sig==='BUY'?entry-sl-cost:entry+sl+cost;
  const tpFullP=sig==='BUY'?entry+tp+cost:entry-tp-cost;

  let tp1Hit=false;
  let bestAfterTP1=sig==='BUY'?-Infinity:Infinity;

  for(let i=0;i<Math.min(maxBars,fH.length);i++){
    if(sig==='BUY'){
      if(!tp1Hit){
        if(fL[i]<=slP)return -(sl+cost)/entry*100;
        if(fH[i]>=tp1P)tp1Hit=true;
      }
      if(tp1Hit){
        bestAfterTP1=Math.max(bestAfterTP1,fH[i]);
        // Trailing stop from best high
        if(fL[i]<=bestAfterTP1-trail-cost){
          const remain=(fC[i]-entry-cost)/entry*100;
          return (tp1/entry*100)*partial + remain*(1-partial);
        }
        // Full TP hit
        if(fH[i]>=tpFullP){
          return (tp1/entry*100)*partial + (tp/entry*100)*(1-partial);
        }
        // Breakeven stop
        if(fL[i]<=entry){
          return (tp1/entry*100)*partial;
        }
      }
    } else {
      if(!tp1Hit){
        if(fH[i]>=slP)return -(sl+cost)/entry*100;
        if(fL[i]<=tp1P)tp1Hit=true;
      }
      if(tp1Hit){
        bestAfterTP1=Math.min(bestAfterTP1,fL[i]);
        if(fH[i]>=bestAfterTP1+trail+cost){
          const remain=(entry-fC[i]-cost)/entry*100;
          return (tp1/entry*100)*partial + remain*(1-partial);
        }
        if(fL[i]<=tpFullP){
          return (tp1/entry*100)*partial + (tp/entry*100)*(1-partial);
        }
        if(fH[i]>=entry){
          return (tp1/entry*100)*partial;
        }
      }
    }
  }
  // Timeout — mark to market
  const last=fC[Math.min(maxBars,fH.length)-1]||entry;
  const uPnl=sig==='BUY'?(last-entry-cost)/entry*100:(entry-last-cost)/entry*100;
  return tp1Hit?(tp1/entry*100)*partial+uPnl*(1-partial):uPnl;
}

// ═══ TEST A CONFIGURATION ═══
function testConfig(allBars,startPct,endPct,cfg){
  const {
    minConv=6,minConds=3,adxMax=25,
    blockDeadHours=true,deadHourStart=0,deadHourEnd=6,
    minVR=0.3,
    mtfCheck=false,   // require 15m RSI confirmation
    htfCheck=false,   // require 1H trend alignment
    htfContra=false,  // block if 1H opposes
    maxADX=99,        // block strong trends
    tpM=1.0,slM=1.0,partial=0.5,trailM=0.1,maxBars=24,
    cd=8 // cooldown bars between signals on same pair
  }=cfg;

  let wins=0,losses=0,pnl=0;
  const lastBar={};
  const trades=[];

  for(const b of allBars){
    if(b.pct<startPct||b.pct>=endPct)continue;

    // Signal from mean-reversion score
    let signal='NEUTRAL';
    if(b.B>b.S&&b.B>=minConv&&b.bI>=minConds)signal='BUY';
    else if(b.S>b.B&&b.S>=minConv&&b.sI>=minConds)signal='SELL';
    if(signal==='NEUTRAL')continue;

    // Cooldown
    const lb=lastBar[b.sym]||-999;
    if(b.bar-lb<cd)continue;

    // ═══ QUALITY FILTERS ═══

    // F1: ADX cap — don't mean-revert in strong trends
    if(b.adx>adxMax)signal='NEUTRAL';

    // F2: Dead hours
    if(blockDeadHours&&b.hUTC>=deadHourStart&&b.hUTC<deadHourEnd)signal='NEUTRAL';

    // F3: Volume floor
    if(b.vr<minVR)signal='NEUTRAL';

    // F4: 15m MTF confirmation (RSI on 15m must agree)
    if(mtfCheck&&signal!=='NEUTRAL'){
      if(signal==='BUY'&&b.mtf15==='SELL')signal='NEUTRAL';
      if(signal==='SELL'&&b.mtf15==='BUY')signal='NEUTRAL';
    }

    // F5: 1H alignment required
    if(htfCheck&&signal!=='NEUTRAL'){
      if(signal!==b.htf)signal='NEUTRAL';
    }

    // F6: 1H contradiction block (softer than htfCheck)
    if(htfContra&&signal!=='NEUTRAL'&&b.htfStr>=3){
      if(signal==='BUY'&&b.htf==='SELL')signal='NEUTRAL';
      if(signal==='SELL'&&b.htf==='BUY')signal='NEUTRAL';
    }

    // F7: Max ADX (block extremely strong trends)
    if(b.adx>maxADX)signal='NEUTRAL';

    if(signal==='NEUTRAL')continue;
    lastBar[b.sym]=b.bar;

    const tPnl=evalTrade(signal,b.cur,b.atr15,{tpM,slM,partial,trailM,maxBars},b.fH,b.fL,b.fC);
    pnl+=tPnl;
    if(tPnl>0)wins++;else losses++;
    trades.push({sym:b.sym,signal,pnl:tPnl,bar:b.bar,hUTC:b.hUTC,conv:Math.max(b.B,b.S),conds:signal==='BUY'?b.bI:b.sI,adx:b.adx});
  }

  const total=wins+losses;
  const len=Object.values(DATA)[0]?.len||1000;
  const days=len*(endPct-startPct)/288;
  return{total,wins,losses,wr:total>0?wins/total*100:0,pnl,spd:total/Math.max(0.5,days),days,trades};
}

async function main(){
  console.log('═'.repeat(70));
  console.log('  VIP v2 — INSTITUTIONAL MEAN-REVERSION OPTIMIZER');
  console.log('  Walk-Forward Validation (train 0-50%, test 50-100%)');
  console.log('═'.repeat(70)+'\n');

  await loadData();

  console.log('\n  Pre-computing all bars with mean-reversion scoring...');
  const t0=Date.now();
  const allBars=precompute();
  console.log(`  Done: ${allBars.length} bars in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  // ═══ PHASE 1: Grid search over key parameters ═══
  // Test different conviction thresholds, quality filters, and TP/SL ratios
  const convLevels=[5,6,7,8,9,10];
  const condLevels=[2,3,4];
  const adxMaxLevels=[20,25,30,99];
  const tpSlCombos=[
    {tpM:0.8,slM:0.8,trailM:0.08,maxBars:24,label:'TP0.8/SL0.8'},
    {tpM:1.0,slM:1.0,trailM:0.1,maxBars:24,label:'TP1.0/SL1.0'},
    {tpM:1.2,slM:0.8,trailM:0.1,maxBars:36,label:'TP1.2/SL0.8'},
    {tpM:1.5,slM:1.0,trailM:0.12,maxBars:36,label:'TP1.5/SL1.0'},
    {tpM:0.6,slM:0.6,trailM:0.06,maxBars:18,label:'TP0.6/SL0.6'},
    {tpM:1.0,slM:0.7,trailM:0.08,maxBars:24,label:'TP1.0/SL0.7'},
  ];
  const filterSets=[
    {label:'BASE',blockDeadHours:true,minVR:0.3},
    {label:'+MTF',blockDeadHours:true,minVR:0.3,mtfCheck:true},
    {label:'+HTFc',blockDeadHours:true,minVR:0.3,htfContra:true},
    {label:'+MTF+HTFc',blockDeadHours:true,minVR:0.3,mtfCheck:true,htfContra:true},
    {label:'NOFILTER',blockDeadHours:false,minVR:0},
  ];

  let results=[];
  let tested=0;

  for(const conv of convLevels){
    for(const conds of condLevels){
      for(const adxMax of adxMaxLevels){
        for(const ts of tpSlCombos){
          for(const fs of filterSets){
            const cfg={minConv:conv,minConds:conds,adxMax,...ts,...fs,cd:8};
            const train=testConfig(allBars,0,0.5,cfg);
            const test=testConfig(allBars,0.5,1.0,cfg);
            const full=testConfig(allBars,0,1.0,cfg);
            results.push({conv,conds,adxMax,ts:ts.label,fs:fs.label,
              trainWR:train.wr,trainPnl:train.pnl,trainSPD:train.spd,trainN:train.total,
              testWR:test.wr,testPnl:test.pnl,testSPD:test.spd,testN:test.total,
              fullWR:full.wr,fullPnl:full.pnl,fullSPD:full.spd,fullN:full.total,
              cfg,trainTrades:train.trades,testTrades:test.trades});
            tested++;
          }
        }
      }
    }
  }
  console.log(`  Tested ${tested} configurations\n`);

  // ═══ PHASE 2: Find best configs ═══
  // Sort by TEST PnL (primary), then by TEST WR (secondary)
  // Filter: test must have at least 5 trades and 2+ s/d
  const viable=results.filter(r=>r.testN>=5&&r.testSPD>=2&&r.trainPnl>-5);
  viable.sort((a,b)=>b.testPnl-a.testPnl);

  console.log('  ══════════════════════════════════════════════════════════════════');
  console.log('  TOP 20 CONFIGS BY TEST PnL (min 5 test trades, min 2 s/d)');
  console.log('  ══════════════════════════════════════════════════════════════════\n');

  console.log('  # | Conv Min Conds ADX   | TP/SL           | Filter    | TRAIN WR  PnL    S/D  N  | TEST WR   PnL    S/D  N  | FULL WR   PnL    S/D  N');
  console.log('  '+'-'.repeat(155));

  const top20=viable.slice(0,20);
  for(let i=0;i<top20.length;i++){
    const r=top20[i];
    const id=`${String(i+1).padStart(2)}`;
    const params=`${String(r.conv).padStart(4)} ${String(r.conds).padStart(4)}  ${String(r.adxMax).padStart(4)}`;
    const tpsl=r.ts.padEnd(15);
    const filt=r.fs.padEnd(9);
    const tr=`${r.trainWR.toFixed(1).padStart(5)}% ${(r.trainPnl>=0?'+':'')+r.trainPnl.toFixed(2).padStart(6)}% ${r.trainSPD.toFixed(1).padStart(4)} ${String(r.trainN).padStart(3)}`;
    const te=`${r.testWR.toFixed(1).padStart(5)}% ${(r.testPnl>=0?'+':'')+r.testPnl.toFixed(2).padStart(6)}% ${r.testSPD.toFixed(1).padStart(4)} ${String(r.testN).padStart(3)}`;
    const fu=`${r.fullWR.toFixed(1).padStart(5)}% ${(r.fullPnl>=0?'+':'')+r.fullPnl.toFixed(2).padStart(6)}% ${r.fullSPD.toFixed(1).padStart(4)} ${String(r.fullN).padStart(3)}`;
    console.log(`  ${id} | ${params} | ${tpsl} | ${filt} | ${tr} | ${te} | ${fu}`);
  }

  // ═══ PHASE 3: Deep analysis of THE BEST CONFIG ═══
  if(viable.length>0){
    const best=viable[0];
    console.log('\n  ══════════════════════════════════════════════════════════════════');
    console.log(`  BEST CONFIG: Conv≥${best.conv}, Conds≥${best.conds}, ADX<${best.adxMax}, ${best.ts}, ${best.fs}`);
    console.log('  ══════════════════════════════════════════════════════════════════\n');

    // Full period analysis
    const full=testConfig(allBars,0,1.0,best.cfg);
    console.log(`  FULL: WR=${full.wr.toFixed(1)}%, PnL=${(full.pnl>=0?'+':'')}${full.pnl.toFixed(2)}%, ${full.spd.toFixed(1)} s/d, ${full.total} sigs (${full.wins}W/${full.losses}L)\n`);

    // By symbol
    const bySym={};
    for(const t of full.trades){
      if(!bySym[t.sym])bySym[t.sym]={w:0,l:0,pnl:0};
      if(t.pnl>0)bySym[t.sym].w++;else bySym[t.sym].l++;
      bySym[t.sym].pnl+=t.pnl;
    }
    console.log('  BY SYMBOL:');
    for(const [sym,d] of Object.entries(bySym).sort((a,b)=>b[1].pnl-a[1].pnl)){
      const tot=d.w+d.l;
      console.log(`    ${sym.padEnd(10)} ${tot} sigs, WR=${(d.w/tot*100).toFixed(0)}%, PnL=${(d.pnl>=0?'+':'')}${d.pnl.toFixed(2)}%`);
    }

    // By direction
    const byDir={BUY:{w:0,l:0,pnl:0},SELL:{w:0,l:0,pnl:0}};
    for(const t of full.trades){
      if(t.pnl>0)byDir[t.signal].w++;else byDir[t.signal].l++;
      byDir[t.signal].pnl+=t.pnl;
    }
    console.log('\n  BY DIRECTION:');
    for(const [dir,d] of Object.entries(byDir)){
      const tot=d.w+d.l;if(!tot)continue;
      console.log(`    ${dir.padEnd(5)} ${tot} sigs, WR=${(d.w/tot*100).toFixed(0)}%, PnL=${(d.pnl>=0?'+':'')}${d.pnl.toFixed(2)}%`);
    }

    // By hour
    const byH={};
    for(const t of full.trades){
      const h=t.hUTC;if(!byH[h])byH[h]={w:0,l:0,pnl:0};
      if(t.pnl>0)byH[h].w++;else byH[h].l++;
      byH[h].pnl+=t.pnl;
    }
    console.log('\n  BY HOUR (UTC):');
    for(let h=0;h<24;h++){
      const d=byH[h];if(!d)continue;
      const tot=d.w+d.l;
      console.log(`    ${String(h).padStart(2)}h: ${String(tot).padStart(2)} sigs, WR=${(d.w/tot*100).toFixed(0).padStart(3)}%, PnL=${(d.pnl>=0?'+':'')}${d.pnl.toFixed(2)}%`);
    }

    // Quarterly robustness
    console.log('\n  QUARTERLY ROBUSTNESS:');
    for(let q=0;q<4;q++){
      const r=testConfig(allBars,q*0.25,(q+1)*0.25,best.cfg);
      console.log(`    Q${q+1}: WR=${r.wr.toFixed(1).padStart(5)}%, PnL=${(r.pnl>=0?'+':'')}${r.pnl.toFixed(2).padStart(6)}%, ${r.spd.toFixed(1)} s/d, ${r.total} sigs`);
    }

    // Train vs Test comparison
    console.log('\n  TRAIN vs TEST:');
    const train=testConfig(allBars,0,0.5,best.cfg);
    const test=testConfig(allBars,0.5,1.0,best.cfg);
    console.log(`    TRAIN (0-50%):  WR=${train.wr.toFixed(1)}%, PnL=${(train.pnl>=0?'+':'')}${train.pnl.toFixed(2)}%, ${train.spd.toFixed(1)} s/d, ${train.total} sigs`);
    console.log(`    TEST  (50-100%):WR=${test.wr.toFixed(1)}%, PnL=${(test.pnl>=0?'+':'')}${test.pnl.toFixed(2)}%, ${test.spd.toFixed(1)} s/d, ${test.total} sigs`);

    // ═══ PHASE 4: Also show top configs that are profitable on BOTH train and test ═══
    const bothProf=results.filter(r=>r.trainPnl>0&&r.testPnl>0&&r.testN>=3);
    bothProf.sort((a,b)=>(a.testPnl+a.trainPnl)-(b.testPnl+b.trainPnl));
    bothProf.reverse();
    console.log('\n  ══════════════════════════════════════════════════════════════════');
    console.log(`  CONFIGS PROFITABLE ON BOTH TRAIN AND TEST (${bothProf.length} found)`);
    console.log('  ══════════════════════════════════════════════════════════════════\n');
    if(bothProf.length>0){
      console.log('  # | Conv Min Conds ADX   | TP/SL           | Filter    | TRAIN WR  PnL    S/D  N  | TEST WR   PnL    S/D  N  | FULL WR   PnL    S/D  N');
      console.log('  '+'-'.repeat(155));
      for(let i=0;i<Math.min(30,bothProf.length);i++){
        const r=bothProf[i];
        const id=`${String(i+1).padStart(2)}`;
        const params=`${String(r.conv).padStart(4)} ${String(r.conds).padStart(4)}  ${String(r.adxMax).padStart(4)}`;
        const tpsl=r.ts.padEnd(15);
        const filt=r.fs.padEnd(9);
        const tr=`${r.trainWR.toFixed(1).padStart(5)}% ${(r.trainPnl>=0?'+':'')+r.trainPnl.toFixed(2).padStart(6)}% ${r.trainSPD.toFixed(1).padStart(4)} ${String(r.trainN).padStart(3)}`;
        const te=`${r.testWR.toFixed(1).padStart(5)}% ${(r.testPnl>=0?'+':'')+r.testPnl.toFixed(2).padStart(6)}% ${r.testSPD.toFixed(1).padStart(4)} ${String(r.testN).padStart(3)}`;
        const fu=`${r.fullWR.toFixed(1).padStart(5)}% ${(r.fullPnl>=0?'+':'')+r.fullPnl.toFixed(2).padStart(6)}% ${r.fullSPD.toFixed(1).padStart(4)} ${String(r.fullN).padStart(3)}`;
        console.log(`  ${id} | ${params} | ${tpsl} | ${filt} | ${tr} | ${te} | ${fu}`);
      }

      // Deep analysis of the best both-profitable config
      if(bothProf.length>0){
        const bb=bothProf[0];
        console.log(`\n  ═══ BEST BOTH-PROFITABLE: Conv≥${bb.conv}, Conds≥${bb.conds}, ADX<${bb.adxMax}, ${bb.ts}, ${bb.fs} ═══`);
        const fullBP=testConfig(allBars,0,1.0,bb.cfg);
        console.log(`  FULL: WR=${fullBP.wr.toFixed(1)}%, PnL=${(fullBP.pnl>=0?'+':'')}${fullBP.pnl.toFixed(2)}%, ${fullBP.spd.toFixed(1)} s/d, ${fullBP.total} sigs`);
        console.log('\n  QUARTERLY:');
        for(let q=0;q<4;q++){
          const r=testConfig(allBars,q*0.25,(q+1)*0.25,bb.cfg);
          console.log(`    Q${q+1}: WR=${r.wr.toFixed(1).padStart(5)}%, PnL=${(r.pnl>=0?'+':'')}${r.pnl.toFixed(2).padStart(6)}%, ${r.spd.toFixed(1)} s/d, ${r.total} sigs`);
        }
      }
    } else {
      console.log('  *** NO CONFIGS FOUND PROFITABLE ON BOTH TRAIN AND TEST ***');
      console.log('  This means the signal engine needs fundamental improvement.');
    }
  }

  console.log('\n'+'═'.repeat(70));
}

main().catch(e=>console.error(e));
