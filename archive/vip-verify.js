// ═══════════════════════════════════════════════════════════════════
// VIP v2 VERIFY — Quick validation that app.html VIP matches optimizer
// Run EXACT same logic as now in app.html to confirm walk-forward results
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
function calcOBV(C,V){if(C.length<2)return{obv:0,slope:0,rising:false};let obv=0;const arr=[0];for(let i=1;i<C.length;i++){if(C[i]>C[i-1])obv+=V[i];else if(C[i]<C[i-1])obv-=V[i];arr.push(obv);}const n=Math.min(20,arr.length);const sl=arr.slice(-n);let sx=0,sy=0,sxx=0,sxy=0;for(let i=0;i<n;i++){sx+=i;sy+=sl[i];sxx+=i*i;sxy+=i*sl[i];}const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx||1);return{obv,slope,rising:slope>0};}
function detectRegime(H,L,C,adxPre,atrPre){const adx=adxPre||calcADX(H,L,C);const atr=atrPre||calcATR(H,L,C,14);const avgP=C.slice(-20).reduce((a,b)=>a+b)/20;const atrPct=atr/avgP*100;if(adx.adx>25&&(adx.pdi>adx.mdi*1.3||adx.mdi>adx.pdi*1.3))return'TRENDING';if(atrPct>2.5)return'VOLATILE';if(atrPct<0.5||adx.adx<15)return'QUIET';return'RANGING';}

let DATA={};
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

// ═══ EXACT REPLICA of app.html VIP v2 scoring + decision ═══
function genVIPSignal(c,h,l,v,cur,atr,adxData,rsi,stoch,bb,mac,obvData,e9,e21,hUTC,regime){
  let B=0,S=0,buyInds=0,sellInds=0;

  // RSI extremes
  if(rsi<25){B+=4;buyInds++;}else if(rsi<30){B+=3;buyInds++;}else if(rsi<35){B+=2;buyInds++;}
  else if(rsi>75){S+=4;sellInds++;}else if(rsi>70){S+=3;sellInds++;}else if(rsi>65){S+=2;sellInds++;}

  // Stoch extremes
  if(stoch.k<20){B+=3;buyInds++;}else if(stoch.k<30){B+=2;buyInds++;}
  else if(stoch.k>80){S+=3;sellInds++;}else if(stoch.k>70){S+=2;sellInds++;}

  // BB position
  const bbR=bb.u-bb.l;const bbP=bbR>0?(cur-bb.l)/bbR:0.5;
  if(bbP<0.1){B+=3;buyInds++;}else if(bbP<0.2){B+=2;buyInds++;}
  else if(bbP>0.9){S+=3;sellInds++;}else if(bbP>0.8){S+=2;sellInds++;}

  // Momentum exhaustion (CONTRARIAN)
  const mom3=(cur-(c[c.length-4]||cur))/Math.max(atr,0.0001);
  if(mom3<-1){B+=2;buyInds++;}else if(mom3<-0.5){B+=1;buyInds++;}
  else if(mom3>1){S+=2;sellInds++;}else if(mom3>0.5){S+=1;sellInds++;}

  // Candle exhaustion
  let bearRun=0,bullRun=0;
  for(let i=Math.max(0,c.length-4);i<c.length;i++){
    if(c[i]<(c[i-1]||c[i]))bearRun++;else bearRun=0;
    if(c[i]>(c[i-1]||c[i]))bullRun++;else bullRun=0;
  }
  if(bearRun>=4){B+=2;buyInds++;}else if(bearRun>=3){B+=1;buyInds++;}
  if(bullRun>=4){S+=2;sellInds++;}else if(bullRun>=3){S+=1;sellInds++;}

  // EMA overextension
  const emaDist=(cur-e21)/Math.max(atr,0.0001);
  if(emaDist<-1.5){B+=1.5;buyInds++;}else if(emaDist<-0.8){B+=0.8;buyInds++;}
  else if(emaDist>1.5){S+=1.5;sellInds++;}else if(emaDist>0.8){S+=0.8;sellInds++;}

  // MACD cross
  if(mac.h>0&&mac.ph<=0){B+=1.5;buyInds++;}else if(mac.h<0&&mac.ph>=0){S+=1.5;sellInds++;}

  // OBV
  if(obvData.rising&&B>S){B+=1;buyInds++;}else if(!obvData.rising&&S>B){S+=1;sellInds++;}

  // Volume spike
  const avgV=v.slice(-20).reduce((a,b)=>a+b)/20;const vr=v.at(-1)/avgV;
  if(vr>1.5){if(B>S)B*=1.1;else S*=1.1;}

  // Decision: Conv≥8, Conds≥3
  let signal='NEUTRAL';
  if(regime==='TRENDING')return{signal:'NEUTRAL',B,S};
  if(B>S&&B>=8&&buyInds>=3)signal='BUY';
  else if(S>B&&S>=8&&sellInds>=3)signal='SELL';

  // F1: ADX<20
  if(signal!=='NEUTRAL'&&adxData.adx>20)signal='NEUTRAL';
  // F2: Block hours 8, 21, 22
  if(signal!=='NEUTRAL'&&(hUTC===8||hUTC===21||hUTC===22))signal='NEUTRAL';
  // F3: No volatile
  if(signal!=='NEUTRAL'&&regime==='VOLATILE')signal='NEUTRAL';

  return{signal,B,S,buyInds,sellInds};
}

function evalTrade(sig,entry,atr15,fH,fL,fC){
  const tpM=1.5,slM=1.0;
  const tp=atr15*tpM,sl=atr15*slM;const cost=entry*0.0008;
  const tp1=tp*0.6;const trail=atr15*0.1;const maxBars=36;
  const tp1P=sig==='BUY'?entry+tp1+cost:entry-tp1-cost;
  const slP=sig==='BUY'?entry-sl-cost:entry+sl+cost;
  const tpFullP=sig==='BUY'?entry+tp+cost:entry-tp-cost;
  let tp1Hit=false;let best=sig==='BUY'?-Infinity:Infinity;
  for(let i=0;i<Math.min(maxBars,fH.length);i++){
    if(sig==='BUY'){
      if(!tp1Hit){if(fL[i]<=slP)return -(sl+cost)/entry*100;if(fH[i]>=tp1P)tp1Hit=true;}
      if(tp1Hit){best=Math.max(best,fH[i]);if(fL[i]<=best-trail-cost){const r=(fC[i]-entry-cost)/entry*100;return(tp1/entry*100)*0.5+r*0.5;}if(fH[i]>=tpFullP)return(tp1/entry*100)*0.5+(tp/entry*100)*0.5;if(fL[i]<=entry)return(tp1/entry*100)*0.5;}
    }else{
      if(!tp1Hit){if(fH[i]>=slP)return -(sl+cost)/entry*100;if(fL[i]<=tp1P)tp1Hit=true;}
      if(tp1Hit){best=Math.min(best,fL[i]);if(fH[i]>=best+trail+cost){const r=(entry-fC[i]-cost)/entry*100;return(tp1/entry*100)*0.5+r*0.5;}if(fL[i]<=tpFullP)return(tp1/entry*100)*0.5+(tp/entry*100)*0.5;if(fH[i]>=entry)return(tp1/entry*100)*0.5;}
    }
  }
  const last=fC[Math.min(maxBars,fH.length)-1]||entry;
  const uPnl=sig==='BUY'?(last-entry-cost)/entry*100:(entry-last-cost)/entry*100;
  return tp1Hit?(tp1/entry*100)*0.5+uPnl*0.5:uPnl;
}

async function main(){
  console.log('═'.repeat(70));
  console.log('  VIP v2 VERIFICATION — Exact app.html logic replication');
  console.log('═'.repeat(70)+'\n');

  await loadData();

  const LB=280,FUT=48;
  let trainW=0,trainL=0,trainPnl=0,testW=0,testL=0,testPnl=0;
  let fullW=0,fullL=0,fullPnl=0;
  const lastBar={};const lastBarTrain={};const lastBarTest={};
  const cd=8; // default cooldown from optimizer
  const trades=[];

  for(const sym of Object.keys(DATA)){
    const d=DATA[sym];
    for(let bar=LB;bar<d.len-FUT;bar++){
      const c=d.C.slice(bar-279,bar+1),h=d.H.slice(bar-279,bar+1),l=d.L.slice(bar-279,bar+1),v=d.V.slice(bar-279,bar+1);
      const bt=d.T[bar];const hUTC=new Date(bt).getUTCHours();
      const cur=c.at(-1);
      const atr=calcATR(h,l,c,14);const adxData=calcADX(h,l,c);
      const rsi=calcRSI(c,14);const mac=calcMACD(c);
      const ea9=calcEMAArr(c,9),ea21=calcEMAArr(c,21);
      const e9=ea9.at(-1),e21=ea21.at(-1);
      const bb=calcBB(c,20,2);const stoch=calcStoch(h,l,c,14);
      const obvData=calcOBV(c,v);
      const regime=detectRegime(h,l,c,adxData,atr);

      // ATR15
      let c15e=0;for(let j=d.T15.length-1;j>=0;j--){if(d.T15[j]<=bt){c15e=j+1;break;}}
      const c15=d.C15.slice(Math.max(0,c15e-100),c15e);
      const h15=d.H15.slice(Math.max(0,c15e-100),c15e);
      const l15=d.L15.slice(Math.max(0,c15e-100),c15e);
      let atr15=atr;if(h15.length>15&&l15.length>15&&c15.length>15){const a=calcATR(h15,l15,c15,14);if(a>0)atr15=a;}

      const sig=genVIPSignal(c,h,l,v,cur,atr,adxData,rsi,stoch,bb,mac,obvData,e9,e21,hUTC,regime);
      if(sig.signal==='NEUTRAL')continue;

      // Cooldown
      const lb=lastBar[sym]||-999;if(bar-lb<cd)continue;
      lastBar[sym]=bar;

      // Min volatility (Rule 11)
      const volPct=atr15/cur;if(volPct<0.0008)continue;

      // Future data
      const fH=[],fL=[],fC=[];
      for(let f=bar+1;f<=Math.min(bar+FUT,d.len-1);f++){fH.push(d.H[f]);fL.push(d.L[f]);fC.push(d.C[f]);}

      const tPnl=evalTrade(sig.signal,cur,atr15,fH,fL,fC);
      const pct=bar/d.len;

      fullPnl+=tPnl;if(tPnl>0)fullW++;else fullL++;
      if(pct<0.5){trainPnl+=tPnl;if(tPnl>0)trainW++;else trainL++;}
      else{testPnl+=tPnl;if(tPnl>0)testW++;else testL++;}
      trades.push({sym,signal:sig.signal,pnl:tPnl,hUTC,adx:adxData.adx,pct});
    }
  }

  const days=(Object.values(DATA)[0]?.len||1000)/288;
  const trainN=trainW+trainL,testN=testW+testL,fullN=fullW+fullL;

  console.log('\n  ══════════════════════════════════════════════════════════════════');
  console.log('  VIP v2 VERIFICATION RESULTS');
  console.log('  ══════════════════════════════════════════════════════════════════\n');
  console.log(`  TRAIN (0-50%):  WR=${trainN?((trainW/trainN*100).toFixed(1)):0}%, PnL=${(trainPnl>=0?'+':'')}${trainPnl.toFixed(2)}%, ${(trainN/(days/2)).toFixed(1)} s/d, ${trainN} sigs (${trainW}W/${trainL}L)`);
  console.log(`  TEST  (50-100%):WR=${testN?((testW/testN*100).toFixed(1)):0}%, PnL=${(testPnl>=0?'+':'')}${testPnl.toFixed(2)}%, ${(testN/(days/2)).toFixed(1)} s/d, ${testN} sigs (${testW}W/${testL}L)`);
  console.log(`  FULL:           WR=${fullN?((fullW/fullN*100).toFixed(1)):0}%, PnL=${(fullPnl>=0?'+':'')}${fullPnl.toFixed(2)}%, ${(fullN/days).toFixed(1)} s/d, ${fullN} sigs (${fullW}W/${fullL}L)`);
  console.log(`  Avg PnL/trade:  ${fullN?(fullPnl/fullN).toFixed(3):0}%`);
  console.log(`  Profit Factor:  ${fullL>0?(trades.filter(t=>t.pnl>0).reduce((a,t)=>a+t.pnl,0)/Math.abs(trades.filter(t=>t.pnl<=0).reduce((a,t)=>a+t.pnl,0))).toFixed(2):'∞'}`);

  // By symbol
  console.log('\n  BY SYMBOL:');
  const bySym={};for(const t of trades){if(!bySym[t.sym])bySym[t.sym]={w:0,l:0,pnl:0};if(t.pnl>0)bySym[t.sym].w++;else bySym[t.sym].l++;bySym[t.sym].pnl+=t.pnl;}
  for(const[sym,d]of Object.entries(bySym).sort((a,b)=>b[1].pnl-a[1].pnl)){
    const tot=d.w+d.l;console.log(`    ${sym.padEnd(10)} ${String(tot).padStart(2)} sigs, WR=${(d.w/tot*100).toFixed(0).padStart(3)}%, PnL=${(d.pnl>=0?'+':'')}${d.pnl.toFixed(2)}%`);}

  // Quarterly
  console.log('\n  QUARTERLY:');
  for(let q=0;q<4;q++){
    const qt=trades.filter(t=>t.pct>=q*0.25&&t.pct<(q+1)*0.25);
    const qw=qt.filter(t=>t.pnl>0).length;const ql=qt.length-qw;
    const qp=qt.reduce((a,t)=>a+t.pnl,0);
    console.log(`    Q${q+1}: WR=${qt.length?(qw/qt.length*100).toFixed(1).padStart(5):'  0.0'}%, PnL=${(qp>=0?'+':'')}${qp.toFixed(2).padStart(6)}%, ${(qt.length/(days/4)).toFixed(1)} s/d, ${qt.length} sigs`);
  }

  console.log('\n  ✅ If these match optimizer results, app.html VIP v2 is correctly implemented.');
  console.log('═'.repeat(70));
}
main().catch(e=>console.error(e));
