#!/usr/bin/env node
'use strict';
// FASE 1 — APEX ELITE: multi-window + confidence sizing + dynamic TP/SL
// Target intermedio: WR 70%, PF 1.45, t/d >=16, DD <2%
const fs=require('fs');const path=require('path');
const X = require('./apex_x_engine.js');
const E = require('./apex_elite_engine.js');

const PAIRS = ['ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT','SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'];

function load(days){
  const allData = {};
  for (const pair of PAIRS) {
    const b1m_h = X.load1m(pair, '/tmp/binance-klines-1m-holdout') || [];
    const b1m_t = X.load1m(pair, '/tmp/binance-klines-1m') || [];
    const merged = b1m_h.concat(b1m_t);
    if (merged.length < 10000) continue;
    merged.sort((a, b) => a[0] - b[0]);
    const seen = new Set();
    const uniq = [];
    for (const b of merged) { if (!seen.has(b[0])) { seen.add(b[0]); uniq.push(b); } }
    allData[pair] = { b1h: X.aggTF(uniq, 60) };
  }
  return allData;
}

function filterTradesPeriod(trades, endTs, days){
  const cutoff = endTs - days*86400000;
  return trades.filter(t => t.time >= cutoff);
}

(function main() {
  const t0 = Date.now();
  console.log('═'.repeat(80));
  console.log('APEX ELITE — FASE 1 ablation (multi-window + z-sizing + dynamic TP/SL)');
  console.log('═'.repeat(80));

  console.log('\n[1/5] Loading data...');
  const allData = load(0);
  console.log(`  ${Object.keys(allData).length}/${PAIRS.length} pairs loaded`);
  const lastTs = Math.max(...Object.values(allData).map(d => d.b1h[d.b1h.length-1].t));
  const firstTs = Math.min(...Object.values(allData).map(d => d.b1h[0].t));
  const totalDays = Math.floor((lastTs - firstTs) / 86400000);
  console.log(`  Range: ${new Date(firstTs).toISOString().slice(0,10)} → ${new Date(lastTs).toISOString().slice(0,10)} (${totalDays}d)`);

  console.log('\n[2/5] Baseline: V44 funding carry original (all off)...');
  const baseline = E.runEliteOnData(allData, PAIRS, { stages: { m1_zsizing:false, m2_multiwin:false, m3_dyntp:false, m4_termstruct:false, m6_oifilter:false, m7_momexit:false, m8_rotation:false } });
  const sBase = E.computeStats(baseline, 500, totalDays);
  console.log(`  Baseline: ${sBase.n}t PF${sBase.pf.toFixed(2)} WR${sBase.wr.toFixed(1)}% DD${sBase.dd_pct.toFixed(2)}% Sh${sBase.sharpe.toFixed(2)} t/d${sBase.tpd.toFixed(1)} PnL$${sBase.pnl.toFixed(0)}(${sBase.pnl_pct.toFixed(1)}%)`);

  console.log('\n[3/5] +M1 (confidence sizing)...');
  const m1 = E.runEliteOnData(allData, PAIRS, { stages: { m1_zsizing:true, m2_multiwin:false, m3_dyntp:false } });
  const sM1 = E.computeStats(m1, 500, totalDays);
  console.log(`  +M1: ${sM1.n}t PF${sM1.pf.toFixed(2)} WR${sM1.wr.toFixed(1)}% DD${sM1.dd_pct.toFixed(2)}% Sh${sM1.sharpe.toFixed(2)} t/d${sM1.tpd.toFixed(1)} PnL$${sM1.pnl.toFixed(0)}(${sM1.pnl_pct.toFixed(1)}%) Δpf${(sM1.pf-sBase.pf >= 0 ? '+' : '')+(sM1.pf-sBase.pf).toFixed(2)} Δpnl${(sM1.pnl_pct-sBase.pnl_pct >= 0 ? '+' : '')+(sM1.pnl_pct-sBase.pnl_pct).toFixed(1)}%`);

  console.log('\n[4/5] +M1+M2 (confidence sizing + multi-window)...');
  const m12 = E.runEliteOnData(allData, PAIRS, { stages: { m1_zsizing:true, m2_multiwin:true, m3_dyntp:false } });
  const sM12 = E.computeStats(m12, 500, totalDays);
  console.log(`  +M1+M2: ${sM12.n}t PF${sM12.pf.toFixed(2)} WR${sM12.wr.toFixed(1)}% DD${sM12.dd_pct.toFixed(2)}% Sh${sM12.sharpe.toFixed(2)} t/d${sM12.tpd.toFixed(1)} PnL$${sM12.pnl.toFixed(0)}(${sM12.pnl_pct.toFixed(1)}%) Δpf${(sM12.pf-sBase.pf >= 0 ? '+' : '')+(sM12.pf-sBase.pf).toFixed(2)} Δpnl${(sM12.pnl_pct-sBase.pnl_pct >= 0 ? '+' : '')+(sM12.pnl_pct-sBase.pnl_pct).toFixed(1)}%`);

  console.log('\n[5/5] +M1+M2+M3 (all FASE 1: + dynamic TP/SL)...');
  const m123 = E.runEliteOnData(allData, PAIRS, { stages: { m1_zsizing:true, m2_multiwin:true, m3_dyntp:true } });
  const sM123 = E.computeStats(m123, 500, totalDays);
  console.log(`  +M1+M2+M3: ${sM123.n}t PF${sM123.pf.toFixed(2)} WR${sM123.wr.toFixed(1)}% DD${sM123.dd_pct.toFixed(2)}% Sh${sM123.sharpe.toFixed(2)} t/d${sM123.tpd.toFixed(1)} PnL$${sM123.pnl.toFixed(0)}(${sM123.pnl_pct.toFixed(1)}%) Δpf${(sM123.pf-sBase.pf >= 0 ? '+' : '')+(sM123.pf-sBase.pf).toFixed(2)} Δpnl${(sM123.pnl_pct-sBase.pnl_pct >= 0 ? '+' : '')+(sM123.pnl_pct-sBase.pnl_pct).toFixed(1)}%`);

  // Period breakdown (7/30/60/120d from lastTs)
  console.log('\n══ PERIOD BREAKDOWN FOR FASE1 FINAL (M1+M2+M3) ══');
  for (const days of [7, 30, 60, 120]) {
    const sub = filterTradesPeriod(m123, lastTs, days);
    const s = E.computeStats(sub, 500, days);
    const goodPF = s.pf >= 1.45 ? '✓' : s.pf >= 1.20 ? '~' : '✗';
    console.log(`  ${days}d: ${String(s.n).padStart(4)}t PF${s.pf.toFixed(2)} WR${s.wr.toFixed(1)}% DD${s.dd_pct.toFixed(2)}% t/d${s.tpd.toFixed(1)} PnL${s.pnl_pct.toFixed(1)}% ${goodPF}`);
  }

  // Gate check FASE 1
  const gateFase1 = {
    wr_ge_70: sM123.wr >= 70,
    pf_ge_145: sM123.pf >= 1.45,
    tpd_ge_16: sM123.tpd >= 16,
    dd_le_2: sM123.dd_pct <= 2
  };
  const gatesPass = Object.values(gateFase1).filter(v=>v).length;
  console.log(`\n🏁 FASE 1 INTERMEDIATE GATES: ${gatesPass}/4`);
  console.log(`  WR ≥ 70:    ${gateFase1.wr_ge_70 ? '✓' : '✗'} (${sM123.wr.toFixed(1)}%)`);
  console.log(`  PF ≥ 1.45:  ${gateFase1.pf_ge_145 ? '✓' : '✗'} (${sM123.pf.toFixed(2)})`);
  console.log(`  t/d ≥ 16:   ${gateFase1.tpd_ge_16 ? '✓' : '✗'} (${sM123.tpd.toFixed(1)})`);
  console.log(`  DD ≤ 2%:    ${gateFase1.dd_le_2 ? '✓' : '✗'} (${sM123.dd_pct.toFixed(2)}%)`);

  const report = {
    runtime_s: (Date.now() - t0) / 1000,
    total_days: totalDays,
    ablation: [
      { stage: 'Baseline (V44)', ...sBase },
      { stage: '+M1 sizing', ...sM1 },
      { stage: '+M1+M2 multiwin', ...sM12 },
      { stage: '+M1+M2+M3 dynTP/SL (FASE 1 final)', ...sM123 }
    ],
    gates_fase1: gateFase1,
    pass_intermediate: gatesPass === 4
  };
  fs.writeFileSync(path.join(__dirname, '..', 'results', '05_elite_fase1.json'), JSON.stringify(report, null, 2));
  console.log(`\n⏱  Runtime: ${report.runtime_s.toFixed(1)}s`);
})();
