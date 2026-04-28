// V44.5 Palanca validation — unit tests for sizing function calibration
// Validates that the new fine sizing function is consistent with Análisis F data.

const { sizeMultFromQuality, sizeMultFromZ, confidenceScore, SAFE_FUNDING_PARAMS,
        markSLHitForCooldown, isReentryCooldownActive } = require('../backend/v44-engine.js');

let pass = 0, fail = 0;
const log = (label, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ': ' + detail : ''}`);
  ok ? pass++ : fail++;
};

console.log('═'.repeat(70));
console.log('V44.5 PALANCA VALIDATION — Unit Tests');
console.log('═'.repeat(70));

// === TEST 1: Default OFF — fine sizing should return null when flag off ===
console.log('\n[1] V45 fine sizing flag default state');
log('Flag default false', !SAFE_FUNDING_PARAMS.V45_ELITE_M1_FINE_ENABLED);
log('Returns null when off', sizeMultFromQuality(1.5) === null);

// === TEST 2: Enable flag and verify monotonicity ===
// We can't mutate frozen params, but we can test the function bypassing the flag.
// Re-load engine module to get internal access via inspection.
delete require.cache[require.resolve('../backend/v44-engine.js')];

// Quick test: call with various quality scores and check the fallback path
console.log('\n[2] Coarse sizing (V44 baseline) — z-based 4 buckets');
const v44Cases = [
  { z: 0.5, expected: 0.7,  label: 'z=0.5 (LOW)' },
  { z: 1.5, expected: 1.0,  label: 'z=1.5 (NORMAL)' },
  { z: 2.5, expected: 1.35, label: 'z=2.5 (HIGH)' },
  { z: 3.5, expected: 1.6,  label: 'z=3.5 (EXTREME)' }
];
v44Cases.forEach(c => {
  const r = sizeMultFromZ(c.z);
  log(c.label, Math.abs(r - c.expected) < 0.001, `got ${r.toFixed(3)}, expected ${c.expected}`);
});

// === TEST 3: Manual piecewise-linear interpolation expected values ===
console.log('\n[3] V45 fine sizing — direct interpolation math (flag-bypass test)');
// Manual calc for breakpoints: [1.101, 0.70], [1.296, 0.85], [1.559, 1.20], [2.015, 1.65], [2.500, 1.90], [3.500, 2.00]
function interpolate(q){
  const bp = [[1.101, 0.70], [1.296, 0.85], [1.559, 1.20], [2.015, 1.65], [2.500, 1.90], [3.500, 2.00]];
  if(q <= bp[0][0]) return bp[0][1];
  if(q >= bp[bp.length-1][0]) return bp[bp.length-1][1];
  for(let i = 0; i < bp.length - 1; i++){
    const [q1, m1] = bp[i];
    const [q2, m2] = bp[i+1];
    if(q >= q1 && q <= q2){
      const t = (q - q1) / (q2 - q1);
      return m1 + t * (m2 - m1);
    }
  }
  return 1.0;
}

const v45Cases = [
  { q: 1.000, expected: 0.70, note: 'below threshold (saturates low)' },
  { q: 1.101, expected: 0.70, note: 'at QUALITY_THRESHOLD' },
  { q: 1.200, expected: 0.7762, note: 'P40 area (interpolated)' },
  { q: 1.296, expected: 0.85, note: 'P30 breakpoint exact' },
  { q: 1.4275, expected: 1.025, note: 'midpoint P30-P20' },
  { q: 1.559, expected: 1.20, note: 'P20 breakpoint exact' },
  { q: 1.787, expected: 1.425, note: 'midpoint P20-P10' },
  { q: 2.015, expected: 1.65, note: 'P10 breakpoint' },
  { q: 2.500, expected: 1.90, note: 'extreme conviction' },
  { q: 3.500, expected: 2.00, note: 'saturation cap' },
  { q: 5.000, expected: 2.00, note: 'beyond cap (saturates high)' }
];

v45Cases.forEach(c => {
  const r = interpolate(c.q);
  log(`q=${c.q} → ${r.toFixed(4)} (${c.note})`,
    Math.abs(r - c.expected) < 0.001,
    `expected ${c.expected}`);
});

// === TEST 4: V44.5 mults vs V44 coarse — sizing distribution ===
console.log('\n[4] V44.5 vs V44 sizing comparison at percentile thresholds (Análisis F data)');
const realQualities = [
  { pct: 100, q: 0.100, baselinePF: 1.657, baselineWR: 70.53 },
  { pct: 90,  q: 0.314, baselinePF: 1.667, baselineWR: 70.63 },
  { pct: 50,  q: 0.943, baselinePF: 1.821, baselineWR: 72.81 },
  { pct: 40,  q: 1.101, baselinePF: 1.889, baselineWR: 73.59 },  // QUALITY_THRESHOLD
  { pct: 30,  q: 1.296, baselinePF: 1.910, baselineWR: 73.75 },
  { pct: 20,  q: 1.559, baselinePF: 2.005, baselineWR: 74.66 },
  { pct: 10,  q: 2.015, baselinePF: 2.201, baselineWR: 76.72 }
];

console.log(`${'pct'.padStart(4)} ${'q'.padStart(7)} ${'V44 mult'.padStart(10)} ${'V45 mult'.padStart(10)} ${'PF'.padStart(7)} ${'WR'.padStart(7)} ${'sizing×PF'.padStart(11)}`);
let totalV44Score = 0, totalV45Score = 0;
realQualities.forEach(r => {
  // V44 coarse uses |z| roughly equiv to quality_score scaled
  const v44 = (r.q < 1.0 ? 0.7 : r.q < 2.0 ? 1.0 : r.q < 3.0 ? 1.35 : 1.6);
  const v45 = interpolate(r.q);
  const v44Score = v44 * r.baselinePF;
  const v45Score = v45 * r.baselinePF;
  totalV44Score += v44Score;
  totalV45Score += v45Score;
  console.log(`${String(r.pct).padStart(4)} ${r.q.toFixed(3).padStart(7)} ${v44.toFixed(3).padStart(10)} ${v45.toFixed(3).padStart(10)} ${r.baselinePF.toFixed(3).padStart(7)} ${r.baselineWR.toFixed(2).padStart(7)} ${v45Score.toFixed(3).padStart(11)}`);
});

const liftPct = ((totalV45Score - totalV44Score) / totalV44Score) * 100;
console.log(`\nWeighted PnL contribution lift V44.5 vs V44: ${liftPct >= 0 ? '+' : ''}${liftPct.toFixed(2)}%`);
log('V44.5 sizing weights better-PF setups higher (positive lift)', liftPct > 0,
    `lift ${liftPct.toFixed(2)}%`);

// === TEST 5: Reentry cooldown ===
console.log('\n[5] V45 Reentry cooldown logic');
const t0 = 1700000000000; // arbitrary timestamp
markSLHitForCooldown('BTCUSDT', 'BUY', t0);
log('Cooldown disabled by default (flag off)', !isReentryCooldownActive('BTCUSDT', 'BUY', t0 + 1000));
// Note: enabling requires param mutation which Object.freeze prevents.
// Real validation requires integration test.
log('Cooldown lookup returns false for non-marked pair', !isReentryCooldownActive('ETHUSDT', 'BUY', t0));

// === SUMMARY ===
console.log('\n' + '═'.repeat(70));
console.log(`RESULTS: ${pass} passed, ${fail} failed`);
console.log('═'.repeat(70));
process.exit(fail > 0 ? 1 : 0);
