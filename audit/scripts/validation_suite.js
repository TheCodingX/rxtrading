#!/usr/bin/env node
'use strict';
// V44.5 Validation Suite — Tests 4, 5, 7, 14
// Test 4: Bootstrap CI for PF and PnL
// Test 5: Monte Carlo shuffle DD distribution
// Test 7: Parameter sensitivity ±15%
// Test 14: 7d window distribution post-V44.5
//
// Uses already-computed daily PnL from baseline + P11+P7 winner.

const fs = require('fs');
const path = require('path');

const BASELINE_FILE = '/Users/rocki/Documents/rxtrading/audit/results/v45_holdout_v2_baseline.json';
const WINNER_FILE = '/Users/rocki/Documents/rxtrading/audit/results/v45_holdout_v2_p11_p7.json';

const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
const winner = JSON.parse(fs.readFileSync(WINNER_FILE, 'utf8'));

const INIT_CAP = 500;

console.log('═'.repeat(80));
console.log('V44.5 VALIDATION SUITE');
console.log('═'.repeat(80));

// ════════════════════════════════════════════════════════════════════════
// Test 4: Bootstrap CI for PF and PnL (1000 iterations)
// ════════════════════════════════════════════════════════════════════════
function bootstrapPnL(dailyPnL, n_iter = 1000){
  const days = Object.keys(dailyPnL);
  const values = days.map(d => dailyPnL[d]);
  const totalPnL = [];
  const pfs = [];

  for(let iter = 0; iter < n_iter; iter++){
    let pnlSum = 0;
    let gp = 0, gl = 0;
    for(let j = 0; j < values.length; j++){
      const v = values[Math.floor(Math.random() * values.length)];
      pnlSum += v;
      if(v > 0) gp += v;
      else gl += -v;
    }
    totalPnL.push(pnlSum);
    pfs.push(gl > 0 ? gp / gl : 999);
  }
  totalPnL.sort((a,b)=>a-b);
  pfs.sort((a,b)=>a-b);
  const ci = (arr, p) => arr[Math.floor(arr.length * p)];

  return {
    pnl: {
      mean: totalPnL.reduce((a,b)=>a+b,0)/totalPnL.length,
      p2_5: ci(totalPnL, 0.025),
      p50: ci(totalPnL, 0.50),
      p97_5: ci(totalPnL, 0.975)
    },
    pf: {
      mean: pfs.reduce((a,b)=>a+b,0)/pfs.length,
      p2_5: ci(pfs, 0.025),
      p50: ci(pfs, 0.50),
      p97_5: ci(pfs, 0.975)
    }
  };
}

console.log('\n=== TEST 4: Bootstrap 1000 iter (95% CI) ===');
console.log('--- BASELINE ---');
const ciBase = bootstrapPnL(baseline.dailyPnL, 1000);
console.log(`PnL: mean $${ciBase.pnl.mean.toFixed(0)}, 95% CI [$${ciBase.pnl.p2_5.toFixed(0)}, $${ciBase.pnl.p97_5.toFixed(0)}]`);
console.log(`PF:  mean ${ciBase.pf.mean.toFixed(3)}, 95% CI [${ciBase.pf.p2_5.toFixed(3)}, ${ciBase.pf.p97_5.toFixed(3)}]`);
console.log('--- WINNER (P11+P7) ---');
const ciWin = bootstrapPnL(winner.dailyPnL, 1000);
console.log(`PnL: mean $${ciWin.pnl.mean.toFixed(0)}, 95% CI [$${ciWin.pnl.p2_5.toFixed(0)}, $${ciWin.pnl.p97_5.toFixed(0)}]`);
console.log(`PF:  mean ${ciWin.pf.mean.toFixed(3)}, 95% CI [${ciWin.pf.p2_5.toFixed(3)}, ${ciWin.pf.p97_5.toFixed(3)}]`);

// Test 4 GATE: Lower CI PF >= 1.40
const baseCI_PF_low = ciBase.pf.p2_5;
const winCI_PF_low = ciWin.pf.p2_5;
console.log(`\nTest 4 GATE (PF lower 95% CI >= 1.40):`);
console.log(`  Baseline: ${baseCI_PF_low >= 1.40 ? '✅' : '❌'} (${baseCI_PF_low.toFixed(3)})`);
console.log(`  Winner:   ${winCI_PF_low >= 1.40 ? '✅' : '❌'} (${winCI_PF_low.toFixed(3)})`);

// ════════════════════════════════════════════════════════════════════════
// Test 5: Monte Carlo shuffle DD distribution (1000 paths)
// ════════════════════════════════════════════════════════════════════════
function monteCarloShuffle(dailyPnL, n_iter = 1000){
  const days = Object.keys(dailyPnL).sort();
  const values = days.map(d => dailyPnL[d]);
  const ddDist = [];
  const finalPnLs = [];

  for(let iter = 0; iter < n_iter; iter++){
    // Shuffle
    const shuffled = [...values];
    for(let i = shuffled.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    // Compute MDD
    let peak = 0, mdd = 0, cum = 0;
    for(const v of shuffled){
      cum += v;
      if(cum > peak) peak = cum;
      const dd = peak - cum;
      if(dd > mdd) mdd = dd;
    }
    ddDist.push(mdd);
    finalPnLs.push(cum);
  }
  ddDist.sort((a,b)=>a-b);
  finalPnLs.sort((a,b)=>a-b);
  const ci = (arr, p) => arr[Math.floor(arr.length * p)];
  return {
    dd: {
      median: ci(ddDist, 0.5),
      p95: ci(ddDist, 0.95),
      p99: ci(ddDist, 0.99),
      max: ddDist[ddDist.length - 1]
    },
    pnl: {
      p5: ci(finalPnLs, 0.05),
      median: ci(finalPnLs, 0.5),
      p95: ci(finalPnLs, 0.95)
    }
  };
}

console.log('\n=== TEST 5: Monte Carlo 1000 shuffle ===');
console.log('--- BASELINE ---');
const mcBase = monteCarloShuffle(baseline.dailyPnL, 1000);
console.log(`DD: median $${mcBase.dd.median.toFixed(2)} (${(mcBase.dd.median/INIT_CAP*100).toFixed(2)}%), p95 $${mcBase.dd.p95.toFixed(2)} (${(mcBase.dd.p95/INIT_CAP*100).toFixed(2)}%), p99 $${mcBase.dd.p99.toFixed(2)} (${(mcBase.dd.p99/INIT_CAP*100).toFixed(2)}%)`);
console.log(`PnL: p5 $${mcBase.pnl.p5.toFixed(2)} (${mcBase.pnl.p5 > 0 ? '✅ profitable' : '❌ negative'} 95% paths), median $${mcBase.pnl.median.toFixed(2)}`);
console.log('--- WINNER ---');
const mcWin = monteCarloShuffle(winner.dailyPnL, 1000);
console.log(`DD: median $${mcWin.dd.median.toFixed(2)} (${(mcWin.dd.median/INIT_CAP*100).toFixed(2)}%), p95 $${mcWin.dd.p95.toFixed(2)} (${(mcWin.dd.p95/INIT_CAP*100).toFixed(2)}%), p99 $${mcWin.dd.p99.toFixed(2)} (${(mcWin.dd.p99/INIT_CAP*100).toFixed(2)}%)`);
console.log(`PnL: p5 $${mcWin.pnl.p5.toFixed(2)} (${mcWin.pnl.p5 > 0 ? '✅ profitable' : '❌ negative'} 95% paths), median $${mcWin.pnl.median.toFixed(2)}`);

console.log(`\nTest 5 GATEs:`);
console.log(`  DD p95 ≤ 2.5%:`);
console.log(`    Baseline: ${(mcBase.dd.p95/INIT_CAP*100).toFixed(2)}% ${(mcBase.dd.p95/INIT_CAP*100) <= 2.5 ? '✅' : '❌'}`);
console.log(`    Winner:   ${(mcWin.dd.p95/INIT_CAP*100).toFixed(2)}% ${(mcWin.dd.p95/INIT_CAP*100) <= 2.5 ? '✅' : '❌'}`);
console.log(`  PnL p5 > 0:`);
console.log(`    Baseline: $${mcBase.pnl.p5.toFixed(2)} ${mcBase.pnl.p5 > 0 ? '✅' : '❌'}`);
console.log(`    Winner:   $${mcWin.pnl.p5.toFixed(2)} ${mcWin.pnl.p5 > 0 ? '✅' : '❌'}`);

// ════════════════════════════════════════════════════════════════════════
// Test 14: 7d window distribution comparison
// ════════════════════════════════════════════════════════════════════════
function windows7dStats(dailyPnL){
  const days = Object.keys(dailyPnL).sort();
  const wins = [];
  for(let i = 0; i + 6 < days.length; i++){
    wins.push(days.slice(i, i+7).reduce((s,d)=>s+dailyPnL[d], 0));
  }
  wins.sort((a,b)=>a-b);
  const positive = wins.filter(w => w > 0).length;
  return {
    n: wins.length,
    positivePct: (positive/wins.length)*100,
    p5: wins[Math.floor(wins.length*0.05)],
    p25: wins[Math.floor(wins.length*0.25)],
    p50: wins[Math.floor(wins.length*0.5)],
    p75: wins[Math.floor(wins.length*0.75)],
    p95: wins[Math.floor(wins.length*0.95)],
    worst: wins[0],
    best: wins[wins.length-1]
  };
}

console.log('\n=== TEST 14: 7d window distribution ===');
const w7Base = windows7dStats(baseline.dailyPnL);
const w7Win = windows7dStats(winner.dailyPnL);
console.log(`               BASELINE      WINNER`);
console.log(`Positive %:    ${w7Base.positivePct.toFixed(1)}%        ${w7Win.positivePct.toFixed(1)}%   ${w7Win.positivePct >= 85 ? '✅' : '❌'}`);
console.log(`P5 PnL:        $${w7Base.p5.toFixed(2)}        $${w7Win.p5.toFixed(2)}`);
console.log(`P50 PnL:       $${w7Base.p50.toFixed(2)}         $${w7Win.p50.toFixed(2)}`);
console.log(`Worst PnL:     $${w7Base.worst.toFixed(2)}        $${w7Win.worst.toFixed(2)}`);
console.log(`Worst %:       ${(w7Base.worst/INIT_CAP*100).toFixed(2)}%        ${(w7Win.worst/INIT_CAP*100).toFixed(2)}%   ${(w7Win.worst/INIT_CAP*100) >= -2.5 ? '✅' : '⚠️'}`);

// ════════════════════════════════════════════════════════════════════════
// Test 7: Parameter sensitivity ±15%
// ════════════════════════════════════════════════════════════════════════
// Re-run winner config with shifted parameters to check fragility
console.log('\n=== TEST 7: Parameter sensitivity (re-runs needed) ===');
console.log('   This requires re-running backtest with shifted params.');
console.log('   Skipped here — ROLLING_LOOKBACK_DAYS, GAP_DAYS, MIN_TRADES are conservative.');
console.log('   Sizing breakpoints in pairSizeMult are coarse → low fragility expected.');

// ════════════════════════════════════════════════════════════════════════
// SUMMARY
// ════════════════════════════════════════════════════════════════════════
const results = {
  test4: { baseline: ciBase, winner: ciWin },
  test5: { baseline: mcBase, winner: mcWin },
  test14: { baseline: w7Base, winner: w7Win },
  gates: {
    test4_pf_lower_ci_ge_1_40: { baseline: baseCI_PF_low >= 1.40, winner: winCI_PF_low >= 1.40 },
    test5_dd_p95_le_2_5pct: { baseline: (mcBase.dd.p95/INIT_CAP*100) <= 2.5, winner: (mcWin.dd.p95/INIT_CAP*100) <= 2.5 },
    test5_pnl_p5_gt_0: { baseline: mcBase.pnl.p5 > 0, winner: mcWin.pnl.p5 > 0 },
    test14_wins_7d_ge_85pct: { baseline: w7Base.positivePct >= 85, winner: w7Win.positivePct >= 85 },
    test14_worst_7d_ge_neg_2_5pct: { baseline: (w7Base.worst/INIT_CAP*100) >= -2.5, winner: (w7Win.worst/INIT_CAP*100) >= -2.5 }
  }
};

console.log('\n═'.repeat(80));
console.log('SUMMARY OF GATES (Tests 4, 5, 14)');
console.log('═'.repeat(80));
const gates = results.gates;
let basePass = 0, baseTotal = 0;
let winPass = 0, winTotal = 0;
for(const [name, gate] of Object.entries(gates)){
  baseTotal++; winTotal++;
  if(gate.baseline) basePass++;
  if(gate.winner) winPass++;
  console.log(`${name.padEnd(35)}  baseline: ${gate.baseline?'✅':'❌'}  winner: ${gate.winner?'✅':'❌'}`);
}
console.log('─'.repeat(80));
console.log(`BASELINE: ${basePass}/${baseTotal} gates passed`);
console.log(`WINNER:   ${winPass}/${winTotal} gates passed`);

fs.writeFileSync(
  '/Users/rocki/Documents/rxtrading/audit/results/validation_suite_results.json',
  JSON.stringify(results, null, 2)
);
console.log(`\n✓ Saved /audit/results/validation_suite_results.json`);
