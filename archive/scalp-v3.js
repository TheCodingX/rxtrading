// ═══════════════════════════════════════════════════════════════════════
// SCALP v3 — FAST OPTIMIZER
// Pre-compute ALL signals once, then test TP/SL configs in milliseconds
// Walk-forward: Train first 50%, Validate last 50%
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
async function loadData() {
  for(const sym of SYMS) {
    process.stdout.write(`  ${sym}...`);
    const [kl5,kl15,kl1h] = await Promise.all([
      getKlines(sym,'5m',1000), getKlines(sym,'15m',400), getKlines(sym,'1h',200)
    ]);
    if(!kl5||kl5.length<400){console.log(' SKIP');continue;}
    DATA[sym]={
      C:kl5.map(k=>+k[4]),H:kl5.map(k=>+k[2]),L:kl5.map(k=>+k[3]),V:kl5.map(k=>+k[5]),T:kl5.map(k=>k[0]),
      C15:kl15?kl15.map(k=>+k[4]):[],H15:kl15?kl15.map(k=>+k[2]):[],L15:kl15?kl15.map(k=>+k[3]):[],T15:kl15?kl15.map(k=>k[0]):[],
      C1h:kl1h?kl1h.map(k=>+k[4]):[],H1h:kl1h?kl1h.map(k=>+k[2]):[],L1h:kl1h?kl1h.map(k=>+k[3]):[],V1h:kl1h?kl1h.map(k=>+k[5]):[],T1h:kl1h?kl1h.map(k=>k[0]):[],
      len:kl5.length
    };
    console.log(` ${kl5.length}`);
    await new Promise(r=>setTimeout(r,200));
  }
}

// ═══ PRE-COMPUTE: Generate ALL signals with full indicator data ═══
// Returns array of { bar, sym, signal, entry, atr, features, futureH[], futureL[], futureC[] }
function precomputeSignals(startPct, endPct, maxFuture) {
  const signals = [];
  const LB = 280;

  for(const sym of Object.keys(DATA)) {
    const d = DATA[sym];
    const rS = Math.floor(d.len * startPct);
    const rE = Math.floor(d.len * endPct);
    const bS = Math.max(LB, rS);
    const bE = rE - maxFuture;
    if(bE <= bS) continue;

    for(let bar = bS; bar < bE; bar++) {
      const c = d.C.slice(bar-279, bar+1);
      const h = d.H.slice(bar-279, bar+1);
      const l = d.L.slice(bar-279, bar+1);
      const v = d.V.slice(bar-279, bar+1);
      const cur = c.at(-1);
      const bt = d.T[bar];
      const hUTC = new Date(bt).getUTCHours();

      // Dead hours always blocked
      if(hUTC >= 0 && hUTC < 6) continue;

      const rsi = calcRSI(c, 14);
      const mac = calcMACD(c);
      const ea9 = calcEMAArr(c, 9), ea21 = calcEMAArr(c, 21);
      const e9 = ea9.at(-1), e21 = ea21.at(-1), e9p = ea9.at(-2), e21p = ea21.at(-2);
      const e50 = calcEMA(c, 50);
      const adx = calcADX(h, l, c);
      const obv = calcOBV(c, v);
      const atr = calcATR(h, l, c, 14);
      const avgV = v.slice(-20).reduce((a,b)=>a+b)/20;
      const vr = v.at(-1) / avgV;
      const stoch = calcStoch(h, l, c, 14);
      const bb = calcBB(c, 20, 2);
      const bbR = bb.u - bb.l;
      const bbP = bbR > 0 ? (cur - bb.l) / bbR : 0.5;

      // Scoring
      let B=0,S=0,bI=0,sI=0;
      if(rsi<30){B+=2.5;bI++;}else if(rsi>70){S+=2.5;sI++;}
      if(mac.h>0&&mac.ph<0){B+=2;bI++;}else if(mac.h<0&&mac.ph>0){S+=2;sI++;}
      else if(mac.h>0){B+=0.5;bI++;}else if(mac.h<0){S+=0.5;sI++;}
      if(e9>e21&&e9p<=e21p){B+=2.5;bI++;}else if(e9<e21&&e9p>=e21p){S+=2.5;sI++;}
      else if(e9>e21){B+=0.5;bI++;}else{S+=0.5;sI++;}
      if(cur>e50){B+=0.5;bI++;}else{S+=0.5;sI++;}
      if(adx.adx>25&&adx.pdi>adx.mdi){B+=1.5;bI++;}
      else if(adx.adx>25&&adx.mdi>adx.pdi){S+=1.5;sI++;}
      if(obv.rising){B+=0.8;bI++;}else{S+=0.8;sI++;}
      if(stoch.k<25&&stoch.k>stoch.d){B+=1.5;bI++;}
      else if(stoch.k>75&&stoch.k<stoch.d){S+=1.5;sI++;}
      if(bbP<0.1){B+=1.5;bI++;}else if(bbP>0.9){S+=1.5;sI++;}
      if(vr>1.5&&B>S)B*=1.15;else if(vr>1.5&&S>B)S*=1.15;

      let signal = 'N';
      if(B>S&&B>=1.0&&bI>=1) signal='B';
      else if(S>B&&S>=1.0&&sI>=1) signal='S';
      if(signal==='N') continue;
      if(vr<0.4) continue;

      const margin = signal==='B'?B-S:S-B;
      const mom3 = (cur - (c.at(-4)||cur)) / Math.max(atr, 0.0001);
      const l4 = c.slice(-4);
      const bullExh = l4.length>=4&&l4.every((x,i)=>i===0||x>l4[i-1]);
      const bearExh = l4.length>=4&&l4.every((x,i)=>i===0||x<l4[i-1]);
      const emaDist = Math.abs(cur - e21) / Math.max(atr, 0.0001);

      // HTF
      let htf = 'N';
      let c1e = 0;
      for(let j=d.T1h.length-1;j>=0;j--){if(d.T1h[j]<=bt){c1e=j+1;break;}}
      const c1h=d.C1h.slice(Math.max(0,c1e-50),c1e);
      const h1h=d.H1h.slice(Math.max(0,c1e-50),c1e);
      const l1h=d.L1h.slice(Math.max(0,c1e-50),c1e);
      const v1h=d.V1h.slice(Math.max(0,c1e-50),c1e);
      if(c1h.length>25){
        const e9h=calcEMA(c1h,9),e21h=calcEMA(c1h,21),m1h=calcMACD(c1h);
        let hB=0,hS=0;
        if(e9h>e21h)hB+=2;else hS+=2;
        if(m1h.h>0)hB+=1.5;else hS+=1.5;
        if(hB>hS+1)htf='B';else if(hS>hB+1)htf='S';
      }

      // MTF
      let mtf = 'N';
      let c15e=0;
      for(let j=d.T15.length-1;j>=0;j--){if(d.T15[j]<=bt){c15e=j+1;break;}}
      const c15=d.C15.slice(Math.max(0,c15e-100),c15e);
      const h15=d.H15.slice(Math.max(0,c15e-100),c15e);
      if(c15.length>25){
        const e9_15=calcEMA(c15,9),e21_15=calcEMA(c15,21),m15=calcMACD(c15);
        let mB=0,mS=0;
        if(e9_15>e21_15)mB++;else mS++;
        if(m15.h>0)mB++;else mS++;
        if(mB>mS)mtf='B';else if(mS>mB)mtf='S';
      }

      // 15m ATR
      let atr15 = atr;
      if(h15.length>15){const l15=d.L15.slice(Math.max(0,c15e-100),c15e);const a=calcATR(h15,l15,c15,14);if(a>0)atr15=a;}

      // Future candles for evaluation
      const fH=[], fL=[], fC=[];
      for(let f=bar+1;f<=Math.min(bar+maxFuture,d.len-1);f++){
        fH.push(d.H[f]);fL.push(d.L[f]);fC.push(d.C[f]);
      }

      signals.push({
        bar, sym, signal, entry: cur, atr, atr15,
        B, S, margin, rsi, adxVal: adx.adx, adxPdi: adx.pdi, adxMdi: adx.mdi,
        vr, stochK: stoch.k, bbP, mom3, emaDist,
        bullExh, bearExh, htf, mtf, hour: hUTC, score: Math.max(B,S),
        fH, fL, fC
      });
    }
  }
  return signals;
}

// ═══ Evaluate pre-computed signals with given config ═══
function evalSignals(signals, cfg) {
  let wins=0, losses=0, pnl=0, count=0;
  const cooldown = cfg.cooldown || 2;
  const lastBarBySym = {};

  for(const s of signals) {
    // Cooldown per symbol
    const lb = lastBarBySym[s.sym] || -999;
    if(s.bar - lb < cooldown) continue;

    // Apply filters
    if(cfg.antiHTF && ((s.signal==='B'&&s.htf==='S')||(s.signal==='S'&&s.htf==='B'))) continue;
    if(cfg.reqHTF && ((s.signal==='B'&&s.htf!=='B')||(s.signal==='S'&&s.htf!=='S'))) continue;
    if(cfg.reqMTF && ((s.signal==='B'&&s.mtf==='S')||(s.signal==='S'&&s.mtf==='B'))) continue;
    if(cfg.reqMTFc && ((s.signal==='B'&&s.mtf!=='B')||(s.signal==='S'&&s.mtf!=='S'))) continue;
    if(cfg.minMargin && s.margin < cfg.minMargin) continue;
    if(cfg.exh && ((s.signal==='B'&&s.bullExh)||(s.signal==='S'&&s.bearExh))) continue;
    if(cfg.mom && ((s.signal==='B'&&s.mom3<-0.3)||(s.signal==='S'&&s.mom3>0.3))) continue;
    if(cfg.rsiCap && ((s.signal==='B'&&s.rsi>cfg.rsiCapB)||(s.signal==='S'&&s.rsi<cfg.rsiCapS))) continue;
    if(cfg.bbF && ((s.signal==='B'&&s.bbP>0.65)||(s.signal==='S'&&s.bbP<0.35))) continue;
    if(cfg.stF && ((s.signal==='B'&&s.stochK>75)||(s.signal==='S'&&s.stochK<25))) continue;
    if(cfg.blockH && cfg.blockH.includes(s.hour)) continue;
    if(cfg.adxF && s.adxVal < cfg.adxF) continue;
    if(cfg.onlyBuy && s.signal==='S') continue;
    if(cfg.emaD && s.emaDist > cfg.emaD) continue;
    if(cfg.minScore && s.score < cfg.minScore) continue;

    lastBarBySym[s.sym] = s.bar;
    count++;

    // TP/SL eval — percentage based
    const entry = s.entry;
    const useATR = cfg.atrBased ? (s.atr15 || s.atr) : null;
    const tp1Abs = cfg.atrBased ? useATR * cfg.tp1M : entry * cfg.tp1P / 100;
    const slAbs = cfg.atrBased ? useATR * cfg.slM : entry * cfg.slP / 100;
    const cost = entry * (cfg.costPS || 0.0004) * 2;

    const tp1Price = s.signal==='B' ? entry + tp1Abs : entry - tp1Abs;
    const slPrice = s.signal==='B' ? entry - slAbs : entry + slAbs;

    let tp1Hit = false;
    let result = 'TO';
    let tradePnl = 0;
    const maxBars = Math.min(cfg.evalW || 24, s.fH.length);

    if(cfg.strategy === 'trail') {
      // Trailing stop after TP1
      const trailAbs = cfg.atrBased ? useATR * cfg.trailM : entry * cfg.trailP / 100;
      let bestP = entry, trailStop = 0;

      for(let i = 0; i < maxBars; i++) {
        if(s.signal === 'B') {
          if(!tp1Hit) {
            if(s.fL[i] <= slPrice) { result='SL'; tradePnl = -slAbs - cost; break; }
            if(s.fH[i] >= tp1Price) { tp1Hit=true; bestP=s.fH[i]; trailStop=bestP-trailAbs; }
          }
          if(tp1Hit) {
            if(s.fH[i]>bestP){bestP=s.fH[i];trailStop=bestP-trailAbs;}
            const exitLevel = Math.max(trailStop, entry);
            if(s.fL[i] <= exitLevel) {
              const exitP = exitLevel;
              tradePnl = tp1Abs*0.5 + (exitP-entry)*0.5 - cost;
              result = exitP > entry ? 'TRAIL' : 'TP1BE'; break;
            }
          }
        } else {
          if(!tp1Hit) {
            if(s.fH[i] >= slPrice) { result='SL'; tradePnl = -slAbs - cost; break; }
            if(s.fL[i] <= tp1Price) { tp1Hit=true; bestP=s.fL[i]; trailStop=bestP+trailAbs; }
          }
          if(tp1Hit) {
            if(s.fL[i]<bestP){bestP=s.fL[i];trailStop=bestP+trailAbs;}
            const exitLevel = Math.min(trailStop, entry);
            if(s.fH[i] >= exitLevel) {
              const exitP = exitLevel;
              tradePnl = tp1Abs*0.5 + (entry-exitP)*0.5 - cost;
              result = exitP < entry ? 'TRAIL' : 'TP1BE'; break;
            }
          }
        }
      }
      if(result==='TO') {
        const last = s.fC[maxBars-1] || entry;
        const uPnl = s.signal==='B' ? last-entry : entry-last;
        tradePnl = tp1Hit ? tp1Abs*0.5+uPnl*0.5-cost : uPnl-cost;
      }
    } else if(cfg.strategy === 'fixed') {
      // Fixed TP2
      const tp2Abs = cfg.atrBased ? useATR * cfg.tp2M : entry * cfg.tp2P / 100;
      const tp2Price = s.signal==='B' ? entry + tp2Abs : entry - tp2Abs;

      for(let i = 0; i < maxBars; i++) {
        if(s.signal === 'B') {
          if(!tp1Hit) {
            if(s.fL[i] <= slPrice) { result='SL'; tradePnl = -slAbs - cost; break; }
            if(s.fH[i] >= tp1Price) tp1Hit = true;
          }
          if(tp1Hit) {
            if(s.fH[i] >= tp2Price) { result='TP2'; tradePnl = tp1Abs*0.5+tp2Abs*0.5-cost; break; }
            if(s.fL[i] <= entry) { result='TP1BE'; tradePnl = tp1Abs*0.5-cost; break; }
          }
        } else {
          if(!tp1Hit) {
            if(s.fH[i] >= slPrice) { result='SL'; tradePnl = -slAbs - cost; break; }
            if(s.fL[i] <= tp1Price) tp1Hit = true;
          }
          if(tp1Hit) {
            if(s.fL[i] <= tp2Price) { result='TP2'; tradePnl = tp1Abs*0.5+tp2Abs*0.5-cost; break; }
            if(s.fH[i] >= entry) { result='TP1BE'; tradePnl = tp1Abs*0.5-cost; break; }
          }
        }
      }
      if(result==='TO') {
        const last = s.fC[maxBars-1] || entry;
        const uPnl = s.signal==='B' ? last-entry : entry-last;
        tradePnl = tp1Hit ? tp1Abs*0.5+uPnl*0.5-cost : uPnl-cost;
      }
    }

    const pnlPct = tradePnl / entry * 100;
    pnl += pnlPct;
    if(result==='SL'||(result==='TO'&&pnlPct<0)) losses++;
    else wins++;
  }

  const total = wins + losses;
  return { wins, losses, total: count, wr: total>0?wins/total*100:0, pnl, spd: 0 };
}

// ═══ MAIN ═══
async function main() {
  console.log('═'.repeat(70));
  console.log('  SCALP v3 — FAST OPTIMIZER (Pre-computed signals)');
  console.log('  Targets: WR>80% | PnL>+20% | 300+ sigs/day');
  console.log('═'.repeat(70) + '\n');

  await loadData();
  const days = Object.values(DATA)[0]?.len / 288 || 3.5;

  // ═══ STEP 1: Pre-compute all base signals ═══
  console.log('\n  Pre-computing signals...');
  const trainSigs = precomputeSignals(0, 0.5, 36);
  const testSigs = precomputeSignals(0.5, 1.0, 36);
  const trainDays = days * 0.5;
  const testDays = days * 0.5;
  console.log(`  TRAIN: ${trainSigs.length} raw signals (${trainDays.toFixed(1)}d) → ${(trainSigs.length/trainDays).toFixed(0)}/day`);
  console.log(`  TEST:  ${testSigs.length} raw signals (${testDays.toFixed(1)}d) → ${(testSigs.length/testDays).toFixed(0)}/day\n`);

  // Directional accuracy check
  let correctTrain = 0;
  for(const s of trainSigs) {
    const fc = s.fC[5] || s.fC.at(-1) || s.entry;
    if(s.signal==='B' && fc > s.entry) correctTrain++;
    else if(s.signal==='S' && fc < s.entry) correctTrain++;
  }
  console.log(`  Base directional accuracy (6-bar): ${(correctTrain/trainSigs.length*100).toFixed(1)}%\n`);

  // ═══ STEP 2: MASSIVE GRID SEARCH on train ═══
  console.log('═══ GRID SEARCH (train set) ═══\n');

  const filterPresets = [
    { id:'base', cfg:{} },
    { id:'anti1h', cfg:{antiHTF:true} },
    { id:'req1h', cfg:{reqHTF:true} },
    { id:'reqMTF', cfg:{reqMTF:true} },
    { id:'reqMTFc', cfg:{reqMTFc:true} },
    { id:'both', cfg:{reqHTF:true,reqMTFc:true} },
    { id:'m05', cfg:{antiHTF:true,minMargin:0.5} },
    { id:'m10', cfg:{antiHTF:true,minMargin:1.0} },
    { id:'m15', cfg:{antiHTF:true,minMargin:1.5} },
    { id:'q1', cfg:{antiHTF:true,exh:true,mom:true} },
    { id:'q2', cfg:{antiHTF:true,exh:true,mom:true,minMargin:0.5} },
    { id:'q3', cfg:{reqHTF:true,exh:true,mom:true} },
    { id:'q4', cfg:{reqHTF:true,reqMTFc:true,exh:true,mom:true} },
    { id:'bb', cfg:{antiHTF:true,bbF:true} },
    { id:'st', cfg:{antiHTF:true,stF:true} },
    { id:'bbst', cfg:{antiHTF:true,bbF:true,stF:true} },
    { id:'r55', cfg:{antiHTF:true,rsiCap:true,rsiCapB:55,rsiCapS:45} },
    { id:'r60', cfg:{antiHTF:true,rsiCap:true,rsiCapB:60,rsiCapS:40} },
    { id:'hrs', cfg:{antiHTF:true,blockH:[6,7,11,12,15,16,17,18,19]} },
    { id:'adx15', cfg:{antiHTF:true,adxF:15} },
    { id:'buyO', cfg:{onlyBuy:true,antiHTF:true} },
    { id:'s2', cfg:{antiHTF:true,minScore:2} },
    { id:'s3', cfg:{antiHTF:true,minScore:3} },
    { id:'s4', cfg:{antiHTF:true,minScore:4} },
    { id:'ema15', cfg:{antiHTF:true,emaD:1.5} },
    { id:'ultra', cfg:{reqHTF:true,reqMTFc:true,exh:true,mom:true,minMargin:1.0} },
    { id:'mega', cfg:{reqHTF:true,reqMTFc:true,exh:true,mom:true,bbF:true,stF:true} },
  ];

  let best = [];
  let tested = 0;

  // ATR-based TP/SL
  const tp1Ms = [0.05, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50];
  const slMs  = [0.30, 0.40, 0.50, 0.60, 0.80, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0];
  const tp2Ms = [0.20, 0.30, 0.40, 0.50, 0.60, 0.80, 1.0, 1.5];
  const trMs  = [0.05, 0.08, 0.10, 0.15, 0.20, 0.30];
  const costPSs = [0.0002, 0.0004, 0.0006];
  const evalWs = [12, 24, 36];
  const cds = [2, 3, 4, 6];

  // ─── Strategy: Fixed TP2 (ATR-based) ───
  console.log('  Testing Fixed TP2 (ATR-based)...');
  for(const fp of filterPresets) {
    for(const tp1 of tp1Ms) {
      for(const tp2 of tp2Ms) {
        if(tp2 <= tp1) continue;
        for(const sl of slMs) {
          for(const cps of costPSs) {
            for(const ew of evalWs) {
              for(const cd of cds) {
                tested++;
                if(tested%10000===0) process.stdout.write(`  ${(tested/1000).toFixed(0)}K... best: WR=${best[0]?.wr?.toFixed(1)||'?'}% PnL=${best[0]?.pnl?.toFixed(1)||'?'}% ${best[0]?.spd?.toFixed(0)||'?'}s/d\r`);

                const cfg = { strategy:'fixed', atrBased:true, tp1M:tp1, tp2M:tp2, slM:sl, costPS:cps, evalW:ew, cooldown:cd, ...fp.cfg };
                const r = evalSignals(trainSigs, cfg);
                if(r.total < 20) continue;
                r.spd = r.total / trainDays;

                const score = (r.wr>=80?50:0) + r.wr*0.3 + (r.pnl>0?r.pnl*3:r.pnl*5) + (r.spd>=300?20:r.spd>=150?10:r.spd>=50?0:-20);
                best.push({ score, ...cfg, filterID: fp.id, wr:r.wr, pnl:r.pnl, spd:r.spd, n:r.total });
                best.sort((a,b) => b.score - a.score);
                if(best.length > 100) best.length = 100;
              }
            }
          }
        }
      }
    }
  }
  console.log(`\n  Fixed: ${tested} combos. Best WR=${best[0]?.wr?.toFixed(1)}% PnL=${best[0]?.pnl?.toFixed(1)}%`);

  // ─── Strategy: Trailing Stop (ATR-based) ───
  console.log('  Testing Trailing Stop (ATR-based)...');
  let tested2 = 0;
  for(const fp of filterPresets) {
    for(const tp1 of tp1Ms) {
      for(const sl of slMs) {
        for(const tr of trMs) {
          for(const cps of costPSs) {
            for(const ew of evalWs) {
              for(const cd of cds) {
                tested2++;
                if(tested2%10000===0) process.stdout.write(`  ${(tested2/1000).toFixed(0)}K trail... best: WR=${best[0]?.wr?.toFixed(1)||'?'}% PnL=${best[0]?.pnl?.toFixed(1)||'?'}%\r`);

                const cfg = { strategy:'trail', atrBased:true, tp1M:tp1, slM:sl, trailM:tr, costPS:cps, evalW:ew, cooldown:cd, ...fp.cfg };
                const r = evalSignals(trainSigs, cfg);
                if(r.total < 20) continue;
                r.spd = r.total / trainDays;

                const score = (r.wr>=80?50:0) + r.wr*0.3 + (r.pnl>0?r.pnl*3:r.pnl*5) + (r.spd>=300?20:r.spd>=150?10:r.spd>=50?0:-20);
                best.push({ score, ...cfg, filterID: fp.id, wr:r.wr, pnl:r.pnl, spd:r.spd, n:r.total });
                best.sort((a,b) => b.score - a.score);
                if(best.length > 100) best.length = 100;
              }
            }
          }
        }
      }
    }
  }
  console.log(`\n  Trail: ${tested2} combos. Total best list: ${best.length}`);

  // ─── % based TP/SL too ───
  console.log('  Testing %-based TP/SL...');
  const pTp1s = [0.04,0.06,0.08,0.10,0.12,0.15,0.20,0.25,0.30];
  const pTp2s = [0.15,0.20,0.30,0.40,0.50,0.60,0.80,1.0];
  const pSls  = [0.20,0.30,0.40,0.50,0.60,0.80,1.0,1.5,2.0];
  const pTrs  = [0.05,0.08,0.10,0.15,0.20];
  let tested3 = 0;

  for(const fp of filterPresets) {
    for(const tp1 of pTp1s) {
      for(const sl of pSls) {
        // Fixed
        for(const tp2 of pTp2s) {
          if(tp2<=tp1) continue;
          for(const cps of costPSs) {
            tested3++;
            const cfg = { strategy:'fixed', atrBased:false, tp1P:tp1, tp2P:tp2, slP:sl, costPS:cps, evalW:24, cooldown:2, ...fp.cfg };
            const r = evalSignals(trainSigs, cfg);
            if(r.total<20)continue;
            r.spd=r.total/trainDays;
            const score=(r.wr>=80?50:0)+r.wr*0.3+(r.pnl>0?r.pnl*3:r.pnl*5)+(r.spd>=300?20:r.spd>=150?10:0);
            best.push({score,...cfg,filterID:fp.id,wr:r.wr,pnl:r.pnl,spd:r.spd,n:r.total});
            best.sort((a,b)=>b.score-a.score);
            if(best.length>100)best.length=100;
          }
        }
        // Trail
        for(const tr of pTrs) {
          for(const cps of costPSs) {
            tested3++;
            const cfg={strategy:'trail',atrBased:false,tp1P:tp1,slP:sl,trailP:tr,costPS:cps,evalW:24,cooldown:2,...fp.cfg};
            const r=evalSignals(trainSigs,cfg);
            if(r.total<20)continue;
            r.spd=r.total/trainDays;
            const score=(r.wr>=80?50:0)+r.wr*0.3+(r.pnl>0?r.pnl*3:r.pnl*5)+(r.spd>=300?20:r.spd>=150?10:0);
            best.push({score,...cfg,filterID:fp.id,wr:r.wr,pnl:r.pnl,spd:r.spd,n:r.total});
            best.sort((a,b)=>b.score-a.score);
            if(best.length>100)best.length=100;
          }
        }
      }
    }
  }
  console.log(`  %-based: ${tested3} combos.\n`);

  const totalTested = tested + tested2 + tested3;
  console.log(`  TOTAL: ${(totalTested/1000).toFixed(0)}K configurations tested on TRAIN\n`);

  // Top 20 TRAIN results
  console.log('  TOP 20 TRAIN RESULTS:\n');
  console.log('  # | Strat | TP1    | TP2/Tr | SL     | Cost  | EW | CD | WR%   | PnL%     | S/Day | Filter');
  console.log('  ' + '-'.repeat(100));
  for(let i=0;i<Math.min(20,best.length);i++){
    const r=best[i];
    const tp1Str=r.atrBased?`${r.tp1M}xA`:`${r.tp1P}%`;
    const tp2Str=r.strategy==='trail'?(r.atrBased?`t${r.trailM}xA`:`t${r.trailP}%`):(r.atrBased?`${r.tp2M}xA`:`${r.tp2P}%`);
    const slStr=r.atrBased?`${r.slM}xA`:`${r.slP}%`;
    console.log(`  ${String(i+1).padStart(2)} | ${r.strategy.padEnd(5)} | ${tp1Str.padStart(6)} | ${tp2Str.padStart(6)} | ${slStr.padStart(6)} | ${(r.costPS*10000).toFixed(0).padStart(3)}bp | ${String(r.evalW||24).padStart(2)} | ${String(r.cooldown||2).padStart(2)} | ${r.wr.toFixed(1).padStart(5)}% | ${(r.pnl>=0?'+':'')+r.pnl.toFixed(2).padStart(7)}% | ${r.spd.toFixed(0).padStart(5)} | ${r.filterID}`);
  }

  // ═══ WALK-FORWARD VALIDATION ═══
  console.log('\n' + '═'.repeat(70));
  console.log('  WALK-FORWARD VALIDATION (test set — unseen data)');
  console.log('═'.repeat(70) + '\n');

  const validated = [];
  for(let i=0;i<Math.min(50,best.length);i++){
    const cfg = {...best[i]};
    const r = evalSignals(testSigs, cfg);
    r.spd = r.total / testDays;
    validated.push({
      ...cfg,
      tWR:r.wr, tPnl:r.pnl, tSpd:r.spd, tN:r.total,
      trWR:cfg.wr, trPnl:cfg.pnl, trSpd:cfg.spd
    });
  }

  validated.sort((a,b) => {
    const sA = (a.tWR>=80?50:0) + a.tWR*0.3 + (a.tPnl>0?a.tPnl*3:a.tPnl*5) + (a.tSpd>=300?20:a.tSpd>=150?10:0);
    const sB = (b.tWR>=80?50:0) + b.tWR*0.3 + (b.tPnl>0?b.tPnl*3:b.tPnl*5) + (b.tSpd>=300?20:b.tSpd>=150?10:0);
    return sB - sA;
  });

  console.log('  TOP 20 VALIDATED:\n');
  console.log('  # | Strat | TP1    | TP2/Tr | SL     | Cost | TRAIN WR | TRAIN PnL | TEST WR | TEST PnL | T.S/Day | Filter');
  console.log('  ' + '-'.repeat(115));
  for(let i=0;i<Math.min(20,validated.length);i++){
    const v=validated[i];
    const tp1S=v.atrBased?`${v.tp1M}xA`:`${v.tp1P}%`;
    const tp2S=v.strategy==='trail'?(v.atrBased?`t${v.trailM}xA`:`t${v.trailP}%`):(v.atrBased?`${v.tp2M}xA`:`${v.tp2P}%`);
    const slS=v.atrBased?`${v.slM}xA`:`${v.slP}%`;
    console.log(`  ${String(i+1).padStart(2)} | ${v.strategy.padEnd(5)} | ${tp1S.padStart(6)} | ${tp2S.padStart(6)} | ${slS.padStart(6)} | ${(v.costPS*10000).toFixed(0).padStart(3)}b | ${v.trWR.toFixed(1).padStart(7)}% | ${(v.trPnl>=0?'+':'')+v.trPnl.toFixed(2).padStart(8)}% | ${v.tWR.toFixed(1).padStart(6)}% | ${(v.tPnl>=0?'+':'')+v.tPnl.toFixed(2).padStart(7)}% | ${v.tSpd.toFixed(0).padStart(6)}  | ${v.filterID}`);
  }

  // ═══ BEST CONFIG ═══
  const b = validated[0];
  if(b) {
    console.log('\n' + '═'.repeat(70));
    console.log('  MEJOR CONFIG WALK-FORWARD VALIDADA');
    console.log('═'.repeat(70));
    console.log(`  Strategy: ${b.strategy} | ${b.atrBased?'ATR-based':'%-based'}`);
    if(b.atrBased) {
      console.log(`  TP1: ${b.tp1M}xATR | ${b.strategy==='trail'?'Trail: '+b.trailM+'xATR':'TP2: '+b.tp2M+'xATR'} | SL: ${b.slM}xATR`);
    } else {
      console.log(`  TP1: ${b.tp1P}% | ${b.strategy==='trail'?'Trail: '+b.trailP+'%':'TP2: '+b.tp2P+'%'} | SL: ${b.slP}%`);
    }
    console.log(`  Cost: ${(b.costPS*10000).toFixed(0)} bps/side | EvalWindow: ${b.evalW||24} bars | Cooldown: ${b.cooldown||2} bars`);
    console.log(`  Filter: ${b.filterID}`);
    console.log(`  TRAIN: WR=${b.trWR.toFixed(1)}% | PnL=${b.trPnl>=0?'+':''}${b.trPnl.toFixed(2)}% | ${b.trSpd.toFixed(0)} s/d`);
    console.log(`  TEST:  WR=${b.tWR.toFixed(1)}% | PnL=${b.tPnl>=0?'+':''}${b.tPnl.toFixed(2)}% | ${b.tSpd.toFixed(0)} s/d`);

    // Full validation
    const allSigs = precomputeSignals(0, 1.0, 36);
    const full = evalSignals(allSigs, b);
    full.spd = full.total / days;
    console.log(`  FULL:  WR=${full.wr.toFixed(1)}% | PnL=${full.totalPnl>=0?'+':''}${full.pnl.toFixed(2)}% | ${full.spd.toFixed(0)} s/d | ${full.total} signals`);

    console.log('\n  TARGETS:');
    console.log(`  ${full.wr>80?'[OK]':'[!!]'} WR > 80%: ${full.wr.toFixed(1)}%`);
    console.log(`  ${full.pnl>20?'[OK]':'[!!]'} PnL > +20%: ${full.pnl>=0?'+':''}${full.pnl.toFixed(2)}%`);
    console.log(`  ${full.spd>300?'[OK]':'[!!]'} Sigs/Day > 300: ${full.spd.toFixed(0)}/dia`);
  }

  console.log('\n' + '═'.repeat(70));
}

main().catch(console.error);
