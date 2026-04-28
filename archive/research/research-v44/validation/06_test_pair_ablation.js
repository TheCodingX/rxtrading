#!/usr/bin/env node
'use strict';
// TEST 6 — Pair-level ablation
const fs=require('fs');const path=require('path');
const E=require('./v44_engine.js');
const KLINES_DIR='/tmp/binance-klines-1m';
const RESULTS_DIR=path.join(__dirname,'results');

async function runWithPairs(pairs){
  const allData={};for(const pair of pairs){const b1m=E.load1m(pair,KLINES_DIR);if(!b1m||b1m.length<50000)continue;allData[pair]={b1h:E.aggTF(b1m,60),b4h:E.aggTF(b1m,240)};}
  const{signals,parsed}=E.genSignals(allData);
  const hrp=E.loadHRP(path.join(__dirname,'..','results'));
  const fundings={};for(const p of Object.keys(allData))fundings[p]=E.proxyFunding(allData[p].b1h);
  const rDir=E.runV44(signals,parsed,allData,hrp);
  const rFund=E.runFundingStream(allData,fundings);
  const combined=[...rDir.trades,...rFund.trades];
  return E.statsFull(combined);
}

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('TEST 6 — PAIR-LEVEL ABLATION');console.log('═'.repeat(80));

  // Baseline
  console.log('\nBaseline (all 15 pairs)...');
  const sBase=await runWithPairs(E.PAIRS);
  console.log(`  Baseline: PF${sBase.pf.toFixed(2)} DD${sBase.mddPct.toFixed(1)}% PnL$${sBase.pnl.toFixed(0)}`);

  console.log('\nRemoving each pair one-at-a-time:');
  console.log('Pair removed        Trades    PF       Δ PF%      DD       Δ DD pp');
  console.log('─'.repeat(80));
  const ablation={};
  let maxDropPct=0;let maxDropPair=null;
  for(const remove of E.PAIRS){
    const pairs=E.PAIRS.filter(p=>p!==remove);
    const s=await runWithPairs(pairs);
    const dPF=(s.pf-sBase.pf)/sBase.pf*100;
    const dDD=s.mddPct-sBase.mddPct;
    ablation[remove]={...s,delta_pf_pct:dPF,delta_dd_pp:dDD};
    console.log(`${remove.padEnd(18)} ${String(s.n).padStart(6)}  ${s.pf.toFixed(2).padStart(5)}  ${dPF>=0?'+':''}${dPF.toFixed(1).padStart(5)}%  ${s.mddPct.toFixed(1).padStart(5)}%  ${dDD>=0?'+':''}${dDD.toFixed(1)}pp`);
    if(Math.abs(dPF)>maxDropPct){maxDropPct=Math.abs(dPF);maxDropPair=remove;}
  }

  const gate=maxDropPct<=15;
  console.log('\n'+'═'.repeat(80));console.log('TEST 6 RESULTS');console.log('═'.repeat(80));
  console.log(`Biggest PF swing when removing ONE pair: ${maxDropPct.toFixed(1)}% (${maxDropPair})`);
  console.log(`\nGate: remove any pair → PF change ≤15% → ${gate?'✓ PASS':'✗ FAIL'}`);
  console.log(`\n🏁 VERDICT: ${gate?'ROBUST':'OUTLIER-DEPENDENT'}`);

  const report={test:'06 — Pair Ablation',runtime_s:(Date.now()-t0)/1000,baseline:sBase,ablation,max_drop_pct:maxDropPct,max_drop_pair:maxDropPair,gate_pass:gate};
  fs.writeFileSync(path.join(RESULTS_DIR,'06_test_pair_ablation.json'),JSON.stringify(report,null,2));
  console.log(`Runtime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e=>{console.error(e);process.exit(1);});
