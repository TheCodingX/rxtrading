#!/usr/bin/env node
'use strict';
// FASE 4 — Full validation: holdout + training split + stress test
// Winner config: M1+M2 (z-sizing + multi-window). Skip M3/M4/M6/M7 (net-negative or overly strict).
const fs=require('fs');const path=require('path');
const X = require('./apex_x_engine.js');
const E = require('./apex_elite_engine.js');

const PAIRS = ['ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT','SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'];

function loadFrom(dir){
  const out = {};
  for (const pair of PAIRS) {
    const b1m = X.load1m(pair, dir) || [];
    if (b1m.length < 10000) continue;
    out[pair] = { b1h: X.aggTF(b1m, 60) };
  }
  return out;
}

function filterPeriod(trades, endTs, days){
  const cutoff = endTs - days*86400000;
  const sub = trades.filter(t => t.time >= cutoff);
  return E.computeStats(sub, 500, days);
}

(function main() {
  const t0 = Date.now();
  console.log('═'.repeat(80));
  console.log('APEX ELITE — FASE 4 Full Validation');
  console.log('═'.repeat(80));

  // Training data: 2025-07 → 2026-03
  console.log('\n[A] TRAINING dataset (2025-07 → 2026-03)...');
  const train = loadFrom('/tmp/binance-klines-1m');
  const trainTs = Math.max(...Object.values(train).map(d => d.b1h[d.b1h.length-1].t));
  const trainSpan = Math.floor((trainTs - Math.min(...Object.values(train).map(d => d.b1h[0].t))) / 86400000);

  const eliteCfg = { m1_zsizing:true, m2_multiwin:true };
  const baselineCfg = {};

  const trainBase = E.runEliteOnData(train, PAIRS, { stages: baselineCfg });
  const trainElite = E.runEliteOnData(train, PAIRS, { stages: eliteCfg });
  const sTrainBase = E.computeStats(trainBase, 500, trainSpan);
  const sTrainElite = E.computeStats(trainElite, 500, trainSpan);
  console.log(`  BASELINE:  ${sTrainBase.n}t PF${sTrainBase.pf.toFixed(2)} WR${sTrainBase.wr.toFixed(1)}% DD${sTrainBase.dd_pct.toFixed(2)}% t/d${sTrainBase.tpd.toFixed(1)} PnL${sTrainBase.pnl_pct.toFixed(1)}% Sh${sTrainBase.sharpe.toFixed(2)}`);
  console.log(`  ELITE:     ${sTrainElite.n}t PF${sTrainElite.pf.toFixed(2)} WR${sTrainElite.wr.toFixed(1)}% DD${sTrainElite.dd_pct.toFixed(2)}% t/d${sTrainElite.tpd.toFixed(1)} PnL${sTrainElite.pnl_pct.toFixed(1)}% Sh${sTrainElite.sharpe.toFixed(2)}`);

  // Holdout data: 2024-07 → 2025-06 (NEVER SEEN)
  console.log('\n[B] HOLDOUT dataset (2024-07 → 2025-06, never seen by base design)...');
  const hold = loadFrom('/tmp/binance-klines-1m-holdout');
  const holdTs = Math.max(...Object.values(hold).map(d => d.b1h[d.b1h.length-1].t));
  const holdFirstTs = Math.min(...Object.values(hold).map(d => d.b1h[0].t));
  const holdSpan = Math.floor((holdTs - holdFirstTs) / 86400000);
  const holdBase = E.runEliteOnData(hold, PAIRS, { stages: baselineCfg });
  const holdElite = E.runEliteOnData(hold, PAIRS, { stages: eliteCfg });
  const sHoldBase = E.computeStats(holdBase, 500, holdSpan);
  const sHoldElite = E.computeStats(holdElite, 500, holdSpan);
  console.log(`  BASELINE:  ${sHoldBase.n}t PF${sHoldBase.pf.toFixed(2)} WR${sHoldBase.wr.toFixed(1)}% DD${sHoldBase.dd_pct.toFixed(2)}% t/d${sHoldBase.tpd.toFixed(1)} PnL${sHoldBase.pnl_pct.toFixed(1)}% Sh${sHoldBase.sharpe.toFixed(2)}`);
  console.log(`  ELITE:     ${sHoldElite.n}t PF${sHoldElite.pf.toFixed(2)} WR${sHoldElite.wr.toFixed(1)}% DD${sHoldElite.dd_pct.toFixed(2)}% t/d${sHoldElite.tpd.toFixed(1)} PnL${sHoldElite.pnl_pct.toFixed(1)}% Sh${sHoldElite.sharpe.toFixed(2)}`);

  // [C] PERIOD BREAKDOWN on training (most recent)
  console.log('\n[C] ELITE on TRAINING, period breakdown:');
  for (const d of [7,30,60,120,273]) {
    const s = filterPeriod(trainElite, trainTs, d);
    console.log(`   ${String(d).padStart(3)}d: ${String(s.n).padStart(4)}t PF${s.pf.toFixed(2)} WR${s.wr.toFixed(1)}% DD${s.dd_pct.toFixed(2)}% t/d${s.tpd.toFixed(1)} PnL${s.pnl_pct.toFixed(1)}% Sh${s.sharpe.toFixed(2)}`);
  }

  // [D] STRESS TESTS: events
  const events = [
    { name: 'Aug 2024 flash crash', start: Date.UTC(2024,7,3), end: Date.UTC(2024,7,10) },
    { name: 'Nov 2024 rally peak', start: Date.UTC(2024,10,1), end: Date.UTC(2024,10,21) },
    { name: 'Feb 2025 pullback', start: Date.UTC(2025,1,10), end: Date.UTC(2025,1,28) },
    { name: 'Mar 2026 chop', start: Date.UTC(2026,2,1), end: Date.UTC(2026,2,31) }
  ];
  console.log('\n[D] STRESS TESTS:');
  const allTradesCombined = [...holdElite, ...trainElite];
  for (const ev of events) {
    const sub = allTradesCombined.filter(t => t.time >= ev.start && t.time <= ev.end);
    const days = (ev.end - ev.start) / 86400000;
    const s = E.computeStats(sub, 500, days || 1);
    const ok = s.dd_pct <= 6 ? '✓' : '✗';
    console.log(`  ${ev.name.padEnd(28)}: ${String(s.n).padStart(3)}t PF${s.pf.toFixed(2)} WR${s.wr.toFixed(1)}% DD${s.dd_pct.toFixed(2)}% PnL${s.pnl_pct.toFixed(2)}% ${ok}`);
  }

  // [E] GATES evaluation
  console.log('\n═══ GATE EVALUATION (ELITE) ═══');
  const p120Train = filterPeriod(trainElite, trainTs, 120);
  const p60Train = filterPeriod(trainElite, trainTs, 60);
  const p30Train = filterPeriod(trainElite, trainTs, 30);
  const p7Train = filterPeriod(trainElite, trainTs, 7);

  const gates = {
    walkforward_wr: { target: '≥70%', actual: sTrainElite.wr.toFixed(1)+'%', pass: sTrainElite.wr >= 70 },
    walkforward_pf: { target: '≥1.50', actual: sTrainElite.pf.toFixed(2), pass: sTrainElite.pf >= 1.50 },
    walkforward_dd: { target: '≤3%', actual: sTrainElite.dd_pct.toFixed(2)+'%', pass: sTrainElite.dd_pct <= 3 },
    walkforward_tpd: { target: '≥12', actual: sTrainElite.tpd.toFixed(1), pass: sTrainElite.tpd >= 12 },
    pnl_120d: { target: '≥20%', actual: p120Train.pnl_pct.toFixed(1)+'%', pass: p120Train.pnl_pct >= 20 },
    holdout_wr: { target: '≥65%', actual: sHoldElite.wr.toFixed(1)+'%', pass: sHoldElite.wr >= 65 },
    holdout_pf: { target: '≥1.35', actual: sHoldElite.pf.toFixed(2), pass: sHoldElite.pf >= 1.35 },
    holdout_dd: { target: '≤5%', actual: sHoldElite.dd_pct.toFixed(2)+'%', pass: sHoldElite.dd_pct <= 5 },
    holdout_tpd: { target: '≥10', actual: sHoldElite.tpd.toFixed(1), pass: sHoldElite.tpd >= 10 },
    all_periods_positive: { target: 'all+', actual: [p7Train,p30Train,p60Train,p120Train].every(p => p.pnl_pct > -0.1) ? 'YES' : 'NO', pass: [p7Train,p30Train,p60Train,p120Train].every(p => p.pnl_pct > -0.1) }
  };
  const passCount = Object.values(gates).filter(g => g.pass).length;
  const totalGates = Object.keys(gates).length;
  for (const [k,v] of Object.entries(gates)) {
    console.log(`  ${k.padEnd(28)} target ${v.target.padEnd(8)}  actual ${v.actual.padStart(10)}  ${v.pass ? '✓ PASS' : '✗ FAIL'}`);
  }
  console.log(`\n🏁 GATES PASSED: ${passCount}/${totalGates}`);
  console.log(`📊 ELITE vs BASELINE (training):`);
  console.log(`   PF:  ${sTrainBase.pf.toFixed(2)} → ${sTrainElite.pf.toFixed(2)}  (Δ${(sTrainElite.pf-sTrainBase.pf>=0?'+':'')+(sTrainElite.pf-sTrainBase.pf).toFixed(2)})`);
  console.log(`   WR:  ${sTrainBase.wr.toFixed(1)}% → ${sTrainElite.wr.toFixed(1)}%  (Δ${(sTrainElite.wr-sTrainBase.wr>=0?'+':'')+(sTrainElite.wr-sTrainBase.wr).toFixed(1)}pp)`);
  console.log(`   t/d: ${sTrainBase.tpd.toFixed(1)} → ${sTrainElite.tpd.toFixed(1)}  (Δ${(sTrainElite.tpd-sTrainBase.tpd>=0?'+':'')+(sTrainElite.tpd-sTrainBase.tpd).toFixed(1)})`);
  console.log(`   PnL: ${sTrainBase.pnl_pct.toFixed(1)}% → ${sTrainElite.pnl_pct.toFixed(1)}%  (Δ${(sTrainElite.pnl_pct-sTrainBase.pnl_pct>=0?'+':'')+(sTrainElite.pnl_pct-sTrainBase.pnl_pct).toFixed(1)}pp)`);

  // Verdict
  const verdict = passCount >= 9 ? '✅ DEPLOY ELITE (9+/10 gates pass)' :
                  passCount >= 7 ? '🟡 DEPLOY with warnings (7-8/10 gates pass)' :
                  '❌ KEEP BASELINE (<7/10 gates pass)';
  console.log(`\n${verdict}`);

  const report = {
    runtime_s: (Date.now()-t0)/1000,
    training: { baseline: sTrainBase, elite: sTrainElite, span_d: trainSpan },
    holdout: { baseline: sHoldBase, elite: sHoldElite, span_d: holdSpan },
    periods_elite: {
      p7: p7Train, p30: p30Train, p60: p60Train, p120: p120Train
    },
    gates,
    gates_passed: `${passCount}/${totalGates}`,
    verdict
  };
  fs.writeFileSync(path.join(__dirname, '..', 'results', '07_elite_holdout.json'), JSON.stringify(report, null, 2));
  console.log(`\n⏱  Runtime: ${report.runtime_s.toFixed(1)}s`);
})();
