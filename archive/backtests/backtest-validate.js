// Quick validation: check if the SAME code gives wildly different results
// by testing order of TP/SL check (TP-first vs SL-first)

const https = require('https');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchKlines(sym, interval, limit=1000, endTime=null) {
  return new Promise((resolve, reject) => {
    let url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function getAllKlines(sym, interval, totalCandles) {
  let all = [];
  let endTime = null;
  while (all.length < totalCandles) {
    const limit = Math.min(1000, totalCandles - all.length);
    const batch = await fetchKlines(sym, interval, limit, endTime);
    if (!batch || !batch.length) break;
    all = batch.concat(all);
    endTime = batch[0][0] - 1;
    await sleep(100);
  }
  return all.slice(-totalCandles);
}

// Simple test: take BTCUSDT 5m data and count how many times
// TP is hit vs SL is hit with different priority orders
async function main() {
  console.log('Fetching BTCUSDT 5m data...');
  const kl = await getAllKlines('BTCUSDT', '5m', 4500);

  const C = kl.map(k => parseFloat(k[4]));
  const H = kl.map(k => parseFloat(k[2]));
  const L = kl.map(k => parseFloat(k[3]));

  // Simulate random entries every 24 candles with 1.5:1 R:R
  // ATR-like distance = average range of last 14 candles
  let tpFirst_wins = 0, tpFirst_losses = 0, tpFirst_timeout = 0;
  let slFirst_wins = 0, slFirst_losses = 0, slFirst_timeout = 0;
  let noCheck_wins = 0, noCheck_losses = 0;

  const totalTests = [];

  for (let i = 300; i < C.length - 50; i += 24) {
    // Calculate ATR
    let sumTR = 0;
    for (let j = i - 14; j < i; j++) {
      sumTR += Math.max(H[j] - L[j], Math.abs(H[j] - C[j-1]), Math.abs(L[j] - C[j-1]));
    }
    const atr = sumTR / 14;

    const entry = C[i];
    // BUY signal
    const tp = entry + atr * 1.5;
    const sl = entry - atr * 1.0;

    // Method 1: Check SL first (pessimistic — what I did)
    let exit1 = null;
    for (let j = i + 1; j < i + 50 && j < C.length; j++) {
      if (L[j] <= sl) { exit1 = 'SL'; break; }
      if (H[j] >= tp) { exit1 = 'TP'; break; }
    }
    if (!exit1) exit1 = 'TIMEOUT';

    // Method 2: Check TP first (optimistic)
    let exit2 = null;
    for (let j = i + 1; j < i + 50 && j < C.length; j++) {
      if (H[j] >= tp) { exit2 = 'TP'; break; }
      if (L[j] <= sl) { exit2 = 'SL'; break; }
    }
    if (!exit2) exit2 = 'TIMEOUT';

    // Method 3: Use close price only (no intracandle)
    let exit3 = null;
    for (let j = i + 1; j < i + 50 && j < C.length; j++) {
      if (C[j] >= tp) { exit3 = 'TP'; break; }
      if (C[j] <= sl) { exit3 = 'SL'; break; }
    }
    if (!exit3) exit3 = 'TIMEOUT';

    if (exit1 === 'TP') slFirst_wins++;
    else if (exit1 === 'SL') slFirst_losses++;
    else slFirst_timeout++;

    if (exit2 === 'TP') tpFirst_wins++;
    else if (exit2 === 'SL') tpFirst_losses++;
    else tpFirst_timeout++;

    if (exit3 === 'TP') noCheck_wins++;
    else if (exit3 === 'SL') noCheck_losses++;

    totalTests.push({ exit1, exit2, exit3 });
  }

  const disagree = totalTests.filter(t => t.exit1 !== t.exit2).length;
  const disagree3 = totalTests.filter(t => t.exit1 !== t.exit3).length;

  console.log(`\nTotal simulated entries: ${totalTests.length}`);
  console.log(`\nMethod 1 (SL-first / pessimistic):`);
  console.log(`  Wins: ${slFirst_wins} (${(slFirst_wins/totalTests.length*100).toFixed(1)}%)`);
  console.log(`  Losses: ${slFirst_losses}`);
  console.log(`  Timeout: ${slFirst_timeout}`);

  console.log(`\nMethod 2 (TP-first / optimistic):`);
  console.log(`  Wins: ${tpFirst_wins} (${(tpFirst_wins/totalTests.length*100).toFixed(1)}%)`);
  console.log(`  Losses: ${tpFirst_losses}`);
  console.log(`  Timeout: ${tpFirst_timeout}`);

  console.log(`\nMethod 3 (Close-only — no high/low check):`);
  console.log(`  Wins: ${noCheck_wins} (${(noCheck_wins/totalTests.length*100).toFixed(1)}%)`);
  console.log(`  Losses: ${noCheck_losses}`);

  console.log(`\nDisagreements (SL-first vs TP-first): ${disagree} (${(disagree/totalTests.length*100).toFixed(1)}%)`);
  console.log(`Disagreements (SL-first vs Close-only): ${disagree3} (${(disagree3/totalTests.length*100).toFixed(1)}%)`);

  console.log(`\n═══ IMPACT ON PnL ═══`);
  // With R:R 1.5:1, fee 0.08%
  const fee = 0.0008;
  const slPnl_wr = slFirst_wins / (slFirst_wins + slFirst_losses);
  const tpPnl_wr = tpFirst_wins / (tpFirst_wins + tpFirst_losses);
  // Expected PnL per trade (normalized)
  const exp_sl = slPnl_wr * 1.5 - (1 - slPnl_wr) * 1.0;
  const exp_tp = tpPnl_wr * 1.5 - (1 - tpPnl_wr) * 1.0;
  console.log(`SL-first expectancy (R units): ${exp_sl.toFixed(3)}`);
  console.log(`TP-first expectancy (R units): ${exp_tp.toFixed(3)}`);
  console.log(`Difference: ${((exp_tp - exp_sl) * 100).toFixed(1)}% of R per trade`);

  // If we had 500 trades with $500×5x position and 1% ATR
  const tradesN = 500;
  const posSize = 2500; // 500*5x
  const avgAtrPct = 0.01; // ~1%
  const pnl_sl = tradesN * posSize * avgAtrPct * exp_sl;
  const pnl_tp = tradesN * posSize * avgAtrPct * exp_tp;
  console.log(`\nOver ${tradesN} trades ($500×5x, ~1% ATR):`);
  console.log(`  SL-first PnL: $${pnl_sl.toFixed(0)}`);
  console.log(`  TP-first PnL: $${pnl_tp.toFixed(0)}`);
  console.log(`  DIFFERENCE: $${(pnl_tp - pnl_sl).toFixed(0)} (${((pnl_tp-pnl_sl)/10000*100).toFixed(1)}% of $10K capital)`);
}

main().catch(console.error);
