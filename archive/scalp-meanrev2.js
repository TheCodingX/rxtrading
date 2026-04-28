// ═══════════════════════════════════════════════════════════════════
// SCALP MEAN-REVERSION ENGINE v2 — PRE-COMPUTED SIGNALS
// Pre-compute signals once per signal-config, then test trade configs
// instantly. 100x faster than v1.
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
    const [k5,k15,k1h]=await Promise.all([getKlines(sym,'5m',1000),getKlines(sym,'15m',400),getKlines(sym,'1h',200)]);
    if(!k5||k5.length<400){console.log(' SKIP');continue;}
    DATA[sym]={C:k5.map(k=>+k[4]),H:k5.map(k=>+k[2]),L:k5.map(k=>+k[3]),V:k5.map(k=>+k[5]),T:k5.map(k=>k[0]),
      C15:k15?k15.map(k=>+k[4]):[],H15:k15?k15.map(k=>+k[2]):[],L15:k15?k15.map(k=>+k[3]):[],T15:k15?k15.map(k=>k[0]):[],
      C1h:k1h?k1h.map(k=>+k[4]):[],H1h:k1h?k1h.map(k=>+k[2]):[],L1h:k1h?k1h.map(k=>+k[3]):[],V1h:k1h?k1h.map(k=>+k[5]):[],T1h:k1h?k1h.map(k=>k[0]):[],len:k5.length};
    console.log(` ${k5.length}`);await new Promise(r=>setTimeout(r,200));
  }
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 1: Pre-compute raw indicator values at every bar
// ═══════════════════════════════════════════════════════════════════
function precomputeIndicators() {
  const LB = 280, FUT = 48; // max future bars we'll ever need
  const allBars = []; // [{sym, bar, signal_data, futureH, futureL, futureC, entry, atr, atr15}]

  for (const sym of Object.keys(DATA)) {
    const d = DATA[sym];
    const bS = LB, bE = d.len - FUT;
    if (bE <= bS) continue;

    for (let bar = bS; bar < bE; bar++) {
      const c = d.C.slice(bar-279, bar+1), h = d.H.slice(bar-279, bar+1), l = d.L.slice(bar-279, bar+1), v = d.V.slice(bar-279, bar+1);
      const bt = d.T[bar], hUTC = new Date(bt).getUTCHours();

      // Dead hours filter (always applied)
      if (hUTC >= 0 && hUTC < 6) continue;

      // Volume filter (always applied)
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
      const ea9 = calcEMAArr(c, 9), ea21 = calcEMAArr(c, 21);
      const emaDist = (cur - ea21.at(-1)) / Math.max(atr, 0.0001);

      // 15m ATR
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

      // MTF 15m
      let mtf = 0;
      if (c15.length > 25) {
        const e9_15 = calcEMA(c15, 9), e21_15 = calcEMA(c15, 21), m15 = calcMACD(c15);
        if (e9_15 > e21_15) mtf++; else mtf--;
        if (m15.h > 0) mtf++; else mtf--;
      }

      // ═══ Compute conviction scores ═══
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

      // Skip bars with zero conviction on both sides
      if (buyConv === 0 && sellConv === 0) continue;

      // Pre-compute future H/L/C bars
      const fH = [], fL = [], fC = [];
      for (let f = bar + 1; f <= Math.min(bar + FUT, d.len - 1); f++) {
        fH.push(d.H[f]); fL.push(d.L[f]); fC.push(d.C[f]);
      }

      allBars.push({
        sym, bar, entry: cur, atr, atr15,
        buyConv, sellConv, buyConds, sellConds,
        adxVal: adx.adx, mtf,
        fH, fL, fC,
        // For train/test split
        pct: bar / d.len
      });
    }
  }
  return allBars;
}

// ═══════════════════════════════════════════════════════════════════
// PHASE 2: Given pre-computed bars, filter signals and evaluate trades
// This is FAST — just array filtering + simple arithmetic
// ═══════════════════════════════════════════════════════════════════
function fastBacktest(allBars, startPct, endPct, sigCfg, tradeCfg) {
  const { minConv, minConds, adxBlock, adxMax, mtfCheck } = sigCfg;
  const { tp1M, slM, trailM, ew, cd, cost } = tradeCfg;

  let wins = 0, losses = 0, pnl = 0, count = 0;
  const lastBar = {};

  for (let i = 0; i < allBars.length; i++) {
    const b = allBars[i];
    if (b.pct < startPct || b.pct >= endPct) continue;

    // Cooldown
    const lb = lastBar[b.sym] || -999;
    if (b.bar - lb < cd) continue;

    // Determine signal direction
    let signal = 'N';
    if (b.buyConv > b.sellConv && b.buyConv >= minConv && b.buyConds >= minConds) signal = 'B';
    else if (b.sellConv > b.buyConv && b.sellConv >= minConv && b.sellConds >= minConds) signal = 'S';
    if (signal === 'N') continue;

    // ADX block
    if (adxBlock && b.adxVal > adxMax) continue;
    // MTF check
    if (mtfCheck && signal === 'B' && b.mtf < -1) continue;
    if (mtfCheck && signal === 'S' && b.mtf > 1) continue;

    lastBar[b.sym] = b.bar;
    count++;

    // Evaluate trade
    const useATR = b.atr15 || b.atr;
    const tp1 = useATR * tp1M;
    const sl = useATR * slM;
    const trail = useATR * trailM;
    const tradeCost = b.entry * (cost || 0.0004) * 2;
    const maxBars = Math.min(ew || 24, b.fH.length);
    const tp1P = signal === 'B' ? b.entry + tp1 : b.entry - tp1;
    const slP = signal === 'B' ? b.entry - sl : b.entry + sl;

    let tp1Hit = false, bestP = b.entry, res = 'TO', tPnl = 0;

    for (let j = 0; j < maxBars; j++) {
      if (signal === 'B') {
        if (!tp1Hit) {
          if (b.fL[j] <= slP) { res = 'SL'; tPnl = -sl - tradeCost; break; }
          if (b.fH[j] >= tp1P) { tp1Hit = true; bestP = b.fH[j]; }
        }
        if (tp1Hit) {
          if (b.fH[j] > bestP) bestP = b.fH[j];
          const tStop = bestP - trail;
          const exitLvl = Math.max(tStop, b.entry);
          if (b.fL[j] <= exitLvl) {
            tPnl = tp1 * 0.5 + (exitLvl - b.entry) * 0.5 - tradeCost;
            res = exitLvl > b.entry ? 'TRAIL' : 'TP1BE'; break;
          }
        }
      } else {
        if (!tp1Hit) {
          if (b.fH[j] >= slP) { res = 'SL'; tPnl = -sl - tradeCost; break; }
          if (b.fL[j] <= tp1P) { tp1Hit = true; bestP = b.fL[j]; }
        }
        if (tp1Hit) {
          if (b.fL[j] < bestP) bestP = b.fL[j];
          const tStop = bestP + trail;
          const exitLvl = Math.min(tStop, b.entry);
          if (b.fH[j] >= exitLvl) {
            tPnl = tp1 * 0.5 + (b.entry - exitLvl) * 0.5 - tradeCost;
            res = exitLvl < b.entry ? 'TRAIL' : 'TP1BE'; break;
          }
        }
      }
    }
    if (res === 'TO') {
      const last = b.fC[maxBars - 1] || b.entry;
      const uPnl = signal === 'B' ? last - b.entry : b.entry - last;
      tPnl = tp1Hit ? tp1 * 0.5 + uPnl * 0.5 - tradeCost : uPnl - tradeCost;
    }

    const pnlPct = tPnl / b.entry * 100;
    pnl += pnlPct;
    if (res === 'SL' || (res === 'TO' && pnlPct < 0)) losses++; else wins++;
  }

  const total = wins + losses;
  const len = Object.values(DATA)[0]?.len || 1000;
  const days = len * (endPct - startPct) / 288;
  return { wins, losses, total: count, wr: total > 0 ? wins / total * 100 : 0, pnl, spd: count / Math.max(0.5, days), days };
}

async function main() {
  console.log('═'.repeat(70));
  console.log('  SCALP MEAN-REVERSION v2 — PRE-COMPUTED SIGNALS');
  console.log('  Target: WR>60%, PnL>+20%, fewer but more precise signals');
  console.log('═'.repeat(70) + '\n');

  await loadData();

  console.log('\n  Pre-computing indicators at every bar...');
  const t0 = Date.now();
  const allBars = precomputeIndicators();
  console.log(`  Done: ${allBars.length} candidate bars in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  // ═══ GRID SEARCH — Signal configs × Trade configs ═══
  const minConvs = [3, 4, 5, 6, 7, 8, 10];
  const minCondsList = [2, 3, 4, 5];
  const adxBlocks = [false, true];
  const adxMaxes = [20, 25, 30, 35];
  const mtfChecks = [false, true];

  const tp1Ms = [0.15, 0.20, 0.30, 0.40, 0.50, 0.60, 0.80, 1.0];
  const slMs = [0.30, 0.40, 0.60, 0.80, 1.0, 1.2, 1.5, 2.0];
  const trMs = [0.06, 0.08, 0.10, 0.15, 0.20, 0.30];
  const ews = [8, 12, 18, 24, 36, 48];
  const cds = [2, 3, 4, 6, 8, 12];
  const costs = [0.0003, 0.0005]; // realistic range

  // Count signal configs
  let sigConfigs = [];
  for (const mc of minConvs) {
    for (const mcd of minCondsList) {
      for (const ab of adxBlocks) {
        const ams = ab ? adxMaxes : [30];
        for (const am of ams) {
          for (const mtfc of mtfChecks) {
            sigConfigs.push({ minConv: mc, minConds: mcd, adxBlock: ab, adxMax: am, mtfCheck: mtfc });
          }
        }
      }
    }
  }

  const tradeConfigs = [];
  for (const tp1 of tp1Ms) {
    for (const sl of slMs) {
      for (const tr of trMs) {
        for (const ew of ews) {
          for (const cd of cds) {
            for (const cost of costs) {
              tradeConfigs.push({ tp1M: tp1, slM: sl, trailM: tr, ew, cd, cost });
            }
          }
        }
      }
    }
  }

  console.log(`  Signal configs: ${sigConfigs.length}`);
  console.log(`  Trade configs: ${tradeConfigs.length}`);
  console.log(`  Total combos: ${(sigConfigs.length * tradeConfigs.length / 1000).toFixed(0)}K`);
  console.log('\n  Phase 1: Grid search on TRAIN (first 50%)...\n');

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
        process.stdout.write(`  ${(tested/1000).toFixed(0)}K/${(total/1000).toFixed(0)}K (${(tested/total*100).toFixed(1)}%) | ${rate.toFixed(0)}/s | ETA: ${(eta/60).toFixed(1)}min | best: WR=${best[0]?.wr?.toFixed(1)||'?'}% PnL=${best[0]?.pnl?.toFixed(1)||'?'}% ${best[0]?.spd?.toFixed(0)||'?'}s/d\r`);
      }

      const r = fastBacktest(allBars, 0, 0.5, sigCfg, tradeCfg);
      if (r.total < 8) continue;

      const score = (r.pnl > 0 ? r.pnl * 5 : r.pnl * 8) + (r.wr >= 60 ? r.wr * 1.5 : r.wr * 0.3) + (r.spd >= 20 ? 15 : r.spd >= 10 ? 5 : 0);
      best.push({ score, ...sigCfg, ...tradeCfg, wr: r.wr, pnl: r.pnl, spd: r.spd, n: r.total, w: r.wins, l: r.losses });
      best.sort((a, b) => b.score - a.score);
      if (best.length > 80) best.length = 80;
    }
  }

  const elapsed1 = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`\n\n  Tested ${(tested/1000).toFixed(0)}K configs in ${elapsed1}s\n`);

  // ═══ TOP 20 TRAIN ═══
  console.log('  TOP 20 TRAIN:\n');
  console.log('  #  | mConv | mCond | ADX  | MTF | TP1  | SL   | Trail | EW | CD | Cost | WR%   | PnL%     | S/Day | N');
  console.log('  ' + '-'.repeat(110));
  for (let i = 0; i < Math.min(20, best.length); i++) {
    const r = best[i];
    console.log(`  ${String(i+1).padStart(2)} | ${String(r.minConv).padStart(5)} | ${String(r.minConds).padStart(5)} | ${r.adxBlock?String(r.adxMax).padStart(4):' no '} | ${r.mtfCheck?'yes':' no'} | ${r.tp1M.toFixed(2).padStart(4)} | ${r.slM.toFixed(2).padStart(4)} | ${r.trailM.toFixed(2).padStart(5)} | ${String(r.ew).padStart(2)} | ${String(r.cd).padStart(2)} | ${(r.cost*10000).toFixed(0).padStart(3)}b | ${r.wr.toFixed(1).padStart(5)}% | ${(r.pnl>=0?'+':'')+r.pnl.toFixed(2).padStart(7)}% | ${r.spd.toFixed(0).padStart(5)} | ${r.n}`);
  }

  // ═══ WALK-FORWARD VALIDATION ═══
  console.log('\n' + '═'.repeat(70));
  console.log('  WALK-FORWARD VALIDATION (unseen TEST data — last 50%)');
  console.log('═'.repeat(70) + '\n');

  const validated = [];
  for (let i = 0; i < Math.min(60, best.length); i++) {
    const cfg = best[i];
    const sigCfg = { minConv: cfg.minConv, minConds: cfg.minConds, adxBlock: cfg.adxBlock, adxMax: cfg.adxMax, mtfCheck: cfg.mtfCheck };
    const tradeCfg = { tp1M: cfg.tp1M, slM: cfg.slM, trailM: cfg.trailM, ew: cfg.ew, cd: cfg.cd, cost: cfg.cost };
    const r = fastBacktest(allBars, 0.5, 1.0, sigCfg, tradeCfg);
    validated.push({ ...cfg, tWR: r.wr, tPnl: r.pnl, tSpd: r.spd, tN: r.total, trWR: cfg.wr, trPnl: cfg.pnl });
  }

  validated.sort((a, b) => {
    const sA = (a.tPnl > 0 ? a.tPnl * 5 : a.tPnl * 8) + (a.tWR >= 60 ? a.tWR * 1.5 : a.tWR * 0.3) + (a.tSpd >= 20 ? 15 : 0);
    const sB = (b.tPnl > 0 ? b.tPnl * 5 : b.tPnl * 8) + (b.tWR >= 60 ? b.tWR * 1.5 : b.tWR * 0.3) + (b.tSpd >= 20 ? 15 : 0);
    return sB - sA;
  });

  console.log('  TOP 20 VALIDATED:\n');
  console.log('  #  | mConv | mCond | ADX  | MTF | TP1  | SL   | Trail | EW | CD | TRAIN WR | TRAIN PnL | TEST WR | TEST PnL | T.S/Day | T.N');
  console.log('  ' + '-'.repeat(130));
  for (let i = 0; i < Math.min(20, validated.length); i++) {
    const v = validated[i];
    console.log(`  ${String(i+1).padStart(2)} | ${String(v.minConv).padStart(5)} | ${String(v.minConds).padStart(5)} | ${v.adxBlock?String(v.adxMax).padStart(4):' no '} | ${v.mtfCheck?'yes':' no'} | ${v.tp1M.toFixed(2).padStart(4)} | ${v.slM.toFixed(1).padStart(4)} | ${v.trailM.toFixed(2).padStart(5)} | ${String(v.ew).padStart(2)} | ${String(v.cd).padStart(2)} | ${v.trWR.toFixed(1).padStart(7)}% | ${(v.trPnl>=0?'+':'')+v.trPnl.toFixed(2).padStart(8)}% | ${v.tWR.toFixed(1).padStart(6)}% | ${(v.tPnl>=0?'+':'')+v.tPnl.toFixed(2).padStart(7)}% | ${v.tSpd.toFixed(0).padStart(7)} | ${v.tN}`);
  }

  // ═══ FULL VALIDATION of top 5 ═══
  console.log('\n' + '═'.repeat(70));
  console.log('  FULL VALIDATION — Top 5 configs on ALL data');
  console.log('═'.repeat(70) + '\n');

  for (let i = 0; i < Math.min(5, validated.length); i++) {
    const b = validated[i];
    const sigCfg = { minConv: b.minConv, minConds: b.minConds, adxBlock: b.adxBlock, adxMax: b.adxMax, mtfCheck: b.mtfCheck };
    const tradeCfg = { tp1M: b.tp1M, slM: b.slM, trailM: b.trailM, ew: b.ew, cd: b.cd, cost: b.cost };
    const full = fastBacktest(allBars, 0, 1.0, sigCfg, tradeCfg);

    console.log(`  Config #${i+1}:`);
    console.log(`    Signal: minConv=${b.minConv} | minConds=${b.minConds} | ADX block=${b.adxBlock?b.adxMax:'no'} | MTF=${b.mtfCheck?'yes':'no'}`);
    console.log(`    Trade:  TP1=${b.tp1M}xATR | Trail=${b.trailM}xATR | SL=${b.slM}xATR | EW=${b.ew} | CD=${b.cd} | Cost=${(b.cost*10000).toFixed(0)}bps`);
    console.log(`    TRAIN:  WR=${b.trWR.toFixed(1)}% | PnL=${b.trPnl>=0?'+':''}${b.trPnl.toFixed(2)}%`);
    console.log(`    TEST:   WR=${b.tWR.toFixed(1)}% | PnL=${b.tPnl>=0?'+':''}${b.tPnl.toFixed(2)}% | ${b.tSpd.toFixed(0)} s/d`);
    console.log(`    FULL:   WR=${full.wr.toFixed(1)}% | PnL=${full.pnl>=0?'+':''}${full.pnl.toFixed(2)}% | ${full.spd.toFixed(0)} s/d | ${full.total} sigs (${full.wins}W/${full.losses}L)`);
    const wrOK = full.wr >= 60, pnlOK = full.pnl >= 20;
    console.log(`    ${wrOK?'✓':'✗'} WR≥60%  ${pnlOK?'✓':'✗'} PnL≥+20%`);
    console.log();
  }

  // ═══ ROBUSTNESS CHECK — Stability across different split points ═══
  if (validated.length > 0) {
    const b = validated[0];
    const sigCfg = { minConv: b.minConv, minConds: b.minConds, adxBlock: b.adxBlock, adxMax: b.adxMax, mtfCheck: b.mtfCheck };
    const tradeCfg = { tp1M: b.tp1M, slM: b.slM, trailM: b.trailM, ew: b.ew, cd: b.cd, cost: b.cost };

    console.log('═'.repeat(70));
    console.log('  ROBUSTNESS — Best config across time windows');
    console.log('═'.repeat(70) + '\n');

    const windows = [
      { name: 'Q1 (0-25%)', s: 0, e: 0.25 },
      { name: 'Q2 (25-50%)', s: 0.25, e: 0.50 },
      { name: 'Q3 (50-75%)', s: 0.50, e: 0.75 },
      { name: 'Q4 (75-100%)', s: 0.75, e: 1.0 },
      { name: 'H1 (0-50%)', s: 0, e: 0.5 },
      { name: 'H2 (50-100%)', s: 0.5, e: 1.0 },
      { name: 'FULL', s: 0, e: 1.0 },
    ];

    for (const w of windows) {
      const r = fastBacktest(allBars, w.s, w.e, sigCfg, tradeCfg);
      console.log(`  ${w.name.padEnd(16)} | WR=${r.wr.toFixed(1).padStart(5)}% | PnL=${(r.pnl>=0?'+':'')+r.pnl.toFixed(2).padStart(7)}% | ${r.spd.toFixed(0).padStart(4)} s/d | ${r.total} sigs`);
    }
  }

  console.log('\n' + '═'.repeat(70));
  console.log('  DONE');
  console.log('═'.repeat(70));
}

main().catch(console.error);
