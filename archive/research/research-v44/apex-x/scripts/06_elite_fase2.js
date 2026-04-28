#!/usr/bin/env node
'use strict';
// FASE 2 — APEX ELITE: M1+M2 base + term structure + OI proxy filters
// Skip M3 (dyn TP/SL) — hurt WR in FASE 1
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

function periodStats(trades, endTs, days){
  const cutoff = endTs - days*86400000;
  const sub = trades.filter(t => t.time >= cutoff);
  return E.computeStats(sub, 500, days);
}

(function main() {
  const t0 = Date.now();
  console.log('═'.repeat(80));
  console.log('APEX ELITE — FASE 2 (M1+M2 + optional filters M4/M6/M7)');
  console.log('═'.repeat(80));

  const allData = load();
  const lastTs = Math.max(...Object.values(allData).map(d => d.b1h[d.b1h.length-1].t));
  const firstTs = Math.min(...Object.values(allData).map(d => d.b1h[0].t));
  const totalDays = Math.floor((lastTs - firstTs) / 86400000);
  console.log(`  ${Object.keys(allData).length} pairs · ${new Date(firstTs).toISOString().slice(0,10)} → ${new Date(lastTs).toISOString().slice(0,10)} (${totalDays}d)\n`);

  const configs = [
    { name: 'Baseline V44', stages: {} },
    { name: 'M1+M2 (FASE 1 clean)', stages: { m1_zsizing:true, m2_multiwin:true } },
    { name: 'M1+M2+M4 (+ term structure)', stages: { m1_zsizing:true, m2_multiwin:true, m4_termstruct:true } },
    { name: 'M1+M2+M6 (+ OI proxy)', stages: { m1_zsizing:true, m2_multiwin:true, m6_oifilter:true } },
    { name: 'M1+M2+M4+M6 (dual filter)', stages: { m1_zsizing:true, m2_multiwin:true, m4_termstruct:true, m6_oifilter:true } },
    { name: 'M1+M2+M4+M6+M7 (+ momentum exit)', stages: { m1_zsizing:true, m2_multiwin:true, m4_termstruct:true, m6_oifilter:true, m7_momexit:true } },
  ];

  const results = [];
  for (const cfg of configs) {
    const trades = E.runEliteOnData(allData, PAIRS, { stages: cfg.stages });
    const full = E.computeStats(trades, 500, totalDays);
    const p120 = periodStats(trades, lastTs, 120);
    const p60 = periodStats(trades, lastTs, 60);
    const p30 = periodStats(trades, lastTs, 30);
    const p7 = periodStats(trades, lastTs, 7);
    results.push({ cfg: cfg.name, full, p120, p60, p30, p7 });
    console.log(`${cfg.name}:`);
    console.log(`  FULL ${totalDays}d: ${full.n}t PF${full.pf.toFixed(2)} WR${full.wr.toFixed(1)}% DD${full.dd_pct.toFixed(2)}% t/d${full.tpd.toFixed(1)} PnL${full.pnl_pct.toFixed(1)}%`);
    console.log(`   7d: ${String(p7.n).padStart(4)}t PF${p7.pf.toFixed(2)} WR${p7.wr.toFixed(1)}% t/d${p7.tpd.toFixed(1)} PnL${p7.pnl_pct.toFixed(2)}%`);
    console.log(`  30d: ${String(p30.n).padStart(4)}t PF${p30.pf.toFixed(2)} WR${p30.wr.toFixed(1)}% t/d${p30.tpd.toFixed(1)} PnL${p30.pnl_pct.toFixed(2)}%`);
    console.log(`  60d: ${String(p60.n).padStart(4)}t PF${p60.pf.toFixed(2)} WR${p60.wr.toFixed(1)}% t/d${p60.tpd.toFixed(1)} PnL${p60.pnl_pct.toFixed(2)}%`);
    console.log(` 120d: ${String(p120.n).padStart(4)}t PF${p120.pf.toFixed(2)} WR${p120.wr.toFixed(1)}% t/d${p120.tpd.toFixed(1)} PnL${p120.pnl_pct.toFixed(2)}%`);
    console.log('');
  }

  // Find best config by multi-gate composite
  function score(r) {
    const full = r.full;
    const allPeriodsPositive = [r.p7, r.p30, r.p60, r.p120].every(p => p.pnl_pct > -0.5);
    return {
      wr_ok: full.wr >= 70,
      pf_ok: full.pf >= 1.50,
      dd_ok: full.dd_pct <= 3,
      tpd_ok: full.tpd >= 12,
      pnl_ok: full.pnl_pct >= 20,
      allPeriodsPositive,
      totalGates: [full.wr >= 70, full.pf >= 1.50, full.dd_pct <= 3, full.tpd >= 12, full.pnl_pct >= 20, allPeriodsPositive].filter(v=>v).length
    };
  }

  console.log('╔' + '═'.repeat(78) + '╗');
  console.log('║ GATE ANALYSIS — ELITE targets: WR≥70, PF≥1.50, DD≤3%, t/d≥12, PnL≥20% ║');
  console.log('╚' + '═'.repeat(78) + '╝');
  for (const r of results) {
    const s = score(r);
    const marks = [
      s.wr_ok ? '✓' : '✗',
      s.pf_ok ? '✓' : '✗',
      s.dd_ok ? '✓' : '✗',
      s.tpd_ok ? '✓' : '✗',
      s.pnl_ok ? '✓' : '✗',
      s.allPeriodsPositive ? '✓' : '✗'
    ];
    console.log(`  ${r.cfg.padEnd(42)}  WR${marks[0]} PF${marks[1]} DD${marks[2]} t/d${marks[3]} PnL${marks[4]} All+${marks[5]}  (${s.totalGates}/6)`);
  }

  fs.writeFileSync(path.join(__dirname, '..', 'results', '06_elite_fase2.json'), JSON.stringify(results, null, 2));
  console.log(`\n⏱  Runtime: ${((Date.now()-t0)/1000).toFixed(1)}s`);
})();
