#!/usr/bin/env node
'use strict';
// TEST 4 — Monte Carlo Trade Order Shuffle (1000 iter → DD distribution)
const fs=require('fs');const path=require('path');
const E=require('./v44_engine.js');

const KLINES_DIR='/tmp/binance-klines-1m';
const RESULTS_DIR=path.join(__dirname,'results');

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('TEST 4 — MONTE CARLO TRADE ORDER SHUFFLE (1000 iter)');console.log('═'.repeat(80));

  const allData={};
  for(const pair of E.PAIRS){const b1m=E.load1m(pair,KLINES_DIR);if(!b1m||b1m.length<50000)continue;allData[pair]={b1h:E.aggTF(b1m,60),b4h:E.aggTF(b1m,240)};}
  const{signals,parsed}=E.genSignals(allData);
  const hrp=E.loadHRP(path.join(__dirname,'..','results'));
  const fundings={};for(const p of Object.keys(allData))fundings[p]=E.proxyFunding(allData[p].b1h);
  const rDir=E.runV44(signals,parsed,allData,hrp);
  const rFund=E.runFundingStream(allData,fundings);
  const allTrades=[...rDir.trades,...rFund.trades].sort((a,b)=>a.ts-b.ts);
  const pnls=allTrades.map(t=>t.pnl);

  function maxDDFromSeq(seq){let cum=0,pk=0,mdd=0;for(const x of seq){cum+=x;if(cum>pk)pk=cum;if(pk-cum>mdd)mdd=pk-cum;}return mdd;}

  const realDD=maxDDFromSeq(pnls);
  console.log(`\nRealized max DD: $${realDD.toFixed(0)}`);
  console.log(`Trades: ${pnls.length}`);

  const ITER=1000;
  console.log(`\nShuffling ${ITER} times...`);
  const mcDDs=[];
  for(let i=0;i<ITER;i++){
    const shuffled=[...pnls];
    for(let j=shuffled.length-1;j>0;j--){const k=Math.floor(Math.random()*(j+1));[shuffled[j],shuffled[k]]=[shuffled[k],shuffled[j]];}
    mcDDs.push(maxDDFromSeq(shuffled));
  }
  mcDDs.sort((a,b)=>a-b);
  const p5=mcDDs[Math.floor(0.05*ITER)];
  const p20=mcDDs[Math.floor(0.20*ITER)];
  const p50=mcDDs[Math.floor(0.50*ITER)];
  const p80=mcDDs[Math.floor(0.80*ITER)];
  const p95=mcDDs[Math.floor(0.95*ITER)];

  const realPercentile=mcDDs.findIndex(d=>d>=realDD)/ITER*100;
  const inP20_P80=realPercentile>=20&&realPercentile<=80;

  console.log('\n'+'═'.repeat(80));console.log('TEST 4 RESULTS');console.log('═'.repeat(80));
  console.log(`\nMonte Carlo DD distribution:`);
  console.log(`  P5:  $${p5.toFixed(0)}`);
  console.log(`  P20: $${p20.toFixed(0)}`);
  console.log(`  P50: $${p50.toFixed(0)}`);
  console.log(`  P80: $${p80.toFixed(0)}`);
  console.log(`  P95: $${p95.toFixed(0)}`);
  console.log(`\nRealized DD: $${realDD.toFixed(0)} → percentile ${realPercentile.toFixed(1)}%`);
  console.log(`\nGate: DD in P20-P80 → ${inP20_P80?'✓ PASS':'✗ FAIL'}`);
  const worstCase=realPercentile<5?'LUCKY — true DD could be much worse':realPercentile>95?'UNLUCKY — true DD could be better':'typical';
  console.log(`\n🏁 VERDICT: ${inP20_P80?'CONSISTENT':worstCase}`);

  const report={test:'04 — MC Trade Shuffle',runtime_s:(Date.now()-t0)/1000,n_trades:pnls.length,iterations:ITER,real_dd:realDD,dd_p5:p5,dd_p20:p20,dd_p50:p50,dd_p80:p80,dd_p95:p95,real_percentile:realPercentile,gate_pass:inP20_P80};
  fs.writeFileSync(path.join(RESULTS_DIR,'04_test_mc_shuffle.json'),JSON.stringify(report,null,2));
  console.log(`\nRuntime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e=>{console.error(e);process.exit(1);});
