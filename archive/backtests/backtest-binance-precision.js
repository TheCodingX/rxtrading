#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// BINANCE PRECISION MOTOR — Optimizer
// Tests MULTIPLE configurations to find PF>1.5, WR>50%, max PnL
// Real-world: FUTURES klines, fees, slippage, 1-bar delay
// ═══════════════════════════════════════════════════════════════

const https = require('https');
const DAYS = 60;
const TRADE_AMT = 500, LEVERAGE = 5;
const TAKER_FEE = 0.0004;
const SLIPPAGE = 0.0003;
const DELAY_BARS = 1;

const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','LINKUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','ARBUSDT','OPUSDT','SUIUSDT','JUPUSDT'];

// ═══ INDICATORS ═══
function calcEMA(a,p){if(!a||a.length<p)return a?a[a.length-1]||0:0;let m=2/(p+1),e=a[0];for(let i=1;i<a.length;i++)e=a[i]*m+e*(1-m);return e;}
function calcEMAArr(a,p){if(!a||!a.length)return[];let m=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*m+r[i-1]*(1-m));return r;}
function calcRSI(c,p=14){if(!c||c.length<p+1)return 50;let g=0,l=0;for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l-=d;}g/=p;l/=p;if(l===0)return 100;return 100-100/(1+g/l);}
function calcMACD(c){if(!c||c.length<26)return{h:0,ph:0};const e12=calcEMAArr(c,12),e26=calcEMAArr(c,26);const ml=[];for(let i=0;i<c.length;i++)ml.push((e12[i]||0)-(e26[i]||0));const sl=calcEMAArr(ml,9);return{h:(ml.at(-1)||0)-(sl.at(-1)||0),ph:(ml.at(-2)||0)-(sl.at(-2)||0)};}
function calcBB(c,p=20,k=2){if(!c||c.length<p)return{u:0,m:0,l:0};const sl=c.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const std=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/p);return{u:m+k*std,m,l:m-k*std};}
function calcStoch(h,l,c,p=14){if(!h||h.length<p)return{k:50};const hh=Math.max(...h.slice(-p)),ll=Math.min(...l.slice(-p));return{k:hh!==ll?((c.at(-1)-ll)/(hh-ll))*100:50};}
function calcATR(h,l,c,p=14){if(!h||h.length<p+1)return 0;let trs=[];for(let i=1;i<h.length;i++)trs.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));const sl=trs.slice(-p);return sl.reduce((a,b)=>a+b)/sl.length;}
function calcADX(h,l,c,p=14){if(!h||h.length<p*2)return{adx:0,pdi:0,mdi:0};let pdm=[],mdm=[],tr=[];for(let i=1;i<h.length;i++){const up=h[i]-h[i-1],dn=l[i-1]-l[i];pdm.push(up>dn&&up>0?up:0);mdm.push(dn>up&&dn>0?dn:0);tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));}const atr=calcEMA(tr,p)||1;const sPDM=calcEMA(pdm,p);const sMDM=calcEMA(mdm,p);const pdi=(sPDM/atr)*100;const mdi=(sMDM/atr)*100;const dx=pdi+mdi>0?Math.abs(pdi-mdi)/(pdi+mdi)*100:0;return{adx:dx,pdi,mdi};}
function calcOBV(c,v){if(!c||c.length<2)return{rising:false};let obv=0;for(let i=1;i<c.length;i++){if(c[i]>c[i-1])obv+=v[i];else if(c[i]<c[i-1])obv-=v[i];}let obv5=0;const p5=c.length>6?c.slice(-6,-1):c;for(let i=1;i<p5.length;i++){if(p5[i]>p5[i-1])obv5+=v[v.length-p5.length+i]||0;}return{rising:obv>obv5};}
function calcMFI(h,l,c,v,p=14){if(!h||h.length<p+1)return 50;let pF=0,nF=0;for(let i=h.length-p;i<h.length;i++){const tp=(h[i]+l[i]+c[i])/3;const ptp=(h[i-1]+l[i-1]+c[i-1])/3;const mf=tp*v[i];if(tp>ptp)pF+=mf;else nF+=mf;}if(nF===0)return 100;return 100-100/(1+pF/nF);}
function calcVWAP(kl){if(!kl||!kl.length)return 0;let cV=0,cTP=0;kl.forEach(k=>{const h=parseFloat(k[2]),l=parseFloat(k[3]),c=parseFloat(k[4]),v=parseFloat(k[5]);cV+=v;cTP+=(h+l+c)/3*v;});return cV>0?cTP/cV:0;}
function calcKeltner(h,l,c,ep=20,ap=14,m=2){const e=calcEMA(c,ep);const a=calcATR(h,l,c,ap);const w=2*m*a;return w>0?(c.at(-1)-(e-m*a))/w:0.5;}
function calcPSAR(h,l,c){if(!h||h.length<3)return{trend:'BUY'};let t='BUY',af=0.02,ep=h[0],sar=l[0];for(let i=1;i<h.length;i++){sar=sar+af*(ep-sar);if(t==='BUY'){if(l[i]<sar){t='SELL';sar=ep;ep=l[i];af=0.02;}else if(h[i]>ep){ep=h[i];af=Math.min(af+0.02,0.2);}}else{if(h[i]>sar){t='BUY';sar=ep;ep=h[i];af=0.02;}else if(l[i]<ep){ep=l[i];af=Math.min(af+0.02,0.2);}}}return{trend:t};}

function fetchJSON(url){return new Promise((r,j)=>{https.get(url,{timeout:15000},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}
async function getFK(sym,tf,limit,end){try{return await fetchJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=${limit}${end?'&endTime='+end:''}`);}catch(e){return null;}}

// ═══ STRATEGY CONFIGS TO TEST ═══
const CONFIGS = [
  // Strategy 1: Pure trend-following, high R:R, very selective
  { name: 'TREND-3.0-HIGH', tpMult: 3.0, slMult: 1.0, minScore: 8, minInds: 5, cdBars: 48, requireHTF: true, requireMTF: true, requireADX: 25, onlyTrendFollow: true },
  { name: 'TREND-2.5-HIGH', tpMult: 2.5, slMult: 1.0, minScore: 8, minInds: 5, cdBars: 36, requireHTF: true, requireMTF: true, requireADX: 22, onlyTrendFollow: true },
  { name: 'TREND-2.0-MED', tpMult: 2.0, slMult: 0.8, minScore: 7, minInds: 4, cdBars: 24, requireHTF: true, requireMTF: true, requireADX: 20, onlyTrendFollow: true },

  // Strategy 2: Trend + momentum confirmation, longer holds
  { name: 'MOMENTUM-3.0', tpMult: 3.0, slMult: 1.2, minScore: 7, minInds: 4, cdBars: 36, requireHTF: true, requireMTF: false, requireADX: 22, onlyTrendFollow: true },
  { name: 'MOMENTUM-2.5', tpMult: 2.5, slMult: 1.0, minScore: 7, minInds: 4, cdBars: 24, requireHTF: true, requireMTF: false, requireADX: 20, onlyTrendFollow: true },

  // Strategy 3: Ultra selective — only extreme confluence
  { name: 'ULTRA-SELECT', tpMult: 3.5, slMult: 1.0, minScore: 10, minInds: 6, cdBars: 60, requireHTF: true, requireMTF: true, requireADX: 25, onlyTrendFollow: true },
  { name: 'ULTRA-2.0', tpMult: 2.0, slMult: 0.7, minScore: 9, minInds: 5, cdBars: 48, requireHTF: true, requireMTF: true, requireADX: 22, onlyTrendFollow: true },

  // Strategy 4: Low frequency high R:R with green candle confirmation
  { name: 'GREEN-CONFIRM-3', tpMult: 3.0, slMult: 1.0, minScore: 7, minInds: 4, cdBars: 36, requireHTF: true, requireMTF: true, requireADX: 20, onlyTrendFollow: true, requireGreenCandle: true },
  { name: 'GREEN-CONFIRM-2.5', tpMult: 2.5, slMult: 0.8, minScore: 7, minInds: 4, cdBars: 24, requireHTF: true, requireMTF: true, requireADX: 18, onlyTrendFollow: true, requireGreenCandle: true },

  // Strategy 5: Very long cooldown, maximum selectivity
  { name: 'SNIPER-4.0', tpMult: 4.0, slMult: 1.2, minScore: 9, minInds: 5, cdBars: 72, requireHTF: true, requireMTF: true, requireADX: 25, onlyTrendFollow: true, requireGreenCandle: true },
  { name: 'SNIPER-3.0', tpMult: 3.0, slMult: 0.8, minScore: 8, minInds: 5, cdBars: 60, requireHTF: true, requireMTF: true, requireADX: 22, onlyTrendFollow: true, requireGreenCandle: true },

  // Strategy 6: Volume-confirmed trend entries
  { name: 'VOLUME-TREND-3', tpMult: 3.0, slMult: 1.0, minScore: 7, minInds: 4, cdBars: 36, requireHTF: true, requireMTF: true, requireADX: 20, onlyTrendFollow: true, requireVolume: 1.2 },
  { name: 'VOLUME-TREND-2.5', tpMult: 2.5, slMult: 0.8, minScore: 7, minInds: 4, cdBars: 24, requireHTF: true, requireMTF: true, requireADX: 18, onlyTrendFollow: true, requireVolume: 1.0 },

  // Strategy 7: ATR(20) for more stable TP/SL
  { name: 'ATR20-TREND-3', tpMult: 3.0, slMult: 1.0, minScore: 7, minInds: 4, cdBars: 36, requireHTF: true, requireMTF: true, requireADX: 20, onlyTrendFollow: true, atrPeriod: 20 },
  { name: 'ATR20-TREND-2', tpMult: 2.0, slMult: 0.7, minScore: 7, minInds: 4, cdBars: 24, requireHTF: true, requireMTF: true, requireADX: 18, onlyTrendFollow: true, atrPeriod: 20 },
];

// ═══ SIGNAL GENERATOR ═══
function generateSignal(kl5, kl15, kl1h, cfg) {
  if(!kl5 || kl5.length < 100) return null;
  const C=kl5.map(k=>parseFloat(k[4])),H=kl5.map(k=>parseFloat(k[2])),L=kl5.map(k=>parseFloat(k[3])),V=kl5.map(k=>parseFloat(k[5]));
  const cur=C.at(-1);

  // HTF
  const C1h=kl1h&&kl1h.length>15?kl1h.map(k=>parseFloat(k[4])):[];
  const H1h=kl1h&&kl1h.length>15?kl1h.map(k=>parseFloat(k[2])):[];
  const L1h=kl1h&&kl1h.length>15?kl1h.map(k=>parseFloat(k[3])):[];
  const V1h=kl1h&&kl1h.length>15?kl1h.map(k=>parseFloat(k[5])):[];
  let htf='NEUTRAL';
  if(kl1h&&kl1h.length>25){
    let hB=0,hS=0;
    const e9=calcEMA(C1h,9),e21=calcEMA(C1h,21),e50=calcEMA(C1h,50);
    const mac=calcMACD(C1h);const rsi=calcRSI(C1h,14);const adx=calcADX(H1h,L1h,C1h);const obv=calcOBV(C1h,V1h);
    if(e9>e21)hB+=2;else hS+=2;if(C1h.at(-1)>e50)hB++;else hS++;
    if(mac.h>0)hB+=1.5;else hS+=1.5;if(rsi>50)hB++;else hS++;
    if(adx.adx>20&&adx.pdi>adx.mdi)hB+=1.5;else if(adx.adx>20)hS+=1.5;
    if(obv.rising)hB++;else hS++;
    if(hB>hS+2)htf='BUY';else if(hS>hB+2)htf='SELL';
  }

  if(cfg.requireHTF && htf === 'NEUTRAL') return null;

  // MTF 15m
  const C15=kl15?kl15.map(k=>parseFloat(k[4])):[];
  let mtf='NEUTRAL';
  if(C15.length>25){const e9=calcEMA(C15,9),e21=calcEMA(C15,21);const mac=calcMACD(C15);let mB=0,mS=0;if(e9>e21)mB++;else mS++;if(mac.h>0)mB++;else mS++;if(mB>mS)mtf='BUY';else if(mS>mB)mtf='SELL';}

  if(cfg.requireMTF && mtf === 'NEUTRAL') return null;
  if(cfg.requireMTF && cfg.requireHTF && mtf !== htf) return null; // Both gates must agree

  // ADX check
  const adxData=calcADX(H,L,C);
  if(cfg.requireADX && adxData.adx < cfg.requireADX) return null;

  const atrPer = cfg.atrPeriod || 14;
  let atr=calcATR(H,L,C,atrPer);

  // Scoring
  const rsiS=calcRSI(C,7);const mac=calcMACD(C);
  const ea5=calcEMAArr(C,5),ea13=calcEMAArr(C,13);const e5=ea5.at(-1),e13=ea13.at(-1);
  const bbS=calcBB(C,10,1.8);const bbSR=bbS.u-bbS.l;const bbSPos=bbSR>0?(cur-bbS.l)/bbSR:0.5;
  const vwap=calcVWAP(kl5.slice(-50));
  const avgV=V.slice(-20).reduce((a,b)=>a+b)/20,lv=V.at(-1),vr=lv/avgV;
  const stK=calcStoch(H,L,C,7).k||50;
  const psar=calcPSAR(H,L,C);
  const kcPos=calcKeltner(H,L,C,20,14,2);
  const mfi=calcMFI(H,L,C,V,7);

  let bS=0,sS=0,bI=0,sI=0;

  if(rsiS<25){bS+=3;bI++;}else if(rsiS<35){bS+=2;bI++;}else if(rsiS<45){bS+=1;bI++;}
  else if(rsiS>75){sS+=3;sI++;}else if(rsiS>65){sS+=2;sI++;}else if(rsiS>55){sS+=1;sI++;}

  if(stK<25){bS+=3;bI++;}else if(stK<40){bS+=1.5;bI++;}
  else if(stK>75){sS+=3;sI++;}else if(stK>60){sS+=1.5;sI++;}

  if(bbSPos<0.08){bS+=3;bI++;}else if(bbSPos<0.25){bS+=2;bI++;}
  else if(bbSPos>0.92){sS+=3;sI++;}else if(bbSPos>0.75){sS+=2;sI++;}

  if(mac.h>0&&mac.ph<=0){bS+=2.5;bI++;}else if(mac.h<0&&mac.ph>=0){sS+=2.5;sI++;}
  else if(mac.h>0){bS+=0.5;}else{sS+=0.5;}

  if(e5>e13){bS+=1.5;bI++;}else{sS+=1.5;sI++;}
  if(vwap&&cur<vwap){bS+=1;bI++;}else if(vwap&&cur>vwap){sS+=1;sI++;}

  if(vr>1.5){if(rsiS<50){bS+=2;bI++;}else{sS+=2;sI++;}}
  else if(vr>0.8){if(rsiS<50)bS+=0.5;else sS+=0.5;}

  if(kcPos<0.25){bS+=1.5;bI++;}else if(kcPos>0.75){sS+=1.5;sI++;}
  if(psar.trend==='BUY'){bS+=1;bI++;}else{sS+=1;sI++;}
  if(mfi<35){bS+=1.5;bI++;}else if(mfi>65){sS+=1.5;sI++;}

  // ADX directional bonus
  if(adxData.pdi>adxData.mdi){bS+=1;bI++;}else{sS+=1;sI++;}

  let signal='NEUTRAL',score=0;

  // ONLY trend-following: signal must match HTF direction
  if(cfg.onlyTrendFollow){
    if(htf==='BUY'&&bS>=cfg.minScore&&bI>=cfg.minInds){signal='BUY';score=bS;}
    else if(htf==='SELL'&&sS>=cfg.minScore&&sI>=cfg.minInds){signal='SELL';score=sS;}
  } else {
    if(bS>=cfg.minScore&&bI>=cfg.minInds&&bS>sS+1.5){signal='BUY';score=bS;}
    else if(sS>=cfg.minScore&&sI>=cfg.minInds&&sS>bS+1.5){signal='SELL';score=sS;}
  }

  if(signal==='NEUTRAL') return null;

  // Volume requirement
  if(cfg.requireVolume && vr < cfg.requireVolume) return null;

  // Green candle confirmation
  if(cfg.requireGreenCandle){
    const lastOpen=parseFloat(kl5[kl5.length-1][1]);
    const lastClose=cur;
    if(signal==='BUY'&&lastClose<=lastOpen) return null;
    if(signal==='SELL'&&lastClose>=lastOpen) return null;
  }

  const useATR=calcATR(H,L,C,atrPer)||atr;
  let tpDist=useATR*cfg.tpMult, slDist=useATR*cfg.slMult;
  if(tpDist<cur*0.003)tpDist=cur*0.003;
  if(slDist<cur*0.001)slDist=cur*0.001;

  return{signal,score,entry:cur,tpDist,slDist};
}

// ═══ RUN ONE CONFIG ═══
function runBacktest(cfg, allData) {
  const cdMs = cfg.cdBars * 5 * 60 * 1000;
  let trades=0,wins=0,losses=0,totalPnl=0,gP=0,gL=0;
  let maxCW=0,maxCL=0,cW=0,cL=0;
  let bal=10000,peak=10000,maxDD=0;

  for(const sym of SYMBOLS){
    const data=allData[sym];
    if(!data||!data.kl5||data.kl5.length<300) continue;
    const {kl5,kl15,kl1h}=data;
    let lastSigTime=0;

    for(let i=280;i<kl5.length-DELAY_BARS-1;i++){
      const bt=parseInt(kl5[i][0]);
      if(bt-lastSigTime<cdMs) continue;

      const sig=generateSignal(
        kl5.slice(Math.max(0,i-280),i+1),
        kl15.filter(k=>parseInt(k[0])<=bt).slice(-100),
        kl1h.filter(k=>parseInt(k[0])<=bt).slice(-50),
        cfg
      );
      if(!sig) continue;
      lastSigTime=bt;

      // Delayed entry
      const dBar=kl5[i+DELAY_BARS];
      if(!dBar) continue;
      const dOpen=parseFloat(dBar[1]);
      const slipDir=sig.signal==='BUY'?1:-1;
      const actualEntry=dOpen*(1+slipDir*SLIPPAGE);

      let tp,sl;
      if(sig.signal==='BUY'){tp=actualEntry+sig.tpDist;sl=actualEntry-sig.slDist;}
      else{tp=actualEntry-sig.tpDist;sl=actualEntry+sig.slDist;}

      let result=null,exitPrice=actualEntry;
      for(let j=i+DELAY_BARS+1;j<kl5.length&&j<i+300;j++){
        const cH=parseFloat(kl5[j][2]),cL=parseFloat(kl5[j][3]),cO=parseFloat(kl5[j][1]);
        if(sig.signal==='BUY'){
          if(cH>=tp&&cL<=sl){result=Math.abs(cO-sl)<Math.abs(cO-tp)?'L':'W';exitPrice=result==='W'?tp:sl;break;}
          if(cH>=tp){result='W';exitPrice=tp;break;}
          if(cL<=sl){result='L';exitPrice=sl;break;}
        }else{
          if(cL<=tp&&cH>=sl){result=Math.abs(cO-sl)<Math.abs(cO-tp)?'L':'W';exitPrice=result==='W'?tp:sl;break;}
          if(cL<=tp){result='W';exitPrice=tp;break;}
          if(cH>=sl){result='L';exitPrice=sl;break;}
        }
      }
      if(!result) continue;

      const pct=sig.signal==='BUY'?(exitPrice-actualEntry)/actualEntry:(actualEntry-exitPrice)/actualEntry;
      const gross=TRADE_AMT*LEVERAGE*pct;
      const fee=TRADE_AMT*LEVERAGE*TAKER_FEE*2;
      const net=gross-fee;

      trades++;totalPnl+=net;bal+=net;
      if(net>0){wins++;gP+=net;cW++;cL=0;if(cW>maxCW)maxCW=cW;}
      else{losses++;gL+=Math.abs(net);cL++;cW=0;if(cL>maxCL)maxCL=cL;}
      if(bal>peak)peak=bal;
      const dd=(peak-bal)/peak*100;
      if(dd>maxDD)maxDD=dd;
    }
  }

  const wr=trades>0?(wins/trades*100):0;
  const pf=gL>0?gP/gL:0;
  return{name:cfg.name,trades,wr,pf,pnl:totalPnl,maxDD,maxCW,maxCL,sigDay:(trades/DAYS).toFixed(1),
    avgWin:wins>0?(gP/wins):0,avgLoss:losses>0?(gL/losses):0,
    fees:trades*TRADE_AMT*LEVERAGE*TAKER_FEE*2};
}

// ═══ MAIN ═══
(async()=>{
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  BINANCE PRECISION — Multi-Strategy Optimizer        ║');
  console.log('║  60 days FUTURES, real fees+slippage+delay           ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Download data
  const endTime=Date.now(),startTime=endTime-DAYS*24*60*60*1000;
  const allData={};
  for(const sym of SYMBOLS){
    process.stdout.write(`  ${sym}...`);
    let kl5=[],kl15=[],kl1h=[];
    let fe=endTime;
    while(true){const b=await getFK(sym,'5m',1000,fe);if(!b||!b.length)break;kl5=b.concat(kl5);if(b[0][0]<=startTime)break;fe=b[0][0]-1;await new Promise(r=>setTimeout(r,80));}
    fe=endTime;
    while(true){const b=await getFK(sym,'15m',1000,fe);if(!b||!b.length)break;kl15=b.concat(kl15);if(b[0][0]<=startTime)break;fe=b[0][0]-1;await new Promise(r=>setTimeout(r,80));}
    const b1h=await getFK(sym,'1h',500,endTime);if(b1h)kl1h=b1h;
    await new Promise(r=>setTimeout(r,80));
    kl5=kl5.filter(k=>k[0]>=startTime);
    console.log(` ${kl5.length}`);
    allData[sym]={kl5,kl15,kl1h};
  }

  // Test all configs
  console.log(`\n  ${'CONFIG'.padEnd(22)} ${'Trades'.padStart(7)} ${'S/D'.padStart(5)} ${'WR%'.padStart(6)} ${'PF'.padStart(6)} ${'PnL$'.padStart(10)} ${'MaxDD%'.padStart(7)} ${'Fees$'.padStart(8)} ${'AvgW'.padStart(7)} ${'AvgL'.padStart(7)} ${'MCW'.padStart(4)} ${'MCL'.padStart(4)}`);
  console.log(`  ${'─'.repeat(105)}`);

  const results = [];
  for(const cfg of CONFIGS){
    const r=runBacktest(cfg,allData);
    results.push(r);
    const pnlStr=(r.pnl>=0?'+':'')+r.pnl.toFixed(0);
    const pass=r.pf>=1.5&&r.wr>=50?'★★★':r.pf>=1.3&&r.wr>=45?'★★':r.pf>=1.1?'★':'';
    console.log(`  ${r.name.padEnd(22)} ${String(r.trades).padStart(7)} ${r.sigDay.padStart(5)} ${r.wr.toFixed(1).padStart(5)}% ${r.pf.toFixed(2).padStart(6)} ${pnlStr.padStart(10)} ${r.maxDD.toFixed(1).padStart(6)}% ${r.fees.toFixed(0).padStart(8)} ${r.avgWin.toFixed(1).padStart(7)} ${r.avgLoss.toFixed(1).padStart(7)} ${String(r.maxCW).padStart(4)} ${String(r.maxCL).padStart(4)} ${pass}`);
  }

  // Find best
  const best=results.filter(r=>r.pf>1.0&&r.trades>50).sort((a,b)=>b.pnl-a.pnl);
  console.log(`\n  ═══ TOP 5 CONFIGS ═══`);
  best.slice(0,5).forEach((r,i)=>{
    console.log(`  ${i+1}. ${r.name}: PnL $${r.pnl.toFixed(0)}, WR ${r.wr.toFixed(1)}%, PF ${r.pf.toFixed(2)}, ${r.trades} trades (${r.sigDay}/d)`);
  });

  const target=results.find(r=>r.pf>=1.5&&r.wr>=50);
  if(target){
    console.log(`\n  ★★★ TARGET MET: ${target.name} — PF ${target.pf.toFixed(2)}, WR ${target.wr.toFixed(1)}%, PnL $${target.pnl.toFixed(0)}`);
  } else {
    console.log(`\n  ⚠ No config met PF≥1.5 + WR≥50%. Best available shown above.`);
  }
  console.log('');
})();
