// FINAL OPTIMIZATION — DIV_SNIPER + Scalp Filters
// Step 1: Score distribution, Step 2: New pairs, Step 3: Threshold optimize, Step 4: Combined
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

// ── Indicators (EXACT copy) ──
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

// ── Divergence detection (EXACT copy) ──
function detectDivergences(O,H,L,C,rsi,atr,T){
  const sigs=[],lb=20;
  for(let i=lb+1;i<C.length-2;i++){
    if(atr[i]===0)continue;
    if(rsi[i]<40){let ok=false;for(let j=i-lb;j<i-4;j++){if(L[i]<L[j]&&rsi[i]>rsi[j]){ok=true;break;}}if(ok&&C[i+1]>O[i+1])sigs.push({bar:i+2,side:'BUY',entry:O[i+2],atr:atr[i],t:T[i+2]});}
    if(rsi[i]>60){let ok=false;for(let j=i-lb;j<i-4;j++){if(H[i]>H[j]&&rsi[i]<rsi[j]){ok=true;break;}}if(ok&&C[i+1]<O[i+1])sigs.push({bar:i+2,side:'SELL',entry:O[i+2],atr:atr[i],t:T[i+2]});}
  }
  const out=[];let last=-999;for(const s of sigs){if(s.bar-last>=6){out.push(s);last=s.bar;}}return out;
}

// ── HTF Gate (EXACT copy) ──
function htfGate(C1h,H1h,L1h,V1h){
  if(C1h.length<26)return'NEUTRAL';
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

// ── 15m Gate (EXACT copy) ──
function mtfGate(C15){
  if(C15.length<26)return'NEUTRAL';
  const e9=emaArr(C15,9).at(-1),e21=emaArr(C15,21).at(-1);
  const rsi=rsiArr(C15,14).at(-1);const mac=macdAt(C15);
  let mB=0,mS=0;
  if(e9>e21)mB+=1;else mS+=1; if(mac.h>0)mB+=1;else mS+=1;
  if(rsi>50)mB+=0.5;else if(rsi<50)mS+=0.5;
  if(mB>mS)return'BUY';if(mS>mB)return'SELL';return'NEUTRAL';
}

// ── Scalp scoring (EXACT copy) ──
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

function momBlock(C,i,side){
  if(i<5)return false;let consUp=0,consDn=0;
  for(let j=i;j>i-5&&j>0;j--){if(C[j]>C[j-1])consUp++;else{break;}}
  for(let j=i;j>i-5&&j>0;j--){if(C[j]<C[j-1])consDn++;else{break;}}
  if(side==='BUY'&&consDn>=4)return true;if(side==='SELL'&&consUp>=4)return true;return false;
}

// ── Apply scalp filters (EXACT copy) — returns {pass, score} ──
function applyScalpFilterWithScore(sig,C,H,L,V,kl5,C1h,H1h,L1h,V1h,C15){
  const i=sig.bar-2;
  if(i<26)return{pass:false,score:0};
  const htf=htfGate(C1h.slice(0,Math.min(C1h.length,Math.floor(i/12)+5)),H1h.slice(0,Math.min(H1h.length,Math.floor(i/12)+5)),L1h.slice(0,Math.min(L1h.length,Math.floor(i/12)+5)),V1h.slice(0,Math.min(V1h.length,Math.floor(i/12)+5)));
  const mtf=mtfGate(C15.slice(0,Math.min(C15.length,Math.floor(i/3)+5)));
  const sc=scalpScore(C,H,L,V,kl5,i,sig.side);
  const minScore=6,minInds=4;
  let pass=false;
  if(mtf===sig.side&&htf===sig.side&&sc.score>=minScore-1&&sc.inds>=minInds-1)pass=true;
  else if(mtf===sig.side&&sc.score>=minScore&&sc.inds>=minInds)pass=true;
  else if(mtf==='NEUTRAL'&&sc.score>=minScore+1&&sc.inds>=minInds)pass=true;
  if(pass&&htf!=='NEUTRAL'&&sig.side!==htf&&sc.score<minScore+2)pass=false;
  if(!pass)return{pass:false,score:sc.score};
  if(sc.vr<0.3)return{pass:false,score:sc.score};
  if(!sc.isMR&&momBlock(C,i,sig.side))return{pass:false,score:sc.score};
  return{pass:true,score:sc.score};
}

// ── Eval combo with per-trade detail ──
function evalComboDetailed(sigs,H,L,C,slM,tpM,pos=2500){
  let wins=0,losses=0,pnl=0,gross=0,grossL=0;
  const mkr=0.0002,tkr=0.0004,slip=0.0001;const trades=[];
  for(const s of sigs){
    const sl=s.atr*slM,tp=s.atr*tpM;if(!sl||!tp)continue;
    const slP=s.side==='BUY'?s.entry-sl:s.entry+sl;
    const tpP=s.side==='BUY'?s.entry+tp:s.entry-tp;
    let hit=0;
    for(let b=s.bar;b<Math.min(s.bar+288,C.length);b++){
      if(s.side==='BUY'){if(L[b]<=slP){hit=-1;break;}if(H[b]>=tpP){hit=1;break;}}
      else{if(H[b]>=slP){hit=-1;break;}if(L[b]<=tpP){hit=1;break;}}
    }
    if(!hit)continue;
    const qty=pos/s.entry;
    if(hit===1){const g=qty*tp-pos*(mkr+mkr);pnl+=g;gross+=g;wins++;trades.push({...s,win:true,pnlT:g});}
    else{const l=qty*sl+pos*(mkr+tkr+slip);pnl-=l;grossL+=l;losses++;trades.push({...s,win:false,pnlT:-l});}
  }
  const n=wins+losses,wr=n?wins/n*100:0,pf=grossL>0?gross/grossL:0;
  return{pnl:Math.round(pnl*100)/100,pf:Math.round(pf*100)/100,wr:Math.round(wr*10)/10,n,wins,losses,trades,gross,grossL};
}

function evalCombo(sigs,H,L,C,slM,tpM,pos=2500){
  const r=evalComboDetailed(sigs,H,L,C,slM,tpM,pos);
  return{pnl:r.pnl,pf:r.pf,wr:r.wr,n:r.n,wins:r.wins,losses:r.losses,gross:r.gross,grossL:r.grossL};
}

async function loadPairData(sym,days=120){
  process.stdout.write(`[DL] ${sym} 5m+1h+15m...`);
  const [k5,k1h,k15]=await Promise.all([getKlines(sym,'5m',days),getKlines(sym,'1h',days),getKlines(sym,'15m',days)]);
  const O=k5.map(k=>+k[1]),H=k5.map(k=>+k[2]),L=k5.map(k=>+k[3]),C=k5.map(k=>+k[4]),V=k5.map(k=>+k[5]),T=k5.map(k=>k[0]);
  const C1h=k1h.map(k=>+k[4]),H1h=k1h.map(k=>+k[2]),L1h=k1h.map(k=>+k[3]),V1h=k1h.map(k=>+k[5]);
  const C15=k15.map(k=>+k[4]);
  console.log(` 5m:${k5.length} 1h:${k1h.length} 15m:${k15.length}`);
  return{O,H,L,C,V,T,k5,C1h,H1h,L1h,V1h,C15};
}

function getFilteredSigs(d){
  const r14=rsiArr(d.C,14),a14=atrArr(d.H,d.L,d.C,14);
  const divs=detectDivergences(d.O,d.H,d.L,d.C,r14,a14,d.T);
  const results=[];
  for(const s of divs){
    const r=applyScalpFilterWithScore(s,d.C,d.H,d.L,d.V,d.k5,d.C1h,d.H1h,d.L1h,d.V1h,d.C15);
    if(r.pass)results.push({...s,score:r.score});
  }
  return results;
}

const SLM=1.2,TPM=3.0;

async function main(){
  console.log('='.repeat(70));
  console.log('  FINAL OPTIMIZATION — DIV_SNIPER + Scalp Filters');
  console.log('='.repeat(70));

  // ── Load base pairs ──
  const BASE=['BTCUSDT','ETHUSDT','SOLUSDT'];
  const NEW=['BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT'];
  const allData={};
  for(const sym of [...BASE,...NEW]){allData[sym]=await loadPairData(sym);}

  // ══════════ STEP 1: Score Distribution ══════════
  console.log('\n'+'='.repeat(70));
  console.log('  STEP 1: SCORE DISTRIBUTION (3 base pairs, score>=6)');
  console.log('='.repeat(70));

  const baseSigs=[];
  for(const sym of BASE){
    const d=allData[sym];
    const filt=getFilteredSigs(d);
    for(const s of filt)baseSigs.push({...s,sym,d});
  }

  // Evaluate each trade and attach score
  const scoreBuckets={6:[],7:[],8:[],9:[],10:[]};
  for(const s of baseSigs){
    const d=allData[s.sym];
    const sl=s.atr*SLM,tp=s.atr*TPM;if(!sl||!tp)continue;
    const slP=s.side==='BUY'?s.entry-sl:s.entry+sl;
    const tpP=s.side==='BUY'?s.entry+tp:s.entry-tp;
    let hit=0;
    for(let b=s.bar;b<Math.min(s.bar+288,d.C.length);b++){
      if(s.side==='BUY'){if(d.L[b]<=slP){hit=-1;break;}if(d.H[b]>=tpP){hit=1;break;}}
      else{if(d.H[b]>=slP){hit=-1;break;}if(d.L[b]<=tpP){hit=1;break;}}
    }
    if(!hit)continue;
    const qty=2500/s.entry;const mkr=0.0002,tkr=0.0004,slip=0.0001;
    const pnlT=hit===1?(qty*tp-2500*(mkr+mkr)):-(qty*sl+2500*(mkr+tkr+slip));
    const sc=Math.min(Math.floor(s.score),10);
    const bucket=sc>=10?10:sc;
    if(!scoreBuckets[bucket])scoreBuckets[bucket]=[];
    scoreBuckets[bucket].push({win:hit===1,pnl:pnlT});
  }

  console.log('\nSCORE DISTRIBUTION (3 base pairs, score>=6):');
  console.log('Score | Trades | WR%   | PF    | PnL');
  console.log('------+--------+-------+-------+--------');
  for(const lvl of [6,7,8,9,10]){
    const b=scoreBuckets[lvl]||[];
    const n=b.length,w=b.filter(x=>x.win).length;
    const wr=n?w/n*100:0;
    const gW=b.filter(x=>x.pnl>0).reduce((a,x)=>a+x.pnl,0);
    const gL=b.filter(x=>x.pnl<0).reduce((a,x)=>a+Math.abs(x.pnl),0);
    const pf=gL>0?gW/gL:0;
    const pnl=b.reduce((a,x)=>a+x.pnl,0);
    const lbl=lvl===10?'10+ ':` ${lvl}  `;
    console.log(`${lbl} | ${String(n).padStart(6)} | ${wr.toFixed(1).padStart(5)} | ${pf.toFixed(2).padStart(5)} | $${Math.round(pnl)}`);
  }

  // ══════════ STEP 2: Test New Pairs ══════════
  console.log('\n'+'='.repeat(70));
  console.log('  STEP 2: NEW PAIRS TEST');
  console.log('='.repeat(70));

  console.log('\nNEW PAIRS:');
  console.log('Pair     | PnL      | PF    | WR%   | Trades | Status');
  console.log('---------+----------+-------+-------+--------+-------');
  const accepted=[];
  for(const sym of NEW){
    const d=allData[sym];
    const filt=getFilteredSigs(d);
    const res=evalCombo(filt,d.H,d.L,d.C,SLM,TPM);
    const status=(res.pf>=3.0&&res.n>=50)?'ACC':'REJ';
    if(status==='ACC')accepted.push(sym);
    const lbl=sym.replace('USDT','').padEnd(8);
    console.log(`${lbl} | $${String(Math.round(res.pnl)).padStart(6)} | ${res.pf.toFixed(2).padStart(5)} | ${res.wr.toFixed(1).padStart(5)} | ${String(res.n).padStart(6)} | ${status}`);
  }
  console.log(`\nAccepted: ${accepted.length?accepted.map(s=>s.replace('USDT','')).join(', '):'none'}`);

  // ══════════ STEP 3: Optimize Score Threshold ══════════
  console.log('\n'+'='.repeat(70));
  console.log('  STEP 3: OPTIMIZE SCORE THRESHOLD');
  console.log('='.repeat(70));

  const FINAL_PAIRS=[...BASE,...accepted];
  // Test thresholds 6,7,8 on combined pairs
  console.log('\nThreshold test (all accepted pairs, SL=1.2, TP=3.0):');
  console.log('Thresh | Trades | WR%   | PF    | PnL      | T/day');
  console.log('-------+--------+-------+-------+----------+------');
  let bestThresh=6,bestThreshPF=0;
  for(const thresh of [6,7,8]){
    let tN=0,tW=0,tGross=0,tGrossL=0,tPnl=0;
    for(const sym of FINAL_PAIRS){
      const d=allData[sym];
      const filt=getFilteredSigs(d).filter(s=>s.score>=thresh);
      const res=evalCombo(filt,d.H,d.L,d.C,SLM,TPM);
      tN+=res.n;tW+=res.wins;tGross+=res.gross;tGrossL+=res.grossL;tPnl+=res.pnl;
    }
    const wr=tN?tW/tN*100:0;const pf=tGrossL>0?tGross/tGrossL:0;const td=tN/120;
    console.log(`  ${thresh}    | ${String(tN).padStart(6)} | ${wr.toFixed(1).padStart(5)} | ${pf.toFixed(2).padStart(5)} | $${String(Math.round(tPnl)).padStart(7)} | ${td.toFixed(1)}`);
    if(pf>bestThreshPF||(pf===bestThreshPF&&wr>=70)){bestThresh=thresh;bestThreshPF=pf;}
  }
  // Pick threshold: prefer WR>=70% with most trades
  // Re-evaluate to pick optimal
  let optThresh=6;
  for(const thresh of [6,7,8]){
    let tN=0,tW=0,tGross=0,tGrossL=0;
    for(const sym of FINAL_PAIRS){
      const d=allData[sym];
      const filt=getFilteredSigs(d).filter(s=>s.score>=thresh);
      const res=evalCombo(filt,d.H,d.L,d.C,SLM,TPM);
      tN+=res.n;tW+=res.wins;tGross+=res.gross;tGrossL+=res.grossL;
    }
    const wr=tN?tW/tN*100:0;const pf=tGrossL>0?tGross/tGrossL:0;
    if(wr>=70&&pf>=5.0)optThresh=thresh;
    else if(thresh===6&&wr>=68)optThresh=6; // fallback
  }
  console.log(`\nOptimal threshold: ${optThresh} (best PF with WR target)`);

  // ══════════ STEP 4: Final Combined Results ══════════
  console.log('\n'+'='.repeat(70));
  console.log(`  STEP 4: FINAL COMBINED (${FINAL_PAIRS.length} pairs, score>=${optThresh})`);
  console.log('='.repeat(70));

  let totalN=0,totalW=0,totalGross=0,totalGrossL=0,totalPnl=0;
  const pairResults=[];let allFiltered=[];
  console.log('\n  Per-pair:');
  for(const sym of FINAL_PAIRS){
    const d=allData[sym];
    const filt=getFilteredSigs(d).filter(s=>s.score>=optThresh);
    const res=evalCombo(filt,d.H,d.L,d.C,SLM,TPM);
    const lbl=sym.replace('USDT','');
    console.log(`  ${lbl}: PF ${res.pf}, ${res.n} trades, $${Math.round(res.pnl)}`);
    totalN+=res.n;totalW+=res.wins;totalGross+=res.gross;totalGrossL+=res.grossL;totalPnl+=res.pnl;
    pairResults.push({sym,res,filt});
    for(const s of filt)allFiltered.push({...s,sym});
  }
  const totalPF=totalGrossL>0?Math.round(totalGross/totalGrossL*100)/100:0;
  const totalWR=totalN?Math.round(totalW/totalN*1000)/10:0;
  const td=totalN/120;
  console.log(`\n  TOTAL: PF ${totalPF} | WR ${totalWR}% | Trades/day: ${td.toFixed(1)}`);
  console.log(`  PnL: $${Math.round(totalPnl).toLocaleString()} | Trades: ${totalN}`);

  // ── Walk-Forward ──
  allFiltered.sort((a,b)=>a.t-b.t);
  const tMin=allFiltered[0]?.t||0,tMax=allFiltered.at(-1)?.t||0;
  const tIS=tMin+80/120*(tMax-tMin);
  let isN=0,isW=0,isG=0,isGL=0,oosN=0,oosW=0,oosG=0,oosGL=0;
  for(const sym of FINAL_PAIRS){
    const d=allData[sym];const pr=pairResults.find(p=>p.sym===sym);if(!pr)continue;
    const isSigs=pr.filt.filter(s=>s.t<tIS);const oosSigs=pr.filt.filter(s=>s.t>=tIS);
    const isR=evalCombo(isSigs,d.H,d.L,d.C,SLM,TPM);
    const oosR=evalCombo(oosSigs,d.H,d.L,d.C,SLM,TPM);
    isN+=isR.n;isW+=isR.wins;isG+=isR.gross;isGL+=isR.grossL;
    oosN+=oosR.n;oosW+=oosR.wins;oosG+=oosR.gross;oosGL+=oosR.grossL;
  }
  const isPF=isGL>0?Math.round(isG/isGL*100)/100:0;const isWR=isN?Math.round(isW/isN*1000)/10:0;
  const oosPF=oosGL>0?Math.round(oosG/oosGL*100)/100:0;const oosWR=oosN?Math.round(oosW/oosN*1000)/10:0;
  console.log(`\nWALK-FORWARD:`);
  console.log(`  IS (d1-80):    PF ${isPF}, WR ${isWR}%, ${isN} trades`);
  console.log(`  OOS (d81-120): PF ${oosPF}, WR ${oosWR}%, ${oosN} trades`);

  // ── Before vs After ──
  console.log(`\nBEFORE vs AFTER:`);
  console.log(`  Before: PF 4.98, WR 68.5%, 5.2 t/d, $6,433`);
  console.log(`  After:  PF ${totalPF}, WR ${totalWR}%, ${td.toFixed(1)} t/d, $${Math.round(totalPnl).toLocaleString()}`);

  // ── Compound ──
  const weekMs=7*86400000;
  let weekCap=2500;
  const wStart=allFiltered[0]?.t||Date.now(),wEnd=allFiltered.at(-1)?.t||Date.now();
  for(let ws=wStart;ws<wEnd;ws+=weekMs){
    const we=ws+weekMs;
    const weekSigs=allFiltered.filter(s=>s.t>=ws&&s.t<we);
    let weekPnl=0;
    for(const s of weekSigs){
      const d=allData[s.sym];const sl2=s.atr*SLM,tp2=s.atr*TPM;
      const slP=s.side==='BUY'?s.entry-sl2:s.entry+sl2;const tpP=s.side==='BUY'?s.entry+tp2:s.entry-tp2;
      let hit=0;for(let b=s.bar;b<Math.min(s.bar+288,d.C.length);b++){
        if(s.side==='BUY'){if(d.L[b]<=slP){hit=-1;break;}if(d.H[b]>=tpP){hit=1;break;}}
        else{if(d.H[b]>=slP){hit=-1;break;}if(d.L[b]<=tpP){hit=1;break;}}
      }
      const posSize=weekCap;const qty=posSize/s.entry;
      if(hit===1)weekPnl+=qty*tp2-posSize*0.0004;else if(hit===-1)weekPnl-=qty*sl2+posSize*0.0007;
    }
    weekCap+=weekPnl*0.65;
    if(weekCap<500)weekCap=500;
  }
  console.log(`\nCOMPOUND (65% weekly from $2,500):`);
  console.log(`  Linear: $${Math.round(totalPnl).toLocaleString()}`);
  console.log(`  Compound: $${Math.round(weekCap-2500).toLocaleString()}`);
  console.log(`  Final Capital: $${Math.round(weekCap).toLocaleString()}`);
  console.log('\n'+'='.repeat(70));
}

main().catch(e=>console.error(e));
