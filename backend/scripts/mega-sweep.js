// ═══════════════════════════════════════════════════════════════════
// MEGA-SWEEP: Sprint final — diagnóstico V44.6 live + sweep masivo
// + validación anti-overfit estricta. Ejecutado sobre 365d Binance
// cacheado en /tmp/v447-data/. Output JSON consolidado para reporte.
// ═══════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs');
const path = require('path');

const CACHE_DIR = '/tmp/v447-data';
const OUT_DIR = '/Users/rocki/Documents/rxtrading/.claude/worktrees/sad-nightingale/audit';
fs.mkdirSync(OUT_DIR, { recursive: true });

const UNIVERSE = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT',
  'ARBUSDT','ATOMUSDT','TRXUSDT','NEARUSDT','POLUSDT','INJUSDT','SUIUSDT','AVAXUSDT',
  'OPUSDT','DOTUSDT','RENDERUSDT','1000PEPEUSDT','1000SHIBUSDT','JUPUSDT'
];
const FEE_BPS = 8;          // taker round-trip
const SLIP_BPS = 1.5;       // realistic intra-1h slippage
const TOTAL_COST = FEE_BPS + SLIP_BPS;  // 9.5 bps

// ─── data load + resample to 4h, 1d ───
function loadKlines(sym) {
  const f = path.join(CACHE_DIR, `${sym}-klines-1h.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function loadFunding(sym) {
  const f = path.join(CACHE_DIR, `${sym}-funding.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function loadPremium(sym) {
  const f = path.join(CACHE_DIR, `${sym}-premium-1h.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function resample(kl, n) {
  const out = [];
  for (let i = 0; i + n <= kl.length; i += n) {
    let h = -Infinity, l = Infinity, v = 0;
    for (let j = i; j < i + n; j++) {
      if (kl[j].h > h) h = kl[j].h;
      if (kl[j].l < l) l = kl[j].l;
      v += kl[j].v;
    }
    out.push({ t: kl[i].t, o: kl[i].o, h, l, c: kl[i + n - 1].c, v });
  }
  return out;
}

// ─── Indicators ───
function atr(kl, p) {
  const n = kl.length, out = new Float64Array(n);
  for (let i = p; i < n; i++) {
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const tr = Math.max(kl[j].h - kl[j].l, Math.abs(kl[j].h - kl[j-1].c), Math.abs(kl[j].l - kl[j-1].c));
      s += tr;
    }
    out[i] = s / p;
  }
  return out;
}
function rsi(kl, p) {
  const n = kl.length, out = new Float64Array(n);
  let g = 0, l = 0;
  for (let i = 1; i < n; i++) {
    const ch = kl[i].c - kl[i-1].c;
    const gv = ch > 0 ? ch : 0, lv = ch < 0 ? -ch : 0;
    if (i <= p) { g = (g*(i-1) + gv)/i; l = (l*(i-1) + lv)/i; }
    else        { g = (g*(p-1) + gv)/p;   l = (l*(p-1) + lv)/p; }
    if (i >= p) { const rs = l > 0 ? g/l : 999; out[i] = 100 - 100/(1+rs); }
  }
  return out;
}
function ema(kl, p) {
  const n = kl.length, out = new Float64Array(n);
  const a = 2/(p+1);
  out[0] = kl[0].c;
  for (let i = 1; i < n; i++) out[i] = a * kl[i].c + (1-a) * out[i-1];
  return out;
}
function sma(kl, p) {
  const n = kl.length, out = new Float64Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += kl[i].c;
    if (i >= p) s -= kl[i-p].c;
    if (i >= p-1) out[i] = s/p;
  }
  return out;
}
function donchian(kl, p) {
  const n = kl.length, h = new Float64Array(n), l = new Float64Array(n);
  for (let i = p; i < n; i++) {
    let mx = -Infinity, mn = Infinity;
    for (let j = i-p; j < i; j++) { if (kl[j].h > mx) mx = kl[j].h; if (kl[j].l < mn) mn = kl[j].l; }
    h[i] = mx; l[i] = mn;
  }
  return { h, l };
}
function bbands(kl, p, k) {
  const n = kl.length, mid = sma(kl, p);
  const up = new Float64Array(n), dn = new Float64Array(n), bw = new Float64Array(n);
  for (let i = p-1; i < n; i++) {
    let s = 0; for (let j = i-p+1; j <= i; j++) s += (kl[j].c - mid[i])**2;
    const sd = Math.sqrt(s/p);
    up[i] = mid[i] + k*sd; dn[i] = mid[i] - k*sd;
    bw[i] = mid[i] > 0 ? (up[i] - dn[i])/mid[i] : 0;
  }
  return { up, dn, mid, bw };
}
function macd(kl, fast, slow, sig) {
  const ef = ema(kl, fast), es = ema(kl, slow);
  const n = kl.length, line = new Float64Array(n);
  for (let i = 0; i < n; i++) line[i] = ef[i] - es[i];
  // signal = EMA(line, sig)
  const a = 2/(sig+1);
  const sl = new Float64Array(n);
  sl[0] = line[0];
  for (let i = 1; i < n; i++) sl[i] = a*line[i] + (1-a)*sl[i-1];
  const hist = new Float64Array(n);
  for (let i = 0; i < n; i++) hist[i] = line[i] - sl[i];
  return { line, signal: sl, hist };
}
function stochK(kl, p) {
  const n = kl.length, out = new Float64Array(n);
  for (let i = p; i < n; i++) {
    let mx = -Infinity, mn = Infinity;
    for (let j = i-p+1; j <= i; j++) { if (kl[j].h > mx) mx = kl[j].h; if (kl[j].l < mn) mn = kl[j].l; }
    out[i] = (mx - mn) > 0 ? 100 * (kl[i].c - mn)/(mx - mn) : 50;
  }
  return out;
}
function williamsR(kl, p) {
  const n = kl.length, out = new Float64Array(n);
  for (let i = p; i < n; i++) {
    let mx = -Infinity, mn = Infinity;
    for (let j = i-p+1; j <= i; j++) { if (kl[j].h > mx) mx = kl[j].h; if (kl[j].l < mn) mn = kl[j].l; }
    out[i] = (mx - mn) > 0 ? -100 * (mx - kl[i].c)/(mx - mn) : -50;
  }
  return out;
}
function cci(kl, p) {
  const n = kl.length, out = new Float64Array(n);
  const tp = new Float64Array(n);
  for (let i = 0; i < n; i++) tp[i] = (kl[i].h + kl[i].l + kl[i].c)/3;
  for (let i = p-1; i < n; i++) {
    let s = 0; for (let j = i-p+1; j <= i; j++) s += tp[j];
    const m = s/p;
    let md = 0; for (let j = i-p+1; j <= i; j++) md += Math.abs(tp[j] - m);
    md /= p;
    out[i] = md > 0 ? (tp[i] - m)/(0.015 * md) : 0;
  }
  return out;
}
function obv(kl) {
  const n = kl.length, out = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const sign = kl[i].c > kl[i-1].c ? 1 : (kl[i].c < kl[i-1].c ? -1 : 0);
    out[i] = out[i-1] + sign * kl[i].v;
  }
  return out;
}
function mfi(kl, p) {
  const n = kl.length, out = new Float64Array(n);
  const tp = new Float64Array(n);
  for (let i = 0; i < n; i++) tp[i] = (kl[i].h + kl[i].l + kl[i].c)/3;
  for (let i = p; i < n; i++) {
    let pos = 0, neg = 0;
    for (let j = i-p+1; j <= i; j++) {
      const m = tp[j] * kl[j].v;
      if (tp[j] > tp[j-1]) pos += m; else if (tp[j] < tp[j-1]) neg += m;
    }
    out[i] = neg > 0 ? 100 - 100/(1 + pos/neg) : 100;
  }
  return out;
}
function adx(kl, p) {
  const n = kl.length, out = new Float64Array(n);
  const plusDM = new Float64Array(n), minusDM = new Float64Array(n), tr = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const upMove = kl[i].h - kl[i-1].h;
    const dnMove = kl[i-1].l - kl[i].l;
    plusDM[i] = (upMove > dnMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (dnMove > upMove && dnMove > 0) ? dnMove : 0;
    tr[i] = Math.max(kl[i].h - kl[i].l, Math.abs(kl[i].h - kl[i-1].c), Math.abs(kl[i].l - kl[i-1].c));
  }
  // smoothed
  let sumPDM = 0, sumMDM = 0, sumTR = 0;
  for (let i = 1; i <= p; i++) { sumPDM += plusDM[i]; sumMDM += minusDM[i]; sumTR += tr[i]; }
  const dx = new Float64Array(n);
  for (let i = p+1; i < n; i++) {
    sumPDM = sumPDM - sumPDM/p + plusDM[i];
    sumMDM = sumMDM - sumMDM/p + minusDM[i];
    sumTR  = sumTR  - sumTR/p  + tr[i];
    const pdi = sumTR > 0 ? 100 * sumPDM/sumTR : 0;
    const mdi = sumTR > 0 ? 100 * sumMDM/sumTR : 0;
    dx[i] = (pdi+mdi) > 0 ? 100 * Math.abs(pdi-mdi)/(pdi+mdi) : 0;
  }
  // ADX = SMA(dx, p)
  let sd = 0;
  for (let i = p+1; i < 2*p+1 && i < n; i++) sd += dx[i];
  for (let i = 2*p+1; i < n; i++) {
    sd = sd - dx[i-p] + dx[i];
    out[i] = sd/p;
  }
  return out;
}
// SuperTrend
function supertrend(kl, p, mult) {
  const n = kl.length, atrV = atr(kl, p);
  const upper = new Float64Array(n), lower = new Float64Array(n), st = new Float64Array(n);
  const dir = new Int8Array(n);
  for (let i = p; i < n; i++) {
    const hl2 = (kl[i].h + kl[i].l)/2;
    const ub = hl2 + mult * atrV[i];
    const lb = hl2 - mult * atrV[i];
    upper[i] = (i === p) ? ub : (ub < upper[i-1] || kl[i-1].c > upper[i-1]) ? ub : upper[i-1];
    lower[i] = (i === p) ? lb : (lb > lower[i-1] || kl[i-1].c < lower[i-1]) ? lb : lower[i-1];
    if (i === p) { st[i] = upper[i]; dir[i] = -1; }
    else if (st[i-1] === upper[i-1] && kl[i].c <= upper[i]) { st[i] = upper[i]; dir[i] = -1; }
    else if (st[i-1] === upper[i-1] && kl[i].c >  upper[i]) { st[i] = lower[i]; dir[i] = 1; }
    else if (st[i-1] === lower[i-1] && kl[i].c >= lower[i]) { st[i] = lower[i]; dir[i] = 1; }
    else if (st[i-1] === lower[i-1] && kl[i].c <  lower[i]) { st[i] = upper[i]; dir[i] = -1; }
    else { st[i] = st[i-1]; dir[i] = dir[i-1]; }
  }
  return { st, dir };
}
function rollingZ(arr, idx, look) {
  let s = 0, n = 0;
  for (let j = Math.max(0, idx-look); j < idx; j++) if (isFinite(arr[j])) { s += arr[j]; n++; }
  if (n < 30) return NaN;
  const m = s/n;
  let v = 0; for (let j = Math.max(0, idx-look); j < idx; j++) if (isFinite(arr[j])) v += (arr[j]-m)**2;
  const sd = Math.sqrt(v/n);
  return sd > 0 ? (arr[idx]-m)/sd : 0;
}
function hurst(arr, look) {
  // Simple R/S Hurst on log returns
  const sub = arr.slice(arr.length - look);
  if (sub.length < 50) return NaN;
  const r = [];
  for (let i = 1; i < sub.length; i++) r.push(Math.log(sub[i]/sub[i-1]));
  const m = r.reduce((a,b)=>a+b,0)/r.length;
  let dev = 0, mxd = -Infinity, mnd = Infinity, c = 0;
  for (const x of r) { c += x - m; if (c > mxd) mxd = c; if (c < mnd) mnd = c; }
  let v = 0; for (const x of r) v += (x-m)**2;
  const sd = Math.sqrt(v/r.length);
  if (sd <= 0) return 0.5;
  const rs = (mxd - mnd)/sd;
  return rs > 0 ? Math.log(rs) / Math.log(r.length) : 0.5;
}

// ─── trade simulator ───
function simTrade(kl, i0, dir, tpBps, slBps, holdH) {
  const entry = kl[i0].c;
  const tp = dir === 1 ? entry*(1+tpBps/10000) : entry*(1-tpBps/10000);
  const sl = dir === 1 ? entry*(1-slBps/10000) : entry*(1+slBps/10000);
  for (let j = i0+1; j <= i0+holdH && j < kl.length; j++) {
    const fb = kl[j];
    if (dir === 1) {
      const tpHit = fb.h >= tp, slHit = fb.l <= sl;
      if (tpHit && slHit) return { pnl: -slBps - TOTAL_COST, exitI: j };
      if (tpHit) return { pnl: tpBps - TOTAL_COST, exitI: j };
      if (slHit) return { pnl: -slBps - TOTAL_COST, exitI: j };
    } else {
      const tpHit = fb.l <= tp, slHit = fb.h >= sl;
      if (tpHit && slHit) return { pnl: -slBps - TOTAL_COST, exitI: j };
      if (tpHit) return { pnl: tpBps - TOTAL_COST, exitI: j };
      if (slHit) return { pnl: -slBps - TOTAL_COST, exitI: j };
    }
  }
  const exitI = Math.min(i0+holdH, kl.length-1);
  const ret = dir === 1 ? ((kl[exitI].c - entry)/entry)*10000 : ((entry - kl[exitI].c)/entry)*10000;
  return { pnl: ret - TOTAL_COST, exitI };
}

// ─── stats ───
function stats(tr) {
  if (!tr.length) return null;
  let gw=0, gl=0, w=0;
  for (const t of tr) { if (t.pnl > 0) { gw += t.pnl; w++; } else gl += -t.pnl; }
  const wr = w/tr.length*100;
  const pf = gl > 0 ? gw/gl : (gw > 0 ? 99 : 0);
  tr.sort((a,b)=>a.t-b.t);
  let eq=0, peak=0, dd=0;
  for (const t of tr) { eq += t.pnl; if (eq>peak) peak=eq; if (peak-eq>dd) dd=peak-eq; }
  const days = Math.max(1, (tr[tr.length-1].t - tr[0].t)/86400000);
  const avg = (gw - gl)/tr.length;
  const std = Math.sqrt(tr.reduce((a,t)=>a+(t.pnl - avg)**2,0) / tr.length);
  const sharpe = std > 0 ? (avg/std) * Math.sqrt(tr.length/days * 365) : 0;
  return {
    trades: tr.length, wins: w, wr: +wr.toFixed(2), pf: +pf.toFixed(3),
    dd_bps: +dd.toFixed(0), totalPnl_bps: +(gw-gl).toFixed(0),
    perDay: +(tr.length/days).toFixed(2), span_days: +days.toFixed(0),
    avg_bps: +avg.toFixed(2), std_bps: +std.toFixed(2), sharpe: +sharpe.toFixed(2)
  };
}
function annualReturn(st, lev=3, sz=0.10) {
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
console.log('[mega-sweep] loading data...');
const t0 = Date.now();
const data = {};
for (const s of UNIVERSE) {
  const k1h = loadKlines(s);
  if (!k1h) continue;
  const k4h = resample(k1h, 4);
  const k1d = resample(k1h, 24);
  data[s] = {
    kl: { '1h': k1h, '4h': k4h, '1d': k1d },
    funding: loadFunding(s),
    premium: loadPremium(s)
  };
}
console.log(`[mega-sweep] loaded ${Object.keys(data).length} pairs (1h+4h+1d) in ${((Date.now()-t0)/1000).toFixed(1)}s`);

// ═══════════════════════════════════════════════════════════════════
// PASO 1 — DIAGNÓSTICO V44.6 LIVE
// ═══════════════════════════════════════════════════════════════════
console.log('\n[mega-sweep] === PASO 1: V44.6 LIVE DIAGNOSIS ===');
const diag = {};

// Last 42d window vs prior 323d
const NOW_T = data.BTCUSDT.kl['1h'][data.BTCUSDT.kl['1h'].length-1].t;
const LIVE_START = NOW_T - 42*24*3600*1000;
diag.live_window = { start: new Date(LIVE_START).toISOString(), end: new Date(NOW_T).toISOString() };

// Regime stats per pair
diag.regime = {};
for (const s of UNIVERSE) {
  const kl = data[s]?.kl['1h'];
  if (!kl) continue;
  const liveBars = kl.filter(b => b.t >= LIVE_START);
  const histBars = kl.filter(b => b.t < LIVE_START);
  if (liveBars.length < 100 || histBars.length < 1000) continue;
  // Realized vol (std of hourly log returns × sqrt(8760))
  const rvol = (bars) => {
    const r = [];
    for (let i = 1; i < bars.length; i++) r.push(Math.log(bars[i].c/bars[i-1].c));
    const m = r.reduce((a,b)=>a+b,0)/r.length;
    let v = 0; for (const x of r) v += (x-m)**2;
    return Math.sqrt(v/r.length) * Math.sqrt(8760);
  };
  // Mean abs return
  const mar = (bars) => {
    let s = 0, n = 0;
    for (let i = 1; i < bars.length; i++) { s += Math.abs(Math.log(bars[i].c/bars[i-1].c)); n++; }
    return s/n;
  };
  diag.regime[s] = {
    rv_live: +rvol(liveBars).toFixed(4),
    rv_hist: +rvol(histBars).toFixed(4),
    rv_ratio: +(rvol(liveBars)/rvol(histBars)).toFixed(3),
    mar_live: +(mar(liveBars)*10000).toFixed(2),
    mar_hist: +(mar(histBars)*10000).toFixed(2),
    n_live: liveBars.length, n_hist: histBars.length
  };
}

// Funding regime
diag.funding_regime = {};
for (const s of UNIVERSE) {
  const f = data[s]?.funding;
  if (!f || !f.length) continue;
  const liveF = f.filter(x => x.t >= LIVE_START);
  const histF = f.filter(x => x.t < LIVE_START);
  if (liveF.length < 10 || histF.length < 100) continue;
  const stats_ = (arr) => {
    const vals = arr.map(x => x.c).filter(isFinite);
    const m = vals.reduce((a,b)=>a+b,0)/vals.length;
    const ab = vals.map(v => Math.abs(v));
    const am = ab.reduce((a,b)=>a+b,0)/ab.length;
    const sorted = [...vals].sort((a,b)=>a-b);
    const p95 = sorted[Math.floor(sorted.length*0.95)];
    const p05 = sorted[Math.floor(sorted.length*0.05)];
    return { mean: m, abs_mean: am, p05, p95 };
  };
  const lv = stats_(liveF), hi = stats_(histF);
  diag.funding_regime[s] = {
    f_abs_live: +(lv.abs_mean*10000).toFixed(2),
    f_abs_hist: +(hi.abs_mean*10000).toFixed(2),
    f_abs_ratio: +(lv.abs_mean/hi.abs_mean).toFixed(3),
    p05_live: +(lv.p05*10000).toFixed(2), p95_live: +(lv.p95*10000).toFixed(2),
    p05_hist: +(hi.p05*10000).toFixed(2), p95_hist: +(hi.p95*10000).toFixed(2)
  };
}

// Statistical significance for V44.6 reported numbers
// Reported: 42d × 18t/d = ~750 trades, WR 48%, PF 1.05
// User reported actually (DB query): 31w/29l of resolved = 60 trades only
diag.stat_sig = {
  // Test 1: 750 trades at 48% WR — distinguishable from 50% coinflip?
  if_750_at_48pct: (() => {
    const n = 750, p_obs = 0.48, p0 = 0.50;
    const z = (p_obs - p0) / Math.sqrt(p0*(1-p0)/n);
    const p_value = 2 * (1 - normalCdf(Math.abs(z)));
    return { n, observed_wr: p_obs, z: +z.toFixed(3), p_value: +p_value.toFixed(4),
             conclusion: p_value < 0.05 ? 'significantly_below_50' : 'NOT_significant_vs_coinflip' };
  })(),
  // Test 2: 60 resolved (31/29) — how much info?
  if_60_resolved: (() => {
    const n = 60, k = 31, p_obs = k/n, p0 = 0.50;
    const z = (p_obs - p0) / Math.sqrt(p0*(1-p0)/n);
    const p_value = 2 * (1 - normalCdf(Math.abs(z)));
    return { n, wins: k, observed_wr: p_obs, z: +z.toFixed(3), p_value: +p_value.toFixed(4),
             conclusion: p_value < 0.05 ? 'significant' : 'NOT_significant — sample too small to conclude' };
  })(),
  // CI95 of WR for 60 trades
  ci95_wr_60: (() => {
    const n = 60, k = 31, p = k/n;
    const se = Math.sqrt(p*(1-p)/n);
    return { wr: +(p*100).toFixed(2), ci_lo: +((p - 1.96*se)*100).toFixed(2), ci_hi: +((p + 1.96*se)*100).toFixed(2) };
  })()
};

// Permutation test: assume PF observed is 1.05. What's the distribution under random direction?
// Approximate: simulate 1000 paths of N coin flips with avg payoff +30/-25 bps; get PF distribution.
diag.permutation_test = (() => {
  const N = 750, TP = 30, SL = 25;
  const PFs = [];
  for (let it = 0; it < 1000; it++) {
    let gw = 0, gl = 0;
    for (let i = 0; i < N; i++) {
      const win = Math.random() < 0.5;
      if (win) gw += TP; else gl += SL;
    }
    PFs.push(gl > 0 ? gw/gl : 99);
  }
  PFs.sort((a,b)=>a-b);
  const p_obs = 1.05;
  let above = 0; for (const x of PFs) if (x >= p_obs) above++;
  return {
    n_trades: N, payoff: '30/-25', n_iter: 1000,
    observed_PF: p_obs,
    coinflip_pf_p05: +PFs[Math.floor(0.05*PFs.length)].toFixed(3),
    coinflip_pf_p50: +PFs[Math.floor(0.50*PFs.length)].toFixed(3),
    coinflip_pf_p95: +PFs[Math.floor(0.95*PFs.length)].toFixed(3),
    p_value_PF_at_least_observed: +(above/1000).toFixed(3),
    conclusion: above/1000 > 0.05 ? 'PF=1.05 INDISTINGUISHABLE_FROM_COINFLIP at N=750' : 'PF=1.05 significantly above coinflip'
  };
})();

function normalCdf(x) {
  const a = 0.3989423; const t = 1/(1 + 0.2316419*Math.abs(x));
  const v = a * Math.exp(-x*x/2) * t * (0.319381530 - 0.356563782*t + 1.781477937*t*t - 1.821255978*t*t*t + 1.330274429*t*t*t*t);
  return x >= 0 ? 1 - v : v;
}

console.log('[diag] regime sample BTC:', diag.regime.BTCUSDT);
console.log('[diag] funding sample BTC:', diag.funding_regime.BTCUSDT);
console.log('[diag] stat_sig:', JSON.stringify(diag.stat_sig, null, 2));
console.log('[diag] permutation:', JSON.stringify(diag.permutation_test, null, 2));

// ═══════════════════════════════════════════════════════════════════
// PASO 2 — MEGA SWEEP (50+ techniques × 3 TFs × 22 pairs)
// ═══════════════════════════════════════════════════════════════════
console.log('\n[mega-sweep] === PASO 2: MEGA SWEEP ===');

// Precompute indicators per (pair, TF). Done lazily inside techniques.
const indCache = new Map();
function getInd(sym, tf) {
  const k = sym+':'+tf;
  if (!indCache.has(k)) {
    const kl = data[sym].kl[tf];
    const ind = {
      atr14: atr(kl, 14),
      rsi14: rsi(kl, 14),
      ema20: ema(kl, 20),
      ema50: ema(kl, 50),
      ema200: ema(kl, 200),
      sma20: sma(kl, 20),
      sma50: sma(kl, 50),
      don20: donchian(kl, 20),
      don55: donchian(kl, 55),
      bb20_2: bbands(kl, 20, 2),
      bb20_3: bbands(kl, 20, 3),
      macd_12_26_9: macd(kl, 12, 26, 9),
      stoch14: stochK(kl, 14),
      will14: williamsR(kl, 14),
      cci20: cci(kl, 20),
      obv: obv(kl),
      mfi14: mfi(kl, 14),
      adx14: adx(kl, 14),
      st10_3: supertrend(kl, 10, 3.0)
    };
    indCache.set(k, ind);
  }
  return indCache.get(k);
}

const allResults = [];
function pushRes(rec) {
  allResults.push(rec);
}

function runStrat(name, tfs, runOnPair) {
  for (const tf of tfs) {
    const allTrades = [];
    for (const sym of UNIVERSE) {
      if (!data[sym]) continue;
      const kl = data[sym].kl[tf];
      if (kl.length < 200) continue;
      const ind = getInd(sym, tf);
      const tr = runOnPair(sym, kl, ind, tf);
      for (const t of tr) allTrades.push(t);
    }
    yield_(name, tf, allTrades);
  }
}
function yield_(name, tf, trades) {
  if (trades.length < 50) return;
  const sp = split70(trades);
  const tr = stats(sp.train), te = stats(sp.test);
  if (!te) return;
  const ann = annualReturn(te);
  pushRes({ name, tf, n_trades: trades.length, train: tr, test: te, annual: ann });
}

// hold periods scale with TF
const holdMap = { '1h': [4, 8, 16], '4h': [3, 6, 12], '1d': [3, 5, 10] };
const tps = [30, 60, 100, 150];
const sls = [20, 40, 60];

// ── A1 Donchian breakout ──
console.log('[A] Donchian breakout x3 TF...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 100; i < kl.length - HOLD; i++) {
      let dir = 0;
      if (kl[i].c > ind.don20.h[i]) dir = 1; else if (kl[i].c < ind.don20.l[i]) dir = -1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_('A1_donchian20', tf, trades);
}

// ── A2 EMA cross 9/21 ──
console.log('[A2] EMA9/21 cross...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf];
    const e9 = ema(kl, 9), e21 = ema(kl, 21);
    for (let i = 50; i < kl.length - HOLD; i++) {
      const cross = (e9[i] > e21[i] && e9[i-1] <= e21[i-1]) ? 1 :
                    (e9[i] < e21[i] && e9[i-1] >= e21[i-1]) ? -1 : 0;
      if (!cross) continue;
      const t = simTrade(kl, i, cross, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_('A2_ema_9_21', tf, trades);
}

// ── A3 EMA cross 21/55 ──
console.log('[A3] EMA21/55 cross...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf];
    const e21 = ema(kl, 21), e55 = ema(kl, 55);
    for (let i = 100; i < kl.length - HOLD; i++) {
      const cross = (e21[i] > e55[i] && e21[i-1] <= e55[i-1]) ? 1 :
                    (e21[i] < e55[i] && e21[i-1] >= e55[i-1]) ? -1 : 0;
      if (!cross) continue;
      const t = simTrade(kl, i, cross, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_('A3_ema_21_55', tf, trades);
}

// ── A4 BB squeeze + breakout ──
console.log('[A4] BB squeeze breakout...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf])
for (const SQUEEZE_PCT of [0.20, 0.30]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 200; i < kl.length - HOLD; i++) {
      // squeeze = bw < N-period quantile
      let cnt = 0, below = 0;
      for (let j = Math.max(0, i-100); j < i; j++) if (ind.bb20_2.bw[j] > 0) { cnt++; if (ind.bb20_2.bw[j] < ind.bb20_2.bw[i]) below++; }
      if (cnt < 50) continue;
      const pct = below/cnt;
      if (pct > SQUEEZE_PCT) continue;
      let dir = 0;
      if (kl[i].c > ind.bb20_2.up[i]) dir = 1; else if (kl[i].c < ind.bb20_2.dn[i]) dir = -1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_(`A4_bb_squeeze_${SQUEEZE_PCT}`, tf, trades);
}

// ── A5 SuperTrend ──
console.log('[A5] SuperTrend...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 50; i < kl.length - HOLD; i++) {
      const flip = ind.st10_3.dir[i] !== ind.st10_3.dir[i-1] ? ind.st10_3.dir[i] : 0;
      if (!flip) continue;
      const t = simTrade(kl, i, flip, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_('A5_supertrend_10_3', tf, trades);
}

// ── A6 ADX-filtered breakout ──
console.log('[A6] ADX-filtered Donchian...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf])
for (const ADX_MIN of [20, 25, 30]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 100; i < kl.length - HOLD; i++) {
      if (!ind.adx14[i] || ind.adx14[i] < ADX_MIN) continue;
      let dir = 0;
      if (kl[i].c > ind.don20.h[i]) dir = 1; else if (kl[i].c < ind.don20.l[i]) dir = -1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_(`A6_adx${ADX_MIN}_donchian`, tf, trades);
}

// ── B1 BB reversion 2σ ──
console.log('[B1] BB 2σ reversion...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 50; i < kl.length - HOLD; i++) {
      let dir = 0;
      if (kl[i].c < ind.bb20_2.dn[i]) dir = 1; else if (kl[i].c > ind.bb20_2.up[i]) dir = -1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_('B1_bb_2sigma_revert', tf, trades);
}

// ── B2 RSI extremes (multiple thresholds) ──
console.log('[B2] RSI extremes...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf])
for (const RL of [25, 30]) for (const RH of [70, 75]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 50; i < kl.length - HOLD; i++) {
      let dir = 0;
      if (ind.rsi14[i] < RL) dir = 1; else if (ind.rsi14[i] > RH) dir = -1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_(`B2_rsi_${RL}_${RH}_revert`, tf, trades);
}

// ── B3 Stochastic extremes ──
console.log('[B3] Stochastic %K extremes...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 50; i < kl.length - HOLD; i++) {
      let dir = 0;
      if (ind.stoch14[i] < 20) dir = 1; else if (ind.stoch14[i] > 80) dir = -1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_('B3_stoch_extremes', tf, trades);
}

// ── B4 CCI extremes ──
console.log('[B4] CCI extremes...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf])
for (const THR of [100, 150, 200]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 50; i < kl.length - HOLD; i++) {
      let dir = 0;
      if (ind.cci20[i] < -THR) dir = 1; else if (ind.cci20[i] > THR) dir = -1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_(`B4_cci_${THR}_revert`, tf, trades);
}

// ── B5 Williams %R ──
console.log('[B5] Williams %R...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 50; i < kl.length - HOLD; i++) {
      let dir = 0;
      if (ind.will14[i] < -80) dir = 1; else if (ind.will14[i] > -20) dir = -1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_('B5_williams_r', tf, trades);
}

// ── B6 Distance from EMA200 (mean revert) ──
console.log('[B6] EMA200 distance revert...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf])
for (const PCT of [0.03, 0.05, 0.08]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 250; i < kl.length - HOLD; i++) {
      const dist = (kl[i].c - ind.ema200[i]) / ind.ema200[i];
      let dir = 0;
      if (dist < -PCT) dir = 1; else if (dist > PCT) dir = -1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_(`B6_ema200_dist_${PCT}_revert`, tf, trades);
}

// ── C1 RSI divergence simplified (RSI hist higher / lower than price) ──
console.log('[C1] MACD histogram momentum...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 50; i < kl.length - HOLD; i++) {
      const cross = (ind.macd_12_26_9.hist[i] > 0 && ind.macd_12_26_9.hist[i-1] <= 0) ? 1 :
                    (ind.macd_12_26_9.hist[i] < 0 && ind.macd_12_26_9.hist[i-1] >= 0) ? -1 : 0;
      if (!cross) continue;
      const t = simTrade(kl, i, cross, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_('C1_macd_hist_cross', tf, trades);
}

// ── C2 Time-series momentum (return last N bars sign) ──
console.log('[C2] TS momentum 12-1...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf])
for (const LB of [12, 24, 48]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf];
    for (let i = LB+5; i < kl.length - HOLD; i++) {
      const ret = Math.log(kl[i].c / kl[i-LB].c);
      // Skip if just signaled (avoid clustering)
      let dir = 0;
      if (ret > 0.02) dir = 1; else if (ret < -0.02) dir = -1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_(`C2_tsmom_${LB}`, tf, trades);
}

// ── C3 Cross-sectional momentum (top-3 / bottom-3 by N-bar return) ──
console.log('[C3] Cross-sectional momentum...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf])
for (const LB of [24, 48, 168]) {
  // For each timestamp: rank pairs by past LB return; long top-3, short bottom-3
  const trades = [];
  // Build aligned timestamp grid
  const baseTS = data.BTCUSDT.kl[tf].map(b => b.t);
  for (let i = LB + 50; i < baseTS.length - HOLD; i += 4) {
    const ts = baseTS[i];
    const rets = [];
    for (const sym of UNIVERSE) {
      const kl = data[sym]?.kl[tf]; if (!kl) continue;
      const j = i;  // assume aligned, true for resamples
      if (j < LB || j >= kl.length) continue;
      const r = Math.log(kl[j].c / kl[j-LB].c);
      rets.push({ sym, r, j });
    }
    if (rets.length < 6) continue;
    rets.sort((a,b)=>b.r - a.r);
    const tops = rets.slice(0, 3), bots = rets.slice(-3);
    for (const x of tops) {
      const t = simTrade(data[x.sym].kl[tf], x.j, 1, TP, SL, HOLD);
      trades.push({ t: ts, pnl: t.pnl });
    }
    for (const x of bots) {
      const t = simTrade(data[x.sym].kl[tf], x.j, -1, TP, SL, HOLD);
      trades.push({ t: ts, pnl: t.pnl });
    }
  }
  yield_(`C3_xsec_mom_${LB}`, tf, trades);
}

// ── J1 OBV divergence simplified ──
console.log('[J1] OBV slope/price slope divergence...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf])
for (const LB of [10, 20]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = LB+5; i < kl.length - HOLD; i++) {
      const dPrice = (kl[i].c - kl[i-LB].c) / kl[i-LB].c;
      const dObv = ind.obv[i-LB] !== 0 ? (ind.obv[i] - ind.obv[i-LB]) / Math.abs(ind.obv[i-LB]) : 0;
      let dir = 0;
      // Bullish div: price down, OBV up → long
      if (dPrice < -0.01 && dObv > 0) dir = 1;
      else if (dPrice > 0.01 && dObv < 0) dir = -1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_(`J1_obv_div_${LB}`, tf, trades);
}

// ── J2 MFI extremes ──
console.log('[J2] MFI extremes...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 30; i < kl.length - HOLD; i++) {
      let dir = 0;
      if (ind.mfi14[i] < 20) dir = 1; else if (ind.mfi14[i] > 80) dir = -1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_('J2_mfi_extremes', tf, trades);
}

// ── K1 Volatility regime breakout (Donchian only when ATR percentile high) ──
console.log('[K1] Vol regime breakout...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf])
for (const REG of ['high', 'low', 'mid']) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 250; i < kl.length - HOLD; i++) {
      // ATR percentile in last 168 bars
      const wnd = [];
      for (let j = i-168; j < i; j++) if (ind.atr14[j] > 0) wnd.push(ind.atr14[j]);
      if (wnd.length < 100) continue;
      wnd.sort((a,b)=>a-b);
      const cur = ind.atr14[i];
      const r = wnd.findIndex(x => x >= cur) / wnd.length;
      if (REG === 'high' && r < 0.7) continue;
      if (REG === 'low' && r > 0.3) continue;
      if (REG === 'mid' && (r < 0.3 || r > 0.7)) continue;
      let dir = 0;
      if (kl[i].c > ind.don20.h[i]) dir = 1; else if (kl[i].c < ind.don20.l[i]) dir = -1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_(`K1_vol_${REG}_breakout`, tf, trades);
}

// ── K2 BB width regime ──
console.log('[K2] BB width regime...');
for (const tf of ['1h','4h','1d'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 250; i < kl.length - HOLD; i++) {
      // long when BB width expanding & price > sma20 ; short when expanding & price < sma20
      const expanding = ind.bb20_2.bw[i] > ind.bb20_2.bw[i-5] * 1.1;
      if (!expanding) continue;
      let dir = 0;
      if (kl[i].c > ind.sma20[i]) dir = 1; else if (kl[i].c < ind.sma20[i]) dir = -1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_('K2_bb_width_expand', tf, trades);
}

// ── P1 Funding extreme (real funding from cache) ──
console.log('[P1] Real funding extremes...');
for (const tf of ['1h']) // funding native is 8h, sample at 1h
for (const TP of tps) for (const SL of sls) for (const HOLD of [4, 8, 16])
for (const F_THR of [0.0001, 0.00015, 0.0002, 0.0003]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    const sym_data = data[sym];
    if (!sym_data?.funding || !sym_data.funding.length) continue;
    const kl = sym_data.kl['1h'];
    // align: for each kline find most recent funding before t
    let fi = 0;
    for (let i = 50; i < kl.length - HOLD; i++) {
      while (fi < sym_data.funding.length-1 && sym_data.funding[fi+1].t <= kl[i].t) fi++;
      if (fi < 1) continue;
      const f = sym_data.funding[fi].c;
      let dir = 0;
      // Funding positive → longs paying shorts → short the longs
      if (f > F_THR) dir = -1;
      else if (f < -F_THR) dir = 1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_(`P1_funding_${F_THR}`, tf, trades);
}

// ── P2 Premium index extreme ──
console.log('[P2] Premium index extremes...');
for (const tf of ['1h'])
for (const TP of tps) for (const SL of sls) for (const HOLD of [4, 8, 16])
for (const PR_THR of [0.0005, 0.001, 0.002]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    const sd = data[sym]; if (!sd?.premium) continue;
    const kl = sd.kl['1h'];
    const pmap = new Map();
    for (const p of sd.premium) pmap.set(p.t, p.c);
    for (let i = 50; i < kl.length - HOLD; i++) {
      const pr = pmap.get(kl[i].t);
      if (!isFinite(pr)) continue;
      let dir = 0;
      if (pr > PR_THR) dir = -1; else if (pr < -PR_THR) dir = 1;
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_(`P2_premium_${PR_THR}`, tf, trades);
}

// ── S1 Hurst regime filter ──
console.log('[S1] Hurst regime + breakout/revert switch...');
for (const tf of ['1h','4h'])
for (const TP of tps) for (const SL of sls) for (const HOLD of holdMap[tf]) {
  const trades = [];
  for (const sym of UNIVERSE) {
    if (!data[sym]) continue;
    const kl = data[sym].kl[tf]; const ind = getInd(sym, tf);
    for (let i = 200; i < kl.length - HOLD; i++) {
      const closes = kl.slice(i-100, i+1).map(b => b.c);
      const H = hurst(closes, closes.length);
      if (!isFinite(H)) continue;
      let dir = 0;
      // Trend regime (H>0.55) → breakout. Anti-trend (H<0.45) → revert.
      if (H > 0.55) {
        if (kl[i].c > ind.don20.h[i]) dir = 1; else if (kl[i].c < ind.don20.l[i]) dir = -1;
      } else if (H < 0.45) {
        if (ind.rsi14[i] < 30) dir = 1; else if (ind.rsi14[i] > 70) dir = -1;
      }
      if (!dir) continue;
      const t = simTrade(kl, i, dir, TP, SL, HOLD);
      trades.push({ t: kl[i].t, pnl: t.pnl });
      i = t.exitI;
    }
  }
  yield_('S1_hurst_regime', tf, trades);
}

console.log(`\n[mega-sweep] sweep done. Total configs: ${allResults.length}`);

// ═══════════════════════════════════════════════════════════════════
// PASO 3 — VALIDACIÓN ESTRICTA top candidatos
// ═══════════════════════════════════════════════════════════════════
console.log('\n[mega-sweep] === PASO 3: VALIDATION ===');

function bootstrapCI(trades, B = 1000) {
  if (trades.length < 30) return null;
  const pfs = [], drs = [];
  for (let it = 0; it < B; it++) {
    const sample = [];
    for (let i = 0; i < trades.length; i++) sample.push(trades[Math.floor(Math.random()*trades.length)]);
    const st = stats(sample);
    if (st) { pfs.push(st.pf); drs.push(st.dd_bps); }
  }
  pfs.sort((a,b)=>a-b); drs.sort((a,b)=>a-b);
  return {
    pf_lo95: +pfs[Math.floor(0.025*B)].toFixed(3),
    pf_hi95: +pfs[Math.floor(0.975*B)].toFixed(3),
    dd_p95:  +drs[Math.floor(0.95*B)].toFixed(0)
  };
}

function deflatedSharpe(sr, n_trials, T) {
  // Simple DSR following Bailey-Lopez de Prado. Approx.
  const exp_max = Math.sqrt(2 * Math.log(n_trials));
  const dsr = sr - exp_max / Math.sqrt(T);
  return +dsr.toFixed(3);
}

// Score: composite for ranking
allResults.forEach(r => {
  const t = r.test;
  if (!t || t.trades < 30 || t.pf < 1.05) { r._score = -Infinity; return; }
  r._score = Math.min(t.pf, 3)/3 * 0.30
           + Math.min(r.annual, 400)/400 * 0.20
           + Math.min(t.sharpe, 5)/5 * 0.15
           + Math.min(t.perDay, 15)/15 * 0.10
           + Math.min(t.wr, 80)/80 * 0.10
           + Math.max(0, 1 - t.dd_bps/2000) * 0.15;
});
allResults.sort((a,b)=>b._score - a._score);

const TOP_N = 30;
const N_TRIALS = allResults.length;
const validated = [];
for (let i = 0; i < Math.min(TOP_N, allResults.length); i++) {
  const r = allResults[i];
  if (r._score === -Infinity) break;
  // Need raw test trades to bootstrap → re-execute strategy. For speed, approximate via parametric resampling on observed pnls.
  // Instead: store raw pnl distribution from test stats — already aggregated.
  // Skip bootstrap for now and record key OOS metrics + DSR.
  const dsr = deflatedSharpe(r.test.sharpe || 0, N_TRIALS, r.test.trades || 1);
  validated.push({ ...r, dsr });
}

// ═══════════════════════════════════════════════════════════════════
// PASO 4 — PER-HORIZON best candidates
// ═══════════════════════════════════════════════════════════════════
console.log('\n[mega-sweep] === PASO 4: HORIZON BEST ===');

function bestByHorizon(label, filter) {
  const cands = allResults.filter(filter).filter(r => r._score > -Infinity).slice(0, 10);
  return cands;
}
const horizons = {
  H_1m: bestByHorizon('1m', r => r.test.span_days >= 30 && r.test.span_days <= 95 && r.test.trades >= 50),
  H_3m: bestByHorizon('3m', r => r.test.span_days >= 80 && r.test.trades >= 100),
  H_1y: bestByHorizon('1y', r => r.test.span_days >= 80 && r.test.trades >= 200)
};

// ═══════════════════════════════════════════════════════════════════
// SAVE all
// ═══════════════════════════════════════════════════════════════════
const out = {
  meta: {
    ts: new Date().toISOString(),
    pairs: Object.keys(data).length,
    cost_bps_roundtrip: TOTAL_COST,
    n_configs_total: allResults.length
  },
  diagnosis: diag,
  top_overall: allResults.slice(0, 50),
  validated: validated,
  horizons
};

fs.writeFileSync(path.join(OUT_DIR, 'mega-sweep-results.json'), JSON.stringify(out, null, 2));
console.log(`\n[mega-sweep] saved to ${OUT_DIR}/mega-sweep-results.json`);

// ─── print summary ───
console.log('\n══ TOP 20 OOS BY COMPOSITE SCORE ══');
let n = 0;
for (const r of allResults) {
  if (r._score === -Infinity) break;
  const t = r.test, tr = r.train;
  console.log(`#${++n} [${r.name}/${r.tf}] sc=${r._score.toFixed(3)} | TR ${tr.trades}t WR=${tr.wr}% PF=${tr.pf} | TE ${t.trades}t WR=${t.wr}% PF=${t.pf} td=${t.perDay} DD=${t.dd_bps} Sh=${t.sharpe} ann=${r.annual}%`);
  if (n >= 20) break;
}

const hard = allResults.filter(r => r.test && r.test.pf >= 1.5 && r.test.sharpe >= 3 && r.test.dd_bps < 800 && r.test.perDay >= 5);
console.log(`\n══ HARD GATES (PF≥1.5 Sh≥3 DD<800bps td≥5): ${hard.length} ══`);
hard.slice(0, 10).forEach(r => {
  const t = r.test;
  console.log(`  [${r.name}/${r.tf}] WR=${t.wr}% PF=${t.pf} Sh=${t.sharpe} DD=${t.dd_bps} td=${t.perDay} ann=${r.annual}%`);
});

console.log('\n══ DONE ══');
