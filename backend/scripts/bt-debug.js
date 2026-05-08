// Debug: inspect first N trades for BTCUSDT with a baseline config
'use strict';
const fs = require('fs');
const path = require('path');
const CACHE_DIR = '/tmp/v447-data';

const klines = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'BTCUSDT-klines-1h.json'), 'utf8'));
console.log('klines:', klines.length, 'first:', new Date(klines[0].t).toISOString(), 'last:', new Date(klines[klines.length-1].t).toISOString());

// EMA proxy (production logic)
const closes = klines.map(b => b.c);
const ema = new Float64Array(closes.length);
ema[0] = closes[0];
const alpha = 2/51;
for (let i=1; i<closes.length; i++) ema[i] = closes[i]*alpha + ema[i-1]*(1-alpha);
const premium = closes.map((v,i) => (v-ema[i])/ema[i]);
const fundArr = new Float64Array(closes.length);
for (let i=8; i<closes.length; i++) {
  let s = 0;
  for (let j=i-7; j<=i; j++) s += premium[j];
  fundArr[i] = s/8;
}

// Hourly direction-baseline test: for 1000 random eligible bars, find what direction signal would say
// and whether price went up or down over next 4h
let total = 0, longSig = 0, shortSig = 0;
let longUp = 0, longDown = 0, shortUp = 0, shortDown = 0;
const SETT = [0,8,16];
function isElig(hr) { for (const s of SETT) { if (hr===s||hr===(s-1+24)%24||hr===(s+1)%24) return true; } return false; }

for (let i = 800; i < klines.length - 4; i++) {
  const hr = new Date(klines[i].t).getUTCHours();
  if (!isElig(hr)) continue;
  const f = fundArr[i];
  if (!isFinite(f)) continue;
  // 168h window
  const wStart = Math.max(0, i-168);
  const fW = [];
  for (let j=wStart; j<i; j++) if (isFinite(fundArr[j])) fW.push(fundArr[j]);
  if (fW.length < 50) continue;
  fW.sort((a,b)=>a-b);
  const p20 = fW[Math.floor(fW.length*0.2)];
  const p80 = fW[Math.floor(fW.length*0.8)];

  let dir = 0;
  if (f > p80 && f > 0.002) dir = -1;
  else if (f < p20 && f < -0.0008) dir = 1;
  if (!dir) continue;

  total++;
  // Look 4h ahead
  const futClose = klines[i+4].c;
  const curClose = klines[i].c;
  const moveBps = ((futClose - curClose)/curClose)*10000;

  if (dir === 1) { longSig++; if (moveBps > 0) longUp++; else longDown++; }
  else           { shortSig++; if (moveBps > 0) shortUp++; else shortDown++; }
}
console.log(`Total signals: ${total}`);
console.log(`LONG  (BUY) signals: ${longSig}  → priceUp: ${longUp} (${(longUp/longSig*100).toFixed(1)}%)  priceDown: ${longDown}`);
console.log(`SHORT (SEL) signals: ${shortSig} → priceUp: ${shortUp} (${(shortUp/shortSig*100).toFixed(1)}%) priceDown: ${shortDown}`);
console.log(``);
console.log(`If LONG signal & priceUp% > 50% → mean-revert works for LONG`);
console.log(`If SHORT signal & priceUp% < 50% → mean-revert works for SHORT`);
console.log(`If both percentages are ~50% → no edge`);
console.log(`If LONG priceUp% < 50% → need to INVERT (signal LONG should be SHORT)`);

// Also test with PREMIUM INDEX REAL
console.log('\n─── PREMIUM INDEX REAL ───');
const prem = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'BTCUSDT-premium-1h.json'), 'utf8'));
const premMap = new Map();
for (const p of prem) premMap.set(p.t, p.c);
const fundArr2 = new Float64Array(closes.length);
let last = NaN;
for (let i=0; i<klines.length; i++) {
  if (premMap.has(klines[i].t)) last = premMap.get(klines[i].t);
  fundArr2[i] = isFinite(last) ? last : NaN;
}

let total2 = 0, lU=0, lD=0, sU=0, sD=0, lN=0, sN=0;
for (let i = 800; i < klines.length - 4; i++) {
  const hr = new Date(klines[i].t).getUTCHours();
  if (!isElig(hr)) continue;
  const f = fundArr2[i];
  if (!isFinite(f)) continue;
  const wStart = Math.max(0, i-168);
  const fW = [];
  for (let j=wStart; j<i; j++) if (isFinite(fundArr2[j])) fW.push(fundArr2[j]);
  if (fW.length < 50) continue;
  fW.sort((a,b)=>a-b);
  const p20 = fW[Math.floor(fW.length*0.2)];
  const p80 = fW[Math.floor(fW.length*0.8)];
  let dir = 0;
  if (f > p80 && f > 0.00015) dir = -1;
  else if (f < p20 && f < -0.00010) dir = 1;
  if (!dir) continue;
  total2++;
  const moveBps = ((klines[i+4].c - klines[i].c)/klines[i].c)*10000;
  if (dir === 1) { lN++; if (moveBps > 0) lU++; else lD++; }
  else           { sN++; if (moveBps > 0) sU++; else sD++; }
}
console.log(`Total signals: ${total2}`);
console.log(`LONG signals: ${lN} → priceUp: ${lU} (${(lU/lN*100).toFixed(1)}%) priceDown: ${lD}`);
console.log(`SHORT signals: ${sN} → priceUp: ${sU} (${(sU/sN*100).toFixed(1)}%) priceDown: ${sD}`);
