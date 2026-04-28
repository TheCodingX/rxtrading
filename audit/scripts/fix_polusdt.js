#!/usr/bin/env node
'use strict';
// Build POLUSDT.json by combining MATICUSDT (pre-rename) + POLUSDT (post-rename)
// MATIC → POL rename happened on Binance Futures around late Sept 2024.

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT = '/tmp/binance-klines-1h/POLUSDT.json';
const START = Date.parse('2024-07-01T00:00:00Z');
const END = Date.parse('2025-06-30T23:00:00Z');
const BATCH = 1000;

function fetchBatch(symbol, startMs, endMs){
  return new Promise((resolve, reject) => {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&startTime=${startMs}&endTime=${endMs}&limit=${BATCH}`;
    https.get(url, { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if(res.statusCode !== 200) return resolve([]);
        try { resolve(JSON.parse(d)); } catch(e){ resolve([]); }
      });
    }).on('error', reject);
  });
}

async function downloadRange(symbol, startMs, endMs){
  const all = [];
  let cur = startMs;
  while(cur < endMs){
    const batchEnd = Math.min(cur + BATCH * 3600 * 1000, endMs);
    const bars = await fetchBatch(symbol, cur, batchEnd);
    if(!Array.isArray(bars) || bars.length === 0) break;
    for(const b of bars){
      all.push([+b[0], +b[1], +b[2], +b[3], +b[4], +b[5]]);
    }
    cur = +bars[bars.length - 1][0] + 3600000;
    await new Promise(r => setTimeout(r, 100));
  }
  return all;
}

async function main(){
  console.log('Building POLUSDT.json from MATICUSDT (pre) + POLUSDT (post)...');
  // POLUSDT futures starts ~2024-09-25
  const POL_START = Date.parse('2024-09-25T00:00:00Z');

  const matic = await downloadRange('MATICUSDT', START, POL_START);
  console.log(`  MATICUSDT: ${matic.length} bars (${new Date(matic[0][0]).toISOString().slice(0,10)} → ${new Date(matic[matic.length-1][0]).toISOString().slice(0,10)})`);

  const pol = await downloadRange('POLUSDT', POL_START, END);
  console.log(`  POLUSDT: ${pol.length} bars (${new Date(pol[0][0]).toISOString().slice(0,10)} → ${new Date(pol[pol.length-1][0]).toISOString().slice(0,10)})`);

  // Merge — MATIC and POL are essentially same token at price level (same supply, just rename)
  // Conversion ratio 1:1 because POLUSDT was launched at same price as MATICUSDT
  const combined = [...matic, ...pol];
  combined.sort((a, b) => a[0] - b[0]);

  // Dedup
  const seen = new Set();
  const dedup = combined.filter(b => { if(seen.has(b[0])) return false; seen.add(b[0]); return true; });

  fs.writeFileSync(OUT, JSON.stringify(dedup));
  console.log(`✓ POLUSDT.json: ${dedup.length} bars total`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
