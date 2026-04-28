#!/usr/bin/env node
'use strict';
// FASE 4 — Stress tests on bear/crash periods
const fs=require('fs');const path=require('path');
const E=require('./apex_x_engine.js');

const RESULTS_DIR=path.join(__dirname,'..','results');

function filterWindow(allData,fromTs,toTs){
  const out={};
  for(const pair of Object.keys(allData)){
    const b1h=allData[pair].b1h.filter(b=>b.t>=fromTs&&b.t<=toTs);
    const b4h=allData[pair].b4h.filter(b=>b.t>=fromTs-4*3600000&&b.t<=toTs);
    if(b1h.length>300)out[pair]={b1h,b4h};
  }
  return out;
}

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('APEX X — FASE 4 — STRESS TESTS');console.log('═'.repeat(80));

  // Load ALL available data: holdout + training
  console.log('\n[1/3] Loading full universe (holdout 2024-07→2025-06 + training 2025-07→2026-03)...');
  const allData={};
  for(const pair of E.PAIRS){
    const b1m_h=E.load1m(pair,'/tmp/binance-klines-1m-holdout')||[];
    const b1m_t=E.load1m(pair,'/tmp/binance-klines-1m')||[];
    const merged=b1m_h.concat(b1m_t);
    if(merged.length<50000)continue;
    merged.sort((a,b)=>a[0]-b[0]);
    // Dedup by timestamp
    const seen=new Set();const uniq=[];for(const b of merged){if(!seen.has(b[0])){seen.add(b[0]);uniq.push(b);}}
    allData[pair]={b1h:E.aggTF(uniq,60),b4h:E.aggTF(uniq,240)};
  }
  console.log(`  ${Object.keys(allData).length}/15 pairs loaded`);

  // Stress windows (approximate 1-month slices around volatile events within available data)
  // Our data covers 2024-07 to 2026-03, so pick volatile subsets:
  const stressWindows=[
    {name:'Aug 2024 flash crash',from:Date.UTC(2024,7,1),to:Date.UTC(2024,7,31,23,59)},
    {name:'Oct-Nov 2024 rally',from:Date.UTC(2024,9,1),to:Date.UTC(2024,10,30,23,59)},
    {name:'Feb 2025 drawdown',from:Date.UTC(2025,1,1),to:Date.UTC(2025,1,28,23,59)},
    {name:'Dec 2025 chop',from:Date.UTC(2025,11,1),to:Date.UTC(2025,11,31,23,59)},
    {name:'Mar 2026 bear',from:Date.UTC(2026,2,1),to:Date.UTC(2026,2,31,23,59)},
  ];

  console.log('\n[2/3] Running stress tests on 5 volatile windows...');
  const results=[];
  for(const sw of stressWindows){
    const windowData=filterWindow(allData,sw.from,sw.to);
    if(Object.keys(windowData).length<5){console.log(`  ✗ ${sw.name}: insufficient pairs`);continue;}
    const span=(sw.to-sw.from)/86400000;
    const{signals,parsed}=E.genSignals(windowData,{train:Math.min(20,Math.floor(span*0.5)),test:5,step:5,spanDays:Math.floor(span)});
    const fundings={};for(const p of Object.keys(windowData))fundings[p]=E.proxyFunding(windowData[p].b1h);
    const r=E.runApexX(signals,parsed,windowData,fundings);
    const sA=E.statsFull(r.tradesA);
    const sB=E.statsFull(r.tradesB);
    const allT=[...r.tradesA,...r.tradesB];
    const sAll=E.statsFull(allT);
    results.push({window:sw.name,span_d:span,signals:signals.length,streamA:sA,streamB:sB,combined:sAll});
    console.log(`  ${sw.name.padEnd(30)}: ${sAll.n}t PF${sAll.pf.toFixed(2)} WR${sAll.wr.toFixed(0)}% DD${sAll.mddPct.toFixed(0)}% PnL$${sAll.pnl.toFixed(0)}`);
  }

  console.log('\n'+'═'.repeat(80));
  console.log('STRESS TEST RESULTS');
  console.log('═'.repeat(80));
  console.log('Window                         Trades   PF     WR      DD      PnL       Verdict');
  console.log('─'.repeat(80));
  for(const r of results){
    const verdict=r.combined.mddPct<=30?'✓ OK':(r.combined.mddPct<=60?'⚠ ELEVATED':'✗ CATASTROPHIC');
    console.log(`${r.window.padEnd(30)} ${String(r.combined.n).padStart(4)}  ${r.combined.pf.toFixed(2).padStart(4)}  ${r.combined.wr.toFixed(0).padStart(3)}%  ${(r.combined.mddPct.toFixed(0)+'%').padStart(4)}  ${'$'+r.combined.pnl.toFixed(0).padStart(5)}  ${verdict}`);
  }

  // Average and worst-case
  const avgDD=results.reduce((s,r)=>s+r.combined.mddPct,0)/results.length;
  const worstDD=Math.max(...results.map(r=>r.combined.mddPct));
  const survivedCount=results.filter(r=>r.combined.mddPct<=avgDD*2).length;

  console.log(`\nAvg DD: ${avgDD.toFixed(1)}% | Worst DD: ${worstDD.toFixed(1)}% | Survived (DD≤2×avg): ${survivedCount}/${results.length}`);

  const report={
    phase:'4 — APEX X Stress Tests',
    runtime_s:(Date.now()-t0)/1000,
    windows_tested:results.length,
    results,
    avg_dd:avgDD,
    worst_dd:worstDD,
    survived_2x_avg_count:survivedCount,
  };
  fs.writeFileSync(path.join(RESULTS_DIR,'03_stress_tests.json'),JSON.stringify(report,null,2));
  console.log(`\nRuntime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`Saved: ${RESULTS_DIR}/03_stress_tests.json`);
}
main().catch(e=>{console.error(e.stack);process.exit(1);});
