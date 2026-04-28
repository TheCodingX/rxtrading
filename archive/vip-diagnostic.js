// ═══════════════════════════════════════════════════════════════════
// VIP STRICT MODE — DIAGNOSTIC: Where do signals die?
// Traces each rule's kill count to find the bottleneck
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
function detectRegime(H,L,C,adxPre,atrPre){const adx=adxPre||calcADX(H,L,C);const atr=atrPre||calcATR(H,L,C,14);const avgP=C.slice(-20).reduce((a,b)=>a+b)/20;const atrPct=atr/avgP*100;if(adx.adx>25&&(adx.pdi>adx.mdi*1.3||adx.mdi>adx.pdi*1.3))return{regime:'TRENDING'};if(atrPct>2.5)return{regime:'VOLATILE'};if(atrPct<0.5||adx.adx<15)return{regime:'QUIET'};return{regime:'RANGING'};}

let DATA={};
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

async function main(){
  console.log('═'.repeat(70));
  console.log('  VIP DIAGNOSTIC — Signal Kill Chain Analysis');
  console.log('═'.repeat(70)+'\n');

  await loadData();

  const LB=280;
  const kills={
    totalBars:0,
    regime_trending:0,regime_volatile:0,regime_quiet:0,regime_ranging:0,
    noSignal_lowScore:0,
    passed_scoring:0,
    R2_mtfContra:0,R3_deadVol:0,R4_deadHours:0,R5_volatile:0,
    R6_exhausted:0,R7_rsiProx:0,R8_emaOverext:0,R9_momContra:0,
    R10_htfContra:0,R13_antiTrap:0,R14_rsiGuard:0,
    R16_adxFloor:0,R17_adxDeadZone:0,R18_scoreMargin:0,
    R15_momAlign:0,R19_quietGate:0,R20_btcSell:0,R21_worstHours:0,
    R11_minVol:0,SR_block:0,
    survived:0,
  };
  const adxDist={};// ADX value distribution at signal generation

  for(const sym of Object.keys(DATA)){
    const d=DATA[sym];
    for(let bar=LB;bar<d.len-24;bar+=4){// sample every 4 bars
      kills.totalBars++;

      const c=d.C.slice(bar-279,bar+1),h=d.H.slice(bar-279,bar+1),l=d.L.slice(bar-279,bar+1),v=d.V.slice(bar-279,bar+1);
      const bt=d.T[bar];const hUTC=new Date(bt).getUTCHours();
      const cur=c.at(-1);

      // Regime
      const atr=calcATR(h,l,c,14);const adxData=calcADX(h,l,c);
      let regime='RANGING';
      try{regime=detectRegime(h,l,c,adxData,atr).regime||'RANGING';}catch(e){}
      const isTrending=(regime==='TRENDING');
      const isQuiet=(regime==='QUIET');
      const isVolatile=(regime==='VOLATILE');

      if(regime==='TRENDING'){kills.regime_trending++;continue;}// blocked
      if(regime==='VOLATILE'){kills.regime_volatile++;}
      if(regime==='QUIET'){kills.regime_quiet++;}
      if(regime==='RANGING'){kills.regime_ranging++;}

      // Scoring (simplified ranging/quiet mode)
      const rsi=calcRSI(c,14);const mac=calcMACD(c);const stFull=calcStoch(h,l,c,14);
      const bb=calcBB(c,20,2);const ea9=calcEMAArr(c,9),ea21=calcEMAArr(c,21);
      const e9=ea9.at(-1),e21=ea21.at(-1);const e50=calcEMA(c,50);
      const obvData=calcOBV(c,v);
      const avgV=v.slice(-20).reduce((a,b)=>a+b)/20;const vr=v.at(-1)/avgV;

      let B=0,S=0,buyInds=0,sellInds=0;
      if(rsi<32){B+=2.5;buyInds++;}else if(rsi>68){S+=2.5;sellInds++;}
      if(stFull.k>stFull.d&&stFull.k<25){B+=2;buyInds++;}else if(stFull.k<stFull.d&&stFull.k>75){S+=2;sellInds++;}
      // BB simplified
      const bbR=bb.u-bb.l;const bbP=bbR>0?(cur-bb.l)/bbR:0.5;
      if(bbP<0.05){B+=2;buyInds++;}else if(bbP>0.95){S+=2;sellInds++;}
      // MACD cross
      if(mac.h>0&&mac.ph<0){B+=1.5;buyInds++;}else if(mac.h<0&&mac.ph>0){S+=1.5;sellInds++;}
      // OBV
      if(obvData.rising){B+=0.8;buyInds++;}else{S+=0.8;sellInds++;}
      // EMA
      if(e9>e21){B+=0.5;buyInds++;}else{S+=0.5;sellInds++;}

      // Volume multiplier
      if(vr>1.5&&B>S)B*=1.1;
      else if(vr>1.5&&S>B)S*=1.1;

      let tot=Math.max(1,B+S);
      let conf=Math.min(99,Math.round((Math.max(B,S)/tot)*100));
      const isLowLiq=!['BTCUSDT','ETHUSDT'].includes(sym);
      if(isLowLiq)conf=Math.max(0,conf-3);

      const thr=2;const confReq=55;const minInds=2;
      let signal='NEUTRAL';
      if(B>S&&B>=thr&&conf>=confReq&&buyInds>=minInds)signal='BUY';
      else if(S>B&&S>=thr&&conf>=confReq&&sellInds>=minInds)signal='SELL';

      if(signal==='NEUTRAL'){kills.noSignal_lowScore++;continue;}
      kills.passed_scoring++;

      // Track ADX distribution at this point
      const adxBucket=Math.floor(adxData.adx/5)*5;
      adxDist[adxBucket]=(adxDist[adxBucket]||0)+1;

      // 1H trend
      let htfTrend='NEUTRAL',htfStrength=0;
      let c1e=0;for(let j=d.T1h.length-1;j>=0;j--){if(d.T1h[j]<=bt){c1e=j+1;break;}}
      const c1h=d.C1h.slice(Math.max(0,c1e-50),c1e);
      const h1h=d.H1h.slice(Math.max(0,c1e-50),c1e);
      const l1h=d.L1h.slice(Math.max(0,c1e-50),c1e);
      const v1h=d.V1h.slice(Math.max(0,c1e-50),c1e);
      if(c1h.length>25){
        const e9h=calcEMA(c1h,9),e21h=calcEMA(c1h,21),e50h=calcEMA(c1h,50);
        const r1h=calcRSI(c1h,14);const m1h=calcMACD(c1h);const a1h=calcADX(h1h,l1h,c1h);const o1h=calcOBV(c1h,v1h);
        let hB=0,hS=0;
        if(e9h>e21h)hB+=2;else hS+=2;if(c1h.at(-1)>e50h)hB+=1;else hS+=1;
        if(m1h.h>0)hB+=1.5;else hS+=1.5;if(m1h.h>m1h.ph)hB+=1;else hS+=1;
        if(r1h>50)hB+=1;else hS+=1;
        if(a1h.adx>20&&a1h.pdi>a1h.mdi)hB+=1.5;else if(a1h.adx>20&&a1h.mdi>a1h.pdi)hS+=1.5;
        if(o1h.rising)hB+=1;else hS+=1;
        if(hB>hS+2){htfTrend='BUY';htfStrength=hB-hS;}
        else if(hS>hB+2){htfTrend='SELL';htfStrength=hS-hB;}
      }

      // 15m confirm
      let mtfConfirm='NEUTRAL';
      let c15e=0;for(let j=d.T15.length-1;j>=0;j--){if(d.T15[j]<=bt){c15e=j+1;break;}}
      const c15=d.C15.slice(Math.max(0,c15e-100),c15e);
      if(c15.length>25){
        const e9_15=calcEMA(c15,9),e21_15=calcEMA(c15,21);const m15=calcMACD(c15);
        let mB=0,mS=0;if(e9_15>e21_15)mB+=1;else mS+=1;if(m15.h>0)mB+=1;else mS+=1;
        if(mB>mS)mtfConfirm='BUY';else if(mS>mB)mtfConfirm='SELL';
      }

      // Apply rules one by one
      const before=signal;

      // R2
      if(signal==='BUY'&&mtfConfirm==='SELL'&&htfTrend!=='BUY'){kills.R2_mtfContra++;continue;}
      if(signal==='SELL'&&mtfConfirm==='BUY'&&htfTrend!=='SELL'){kills.R2_mtfContra++;continue;}
      // R3
      if(signal!=='NEUTRAL'&&vr<0.5){kills.R3_deadVol++;continue;}
      // R4
      if(signal!=='NEUTRAL'&&hUTC>=0&&hUTC<6){kills.R4_deadHours++;continue;}
      // R5
      if(signal!=='NEUTRAL'&&isVolatile){kills.R5_volatile++;continue;}
      // R6
      const last4C=c.slice(-4);
      const bullExh=last4C.every((x,i)=>i===0||x>last4C[i-1]);
      const bearExh=last4C.every((x,i)=>i===0||x<last4C[i-1]);
      if(signal==='BUY'&&bullExh){kills.R6_exhausted++;continue;}
      if(signal==='SELL'&&bearExh){kills.R6_exhausted++;continue;}
      // R7
      if(signal==='BUY'&&rsi>65){kills.R7_rsiProx++;continue;}
      if(signal==='SELL'&&rsi<35){kills.R7_rsiProx++;continue;}
      // R8
      const dEMA=Math.abs(cur-e21)/atr;
      if(signal==='BUY'&&cur>e21&&dEMA>2.0){kills.R8_emaOverext++;continue;}
      if(signal==='SELL'&&cur<e21&&dEMA>2.0){kills.R8_emaOverext++;continue;}
      // R9
      const mom3=(cur-(c[c.length-4]||cur))/atr;
      let bP=0,sP=0;
      for(let i=c.length-5;i<c.length;i++){const o=i>0?c[i-1]:c[i];const body=c[i]-o;if(body>0){bP+=body;}else{sP+=Math.abs(body);}}
      const fR=bP/Math.max(0.001,sP);
      if(signal==='BUY'&&mom3<-0.5&&fR<0.7){kills.R9_momContra++;continue;}
      if(signal==='SELL'&&mom3>0.5&&fR>1.4){kills.R9_momContra++;continue;}
      // R10
      if(!isTrending&&htfStrength>=4){
        if(signal==='BUY'&&htfTrend==='SELL'){kills.R10_htfContra++;continue;}
        if(signal==='SELL'&&htfTrend==='BUY'){kills.R10_htfContra++;continue;}
      }
      // R13
      if(!isTrending){
        const lastBody=(c.at(-1)-(c.at(-2)||c.at(-1)))/atr;
        if(signal==='BUY'&&lastBody<-0.7){kills.R13_antiTrap++;continue;}
        if(signal==='SELL'&&lastBody>0.7){kills.R13_antiTrap++;continue;}
      }
      // R14
      if(!isTrending){
        if(signal==='BUY'&&rsi>55){kills.R14_rsiGuard++;continue;}
        if(signal==='SELL'&&rsi<38){kills.R14_rsiGuard++;continue;}
      }
      // R16
      if(adxData.adx<15){kills.R16_adxFloor++;continue;}
      // R17
      if(!isTrending&&adxData.adx>=18&&adxData.adx<=25){kills.R17_adxDeadZone++;continue;}
      if(!isTrending&&adxData.adx>30){kills.R17_adxDeadZone++;continue;}
      // R18
      const scoreMargin=signal==='BUY'?B-S:S-B;
      if(scoreMargin<2.0){kills.R18_scoreMargin++;continue;}
      // R15
      const c1=c.at(-1)||0,c3=c.at(-3)||0,c4=c.at(-4)||0;
      const sMom=(c1-c3)/atr;const lMom=(c1-c4)/atr;
      if(signal==='BUY'&&sMom<-0.3&&lMom<-0.3){kills.R15_momAlign++;continue;}
      if(signal==='SELL'&&sMom>0.3&&lMom>0.3){kills.R15_momAlign++;continue;}
      // R19
      if(isQuiet){
        if(htfTrend!==signal){kills.R19_quietGate++;continue;}
      }
      // R20
      if(signal==='SELL'&&sym==='BTCUSDT'&&!isTrending){kills.R20_btcSell++;continue;}
      // R21
      if(hUTC===7||hUTC===13||hUTC===23){kills.R21_worstHours++;continue;}

      kills.survived++;
    }
  }

  console.log('\n  SIGNAL KILL CHAIN — Where do signals die?\n');
  console.log(`  Total bars sampled:    ${kills.totalBars}`);
  console.log(`  Killed by TRENDING:    ${kills.regime_trending} (${(kills.regime_trending/kills.totalBars*100).toFixed(1)}%)`);
  console.log(`  ─── After regime filter: ${kills.totalBars-kills.regime_trending} bars remaining`);
  console.log(`  Regime breakdown:`);
  console.log(`    RANGING:   ${kills.regime_ranging}`);
  console.log(`    QUIET:     ${kills.regime_quiet}`);
  console.log(`    VOLATILE:  ${kills.regime_volatile}`);
  console.log();
  console.log(`  Low score / no signal: ${kills.noSignal_lowScore} (${(kills.noSignal_lowScore/(kills.totalBars-kills.regime_trending)*100).toFixed(1)}%)`);
  console.log(`  ─── Passed scoring:    ${kills.passed_scoring} signals generated`);
  console.log();

  const ruleKills=[
    ['R2:  15m contradiction',kills.R2_mtfContra],
    ['R3:  Dead volume <0.5',kills.R3_deadVol],
    ['R4:  Dead hours 00-06',kills.R4_deadHours],
    ['R5:  Volatile regime',kills.R5_volatile],
    ['R6:  Candle exhaustion',kills.R6_exhausted],
    ['R7:  RSI proximity',kills.R7_rsiProx],
    ['R8:  EMA overextended',kills.R8_emaOverext],
    ['R9:  Momentum contradiction',kills.R9_momContra],
    ['R10: HTF contra (str>=4)',kills.R10_htfContra],
    ['R13: Anti-trap big candle',kills.R13_antiTrap],
    ['R14: RSI guard (BUY>55/SELL<38)',kills.R14_rsiGuard],
    ['R16: ADX floor <15',kills.R16_adxFloor],
    ['R17: ADX dead zone 18-25 or >30',kills.R17_adxDeadZone],
    ['R18: Score margin <2',kills.R18_scoreMargin],
    ['R15: Momentum alignment',kills.R15_momAlign],
    ['R19: QUIET gate',kills.R19_quietGate],
    ['R20: BTC SELL filter',kills.R20_btcSell],
    ['R21: Worst hours (7,13,23)',kills.R21_worstHours],
  ];

  ruleKills.sort((a,b)=>b[1]-a[1]);
  let remaining=kills.passed_scoring;
  console.log('  HARD RULE KILLS (sorted by impact):\n');
  for(const [name,count] of ruleKills){
    if(count===0)continue;
    const pct=(count/kills.passed_scoring*100).toFixed(1);
    const bar='█'.repeat(Math.min(50,Math.round(count/kills.passed_scoring*50)));
    console.log(`    ${name.padEnd(40)} ${String(count).padStart(5)} killed (${pct.padStart(5)}%) ${bar}`);
    remaining-=count;
  }
  console.log();
  console.log(`  ═══ SURVIVED ALL RULES: ${kills.survived} signals (${(kills.survived/kills.passed_scoring*100).toFixed(1)}% of generated)`);
  console.log(`  ═══ That's ${(kills.survived/(kills.totalBars/4)*100).toFixed(2)}% of all bars → ${(kills.survived/3.5).toFixed(1)} signals/day`);

  console.log('\n  ADX DISTRIBUTION at signal generation:\n');
  const sortedADX=Object.entries(adxDist).sort((a,b)=>+a[0]-+b[0]);
  for(const [bucket,count] of sortedADX){
    const bar='█'.repeat(Math.round(count/kills.passed_scoring*80));
    console.log(`    ADX ${String(bucket).padStart(2)}-${String(+bucket+4).padStart(2)}: ${String(count).padStart(4)} ${bar}`);
  }

  console.log('\n'+'═'.repeat(70));
}

main().catch(console.error);
