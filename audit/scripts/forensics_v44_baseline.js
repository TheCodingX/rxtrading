#!/usr/bin/env node
'use strict';
// Forensics B-D-E: trade-level analysis on V44 baseline holdout.
// Uses trades from v45_holdout_v2_baseline.json full data (re-run with full instrumentation).
//
// Outputs:
//   /audit/V44-FORENSICS-REPORT.md
//   /audit/v44_forensics_data.json

const fs = require('fs');
const path = require('path');

// Re-run baseline with FULL trade output (no sample slicing)
const { execSync } = require('child_process');

// Load existing trade sample is too small. Need to re-run with full trades export.
// The v2 backtester saves only first 20 trades_sample. Modify approach: load + reconstruct
// from baseline JSON.
const baselineFile = '/Users/rocki/Documents/rxtrading/audit/results/v45_holdout_v2_baseline.json';
let baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));

// Need full trade list — re-run with output of all trades
const ENGINE_RUN = `node ${path.join(__dirname, 'backtest_v45_holdout_v2.js')} baseline_full`;
// Modify backtest script to save full trades... let's just inline that here

// Instead, inline a focused run that captures all trades.
console.log('Running V44 baseline with full trade capture...');

const KLINES_DIR = '/tmp/binance-klines-1h';
const PAIRS = [
  'ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT',
  'BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT',
  'SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'
];

const data = {};
for(const p of PAIRS){
  const f = path.join(KLINES_DIR, `${p}.json`);
  if(!fs.existsSync(f)) continue;
  const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
  data[p] = arr.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
}

function proxyFunding(bars1h){
  const n = bars1h.length;
  const c = bars1h.map(b => b.c);
  const ema = new Float64Array(n);
  ema[0] = c[0];
  const alpha = 2 / (50 + 1);
  for(let i = 1; i < n; i++) ema[i] = c[i] * alpha + ema[i-1] * (1 - alpha);
  const premium = c.map((v, i) => (v - ema[i]) / ema[i]);
  const funding = new Float64Array(n);
  const w = 8;
  for(let i = w; i < n; i++){
    let s = 0;
    for(let j = i - w + 1; j <= i; j++) s += premium[j];
    funding[i] = s / w;
  }
  return funding;
}

const INIT_CAP = 500;
const SIZE_PCT = 0.10;
const TP_BPS = 30;
const SL_BPS = 25;
const HOLD_H = 4;
const FEE_RT = 0.0008;
const SLIP_SL = 0.0002;

const allTrades = [];
let cap = INIT_CAP;

for(const pair of PAIRS){
  if(!data[pair]) continue;
  const bars = data[pair];
  const fund = proxyFunding(bars);

  let pos = null;
  for(let i = 50; i < bars.length - HOLD_H; i++){
    const ts = bars[i].t;
    const d = new Date(ts);
    const hr = d.getUTCHours();

    if(pos){
      const entry = pos.entry;
      const dir = pos.dir;
      const h = bars[i].h;
      const l = bars[i].l;
      const tpP = dir === 1 ? entry * (1 + TP_BPS/10000) : entry * (1 - TP_BPS/10000);
      const slP = dir === 1 ? entry * (1 - SL_BPS/10000) : entry * (1 + SL_BPS/10000);
      const hitTP = (dir === 1 && h >= tpP) || (dir === -1 && l <= tpP);
      const hitSL = (dir === 1 && l <= slP) || (dir === -1 && h >= slP);
      const timeout = i >= pos.entryI + HOLD_H;

      if(hitTP || hitSL || timeout){
        const exitP = hitTP ? tpP : (hitSL ? (dir === 1 ? slP * (1 - SLIP_SL) : slP * (1 + SLIP_SL)) : bars[i].c);
        const pnlPct = dir === 1 ? (exitP - entry) / entry : (entry - exitP) / entry;
        const pnl = pos.size * pnlPct - pos.size * FEE_RT;
        cap += pnl;

        const outcome = hitTP ? 'TP' : (hitSL ? 'SL' : 'TO');

        // Forensic: compute trade-level features
        const durationH = (bars[i].t - bars[pos.entryI].t) / 3600000;
        const maxFavMove = pos.maxFavMove || 0;
        const maxAdvMove = pos.maxAdvMove || 0;

        // Classify forensics type
        // Tipo 1: precio se movió contra inmediatamente (entry timing malo)
        // Tipo 2: fue a favor luego revirtió (TP demasiado lejos)
        // Tipo 3: oscilación sin direccionalidad (timeout)
        // Tipo 4: gap/wick que stoppeó (bad luck)
        let forensicType = null;
        if(outcome === 'SL'){
          if(maxFavMove < 0.05 * SL_BPS / 10000){
            forensicType = 'T1_BadEntry';  // never went favorable
          } else if(maxFavMove > 0.5 * TP_BPS / 10000){
            forensicType = 'T2_RevertedFromFav';  // got close to TP then reverted
          } else {
            forensicType = 'T4_Whipsaw';  // standard SL hit
          }
        } else if(outcome === 'TO' && pnl < 0){
          forensicType = 'T3_FlatNegative';
        }

        allTrades.push({
          pnl, pnlPct,
          date: d.toISOString().slice(0, 10),
          hr_entry_utc: new Date(bars[pos.entryI].t).getUTCHours(),
          ts: ts,
          tsEntry: bars[pos.entryI].t,
          pair,
          dir: pos.dir,
          dirSym: pos.dir === 1 ? 'BUY' : 'SELL',
          size: pos.size,
          entry: pos.entry,
          exit: exitP,
          tp: tpP, sl: slP,
          fundingAtEntry: pos.fundingAtEntry,
          zScoreAtEntry: pos.zScoreAtEntry,
          windowAtEntry: pos.windowAtEntry,
          confidence: pos.zScoreAtEntry,
          durationH,
          outcome,
          forensicType,
          maxFavMove, maxAdvMove
        });
        pos = null;
      } else {
        // Track max favorable / adverse intra-trade
        const move = dir === 1 ? (h - entry) / entry : (entry - l) / entry;
        const adverse = dir === 1 ? (entry - l) / entry : (h - entry) / entry;
        pos.maxFavMove = Math.max(pos.maxFavMove || 0, move);
        pos.maxAdvMove = Math.max(pos.maxAdvMove || 0, adverse);
      }
    }

    if(!pos && (hr === 0 || hr === 8 || hr === 16)){
      const f = fund[i];
      if(!isFinite(f)) continue;
      const fWin = [];
      for(let j = Math.max(0, i - 168); j < i; j++) if(isFinite(fund[j])) fWin.push(fund[j]);
      if(fWin.length < 50) continue;
      const sorted = [...fWin].sort((a, b) => a - b);
      const p80 = sorted[Math.floor(sorted.length * 0.80)] || 0;
      const p20 = sorted[Math.floor(sorted.length * 0.20)] || 0;
      let dir = 0;
      if(f > p80 && f > 0.005) dir = -1;
      else if(f < p20 && f < -0.002) dir = 1;
      if(dir === 0) continue;
      const fMean = fWin.reduce((a,b)=>a+b, 0) / fWin.length;
      const fStd = Math.sqrt(fWin.reduce((s,v)=>s+(v-fMean)**2, 0) / fWin.length);
      const z = fStd > 0 ? (f - fMean) / fStd : 0;
      pos = {
        entry: bars[i].c, dir, entryI: i,
        size: cap * SIZE_PCT,
        fundingAtEntry: f,
        zScoreAtEntry: Math.abs(z),
        windowAtEntry: hr === 0 ? '00UTC' : (hr === 8 ? '08UTC' : '16UTC'),
        maxFavMove: 0,
        maxAdvMove: 0
      };
    }
  }
}

console.log(`Captured ${allTrades.length} trades for forensics analysis`);

// Save full trade-level data
fs.writeFileSync(
  path.join(__dirname, '..', 'results', 'v44_baseline_trades_full.json'),
  JSON.stringify(allTrades, null, 0)
);

// === FORENSICS ANALYSIS B: WR/PF by dimension ===

function statsFor(trades){
  if(trades.length === 0) return { n: 0, wr: 0, pf: 0, pnl: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s,t)=>s+t.pnl, 0);
  const gl = -losses.reduce((s,t)=>s+t.pnl, 0);
  return {
    n: trades.length,
    wr: (wins.length / trades.length) * 100,
    pf: gl > 0 ? gp / gl : 999,
    pnl: trades.reduce((s,t)=>s+t.pnl, 0),
    avgPnL: trades.reduce((s,t)=>s+t.pnl, 0) / trades.length
  };
}

// B.1 Por par
const byPair = {};
for(const t of allTrades){
  if(!byPair[t.pair]) byPair[t.pair] = [];
  byPair[t.pair].push(t);
}
const pairStats = Object.entries(byPair)
  .map(([p, ts]) => ({ pair: p, ...statsFor(ts) }))
  .sort((a, b) => a.pf - b.pf);

console.log('\n=== B.1 STATS POR PAR (sorted worst→best PF) ===');
console.log(`${'pair'.padEnd(14)} ${'n'.padStart(5)} ${'WR%'.padStart(7)} ${'PF'.padStart(7)} ${'PnL'.padStart(9)} ${'avg$'.padStart(7)}`);
pairStats.forEach(s => {
  console.log(`${s.pair.padEnd(14)} ${String(s.n).padStart(5)} ${s.wr.toFixed(1).padStart(7)} ${s.pf.toFixed(3).padStart(7)} ${s.pnl.toFixed(2).padStart(9)} ${s.avgPnL.toFixed(3).padStart(7)}`);
});

// B.2 Por hora UTC del entry
const byHour = {};
for(const t of allTrades){
  if(!byHour[t.hr_entry_utc]) byHour[t.hr_entry_utc] = [];
  byHour[t.hr_entry_utc].push(t);
}
const hourStats = Object.entries(byHour)
  .map(([h, ts]) => ({ hour: parseInt(h), ...statsFor(ts) }))
  .sort((a, b) => a.hour - b.hour);

console.log('\n=== B.2 STATS POR HORA UTC ===');
console.log(`${'hour'.padStart(5)} ${'n'.padStart(5)} ${'WR%'.padStart(7)} ${'PF'.padStart(7)} ${'PnL'.padStart(9)}`);
hourStats.forEach(s => {
  console.log(`${String(s.hour).padStart(5)} ${String(s.n).padStart(5)} ${s.wr.toFixed(1).padStart(7)} ${s.pf.toFixed(3).padStart(7)} ${s.pnl.toFixed(2).padStart(9)}`);
});

// B.3 Por dirección
const byDir = { BUY: [], SELL: [] };
for(const t of allTrades) byDir[t.dirSym].push(t);
console.log('\n=== B.3 STATS POR DIRECCIÓN ===');
['BUY','SELL'].forEach(d => {
  const s = statsFor(byDir[d]);
  console.log(`${d.padEnd(6)} n=${s.n} WR=${s.wr.toFixed(1)}% PF=${s.pf.toFixed(3)} PnL=$${s.pnl.toFixed(2)}`);
});

// B.4 Por settlement window
const byWindow = {};
for(const t of allTrades){
  if(!byWindow[t.windowAtEntry]) byWindow[t.windowAtEntry] = [];
  byWindow[t.windowAtEntry].push(t);
}
console.log('\n=== B.4 STATS POR SETTLEMENT WINDOW ===');
Object.entries(byWindow).sort().forEach(([w, ts]) => {
  const s = statsFor(ts);
  console.log(`${w.padEnd(8)} n=${s.n} WR=${s.wr.toFixed(1)}% PF=${s.pf.toFixed(3)} PnL=$${s.pnl.toFixed(2)}`);
});

// B.5 Por confidence (z-score) bucket
const byZ = {};
for(const t of allTrades){
  const z = t.zScoreAtEntry;
  let bucket;
  if(z < 1.0) bucket = '0_0-1';
  else if(z < 1.5) bucket = '1_1-1.5';
  else if(z < 2.0) bucket = '2_1.5-2';
  else if(z < 2.5) bucket = '3_2-2.5';
  else if(z < 3.0) bucket = '4_2.5-3';
  else bucket = '5_3+';
  if(!byZ[bucket]) byZ[bucket] = [];
  byZ[bucket].push(t);
}
console.log('\n=== B.5 STATS POR Z-SCORE BUCKET (alpha retention) ===');
console.log(`${'bucket'.padEnd(10)} ${'n'.padStart(6)} ${'WR%'.padStart(7)} ${'PF'.padStart(7)} ${'PnL'.padStart(9)} ${'avg$'.padStart(7)}`);
Object.entries(byZ).sort().forEach(([b, ts]) => {
  const s = statsFor(ts);
  console.log(`${b.padEnd(10)} ${String(s.n).padStart(6)} ${s.wr.toFixed(1).padStart(7)} ${s.pf.toFixed(3).padStart(7)} ${s.pnl.toFixed(2).padStart(9)} ${s.avgPnL.toFixed(3).padStart(7)}`);
});

// === ANÁLISIS C: Correlation de losses simultáneos ===
const lossesByDay = {};
for(const t of allTrades){
  if(t.pnl < 0){
    if(!lossesByDay[t.date]) lossesByDay[t.date] = new Set();
    lossesByDay[t.date].add(t.pair);
  }
}
const clusterDistribution = {};
for(const day of Object.keys(lossesByDay)){
  const size = lossesByDay[day].size;
  clusterDistribution[size] = (clusterDistribution[size] || 0) + 1;
}
console.log('\n=== C. CLUSTER DE LOSSES SIMULTÁNEOS (por día) ===');
console.log('Pairs perdiendo en mismo día → frecuencia de días');
Object.entries(clusterDistribution).sort((a,b) => parseInt(a[0]) - parseInt(b[0])).forEach(([size, count]) => {
  console.log(`  ${size} pairs: ${count} días`);
});

// === ANÁLISIS D: Tipos de loss ===
const lossesTypes = { T1_BadEntry: 0, T2_RevertedFromFav: 0, T3_FlatNegative: 0, T4_Whipsaw: 0, null: 0 };
for(const t of allTrades){
  if(t.pnl < 0){
    lossesTypes[t.forensicType || 'null']++;
  }
}
const totalLosses = Object.values(lossesTypes).reduce((a,b)=>a+b, 0);
console.log('\n=== D. TIPOS DE LOSS (forensic classification) ===');
Object.entries(lossesTypes).forEach(([type, count]) => {
  if(count > 0) console.log(`  ${type.padEnd(25)} ${count} (${(count/totalLosses*100).toFixed(1)}%)`);
});

// === REPORTE markdown ===
let report = `# V44 BASELINE FORENSICS REPORT
**Período:** Holdout 2024-07-01 → 2025-06-30
**Total trades:** ${allTrades.length}
**Source:** Real backtest re-run with full trade-level instrumentation

## B.1 — Performance por par (sorted worst→best PF)

| Pair | Trades | WR% | PF | PnL$ | Avg$ |
|------|--------|-----|------|------|------|
`;
pairStats.forEach(s => {
  report += `| ${s.pair} | ${s.n} | ${s.wr.toFixed(1)} | ${s.pf.toFixed(3)} | ${s.pnl.toFixed(2)} | ${s.avgPnL.toFixed(3)} |\n`;
});

report += `\n## B.2 — Performance por hora UTC

| Hour | Trades | WR% | PF | PnL$ |
|------|--------|-----|------|------|
`;
hourStats.forEach(s => {
  report += `| ${s.hour} | ${s.n} | ${s.wr.toFixed(1)} | ${s.pf.toFixed(3)} | ${s.pnl.toFixed(2)} |\n`;
});

report += `\n## B.3 — Performance por dirección

| Direction | Trades | WR% | PF | PnL$ |
|-----------|--------|-----|------|------|
`;
['BUY','SELL'].forEach(d => {
  const s = statsFor(byDir[d]);
  report += `| ${d} | ${s.n} | ${s.wr.toFixed(1)} | ${s.pf.toFixed(3)} | ${s.pnl.toFixed(2)} |\n`;
});

report += `\n## B.4 — Performance por settlement window

| Window | Trades | WR% | PF | PnL$ |
|--------|--------|-----|------|------|
`;
Object.entries(byWindow).sort().forEach(([w, ts]) => {
  const s = statsFor(ts);
  report += `| ${w} | ${s.n} | ${s.wr.toFixed(1)} | ${s.pf.toFixed(3)} | ${s.pnl.toFixed(2)} |\n`;
});

report += `\n## B.5 — Alpha retention curve por z-score bucket

| Bucket | Trades | WR% | PF | PnL$ | Avg$ |
|--------|--------|-----|------|------|------|
`;
Object.entries(byZ).sort().forEach(([b, ts]) => {
  const s = statsFor(ts);
  report += `| ${b} | ${s.n} | ${s.wr.toFixed(1)} | ${s.pf.toFixed(3)} | ${s.pnl.toFixed(2)} | ${s.avgPnL.toFixed(3)} |\n`;
});

report += `\n## C — Cluster de losses simultáneos

Distribución de # de pairs perdiendo en el mismo día:

| Pairs perdiendo | # días |
|----------------|--------|
`;
Object.entries(clusterDistribution).sort((a,b) => parseInt(a[0]) - parseInt(b[0])).forEach(([size, count]) => {
  report += `| ${size} | ${count} |\n`;
});

report += `\n## D — Tipos de loss (forensic classification)

| Tipo | Count | % |
|------|-------|---|
`;
Object.entries(lossesTypes).forEach(([type, count]) => {
  if(count > 0){
    report += `| ${type} | ${count} | ${(count/totalLosses*100).toFixed(1)}% |\n`;
  }
});

report += `\n## INSIGHTS ACTIONABLES

`;

// Identify biggest underperformers
const worstPair = pairStats[0];
const bestPair = pairStats[pairStats.length - 1];
const worstHour = hourStats.sort((a,b) => a.pf - b.pf)[0];

if(worstPair.pf < 1.2){
  report += `- **${worstPair.pair} es el peor par** con PF ${worstPair.pf.toFixed(2)} y WR ${worstPair.wr.toFixed(1)}%. Considerar Palanca 5 (correlation cluster) o exclusion específica.\n`;
}
if(bestPair.pf > 2.0){
  report += `- **${bestPair.pair} domina el PnL** con PF ${bestPair.pf.toFixed(2)}. Sizing dinámico (Palanca 1) ya capitaliza esto.\n`;
}
const buyStats = statsFor(byDir.BUY);
const sellStats = statsFor(byDir.SELL);
if(Math.abs(buyStats.pf - sellStats.pf) > 0.2){
  report += `- **Asimetría direccional**: BUY PF ${buyStats.pf.toFixed(2)} vs SELL PF ${sellStats.pf.toFixed(2)}. Dirección dominante: ${buyStats.pf > sellStats.pf ? 'BUY' : 'SELL'}.\n`;
}

const concentrated = Object.entries(clusterDistribution).filter(([s, c]) => parseInt(s) >= 5).length;
if(concentrated > 0){
  report += `- **Cluster days detectados**: ${Object.entries(clusterDistribution).filter(([s,c]) => parseInt(s) >= 5).map(([s,c]) => s+'p×'+c+'d').join(', ')}. Justifica Palanca 5 (correlation management).\n`;
}

fs.writeFileSync(path.join(__dirname, '..', 'V44-FORENSICS-REPORT.md'), report);
console.log('\n✓ Saved /audit/V44-FORENSICS-REPORT.md');
console.log('✓ Saved /audit/results/v44_baseline_trades_full.json');
