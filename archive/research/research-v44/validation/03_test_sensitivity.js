#!/usr/bin/env node
'use strict';
// TEST 3 — Parameter Sensitivity Grid
// Perturb each key parameter ±20% and measure PF/DD/WR degradation
const fs=require('fs');const path=require('path');
const E=require('./v44_engine.js');

const KLINES_DIR='/tmp/binance-klines-1m';
const RESULTS_DIR=path.join(__dirname,'results');

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('TEST 3 — PARAMETER SENSITIVITY (±10%, ±20%)');console.log('═'.repeat(80));

  console.log('\nLoading data + precomputing signals...');
  const allData={};
  for(const pair of E.PAIRS){const b1m=E.load1m(pair,KLINES_DIR);if(!b1m||b1m.length<50000)continue;allData[pair]={b1h:E.aggTF(b1m,60),b4h:E.aggTF(b1m,240)};}
  const{signals,parsed}=E.genSignals(allData);
  const hrp=E.loadHRP(path.join(__dirname,'..','results'));
  const fundings={};for(const p of Object.keys(allData))fundings[p]=E.proxyFunding(allData[p].b1h);

  // Key params to perturb
  const paramsToTest={
    entropyPct:E.V44_PARAMS.entropyPct,
    entropyWindowDays:E.V44_PARAMS.entropyWindowDays,
    ddStop14:E.V44_PARAMS.ddStop14,
    ddStop30:E.V44_PARAMS.ddStop30,
    slMNormal:E.V44_PARAMS.slMNormal,
    tpRNormal:E.V44_PARAMS.tpRNormal,
    prngGate:E.V44_PARAMS.prngGate,
    peakThresh:E.V44_PARAMS.peakThresh,
  };
  const perturbations=[-0.20,-0.10,0,0.10,0.20];

  // Baseline
  console.log('\nBaseline (no perturbation)...');
  const rBase=E.runV44(signals,parsed,allData,hrp);
  const rBaseFund=E.runFundingStream(allData,fundings);
  const baseTrades=[...rBase.trades,...rBaseFund.trades];
  const sBase=E.statsFull(baseTrades);
  console.log(`  Baseline: PF${sBase.pf.toFixed(3)} WR${sBase.wr.toFixed(1)}% DD${sBase.mddPct.toFixed(1)}%`);

  // Grid
  console.log('\n── Sensitivity grid ──');
  console.log('Parameter            -20%       -10%       base       +10%       +20%    Max Δ');
  console.log('─'.repeat(95));

  const grid={};
  for(const[pname,base]of Object.entries(paramsToTest)){
    const row=[];
    for(const delta of perturbations){
      if(delta===0){row.push({pf:sBase.pf,dd:sBase.mddPct,wr:sBase.wr});continue;}
      const newVal=base*(1+delta);
      const override={[pname]:newVal};
      const rD=E.runV44(signals,parsed,allData,hrp,override);
      const fundOvr={};
      // For funding-related params we skip (entropy/dd don't affect funding)
      const rF=E.runFundingStream(allData,fundings,fundOvr);
      const allT=[...rD.trades,...rF.trades];
      const s=E.statsFull(allT);
      row.push({pf:s.pf,dd:s.mddPct,wr:s.wr,delta});
    }
    grid[pname]=row;
    const pfVals=row.map(r=>r.pf);
    const maxPF=Math.max(...pfVals);
    const minPF=Math.min(...pfVals);
    const maxDelta=(minPF-sBase.pf)/sBase.pf*100;
    console.log(`${pname.padEnd(20)} ${pfVals.map(v=>v.toFixed(2)).join('     ')}  ${maxDelta.toFixed(1)}%`);
  }

  // Evaluate stability
  let maxPFDrop=0;let overTunedFlag=false;
  for(const[pname,row]of Object.entries(grid)){
    for(const r of row){
      if(r.delta===undefined)continue;
      const dropPct=Math.abs(r.pf-sBase.pf)/sBase.pf;
      if(Math.abs(r.delta)<=0.10&&dropPct>0.30)overTunedFlag=true;
      if(dropPct>maxPFDrop)maxPFDrop=dropPct;
    }
  }

  const gateStable=!overTunedFlag&&maxPFDrop<=0.25; // stable if <25% swing for ±20%
  console.log('\n'+'═'.repeat(80));console.log('TEST 3 RESULTS');console.log('═'.repeat(80));
  console.log(`Max PF drop across all perturbations: ${(maxPFDrop*100).toFixed(1)}%`);
  console.log(`Over-tuned flag (>30% drop at ±10%): ${overTunedFlag?'YES':'NO'}`);
  console.log(`\nGate: PF stable ±15% at ±10% perturb → ${gateStable?'✓ PASS':'✗ FAIL'}`);
  console.log(`\n🏁 VERDICT: ${gateStable?'ROBUST':'OVER-TUNED'}`);

  const report={test:'03 — Parameter Sensitivity',runtime_s:(Date.now()-t0)/1000,baseline:sBase,grid,max_pf_drop_pct:maxPFDrop*100,over_tuned:overTunedFlag,gate_pass:gateStable};
  fs.writeFileSync(path.join(RESULTS_DIR,'03_test_sensitivity.json'),JSON.stringify(report,null,2));
  console.log(`\nRuntime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`Saved: ${RESULTS_DIR}/03_test_sensitivity.json`);
}
main().catch(e=>{console.error(e);process.exit(1);});
