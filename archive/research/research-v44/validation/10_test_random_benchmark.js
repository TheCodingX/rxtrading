#!/usr/bin/env node
'use strict';
// TEST 10 — Random Entry Benchmark (1000 simulations)
// Replace V44 entries with random entries, same exit logic
// Compare V44 PF vs distribution of random PFs
const fs=require('fs');const path=require('path');
const E=require('./v44_engine.js');
const KLINES_DIR='/tmp/binance-klines-1m';
const RESULTS_DIR=path.join(__dirname,'results');

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('TEST 10 — V44 vs RANDOM BENCHMARK (1000 sim)');console.log('═'.repeat(80));

  const allData={};
  for(const pair of E.PAIRS){const b1m=E.load1m(pair,KLINES_DIR);if(!b1m||b1m.length<50000)continue;allData[pair]={b1h:E.aggTF(b1m,60),b4h:E.aggTF(b1m,240)};}
  const{signals:v44Signals,parsed}=E.genSignals(allData);
  const hrp=E.loadHRP(path.join(__dirname,'..','results'));
  const fundings={};for(const p of Object.keys(allData))fundings[p]=E.proxyFunding(allData[p].b1h);
  const rDir=E.runV44(v44Signals,parsed,allData,hrp);
  const rFund=E.runFundingStream(allData,fundings);
  const v44Trades=[...rDir.trades,...rFund.trades];
  const v44Stats=E.statsFull(v44Trades);
  console.log(`\nV44 real: ${v44Stats.n} trades, PF ${v44Stats.pf.toFixed(2)}, Sharpe ${v44Stats.sharpe.toFixed(2)}`);

  // Random entries: take same number of signals but random direction + random timestamp
  const nTotalSignals=v44Signals.length;
  const NSIM=1000;
  console.log(`\nRunning ${NSIM} random-entry simulations...`);

  function makeRandomSignals(baseData,baseSignals){
    // Sample random times from the test window, random direction, random pair
    const out=[];
    const allTs=[];for(const p of Object.keys(baseData)){for(const b of baseData[p].b1h)allTs.push(b.t);}
    const pairs=Object.keys(baseData);
    for(let i=0;i<baseSignals.length;i++){
      const pair=pairs[Math.floor(Math.random()*pairs.length)];
      const pd=parsed[pair];if(!pd||pd.c.length<100)continue;
      const idx=50+Math.floor(Math.random()*(pd.c.length-60-50));
      out.push({pair,ts:pd.t[idx],dir:Math.random()<0.5?1:-1,absIdx:idx,atr:pd.atr[idx],confRatio:1+Math.random()*0.5,hr:new Date(pd.t[idx]).getUTCHours()});
    }
    out.sort((a,b)=>a.ts-b.ts);
    return out;
  }

  const randomPFs=[];
  for(let s=0;s<NSIM;s++){
    const randSigs=makeRandomSignals(allData,v44Signals);
    const rRand=E.runV44(randSigs,parsed,allData,hrp);
    // Keep funding stream same (it's independent of signals)
    const randTrades=[...rRand.trades,...rFund.trades];
    const sRand=E.statsFull(randTrades);
    randomPFs.push(sRand.pf);
    if((s+1)%100===0)process.stdout.write(`[${s+1}/${NSIM}] `);
  }
  console.log();
  randomPFs.sort((a,b)=>a-b);

  const randMean=randomPFs.reduce((a,x)=>a+x,0)/randomPFs.length;
  const randP50=randomPFs[Math.floor(NSIM*0.50)];
  const randP95=randomPFs[Math.floor(NSIM*0.95)];
  const randP99=randomPFs[Math.floor(NSIM*0.99)];

  // V44 percentile in random distribution
  const v44Pct=randomPFs.findIndex(p=>p>=v44Stats.pf)/NSIM*100;

  console.log('\n'+'═'.repeat(80));console.log('TEST 10 RESULTS');console.log('═'.repeat(80));
  console.log(`\nRandom PF distribution:`);
  console.log(`  Mean: ${randMean.toFixed(2)}`);
  console.log(`  P50:  ${randP50.toFixed(2)}`);
  console.log(`  P95:  ${randP95.toFixed(2)}`);
  console.log(`  P99:  ${randP99.toFixed(2)}`);
  console.log(`\nV44 PF: ${v44Stats.pf.toFixed(2)} → percentile ${v44Pct.toFixed(1)}%`);
  const gate=v44Pct>=99;
  console.log(`\nGate: V44 ≥ P99 → ${gate?'✓ PASS':'✗ FAIL'}`);
  console.log(`\n🏁 VERDICT: ${gate?'REAL EDGE vs random':'NO SIGNIFICANT EDGE vs random'}`);

  const report={test:'10 — Random Benchmark',runtime_s:(Date.now()-t0)/1000,n_sim:NSIM,v44_pf:v44Stats.pf,v44_percentile:v44Pct,random_mean:randMean,random_p50:randP50,random_p95:randP95,random_p99:randP99,gate_pass:gate};
  fs.writeFileSync(path.join(RESULTS_DIR,'10_test_random_benchmark.json'),JSON.stringify(report,null,2));
  console.log(`Runtime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e=>{console.error(e);process.exit(1);});
