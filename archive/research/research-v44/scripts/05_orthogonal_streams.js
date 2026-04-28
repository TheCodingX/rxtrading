#!/usr/bin/env node
'use strict';
// FASE 5 — Orthogonal Streams
// Técnica 11: Funding Carry Harvester (settlement windows 00/08/16 UTC)
// Técnica 12: Post-Liquidation Fade (detect cascades, fade entry)
const fs=require('fs');const path=require('path');

const KLINES_DIR='/tmp/binance-klines-1m';
const RESULTS_DIR=path.join(__dirname,'..','results');

const PAIRS=['ADAUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','SOLUSDT','LTCUSDT','DOTUSDT','NEARUSDT','AVAXUSDT','DOGEUSDT','BNBUSDT'];
const INIT_CAP=500;

function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggTF(b1m,m){const o=[];const s=m*60000;let i0=0;while(i0<b1m.length&&(b1m[i0][0]%s)!==0)i0++;for(let i=i0;i<b1m.length;i+=m){const g=b1m.slice(i,i+m);if(g.length<m)break;let h=-Infinity,l=Infinity,v=0,tbv=0;for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];}const c=g[g.length-1][4];o.push({t:g[0][0],o:g[0][1],h,l,c,v,tbv,tsv:v-tbv});}return o;}

// Proxy funding rate: derived from premium between perp (close) and proxy spot (EMA-50 of close)
// In production, real funding rate from Binance API used. Proxy captures directional basis dynamics.
function proxyFundingRate(bars1h){
  const n=bars1h.length;
  const closes=bars1h.map(b=>b.c);
  // EMA proxy for "index"
  const ema=new Float64Array(n);ema[0]=closes[0];const alpha=2/(50+1);
  for(let i=1;i<n;i++)ema[i]=closes[i]*alpha+ema[i-1]*(1-alpha);
  // Premium = (perp - index) / index
  const premium=closes.map((c,i)=>(c-ema[i])/ema[i]);
  // Smooth premium as funding rate proxy (8h window = funding settlement interval)
  const funding=new Float64Array(n);
  const w=8;
  for(let i=w;i<n;i++){
    let s=0;for(let j=i-w+1;j<=i;j++)s+=premium[j];
    funding[i]=s/w;
  }
  return funding;
}

// ═══ Técnica 11: Funding Carry Harvester ═══
// Entry at settlement windows ±30min: short if funding >+0.03%, long if <-0.02%
// Size 10% capital
function fundingCarryBacktest(bars1h,funding){
  const trades=[];
  const SIZE_PCT=0.10;
  const TP_BPS=30;const SL_BPS=25; // 30bp TP, 25bp SL for ~1:1 risk
  const HOLD_H=4; // hold 4h max
  const cap={value:INIT_CAP};
  let pos=null;
  for(let i=50;i<bars1h.length-HOLD_H;i++){
    const ts=bars1h[i].t;const d=new Date(ts);const hr=d.getUTCHours();
    if(pos){
      // Check exit
      const entry=pos.entry;const dir=pos.dir;
      const h=bars1h[i].h;const l=bars1h[i].l;
      const tpP=dir===1?entry*(1+TP_BPS/10000):entry*(1-TP_BPS/10000);
      const slP=dir===1?entry*(1-SL_BPS/10000):entry*(1+SL_BPS/10000);
      const hitTP=(dir===1&&h>=tpP)||(dir===-1&&l<=tpP);
      const hitSL=(dir===1&&l<=slP)||(dir===-1&&h>=slP);
      const timeout=i>=pos.entryI+HOLD_H;
      if(hitTP||hitSL||timeout){
        const exitP=hitTP?tpP:(hitSL?slP:bars1h[i].c);
        const pnl_pct=dir===1?(exitP-entry)/entry:(entry-exitP)/entry;
        const pnl=pos.size*pnl_pct-pos.size*0.0008; // fees
        cap.value+=pnl;
        trades.push({pnl,date:d.toISOString().slice(0,10),ts,funding:pos.funding,dir,exitType:hitTP?'TP':(hitSL?'SL':'TO')});
        pos=null;
      }
    }
    // Check entry at settlement windows ±30min
    const atSettlement=(hr===0||hr===8||hr===16);
    if(!pos&&atSettlement){
      const f=funding[i];
      // Real funding rate typical ±0.01%. Proxy spans larger. Use relative thresholds.
      // Scale: use rolling P80 of funding as threshold
      const fWindow=funding.slice(Math.max(0,i-168),i); // last 7d
      const pos80=[...fWindow].sort((a,b)=>a-b)[Math.floor(fWindow.length*0.80)]||0;
      const neg80=[...fWindow].sort((a,b)=>a-b)[Math.floor(fWindow.length*0.20)]||0;
      let dir=0;
      if(f>pos80&&f>0.005)dir=-1;  // high funding → short
      else if(f<neg80&&f<-0.002)dir=1; // low funding → long
      if(dir!==0){
        pos={entry:bars1h[i].c,dir,entryI:i,size:cap.value*SIZE_PCT,funding:f};
      }
    }
  }
  return{trades,finalCap:cap.value};
}

// ═══ Técnica 12: Post-Liquidation Fade ═══
// Detect liquidation cascades: large range bars with directional move + high volume
// Fade: enter counter-trend after cascade, TP at 30% retrace of move
function liquidationFadeBacktest(bars1h){
  const trades=[];
  const SIZE_PCT=0.10;
  const cap={value:INIT_CAP};
  let pos=null;
  // Volume z-score to detect cascades
  const vols=bars1h.map(b=>b.v);
  const window=168;
  for(let i=window;i<bars1h.length-6;i++){
    const ts=bars1h[i].t;const d=new Date(ts);
    if(pos){
      const h=bars1h[i].h;const l=bars1h[i].l;const entry=pos.entry;const dir=pos.dir;
      const tpP=pos.tpP;const slP=pos.slP;
      const hitTP=(dir===1&&h>=tpP)||(dir===-1&&l<=tpP);
      const hitSL=(dir===1&&l<=slP)||(dir===-1&&h>=slP);
      const timeout=i>=pos.entryI+6;
      if(hitTP||hitSL||timeout){
        const exitP=hitTP?tpP:(hitSL?slP:bars1h[i].c);
        const pnl_pct=dir===1?(exitP-entry)/entry:(entry-exitP)/entry;
        const pnl=pos.size*pnl_pct-pos.size*0.0008;
        cap.value+=pnl;
        trades.push({pnl,date:d.toISOString().slice(0,10),ts,dir,exitType:hitTP?'TP':(hitSL?'SL':'TO')});
        pos=null;
      }
    }
    if(!pos){
      // Detect cascade: volume > 3σ + abs return > 2%
      let m=0;for(let j=i-window;j<i;j++)m+=vols[j];m/=window;
      let sd=0;for(let j=i-window;j<i;j++)sd+=(vols[j]-m)**2;sd=Math.sqrt(sd/window);
      const volZ=sd>0?(bars1h[i].v-m)/sd:0;
      const retPct=(bars1h[i].c-bars1h[i].o)/bars1h[i].o;
      if(volZ>3&&Math.abs(retPct)>0.02){
        // Cascade detected; fade next bar
        const dir=retPct>0?-1:1; // fade: opposite direction
        const entry=bars1h[i].c;
        const moveSize=Math.abs(retPct);
        const tpP=dir===1?entry*(1+0.3*moveSize):entry*(1-0.3*moveSize);
        const slP=dir===1?entry*(1-0.6*moveSize):entry*(1+0.6*moveSize);
        pos={entry,dir,entryI:i,size:cap.value*SIZE_PCT,tpP,slP};
      }
    }
  }
  return{trades,finalCap:cap.value};
}

function stats(trades){
  if(!trades.length)return{pf:0,wr:0,pnl:0,n:0,sharpe:0,mdd:0};
  const w=trades.filter(x=>x.pnl>0),lo=trades.filter(x=>x.pnl<=0);
  const gw=w.reduce((s,x)=>s+x.pnl,0),gl=Math.abs(lo.reduce((s,x)=>s+x.pnl,0));
  const byDay={};for(const x of trades){byDay[x.date]=(byDay[x.date]||0)+x.pnl;}
  const dR=Object.values(byDay);if(dR.length<2)return{pf:gl>0?gw/gl:0,wr:w.length/trades.length*100,pnl:gw-gl,n:trades.length,sharpe:0,mdd:0};
  const mD=dR.reduce((a,x)=>a+x,0)/dR.length;const vD=dR.reduce((a,x)=>a+(x-mD)**2,0)/dR.length;
  const sharpe=vD>0?mD/Math.sqrt(vD)*Math.sqrt(365):0;
  let cum=0,pk=0,mdd=0;for(const x of trades){cum+=x.pnl;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}
  return{pf:gl>0?gw/gl:0,wr:w.length/trades.length*100,pnl:gw-gl,n:trades.length,sharpe,mdd};
}

function correlation(a,b){
  const nA=new Map(a.map(t=>[t.date,t.pnl||0]));
  const nB=new Map(b.map(t=>[t.date,t.pnl||0]));
  const dates=[...new Set([...nA.keys(),...nB.keys()])].sort();
  const arrA=dates.map(d=>nA.get(d)||0);const arrB=dates.map(d=>nB.get(d)||0);
  if(arrA.length<5)return 0;
  const mA=arrA.reduce((s,x)=>s+x,0)/arrA.length;const mB=arrB.reduce((s,x)=>s+x,0)/arrB.length;
  let cab=0,caa=0,cbb=0;
  for(let i=0;i<arrA.length;i++){cab+=(arrA[i]-mA)*(arrB[i]-mB);caa+=(arrA[i]-mA)**2;cbb+=(arrB[i]-mB)**2;}
  return caa*cbb>0?cab/Math.sqrt(caa*cbb):0;
}

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('FASE 5 — Orthogonal Streams (Funding Carry + Post-Liq Fade)');console.log('═'.repeat(80));

  const allBars={};
  console.log('\n[1/3] Loading data...');
  for(const pair of PAIRS){
    const b1m=load1m(pair);if(!b1m||b1m.length<50000)continue;
    const b1h=aggTF(b1m,60);
    allBars[pair]=b1h;
  }
  console.log(`  ${Object.keys(allBars).length} pairs loaded`);

  // Funding carry per pair
  console.log('\n[2/3] Funding Carry Harvester...');
  const fundingResults={};
  let allFundingTrades=[];
  for(const pair of Object.keys(allBars)){
    const funding=proxyFundingRate(allBars[pair]);
    const r=fundingCarryBacktest(allBars[pair],funding);
    const s=stats(r.trades);
    fundingResults[pair]={...s};
    allFundingTrades=allFundingTrades.concat(r.trades.map(t=>({...t,pair})));
    process.stdout.write(`  ${pair.padEnd(14)} ${String(s.n).padStart(3)}t PF${s.pf.toFixed(2)} WR${s.wr.toFixed(0)}% Sh${s.sharpe.toFixed(1)} PnL$${s.pnl.toFixed(0)}\n`);
  }
  const aggF=stats(allFundingTrades);
  console.log(`\n  ▶ AGGREGATE: ${aggF.n}t PF${aggF.pf.toFixed(2)} WR${aggF.wr.toFixed(1)}% Sh${aggF.sharpe.toFixed(2)} PnL$${aggF.pnl.toFixed(0)}`);

  // Post-liq fade per pair
  console.log('\n[3/3] Post-Liquidation Fade...');
  const liqResults={};
  let allLiqTrades=[];
  for(const pair of Object.keys(allBars)){
    const r=liquidationFadeBacktest(allBars[pair]);
    const s=stats(r.trades);
    liqResults[pair]={...s};
    allLiqTrades=allLiqTrades.concat(r.trades.map(t=>({...t,pair})));
    process.stdout.write(`  ${pair.padEnd(14)} ${String(s.n).padStart(3)}t PF${s.pf.toFixed(2)} WR${s.wr.toFixed(0)}% Sh${s.sharpe.toFixed(1)} PnL$${s.pnl.toFixed(0)}\n`);
  }
  const aggL=stats(allLiqTrades);
  console.log(`\n  ▶ AGGREGATE: ${aggL.n}t PF${aggL.pf.toFixed(2)} WR${aggL.wr.toFixed(1)}% Sh${aggL.sharpe.toFixed(2)} PnL$${aggL.pnl.toFixed(0)}`);

  const corrFL=correlation(allFundingTrades,allLiqTrades);
  console.log(`\n  Correlation Funding ↔ Liq fade: ${corrFL.toFixed(3)} (target <0.3 for orthogonality)`);

  const summary={phase:'5 — Orthogonal Streams',runtime_s:(Date.now()-t0)/1000,funding_carry:{aggregate:aggF,per_pair:fundingResults},post_liq_fade:{aggregate:aggL,per_pair:liqResults},correlation:{funding_vs_liq:corrFL},verdict_funding:aggF.pf>=1.0?'ACCEPT':'REJECT',verdict_liq:aggL.pf>=1.0?'ACCEPT':'REJECT'};
  fs.writeFileSync(path.join(RESULTS_DIR,'05_orthogonal_streams.json'),JSON.stringify(summary,null,2));

  console.log('\n'+'═'.repeat(80));console.log('FASE 5 COMPLETE');console.log('═'.repeat(80));
  console.log(`Runtime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`Funding: ${summary.verdict_funding} (PF ${aggF.pf.toFixed(2)})`);
  console.log(`Liq Fade: ${summary.verdict_liq} (PF ${aggL.pf.toFixed(2)})`);
  console.log(`Orthogonality: ${corrFL.toFixed(3)} ${Math.abs(corrFL)<0.3?'✓':'✗'}`);
  console.log(`Saved: ${RESULTS_DIR}/05_orthogonal_streams.json`);
}
main().catch(e=>{console.error(e);process.exit(1);});
