// ═══════════════════════════════════════════════════════════════════════
// SCALP ENGINE v4 — Signal Quality First
// Step 1: Mine which indicators ACTUALLY predict direction
// Step 2: Build new scoring weighted by real predictive power
// Step 3: Find optimal TP/SL for high-quality signals
// Step 4: Walk-forward validation
// ═══════════════════════════════════════════════════════════════════════

const https = require('https');
const SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','DOTUSDT','NEARUSDT','APTUSDT'];

function fetchJSON(url){return new Promise((res,rej)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}});}).on('error',rej)});}
async function getKlines(sym,tf,limit){try{return await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`);}catch(e){return null;}}

// ─── Indicators ───
function calcRSI(C,p=14){if(C.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=C[i]-C[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<C.length;i++){const d=C[i]-C[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}if(al===0)return 100;return 100-(100/(1+ag/al));}
function calcEMAArr(d,p){const k=2/(p+1);const r=[d[0]];for(let i=1;i<d.length;i++)r.push(d[i]*k+r[i-1]*(1-k));return r;}
function calcEMA(d,p){return calcEMAArr(d,p).at(-1);}
function calcMACD(C){if(C.length<35)return{h:0,ph:0};const e12=calcEMAArr(C,12),e26=calcEMAArr(C,26);const ml=e12.map((v,i)=>v-e26[i]);const sl=calcEMAArr(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1))};}
function calcATR(H,L,C,p=14){if(C.length<p+1)return 0;const trs=[];for(let i=1;i<C.length;i++)trs.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));if(trs.length<p)return trs.reduce((a,b)=>a+b)/trs.length;let atr=trs.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<trs.length;i++)atr=(atr*(p-1)+trs[i])/p;return atr;}
function calcADX(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pdm=[],mdm=[],tr=[];for(let i=1;i<H.length;i++){const u=H[i]-H[i-1],d=L[i-1]-L[i];pdm.push(u>d&&u>0?u:0);mdm.push(d>u&&d>0?d:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}function ws(a,p){if(a.length<p)return a.map(()=>0);const r=[];let s=a.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=0;i<p;i++)r.push(0);r[p-1]=s;for(let i=p;i<a.length;i++){s=(s*(p-1)+a[i])/p;r.push(s);}return r;}const sT=ws(tr,p),sP=ws(pdm,p),sM=ws(mdm,p);const pdi=sP.map((v,i)=>sT[i]?v/sT[i]*100:0);const mdi=sM.map((v,i)=>sT[i]?v/sT[i]*100:0);const dx=pdi.map((v,i)=>{const s=v+mdi[i];return s?Math.abs(v-mdi[i])/s*100:0;});const dxV=dx.slice(p-1);const adxA=dxV.length>=p?ws(dxV,p):dxV;return{adx:adxA.at(-1)||15,pdi:pdi.at(-1)||0,mdi:mdi.at(-1)||0};}
function calcOBV(C,V){if(C.length<2)return{rising:false};let o=0;const a=[0];for(let i=1;i<C.length;i++){if(C[i]>C[i-1])o+=V[i];else if(C[i]<C[i-1])o-=V[i];a.push(o);}const n=Math.min(a.length,20);const r=a.slice(-n);let sX=0,sY=0,sXY=0,sX2=0;for(let i=0;i<n;i++){sX+=i;sY+=r[i];sXY+=i*r[i];sX2+=i*i;}return{rising:(n*sXY-sX*sY)/(n*sX2-sX*sX||1)>0};}
function calcStoch(H,L,C,kp=14){if(C.length<kp+3)return{k:50,d:50};const kA=[];for(let i=kp;i<=C.length;i++){const sh=H.slice(i-kp,i),sl=L.slice(i-kp,i);const hi=Math.max(...sh),lo=Math.min(...sl);kA.push(hi===lo?50:((C[i-1]-lo)/(hi-lo))*100);}const dA=[];for(let i=2;i<kA.length;i++)dA.push((kA[i]+kA[i-1]+kA[i-2])/3);return{k:kA.at(-1)||50,d:dA.at(-1)||50};}
function calcBB(C,p=20,s=2){if(C.length<p)return{u:0,m:0,l:0};const sl=C.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+s*sd,m,l:m-s*sd};}

let DATA = {};
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

// ═══ STEP 1: Mine ALL indicator features at every bar ═══
function mineFeatures(startPct, endPct, futBars) {
  const rows = [];
  const LB = 280;
  for(const sym of Object.keys(DATA)) {
    const d = DATA[sym], len = d.len;
    const rS = Math.floor(len*startPct), rE = Math.floor(len*endPct);
    const bS = Math.max(LB, rS), bE = rE - futBars;
    if(bE<=bS) continue;

    for(let bar = bS; bar < bE; bar++) {
      const c=d.C.slice(bar-279,bar+1),h=d.H.slice(bar-279,bar+1),l=d.L.slice(bar-279,bar+1),v=d.V.slice(bar-279,bar+1);
      const cur=c.at(-1), bt=d.T[bar], hUTC=new Date(bt).getUTCHours();
      if(hUTC>=0&&hUTC<6) continue;

      const rsi=calcRSI(c,14),mac=calcMACD(c);
      const ea9=calcEMAArr(c,9),ea21=calcEMAArr(c,21);
      const e9=ea9.at(-1),e21=ea21.at(-1),e9p=ea9.at(-2),e21p=ea21.at(-2),e50=calcEMA(c,50);
      const adx=calcADX(h,l,c),obv=calcOBV(c,v),atr=calcATR(h,l,c,14);
      const avgV=v.slice(-20).reduce((a,b)=>a+b)/20,vr=v.at(-1)/avgV;
      const stoch=calcStoch(h,l,c,14),bb=calcBB(c,20,2);
      const bbR=bb.u-bb.l,bbP=bbR>0?(cur-bb.l)/bbR:0.5;
      const mom1=(cur-(c.at(-2)||cur))/Math.max(atr,.0001);
      const mom3=(cur-(c.at(-4)||cur))/Math.max(atr,.0001);
      const mom6=(cur-(c.at(-7)||cur))/Math.max(atr,.0001);
      const emaDist=(cur-e21)/Math.max(atr,.0001);
      const ema50Dist=(cur-e50)/Math.max(atr,.0001);
      const l4=c.slice(-4);
      const bullExh=l4.length>=4&&l4.every((x,i)=>i===0||x>l4[i-1]);
      const bearExh=l4.length>=4&&l4.every((x,i)=>i===0||x<l4[i-1]);
      const emaCross=e9>e21&&e9p<=e21p?1:e9<e21&&e9p>=e21p?-1:0;
      const macdCross=mac.h>0&&mac.ph<0?1:mac.h<0&&mac.ph>0?-1:0;

      // HTF
      let htf=0;
      let c1e=0;for(let j=d.T1h.length-1;j>=0;j--){if(d.T1h[j]<=bt){c1e=j+1;break;}}
      const c1h=d.C1h.slice(Math.max(0,c1e-50),c1e);
      const h1h=d.H1h.slice(Math.max(0,c1e-50),c1e);
      const l1h=d.L1h.slice(Math.max(0,c1e-50),c1e);
      const v1h=d.V1h.slice(Math.max(0,c1e-50),c1e);
      if(c1h.length>25){
        const e9h=calcEMA(c1h,9),e21h=calcEMA(c1h,21),m1h=calcMACD(c1h),rsi1h=calcRSI(c1h,14);
        let hB=0,hS=0;
        if(e9h>e21h)hB+=2;else hS+=2;if(m1h.h>0)hB+=1.5;else hS+=1.5;
        if(rsi1h>50)hB+=1;else hS+=1;
        htf=hB-hS; // positive=bullish, negative=bearish
      }

      // MTF 15m
      let mtf=0;
      let c15e=0;for(let j=d.T15.length-1;j>=0;j--){if(d.T15[j]<=bt){c15e=j+1;break;}}
      const c15=d.C15.slice(Math.max(0,c15e-100),c15e);
      const h15=d.H15.slice(Math.max(0,c15e-100),c15e);
      const l15=d.L15.slice(Math.max(0,c15e-100),c15e);
      if(c15.length>25){
        const e9_15=calcEMA(c15,9),e21_15=calcEMA(c15,21),m15=calcMACD(c15);
        let mB=0,mS=0;if(e9_15>e21_15)mB++;else mS++;if(m15.h>0)mB++;else mS++;
        mtf=mB-mS;
      }
      // 15m ATR
      let atr15=atr;
      if(h15.length>15&&l15.length>15&&c15.length>15){const a=calcATR(h15,l15,c15,14);if(a>0)atr15=a;}

      // Future outcomes
      const fH=[],fL=[],fC=[];
      for(let f=bar+1;f<=Math.min(bar+futBars,d.len-1);f++){fH.push(d.H[f]);fL.push(d.L[f]);fC.push(d.C[f]);}

      // Future price change at various horizons
      const fut3 = fC[2] ? (fC[2]-cur)/cur*100 : 0;
      const fut6 = fC[5] ? (fC[5]-cur)/cur*100 : 0;
      const fut12 = fC[11] ? (fC[11]-cur)/cur*100 : 0;
      // Max favorable excursion (MFE) — how far price went in OUR favor
      let maxUp=0,maxDn=0;
      for(let i=0;i<fH.length;i++){
        const up=(fH[i]-cur)/cur*100;if(up>maxUp)maxUp=up;
        const dn=(cur-fL[i])/cur*100;if(dn>maxDn)maxDn=dn;
      }

      rows.push({
        sym,bar,cur,atr,atr15,hUTC,
        // Features
        rsi,macdH:mac.h,macdCross,emaCross,
        emaDir:e9>e21?1:-1, ema50Dir:cur>e50?1:-1,
        adxVal:adx.adx,adxDir:adx.pdi>adx.mdi?1:-1,
        obvRising:obv.rising?1:0, stochK:stoch.k,stochSignal:stoch.k>stoch.d?1:-1,
        bbP,vr,mom1,mom3,mom6,emaDist,ema50Dist,
        bullExh:bullExh?1:0,bearExh:bearExh?1:0,
        htf,mtf,
        // Outcomes
        fut3,fut6,fut12,maxUp,maxDn,fH,fL,fC
      });
    }
  }
  return rows;
}

// ═══ STEP 2: Analyze which features predict direction ═══
function analyzeFeatures(rows) {
  console.log(`\n  Analyzing ${rows.length} data points...\n`);

  // For each potential BUY condition, measure: what % of times does price go UP?
  const conditions = [
    { name: 'RSI < 25',        test: r => r.rsi < 25 },
    { name: 'RSI < 30',        test: r => r.rsi < 30 },
    { name: 'RSI < 35',        test: r => r.rsi < 35 },
    { name: 'RSI < 40',        test: r => r.rsi < 40 },
    { name: 'RSI > 60',        test: r => r.rsi > 60 },
    { name: 'RSI > 65',        test: r => r.rsi > 65 },
    { name: 'RSI > 70',        test: r => r.rsi > 70 },
    { name: 'RSI > 75',        test: r => r.rsi > 75 },
    { name: 'MACD cross UP',   test: r => r.macdCross === 1 },
    { name: 'MACD cross DN',   test: r => r.macdCross === -1 },
    { name: 'MACD > 0',        test: r => r.macdH > 0 },
    { name: 'MACD < 0',        test: r => r.macdH < 0 },
    { name: 'EMA cross UP',    test: r => r.emaCross === 1 },
    { name: 'EMA cross DN',    test: r => r.emaCross === -1 },
    { name: 'EMA9 > EMA21',    test: r => r.emaDir === 1 },
    { name: 'EMA9 < EMA21',    test: r => r.emaDir === -1 },
    { name: 'Price > EMA50',   test: r => r.ema50Dir === 1 },
    { name: 'Price < EMA50',   test: r => r.ema50Dir === -1 },
    { name: 'ADX > 25 +DI',    test: r => r.adxVal > 25 && r.adxDir === 1 },
    { name: 'ADX > 25 -DI',    test: r => r.adxVal > 25 && r.adxDir === -1 },
    { name: 'ADX < 15',        test: r => r.adxVal < 15 },
    { name: 'ADX 15-25',       test: r => r.adxVal >= 15 && r.adxVal <= 25 },
    { name: 'OBV rising',      test: r => r.obvRising === 1 },
    { name: 'OBV falling',     test: r => r.obvRising === 0 },
    { name: 'StochK < 20',     test: r => r.stochK < 20 },
    { name: 'StochK < 30',     test: r => r.stochK < 30 },
    { name: 'StochK > 70',     test: r => r.stochK > 70 },
    { name: 'StochK > 80',     test: r => r.stochK > 80 },
    { name: 'BB lower 10%',    test: r => r.bbP < 0.1 },
    { name: 'BB lower 20%',    test: r => r.bbP < 0.2 },
    { name: 'BB upper 80%',    test: r => r.bbP > 0.8 },
    { name: 'BB upper 90%',    test: r => r.bbP > 0.9 },
    { name: 'Mom3 > +0.5',     test: r => r.mom3 > 0.5 },
    { name: 'Mom3 > +1.0',     test: r => r.mom3 > 1.0 },
    { name: 'Mom3 < -0.5',     test: r => r.mom3 < -0.5 },
    { name: 'Mom3 < -1.0',     test: r => r.mom3 < -1.0 },
    { name: 'VR > 1.5',        test: r => r.vr > 1.5 },
    { name: 'VR > 2.0',        test: r => r.vr > 2.0 },
    { name: 'VR < 0.5',        test: r => r.vr < 0.5 },
    { name: 'HTF bullish',     test: r => r.htf > 1 },
    { name: 'HTF bearish',     test: r => r.htf < -1 },
    { name: 'MTF bullish',     test: r => r.mtf > 0 },
    { name: 'MTF bearish',     test: r => r.mtf < 0 },
    { name: 'Bull exhaustion',  test: r => r.bullExh === 1 },
    { name: 'Bear exhaustion',  test: r => r.bearExh === 1 },
    { name: 'EMA dist > +1.5', test: r => r.emaDist > 1.5 },
    { name: 'EMA dist < -1.5', test: r => r.emaDist < -1.5 },
    { name: 'Stoch K>D oversold', test: r => r.stochK<30&&r.stochSignal===1 },
    { name: 'Stoch K<D overbought', test: r => r.stochK>70&&r.stochSignal===-1 },
    // Combos
    { name: 'RSI<30 + HTF bull', test: r => r.rsi<30&&r.htf>1 },
    { name: 'RSI>70 + HTF bear', test: r => r.rsi>70&&r.htf<-1 },
    { name: 'RSI<35 + MTF bull', test: r => r.rsi<35&&r.mtf>0 },
    { name: 'RSI>65 + MTF bear', test: r => r.rsi>65&&r.mtf<0 },
    { name: 'MACD xUP + EMA bull', test: r => r.macdCross===1&&r.emaDir===1 },
    { name: 'MACD xDN + EMA bear', test: r => r.macdCross===-1&&r.emaDir===-1 },
    { name: 'BB<0.1 + StochK<20', test: r => r.bbP<0.1&&r.stochK<20 },
    { name: 'BB>0.9 + StochK>80', test: r => r.bbP>0.9&&r.stochK>80 },
    { name: 'Mom3<-0.5 + RSI<35', test: r => r.mom3<-0.5&&r.rsi<35 },
    { name: 'Mom3>+0.5 + RSI>65', test: r => r.mom3>0.5&&r.rsi>65 },
    { name: 'HTF bull + MTF bull', test: r => r.htf>1&&r.mtf>0 },
    { name: 'HTF bear + MTF bear', test: r => r.htf<-1&&r.mtf<0 },
    { name: 'HTF bull + MTF bull + EMA bull', test: r => r.htf>1&&r.mtf>0&&r.emaDir===1 },
    { name: 'HTF bear + MTF bear + EMA bear', test: r => r.htf<-1&&r.mtf<0&&r.emaDir===-1 },
    { name: 'VR>1.5 + MACD xUP', test: r => r.vr>1.5&&r.macdCross===1 },
    { name: 'VR>1.5 + MACD xDN', test: r => r.vr>1.5&&r.macdCross===-1 },
    { name: 'ADX>25+DI + EMA bull + MTF bull', test: r => r.adxVal>25&&r.adxDir===1&&r.emaDir===1&&r.mtf>0 },
    { name: 'ADX>25-DI + EMA bear + MTF bear', test: r => r.adxVal>25&&r.adxDir===-1&&r.emaDir===-1&&r.mtf<0 },
    { name: 'Triple align BUY (HTF+MTF+5m)', test: r => r.htf>1&&r.mtf>0&&r.emaDir===1&&r.macdH>0 },
    { name: 'Triple align SELL (HTF+MTF+5m)', test: r => r.htf<-1&&r.mtf<0&&r.emaDir===-1&&r.macdH<0 },
  ];

  console.log('  INDIVIDUAL FEATURE PREDICTIVE POWER (6-bar horizon):\n');
  console.log('  Condition                              |   N  | UP%   | DN%   | AvgChg%  | Prediction');
  console.log('  ' + '─'.repeat(90));

  const results = [];
  for(const cond of conditions) {
    const matching = rows.filter(cond.test);
    if(matching.length < 10) continue;
    const upCount = matching.filter(r => r.fut6 > 0).length;
    const upPct = upCount / matching.length * 100;
    const dnPct = 100 - upPct;
    const avgChg = matching.reduce((s,r) => s + r.fut6, 0) / matching.length;
    const bestDir = upPct > 55 ? 'BUY' : dnPct > 55 ? 'SELL' : 'WEAK';
    const edge = Math.abs(upPct - 50);

    results.push({ name: cond.name, n: matching.length, upPct, dnPct, avgChg, bestDir, edge, test: cond.test });

    const marker = edge > 5 ? (edge > 10 ? ' ★★' : ' ★') : '';
    console.log(`  ${cond.name.padEnd(40)} | ${String(matching.length).padStart(4)} | ${upPct.toFixed(1).padStart(5)}% | ${dnPct.toFixed(1).padStart(5)}% | ${(avgChg>=0?'+':'')+avgChg.toFixed(4).padStart(7)}% | ${bestDir}${marker}`);
  }

  // Sort by edge
  results.sort((a,b) => b.edge - a.edge);

  console.log('\n  TOP 15 MOST PREDICTIVE CONDITIONS:\n');
  for(let i=0;i<Math.min(15,results.length);i++){
    const r = results[i];
    console.log(`  ${String(i+1).padStart(2)}. ${r.name.padEnd(42)} edge=${r.edge.toFixed(1)}% dir=${r.bestDir} n=${r.n} avgChg=${(r.avgChg>=0?'+':'')+r.avgChg.toFixed(4)}%`);
  }

  return results;
}

// ═══ STEP 3: Build composite signal using best predictors ═══
function buildSignals(rows, featureResults, minEdge) {
  // Get features with edge > minEdge
  const goodBuy = featureResults.filter(f => f.bestDir === 'BUY' && f.edge >= minEdge);
  const goodSell = featureResults.filter(f => f.bestDir === 'SELL' && f.edge >= minEdge);

  console.log(`\n  Building signals: ${goodBuy.length} BUY features, ${goodSell.length} SELL features (edge>=${minEdge}%)\n`);

  const signals = [];
  for(const r of rows) {
    let buyScore = 0, sellScore = 0;
    let buyHits = 0, sellHits = 0;

    for(const f of goodBuy) {
      if(f.test(r)) { buyScore += f.edge; buyHits++; }
    }
    for(const f of goodSell) {
      if(f.test(r)) { sellScore += f.edge; sellHits++; }
    }

    signals.push({
      ...r,
      buyScore, sellScore, buyHits, sellHits,
      bestDir: buyScore > sellScore ? 'B' : sellScore > buyScore ? 'S' : 'N',
      netScore: Math.abs(buyScore - sellScore),
      topHits: Math.max(buyHits, sellHits)
    });
  }

  return signals;
}

// ═══ STEP 4: Evaluate with TP/SL ═══
function evalConfig(signals, cfg) {
  let wins=0, losses=0, pnl=0, count=0;
  const lastBar = {};

  for(const s of signals) {
    if(s.bestDir === 'N') continue;
    if(s.netScore < (cfg.minNet || 0)) continue;
    if(s.topHits < (cfg.minHits || 0)) continue;

    const lb = lastBar[s.sym] || -999;
    if(s.bar - lb < (cfg.cd || 3)) continue;
    lastBar[s.sym] = s.bar;
    count++;

    const signal = s.bestDir;
    const entry = s.cur;
    const useATR = s.atr15 || s.atr;
    const tp1Abs = useATR * cfg.tp1M;
    const slAbs = useATR * cfg.slM;
    const trailAbs = useATR * cfg.trailM;
    const cost = entry * (cfg.cost || 0.0004) * 2;
    const maxBars = Math.min(cfg.ew || 24, s.fH.length);

    const tp1P = signal==='B' ? entry+tp1Abs : entry-tp1Abs;
    const slP = signal==='B' ? entry-slAbs : entry+slAbs;

    let tp1Hit = false, bestP = entry, res = 'TO', tradePnl = 0;

    for(let i = 0; i < maxBars; i++) {
      if(signal === 'B') {
        if(!tp1Hit) {
          if(s.fL[i] <= slP) { res='SL'; tradePnl=-slAbs-cost; break; }
          if(s.fH[i] >= tp1P) { tp1Hit=true; bestP=s.fH[i]; }
        }
        if(tp1Hit) {
          if(s.fH[i]>bestP) bestP=s.fH[i];
          const trail = bestP - trailAbs;
          const exitLvl = Math.max(trail, entry);
          if(s.fL[i] <= exitLvl) {
            tradePnl = tp1Abs*0.5 + (exitLvl-entry)*0.5 - cost;
            res = exitLvl>entry?'TRAIL':'TP1BE'; break;
          }
        }
      } else {
        if(!tp1Hit) {
          if(s.fH[i] >= slP) { res='SL'; tradePnl=-slAbs-cost; break; }
          if(s.fL[i] <= tp1P) { tp1Hit=true; bestP=s.fL[i]; }
        }
        if(tp1Hit) {
          if(s.fL[i]<bestP) bestP=s.fL[i];
          const trail = bestP + trailAbs;
          const exitLvl = Math.min(trail, entry);
          if(s.fH[i] >= exitLvl) {
            tradePnl = tp1Abs*0.5 + (entry-exitLvl)*0.5 - cost;
            res = exitLvl<entry?'TRAIL':'TP1BE'; break;
          }
        }
      }
    }
    if(res==='TO') {
      const last=s.fC[maxBars-1]||entry;
      const uPnl=signal==='B'?last-entry:entry-last;
      tradePnl=tp1Hit?tp1Abs*0.5+uPnl*0.5-cost:uPnl-cost;
    }

    const pnlPct = tradePnl / entry * 100;
    pnl += pnlPct;
    if(res==='SL'||(res==='TO'&&pnlPct<0)) losses++; else wins++;
  }

  const total = wins + losses;
  return { wins, losses, total: count, wr: total>0?wins/total*100:0, pnl };
}

// ═══ MAIN ═══
async function main() {
  console.log('═'.repeat(70));
  console.log('  SCALP ENGINE v4 — Signal Quality Mining');
  console.log('  Step 1: Find which indicators ACTUALLY predict direction');
  console.log('  Step 2: Build weighted composite signal');
  console.log('  Step 3: Optimize TP/SL for quality signals');
  console.log('  Step 4: Walk-forward validation');
  console.log('═'.repeat(70) + '\n');

  await loadData();
  const days = Object.values(DATA)[0]?.len / 288 || 3.5;
  const trainDays = days * 0.5, testDays = days * 0.5;

  // STEP 1: Mine features on TRAIN data
  console.log('\n  STEP 1: Mining features on TRAIN set...');
  const trainRows = mineFeatures(0, 0.5, 36);
  const testRows = mineFeatures(0.5, 1.0, 36);
  console.log(`  TRAIN: ${trainRows.length} bars | TEST: ${testRows.length} bars`);

  const featureResults = analyzeFeatures(trainRows);

  // STEP 2: Build composite signals at various edge thresholds
  console.log('\n' + '═'.repeat(70));
  console.log('  STEP 2-3: Build signals + Grid search TP/SL');
  console.log('═'.repeat(70));

  const edgeThresholds = [3, 5, 7, 10];
  const minNets = [0, 5, 10, 15, 20, 30, 40, 50];
  const minHitsList = [1, 2, 3, 4, 5];
  const tp1Ms = [0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.60, 0.80];
  const slMs = [0.30, 0.50, 0.80, 1.0, 1.5, 2.0, 2.5, 3.0];
  const trMs = [0.05, 0.08, 0.10, 0.15, 0.20, 0.30];
  const ews = [12, 24, 36];
  const cds = [2, 3, 4, 6];
  const costs = [0.0002, 0.0004];

  let best = [];
  let totalTested = 0;

  for(const edge of edgeThresholds) {
    const trainSigs = buildSignals(trainRows, featureResults, edge);

    // Check directional accuracy of composite signal
    let correct = 0, total = 0;
    for(const s of trainSigs) {
      if(s.bestDir === 'N') continue;
      if(s.netScore < 10) continue;
      total++;
      if(s.bestDir === 'B' && s.fut6 > 0) correct++;
      else if(s.bestDir === 'S' && s.fut6 < 0) correct++;
    }
    console.log(`\n  Edge>=${edge}%: ${total} filtered sigs, directional accuracy=${(correct/Math.max(1,total)*100).toFixed(1)}%`);

    for(const minNet of minNets) {
      for(const minHits of minHitsList) {
        for(const tp1 of tp1Ms) {
          for(const sl of slMs) {
            for(const tr of trMs) {
              for(const ew of ews) {
                for(const cd of cds) {
                  for(const cost of costs) {
                    totalTested++;
                    if(totalTested%50000===0) process.stdout.write(`  ${(totalTested/1000).toFixed(0)}K... best WR=${best[0]?.wr?.toFixed(1)||'?'}% PnL=${best[0]?.pnl?.toFixed(1)||'?'}%\r`);

                    const cfg = { tp1M:tp1, slM:sl, trailM:tr, ew, cd, cost, minNet, minHits };
                    const r = evalConfig(trainSigs, cfg);
                    if(r.total < 15) continue;
                    r.spd = r.total / trainDays;

                    const score = r.wr*0.5 + (r.pnl>0?r.pnl*3:r.pnl*5) + (r.spd>=25?10:0) + (r.wr>=60?30:0);
                    best.push({ score, edge, ...cfg, wr:r.wr, pnl:r.pnl, spd:r.spd, n:r.total, w:r.wins, l:r.losses });
                    best.sort((a,b) => b.score - a.score);
                    if(best.length > 80) best.length = 80;
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  console.log(`\n\n  Total tested: ${(totalTested/1000).toFixed(0)}K configurations\n`);

  console.log('  TOP 20 TRAIN:\n');
  console.log('  # | Edge | MinNet | Hits | TP1   | SL    | Trail | EW | CD | Cost | WR%   | PnL%     | S/Day | N');
  console.log('  ' + '-'.repeat(105));
  for(let i=0;i<Math.min(20,best.length);i++){
    const r=best[i];
    console.log(`  ${String(i+1).padStart(2)} | ${String(r.edge).padStart(4)} | ${String(r.minNet).padStart(6)} | ${String(r.minHits).padStart(4)} | ${r.tp1M.toFixed(2).padStart(5)} | ${r.slM.toFixed(1).padStart(5)} | ${r.trailM.toFixed(2).padStart(5)} | ${String(r.ew).padStart(2)} | ${String(r.cd).padStart(2)} | ${(r.cost*10000).toFixed(0).padStart(3)}b | ${r.wr.toFixed(1).padStart(5)}% | ${(r.pnl>=0?'+':'')+r.pnl.toFixed(2).padStart(7)}% | ${r.spd.toFixed(0).padStart(5)} | ${r.n}`);
  }

  // ═══ STEP 4: WALK-FORWARD VALIDATION ═══
  console.log('\n' + '═'.repeat(70));
  console.log('  STEP 4: WALK-FORWARD VALIDATION (unseen TEST data)');
  console.log('═'.repeat(70) + '\n');

  const validated = [];
  for(let i = 0; i < Math.min(40, best.length); i++) {
    const cfg = best[i];
    const testSigs = buildSignals(testRows, featureResults, cfg.edge);
    const r = evalConfig(testSigs, cfg);
    r.spd = r.total / testDays;
    validated.push({
      ...cfg, tWR: r.wr, tPnl: r.pnl, tSpd: r.spd, tN: r.total,
      trWR: cfg.wr, trPnl: cfg.pnl
    });
  }

  validated.sort((a,b) => {
    const sA = a.tWR*0.5 + (a.tPnl>0?a.tPnl*3:a.tPnl*5) + (a.tSpd>=25?10:0) + (a.tWR>=60?30:0);
    const sB = b.tWR*0.5 + (b.tPnl>0?b.tPnl*3:b.tPnl*5) + (b.tSpd>=25?10:0) + (b.tWR>=60?30:0);
    return sB - sA;
  });

  console.log('  TOP 20 VALIDATED:\n');
  console.log('  # | Edge | MinNet | Hits | TP1   | SL   | Trail | TRAIN WR | TRAIN PnL | TEST WR | TEST PnL | T.S/Day');
  console.log('  ' + '-'.repeat(110));
  for(let i=0;i<Math.min(20,validated.length);i++){
    const v=validated[i];
    console.log(`  ${String(i+1).padStart(2)} | ${String(v.edge).padStart(4)} | ${String(v.minNet).padStart(6)} | ${String(v.minHits).padStart(4)} | ${v.tp1M.toFixed(2).padStart(5)} | ${v.slM.toFixed(1).padStart(4)} | ${v.trailM.toFixed(2).padStart(5)} | ${v.trWR.toFixed(1).padStart(7)}% | ${(v.trPnl>=0?'+':'')+v.trPnl.toFixed(2).padStart(8)}% | ${v.tWR.toFixed(1).padStart(6)}% | ${(v.tPnl>=0?'+':'')+v.tPnl.toFixed(2).padStart(7)}% | ${v.tSpd.toFixed(0).padStart(6)}`);
  }

  // Best config
  const b = validated[0];
  if(b) {
    // Full validation
    const allRows = mineFeatures(0, 1.0, 36);
    const allSigs = buildSignals(allRows, featureResults, b.edge);
    const full = evalConfig(allSigs, b);
    full.spd = full.total / days;

    console.log('\n' + '═'.repeat(70));
    console.log('  MEJOR CONFIG — FULL VALIDATION');
    console.log('═'.repeat(70));
    console.log(`  Edge: ${b.edge}% | MinNetScore: ${b.minNet} | MinHits: ${b.minHits}`);
    console.log(`  TP1: ${b.tp1M}xATR | Trail: ${b.trailM}xATR | SL: ${b.slM}xATR`);
    console.log(`  EvalWindow: ${b.ew} bars | Cooldown: ${b.cd} bars | Cost: ${(b.cost*10000).toFixed(0)} bps/side`);
    console.log(`  TRAIN: WR=${b.trWR.toFixed(1)}% | PnL=${b.trPnl>=0?'+':''}${b.trPnl.toFixed(2)}%`);
    console.log(`  TEST:  WR=${b.tWR.toFixed(1)}% | PnL=${b.tPnl>=0?'+':''}${b.tPnl.toFixed(2)}%`);
    console.log(`  FULL:  WR=${full.wr.toFixed(1)}% | PnL=${full.pnl>=0?'+':''}${full.pnl.toFixed(2)}% | ${full.spd.toFixed(0)} s/d | ${full.total} signals (${full.wins}W/${full.losses}L)`);

    console.log('\n  TARGETS:');
    console.log(`  ${full.wr>=60?'[OK]':'[!!]'} WR >= 60%: ${full.wr.toFixed(1)}%`);
    console.log(`  ${full.pnl>=20?'[OK]':'[!!]'} PnL >= +20%: ${full.pnl>=0?'+':''}${full.pnl.toFixed(2)}%`);
    console.log(`  Signals/Day: ${full.spd.toFixed(0)}`);
  }

  console.log('\n' + '═'.repeat(70));
}

main().catch(console.error);
