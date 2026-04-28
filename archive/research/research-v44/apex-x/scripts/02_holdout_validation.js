#!/usr/bin/env node
'use strict';
// FASE 2 — APEX X holdout validation (2024-07 → 2025-06, never seen by v42 PRO+)
const fs=require('fs');const path=require('path');
const E=require('./apex_x_engine.js');

const KLINES_DIR='/tmp/binance-klines-1m-holdout';
const RESULTS_DIR=path.join(__dirname,'..','results');

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('APEX X — FASE 2 — HOLDOUT 2024-07 → 2025-06');console.log('═'.repeat(80));

  console.log('\n[1/3] Loading holdout data...');
  const allData={};
  for(const pair of E.PAIRS){
    const b1m=E.load1m(pair,KLINES_DIR);
    if(!b1m||b1m.length<50000){console.log(`  ✗ ${pair}: insufficient (${b1m?b1m.length:0} bars)`);continue;}
    allData[pair]={b1h:E.aggTF(b1m,60),b4h:E.aggTF(b1m,240)};
  }
  const loaded=Object.keys(allData).length;
  console.log(`  ${loaded}/15 pairs loaded`);
  if(loaded<10){console.error('Insufficient pairs for holdout');process.exit(1);}

  const firstTs=Math.min(...Object.values(allData).map(d=>d.b1h[0].t));
  const lastTs=Math.max(...Object.values(allData).map(d=>d.b1h[d.b1h.length-1].t));
  const span=(lastTs-firstTs)/86400000;
  console.log(`  Data span: ${new Date(firstTs).toISOString().slice(0,10)} → ${new Date(lastTs).toISOString().slice(0,10)} (${span.toFixed(0)}d)`);

  console.log('\n[2/3] Generating signals + funding...');
  const{signals,parsed}=E.genSignals(allData,{spanDays:Math.floor(span)});
  const fundings={};for(const p of Object.keys(allData))fundings[p]=E.proxyFunding(allData[p].b1h);
  console.log(`  ${signals.length} directional signals`);

  console.log('\n[3/3] Running APEX X holdout backtest...');
  const r=E.runApexX(signals,parsed,allData,fundings);
  const sA=E.statsFull(r.tradesA);
  const sB=E.statsFull(r.tradesB);
  const allTrades=[...r.tradesA,...r.tradesB].sort((a,b)=>a.ts-b.ts);
  const sAll=E.statsFull(allTrades);
  const tpdA=sA.n/span;const tpdB=sB.n/span;const tpdAll=sAll.n/span;
  const pnlContribA=sA.pnl+sB.pnl!==0?sA.pnl/(sA.pnl+sB.pnl)*100:0;
  const pnlContribB=sA.pnl+sB.pnl!==0?sB.pnl/(sA.pnl+sB.pnl)*100:0;

  console.log('\n'+'═'.repeat(80));
  console.log('HOLDOUT RESULTS — 2024-07 → 2025-06');
  console.log('═'.repeat(80));
  console.log('\n                    Stream A        Stream B        COMBINED');
  console.log('─'.repeat(80));
  console.log(`Trades            ${String(sA.n).padStart(8)}  ${String(sB.n).padStart(14)}  ${String(sAll.n).padStart(14)}`);
  console.log(`PF                ${sA.pf.toFixed(2).padStart(8)}  ${sB.pf.toFixed(2).padStart(14)}  ${sAll.pf.toFixed(2).padStart(14)}`);
  console.log(`WR                ${(sA.wr.toFixed(1)+'%').padStart(8)}  ${(sB.wr.toFixed(1)+'%').padStart(14)}  ${(sAll.wr.toFixed(1)+'%').padStart(14)}`);
  console.log(`Sharpe            ${sA.sharpe.toFixed(2).padStart(8)}  ${sB.sharpe.toFixed(2).padStart(14)}  ${sAll.sharpe.toFixed(2).padStart(14)}`);
  console.log(`DD                ${(sA.mddPct.toFixed(1)+'%').padStart(8)}  ${(sB.mddPct.toFixed(1)+'%').padStart(14)}  ${(sAll.mddPct.toFixed(1)+'%').padStart(14)}`);
  console.log(`PnL               ${'$'+sA.pnl.toFixed(0).padStart(6)}  ${'$'+sB.pnl.toFixed(0).padStart(12)}  ${'$'+sAll.pnl.toFixed(0).padStart(12)}`);
  console.log(`t/d               ${tpdA.toFixed(2).padStart(8)}  ${tpdB.toFixed(2).padStart(14)}  ${tpdAll.toFixed(2).padStart(14)}`);

  // Rolling correlation
  const corrs=E.rollingCorrelation(r.tradesA,r.tradesB,30);
  const corrVals=corrs.map(c=>c.corr);
  const corrMean=corrVals.reduce((a,x)=>a+x,0)/corrVals.length;
  const corrHighCount=corrVals.filter(c=>Math.abs(c)>0.5).length;
  const corrHighPct=corrVals.length?corrHighCount/corrVals.length*100:0;

  console.log('\n── Rolling 30d correlation Stream A vs B ──');
  console.log(`Mean: ${corrMean.toFixed(3)} | Windows |corr|>0.5: ${corrHighCount}/${corrVals.length} (${corrHighPct.toFixed(1)}%)`);

  // Monthly segmentation
  const monthly=E.monthlySegmentation(allTrades);
  const months=Object.entries(monthly).sort();
  console.log('\n── Monthly segmentation ──');
  console.log('Month     Trades   PF     WR     PnL');
  let monthsPos=0;
  for(const[m,v]of months){
    const pos=v.monthPnL>=0;if(pos)monthsPos++;
    console.log(`${m}   ${String(v.n).padStart(4)}  ${v.pf.toFixed(2).padStart(4)}  ${v.wr.toFixed(1).padStart(4)}%  $${v.pnl.toFixed(0).padStart(6)}`);
  }

  // Compare vs FASE 1 (training) & V44 research holdout findings
  // V44 research TEST 1 findings: v42 PRO+ on this holdout → PF 1.00 (catastrophic degradation from training 1.85)
  // Funding carry on holdout: PF 1.47 (consistent with training 1.41)
  const fase1=JSON.parse(fs.readFileSync(path.join(RESULTS_DIR,'01_backtest_274d.json'),'utf8'));
  console.log('\n── Training (274d) vs Holdout (365d) ──');
  console.log('                 Training  Holdout   Δ        Degradation');
  const degrade=(train,hold)=>train!==0?((hold-train)/Math.abs(train)*100).toFixed(0)+'%':'n/a';
  console.log(`Stream A PF     ${fase1.stream_a.pf.toFixed(2).padStart(8)}  ${sA.pf.toFixed(2).padStart(7)}  ${(sA.pf-fase1.stream_a.pf>=0?'+':'')+(sA.pf-fase1.stream_a.pf).toFixed(2).padStart(5)}   ${degrade(fase1.stream_a.pf,sA.pf)}`);
  console.log(`Stream A WR     ${(fase1.stream_a.wr.toFixed(1)+'%').padStart(8)}  ${(sA.wr.toFixed(1)+'%').padStart(7)}  ${((sA.wr-fase1.stream_a.wr)>=0?'+':'')+(sA.wr-fase1.stream_a.wr).toFixed(1)}pp`);
  console.log(`Stream A DD     ${(fase1.stream_a.mddPct.toFixed(1)+'%').padStart(8)}  ${(sA.mddPct.toFixed(1)+'%').padStart(7)}  ${((sA.mddPct-fase1.stream_a.mddPct)>=0?'+':'')+(sA.mddPct-fase1.stream_a.mddPct).toFixed(1)}pp`);
  console.log(`Stream B PF     ${fase1.stream_b.pf.toFixed(2).padStart(8)}  ${sB.pf.toFixed(2).padStart(7)}  ${(sB.pf-fase1.stream_b.pf>=0?'+':'')+(sB.pf-fase1.stream_b.pf).toFixed(2).padStart(5)}   ${degrade(fase1.stream_b.pf,sB.pf)}`);
  console.log(`Stream B WR     ${(fase1.stream_b.wr.toFixed(1)+'%').padStart(8)}  ${(sB.wr.toFixed(1)+'%').padStart(7)}  ${((sB.wr-fase1.stream_b.wr)>=0?'+':'')+(sB.wr-fase1.stream_b.wr).toFixed(1)}pp`);
  console.log(`Combined PF     ${fase1.combined.pf.toFixed(2).padStart(8)}  ${sAll.pf.toFixed(2).padStart(7)}  ${(sAll.pf-fase1.combined.pf>=0?'+':'')+(sAll.pf-fase1.combined.pf).toFixed(2).padStart(5)}   ${degrade(fase1.combined.pf,sAll.pf)}`);
  console.log(`Combined DD     ${(fase1.combined.mddPct.toFixed(1)+'%').padStart(8)}  ${(sAll.mddPct.toFixed(1)+'%').padStart(7)}  ${((sAll.mddPct-fase1.combined.mddPct)>=0?'+':'')+(sAll.mddPct-fase1.combined.mddPct).toFixed(1)}pp`);

  // FASE 2 Gates
  const gates={
    combined_pf_ge_120:sAll.pf>=1.20,
    combined_dd_le_40:sAll.mddPct<=40,
    stream_a_survives:sA.pf>=0.80,
    stream_b_survives:sB.pf>=1.20,  // V44 research found funding carry robust in holdout
  };
  const gatesPass=Object.values(gates).filter(x=>x).length;

  console.log('\n── FASE 2 Holdout Gates ──');
  console.log(`  Combined PF ≥ 1.20:           ${gates.combined_pf_ge_120?'✓':'✗'} (${sAll.pf.toFixed(2)})`);
  console.log(`  Combined DD ≤ 40%:            ${gates.combined_dd_le_40?'✓':'✗'} (${sAll.mddPct.toFixed(1)}%)`);
  console.log(`  Stream A PF ≥ 0.80 (survives): ${gates.stream_a_survives?'✓':'✗'} (${sA.pf.toFixed(2)})`);
  console.log(`  Stream B PF ≥ 1.20 (V44 robust): ${gates.stream_b_survives?'✓':'✗'} (${sB.pf.toFixed(2)})`);
  console.log(`\n🏁 FASE 2: ${gatesPass}/4 gates pass`);
  console.log(`📅 Monthly: ${monthsPos}/${months.length} months positive`);

  const report={
    phase:'2 — APEX X Holdout Validation',
    runtime_s:(Date.now()-t0)/1000,
    holdout_span_days:span,
    pairs_loaded:loaded,
    stream_a:{...sA,tpd:tpdA,pnl_contribution_pct:pnlContribA},
    stream_b:{...sB,tpd:tpdB,pnl_contribution_pct:pnlContribB},
    combined:{...sAll,tpd:tpdAll},
    rolling_corr:{mean:corrMean,n:corrVals.length,high_pct:corrHighPct},
    monthly,
    months_positive:`${monthsPos}/${months.length}`,
    degradation_vs_training:{
      stream_a_pf:sA.pf-fase1.stream_a.pf,
      stream_a_dd:sA.mddPct-fase1.stream_a.mddPct,
      stream_b_pf:sB.pf-fase1.stream_b.pf,
      combined_pf:sAll.pf-fase1.combined.pf,
    },
    gates,
    gates_passed:`${gatesPass}/4`,
  };

  fs.writeFileSync(path.join(RESULTS_DIR,'02_holdout.json'),JSON.stringify(report,null,2));
  console.log(`\nRuntime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`Saved: ${RESULTS_DIR}/02_holdout.json`);
}
main().catch(e=>{console.error(e.stack);process.exit(1);});
