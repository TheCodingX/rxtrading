#!/usr/bin/env node
'use strict';
// V44.5 combos — P11 alone vs P11+P9 vs P11+P7 vs full stack
//
// Usage: node backtest_v45_combo.js [config]
// Configs: p11, p11_p9, p11_p7, p11_p7_p9

const fs = require('fs');
const path = require('path');

const CFG = (process.argv[2] || 'p11').toLowerCase();
const VALID = ['p11', 'p11_p9', 'p11_p7', 'p11_p7_p9'];
if(!VALID.includes(CFG)){
  console.error(`Invalid: ${CFG}. Valid: ${VALID.join(', ')}`);
  process.exit(1);
}

const FLAGS = {
  P11: true,
  P9: CFG.includes('p9'),
  P7: CFG.includes('p7')
};

const KLINES_DIR = '/tmp/binance-klines-1h';
const OUT_DIR = path.join(__dirname, '..', 'results');

const PAIRS = [
  'ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT',
  'BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT',
  'SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'
];

console.log('═'.repeat(70));
console.log(`V44.5 COMBO BACKTEST — ${CFG.toUpperCase()}`);
console.log('═'.repeat(70));
console.log(`P11=${FLAGS.P11} P9=${FLAGS.P9} P7=${FLAGS.P7}`);

const data = {};
for(const p of PAIRS){
  const f = path.join(KLINES_DIR, `${p}.json`);
  if(!fs.existsSync(f)) continue;
  data[p] = JSON.parse(fs.readFileSync(f, 'utf8')).map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4] }));
}

function proxyFunding(bars1h){
  const n = bars1h.length;
  const c = bars1h.map(b => b.c);
  const ema = new Float64Array(n);
  ema[0] = c[0];
  const alpha = 2 / 51;
  for(let i = 1; i < n; i++) ema[i] = c[i] * alpha + ema[i-1] * (1 - alpha);
  const premium = c.map((v, i) => (v - ema[i]) / ema[i]);
  const f = new Float64Array(n);
  for(let i = 8; i < n; i++){
    let s = 0;
    for(let j = i - 7; j <= i; j++) s += premium[j];
    f[i] = s / 8;
  }
  return f;
}

function pairSizeMult(rollingPF){
  if(rollingPF === null) return 1.0;
  if(rollingPF >= 2.5) return 1.6;
  if(rollingPF >= 2.0) return 1.4;
  if(rollingPF >= 1.5) return 1.2;
  if(rollingPF >= 1.2) return 1.0;
  if(rollingPF >= 1.0) return 0.85;
  if(rollingPF >= 0.8) return 0.65;
  return 0.45;
}

function termStructureBoost(fund, idx, dir){
  if(idx < 168) return 1.0;
  const f24 = [];
  for(let j = idx - 24; j < idx; j++) if(isFinite(fund[j])) f24.push(fund[j]);
  const f7d = [];
  for(let j = idx - 168; j < idx; j++) if(isFinite(fund[j])) f7d.push(fund[j]);
  if(f24.length < 12 || f7d.length < 80) return 1.0;
  const m24 = f24.reduce((a,b)=>a+b, 0) / f24.length;
  const m7d = f7d.reduce((a,b)=>a+b, 0) / f7d.length;
  const std = Math.sqrt(f7d.reduce((s,v)=>s+(v-m7d)**2, 0) / f7d.length);
  const div = m24 - m7d;
  const aligned = dir === 1 ? -div : div;
  const norm = std > 0 ? aligned / std : 0;
  return 1.0 + Math.max(0, Math.min(0.30, norm * 0.15));
}

const _cooldownMap = new Map();
function cooldownActive(pair, dir, ts){
  if(!FLAGS.P9) return false;
  const k = `${pair}:${dir}`;
  const last = _cooldownMap.get(k);
  if(!last) return false;
  if(ts - last < 8 * 3600 * 1000) return true;
  _cooldownMap.delete(k);
  return false;
}
function markSL(pair, dir, ts){
  _cooldownMap.set(`${pair}:${dir}`, ts);
}

const INIT_CAP = 500;
const SIZE_PCT = 0.10;
const TP_BPS = 30, SL_BPS = 25, HOLD_H = 4, FEE_RT = 0.0008, SLIP_SL = 0.0002;

const trades = [];
let cap = INIT_CAP;
const dailyPnL = {};
const tradesByPair = {};
PAIRS.forEach(p => tradesByPair[p] = []);

function rollingPF(pairTs, currentTs){
  const cutoffEnd = currentTs - 7 * 86400000;
  const cutoffStart = cutoffEnd - 90 * 86400000;
  const win = pairTs.filter(t => t.ts >= cutoffStart && t.ts <= cutoffEnd);
  if(win.length < 30) return null;
  const w = win.filter(t => t.pnl > 0);
  const gp = w.reduce((s,t)=>s+t.pnl, 0);
  const gl = -win.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl, 0);
  return gl > 0 ? gp/gl : 999;
}

const t0 = Date.now();

for(const pair of PAIRS){
  if(!data[pair]) continue;
  const bars = data[pair];
  const fund = proxyFunding(bars);

  let pos = null;
  for(let i = 50; i < bars.length - HOLD_H; i++){
    const ts = bars[i].t;
    const hr = new Date(ts).getUTCHours();

    if(pos){
      const e = pos.entry, dir = pos.dir, h = bars[i].h, l = bars[i].l;
      const tp = dir === 1 ? e * (1 + TP_BPS/10000) : e * (1 - TP_BPS/10000);
      const sl = dir === 1 ? e * (1 - SL_BPS/10000) : e * (1 + SL_BPS/10000);
      const hitTP = (dir === 1 && h >= tp) || (dir === -1 && l <= tp);
      const hitSL = (dir === 1 && l <= sl) || (dir === -1 && h >= sl);
      const to = i >= pos.entryI + HOLD_H;
      if(hitTP || hitSL || to){
        const ex = hitTP ? tp : (hitSL ? (dir === 1 ? sl*(1-SLIP_SL) : sl*(1+SLIP_SL)) : bars[i].c);
        const pct = dir === 1 ? (ex-e)/e : (e-ex)/e;
        const pnl = pos.size * pct - pos.size * FEE_RT;
        cap += pnl;
        const dk = new Date(ts).toISOString().slice(0,10);
        dailyPnL[dk] = (dailyPnL[dk] || 0) + pnl;
        const tr = { pnl, ts, pair, dir: pos.dir, type: hitTP ? 'TP' : (hitSL ? 'SL' : 'TO') };
        trades.push(tr);
        tradesByPair[pair].push(tr);
        if(hitSL) markSL(pair, pos.dir === 1 ? 'BUY' : 'SELL', ts);
        pos = null;
      }
    }

    if(!pos && (hr === 0 || hr === 8 || hr === 16)){
      const f = fund[i];
      if(!isFinite(f)) continue;
      const fW = [];
      for(let j = Math.max(0, i-168); j < i; j++) if(isFinite(fund[j])) fW.push(fund[j]);
      if(fW.length < 50) continue;
      const sorted = [...fW].sort((a,b)=>a-b);
      const p80 = sorted[Math.floor(sorted.length*0.8)] || 0;
      const p20 = sorted[Math.floor(sorted.length*0.2)] || 0;
      let dir = 0;
      if(f > p80 && f > 0.005) dir = -1;
      else if(f < p20 && f < -0.002) dir = 1;
      if(dir === 0) continue;
      if(cooldownActive(pair, dir === 1 ? 'BUY' : 'SELL', ts)) continue;

      const pf = rollingPF(tradesByPair[pair], ts);
      let mult = pairSizeMult(pf);

      // P7: TS boost extra modifier (small)
      if(FLAGS.P7){
        const ts_b = termStructureBoost(fund, i, dir);
        // Compose: pair sizing × ts-boost (capped at 2x total to avoid runaway)
        mult = Math.min(2.0, mult * ts_b);
      }

      pos = { entry: bars[i].c, dir, entryI: i, size: cap * SIZE_PCT * mult, sizeMult: mult, rollingPF: pf };
    }
  }
}

const dt = ((Date.now() - t0) / 1000).toFixed(1);

function compute(trades, dailyPnL, capital = INIT_CAP){
  if(trades.length === 0) return { n: 0 };
  const w = trades.filter(t => t.pnl > 0);
  const l = trades.filter(t => t.pnl <= 0);
  const gp = w.reduce((s,t)=>s+t.pnl, 0);
  const gl = -l.reduce((s,t)=>s+t.pnl, 0);
  const days = Object.keys(dailyPnL).sort();
  const dr = days.map(d => dailyPnL[d]/capital);
  const m = dr.reduce((a,b)=>a+b,0)/Math.max(1,dr.length);
  const v = dr.reduce((s,r)=>s+(r-m)**2,0)/Math.max(1,dr.length);
  const sh = Math.sqrt(v) > 0 ? (m/Math.sqrt(v))*Math.sqrt(365) : 0;
  let pk = 0, mdd = 0, cum = 0;
  for(const d of days){ cum += dailyPnL[d]; if(cum>pk) pk=cum; if(pk-cum>mdd) mdd=pk-cum; }
  return {
    n: trades.length, wins: w.length, losses: l.length,
    pf: gl > 0 ? gp/gl : 999, wr: (w.length/trades.length)*100,
    pnl: trades.reduce((s,t)=>s+t.pnl, 0),
    sharpe: sh, mdd, mddPct: (mdd/capital)*100,
    tpd: days.length > 0 ? trades.length/days.length : 0,
    days: days.length
  };
}

const stats = compute(trades, dailyPnL);
const sortedDays = Object.keys(dailyPnL).sort();
const win7d = [];
for(let i = 0; i + 6 < sortedDays.length; i++){
  win7d.push({ pnl: sortedDays.slice(i,i+7).reduce((s,d)=>s+dailyPnL[d], 0) });
}
const pos7d = win7d.filter(w => w.pnl > 0).length;
const sorted = win7d.map(w=>w.pnl).sort((a,b)=>a-b);

console.log('');
console.log(`Trades: ${stats.n}  PF: ${stats.pf.toFixed(3)}  WR: ${stats.wr.toFixed(2)}%  PnL: $${stats.pnl.toFixed(2)}  DD: ${stats.mddPct.toFixed(2)}%  Sharpe: ${stats.sharpe.toFixed(2)}  t/d: ${stats.tpd.toFixed(2)}`);
console.log(`7d: ${(pos7d/win7d.length*100).toFixed(1)}% pos | worst $${sorted[0].toFixed(2)} (${(sorted[0]/INIT_CAP*100).toFixed(2)}%)`);

const out = {
  config: CFG, flags: FLAGS, stats,
  positivePct: (pos7d/win7d.length)*100, worstWin: sorted[0],
  windows7d_count: win7d.length, windows7d_positive: pos7d,
  dailyPnL, runtime_s: parseFloat(dt)
};
fs.writeFileSync(path.join(OUT_DIR, `v45_holdout_v2_${CFG}.json`), JSON.stringify(out, null, 2));
console.log(`✓ Saved ${OUT_DIR}/v45_holdout_v2_${CFG}.json`);
