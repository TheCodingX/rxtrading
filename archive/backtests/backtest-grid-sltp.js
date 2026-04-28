// DIV_SNIPER SL/TP Grid Search — ATR multiplier + Fixed % grids
// Generates divergence signals once, then evaluates 78 SL/TP combos
const https = require('https');

function fetchJSON(url){return new Promise((ok,no)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{ok(JSON.parse(d))}catch(e){no(e)}});}).on('error',no)});}

async function getKlines(sym,tf,days){
  const ms=days*86400000, now=Date.now(), lim=1500, intMs={'5m':300000,'1h':3600000}[tf];
  let all=[], end=now;
  while(all.length<days*86400000/intMs){
    const url=`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=${lim}&endTime=${end}`;
    const k=await fetchJSON(url); if(!k.length)break;
    all=k.concat(all); end=k[0][0]-1;
    if(all[0][0]<=now-ms)break; await new Promise(r=>setTimeout(r,100));
  }
  const cutoff=now-ms;
  return all.filter(k=>k[0]>=cutoff);
}

function rsiArr(C,p=14){const r=new Array(C.length).fill(50);if(C.length<p+1)return r;let g=0,l=0;
  for(let i=1;i<=p;i++){const d=C[i]-C[i-1];d>0?g+=d:l+=Math.abs(d);}let ag=g/p,al=l/p;
  r[p]=al===0?100:100-100/(1+ag/al);
  for(let i=p+1;i<C.length;i++){const d=C[i]-C[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;r[i]=al===0?100:100-100/(1+ag/al);}return r;}

function atrArr(H,L,C,p=14){const r=new Array(C.length).fill(0);if(C.length<p+1)return r;
  const tr=i=>Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1]));
  let s=0;for(let i=1;i<=p;i++)s+=tr(i);let a=s/p;r[p]=a;
  for(let i=p+1;i<C.length;i++){a=(a*(p-1)+tr(i))/p;r[i]=a;}return r;}

function detectDivergences(O,H,L,C,rsi,atr,T){
  const sigs=[];const lb=20;
  for(let i=lb+1;i<C.length-2;i++){
    if(atr[i]===0)continue;
    // Bull: price lower low + RSI higher low, RSI<40
    if(rsi[i]<40){
      let pLL=false,rHL=false;
      for(let j=i-lb;j<i-4;j++){
        if(L[i]<L[j]&&rsi[i]>rsi[j]){pLL=true;rHL=true;break;}
      }
      if(pLL&&rHL){
        // confirmation: next candle bullish
        if(C[i+1]>O[i+1]){
          sigs.push({bar:i+2,side:'BUY',entry:O[i+2],atr:atr[i],t:T[i+2]});
        }
      }
    }
    // Bear: price higher high + RSI lower high, RSI>60
    if(rsi[i]>60){
      let pHH=false,rLH=false;
      for(let j=i-lb;j<i-4;j++){
        if(H[i]>H[j]&&rsi[i]<rsi[j]){pHH=true;rLH=true;break;}
      }
      if(pHH&&rLH){
        if(C[i+1]<O[i+1]){
          sigs.push({bar:i+2,side:'SELL',entry:O[i+2],atr:atr[i],t:T[i+2]});
        }
      }
    }
  }
  // deduplicate: no two signals within 6 bars
  const out=[];let last=-999;
  for(const s of sigs){if(s.bar-last>=6){out.push(s);last=s.bar;}}
  return out;
}

function evalCombo(sigs,H,L,C,slFn,tpFn,pos=2500){
  let wins=0,losses=0,pnl=0,gross=0,grossL=0;
  const makerFee=0.0002,takerFee=0.0004,slip=0.0001;
  for(const s of sigs){
    const sl=slFn(s),tp=tpFn(s);if(!sl||!tp||sl<=0||tp<=0)continue;
    const slP=s.side==='BUY'?s.entry-sl:s.entry+sl;
    const tpP=s.side==='BUY'?s.entry+tp:s.entry-tp;
    let hit=0; // 1=TP, -1=SL
    for(let b=s.bar;b<Math.min(s.bar+288,C.length);b++){// max 24h hold
      if(s.side==='BUY'){
        if(L[b]<=slP){hit=-1;break;}
        if(H[b]>=tpP){hit=1;break;}
      }else{
        if(H[b]>=slP){hit=-1;break;}
        if(L[b]<=tpP){hit=1;break;}
      }
    }
    if(hit===0)continue;// expired — skip
    const qty=pos/s.entry;
    if(hit===1){const g=qty*tp-pos*(makerFee+makerFee);pnl+=g;gross+=g;wins++;}
    else{const l=qty*sl+pos*(makerFee+takerFee+slip);pnl-=l;grossL+=l;losses++;}
  }
  const n=wins+losses;const wr=n?wins/n*100:0;const pf=grossL?gross/grossL:0;
  return{pnl:Math.round(pnl*100)/100,pf:Math.round(pf*100)/100,wr:Math.round(wr*10)/10,n};
}

function evalComboSplit(sigs,H,L,C,slFn,tpFn,tStart,tEnd,pos=2500){
  const sub=sigs.filter(s=>s.t>=tStart&&s.t<tEnd);
  return evalCombo(sub,H,L,C,slFn,tpFn,pos);
}

async function main(){
  console.log('='.repeat(70));
  console.log('  DIV_SNIPER — SL/TP Grid Search (120d, Futures)');
  console.log('='.repeat(70));

  // ── Download BTC data ──
  console.log('\n[1] Downloading BTCUSDT 5m + 1h (120 days)...');
  const [k5,k1h]=await Promise.all([getKlines('BTCUSDT','5m',120),getKlines('BTCUSDT','1h',120)]);
  console.log(`    5m: ${k5.length} candles, 1h: ${k1h.length} candles`);
  const O=k5.map(k=>+k[1]),H=k5.map(k=>+k[2]),L=k5.map(k=>+k[3]),C=k5.map(k=>+k[4]),T=k5.map(k=>k[0]);

  // ── Compute indicators ──
  const rsi=rsiArr(C,14), atr=atrArr(H,L,C,14);

  // ── Generate signals once ──
  console.log('[2] Detecting RSI divergences...');
  const sigs=detectDivergences(O,H,L,C,rsi,atr,T);
  console.log(`    Found ${sigs.length} divergence signals (${sigs.filter(s=>s.side==='BUY').length} BUY, ${sigs.filter(s=>s.side==='SELL').length} SELL)`);

  // ── GRID 1: ATR multiplier ──
  console.log('\n[3] ATR GRID (36 combos)...');
  const SL_M=[0.3,0.5,0.8,1.0,1.2,1.5], TP_M=[1.0,1.5,2.0,2.5,3.0,4.0];
  const atrResults=[];
  for(const sl of SL_M)for(const tp of TP_M){
    const r=evalCombo(sigs,H,L,C,s=>s.atr*sl,s=>s.atr*tp);
    atrResults.push({type:'ATR',sl,tp,label:`ATR SL×${sl} TP×${tp}`,...r});
  }

  // ── GRID 2: Fixed % ──
  console.log('[4] PCT GRID (42 combos)...');
  const SL_P=[0.20,0.30,0.40,0.50,0.60,0.80,1.00], TP_P=[0.50,0.80,1.00,1.50,2.00,3.00];
  const pctResults=[];
  for(const sl of SL_P)for(const tp of TP_P){
    const r=evalCombo(sigs,H,L,C,s=>s.entry*sl/100,s=>s.entry*tp/100);
    pctResults.push({type:'PCT',sl,tp,label:`PCT SL${sl}% TP${tp}%`,...r});
  }

  // ── Print ATR Grid ──
  console.log('\n' + '='.repeat(70));
  console.log('  ATR GRID (SL_mult x TP_mult) — PF / WR% / N');
  console.log('='.repeat(70));
  const hdr='         '+TP_M.map(t=>`TP×${t}`.padStart(12)).join('');
  console.log(hdr);
  for(const sl of SL_M){
    let row=`SL×${sl}`.padEnd(9);
    for(const tp of TP_M){const r=atrResults.find(x=>x.sl===sl&&x.tp===tp);row+=`${r.pf}/${r.wr}/${r.n}`.padStart(12);}
    console.log(row);
  }

  // ── Print PCT Grid ──
  console.log('\n' + '='.repeat(70));
  console.log('  PCT GRID (SL% x TP%) — PF / WR% / N');
  console.log('='.repeat(70));
  const hdr2='         '+TP_P.map(t=>`TP${t}%`.padStart(12)).join('');
  console.log(hdr2);
  for(const sl of SL_P){
    let row=`SL${sl}%`.padEnd(9);
    for(const tp of TP_P){const r=pctResults.find(x=>x.sl===sl&&x.tp===tp);row+=`${r.pf}/${r.wr}/${r.n}`.padStart(12);}
    console.log(row);
  }

  // ── TOP 5 by PnL (min 50 trades) ──
  const all=[...atrResults,...pctResults].filter(r=>r.n>=50).sort((a,b)=>b.pnl-a.pnl);
  const top5=all.slice(0,5);
  console.log('\n' + '='.repeat(70));
  console.log('  TOP 5 BY PnL (min 50 trades)');
  console.log('='.repeat(70));
  console.log('#  | Config                      | PnL       | PF   | WR%  | Trades');
  console.log('---|-----------------------------|-----------| -----| -----| ------');
  top5.forEach((r,i)=>console.log(`${i+1}  | ${r.label.padEnd(27)} | ${String(r.pnl).padStart(9)} | ${String(r.pf).padStart(4)} | ${String(r.wr).padStart(4)} | ${r.n}`));

  if(!top5.length){console.log('  No configs with 50+ trades found. Lowering to 20...');
    const all2=[...atrResults,...pctResults].filter(r=>r.n>=20).sort((a,b)=>b.pnl-a.pnl);
    top5.push(...all2.slice(0,5));
    top5.forEach((r,i)=>console.log(`${i+1}  | ${r.label.padEnd(27)} | ${String(r.pnl).padStart(9)} | ${String(r.pf).padStart(4)} | ${String(r.wr).padStart(4)} | ${r.n}`));
  }

  // ── WALK-FORWARD ──
  console.log('\n' + '='.repeat(70));
  console.log('  WALK-FORWARD (d1-60 IS vs d61-120 OOS)');
  console.log('='.repeat(70));
  const tMin=T[0],tMax=T[T.length-1],tMid=tMin+Math.floor((tMax-tMin)/2);
  console.log('#  | Config                      | IS_PF | OOS_PF | IS_WR | OOS_WR | VERDICT');
  console.log('---|-----------------------------| ------| -------| ------| -------| -------');
  const wfResults=[];
  for(let i=0;i<top5.length;i++){
    const r=top5[i];
    const slFn=r.type==='ATR'?s=>s.atr*r.sl:s=>s.entry*r.sl/100;
    const tpFn=r.type==='ATR'?s=>s.atr*r.tp:s=>s.entry*r.tp/100;
    const is=evalComboSplit(sigs,H,L,C,slFn,tpFn,tMin,tMid);
    const oos=evalComboSplit(sigs,H,L,C,slFn,tpFn,tMid,tMax);
    const verdict=oos.pf>=1.0&&is.pf>=1.0?'PASS':oos.pf>=0.8?'MARGINAL':'FAIL';
    wfResults.push({...r,isPF:is.pf,oosPF:oos.pf,isWR:is.wr,oosWR:oos.wr,verdict,oosPnl:oos.pnl});
    console.log(`${i+1}  | ${r.label.padEnd(27)} | ${String(is.pf).padStart(5)} | ${String(oos.pf).padStart(6)} | ${String(is.wr).padStart(5)} | ${String(oos.wr).padStart(6)} | ${verdict}`);
  }

  // ── MULTI-PAIR ──
  const bestOOS=wfResults.sort((a,b)=>b.oosPnl-a.oosPnl)[0];
  if(!bestOOS){console.log('\nNo valid walk-forward config found.');return;}
  console.log(`\nBest OOS config: ${bestOOS.label}`);
  console.log('\n' + '='.repeat(70));
  console.log('  MULTI-PAIR TEST (best OOS config)');
  console.log('='.repeat(70));

  const pairs=['ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT'];
  const mpResults=[{pair:'BTC',pnl:bestOOS.pnl,pf:bestOOS.pf,wr:bestOOS.wr,n:bestOOS.n}];
  console.log('Pair  | PnL       | PF   | WR%  | Trades');
  console.log('------|-----------|------|------|-------');
  console.log(`BTC   | ${String(bestOOS.pnl).padStart(9)} | ${String(bestOOS.pf).padStart(4)} | ${String(bestOOS.wr).padStart(4)} | ${bestOOS.n}`);

  for(const sym of pairs){
    console.log(`  Downloading ${sym}...`);
    const [pk5]=await Promise.all([getKlines(sym,'5m',120)]);
    if(!pk5||pk5.length<1000){console.log(`  ${sym}: insufficient data (${pk5?pk5.length:0}), skipping`);continue;}
    const pO=pk5.map(k=>+k[1]),pH=pk5.map(k=>+k[2]),pL=pk5.map(k=>+k[3]),pC=pk5.map(k=>+k[4]),pT=pk5.map(k=>k[0]);
    const pRsi=rsiArr(pC,14),pAtr=atrArr(pH,pL,pC,14);
    const pSigs=detectDivergences(pO,pH,pL,pC,pRsi,pAtr,pT);
    const slFn=bestOOS.type==='ATR'?s=>s.atr*bestOOS.sl:s=>s.entry*bestOOS.sl/100;
    const tpFn=bestOOS.type==='ATR'?s=>s.atr*bestOOS.tp:s=>s.entry*bestOOS.tp/100;
    const pr=evalCombo(pSigs,pH,pL,pC,slFn,tpFn);
    mpResults.push({pair:sym.replace('USDT',''),pnl:pr.pnl,pf:pr.pf,wr:pr.wr,n:pr.n});
    console.log(`${sym.replace('USDT','').padEnd(6)}| ${String(pr.pnl).padStart(9)} | ${String(pr.pf).padStart(4)} | ${String(pr.wr).padStart(4)} | ${pr.n}`);
  }

  const totPnl=mpResults.reduce((a,b)=>a+b.pnl,0);
  const totN=mpResults.reduce((a,b)=>a+b.n,0);
  const totWins=mpResults.reduce((a,b)=>a+b.n*b.wr/100,0);
  console.log('------|-----------|------|------|-------');
  console.log(`TOTAL | ${String(Math.round(totPnl*100)/100).padStart(9)} | ${mpResults.length>0?'—':'-'}    | ${(totWins/totN*100).toFixed(1).padStart(4)} | ${totN}`);
  console.log('\n'+'='.repeat(70));
  console.log('  DONE');
}

main().catch(console.error);
