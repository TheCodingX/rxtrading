#!/usr/bin/env node
'use strict';
// Download 1h Binance Futures klines for V44.5 holdout validation.
// Period: 2024-07-01 → 2025-06-30 (365d holdout OOS)
// Source: Binance public API (no auth needed, free, no rate limit issues for 1h granularity)
//
// Output: /tmp/binance-klines-1h/{SYMBOL}.json with array of [t, o, h, l, c, v]

const fs = require('fs');
const path = require('path');
const https = require('https');

const PAIRS = [
  'ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT',
  'BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT',
  'SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'
];

const START = Date.parse('2024-07-01T00:00:00Z');
const END   = Date.parse('2025-06-30T23:00:00Z');
const OUT_DIR = '/tmp/binance-klines-1h';
const INTERVAL = '1h';
const BATCH = 1000;

if(!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Try fapi first (futures), fallback to api (spot)
function fetchBatch(symbol, startMs, endMs){
  return new Promise((resolve, reject) => {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${INTERVAL}&startTime=${startMs}&endTime=${endMs}&limit=${BATCH}`;
    const req = https.get(url, { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if(res.statusCode !== 200){
          // Try spot fallback
          const url2 = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&startTime=${startMs}&endTime=${endMs}&limit=${BATCH}`;
          https.get(url2, { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res2) => {
            let d2 = '';
            res2.on('data', (c) => d2 += c);
            res2.on('end', () => {
              if(res2.statusCode !== 200) return reject(new Error(`Both APIs failed for ${symbol}: ${res.statusCode}/${res2.statusCode}`));
              try { resolve(JSON.parse(d2)); } catch(e){ reject(e); }
            });
          }).on('error', reject);
          return;
        }
        try { resolve(JSON.parse(data)); } catch(e){ reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function downloadPair(symbol){
  const outFile = path.join(OUT_DIR, `${symbol}.json`);
  if(fs.existsSync(outFile)){
    const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    if(existing.length >= 8500){ // ~365d × 24h = 8760
      console.log(`  ${symbol.padEnd(14)} SKIP (already ${existing.length} bars)`);
      return existing.length;
    }
  }
  const allBars = [];
  let cur = START;
  let calls = 0;
  while(cur < END){
    const batchEnd = Math.min(cur + BATCH * 3600 * 1000, END);
    try {
      const bars = await fetchBatch(symbol, cur, batchEnd);
      calls++;
      if(!Array.isArray(bars) || bars.length === 0) break;
      // Each bar: [openTime, o, h, l, c, v, closeTime, ...]
      // Compact: [t, o, h, l, c, v]
      for(const b of bars){
        allBars.push([+b[0], +b[1], +b[2], +b[3], +b[4], +b[5]]);
      }
      const lastT = +bars[bars.length - 1][0];
      cur = lastT + 3600000;  // next hour
      // Mini delay to be nice
      await new Promise(r => setTimeout(r, 100));
    } catch(e){
      console.log(`  ${symbol} batch failed at ${new Date(cur).toISOString()}: ${e.message}`);
      // retry once
      await new Promise(r => setTimeout(r, 2000));
      try {
        const bars = await fetchBatch(symbol, cur, batchEnd);
        for(const b of bars){
          allBars.push([+b[0], +b[1], +b[2], +b[3], +b[4], +b[5]]);
        }
        cur = +bars[bars.length - 1][0] + 3600000;
      } catch(e2){
        throw new Error(`${symbol}: ${e2.message}`);
      }
    }
  }
  // Dedup by timestamp
  const seen = new Set();
  const dedup = allBars.filter(b => { if(seen.has(b[0])) return false; seen.add(b[0]); return true; });
  dedup.sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(outFile, JSON.stringify(dedup));
  console.log(`  ${symbol.padEnd(14)} ${dedup.length.toString().padStart(5)} bars (${calls} API calls)  ${new Date(dedup[0][0]).toISOString().slice(0,10)} → ${new Date(dedup[dedup.length-1][0]).toISOString().slice(0,10)}`);
  return dedup.length;
}

async function main(){
  console.log('═'.repeat(80));
  console.log('BINANCE 1h KLINES DOWNLOADER — V44.5 holdout validation');
  console.log('═'.repeat(80));
  console.log(`Period: ${new Date(START).toISOString().slice(0,10)} → ${new Date(END).toISOString().slice(0,10)}`);
  console.log(`Pairs: ${PAIRS.length}`);
  console.log(`Out: ${OUT_DIR}`);
  console.log('');

  const t0 = Date.now();
  let totalBars = 0;
  let failed = [];
  for(const pair of PAIRS){
    try {
      totalBars += await downloadPair(pair);
    } catch(e){
      console.log(`  ${pair.padEnd(14)} FAILED: ${e.message}`);
      failed.push(pair);
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  console.log('─'.repeat(80));
  console.log(`Total: ${totalBars} bars across ${PAIRS.length - failed.length}/${PAIRS.length} pairs in ${dt}s`);
  if(failed.length){
    console.log(`Failed: ${failed.join(', ')}`);
    process.exit(1);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
