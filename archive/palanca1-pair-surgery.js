#!/usr/bin/env node
'use strict';
/**
 * Palanca 1 — Per-pair PF backtest over 120d OOS
 * Goal: identify pairs with PF<1.10 to remove from APEX universe
 *
 * Uses Pearson-per-pair approach (mimic v42 PRO+) over 1m→15m bars
 */
const fs = require('fs');
const path = require('path');

const KLINES_DIR = '/tmp/binance-klines-1m';
const PAIRS = ['ADAUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','ATOMUSDT','LINKUSDT','SOLUSDT','TRXUSDT','NEARUSDT','INJUSDT','BNBUSDT','AVAXUSDT','DOGEUSDT','LTCUSDT','DOTUSDT'];
const TF_MIN = 15;
const POS_SIZE = 1000;
const FEE_RT = 0.0004;

function mkPRNG(s){let a=s|0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const prng = mkPRNG(314159265);

function load1m(pair){const dir=path.join(KLINES_DIR,pair);if(!fs.existsSync(dir))return null;const files=fs.readdirSync(dir).filter(f=>f.endsWith('.csv')).sort();const bars=[];for(const f of files){const c=fs.readFileSync(path.join(dir,f),'utf8').split('\n');const s=c[0].startsWith('open_time')?1:0;for(let i=s;i<c.length;i++){const l=c[i].trim();if(!l)continue;const p=l.split(',');if(p.length<11)continue;bars.push([+p[0],+p[1],+p[2],+p[3],+p[4],+p[5],+p[6],+p[7],+p[8],+p[9],+p[10]]);}}bars.sort((a,b)=>a[0]-b[0]);return bars;}

function agg15m(b1){const out=[];for(let i=0;i+TF_MIN<=b1.length;i+=TF_MIN){const s=b1.slice(i,i+TF_MIN);const o=s[0][1],c=s[s.length-1][4];let h=-Infinity,l=Infinity,v=0,tbv=0,cnt=0;for(const b of s){if(b[2]>h)h=b[2];if(b[3]<l)l=b[3];v+=b[5];tbv+=b[9];cnt+=b[8];}out.push({ts:s[0][0],o,h,l,c,v,cnt,tbr:v>0?tbv/v:0.5,tbd:(v>0?tbv/v:0.5)-0.5});}return out;}

function ema(a,p,k='c'){const al=2/(p+1);const o=new Array(a.length);let v=a[0][k];for(let i=0;i<a.length;i++){v=a[i][k]*al+v*(1-al);o[i]=v;}return o;}
function rsi(a,p=14){const o=new Array(a.length).fill(50);let g=0,l=0;for(let i=1;i<=p&&i<a.length;i++){const d=a[i].c-a[i-1].c;if(d>0)g+=d;else l-=d;}g/=p;l/=p;for(let i=p;i<a.length;i++){const d=a[i].c-a[i-1].c;g=(g*(p-1)+(d>0?d:0))/p;l=(l*(p-1)+(d<0?-d:0))/p;o[i]=100-100/(1+(l===0?100:g/l));}return o;}
function atr(a,p=14){const o=new Array(a.length).fill(0);let s=0;for(let i=1;i<=p&&i<a.length;i++)s+=Math.max(a[i].h-a[i].l,Math.abs(a[i].h-a[i-1].c),Math.abs(a[i].l-a[i-1].c));o[p]=s/p;for(let i=p+1;i<a.length;i++){const tr=Math.max(a[i].h-a[i].l,Math.abs(a[i].h-a[i-1].c),Math.abs(a[i].l-a[i-1].c));o[i]=(o[i-1]*(p-1)+tr)/p;}return o;}
function adx(a,p=14){const o=new Array(a.length).fill(0);if(a.length<p*2)return o;let pDM=0,nDM=0,tr=0;for(let i=1;i<=p&&i<a.length;i++){const up=a[i].h-a[i-1].h,dn=a[i-1].l-a[i].l;if(up>dn&&up>0)pDM+=up;if(dn>up&&dn>0)nDM+=dn;tr+=Math.max(a[i].h-a[i].l,Math.abs(a[i].h-a[i-1].c),Math.abs(a[i].l-a[i-1].c));}for(let i=p+1;i<a.length;i++){const up=a[i].h-a[i-1].h,dn=a[i-1].l-a[i].l;const dmp=up>dn&&up>0?up:0,dmn=dn>up&&dn>0?dn:0;const trN=Math.max(a[i].h-a[i].l,Math.abs(a[i].h-a[i-1].c),Math.abs(a[i].l-a[i-1].c));pDM=pDM-pDM/p+dmp;nDM=nDM-nDM/p+dmn;tr=tr-tr/p+trN;const pDI=100*pDM/tr,nDI=100*nDM/tr;const dx=100*Math.abs(pDI-nDI)/(pDI+nDI+1e-9);o[i]=i===p+1?dx:(o[i-1]*(p-1)+dx)/p;}return o;}

function mtfS(b,i){if(i<192)return 0;const avg=(f,t)=>{let s=0,n=0;for(let x=Math.max(0,f);x<=Math.min(b.length-1,t);x++){s+=b[x].c;n++;}return n>0?s/n:0;};const t15=avg(i-9,i)>avg(i-21,i-10)?1:-1;const t1h=avg(i-15,i)>avg(i-31,i-16)?1:-1;const t4h=avg(i-47,i)>avg(i-95,i-48)?1:-1;const t1d=avg(i-95,i)>avg(i-191,i-96)?1:-1;return (t15+t1h+t4h+t1d)/4;}

function regime(b,i){const p=96;if(i<p)return'chop';const s=b.slice(i-p,i+1);let sR=0,n=0;for(let j=1;j<s.length;j++){const r=Math.log(s[j].c/s[j-1].c);sR+=r*r;n++;}const rv=Math.sqrt(sR/n)*Math.sqrt(96);const r24=(s[s.length-1].c-s[0].c)/s[0].c;const ax=adx(s,14);const an=ax[ax.length-1]||20;if(r24>0.015&&an>25&&rv<0.06)return'bull';if(r24<-0.015&&an>25)return'bear';if(rv>0.07||an<18)return'chop';return Math.abs(r24)>0.008?(r24>0?'bull':'bear'):'chop';}

const FEATS = ['ret1','ret4','ret16','vol16','tbd','emaCross','emaSlow','rsiNorm','adxN','mtfSigned'];

function buildFeats(b){const e9=ema(b,9),e21=ema(b,21),e55=ema(b,55);const r=rsi(b,14),a=atr(b,14),ad=adx(b,14);const fs=[];for(let i=192;i<b.length;i++){const x=b[i];const r1=(x.c-b[i-1].c)/b[i-1].c;const r4=(x.c-b[i-4].c)/b[i-4].c;const r16=(x.c-b[i-16].c)/b[i-16].c;let v16=0;for(let j=i-15;j<=i;j++){const rr=(b[j].c-b[j-1].c)/b[j-1].c;v16+=rr*rr;}v16=Math.sqrt(v16/16);fs.push({ts:x.ts,c:x.c,h:x.h,l:x.l,atrPct:a[i]/x.c,feats:[r1,r4,r16,v16,x.tbd,(e9[i]-e21[i])/e21[i],(e21[i]-e55[i])/e55[i],(r[i]-50)/50,ad[i]/100,mtfS(b,i)],regime:regime(b,i),mtfSigned:mtfS(b,i)});}return fs;}

function fwdR(f,i,h=2){if(i+h>=f.length)return null;return(f[i+h].c-f[i].c)/f[i].c;}
function pearson(x,y){const n=x.length;if(n<10)return 0;let sx=0,sy=0,sxy=0,sx2=0,sy2=0;for(let i=0;i<n;i++){sx+=x[i];sy+=y[i];sxy+=x[i]*y[i];sx2+=x[i]*x[i];sy2+=y[i]*y[i];}const num=n*sxy-sx*sy;const den=Math.sqrt((n*sx2-sx*sx)*(n*sy2-sy*sy));return den===0?0:num/den;}

async function runPair(pair){
  const b1 = load1m(pair);
  if (!b1 || b1.length < 10000) return null;
  const b15 = agg15m(b1);
  const feats = buildFeats(b15);
  if (feats.length < 500) return null;

  const tsEnd = feats[feats.length-1].ts;
  // 120d window: last 120d = test, prior 120d = train
  const testStart = tsEnd - 120*86400000;
  const trainStart = testStart - 120*86400000;

  const trainFeats = feats.filter(f => f.ts >= trainStart && f.ts < testStart);
  const testFeats = feats.filter(f => f.ts >= testStart && f.ts <= tsEnd);
  if (trainFeats.length < 300 || testFeats.length < 100) return null;

  // Compute Pearson corrs on train
  const Y = [];
  const xByF = FEATS.map(() => []);
  for (const f of trainFeats) {
    const i = feats.indexOf(f);
    const fr = fwdR(feats, i, 2);
    if (fr == null) continue;
    Y.push(fr);
    for (let k = 0; k < FEATS.length; k++) xByF[k].push(f.feats[k]);
  }
  const corrs = [];
  for (let k = 0; k < FEATS.length; k++) {
    const c = pearson(xByF[k], Y);
    corrs.push({ idx: k, corr: c, abs: Math.abs(c) });
  }
  corrs.sort((a,b) => b.abs - a.abs);
  const topK = corrs.slice(0, 5);

  // Threshold from train
  const trainScores = trainFeats.map(f => {
    let s = 0;
    for (const tk of topK) s += tk.corr * f.feats[tk.idx];
    return Math.abs(s);
  });
  trainScores.sort((a,b) => a-b);
  const p70 = trainScores[Math.floor(trainScores.length*0.7)];

  // Simulate test
  const trades = [];
  const open = [];
  for (const f of testFeats) {
    // Exit check
    for (let i = open.length-1; i >= 0; i--) {
      const t = open[i];
      const mv = t.side === 'LONG'
        ? (f.h >= t.tp ? {px:t.tp} : (f.l <= t.sl ? {px:t.sl} : null))
        : (f.l <= t.tp ? {px:t.tp} : (f.h >= t.sl ? {px:t.sl} : null));
      const held = Math.floor((f.ts-t.ts)/(15*60*1000));
      if (mv || held >= 60) {
        const exitPx = mv ? mv.px : f.c;
        const pnl = t.side === 'LONG'
          ? (exitPx - t.entry)/t.entry * POS_SIZE - POS_SIZE*FEE_RT
          : (t.entry - exitPx)/t.entry * POS_SIZE - POS_SIZE*FEE_RT;
        trades.push({ side: t.side, entry: t.entry, exit: exitPx, pnl, held });
        open.splice(i, 1);
      }
    }
    // Entry
    let score = 0;
    for (const tk of topK) score += tk.corr * f.feats[tk.idx];
    const abs = Math.abs(score);
    if (open.length === 0 && abs >= p70 && Math.abs(f.mtfSigned) >= 0.5) {
      const side = score > 0 ? 'LONG' : 'SHORT';
      const regAllowed = (f.regime === 'bull' && side === 'LONG')
                     || (f.regime === 'bear' && side === 'SHORT')
                     || (f.regime === 'chop');
      if (regAllowed) {
        const atrPx = f.atrPct * f.c;
        const tp = side === 'LONG' ? f.c + atrPx*1.5 : f.c - atrPx*1.5;
        const sl = side === 'LONG' ? f.c - atrPx*1.0 : f.c + atrPx*1.0;
        open.push({ side, entry: f.c, tp, sl, ts: f.ts });
      }
    }
  }

  // Metrics
  if (trades.length === 0) return { pair, n: 0, pf: 0, wr: 0, pnl: 0, dd: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const sumW = wins.reduce((s,t)=>s+t.pnl, 0);
  const sumL = Math.abs(losses.reduce((s,t)=>s+t.pnl, 0));
  const pf = sumL > 0 ? sumW/sumL : sumW;
  const wr = wins.length/trades.length;
  const pnl = sumW - sumL;
  let peak=0, dd=0, cash=0;
  for (const t of trades) {
    cash += t.pnl;
    if (cash > peak) peak = cash;
    const d = peak > 0 ? (peak - cash)/(10000 + peak) : 0;
    if (d > dd) dd = d;
  }
  return {
    pair, n: trades.length, pf, wr, pnl, dd,
    avgHold: trades.reduce((s,t)=>s+t.held, 0)/trades.length*15,
    topFeatures: topK.map(t => ({ name: FEATS[t.idx], corr: t.corr.toFixed(3) }))
  };
}

async function main() {
  console.log('[Palanca 1] Per-pair PF over last 120d OOS');
  console.log('='.repeat(70));
  const results = [];
  for (const pair of PAIRS) {
    const r = await runPair(pair);
    if (r) {
      results.push(r);
      console.log(`${pair.padEnd(14)} n=${String(r.n).padStart(3)} PF=${r.pf.toFixed(2)} WR=${(r.wr*100).toFixed(1)}% PnL=${r.pnl>0?'+':''}${r.pnl.toFixed(0)} DD=${(r.dd*100).toFixed(1)}%`);
    } else {
      console.log(`${pair.padEnd(14)} SKIP`);
    }
  }
  // Sort by PF
  results.sort((a,b) => b.pf - a.pf);
  console.log('\n' + '='.repeat(70));
  console.log('RANKING BY PF');
  console.log('='.repeat(70));
  for (const r of results) {
    const flag = r.pf < 1.10 ? '✗ REMOVE' : r.pf < 1.20 ? '△ MARGINAL' : '✓ KEEP';
    console.log(`${flag.padEnd(12)} ${r.pair.padEnd(14)} PF=${r.pf.toFixed(2)} WR=${(r.wr*100).toFixed(1)}% n=${r.n}`);
  }

  const keepers = results.filter(r => r.pf >= 1.10 && r.n >= 20);
  console.log('\n' + '='.repeat(70));
  console.log(`DECISION: Keep ${keepers.length}/${results.length} pairs (PF>=1.10 AND n>=20)`);
  console.log('='.repeat(70));
  console.log(`Keepers: [${keepers.map(r => `'${r.pair}'`).join(', ')}]`);

  // Portfolio-wide metrics: aggregate all keeper trades
  const allKeepers = keepers.flatMap(r => ({pair: r.pair, ...r}));
  const totalPF = keepers.reduce((s,r)=>s+r.pf*r.n, 0)/Math.max(1, keepers.reduce((s,r)=>s+r.n, 0));
  const totalWR = keepers.reduce((s,r)=>s+r.wr*r.n, 0)/Math.max(1, keepers.reduce((s,r)=>s+r.n, 0));
  const totalPnL = keepers.reduce((s,r)=>s+r.pnl, 0);
  const totalN = keepers.reduce((s,r)=>s+r.n, 0);
  console.log(`\nPortfolio metrics (keepers only, aggregated):`);
  console.log(`  Total trades: ${totalN}`);
  console.log(`  Avg PF (trade-weighted): ${totalPF.toFixed(2)}`);
  console.log(`  Avg WR (trade-weighted): ${(totalWR*100).toFixed(1)}%`);
  console.log(`  Total PnL: $${totalPnL.toFixed(0)}`);

  fs.writeFileSync('/tmp/palanca1-pair-surgery.json', JSON.stringify({
    all: results, keepers: keepers.map(r => r.pair),
    portfolioPF: totalPF, portfolioWR: totalWR, totalPnL
  }, null, 2));
  console.log('\n[SAVED] /tmp/palanca1-pair-surgery.json');
}

main().catch(e => { console.error(e); process.exit(1); });
