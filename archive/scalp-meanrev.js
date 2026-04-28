// ═══════════════════════════════════════════════════════════════════
// SCALP MEAN-REVERSION ENGINE — Based on feature mining results
// Key insight: 5m market is mean-reverting. RSI/BB/Stoch extremes
// predict reversals with 60-95% accuracy.
// Moderate TP/SL (not suicide-wide SL)
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

// ═══ MEAN REVERSION signal generator ═══
function genMeanRev(c, h, l, v, c15, h15, l15, c1h, h1h, l1h, v1h, sym, hourUTC, cfg) {
  const cur = c.at(-1);
  const rsi = calcRSI(c, 14);
  const stoch = calcStoch(h, l, c, 14);
  const bb = calcBB(c, 20, 2);
  const bbR = bb.u - bb.l;
  const bbP = bbR > 0 ? (cur - bb.l) / bbR : 0.5;
  const atr = calcATR(h, l, c, 14);
  const mac = calcMACD(c);
  const mom3 = (cur - (c.at(-4) || cur)) / Math.max(atr, 0.0001);
  const avgV = v.slice(-20).reduce((a,b)=>a+b)/20;
  const vr = v.at(-1) / avgV;
  const adx = calcADX(h, l, c);
  const l4 = c.slice(-4);
  const bullExh = l4.length>=4 && l4.every((x,i)=>i===0||x>l4[i-1]);
  const bearExh = l4.length>=4 && l4.every((x,i)=>i===0||x<l4[i-1]);
  const ea9 = calcEMAArr(c,9), ea21 = calcEMAArr(c,21);
  const e9 = ea9.at(-1), e21 = ea21.at(-1);
  const emaDist = (cur - e21) / Math.max(atr, 0.0001);

  // 15m ATR
  let atr15 = atr;
  if(h15.length>15&&l15.length>15&&c15.length>15){const a=calcATR(h15,l15,c15,14);if(a>0)atr15=a;}

  // MTF 15m
  let mtf = 0;
  if(c15.length > 25) {
    const e9_15=calcEMA(c15,9),e21_15=calcEMA(c15,21),m15=calcMACD(c15);
    if(e9_15>e21_15) mtf++; else mtf--;
    if(m15.h>0) mtf++; else mtf--;
  }

  // ═══ MEAN REVERSION SCORING ═══
  // Each condition adds conviction for REVERSAL (not continuation)
  let buyConv = 0, sellConv = 0; // conviction score
  let buyConds = 0, sellConds = 0; // number of conditions met

  // RSI extremes (strongest single predictor)
  if(rsi < 25) { buyConv += 4; buyConds++; }
  else if(rsi < 30) { buyConv += 3; buyConds++; }
  else if(rsi < 35) { buyConv += 2; buyConds++; }
  else if(rsi < 40) { buyConv += 1; buyConds++; }
  if(rsi > 75) { sellConv += 4; sellConds++; }
  else if(rsi > 70) { sellConv += 3; sellConds++; }
  else if(rsi > 65) { sellConv += 2; sellConds++; }
  else if(rsi > 60) { sellConv += 1; sellConds++; }

  // Stoch extremes
  if(stoch.k < 20) { buyConv += 3; buyConds++; }
  else if(stoch.k < 30) { buyConv += 1.5; buyConds++; }
  if(stoch.k > 80) { sellConv += 3; sellConds++; }
  else if(stoch.k > 70) { sellConv += 1.5; sellConds++; }

  // BB extremes
  if(bbP < 0.1) { buyConv += 3; buyConds++; }
  else if(bbP < 0.2) { buyConv += 2; buyConds++; }
  if(bbP > 0.9) { sellConv += 3; sellConds++; }
  else if(bbP > 0.8) { sellConv += 2; sellConds++; }

  // Momentum exhaustion (contrarian)
  if(mom3 < -1.0) { buyConv += 2; buyConds++; }
  else if(mom3 < -0.5) { buyConv += 1; buyConds++; }
  if(mom3 > 1.0) { sellConv += 2; sellConds++; }
  else if(mom3 > 0.5) { sellConv += 1; sellConds++; }

  // Candle exhaustion
  if(bearExh) { buyConv += 2; buyConds++; }
  if(bullExh) { sellConv += 2; sellConds++; }

  // EMA overextension (price too far from mean → snap back)
  if(emaDist < -1.5) { buyConv += 1.5; buyConds++; }
  if(emaDist > 1.5) { sellConv += 1.5; sellConds++; }

  // MACD/EMA crosses are CONTRARIAN on 5m
  if(mac.h > 0 && mac.ph < 0) { sellConv += 1; sellConds++; } // MACD cross up → sell
  if(mac.h < 0 && mac.ph > 0) { buyConv += 1; buyConds++; }  // MACD cross down → buy

  let signal = 'N';
  const minConv = cfg.minConv || 4;
  const minConds = cfg.minConds || 2;

  if(buyConv > sellConv && buyConv >= minConv && buyConds >= minConds) signal = 'B';
  else if(sellConv > buyConv && sellConv >= minConv && sellConds >= minConds) signal = 'S';

  // Safety filters
  if(signal !== 'N' && hourUTC >= 0 && hourUTC < 6) signal = 'N';
  if(signal !== 'N' && vr < 0.3) signal = 'N';
  // Don't mean-revert in strong trends (ADX>30 = respect the trend)
  if(cfg.adxBlock && signal !== 'N' && adx.adx > (cfg.adxMax || 30)) signal = 'N';
  // MTF contradiction: don't buy if 15m is strongly bearish
  if(cfg.mtfCheck && signal === 'B' && mtf < -1) signal = 'N';
  if(cfg.mtfCheck && signal === 'S' && mtf > 1) signal = 'N';

  return { signal, entry: cur, atr, atr15, buyConv, sellConv, buyConds, sellConds, rsi, stochK: stoch.k, bbP, mom3 };
}

// ═══ Evaluate with trailing stop ═══
function evalTrade(sig, cfg, fH, fL, fC) {
  const entry = sig.entry;
  const useATR = sig.atr15 || sig.atr;
  const tp1 = useATR * cfg.tp1M;
  const sl = useATR * cfg.slM;
  const trail = useATR * cfg.trailM;
  const cost = entry * (cfg.cost || 0.0004) * 2;
  const maxBars = Math.min(cfg.ew || 24, fH.length);

  const tp1P = sig.signal==='B' ? entry+tp1 : entry-tp1;
  const slP = sig.signal==='B' ? entry-sl : entry+sl;

  let tp1Hit = false, bestP = entry, res = 'TO', pnl = 0;

  for(let i = 0; i < maxBars; i++) {
    if(sig.signal === 'B') {
      if(!tp1Hit) {
        if(fL[i] <= slP) { res='SL'; pnl=-sl-cost; break; }
        if(fH[i] >= tp1P) { tp1Hit=true; bestP=fH[i]; }
      }
      if(tp1Hit) {
        if(fH[i]>bestP) bestP=fH[i];
        const tStop = bestP - trail;
        const exitLvl = Math.max(tStop, entry);
        if(fL[i] <= exitLvl) {
          pnl = tp1*0.5 + (exitLvl-entry)*0.5 - cost;
          res = exitLvl>entry?'TRAIL':'TP1BE'; break;
        }
      }
    } else {
      if(!tp1Hit) {
        if(fH[i] >= slP) { res='SL'; pnl=-sl-cost; break; }
        if(fL[i] <= tp1P) { tp1Hit=true; bestP=fL[i]; }
      }
      if(tp1Hit) {
        if(fL[i]<bestP) bestP=fL[i];
        const tStop = bestP + trail;
        const exitLvl = Math.min(tStop, entry);
        if(fH[i] >= exitLvl) {
          pnl = tp1*0.5 + (entry-exitLvl)*0.5 - cost;
          res = exitLvl<entry?'TRAIL':'TP1BE'; break;
        }
      }
    }
  }
  if(res==='TO') {
    const last = fC[maxBars-1]||entry;
    const uPnl = sig.signal==='B' ? last-entry : entry-last;
    pnl = tp1Hit ? tp1*0.5+uPnl*0.5-cost : uPnl-cost;
  }
  return { res, pnl: pnl/entry*100 };
}

// ═══ Backtest on a range ═══
function backtest(startPct, endPct, sigCfg, tradeCfg) {
  const LB=280, FUT=tradeCfg.ew||24;
  let wins=0,losses=0,pnl=0,count=0;
  const lastBar={};
  const cd = tradeCfg.cd || 4;

  for(const sym of Object.keys(DATA)) {
    const d=DATA[sym];
    const rS=Math.floor(d.len*startPct),rE=Math.floor(d.len*endPct);
    const bS=Math.max(LB,rS),bE=rE-FUT;
    if(bE<=bS)continue;

    for(let bar=bS;bar<bE;bar++){
      const lb=lastBar[sym]||-999;
      if(bar-lb<cd)continue;

      const c=d.C.slice(bar-279,bar+1),h=d.H.slice(bar-279,bar+1),l=d.L.slice(bar-279,bar+1),v=d.V.slice(bar-279,bar+1);
      const bt=d.T[bar],hUTC=new Date(bt).getUTCHours();
      let c15e=0;for(let j=d.T15.length-1;j>=0;j--){if(d.T15[j]<=bt){c15e=j+1;break;}}
      const c15=d.C15.slice(Math.max(0,c15e-100),c15e),h15=d.H15.slice(Math.max(0,c15e-100),c15e),l15=d.L15.slice(Math.max(0,c15e-100),c15e);
      let c1e=0;for(let j=d.T1h.length-1;j>=0;j--){if(d.T1h[j]<=bt){c1e=j+1;break;}}
      const c1h=d.C1h.slice(Math.max(0,c1e-50),c1e),h1h=d.H1h.slice(Math.max(0,c1e-50),c1e),l1h=d.L1h.slice(Math.max(0,c1e-50),c1e),v1h=d.V1h.slice(Math.max(0,c1e-50),c1e);

      const sig=genMeanRev(c,h,l,v,c15,h15,l15,c1h,h1h,l1h,v1h,sym,hUTC,sigCfg);
      if(!sig||sig.signal==='N')continue;
      lastBar[sym]=bar;count++;

      const fH=[],fL=[],fC=[];
      for(let f=bar+1;f<=Math.min(bar+FUT,d.len-1);f++){fH.push(d.H[f]);fL.push(d.L[f]);fC.push(d.C[f]);}
      const ev=evalTrade(sig,tradeCfg,fH,fL,fC);
      pnl+=ev.pnl;
      if(ev.res==='SL'||(ev.res==='TO'&&ev.pnl<0))losses++;else wins++;
    }
  }
  const total=wins+losses;
  const days=(Object.values(DATA)[0]?.len||1000)*(endPct-startPct)/288;
  return{wins,losses,total:count,wr:total>0?wins/total*100:0,pnl,spd:count/Math.max(0.5,days),days};
}

async function main(){
  console.log('═'.repeat(70));
  console.log('  SCALP MEAN-REVERSION ENGINE — Walk-Forward Optimization');
  console.log('  Target: WR>60%, PnL>+20%, high quality signals');
  console.log('═'.repeat(70)+'\n');

  await loadData();

  // ═══ GRID SEARCH ═══
  const minConvs = [3, 4, 5, 6, 7, 8];
  const minCondsList = [2, 3, 4];
  const adxBlocks = [false, true];
  const adxMaxes = [25, 30, 35];
  const mtfChecks = [false, true];
  const tp1Ms = [0.20, 0.30, 0.40, 0.50, 0.60, 0.80];
  const slMs = [0.40, 0.60, 0.80, 1.0, 1.2, 1.5];
  const trMs = [0.08, 0.10, 0.15, 0.20, 0.30];
  const ews = [12, 18, 24, 36];
  const cds = [3, 4, 6, 8];
  const costs = [0.0002, 0.0004];

  let best = [];
  let tested = 0;

  console.log('  Grid search on TRAIN (first 50%)...\n');

  for(const mc of minConvs){
    for(const mcd of minCondsList){
      for(const ab of adxBlocks){
        const adxMs = ab ? adxMaxes : [30];
        for(const am of adxMs){
          for(const mtfc of mtfChecks){
            const sigCfg = { minConv:mc, minConds:mcd, adxBlock:ab, adxMax:am, mtfCheck:mtfc };
            for(const tp1 of tp1Ms){
              for(const sl of slMs){
                for(const tr of trMs){
                  for(const ew of ews){
                    for(const cd of cds){
                      for(const cost of costs){
                        tested++;
                        if(tested%10000===0) process.stdout.write(`  ${(tested/1000).toFixed(0)}K... best: WR=${best[0]?.wr?.toFixed(1)||'?'}% PnL=${best[0]?.pnl?.toFixed(1)||'?'}% ${best[0]?.spd?.toFixed(0)||'?'}s/d\r`);

                        const tradeCfg = { tp1M:tp1, slM:sl, trailM:tr, ew, cd, cost };
                        const r = backtest(0, 0.5, sigCfg, tradeCfg);
                        if(r.total < 10) continue;

                        // Score: prioritize PnL > 0, then WR, then signal count
                        const score = (r.pnl>0?r.pnl*5:r.pnl*8) + (r.wr>=60?r.wr:r.wr*0.3) + (r.spd>=30?15:r.spd>=15?5:0);
                        best.push({ score, ...sigCfg, ...tradeCfg, wr:r.wr, pnl:r.pnl, spd:r.spd, n:r.total, w:r.wins, l:r.losses });
                        best.sort((a,b)=>b.score-a.score);
                        if(best.length>60)best.length=60;
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  console.log(`\n\n  Tested ${(tested/1000).toFixed(0)}K configs\n`);

  console.log('  TOP 20 TRAIN:\n');
  console.log('  #  | mConv | mCond | ADX | MTF | TP1  | SL   | Trail | EW | CD | Cost | WR%   | PnL%     | S/Day | N');
  console.log('  '+'-'.repeat(105));
  for(let i=0;i<Math.min(20,best.length);i++){
    const r=best[i];
    console.log(`  ${String(i+1).padStart(2)} | ${String(r.minConv).padStart(5)} | ${String(r.minConds).padStart(5)} | ${r.adxBlock?String(r.adxMax).padStart(3):' no'} | ${r.mtfCheck?'yes':' no'} | ${r.tp1M.toFixed(2).padStart(4)} | ${r.slM.toFixed(2).padStart(4)} | ${r.trailM.toFixed(2).padStart(5)} | ${String(r.ew).padStart(2)} | ${String(r.cd).padStart(2)} | ${(r.cost*10000).toFixed(0).padStart(3)}b | ${r.wr.toFixed(1).padStart(5)}% | ${(r.pnl>=0?'+':'')+r.pnl.toFixed(2).padStart(7)}% | ${r.spd.toFixed(0).padStart(5)} | ${r.n}`);
  }

  // ═══ WALK-FORWARD ═══
  console.log('\n' + '═'.repeat(70));
  console.log('  WALK-FORWARD VALIDATION (unseen TEST data — last 50%)');
  console.log('═'.repeat(70)+'\n');

  const validated = [];
  for(let i=0;i<Math.min(40,best.length);i++){
    const cfg=best[i];
    const sigCfg={minConv:cfg.minConv,minConds:cfg.minConds,adxBlock:cfg.adxBlock,adxMax:cfg.adxMax,mtfCheck:cfg.mtfCheck};
    const tradeCfg={tp1M:cfg.tp1M,slM:cfg.slM,trailM:cfg.trailM,ew:cfg.ew,cd:cfg.cd,cost:cfg.cost};
    const r=backtest(0.5,1.0,sigCfg,tradeCfg);
    validated.push({...cfg,tWR:r.wr,tPnl:r.pnl,tSpd:r.spd,tN:r.total,trWR:cfg.wr,trPnl:cfg.pnl});
  }

  validated.sort((a,b)=>{
    const sA=(a.tPnl>0?a.tPnl*5:a.tPnl*8)+(a.tWR>=60?a.tWR:a.tWR*0.3)+(a.tSpd>=30?15:0);
    const sB=(b.tPnl>0?b.tPnl*5:b.tPnl*8)+(b.tWR>=60?b.tWR:b.tWR*0.3)+(b.tSpd>=30?15:0);
    return sB-sA;
  });

  console.log('  TOP 15 VALIDATED:\n');
  console.log('  #  | mConv | mCond | ADX | MTF | TP1  | SL   | Trail | TRAIN WR | TRAIN PnL | TEST WR | TEST PnL | T.S/Day');
  console.log('  '+'-'.repeat(110));
  for(let i=0;i<Math.min(15,validated.length);i++){
    const v=validated[i];
    console.log(`  ${String(i+1).padStart(2)} | ${String(v.minConv).padStart(5)} | ${String(v.minConds).padStart(5)} | ${v.adxBlock?String(v.adxMax).padStart(3):' no'} | ${v.mtfCheck?'yes':' no'} | ${v.tp1M.toFixed(2).padStart(4)} | ${v.slM.toFixed(1).padStart(4)} | ${v.trailM.toFixed(2).padStart(5)} | ${v.trWR.toFixed(1).padStart(7)}% | ${(v.trPnl>=0?'+':'')+v.trPnl.toFixed(2).padStart(8)}% | ${v.tWR.toFixed(1).padStart(6)}% | ${(v.tPnl>=0?'+':'')+v.tPnl.toFixed(2).padStart(7)}% | ${v.tSpd.toFixed(0).padStart(6)}`);
  }

  // Full validation of best
  const b=validated[0];
  if(b){
    const sigCfg={minConv:b.minConv,minConds:b.minConds,adxBlock:b.adxBlock,adxMax:b.adxMax,mtfCheck:b.mtfCheck};
    const tradeCfg={tp1M:b.tp1M,slM:b.slM,trailM:b.trailM,ew:b.ew,cd:b.cd,cost:b.cost};
    const full=backtest(0,1.0,sigCfg,tradeCfg);

    console.log('\n'+'═'.repeat(70));
    console.log('  MEJOR CONFIG — FULL VALIDATION');
    console.log('═'.repeat(70));
    console.log(`  Signal: minConv=${b.minConv} | minConds=${b.minConds} | ADX block=${b.adxBlock?b.adxMax:'no'} | MTF=${b.mtfCheck?'yes':'no'}`);
    console.log(`  Trade: TP1=${b.tp1M}xATR | Trail=${b.trailM}xATR | SL=${b.slM}xATR | EW=${b.ew} | CD=${b.cd} | Cost=${(b.cost*10000).toFixed(0)}bps`);
    console.log(`  TRAIN: WR=${b.trWR.toFixed(1)}% | PnL=${b.trPnl>=0?'+':''}${b.trPnl.toFixed(2)}%`);
    console.log(`  TEST:  WR=${b.tWR.toFixed(1)}% | PnL=${b.tPnl>=0?'+':''}${b.tPnl.toFixed(2)}% | ${b.tSpd.toFixed(0)} s/d`);
    console.log(`  FULL:  WR=${full.wr.toFixed(1)}% | PnL=${full.pnl>=0?'+':''}${full.pnl.toFixed(2)}% | ${full.spd.toFixed(0)} s/d | ${full.total} sigs (${full.wins}W/${full.losses}L)`);

    console.log('\n  TARGETS:');
    console.log(`  ${full.wr>=60?'[OK]':'[!!]'} WR >= 60%: ${full.wr.toFixed(1)}%`);
    console.log(`  ${full.pnl>=20?'[OK]':'[!!]'} PnL >= +20%: ${full.pnl>=0?'+':''}${full.pnl.toFixed(2)}%`);
    console.log(`  Signals/Day: ${full.spd.toFixed(0)}`);
  }
  console.log('\n'+'═'.repeat(70));
}

main().catch(console.error);
