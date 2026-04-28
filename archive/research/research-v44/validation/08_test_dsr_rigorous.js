#!/usr/bin/env node
'use strict';
// TEST 8 — Deflated Sharpe Rigorous (account for multiple trials)
// During V44 research: 4 ablation configs × 3 tuning rounds × 8 parameters × 5 perturbations ≈ 100+ trials
const fs=require('fs');const path=require('path');
const E=require('./v44_engine.js');
const KLINES_DIR='/tmp/binance-klines-1m';
const RESULTS_DIR=path.join(__dirname,'results');

function erf(x){const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;const sign=x<0?-1:1;x=Math.abs(x);const t=1/(1+p*x);const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);return sign*y;}
function normInv(p){const a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00];const b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01];const c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00];const d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00];const pLow=0.02425;if(p<pLow){const q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}if(p<1-pLow){const q=p-0.5,r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}const q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('TEST 8 — DEFLATED SHARPE RIGOROUS');console.log('═'.repeat(80));

  const allData={};
  for(const pair of E.PAIRS){const b1m=E.load1m(pair,KLINES_DIR);if(!b1m||b1m.length<50000)continue;allData[pair]={b1h:E.aggTF(b1m,60),b4h:E.aggTF(b1m,240)};}
  const{signals,parsed}=E.genSignals(allData);
  const hrp=E.loadHRP(path.join(__dirname,'..','results'));
  const fundings={};for(const p of Object.keys(allData))fundings[p]=E.proxyFunding(allData[p].b1h);
  const rDir=E.runV44(signals,parsed,allData,hrp);
  const rFund=E.runFundingStream(allData,fundings);
  const combined=[...rDir.trades,...rFund.trades];
  const s=E.statsFull(combined);
  const dailyPnL=Object.values(s.dailyPnL);
  const T=dailyPnL.length;

  console.log(`\nFull sample: ${T} days, ${s.n} trades, PF ${s.pf.toFixed(2)}, Sharpe ${s.sharpe.toFixed(2)}`);

  // Skewness and kurtosis of daily returns
  const m=dailyPnL.reduce((a,x)=>a+x,0)/T;
  let s2=0,s3=0,s4=0;for(const v of dailyPnL){const d=v-m;s2+=d*d;s3+=d*d*d;s4+=d*d*d*d;}
  const sd=Math.sqrt(s2/T);const sk=s3/T/(sd**3);const ku=s4/T/(sd**4);
  console.log(`Skew: ${sk.toFixed(2)}, Kurt: ${ku.toFixed(2)}`);

  // N_trials scenarios: conservative (10), realistic (100), paranoid (500)
  const scenarios=[
    {name:'Low (10 trials)',N:10},
    {name:'Realistic (100)',N:100},
    {name:'Paranoid (500)',N:500},
  ];

  function dsr(N,sharpe){
    const gamma=0.5772156649;
    const emax=((1-gamma)*normInv(1-1/N)+gamma*normInv(1-1/(N*Math.E)));
    const num=sharpe-emax;
    const den=Math.sqrt((1-sk*sharpe+(ku-1)/4*sharpe*sharpe)/(T-1));
    const stat=den>0?num/den:0;
    const p=0.5*(1+erf(stat/Math.SQRT2));
    return{emax,dsr:stat,pvalue:p};
  }

  console.log('\nDSR by N_trials assumption:');
  console.log('Scenario                E[max Sh]    DSR      p-value');
  console.log('─'.repeat(70));
  const results={};
  for(const sc of scenarios){
    const r=dsr(sc.N,s.sharpe);
    results[sc.name]=r;
    console.log(`${sc.name.padEnd(24)} ${r.emax.toFixed(3).padStart(6)}    ${r.dsr.toFixed(3).padStart(5)}   ${r.pvalue.toFixed(4)}`);
  }

  // Gate: DSR > 1.0 under realistic (100 trials)
  const realDSR=results['Realistic (100)'].dsr;
  const gate=realDSR>1.0;
  console.log('\n'+'═'.repeat(80));console.log('TEST 8 RESULTS');console.log('═'.repeat(80));
  console.log(`DSR @ 100 trials: ${realDSR.toFixed(3)}`);
  console.log(`Gate: DSR > 1.0 → ${gate?'✓ PASS':'✗ FAIL'}`);
  console.log(`\n🏁 VERDICT: ${gate?'STATISTICALLY SIGNIFICANT':'NOT SIGNIFICANT vs multiple trials'}`);

  const report={test:'08 — DSR Rigorous',runtime_s:(Date.now()-t0)/1000,full_sharpe:s.sharpe,T,skew:sk,kurt:ku,scenarios:results,gate_pass:gate};
  fs.writeFileSync(path.join(RESULTS_DIR,'08_test_dsr_rigorous.json'),JSON.stringify(report,null,2));
  console.log(`Runtime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e=>{console.error(e);process.exit(1);});
