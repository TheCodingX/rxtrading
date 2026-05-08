// Multi-strategy backtest v2 — precomputes indicators once per pair,
// only param sweeps over thresholds. ~100x faster than v1.
'use strict';
const fs = require('fs');
const path = require('path');

const CACHE_DIR = '/tmp/v447-data';
const UNIVERSE = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT',
  'ARBUSDT','ATOMUSDT','TRXUSDT','NEARUSDT','POLUSDT','INJUSDT','SUIUSDT','AVAXUSDT',
  'OPUSDT','DOTUSDT','RENDERUSDT','1000PEPEUSDT','1000SHIBUSDT','JUPUSDT'
];
const FEE = 8;
const OUT_FILE = '/tmp/v447-data/strat-results-v2.json';

function loadKlines(sym) {
  const f = path.join(CACHE_DIR, `${sym}-klines-1h.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// ─── precompute indicators per pair, once ───
function precompute(klines) {
  const n = klines.length;
  const a14 = new Float64Array(n);
  const r14 = new Float64Array(n);
  const vMA20 = new Float64Array(n);
  const donH20 = new Float64Array(n);
  const donL20 = new Float64Array(n);

  // ATR(14)
  for (let i = 14; i < n; i++) {
    let s = 0;
    for (let j = i - 13; j <= i; j++) {
      const tr = Math.max(
        klines[j].h - klines[j].l,
        Math.abs(klines[j].h - klines[j-1].c),
        Math.abs(klines[j].l - klines[j-1].c)
      );
      s += tr;
    }
    a14[i] = s / 14;
  }

  // RSI(14) — Wilder smoothing
  let avgG = 0, avgL = 0;
  for (let i = 1; i < n; i++) {
    const ch = klines[i].c - klines[i-1].c;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    if (i <= 14) {
      avgG = (avgG * (i - 1) + g) / i;
      avgL = (avgL * (i - 1) + l) / i;
    } else {
      avgG = (avgG * 13 + g) / 14;
      avgL = (avgL * 13 + l) / 14;
    }
    if (i >= 14) {
      const rs = avgL > 0 ? avgG / avgL : 999;
      r14[i] = 100 - (100 / (1 + rs));
    }
  }

  // volMA(20)
  let vsum = 0;
  for (let i = 0; i < n; i++) {
    vsum += klines[i].v;
    if (i >= 20) vsum -= klines[i-20].v;
    if (i >= 19) vMA20[i] = vsum / 20;
  }

  // Donchian(20)
  for (let i = 20; i < n; i++) {
    let h = -Infinity, l = Infinity;
    for (let j = i - 20; j < i; j++) {
      if (klines[j].h > h) h = klines[j].h;
      if (klines[j].l < l) l = klines[j].l;
    }
    donH20[i] = h; donL20[i] = l;
  }

  // ATR percentiles 168h rolling — sliding sorted window via simple sort each step
  // (still O(n*168*log168) but only once per pair, not per config)
  const a25 = new Float64Array(n);
  const a20p = new Float64Array(n);
  const a80p = new Float64Array(n);
  const buf = new Float64Array(168);
  for (let i = 168; i < n; i++) {
    let cnt = 0;
    for (let j = i - 168; j < i; j++) if (a14[j] > 0) buf[cnt++] = a14[j];
    if (cnt < 50) continue;
    const sub = Array.from(buf.subarray(0, cnt)).sort((x,y)=>x-y);
    a25[i] = sub[Math.floor(cnt*0.25)];
    a20p[i] = sub[Math.floor(cnt*0.20)];
    a80p[i] = sub[Math.floor(cnt*0.80)];
  }

  return { a14, r14, vMA20, donH20, donL20, a25, a20p, a80p };
}

// ─── trade simulator ───
function simTrade(kl, i0, dir, tpBps, slBps, holdH, fee) {
  const entry = kl[i0].c;
  const tp = dir === 1 ? entry * (1 + tpBps/10000) : entry * (1 - tpBps/10000);
  const sl = dir === 1 ? entry * (1 - slBps/10000) : entry * (1 + slBps/10000);
  for (let j = i0 + 1; j <= i0 + holdH && j < kl.length; j++) {
    const fb = kl[j];
    if (dir === 1) {
      const tpHit = fb.h >= tp, slHit = fb.l <= sl;
      if (tpHit && slHit) return { pnl: -slBps - fee, w: 0, exitI: j };
      if (tpHit) return { pnl: tpBps - fee, w: 1, exitI: j };
      if (slHit) return { pnl: -slBps - fee, w: 0, exitI: j };
    } else {
      const tpHit = fb.l <= tp, slHit = fb.h >= sl;
      if (tpHit && slHit) return { pnl: -slBps - fee, w: 0, exitI: j };
      if (tpHit) return { pnl: tpBps - fee, w: 1, exitI: j };
      if (slHit) return { pnl: -slBps - fee, w: 0, exitI: j };
    }
  }
  const exitI = Math.min(i0 + holdH, kl.length - 1);
  const exit = kl[exitI].c;
  const pnl = dir === 1 ? ((exit - entry) / entry) * 10000 : ((entry - exit) / entry) * 10000;
  return { pnl: pnl - fee, w: pnl > 0 ? 1 : 0, exitI };
}

// ─── strats ───
function s1_volBreakout(kl, ind, p) {
  const tr = [];
  for (let i = 200; i < kl.length - p.HOLD; i++) {
    if (!ind.a14[i] || !ind.a25[i]) continue;
    if (ind.a14[i] > ind.a25[i] * p.SR) continue;
    let dir = 0;
    if (kl[i].c > ind.donH20[i]) dir = 1;
    else if (kl[i].c < ind.donL20[i]) dir = -1;
    if (!dir) continue;
    const t = simTrade(kl, i, dir, p.TP, p.SL, p.HOLD, FEE);
    tr.push({ t: kl[i].t, dir, pnl: t.pnl, w: t.w });
    i = t.exitI;
  }
  return tr;
}

function s2_bigCandleFade(kl, ind, p) {
  const tr = [];
  for (let i = 30; i < kl.length - p.HOLD - 1; i++) {
    if (!ind.a14[i] || !ind.vMA20[i]) continue;
    const body = Math.abs(kl[i].c - kl[i].o);
    const bodyAtr = body / ind.a14[i];
    const volR = kl[i].v / ind.vMA20[i];
    if (bodyAtr < p.BAM || volR < p.VRM) continue;
    const dir = kl[i].c > kl[i].o ? -1 : 1;
    const t = simTrade(kl, i + 1, dir, p.TP, p.SL, p.HOLD, FEE);
    tr.push({ t: kl[i+1].t, dir, pnl: t.pnl, w: t.w });
    i = t.exitI;
  }
  return tr;
}

function s3_pairsBTCETH(btc, eth, p) {
  const tr = [];
  const ethMap = new Map();
  for (const e of eth) ethMap.set(e.t, e);
  const N = btc.length;
  const spr = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const e = ethMap.get(btc[i].t);
    spr[i] = e ? Math.log(btc[i].c) - Math.log(e.c) : NaN;
  }
  for (let i = 200; i < N - p.HOLD; i++) {
    if (!isFinite(spr[i])) continue;
    let s=0, n=0;
    for (let j = i-168; j<i; j++) if (isFinite(spr[j])) { s+=spr[j]; n++; }
    if (n < 100) continue;
    const m = s/n;
    let v=0; for (let j=i-168; j<i; j++) if (isFinite(spr[j])) v += (spr[j]-m)**2;
    const sd = Math.sqrt(v/n);
    if (sd <= 0) continue;
    const z = (spr[i]-m)/sd;
    let dir = 0;
    if (z > p.Z) dir = -1; else if (z < -p.Z) dir = 1;
    if (!dir) continue;
    const t = simTrade(btc, i, dir, p.TP, p.SL, p.HOLD, FEE);
    tr.push({ t: btc[i].t, dir, pnl: t.pnl, w: t.w });
    i = t.exitI;
  }
  return tr;
}

function s4_rsiAtr(kl, ind, p) {
  const tr = [];
  for (let i = 200; i < kl.length - p.HOLD; i++) {
    if (!ind.r14[i] || !ind.a14[i]) continue;
    const a20p = ind.a20p[i], a80p = ind.a80p[i];
    if (!a20p || !a80p) continue;
    if (p.REG === 'mid' && (ind.a14[i] < a20p || ind.a14[i] > a80p)) continue;
    if (p.REG === 'low' && ind.a14[i] > a20p) continue;
    if (p.REG === 'high' && ind.a14[i] < a80p) continue;
    let dir = 0;
    if (ind.r14[i] < p.RL) dir = 1; else if (ind.r14[i] > p.RH) dir = -1;
    if (!dir) continue;
    if (p.INV) dir = -dir;
    const t = simTrade(kl, i, dir, p.TP, p.SL, p.HOLD, FEE);
    tr.push({ t: kl[i].t, dir, pnl: t.pnl, w: t.w });
    i = t.exitI;
  }
  return tr;
}

// ─── stats ───
function stats(tr) {
  if (!tr.length) return null;
  let gw=0, gl=0, w=0;
  for (const t of tr) {
    if (t.pnl > 0) { gw += t.pnl; w++; }
    else gl += -t.pnl;
  }
  const wr = w / tr.length * 100;
  const pf = gl > 0 ? gw/gl : (gw > 0 ? 99 : 0);
  tr.sort((a,b)=>a.t-b.t);
  let eq=0, peak=0, dd=0;
  for (const t of tr) { eq += t.pnl; if (eq>peak) peak=eq; if (peak-eq>dd) dd=peak-eq; }
  const span = (tr[tr.length-1].t - tr[0].t) / 86400000;
  const days = Math.max(1, span);
  return {
    trades: tr.length, wins: w, wr: +wr.toFixed(2), pf: +pf.toFixed(3),
    dd_bps: +dd.toFixed(0), totalPnl_bps: +(gw-gl).toFixed(0),
    perDay: +(tr.length/days).toFixed(2), span_days: +days.toFixed(0)
  };
}
function ann(st, lev=3, sz=0.10) {
  if (!st || !st.trades) return 0;
  const avg = st.totalPnl_bps / st.trades;
  const tpy = st.perDay * 365;
  const eff = avg * lev * sz / 10000;
  return +(((1+eff)**tpy - 1) * 100).toFixed(1);
}
function split70(tr) {
  if (!tr.length) return { train: [], test: [] };
  tr.sort((a,b)=>a.t-b.t);
  const cut = tr[0].t + (tr[tr.length-1].t-tr[0].t)*0.7;
  return { train: tr.filter(t=>t.t<cut), test: tr.filter(t=>t.t>=cut) };
}

// ─── load + precompute ───
console.log('Loading + precomputing per pair...');
const data = {};
const t0 = Date.now();
for (const s of UNIVERSE) {
  const k = loadKlines(s);
  if (!k) continue;
  data[s] = { kl: k, ind: precompute(k) };
  process.stdout.write('.');
}
console.log(`\nPrecomputed ${Object.keys(data).length} pairs in ${((Date.now()-t0)/1000).toFixed(1)}s`);

const results = [];

function runOnAll(stratFn, params) {
  const all = [];
  for (const s of UNIVERSE) {
    if (!data[s]) continue;
    const tr = stratFn(data[s].kl, data[s].ind, params);
    all.push(...tr);
  }
  return all;
}

function evalConfig(strat, name, params, tradesFn) {
  const tr = tradesFn();
  if (tr.length < 100) return;
  const sp = split70(tr);
  const trS = stats(sp.train), teS = stats(sp.test);
  if (!teS) return;
  const annual = ann(teS);
  results.push({ strat: name, params, train: trS, test: teS, annual });
}

// ── Strat 1: Vol breakout ──
console.log('\n[S1] Vol breakout...');
let n1 = 0;
for (const TP of [60, 100, 150, 200])
for (const SL of [20, 30, 50])
for (const HOLD of [4, 8, 16])
for (const SR of [0.7, 1.0, 1.3]) {
  const params = { TP, SL, HOLD, SR };
  evalConfig('vol_breakout', 'vol_breakout', params, () => runOnAll(s1_volBreakout, params));
  n1++;
}
console.log(`  ${n1} configs`);

// ── Strat 2: Big candle fade ──
console.log('[S2] Big candle fade...');
let n2 = 0;
for (const TP of [30, 50, 80, 120])
for (const SL of [15, 25, 40])
for (const HOLD of [4, 8, 16])
for (const BAM of [1.0, 1.5, 2.0])
for (const VRM of [1.0, 1.5, 2.0, 3.0]) {
  const params = { TP, SL, HOLD, BAM, VRM };
  evalConfig('bigcandle_fade', 'bigcandle_fade', params, () => runOnAll(s2_bigCandleFade, params));
  n2++;
}
console.log(`  ${n2} configs`);

// ── Strat 3: BTC-ETH pairs ──
console.log('[S3] BTC-ETH pairs...');
let n3 = 0;
if (data.BTCUSDT && data.ETHUSDT) {
  for (const TP of [30, 60, 100])
  for (const SL of [20, 30, 50])
  for (const HOLD of [4, 8, 16, 24])
  for (const Z of [1.5, 2.0, 2.5, 3.0]) {
    const params = { TP, SL, HOLD, Z };
    evalConfig('pairs_btceth', 'pairs_btceth', params, () => s3_pairsBTCETH(data.BTCUSDT.kl, data.ETHUSDT.kl, params));
    n3++;
  }
}
console.log(`  ${n3} configs`);

// ── Strat 4: RSI extreme + ATR regime ──
console.log('[S4] RSI extreme + ATR regime...');
let n4 = 0;
for (const TP of [30, 60, 100])
for (const SL of [15, 25, 40])
for (const HOLD of [4, 8, 16])
for (const RL of [25, 30])
for (const RH of [70, 75])
for (const REG of ['mid', 'low', 'high', 'all'])
for (const INV of [false, true]) {
  const params = { TP, SL, HOLD, RL, RH, REG, INV };
  evalConfig('rsi_atr', 'rsi_atr', params, () => runOnAll(s4_rsiAtr, params));
  n4++;
}
console.log(`  ${n4} configs`);

console.log(`\nTotal evaluated: ${results.length}`);

function score(r) {
  const t = r.test;
  if (!t || t.trades < 30) return -Infinity;
  if (t.pf < 1.0 || r.annual < 0) return -Infinity;
  const consistency = 1 - Math.min(1, Math.abs(t.wr - r.train.wr)/30);
  return Math.min(t.pf,3)/3 * 0.30
       + Math.min(r.annual,400)/400 * 0.20
       + Math.min(t.perDay,15)/15 * 0.15
       + Math.min(t.wr,80)/80 * 0.15
       + Math.max(0, 1 - t.dd_bps/1500) * 0.10
       + consistency * 0.10;
}
results.forEach(r => r._score = score(r));
results.sort((a,b)=>b._score - a._score);

console.log('\n══ TOP 15 OOS PROFITABLE ══');
let n = 0;
for (const r of results) {
  if (r._score === -Infinity) break;
  const t = r.test, tr = r.train;
  console.log(`#${++n} [${r.strat}] s=${r._score.toFixed(3)} ${JSON.stringify(r.params)}`);
  console.log(`   TR: ${tr.trades}t WR=${tr.wr}% PF=${tr.pf} td=${tr.perDay} DD=${tr.dd_bps}`);
  console.log(`   TE: ${t.trades}t WR=${t.wr}% PF=${t.pf} td=${t.perDay} DD=${t.dd_bps} ann=${r.annual}%`);
  if (n >= 15) break;
}

console.log('\n══ BEST PER STRATEGY ══');
const byStrat = {};
for (const r of results) {
  if (r._score === -Infinity) continue;
  if (!byStrat[r.strat] || r._score > byStrat[r.strat]._score) byStrat[r.strat] = r;
}
for (const [s, r] of Object.entries(byStrat)) {
  const t = r.test;
  console.log(`[${s}] WR=${t.wr}% PF=${t.pf} td=${t.perDay} DD=${t.dd_bps} ann=${r.annual}% (${t.trades} trades OOS)`);
}

const hard = results.filter(r => {
  const t = r.test;
  return t && t.wr >= 70 && t.pf >= 1.5 && t.perDay >= 10 && r.annual >= 200 && t.dd_bps < 1500;
});
console.log(`\n══ HARD TARGETS (WR≥70 PF≥1.5 td≥10 ann≥200% DD<1500): ${hard.length} ══`);
hard.slice(0,10).forEach(r => {
  const t = r.test;
  console.log(`  [${r.strat}] WR=${t.wr}% PF=${t.pf} td=${t.perDay} DD=${t.dd_bps} ann=${r.annual}% ${JSON.stringify(r.params)}`);
});

const relax = results.filter(r => {
  const t = r.test;
  return t && t.wr >= 60 && t.pf >= 1.3 && t.perDay >= 5 && r.annual >= 100;
});
console.log(`\n══ RELAXED (WR≥60 PF≥1.3 td≥5 ann≥100%): ${relax.length} ══`);
relax.slice(0,10).forEach(r => {
  const t = r.test;
  console.log(`  [${r.strat}] WR=${t.wr}% PF=${t.pf} td=${t.perDay} DD=${t.dd_bps} ann=${r.annual}% ${JSON.stringify(r.params)}`);
});

fs.writeFileSync(OUT_FILE, JSON.stringify(results.slice(0, 200), null, 2));
console.log(`\nSaved top-200 to ${OUT_FILE}`);
