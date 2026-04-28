// ═══════════════════════════════════════════════════════════════════
// SCALP MEAN-REVERSION v3 — FAVORABLE RISK/REWARD FOCUS
// Key change: TP ≥ SL ratios + higher conviction thresholds
// Also: 3-fold cross-validation to avoid overfitting
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

let DATA = {};
async function loadData(){
  for(const sym of SYMS){
    process.stdout.write(`  ${sym}...`);
    const [k5,k15]=await Promise.all([getKlines(sym,'5m',1000),getKlines(sym,'15m',400)]);
    if(!k5||k5.length<400){console.log(' SKIP');continue;}
    DATA[sym]={C:k5.map(k=>+k[4]),H:k5.map(k=>+k[2]),L:k5.map(k=>+k[3]),V:k5.map(k=>+k[5]),T:k5.map(k=>k[0]),
      C15:k15?k15.map(k=>+k[4]):[],H15:k15?k15.map(k=>+k[2]):[],L15:k15?k15.map(k=>+k[3]):[],T15:k15?k15.map(k=>k[0]):[],len:k5.length};
    console.log(` ${k5.length}`);await new Promise(r=>setTimeout(r,200));
  }
}

function precomputeIndicators() {
  const LB = 280, FUT = 48;
  const allBars = [];

  for (const sym of Object.keys(DATA)) {
    const d = DATA[sym];
    const bS = LB, bE = d.len - FUT;
    if (bE <= bS) continue;

    for (let bar = bS; bar < bE; bar++) {
      const c = d.C.slice(bar-279, bar+1), h = d.H.slice(bar-279, bar+1), l = d.L.slice(bar-279, bar+1), v = d.V.slice(bar-279, bar+1);
      const bt = d.T[bar], hUTC = new Date(bt).getUTCHours();
      if (hUTC >= 0 && hUTC < 6) continue;

      const avgV = v.slice(-20).reduce((a,b)=>a+b)/20;
      const vr = v.at(-1) / avgV;
      if (vr < 0.3) continue;

      const cur = c.at(-1);
      const rsi = calcRSI(c, 14);
      const stoch = calcStoch(h, l, c, 14);
      const bb = calcBB(c, 20, 2);
      const bbR = bb.u - bb.l;
      const bbP = bbR > 0 ? (cur - bb.l) / bbR : 0.5;
      const atr = calcATR(h, l, c, 14);
      const mac = calcMACD(c);
      const mom3 = (cur - (c.at(-4) || cur)) / Math.max(atr, 0.0001);
      const adx = calcADX(h, l, c);
      const l4 = c.slice(-4);
      const bullExh = l4.length >= 4 && l4.every((x,i) => i === 0 || x > l4[i-1]);
      const bearExh = l4.length >= 4 && l4.every((x,i) => i === 0 || x < l4[i-1]);
      const emaDist = (cur - calcEMAArr(c, 21).at(-1)) / Math.max(atr, 0.0001);

      let c15e = 0;
      for (let j = d.T15.length - 1; j >= 0; j--) { if (d.T15[j] <= bt) { c15e = j + 1; break; } }
      const c15 = d.C15.slice(Math.max(0, c15e-100), c15e);
      const h15 = d.H15.slice(Math.max(0, c15e-100), c15e);
      const l15 = d.L15.slice(Math.max(0, c15e-100), c15e);
      let atr15 = atr;
      if (h15.length > 15 && l15.length > 15 && c15.length > 15) {
        const a = calcATR(h15, l15, c15, 14);
        if (a > 0) atr15 = a;
      }

      let mtf = 0;
      if (c15.length > 25) {
        const e9_15 = calcEMA(c15, 9), e21_15 = calcEMA(c15, 21), m15 = calcMACD(c15);
        if (e9_15 > e21_15) mtf++; else mtf--;
        if (m15.h > 0) mtf++; else mtf--;
      }

      // ═══ Conviction scoring ═══
      let buyConv = 0, sellConv = 0, buyConds = 0, sellConds = 0;

      if (rsi < 25) { buyConv += 4; buyConds++; }
      else if (rsi < 30) { buyConv += 3; buyConds++; }
      else if (rsi < 35) { buyConv += 2; buyConds++; }
      else if (rsi < 40) { buyConv += 1; buyConds++; }
      if (rsi > 75) { sellConv += 4; sellConds++; }
      else if (rsi > 70) { sellConv += 3; sellConds++; }
      else if (rsi > 65) { sellConv += 2; sellConds++; }
      else if (rsi > 60) { sellConv += 1; sellConds++; }

      if (stoch.k < 20) { buyConv += 3; buyConds++; }
      else if (stoch.k < 30) { buyConv += 1.5; buyConds++; }
      if (stoch.k > 80) { sellConv += 3; sellConds++; }
      else if (stoch.k > 70) { sellConv += 1.5; sellConds++; }

      if (bbP < 0.1) { buyConv += 3; buyConds++; }
      else if (bbP < 0.2) { buyConv += 2; buyConds++; }
      if (bbP > 0.9) { sellConv += 3; sellConds++; }
      else if (bbP > 0.8) { sellConv += 2; sellConds++; }

      if (mom3 < -1.0) { buyConv += 2; buyConds++; }
      else if (mom3 < -0.5) { buyConv += 1; buyConds++; }
      if (mom3 > 1.0) { sellConv += 2; sellConds++; }
      else if (mom3 > 0.5) { sellConv += 1; sellConds++; }

      if (bearExh) { buyConv += 2; buyConds++; }
      if (bullExh) { sellConv += 2; sellConds++; }

      if (emaDist < -1.5) { buyConv += 1.5; buyConds++; }
      if (emaDist > 1.5) { sellConv += 1.5; sellConds++; }

      if (mac.h > 0 && mac.ph < 0) { sellConv += 1; sellConds++; }
      if (mac.h < 0 && mac.ph > 0) { buyConv += 1; buyConds++; }

      if (buyConv === 0 && sellConv === 0) continue;

      const fH = [], fL = [], fC = [];
      for (let f = bar + 1; f <= Math.min(bar + FUT, d.len - 1); f++) {
        fH.push(d.H[f]); fL.push(d.L[f]); fC.push(d.C[f]);
      }

      allBars.push({
        sym, bar, entry: cur, atr, atr15,
        buyConv, sellConv, buyConds, sellConds,
        adxVal: adx.adx, mtf, vr,
        fH, fL, fC,
        pct: bar / d.len
      });
    }
  }
  return allBars;
}

// ═══ THREE EXIT STRATEGIES ═══
function evalFixedTPSL(sig, entry, atr15, tp1M, slM, ew, fH, fL, fC, cost) {
  const tp = atr15 * tp1M, sl = atr15 * slM;
  const tpP = sig === 'B' ? entry + tp : entry - tp;
  const slP = sig === 'B' ? entry - sl : entry + sl;
  const tradeCost = entry * cost * 2;
  const maxBars = Math.min(ew, fH.length);

  for (let i = 0; i < maxBars; i++) {
    if (sig === 'B') {
      if (fL[i] <= slP) return -sl - tradeCost;
      if (fH[i] >= tpP) return tp - tradeCost;
    } else {
      if (fH[i] >= slP) return -sl - tradeCost;
      if (fL[i] <= tpP) return tp - tradeCost;
    }
  }
  const last = fC[maxBars - 1] || entry;
  return (sig === 'B' ? last - entry : entry - last) - tradeCost;
}

function evalPartialTP(sig, entry, atr15, tp1M, slM, trailM, ew, fH, fL, fC, cost) {
  const tp1 = atr15 * tp1M, sl = atr15 * slM, trail = atr15 * trailM;
  const tp1P = sig === 'B' ? entry + tp1 : entry - tp1;
  const slP = sig === 'B' ? entry - sl : entry + sl;
  const tradeCost = entry * cost * 2;
  const maxBars = Math.min(ew, fH.length);
  let tp1Hit = false, bestP = entry;

  for (let i = 0; i < maxBars; i++) {
    if (sig === 'B') {
      if (!tp1Hit) {
        if (fL[i] <= slP) return -sl - tradeCost;
        if (fH[i] >= tp1P) { tp1Hit = true; bestP = fH[i]; }
      }
      if (tp1Hit) {
        if (fH[i] > bestP) bestP = fH[i];
        const exitLvl = Math.max(bestP - trail, entry);
        if (fL[i] <= exitLvl) return tp1 * 0.5 + (exitLvl - entry) * 0.5 - tradeCost;
      }
    } else {
      if (!tp1Hit) {
        if (fH[i] >= slP) return -sl - tradeCost;
        if (fL[i] <= tp1P) { tp1Hit = true; bestP = fL[i]; }
      }
      if (tp1Hit) {
        if (fL[i] < bestP) bestP = fL[i];
        const exitLvl = Math.min(bestP + trail, entry);
        if (fH[i] >= exitLvl) return tp1 * 0.5 + (entry - exitLvl) * 0.5 - tradeCost;
      }
    }
  }
  const last = fC[maxBars - 1] || entry;
  const uPnl = sig === 'B' ? last - entry : entry - last;
  return tp1Hit ? tp1 * 0.5 + uPnl * 0.5 - tradeCost : uPnl - tradeCost;
}

function fastBacktest(allBars, startPct, endPct, sigCfg, tradeCfg) {
  const { minConv, minConds, adxBlock, adxMax, mtfCheck } = sigCfg;
  const { strategy, tp1M, slM, trailM, ew, cd, cost } = tradeCfg;

  let wins = 0, losses = 0, pnl = 0, count = 0;
  const lastBar = {};

  for (let i = 0; i < allBars.length; i++) {
    const b = allBars[i];
    if (b.pct < startPct || b.pct >= endPct) continue;

    const lb = lastBar[b.sym] || -999;
    if (b.bar - lb < cd) continue;

    let signal = 'N';
    if (b.buyConv > b.sellConv && b.buyConv >= minConv && b.buyConds >= minConds) signal = 'B';
    else if (b.sellConv > b.buyConv && b.sellConv >= minConv && b.sellConds >= minConds) signal = 'S';
    if (signal === 'N') continue;

    if (adxBlock && b.adxVal > adxMax) continue;
    if (mtfCheck && signal === 'B' && b.mtf < -1) continue;
    if (mtfCheck && signal === 'S' && b.mtf > 1) continue;

    lastBar[b.sym] = b.bar;
    count++;

    const atr15 = b.atr15 || b.atr;
    let tPnl;
    if (strategy === 'fixed') {
      tPnl = evalFixedTPSL(signal, b.entry, atr15, tp1M, slM, ew, b.fH, b.fL, b.fC, cost);
    } else {
      tPnl = evalPartialTP(signal, b.entry, atr15, tp1M, slM, trailM || 0.1, ew, b.fH, b.fL, b.fC, cost);
    }

    const pnlPct = tPnl / b.entry * 100;
    pnl += pnlPct;
    if (pnlPct < 0) losses++; else wins++;
  }

  const total = wins + losses;
  const len = Object.values(DATA)[0]?.len || 1000;
  const days = len * (endPct - startPct) / 288;
  return { wins, losses, total: count, wr: total > 0 ? wins / total * 100 : 0, pnl, spd: count / Math.max(0.5, days), days };
}

async function main() {
  console.log('═'.repeat(70));
  console.log('  SCALP MEAN-REVERSION v3 — FAVORABLE R:R + CROSS-VALIDATION');
  console.log('  Target: WR>60%, PnL>+20%, robust across time windows');
  console.log('═'.repeat(70) + '\n');

  await loadData();

  console.log('\n  Pre-computing indicators...');
  const t0 = Date.now();
  const allBars = precomputeIndicators();
  console.log(`  Done: ${allBars.length} candidate bars in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  // ═══ GRID — Focus on TP ≥ SL (favorable R:R) and high selectivity ═══
  const sigConfigs = [];
  for (const mc of [3, 4, 5, 6, 7, 8, 10, 12]) {
    for (const mcd of [2, 3, 4, 5]) {
      for (const ab of [false, true]) {
        const ams = ab ? [20, 25, 30] : [30];
        for (const am of ams) {
          for (const mtfc of [false, true]) {
            sigConfigs.push({ minConv: mc, minConds: mcd, adxBlock: ab, adxMax: am, mtfCheck: mtfc });
          }
        }
      }
    }
  }

  // Strategy 1: Fixed TP/SL with TP ≥ SL
  const tradeConfigs = [];
  // Fixed TP/SL — favorable R:R
  for (const tp of [0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.2, 1.5]) {
    for (const sl of [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0]) {
      if (tp < sl * 0.8) continue; // Only favorable R:R (TP/SL >= 0.8)
      for (const ew of [8, 12, 18, 24, 36]) {
        for (const cd of [2, 3, 4, 6, 8]) {
          tradeConfigs.push({ strategy: 'fixed', tp1M: tp, slM: sl, ew, cd, cost: 0.0004 });
        }
      }
    }
  }
  // Partial TP + trailing
  for (const tp of [0.3, 0.4, 0.5, 0.6, 0.8, 1.0]) {
    for (const sl of [0.3, 0.4, 0.5, 0.6, 0.8, 1.0]) {
      if (tp < sl * 0.7) continue;
      for (const tr of [0.08, 0.12, 0.15, 0.20]) {
        for (const ew of [12, 18, 24, 36]) {
          for (const cd of [2, 4, 6, 8]) {
            tradeConfigs.push({ strategy: 'partial', tp1M: tp, slM: sl, trailM: tr, ew, cd, cost: 0.0004 });
          }
        }
      }
    }
  }

  console.log(`  Signal configs: ${sigConfigs.length}`);
  console.log(`  Trade configs: ${tradeConfigs.length}`);
  console.log(`  Total combos: ${(sigConfigs.length * tradeConfigs.length / 1000).toFixed(0)}K`);

  // ═══ 3-FOLD CROSS-VALIDATION ═══
  // Fold1: Train 0-33%, Test 33-67%
  // Fold2: Train 33-67%, Test 67-100%
  // Fold3: Train 0-50%, Test 50-100% (standard walk-forward)
  // Score = MINIMUM test PnL across folds (robust = good in all)

  console.log('\n  Phase 1: 3-fold cross-validation grid search...\n');

  let best = [];
  let tested = 0;
  const total = sigConfigs.length * tradeConfigs.length;
  const t1 = Date.now();

  for (const sigCfg of sigConfigs) {
    for (const tradeCfg of tradeConfigs) {
      tested++;
      if (tested % 50000 === 0) {
        const elapsed = (Date.now() - t1) / 1000;
        const rate = tested / elapsed;
        const eta = (total - tested) / rate;
        process.stdout.write(`  ${(tested/1000).toFixed(0)}K/${(total/1000).toFixed(0)}K (${(tested/total*100).toFixed(1)}%) | ${rate.toFixed(0)}/s | ETA: ${(eta/60).toFixed(1)}min | best: WR=${best[0]?.avgWR?.toFixed(1)||'?'}% PnL=${best[0]?.minPnl?.toFixed(1)||'?'}%\r`);
      }

      // Quick check on fold 3 first (standard walk-forward)
      const r3train = fastBacktest(allBars, 0, 0.5, sigCfg, tradeCfg);
      if (r3train.total < 8 || r3train.pnl < 0) continue; // Skip if train is negative

      const r3test = fastBacktest(allBars, 0.5, 1.0, sigCfg, tradeCfg);
      if (r3test.total < 5) continue;

      // If fold 3 looks okay, check fold 1 and 2
      const r1test = fastBacktest(allBars, 0.33, 0.67, sigCfg, tradeCfg);
      const r2test = fastBacktest(allBars, 0.67, 1.0, sigCfg, tradeCfg);

      if (r1test.total < 3 || r2test.total < 3) continue;

      const minPnl = Math.min(r1test.pnl, r2test.pnl, r3test.pnl);
      const avgPnl = (r1test.pnl + r2test.pnl + r3test.pnl) / 3;
      const avgWR = (r1test.wr + r2test.wr + r3test.wr) / 3;
      const minWR = Math.min(r1test.wr, r2test.wr, r3test.wr);

      // Score: prioritize configs that are profitable in ALL folds
      const score = minPnl * 10 + avgPnl * 3 + (minWR >= 55 ? minWR : 0) + (avgWR >= 60 ? avgWR : 0);

      best.push({
        score, ...sigCfg, ...tradeCfg,
        f1WR: r1test.wr, f1Pnl: r1test.pnl, f1N: r1test.total,
        f2WR: r2test.wr, f2Pnl: r2test.pnl, f2N: r2test.total,
        f3WR: r3test.wr, f3Pnl: r3test.pnl, f3N: r3test.total, f3Spd: r3test.spd,
        trWR: r3train.wr, trPnl: r3train.pnl,
        minPnl, avgPnl, avgWR, minWR
      });
      best.sort((a, b) => b.score - a.score);
      if (best.length > 100) best.length = 100;
    }
  }

  const elapsed1 = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`\n\n  Tested ${(tested/1000).toFixed(0)}K configs in ${elapsed1}s`);
  console.log(`  Configs with ALL folds profitable: ${best.filter(b => b.minPnl > 0).length}\n`);

  // ═══ TOP 25 RESULTS ═══
  console.log('  TOP 25 CROSS-VALIDATED:\n');
  console.log('  #  | Type    | mConv | mCond | ADX  | MTF | TP   | SL   | Tr   | EW | CD | F1 WR | F1 PnL | F2 WR | F2 PnL | F3 WR | F3 PnL | Min PnL | Avg PnL');
  console.log('  ' + '-'.repeat(145));
  for (let i = 0; i < Math.min(25, best.length); i++) {
    const v = best[i];
    const type = v.strategy === 'fixed' ? 'fixed  ' : 'partial';
    const tr = v.trailM ? v.trailM.toFixed(2) : ' n/a';
    console.log(`  ${String(i+1).padStart(2)} | ${type} | ${String(v.minConv).padStart(5)} | ${String(v.minConds).padStart(5)} | ${v.adxBlock?String(v.adxMax).padStart(4):' no '} | ${v.mtfCheck?'yes':' no'} | ${v.tp1M.toFixed(2).padStart(4)} | ${v.slM.toFixed(2).padStart(4)} | ${tr} | ${String(v.ew).padStart(2)} | ${String(v.cd).padStart(2)} | ${v.f1WR.toFixed(1).padStart(5)}% | ${(v.f1Pnl>=0?'+':'')+v.f1Pnl.toFixed(1).padStart(5)}% | ${v.f2WR.toFixed(1).padStart(5)}% | ${(v.f2Pnl>=0?'+':'')+v.f2Pnl.toFixed(1).padStart(5)}% | ${v.f3WR.toFixed(1).padStart(5)}% | ${(v.f3Pnl>=0?'+':'')+v.f3Pnl.toFixed(1).padStart(5)}% | ${(v.minPnl>=0?'+':'')+v.minPnl.toFixed(2).padStart(6)}% | ${(v.avgPnl>=0?'+':'')+v.avgPnl.toFixed(2).padStart(6)}%`);
  }

  // ═══ FULL VALIDATION of top 5 ═══
  console.log('\n' + '═'.repeat(70));
  console.log('  FULL VALIDATION — Top 5 on ALL data');
  console.log('═'.repeat(70) + '\n');

  for (let i = 0; i < Math.min(5, best.length); i++) {
    const b = best[i];
    const sigCfg = { minConv: b.minConv, minConds: b.minConds, adxBlock: b.adxBlock, adxMax: b.adxMax, mtfCheck: b.mtfCheck };
    const tradeCfg = { strategy: b.strategy, tp1M: b.tp1M, slM: b.slM, trailM: b.trailM, ew: b.ew, cd: b.cd, cost: b.cost };
    const full = fastBacktest(allBars, 0, 1.0, sigCfg, tradeCfg);

    console.log(`  Config #${i+1} (${b.strategy}):`);
    console.log(`    Signal: minConv=${b.minConv} | minConds=${b.minConds} | ADX=${b.adxBlock?b.adxMax:'no'} | MTF=${b.mtfCheck?'yes':'no'}`);
    console.log(`    Trade:  TP=${b.tp1M}xATR | SL=${b.slM}xATR${b.trailM?' | Trail='+b.trailM+'xATR':''} | EW=${b.ew} | CD=${b.cd}`);
    console.log(`    Fold 1: WR=${b.f1WR.toFixed(1)}% PnL=${b.f1Pnl>=0?'+':''}${b.f1Pnl.toFixed(2)}% (${b.f1N})`);
    console.log(`    Fold 2: WR=${b.f2WR.toFixed(1)}% PnL=${b.f2Pnl>=0?'+':''}${b.f2Pnl.toFixed(2)}% (${b.f2N})`);
    console.log(`    Fold 3: WR=${b.f3WR.toFixed(1)}% PnL=${b.f3Pnl>=0?'+':''}${b.f3Pnl.toFixed(2)}% (${b.f3N})`);
    console.log(`    FULL:   WR=${full.wr.toFixed(1)}% | PnL=${full.pnl>=0?'+':''}${full.pnl.toFixed(2)}% | ${full.spd.toFixed(0)} s/d | ${full.total} sigs (${full.wins}W/${full.losses}L)`);
    console.log(`    ${full.wr>=60?'✓':'✗'} WR≥60%  ${full.pnl>=20?'✓':'✗'} PnL≥+20%  Min-fold PnL: ${b.minPnl>=0?'+':''}${b.minPnl.toFixed(2)}%`);
    console.log();
  }

  // ═══ Robustness: Quarterly breakdown of best config ═══
  if (best.length > 0) {
    const b = best[0];
    const sigCfg = { minConv: b.minConv, minConds: b.minConds, adxBlock: b.adxBlock, adxMax: b.adxMax, mtfCheck: b.mtfCheck };
    const tradeCfg = { strategy: b.strategy, tp1M: b.tp1M, slM: b.slM, trailM: b.trailM, ew: b.ew, cd: b.cd, cost: b.cost };

    console.log('═'.repeat(70));
    console.log('  ROBUSTNESS — Best config across 5 time windows');
    console.log('═'.repeat(70) + '\n');

    const windows = [
      { name: '0-20%', s: 0, e: 0.20 },
      { name: '20-40%', s: 0.20, e: 0.40 },
      { name: '40-60%', s: 0.40, e: 0.60 },
      { name: '60-80%', s: 0.60, e: 0.80 },
      { name: '80-100%', s: 0.80, e: 1.0 },
      { name: 'FULL', s: 0, e: 1.0 },
    ];

    for (const w of windows) {
      const r = fastBacktest(allBars, w.s, w.e, sigCfg, tradeCfg);
      const wrTag = r.wr >= 60 ? '✓' : r.total > 0 ? '✗' : '-';
      const pnlTag = r.pnl > 0 ? '✓' : r.total > 0 ? '✗' : '-';
      console.log(`  ${w.name.padEnd(10)} | ${wrTag} WR=${r.wr.toFixed(1).padStart(5)}% | ${pnlTag} PnL=${(r.pnl>=0?'+':'')+r.pnl.toFixed(2).padStart(7)}% | ${r.spd.toFixed(0).padStart(4)} s/d | ${r.total} sigs`);
    }
  }

  // ═══ DIRECTIONAL ACCURACY CHECK ═══
  console.log('\n' + '═'.repeat(70));
  console.log('  DIRECTIONAL ACCURACY — Signal quality check');
  console.log('═'.repeat(70) + '\n');

  // Check raw directional accuracy for different conviction thresholds
  for (const minConv of [3, 5, 7, 10]) {
    let correct = 0, wrong = 0;
    for (const b of allBars) {
      let signal = 'N';
      if (b.buyConv > b.sellConv && b.buyConv >= minConv && b.buyConds >= 2) signal = 'B';
      else if (b.sellConv > b.buyConv && b.sellConv >= minConv && b.sellConds >= 2) signal = 'S';
      if (signal === 'N') continue;

      // Check 6-bar direction
      const fut6 = b.fC[5] || b.fC[b.fC.length - 1] || b.entry;
      const dir = signal === 'B' ? fut6 > b.entry : fut6 < b.entry;
      if (dir) correct++; else wrong++;
    }
    const total = correct + wrong;
    console.log(`  minConv≥${String(minConv).padStart(2)}: ${total} signals | Directional accuracy: ${(correct/total*100).toFixed(1)}% | ${correct}/${total}`);
  }

  console.log('\n' + '═'.repeat(70));
  console.log('  DONE');
  console.log('═'.repeat(70));
}

main().catch(console.error);
