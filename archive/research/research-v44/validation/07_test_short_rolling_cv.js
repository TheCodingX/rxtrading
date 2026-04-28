#!/usr/bin/env node
'use strict';
// TEST 7 — Short Rolling Walk-forward (60/20 + 30/10)
const fs=require('fs');const path=require('path');
const E=require('./v44_engine.js');
const KLINES_DIR='/tmp/binance-klines-1m';
const RESULTS_DIR=path.join(__dirname,'results');

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('TEST 7 — SHORT ROLLING CV (60/20 + 30/10)');console.log('═'.repeat(80));

  const allData={};
  for(const pair of E.PAIRS){const b1m=E.load1m(pair,KLINES_DIR);if(!b1m||b1m.length<50000)continue;allData[pair]={b1h:E.aggTF(b1m,60),b4h:E.aggTF(b1m,240)};}
  const hrp=E.loadHRP(path.join(__dirname,'..','results'));
  const fundings={};for(const p of Object.keys(allData))fundings[p]=E.proxyFunding(allData[p].b1h);

  // Walk-forward with shorter windows
  async function runScheme(train,test,step,spanDays=273){
    console.log(`\nWalk-forward TRAIN=${train}d TEST=${test}d STEP=${step}d...`);
    const{signals,parsed}=E.genSignals(allData,{train,test,step,spanDays});
    console.log(`  ${signals.length} signals across windows`);
    const rDir=E.runV44(signals,parsed,allData,hrp);
    const rFund=E.runFundingStream(allData,fundings);
    const combined=[...rDir.trades,...rFund.trades];
    // Segment by test window
    const firstTs=Math.min(...Object.values(allData).map(d=>d.b1h[0].t));
    const nW=Math.max(1,Math.floor((spanDays-train-test)/step)+1);
    const windowPFs=[];
    for(let w=0;w<nW;w++){
      const tes=firstTs+(w*step+train)*864e5;
      const tee=tes+test*864e5;
      const windowTrades=combined.filter(t=>t.ts>=tes&&t.ts<tee);
      if(windowTrades.length<5)continue;
      const s=E.statsFull(windowTrades);
      windowPFs.push(s.pf);
    }
    return{windowPFs,combined};
  }

  const scheme1=await runScheme(60,20,10);
  const scheme2=await runScheme(30,10,5);

  function summary(windowPFs){const valid=windowPFs.filter(x=>x>0);const sorted=[...valid].sort((a,b)=>a-b);const min=sorted[0]||0;const p25=sorted[Math.floor(valid.length*0.25)]||0;const median=sorted[Math.floor(valid.length*0.50)]||0;const p75=sorted[Math.floor(valid.length*0.75)]||0;const max=sorted[sorted.length-1]||0;const mean=valid.reduce((a,x)=>a+x,0)/valid.length;return{n_windows:valid.length,min,p25,median,p75,max,mean};}

  const s1=summary(scheme1.windowPFs);
  const s2=summary(scheme2.windowPFs);

  console.log('\n── Summary ──');
  console.log('Scheme                     windows    min     P25    median    P75     max');
  console.log(`TRAIN=60d TEST=20d            ${s1.n_windows}   ${s1.min.toFixed(2)}   ${s1.p25.toFixed(2)}    ${s1.median.toFixed(2)}      ${s1.p75.toFixed(2)}   ${s1.max.toFixed(2)}`);
  console.log(`TRAIN=30d TEST=10d            ${s2.n_windows}   ${s2.min.toFixed(2)}   ${s2.p25.toFixed(2)}    ${s2.median.toFixed(2)}      ${s2.p75.toFixed(2)}   ${s2.max.toFixed(2)}`);

  const gate1=s1.median>=1.4&&s1.min>=1.1;
  const gate2=s2.median>=1.4&&s2.min>=1.1;
  const pass=gate1||gate2;

  console.log('\n'+'═'.repeat(80));console.log('TEST 7 RESULTS');console.log('═'.repeat(80));
  console.log(`\nGates (median ≥1.4 AND min ≥1.1):`);
  console.log(`  Scheme 60/20: ${gate1?'✓':'✗'} (median ${s1.median.toFixed(2)}, min ${s1.min.toFixed(2)})`);
  console.log(`  Scheme 30/10: ${gate2?'✓':'✗'} (median ${s2.median.toFixed(2)}, min ${s2.min.toFixed(2)})`);
  console.log(`\n🏁 VERDICT: ${pass?'ROBUST ACROSS SHORT WINDOWS':'UNSTABLE ON SHORT WINDOWS'}`);

  const report={test:'07 — Short Rolling CV',runtime_s:(Date.now()-t0)/1000,scheme_60_20:s1,scheme_30_10:s2,gate_60_20:gate1,gate_30_10:gate2,gate_pass:pass};
  fs.writeFileSync(path.join(RESULTS_DIR,'07_test_short_rolling_cv.json'),JSON.stringify(report,null,2));
  console.log(`Runtime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e=>{console.error(e);process.exit(1);});
