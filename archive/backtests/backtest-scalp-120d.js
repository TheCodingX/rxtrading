const https=require('https');
const DAYS=120,SYMS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','DOTUSDT','PEPEUSDT'];
function calcEMA(a,p){if(!a||a.length<p)return a?a[a.length-1]||0:0;let m=2/(p+1),e=a[0];for(let i=1;i<a.length;i++)e=a[i]*m+e*(1-m);return e;}
function calcEMAArr(a,p){if(!a||!a.length)return[];let m=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*m+r[i-1]*(1-m));return r;}
function calcRSI(c,p=14){if(!c||c.length<p+1)return 50;let g=0,l=0;for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l-=d;}g/=p;l/=p;if(l===0)return 100;return 100-100/(1+g/l);}
function calcMACD(c){if(!c||c.length<26)return{h:0,ph:0};const e12=calcEMAArr(c,12),e26=calcEMAArr(c,26);const ml=[];for(let i=0;i<c.length;i++)ml.push((e12[i]||0)-(e26[i]||0));const sl=calcEMAArr(ml,9);return{h:(ml.at(-1)||0)-(sl.at(-1)||0),ph:(ml.at(-2)||0)-(sl.at(-2)||0)};}
function calcBB(c,p=20,k=2){if(!c||c.length<p)return{u:0,m:0,l:0};const sl=c.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const std=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/p);return{u:m+k*std,m,l:m-k*std};}
function calcStoch(h,l,c,p=14){if(!h||h.length<p)return{k:50,d:50};const hh=Math.max(...h.slice(-p)),ll=Math.min(...l.slice(-p));return{k:hh!==ll?((c.at(-1)-ll)/(hh-ll))*100:50,d:50};}
function calcATR(h,l,c,p=14){if(!h||h.length<p+1)return 0;let t=[];for(let i=1;i<h.length;i++)t.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));return t.slice(-p).reduce((a,b)=>a+b)/p;}
function calcADX(h,l,c,p=14){if(!h||h.length<p*2)return{adx:0,pdi:0,mdi:0};let pdm=[],mdm=[],tr=[];for(let i=1;i<h.length;i++){const up=h[i]-h[i-1],dn=l[i-1]-l[i];pdm.push(up>dn&&up>0?up:0);mdm.push(dn>up&&dn>0?dn:0);tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));}const atr=calcEMA(tr,p)||1;const sPDM=calcEMA(pdm,p);const sMDM=calcEMA(mdm,p);const pdi=(sPDM/atr)*100;const mdi=(sMDM/atr)*100;const dx=pdi+mdi>0?Math.abs(pdi-mdi)/(pdi+mdi)*100:0;return{adx:dx,pdi,mdi};}
function calcOBV(c,v){if(!c||c.length<2)return{rising:false};let o=0;for(let i=1;i<c.length;i++){if(c[i]>c[i-1])o+=v[i];else if(c[i]<c[i-1])o-=v[i];}let o5=0;const p5=c.length>6?c.slice(-6,-1):c;for(let i=1;i<p5.length;i++){if(p5[i]>p5[i-1])o5+=v[v.length-p5.length+i]||0;}return{rising:o>o5};}
function calcMFI(h,l,c,v,p=14){if(!h||h.length<p+1)return 50;let pF=0,nF=0;for(let i=h.length-p;i<h.length;i++){const tp=(h[i]+l[i]+c[i])/3;const pp=(h[i-1]+l[i-1]+c[i-1])/3;if(tp>pp)pF+=tp*v[i];else nF+=tp*v[i];}if(nF===0)return 100;return 100-100/(1+pF/nF);}
function calcVWAP(kl){if(!kl||!kl.length)return 0;let cV=0,cTP=0;kl.forEach(k=>{const h=parseFloat(k[2]),l=parseFloat(k[3]),c=parseFloat(k[4]),v=parseFloat(k[5]);cV+=v;cTP+=(h+l+c)/3*v;});return cV>0?cTP/cV:0;}
function calcKeltner(h,l,c){const e=calcEMA(c,20);const a=calcATR(h,l,c,14);const w=2*2*a;return w>0?(c.at(-1)-(e-2*a))/w:0.5;}
function calcPSAR(h,l,c){if(!h||h.length<3)return{trend:'BUY'};let t='BUY',af=0.02,ep=h[0],sar=l[0];for(let i=1;i<h.length;i++){sar=sar+af*(ep-sar);if(t==='BUY'){if(l[i]<sar){t='SELL';sar=ep;ep=l[i];af=0.02;}else if(h[i]>ep){ep=h[i];af=Math.min(af+0.02,0.2);}}else{if(h[i]>sar){t='BUY';sar=ep;ep=h[i];af=0.02;}else if(l[i]<ep){ep=l[i];af=Math.min(af+0.02,0.2);}}}return{trend:t};}
function fetchJSON(url){return new Promise((r,j)=>{https.get(url,{timeout:15000},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}
async function getK(sym,tf,limit,end){try{return await fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}${end?'&endTime='+end:''}`);}catch{return null;}}

function genScalpSig(kl5,kl15,kl1h){
  if(!kl5||kl5.length<100)return null;
  const C=kl5.map(k=>parseFloat(k[4])),H=kl5.map(k=>parseFloat(k[2])),L=kl5.map(k=>parseFloat(k[3])),V=kl5.map(k=>parseFloat(k[5]));
  const cur=C.at(-1);
  // HTF
  const C1h=kl1h&&kl1h.length>15?kl1h.map(k=>parseFloat(k[4])):[];
  let htf='NEUTRAL';
  if(kl1h&&kl1h.length>25){let hB=0,hS=0;const e9=calcEMA(C1h,9),e21=calcEMA(C1h,21);const mac=calcMACD(C1h);if(e9>e21)hB+=2;else hS+=2;if(mac.h>0)hB+=1.5;else hS+=1.5;if(calcRSI(C1h,14)>50)hB++;else hS++;const adx=calcADX(kl1h.map(k=>parseFloat(k[2])),kl1h.map(k=>parseFloat(k[3])),C1h);if(adx.adx>20&&adx.pdi>adx.mdi)hB+=1.5;else if(adx.adx>20)hS+=1.5;if(hB>hS+2)htf='BUY';else if(hS>hB+2)htf='SELL';}
  // MTF
  const C15=kl15?kl15.map(k=>parseFloat(k[4])):[];
  let mtf='NEUTRAL';
  if(C15.length>25){const e9=calcEMA(C15,9),e21=calcEMA(C15,21);const mac=calcMACD(C15);let mB=0,mS=0;if(e9>e21)mB++;else mS++;if(mac.h>0)mB++;else mS++;if(mB>mS)mtf='BUY';else if(mS>mB)mtf='SELL';}
  // Scoring
  const rsiS=calcRSI(C,7),mac=calcMACD(C),e5=calcEMAArr(C,5).at(-1),e13=calcEMAArr(C,13).at(-1);
  const bbS=calcBB(C,10,1.8),bbP=(bbS.u-bbS.l)>0?(cur-bbS.l)/(bbS.u-bbS.l):0.5;
  const vwap=calcVWAP(kl5.slice(-50)),avgV=V.slice(-20).reduce((a,b)=>a+b)/20,vr=V.at(-1)/avgV;
  const stK=calcStoch(H,L,C,7).k||50,psar=calcPSAR(H,L,C),kc=calcKeltner(H,L,C),mfi=calcMFI(H,L,C,V,7);
  const adx=calcADX(H,L,C);
  let bS=0,sS=0,bI=0,sI=0;
  if(rsiS<25){bS+=3;bI++;}else if(rsiS<35){bS+=2;bI++;}else if(rsiS<45){bS+=1;bI++;}
  else if(rsiS>75){sS+=3;sI++;}else if(rsiS>65){sS+=2;sI++;}else if(rsiS>55){sS+=1;sI++;}
  if(stK<25){bS+=3;bI++;}else if(stK<40){bS+=1.5;bI++;}else if(stK>75){sS+=3;sI++;}else if(stK>60){sS+=1.5;sI++;}
  if(bbP<0.08){bS+=3;bI++;}else if(bbP<0.25){bS+=2;bI++;}else if(bbP>0.92){sS+=3;sI++;}else if(bbP>0.75){sS+=2;sI++;}
  if(mac.h>0&&mac.ph<=0){bS+=2.5;bI++;}else if(mac.h<0&&mac.ph>=0){sS+=2.5;sI++;}else if(mac.h>0){bS+=0.5;}else{sS+=0.5;}
  if(e5>e13){bS+=1.5;bI++;}else{sS+=1.5;sI++;}
  if(vwap&&cur<vwap){bS+=1;bI++;}else if(vwap&&cur>vwap){sS+=1;sI++;}
  if(vr>1.5){const v2=rsiS<50?'B':'S';if(v2==='B'){bS+=2;bI++;}else{sS+=2;sI++;}}
  if(kc<0.25){bS+=1.5;bI++;}else if(kc>0.75){sS+=1.5;sI++;}
  if(psar.trend==='BUY'){bS+=1;bI++;}else{sS+=1;sI++;}
  if(mfi<35){bS+=1.5;bI++;}else if(mfi>65){sS+=1.5;sI++;}
  let signal='NEUTRAL',score=0;
  const minScore=7,minInds=5;
  if(mtf==='BUY'&&htf==='BUY'&&bS>=minScore-1&&bI>=minInds-1){signal='BUY';score=bS;}
  else if(mtf==='SELL'&&htf==='SELL'&&sS>=minScore-1&&sI>=minInds-1){signal='SELL';score=sS;}
  else if(mtf==='BUY'&&bS>=minScore&&bI>=minInds){signal='BUY';score=bS;}
  else if(mtf==='SELL'&&sS>=minScore&&sI>=minInds){signal='SELL';score=sS;}
  else if(mtf==='NEUTRAL'){
    if(bS>=minScore+1&&bI>=minInds&&bS>sS+1.5){signal='BUY';score=bS;}
    else if(sS>=minScore+1&&sI>=minInds&&sS>bS+1.5){signal='SELL';score=sS;}
  }
  if(signal!=='NEUTRAL'&&htf!=='NEUTRAL'&&signal!==htf){if(score<minScore+2)signal='NEUTRAL';}
  if(signal==='NEUTRAL')return null;
  const isMR=(signal==='BUY'&&(rsiS<35||bbP<0.20))||(signal==='SELL'&&(rsiS>65||bbP>0.80));
  if(!isMR&&vr<0.3)signal='NEUTRAL';
  if(signal==='NEUTRAL')return null;
  const atr=calcATR(H,L,C,14);
  return{signal,score,entry:cur,atr};
}

(async()=>{
  console.log('SCALP + SAFE MODE BACKTEST — 120 DAYS');
  const endTime=Date.now(),startTime=endTime-DAYS*24*60*60*1000;
  const allData={};
  for(const sym of SYMS){
    process.stdout.write(`  ${sym}...`);
    let kl5=[],kl15=[],kl1h=[];
    let fe=endTime;
    while(true){const b=await getK(sym,'5m',1000,fe);if(!b||!b.length)break;kl5=b.concat(kl5);if(b[0][0]<=startTime)break;fe=b[0][0]-1;await new Promise(r=>setTimeout(r,80));}
    fe=endTime;while(true){const b=await getK(sym,'15m',1000,fe);if(!b||!b.length)break;kl15=b.concat(kl15);if(b[0][0]<=startTime)break;fe=b[0][0]-1;await new Promise(r=>setTimeout(r,80));}
    const b1h=await getK(sym,'1h',1000,endTime);if(b1h)kl1h=b1h;
    kl5=kl5.filter(k=>k[0]>=startTime);
    console.log(` ${kl5.length}`);
    allData[sym]={kl5,kl15,kl1h};
  }
  // Test SCALP (Precision Institucional) and SAFE MODE (strict)
  for(const mode of ['scalp','strict']){
    const cdBars=mode==='scalp'?12:36,cdMs=cdBars*5*60*1000;
    const tpMult=mode==='scalp'?2.0:2.5,slMult=mode==='scalp'?0.8:1.0;
    let wins=0,losses=0,gP=0,gL=0,totalPnl=0;
    const pairResults={};
    for(const sym of (mode==='strict'?['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT']:SYMS)){
      const d=allData[sym];if(!d)continue;
      const{kl5,kl15,kl1h}=d;let lastSig=0,pW=0,pL=0,pPnl=0;
      for(let i=280;i<kl5.length;i++){
        const bt=parseInt(kl5[i][0]);
        if(bt-lastSig<cdMs)continue;
        const sig=genScalpSig(kl5.slice(Math.max(0,i-280),i+1),kl15.filter(k=>k[0]<=bt).slice(-100),kl1h.filter(k=>k[0]<=bt).slice(-50));
        if(!sig)continue;
        lastSig=bt;
        const entry=sig.entry,atr=sig.atr||calcATR(kl5.slice(i-20,i+1).map(k=>parseFloat(k[2])),kl5.slice(i-20,i+1).map(k=>parseFloat(k[3])),kl5.slice(i-20,i+1).map(k=>parseFloat(k[4])),14);
        const tpDist=Math.max(atr*tpMult,entry*0.002),slDist=Math.max(atr*slMult,entry*0.001);
        const costBuf=entry*0.0013;
        const tp=sig.signal==='BUY'?entry+tpDist-costBuf:entry-tpDist+costBuf;
        const sl=sig.signal==='BUY'?entry-slDist+entry*0.0005:entry+slDist-entry*0.0005;
        let result=null,exitPrice=entry;
        for(let j=i+1;j<kl5.length&&j<i+200;j++){
          const cH=parseFloat(kl5[j][2]),cL=parseFloat(kl5[j][3]),cO=parseFloat(kl5[j][1]);
          if(sig.signal==='BUY'){
            if(cH>=tp&&cL<=sl){result=Math.abs(cO-sl)<Math.abs(cO-tp)?'L':'W';exitPrice=result==='W'?tp:sl;break;}
            if(cH>=tp){result='W';exitPrice=tp;break;}if(cL<=sl){result='L';exitPrice=sl;break;}
          }else{
            if(cL<=tp&&cH>=sl){result=Math.abs(cO-sl)<Math.abs(cO-tp)?'L':'W';exitPrice=result==='W'?tp:sl;break;}
            if(cL<=tp){result='W';exitPrice=tp;break;}if(cH>=sl){result='L';exitPrice=sl;break;}
          }
        }
        if(!result)continue;
        const pct=sig.signal==='BUY'?(exitPrice-entry)/entry:(entry-exitPrice)/entry;
        const pnl=500*5*pct;
        totalPnl+=pnl;pPnl+=pnl;
        if(pnl>0){wins++;pW++;gP+=pnl;}else{losses++;pL++;gL+=Math.abs(pnl);}
      }
      pairResults[sym]={w:pW,l:pL,pnl:pPnl.toFixed(0)};
    }
    const total=wins+losses,wr=total>0?(wins/total*100).toFixed(1):'0',pf=gL>0?(gP/gL).toFixed(2):'0';
    console.log(`\n=== ${mode==='scalp'?'PRECISION INSTITUCIONAL':'SAFE MODE'} (${DAYS}d) ===`);
    console.log(`  PnL: $${totalPnl.toFixed(0)} | PF: ${pf} | WR: ${wr}% | Trades: ${total} | T/d: ${(total/DAYS).toFixed(1)}`);
    Object.entries(pairResults).forEach(([s,r])=>console.log(`    ${s.replace('USDT','')}: W${r.w} L${r.l} PnL $${r.pnl}`));
  }
})();
