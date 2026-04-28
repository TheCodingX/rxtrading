#!/usr/bin/env node
'use strict';
// FASE 2 Palanca B — Leverage sweep on Palanca A (top 40% quality filter)
// Test 1.0x / 1.5x / 2.0x / 2.5x / 3.0x / 3.5x. Pick sweet spot: DD ≤ 5%, no liquidation.
const fs=require('fs');const path=require('path');
const X = require('./apex_x_engine.js');
const E = require('./apex_elite_engine.js');

const PAIRS = ['ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT','SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'];
const QUALITY_THRESHOLD = 1.101; // top 40% from Palanca A
const INIT_CAP = 500;

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
  const zAbs = Math.abs(t.zscore || 0);
  const ww = t.windowType === 'MID' ? 1.0 : (t.windowType === 'PRE' ? 0.85 : 0.75);
  return zAbs * ww;
}

// Simulate leverage scaling on trade list (amplify pnl and size; check margin/liquidation)
function applyLeverage(trades, leverage, cap = INIT_CAP) {
  let capCur = cap;
  const out = [];
  let maxMarginUtil = 0;
  let worstTradeLoss = 0;
  let liquidationEvents = 0;
  let peakCap = cap;
  let maxDD = 0;

  for (const t of trades) {
    // Amplified PnL: original pnl uses size=cap×SIZE_PCT×mult. With leverage, we pay LEVERAGE× that notional.
    // PnL % stays same per trade (from price move), but NOTIONAL is L× larger.
    // So amplified PnL = t.pnl × L
    const amplifiedPnl = t.pnl * leverage;

    // Margin utilization: size × leverage represents exposure. Margin required = size (cash at risk)
    const marginUsed = (t.size || cap * 0.1) * leverage;
    const marginUtil = marginUsed / capCur;
    if (marginUtil > maxMarginUtil) maxMarginUtil = marginUtil;

    // Worst single-trade loss as % of capital
    if (amplifiedPnl < 0) {
      const lossPct = Math.abs(amplifiedPnl) / capCur * 100;
      if (lossPct > worstTradeLoss) worstTradeLoss = lossPct;
      // Liquidation check: single loss > 50% of capital = effective liquidation
      if (lossPct > 50) liquidationEvents++;
    }

    capCur += amplifiedPnl;
    if (capCur > peakCap) peakCap = capCur;
    const dd = (peakCap - capCur) / peakCap * 100;
    if (dd > maxDD) maxDD = dd;

    out.push({...t, ampPnl: amplifiedPnl, cap: capCur});
  }

  const wins = out.filter(t => t.ampPnl > 0);
  const losses = out.filter(t => t.ampPnl <= 0);
  const gw = wins.reduce((s,t) => s + t.ampPnl, 0);
  const gl = Math.abs(losses.reduce((s,t) => s + t.ampPnl, 0));
  const pnl = gw - gl;

  return {
    n: out.length,
    pf: gl > 0 ? gw/gl : (gw>0?99:0),
    wr: wins.length / out.length * 100,
    maxDD_pct: maxDD,
    pnl, pnl_pct: pnl / cap * 100,
    marginUtilMax: maxMarginUtil * 100,
    worstTradeLossPct: worstTradeLoss,
    liquidationEvents,
    finalCap: capCur
  };
}

(function main() {
  const t0 = Date.now();
  console.log('═'.repeat(80));
  console.log('APEX ULTRA — FASE 2 Palanca B (Leverage Sweep)');
  console.log('═'.repeat(80));

  const allData = load();
  const lastTs = Math.max(...Object.values(allData).map(d => d.b1h[d.b1h.length-1].t));
  const firstTs = Math.min(...Object.values(allData).map(d => d.b1h[0].t));
  const totalDays = Math.floor((lastTs - firstTs) / 86400000);

  console.log('\n[1/3] Run ELITE + apply quality filter (top 40%, thr 1.101)...');
  const allTrades = E.runEliteOnData(allData, PAIRS, { stages: { m1_zsizing:true, m2_multiwin:true } });
  const qualityTrades = allTrades.filter(t => scoreTrade(t) >= QUALITY_THRESHOLD);
  console.log(`  ${allTrades.length} → ${qualityTrades.length} trades after filter`);

  console.log('\n[2/3] Leverage sweep (1.0x-3.5x):');
  const leverages = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5];
  const results = [];
  console.log('  Lev  │ Trades │  PF  │  WR  │  DD   │  PnL   │ MgnUtil│ WorstT │ Liq │ Status');
  console.log('  ─────┼────────┼──────┼──────┼───────┼────────┼────────┼────────┼─────┼────────');
  for (const lev of leverages) {
    const s = applyLeverage(qualityTrades, lev);
    results.push({ leverage: lev, ...s });
    const status = s.maxDD_pct <= 5 && s.marginUtilMax <= 60 && s.worstTradeLossPct <= 2 && s.liquidationEvents === 0 ? '✓ OK' : '✗ FAIL';
    console.log(`  ${lev.toFixed(1).padStart(4)}x│ ${String(s.n).padStart(6)} │ ${s.pf.toFixed(2).padStart(4)} │ ${s.wr.toFixed(1).padStart(4)}%│ ${s.maxDD_pct.toFixed(2).padStart(4)}% │ ${s.pnl_pct.toFixed(1).padStart(6)}%│ ${s.marginUtilMax.toFixed(1).padStart(6)}%│ ${s.worstTradeLossPct.toFixed(2).padStart(5)}%│ ${String(s.liquidationEvents).padStart(3)} │ ${status}`);
  }

  console.log('\n[3/3] Sweet spot selection:');
  const viable = results.filter(s => s.maxDD_pct <= 5 && s.marginUtilMax <= 60 && s.worstTradeLossPct <= 2 && s.liquidationEvents === 0);
  console.log(`  Viable configs (DD≤5%, Margin≤60%, WorstT≤2%, 0 liq): ${viable.length}`);
  const best = viable.length ? viable.reduce((a,b) => b.pnl_pct > a.pnl_pct ? b : a) : null;
  if (best) {
    console.log(`  ✅ CHOSEN: Leverage ${best.leverage}x`);
    console.log(`     ${best.n}t PF${best.pf.toFixed(2)} WR${best.wr.toFixed(1)}% DD${best.maxDD_pct.toFixed(2)}% PnL${best.pnl_pct.toFixed(1)}%`);

    // Period breakdown on chosen leverage
    console.log('\n  Period breakdown on chosen leverage:');
    for (const days of [7, 30, 60, 120]) {
      const cutoff = lastTs - days*86400000;
      const sub = qualityTrades.filter(t => t.time >= cutoff);
      const s = applyLeverage(sub, best.leverage);
      console.log(`    ${String(days).padStart(3)}d: ${String(s.n).padStart(5)}t PF${s.pf.toFixed(2)} WR${s.wr.toFixed(1)}% DD${s.maxDD_pct.toFixed(2)}% PnL${s.pnl_pct.toFixed(1)}% tpd${(s.n/days).toFixed(1)}`);
    }
  } else {
    console.log(`  ❌ No viable leverage found within risk constraints`);
  }

  fs.writeFileSync(path.join(__dirname, '..', 'results', '09_ultra_fase2_leverage.json'), JSON.stringify({ quality_threshold: QUALITY_THRESHOLD, sweep: results, chosen: best }, null, 2));
  console.log(`\n⏱  Runtime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
})();
