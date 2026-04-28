#!/usr/bin/env node
'use strict';
// TEST 2 — Bootstrap Resampling 2000 iterations of V44 trades
const fs=require('fs');const path=require('path');
const E=require('./v44_engine.js');

const KLINES_DIR='/tmp/binance-klines-1m';
const RESULTS_DIR=path.join(__dirname,'results');

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('TEST 2 — BOOTSTRAP RESAMPLING (2000 iter)');console.log('═'.repeat(80));

  // Load training data and generate V44 trades
  console.log('\nLoading training data...');
  const allData={};
  for(const pair of E.PAIRS){
    const b1m=E.load1m(pair,KLINES_DIR);if(!b1m||b1m.length<50000)continue;
    allData[pair]={b1h:E.aggTF(b1m,60),b4h:E.aggTF(b1m,240)};
  }
  console.log(`  ${Object.keys(allData).length} pairs`);

  const{signals,parsed}=E.genSignals(allData);
  const hrp=E.loadHRP(path.join(__dirname,'..','results'));
  const fundings={};for(const p of Object.keys(allData))fundings[p]=E.proxyFunding(allData[p].b1h);
  const rDir=E.runV44(signals,parsed,allData,hrp);
  const rFund=E.runFundingStream(allData,fundings);
  const allTrades=[...rDir.trades,...rFund.trades];
  console.log(`  ${allTrades.length} total trades`);

  // Compute PF from a list of PnLs
  function computePF(pnls){const w=pnls.filter(x=>x>0);const l=pnls.filter(x=>x<=0);const gw=w.reduce((s,x)=>s+x,0);const gl=Math.abs(l.reduce((s,x)=>s+x,0));return gl>0?gw/gl:gw>0?99:0;}

  const N=allTrades.length;
  const ITER=2000;
  console.log(`\nBootstrapping ${ITER} iterations with N=${N}...`);
  const pnls=allTrades.map(t=>t.pnl);
  const pfSamples=[];
  for(let i=0;i<ITER;i++){
    const sample=new Array(N);
    for(let j=0;j<N;j++)sample[j]=pnls[Math.floor(Math.random()*N)];
    pfSamples.push(computePF(sample));
  }
  pfSamples.sort((a,b)=>a-b);

  const pfMean=pfSamples.reduce((a,x)=>a+x,0)/ITER;
  const pfMedian=pfSamples[Math.floor(ITER*0.50)];
  const pf025=pfSamples[Math.floor(ITER*0.025)];
  const pf975=pfSamples[Math.floor(ITER*0.975)];
  const fracLt1=pfSamples.filter(x=>x<1.0).length/ITER;
  const fracLt13=pfSamples.filter(x=>x<1.3).length/ITER;

  const realPF=computePF(pnls);

  console.log('\n'+'═'.repeat(80));console.log('TEST 2 RESULTS');console.log('═'.repeat(80));
  console.log(`\nBootstrap distribution:`);
  console.log(`  Median PF: ${pfMedian.toFixed(3)}`);
  console.log(`  Mean PF:   ${pfMean.toFixed(3)}`);
  console.log(`  95% CI:    [${pf025.toFixed(3)}, ${pf975.toFixed(3)}]`);
  console.log(`  Fraction PF<1.0: ${(fracLt1*100).toFixed(2)}%`);
  console.log(`  Fraction PF<1.3: ${(fracLt13*100).toFixed(2)}%`);
  console.log(`\nRealized PF: ${realPF.toFixed(3)}`);

  const gate1=pfMedian>=1.5;
  const gate2=fracLt1<0.05;
  const gate3=fracLt13<0.20;
  const pass=gate1&&gate2&&gate3;
  console.log(`\nGates:`);
  console.log(`  Median PF ≥ 1.5:       ${gate1?'✓':'✗'} (${pfMedian.toFixed(3)})`);
  console.log(`  Frac(PF<1.0) < 5%:     ${gate2?'✓':'✗'} (${(fracLt1*100).toFixed(2)}%)`);
  console.log(`  Frac(PF<1.3) < 20%:    ${gate3?'✓':'✗'} (${(fracLt13*100).toFixed(2)}%)`);
  console.log(`\n🏁 VERDICT: ${pass?'ROBUST':'OVERFIT / FRAGILE'}`);

  const report={test:'02 — Bootstrap',runtime_s:(Date.now()-t0)/1000,n_trades:N,iterations:ITER,pf_real:realPF,pf_mean:pfMean,pf_median:pfMedian,pf_ci95:[pf025,pf975],frac_lt_1:fracLt1,frac_lt_13:fracLt13,gate_median_pass:gate1,gate_frac1_pass:gate2,gate_frac13_pass:gate3,gate_pass:pass};
  fs.writeFileSync(path.join(RESULTS_DIR,'02_test_bootstrap.json'),JSON.stringify(report,null,2));
  console.log(`\nSaved: ${RESULTS_DIR}/02_test_bootstrap.json`);
}
main().catch(e=>{console.error(e);process.exit(1);});
