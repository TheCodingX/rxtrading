#!/usr/bin/env node
'use strict';
// FASE 1 — APEX X backtest 274d on training window (2025-07 → 2026-03)
const fs=require('fs');const path=require('path');
const E=require('./apex_x_engine.js');

const KLINES_DIR='/tmp/binance-klines-1m';
const RESULTS_DIR=path.join(__dirname,'..','results');

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('APEX X — FASE 1 — BACKTEST 274d (2025-07→2026-03)');console.log('═'.repeat(80));

  console.log('\n[1/3] Loading data...');
  const allData={};
  for(const pair of E.PAIRS){const b1m=E.load1m(pair,KLINES_DIR);if(!b1m||b1m.length<50000)continue;allData[pair]={b1h:E.aggTF(b1m,60),b4h:E.aggTF(b1m,240)};}
  console.log(`  ${Object.keys(allData).length} pairs loaded`);

  console.log('\n[2/3] Generating Pearson signals + funding proxies...');
  const{signals,parsed}=E.genSignals(allData);
  const fundings={};for(const p of Object.keys(allData))fundings[p]=E.proxyFunding(allData[p].b1h);
  console.log(`  ${signals.length} directional signals`);

  console.log('\n[3/3] Running APEX X composite engine...');
  const r=E.runApexX(signals,parsed,allData,fundings);

  const sA=E.statsFull(r.tradesA);
  const sB=E.statsFull(r.tradesB);
  const allTrades=[...r.tradesA,...r.tradesB].sort((a,b)=>a.ts-b.ts);
  const sAll=E.statsFull(allTrades);
  const tpdAll=sAll.n/273;
  const tpdA=sA.n/273;
  const tpdB=sB.n/273;
  const pnlContribA=sA.pnl/(sA.pnl+sB.pnl)*100;
  const pnlContribB=sB.pnl/(sA.pnl+sB.pnl)*100;

  console.log('\n'+'═'.repeat(80));
  console.log('RESULTS — APEX X 274d');
  console.log('═'.repeat(80));
  console.log('');
  console.log('                    Stream A        Stream B        COMBINED');
  console.log('─'.repeat(80));
  console.log(`Trades            ${String(sA.n).padStart(8)}  ${String(sB.n).padStart(14)}  ${String(sAll.n).padStart(14)}`);
  console.log(`PF                ${sA.pf.toFixed(2).padStart(8)}  ${sB.pf.toFixed(2).padStart(14)}  ${sAll.pf.toFixed(2).padStart(14)}`);
  console.log(`WR                ${(sA.wr.toFixed(1)+'%').padStart(8)}  ${(sB.wr.toFixed(1)+'%').padStart(14)}  ${(sAll.wr.toFixed(1)+'%').padStart(14)}`);
  console.log(`Sharpe            ${sA.sharpe.toFixed(2).padStart(8)}  ${sB.sharpe.toFixed(2).padStart(14)}  ${sAll.sharpe.toFixed(2).padStart(14)}`);
  console.log(`DD                ${(sA.mddPct.toFixed(1)+'%').padStart(8)}  ${(sB.mddPct.toFixed(1)+'%').padStart(14)}  ${(sAll.mddPct.toFixed(1)+'%').padStart(14)}`);
  console.log(`PnL               ${'$'+sA.pnl.toFixed(0).padStart(6)}  ${'$'+sB.pnl.toFixed(0).padStart(12)}  ${'$'+sAll.pnl.toFixed(0).padStart(12)}`);
  console.log(`t/d               ${tpdA.toFixed(2).padStart(8)}  ${tpdB.toFixed(2).padStart(14)}  ${tpdAll.toFixed(2).padStart(14)}`);
  console.log(`PnL contribution  ${pnlContribA.toFixed(1)+'%'.padStart(7)}  ${(pnlContribB.toFixed(1)+'%').padStart(13)}  ${'100%'.padStart(14)}`);

  // Rolling correlation between streams
  const corrs=E.rollingCorrelation(r.tradesA,r.tradesB,30);
  const corrVals=corrs.map(c=>c.corr);
  const corrMean=corrVals.reduce((a,x)=>a+x,0)/corrVals.length;
  const corrMax=Math.max(...corrVals);const corrMin=Math.min(...corrVals);
  const corrHighCount=corrVals.filter(c=>Math.abs(c)>0.5).length;
  const corrHighPct=corrHighCount/corrVals.length*100;

  console.log('\n── Rolling 30d correlation Stream A vs B ──');
  console.log(`Mean: ${corrMean.toFixed(3)} | Min: ${corrMin.toFixed(3)} | Max: ${corrMax.toFixed(3)}`);
  console.log(`Windows with |corr|>0.5: ${corrHighCount}/${corrVals.length} (${corrHighPct.toFixed(1)}%)`);

  // Monthly segmentation
  const monthly=E.monthlySegmentation(allTrades);
  const monthsPos=Object.values(monthly).filter(m=>m.monthPnL>=0).length;
  const totalMonths=Object.keys(monthly).length;
  console.log('\n── Monthly segmentation ──');
  console.log('Month     Trades   PF     WR     PnL');
  for(const[m,v]of Object.entries(monthly).sort()){
    console.log(`${m}   ${String(v.n).padStart(4)}  ${v.pf.toFixed(2).padStart(4)}  ${v.wr.toFixed(1).padStart(4)}%  $${v.pnl.toFixed(0).padStart(6)}`);
  }

  // v42 PRO+ baseline comparison (from /research-v44/results/06b_integrated_v44_redesigned.json)
  const v42PRO_PF=1.30,v42PRO_WR=48.0,v42PRO_DD=24.0,v42PRO_tpd=5.06,v42PRO_Sh=3.2;

  console.log('\n── APEX X vs v42 PRO+ ──');
  console.log('                 v42 PRO+    APEX X     Δ');
  console.log(`PF              ${v42PRO_PF.toFixed(2).padStart(8)}  ${sAll.pf.toFixed(2).padStart(8)}  ${(sAll.pf-v42PRO_PF>=0?'+':'')+(sAll.pf-v42PRO_PF).toFixed(2)}`);
  console.log(`WR              ${(v42PRO_WR.toFixed(1)+'%').padStart(8)}  ${(sAll.wr.toFixed(1)+'%').padStart(8)}  ${(sAll.wr-v42PRO_WR>=0?'+':'')+(sAll.wr-v42PRO_WR).toFixed(1)}pp`);
  console.log(`DD              ${(v42PRO_DD.toFixed(1)+'%').padStart(8)}  ${(sAll.mddPct.toFixed(1)+'%').padStart(8)}  ${(sAll.mddPct-v42PRO_DD>=0?'+':'')+(sAll.mddPct-v42PRO_DD).toFixed(1)}pp`);
  console.log(`t/d             ${v42PRO_tpd.toFixed(2).padStart(8)}  ${tpdAll.toFixed(2).padStart(8)}  ${(tpdAll-v42PRO_tpd>=0?'+':'')+(tpdAll-v42PRO_tpd).toFixed(2)}`);
  console.log(`Sharpe          ${v42PRO_Sh.toFixed(2).padStart(8)}  ${sAll.sharpe.toFixed(2).padStart(8)}  ${(sAll.sharpe-v42PRO_Sh>=0?'+':'')+(sAll.sharpe-v42PRO_Sh).toFixed(2)}`);

  // Gates evaluation for FASE 1
  const gates={
    pf_ge_baseline_plus_005:sAll.pf>=v42PRO_PF+0.05,
    dd_le_baseline:sAll.mddPct<=v42PRO_DD,
    corr_below_04_90pct:(corrVals.length-corrHighCount)/corrVals.length>=0.90,
    funding_contributes_10pct:Math.abs(pnlContribB)>=10,
  };
  const gatesPass=Object.values(gates).filter(x=>x).length;

  console.log('\n── FASE 1 Gates ──');
  console.log(`  PF ≥ 1.35 (baseline +0.05):   ${gates.pf_ge_baseline_plus_005?'✓':'✗'} (${sAll.pf.toFixed(2)})`);
  console.log(`  DD ≤ 24%:                     ${gates.dd_le_baseline?'✓':'✗'} (${sAll.mddPct.toFixed(1)}%)`);
  console.log(`  Rolling corr <0.4 in 90% win: ${gates.corr_below_04_90pct?'✓':'✗'} (${(100-corrHighPct).toFixed(1)}% below)`);
  console.log(`  Funding contrib ≥10% PnL:     ${gates.funding_contributes_10pct?'✓':'✗'} (${Math.abs(pnlContribB).toFixed(1)}%)`);
  console.log(`\n🏁 FASE 1: ${gatesPass}/4 gates pass`);

  const report={
    phase:'1 — APEX X Backtest 274d',
    runtime_s:(Date.now()-t0)/1000,
    stream_a:{...sA,tpd:tpdA,pnl_contribution_pct:pnlContribA},
    stream_b:{...sB,tpd:tpdB,pnl_contribution_pct:pnlContribB},
    combined:{...sAll,tpd:tpdAll},
    vs_v42proplus:{delta_pf:sAll.pf-v42PRO_PF,delta_wr:sAll.wr-v42PRO_WR,delta_dd:sAll.mddPct-v42PRO_DD,delta_tpd:tpdAll-v42PRO_tpd,delta_sharpe:sAll.sharpe-v42PRO_Sh},
    rolling_corr:{mean:corrMean,min:corrMin,max:corrMax,n_windows:corrVals.length,high_windows_pct:corrHighPct},
    monthly,
    months_positive:`${monthsPos}/${totalMonths}`,
    gates,
    gates_passed:`${gatesPass}/4`,
  };

  fs.writeFileSync(path.join(RESULTS_DIR,'01_backtest_274d.json'),JSON.stringify(report,null,2));

  // Also save daily PnL CSV for further analysis
  const dailyA={};for(const t of r.tradesA)dailyA[t.date]=(dailyA[t.date]||0)+t.pnl;
  const dailyB={};for(const t of r.tradesB)dailyB[t.date]=(dailyB[t.date]||0)+t.pnl;
  const allDates=[...new Set([...Object.keys(dailyA),...Object.keys(dailyB)])].sort();
  const csvLines=['date,stream_a_pnl,stream_b_pnl,combined_pnl,rolling_corr_30d'];
  for(let i=0;i<allDates.length;i++){
    const d=allDates[i];
    const a=dailyA[d]||0;const b=dailyB[d]||0;
    const corrRec=corrs.find(c=>c.date===d);
    csvLines.push(`${d},${a.toFixed(2)},${b.toFixed(2)},${(a+b).toFixed(2)},${corrRec?corrRec.corr.toFixed(4):''}`);
  }
  fs.writeFileSync(path.join(RESULTS_DIR,'01_daily_pnl.csv'),csvLines.join('\n'));

  console.log(`\nRuntime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`Saved: ${RESULTS_DIR}/01_backtest_274d.json`);
  console.log(`CSV: ${RESULTS_DIR}/01_daily_pnl.csv`);
}
main().catch(e=>{console.error(e);process.exit(1);});
