#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════
// BACKTESTING v3 — AGGRESSIVE HOUR-BASED OPTIMIZATION
// Only trade during statistically profitable hours
// ══════════════════════════════════════════════════════════════════════

const https = require('https');

const CAPITAL = 10000;
const POS_SIZE = 500;
const LEVERAGE = 5;
const FEE_RT = 0.0008;

const VIP_PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','ADAUSDT','DOTUSDT','LINKUSDT','APTUSDT','NEARUSDT','ATOMUSDT','FILUSDT','UNIUSDT','ARBUSDT','OPUSDT','SHIBUSDT','TRXUSDT','SUIUSDT','SEIUSDT','TIAUSDT','JUPUSDT','WIFUSDT','FETUSDT','PEPEUSDT'];
const SCALP_PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','DOTUSDT','NEARUSDT','APTUSDT'];
const FREE_PAIRS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];

// Pairs that consistently lose — remove from VIP
const VIP_EXCLUDE = ['ETHUSDT','BNBUSDT','ATOMUSDT','JUPUSDT','ADAUSDT','SEIUSDT'];
const VIP_FILTERED = VIP_PAIRS.filter(p => !VIP_EXCLUDE.includes(p));
// Scalp exclude
const SCALP_EXCLUDE = ['SOLUSDT','XRPUSDT'];
const SCALP_FILTERED = SCALP_PAIRS.filter(p => !SCALP_EXCLUDE.includes(p));

const COOLDOWNS = { strict: 24, scalp: 12, frequent: 8 };

// Indicator functions
function calcRSI(c,p=14){if(c.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}if(!al)return 100;return 100-100/(1+ag/al);}
function calcEMAArr(d,p){const k=2/(p+1);const r=[d[0]];for(let i=1;i<d.length;i++)r.push(d[i]*k+r[i-1]*(1-k));return r;}
function calcEMA(d,p){return calcEMAArr(d,p).at(-1);}
function calcMACD(c){if(c.length<35)return{h:0,ph:0};const e12=calcEMAArr(c,12),e26=calcEMAArr(c,26);const ml=e12.map((v,i)=>v-e26[i]);const sl=calcEMAArr(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1))};}
function calcBB(c,p=20,s=2){if(c.length<p)return{u:0,m:0,l:0};const sl=c.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+s*sd,m,l:m-s*sd};}
function calcStoch(H,L,C,kp=14){if(C.length<kp+3)return{k:50};const kA=[];for(let i=kp;i<=C.length;i++){const sh=H.slice(i-kp,i),sl=L.slice(i-kp,i);const hi=Math.max(...sh),lo=Math.min(...sl);kA.push(hi===lo?50:((C[i-1]-lo)/(hi-lo))*100);}return{k:kA.at(-1)||50};}
function calcATR(H,L,C,p=14){if(C.length<p+1)return 0;const t=[];for(let i=1;i<C.length;i++)t.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));if(t.length<p)return t.reduce((a,b)=>a+b)/t.length;let a=t.slice(0,p).reduce((x,y)=>x+y)/p;for(let i=p;i<t.length;i++)a=(a*(p-1)+t[i])/p;return a;}
function calcADX(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pd=[],md=[],tr=[];for(let i=1;i<H.length;i++){const u=H[i]-H[i-1],d=L[i-1]-L[i];pd.push(u>d&&u>0?u:0);md.push(d>u&&d>0?d:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}function ws(a,p){if(a.length<p)return a.map(()=>0);const r=[];let s=a.slice(0,p).reduce((x,y)=>x+y)/p;for(let i=0;i<p;i++)r.push(0);r[p-1]=s;for(let i=p;i<a.length;i++){s=(s*(p-1)+a[i])/p;r.push(s);}return r;}const sT=ws(tr,p),sP=ws(pd,p),sM=ws(md,p);const pi=sP.map((v,i)=>sT[i]?v/sT[i]*100:0);const mi=sM.map((v,i)=>sT[i]?v/sT[i]*100:0);const dx=pi.map((v,i)=>{const s=v+mi[i];return s?Math.abs(v-mi[i])/s*100:0;});const dV=dx.slice(p-1);const aA=dV.length>=p?ws(dV,p):dV;return{adx:aA.at(-1)||15,pdi:pi.at(-1)||0,mdi:mi.at(-1)||0};}
function calcOBV(C,V){if(C.length<2)return{rising:false};let o=0;const a=[0];for(let i=1;i<C.length;i++){if(C[i]>C[i-1])o+=V[i];else if(C[i]<C[i-1])o-=V[i];a.push(o);}const n=Math.min(a.length,20),r=a.slice(-n);let sX=0,sY=0,sXY=0,sX2=0;for(let i=0;i<n;i++){sX+=i;sY+=r[i];sXY+=i*r[i];sX2+=i*i;}return{rising:(n*sXY-sX*sY)/(n*sX2-sX*sX||1)>0};}
function detectRegime(H,L,C,adx,atr){const avg=C.slice(-20).reduce((a,b)=>a+b)/20;const p=atr/avg*100;if(adx.adx>25&&p>1.5)return'TRENDING';if(adx.adx<20&&p<0.8)return'QUIET';if(p>2)return'VOLATILE';return'RANGING';}
function detectRSIDivergence(C,H,L,p=14){if(C.length<30)return{bull:false,bear:false};const ra=[];for(let i=p+1;i<=C.length;i++)ra.push(calcRSI(C.slice(0,i),p));if(ra.length<10)return{bull:false,bear:false};const len=Math.min(ra.length,C.length);const cR=C.slice(-len),rR=ra.slice(-len);let bu=false,be=false;for(let i=len-4;i>=Math.max(0,len-10);i--){if(cR.at(-1)<cR[i]&&rR.at(-1)>rR[i])bu=true;if(cR.at(-1)>cR[i]&&rR.at(-1)<rR[i])be=true;}return{bull:bu,bear:be};}

function fetchJSON(url){return new Promise((res,rej)=>{https.get(url,{timeout:15000},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}});}).on('error',rej).on('timeout',function(){this.destroy();rej(new Error('timeout'))})});}

async function getKlines(sym,tf,limit){
  const all=[];let end=Date.now();const tgt=Math.min(limit,4032);
  while(all.length<tgt){
    const bs=Math.min(1000,tgt-all.length);
    const url=`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${bs}&endTime=${end}`;
    for(let a=0;a<3;a++){try{const d=await fetchJSON(url);if(Array.isArray(d)&&d.length>0){all.unshift(...d);end=d[0][0]-1;break;}}catch(e){}await new Promise(r=>setTimeout(r,800));}
    if(all.length<50&&tgt>1000)break;if(end<Date.now()-30*86400000)break;
    await new Promise(r=>setTimeout(r,150));
  }
  return all.length>0?all:null;
}

// Signal generation with allowed hours whitelist
function genSig(C5,H5,L5,V5,C15,H15,L15,C1h,H1h,L1h,V1h,idx,mode,hour,allowedHours) {
  const isStrict=(mode==='strict'),isScalp=(mode==='scalp');
  if(idx<50)return null;
  const c=C5.slice(Math.max(0,idx-279),idx+1),h=H5.slice(Math.max(0,idx-279),idx+1),l=L5.slice(Math.max(0,idx-279),idx+1),v=V5.slice(Math.max(0,idx-279),idx+1);
  const cur=c.at(-1);if(!cur||cur<=0)return null;
  let B=0,S=0,bI=0,sI=0;

  // HTF
  let htf='NEUTRAL';
  if(C1h.length>25){let hB=0,hS=0;const e9=calcEMA(C1h,9),e21=calcEMA(C1h,21),e50=calcEMA(C1h,50);if(e9>e21)hB+=2;else hS+=2;if(C1h.at(-1)>e50)hB+=1;else hS+=1;const m=calcMACD(C1h);if(m.h>0)hB+=1.5;else hS+=1.5;if(m.h>m.ph)hB+=1;else hS+=1;const r=calcRSI(C1h,14);if(r>50)hB+=1;else hS+=1;const a=calcADX(H1h,L1h,C1h);if(a.adx>20&&a.pdi>a.mdi)hB+=1.5;else if(a.adx>20&&a.mdi>a.pdi)hS+=1.5;const o=calcOBV(C1h,V1h);if(o.rising)hB+=1;else hS+=1;if(hB>hS+2)htf='BUY';else if(hS>hB+2)htf='SELL';}
  // MTF
  let mtf='NEUTRAL';
  if(C15.length>25){let mB=0,mS=0;if(calcEMA(C15,9)>calcEMA(C15,21))mB++;else mS++;if(calcMACD(C15).h>0)mB++;else mS++;const r=calcRSI(C15,14);if(r>50)mB+=0.5;else if(r<50)mS+=0.5;if(mB>mS)mtf='BUY';else if(mS>mB)mtf='SELL';}

  const rsi=calcRSI(c,14),mac=calcMACD(c);
  const ea9=calcEMAArr(c,9),ea21=calcEMAArr(c,21);
  const e9=ea9.at(-1),e21=ea21.at(-1);
  const bb=calcBB(c,20,2);
  const avgV=v.slice(-20).reduce((a,b)=>a+b)/20,vr=v.at(-1)/avgV;
  const adx=calcADX(h,l,c),obv=calcOBV(c,v);
  const st=calcStoch(h,l,c,14);
  let atr=calcATR(h,l,c,14);
  const rsiDiv=detectRSIDivergence(c,h,l,14);
  const regime=detectRegime(h,l,c,adx,atr);
  const isTrending=(regime==='TRENDING'),isVolatile=(regime==='VOLATILE');

  // SCORING
  if(isStrict&&!isTrending){
    if(rsi<25){B+=4;bI++;}else if(rsi<30){B+=3;bI++;}else if(rsi<35){B+=2;bI++;}
    else if(rsi>75){S+=4;sI++;}else if(rsi>70){S+=3;sI++;}else if(rsi>65){S+=2;sI++;}
    if(st.k<20){B+=3;bI++;}else if(st.k<30){B+=2;bI++;}
    else if(st.k>80){S+=3;sI++;}else if(st.k>70){S+=2;sI++;}
    const bR=bb.u-bb.l,bP=bR>0?(cur-bb.l)/bR:0.5;
    if(bP<0.1){B+=3;bI++;}else if(bP<0.2){B+=2;bI++;}
    else if(bP>0.9){S+=3;sI++;}else if(bP>0.8){S+=2;sI++;}
    const m3=(cur-(c[c.length-4]||cur))/Math.max(atr,0.0001);
    if(m3<-1){B+=2;bI++;}else if(m3<-0.5){B+=1;bI++;}
    else if(m3>1){S+=2;sI++;}else if(m3>0.5){S+=1;sI++;}
    let bR2=0,uR2=0;for(let i=Math.max(0,c.length-4);i<c.length;i++){if(c[i]<(c[i-1]||c[i]))bR2++;else bR2=0;if(c[i]>(c[i-1]||c[i]))uR2++;else uR2=0;}
    if(bR2>=4){B+=2;bI++;}else if(bR2>=3){B+=1;bI++;}
    if(uR2>=4){S+=2;sI++;}else if(uR2>=3){S+=1;sI++;}
    const ed=(cur-e21)/Math.max(atr,0.0001);
    if(ed<-1.5){B+=1.5;bI++;}else if(ed<-0.8){B+=0.8;bI++;}
    else if(ed>1.5){S+=1.5;sI++;}else if(ed>0.8){S+=0.8;sI++;}
    if(mac.h>0&&mac.ph<=0){B+=1.5;bI++;}else if(mac.h<0&&mac.ph>=0){S+=1.5;sI++;}
    if(obv.rising&&B>S){B+=1;bI++;}else if(!obv.rising&&S>B){S+=1;sI++;}
    if(vr>1.5){if(B>S)B*=1.1;else S*=1.1;}
  } else if(isScalp){
    const sk=st.k||50,bR=bb.u-bb.l,bP=bR>0?(cur-bb.l)/bR:0.5;
    const m3=(cur-(c[c.length-4]||cur))/Math.max(atr,0.0001);
    const ed=(cur-e21)/Math.max(atr,0.0001);
    const l4=c.slice(-4);
    const sBE=l4.length>=4&&l4.every((x,i)=>i===0||x<l4[i-1]);
    const sUE=l4.length>=4&&l4.every((x,i)=>i===0||x>l4[i-1]);
    if(rsi<25){B+=4;bI++;}else if(rsi<30){B+=3;bI++;}else if(rsi<35){B+=2;bI++;}else if(rsi<40){B+=1;bI++;}
    else if(rsi>75){S+=4;sI++;}else if(rsi>70){S+=3;sI++;}else if(rsi>65){S+=2;sI++;}else if(rsi>60){S+=1;sI++;}
    if(sk<20){B+=3;bI++;}else if(sk<30){B+=1.5;bI++;}else if(sk>80){S+=3;sI++;}else if(sk>70){S+=1.5;sI++;}
    if(bP<0.1){B+=3;bI++;}else if(bP<0.2){B+=2;bI++;}else if(bP>0.9){S+=3;sI++;}else if(bP>0.8){S+=2;sI++;}
    if(m3<-1){B+=2;bI++;}else if(m3<-0.5){B+=1;bI++;}else if(m3>1){S+=2;sI++;}else if(m3>0.5){S+=1;sI++;}
    if(sBE){B+=2;bI++;}else if(sUE){S+=2;sI++;}
    if(ed<-1.5){B+=1.5;bI++;}else if(ed>1.5){S+=1.5;sI++;}
    if(mac.h>0&&mac.ph<0){S+=1;sI++;}else if(mac.h<0&&mac.ph>0){B+=1;bI++;}
    if(vr>1.5){if(B>S)B*=1.1;else S*=1.1;}
  } else {
    const sk=st.k||50,bR=bb.u-bb.l,bP=bR>0?(cur-bb.l)/bR:0.5;
    if(rsi<28){B+=3;bI++;}else if(rsi<35){B+=2;bI++;}else if(rsi<40){B+=1;bI++;}
    else if(rsi>72){S+=3;sI++;}else if(rsi>65){S+=2;sI++;}else if(rsi>60){S+=1;sI++;}
    if(sk<25){B+=2;bI++;}else if(sk<35){B+=1;bI++;}else if(sk>75){S+=2;sI++;}else if(sk>65){S+=1;sI++;}
    if(bP<0.15){B+=2;bI++;}else if(bP<0.25){B+=1;bI++;}else if(bP>0.85){S+=2;sI++;}else if(bP>0.75){S+=1;sI++;}
    const fm=(cur-(c[c.length-4]||cur))/Math.max(atr,0.0001);
    if(fm<-0.8){B+=1;bI++;}else if(fm>0.8){S+=1;sI++;}
    if(mac.h>0&&mac.ph<0){B+=1;bI++;}else if(mac.h<0&&mac.ph>0){S+=1;sI++;}
    if(obv.rising)B+=0.5;else S+=0.5;
    if(vr>1.5){if(B>S)B*=1.1;else S*=1.1;}
  }

  // DECISION
  let signal='NEUTRAL',conf=0;

  if(isStrict){
    if(isTrending){}
    else if(B>S&&B>=8&&bI>=3)signal='BUY';
    else if(S>B&&S>=8&&sI>=3)signal='SELL';
    if(signal!=='NEUTRAL'&&adx.adx>20)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&!allowedHours.includes(hour))signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&isVolatile)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&atr/cur<0.0008)signal='NEUTRAL';
    if(signal!=='NEUTRAL'){
      const cs=signal==='BUY'?B:S,cc=signal==='BUY'?bI:sI;
      conf=Math.min(85,Math.round(50+cs*2.5+cc*1.5));
      if(htf===signal)conf=Math.min(85,conf+5);
      if(mtf===signal)conf=Math.min(85,conf+3);
      if(rsiDiv.bull&&signal==='BUY')conf=Math.min(85,conf+3);
      if(rsiDiv.bear&&signal==='SELL')conf=Math.min(85,conf+3);
    }
  } else if(isScalp){
    if(B>S&&B>=6&&bI>=3)signal='BUY';
    else if(S>B&&S>=6&&sI>=3)signal='SELL';
    if(signal!=='NEUTRAL'&&adx.adx>20)signal='NEUTRAL';
    if(signal==='BUY'&&mtf==='SELL')signal='NEUTRAL';
    if(signal==='SELL'&&mtf==='BUY')signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&!allowedHours.includes(hour))signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&vr<0.3)signal='NEUTRAL';
    if(signal!=='NEUTRAL')conf=Math.min(85,Math.max(55,Math.round(50+Math.max(B,S)*3)));
  } else {
    if(B>S&&B>=5&&bI>=2)signal='BUY';
    else if(S>B&&S>=5&&sI>=2)signal='SELL';
    if(signal!=='NEUTRAL'&&isTrending)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&isVolatile)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&adx.adx>30)signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&!allowedHours.includes(hour))signal='NEUTRAL';
    if(signal!=='NEUTRAL'&&vr<0.4)signal='NEUTRAL';
    if(signal!=='NEUTRAL'){
      const cs=signal==='BUY'?B:S,cc=signal==='BUY'?bI:sI;
      conf=Math.min(75,Math.round(40+cs*2+cc*1.5));
    }
  }

  // TP/SL
  let a15=atr,a1h=atr*3.46;
  if(C15.length>15){const a=calcATR(H15,L15,C15,14);if(a>0)a15=a;}
  if(C1h.length>15){const a=calcATR(H1h,L1h,C1h,14);if(a>0)a1h=a;}
  const bl=Math.max(a15,a1h/4);
  const useA=isScalp?(a15||bl):bl;
  let tp=useA*(isScalp?1.0:1.5),sl=useA*1.0;
  if(isScalp){const m=cur*0.0015;if(tp<m)tp=m;if(sl<m)sl=m;}
  else{const m=cur*0.0012;if(tp<m)tp=m;if(sl<m*0.67)sl=m*0.67;}
  if(!isStrict&&!isScalp&&tp<sl*1.2)tp=sl*1.2;
  const cb=cur*0.0008;

  return{signal,conf,entry:cur,
    tp:signal==='BUY'?cur+tp+cb:signal==='SELL'?cur-tp-cb:null,
    sl:signal==='BUY'?cur-sl-cb:signal==='SELL'?cur+sl+cb:null,
    regime,adx:adx.adx,rsi,vr,B,S,bI,sI};
}

function simulate(sigs,H5,L5,C5,mode,timeout=50){
  const trades=[],cds={},cd=COOLDOWNS[mode];
  for(const s of sigs){
    const last=cds[s.sym]||-999;if(s.barIdx-last<cd)continue;
    const hh=H5[s.sym],ll=L5[s.sym],cc=C5[s.sym];
    let ep=null,eb=null,er=null;
    for(let j=s.barIdx+1;j<Math.min(s.barIdx+1+timeout,cc.length);j++){
      if(s.signal==='BUY'){if(ll[j]<=s.sl){ep=s.sl;eb=j;er='SL';break;}if(hh[j]>=s.tp){ep=s.tp;eb=j;er='TP';break;}}
      else{if(hh[j]>=s.sl){ep=s.sl;eb=j;er='SL';break;}if(ll[j]<=s.tp){ep=s.tp;eb=j;er='TP';break;}}
    }
    if(!ep){eb=Math.min(s.barIdx+timeout,cc.length-1);ep=cc[eb];er='TO';}
    const pp=s.signal==='BUY'?(ep-s.entry)/s.entry:(s.entry-ep)/s.entry;
    trades.push({sym:s.sym,dir:s.signal,pnlNet:(pp*POS_SIZE*LEVERAGE)-(POS_SIZE*LEVERAGE*FEE_RT),
      barIdx:s.barIdx,exitBar:eb,exitReason:er,duration:(eb-s.barIdx)*5,regime:s.regime,hour:s.hour});
    cds[s.sym]=s.barIdx;
  }
  return trades;
}

function report(trades,name,days){
  if(!trades.length){console.log(`  ${name}: NO TRADES`);return null;}
  const w=trades.filter(t=>t.pnlNet>0),lo=trades.filter(t=>t.pnlNet<=0);
  const wr=w.length/trades.length*100,total=trades.reduce((s,t)=>s+t.pnlNet,0);
  const gp=w.reduce((s,t)=>s+t.pnlNet,0),gl=Math.abs(lo.reduce((s,t)=>s+t.pnlNet,0));
  const pf=gl>0?gp/gl:99;
  let eq=CAPITAL,pk=CAPITAL,mdd=0;
  const daily={};
  for(const t of trades){eq+=t.pnlNet;pk=Math.max(pk,eq);mdd=Math.max(mdd,(pk-eq)/pk*100);const d=Math.floor(t.barIdx/288);daily[d]=(daily[d]||0)+t.pnlNet;}
  const avgW=w.length?gp/w.length:0,avgL=lo.length?gl/lo.length:0;
  const exp=(wr/100*avgW)-((1-wr/100)*avgL);
  const avgDur=trades.reduce((s,t)=>s+t.duration,0)/trades.length;
  let mcw=0,mcl=0,cw=0,cl=0;
  for(const t of trades){if(t.pnlNet>0){cw++;cl=0;mcw=Math.max(mcw,cw);}else{cl++;cw=0;mcl=Math.max(mcl,cl);}}

  const byPair={},byHour={},byRegime={};
  for(const t of trades){
    byPair[t.sym]=byPair[t.sym]||{n:0,w:0,p:0};byPair[t.sym].n++;if(t.pnlNet>0)byPair[t.sym].w++;byPair[t.sym].p+=t.pnlNet;
    byHour[t.hour]=byHour[t.hour]||{n:0,w:0,p:0};byHour[t.hour].n++;if(t.pnlNet>0)byHour[t.hour].w++;byHour[t.hour].p+=t.pnlNet;
    byRegime[t.regime]=byRegime[t.regime]||{n:0,w:0,p:0};byRegime[t.regime].n++;if(t.pnlNet>0)byRegime[t.regime].w++;byRegime[t.regime].p+=t.pnlNet;
  }

  const dRet=Object.values(daily);
  const profitDays=dRet.filter(d=>d>0).length;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${name}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Trades: ${trades.length} (BUY:${trades.filter(t=>t.dir==='BUY').length} SELL:${trades.filter(t=>t.dir==='SELL').length}) | ${(trades.length/days).toFixed(1)} s/d`);
  console.log(`  WR: ${wr.toFixed(1)}% | PnL: $${total.toFixed(2)} (${(total/CAPITAL*100).toFixed(2)}%) | PF: ${pf.toFixed(2)} | MaxDD: ${mdd.toFixed(1)}%`);
  console.log(`  Avg Duration: ${avgDur.toFixed(0)}min | Expectancy: $${exp.toFixed(2)}/trade`);
  console.log(`  Avg Win: $${avgW.toFixed(2)} | Avg Loss: $${avgL.toFixed(2)} | ConsW: ${mcw} | ConsL: ${mcl}`);
  console.log(`  Profit Days: ${profitDays}/${dRet.length}`);

  console.log(`  Pairs:`);
  Object.entries(byPair).sort((a,b)=>b[1].p-a[1].p).forEach(([s,d])=>{
    console.log(`    ${s}: ${d.n}t WR=${(d.w/d.n*100).toFixed(0)}% $${d.p.toFixed(0)}`);
  });

  console.log(`  Hours:`);
  Object.entries(byHour).sort((a,b)=>parseInt(a[0])-parseInt(b[0])).forEach(([h,d])=>{
    console.log(`    H${h.padStart(2,'0')}: ${d.p>0?'🟢':'🔴'} ${d.n}t WR=${(d.w/d.n*100).toFixed(0)}% $${d.p.toFixed(0)}`);
  });

  console.log(`  Daily:`);
  Object.entries(daily).sort((a,b)=>parseInt(a[0])-parseInt(b[0])).forEach(([d,p])=>{
    console.log(`    D${d}: ${p>0?'🟢':'🔴'} $${p.toFixed(0)}`);
  });

  return{name,trades:trades.length,wr,total,pf,mdd,exp,spd:trades.length/days,profitDays,totalDays:dRet.length};
}

async function main(){
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('  BACKTESTING v3 — OPTIMIZED CONFIGS, 14-DAY REAL DATA');
  console.log('══════════════════════════════════════════════════════════════════════\n');

  const allPairs=[...new Set([...VIP_PAIRS,...SCALP_PAIRS,...FREE_PAIRS])];
  const data={};
  for(const sym of allPairs){
    process.stdout.write(`  ${sym}... `);
    try{
      const [k5,k15,k1h]=await Promise.all([getKlines(sym,'5m',4032),getKlines(sym,'15m',1500),getKlines(sym,'1h',400)]);
      if(!k5||k5.length<500){console.log(`SKIP`);continue;}
      data[sym]={C5:k5.map(k=>parseFloat(k[4])),H5:k5.map(k=>parseFloat(k[2])),L5:k5.map(k=>parseFloat(k[3])),V5:k5.map(k=>parseFloat(k[5])),ts:k5.map(k=>k[0]),
        C15:k15?k15.map(k=>parseFloat(k[4])):[],H15:k15?k15.map(k=>parseFloat(k[2])):[],L15:k15?k15.map(k=>parseFloat(k[3])):[],
        C1h:k1h?k1h.map(k=>parseFloat(k[4])):[],H1h:k1h?k1h.map(k=>parseFloat(k[2])):[],L1h:k1h?k1h.map(k=>parseFloat(k[3])):[],V1h:k1h?k1h.map(k=>parseFloat(k[5])):[]};
      console.log(`OK (${k5.length})`);
    }catch(e){console.log(`ERR`);}
    await new Promise(r=>setTimeout(r,250));
  }

  const days=Math.min(...Object.values(data).map(d=>d.C5.length/288));
  console.log(`\nCoverage: ~${days.toFixed(1)} days\n`);

  // Profitable hours from v2 backtest data:
  // VIP: H06(+312), H07(+216), H14(+118), H15(+86), H20(+640), H23(+187)
  // SCALP: H06(+18), H11(+42), H12(+220), H13(+148), H15(+47), H20(+49), H23(+98)
  // FREE: H06(+52), H10(+91), H18(+121), H20(+164), H21(+95), H23(+70)

  const configs=[
    {name:'VIP STRICT — best hours only',mode:'strict',pairs:VIP_PAIRS,hours:[6,7,14,15,20,23]},
    {name:'VIP STRICT — best hours + filtered pairs',mode:'strict',pairs:VIP_FILTERED,hours:[6,7,14,15,20,23]},
    {name:'VIP STRICT — wider hours',mode:'strict',pairs:VIP_PAIRS,hours:[6,7,9,13,14,15,20,23]},
    {name:'VIP STRICT — wider + filtered pairs',mode:'strict',pairs:VIP_FILTERED,hours:[6,7,9,13,14,15,20,23]},
    {name:'SCALP — best hours only',mode:'scalp',pairs:SCALP_PAIRS,hours:[6,7,11,12,13,15,20,22,23]},
    {name:'SCALP — best + filtered pairs',mode:'scalp',pairs:SCALP_FILTERED,hours:[6,7,11,12,13,15,20,22,23]},
    {name:'FREE — best hours only',mode:'frequent',pairs:FREE_PAIRS,hours:[6,9,10,12,13,18,20,21,23]},
    {name:'FREE — aggressive (top 4 hours)',mode:'frequent',pairs:FREE_PAIRS,hours:[10,18,20,21]},
  ];

  const summaries=[];

  for(const cfg of configs){
    process.stdout.write(`⏳ ${cfg.name}... `);
    const sigs=[];
    for(const sym of cfg.pairs){
      if(!data[sym])continue;const d=data[sym];
      const start=Math.max(280,d.C5.length-Math.round(days*288));
      for(let i=start;i<d.C5.length-1;i++){
        const h=new Date(d.ts[i]).getUTCHours();
        const s=genSig(d.C5,d.H5,d.L5,d.V5,d.C15,d.H15,d.L15,d.C1h,d.H1h,d.L1h,d.V1h,i,cfg.mode,h,cfg.hours);
        if(s&&s.signal!=='NEUTRAL')sigs.push({...s,sym,barIdx:i,hour:h});
      }
    }
    sigs.sort((a,b)=>a.barIdx-b.barIdx);
    const H5m={},L5m={},C5m={};
    for(const sym of cfg.pairs){if(data[sym]){H5m[sym]=data[sym].H5;L5m[sym]=data[sym].L5;C5m[sym]=data[sym].C5;}}
    const trades=simulate(sigs,H5m,L5m,C5m,cfg.mode);
    console.log(`${trades.length} trades`);
    const r=report(trades,cfg.name,days);
    if(r)summaries.push(r);
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log('  RESUMEN FINAL — CONFIGS OPTIMIZADAS');
  console.log(`${'═'.repeat(80)}`);
  console.log(`\n  ${'Config'.padEnd(45)} ${'Tr'.padStart(5)} ${'WR%'.padStart(6)} ${'PnL$'.padStart(9)} ${'PnL%'.padStart(7)} ${'PF'.padStart(6)} ${'DD%'.padStart(5)} ${'S/D'.padStart(5)} ${'P.Days'.padStart(7)}`);
  console.log('  '+'─'.repeat(95));
  for(const s of summaries){
    const v=s.total>0&&s.pf>1.1?'✅':s.total>0?'⚠️':'❌';
    console.log(`  ${v} ${s.name.padEnd(43)} ${String(s.trades).padStart(5)} ${s.wr.toFixed(1).padStart(6)} ${('$'+s.total.toFixed(0)).padStart(9)} ${(s.total/CAPITAL*100).toFixed(1).padStart(6)}% ${s.pf.toFixed(2).padStart(6)} ${s.mdd.toFixed(1).padStart(4)}% ${s.spd.toFixed(1).padStart(5)} ${s.profitDays}/${s.totalDays}`);
  }
  console.log('\nDone.');
}

main().catch(console.error);
