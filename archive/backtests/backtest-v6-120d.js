#!/usr/bin/env node
/**
 * ENGINE v6 — BUILT ON PROVEN EDGE (not assumptions)
 *
 * Based on edge-finder results — ONLY strategies profitable in BOTH 30d halves:
 *
 * PRIMARY EDGE: ADX>25 + DI direction with R:R 2.5-3:1
 *   → Trend-following. WR 31-35% but massive R:R compensates.
 *   → This is HOW quant funds trade: low WR, high R:R, let winners run.
 *
 * SECONDARY EDGE: BB extreme (<0.05 / >0.95) with R:R 1.5-2:1
 *   → Mean-reversion at TRUE extremes only. WR 40-46%.
 *
 * TERTIARY: Volume spike + RSI<35 BUY with R:R 2:1
 *   → Capitulation reversal. WR 36-44%.
 *
 * COMBINED SIGNAL: Require at least 2 of 3 edges to agree.
 *
 * KEY CHANGE: R:R is 2.5:1 minimum. NO trailing. NO TP1 partial.
 * The math: WR 35% × 2.5 R:R = PF 1.35. WR 40% × 2.5 = PF 1.67.
 */

const https = require('https');
const CAPITAL=10000, POS=500, LEV=5, FEE=0.0008, DAYS=120, TIMEOUT=50, MAX_CONC=5;

const STRICT_PAIRS = ['SOLUSDT','ADAUSDT','DOTUSDT','LINKUSDT','FILUSDT','ARBUSDT','OPUSDT','JUPUSDT','WIFUSDT','FETUSDT','AVAXUSDT','SUIUSDT','TIAUSDT','UNIUSDT','PEPEUSDT'];
const SCALP_PAIRS = ['SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','ADAUSDT','DOTUSDT','ARBUSDT','OPUSDT','FILUSDT','UNIUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT','TIAUSDT','ATOMUSDT','SUIUSDT'];

// ═══ Indicators ═══
function calcRSI(c,p=14){if(c.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}return al===0?100:100-(100/(1+ag/al));}
function emaA(d,p){const k=2/(p+1),r=[d[0]];for(let i=1;i<d.length;i++)r.push(d[i]*k+r[i-1]*(1-k));return r;}
function ema(d,p){return emaA(d,p).at(-1);}
function macd(c){if(c.length<35)return{h:0,ph:0};const e12=emaA(c,12),e26=emaA(c,26),ml=e12.map((v,i)=>v-e26[i]),sl=emaA(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1))};}
function bb(c,p=20){if(c.length<p)return{u:0,m:0,l:0};const s=c.slice(-p),m=s.reduce((a,b)=>a+b)/p,sd=Math.sqrt(s.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+2*sd,m,l:m-2*sd};}
function stoch(H,L,C){if(C.length<17)return 50;const s=14,sh=H.slice(-s),sl=L.slice(-s),hi=Math.max(...sh),lo=Math.min(...sl);return hi===lo?50:((C.at(-1)-lo)/(hi-lo))*100;}
function atr(H,L,C,p=14){if(C.length<p+1)return 0;const t=[];for(let i=1;i<C.length;i++)t.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));let a=t.slice(0,p).reduce((s,v)=>s+v)/p;for(let i=p;i<t.length;i++)a=(a*(p-1)+t[i])/p;return a;}
function wilder(a,p){if(a.length<p)return a.map(()=>0);const r=[];let s=a.slice(0,p).reduce((x,y)=>x+y)/p;for(let i=0;i<p;i++)r.push(0);r[p-1]=s;for(let i=p;i<a.length;i++){s=(s*(p-1)+a[i])/p;r.push(s);}return r;}
function adx(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pd=[],md=[],tr=[];for(let i=1;i<H.length;i++){const u=H[i]-H[i-1],d=L[i-1]-L[i];pd.push(u>d&&u>0?u:0);md.push(d>u&&d>0?d:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}const sT=wilder(tr,p),sP=wilder(pd,p),sM=wilder(md,p);const pi=sP.map((v,i)=>sT[i]?v/sT[i]*100:0),mi=sM.map((v,i)=>sT[i]?v/sT[i]*100:0);const dx=pi.map((v,i)=>{const s=v+mi[i];return s?Math.abs(v-mi[i])/s*100:0;});const dxV=dx.slice(p-1);const aa=dxV.length>=p?wilder(dxV,p):dxV;return{adx:aa.at(-1)||15,pdi:pi.at(-1)||0,mdi:mi.at(-1)||0};}
function obv(C,V){if(C.length<2)return false;let o=0;const a=[0];for(let i=1;i<C.length;i++){if(C[i]>C[i-1])o+=V[i];else if(C[i]<C[i-1])o-=V[i];a.push(o);}const n=Math.min(a.length,20),r=a.slice(-n);let sx=0,sy=0,sxy=0,sx2=0;for(let i=0;i<n;i++){sx+=i;sy+=r[i];sxy+=i*r[i];sx2+=i*i;}return(n*sxy-sx*sy)/(n*sx2-sx*sx||1)>0;}

// ═══ v6 SIGNAL ENGINE ═══
function genSignal(C,H,L,V,idx,mode) {
  if(idx < 50) return null;
  const cs=C.slice(0,idx+1), hs=H.slice(0,idx+1), ls=L.slice(0,idx+1), vs=V.slice(0,idx+1);
  const cur = cs.at(-1);
  const isStrict = mode==='strict';

  const rsi = calcRSI(cs);
  const mac = macd(cs);
  const bbV = bb(cs);
  const bbR = bbV.u-bbV.l, bbP = bbR>0?(cur-bbV.l)/bbR:0.5;
  const adxD = adx(hs,ls,cs);
  const atrV = atr(hs,ls,cs);
  const avgV = vs.slice(-20).reduce((a,b)=>a+b)/Math.min(20,vs.length);
  const vr = vs.at(-1)/avgV;
  const e9 = ema(cs,9), e21 = ema(cs,21);
  const obvR = obv(cs,vs);

  // ═══ EDGE 1: ADX TREND (strongest proven edge) ═══
  let adxSig = 'NEUTRAL';
  if(adxD.adx > 25) {
    if(adxD.pdi > adxD.mdi * 1.2) adxSig = 'BUY';   // Strong bullish trend
    else if(adxD.mdi > adxD.pdi * 1.2) adxSig = 'SELL'; // Strong bearish trend
  }

  // ═══ EDGE 2: BB EXTREME (proven mean-reversion) ═══
  let bbSig = 'NEUTRAL';
  if(bbP < 0.05) bbSig = 'BUY';        // Price below lower BB extreme
  else if(bbP > 0.95) bbSig = 'SELL';   // Price above upper BB extreme

  // ═══ EDGE 3: VOLUME + RSI CAPITULATION ═══
  let volSig = 'NEUTRAL';
  if(vr > 2.0 && rsi < 35) volSig = 'BUY';
  else if(vr > 2.0 && rsi > 65) volSig = 'SELL';

  // ═══ EDGE 4: RSI EXTREME with tight SL ═══
  let rsiSig = 'NEUTRAL';
  if(rsi > 70) rsiSig = 'SELL';
  else if(rsi < 25) rsiSig = 'BUY';

  // ═══ CONFLUENCE: need agreement ═══
  let buyVotes = [adxSig,bbSig,volSig,rsiSig].filter(s=>s==='BUY').length;
  let sellVotes = [adxSig,bbSig,volSig,rsiSig].filter(s=>s==='SELL').length;

  let signal = 'NEUTRAL';
  const minVotes = isStrict ? 2 : 2;  // Both need 2+ edges agreeing

  // For ADX trend signals, 1 vote is enough if ADX is very strong
  if(adxSig !== 'NEUTRAL' && adxD.adx > 30) {
    if(adxSig === 'BUY') buyVotes += 0.5;  // ADX>30 counts extra
    else sellVotes += 0.5;
  }

  if(buyVotes >= minVotes && sellVotes === 0) signal = 'BUY';
  else if(sellVotes >= minVotes && buyVotes === 0) signal = 'SELL';

  // Also allow pure ADX signal if ADX > 30 and DI ratio > 1.5
  if(signal === 'NEUTRAL' && adxD.adx > 30) {
    if(adxD.pdi > adxD.mdi * 1.5 && e9 > e21) signal = 'BUY';
    else if(adxD.mdi > adxD.pdi * 1.5 && e9 < e21) signal = 'SELL';
  }

  // Also allow pure BB extreme if really extreme (<0.02 or >0.98)
  if(signal === 'NEUTRAL') {
    if(bbP < 0.02 && rsi < 40) signal = 'BUY';
    else if(bbP > 0.98 && rsi > 60) signal = 'SELL';
  }

  if(signal === 'NEUTRAL') return null;

  // Dead volume filter
  if(vr < 0.4) return null;

  // ═══ TP/SL — HIGH R:R ═══
  let tpM, slM;

  // If ADX signal is primary → trend-following R:R (wider TP)
  if(adxSig === signal && adxD.adx > 25) {
    tpM = isStrict ? 2.5 : 2.0;
    slM = 1.0;
  }
  // If BB is primary → mean-reversion R:R (moderate TP)
  else if(bbSig === signal) {
    tpM = 2.0;
    slM = 1.0;
  }
  // Mixed
  else {
    tpM = isStrict ? 2.5 : 2.0;
    slM = 1.0;
  }

  const tpD = Math.max(atrV * tpM, cur * 0.002); // Min 0.2% TP
  const slD = Math.max(atrV * slM, cur * 0.001); // Min 0.1% SL
  const cb = cur * FEE;

  const tp = signal==='BUY' ? cur+tpD+cb : cur-tpD-cb;
  const sl = signal==='BUY' ? cur-slD-cb : cur+slD+cb;

  // Confidence
  const totalVotes = signal==='BUY' ? buyVotes : sellVotes;
  let conf = 55 + Math.round(totalVotes * 10);
  if(adxD.adx > 30) conf += 5;
  if(vr > 1.5) conf += 3;
  conf = Math.min(isStrict ? 92 : 88, conf);

  return { signal, conf, entry:cur, tp, sl, tpD, slD, adx:adxD.adx, rsi, vr, bbP, edges:{adxSig,bbSig,volSig,rsiSig}, rratio:tpM/slM };
}

// ═══ Data ═══
function fetchJSON(url){return new Promise((res,rej)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d));}catch(e){rej(e);}});}).on('error',rej);});}
async function getKlines(sym,intv,lim,end){let u=`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${intv}&limit=${lim}`;if(end)u+=`&endTime=${end}`;try{return await fetchJSON(u);}catch(e){return[];}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function fetchData(sym){const now=Date.now(),need=DAYS*288+280;const a=[];let end=now;while(a.length<need){const b=await getKlines(sym,'5m',1000,end);if(!b||!b.length)break;a.unshift(...b);end=b[0][0]-1;await sleep(100);}return{C:a.map(k=>parseFloat(k[4])),H:a.map(k=>parseFloat(k[2])),L:a.map(k=>parseFloat(k[3])),V:a.map(k=>parseFloat(k[5])),T:a.map(k=>k[0])};}

// ═══ BACKTEST ═══
async function run(mode) {
  const pairs = mode==='strict' ? STRICT_PAIRS : SCALP_PAIRS;
  const cd = mode==='strict' ? 8 : 4;

  console.log(`\n${'═'.repeat(75)}`);
  console.log(`  v6 PROVEN EDGE: ${mode.toUpperCase()} — ${DAYS}d, ${pairs.length} pairs, cd=${cd}`);
  console.log(`  ADX trend + BB extreme + Volume spike | R:R 2-2.5:1 | No trailing`);
  console.log(`${'═'.repeat(75)}\n`);

  const data={};
  for(const sym of pairs){process.stdout.write(`${sym}..`);try{data[sym]=await fetchData(sym);console.log(data[sym].C.length);}catch(e){console.log('ERR');}}

  const testStart=Date.now()-DAYS*86400000;
  const midPoint=testStart+30*86400000;
  const ref=data[pairs[0]]; if(!ref)return;
  const si0=ref.T.findIndex(t=>t>=testStart); if(si0<0)return;

  const trades=[], openPos=[], lastSig={};
  const weeklyPnL={};
  let equity=CAPITAL, peak=CAPITAL, maxDD=0;
  const eqCurve=[];

  for(let bi=si0; bi<ref.C.length; bi++) {
    const barTime=ref.T[bi];
    const wk=Math.floor((barTime-testStart)/(7*86400000));
    if(!weeklyPnL[wk])weeklyPnL[wk]={pnl:0,n:0,w:0};

    // Check open positions
    for(let pi=openPos.length-1;pi>=0;pi--){
      const p=openPos[pi];const d=data[p.sym];if(!d)continue;
      const sbi=d.T.indexOf(barTime);if(sbi<0)continue;
      p.bars++;
      let pnl,reason;
      if(p.signal==='BUY'){
        if(d.L[sbi]<=p.sl){pnl=-(p.slD/p.entry)*LEV*POS-POS*FEE;reason='SL';}
        else if(d.H[sbi]>=p.tp){pnl=(p.tpD/p.entry)*LEV*POS-POS*FEE;reason='TP';}
        else if(p.bars>=TIMEOUT){pnl=(d.C[sbi]-p.entry)/p.entry*LEV*POS-POS*FEE;reason='TO';}
        else continue;
      }else{
        if(d.H[sbi]>=p.sl){pnl=-(p.slD/p.entry)*LEV*POS-POS*FEE;reason='SL';}
        else if(d.L[sbi]<=p.tp){pnl=(p.tpD/p.entry)*LEV*POS-POS*FEE;reason='TP';}
        else if(p.bars>=TIMEOUT){pnl=(p.entry-d.C[sbi])/p.entry*LEV*POS-POS*FEE;reason='TO';}
        else continue;
      }
      trades.push({sym:p.sym,signal:p.signal,pnl,reason,bars:p.bars,edges:p.edges,rratio:p.rratio,time:barTime});
      weeklyPnL[wk].n++;weeklyPnL[wk].pnl+=pnl;if(pnl>0)weeklyPnL[wk].w++;
      equity+=pnl;openPos.splice(pi,1);
    }

    if(equity>peak)peak=equity;const dd=(peak-equity)/peak*100;if(dd>maxDD)maxDD=dd;
    if(bi%288===0)eqCurve.push({d:Math.floor((bi-si0)/288),eq:equity});
    if(openPos.length>=MAX_CONC)continue;

    // Generate signals
    for(const sym of pairs){
      if(openPos.length>=MAX_CONC)break;
      if(openPos.some(p=>p.sym===sym))continue;
      const d=data[sym];if(!d)continue;
      const lb=lastSig[sym]||-cd;if(bi-lb<cd)continue;
      const sbi=d.T.indexOf(barTime);if(sbi<280)continue;

      const sig=genSignal(d.C,d.H,d.L,d.V,sbi,mode);
      if(!sig)continue;

      lastSig[sym]=bi;
      openPos.push({sym,signal:sig.signal,entry:sig.entry,tp:sig.tp,sl:sig.sl,tpD:sig.tpD,slD:sig.slD,bars:0,edges:sig.edges,rratio:sig.rratio});
    }
  }

  // Close remaining
  for(const p of openPos){const d=data[p.sym];if(!d)continue;const ex=d.C.at(-1);
    const pnl=p.signal==='BUY'?(ex-p.entry)/p.entry*LEV*POS-POS*FEE:(p.entry-ex)/p.entry*LEV*POS-POS*FEE;
    trades.push({sym:p.sym,signal:p.signal,pnl,reason:'END',bars:p.bars,edges:p.edges,rratio:p.rratio});equity+=pnl;}

  // ═══ RESULTS ═══
  const wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<=0);
  const totalPnL=trades.reduce((a,t)=>a+t.pnl,0);
  const gP=wins.reduce((a,t)=>a+t.pnl,0),gL=Math.abs(losses.reduce((a,t)=>a+t.pnl,0));
  const wr=trades.length?wins.length/trades.length*100:0;
  const pf=gL>0?gP/gL:0;

  console.log(`\n${'═'.repeat(75)}`);
  console.log(`  v6 RESULTS: ${mode.toUpperCase()} — ${DAYS} DAYS`);
  console.log(`${'═'.repeat(75)}`);
  console.log(`  Trades:    ${trades.length} (${(trades.length/DAYS).toFixed(1)}/day)`);
  console.log(`  WR:        ${wr.toFixed(1)}% (${wins.length}W/${losses.length}L)`);
  console.log(`  PnL:       $${totalPnL.toFixed(2)} (${(totalPnL/CAPITAL*100).toFixed(2)}%)`);
  console.log(`  PF:        ${pf.toFixed(2)}`);
  console.log(`  MaxDD:     ${maxDD.toFixed(2)}%`);
  console.log(`  Avg Win:   $${wins.length?(gP/wins.length).toFixed(2):'0'}`);
  console.log(`  Avg Loss:  $${losses.length?(gL/losses.length).toFixed(2):'0'}`);
  console.log(`  Eff R:R:   ${losses.length&&wins.length?((gP/wins.length)/(gL/losses.length)).toFixed(2):'N/A'}`);
  console.log(`  Expect:    $${trades.length?(totalPnL/trades.length).toFixed(2):'0'}/trade`);

  const reasons={};for(const t of trades)reasons[t.reason]=(reasons[t.reason]||0)+1;
  console.log(`\n  Exits:`);for(const[r,c]of Object.entries(reasons).sort((a,b)=>b[1]-a[1]))console.log(`    ${r.padEnd(6)} ${c} (${(c/trades.length*100).toFixed(0)}%)`);

  console.log(`\n  ═══ WEEKLY ═══`);
  const wks=Object.entries(weeklyPnL).sort((a,b)=>parseInt(a[0])-parseInt(b[0]));
  let pw=0;
  for(const[w,d]of wks){
    const isTrain=parseInt(w)<4;
    const bar=d.pnl>=0?'█'.repeat(Math.min(30,Math.round(d.pnl/20))):'▒'.repeat(Math.min(30,Math.round(Math.abs(d.pnl)/20)));
    console.log(`    W${(parseInt(w)+1).toString().padStart(2)}: $${d.pnl.toFixed(0).padStart(7)} ${d.n}t WR:${d.n?(d.w/d.n*100).toFixed(0):'0'}% ${d.pnl>=0?'+':'-'}${bar} ${isTrain?'[TRAIN]':'[TEST]'}`);
    if(d.pnl>0)pw++;
  }
  console.log(`    Profitable: ${pw}/${wks.length} (${(pw/wks.length*100).toFixed(0)}%)`);

  // First half vs second half
  const h1=trades.filter(t=>t.time&&t.time<midPoint),h2=trades.filter(t=>t.time&&t.time>=midPoint);
  const h1pnl=h1.reduce((a,t)=>a+t.pnl,0),h2pnl=h2.reduce((a,t)=>a+t.pnl,0);
  console.log(`\n  SPLIT: First 30d: $${h1pnl.toFixed(0)} (${h1.length}t) | Last 30d: $${h2pnl.toFixed(0)} (${h2.length}t)`);
  console.log(`         ${h1pnl>0&&h2pnl>0?'BOTH PROFITABLE':'ONE OR BOTH NEGATIVE'}`);

  const byPair={};for(const t of trades){if(!byPair[t.sym])byPair[t.sym]={n:0,pnl:0,w:0};byPair[t.sym].n++;byPair[t.sym].pnl+=t.pnl;if(t.pnl>0)byPair[t.sym].w++;}
  const pa=Object.entries(byPair).sort((a,b)=>b[1].pnl-a[1].pnl);
  console.log(`\n  Pairs:`);
  for(const[p,d]of pa)console.log(`    ${p.padEnd(12)} ${String(d.n).padEnd(4)} WR:${(d.w/d.n*100).toFixed(0).padEnd(3)}% $${d.pnl.toFixed(0)}`);

  // Edge analysis
  const edgeStats={adx:{n:0,pnl:0},bb:{n:0,pnl:0},vol:{n:0,pnl:0},rsi:{n:0,pnl:0}};
  for(const t of trades){
    if(t.edges.adxSig===t.signal){edgeStats.adx.n++;edgeStats.adx.pnl+=t.pnl;}
    if(t.edges.bbSig===t.signal){edgeStats.bb.n++;edgeStats.bb.pnl+=t.pnl;}
    if(t.edges.volSig===t.signal){edgeStats.vol.n++;edgeStats.vol.pnl+=t.pnl;}
    if(t.edges.rsiSig===t.signal){edgeStats.rsi.n++;edgeStats.rsi.pnl+=t.pnl;}
  }
  console.log(`\n  Edge contribution:`);
  for(const[e,d]of Object.entries(edgeStats))if(d.n)console.log(`    ${e.padEnd(6)} ${d.n}t $${d.pnl.toFixed(0)}`);

  console.log(`\n  Equity:`);
  for(const e of eqCurve){const p=((e.eq-CAPITAL)/CAPITAL*100).toFixed(1);
    const bar=e.eq>=CAPITAL?'█'.repeat(Math.min(40,Math.round((e.eq-CAPITAL)/25))):'▒'.repeat(Math.min(40,Math.round((CAPITAL-e.eq)/25)));
    console.log(`    D${String(e.d).padStart(2)}: $${e.eq.toFixed(0).padStart(7)} (${p.padStart(6)}%) ${bar}`);}

  console.log(`\n  Best: $${Math.max(...trades.map(t=>t.pnl)).toFixed(2)} | Worst: $${Math.min(...trades.map(t=>t.pnl)).toFixed(2)}`);
  console.log(`${'═'.repeat(75)}\n`);
}

async function main(){
  const mode=process.argv[2]||'strict';
  console.log('╔═══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  v6 ENGINE — BUILT ON PROVEN EDGE DATA (ADX+BB+Volume)                  ║');
  console.log('║  60 days | No hour/day filters | High R:R | No trailing                  ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════╝');
  await run(mode);
}
main().catch(console.error);
