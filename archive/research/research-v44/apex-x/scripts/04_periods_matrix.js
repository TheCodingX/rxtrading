#!/usr/bin/env node
'use strict';
// Generate performance matrix for APEX + SAFE at 7/30/60/120 day windows
// Uses most recent data available (/tmp/binance-klines-1m/)
const fs=require('fs');const path=require('path');
const E=require('./apex_x_engine.js');

const RESULTS_DIR=path.join(__dirname,'..','results');

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));
  console.log('APEX + SAFE — PERFORMANCE MATRIX (7/30/60/120 days)');
  console.log('═'.repeat(80));

  console.log('\n[1/3] Loading full universe data (holdout + training combined)...');
  const allData={};
  for(const pair of E.PAIRS){
    const b1m_h=E.load1m(pair,'/tmp/binance-klines-1m-holdout')||[];
    const b1m_t=E.load1m(pair,'/tmp/binance-klines-1m')||[];
    const merged=b1m_h.concat(b1m_t);
    if(merged.length<10000)continue;
    merged.sort((a,b)=>a[0]-b[0]);
    const seen=new Set();const uniq=[];
    for(const b of merged){if(!seen.has(b[0])){seen.add(b[0]);uniq.push(b);}}
    allData[pair]={b1h:E.aggTF(uniq,60),b4h:E.aggTF(uniq,240)};
  }
  console.log(`  ${Object.keys(allData).length}/15 pairs loaded`);

  const lastTs=Math.max(...Object.values(allData).map(d=>d.b1h[d.b1h.length-1].t));
  const firstTs=Math.min(...Object.values(allData).map(d=>d.b1h[0].t));
  const totalSpan=(lastTs-firstTs)/86400000;
  console.log(`  Data range: ${new Date(firstTs).toISOString().slice(0,10)} → ${new Date(lastTs).toISOString().slice(0,10)} (${totalSpan.toFixed(0)}d)`);

  console.log('\n[2/3] Computing funding proxies...');
  const fundings={};for(const p of Object.keys(allData))fundings[p]=E.proxyFunding(allData[p].b1h);

  console.log('\n[3/3] Running full backtests (once each), then filtering by period...\n');

  // APEX: load TRAINING DATASET only (same source as FASE 1 that got 771 trades)
  console.log('  Loading APEX training-only dataset...');
  const apexData={};
  for(const pair of E.PAIRS){
    const b1m=E.load1m(pair,'/tmp/binance-klines-1m');
    if(!b1m||b1m.length<10000)continue;
    apexData[pair]={b1h:E.aggTF(b1m,60),b4h:E.aggTF(b1m,240)};
  }
  const apexLastTs=Math.max(...Object.values(apexData).map(d=>d.b1h[d.b1h.length-1].t));
  const apexFirstTs=Math.min(...Object.values(apexData).map(d=>d.b1h[0].t));
  const apexSpan=Math.floor((apexLastTs-apexFirstTs)/86400000);
  console.log(`    APEX data: ${Object.keys(apexData).length} pairs, ${apexSpan}d (${new Date(apexFirstTs).toISOString().slice(0,10)}→${new Date(apexLastTs).toISOString().slice(0,10)})`);
  const{signals:sigFull,parsed:parsedFull}=E.genSignals(apexData,{train:120,test:30,step:30,spanDays:apexSpan});
  const rA_full=E.runStreamA(sigFull,parsedFull);
  console.log(`    ${rA_full.trades.length} APEX trades`);

  // SAFE: runs on full combined data (no walk-forward needed)
  console.log(`  SAFE full backtest (${totalSpan.toFixed(0)}d combined data)...`);
  const rB_full=E.runStreamB(allData,fundings);
  console.log(`    ${rB_full.trades.length} SAFE trades over ${totalSpan.toFixed(0)}d`);

  // Filter by period windows (from lastTs backward)
  const periods=[7,30,60,120];
  const matrix={apex:{},safe:{}};

  function periodStats(trades,cutoff,days,cap=500){
    const subset=trades.filter(t=>t.ts>=cutoff);
    const s=E.statsFull(subset,cap);
    return{
      trades:s.n,pf:+s.pf.toFixed(2),wr:+s.wr.toFixed(1),
      dd_pct:+s.mddPct.toFixed(1),sharpe:+s.sharpe.toFixed(2),
      pnl:+s.pnl.toFixed(0),tpd:+(s.n/days).toFixed(2)
    };
  }

  for(const days of periods){
    const cutoff=lastTs-days*86400000;
    matrix.apex[days]=periodStats(rA_full.trades,cutoff,days);
    matrix.safe[days]=periodStats(rB_full.trades,cutoff,days);
    const a=matrix.apex[days];const s=matrix.safe[days];
    console.log(`  ${days}d window:`);
    console.log(`    APEX: ${String(a.trades).padStart(4)}t  PF ${a.pf.toFixed(2)}  WR ${a.wr.toFixed(1)}%  DD ${a.dd_pct.toFixed(1)}%  Sh ${a.sharpe.toFixed(2)}  PnL $${a.pnl}`);
    console.log(`    SAFE: ${String(s.trades).padStart(4)}t  PF ${s.pf.toFixed(2)}  WR ${s.wr.toFixed(1)}%  DD ${s.dd_pct.toFixed(1)}%  Sh ${s.sharpe.toFixed(2)}  PnL $${s.pnl}`);
  }

  console.log('\n'+'═'.repeat(80));
  console.log('MATRIX SUMMARY');
  console.log('═'.repeat(80));
  console.log('\n┌────────┬────────────────────────────────┬────────────────────────────────┐');
  console.log('│ Period │            APEX                │            SAFE                │');
  console.log('│        │  Trades  PF    WR%   DD%  Sh   │  Trades  PF    WR%   DD%  Sh   │');
  console.log('├────────┼────────────────────────────────┼────────────────────────────────┤');
  for(const days of periods){
    const a=matrix.apex[days];const s=matrix.safe[days];
    console.log(`│ ${String(days).padStart(4)}d  │  ${String(a.trades).padStart(5)}  ${a.pf.toFixed(2).padStart(4)}  ${a.wr.toFixed(1).padStart(4)}  ${a.dd_pct.toFixed(1).padStart(4)}  ${a.sharpe.toFixed(2).padStart(4)}  │  ${String(s.trades).padStart(5)}  ${s.pf.toFixed(2).padStart(4)}  ${s.wr.toFixed(1).padStart(4)}  ${s.dd_pct.toFixed(1).padStart(4)}  ${s.sharpe.toFixed(2).padStart(4)}  │`);
  }
  console.log('└────────┴────────────────────────────────┴────────────────────────────────┘');

  const report={
    generated_at:new Date().toISOString(),
    data_range:{from:new Date(firstTs).toISOString(),to:new Date(lastTs).toISOString()},
    pairs_count:Object.keys(allData).length,
    runtime_s:(Date.now()-t0)/1000,
    matrix
  };
  fs.writeFileSync(path.join(RESULTS_DIR,'04_periods_matrix.json'),JSON.stringify(report,null,2));
  console.log(`\nRuntime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`Saved: ${RESULTS_DIR}/04_periods_matrix.json`);
}
main().catch(e=>{console.error(e.stack);process.exit(1);});
