// ═══════════════════════════════════════════════════════════════════
// VIP STRICT MODE — Rule Optimization via Walk-Forward
// Tests different rule configs and validates on unseen data
// Goal: Find the minimum relaxation that gives 3-8 signals/day
//       with >55% WR and positive PnL
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

// Pre-compute all indicator data at each bar
function precompute(){
  const LB=280,FUT=24;
  const allBars=[];
  for(const sym of Object.keys(DATA)){
    const d=DATA[sym];
    for(let bar=LB;bar<d.len-FUT;bar++){
      const c=d.C.slice(bar-279,bar+1),h=d.H.slice(bar-279,bar+1),l=d.L.slice(bar-279,bar+1),v=d.V.slice(bar-279,bar+1);
      const bt=d.T[bar];const hUTC=new Date(bt).getUTCHours();
      const cur=c.at(-1);
      const atr=calcATR(h,l,c,14);const adxData=calcADX(h,l,c);
      let regime='RANGING';try{regime=detectRegime(h,l,c,adxData,atr).regime||'RANGING';}catch(e){}
      const isTrending=(regime==='TRENDING');
      const isQuiet=(regime==='QUIET');
      const isVolatile=(regime==='VOLATILE');

      const rsi=calcRSI(c,14);const mac=calcMACD(c);
      const ea9=calcEMAArr(c,9),ea21=calcEMAArr(c,21);
      const e9=ea9.at(-1),e21=ea21.at(-1),e9p=ea9.at(-2),e21p=ea21.at(-2);
      const e50=calcEMA(c,50);
      const bb=calcBB(c,20,2);
      const stFull=calcStoch(h,l,c,14);
      const avgV=v.slice(-20).reduce((a,b)=>a+b)/20;const vr=v.at(-1)/avgV;
      const obvData=calcOBV(c,v);
      const mom3=(cur-(c[c.length-4]||cur))/Math.max(atr,0.0001);

      // Scoring (ranging/quiet)
      let B=0,S=0,buyInds=0,sellInds=0;
      if(!isTrending){
        if(rsi<32){B+=2.5;buyInds++;}else if(rsi>68){S+=2.5;sellInds++;}
        if(stFull.k>stFull.d&&stFull.k<25){B+=2;buyInds++;}else if(stFull.k<stFull.d&&stFull.k>75){S+=2;sellInds++;}
        const bbR=bb.u-bb.l;const bbP=bbR>0?(cur-bb.l)/bbR:0.5;
        if(bbP<0.05){B+=2;buyInds++;}else if(bbP>0.95){S+=2;sellInds++;}
        if(mac.h>0&&mac.ph<0){B+=1.5;buyInds++;}else if(mac.h<0&&mac.ph>0){S+=1.5;sellInds++;}
        if(obvData.rising){B+=0.8;buyInds++;}else{S+=0.8;sellInds++;}
        if(e9>e21){B+=0.5;buyInds++;}else{S+=0.5;sellInds++;}
      }
      if(vr>1.5&&B>S)B*=1.1;else if(vr>1.5&&S>B)S*=1.1;

      let tot=Math.max(1,B+S);let conf=Math.min(99,Math.round((Math.max(B,S)/tot)*100));
      if(!['BTCUSDT','ETHUSDT'].includes(sym))conf=Math.max(0,conf-3);

      const thr=2;const confReq=55;const minInds=2;
      let rawSignal='NEUTRAL';
      if(B>S&&B>=thr&&conf>=confReq&&buyInds>=minInds)rawSignal='BUY';
      else if(S>B&&S>=thr&&conf>=confReq&&sellInds>=minInds)rawSignal='SELL';

      // 1H trend
      let htfTrend='NEUTRAL',htfStrength=0;
      let c1e=0;for(let j=d.T1h.length-1;j>=0;j--){if(d.T1h[j]<=bt){c1e=j+1;break;}}
      const c1h=d.C1h.slice(Math.max(0,c1e-50),c1e);const h1h=d.H1h.slice(Math.max(0,c1e-50),c1e);
      const l1h=d.L1h.slice(Math.max(0,c1e-50),c1e);const v1h=d.V1h.slice(Math.max(0,c1e-50),c1e);
      if(c1h.length>25){
        let hB=0,hS=0;const e9h=calcEMA(c1h,9),e21h=calcEMA(c1h,21),e50h=calcEMA(c1h,50);
        const m1h=calcMACD(c1h);const a1h=calcADX(h1h,l1h,c1h);const o1h=calcOBV(c1h,v1h);
        if(e9h>e21h)hB+=2;else hS+=2;if(c1h.at(-1)>e50h)hB+=1;else hS+=1;
        if(m1h.h>0)hB+=1.5;else hS+=1.5;if(m1h.h>m1h.ph)hB+=1;else hS+=1;
        if(calcRSI(c1h,14)>50)hB+=1;else hS+=1;
        if(a1h.adx>20&&a1h.pdi>a1h.mdi)hB+=1.5;else if(a1h.adx>20&&a1h.mdi>a1h.pdi)hS+=1.5;
        if(o1h.rising)hB+=1;else hS+=1;
        if(hB>hS+2){htfTrend='BUY';htfStrength=hB-hS;}
        else if(hS>hB+2){htfTrend='SELL';htfStrength=hS-hB;}
      }

      let mtfConfirm='NEUTRAL';
      let c15e=0;for(let j=d.T15.length-1;j>=0;j--){if(d.T15[j]<=bt){c15e=j+1;break;}}
      const c15=d.C15.slice(Math.max(0,c15e-100),c15e);
      if(c15.length>25){
        let mB=0,mS=0;if(calcEMA(c15,9)>calcEMA(c15,21))mB+=1;else mS+=1;
        if(calcMACD(c15).h>0)mB+=1;else mS+=1;
        if(mB>mS)mtfConfirm='BUY';else if(mS>mB)mtfConfirm='SELL';
      }

      const last4=c.slice(-4);
      const bullExh=last4.every((x,i)=>i===0||x>last4[i-1]);
      const bearExh=last4.every((x,i)=>i===0||x<last4[i-1]);
      const lastBody=(c.at(-1)-(c.at(-2)||c.at(-1)))/Math.max(atr,0.0001);
      let bP=0,sP=0;for(let i=c.length-5;i<c.length;i++){const o=i>0?c[i-1]:c[i];const body=c[i]-o;if(body>0)bP+=body;else sP+=Math.abs(body);}
      const fR=bP/Math.max(0.001,sP);const flowBull=fR>1.4;const flowBear=fR<0.7;
      const shortMom=(c.at(-1)-(c.at(-3)||cur))/Math.max(atr,0.0001);
      const longMom=(c.at(-1)-(c.at(-4)||cur))/Math.max(atr,0.0001);
      const scoreMargin=rawSignal==='BUY'?B-S:S-B;

      // ATR15 for TP/SL
      const h15=d.H15.slice(Math.max(0,c15e-100),c15e);const l15=d.L15.slice(Math.max(0,c15e-100),c15e);
      let atr15=atr;if(h15.length>15&&l15.length>15&&c15.length>15){const a=calcATR(h15,l15,c15,14);if(a>0)atr15=a;}

      // Future data
      const fH=[],fL=[],fC=[];
      for(let f=bar+1;f<=Math.min(bar+FUT,d.len-1);f++){fH.push(d.H[f]);fL.push(d.L[f]);fC.push(d.C[f]);}

      allBars.push({
        sym,bar,hUTC,cur,atr,atr15,adx:adxData.adx,
        isTrending,isQuiet,isVolatile,regime,
        rawSignal,B,S,buyInds,sellInds,conf,
        rsi,mom3,vr,
        htfTrend,htfStrength,mtfConfirm,
        bullExh,bearExh,lastBody,flowBull,flowBear,
        shortMom,longMom,scoreMargin,e21,
        fH,fL,fC,pct:bar/d.len
      });
    }
  }
  return allBars;
}

function evalTrade(sig,entry,atr15,tpM,slM,fH,fL,fC,maxBars=24){
  const tp=atr15*tpM,sl=atr15*slM;const cost=entry*0.0008;
  const tp1=tp*0.6;
  const tp1P=sig==='BUY'?entry+tp1+cost:entry-tp1-cost;
  const slP=sig==='BUY'?entry-sl-cost:entry+sl+cost;
  const tpFullP=sig==='BUY'?entry+tp+cost:entry-tp-cost;
  let tp1Hit=false;
  for(let i=0;i<Math.min(maxBars,fH.length);i++){
    if(sig==='BUY'){
      if(!tp1Hit){if(fL[i]<=slP)return -(sl+cost)/entry*100;if(fH[i]>=tp1P)tp1Hit=true;}
      if(tp1Hit){if(fL[i]<=entry)return(tp1/entry*100)*0.5;if(fH[i]>=tpFullP)return(tp1/entry*100)*0.5+(tp/entry*100)*0.5;}
    }else{
      if(!tp1Hit){if(fH[i]>=slP)return -(sl+cost)/entry*100;if(fL[i]<=tp1P)tp1Hit=true;}
      if(tp1Hit){if(fH[i]>=entry)return(tp1/entry*100)*0.5;if(fL[i]<=tpFullP)return(tp1/entry*100)*0.5+(tp/entry*100)*0.5;}
    }
  }
  const last=fC[Math.min(maxBars,fH.length)-1]||entry;
  const uPnl=sig==='BUY'?last-entry:entry-last;
  return tp1Hit?(tp1/entry*100)*0.5+(uPnl/entry*100)*0.5:(uPnl-cost)/entry*100;
}

function testConfig(allBars,startPct,endPct,cfg){
  const {
    blockTrending=true,r2_mtf=true,r3_volFloor=0.5,r4_deadHours=true,r5_volatile=true,
    r6_exhaustion=true,r7_rsiCap=[65,35],r8_emaOverext=2.0,r9_momContra=true,
    r10_htfStr=4,r13_antiTrap=0.7,r14_rsiGuard=[55,38],
    r16_adxFloor=15,r17_adxDead=[18,25,30],r18_marginMin=2.0,
    r15_momAlign=0.3,r19_quietGate=true,r20_btcSell=true,r21_hours=[7,13,23],
    tpM=0.65,slM=0.80,cd=8
  }=cfg;

  let wins=0,losses=0,pnl=0,count=0;
  const lastBar={};

  for(const b of allBars){
    if(b.pct<startPct||b.pct>=endPct)continue;
    if(blockTrending&&b.isTrending)continue;
    if(b.rawSignal==='NEUTRAL')continue;

    const lb=lastBar[b.sym]||-999;
    if(b.bar-lb<cd)continue;

    let signal=b.rawSignal;

    if(r2_mtf){
      if(signal==='BUY'&&b.mtfConfirm==='SELL'&&b.htfTrend!=='BUY')signal='NEUTRAL';
      if(signal==='SELL'&&b.mtfConfirm==='BUY'&&b.htfTrend!=='SELL')signal='NEUTRAL';
    }
    if(signal!=='NEUTRAL'&&b.vr<r3_volFloor)signal='NEUTRAL';
    if(r4_deadHours&&signal!=='NEUTRAL'&&b.hUTC>=0&&b.hUTC<6)signal='NEUTRAL';
    if(r5_volatile&&signal!=='NEUTRAL'&&b.isVolatile)signal='NEUTRAL';
    if(r6_exhaustion){
      if(signal==='BUY'&&b.bullExh)signal='NEUTRAL';
      if(signal==='SELL'&&b.bearExh)signal='NEUTRAL';
    }
    if(signal==='BUY'&&b.rsi>r7_rsiCap[0])signal='NEUTRAL';
    if(signal==='SELL'&&b.rsi<r7_rsiCap[1])signal='NEUTRAL';
    if(r8_emaOverext>0){
      const d=Math.abs(b.cur-b.e21)/b.atr;
      if(signal==='BUY'&&b.cur>b.e21&&d>r8_emaOverext)signal='NEUTRAL';
      if(signal==='SELL'&&b.cur<b.e21&&d>r8_emaOverext)signal='NEUTRAL';
    }
    if(r9_momContra){
      if(signal==='BUY'&&b.mom3<-0.5&&b.flowBear)signal='NEUTRAL';
      if(signal==='SELL'&&b.mom3>0.5&&b.flowBull)signal='NEUTRAL';
    }
    if(!b.isTrending&&b.htfStrength>=r10_htfStr){
      if(signal==='BUY'&&b.htfTrend==='SELL')signal='NEUTRAL';
      if(signal==='SELL'&&b.htfTrend==='BUY')signal='NEUTRAL';
    }
    if(r13_antiTrap>0&&!b.isTrending){
      if(signal==='BUY'&&b.lastBody<-r13_antiTrap)signal='NEUTRAL';
      if(signal==='SELL'&&b.lastBody>r13_antiTrap)signal='NEUTRAL';
    }
    if(!b.isTrending){
      if(signal==='BUY'&&b.rsi>r14_rsiGuard[0])signal='NEUTRAL';
      if(signal==='SELL'&&b.rsi<r14_rsiGuard[1])signal='NEUTRAL';
    }
    if(b.adx<r16_adxFloor)signal='NEUTRAL';
    if(!b.isTrending&&r17_adxDead){
      if(b.adx>=r17_adxDead[0]&&b.adx<=r17_adxDead[1])signal='NEUTRAL';
      if(b.adx>r17_adxDead[2])signal='NEUTRAL';
    }
    if(b.scoreMargin<r18_marginMin&&signal!=='NEUTRAL')signal='NEUTRAL';
    if(r15_momAlign>0&&!b.isTrending){
      if(signal==='BUY'&&b.shortMom<-r15_momAlign&&b.longMom<-r15_momAlign)signal='NEUTRAL';
      if(signal==='SELL'&&b.shortMom>r15_momAlign&&b.longMom>r15_momAlign)signal='NEUTRAL';
    }
    if(r19_quietGate&&b.isQuiet){
      if(b.htfTrend!==signal)signal='NEUTRAL';
    }
    if(r20_btcSell&&signal==='SELL'&&b.sym==='BTCUSDT'&&!b.isTrending)signal='NEUTRAL';
    if(r21_hours&&signal!=='NEUTRAL'){
      if(r21_hours.includes(b.hUTC))signal='NEUTRAL';
    }

    if(signal==='NEUTRAL')continue;
    lastBar[b.sym]=b.bar;count++;

    const tPnl=evalTrade(signal,b.cur,b.atr15,tpM,slM,b.fH,b.fL,b.fC);
    pnl+=tPnl;
    if(tPnl>0)wins++;else losses++;
  }

  const total=wins+losses;
  const len=Object.values(DATA)[0]?.len||1000;
  const days=len*(endPct-startPct)/288;
  return{total:count,wins,losses,wr:total>0?wins/total*100:0,pnl,spd:count/Math.max(0.5,days),days};
}

async function main(){
  console.log('═'.repeat(70));
  console.log('  VIP STRICT — RULE OPTIMIZATION via Walk-Forward');
  console.log('═'.repeat(70)+'\n');

  await loadData();

  console.log('\n  Pre-computing all bars...');
  const t0=Date.now();
  const allBars=precompute();
  console.log(`  Done: ${allBars.length} bars in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);

  // ═══ Test configurations — from most strict to most relaxed ═══
  const configs=[
    {name:'CURRENT (all 21 rules)',cfg:{}},
    {name:'Relax R9 (no mom contra)',cfg:{r9_momContra:false}},
    {name:'Relax R3 (vol>0.3)',cfg:{r3_volFloor:0.3}},
    {name:'Relax R17 (no ADX dead)',cfg:{r17_adxDead:null}},
    {name:'Relax R19 (no quiet gate)',cfg:{r19_quietGate:false}},
    {name:'Relax R14 (RSI 60/33)',cfg:{r14_rsiGuard:[60,33]}},
    {name:'Relax R9+R3',cfg:{r9_momContra:false,r3_volFloor:0.3}},
    {name:'Relax R9+R3+R17',cfg:{r9_momContra:false,r3_volFloor:0.3,r17_adxDead:null}},
    {name:'Relax R9+R3+R17+R19',cfg:{r9_momContra:false,r3_volFloor:0.3,r17_adxDead:null,r19_quietGate:false}},
    {name:'Relax R9+R3+R17+R19+R14',cfg:{r9_momContra:false,r3_volFloor:0.3,r17_adxDead:null,r19_quietGate:false,r14_rsiGuard:[60,33]}},
    {name:'MINIMAL (only R4+R6+R7+R16)',cfg:{r2_mtf:false,r3_volFloor:0.2,r5_volatile:false,r8_emaOverext:0,r9_momContra:false,r10_htfStr:99,r13_antiTrap:0,r14_rsiGuard:[99,0],r17_adxDead:null,r18_marginMin:0,r15_momAlign:0,r19_quietGate:false,r20_btcSell:false,r21_hours:null}},
    // TP/SL variations on best rule config
    {name:'Relax9+3+17+19 | TP=0.5 SL=0.5',cfg:{r9_momContra:false,r3_volFloor:0.3,r17_adxDead:null,r19_quietGate:false,tpM:0.5,slM:0.5}},
    {name:'Relax9+3+17+19 | TP=0.8 SL=0.6',cfg:{r9_momContra:false,r3_volFloor:0.3,r17_adxDead:null,r19_quietGate:false,tpM:0.8,slM:0.6}},
    {name:'Relax9+3+17+19 | TP=1.0 SL=1.0',cfg:{r9_momContra:false,r3_volFloor:0.3,r17_adxDead:null,r19_quietGate:false,tpM:1.0,slM:1.0}},
    {name:'Relax9+3+17+19 | TP=0.4 SL=0.3',cfg:{r9_momContra:false,r3_volFloor:0.3,r17_adxDead:null,r19_quietGate:false,tpM:0.4,slM:0.3}},
  ];

  console.log('  Config                                        | TRAIN WR  | TRAIN PnL | TRAIN S/D | TEST WR  | TEST PnL  | TEST S/D | FULL WR  | FULL PnL  | FULL S/D');
  console.log('  '+'-'.repeat(170));

  for(const {name,cfg} of configs){
    const train=testConfig(allBars,0,0.5,cfg);
    const test=testConfig(allBars,0.5,1.0,cfg);
    const full=testConfig(allBars,0,1.0,cfg);
    const trainStr=`${train.wr.toFixed(1).padStart(5)}% | ${(train.pnl>=0?'+':'')+train.pnl.toFixed(2).padStart(6)}% | ${train.spd.toFixed(1).padStart(5)}`;
    const testStr=`${test.wr.toFixed(1).padStart(5)}% | ${(test.pnl>=0?'+':'')+test.pnl.toFixed(2).padStart(6)}% | ${test.spd.toFixed(1).padStart(5)}`;
    const fullStr=`${full.wr.toFixed(1).padStart(5)}% | ${(full.pnl>=0?'+':'')+full.pnl.toFixed(2).padStart(6)}% | ${full.spd.toFixed(1).padStart(5)}`;
    console.log(`  ${name.padEnd(47)} | ${trainStr} | ${testStr} | ${fullStr}`);
  }

  // ═══ Best config deep analysis ═══
  // Find config with best test PnL that has >5 test signals
  let bestCfg=configs[0].cfg;let bestName=configs[0].name;let bestTestPnl=-Infinity;
  for(const {name,cfg} of configs){
    const test=testConfig(allBars,0.5,1.0,cfg);
    if(test.total>=3&&test.pnl>bestTestPnl){bestTestPnl=test.pnl;bestCfg=cfg;bestName=name;}
  }

  console.log('\n'+'═'.repeat(70));
  console.log(`  BEST CONFIG: ${bestName}`);
  console.log('═'.repeat(70)+'\n');

  // Quarterly breakdown
  const windows=[{n:'Q1',s:0,e:0.25},{n:'Q2',s:0.25,e:0.50},{n:'Q3',s:0.50,e:0.75},{n:'Q4',s:0.75,e:1.0},{n:'FULL',s:0,e:1.0}];
  for(const w of windows){
    const r=testConfig(allBars,w.s,w.e,bestCfg);
    console.log(`  ${w.n.padEnd(6)} | WR=${r.wr.toFixed(1).padStart(5)}% | PnL=${(r.pnl>=0?'+':'')+r.pnl.toFixed(2).padStart(6)}% | ${r.spd.toFixed(1)} s/d | ${r.total} sigs (${r.wins}W/${r.losses}L)`);
  }

  console.log('\n'+'═'.repeat(70));
}

main().catch(console.error);
