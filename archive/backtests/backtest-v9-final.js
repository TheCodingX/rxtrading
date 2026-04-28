#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// BACKTEST v9 FINAL — 150 días reales Binance
// Motor Scalp + VIP Precision v9, sin bias, sin filtros fake
// Evalúa cada par individualmente para eliminar los peores
// ═══════════════════════════════════════════════════════════════

const https = require('https');
const DAYS = 150;
const TRADE_AMT = 500, LEV = 5;

// ═══ INDICATORS ═══
function calcEMA(a,p){if(!a||a.length<p)return a?a.at(-1)||0:0;let m=2/(p+1),e=a[0];for(let i=1;i<a.length;i++)e=a[i]*m+e*(1-m);return e;}
function calcEMAArr(a,p){if(!a||!a.length)return[];let m=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*m+r[i-1]*(1-m));return r;}
function calcRSI(c,p=14){if(!c||c.length<p+1)return 50;let g=0,l=0;for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l-=d;}g/=p;l/=p;if(l===0)return 100;return 100-100/(1+g/l);}
function calcMACD(c){if(!c||c.length<26)return{h:0,ph:0};const e12=calcEMAArr(c,12),e26=calcEMAArr(c,26);const ml=[];for(let i=0;i<c.length;i++)ml.push((e12[i]||0)-(e26[i]||0));const sl=calcEMAArr(ml,9);return{h:(ml.at(-1)||0)-(sl.at(-1)||0),ph:(ml.at(-2)||0)-(sl.at(-2)||0)};}
function calcBB(c,p=20,k=2){if(!c||c.length<p)return{u:c?c.at(-1)||0:0,m:0,l:0};const sl=c.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const std=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/p);return{u:m+k*std,m,l:m-k*std};}
function calcStoch(h,l,c,p=14){if(!h||h.length<p)return{k:50,d:50};const hh=Math.max(...h.slice(-p)),ll=Math.min(...l.slice(-p));const k=hh!==ll?((c.at(-1)-ll)/(hh-ll))*100:50;return{k,d:k};}
function calcATR(h,l,c,p=14){if(!h||h.length<p+1)return 0;let t=[];for(let i=1;i<h.length;i++)t.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));return t.slice(-p).reduce((a,b)=>a+b)/p;}
function calcADX(h,l,c,p=14){if(!h||h.length<p*2)return{adx:0,pdi:0,mdi:0};let pd=[],md=[],tr=[];for(let i=1;i<h.length;i++){const u=h[i]-h[i-1],d=l[i-1]-l[i];pd.push(u>d&&u>0?u:0);md.push(d>u&&d>0?d:0);tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));}const atr=calcEMA(tr,p)||1;return{adx:Math.abs(calcEMA(pd,p)/atr-calcEMA(md,p)/atr)/(calcEMA(pd,p)/atr+calcEMA(md,p)/atr+0.001)*100,pdi:(calcEMA(pd,p)/atr)*100,mdi:(calcEMA(md,p)/atr)*100};}
function calcOBV(c,v){if(!c||c.length<2)return{rising:false};let o=0;for(let i=1;i<c.length;i++){if(c[i]>c[i-1])o+=v[i];else if(c[i]<c[i-1])o-=v[i];}let o5=0;const s=Math.max(0,c.length-6);for(let i=s+1;i<c.length-1;i++){if(c[i]>c[i-1])o5+=v[i];}return{rising:o>o5};}
function calcVWAP(kl){if(!kl||!kl.length)return[0];let cv=0,ct=0;return kl.map(k=>{const h=parseFloat(k[2]),l=parseFloat(k[3]),c=parseFloat(k[4]),v=parseFloat(k[5]);cv+=v;ct+=(h+l+c)/3*v;return cv>0?ct/cv:c;});}
function calcKeltner(h,l,c,ep=20,ap=14,m=2){const e=calcEMA(c,ep);const a=calcATR(h,l,c,ap);const w=(e+m*a)-(e-m*a);return{position:w>0?(c.at(-1)-(e-m*a))/w:0.5};}
function calcMFI(h,l,c,v,p=14){if(!h||h.length<p+1)return 50;let pf=0,nf=0;for(let i=h.length-p;i<h.length;i++){const tp=(h[i]+l[i]+c[i])/3;const pt=(h[i-1]+l[i-1]+c[i-1])/3;const mf=tp*v[i];if(tp>pt)pf+=mf;else nf+=mf;}if(nf===0)return 100;return 100-100/(1+pf/nf);}
function calcParabolicSAR(h,l,c){if(!h||h.length<3)return{trend:'BUY',recentFlip:false};let t='BUY',af=.02,ep=h[0],sar=l[0],ps=sar;for(let i=1;i<h.length;i++){ps=sar;sar+=af*(ep-sar);if(t==='BUY'){if(l[i]<sar){t='SELL';sar=ep;ep=l[i];af=.02;}else if(h[i]>ep){ep=h[i];af=Math.min(af+.02,.2);}}else{if(h[i]>sar){t='BUY';sar=ep;ep=h[i];af=.02;}else if(l[i]<ep){ep=l[i];af=Math.min(af+.02,.2);}}}return{trend:t,recentFlip:Math.abs(sar-ps)/(c.at(-1)||1)>.003};}

function fetchJSON(url){return new Promise((r,j)=>{https.get(url,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}
async function getKlines(s,i,l,e){try{return await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${s}&interval=${i}&limit=${l}${e?'&endTime='+e:''}`);}catch(e){return null;}}

// ═══ HTF TREND ═══
function getHTFTrend(C1h,H1h,L1h,V1h){
  if(!C1h||C1h.length<26)return'NEUTRAL';
  const e9=calcEMA(C1h,9),e21=calcEMA(C1h,21),e50=calcEMA(C1h,50);
  const rsi=calcRSI(C1h,14);const mac=calcMACD(C1h);const adx=calcADX(H1h,L1h,C1h);const obv=calcOBV(C1h,V1h);
  let hB=0,hS=0;
  if(e9>e21)hB+=2;else hS+=2;if(C1h.at(-1)>e50)hB++;else hS++;
  if(mac.h>0)hB+=1.5;else hS+=1.5;if(rsi>50)hB++;else hS++;
  if(adx.adx>20&&adx.pdi>adx.mdi)hB+=1.5;else if(adx.adx>20)hS+=1.5;
  if(obv.rising)hB++;else hS++;
  if(hB>hS+2)return'BUY';if(hS>hB+2)return'SELL';return'NEUTRAL';
}

// ═══ 15m CONFIRM ═══
function get15mConfirm(C15){
  if(!C15||C15.length<26)return'NEUTRAL';
  const e9=calcEMA(C15,9),e21=calcEMA(C15,21);const mac=calcMACD(C15);
  let mB=0,mS=0;if(e9>e21)mB++;else mS++;if(mac.h>0)mB++;else mS++;
  if(mB>mS)return'BUY';if(mS>mB)return'SELL';return'NEUTRAL';
}

// ═══ SCALP SIGNAL (exact v9 from app.html) ═══
function genScalpSignal(kl5,kl15,kl1h){
  if(!kl5||kl5.length<100)return null;
  const C=kl5.map(k=>parseFloat(k[4])),H=kl5.map(k=>parseFloat(k[2])),L=kl5.map(k=>parseFloat(k[3])),V=kl5.map(k=>parseFloat(k[5]));
  const C15=kl15?kl15.map(k=>parseFloat(k[4])):[];
  const C1h=kl1h&&kl1h.length>15?kl1h.map(k=>parseFloat(k[4])):[];
  const H1h=kl1h&&kl1h.length>15?kl1h.map(k=>parseFloat(k[2])):[];
  const L1h=kl1h&&kl1h.length>15?kl1h.map(k=>parseFloat(k[3])):[];
  const V1h=kl1h&&kl1h.length>15?kl1h.map(k=>parseFloat(k[5])):[];
  const cur=C.at(-1);
  const mtf=get15mConfirm(C15);
  const htf=getHTFTrend(C1h,H1h,L1h,V1h);
  const adxD=calcADX(H,L,C);

  const rsi=calcRSI(C,7);const mac=calcMACD(C);
  const e5=calcEMAArr(C,5).at(-1),e13=calcEMAArr(C,13).at(-1);
  const bb=calcBB(C,10,1.8);const bbR=bb.u-bb.l;const bbP=bbR>0?(cur-bb.l)/bbR:0.5;
  const vwap=calcVWAP(kl5.slice(-50)).at(-1);
  const avgV=V.slice(-20).reduce((a,b)=>a+b)/20,vr=V.at(-1)/avgV;
  const st=calcStoch(H,L,C,7);const stK=st.k||50,stD=st.d||50;
  const psar=calcParabolicSAR(H,L,C);
  const kc=calcKeltner(H,L,C,20,14,2);
  const mfi=calcMFI(H,L,C,V,7);

  let bS=0,sS=0,bI=0,sI=0;
  if(rsi<25){bS+=3;bI++;}else if(rsi<40){bS+=2;bI++;}else if(rsi<48){bS+=1;bI++;}
  else if(rsi>75){sS+=3;sI++;}else if(rsi>60){sS+=2;sI++;}else if(rsi>52){sS+=1;sI++;}
  if(stK<25){bS+=3;bI++;if(stK>stD&&stK<35)bS+=1;}else if(stK<40){bS+=1.5;bI++;}
  else if(stK>75){sS+=3;sI++;if(stK<stD&&stK>65)sS+=1;}else if(stK>60){sS+=1.5;sI++;}
  if(bbP<0.08){bS+=3;bI++;}else if(bbP<0.25){bS+=2;bI++;}
  else if(bbP>0.92){sS+=3;sI++;}else if(bbP>0.75){sS+=2;sI++;}
  if(mac.h>0&&mac.ph<=0){bS+=2.5;bI++;}else if(mac.h<0&&mac.ph>=0){sS+=2.5;sI++;}
  else if(mac.h>0)bS+=0.5;else sS+=0.5;
  if(e5>e13){bS+=1.5;bI++;}else{sS+=1.5;sI++;}
  if(vwap&&cur<vwap){bS+=1;bI++;}else if(vwap&&cur>vwap){sS+=1;sI++;}
  if(vr>1.5){if(rsi<50){bS+=2;bI++;}else{sS+=2;sI++;}}
  if(kc.position<0.25){bS+=1.5;bI++;}else if(kc.position>0.75){sS+=1.5;sI++;}
  if(psar.trend==='BUY'){bS+=1;bI++;}else{sS+=1;sI++;}
  if(mfi<35){bS+=1.5;bI++;}else if(mfi>65){sS+=1.5;sI++;}

  let sig='NEUTRAL',score=0;
  if(mtf==='BUY'&&bS>=6&&bI>=4){sig='BUY';score=bS;}
  else if(mtf==='SELL'&&sS>=6&&sI>=4){sig='SELL';score=sS;}
  else if(mtf==='NEUTRAL'){
    if(bS>=6&&bI>=4&&bS>sS+1){sig='BUY';score=bS;}
    else if(sS>=6&&sI>=4&&sS>bS+1){sig='SELL';score=sS;}
  }
  if(sig==='NEUTRAL'){
    if(bS>=7&&bI>=5&&bS>sS+2){sig='BUY';score=bS;}
    else if(sS>=7&&sI>=5&&sS>bS+2){sig='SELL';score=sS;}
  }
  if(sig==='NEUTRAL')return null;
  let conf=Math.round(50+(score/22)*40);if(mtf===sig)conf+=3;if(htf===sig)conf+=5;conf=Math.min(90,conf);
  if(conf<60)return null;
  const atr=calcATR(H,L,C,7)||calcATR(H,L,C,14);
  return{signal:sig,conf,entry:cur,atr,tpMult:2.0,slMult:1.0};
}

// ═══ VIP PRECISION SIGNAL (exact v9 — same as scalp but HTF gate + higher thresholds) ═══
function genVIPSignal(kl5,kl15,kl1h){
  if(!kl5||kl5.length<100)return null;
  const C=kl5.map(k=>parseFloat(k[4])),H=kl5.map(k=>parseFloat(k[2])),L=kl5.map(k=>parseFloat(k[3])),V=kl5.map(k=>parseFloat(k[5]));
  const C15=kl15?kl15.map(k=>parseFloat(k[4])):[];
  const C1h=kl1h&&kl1h.length>15?kl1h.map(k=>parseFloat(k[4])):[];
  const H1h=kl1h&&kl1h.length>15?kl1h.map(k=>parseFloat(k[2])):[];
  const L1h=kl1h&&kl1h.length>15?kl1h.map(k=>parseFloat(k[3])):[];
  const V1h=kl1h&&kl1h.length>15?kl1h.map(k=>parseFloat(k[5])):[];
  const cur=C.at(-1);
  const mtf=get15mConfirm(C15);
  const htf=getHTFTrend(C1h,H1h,L1h,V1h);
  const adxD=calcADX(H,L,C);

  // Same 10 indicators as scalp
  const rsi=calcRSI(C,7);const mac=calcMACD(C);
  const e5=calcEMAArr(C,5).at(-1),e13=calcEMAArr(C,13).at(-1);
  const bb=calcBB(C,10,1.8);const bbR=bb.u-bb.l;const bbP=bbR>0?(cur-bb.l)/bbR:0.5;
  const vwap=calcVWAP(kl5.slice(-50)).at(-1);
  const avgV=V.slice(-20).reduce((a,b)=>a+b)/20,vr=V.at(-1)/avgV;
  const st=calcStoch(H,L,C,7);const stK=st.k||50,stD=st.d||50;
  const psar=calcParabolicSAR(H,L,C);
  const kc=calcKeltner(H,L,C,20,14,2);
  const mfi=calcMFI(H,L,C,V,7);

  let bS=0,sS=0,bI=0,sI=0;
  if(rsi<25){bS+=3;bI++;}else if(rsi<40){bS+=2;bI++;}else if(rsi<48){bS+=1;bI++;}
  else if(rsi>75){sS+=3;sI++;}else if(rsi>60){sS+=2;sI++;}else if(rsi>52){sS+=1;sI++;}
  if(stK<25){bS+=3;bI++;if(stK>stD&&stK<35)bS+=1;}else if(stK<40){bS+=1.5;bI++;}
  else if(stK>75){sS+=3;sI++;if(stK<stD&&stK>65)sS+=1;}else if(stK>60){sS+=1.5;sI++;}
  if(bbP<0.08){bS+=3;bI++;}else if(bbP<0.25){bS+=2;bI++;}
  else if(bbP>0.92){sS+=3;sI++;}else if(bbP>0.75){sS+=2;sI++;}
  if(mac.h>0&&mac.ph<=0){bS+=2.5;bI++;}else if(mac.h<0&&mac.ph>=0){sS+=2.5;sI++;}
  else if(mac.h>0)bS+=0.5;else sS+=0.5;
  if(e5>e13){bS+=1.5;bI++;}else{sS+=1.5;sI++;}
  if(vwap&&cur<vwap){bS+=1;bI++;}else if(vwap&&cur>vwap){sS+=1;sI++;}
  if(vr>1.5){if(rsi<50){bS+=2;bI++;}else{sS+=2;sI++;}}
  if(kc.position<0.25){bS+=1.5;bI++;}else if(kc.position>0.75){sS+=1.5;sI++;}
  if(psar.trend==='BUY'){bS+=1;bI++;}else{sS+=1;sI++;}
  if(mfi<35){bS+=1.5;bI++;}else if(mfi>65){sS+=1.5;sI++;}

  let sig='NEUTRAL',score=0;
  // HTF gate OBLIGATORIO — solo opera en dirección de 1H
  if(htf==='BUY'&&bS>=7&&bI>=5){sig='BUY';score=bS;}
  else if(htf==='SELL'&&sS>=7&&sI>=5){sig='SELL';score=sS;}
  // HTF neutral: score +2 extra
  else if(htf==='NEUTRAL'){
    if(bS>=9&&bI>=5&&bS>sS+2){sig='BUY';score=bS;}
    else if(sS>=9&&sI>=5&&sS>bS+2){sig='SELL';score=sS;}
  }
  if(sig==='NEUTRAL')return null;
  let conf=Math.round(60+(score/22)*33);if(htf===sig)conf+=5;if(mtf===sig)conf+=3;conf=Math.min(95,conf);
  if(conf<60)return null;

  const H15=kl15?kl15.map(k=>parseFloat(k[2])):[];const L15=kl15?kl15.map(k=>parseFloat(k[3])):[];
  let atr15=calcATR(H,L,C,14);
  if(H15.length>15){const a=calcATR(H15,L15,C15,14);if(a>0)atr15=a;}
  let atr1h=atr15;if(H1h.length>15){const a=calcATR(H1h,L1h,C1h,14);if(a>0)atr1h=a;}
  const useATR=Math.max(atr15,atr1h/4);
  return{signal:sig,conf,entry:cur,atr:useATR,tpMult:2.5,slMult:1.0};
}

// ═══ DOWNLOAD DATA ═══
async function downloadData(symbols){
  const end=Date.now(),start=end-DAYS*864e5;const data={};
  for(const sym of symbols){
    process.stdout.write(`  ${sym}...`);
    let k5=[],k15=[],k1h=[];
    let fe=end;
    while(true){const b=await getKlines(sym,'5m',1000,fe);if(!b||!b.length)break;k5=b.concat(k5);if(b[0][0]<=start)break;fe=b[0][0]-1;await new Promise(r=>setTimeout(r,80));}
    fe=end;while(true){const b=await getKlines(sym,'15m',1000,fe);if(!b||!b.length)break;k15=b.concat(k15);if(b[0][0]<=start)break;fe=b[0][0]-1;await new Promise(r=>setTimeout(r,80));}
    const b1h=await getKlines(sym,'1h',1000,end);if(b1h)k1h=b1h;
    await new Promise(r=>setTimeout(r,80));
    k5=k5.filter(k=>k[0]>=start);
    console.log(` ${k5.length} bars`);
    data[sym]={k5,k15,k1h};
  }
  return data;
}

// ═══ BACKTEST ONE SYMBOL ═══
function testSymbol(sym,data,mode,cdBars){
  const{k5,k15,k1h}=data;
  const cdMs=cdBars*5*6e4;
  let w=0,l=0,pnl=0,gp=0,gl=0,lastSig=0;
  const lb5=280,lb15=100,lb1h=50;

  for(let i=lb5;i<k5.length;i++){
    const t=k5[i][0];
    if(t-lastSig<cdMs)continue;
    const w5=k5.slice(Math.max(0,i-lb5),i+1);
    const w15=k15.filter(k=>k[0]<=t).slice(-lb15);
    const w1h=k1h.filter(k=>k[0]<=t).slice(-lb1h);

    const sig=mode==='scalp'?genScalpSignal(w5,w15,w1h):genVIPSignal(w5,w15,w1h);
    if(!sig)continue;
    lastSig=t;

    const entry=sig.entry;
    const tpD=sig.atr*sig.tpMult,slD=sig.atr*sig.slMult;
    const cb=entry*0.0008;
    const tp=sig.signal==='BUY'?entry+tpD+cb:entry-tpD-cb;
    const sl=sig.signal==='BUY'?entry-slD-cb:entry+slD+cb;

    let res=null,exit=entry;
    for(let j=i+1;j<k5.length&&j<i+600;j++){
      const cH=parseFloat(k5[j][2]),cL=parseFloat(k5[j][3]);
      if(sig.signal==='BUY'){if(cH>=tp){res='W';exit=tp;break;}if(cL<=sl){res='L';exit=sl;break;}}
      else{if(cL<=tp){res='W';exit=tp;break;}if(cH>=sl){res='L';exit=sl;break;}}
    }
    if(!res)continue;

    const pct=sig.signal==='BUY'?(exit-entry)/entry:(entry-exit)/entry;
    const p=TRADE_AMT*LEV*pct;
    pnl+=p;
    if(p>0){gp+=p;w++;}else{gl+=Math.abs(p);l++;}
  }
  return{sym,w,l,total:w+l,wr:w+l>0?(w/(w+l)*100):0,pnl,gp,gl,pf:gl>0?gp/gl:0,avgW:w>0?gp/w:0,avgL:l>0?gl/l:0,sigDay:(w+l)/DAYS};
}

// ═══ MAIN ═══
(async()=>{
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║  BACKTEST v9 FINAL — 150 DÍAS REALES BINANCE      ║');
  console.log('║  Scalp (TP2.0/SL1.0) + VIP Precision (TP2.5/SL1.0)║');
  console.log('║  Evaluación por par para eliminar los peores       ║');
  console.log('╚═══════════════════════════════════════════════════╝\n');

  const ALL_SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','ADAUSDT','SUIUSDT','ARBUSDT','OPUSDT','DOTUSDT','UNIUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT','TIAUSDT','ATOMUSDT','XRPUSDT','AVAXUSDT'];
  const VIP_SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];

  console.log('  Descargando 150 días de datos para',ALL_SYMS.length,'pares...\n');
  const data=await downloadData(ALL_SYMS);

  // ═══ SCALP — PER SYMBOL ═══
  console.log('\n═══ SCALP MODE — POR PAR (cd=12 bars) ═══');
  console.log(`${'PAR'.padEnd(10)} ${'Sigs'.padStart(6)} ${'S/D'.padStart(6)} ${'W'.padStart(5)} ${'L'.padStart(5)} ${'WR%'.padStart(7)} ${'PF'.padStart(6)} ${'PnL$'.padStart(9)} ${'AvgW$'.padStart(8)} ${'AvgL$'.padStart(8)}`);
  console.log('─'.repeat(78));

  const scalpResults=[];
  for(const sym of ALL_SYMS){
    const r=testSymbol(sym,data[sym],'scalp',12);
    scalpResults.push(r);
    const c=r.pnl>=0?'+':'';
    console.log(`${r.sym.replace('USDT','').padEnd(10)} ${String(r.total).padStart(6)} ${r.sigDay.toFixed(1).padStart(6)} ${String(r.w).padStart(5)} ${String(r.l).padStart(5)} ${r.wr.toFixed(1).padStart(6)}% ${r.pf.toFixed(2).padStart(6)} ${(c+'$'+Math.abs(r.pnl).toFixed(0)).padStart(9)} ${('$'+r.avgW.toFixed(2)).padStart(8)} ${('$'+r.avgL.toFixed(2)).padStart(8)}`);
  }

  // Totals
  const sT=scalpResults.reduce((a,r)=>({w:a.w+r.w,l:a.l+r.l,pnl:a.pnl+r.pnl,gp:a.gp+r.gp,gl:a.gl+r.gl}),{w:0,l:0,pnl:0,gp:0,gl:0});
  console.log('─'.repeat(78));
  console.log(`${'TOTAL'.padEnd(10)} ${String(sT.w+sT.l).padStart(6)} ${((sT.w+sT.l)/DAYS).toFixed(1).padStart(6)} ${String(sT.w).padStart(5)} ${String(sT.l).padStart(5)} ${(sT.w/(sT.w+sT.l)*100).toFixed(1).padStart(6)}% ${(sT.gp/sT.gl).toFixed(2).padStart(6)} ${((sT.pnl>=0?'+':'')+('$'+Math.abs(sT.pnl).toFixed(0))).padStart(9)}`);

  // Identify losers
  const scalpLosers=scalpResults.filter(r=>r.pnl<0||r.pf<0.9).sort((a,b)=>a.pnl-b.pnl);
  console.log('\n  ✗ PARES A ELIMINAR (PnL negativo o PF < 0.9):');
  scalpLosers.forEach(r=>console.log(`    ${r.sym.replace('USDT','')}: PnL $${r.pnl.toFixed(0)}, PF ${r.pf.toFixed(2)}, WR ${r.wr.toFixed(1)}%`));

  const scalpWinners=scalpResults.filter(r=>r.pnl>0&&r.pf>=0.9).sort((a,b)=>b.pnl-a.pnl);
  console.log('\n  ★ PARES RENTABLES (ordenados por PnL):');
  scalpWinners.forEach(r=>console.log(`    ${r.sym.replace('USDT','')}: PnL +$${r.pnl.toFixed(0)}, PF ${r.pf.toFixed(2)}, WR ${r.wr.toFixed(1)}%, ${r.sigDay.toFixed(1)} sig/d`));

  // Recalculate with only winners
  const wT=scalpWinners.reduce((a,r)=>({w:a.w+r.w,l:a.l+r.l,pnl:a.pnl+r.pnl,gp:a.gp+r.gp,gl:a.gl+r.gl}),{w:0,l:0,pnl:0,gp:0,gl:0});
  console.log(`\n  ★ SCALP SOLO GANADORES (${scalpWinners.length} pares):`);
  console.log(`    PnL: +$${wT.pnl.toFixed(0)} | WR: ${(wT.w/(wT.w+wT.l)*100).toFixed(1)}% | PF: ${(wT.gp/wT.gl).toFixed(2)} | Sig/day: ${((wT.w+wT.l)/DAYS).toFixed(1)}`);

  // ═══ VIP PRECISION — PER SYMBOL ═══
  console.log('\n═══ VIP PRECISION MODE — POR PAR (cd=36 bars) ═══');
  console.log(`${'PAR'.padEnd(10)} ${'Sigs'.padStart(6)} ${'S/D'.padStart(6)} ${'W'.padStart(5)} ${'L'.padStart(5)} ${'WR%'.padStart(7)} ${'PF'.padStart(6)} ${'PnL$'.padStart(9)} ${'AvgW$'.padStart(8)} ${'AvgL$'.padStart(8)}`);
  console.log('─'.repeat(78));

  const vipResults=[];
  for(const sym of VIP_SYMS){
    const r=testSymbol(sym,data[sym],'strict',36);
    vipResults.push(r);
    const c=r.pnl>=0?'+':'';
    console.log(`${r.sym.replace('USDT','').padEnd(10)} ${String(r.total).padStart(6)} ${r.sigDay.toFixed(1).padStart(6)} ${String(r.w).padStart(5)} ${String(r.l).padStart(5)} ${r.wr.toFixed(1).padStart(6)}% ${r.pf.toFixed(2).padStart(6)} ${(c+'$'+Math.abs(r.pnl).toFixed(0)).padStart(9)} ${('$'+r.avgW.toFixed(2)).padStart(8)} ${('$'+r.avgL.toFixed(2)).padStart(8)}`);
  }

  const vT=vipResults.reduce((a,r)=>({w:a.w+r.w,l:a.l+r.l,pnl:a.pnl+r.pnl,gp:a.gp+r.gp,gl:a.gl+r.gl}),{w:0,l:0,pnl:0,gp:0,gl:0});
  console.log('─'.repeat(78));
  console.log(`${'TOTAL'.padEnd(10)} ${String(vT.w+vT.l).padStart(6)} ${((vT.w+vT.l)/DAYS).toFixed(1).padStart(6)} ${String(vT.w).padStart(5)} ${String(vT.l).padStart(5)} ${(vT.w/(vT.w+vT.l)*100).toFixed(1).padStart(6)}% ${(vT.gp/vT.gl).toFixed(2).padStart(6)} ${((vT.pnl>=0?'+':'')+('$'+Math.abs(vT.pnl).toFixed(0))).padStart(9)}`);

  const vipLosers=vipResults.filter(r=>r.pnl<0);
  if(vipLosers.length>0){
    console.log('\n  ✗ VIP PARES A ELIMINAR:');
    vipLosers.forEach(r=>console.log(`    ${r.sym.replace('USDT','')}: PnL $${r.pnl.toFixed(0)}, PF ${r.pf.toFixed(2)}`));
  }

  // ═══ FINAL SUMMARY ═══
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  RESUMEN FINAL');
  console.log(`${'═'.repeat(60)}`);
  console.log(`  SCALP: ${scalpWinners.map(r=>r.sym.replace('USDT','')).join(', ')}`);
  console.log(`  VIP:   ${vipResults.filter(r=>r.pnl>0).map(r=>r.sym.replace('USDT','')).join(', ') || 'Todos'}`);
  console.log(`\n  Aplicar estos pares a SCALP_SCAN_SYMS y VIP_SCAN_SYMS en app.html`);
  console.log(`${'═'.repeat(60)}\n`);
})();
