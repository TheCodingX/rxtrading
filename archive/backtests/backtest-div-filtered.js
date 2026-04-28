// DIV_SNIPER + SCALP FILTERS — Divergence signals filtered by scalp engine gates
// Downloads 120d of BTC/ETH/SOL 5m+1h+15m, detects RSI divergences, applies scalp filters,
// runs 9-combo mini-grid, walk-forward, multi-pair, compound.
//
// AUDIT FIXES APPLIED:
//   FIX 1 (L1): HTF look-ahead — timestamp-based 1h filtering
//   FIX 2 (L2): MTF look-ahead — timestamp-based 15m filtering
//   FIX 3 (S2): Walk-forward genuine — grid on IS only, fixed params on OOS
//   FIX 4 (C1): Dynamic capital tracking
//   FIX 5 (C2): Max simultaneous positions (3 total, 2 same direction)
//   FIX 6 (F1): Fill rate — skip trades where entry bar range < ATR*0.3
//   FIX 7: Fees VIP 0 — taker 0.05%, slippage 0.03%
//   FIX 8: Timeout trades closed at market (bar 288 close, taker+slip)
//   FIX 9: SL/TP same bar — SL wins (already conservative, PASS)
const https = require('https');

function fetchJSON(url){return new Promise((ok,no)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{ok(JSON.parse(d))}catch(e){no(e)}});}).on('error',no)});}

async function getKlines(sym,tf,days){
  const ms=days*86400000,now=Date.now(),lim=1500,intMs={'5m':300000,'15m':900000,'1h':3600000}[tf];
  let all=[],end=now;
  while(all.length<ms/intMs){
    const url=`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=${lim}&endTime=${end}`;
    const k=await fetchJSON(url);if(!k.length)break;
    all=k.concat(all);end=k[0][0]-1;
    if(all[0][0]<=now-ms)break;await new Promise(r=>setTimeout(r,100));
  }
  return all.filter(k=>k[0]>=now-ms);
}

// ── Indicators ──
function emaArr(C,p){const r=new Array(C.length).fill(C[0]||0);if(C.length<p)return r;const m=2/(p+1);let v=C.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=0;i<p;i++)r[i]=v;for(let i=p;i<C.length;i++){v=C[i]*m+v*(1-m);r[i]=v;}return r;}
function rsiArr(C,p=14){const r=new Array(C.length).fill(50);if(C.length<p+1)return r;let g=0,l=0;for(let i=1;i<=p;i++){const d=C[i]-C[i-1];d>0?g+=d:l+=Math.abs(d);}let ag=g/p,al=l/p;r[p]=al===0?100:100-100/(1+ag/al);for(let i=p+1;i<C.length;i++){const d=C[i]-C[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;}
function atrArr(H,L,C,p=14){const r=new Array(C.length).fill(0);if(C.length<p+1)return r;const tr=i=>Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1]));let s=0;for(let i=1;i<=p;i++)s+=tr(i);let a=s/p;r[p]=a;for(let i=p+1;i<C.length;i++){a=(a*(p-1)+tr(i))/p;r[i]=a;}return r;}
function macdAt(C){if(C.length<26)return{h:0,ph:0};const e12=emaArr(C,12),e26=emaArr(C,26);const ml=e12.map((v,i)=>v-e26[i]);const sig=emaArr(ml,9);const h=ml.at(-1)-sig.at(-1);const ph=ml.at(-2)-sig.at(-2);return{h,ph};}
function stochAt(H,L,C,p=7){if(C.length<p)return{k:50,d:50};const hh=Math.max(...H.slice(-p)),ll=Math.min(...L.slice(-p));const k=hh===ll?50:(C.at(-1)-ll)/(hh-ll)*100;return{k,d:k};}
function bbAt(C,p=10,m=1.8){if(C.length<p)return{pos:0.5};const s=C.slice(-p),avg=s.reduce((a,b)=>a+b)/p;const std=Math.sqrt(s.reduce((a,b)=>a+(b-avg)**2,0)/p);const u=avg+m*std,l=avg-m*std;return{pos:u===l?0.5:(C.at(-1)-l)/(u-l)};}
function vwapAt(kl){if(!kl||kl.length<2)return null;let cumPV=0,cumV=0;for(const k of kl){const tp=(+k[2]+ +k[3]+ +k[4])/3;const v=+k[5];cumPV+=tp*v;cumV+=v;}return cumV>0?cumPV/cumV:null;}
function kcPos(H,L,C,p=20,ap=14,m=2){if(C.length<p)return 0.5;const mid=C.slice(-p).reduce((a,b)=>a+b)/p;const atr=atrArr(H,L,C,ap);const a=atr.at(-1);const u=mid+m*a,l=mid-m*a;return u===l?0.5:(C.at(-1)-l)/(u-l);}
function mfiAt(H,L,C,V,p=7){if(C.length<p+1)return 50;let posF=0,negF=0;for(let i=C.length-p;i<C.length;i++){const tp=(H[i]+L[i]+C[i])/3;const tpP=(H[i-1]+L[i-1]+C[i-1])/3;const mf=tp*V[i];tp>tpP?posF+=mf:negF+=mf;}return negF===0?100:100-100/(1+posF/negF);}
function psarTrend(H,L,C){if(C.length<3)return'BUY';let bull=true,sar=L[0],ep=H[0],af=0.02;for(let i=1;i<C.length;i++){let ns=sar+af*(ep-sar);if(bull){ns=Math.min(ns,L[i-1],i>1?L[i-2]:L[i-1]);if(L[i]<ns){bull=false;sar=ep;ep=L[i];af=0.02;continue;}if(H[i]>ep){ep=H[i];af=Math.min(af+0.02,0.2);}sar=ns;}else{ns=Math.max(ns,H[i-1],i>1?H[i-2]:H[i-1]);if(H[i]>ns){bull=true;sar=ep;ep=H[i];af=0.02;continue;}if(L[i]<ep){ep=L[i];af=Math.min(af+0.02,0.2);}sar=ns;}}return bull?'BUY':'SELL';}
function adxCalc(H,L,C,p=14){if(C.length<p*2)return{adx:0,pdi:0,mdi:0};let atr=0,pdm=0,mdm=0;for(let i=1;i<=p;i++){atr+=Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1]));const up=H[i]-H[i-1],dn=L[i-1]-L[i];pdm+=(up>dn&&up>0)?up:0;mdm+=(dn>up&&dn>0)?dn:0;}for(let i=p+1;i<C.length;i++){const tr=Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1]));atr=(atr*(p-1)+tr)/p;const up=H[i]-H[i-1],dn=L[i-1]-L[i];pdm=(pdm*(p-1)+((up>dn&&up>0)?up:0))/p;mdm=(mdm*(p-1)+((dn>up&&dn>0)?dn:0))/p;}const pdi=atr?pdm/atr*100:0,mdi=atr?mdm/atr*100:0;const dx=pdi+mdi>0?Math.abs(pdi-mdi)/(pdi+mdi)*100:0;return{adx:dx,pdi,mdi};}
function obvRising(C,V){if(C.length<10)return false;let obv=0;const vals=[];for(let i=1;i<C.length;i++){obv+=C[i]>C[i-1]?V[i]:C[i]<C[i-1]?-V[i]:0;vals.push(obv);}if(vals.length<5)return false;const e5=vals.slice(-5),e10=vals.slice(-10,-5);return e5.reduce((a,b)=>a+b)/5>e10.reduce((a,b)=>a+b)/5;}

// ── Divergence detection ──
function detectDivergences(O,H,L,C,rsi,atr,T){
  const sigs=[],lb=20;
  for(let i=lb+1;i<C.length-2;i++){
    if(atr[i]===0)continue;
    if(rsi[i]<40){let ok=false;for(let j=i-lb;j<i-4;j++){if(L[i]<L[j]&&rsi[i]>rsi[j]){ok=true;break;}}if(ok&&C[i+1]>O[i+1])sigs.push({bar:i+2,side:'BUY',entry:O[i+2],atr:atr[i],t:T[i+2]});}
    if(rsi[i]>60){let ok=false;for(let j=i-lb;j<i-4;j++){if(H[i]>H[j]&&rsi[i]<rsi[j]){ok=true;break;}}if(ok&&C[i+1]<O[i+1])sigs.push({bar:i+2,side:'SELL',entry:O[i+2],atr:atr[i],t:T[i+2]});}
  }
  const out=[];let last=-999;for(const s of sigs){if(s.bar-last>=6){out.push(s);last=s.bar;}}return out;
}

// ── HTF Gate: 1H trend — FIX 1: timestamp-based filtering ──
function htfGate(kl1hRaw, barTime){
  // FIX 1 (L1): Use only 1h candles whose closeTime <= barTime (no look-ahead)
  const htfSlice = kl1hRaw.filter(k => parseInt(k[6]) <= barTime);
  if(htfSlice.length < 50) return 'NEUTRAL';
  const C1h = htfSlice.map(k => +k[4]);
  const H1h = htfSlice.map(k => +k[2]);
  const L1h = htfSlice.map(k => +k[3]);
  const V1h = htfSlice.map(k => +k[5]);

  const e9=emaArr(C1h,9).at(-1),e21=emaArr(C1h,21).at(-1),e50=emaArr(C1h,50).at(-1);
  const rsi=rsiArr(C1h,14).at(-1);const mac=macdAt(C1h);
  const adx=adxCalc(H1h,L1h,C1h);const obR=obvRising(C1h,V1h);
  let hB=0,hS=0;
  if(e9>e21)hB+=2;else hS+=2; if(C1h.at(-1)>e50)hB+=1;else hS+=1;
  if(mac.h>0)hB+=1.5;else hS+=1.5; if(mac.h>mac.ph)hB+=1;else hS+=1;
  if(rsi>50)hB+=1;else hS+=1;
  if(adx.adx>20&&adx.pdi>adx.mdi)hB+=1.5;else if(adx.adx>20&&adx.mdi>adx.pdi)hS+=1.5;
  if(obR)hB+=1;else hS+=1;
  if(hB>hS+2)return'BUY';if(hS>hB+2)return'SELL';return'NEUTRAL';
}

// ── 15m Gate — FIX 2: timestamp-based filtering ──
function mtfGate(kl15Raw, barTime){
  // FIX 2 (L2): Use only 15m candles whose closeTime <= barTime (no look-ahead)
  const mtfSlice = kl15Raw.filter(k => parseInt(k[6]) <= barTime);
  if(mtfSlice.length < 26) return 'NEUTRAL';
  const C15 = mtfSlice.map(k => +k[4]);

  const e9=emaArr(C15,9).at(-1),e21=emaArr(C15,21).at(-1);
  const rsi=rsiArr(C15,14).at(-1);const mac=macdAt(C15);
  let mB=0,mS=0;
  if(e9>e21)mB+=1;else mS+=1; if(mac.h>0)mB+=1;else mS+=1;
  if(rsi>50)mB+=0.5;else if(rsi<50)mS+=0.5;
  if(mB>mS)return'BUY';if(mS>mB)return'SELL';return'NEUTRAL';
}

// ── Scalp scoring at bar i ──
function scalpScore(C,H,L,V,kl5,i,side){
  const sl=Math.max(0,i-280),cS=C.slice(sl,i+1),hS=H.slice(sl,i+1),lS=L.slice(sl,i+1),vS=V.slice(sl,i+1);
  if(cS.length<26)return{score:0,inds:0,isMR:false};
  const cur=cS.at(-1);const rsiS=rsiArr(cS,7).at(-1);const mac=macdAt(cS);
  const e5=emaArr(cS,5).at(-1),e13=emaArr(cS,13).at(-1);
  const bb=bbAt(cS,10,1.8);const st=stochAt(hS,lS,cS,7);
  const avgV=vS.slice(-20).reduce((a,b)=>a+b)/Math.min(20,vS.length);const vr=vS.at(-1)/avgV;
  const kcp=kcPos(hS,lS,cS);const mfi=mfiAt(hS,lS,cS,vS,7);const psar=psarTrend(hS,lS,cS);
  const klSlice=kl5?kl5.slice(Math.max(0,i-50),i+1):[];const vwap=vwapAt(klSlice);
  let bS=0,sS=0,bI=0,sI=0;
  if(rsiS<25){bS+=3;bI++;}else if(rsiS<35){bS+=2;bI++;}else if(rsiS<45){bS+=1;bI++;}
  else if(rsiS>75){sS+=3;sI++;}else if(rsiS>65){sS+=2;sI++;}else if(rsiS>55){sS+=1;sI++;}
  if(st.k<25){bS+=3;bI++;}else if(st.k<40){bS+=1.5;bI++;}
  else if(st.k>75){sS+=3;sI++;}else if(st.k>60){sS+=1.5;sI++;}
  if(bb.pos<0.08){bS+=3;bI++;}else if(bb.pos<0.25){bS+=2;bI++;}
  else if(bb.pos>0.92){sS+=3;sI++;}else if(bb.pos>0.75){sS+=2;sI++;}
  if(mac.h>0&&mac.ph<=0){bS+=2.5;bI++;}else if(mac.h<0&&mac.ph>=0){sS+=2.5;sI++;}
  else if(mac.h>0)bS+=0.5;else sS+=0.5;
  if(e5>e13){bS+=1.5;bI++;}else{sS+=1.5;sI++;}
  if(vwap&&cur<vwap){bS+=1;bI++;}else if(vwap&&cur>vwap){sS+=1;sI++;}
  if(vr>1.5){if(rsiS<50){bS+=2;bI++;}else{sS+=2;sI++;}}else if(vr>0.8){if(rsiS<50)bS+=0.5;else sS+=0.5;}
  if(kcp<0.25){bS+=1.5;bI++;}else if(kcp>0.75){sS+=1.5;sI++;}
  if(psar==='BUY'){bS+=1;bI++;}else{sS+=1;sI++;}
  if(mfi<35){bS+=1.5;bI++;}else if(mfi>65){sS+=1.5;sI++;}
  if(side==='BUY'){bS+=3;bI++;}else{sS+=3;sI++;}
  const sc=side==='BUY'?bS:sS, ic=side==='BUY'?bI:sI;
  const isMR=(side==='BUY'&&(rsiS<35||bb.pos<0.20))||(side==='SELL'&&(rsiS>65||bb.pos>0.80));
  return{score:sc,inds:ic,isMR,vr};
}

// ── Momentum check ──
function momBlock(C,i,side){
  if(i<5)return false;let consUp=0,consDn=0;
  for(let j=i;j>i-5&&j>0;j--){if(C[j]>C[j-1])consUp++;else{break;}}
  for(let j=i;j>i-5&&j>0;j--){if(C[j]<C[j-1])consDn++;else{break;}}
  if(side==='BUY'&&consDn>=4)return true;if(side==='SELL'&&consUp>=4)return true;return false;
}

// ── Apply scalp filters — FIX 1 & 2: pass raw kline arrays + barTime ──
function applyScalpFilter(sig,C,H,L,V,kl5,kl1hRaw,kl15Raw){
  const i=sig.bar-2;
  if(i<26)return false;

  // FIX 1 (L1): Timestamp-based HTF gate
  const barTime = parseInt(kl5[sig.bar][0]);
  const htf = htfGate(kl1hRaw, barTime);

  // FIX 2 (L2): Timestamp-based MTF gate
  const mtf = mtfGate(kl15Raw, barTime);

  const sc=scalpScore(C,H,L,V,kl5,i,sig.side);
  const minScore=6,minInds=4;
  let pass=false;
  if(mtf===sig.side&&htf===sig.side&&sc.score>=minScore-1&&sc.inds>=minInds-1)pass=true;
  else if(mtf===sig.side&&sc.score>=minScore&&sc.inds>=minInds)pass=true;
  else if(mtf==='NEUTRAL'&&sc.score>=minScore+1&&sc.inds>=minInds)pass=true;
  if(pass&&htf!=='NEUTRAL'&&sig.side!==htf&&sc.score<minScore+2)pass=false;
  if(!pass)return false;
  if(sc.vr<0.3)return false;
  if(!sc.isMR&&momBlock(C,i,sig.side))return false;
  return true;
}

// ── FIX 7: Fees VIP 0 ──
const MKR = 0.0002;   // 0.02% maker
const TKR = 0.0005;   // 0.05% taker (was 0.04%)
const SLIP = 0.0003;  // 0.03% slippage (was 0.01%)

// ── Eval combo — FIX 4,5,6,7,8 applied ──
// Returns detailed trade-level results for capital tracking and position overlap
function evalComboAudited(sigs, H, L, C, atrArr2, slM, tpM, pos=2500){
  const trades = [];
  // FIX 5 (C2): Sort by bar for overlap tracking
  const sorted = [...sigs].sort((a,b) => a.bar - b.bar);

  for(const s of sorted){
    const sl=s.atr*slM, tp=s.atr*tpM;
    if(!sl||!tp)continue;

    // FIX 6 (F1): Fill rate — skip if entry bar range < ATR*0.3
    const barRange = H[s.bar] - L[s.bar];
    if(barRange < s.atr * 0.3) continue; // low volatility, limit likely not filled

    const slP=s.side==='BUY'?s.entry-sl:s.entry+sl;
    const tpP=s.side==='BUY'?s.entry+tp:s.entry-tp;
    let hit=0, exitBar=s.bar, exitPrice=s.entry;

    for(let b=s.bar;b<Math.min(s.bar+288,C.length);b++){
      // FIX 9: SL checked first (SL wins on same bar) — already was conservative
      if(s.side==='BUY'){
        if(L[b]<=slP){hit=-1;exitBar=b;exitPrice=slP;break;}
        if(H[b]>=tpP){hit=1;exitBar=b;exitPrice=tpP;break;}
      } else {
        if(H[b]>=slP){hit=-1;exitBar=b;exitPrice=slP;break;}
        if(L[b]<=tpP){hit=1;exitBar=b;exitPrice=tpP;break;}
      }
    }

    // FIX 8: Timeout trades closed at market (not dropped)
    if(hit===0){
      const timeoutBar = Math.min(s.bar+287, C.length-1);
      exitBar = timeoutBar;
      exitPrice = C[timeoutBar]; // close at market
      const pnlRaw = s.side==='BUY' ? exitPrice - s.entry : s.entry - exitPrice;
      hit = pnlRaw >= 0 ? 2 : -2; // 2/-2 = timeout win/loss
    }

    trades.push({
      ...s,
      hit,
      exitBar,
      exitPrice,
      sl, tp, slP, tpP
    });
  }

  return trades;
}

// ── Simulate trades with capital tracking + position limits ──
function simulateTrades(trades, startCap=2500){
  let capital = startCap;
  let wins=0, losses=0, pnl=0, gross=0, grossL=0;
  let minCap = capital, maxDD = 0, peakCap = capital;
  let skippedOverlap = 0, timeouts = 0;
  const executed = [];
  const weeklyEquity = {};

  for(const t of trades){
    // FIX 4 (C1): Check capital
    if(capital <= 0) break;

    // FIX 5 (C2): Check overlap — max 3 simultaneous, max 2 same direction
    const openAtEntry = executed.filter(e => e.exitBar > t.bar);
    if(openAtEntry.length >= 3){ skippedOverlap++; continue; }
    const sameDirOpen = openAtEntry.filter(e => e.side === t.side);
    if(sameDirOpen.length >= 2){ skippedOverlap++; continue; }

    // FIX 4 (C1): Dynamic position size
    const posSize = Math.min(2500, capital * 5);
    const qty = posSize / t.entry;

    let tradePnl = 0;
    if(t.hit === 1){ // TP hit
      tradePnl = qty * t.tp - posSize * (MKR + MKR); // maker entry + maker exit (limit)
      gross += tradePnl > 0 ? tradePnl : 0;
      wins++;
    } else if(t.hit === -1){ // SL hit
      tradePnl = -(qty * t.sl + posSize * (MKR + TKR + SLIP)); // maker entry, taker+slip exit
      grossL += Math.abs(tradePnl);
      losses++;
    } else if(t.hit === 2){ // timeout win
      const rawPnl = t.side==='BUY' ? t.exitPrice - t.entry : t.entry - t.exitPrice;
      tradePnl = qty * rawPnl - posSize * (MKR + TKR + SLIP); // taker exit for timeout
      gross += tradePnl > 0 ? tradePnl : 0;
      wins++;
      timeouts++;
    } else if(t.hit === -2){ // timeout loss
      const rawPnl = t.side==='BUY' ? t.exitPrice - t.entry : t.entry - t.exitPrice;
      tradePnl = qty * rawPnl - posSize * (MKR + TKR + SLIP);
      grossL += Math.abs(tradePnl);
      losses++;
      timeouts++;
    }

    pnl += tradePnl;
    capital += tradePnl;

    // Track drawdown
    if(capital > peakCap) peakCap = capital;
    const dd = (peakCap - capital) / peakCap;
    if(dd > maxDD) maxDD = dd;
    if(capital < minCap) minCap = capital;

    // Weekly equity tracking
    if(t.t){
      const weekKey = Math.floor(t.t / (7*86400000));
      weeklyEquity[weekKey] = capital;
    }

    executed.push(t);
  }

  const n = wins + losses;
  const wr = n ? wins/n*100 : 0;
  const pf = grossL > 0 ? gross/grossL : 0;

  return {
    pnl: Math.round(pnl*100)/100,
    pf: Math.round(pf*100)/100,
    wr: Math.round(wr*10)/10,
    n, wins, losses,
    capital: Math.round(capital*100)/100,
    minCap: Math.round(minCap*100)/100,
    maxDD: Math.round(maxDD*10000)/100, // percentage
    peakCap: Math.round(peakCap*100)/100,
    skippedOverlap,
    timeouts,
    weeklyEquity,
    executed
  };
}

// Simple evalCombo wrapper for grid search (no capital tracking needed)
function evalComboSimple(sigs, H, L, C, slM, tpM){
  const trades = evalComboAudited(sigs, H, L, C, null, slM, tpM);
  return simulateTrades(trades);
}

async function main(){
  console.log('='.repeat(70));
  console.log('  DIV_SNIPER + SCALP FILTERS — 120d Backtest (AUDITED)');
  console.log('='.repeat(70));

  console.log(`
AUDIT FIXES APPLIED:
  FIX 1 (L1): HTF look-ahead — timestamp-based 1h filtering (was index arithmetic)
  FIX 2 (L2): MTF look-ahead — timestamp-based 15m filtering (was index arithmetic)
  FIX 3 (S2): Walk-forward — grid on IS (67%) only, fixed params on OOS (33%)
  FIX 4 (C1): Dynamic capital — start $2500, posSize=min(2500, capital*5)
  FIX 5 (C2): Max 3 simultaneous positions, max 2 same direction
  FIX 6 (F1): Fill rate — skip trades where entry bar range < ATR*0.3
  FIX 7: Fees — taker 0.05% (was 0.04%), slippage 0.03% (was 0.01%)
  FIX 8: Timeout — 288-bar timeout closed at market (was silently dropped)
  FIX 9: SL/TP same bar — SL wins (already conservative, PASS)
`);

  console.log(`FEE STRUCTURE: maker=${MKR*100}%, taker=${TKR*100}%, slippage=${SLIP*100}%`);

  const PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT'];
  const allData={};

  // Download data
  for(const sym of PAIRS){
    process.stdout.write(`\n[DL] ${sym} 5m+1h+15m...`);
    const [k5,k1h,k15]=await Promise.all([getKlines(sym,'5m',120),getKlines(sym,'1h',120),getKlines(sym,'15m',120)]);
    const O=k5.map(k=>+k[1]),H=k5.map(k=>+k[2]),L=k5.map(k=>+k[3]),C=k5.map(k=>+k[4]),V=k5.map(k=>+k[5]),T=k5.map(k=>k[0]);
    allData[sym]={O,H,L,C,V,T,k5,k1h,k15};
    console.log(` 5m:${k5.length} 1h:${k1h.length} 15m:${k15.length}`);
  }

  // ── BTC baseline + filtered ──
  const btc=allData.BTCUSDT;
  const rsi=rsiArr(btc.C,14),atr=atrArr(btc.H,btc.L,btc.C,14);
  const allSigs=detectDivergences(btc.O,btc.H,btc.L,btc.C,rsi,atr,btc.T);

  // Apply scalp filters — FIX 1 & 2: pass raw kline arrays
  const filtered=allSigs.filter(s=>applyScalpFilter(s,btc.C,btc.H,btc.L,btc.V,btc.k5,btc.k1h,btc.k15));
  const pctOut=((1-filtered.length/allSigs.length)*100).toFixed(0);
  console.log(`\nSIGNAL COUNTS:`);
  console.log(`  Raw divergences: ${allSigs.length}`);
  console.log(`  After scalp filters: ${filtered.length} (${pctOut}% filtered out)`);

  // ── FIX 3: Walk-forward genuine ──
  // Split data: first 67% = IS, last 33% = OOS
  const tMin=btc.T[0],tMax=btc.T.at(-1);
  const tSplit = tMin + 0.67 * (tMax - tMin); // 67% boundary

  const isSigs = filtered.filter(s => s.t < tSplit);
  const oosSigs = filtered.filter(s => s.t >= tSplit);

  console.log(`\n${'='.repeat(70)}`);
  console.log('  FIX 3: WALK-FORWARD (grid on IS only, fixed params on OOS)');
  console.log(`${'='.repeat(70)}`);
  console.log(`  IS signals: ${isSigs.length} (first 67% of data)`);
  console.log(`  OOS signals: ${oosSigs.length} (last 33% of data)`);

  // Mini-grid on IS signals ONLY
  const SLs=[0.8,1.0,1.2],TPs=[2.0,2.5,3.0];
  const grid=[];
  for(const sl of SLs) for(const tp of TPs){
    const r = evalComboSimple(isSigs, btc.H, btc.L, btc.C, sl, tp);
    grid.push({sl, tp, ...r});
  }

  console.log(`\nMINI-GRID (IS period only, BTCUSDT):`);
  console.log('          '+TPs.map(t=>`TP×${t}`.padStart(18)).join(''));
  for(const sl of SLs){
    let row=`SL×${sl}`.padEnd(10);
    for(const tp of TPs){
      const r=grid.find(x=>x.sl===sl&&x.tp===tp);
      row+=`PF${r.pf}/WR${r.wr}/${r.n}t`.padStart(18);
    }
    console.log(row);
  }

  // Select best from IS
  const best=grid.filter(r=>r.n>=3).sort((a,b)=>b.pnl-a.pnl)[0]||grid[0];
  console.log(`\nBest IS params: SL×${best.sl} TP×${best.tp} → PF ${best.pf}, WR ${best.wr}%, ${best.n} trades, PnL $${best.pnl}`);

  // Evaluate FIXED best params on OOS (no re-optimization!)
  const oosResult = evalComboSimple(oosSigs, btc.H, btc.L, btc.C, best.sl, best.tp);
  console.log(`\nOOS (fixed params SL×${best.sl} TP×${best.tp}):`);
  console.log(`  PF ${oosResult.pf}, WR ${oosResult.wr}%, ${oosResult.n} trades, PnL $${oosResult.pnl}`);
  console.log(`  OOS/IS PF ratio: ${best.pf > 0 ? (oosResult.pf/best.pf).toFixed(2) : 'N/A'}`);

  // ── Multi-pair with ALL audit fixes ──
  console.log(`\n${'='.repeat(70)}`);
  console.log('  MULTI-PAIR RESULTS (all fixes applied)');
  console.log(`${'='.repeat(70)}`);

  let allFilteredSigs = [];
  const pairResults = [];

  for(const sym of PAIRS){
    const d=allData[sym];
    const r14=rsiArr(d.C,14),a14=atrArr(d.H,d.L,d.C,14);
    const divs=detectDivergences(d.O,d.H,d.L,d.C,r14,a14,d.T);
    // FIX 1 & 2: pass raw kline arrays
    const filt=divs.filter(s=>applyScalpFilter(s,d.C,d.H,d.L,d.V,d.k5,d.k1h,d.k15));

    // Get trades with all fixes
    const trades = evalComboAudited(filt, d.H, d.L, d.C, null, best.sl, best.tp);
    const res = simulateTrades(trades);

    const label=sym.replace('USDT','');
    console.log(`\n  ${label}:`);
    console.log(`    Raw divs: ${divs.length}, Filtered: ${filt.length}`);
    console.log(`    PF ${res.pf}, WR ${res.wr}%, ${res.n} trades, PnL $${res.pnl}`);
    console.log(`    Timeouts: ${res.timeouts}, Skipped (overlap): ${res.skippedOverlap}`);
    console.log(`    Min capital: $${res.minCap}, Max DD: ${res.maxDD}%`);

    pairResults.push({sym, label, divs: divs.length, filt: filt.length, res, trades});
    allFilteredSigs.push(...filt.map(s=>({...s, sym})));
  }

  // ── Combined multi-pair simulation (FIX 4+5 across all pairs) ──
  console.log(`\n${'='.repeat(70)}`);
  console.log('  COMBINED PORTFOLIO (all pairs, capital + position limits)');
  console.log(`${'='.repeat(70)}`);

  // Collect all trades from all pairs, sort by time
  let allTrades = [];
  for(const pr of pairResults){
    for(const t of pr.trades){
      allTrades.push({...t, sym: pr.sym});
    }
  }
  allTrades.sort((a,b) => a.bar === b.bar ? a.t - b.t : a.t - b.t);

  // Combined portfolio trades with proper eval
  let combinedTrades = [];
  for(const pr of pairResults){
    const d = allData[pr.sym];
    const trades = evalComboAudited(pr.trades.length ? pr.res.executed.map(t=>t) : [], d.H, d.L, d.C, null, best.sl, best.tp);
    // Actually just use the already-computed trades
  }

  // Re-simulate all trades together with shared capital and position limits
  const combined = simulateTrades(allTrades, 2500);

  console.log(`  Total trades: ${combined.n}`);
  console.log(`  PF: ${combined.pf}, WR: ${combined.wr}%`);
  console.log(`  PnL: $${combined.pnl}`);
  console.log(`  Start capital: $2500`);
  console.log(`  Final capital: $${combined.capital}`);
  console.log(`  Min capital: $${combined.minCap}`);
  console.log(`  Peak capital: $${combined.peakCap}`);
  console.log(`  Max drawdown: ${combined.maxDD}%`);
  console.log(`  Timeouts: ${combined.timeouts}`);
  console.log(`  Skipped (overlap): ${combined.skippedOverlap}`);
  const liquidated = combined.minCap <= 0;
  console.log(`  Liquidated: ${liquidated ? 'YES' : 'NO'}`);

  // ── Weekly equity ──
  console.log(`\nWEEKLY EQUITY:`);
  const weeks = Object.entries(combined.weeklyEquity).sort((a,b) => +a[0] - +b[0]);
  if(weeks.length){
    let wNum = 1;
    for(const [wk, eq] of weeks){
      const date = new Date(+wk * 7 * 86400000);
      console.log(`  W${String(wNum).padStart(2,'0')} (${date.toISOString().slice(0,10)}): $${Math.round(eq)}`);
      wNum++;
    }
  } else {
    console.log('  No trades executed.');
  }

  // ── Comparison summary ──
  console.log(`\n${'='.repeat(70)}`);
  console.log('  BEFORE vs AFTER AUDIT COMPARISON');
  console.log(`${'='.repeat(70)}`);
  console.log('  (Before = original code without fixes, After = all 9 fixes applied)');
  console.log('');
  console.log('  BEFORE (unaudited):');

  // Run unaudited version for comparison
  const unauditedBase = evalUnaudited(filtered, btc.H, btc.L, btc.C, best.sl, best.tp);
  console.log(`    BTC: PF ${unauditedBase.pf}, WR ${unauditedBase.wr}%, ${unauditedBase.n} trades, PnL $${unauditedBase.pnl}`);

  const btcAudited = pairResults.find(p=>p.sym==='BTCUSDT');
  console.log('  AFTER (audited):');
  console.log(`    BTC: PF ${btcAudited.res.pf}, WR ${btcAudited.res.wr}%, ${btcAudited.res.n} trades, PnL $${btcAudited.res.pnl}`);

  console.log(`\n  Metric         Before    After     Delta`);
  console.log(`  ${'─'.repeat(48)}`);
  console.log(`  PF             ${String(unauditedBase.pf).padEnd(10)}${String(btcAudited.res.pf).padEnd(10)}${(btcAudited.res.pf - unauditedBase.pf).toFixed(2)}`);
  console.log(`  WR%            ${String(unauditedBase.wr).padEnd(10)}${String(btcAudited.res.wr).padEnd(10)}${(btcAudited.res.wr - unauditedBase.wr).toFixed(1)}`);
  console.log(`  Trades         ${String(unauditedBase.n).padEnd(10)}${String(btcAudited.res.n).padEnd(10)}${btcAudited.res.n - unauditedBase.n}`);
  console.log(`  PnL            $${String(unauditedBase.pnl).padEnd(9)}$${String(btcAudited.res.pnl).padEnd(9)}$${(btcAudited.res.pnl - unauditedBase.pnl).toFixed(2)}`);
}

// ── Unaudited evalCombo (original logic for comparison) ──
function evalUnaudited(sigs, H, L, C, slM, tpM, pos=2500){
  let wins=0,losses=0,pnl=0,gross=0,grossL=0;
  const mkr=0.0002,tkr=0.0004,slip=0.0001; // original fees
  for(const s of sigs){
    const sl=s.atr*slM,tp=s.atr*tpM;if(!sl||!tp)continue;
    const slP=s.side==='BUY'?s.entry-sl:s.entry+sl;
    const tpP=s.side==='BUY'?s.entry+tp:s.entry-tp;
    let hit=0;
    for(let b=s.bar;b<Math.min(s.bar+288,C.length);b++){
      if(s.side==='BUY'){if(L[b]<=slP){hit=-1;break;}if(H[b]>=tpP){hit=1;break;}}
      else{if(H[b]>=slP){hit=-1;break;}if(L[b]<=tpP){hit=1;break;}}
    }
    if(!hit)continue; // original: dropped timeouts
    const qty=pos/s.entry;
    if(hit===1){const g=qty*tp-pos*(mkr+mkr);pnl+=g;gross+=g;wins++;}
    else{const l=qty*sl+pos*(mkr+tkr+slip);pnl-=l;grossL+=l;losses++;}
  }
  const n=wins+losses,wr=n?wins/n*100:0,pf=grossL>0?gross/grossL:0;
  return{pnl:Math.round(pnl*100)/100,pf:Math.round(pf*100)/100,wr:Math.round(wr*10)/10,n,wins,losses};
}

main().catch(e=>console.error(e));
