#!/usr/bin/env node
const https = require('https');
const DAYS = 60, TRADE_AMT = 500, LEVERAGE = 5, NOTIONAL = TRADE_AMT * LEVERAGE;
const TAKER_FEE = 0.0004, SLIPPAGE = 0.0003;
const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT'];

function ema(a,p){if(!a||a.length<p)return a?a.at(-1)||0:0;let m=2/(p+1),e=a[0];for(let i=1;i<a.length;i++)e=a[i]*m+e*(1-m);return e;}
function emaArr(a,p){if(!a||!a.length)return[];let m=2/(p+1),r=[a[0]];for(let i=1;i<a.length;i++)r.push(a[i]*m+r[i-1]*(1-m));return r;}
function rsi(c,p=14){if(!c||c.length<p+1)return 50;let g=0,l=0;for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l-=d;}g/=p;l/=p;if(l===0)return 100;return 100-100/(1+g/l);}
function macd(c){if(!c||c.length<26)return{h:0,ph:0};const e12=emaArr(c,12),e26=emaArr(c,26);const ml=[];for(let i=0;i<c.length;i++)ml.push((e12[i]||0)-(e26[i]||0));const sl=emaArr(ml,9);return{h:(ml.at(-1)||0)-(sl.at(-1)||0),ph:(ml.at(-2)||0)-(sl.at(-2)||0)};}
function bb(c,p=20,k=2){if(!c||c.length<p)return{u:0,m:0,l:0};const sl=c.slice(-p);const m=sl.reduce((a,b)=>a+b)/p;const std=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/p);return{u:m+k*std,m,l:m-k*std};}
function stoch(h,l,c,p=14){if(!h||h.length<p)return 50;const hh=Math.max(...h.slice(-p)),ll=Math.min(...l.slice(-p));return hh!==ll?((c.at(-1)-ll)/(hh-ll))*100:50;}
function atr(h,l,c,p=14){if(!h||h.length<p+1)return 0;let t=[];for(let i=1;i<h.length;i++)t.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));return t.slice(-p).reduce((a,b)=>a+b)/p;}
function adx(h,l,c,p=14){if(!h||h.length<p*2)return{adx:0,pdi:0,mdi:0};let pd=[],md=[],tr=[];for(let i=1;i<h.length;i++){const u=h[i]-h[i-1],d=l[i-1]-l[i];pd.push(u>d&&u>0?u:0);md.push(d>u&&d>0?d:0);tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));}const a=ema(tr,p)||1;return{adx:Math.abs(ema(pd,p)/a-ema(md,p)/a)/(ema(pd,p)/a+ema(md,p)/a+0.001)*100,pdi:(ema(pd,p)/a)*100,mdi:(ema(md,p)/a)*100};}
function obv(c,v){if(!c||c.length<5)return false;let o=0;for(let i=c.length-5;i<c.length;i++){if(i>0){if(c[i]>c[i-1])o+=v[i];else if(c[i]<c[i-1])o-=v[i];}}return o>0;}
function mfi(h,l,c,v,p=14){if(!h||h.length<p+1)return 50;let pF=0,nF=0;for(let i=h.length-p;i<h.length;i++){const tp=(h[i]+l[i]+c[i])/3;const pt=(h[i-1]+l[i-1]+c[i-1])/3;if(tp>pt)pF+=tp*v[i];else nF+=tp*v[i];}if(nF===0)return 100;return 100-100/(1+pF/nF);}
function fetchJ(u){return new Promise((r,j)=>{https.get(u,{timeout:15000},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{r(JSON.parse(d));}catch(e){j(e);}});}).on('error',j);});}
async function getFK(s,t,l,e){try{return await fetchJ(`https://fapi.binance.com/fapi/v1/klines?symbol=${s}&interval=${t}&limit=${l}${e?'&endTime='+e:''}`);}catch{return null;}}

const CFGS = [
  {name:'15m-PB-3.0',tf:'15m',tp:3.0,sl:1.0,ms:6,mi:4,cd:8,htf:1,adxMin:20,grn:1,tOnly:1},
  {name:'15m-PB-2.5',tf:'15m',tp:2.5,sl:1.0,ms:6,mi:4,cd:6,htf:1,adxMin:18,grn:1,tOnly:1},
  {name:'15m-PB-2.0',tf:'15m',tp:2.0,sl:0.8,ms:5,mi:3,cd:4,htf:1,adxMin:15,grn:1,tOnly:1},
  {name:'15m-TR-3.0',tf:'15m',tp:3.0,sl:1.0,ms:7,mi:4,cd:8,htf:1,adxMin:22,grn:0,tOnly:1,mtf:1},
  {name:'15m-TR-2.0',tf:'15m',tp:2.0,sl:0.8,ms:6,mi:4,cd:6,htf:1,adxMin:20,grn:0,tOnly:1,mtf:1},
  {name:'15m-VOL-3.0',tf:'15m',tp:3.0,sl:1.0,ms:6,mi:4,cd:8,htf:1,adxMin:20,grn:1,tOnly:1,vol:1.2},
  {name:'15m-VOL-2.5',tf:'15m',tp:2.5,sl:0.8,ms:5,mi:3,cd:6,htf:1,adxMin:18,grn:1,tOnly:1,vol:1.0},
  {name:'15m-HYB-3.5',tf:'15m',tp:3.5,sl:1.0,ms:7,mi:4,cd:10,htf:1,adxMin:22,grn:1,tOnly:1,vol:1.0,mtf:1},
  {name:'15m-HYB-4.0',tf:'15m',tp:4.0,sl:1.2,ms:7,mi:4,cd:12,htf:1,adxMin:25,grn:1,tOnly:1,vol:1.2,mtf:1},
  {name:'15m-SNP-5.0',tf:'15m',tp:5.0,sl:1.0,ms:8,mi:5,cd:16,htf:1,adxMin:25,grn:1,tOnly:1,vol:1.3,mtf:1},
  {name:'15m-RLX-2.0',tf:'15m',tp:2.0,sl:1.0,ms:5,mi:3,cd:4,htf:1,adxMin:15,grn:0,tOnly:1},
  {name:'15m-RLX-1.8',tf:'15m',tp:1.8,sl:0.8,ms:5,mi:3,cd:3,htf:1,adxMin:12,grn:0,tOnly:1},
  {name:'5m-ULT-4.0',tf:'5m',tp:4.0,sl:1.0,ms:8,mi:5,cd:48,htf:1,adxMin:25,grn:1,tOnly:1,mtf:1},
  {name:'5m-ULT-3.5',tf:'5m',tp:3.5,sl:0.8,ms:7,mi:4,cd:36,htf:1,adxMin:22,grn:1,tOnly:1,mtf:1},
  {name:'15m-WIDE-3',tf:'15m',tp:3.0,sl:1.5,ms:5,mi:3,cd:4,htf:1,adxMin:15,grn:0,tOnly:1},
  {name:'15m-TIGHT-2',tf:'15m',tp:2.0,sl:0.5,ms:6,mi:4,cd:6,htf:1,adxMin:18,grn:1,tOnly:1},
];

function genSig(kl,klH,cfg){
  if(!kl||kl.length<50)return null;
  const C=kl.map(k=>parseFloat(k[4])),H=kl.map(k=>parseFloat(k[2])),L=kl.map(k=>parseFloat(k[3])),V=kl.map(k=>parseFloat(k[5]));
  const cur=C.at(-1);
  let htf='N';
  if(klH&&klH.length>25){const Ch=klH.map(k=>parseFloat(k[4])),Hh=klH.map(k=>parseFloat(k[2])),Lh=klH.map(k=>parseFloat(k[3])),Vh=klH.map(k=>parseFloat(k[5]));let hB=0,hS=0;if(ema(Ch,9)>ema(Ch,21))hB+=2;else hS+=2;if(Ch.at(-1)>ema(Ch,50))hB++;else hS++;const m=macd(Ch);if(m.h>0)hB+=1.5;else hS+=1.5;if(rsi(Ch,14)>55)hB++;else if(rsi(Ch,14)<45)hS++;const a=adx(Hh,Lh,Ch);if(a.adx>20&&a.pdi>a.mdi)hB+=1.5;else if(a.adx>20)hS+=1.5;if(obv(Ch,Vh))hB++;else hS++;if(hB>hS+2.5)htf='B';else if(hS>hB+2.5)htf='S';}
  if(cfg.htf&&htf==='N')return null;
  const ad=adx(H,L,C);if(cfg.adxMin&&ad.adx<cfg.adxMin)return null;
  const r=rsi(C,14),m=macd(C),e9=ema(C,9),e21=ema(C,21),e50=ema(C,50),bbd=bb(C,20,2),bbR=bbd.u-bbd.l,bbP=bbR>0?(cur-bbd.l)/bbR:0.5,sk=stoch(H,L,C,14),avgV=V.slice(-20).reduce((a,b)=>a+b)/20,vr=V.at(-1)/avgV,mf=mfi(H,L,C,V,14);
  let bS=0,sS=0,bI=0,sI=0;
  if(r<30){bS+=3;bI++;}else if(r<40){bS+=2;bI++;}else if(r<48){bS+=1;bI++;}else if(r>70){sS+=3;sI++;}else if(r>60){sS+=2;sI++;}else if(r>52){sS+=1;sI++;}
  if(sk<25){bS+=3;bI++;}else if(sk<40){bS+=1.5;bI++;}else if(sk>75){sS+=3;sI++;}else if(sk>60){sS+=1.5;sI++;}
  if(bbP<0.10){bS+=3;bI++;}else if(bbP<0.25){bS+=2;bI++;}else if(bbP>0.90){sS+=3;sI++;}else if(bbP>0.75){sS+=2;sI++;}
  if(m.h>0&&m.ph<=0){bS+=2.5;bI++;}else if(m.h<0&&m.ph>=0){sS+=2.5;sI++;}else if(m.h>0)bS+=0.5;else sS+=0.5;
  if(e9>e21){bS+=1.5;bI++;}else{sS+=1.5;sI++;}if(cur>e50){bS+=1;bI++;}else{sS+=1;sI++;}
  if(vr>1.5){if(r<50){bS+=2;bI++;}else{sS+=2;sI++;}}else if(vr>1)if(r<50)bS+=0.5;else sS+=0.5;
  if(mf<30){bS+=2;bI++;}else if(mf<40){bS+=1;bI++;}else if(mf>70){sS+=2;sI++;}else if(mf>60){sS+=1;sI++;}
  if(ad.pdi>ad.mdi){bS+=1;bI++;}else{sS+=1;sI++;}
  if(obv(C,V)){bS+=1;bI++;}else{sS+=1;sI++;}
  let sig='N',sc=0;
  if(cfg.tOnly){if(htf==='B'&&bS>=cfg.ms&&bI>=cfg.mi){sig='B';sc=bS;}else if(htf==='S'&&sS>=cfg.ms&&sI>=cfg.mi){sig='S';sc=sS;}}
  else{if(bS>=cfg.ms&&bI>=cfg.mi&&bS>sS+2){sig='B';sc=bS;}else if(sS>=cfg.ms&&sI>=cfg.mi&&sS>bS+2){sig='S';sc=sS;}}
  if(sig==='N')return null;
  if(cfg.vol&&vr<cfg.vol)return null;
  if(cfg.grn){const lo=parseFloat(kl.at(-1)[1]);if(sig==='B'&&cur<=lo)return null;if(sig==='S'&&cur>=lo)return null;}
  if(cfg.mtf){const l3=C.slice(-3);if(sig==='B'&&!(l3[2]>l3[1]&&l3[1]>l3[0]))return null;if(sig==='S'&&!(l3[2]<l3[1]&&l3[1]<l3[0]))return null;}
  return{sig,sc,entry:cur,atrV:atr(H,L,C,20)};
}

function runBT(cfg,D){
  const tfMs=cfg.tf==='15m'?900000:300000,cdMs=cfg.cd*tfMs;
  let t=0,w=0,l=0,pnl=0,gP=0,gL=0,cW=0,cL=0,mCW=0,mCL=0,bal=10000,pk=10000,mDD=0;
  const ps={};
  for(const sym of SYMBOLS){const d=D[sym];if(!d)continue;const kl=cfg.tf==='15m'?d.kl15:d.kl5;const kh=d.kl1h;if(!kl||kl.length<100)continue;let lst=0;ps[sym]={t:0,w:0,p:0};
    for(let i=50;i<kl.length-2;i++){const bt=parseInt(kl[i][0]);if(bt-lst<cdMs)continue;
      const s=genSig(kl.slice(Math.max(0,i-100),i+1),kh.filter(k=>parseInt(k[0])<=bt).slice(-50),cfg);if(!s)continue;lst=bt;
      const dB=kl[i+1];if(!dB)continue;const dO=parseFloat(dB[1]),sd=s.sig==='B'?1:-1,ae=dO*(1+sd*SLIPPAGE);
      const tpD=s.atrV*cfg.tp,slD=s.atrV*cfg.sl;let tp,sl;if(s.sig==='B'){tp=ae+tpD;sl=ae-slD;}else{tp=ae-tpD;sl=ae+slD;}
      let r=null,ep=ae;for(let j=i+2;j<kl.length&&j<i+200;j++){const cH=parseFloat(kl[j][2]),cL=parseFloat(kl[j][3]),cO=parseFloat(kl[j][1]);
        if(s.sig==='B'){if(cH>=tp&&cL<=sl){r=Math.abs(cO-sl)<Math.abs(cO-tp)?'L':'W';ep=r==='W'?tp:sl;break;}if(cH>=tp){r='W';ep=tp;break;}if(cL<=sl){r='L';ep=sl;break;}}
        else{if(cL<=tp&&cH>=sl){r=Math.abs(cO-sl)<Math.abs(cO-tp)?'L':'W';ep=r==='W'?tp:sl;break;}if(cL<=tp){r='W';ep=tp;break;}if(cH>=sl){r='L';ep=sl;break;}}}
      if(!r)continue;const pc=s.sig==='B'?(ep-ae)/ae:(ae-ep)/ae,gr=NOTIONAL*pc,fe=NOTIONAL*TAKER_FEE*2,nt=gr-fe;
      t++;pnl+=nt;bal+=nt;ps[sym].t++;ps[sym].p+=nt;
      if(nt>0){w++;gP+=nt;cW++;cL=0;if(cW>mCW)mCW=cW;ps[sym].w++;}else{l++;gL+=Math.abs(nt);cL++;cW=0;if(cL>mCL)mCL=cL;}
      if(bal>pk)pk=bal;const dd=(pk-bal)/pk*100;if(dd>mDD)mDD=dd;}}
  return{n:cfg.name,tf:cfg.tf,t,wr:t>0?w/t*100:0,pf:gL>0?gP/gL:0,pnl,mDD,mCW,mCL,sd:(t/DAYS).toFixed(1),aw:w>0?gP/w:0,al:l>0?gL/l:0,fe:t*NOTIONAL*TAKER_FEE*2,ps};
}

(async()=>{
  console.log('\n  BINANCE PRECISION v2 — 60 DAYS FUTURES REAL');
  console.log(`  Fee:${TAKER_FEE*100}% Slip:${SLIPPAGE*100}% Delay:1bar $${TRADE_AMT}x${LEVERAGE}\n`);
  const et=Date.now(),st=et-DAYS*86400000,D={};
  for(const s of SYMBOLS){process.stdout.write(`  ${s}: `);
    let k5=[],k15=[],k1h=[],fe=et;
    while(true){const b=await getFK(s,'5m',1000,fe);if(!b||!b.length)break;k5=b.concat(k5);if(b[0][0]<=st)break;fe=b[0][0]-1;await new Promise(r=>setTimeout(r,80));}k5=k5.filter(k=>k[0]>=st);process.stdout.write(`5m:${k5.length} `);
    fe=et;while(true){const b=await getFK(s,'15m',1000,fe);if(!b||!b.length)break;k15=b.concat(k15);if(b[0][0]<=st)break;fe=b[0][0]-1;await new Promise(r=>setTimeout(r,80));}process.stdout.write(`15m:${k15.length} `);
    fe=et;while(true){const b=await getFK(s,'1h',1000,fe);if(!b||!b.length)break;k1h=b.concat(k1h);if(b[0][0]<=st)break;fe=b[0][0]-1;await new Promise(r=>setTimeout(r,80));}console.log(`1h:${k1h.length}`);
    D[s]={kl5:k5,kl15:k15,kl1h:k1h};}

  console.log(`\n  ${'CONFIG'.padEnd(18)} ${'TF'.padStart(4)} ${'#'.padStart(5)} ${'S/D'.padStart(5)} ${'WR%'.padStart(6)} ${'PF'.padStart(6)} ${'PnL$'.padStart(9)} ${'DD%'.padStart(6)} ${'Fee$'.padStart(7)} ${'AvgW'.padStart(7)} ${'AvgL'.padStart(7)}`);
  console.log(`  ${'─'.repeat(90)}`);

  const R=[];for(const c of CFGS){const r=runBT(c,D);R.push(r);
    console.log(`  ${r.n.padEnd(18)} ${r.tf.padStart(4)} ${String(r.t).padStart(5)} ${r.sd.padStart(5)} ${r.wr.toFixed(1).padStart(5)}% ${r.pf.toFixed(2).padStart(6)} ${((r.pnl>=0?'+':'')+r.pnl.toFixed(0)).padStart(9)} ${r.mDD.toFixed(1).padStart(5)}% ${r.fe.toFixed(0).padStart(7)} ${r.aw.toFixed(1).padStart(7)} ${r.al.toFixed(1).padStart(7)} ${r.pf>=1.5&&r.wr>=50?'★★★':r.pf>=1.2&&r.pnl>0?'★★':r.pnl>0?'★':''}`);}

  console.log(`\n  TOP 3:`);
  R.filter(r=>r.t>10).sort((a,b)=>b.pnl-a.pnl).slice(0,3).forEach((r,i)=>{
    console.log(`  ${i+1}. ${r.n} [${r.tf}]: $${r.pnl.toFixed(0)} WR:${r.wr.toFixed(1)}% PF:${r.pf.toFixed(2)} ${r.t}t DD:${r.mDD.toFixed(1)}%`);
    Object.entries(r.ps).forEach(([s,v])=>{if(v.t>0)console.log(`     ${s.replace('USDT','').padEnd(5)} ${v.t}t WR:${(v.w/v.t*100).toFixed(0)}% $${v.p.toFixed(0)}`);});});
  console.log('');
})();
