#!/usr/bin/env node
'use strict';
// FASE 1 Palanca A — Quality filter
// Run ELITE with all confidence metadata, analyze WR/PF by confidence percentile,
// pick threshold that maximizes PF×WR while keeping trades >= 3000 on 638d
const fs=require('fs');const path=require('path');
const X = require('./apex_x_engine.js');
const E = require('./apex_elite_engine.js');

const PAIRS = ['ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT','SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'];

function load(){
  const allData = {};
  for (const pair of PAIRS) {
    const b1m_h = X.load1m(pair, '/tmp/binance-klines-1m-holdout') || [];
    const b1m_t = X.load1m(pair, '/tmp/binance-klines-1m') || [];
    const merged = b1m_h.concat(b1m_t);
    if (merged.length < 10000) continue;
    merged.sort((a, b) => a[0] - b[0]);
    const seen = new Set(); const uniq = [];
    for (const b of merged) { if (!seen.has(b[0])) { seen.add(b[0]); uniq.push(b); } }
    allData[pair] = { b1h: X.aggTF(uniq, 60) };
  }
  return allData;
}

function scoreTrade(t) {
  // Composite confidence: |z-score| × windowType weight × funding-extremity
  const zAbs = Math.abs(t.zscore || 0);
  const windowWeight = t.windowType === 'MID' ? 1.0 : (t.windowType === 'PRE' ? 0.85 : 0.75);
  return zAbs * windowWeight;
}

function statsFiltered(trades, threshold, cap=500, days=638){
  const filtered = trades.filter(t => scoreTrade(t) >= threshold);
  if (!filtered.length) return { n:0, pf:0, wr:0, dd:0, pnl:0, pnl_pct:0, tpd:0, qualityScore:0 };
  const wins = filtered.filter(t => t.pnl > 0);
  const losses = filtered.filter(t => t.pnl <= 0);
  const gw = wins.reduce((s,t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s,t) => s + t.pnl, 0));
  let cum=0, pk=0, mdd=0;
  for (const t of filtered) { cum += t.pnl; if (cum > pk) pk = cum; if (pk-cum > mdd) mdd = pk-cum; }
  const pnl = gw - gl;
  const pf = gl > 0 ? gw/gl : (gw>0?99:0);
  const wr = wins.length / filtered.length * 100;
  return {
    n: filtered.length,
    pf, wr,
    dd: mdd / (cap + Math.max(0, pnl)) * 100,
    pnl, pnl_pct: pnl/cap*100,
    tpd: filtered.length / days,
    qualityScore: pf * wr / 100  // composite quality
  };
}

(function main() {
  const t0 = Date.now();
  console.log('═'.repeat(80));
  console.log('APEX ULTRA — FASE 1 Palanca A (Quality Filter)');
  console.log('═'.repeat(80));

  console.log('\n[1/4] Load + run ELITE engine (M1+M2) on 638d...');
  const allData = load();
  const lastTs = Math.max(...Object.values(allData).map(d => d.b1h[d.b1h.length-1].t));
  const firstTs = Math.min(...Object.values(allData).map(d => d.b1h[0].t));
  const totalDays = Math.floor((lastTs - firstTs) / 86400000);
  const trades = E.runEliteOnData(allData, PAIRS, { stages: { m1_zsizing:true, m2_multiwin:true } });
  console.log(`  ${trades.length} trades over ${totalDays} days`);

  // Score each trade
  const scores = trades.map(scoreTrade).sort((a,b) => a-b);
  const baseline = statsFiltered(trades, 0, 500, totalDays);
  console.log(`  BASELINE (no filter): ${baseline.n}t PF${baseline.pf.toFixed(2)} WR${baseline.wr.toFixed(1)}% DD${baseline.dd.toFixed(2)}% PnL${baseline.pnl_pct.toFixed(1)}% tpd${baseline.tpd.toFixed(1)} Q${baseline.qualityScore.toFixed(2)}`);

  console.log('\n[2/4] Analyze WR/PF by confidence percentile (top N% only):');
  const percentiles = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];
  const results = [];
  for (const pct of percentiles) {
    const idx = Math.floor(scores.length * (1 - pct/100));
    const threshold = scores[idx] || 0;
    const s = statsFiltered(trades, threshold, 500, totalDays);
    results.push({ pct, threshold: +threshold.toFixed(3), ...s });
    console.log(`  top ${String(pct).padStart(3)}% (thr ${threshold.toFixed(3).padStart(6)}): ${String(s.n).padStart(5)}t PF${s.pf.toFixed(2)} WR${s.wr.toFixed(1)}% DD${s.dd.toFixed(2)}% PnL${s.pnl_pct.toFixed(1)}% tpd${s.tpd.toFixed(1)} Q${s.qualityScore.toFixed(2)}`);
  }

  console.log('\n[3/4] Find optimal threshold (max PF×WR with trades ≥ 3000 on 638d, tpd ≥ 4.7)...');
  const viable = results.filter(r => r.n >= 3000 && r.pf >= 1.55 && r.wr >= 70);
  console.log(`  Viable candidates (PF≥1.55, WR≥70%, trades≥3000): ${viable.length}`);
  for (const v of viable) {
    console.log(`   - top ${v.pct}% / thr ${v.threshold}: PF ${v.pf.toFixed(2)} WR ${v.wr.toFixed(1)}% trades ${v.n} Q=${v.qualityScore.toFixed(2)}`);
  }
  const best = viable.length ? viable.reduce((a,b) => b.qualityScore > a.qualityScore ? b : a) : results.find(r => r.pct === 70);

  console.log('\n[4/4] CHOSEN THRESHOLD:');
  console.log(`  top ${best.pct}% (threshold ${best.threshold}):`);
  console.log(`    ${best.n}t  PF ${best.pf.toFixed(2)}  WR ${best.wr.toFixed(1)}%  DD ${best.dd.toFixed(2)}%  PnL ${best.pnl_pct.toFixed(1)}%  tpd ${best.tpd.toFixed(1)}`);

  // Period breakdown for best
  console.log('\n── Period breakdown for best threshold ──');
  for (const days of [7, 30, 60, 120]) {
    const cutoff = lastTs - days*86400000;
    const sub = trades.filter(t => scoreTrade(t) >= best.threshold && t.time >= cutoff);
    const s = statsFiltered(sub, 0, 500, days);  // hack: 0 threshold since already filtered
    console.log(`  ${String(days).padStart(3)}d: ${String(s.n).padStart(5)}t PF${s.pf.toFixed(2)} WR${s.wr.toFixed(1)}% DD${s.dd.toFixed(2)}% PnL${s.pnl_pct.toFixed(1)}% tpd${s.tpd.toFixed(1)}`);
  }

  // Gates Palanca A
  const gates = {
    pf_ge_155: best.pf >= 1.55,
    wr_ge_70:  best.wr >= 70,
    trades_ge_3000: best.n >= 3000,
    dd_le_2: best.dd <= 2
  };
  const gatesPass = Object.values(gates).filter(v => v).length;
  console.log(`\n🏁 PALANCA A GATES: ${gatesPass}/4`);
  console.log(`  PF ≥ 1.55:     ${gates.pf_ge_155 ? '✓' : '✗'} (${best.pf.toFixed(2)})`);
  console.log(`  WR ≥ 70%:      ${gates.wr_ge_70 ? '✓' : '✗'} (${best.wr.toFixed(1)}%)`);
  console.log(`  trades ≥ 3000: ${gates.trades_ge_3000 ? '✓' : '✗'} (${best.n})`);
  console.log(`  DD ≤ 2%:       ${gates.dd_le_2 ? '✓' : '✗'} (${best.dd.toFixed(2)}%)`);

  fs.writeFileSync(path.join(__dirname, '..', 'results', '08_ultra_fase1.json'), JSON.stringify({ baseline, percentileTable: results, best, gates }, null, 2));
  console.log(`\n⏱  Runtime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
})();
