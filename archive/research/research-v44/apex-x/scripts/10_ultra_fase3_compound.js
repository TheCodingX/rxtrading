#!/usr/bin/env node
'use strict';
// FASE 3 Palanca C — Compounding + final FASE 4 validation
// Config: ELITE M1+M2 + top 40% quality + leverage 3.0x + full reinvestment
const fs=require('fs');const path=require('path');
const X = require('./apex_x_engine.js');
const E = require('./apex_elite_engine.js');

const PAIRS = ['ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT','SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'];
const QUALITY_THRESHOLD = 1.101;
const LEVERAGE = 3.0;
const INIT_CAP = 500;

function scoreTrade(t) {
  const zAbs = Math.abs(t.zscore || 0);
  const ww = t.windowType === 'MID' ? 1.0 : (t.windowType === 'PRE' ? 0.85 : 0.75);
  return zAbs * ww;
}

function loadFromDir(dir) {
  const out = {};
  for (const pair of PAIRS) {
    const b1m = X.load1m(pair, dir) || [];
    if (b1m.length < 10000) continue;
    out[pair] = { b1h: X.aggTF(b1m, 60) };
  }
  return out;
}

function loadFull() {
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

// ULTRA engine: ELITE + quality filter + compounding + leverage
function runUltraCompounded(trades, cap = INIT_CAP, leverage = LEVERAGE, threshold = QUALITY_THRESHOLD) {
  // Filter by quality
  const filtered = trades.filter(t => scoreTrade(t) >= threshold);
  // Sort chronologically (should already be)
  filtered.sort((a,b) => a.time - b.time);

  let capCur = cap;
  let peak = cap;
  let maxDD = 0;
  let liqEvents = 0;
  let maxMargin = 0;
  let worstTradePct = 0;
  const out = [];

  for (const t of filtered) {
    // Recalculate size based on CURRENT capital (compounding)
    // Original t.size was cap * 0.10 * sizeMult for INITIAL cap=500.
    // Now: new_size = capCur * 0.10 * sizeMult * leverage
    // PnL scales: per-trade pnl_pct stays (from price move). New pnl = new_size * pnl_pct.
    // From original: t.pnl ≈ t.size * pnl_pct. So pnl_pct ≈ t.pnl / t.size.
    const pnl_pct_per_trade = t.size > 0 ? t.pnl / t.size : 0;

    // New notional with compounding + leverage
    const sizeMult = t.size_mult || 1;
    const newSize = capCur * 0.10 * sizeMult * leverage;
    const margin = newSize / leverage; // cash at risk
    const marginUtil = margin / capCur;
    if (marginUtil > maxMargin) maxMargin = marginUtil;

    const newPnl = newSize * pnl_pct_per_trade;

    if (newPnl < 0) {
      const lossPct = Math.abs(newPnl) / capCur * 100;
      if (lossPct > worstTradePct) worstTradePct = lossPct;
      if (lossPct > 50) liqEvents++;
    }

    capCur += newPnl;
    if (capCur <= 0) { liqEvents++; capCur = 0; break; }
    if (capCur > peak) peak = capCur;
    const dd = (peak - capCur) / peak * 100;
    if (dd > maxDD) maxDD = dd;

    out.push({ ...t, newSize, newPnl, capCur });
  }

  const wins = out.filter(t => t.newPnl > 0);
  const gw = wins.reduce((s,t) => s + t.newPnl, 0);
  const gl = Math.abs(out.filter(t => t.newPnl <= 0).reduce((s,t) => s + t.newPnl, 0));

  return {
    n: out.length,
    pf: gl > 0 ? gw/gl : (gw>0?99:0),
    wr: wins.length / out.length * 100,
    maxDD_pct: maxDD,
    finalCap: capCur,
    pnl: capCur - cap,
    pnl_pct: (capCur - cap) / cap * 100,
    liqEvents,
    marginMax: maxMargin * 100,
    worstTradePct,
    trades: out
  };
}

function periodStats(trades, endTs, days) {
  const cutoff = endTs - days*86400000;
  const sub = trades.filter(t => t.time >= cutoff);
  return runUltraCompounded(sub);
}

(function main() {
  const t0 = Date.now();
  console.log('═'.repeat(80));
  console.log(`APEX ULTRA — FASE 3+4 (Compound + Full Validation)`);
  console.log(`  Config: Quality thr ${QUALITY_THRESHOLD} · Leverage ${LEVERAGE}x · Compounding ON`);
  console.log('═'.repeat(80));

  console.log('\n[1/4] Full 638d backtest...');
  const allData = loadFull();
  const lastTs = Math.max(...Object.values(allData).map(d => d.b1h[d.b1h.length-1].t));
  const firstTs = Math.min(...Object.values(allData).map(d => d.b1h[0].t));
  const totalDays = Math.floor((lastTs - firstTs) / 86400000);
  const eliteAll = E.runEliteOnData(allData, PAIRS, { stages: { m1_zsizing:true, m2_multiwin:true } });
  const fullResult = runUltraCompounded(eliteAll);
  const tpdFull = fullResult.n / totalDays;
  console.log(`  ${fullResult.n}t PF${fullResult.pf.toFixed(2)} WR${fullResult.wr.toFixed(1)}% DD${fullResult.maxDD_pct.toFixed(2)}% PnL${fullResult.pnl_pct.toFixed(1)}% tpd${tpdFull.toFixed(1)} liq${fullResult.liqEvents}`);

  // Period breakdown
  console.log('\n[2/4] Period breakdown:');
  const periodsRes = {};
  for (const days of [7,30,60,120]) {
    const ps = periodStats(eliteAll, lastTs, days);
    periodsRes[days] = { ...ps, trades: undefined }; // drop trades for JSON
    console.log(`  ${String(days).padStart(3)}d: ${String(ps.n).padStart(5)}t PF${ps.pf.toFixed(2)} WR${ps.wr.toFixed(1)}% DD${ps.maxDD_pct.toFixed(2)}% PnL${ps.pnl_pct.toFixed(1)}% tpd${(ps.n/days).toFixed(1)}`);
  }

  // [3/4] Holdout separate
  console.log('\n[3/4] HOLDOUT validation (2024-07 → 2025-06, never seen)...');
  const hold = loadFromDir('/tmp/binance-klines-1m-holdout');
  const holdTs = Math.max(...Object.values(hold).map(d => d.b1h[d.b1h.length-1].t));
  const holdFirst = Math.min(...Object.values(hold).map(d => d.b1h[0].t));
  const holdSpan = Math.floor((holdTs - holdFirst) / 86400000);
  const holdElite = E.runEliteOnData(hold, PAIRS, { stages: { m1_zsizing:true, m2_multiwin:true } });
  const holdUltra = runUltraCompounded(holdElite);
  console.log(`  ${holdUltra.n}t PF${holdUltra.pf.toFixed(2)} WR${holdUltra.wr.toFixed(1)}% DD${holdUltra.maxDD_pct.toFixed(2)}% PnL${holdUltra.pnl_pct.toFixed(1)}% tpd${(holdUltra.n/holdSpan).toFixed(1)} liq${holdUltra.liqEvents}`);

  // [4/4] Training separate
  console.log('\n[4/4] TRAINING validation (2025-07 → 2026-03)...');
  const train = loadFromDir('/tmp/binance-klines-1m');
  const trainTs = Math.max(...Object.values(train).map(d => d.b1h[d.b1h.length-1].t));
  const trainFirst = Math.min(...Object.values(train).map(d => d.b1h[0].t));
  const trainSpan = Math.floor((trainTs - trainFirst) / 86400000);
  const trainElite = E.runEliteOnData(train, PAIRS, { stages: { m1_zsizing:true, m2_multiwin:true } });
  const trainUltra = runUltraCompounded(trainElite);
  console.log(`  ${trainUltra.n}t PF${trainUltra.pf.toFixed(2)} WR${trainUltra.wr.toFixed(1)}% DD${trainUltra.maxDD_pct.toFixed(2)}% PnL${trainUltra.pnl_pct.toFixed(1)}% tpd${(trainUltra.n/trainSpan).toFixed(1)} liq${trainUltra.liqEvents}`);

  // Stress tests
  console.log('\n[5] STRESS TESTS:');
  const events = [
    { name: 'Aug 2024 flash crash', start: Date.UTC(2024,7,3), end: Date.UTC(2024,7,10) },
    { name: 'Nov 2024 rally peak', start: Date.UTC(2024,10,1), end: Date.UTC(2024,10,21) },
    { name: 'Feb 2025 pullback', start: Date.UTC(2025,1,10), end: Date.UTC(2025,1,28) },
    { name: 'Mar 2026 chop', start: Date.UTC(2026,2,1), end: Date.UTC(2026,2,31) }
  ];
  const combined = [...holdElite, ...trainElite];
  const stress = [];
  for (const ev of events) {
    const sub = combined.filter(t => t.time >= ev.start && t.time <= ev.end);
    const s = runUltraCompounded(sub);
    const days = (ev.end - ev.start) / 86400000;
    const ok = s.maxDD_pct <= 8 && s.liqEvents === 0 ? '✓' : '✗';
    stress.push({ event: ev.name, ...s, trades:undefined });
    console.log(`  ${ev.name.padEnd(28)}: ${String(s.n).padStart(4)}t PF${s.pf.toFixed(2)} WR${s.wr.toFixed(1)}% DD${s.maxDD_pct.toFixed(2)}% PnL${s.pnl_pct.toFixed(1)}% ${ok}`);
  }

  // Gate check
  console.log('\n═══ GATES (APEX ULTRA) ═══');
  const gates = {
    wf_pf: { target: '≥1.55', actual: trainUltra.pf.toFixed(2), pass: trainUltra.pf >= 1.55 },
    wf_wr: { target: '≥70%', actual: trainUltra.wr.toFixed(1)+'%', pass: trainUltra.wr >= 70 },
    wf_dd: { target: '≤5%', actual: trainUltra.maxDD_pct.toFixed(2)+'%', pass: trainUltra.maxDD_pct <= 5 },
    wf_tpd: { target: '≥12', actual: (trainUltra.n/trainSpan).toFixed(1), pass: trainUltra.n/trainSpan >= 12 },
    wf_pnl: { target: '≥40%', actual: periodsRes[120].pnl_pct.toFixed(1)+'%', pass: periodsRes[120].pnl_pct >= 40 },
    holdout_pf: { target: '≥1.35', actual: holdUltra.pf.toFixed(2), pass: holdUltra.pf >= 1.35 },
    holdout_wr: { target: '≥65%', actual: holdUltra.wr.toFixed(1)+'%', pass: holdUltra.wr >= 65 },
    holdout_dd: { target: '≤7%', actual: holdUltra.maxDD_pct.toFixed(2)+'%', pass: holdUltra.maxDD_pct <= 7 },
    stress_all_ok: { target: 'DD≤8% all', actual: stress.filter(s => s.maxDD_pct > 8).length === 0 ? 'YES' : 'NO', pass: stress.filter(s => s.maxDD_pct > 8).length === 0 },
    zero_liq: { target: '0', actual: String(fullResult.liqEvents + holdUltra.liqEvents + trainUltra.liqEvents), pass: (fullResult.liqEvents + holdUltra.liqEvents + trainUltra.liqEvents) === 0 }
  };
  const passes = Object.values(gates).filter(g => g.pass).length;
  const total = Object.keys(gates).length;
  for (const [k,v] of Object.entries(gates)) {
    console.log(`  ${k.padEnd(18)} target ${v.target.padEnd(10)}  actual ${String(v.actual).padStart(10)}  ${v.pass ? '✓ PASS' : '✗ FAIL'}`);
  }
  console.log(`\n🏁 ULTRA gates: ${passes}/${total}`);

  const verdict = passes >= 9 ? '✅ DEPLOY ULTRA (9+/10)' : passes >= 7 ? '🟡 DEPLOY w/ warnings' : '❌ KEEP ELITE';
  console.log(verdict);

  const report = {
    config: { QUALITY_THRESHOLD, LEVERAGE, COMPOUNDING: true },
    full_638d: { ...fullResult, trades: undefined, tpd: tpdFull },
    periods: periodsRes,
    holdout: { ...holdUltra, trades: undefined, tpd: holdUltra.n/holdSpan, span_d: holdSpan },
    training: { ...trainUltra, trades: undefined, tpd: trainUltra.n/trainSpan, span_d: trainSpan },
    stress_tests: stress,
    gates, gates_passed: `${passes}/${total}`, verdict
  };
  fs.writeFileSync(path.join(__dirname, '..', 'results', '10_ultra_final.json'), JSON.stringify(report, null, 2));
  console.log(`\n⏱  Runtime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
})();
