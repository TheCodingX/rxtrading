#!/usr/bin/env node
'use strict';
// TEST 1 — HOLDOUT SACROSANTO
// Run V44 with FROZEN params on 2024-07 → 2025-06 (12 months BEFORE training window)
const fs=require('fs');const path=require('path');
const E=require('./v44_engine.js');

const HOLDOUT_DIR='/tmp/binance-klines-1m-holdout';
const RESULTS_DIR=path.join(__dirname,'results');
if(!fs.existsSync(RESULTS_DIR))fs.mkdirSync(RESULTS_DIR,{recursive:true});

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('TEST 1 — HOLDOUT SACROSANTO (2024-07 → 2025-06)');console.log('═'.repeat(80));

  console.log('\nLoading holdout data...');
  const allData={};let npairs=0;
  for(const pair of E.PAIRS){
    const b1m=E.load1m(pair,HOLDOUT_DIR);
    if(!b1m||b1m.length<50000){console.log(`  ${pair}: SKIP (${b1m?b1m.length:0} bars)`);continue;}
    const b1h=E.aggTF(b1m,60);const b4h=E.aggTF(b1m,240);
    allData[pair]={b1h,b4h};
    npairs++;
    console.log(`  ${pair}: ${b1m.length} 1m bars, ${b1h.length} 1h bars  [${new Date(b1m[0][0]).toISOString().slice(0,10)} → ${new Date(b1m[b1m.length-1][0]).toISOString().slice(0,10)}]`);
  }
  if(npairs<10){console.error('Not enough pairs with data. Aborting.');process.exit(1);}

  // Determine span
  const firstT=Math.min(...Object.values(allData).map(d=>d.b1h[0].t));
  const lastT=Math.max(...Object.values(allData).map(d=>d.b1h[d.b1h.length-1].t));
  const spanDays=Math.floor((lastT-firstT)/86400000);
  console.log(`\nHoldout span: ${spanDays}d`);

  // Generate signals on holdout
  console.log('\nGenerating Pearson signals (walk-forward 120/30/30)...');
  const{signals,parsed}=E.genSignals(allData,{train:120,test:30,step:30,spanDays});
  console.log(`  ${signals.length} signals`);

  // HRP weights — use V44's original (frozen) weights (computed on training data)
  const hrpTraining=E.loadHRP(path.join(__dirname,'..','results'));
  if(!hrpTraining){console.error('HRP weights not found');process.exit(1);}

  // Compute funding proxies
  const fundings={};for(const p of Object.keys(allData))fundings[p]=E.proxyFunding(allData[p].b1h);

  // Run V44 directional
  console.log('\n[1/3] V44 Directional Engine (frozen params)...');
  const rDir=E.runV44(signals,parsed,allData,hrpTraining);
  const sDir=E.statsFull(rDir.trades);
  const tpdDir=sDir.n/spanDays;
  console.log(`  ${sDir.n}t PF${sDir.pf.toFixed(2)} WR${sDir.wr.toFixed(1)}% DD${sDir.mddPct.toFixed(1)}% Sh${sDir.sharpe.toFixed(2)} t/d${tpdDir.toFixed(2)} PnL$${sDir.pnl.toFixed(0)}`);

  // Funding stream
  console.log('\n[2/3] V44 Funding Carry Stream...');
  const rFund=E.runFundingStream(allData,fundings);
  const sFund=E.statsFull(rFund.trades);
  console.log(`  ${sFund.n}t PF${sFund.pf.toFixed(2)} WR${sFund.wr.toFixed(1)}% Sh${sFund.sharpe.toFixed(2)} PnL$${sFund.pnl.toFixed(0)}`);

  // Combined
  console.log('\n[3/3] V44 Combined...');
  const combined=[...rDir.trades,...rFund.trades].sort((a,b)=>a.ts-b.ts);
  const sComb=E.statsFull(combined);
  const tpdComb=sComb.n/spanDays;
  console.log(`  Combined: ${sComb.n}t PF${sComb.pf.toFixed(2)} WR${sComb.wr.toFixed(1)}% DD${sComb.mddPct.toFixed(1)}% Sh${sComb.sharpe.toFixed(2)} t/d${tpdComb.toFixed(2)} PnL$${sComb.pnl.toFixed(0)}`);

  // Compare vs V44 backtest (training): PF 1.85, DD 15.5%, WR 67.7%
  const TRAIN_PF=1.85,TRAIN_DD=15.5,TRAIN_WR=67.7,TRAIN_SH=1.75;
  const pfRatio=sComb.pf/TRAIN_PF;

  let verdict;
  if(pfRatio>=0.8)verdict='ROBUST (PF holdout ≥ 0.8× training)';
  else if(pfRatio>=0.6)verdict='TYPICAL OOS DEGRADATION (0.6-0.8×)';
  else verdict='OVERFIT CONFIRMED (PF holdout < 0.6× training)';

  console.log('\n'+'═'.repeat(80));console.log('TEST 1 — HOLDOUT RESULTS');console.log('═'.repeat(80));
  console.log(`\nTraining window (2025-07→2026-03): PF ${TRAIN_PF}, DD ${TRAIN_DD}%, WR ${TRAIN_WR}%, Sh ${TRAIN_SH}`);
  console.log(`Holdout window (2024-07→2025-06):  PF ${sComb.pf.toFixed(2)}, DD ${sComb.mddPct.toFixed(1)}%, WR ${sComb.wr.toFixed(1)}%, Sh ${sComb.sharpe.toFixed(2)}`);
  console.log(`\nPF ratio holdout/training: ${pfRatio.toFixed(2)}×`);
  console.log(`Gate: PF holdout ≥ 1.30 → ${sComb.pf>=1.30?'✓ PASS':'✗ FAIL'} (${sComb.pf.toFixed(2)})`);
  console.log(`\n🏁 VERDICT: ${verdict}`);
  const gatePass=sComb.pf>=1.30;

  const report={
    test:'01 — Holdout Sacrosanto',
    runtime_s:(Date.now()-t0)/1000,
    holdout_span_days:spanDays,
    n_pairs:npairs,
    training_metrics:{pf:TRAIN_PF,dd:TRAIN_DD,wr:TRAIN_WR,sharpe:TRAIN_SH},
    holdout_directional:sDir,
    holdout_funding:sFund,
    holdout_combined:sComb,
    holdout_tpd_combined:tpdComb,
    pf_ratio:pfRatio,
    verdict,
    gate_pass:gatePass,
  };
  fs.writeFileSync(path.join(RESULTS_DIR,'01_test_holdout.json'),JSON.stringify(report,null,2));
  console.log(`\nRuntime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`Saved: ${RESULTS_DIR}/01_test_holdout.json`);
}
main().catch(e=>{console.error(e);process.exit(1);});
