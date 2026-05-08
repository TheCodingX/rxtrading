// V44.7 BACKTEST DATA DOWNLOADER
// Pulls 365d of 1h klines (with OHLC), 1h premiumIndex, and 8h fundingRate history
// from Binance fapi for the production universe. Caches JSON to /tmp/v447-data/.
// Idempotent — skips files that already exist.

'use strict';
const fs = require('fs');
const path = require('path');

const UNIVERSE = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','ADAUSDT','DOGEUSDT','LINKUSDT',
  'ARBUSDT','ATOMUSDT','TRXUSDT','NEARUSDT','POLUSDT','INJUSDT','SUIUSDT','AVAXUSDT',
  'OPUSDT','DOTUSDT','RENDERUSDT','1000PEPEUSDT','1000SHIBUSDT','JUPUSDT'
];

const DAYS_BACK = 365;
const END = Date.now();
const START = END - DAYS_BACK * 86400000;
const CACHE_DIR = '/tmp/v447-data';
fs.mkdirSync(CACHE_DIR, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url, attempt = 0) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.status === 429 || r.status === 418) {
      await sleep(2000);
      if (attempt < 3) return fetchJSON(url, attempt + 1);
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (attempt < 2) {
      await sleep(1000);
      return fetchJSON(url, attempt + 1);
    }
    throw e;
  }
}

async function downloadKlines1h(sym) {
  const out = [];
  let cursor = START;
  while (cursor < END) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1h&startTime=${cursor}&limit=1500`;
    const arr = await fetchJSON(url);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const k of arr) {
      out.push({
        t: k[0],
        o: parseFloat(k[1]),
        h: parseFloat(k[2]),
        l: parseFloat(k[3]),
        c: parseFloat(k[4]),
        v: parseFloat(k[5])
      });
    }
    if (arr.length < 1500) break;
    cursor = arr[arr.length - 1][0] + 3600000;
    await sleep(80);
  }
  return out;
}

async function downloadPremium1h(sym) {
  const out = [];
  let cursor = START;
  while (cursor < END) {
    const url = `https://fapi.binance.com/fapi/v1/premiumIndexKlines?symbol=${sym}&interval=1h&startTime=${cursor}&limit=1500`;
    const arr = await fetchJSON(url);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const k of arr) {
      out.push({ t: k[0], c: parseFloat(k[4]) }); // close = avg premium for that hour
    }
    if (arr.length < 1500) break;
    cursor = arr[arr.length - 1][0] + 3600000;
    await sleep(80);
  }
  return out;
}

async function downloadFunding(sym) {
  const out = [];
  let cursor = START;
  while (cursor < END) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${cursor}&limit=1000`;
    const arr = await fetchJSON(url);
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const f of arr) {
      out.push({ t: f.fundingTime, c: parseFloat(f.fundingRate) });
    }
    if (arr.length < 1000) break;
    cursor = arr[arr.length - 1].fundingTime + 1;
    await sleep(80);
  }
  return out;
}

(async () => {
  for (const sym of UNIVERSE) {
    const klFile = path.join(CACHE_DIR, `${sym}-klines-1h.json`);
    const prFile = path.join(CACHE_DIR, `${sym}-premium-1h.json`);
    const fdFile = path.join(CACHE_DIR, `${sym}-funding.json`);

    try {
      if (!fs.existsSync(klFile)) {
        process.stdout.write(`[${sym}] klines... `);
        const t0 = Date.now();
        const k = await downloadKlines1h(sym);
        fs.writeFileSync(klFile, JSON.stringify(k));
        console.log(`${k.length} bars in ${Date.now() - t0}ms`);
      } else {
        console.log(`[${sym}] klines cached`);
      }

      if (!fs.existsSync(prFile)) {
        process.stdout.write(`[${sym}] premium... `);
        const t0 = Date.now();
        const p = await downloadPremium1h(sym);
        fs.writeFileSync(prFile, JSON.stringify(p));
        console.log(`${p.length} bars in ${Date.now() - t0}ms`);
      } else {
        console.log(`[${sym}] premium cached`);
      }

      if (!fs.existsSync(fdFile)) {
        process.stdout.write(`[${sym}] funding... `);
        const t0 = Date.now();
        const f = await downloadFunding(sym);
        fs.writeFileSync(fdFile, JSON.stringify(f));
        console.log(`${f.length} fundings in ${Date.now() - t0}ms`);
      } else {
        console.log(`[${sym}] funding cached`);
      }
    } catch (e) {
      console.error(`[${sym}] ERROR ${e.message}`);
    }
  }
  console.log('DONE');
})();
