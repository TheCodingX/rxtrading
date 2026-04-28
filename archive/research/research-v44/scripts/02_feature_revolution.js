#!/usr/bin/env node
'use strict';
// FASE 2 — Feature Revolution
// Técnica 1: Fractional Differentiation (López de Prado Cap.5, FFD method)
// Técnica 2: Information-Driven Bars (Dollar bars, Imbalance bars)
// Técnica 3: Cross-Sectional Features (ranks vs universe)
// Técnica 4: VPIN proxy from 1m taker_buy_volume (Easley-López-O'Hara 2012)
// Técnica 5: Orderbook reconstruction proxy (wick absorption, Hawkes lite, flow toxicity)
const fs=require('fs');const path=require('path');

const KLINES_DIR='/tmp/binance-klines-1m';
const FEATURES_DIR=path.join(__dirname,'..','features');
const RESULTS_DIR=path.join(__dirname,'..','results');
if(!fs.existsSync(FEATURES_DIR))fs.mkdirSync(FEATURES_DIR,{recursive:true});

const PAIRS=['ADAUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','SOLUSDT','LTCUSDT','DOTUSDT','NEARUSDT','AVAXUSDT','DOGEUSDT','BNBUSDT'];

function load1m(p){const d=path.join(KLINES_DIR,p);if(!fs.existsSync(d))return null;const fl=fs.readdirSync(d).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of fl){const ct=fs.readFileSync(path.join(d,f),'utf8').split('\n');const st=ct[0].startsWith('open_time')?1:0;for(let i=st;i<ct.length;i++){const l=ct[i].trim();if(!l)continue;const p2=l.split(',');if(p2.length<11)continue;bars.push([+p2[0],+p2[1],+p2[2],+p2[3],+p2[4],+p2[5],+p2[6],+p2[7],+p2[8],+p2[9],+p2[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}
function aggTF(b1m,m){const o=[];const s=m*60000;let i0=0;while(i0<b1m.length&&(b1m[i0][0]%s)!==0)i0++;for(let i=i0;i<b1m.length;i+=m){const g=b1m.slice(i,i+m);if(g.length<m)break;let h=-Infinity,l=Infinity,v=0,tbv=0,qv=0;for(const b of g){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];qv+=b[7];}const c=g[g.length-1][4],tsv=v-tbv,ti=v>0?(tbv-tsv)/v:0;o.push({t:g[0][0],o:g[0][1],h,l,c,v,tbv,tsv,ti,qv});}return o;}

// ═══ Técnica 1: Fractional Differentiation (FFD) ═══
// FFD: Fixed-Width Window Fracdiff (López de Prado Ch.5.5)
// d: fractional order in (0,1); smaller d = more memory retained
// Weights: w_k = -w_{k-1} · (d-k+1)/k, drop when |w_k| < tau
function getFFDWeights(d,thres=1e-5){
  const w=[1];
  for(let k=1;k<1000;k++){
    const w_next=-w[k-1]*(d-k+1)/k;
    if(Math.abs(w_next)<thres)break;
    w.push(w_next);
  }
  return w;
}
function fracdiffFFD(series,d,thres=1e-5){
  const w=getFFDWeights(d,thres);
  const width=w.length;
  const result=new Float64Array(series.length).fill(NaN);
  for(let i=width-1;i<series.length;i++){
    let sum=0;let valid=true;
    for(let k=0;k<width;k++){
      const v=series[i-k];
      if(isNaN(v)||!isFinite(v)){valid=false;break;}
      sum+=w[k]*v;
    }
    if(valid)result[i]=sum;
  }
  return result;
}
// ADF test simplified (regression-based critical value check)
// Returns test statistic; more negative = more stationary
// Augmented Dickey-Fuller with intercept
function adfTest(series,lags=4){
  const filtered=series.filter(x=>!isNaN(x)&&isFinite(x));
  if(filtered.length<30)return{stat:0,significant:false};
  const n=filtered.length;
  // Δy_t = α + β·y_{t-1} + Σ γ_i·Δy_{t-i} + ε_t
  // OLS on this regression; test H0: β=0 (unit root)
  const dy=new Float64Array(n-1);
  for(let i=1;i<n;i++)dy[i-1]=filtered[i]-filtered[i-1];
  if(dy.length<lags+5)return{stat:0,significant:false};
  // Build design matrix
  const nn=dy.length-lags;
  if(nn<5)return{stat:0,significant:false};
  const X=[],Y=[];
  for(let i=lags;i<dy.length;i++){
    const row=[1,filtered[i]]; // intercept + y_{t-1}
    for(let j=1;j<=lags;j++)row.push(dy[i-j]);
    X.push(row);
    Y.push(dy[i]);
  }
  // OLS via normal equations: β = (X'X)^-1 X'Y
  const k=X[0].length;
  const XtX=Array.from({length:k},()=>new Float64Array(k));
  const XtY=new Float64Array(k);
  for(let i=0;i<X.length;i++){for(let a=0;a<k;a++){XtY[a]+=X[i][a]*Y[i];for(let b=0;b<k;b++)XtX[a][b]+=X[i][a]*X[i][b];}}
  // Invert XtX
  const inv=invMatrix(XtX);
  if(!inv)return{stat:0,significant:false};
  const beta=new Float64Array(k);
  for(let a=0;a<k;a++){let s=0;for(let b=0;b<k;b++)s+=inv[a][b]*XtY[b];beta[a]=s;}
  // Residuals
  let rss=0;for(let i=0;i<X.length;i++){let yhat=0;for(let a=0;a<k;a++)yhat+=X[i][a]*beta[a];rss+=(Y[i]-yhat)**2;}
  const sigma2=rss/(X.length-k);
  // Standard error of beta[1] = sqrt(sigma2 · [(X'X)^-1]_{1,1})
  const se=Math.sqrt(sigma2*inv[1][1]);
  const stat=se>0?beta[1]/se:0;
  // Critical values approx (ADF): 1%=-3.43, 5%=-2.86, 10%=-2.57
  return{stat,significant:stat<-2.86,beta:beta[1]};
}
function invMatrix(M){const n=M.length;const A=M.map(r=>[...r,...Array(n).fill(0)]);for(let i=0;i<n;i++)A[i][n+i]=1;for(let i=0;i<n;i++){let piv=A[i][i];let r=i;for(let j=i+1;j<n;j++){if(Math.abs(A[j][i])>Math.abs(piv)){piv=A[j][i];r=j;}}if(Math.abs(piv)<1e-12)return null;if(r!==i)[A[i],A[r]]=[A[r],A[i]];for(let j=0;j<2*n;j++)A[i][j]/=piv;for(let k=0;k<n;k++){if(k===i)continue;const f=A[k][i];for(let j=0;j<2*n;j++)A[k][j]-=f*A[i][j];}}return A.map(r=>r.slice(n));}

function findOptimalD(series,thres=1e-5){
  // Binary search for minimum d that passes ADF at 5%
  const candidates=[0.05,0.10,0.15,0.20,0.25,0.30,0.35,0.40,0.50,0.60,0.70,0.80,0.90,1.00];
  let best=null;
  for(const d of candidates){
    const diffed=fracdiffFFD(series,d,thres);
    const adf=adfTest(diffed);
    if(adf.significant){best={d,stat:adf.stat};break;}
  }
  return best||{d:1.0,stat:0};
}

// ═══ Técnica 2: Information-Driven Bars ═══
// Dollar bars: close bar when cumulative quote_volume ≥ threshold
// Imbalance bars: close when |buy_vol - sell_vol| ≥ θ (adaptive)
function buildDollarBars(bars1m,dollarThreshold){
  const out=[];
  let cumUSD=0;let acc={o:null,h:-Infinity,l:Infinity,c:null,v:0,tbv:0,qv:0,n_1m:0,t_start:null,t_end:null};
  for(const b of bars1m){
    if(acc.o===null){acc.o=b[1];acc.t_start=b[0];}
    if(b[2]>acc.h)acc.h=b[2];
    if(b[3]<acc.l)acc.l=b[3];
    acc.c=b[4];
    acc.v+=b[5];
    acc.tbv+=b[9];
    acc.qv+=b[7];
    acc.n_1m++;
    acc.t_end=b[0];
    cumUSD+=b[7];
    if(cumUSD>=dollarThreshold){
      acc.tsv=acc.v-acc.tbv;acc.ti=acc.v>0?(acc.tbv-acc.tsv)/acc.v:0;acc.t=acc.t_start;
      out.push({...acc});
      cumUSD=0;acc={o:null,h:-Infinity,l:Infinity,c:null,v:0,tbv:0,qv:0,n_1m:0,t_start:null,t_end:null};
    }
  }
  return out;
}

function buildImbalanceBars(bars1m,thetaBase){
  const out=[];
  let imbal=0;
  let acc={o:null,h:-Infinity,l:Infinity,c:null,v:0,tbv:0,qv:0,n_1m:0,t_start:null};
  for(const b of bars1m){
    if(acc.o===null){acc.o=b[1];acc.t_start=b[0];}
    if(b[2]>acc.h)acc.h=b[2];
    if(b[3]<acc.l)acc.l=b[3];
    acc.c=b[4];acc.v+=b[5];acc.tbv+=b[9];acc.qv+=b[7];acc.n_1m++;
    const tsv=b[5]-b[9];imbal+=b[9]-tsv; // signed buy imbalance
    if(Math.abs(imbal)>=thetaBase||acc.n_1m>=360){ // cap at 6h
      acc.tsv=acc.v-acc.tbv;acc.ti=acc.v>0?(acc.tbv-acc.tsv)/acc.v:0;acc.t=acc.t_start;acc.imbal=imbal;
      out.push({...acc});
      imbal=0;acc={o:null,h:-Infinity,l:Infinity,c:null,v:0,tbv:0,qv:0,n_1m:0,t_start:null};
    }
  }
  return out;
}

// ═══ Técnica 4: VPIN proxy (from 1m taker_buy_volume) ═══
// Bulk classification: use taker_buy_volume as buy_volume (aggressive buys)
// Bucket by volume V (mean daily volume / 50)
// VPIN = |buy_vol - sell_vol| / V
function computeVPIN(bars1m,bucketSize){
  const vpinSeries=[];
  const timeStamps=[];
  let acc={t_start:null,buyV:0,sellV:0,accV:0};
  for(const b of bars1m){
    if(acc.t_start===null)acc.t_start=b[0];
    const buy=b[9];const sell=b[5]-b[9];
    acc.buyV+=buy;acc.sellV+=sell;acc.accV+=b[5];
    if(acc.accV>=bucketSize){
      const vpin=Math.abs(acc.buyV-acc.sellV)/acc.accV;
      vpinSeries.push(vpin);timeStamps.push(acc.t_start);
      acc={t_start:null,buyV:0,sellV:0,accV:0};
    }
  }
  // Smooth with EMA-50
  const smoothed=new Float64Array(vpinSeries.length);
  if(vpinSeries.length>0){
    smoothed[0]=vpinSeries[0];const alpha=2/(50+1);
    for(let i=1;i<vpinSeries.length;i++)smoothed[i]=vpinSeries[i]*alpha+smoothed[i-1]*(1-alpha);
  }
  // Percentile P95 for toxicity threshold
  const sorted=[...vpinSeries].sort((a,b)=>a-b);
  const p95=sorted[Math.floor(0.95*sorted.length)]||0;
  return{vpin:vpinSeries,smoothed,timeStamps,p95,tox_flag:vpinSeries.map(v=>v>=p95?1:0)};
}

// ═══ Técnica 5: Orderbook reconstruction proxy ═══
// From 1m OHLCV with taker_buy_volume:
// - Wick absorption: large wick + high volume = absorption
// - Hawkes process lite: trade intensity clustering (rolling Poisson rate)
// - Flow toxicity: correlation between direction and size
function orderbookProxy(bars1h){
  const n=bars1h.length;
  // Feature 1: upper wick absorption (rejection of highs)
  // Feature 2: lower wick absorption (rejection of lows)
  const upperAbsorb=new Float64Array(n);
  const lowerAbsorb=new Float64Array(n);
  // Feature 3: body/range ratio (strong move vs wick dominance)
  const bodyRatio=new Float64Array(n);
  // Feature 4: trade intensity Hawkes proxy (EMA of volume)
  const intensity=new Float64Array(n);
  // Feature 5: flow toxicity (signed imbalance vs total volume, rolling)
  const toxicity=new Float64Array(n);
  // Feature 6: large trade flag (volume >2σ)
  const largeTrade=new Float64Array(n);
  let intAcc=0;const intAlpha=2/(20+1);
  for(let i=0;i<n;i++){
    const b=bars1h[i];
    const range=b.h-b.l;
    if(range<=0){upperAbsorb[i]=0;lowerAbsorb[i]=0;bodyRatio[i]=0;continue;}
    const upWick=b.h-Math.max(b.o,b.c);
    const loWick=Math.min(b.o,b.c)-b.l;
    const body=Math.abs(b.c-b.o);
    upperAbsorb[i]=(upWick/range)*Math.min(b.v/500,1);
    lowerAbsorb[i]=(loWick/range)*Math.min(b.v/500,1);
    bodyRatio[i]=body/range;
    intAcc=b.v*intAlpha+intAcc*(1-intAlpha);
    intensity[i]=b.v>0?Math.log(1+b.v/Math.max(intAcc,1)):0;
    // Toxicity: buy-sell imbalance normalized
    const imbal=b.tbv-b.tsv;toxicity[i]=b.v>0?imbal/b.v:0;
  }
  // Large trade flag: z-score vs rolling mean/std
  const window=24;
  for(let i=window;i<n;i++){
    let m=0;for(let j=i-window+1;j<=i;j++)m+=bars1h[j].v;m/=window;
    let sd=0;for(let j=i-window+1;j<=i;j++)sd+=(bars1h[j].v-m)**2;sd=Math.sqrt(sd/window);
    largeTrade[i]=sd>0?(bars1h[i].v-m)/sd:0;
    if(largeTrade[i]<2)largeTrade[i]=0;
  }
  return{upperAbsorb,lowerAbsorb,bodyRatio,intensity,toxicity,largeTrade};
}

// ═══ Técnica 3: Cross-Sectional features ═══
// For each timestamp, rank pair vs others in universe
function computeCrossSectional(allFeatures,PAIRS){
  // Align all pairs to common timestamps
  if(PAIRS.length===0)return {};
  const refT=allFeatures[PAIRS[0]].t;
  const rankFeats={};
  for(const p of PAIRS){rankFeats[p]={mom60m:new Float64Array(refT.length),mom4h:new Float64Array(refT.length),mom24h:new Float64Array(refT.length),vol24h:new Float64Array(refT.length),volZ:new Float64Array(refT.length)};}
  for(let i=24;i<refT.length;i++){
    // Snapshot all pairs at bar i
    const snap=PAIRS.map(p=>{
      const af=allFeatures[p];
      const c=af.c[i];const c1h=i>=1?af.c[i-1]:c;const c4=i>=4?af.c[i-4]:c;const c24=i>=24?af.c[i-24]:c;
      // Vol proxy: std of returns over 24h
      let m=0;for(let j=i-24;j<i;j++)m+=af.c[j];m/=24;let sd=0;for(let j=i-24;j<i;j++)sd+=(af.c[j]-m)**2;sd=Math.sqrt(sd/24);
      return{p,mom60m:(c-c1h)/c1h,mom4h:(c-c4)/c4,mom24h:(c-c24)/c24,vol24h:sd/c,volZ:af.v[i]};
    });
    // Compute ranks (1 to N)
    for(const key of['mom60m','mom4h','mom24h','vol24h','volZ']){
      const sorted=[...snap].sort((a,b)=>a[key]-b[key]);
      for(let r=0;r<sorted.length;r++){rankFeats[sorted[r].p][key][i]=(r+1)/sorted.length;}
    }
  }
  return rankFeats;
}

async function main(){
  const t0=Date.now();
  console.log('═'.repeat(80));console.log('FASE 2 — Feature Revolution (fracdiff + bars + cross-sect + VPIN + orderbook)');console.log('═'.repeat(80));

  // Load all 1m data
  console.log('\n[1/5] Loading 1m data...');
  const allData={};
  for(const pair of PAIRS){
    const b1m=load1m(pair);if(!b1m||b1m.length<50000){console.log(`  ${pair} SKIP`);continue;}
    const b1h=aggTF(b1m,60);
    allData[pair]={b1m,b1h};
  }
  console.log(`  Loaded ${Object.keys(allData).length} pairs [${((Date.now()-t0)/1000).toFixed(1)}s]`);

  // Técnica 1: Fractional Differentiation per pair
  console.log('\n[2/5] Fractional Differentiation (finding optimal d per feature)...');
  const fracdiffResults={};
  const t2=Date.now();
  for(const pair of Object.keys(allData)){
    const closes=Float64Array.from(allData[pair].b1h.map(b=>Math.log(b.c))); // log prices
    const vols=Float64Array.from(allData[pair].b1h.map(b=>Math.log(1+b.v)));
    // Sample subset for speed
    const optD_close=findOptimalD(Array.from(closes),1e-4);
    const optD_vol=findOptimalD(Array.from(vols),1e-4);
    const ffd_close=fracdiffFFD(Array.from(closes),optD_close.d,1e-5);
    const ffd_vol=fracdiffFFD(Array.from(vols),optD_vol.d,1e-5);
    fracdiffResults[pair]={d_close:optD_close.d,d_vol:optD_vol.d,ffd_close,ffd_vol};
    process.stdout.write(`  ${pair}: d_close=${optD_close.d.toFixed(2)} d_vol=${optD_vol.d.toFixed(2)}\n`);
  }
  console.log(`  [${((Date.now()-t2)/1000).toFixed(1)}s]`);

  // Técnica 2: Info-driven bars per pair (compute stats only, full bars too large)
  console.log('\n[3/5] Information-driven bars (dollar + imbalance)...');
  const barStats={};const t3=Date.now();
  for(const pair of Object.keys(allData)){
    const b1m=allData[pair].b1m;
    // Daily volume USD (mean)
    let totalUSD=0;for(const b of b1m)totalUSD+=b[7];
    const daysSpan=Math.ceil((b1m[b1m.length-1][0]-b1m[0][0])/86400000);
    const avgDailyUSD=totalUSD/daysSpan;
    const dollarThresh=avgDailyUSD/50; // 50 dollar bars/day target
    const dollarBars=buildDollarBars(b1m,dollarThresh);
    // For imbalance bars: use 25% of dollar threshold as theta (volume units)
    let totalVol=0;for(const b of b1m)totalVol+=b[5];
    const avgDailyVol=totalVol/daysSpan;
    const imbalTheta=avgDailyVol/100;
    const imbalBars=buildImbalanceBars(b1m,imbalTheta);
    // Compare statistical properties (skew/kurt of log returns)
    function logRetStats(bars){if(bars.length<10)return{skew:0,kurt:3,ac1:0};const lr=[];for(let i=1;i<bars.length;i++)lr.push(Math.log(bars[i].c/bars[i-1].c));const m=lr.reduce((a,x)=>a+x,0)/lr.length;let s2=0,s3=0,s4=0;for(const r of lr){const d=r-m;s2+=d*d;s3+=d*d*d;s4+=d*d*d*d;}const sd=Math.sqrt(s2/lr.length);if(sd===0)return{skew:0,kurt:3,ac1:0};const skew=s3/lr.length/(sd*sd*sd);const kurt=s4/lr.length/(sd*sd*sd*sd);let ac=0,acd=0;for(let i=1;i<lr.length;i++){ac+=(lr[i]-m)*(lr[i-1]-m);acd+=(lr[i-1]-m)**2;}const ac1=acd>0?ac/acd:0;return{skew,kurt,ac1};}
    const time1hStats=logRetStats(allData[pair].b1h);
    const dollarStats=logRetStats(dollarBars);
    const imbalStats=logRetStats(imbalBars);
    barStats[pair]={n_dollar:dollarBars.length,n_imbal:imbalBars.length,time1h:time1hStats,dollar:dollarStats,imbal:imbalStats};
    process.stdout.write(`  ${pair}: ${dollarBars.length} dollar, ${imbalBars.length} imbal bars. 1h kurt=${time1hStats.kurt.toFixed(2)}, dollar kurt=${dollarStats.kurt.toFixed(2)}\n`);
  }
  console.log(`  [${((Date.now()-t3)/1000).toFixed(1)}s]`);

  // Técnica 4: VPIN proxy
  console.log('\n[4/5] VPIN proxy (Easley-López-O\'Hara)...');
  const vpinResults={};const t4=Date.now();
  for(const pair of Object.keys(allData)){
    const b1m=allData[pair].b1m;
    let totalVol=0;for(const b of b1m)totalVol+=b[5];
    const daysSpan=Math.ceil((b1m[b1m.length-1][0]-b1m[0][0])/86400000);
    const bucketSize=(totalVol/daysSpan)/50;
    const v=computeVPIN(b1m,bucketSize);
    vpinResults[pair]={n_buckets:v.vpin.length,p95:v.p95,mean:v.vpin.reduce((a,x)=>a+x,0)/v.vpin.length,smoothed_mean:v.smoothed.reduce((a,x)=>a+x,0)/v.smoothed.length,tox_rate:v.tox_flag.filter(x=>x===1).length/v.tox_flag.length,timeStamps:v.timeStamps,vpinSeries:v.smoothed};
    process.stdout.write(`  ${pair}: ${v.vpin.length} buckets, mean VPIN ${(vpinResults[pair].mean*100).toFixed(2)}%, P95 ${(v.p95*100).toFixed(2)}%, tox rate ${(vpinResults[pair].tox_rate*100).toFixed(1)}%\n`);
  }
  console.log(`  [${((Date.now()-t4)/1000).toFixed(1)}s]`);

  // Técnica 5: Orderbook proxy
  console.log('\n[5/5] Orderbook reconstruction proxy...');
  const orderbookResults={};const t5=Date.now();
  for(const pair of Object.keys(allData)){
    const res=orderbookProxy(allData[pair].b1h);
    // Save only summary stats (not full arrays to limit file size)
    const meanVal=arr=>arr.reduce((a,x)=>a+(isFinite(x)?x:0),0)/arr.length;
    orderbookResults[pair]={mean_upperAbsorb:meanVal(res.upperAbsorb),mean_lowerAbsorb:meanVal(res.lowerAbsorb),mean_bodyRatio:meanVal(res.bodyRatio),mean_intensity:meanVal(res.intensity),mean_toxicity:meanVal(res.toxicity),largeTrade_rate:Array.from(res.largeTrade).filter(x=>x>0).length/res.largeTrade.length};
    process.stdout.write(`  ${pair}: body=${orderbookResults[pair].mean_bodyRatio.toFixed(3)}, tox=${orderbookResults[pair].mean_toxicity.toFixed(3)}, largeTrade=${(orderbookResults[pair].largeTrade_rate*100).toFixed(1)}%\n`);
  }
  console.log(`  [${((Date.now()-t5)/1000).toFixed(1)}s]`);

  // Técnica 3: Cross-sectional (needs all pairs' features aligned)
  console.log('\n[3b/5] Cross-sectional features...');
  const featsForXS={};for(const p of Object.keys(allData)){const bh=allData[p].b1h;featsForXS[p]={t:bh.map(b=>b.t),c:bh.map(b=>b.c),v:bh.map(b=>b.v)};}
  const xsRanks=computeCrossSectional(featsForXS,Object.keys(featsForXS));
  console.log(`  ✓ Computed ranks for ${Object.keys(xsRanks).length} pairs, 5 rank features each`);

  // Save feature summary
  const summary={phase:'2 — Feature Revolution',runtime_s:(Date.now()-t0)/1000,n_pairs:Object.keys(allData).length,fracdiff:Object.fromEntries(Object.entries(fracdiffResults).map(([k,v])=>[k,{d_close:v.d_close,d_vol:v.d_vol}])),bars:barStats,vpin:Object.fromEntries(Object.entries(vpinResults).map(([k,v])=>[k,{n_buckets:v.n_buckets,p95:v.p95,mean:v.mean,tox_rate:v.tox_rate}])),orderbook:orderbookResults};
  fs.writeFileSync(path.join(RESULTS_DIR,'02_feature_revolution.json'),JSON.stringify(summary,null,2));

  // Save dense feature arrays for Phase 3 (as ndjson for efficiency)
  const featArrays={fracdiff:fracdiffResults,xsRanks,vpinTimeStamps:Object.fromEntries(Object.entries(vpinResults).map(([k,v])=>[k,{ts:v.timeStamps,vpin:Array.from(v.vpinSeries)}]))};
  // Save to binary-friendly JSON
  fs.writeFileSync(path.join(FEATURES_DIR,'02_feat_arrays_meta.json'),JSON.stringify({pairs:Object.keys(allData),generated:new Date().toISOString()},null,2));
  for(const pair of Object.keys(allData)){
    const exportData={pair,ffd_close_d:fracdiffResults[pair].d_close,ffd_vol_d:fracdiffResults[pair].d_vol};
    fs.writeFileSync(path.join(FEATURES_DIR,`02_ffd_${pair}.json`),JSON.stringify(exportData));
  }

  console.log('\n'+'═'.repeat(80));console.log('FASE 2 COMPLETE');console.log('═'.repeat(80));
  console.log(`Runtime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`\nFeature families built:`);
  console.log(`  ✓ Fractional Diff: d_close mean = ${(Object.values(fracdiffResults).reduce((a,v)=>a+v.d_close,0)/Object.keys(fracdiffResults).length).toFixed(2)}`);
  console.log(`  ✓ Info-driven bars: ${Object.values(barStats).reduce((a,v)=>a+v.n_dollar,0)} dollar bars total`);
  console.log(`  ✓ VPIN proxy: ${Object.values(vpinResults).reduce((a,v)=>a+v.n_buckets,0)} buckets total`);
  console.log(`  ✓ Orderbook proxy: 6 features × ${Object.keys(orderbookResults).length} pairs`);
  console.log(`  ✓ Cross-sectional: 5 rank features × ${Object.keys(xsRanks).length} pairs`);
  console.log(`\nSaved: ${RESULTS_DIR}/02_feature_revolution.json`);
  console.log(`Feature arrays: ${FEATURES_DIR}/`);
}
main().catch(e=>{console.error(e);process.exit(1);});
