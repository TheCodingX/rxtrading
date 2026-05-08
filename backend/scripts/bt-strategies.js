// Multi-strategy backtest over 365d real Binance data.
// Tests 4 strategies completely independent of funding-carry to find ANY structural edge.
'use strict';
const fs = require('fs');
const path = require('path');

const CACHE_DIR = '/tmp/v447-data';
const UNIVERSE = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT',
  'ARBUSDT','ATOMUSDT','TRXUSDT','NEARUSDT','POLUSDT','INJUSDT','SUIUSDT','AVAXUSDT',
  'OPUSDT','DOTUSDT','RENDERUSDT','1000PEPEUSDT','1000SHIBUSDT','JUPUSDT'
];

function loadKlines(sym) {
  const f = path.join(CACHE_DIR, `${sym}-klines-1h.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// ─────── Indicators ───────
function atr(klines, lookback = 14) {
  const n = klines.length;
  const out = new Float64Array(n);
  for (let i = lookback; i < n; i++) {
    let sum = 0;
    for (let j = i - lookback + 1; j <= i; j++) {
      const tr = Math.max(
        klines[j].h - klines[j].l,
        Math.abs(klines[j].h - klines[j-1].c),
        Math.abs(klines[j].l - klines[j-1].c)
      );
      sum += tr;
    }
    out[i] = sum / lookback;
  }
  return out;
}

function donchian(klines, period = 20) {
  const n = klines.length;
  const high = new Float64Array(n);
  const low  = new Float64Array(n);
  for (let i = period; i < n; i++) {
    let h = -Infinity, l = Infinity;
    for (let j = i - period; j < i; j++) {
      if (klines[j].h > h) h = klines[j].h;
      if (klines[j].l < l) l = klines[j].l;
    }
    high[i] = h; low[i] = l;
  }
  return { high, low };
}

function volMA(klines, period = 20) {
  const n = klines.length;
  const out = new Float64Array(n);
  for (let i = period; i < n; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += klines[j].v;
    out[i] = s / period;
  }
  return out;
}

function rsi(klines, period = 14) {
  const n = klines.length;
  const out = new Float64Array(n);
  let avgG = 0, avgL = 0;
  for (let i = 1; i < n; i++) {
    const ch = klines[i].c - klines[i-1].c;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    if (i <= period) {
      avgG = (avgG * (i - 1) + g) / i;
      avgL = (avgL * (i - 1) + l) / i;
    } else {
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
    }
    if (i >= period) {
      const rs = avgL > 0 ? avgG / avgL : 999;
      out[i] = 100 - (100 / (1 + rs));
    }
  }
  return out;
}

// ─────── Trade simulator (intrabar TP/SL on next bars) ───────
function simulateTrade(klines, entryI, dir, tpBps, slBps, holdH, feeBps) {
  const entry = klines[entryI].c;
  const tp = dir === 1 ? entry * (1 + tpBps/10000) : entry * (1 - tpBps/10000);
  const sl = dir === 1 ? entry * (1 - slBps/10000) : entry * (1 + slBps/10000);
  for (let j = entryI + 1; j <= entryI + holdH && j < klines.length; j++) {
    const fb = klines[j];
    if (dir === 1) {
      const tpHit = fb.h >= tp;
      const slHit = fb.l <= sl;
      if (tpHit && slHit) return { pnl_bps: -slBps - feeBps, outcome: 'LOSS', exitI: j };
      if (tpHit) return { pnl_bps: tpBps - feeBps, outcome: 'WIN', exitI: j };
      if (slHit) return { pnl_bps: -slBps - feeBps, outcome: 'LOSS', exitI: j };
    } else {
      const tpHit = fb.l <= tp;
      const slHit = fb.h >= sl;
      if (tpHit && slHit) return { pnl_bps: -slBps - feeBps, outcome: 'LOSS', exitI: j };
      if (tpHit) return { pnl_bps: tpBps - feeBps, outcome: 'WIN', exitI: j };
      if (slHit) return { pnl_bps: -slBps - feeBps, outcome: 'LOSS', exitI: j };
    }
  }
  // Timeout
  const exitI = Math.min(entryI + holdH, klines.length - 1);
  const exit = klines[exitI].c;
  const pnl = dir === 1 ? ((exit - entry) / entry) * 10000 : ((entry - exit) / entry) * 10000;
  return { pnl_bps: pnl - feeBps, outcome: 'TIMEOUT', exitI };
}

// ─────── Strategy 1: Volatility Compression Breakout ───────
// When ATR(14) drops below its 168h 25th percentile (compression),
// look for Donchian breakout in next bars.
function strat1_volBreakout(klines, params) {
  const trades = [];
  const a14 = atr(klines, 14);
  const don = donchian(klines, params.DONCHIAN_PERIOD);
  // Rolling ATR percentile
  const a25 = new Float64Array(klines.length);
  for (let i = 168; i < klines.length; i++) {
    const w = [];
    for (let j = i - 168; j < i; j++) if (a14[j] > 0) w.push(a14[j]);
    w.sort((x,y)=>x-y);
    a25[i] = w.length ? w[Math.floor(w.length*0.25)] : NaN;
  }
  for (let i = 200; i < klines.length - params.HOLD_H; i++) {
    const bar = klines[i];
    if (!isFinite(a14[i]) || !isFinite(a25[i])) continue;
    if (a14[i] > a25[i] * params.SQUEEZE_RATIO) continue; // not compressed
    let dir = 0;
    if (bar.c > don.high[i]) dir = 1;
    else if (bar.c < don.low[i]) dir = -1;
    if (!dir) continue;
    const trade = simulateTrade(klines, i, dir, params.TP, params.SL, params.HOLD_H, params.FEE);
    trades.push({ t: bar.t, dir, ...trade, sym: klines[0].sym });
    i = trade.exitI;
  }
  return trades;
}

// ─────── Strategy 2: Big Candle Fade (liquidation cascade proxy) ───────
// When current 1h candle |body| > N × ATR(14) AND volume > M × volMA(20),
// take opposite-direction trade at next bar open.
function strat2_bigCandleFade(klines, params) {
  const trades = [];
  const a14 = atr(klines, 14);
  const vMA = volMA(klines, 20);
  for (let i = 30; i < klines.length - params.HOLD_H - 1; i++) {
    const bar = klines[i];
    if (!isFinite(a14[i]) || a14[i] <= 0) continue;
    if (!isFinite(vMA[i]) || vMA[i] <= 0) continue;
    const body = Math.abs(bar.c - bar.o);
    const bodyAtr = body / a14[i];
    const volRatio = bar.v / vMA[i];
    if (bodyAtr < params.BODY_ATR_MIN) continue;
    if (volRatio < params.VOL_RATIO_MIN) continue;
    // Direction: fade — opposite to candle direction
    const dir = bar.c > bar.o ? -1 : 1;
    // Entry at next bar open (i+1 close as proxy)
    const trade = simulateTrade(klines, i + 1, dir, params.TP, params.SL, params.HOLD_H, params.FEE);
    trades.push({ t: klines[i+1].t, dir, ...trade, sym: klines[0].sym });
    i = trade.exitI;
  }
  return trades;
}

// ─────── Strategy 3: BTC-ETH spread mean-revert (pairs trading) ───────
function strat3_pairsBTCETH(btcKL, ethKL, params) {
  const trades = [];
  // Align by timestamp
  const ethMap = new Map();
  for (const e of ethKL) ethMap.set(e.t, e);
  // Compute log-spread normalized by initial ratio
  const N = btcKL.length;
  const spread = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const e = ethMap.get(btcKL[i].t);
    if (!e) { spread[i] = NaN; continue; }
    spread[i] = Math.log(btcKL[i].c) - Math.log(e.c);
  }
  // Z-score on rolling 168h
  for (let i = 200; i < N - params.HOLD_H; i++) {
    if (!isFinite(spread[i])) continue;
    let sum = 0, n = 0;
    for (let j = i - 168; j < i; j++) if (isFinite(spread[j])) { sum += spread[j]; n++; }
    if (n < 100) continue;
    const mean = sum / n;
    let vsum = 0;
    for (let j = i - 168; j < i; j++) if (isFinite(spread[j])) vsum += (spread[j] - mean)**2;
    const std = Math.sqrt(vsum / n);
    if (std <= 0) continue;
    const z = (spread[i] - mean) / std;
    let dir = 0;
    let sym = null;
    // Spread = log(BTC) - log(ETH). High z → BTC strong vs ETH → fade BTC (short BTC) OR long ETH
    // Trade BTC: dir=-1 if z>thr, dir=1 if z<-thr
    if (z > params.Z_THR) { dir = -1; sym = 'BTC'; }
    else if (z < -params.Z_THR) { dir = 1; sym = 'BTC'; }
    if (!dir) continue;
    const trade = simulateTrade(btcKL, i, dir, params.TP, params.SL, params.HOLD_H, params.FEE);
    trades.push({ t: btcKL[i].t, dir, ...trade, sym: 'BTCUSDT' });
    i = trade.exitI;
  }
  return trades;
}

// ─────── Strategy 4: RSI extreme + ATR-regime aware ───────
// Long when RSI(14) < 25 AND ATR is in mid-range (not extreme). Short when RSI > 75 AND ATR mid.
function strat4_rsiExtreme(klines, params) {
  const trades = [];
  const r = rsi(klines, 14);
  const a14 = atr(klines, 14);
  for (let i = 200; i < klines.length - params.HOLD_H; i++) {
    if (!isFinite(r[i]) || !isFinite(a14[i])) continue;
    // ATR percentile over last 168h
    const w = [];
    for (let j = i - 168; j < i; j++) if (a14[j] > 0) w.push(a14[j]);
    if (w.length < 100) continue;
    w.sort((x,y)=>x-y);
    const a20 = w[Math.floor(w.length*0.20)];
    const a80 = w[Math.floor(w.length*0.80)];
    if (params.ATR_REGIME === 'mid' && (a14[i] < a20 || a14[i] > a80)) continue;
    if (params.ATR_REGIME === 'low' && a14[i] > a20) continue;
    if (params.ATR_REGIME === 'high' && a14[i] < a80) continue;

    let dir = 0;
    if (r[i] < params.RSI_LOW) dir = 1;
    else if (r[i] > params.RSI_HIGH) dir = -1;
    if (!dir) continue;
    if (params.INVERT) dir = -dir;
    const trade = simulateTrade(klines, i, dir, params.TP, params.SL, params.HOLD_H, params.FEE);
    trades.push({ t: klines[i].t, dir, ...trade, sym: klines[0].sym });
    i = trade.exitI;
  }
  return trades;
}

// ─────── Stats ───────
function statsOf(trades) {
  if (!trades.length) return { trades: 0, wr: 0, pf: 0, dd: 0, perDay: 0, totalPnl: 0 };
  const wins = trades.filter(t => t.pnl_bps > 0);
  const losses = trades.filter(t => t.pnl_bps <= 0);
  const gw = wins.reduce((s,t)=>s+t.pnl_bps,0);
  const gl = Math.abs(losses.reduce((s,t)=>s+t.pnl_bps,0));
  const wr = wins.length / trades.length * 100;
  const pf = gl > 0 ? gw/gl : (gw > 0 ? 99 : 0);
  trades.sort((a,b)=>a.t-b.t);
  let eq=0, peak=0, maxDD=0;
  for (const t of trades) { eq += t.pnl_bps; if (eq>peak) peak=eq; if (peak-eq>maxDD) maxDD=peak-eq; }
  const span = trades[trades.length-1].t - trades[0].t;
  const days = Math.max(1, span/86400000);
  const perDay = trades.length / days;
  return {
    trades: trades.length, wins: wins.length, losses: losses.length,
    wr: +wr.toFixed(2), pf: +pf.toFixed(3), dd_bps: +maxDD.toFixed(0),
    totalPnl_bps: +(gw-gl).toFixed(0), perDay: +perDay.toFixed(2),
    span_days: +days.toFixed(0)
  };
}

function annualReturn(stats, lev=3, sizePct=0.10) {
  if (!stats.trades) return 0;
  const avg = stats.totalPnl_bps / stats.trades;
  const tpy = stats.perDay * 365;
  const eff = avg * lev * sizePct / 10000;
  return +(((1+eff)**tpy - 1) * 100).toFixed(1);
}

function splitT(trades, ratio=0.7) {
  trades.sort((a,b)=>a.t-b.t);
  if (!trades.length) return { train: [], test: [] };
  const cut = trades[0].t + (trades[trades.length-1].t-trades[0].t)*ratio;
  return { train: trades.filter(t=>t.t<cut), test: trades.filter(t=>t.t>=cut) };
}

// Load all pair klines once
console.log('Loading pair klines...');
const pairKL = {};
for (const sym of UNIVERSE) {
  const k = loadKlines(sym);
  if (k) {
    for (const b of k) b.sym = sym;
    k[0].sym = sym;
    pairKL[sym] = k;
  }
}
console.log(`Loaded ${Object.keys(pairKL).length} pairs`);

function runStrat(stratFn, params, syms = UNIVERSE) {
  const all = [];
  for (const s of syms) {
    if (!pairKL[s]) continue;
    const t = stratFn(pairKL[s], params);
    all.push(...t);
  }
  return all;
}

const FEE = 8;
const results = [];

// ── Strategy 1: Vol Compression Breakout ──
console.log('\n[Strat 1] Vol compression breakout');
for (const TP of [60, 100, 150, 200])
for (const SL of [20, 30, 50])
for (const HOLD of [4, 8, 16])
for (const SR of [0.7, 1.0, 1.3])
for (const DP of [12, 20, 36]) {
  const params = { TP, SL, HOLD_H: HOLD, SQUEEZE_RATIO: SR, DONCHIAN_PERIOD: DP, FEE };
  const trades = runStrat(strat1_volBreakout, params);
  if (trades.length < 100) continue;
  const sp = splitT(trades);
  const tr = statsOf(sp.train), te = statsOf(sp.test);
  const ann = annualReturn(te);
  results.push({ strat: 'vol_breakout', params, train: tr, test: te, annual: ann });
}

// ── Strategy 2: Big Candle Fade ──
console.log('[Strat 2] Big candle fade');
for (const TP of [30, 50, 80, 120])
for (const SL of [15, 25, 40])
for (const HOLD of [4, 8, 16])
for (const BAM of [1.0, 1.5, 2.0, 2.5])
for (const VRM of [1.0, 1.5, 2.0, 3.0]) {
  const params = { TP, SL, HOLD_H: HOLD, BODY_ATR_MIN: BAM, VOL_RATIO_MIN: VRM, FEE };
  const trades = runStrat(strat2_bigCandleFade, params);
  if (trades.length < 100) continue;
  const sp = splitT(trades);
  const tr = statsOf(sp.train), te = statsOf(sp.test);
  const ann = annualReturn(te);
  results.push({ strat: 'bigcandle_fade', params, train: tr, test: te, annual: ann });
}

// ── Strategy 3: BTC-ETH pairs ──
console.log('[Strat 3] BTC-ETH pairs spread');
if (pairKL.BTCUSDT && pairKL.ETHUSDT) {
  for (const TP of [30, 60, 100])
  for (const SL of [20, 30, 50])
  for (const HOLD of [4, 8, 16, 24])
  for (const Z of [1.5, 2.0, 2.5, 3.0]) {
    const params = { TP, SL, HOLD_H: HOLD, Z_THR: Z, FEE };
    const trades = strat3_pairsBTCETH(pairKL.BTCUSDT, pairKL.ETHUSDT, params);
    if (trades.length < 50) continue;
    const sp = splitT(trades);
    const tr = statsOf(sp.train), te = statsOf(sp.test);
    const ann = annualReturn(te);
    results.push({ strat: 'pairs_btceth', params, train: tr, test: te, annual: ann });
  }
}

// ── Strategy 4: RSI extreme + ATR regime ──
console.log('[Strat 4] RSI extreme + ATR regime');
for (const TP of [30, 60, 100])
for (const SL of [15, 25, 40])
for (const HOLD of [4, 8, 16])
for (const RL of [20, 25, 30])
for (const RH of [70, 75, 80])
for (const REG of ['mid', 'low', 'high', 'all'])
for (const INV of [false, true]) {
  const params = { TP, SL, HOLD_H: HOLD, RSI_LOW: RL, RSI_HIGH: RH, ATR_REGIME: REG, INVERT: INV, FEE };
  const trades = runStrat(strat4_rsiExtreme, params);
  if (trades.length < 100) continue;
  const sp = splitT(trades);
  const tr = statsOf(sp.train), te = statsOf(sp.test);
  const ann = annualReturn(te);
  results.push({ strat: 'rsi_atr', params, train: tr, test: te, annual: ann });
}

console.log(`\nTotal configs evaluated: ${results.length}`);

// Score: profit-first, then targets
function score(r) {
  const t = r.test;
  if (!t.trades || t.trades < 30) return -Infinity;
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
results.sort((a,b) => b._score - a._score);

console.log('\n═══ TOP 20 PROFITABLE OOS ═══');
let n = 0;
for (const r of results) {
  if (r._score === -Infinity) break;
  const t = r.test, tr = r.train;
  console.log(`#${++n} [${r.strat}] score=${r._score.toFixed(3)} ${JSON.stringify(r.params).slice(0,160)}`);
  console.log(`   TRAIN: ${tr.trades}t WR=${tr.wr}% PF=${tr.pf} td=${tr.perDay} DD=${tr.dd_bps}bps`);
  console.log(`   TEST : ${t.trades}t WR=${t.wr}% PF=${t.pf} td=${t.perDay} DD=${t.dd_bps}bps annual=${r.annual}%`);
  if (n >= 20) break;
}

// Per-strategy best
console.log('\n═══ BEST PER STRATEGY ═══');
const byStrat = {};
for (const r of results) {
  if (r._score === -Infinity) continue;
  if (!byStrat[r.strat] || r._score > byStrat[r.strat]._score) byStrat[r.strat] = r;
}
for (const [s, r] of Object.entries(byStrat)) {
  const t = r.test;
  console.log(`[${s}] WR=${t.wr}% PF=${t.pf} td=${t.perDay} DD=${t.dd_bps}bps annual=${r.annual}% (${t.trades} trades OOS)`);
}

const hard = results.filter(r => {
  const t = r.test;
  return t.wr >= 70 && t.pf >= 1.5 && t.perDay >= 10 && r.annual >= 200 && t.dd_bps < 1500;
});
console.log(`\n═══ HARD TARGETS (WR≥70 PF≥1.5 td≥10 ann≥200% DD<1500): ${hard.length} configs ═══`);
hard.slice(0,10).forEach(r => {
  const t = r.test;
  console.log(`  [${r.strat}] WR=${t.wr}% PF=${t.pf} td=${t.perDay} DD=${t.dd_bps}bps ann=${r.annual}% ${JSON.stringify(r.params).slice(0,120)}`);
});

fs.writeFileSync('/tmp/v447-data/strategies-results.json', JSON.stringify(results.slice(0,200), null, 2));
console.log(`\nSaved top-200 to /tmp/v447-data/strategies-results.json`);
