#!/usr/bin/env node
'use strict';
// Download real Binance Futures funding rate history for holdout period
// Output: /tmp/binance-funding/{SYMBOL}.json with [fundingTime, fundingRate]

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
const OUT_DIR = '/tmp/binance-funding';

if(!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function fetchBatch(symbol, startMs, endMs){
  return new Promise((resolve, reject) => {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startMs}&endTime=${endMs}&limit=1000`;
    https.get(url, { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e){ resolve([]); } });
    }).on('error', reject);
  });
}

async function downloadPair(symbol){
  const out = path.join(OUT_DIR, `${symbol}.json`);
  if(fs.existsSync(out)){
    const ex = JSON.parse(fs.readFileSync(out, 'utf8'));
    if(ex.length >= 1000){
      console.log(`  ${symbol.padEnd(14)} SKIP (${ex.length} records)`);
      return ex.length;
    }
  }
  const all = [];
  let cur = START;
  while(cur < END){
    const batch = await fetchBatch(symbol, cur, END);
    if(!Array.isArray(batch) || batch.length === 0) break;
    for(const r of batch) all.push([+r.fundingTime, +r.fundingRate]);
    cur = +batch[batch.length-1].fundingTime + 1;
    await new Promise(r => setTimeout(r, 100));
  }
  // dedup
  const seen = new Set();
  const dedup = all.filter(r => { if(seen.has(r[0])) return false; seen.add(r[0]); return true; });
  dedup.sort((a,b)=>a[0]-b[0]);
  fs.writeFileSync(out, JSON.stringify(dedup));
  console.log(`  ${symbol.padEnd(14)} ${String(dedup.length).padStart(5)} records (${new Date(dedup[0][0]).toISOString().slice(0,10)} → ${new Date(dedup[dedup.length-1][0]).toISOString().slice(0,10)})`);
  return dedup.length;
}

(async () => {
  console.log('Downloading Binance Funding Rate History (8h intervals)');
  console.log('═'.repeat(70));
  for(const p of PAIRS){
    try { await downloadPair(p); }
    catch(e){ console.log(`  ${p} FAIL: ${e.message}`); }
  }
})();
