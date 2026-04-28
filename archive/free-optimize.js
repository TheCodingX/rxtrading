// ═══════════════════════════════════════════════════════════════════
// FREE MODE OPTIMIZER — Find profitable config for Alta Frecuencia
// Must be profitable but worse than VIP/Scalp
// Target: 30-80 signals/day, positive PnL, WR>52%
// ═══════════════════════════════════════════════════════════════════

const https = require('https');
const SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT','DOTUSDT','NEARUSDT','APTUSDT'];

function fetchJSON(url){return new Promise((res,rej)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}});}).on('error',rej)});}
async function getKlines(sym,tf,limit,endTime){let url=`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`;if(endTime)url+=`&endTime=${endTime}`;try{return await fetchJSON(url);}catch(e){return null;}}

function calcRSI(C,p=14){if(C.length<p+1)return 50;let g=0,l=0;for(let i=1;i<=p;i++){const d=C[i]-C[i-1];if(d>0)g+=d;else l+=Math.abs(d);}let ag=g/p,al=l/p;for(let i=p+1;i<C.length;i++){const d=C[i]-C[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;}if(al===0)return 100;return 100-(100/(1+ag/al));}
function calcEMAArr(d,p){const k=2/(p+1);const r=[d[0]];for(let i=1;i<d.length;i++)r.push(d[i]*k+r[i-1]*(1-k));return r;}
function calcEMA(d,p){return calcEMAArr(d,p).at(-1);}
function calcMACD(C){if(C.length<35)return{h:0,ph:0};const e12=calcEMAArr(C,12),e26=calcEMAArr(C,26);const ml=e12.map((v,i)=>v-e26[i]);const sl=calcEMAArr(ml,9);return{h:ml.at(-1)-sl.at(-1),ph:(ml.at(-2)||0)-(sl.at(-2)||sl.at(-1))};}
function calcATR(H,L,C,p=14){if(C.length<p+1)return 0;const trs=[];for(let i=1;i<C.length;i++)trs.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));if(trs.length<p)return trs.reduce((a,b)=>a+b)/trs.length;let atr=trs.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<trs.length;i++)atr=(atr*(p-1)+trs[i])/p;return atr;}
function calcStoch(H,L,C,kp=14){if(C.length<kp+3)return{k:50,d:50};const kA=[];for(let i=kp;i<=C.length;i++){const sh=H.slice(i-kp,i),sl=L.slice(i-kp,i);const hi=Math.max(...sh),lo=Math.min(...sl);kA.push(hi===lo?50:((C[i-1]-lo)/(hi-lo))*100);}const dA=[];for(let i=2;i<kA.length;i++)dA.push((kA[i]+kA[i-1]+kA[i-2])/3);return{k:kA.at(-1)||50,d:dA.at(-1)||50};}
function calcBB(C,p=20,s=2){if(C.length<p)return{u:0,m:0,l:0};const sl=C.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/p);return{u:m+s*sd,m,l:m-s*sd};}
function calcADX(H,L,C,p=14){if(C.length<p*2)return{adx:15,pdi:0,mdi:0};const pdm=[],mdm=[],tr=[];for(let i=1;i<H.length;i++){const u=H[i]-H[i-1],d=L[i-1]-L[i];pdm.push(u>d&&u>0?u:0);mdm.push(d>u&&d>0?d:0);tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));}function ws(a,p){if(a.length<p)return a.map(()=>0);const r=[];let s=a.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=0;i<p;i++)r.push(0);r[p-1]=s;for(let i=p;i<a.length;i++){s=(s*(p-1)+a[i])/p;r.push(s);}return r;}const sT=ws(tr,p),sP=ws(pdm,p),sM=ws(mdm,p);const pdi=sP.map((v,i)=>sT[i]?v/sT[i]*100:0);const mdi=sM.map((v,i)=>sT[i]?v/sT[i]*100:0);const dx=pdi.map((v,i)=>{const s=v+mdi[i];return s?Math.abs(v-mdi[i])/s*100:0;});const dxV=dx.slice(p-1);const adxA=dxV.length>=p?ws(dxV,p):dxV;return{adx:adxA.at(-1)||15,pdi:pdi.at(-1)||0,mdi:mdi.at(-1)||0};}
function calcOBV(C,V){if(C.length<2)return{obv:0,slope:0,rising:false};let obv=0;const arr=[0];for(let i=1;i<C.length;i++){if(C[i]>C[i-1])obv+=V[i];else if(C[i]<C[i-1])obv-=V[i];arr.push(obv);}const n=Math.min(20,arr.length);const sl=arr.slice(-n);let sx=0,sy=0,sxx=0,sxy=0;for(let i=0;i<n;i++){sx+=i;sy+=sl[i];sxx+=i*i;sxy+=i*sl[i];}const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx||1);return{obv,slope,rising:slope>0};}
function detectRegime(H,L,C,adxPre,atrPre){const adx=adxPre||calcADX(H,L,C);const atr=atrPre||calcATR(H,L,C,14);const avgP=C.slice(-20).reduce((a,b)=>a+b)/20;const atrPct=atr/avgP*100;if(adx.adx>25&&(adx.pdi>adx.mdi*1.3||adx.mdi>adx.pdi*1.3))return'TRENDING';if(atrPct>2.5)return'VOLATILE';if(atrPct<0.5||adx.adx<15)return'QUIET';return'RANGING';}

let DATA={};
async function loadData(){
  const now=Date.now();const midTime=now-3.5*24*60*60*1000;
  for(const sym of SYMS){
    process.stdout.write(`  ${sym}...`);
    const [k5a,k5b,k15]=await Promise.all([getKlines(sym,'5m',1000,Math.floor(midTime)),getKlines(sym,'5m',1000),getKlines(sym,'15m',700)]);
    await new Promise(r=>setTimeout(r,300));
    if(!k5a||!k5b){console.log(' SKIP');continue;}
    const allK5=new Map();for(const k of [...k5a,...k5b])allK5.set(k[0],k);const k5=Array.from(allK5.values()).sort((a,b)=>a[0]-b[0]);
    DATA[sym]={C:k5.map(k=>+k[4]),H:k5.map(k=>+k[2]),L:k5.map(k=>+k[3]),V:k5.map(k=>+k[5]),T:k5.map(k=>k[0]),
      C15:k15?k15.map(k=>+k[4]):[],H15:k15?k15.map(k=>+k[2]):[],L15:k15?k15.map(k=>+k[3]):[],T15:k15?k15.map(k=>k[0]):[],len:k5.length};
    console.log(` ${k5.length}`);
  }
}

// Mean-reversion scoring (same engine, configurable thresholds)
function score(c,h,l,v,cur,atr,rsi,stoch,bb,mac,obvData,e21,cfg){
  const{rsiLevels=[25,30,35,65,70,75],stochLevels=[20,30,70,80],bbLevels=[0.1,0.2,0.8,0.9],
    useMom=true,useCandles=true,useEMA=true,useMACDContra=false,useMACDConfirm=true,useOBV=true}=cfg;
  let B=0,S=0,bI=0,sI=0;

  // RSI
  if(rsi<rsiLevels[0]){B+=4;bI++;}else if(rsi<rsiLevels[1]){B+=3;bI++;}else if(rsi<rsiLevels[2]){B+=2;bI++;}
  else if(rsi>rsiLevels[5]){S+=4;sI++;}else if(rsi>rsiLevels[4]){S+=3;sI++;}else if(rsi>rsiLevels[3]){S+=2;sI++;}

  // Stoch
  if(stoch.k<stochLevels[0]){B+=3;bI++;}else if(stoch.k<stochLevels[1]){B+=1.5;bI++;}
  else if(stoch.k>stochLevels[3]){S+=3;sI++;}else if(stoch.k>stochLevels[2]){S+=1.5;sI++;}

  // BB
  const bbR=bb.u-bb.l;const bbP=bbR>0?(cur-bb.l)/bbR:0.5;
  if(bbP<bbLevels[0]){B+=3;bI++;}else if(bbP<bbLevels[1]){B+=2;bI++;}
  else if(bbP>bbLevels[3]){S+=3;sI++;}else if(bbP>bbLevels[2]){S+=2;sI++;}

  // Momentum contrarian
  if(useMom){
    const mom3=(cur-(c[c.length-4]||cur))/Math.max(atr,0.0001);
    if(mom3<-1){B+=2;bI++;}else if(mom3<-0.5){B+=1;bI++;}
    else if(mom3>1){S+=2;sI++;}else if(mom3>0.5){S+=1;sI++;}
  }

  // Candle exhaustion
  if(useCandles){
    let bearRun=0,bullRun=0;
    for(let i=Math.max(0,c.length-4);i<c.length;i++){
      if(c[i]<(c[i-1]||c[i]))bearRun++;else bearRun=0;
      if(c[i]>(c[i-1]||c[i]))bullRun++;else bullRun=0;
    }
    if(bearRun>=4){B+=2;bI++;}else if(bearRun>=3){B+=1;bI++;}
    if(bullRun>=4){S+=2;sI++;}else if(bullRun>=3){S+=1;sI++;}
  }

  // EMA overextension
  if(useEMA){
    const emaDist=(cur-e21)/Math.max(atr,0.0001);
    if(emaDist<-1.5){B+=1.5;bI++;}else if(emaDist<-0.8){B+=0.8;bI++;}
    else if(emaDist>1.5){S+=1.5;sI++;}else if(emaDist>0.8){S+=0.8;sI++;}
  }

  // MACD (confirm or contrarian)
  if(useMACDConfirm){
    if(mac.h>0&&mac.ph<=0){B+=1.5;bI++;}else if(mac.h<0&&mac.ph>=0){S+=1.5;sI++;}
  }
  if(useMACDContra){
    if(mac.h>0&&mac.ph<0){S+=1;sI++;}else if(mac.h<0&&mac.ph>0){B+=1;bI++;}
  }

  // OBV
  if(useOBV){
    if(obvData.rising&&B>S){B+=1;bI++;}else if(!obvData.rising&&S>B){S+=1;sI++;}
  }

  // Volume spike
  const avgV=v.slice(-20).reduce((a,b)=>a+b)/20;const vr=v.at(-1)/avgV;
  if(vr>1.5){if(B>S)B*=1.1;else S*=1.1;}

  return{B,S,bI,sI,vr};
}

function precompute(){
  const LB=280,FUT=36;const allBars=[];
  for(const sym of Object.keys(DATA)){
    const d=DATA[sym];
    for(let bar=LB;bar<d.len-FUT;bar++){
      const c=d.C.slice(bar-279,bar+1),h=d.H.slice(bar-279,bar+1),l=d.L.slice(bar-279,bar+1),v=d.V.slice(bar-279,bar+1);
      const bt=d.T[bar];const hUTC=new Date(bt).getUTCHours();const cur=c.at(-1);
      const atr=calcATR(h,l,c,14);const adxData=calcADX(h,l,c);
      const rsi=calcRSI(c,14);const mac=calcMACD(c);
      const ea21=calcEMAArr(c,21);const e21=ea21.at(-1);
      const bb=calcBB(c,20,2);const stoch=calcStoch(h,l,c,14);
      const obvData=calcOBV(c,v);
      const regime=detectRegime(h,l,c,adxData,atr);
      const avgV=v.slice(-20).reduce((a,b)=>a+b)/20;const vr=v.at(-1)/avgV;

      // 15m MTF
      let c15e=0;for(let j=d.T15.length-1;j>=0;j--){if(d.T15[j]<=bt){c15e=j+1;break;}}
      const c15=d.C15.slice(Math.max(0,c15e-100),c15e);
      const h15=d.H15.slice(Math.max(0,c15e-100),c15e);
      const l15=d.L15.slice(Math.max(0,c15e-100),c15e);
      let mtf15='NEUTRAL';
      if(c15.length>25){let mB=0,mS=0;if(calcEMA(c15,9)>calcEMA(c15,21))mB++;else mS++;if(calcMACD(c15).h>0)mB++;else mS++;if(mB>mS)mtf15='BUY';else if(mS>mB)mtf15='SELL';}
      let atr15=atr;if(h15.length>15&&l15.length>15&&c15.length>15){const a=calcATR(h15,l15,c15,14);if(a>0)atr15=a;}

      const fH=[],fL=[],fC=[];
      for(let f=bar+1;f<=Math.min(bar+FUT,d.len-1);f++){fH.push(d.H[f]);fL.push(d.L[f]);fC.push(d.C[f]);}

      allBars.push({sym,bar,hUTC,cur,atr,atr15,adx:adxData.adx,rsi,mac,e21,bb,stoch,obvData,regime,vr,
        mtf15,c,h,l,v,fH,fL,fC,pct:bar/d.len});
    }
  }
  return allBars;
}

function evalTrade(sig,entry,useATR,tpM,slM,tp1R,maxBars,fH,fL,fC){
  const tp=useATR*tpM,sl=useATR*slM;const cost=entry*0.0008;
  const tp1=tp*tp1R;const trail=useATR*0.08;
  const tp1P=sig==='BUY'?entry+tp1+cost:entry-tp1-cost;
  const slP=sig==='BUY'?entry-sl-cost:entry+sl+cost;
  const tpFullP=sig==='BUY'?entry+tp+cost:entry-tp-cost;
  let tp1Hit=false;let best=sig==='BUY'?-Infinity:Infinity;
  for(let i=0;i<Math.min(maxBars,fH.length);i++){
    if(sig==='BUY'){
      if(!tp1Hit){if(fL[i]<=slP)return -(sl+cost)/entry*100;if(fH[i]>=tp1P)tp1Hit=true;}
      if(tp1Hit){best=Math.max(best,fH[i]);if(fL[i]<=best-trail-cost)return(tp1/entry*100)*0.5+((fC[i]-entry-cost)/entry*100)*0.5;if(fH[i]>=tpFullP)return(tp1/entry*100)*0.5+(tp/entry*100)*0.5;if(fL[i]<=entry)return(tp1/entry*100)*0.5;}
    }else{
      if(!tp1Hit){if(fH[i]>=slP)return -(sl+cost)/entry*100;if(fL[i]<=tp1P)tp1Hit=true;}
      if(tp1Hit){best=Math.min(best,fL[i]);if(fH[i]>=best+trail+cost)return(tp1/entry*100)*0.5+((entry-fC[i]-cost)/entry*100)*0.5;if(fL[i]<=tpFullP)return(tp1/entry*100)*0.5+(tp/entry*100)*0.5;if(fH[i]>=entry)return(tp1/entry*100)*0.5;}
    }
  }
  const last=fC[Math.min(maxBars,fH.length)-1]||entry;
  const uPnl=sig==='BUY'?(last-entry-cost)/entry*100:(entry-last-cost)/entry*100;
  return tp1Hit?(tp1/entry*100)*0.5+uPnl*0.5:uPnl;
}

function testConfig(allBars,startPct,endPct,cfg){
  const{minConv=4,minConds=2,adxMax=99,cd=6,deadH=true,minVR=0,mtfBlock=false,
    blockTrending=false,blockVolatile=false,blockHours=null,
    tpM=1.0,slM=0.8,tp1R=0.5,maxBars=24,scoreCfg={}}=cfg;
  let wins=0,losses=0,pnl=0;const lastBar={};
  for(const b of allBars){
    if(b.pct<startPct||b.pct>=endPct)continue;
    const sc=score(b.c,b.h,b.l,b.v,b.cur,b.atr,b.rsi,b.stoch,b.bb,b.mac,b.obvData,b.e21,scoreCfg);
    let signal='NEUTRAL';
    if(sc.B>sc.S&&sc.B>=minConv&&sc.bI>=minConds)signal='BUY';
    else if(sc.S>sc.B&&sc.S>=minConv&&sc.sI>=minConds)signal='SELL';
    if(signal==='NEUTRAL')continue;
    const lb=lastBar[b.sym]||-999;if(b.bar-lb<cd)continue;
    if(adxMax<99&&b.adx>adxMax)continue;
    if(deadH&&b.hUTC>=0&&b.hUTC<6)continue;
    if(sc.vr<minVR)continue;
    if(mtfBlock){if(signal==='BUY'&&b.mtf15==='SELL')continue;if(signal==='SELL'&&b.mtf15==='BUY')continue;}
    if(blockTrending&&b.regime==='TRENDING')continue;
    if(blockVolatile&&b.regime==='VOLATILE')continue;
    if(blockHours&&blockHours.includes(b.hUTC))continue;
    lastBar[b.sym]=b.bar;
    const tPnl=evalTrade(signal,b.cur,b.atr15,tpM,slM,tp1R,maxBars,b.fH,b.fL,b.fC);
    pnl+=tPnl;if(tPnl>0)wins++;else losses++;
  }
  const total=wins+losses;const len=Object.values(DATA)[0]?.len||1000;const days=len*(endPct-startPct)/288;
  return{total,wins,losses,wr:total>0?wins/total*100:0,pnl,spd:total/Math.max(0.5,days),days};
}

async function main(){
  console.log('═'.repeat(70));
  console.log('  FREE MODE OPTIMIZER — Mean-Reversion Light');
  console.log('═'.repeat(70)+'\n');
  await loadData();
  console.log('\n  Pre-computing...');const allBars=precompute();
  console.log(`  Done: ${allBars.length} bars\n`);

  const configs=[
    // ═══ CURRENT FREE MODE (trend-following) for reference ═══
    // Can't test exact current mode here since it uses different scoring
    // We'll test mean-reversion variants instead

    // ═══ CONVICTION LEVELS ═══
    {name:'Conv≥3 cd=4',cfg:{minConv:3,minConds:2,cd:4,deadH:true,tpM:1.0,slM:0.8,tp1R:0.5}},
    {name:'Conv≥4 cd=4',cfg:{minConv:4,minConds:2,cd:4,deadH:true,tpM:1.0,slM:0.8,tp1R:0.5}},
    {name:'Conv≥5 cd=4',cfg:{minConv:5,minConds:2,cd:4,deadH:true,tpM:1.0,slM:0.8,tp1R:0.5}},
    {name:'Conv≥5 cd=6',cfg:{minConv:5,minConds:2,cd:6,deadH:true,tpM:1.0,slM:0.8,tp1R:0.5}},
    {name:'Conv≥6 cd=4',cfg:{minConv:6,minConds:2,cd:4,deadH:true,tpM:1.0,slM:0.8,tp1R:0.5}},

    // ═══ TP/SL RATIOS ═══
    {name:'Conv≥4 TP1.2/SL0.8',cfg:{minConv:4,cd:4,deadH:true,tpM:1.2,slM:0.8,tp1R:0.5}},
    {name:'Conv≥4 TP1.0/SL1.0',cfg:{minConv:4,cd:4,deadH:true,tpM:1.0,slM:1.0,tp1R:0.5}},
    {name:'Conv≥4 TP1.5/SL1.0',cfg:{minConv:4,cd:4,deadH:true,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥5 TP1.5/SL1.0',cfg:{minConv:5,cd:4,deadH:true,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥5 TP1.2/SL1.0',cfg:{minConv:5,cd:4,deadH:true,tpM:1.2,slM:1.0,tp1R:0.5}},
    {name:'Conv≥4 TP0.8/SL0.8',cfg:{minConv:4,cd:4,deadH:true,tpM:0.8,slM:0.8,tp1R:0.5}},
    {name:'Conv≥5 TP1.0/SL0.7',cfg:{minConv:5,cd:6,deadH:true,tpM:1.0,slM:0.7,tp1R:0.5}},

    // ═══ ADX FILTERS ═══
    {name:'Conv≥5 ADX<25',cfg:{minConv:5,cd:4,deadH:true,adxMax:25,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥5 ADX<30',cfg:{minConv:5,cd:4,deadH:true,adxMax:30,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥4 ADX<25',cfg:{minConv:4,cd:4,deadH:true,adxMax:25,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥4 ADX<30',cfg:{minConv:4,cd:4,deadH:true,adxMax:30,tpM:1.5,slM:1.0,tp1R:0.6}},

    // ═══ BLOCK TRENDING/VOLATILE ═══
    {name:'Conv≥4 !TREND',cfg:{minConv:4,cd:4,deadH:true,blockTrending:true,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥5 !TREND',cfg:{minConv:5,cd:4,deadH:true,blockTrending:true,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥4 !TREND!VOL',cfg:{minConv:4,cd:4,deadH:true,blockTrending:true,blockVolatile:true,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥5 !TREND!VOL',cfg:{minConv:5,cd:4,deadH:true,blockTrending:true,blockVolatile:true,tpM:1.5,slM:1.0,tp1R:0.6}},

    // ═══ COOLDOWN VARIATIONS ═══
    {name:'Conv≥4 cd=8 !T TP1.5',cfg:{minConv:4,cd:8,deadH:true,blockTrending:true,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥5 cd=8 !T TP1.5',cfg:{minConv:5,cd:8,deadH:true,blockTrending:true,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥4 cd=12 !T TP1.5',cfg:{minConv:4,cd:12,deadH:true,blockTrending:true,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥5 cd=12 !T TP1.5',cfg:{minConv:5,cd:12,deadH:true,blockTrending:true,tpM:1.5,slM:1.0,tp1R:0.6}},

    // ═══ MTF + HOURS COMBOS ═══
    {name:'Conv≥4 cd=6 !T +MTF',cfg:{minConv:4,cd:6,deadH:true,blockTrending:true,mtfBlock:true,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥5 cd=6 !T +MTF',cfg:{minConv:5,cd:6,deadH:true,blockTrending:true,mtfBlock:true,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥4 cd=6 !T BH8,21,22',cfg:{minConv:4,cd:6,deadH:true,blockTrending:true,blockHours:[8,21,22],tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥5 cd=6 !T BH8,21,22',cfg:{minConv:5,cd:6,deadH:true,blockTrending:true,blockHours:[8,21,22],tpM:1.5,slM:1.0,tp1R:0.6}},

    // ═══ WIDER RSI THRESHOLDS ═══
    {name:'Conv≥3 cd=6 !T WideRSI',cfg:{minConv:3,cd:6,deadH:true,blockTrending:true,tpM:1.5,slM:1.0,tp1R:0.6,scoreCfg:{rsiLevels:[30,35,40,60,65,70]}}},
    {name:'Conv≥4 cd=6 !T WideRSI',cfg:{minConv:4,cd:6,deadH:true,blockTrending:true,tpM:1.5,slM:1.0,tp1R:0.6,scoreCfg:{rsiLevels:[30,35,40,60,65,70]}}},

    // ═══ BEST COMBOS ═══
    {name:'Conv≥4 cd=8 !T!V ADX30 BH',cfg:{minConv:4,cd:8,deadH:true,blockTrending:true,blockVolatile:true,adxMax:30,blockHours:[8,21,22],tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥5 cd=6 !T!V ADX30',cfg:{minConv:5,cd:6,deadH:true,blockTrending:true,blockVolatile:true,adxMax:30,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥5 cd=8 !T!V ADX30',cfg:{minConv:5,cd:8,deadH:true,blockTrending:true,blockVolatile:true,adxMax:30,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥4 cd=6 !T VR>0.3',cfg:{minConv:4,cd:6,deadH:true,blockTrending:true,minVR:0.3,tpM:1.5,slM:1.0,tp1R:0.6}},
    {name:'Conv≥5 cd=6 !T VR>0.3',cfg:{minConv:5,cd:6,deadH:true,blockTrending:true,minVR:0.3,tpM:1.5,slM:1.0,tp1R:0.6}},
  ];

  console.log('  Config                              | TRAIN WR  PnL    S/D    N | TEST WR   PnL    S/D    N | FULL WR   PnL    S/D    N');
  console.log('  '+'-'.repeat(130));

  let results=[];
  for(const{name,cfg}of configs){
    const train=testConfig(allBars,0,0.5,cfg);
    const test=testConfig(allBars,0.5,1.0,cfg);
    const full=testConfig(allBars,0,1.0,cfg);
    const fmtSeg=(r)=>`${r.wr.toFixed(1).padStart(5)}% ${(r.pnl>=0?'+':'')+r.pnl.toFixed(2).padStart(7)}% ${r.spd.toFixed(1).padStart(5)} ${String(r.total).padStart(4)}`;
    console.log(`  ${name.padEnd(37)} | ${fmtSeg(train)} | ${fmtSeg(test)} | ${fmtSeg(full)}`);
    results.push({name,cfg,train,test,full});
  }

  // Best configs profitable on both
  const both=results.filter(r=>r.train.pnl>0&&r.test.pnl>0&&r.full.spd>=15);
  both.sort((a,b)=>(b.train.pnl+b.test.pnl)-(a.train.pnl+a.test.pnl));
  console.log(`\n  ═══ PROFITABLE ON BOTH TRAIN+TEST (≥15 s/d): ${both.length} found ═══\n`);
  for(const r of both.slice(0,15)){
    console.log(`  ★ ${r.name}: TRAIN=${(r.train.pnl>=0?'+':'')}${r.train.pnl.toFixed(2)}% TEST=${(r.test.pnl>=0?'+':'')}${r.test.pnl.toFixed(2)}% FULL=${(r.full.pnl>=0?'+':'')}${r.full.pnl.toFixed(2)}% ${r.full.spd.toFixed(0)} s/d WR=${r.full.wr.toFixed(1)}%`);
  }

  // Best by test PnL with decent frequency
  const byTest=results.filter(r=>r.test.pnl>0&&r.full.spd>=15).sort((a,b)=>b.test.pnl-a.test.pnl);
  console.log(`\n  ═══ TOP 10 BY TEST PnL (≥15 s/d): ═══\n`);
  for(const r of byTest.slice(0,10)){
    console.log(`  ${r.name}: TRAIN=${(r.train.pnl>=0?'+':'')}${r.train.pnl.toFixed(2)}% TEST=${(r.test.pnl>=0?'+':'')}${r.test.pnl.toFixed(2)}% FULL=${(r.full.pnl>=0?'+':'')}${r.full.pnl.toFixed(2)}% ${r.full.spd.toFixed(0)} s/d WR=${r.full.wr.toFixed(1)}%`);
  }

  console.log('\n'+'═'.repeat(70));
}
main().catch(e=>console.error(e));
