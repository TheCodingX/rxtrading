#!/usr/bin/env node
// Validation backtest for v4 improvements
const https = require('https');

const VIP_SCAN_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','AVAXUSDT','ADAUSDT','DOTUSDT','LINKUSDT','APTUSDT','NEARUSDT','FILUSDT','UNIUSDT','ARBUSDT','OPUSDT','SHIBUSDT','SUIUSDT','SEIUSDT','TIAUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT'];
const SCALP_SCAN_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','DOTUSDT','NEARUSDT','APTUSDT','ARBUSDT','OPUSDT','SUIUSDT','SEIUSDT','FILUSDT','UNIUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT','TIAUSDT','ATOMUSDT'];
const PUB_SCAN_SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];

function calcRSI(c,p=14){if(c.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}if(al===0)return 100;return 100-(100/(1+ag/al));}
function calcEMAArr(d,p){const k=2/(p+1);const r=[d[0]];for(let i=1;i<d.length;i++)r.push(d[i]*k+r[i-1]*(1-k));return r;}
function calcEMA(d,p){return calcEMAArr(d,p).at(-1);}
function calcMACD(c){if(c.length<35)return{h:0,ph:0};const e12=calcEMAArr(c,12),e26=calcEMAArr(c,26);const ml=e12.map((v,i)=>v-e26[i]);const sl=calcEMAArr(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1))};}
function calcBB(c,p=20,s=2){if(c.length<p)return{u:0,m:0,l:0};const sl=c.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+s*sd,m,l:m-s*sd};}
function calcStoch(H,L,C,kp=14){if(C.length<kp+3)return{k:50};const kA=[];for(let i=kp;i<=C.length;i++){const sh=H.slice(i-kp,i),sl=L.slice(i-kp,i);const hi=Math.max(...sh),lo=Math.min(...sl);kA.push(hi===lo?50:((C[i-1]-lo)/(hi-lo))*100);}return{k:kA.at(-1)||50};}
function calcATR(H,L,C,p=14){if(C.length<p+1)return 0;const t=[];for(let i=1;i<C.length;i++)t.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));if(t.length<p)return t.reduce((a,b)=>a+b)/t.length;let a=t.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<t.length;i++)a=(a*(p-1)+t[i])/p;return a;}
function calcADX(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pd=[],md=[],tr=[];for(let i=1;i<H.length;i++){const u=H[i]-H[i-1],d=L[i-1]-L[i];pd.push(u>d&&u>0?u:0);md.push(d>u&&d>0?d:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}function ws(a,pp){if(a.length<pp)return a.map(()=>0);const r=[];let s=a.slice(0,pp).reduce((a,b)=>a+b)/pp;for(let i=0;i<pp;i++)r.push(0);r[pp-1]=s;for(let i=pp;i<a.length;i++){s=(s*(pp-1)+a[i])/pp;r.push(s);}return r;}const sT=ws(tr,p),sP=ws(pd,p),sM=ws(md,p);const pi=sP.map((v,i)=>sT[i]?v/sT[i]*100:0);const mi=sM.map((v,i)=>sT[i]?v/sT[i]*100:0);const dx=pi.map((v,i)=>{const s=v+mi[i];return s?Math.abs(v-mi[i])/s*100:0;});const dV=dx.slice(p-1);const aA=dV.length>=p?ws(dV,p):dV;return{adx:aA.at(-1)||15,pdi:pi.at(-1)||0,mdi:mi.at(-1)||0};}
function calcOBV(C,V){if(C.length<2)return{rising:false};let o=0;const a=[0];for(let i=1;i<C.length;i++){if(C[i]>C[i-1])o+=V[i];else if(C[i]<C[i-1])o-=V[i];a.push(o);}const n=Math.min(a.length,20);const r=a.slice(-n);let sX=0,sY=0,sXY=0,sX2=0;for(let i=0;i<n;i++){sX+=i;sY+=r[i];sXY+=i*r[i];sX2+=i*i;}return{rising:(n*sXY-sX*sY)/(n*sX2-sX*sX||1)>0};}
function detectRegime(H,L,C,ax,at){const l=Math.min(C.length,20);const ap=C.slice(-l).reduce((a,b)=>a+b)/l;const aP=at/ap*100;if(ax.adx>25&&aP>1.5)return'TRENDING';if(ax.adx<20&&aP<0.8)return'QUIET';if(aP>2)return'VOLATILE';return'RANGING';}
function calcKeltner(H,L,C,eL=20,aL=14,m=2){if(C.length<Math.max(eL,aL)+1)return{position:0.5};const mid=calcEMA(C,eL);const at=calcATR(H,L,C,aL);const u=mid+m*at,lo=mid-m*at;const r=u-lo;return{position:r>0?(C.at(-1)-lo)/r:0.5};}

function fetchKlines(sym,itv,lim,st){return new Promise((res,rej)=>{let u=`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${itv}&limit=${lim}`;if(st)u+=`&startTime=${st}`;https.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const p=JSON.parse(d);if(p.code)rej(new Error(p.msg));else res(p);}catch(e){rej(e);}});}).on('error',rej);});}
async function fetchAll(sym,itv,total){const a=[];const ms={'5m':3e5,'15m':9e5,'1h':36e5}[itv]||3e5;let st=Date.now()-total*ms;while(a.length<total){const l=Math.min(total-a.length,1000);try{const d=await fetchKlines(sym,itv,l,st);if(!Array.isArray(d)||!d.length)break;a.push(...d);st=d[d.length-1][0]+ms;}catch(e){break;}await new Promise(r=>setTimeout(r,120));}return a;}

function genSig(C5,H5,L5,V5,C15,H15,L15,C1h,H1h,L1h,T5,mode,sym){
  const isStrict=mode==='strict',isScalp=mode==='scalp';
  if(!C5||C5.length<100)return null;
  const C=C5,H=H5,L=L5,V=V5,cur=C.at(-1);
  const rsi=calcRSI(C),mac=calcMACD(C),bb=calcBB(C),st=calcStoch(H,L,C),atr=calcATR(H,L,C);
  const adx=calcADX(H,L,C),obv=calcOBV(C,V),e9=calcEMA(C,9),e21=calcEMA(C,21);
  const e50=C.length>=50?calcEMA(C,50):e21;
  const e9p=C.length>10?calcEMA(C.slice(0,-1),9):e9;
  const vS=V.slice(-20),aV=vS.reduce((a,b)=>a+b)/vS.length,vr=aV>0?V.at(-1)/aV:1;
  const reg=detectRegime(H,L,C,adx,atr);
  const isTrending=reg==='TRENDING',isVolatile=reg==='VOLATILE';
  const kc=calcKeltner(H,L,C);
  
  let htf='NEUTRAL';
  if(C1h&&C1h.length>25){const e9h=calcEMA(C1h,9),e21h=calcEMA(C1h,21);const e50h=C1h.length>=50?calcEMA(C1h,50):e21h;const r1h=calcRSI(C1h);const m1h=calcMACD(C1h);const a1h=calcADX(H1h,L1h,C1h);let hB=0,hS=0;if(e9h>e21h)hB+=2;else hS+=2;if(C1h.at(-1)>e50h)hB+=1;else hS+=1;if(m1h.h>0)hB+=1.5;else hS+=1.5;if(m1h.h>m1h.ph)hB+=1;else hS+=1;if(r1h>50)hB+=1;else hS+=1;if(a1h.adx>20&&a1h.pdi>a1h.mdi)hB+=1.5;else if(a1h.adx>20)hS+=1.5;if(hB>hS+2)htf='BUY';else if(hS>hB+2)htf='SELL';}
  
  let mtf='NEUTRAL';
  if(C15&&C15.length>25){const e9_15=calcEMA(C15,9),e21_15=calcEMA(C15,21);const m15=calcMACD(C15);const r15=calcRSI(C15);let mB=0,mS=0;if(e9_15>e21_15)mB+=1;else mS+=1;if(m15.h>0)mB+=1;else mS+=1;if(r15>50)mB+=0.5;else if(r15<50)mS+=0.5;if(mB>mS)mtf='BUY';else if(mS>mB)mtf='SELL';}

  let B=0,S=0,bI=0,sI=0;
  const hU=new Date(T5.at(-1)).getUTCHours();
  const dayOfWeek=new Date(T5.at(-1)).getUTCDay();

  if(isStrict&&!isTrending){
    // VIP MEAN-REVERSION v4
    if(rsi<25){B+=4;bI++;}else if(rsi<30){B+=3;bI++;}else if(rsi<35){B+=2;bI++;}
    else if(rsi>75){S+=4;sI++;}else if(rsi>70){S+=3;sI++;}else if(rsi>65){S+=2;sI++;}
    if(st.k<20){B+=3;bI++;}else if(st.k<30){B+=2;bI++;}
    else if(st.k>80){S+=3;sI++;}else if(st.k>70){S+=2;sI++;}
    const bbR=bb.u-bb.l,bbP=bbR>0?(cur-bb.l)/bbR:0.5;
    if(bbP<0.1){B+=3;bI++;}else if(bbP<0.2){B+=2;bI++;}
    else if(bbP>0.9){S+=3;sI++;}else if(bbP>0.8){S+=2;sI++;}
    const m3=(cur-(C[C.length-4]||cur))/Math.max(atr,1e-4);
    if(m3<-1){B+=2;bI++;}else if(m3<-0.5){B+=1;bI++;}
    else if(m3>1){S+=2;sI++;}else if(m3>0.5){S+=1;sI++;}
    let bR=0,buR=0;for(let ci=Math.max(0,C.length-4);ci<C.length;ci++){if(C[ci]<(C[ci-1]||C[ci]))bR++;else bR=0;if(C[ci]>(C[ci-1]||C[ci]))buR++;else buR=0;}
    if(bR>=4){B+=2;bI++;}else if(bR>=3){B+=1;bI++;}
    if(buR>=4){S+=2;sI++;}else if(buR>=3){S+=1;sI++;}
    const eD=(cur-e21)/Math.max(atr,1e-4);
    if(eD<-1.5){B+=1.5;bI++;}else if(eD<-0.8){B+=0.8;bI++;}
    else if(eD>1.5){S+=1.5;sI++;}else if(eD>0.8){S+=0.8;sI++;}
    if(mac.h>0&&mac.ph<=0){B+=1.5;bI++;}else if(mac.h<0&&mac.ph>=0){S+=1.5;sI++;}
    if(obv.rising&&B>S){B+=1;bI++;}else if(!obv.rising&&S>B){S+=1;sI++;}
    if(vr>1.5){if(B>S)B*=1.15;else S*=1.15;}
    // Keltner
    if(kc.position<0.05){B+=2;bI++;}else if(kc.position<0.15){B+=1;bI++;}
    else if(kc.position>0.95){S+=2;sI++;}else if(kc.position>0.85){S+=1;sI++;}
  } else if(isScalp){
    // SCALP v4 — wider thresholds
    if(rsi<25){B+=4;bI++;}else if(rsi<30){B+=3;bI++;}else if(rsi<38){B+=2;bI++;}else if(rsi<45){B+=1;bI++;}
    else if(rsi>75){S+=4;sI++;}else if(rsi>70){S+=3;sI++;}else if(rsi>62){S+=2;sI++;}else if(rsi>55){S+=1;sI++;}
    if(st.k<20){B+=3;bI++;}else if(st.k<35){B+=1.5;bI++;}
    else if(st.k>80){S+=3;sI++;}else if(st.k>65){S+=1.5;sI++;}
    const bbR=bb.u-bb.l,bbP=bbR>0?(cur-bb.l)/bbR:0.5;
    if(bbP<0.1){B+=3;bI++;}else if(bbP<0.25){B+=2;bI++;}
    else if(bbP>0.9){S+=3;sI++;}else if(bbP>0.75){S+=2;sI++;}
    const m3=(cur-(C[C.length-4]||cur))/Math.max(atr,1e-4);
    if(m3<-0.8){B+=2;bI++;}else if(m3<-0.3){B+=1;bI++;}
    else if(m3>0.8){S+=2;sI++;}else if(m3>0.3){S+=1;sI++;}
    const l4=C.slice(-4);
    const bExh=l4.length>=4&&l4.every((x,i)=>i===0||x<l4[i-1]);
    const buExh=l4.length>=4&&l4.every((x,i)=>i===0||x>l4[i-1]);
    if(bExh){B+=2;bI++;}else if(buExh){S+=2;sI++;}
    else{const l3=C.slice(-3);if(l3.length>=3&&l3.every((x,i)=>i===0||x<l3[i-1])){B+=1;bI++;}else if(l3.length>=3&&l3.every((x,i)=>i===0||x>l3[i-1])){S+=1;sI++;}}
    const eD=(cur-e21)/Math.max(atr,1e-4);
    if(eD<-1.2){B+=1.5;bI++;}else if(eD<-0.6){B+=0.8;bI++;}
    else if(eD>1.2){S+=1.5;sI++;}else if(eD>0.6){S+=0.8;sI++;}
    if(mac.h>0&&mac.ph<0){S+=1;sI++;}else if(mac.h<0&&mac.ph>0){B+=1;bI++;}
    else if(mac.h>0&&mac.h>mac.ph){S+=0.5;sI++;}else if(mac.h<0&&mac.h<mac.ph){B+=0.5;bI++;}
    if(obv.rising&&B>S){B+=0.8;bI++;}else if(!obv.rising&&S>B){S+=0.8;sI++;}
    if(kc.position<0.05){B+=1.5;bI++;}else if(kc.position<0.2){B+=0.8;bI++;}
    else if(kc.position>0.95){S+=1.5;sI++;}else if(kc.position>0.8){S+=0.8;sI++;}
    if(vr>1.5){if(B>S)B*=1.15;else S*=1.15;}
  } else {
    // FREE (unchanged)
    if(rsi<28){B+=3;bI++;}else if(rsi<35){B+=2;bI++;}else if(rsi<40){B+=1;bI++;}
    else if(rsi>72){S+=3;sI++;}else if(rsi>65){S+=2;sI++;}else if(rsi>60){S+=1;sI++;}
    const fS=st.k||50;if(fS<25){B+=2;bI++;}else if(fS<35){B+=1;bI++;}else if(fS>75){S+=2;sI++;}else if(fS>65){S+=1;sI++;}
    const fR=bb.u-bb.l,fP=fR>0?(cur-bb.l)/fR:0.5;
    if(fP<0.15){B+=2;bI++;}else if(fP<0.25){B+=1;bI++;}else if(fP>0.85){S+=2;sI++;}else if(fP>0.75){S+=1;sI++;}
    const fM=(cur-(C[C.length-4]||cur))/Math.max(atr,1e-4);
    if(fM<-0.8){B+=1;bI++;}else if(fM>0.8){S+=1;sI++;}
    if(mac.h>0&&mac.ph<0){B+=1;bI++;}else if(mac.h<0&&mac.ph>0){S+=1;sI++;}
    if(obv.rising){B+=0.5;bI++;}else{S+=0.5;sI++;}
    if(vr>1.5&&B>S)B*=1.1;else if(vr>1.5&&S>B)S*=1.1;
  }

  let sig='NEUTRAL',conf=0;
  if(isStrict){
    if(!isTrending&&B>S&&B>=8&&bI>=3)sig='BUY';
    else if(!isTrending&&S>B&&S>=8&&sI>=3)sig='SELL';
    if(sig!=='NEUTRAL'&&adx.adx>20)sig='NEUTRAL';
    if(sig!=='NEUTRAL'&&!([6,7,20,23].includes(hU)))sig='NEUTRAL';
    if(sig!=='NEUTRAL'&&isVolatile)sig='NEUTRAL';
    if(sig!=='NEUTRAL'&&dayOfWeek===6)sig='NEUTRAL'; // Block Saturday
    if(sig!=='NEUTRAL'){const a15=C15&&C15.length>15?calcATR(H15,L15,C15):atr;if(a15/cur<0.0008)sig='NEUTRAL';}
    if(sig!=='NEUTRAL'){const cs=sig==='BUY'?B:S,cc=sig==='BUY'?bI:sI;conf=Math.min(90,Math.round(50+cs*2.5+cc*1.5));if(htf===sig)conf=Math.min(90,conf+5);if(mtf===sig)conf=Math.min(90,conf+3);}
  }else if(isScalp){
    if(B>S&&B>=5&&bI>=2)sig='BUY';
    else if(S>B&&S>=5&&sI>=2)sig='SELL';
    if(sig!=='NEUTRAL'&&adx.adx>22)sig='NEUTRAL';
    const maxC=Math.max(B,S);
    if(sig==='BUY'&&mtf==='SELL'&&maxC<7)sig='NEUTRAL';
    if(sig==='SELL'&&mtf==='BUY'&&maxC<7)sig='NEUTRAL';
    if(sig!=='NEUTRAL'&&![0,6,7,10,15,17,20,21,23].includes(hU))sig='NEUTRAL';
    if(sig!=='NEUTRAL'&&dayOfWeek===2)sig='NEUTRAL'; // Block Tuesday
    if(sig!=="NEUTRAL"&&(dayOfWeek===0||dayOfWeek===1||dayOfWeek===6))sig="NEUTRAL";
    if(sig!=="NEUTRAL"&&Math.max(B,S)<Math.min(B,S)*1.4)sig="NEUTRAL";
    if(sig!=='NEUTRAL'&&vr<0.3)sig='NEUTRAL';
    if(sig!=='NEUTRAL'){const cc=sig==='BUY'?bI:sI;conf=Math.min(88,Math.max(52,Math.round(48+maxC*2.5+cc*2)));if(htf===sig)conf=Math.min(88,conf+4);if(mtf===sig)conf=Math.min(88,conf+3);}
  }else{
    if(B>S&&B>=5&&bI>=2)sig='BUY';else if(S>B&&S>=5&&sI>=2)sig='SELL';
    if(sig!=='NEUTRAL'&&isTrending)sig='NEUTRAL';
    if(sig!=='NEUTRAL'&&isVolatile)sig='NEUTRAL';
    if(sig!=='NEUTRAL'&&adx.adx>30)sig='NEUTRAL';
    if(sig!=='NEUTRAL'&&!([6,10,18,20,21,23].includes(hU)))sig='NEUTRAL';
    if(sig!=='NEUTRAL'&&vr<0.4)sig='NEUTRAL';
    if(sig!=='NEUTRAL'){const cs=sig==='BUY'?B:S,cc=sig==='BUY'?bI:sI;conf=Math.min(75,Math.round(40+cs*2+cc*1.5));}
  }

  // TP/SL
  let a15=atr;if(C15&&C15.length>15){const a=calcATR(H15,L15,C15);if(a>0)a15=a;}
  let a1h=atr;if(C1h&&C1h.length>15){const a=calcATR(H1h,L1h,C1h);if(a>0)a1h=a;}
  const bATR=Math.max(a15,a1h/4);
  let tpD,slD;
  if(isScalp){tpD=(a15||bATR)*1.3;slD=(a15||bATR)*1.0;}
  else if(isStrict){tpD=bATR*1.5;slD=bATR*1.0;}
  else{tpD=bATR*1.5;slD=bATR*1.0;}
  if(isScalp){const m=cur*0.0015;if(tpD<m)tpD=m;if(slD<m)slD=m;}
  else{const m=cur*0.0012;if(tpD<m)tpD=m;if(slD<m*0.67)slD=m*0.67;}
  if(!isStrict&&!isScalp&&tpD<slD*1.2)tpD=slD*1.2;
  const cb=cur*0.0008;
  let tp,sl;
  if(sig==='BUY'){tp=cur+tpD+cb;sl=cur-slD-cb;}
  else if(sig==='SELL'){tp=cur-tpD-cb;sl=cur+slD+cb;}
  return{signal:sig,confidence:conf,entry:cur,tp,sl,tpD,slD,B,S,bI,sI,regime:reg,hU,adx:adx.adx,rsi,atr:bATR,dayOfWeek};
}

function simTrade(sig,fc,to=50){
  const e=sig.entry,tp=sig.tp,sl=sig.sl,iB=sig.signal==='BUY';
  for(let i=0;i<Math.min(fc.length,to);i++){const c=fc[i];if(iB){if(c.l<=sl)return{r:'SL',ep:sl,b:i+1,t:c.t};if(c.h>=tp)return{r:'TP',ep:tp,b:i+1,t:c.t};}else{if(c.h>=sl)return{r:'SL',ep:sl,b:i+1,t:c.t};if(c.l<=tp)return{r:'TP',ep:tp,b:i+1,t:c.t};}}
  const li=Math.min(fc.length-1,to-1);if(li<0)return null;return{r:'TO',ep:fc[li].c,b:li+1,t:fc[li].t};
}

async function runBT(mode,syms,tos){
  console.log(`\n${'═'.repeat(60)}\n  ${mode.toUpperCase()} | ${syms.length} pairs\n${'═'.repeat(60)}`);
  const cd=mode==='strict'?24:mode==='scalp'?8:8; // Scalp cooldown lowered to 4
  const data={};
  for(const sym of syms){process.stdout.write(`  ${sym}...`);try{const[k5,k15,k1h]=await Promise.all([fetchAll(sym,'5m',4032),fetchAll(sym,'15m',1344),fetchAll(sym,'1h',336)]);if(!k5||k5.length<300){console.log(' skip');continue;}data[sym]={k5:k5.map(k=>({t:k[0],h:+k[2],l:+k[3],c:+k[4],v:+k[5]})),k15:k15.map(k=>({t:k[0],h:+k[2],l:+k[3],c:+k[4]})),k1h:k1h.map(k=>({t:k[0],h:+k[2],l:+k[3],c:+k[4]}))};console.log(` ${k5.length}c`);}catch(e){console.log(` ERR`);}await new Promise(r=>setTimeout(r,200));}
  const res={};
  for(const to of tos){
    const trades=[];const sC={total:0,buy:0,sell:0};const sS={},hS={},rS={},dS={},dwS={};
    for(const sym of Object.keys(data)){const{k5,k15,k1h}=data[sym];let lsb=-cd;if(!sS[sym])sS[sym]={t:0,w:0,p:0};
    for(let i=280;i<k5.length-to-1;i++){if(i-lsb<cd)continue;const w=k5.slice(Math.max(0,i-279),i+1);const C5=w.map(k=>k.c),H5=w.map(k=>k.h),L5=w.map(k=>k.l),V5=w.map(k=>k.v),T5=w.map(k=>k.t);const ct=k5[i].t;const c15=k15.filter(k=>k.t<=ct).slice(-100);const c1h=k1h.filter(k=>k.t<=ct).slice(-50);
    const sg=genSig(C5,H5,L5,V5,c15.map(k=>k.c),c15.map(k=>k.h),c15.map(k=>k.l),c1h.map(k=>k.c),c1h.map(k=>k.h),c1h.map(k=>k.l),T5,mode,sym);
    if(!sg){continue;}sC.total++;if(sg.signal==='NEUTRAL')continue;sC[sg.signal.toLowerCase()]++;
    const fc=k5.slice(i+1,i+1+to).map(k=>({h:k.h,l:k.l,c:k.c,t:k.t}));const r=simTrade(sg,fc,to);if(!r)continue;
    let pnl=sg.signal==='BUY'?(r.ep-sg.entry)/sg.entry*100:(sg.entry-r.ep)/sg.entry*100;pnl-=0.08;
    trades.push({sym,sig:sg.signal,res:r.r,pnl,bars:r.b,dur:r.b*5,h:sg.hU,reg:sg.regime,dow:sg.dayOfWeek});
    lsb=i;sS[sym].t++;sS[sym].p+=pnl;if(r.r==='TP')sS[sym].w++;
    if(!hS[sg.hU])hS[sg.hU]={t:0,w:0,p:0};hS[sg.hU].t++;hS[sg.hU].p+=pnl;if(r.r==='TP')hS[sg.hU].w++;
    if(!rS[sg.regime])rS[sg.regime]={t:0,w:0,p:0};rS[sg.regime].t++;rS[sg.regime].p+=pnl;if(r.r==='TP')rS[sg.regime].w++;
    const dk=new Date(k5[i].t).toISOString().slice(0,10);if(!dS[dk])dS[dk]={t:0,w:0,p:0};dS[dk].t++;dS[dk].p+=pnl;if(r.r==='TP')dS[dk].w++;
    const dw=sg.dayOfWeek;if(!dwS[dw])dwS[dw]={t:0,w:0,p:0};dwS[dw].t++;dwS[dw].p+=pnl;if(r.r==='TP')dwS[dw].w++;}}
    
    const n=trades.length;if(n===0){console.log(`  ${to}b: NO TRADES`);res[to]={totalTrades:0};continue;}
    const wins=trades.filter(t=>t.res==='TP').length;const wr=wins/n*100;const tP=trades.reduce((s,t)=>s+t.pnl,0);
    const gp=trades.filter(t=>t.pnl>0).reduce((s,t)=>s+t.pnl,0);const gl=Math.abs(trades.filter(t=>t.pnl<0).reduce((s,t)=>s+t.pnl,0));
    const pf=gl>0?gp/gl:99;let eq=10000,pk=10000,mdd=0;for(const t of trades){eq+=500*5*(t.pnl/100);if(eq>pk)pk=eq;const dd=(pk-eq)/pk*100;if(dd>mdd)mdd=dd;}
    const aW=wins>0?gp/wins:0;const aL=(n-wins)>0?gl/(n-wins):0;const exp=(wr/100)*aW-(1-wr/100)*aL;
    const dPnls=Object.values(dS).map(d=>d.p);const aD=dPnls.reduce((s,v)=>s+v,0)/dPnls.length;const sD=Math.sqrt(dPnls.reduce((s,v)=>s+Math.pow(v-aD,2),0)/dPnls.length);const sh=sD>0?(aD/sD)*Math.sqrt(365):0;
    
    console.log(`\n  ┌─── ${mode.toUpperCase()} | TO=${to}b ───┐`);
    console.log(`  │ Trades: ${n} (${wins}W) B:${sC.buy} S:${sC.sell} | ${(n/14).toFixed(0)}/day`);
    console.log(`  │ WR: ${wr.toFixed(1)}% | PnL: ${tP>=0?'+':''}${tP.toFixed(2)}% | Eq: $${eq.toFixed(0)}`);
    console.log(`  │ PF: ${pf.toFixed(3)} | DD: ${mdd.toFixed(2)}% | Sharpe: ${sh.toFixed(2)}`);
    console.log(`  │ AvgW: +${aW.toFixed(3)}% | AvgL: -${aL.toFixed(3)}% | Exp: ${exp>=0?'+':''}${exp.toFixed(4)}`);
    console.log(`  └${'─'.repeat(40)}`);
    
    console.log(`\n  TOP/BOTTOM SYMBOLS:`);
    Object.entries(sS).filter(([,v])=>v.t>0).sort((a,b)=>b[1].p-a[1].p).forEach(([s,d])=>console.log(`  ${s.padEnd(12)} ${String(d.t).padStart(5)} WR:${(d.w/d.t*100).toFixed(0).padStart(3)}% PnL:${(d.p>=0?'+':'')+d.p.toFixed(2)}`));
    
    console.log(`\n  BY HOUR:`);
    for(let h=0;h<24;h++){const d=hS[h];if(!d)continue;console.log(`  H${String(h).padStart(2)} ${String(d.t).padStart(5)} WR:${(d.w/d.t*100).toFixed(0).padStart(3)}% PnL:${(d.p>=0?'+':'')+d.p.toFixed(2)}`);}
    
    console.log(`\n  BY REGIME:`);
    Object.entries(rS).forEach(([r,d])=>console.log(`  ${r.padEnd(12)} ${String(d.t).padStart(5)} WR:${(d.w/d.t*100).toFixed(0).padStart(3)}% PnL:${(d.p>=0?'+':'')+d.p.toFixed(2)}`));
    
    console.log(`\n  BY DOW:`);
    ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach((dn,i)=>{const d=dwS[i];if(!d)return;console.log(`  ${dn} ${String(d.t).padStart(5)} WR:${(d.w/d.t*100).toFixed(0).padStart(3)}% PnL:${(d.p>=0?'+':'')+d.p.toFixed(2)}`);});
    
    console.log(`\n  EQUITY:`);
    let rp=0;Object.entries(dS).sort().forEach(([day,d])=>{rp+=d.p;console.log(`  ${day} ${String(d.t).padStart(3)}t WR${(d.w/d.t*100).toFixed(0).padStart(3)}% ${(d.p>=0?'+':'')+d.p.toFixed(2).padStart(7)}% cum:${(rp>=0?'+':'')+rp.toFixed(2).padStart(7)}%`);});
    
    res[to]={totalTrades:n,wins,wr,totalPnlPct:tP,pf,maxDD:mdd,sharpe:sh,equity:eq,expectancy:exp,tradesPerDay:(n/14).toFixed(1)};
  }
  return res;
}

async function main(){
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  RXTRADING v4 — VALIDATION BACKTEST                   ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  const all={};
  for(const[m,s]of[['strict',VIP_SCAN_SYMS],['scalp',SCALP_SCAN_SYMS],['frequent',PUB_SCAN_SYMS]]){
    try{all[m]=await runBT(m,s,[50]);}catch(e){console.error(`${m}: ${e.message}`);}
  }
  console.log(`\n${'═'.repeat(60)}\n  COMPARISON (TO=50)\n${'═'.repeat(60)}`);
  console.log(`  ${'Mode'.padEnd(12)} ${'Trades'.padStart(7)} ${'T/Day'.padStart(6)} ${'WR%'.padStart(6)} ${'PnL%'.padStart(8)} ${'PF'.padStart(6)} ${'DD%'.padStart(6)} ${'Sharpe'.padStart(7)}`);
  for(const m of['strict','scalp','frequent']){const r=all[m]?.[50];if(!r||r.totalTrades===0){console.log(`  ${m.padEnd(12)} NO DATA`);continue;}
  console.log(`  ${m.padEnd(12)} ${String(r.totalTrades).padStart(7)} ${r.tradesPerDay.padStart(6)} ${r.wr.toFixed(1).padStart(6)} ${(r.totalPnlPct>=0?'+':'')+r.totalPnlPct.toFixed(2).padStart(7)} ${r.pf.toFixed(2).padStart(6)} ${r.maxDD.toFixed(2).padStart(6)} ${r.sharpe.toFixed(2).padStart(7)}`);}
  console.log('\nDone!');
}
main().catch(console.error);
