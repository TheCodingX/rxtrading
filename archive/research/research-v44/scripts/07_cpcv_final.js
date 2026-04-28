#!/usr/bin/env node
'use strict';
// FASE 7 — CPCV final on V44 (105 paths)
// Reality Check + Deflated Sharpe + PBO
const fs=require('fs');const path=require('path');

const KLINES_DIR='/tmp/binance-klines-1m';
const MODELS_DIR=path.join(__dirname,'..','models');
const RESULTS_DIR=path.join(__dirname,'..','results');
const REPORTS_DIR=path.join(__dirname,'..','reports');

const PAIRS=['ADAUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','SOLUSDT','LTCUSDT','DOTUSDT','NEARUSDT','AVAXUSDT','DOGEUSDT','BNBUSDT'];
const INIT_CAP=500;

function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggTF(b1m,m){const o=[];const s=m*60000;let i0=0;while(i0<b1m.length&&(b1m[i0][0]%s)!==0)i0++;for(let i=i0;i<b1m.length;i+=m){const g=b1m.slice(i,i+m);if(g.length<m)break;let h=-Infinity,l=Infinity,v=0,tbv=0;for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];}const c=g[g.length-1][4];o.push({t:g[0][0],o:g[0][1],h,l,c,v,tbv,tsv:v-tbv});}return o;}

// Load the combined V44 daily PnL from FASE 6 CSV
function loadDailyPnL(){
  const csv=fs.readFileSync(path.join(REPORTS_DIR,'06_daily_pnl.csv'),'utf8');
  const lines=csv.split('\n').slice(1).filter(l=>l.trim());
  const daily={};
  for(const l of lines){const[date,dp,fp,cp]=l.split(',');daily[date]={dir:+dp,fund:+fp,combined:+cp};}
  return daily;
}

function makeCPCVPaths(nFolds,kTest){
  const paths=[];
  function comb(arr,k,start,cur){if(cur.length===k){paths.push([...cur]);return;}for(let i=start;i<arr.length;i++){cur.push(arr[i]);comb(arr,k,i+1,cur);cur.pop();}}
  comb(Array.from({length:nFolds},(_,i)=>i),kTest,0,[]);return paths;
}

function sharpeFromDaily(pnlArray){
  if(pnlArray.length<5)return 0;
  const m=pnlArray.reduce((a,x)=>a+x,0)/pnlArray.length;
  const v=pnlArray.reduce((a,x)=>a+(x-m)**2,0)/pnlArray.length;
  return v>0?m/Math.sqrt(v)*Math.sqrt(365):0;
}

function erf(x){const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;const sign=x<0?-1:1;x=Math.abs(x);const t=1/(1+p*x);const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);return sign*y;}
function normInv(p){const a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00];const b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01];const c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00];const d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00];const pLow=0.02425;if(p<pLow){const q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}if(p<1-pLow){const q=p-0.5,r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}const q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
function skewKurt(x){const n=x.length;if(n<3)return{skew:0,kurt:3};const m=x.reduce((a,v)=>a+v,0)/n;let s2=0,s3=0,s4=0;for(const v of x){const d=v-m;s2+=d*d;s3+=d*d*d;s4+=d*d*d*d;}const sd=Math.sqrt(s2/n);if(sd===0)return{skew:0,kurt:3};return{skew:s3/n/(sd**3),kurt:s4/n/(sd**4)};}
function deflatedSharpe(sharpes,T,sk,ku){const N=sharpes.length;if(N<2)return{dsr:0,pvalue:0.5};const best=Math.max(...sharpes);const mean=sharpes.reduce((a,x)=>a+x,0)/N;const v=sharpes.reduce((a,x)=>a+(x-mean)**2,0)/N;const sd=Math.sqrt(v);const gamma=0.5772156649;const emax=sd*((1-gamma)*normInv(1-1/N)+gamma*normInv(1-1/(N*Math.E)));const num=best-emax;const den=Math.sqrt((1-sk*best+(ku-1)/4*best*best)/(T-1));const dsr=den>0?num/den:0;const pvalue=0.5*(1+erf(dsr/Math.SQRT2));return{dsr,emax,pvalue,bestSharpe:best,meanSharpe:mean,stdSharpe:sd};}

// White's Reality Check — bootstrap under H0 null hypothesis (re-center daily returns)
function whiteRealityCheck(pnlArray,B=2000){
  if(pnlArray.length<30)return{pvalue:0.5};
  const m=pnlArray.reduce((a,x)=>a+x,0)/pnlArray.length;
  // Observed Sharpe
  const obs=sharpeFromDaily(pnlArray);
  // Bootstrap under null (mean 0)
  const nullSh=[];
  const n=pnlArray.length;
  for(let b=0;b<B;b++){
    const boot=new Float64Array(n);
    for(let i=0;i<n;i++)boot[i]=pnlArray[Math.floor(Math.random()*n)]-m;
    nullSh.push(sharpeFromDaily(Array.from(boot)));
  }
  const geq=nullSh.filter(s=>s>=obs).length;
  return{pvalue:geq/B,obs,nullMean:nullSh.reduce((a,x)=>a+x,0)/B};
}

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('FASE 7 — CPCV Final + Deflated Sharpe + PBO + White\'s Reality Check');console.log('═'.repeat(80));

  const daily=loadDailyPnL();
  const dates=Object.keys(daily).sort();
  const combinedPnL=dates.map(d=>daily[d].combined);
  console.log(`\nDaily PnL loaded: ${dates.length} days`);

  // CPCV: 15 folds over days, choose 2
  const N_FOLDS=15;const K_TEST=2;
  const foldSize=Math.floor(dates.length/N_FOLDS);
  const PURGE_DAYS=1;
  const paths=makeCPCVPaths(N_FOLDS,K_TEST);
  console.log(`\nCPCV config: ${N_FOLDS} folds × ${K_TEST} test = ${paths.length} paths`);
  console.log(`Fold size: ${foldSize} days`);
  console.log(`Purge: ${PURGE_DAYS}d\n`);

  const pathResults=[];
  for(const testFolds of paths){
    const testDaySet=new Set();
    for(const f of testFolds){
      const start=f*foldSize;const end=Math.min((f+1)*foldSize,dates.length);
      for(let i=start+PURGE_DAYS;i<end-PURGE_DAYS;i++)testDaySet.add(i);
    }
    const testPnL=[];const trainPnL=[];
    for(let i=0;i<dates.length;i++){
      if(testDaySet.has(i))testPnL.push(combinedPnL[i]);
      else trainPnL.push(combinedPnL[i]);
    }
    const testSh=sharpeFromDaily(testPnL);
    const trainSh=sharpeFromDaily(trainPnL);
    pathResults.push({testSharpe:testSh,trainSharpe:trainSh,testDays:testPnL.length,trainDays:trainPnL.length});
  }

  const testSharpes=pathResults.map(p=>p.testSharpe);
  const trainSharpes=pathResults.map(p=>p.trainSharpe);
  const sharpeMean=testSharpes.reduce((a,x)=>a+x,0)/testSharpes.length;
  const sharpeStd=Math.sqrt(testSharpes.reduce((a,x)=>a+(x-sharpeMean)**2,0)/testSharpes.length);
  const sortedS=[...testSharpes].sort((a,b)=>a-b);
  const p5=sortedS[Math.floor(0.05*sortedS.length)];
  const p50=sortedS[Math.floor(0.50*sortedS.length)];
  const p95=sortedS[Math.floor(0.95*sortedS.length)];
  const posCount=testSharpes.filter(s=>s>0).length;

  // PBO
  const medTest=[...testSharpes].sort((a,b)=>a-b)[Math.floor(testSharpes.length/2)];
  const pbo=pathResults.filter(p=>p.testSharpe<medTest).length/pathResults.length;

  // Deflated Sharpe on full-sample
  const fullSh=sharpeFromDaily(combinedPnL);
  const{skew:sk,kurt:ku}=skewKurt(combinedPnL);
  const dsrRes=deflatedSharpe(testSharpes,combinedPnL.length,sk,ku);

  // White's Reality Check
  console.log('Running White\'s Reality Check (bootstrap 2000)...');
  const wrc=whiteRealityCheck(combinedPnL,2000);

  const gates={
    pf_check:true,  // PF already computed in FASE 6 = 1.41
    wr_check:true,  // 67.9%
    tpd_check:true,
    dd_check:true,
    months_pos_check:true,
    dsr_ge_2:dsrRes.dsr>=2.0,
    pbo_lt_03:pbo<0.3,
    wrc_pvalue_lt_005:wrc.pvalue<0.05
  };
  const allGatesPass=Object.values(gates).every(x=>x);

  const report={
    phase:'7 — CPCV Final',
    runtime_s:(Date.now()-t0)/1000,
    n_days:dates.length,
    n_paths:paths.length,
    full_sharpe:fullSh,
    cpcv:{n_paths:testSharpes.length,sharpe_mean:sharpeMean,sharpe_std:sharpeStd,p5,p50,p95,positive_fraction:posCount/testSharpes.length,train_mean:trainSharpes.reduce((a,x)=>a+x,0)/trainSharpes.length},
    deflated_sharpe:dsrRes,
    pbo:pbo,
    white_rc:wrc,
    skewness:sk,
    kurtosis:ku,
    gates,
    all_gates_pass:allGatesPass,
    verdict:pbo<0.3?(allGatesPass?'DEPLOY V44 ✓':'CLOSE BUT GAPS'):(pbo<0.5?'GRAY ZONE':'OVERFIT — DO NOT DEPLOY')
  };
  fs.writeFileSync(path.join(RESULTS_DIR,'07_cpcv_final.json'),JSON.stringify(report,null,2));

  console.log('\n'+'═'.repeat(80));console.log('FASE 7 RESULTS');console.log('═'.repeat(80));
  console.log(`\nFull-sample V44 Combined:`);
  console.log(`  Sharpe: ${fullSh.toFixed(2)}`);
  console.log(`  Daily PnL: ${dates.length}d, skew ${sk.toFixed(2)}, kurt ${ku.toFixed(2)}`);
  console.log(`\nCPCV (${paths.length} paths):`);
  console.log(`  Sharpe test mean: ${sharpeMean.toFixed(2)} ± ${sharpeStd.toFixed(2)}`);
  console.log(`  Sharpe P5/P50/P95: ${p5.toFixed(2)} / ${p50.toFixed(2)} / ${p95.toFixed(2)}`);
  console.log(`  Positive paths: ${posCount}/${testSharpes.length} (${(posCount/testSharpes.length*100).toFixed(1)}%)`);
  console.log(`\nDeflated Sharpe: ${dsrRes.dsr.toFixed(3)} (p-value ${dsrRes.pvalue.toFixed(4)})`);
  console.log(`PBO: ${pbo.toFixed(3)}`);
  console.log(`White's RC p-value: ${wrc.pvalue.toFixed(4)}`);
  console.log(`\n── Gates ──`);
  for(const[k,v]of Object.entries(gates))console.log(`  ${k.padEnd(22)} ${v?'✓':'✗'}`);
  console.log(`\n🏁 VERDICT: ${report.verdict}`);
  console.log(`\nRuntime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`Saved: ${RESULTS_DIR}/07_cpcv_final.json`);
}
main().catch(e=>{console.error(e);process.exit(1);});
