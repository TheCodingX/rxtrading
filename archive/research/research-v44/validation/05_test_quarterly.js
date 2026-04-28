#!/usr/bin/env node
'use strict';
// TEST 5 — Quarterly Segmentation
const fs=require('fs');const path=require('path');
const E=require('./v44_engine.js');

const KLINES_DIR='/tmp/binance-klines-1m';
const RESULTS_DIR=path.join(__dirname,'results');

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('TEST 5 — QUARTERLY SEGMENTATION');console.log('═'.repeat(80));
  const allData={};
  for(const pair of E.PAIRS){const b1m=E.load1m(pair,KLINES_DIR);if(!b1m||b1m.length<50000)continue;allData[pair]={b1h:E.aggTF(b1m,60),b4h:E.aggTF(b1m,240)};}
  const{signals,parsed}=E.genSignals(allData);
  const hrp=E.loadHRP(path.join(__dirname,'..','results'));
  const fundings={};for(const p of Object.keys(allData))fundings[p]=E.proxyFunding(allData[p].b1h);
  const rDir=E.runV44(signals,parsed,allData,hrp);
  const rFund=E.runFundingStream(allData,fundings);
  const allTrades=[...rDir.trades,...rFund.trades].sort((a,b)=>a.ts-b.ts);

  // Segment by quarter
  const byQuarter={};
  for(const t of allTrades){
    const date=new Date(t.ts);const y=date.getUTCFullYear();const q=Math.floor(date.getUTCMonth()/3)+1;
    const key=`${y}-Q${q}`;
    if(!byQuarter[key])byQuarter[key]=[];
    byQuarter[key].push(t);
  }

  console.log('\nQuarter        Trades    PF      WR      DD      PnL');
  console.log('─'.repeat(70));
  const qStats={};
  for(const[q,tr]of Object.entries(byQuarter).sort()){
    const s=E.statsFull(tr);
    qStats[q]=s;
    console.log(`${q}   ${String(s.n).padStart(6)}  ${s.pf.toFixed(2).padStart(5)}  ${s.wr.toFixed(1).padStart(5)}%  ${s.mddPct.toFixed(1).padStart(5)}%  $${s.pnl.toFixed(0).padStart(6)}`);
  }

  const pfVals=Object.values(qStats).map(s=>s.pf).filter(x=>x>0);
  const minPF=Math.min(...pfVals),maxPF=Math.max(...pfVals);
  const varPct=(maxPF-minPF)/minPF*100;

  console.log('\n'+'═'.repeat(80));console.log('TEST 5 RESULTS');console.log('═'.repeat(80));
  console.log(`PF range: ${minPF.toFixed(2)} - ${maxPF.toFixed(2)} (variation ${varPct.toFixed(0)}%)`);
  const gate1=minPF>=1.2;
  const gate2=varPct<=40;
  console.log(`\nGates:`);
  console.log(`  Worst quarter PF ≥ 1.2: ${gate1?'✓':'✗'} (${minPF.toFixed(2)})`);
  console.log(`  Variation ≤ 40%:         ${gate2?'✓':'✗'} (${varPct.toFixed(0)}%)`);
  const pass=gate1&&gate2;
  console.log(`\n🏁 VERDICT: ${pass?'CONSISTENT':'REGIME-DEPENDENT'}`);

  const report={test:'05 — Quarterly',runtime_s:(Date.now()-t0)/1000,quarters:qStats,min_pf:minPF,max_pf:maxPF,variation_pct:varPct,gate_pass:pass};
  fs.writeFileSync(path.join(RESULTS_DIR,'05_test_quarterly.json'),JSON.stringify(report,null,2));
  console.log(`\nRuntime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e=>{console.error(e);process.exit(1);});
