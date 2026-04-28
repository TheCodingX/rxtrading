// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST v10 FINAL — Dual Motor (Scalp + VIP) over 150 days real Binance data
// Bar-by-bar simulation, no look-ahead bias, pure TP/SL hit evaluation
// Trade size: $500 x5 leverage = $2500 notional
// ═══════════════════════════════════════════════════════════════════════════

const https = require('https');

// ─── Symbols per motor ───
const SCALP_SYMS = ['BTCUSDT','SOLUSDT','BNBUSDT','DOGEUSDT','LINKUSDT','ADAUSDT','SUIUSDT','ARBUSDT','OPUSDT'];
const VIP_SYMS   = ['BTCUSDT','BNBUSDT'];

// ─── Motor parameters ───
const SCALP_CFG = { tpM: 1.0, slM: 0.8, minScore: 6, minInds: 4, cooldown: 12 };
const VIP_CFG   = { tpM: 1.5, slM: 1.0, minScore: 8, minInds: 6, cooldown: 36 };

const TRADE_SIZE = 500;   // $500
const LEVERAGE   = 5;     // 5x
const NOTIONAL   = TRADE_SIZE * LEVERAGE; // $2500
const FEE_RATE   = 0.0004; // 0.04% per side (taker)

// ═══════════════════════════════════════════════════════════════════════════
// INDICATORS — exact logic from codebase (RSI, MACD, BB, Stoch, EMA, VWAP,
//              Keltner, PSAR, MFI, Volume)
// ═══════════════════════════════════════════════════════════════════════════

function calcRSI(C, p = 14) {
  if (C.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = C[i] - C[i - 1]; if (d > 0) g += d; else l += Math.abs(d); }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < C.length; i++) {
    const d = C[i] - C[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? Math.abs(d) : 0)) / p;
  }
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}

function calcEMAArr(d, p) {
  const k = 2 / (p + 1); const r = [d[0]];
  for (let i = 1; i < d.length; i++) r.push(d[i] * k + r[i - 1] * (1 - k));
  return r;
}
function calcEMA(d, p) { return calcEMAArr(d, p).at(-1); }

function calcMACD(C) {
  if (C.length < 35) return { h: 0, ph: 0 };
  const e12 = calcEMAArr(C, 12), e26 = calcEMAArr(C, 26);
  const ml = e12.map((v, i) => v - e26[i]);
  const sl = calcEMAArr(ml, 9);
  return { h: ml.at(-1) - sl.at(-1), ph: (ml.at(-2) || 0) - (sl.at(-2) || sl.at(-1)) };
}

function calcATR(H, L, C, p = 14) {
  if (C.length < p + 1) return 0;
  const trs = [];
  for (let i = 1; i < C.length; i++) trs.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
  if (trs.length < p) return trs.reduce((a, b) => a + b) / trs.length;
  let atr = trs.slice(0, p).reduce((a, b) => a + b) / p;
  for (let i = p; i < trs.length; i++) atr = (atr * (p - 1) + trs[i]) / p;
  return atr;
}

function calcStoch(H, L, C, kp = 14) {
  if (C.length < kp + 3) return { k: 50, d: 50 };
  const kA = [];
  for (let i = kp; i <= C.length; i++) {
    const sh = H.slice(i - kp, i), sl = L.slice(i - kp, i);
    const hi = Math.max(...sh), lo = Math.min(...sl);
    kA.push(hi === lo ? 50 : ((C[i - 1] - lo) / (hi - lo)) * 100);
  }
  const dA = [];
  for (let i = 2; i < kA.length; i++) dA.push((kA[i] + kA[i - 1] + kA[i - 2]) / 3);
  return { k: kA.at(-1) || 50, d: dA.at(-1) || 50 };
}

function calcBB(C, p = 20, s = 2) {
  if (C.length < p) return { u: 0, m: 0, l: 0 };
  const sl = C.slice(-p);
  const m = sl.reduce((a, b) => a + b) / p;
  const sd = Math.sqrt(sl.reduce((a, b) => a + Math.pow(b - m, 2), 0) / p);
  return { u: m + s * sd, m, l: m - s * sd };
}

function calcVWAP(klines) {
  if (!klines || !klines.length) return 0;
  let cv = 0, ct = 0;
  let last = 0;
  for (const k of klines) {
    const h = k[2], l = k[3], c = k[4], v = k[5];
    cv += v; ct += (h + l + c) / 3 * v;
    last = cv > 0 ? ct / cv : c;
  }
  return last;
}

function calcKeltner(H, L, C, ep = 20, ap = 14, m = 2) {
  const e = calcEMA(C, ep);
  const a = calcATR(H, L, C, ap);
  const upper = e + m * a, lower = e - m * a;
  const w = upper - lower;
  return { position: w > 0 ? (C.at(-1) - lower) / w : 0.5 };
}

function calcMFI(H, L, C, V, p = 14) {
  if (!H || H.length < p + 1) return 50;
  let pf = 0, nf = 0;
  for (let i = H.length - p; i < H.length; i++) {
    const tp = (H[i] + L[i] + C[i]) / 3;
    const pt = (H[i - 1] + L[i - 1] + C[i - 1]) / 3;
    if (tp > pt) pf += tp * V[i]; else nf += tp * V[i];
  }
  if (nf === 0) return 100;
  return 100 - 100 / (1 + pf / nf);
}

function calcParabolicSAR(H, L, C) {
  if (!H || H.length < 3) return { trend: 'BUY' };
  let t = 'BUY', af = 0.02, ep = H[0], sar = L[0];
  for (let i = 1; i < H.length; i++) {
    sar += af * (ep - sar);
    if (t === 'BUY') {
      if (L[i] < sar) { t = 'SELL'; sar = ep; ep = L[i]; af = 0.02; }
      else if (H[i] > ep) { ep = H[i]; af = Math.min(af + 0.02, 0.2); }
    } else {
      if (H[i] > sar) { t = 'BUY'; sar = ep; ep = H[i]; af = 0.02; }
      else if (L[i] < ep) { ep = L[i]; af = Math.min(af + 0.02, 0.2); }
    }
  }
  return { trend: t };
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA FETCHING — 150 days of 5m candles from Binance
// 150 days * 288 bars/day = 43200 bars (Binance limit 1000 per call)
// ═══════════════════════════════════════════════════════════════════════════

function fetchJSON(url) {
  return new Promise((res, rej) => {
    https.get(url, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

async function getKlines(sym, tf, limit, endTime) {
  try {
    let url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;
    return await fetchJSON(url);
  } catch (e) { return null; }
}

async function fetch150DaysCandles(sym) {
  const BARS_PER_DAY = 288; // 5m candles
  const TOTAL_BARS = 150 * BARS_PER_DAY; // 43200
  const BATCH = 1000;
  let allCandles = [];
  let endTime = Date.now();

  process.stdout.write(`  ${sym}: fetching 150d...`);

  while (allCandles.length < TOTAL_BARS) {
    const batch = await getKlines(sym, '5m', BATCH, endTime);
    if (!batch || batch.length === 0) break;
    allCandles = batch.concat(allCandles);
    endTime = batch[0][0] - 1; // before first candle of this batch
    process.stdout.write(` ${allCandles.length}`);
    await new Promise(r => setTimeout(r, 150)); // rate limit
  }

  console.log(` -> ${allCandles.length} bars (${(allCandles.length / BARS_PER_DAY).toFixed(0)}d)`);
  return allCandles;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCORING FUNCTION — 10 indicators (shared by both motors, same logic)
// RSI, MACD, BB, Stoch, EMA, VWAP, Keltner, PSAR, MFI, Volume
// ═══════════════════════════════════════════════════════════════════════════

function scoreBar(C, H, L, V, rawKlines) {
  const cur = C.at(-1);
  const rsi = calcRSI(C, 7);
  const mac = calcMACD(C);
  const e5 = calcEMAArr(C, 5).at(-1);
  const e13 = calcEMAArr(C, 13).at(-1);
  const bb = calcBB(C, 10, 1.8);
  const bbR = bb.u - bb.l;
  const bbP = bbR > 0 ? (cur - bb.l) / bbR : 0.5;
  const vwap = calcVWAP(rawKlines.slice(-50));
  const avgV = V.slice(-20).reduce((a, b) => a + b) / Math.max(V.slice(-20).length, 1);
  const vr = avgV > 0 ? V.at(-1) / avgV : 1;
  const st = calcStoch(H, L, C, 7);
  const stK = st.k || 50, stD = st.d || 50;
  const psar = calcParabolicSAR(H, L, C);
  const kc = calcKeltner(H, L, C, 20, 14, 2);
  const mfi = calcMFI(H, L, C, V, 7);
  const atr = calcATR(H, L, C, 14);

  let bS = 0, sS = 0, bI = 0, sI = 0;

  // 1. RSI
  if (rsi < 25) { bS += 3; bI++; } else if (rsi < 40) { bS += 2; bI++; } else if (rsi < 48) { bS += 1; bI++; }
  else if (rsi > 75) { sS += 3; sI++; } else if (rsi > 60) { sS += 2; sI++; } else if (rsi > 52) { sS += 1; sI++; }

  // 2. Stochastic
  if (stK < 25) { bS += 3; bI++; if (stK > stD && stK < 35) bS += 1; } else if (stK < 40) { bS += 1.5; bI++; }
  else if (stK > 75) { sS += 3; sI++; if (stK < stD && stK > 65) sS += 1; } else if (stK > 60) { sS += 1.5; sI++; }

  // 3. Bollinger Bands
  if (bbP < 0.08) { bS += 3; bI++; } else if (bbP < 0.25) { bS += 2; bI++; }
  else if (bbP > 0.92) { sS += 3; sI++; } else if (bbP > 0.75) { sS += 2; sI++; }

  // 4. MACD
  if (mac.h > 0 && mac.ph <= 0) { bS += 2.5; bI++; } else if (mac.h < 0 && mac.ph >= 0) { sS += 2.5; sI++; }
  else if (mac.h > 0) bS += 0.5; else sS += 0.5;

  // 5. EMA cross (5/13)
  if (e5 > e13) { bS += 1.5; bI++; } else { sS += 1.5; sI++; }

  // 6. VWAP
  if (vwap && cur < vwap) { bS += 1; bI++; } else if (vwap && cur > vwap) { sS += 1; sI++; }

  // 7. Volume
  if (vr > 1.5) { if (rsi < 50) { bS += 2; bI++; } else { sS += 2; sI++; } }

  // 8. Keltner Channel
  if (kc.position < 0.25) { bS += 1.5; bI++; } else if (kc.position > 0.75) { sS += 1.5; sI++; }

  // 9. Parabolic SAR
  if (psar.trend === 'BUY') { bS += 1; bI++; } else { sS += 1; sI++; }

  // 10. MFI
  if (mfi < 35) { bS += 1.5; bI++; } else if (mfi > 65) { sS += 1.5; sI++; }

  return { bS, sS, bI, sI, cur, atr };
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADE EVALUATION — pure TP/SL hit (no timeout, no trailing)
// ═══════════════════════════════════════════════════════════════════════════

function evalTrade(signal, entry, atr, tpMult, slMult, futureH, futureL) {
  const fees = entry * FEE_RATE * 2; // entry + exit fees
  const tpDist = atr * tpMult;
  const slDist = atr * slMult;

  let tpPrice, slPrice;
  if (signal === 'BUY') {
    tpPrice = entry + tpDist;
    slPrice = entry - slDist;
  } else {
    tpPrice = entry - tpDist;
    slPrice = entry + slDist;
  }

  // Walk forward bar-by-bar
  for (let i = 0; i < futureH.length; i++) {
    if (signal === 'BUY') {
      // Check SL first (conservative: assume worst case within bar)
      if (futureL[i] <= slPrice) {
        const loss = slDist + fees;
        const pnlPct = -loss / entry;
        return { win: false, pnlPct, pnlUSD: pnlPct * NOTIONAL, barsHeld: i + 1 };
      }
      if (futureH[i] >= tpPrice) {
        const gain = tpDist - fees;
        const pnlPct = gain / entry;
        return { win: true, pnlPct, pnlUSD: pnlPct * NOTIONAL, barsHeld: i + 1 };
      }
    } else {
      // SELL: check SL first
      if (futureH[i] >= slPrice) {
        const loss = slDist + fees;
        const pnlPct = -loss / entry;
        return { win: false, pnlPct, pnlUSD: pnlPct * NOTIONAL, barsHeld: i + 1 };
      }
      if (futureL[i] <= tpPrice) {
        const gain = tpDist - fees;
        const pnlPct = gain / entry;
        return { win: true, pnlPct, pnlUSD: pnlPct * NOTIONAL, barsHeld: i + 1 };
      }
    }
  }

  // Neither TP nor SL hit — close at last bar (mark to market)
  const lastClose = futureH.length > 0 ? (futureH.at(-1) + futureL.at(-1)) / 2 : entry;
  let pnlPct;
  if (signal === 'BUY') pnlPct = (lastClose - entry - fees) / entry;
  else pnlPct = (entry - lastClose - fees) / entry;
  return { win: pnlPct > 0, pnlPct, pnlUSD: pnlPct * NOTIONAL, barsHeld: futureH.length, expired: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST ENGINE — bar-by-bar walk-forward
// ═══════════════════════════════════════════════════════════════════════════

function runBacktest(allData, symbols, cfg, motorName) {
  const { tpM, slM, minScore, minInds, cooldown } = cfg;
  const LOOKBACK = 280; // bars needed for indicators to warm up
  const trades = [];
  const lastSignalBar = {}; // per-symbol cooldown tracker

  for (const sym of symbols) {
    const data = allData[sym];
    if (!data) { console.log(`    WARNING: No data for ${sym}`); continue; }

    const { C, H, L, V, rawKlines } = data;
    const totalBars = C.length;

    for (let bar = LOOKBACK; bar < totalBars - 1; bar++) {
      // Cooldown check
      const lb = lastSignalBar[sym] || -999;
      if (bar - lb < cooldown) continue;

      // Slice historical data up to current bar (no look-ahead)
      const cSlice = C.slice(Math.max(0, bar - 279), bar + 1);
      const hSlice = H.slice(Math.max(0, bar - 279), bar + 1);
      const lSlice = L.slice(Math.max(0, bar - 279), bar + 1);
      const vSlice = V.slice(Math.max(0, bar - 279), bar + 1);
      const rkSlice = rawKlines.slice(Math.max(0, bar - 279), bar + 1);

      // Score the bar
      const score = scoreBar(cSlice, hSlice, lSlice, vSlice, rkSlice);

      // Generate signal
      let signal = null;
      if (score.bS >= minScore && score.bI >= minInds && score.bS > score.sS) {
        signal = 'BUY';
      } else if (score.sS >= minScore && score.sI >= minInds && score.sS > score.bS) {
        signal = 'SELL';
      }

      if (!signal) continue;

      // Mark cooldown
      lastSignalBar[sym] = bar;

      // Future bars for evaluation (rest of available data)
      const futH = H.slice(bar + 1);
      const futL = L.slice(bar + 1);

      // Evaluate trade
      const result = evalTrade(signal, score.cur, score.atr, tpM, slM, futH, futL);

      trades.push({
        sym,
        bar,
        signal,
        entry: score.cur,
        atr: score.atr,
        buyScore: score.bS,
        sellScore: score.sS,
        buyInds: score.bI,
        sellInds: score.sI,
        ...result
      });
    }
  }

  return trades;
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORTING
// ═══════════════════════════════════════════════════════════════════════════

function report(trades, motorName) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  ${motorName} MOTOR — RESULTS`);
  console.log(`${'═'.repeat(80)}`);

  if (trades.length === 0) {
    console.log('  No trades generated.\n');
    return;
  }

  const wins = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const totalPnL = trades.reduce((s, t) => s + t.pnlUSD, 0);
  const wr = (wins.length / trades.length * 100);
  const grossWin = wins.reduce((s, t) => s + t.pnlUSD, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUSD, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const avgWin = wins.length > 0 ? grossWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

  // Max consecutive losses
  let maxConsecLoss = 0, curConsec = 0;
  for (const t of trades) {
    if (!t.win) { curConsec++; maxConsecLoss = Math.max(maxConsecLoss, curConsec); }
    else curConsec = 0;
  }

  // Expired trades (neither TP nor SL hit)
  const expired = trades.filter(t => t.expired);

  console.log(`\n  SUMMARY:`);
  console.log(`  ────────────────────────────────────────────────────`);
  console.log(`  Total Signals:        ${trades.length}`);
  console.log(`  Wins:                 ${wins.length}`);
  console.log(`  Losses:               ${losses.length}`);
  console.log(`  Win Rate:             ${wr.toFixed(1)}%`);
  console.log(`  Profit Factor:        ${pf === Infinity ? 'INF' : pf.toFixed(2)}`);
  console.log(`  Total PnL:            $${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}`);
  console.log(`  Avg Win:              $${avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:             $${avgLoss.toFixed(2)}`);
  console.log(`  Max Consec. Losses:   ${maxConsecLoss}`);
  if (expired.length > 0) console.log(`  Expired (no TP/SL):   ${expired.length}`);
  console.log(`  Avg Bars Held:        ${(trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length).toFixed(1)}`);
  console.log(`  Trade Size:           $${TRADE_SIZE} x${LEVERAGE} = $${NOTIONAL} notional`);

  // Per-symbol breakdown
  console.log(`\n  PER-SYMBOL BREAKDOWN:`);
  console.log(`  ${'Symbol'.padEnd(10)} ${'Sigs'.padStart(5)} ${'Wins'.padStart(5)} ${'Loss'.padStart(5)} ${'WR%'.padStart(6)} ${'PnL ($)'.padStart(10)} ${'AvgWin'.padStart(8)} ${'AvgLoss'.padStart(8)}`);
  console.log(`  ${'-'.repeat(68)}`);

  const symSet = [...new Set(trades.map(t => t.sym))].sort();
  for (const sym of symSet) {
    const st = trades.filter(t => t.sym === sym);
    const sw = st.filter(t => t.win);
    const sl = st.filter(t => !t.win);
    const sp = st.reduce((s, t) => s + t.pnlUSD, 0);
    const swr = st.length > 0 ? (sw.length / st.length * 100) : 0;
    const saw = sw.length > 0 ? sw.reduce((s, t) => s + t.pnlUSD, 0) / sw.length : 0;
    const sal = sl.length > 0 ? Math.abs(sl.reduce((s, t) => s + t.pnlUSD, 0)) / sl.length : 0;
    console.log(`  ${sym.padEnd(10)} ${String(st.length).padStart(5)} ${String(sw.length).padStart(5)} ${String(sl.length).padStart(5)} ${swr.toFixed(1).padStart(6)} ${(sp >= 0 ? '+' : '') + sp.toFixed(2).padStart(sp >= 0 ? 9 : 10)} ${saw.toFixed(2).padStart(8)} ${sal.toFixed(2).padStart(8)}`);
  }

  // Direction breakdown
  console.log(`\n  BY DIRECTION:`);
  for (const dir of ['BUY', 'SELL']) {
    const dt = trades.filter(t => t.signal === dir);
    if (dt.length === 0) continue;
    const dw = dt.filter(t => t.win);
    const dp = dt.reduce((s, t) => s + t.pnlUSD, 0);
    console.log(`  ${dir.padEnd(6)} ${dt.length} sigs, WR=${(dw.length / dt.length * 100).toFixed(1)}%, PnL=$${dp >= 0 ? '+' : ''}${dp.toFixed(2)}`);
  }

  // Equity curve stats
  let equity = 0, peak = 0, maxDD = 0;
  const equityCurve = [];
  for (const t of trades) {
    equity += t.pnlUSD;
    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  console.log(`\n  EQUITY CURVE:`);
  console.log(`  Peak Equity:          $${peak.toFixed(2)}`);
  console.log(`  Max Drawdown:         $${maxDD.toFixed(2)}`);
  console.log(`  Final Equity:         $${equity.toFixed(2)}`);

  return { totalPnL, wr, pf, wins: wins.length, losses: losses.length, maxConsecLoss, avgWin, avgLoss };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(80));
  console.log('  BACKTEST v10 FINAL — DUAL MOTOR (SCALP + VIP)');
  console.log('  150 days | 5m candles | Real Binance data | Bar-by-bar');
  console.log('  $500 x5 leverage | Pure TP/SL evaluation');
  console.log('═'.repeat(80));
  console.log();

  // Collect all unique symbols
  const allSyms = [...new Set([...SCALP_SYMS, ...VIP_SYMS])];
  const allData = {};

  console.log(`  Downloading data for ${allSyms.length} symbols (150 days each)...\n`);

  for (const sym of allSyms) {
    const candles = await fetch150DaysCandles(sym);
    if (!candles || candles.length < 1000) {
      console.log(`  WARNING: Insufficient data for ${sym} (${candles ? candles.length : 0} bars)`);
      continue;
    }
    allData[sym] = {
      C: candles.map(k => parseFloat(k[4])),
      H: candles.map(k => parseFloat(k[2])),
      L: candles.map(k => parseFloat(k[3])),
      V: candles.map(k => parseFloat(k[5])),
      T: candles.map(k => k[0]),
      rawKlines: candles.map(k => [k[0], k[1], parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4]), parseFloat(k[5])]),
      len: candles.length
    };
  }

  console.log(`\n  Data loaded for ${Object.keys(allData).length} symbols\n`);

  // ─── Run Scalp Motor ───
  console.log('  Running SCALP motor backtest...');
  console.log(`  Params: TP=${SCALP_CFG.tpM}x ATR, SL=${SCALP_CFG.slM}x ATR, score>=${SCALP_CFG.minScore}, ${SCALP_CFG.minInds} inds, ${SCALP_CFG.cooldown}-bar cooldown`);
  console.log(`  Symbols: ${SCALP_SYMS.join(', ')}`);
  const scalpTrades = runBacktest(allData, SCALP_SYMS, SCALP_CFG, 'SCALP');
  const scalpStats = report(scalpTrades, 'SCALP');

  // ─── Run VIP Motor ───
  console.log('\n  Running VIP motor backtest...');
  console.log(`  Params: TP=${VIP_CFG.tpM}x ATR, SL=${VIP_CFG.slM}x ATR, score>=${VIP_CFG.minScore}, ${VIP_CFG.minInds} inds, ${VIP_CFG.cooldown}-bar cooldown`);
  console.log(`  Symbols: ${VIP_SYMS.join(', ')}`);
  const vipTrades = runBacktest(allData, VIP_SYMS, VIP_CFG, 'VIP');
  const vipStats = report(vipTrades, 'VIP');

  // ─── Combined Summary ───
  console.log(`\n${'═'.repeat(80)}`);
  console.log('  COMBINED SUMMARY (BOTH MOTORS)');
  console.log(`${'═'.repeat(80)}`);
  const allTrades = [...scalpTrades, ...vipTrades];
  const totalPnL = allTrades.reduce((s, t) => s + t.pnlUSD, 0);
  const totalWins = allTrades.filter(t => t.win).length;
  const totalLosses = allTrades.filter(t => !t.win).length;
  const combinedWR = allTrades.length > 0 ? (totalWins / allTrades.length * 100) : 0;
  console.log(`  Total Trades:  ${allTrades.length} (Scalp: ${scalpTrades.length}, VIP: ${vipTrades.length})`);
  console.log(`  Combined WR:   ${combinedWR.toFixed(1)}%`);
  console.log(`  Combined PnL:  $${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}`);
  console.log(`  Scalp PnL:     $${scalpStats ? (scalpStats.totalPnL >= 0 ? '+' : '') + scalpStats.totalPnL.toFixed(2) : '0.00'}`);
  console.log(`  VIP PnL:       $${vipStats ? (vipStats.totalPnL >= 0 ? '+' : '') + vipStats.totalPnL.toFixed(2) : '0.00'}`);
  console.log(`${'═'.repeat(80)}\n`);
}

main().catch(e => console.error('FATAL:', e));
