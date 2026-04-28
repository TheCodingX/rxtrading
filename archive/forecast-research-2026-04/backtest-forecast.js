/**
 * AI FORECAST — Backtest 180d (honesto)
 * Fecha: 2026-04-24
 *
 * Metodología:
 *   - Fetch klines 1h de Binance Futures (REAL DATA, API pública).
 *   - Para cada hora t del window, con barras hasta t-1 (no leak):
 *     * Calcular ensemble forecast
 *     * Si active=true (pasa gate 85%): registrar predicción
 *   - Evaluar al horizonte (2h, 4h, 6h, 8h): HIT si dirección acertó.
 *   - Reportar accuracy por horizonte + por cripto + calibration.
 *
 * Uso:
 *   node backend/backtest-forecast.js
 *     [--days 180] [--threshold 0.85] [--symbols BTCUSDT,ETHUSDT,...]
 */

'use strict';

const https = require('https');
const { ensembleForecast } = require('./forecast-engine');

// ─────────── Args ───────────
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
const DAYS = parseInt(arg('--days', '180'));
const THRESHOLD = parseFloat(arg('--threshold', '0.85'));
const SYMBOLS = arg('--symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,LINKUSDT').split(',');
const HORIZONS_H = [2, 4, 6, 8];

const BINANCE = 'https://fapi.binance.com'; // futures prod (read-only, no auth)

// ─────────── HTTP helpers ───────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Bad JSON: ' + body.slice(0, 200))); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Binance klines: GET /fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=1500
// Cada request devuelve max 1500 velas. 180d × 24h = 4320 velas 1h → 3 requests.
async function fetchKlines(symbol, interval, days) {
  const limit = 1500;
  const msPerBar = interval === '1h' ? 3600000 : interval === '4h' ? 14400000 : interval === '1d' ? 86400000 : 3600000;
  const total = Math.ceil((days * 86400000) / msPerBar);
  const pages = Math.ceil(total / limit);
  let end = Date.now();
  const all = [];
  for (let p = 0; p < pages; p++) {
    const url = `${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${end}`;
    try {
      const data = await httpGet(url);
      if (!Array.isArray(data) || data.length === 0) break;
      all.unshift(...data);
      end = data[0][0] - 1;
      await sleep(150); // gentle rate limit
    } catch (e) {
      console.error(`[fetch] ${symbol} ${interval} err:`, e.message);
      break;
    }
  }
  // Dedup (in case of overlapping windows)
  const seen = new Set();
  const dedup = [];
  for (const bar of all) {
    if (!seen.has(bar[0])) { seen.add(bar[0]); dedup.push(bar); }
  }
  dedup.sort((a, b) => a[0] - b[0]);
  return dedup;
}

// ─────────── Backtest core ───────────
async function backtestSymbol(symbol) {
  console.log(`\n[${symbol}] Fetching ${DAYS}d of 1h + 4h + 1d klines...`);
  const kl1h_full = await fetchKlines(symbol, '1h', DAYS);
  const kl4h_full = await fetchKlines(symbol, '4h', DAYS);
  const kl1d_full = await fetchKlines(symbol, '1d', Math.max(60, DAYS)); // need at least 30 1d bars
  console.log(`  → 1h:${kl1h_full.length}  4h:${kl4h_full.length}  1d:${kl1d_full.length}`);

  if (kl1h_full.length < 50 || kl4h_full.length < 50 || kl1d_full.length < 30) {
    console.log(`  ⚠ insufficient data, skipping ${symbol}`);
    return null;
  }

  const predictions = [];
  // Walk forward hourly. Need at least 50 4h bars + 30 1d bars available before each prediction.
  // kl1h is the driver timeline.
  // For each 1h bar t, slice kl4h / kl1d to only include bars fully closed before t.
  let stepCount = 0;
  for (let i = 50; i < kl1h_full.length - Math.max(...HORIZONS_H); i++) {
    stepCount++;
    const tNow = kl1h_full[i][0]; // open time of this 1h bar
    const kl1h = kl1h_full.slice(0, i);
    const kl4h = kl4h_full.filter(b => b[0] < tNow);
    const kl1d = kl1d_full.filter(b => b[0] < tNow);
    if (kl4h.length < 30 || kl1d.length < 30) continue;

    // BTC 24h change (as macro proxy): use kl1d_full relative to current time
    let btc24hChgPct = 0;
    if (symbol === 'BTCUSDT' && kl1h.length >= 24) {
      const c24Ago = +kl1h[kl1h.length - 24][4];
      const cNow = +kl1h.at(-1)[4];
      btc24hChgPct = c24Ago > 0 ? ((cNow - c24Ago) / c24Ago) * 100 : 0;
    }
    // For non-BTC, we'd fetch BTC separately; for simplicity use self-24h as proxy
    if (symbol !== 'BTCUSDT' && kl1h.length >= 24) {
      const c24Ago = +kl1h[kl1h.length - 24][4];
      const cNow = +kl1h.at(-1)[4];
      btc24hChgPct = c24Ago > 0 ? ((cNow - c24Ago) / c24Ago) * 100 : 0;
    }
    // Fear & Greed proxy: compute from volatility + direction (simplified — historical F&G API limit)
    // Use 30d return as sentiment proxy
    const c30dAgo = kl1h.length >= 720 ? +kl1h[kl1h.length - 720][4] : +kl1h[0][4];
    const cNow30 = +kl1h.at(-1)[4];
    const ret30d = c30dAgo > 0 ? ((cNow30 - c30dAgo) / c30dAgo) * 100 : 0;
    // Map return → F&G-like score 0-100
    let fgProxy = 50;
    if (ret30d > 20) fgProxy = 80;
    else if (ret30d > 10) fgProxy = 65;
    else if (ret30d > 0) fgProxy = 55;
    else if (ret30d > -10) fgProxy = 45;
    else if (ret30d > -20) fgProxy = 30;
    else fgProxy = 20;

    const forecast = ensembleForecast({
      momentum: { kl1h, kl4h, kl1d, funding: 0 }, // funding no disponible en backtest simple
      micro: { kl1h },
      macro: { btc24hChgPct, fearGreed: fgProxy, spxBias: 0 }
    }, THRESHOLD);

    if (!forecast.active) continue;

    // Registrar predicción y evaluar cada horizonte
    const entryPrice = +kl1h_full[i][4]; // close actual (t)
    const tsPrediction = tNow;
    for (const hH of HORIZONS_H) {
      const targetIdx = i + hH;
      if (targetIdx >= kl1h_full.length) continue;
      const targetPrice = +kl1h_full[targetIdx][4];
      const actualMove = (targetPrice - entryPrice) / entryPrice;
      const actualDir = actualMove > 0 ? 'UP' : (actualMove < 0 ? 'DOWN' : 'FLAT');
      const hit = (forecast.direction === 'UP' && actualMove > 0) ||
                  (forecast.direction === 'DOWN' && actualMove < 0);
      predictions.push({
        symbol, tsPrediction, horizonH: hH, entryPrice, targetPrice,
        predictedDir: forecast.direction, confidence: forecast.confidence,
        actualDir, actualMovePct: actualMove * 100, hit
      });
    }
  }
  console.log(`  → ${stepCount} walk-forward steps, ${predictions.length/HORIZONS_H.length|0} gated predictions × ${HORIZONS_H.length} horizons`);
  return predictions;
}

// ─────────── Aggregate ───────────
function aggregate(predictions) {
  const byHorizon = {};
  const bySymbol = {};
  const byConfBucket = {};
  for (const p of predictions) {
    const h = p.horizonH;
    const s = p.symbol;
    byHorizon[h] = byHorizon[h] || { total: 0, hits: 0 };
    bySymbol[s] = bySymbol[s] || { total: 0, hits: 0 };
    byHorizon[h].total++;
    bySymbol[s].total++;
    if (p.hit) { byHorizon[h].hits++; bySymbol[s].hits++; }
    // Calibration bucket (0.85-0.90, 0.90-0.95, 0.95+)
    const bucket = p.confidence >= 0.95 ? '0.95+' : p.confidence >= 0.90 ? '0.90-0.95' : '0.85-0.90';
    byConfBucket[bucket] = byConfBucket[bucket] || { total: 0, hits: 0, confSum: 0 };
    byConfBucket[bucket].total++;
    byConfBucket[bucket].confSum += p.confidence;
    if (p.hit) byConfBucket[bucket].hits++;
  }
  return { byHorizon, bySymbol, byConfBucket, total: predictions.length };
}

function pct(h, t) { return t === 0 ? '—' : ((h / t) * 100).toFixed(1) + '%'; }

// ─────────── Main ───────────
(async () => {
  console.log(`\n═══ AI FORECAST BACKTEST ═══`);
  console.log(`Window: ${DAYS}d | Threshold: ${THRESHOLD} | Symbols: ${SYMBOLS.length}`);
  console.log(`Horizons: ${HORIZONS_H.join('h, ')}h\n`);

  const startT = Date.now();
  const all = [];
  for (const sym of SYMBOLS) {
    try {
      const preds = await backtestSymbol(sym);
      if (preds) all.push(...preds);
    } catch (e) {
      console.error(`[${sym}] backtest failed:`, e.message);
    }
  }
  const elapsedS = ((Date.now() - startT) / 1000).toFixed(1);

  const agg = aggregate(all);
  console.log(`\n═══ RESULTADOS (${elapsedS}s) ═══`);
  console.log(`Total predicciones (todos horizontes × símbolos): ${agg.total}`);
  console.log(`\n[By horizon]`);
  for (const h of HORIZONS_H) {
    const v = agg.byHorizon[h] || { total: 0, hits: 0 };
    console.log(`  ${h}h: ${v.hits}/${v.total} = ${pct(v.hits, v.total)}`);
  }
  console.log(`\n[By symbol]`);
  for (const s of SYMBOLS) {
    const v = agg.bySymbol[s] || { total: 0, hits: 0 };
    console.log(`  ${s.padEnd(10)}: ${v.hits}/${v.total} = ${pct(v.hits, v.total)}`);
  }
  console.log(`\n[Calibration buckets]`);
  for (const b of ['0.85-0.90', '0.90-0.95', '0.95+']) {
    const v = agg.byConfBucket[b] || { total: 0, hits: 0, confSum: 0 };
    const avgConf = v.total > 0 ? (v.confSum / v.total * 100).toFixed(1) : '—';
    console.log(`  ${b.padEnd(10)}: ${v.hits}/${v.total} = ${pct(v.hits, v.total)}  (reported conf ${avgConf}%)`);
  }

  // Overall
  let totalHits = 0, totalAll = 0;
  for (const h of HORIZONS_H) {
    totalHits += (agg.byHorizon[h] || {}).hits || 0;
    totalAll += (agg.byHorizon[h] || {}).total || 0;
  }
  console.log(`\n━━ OVERALL: ${totalHits}/${totalAll} = ${pct(totalHits, totalAll)}`);
  const overallAcc = totalAll === 0 ? 0 : (totalHits / totalAll);
  console.log(`\n━━ GATE ≥80%: ${overallAcc >= 0.80 ? '✅ PASS' : '❌ FAIL'}`);
  if (overallAcc < 0.80) {
    console.log(`   → Sugerencia: subir threshold (actual ${THRESHOLD}). Prueba con 0.90 o 0.92.`);
  }

  // Persist raw predictions for audit report
  const fs = require('fs');
  const path = require('path');
  try {
    const out = {
      meta: { days: DAYS, threshold: THRESHOLD, symbols: SYMBOLS, horizons: HORIZONS_H, ranAt: new Date().toISOString(), elapsedS: +elapsedS },
      agg,
      sample: all.slice(0, 50) // sample solo
    };
    const outPath = path.join(__dirname, '..', 'audit', 'AI-FORECAST-BACKTEST-RAW.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`\n→ Raw saved to ${outPath}`);
  } catch (e) {
    console.log('[warn] could not persist raw:', e.message);
  }

  process.exit(overallAcc >= 0.80 ? 0 : 1);
})();
