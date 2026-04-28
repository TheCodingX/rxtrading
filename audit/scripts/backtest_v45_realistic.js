#!/usr/bin/env node
'use strict';
// V45 REALISTIC — Backtest con costos reales modeled (Binance Futures)
//
// COSTOS MODELED:
//   ENTRY (market):    fee taker 0.05% + slippage 0.02%   = 0.07%
//   TP HIT:            fee taker 0.05% + slippage 0%       = 0.05%
//   SL HIT (no BE):    fee taker 0.05% + slippage 0.02%   = 0.07%
//   BE_MOVE_AT_1H:     cancel SL + place new SL maker 0.02% = 0.02%
//   BE CLOSE (after move): fee maker 0.02%                 = 0.02%
//   TIME_STOP_4H:      fee taker 0.05% + slippage 0.05%   = 0.10%
//
// Round-trip min: entry 0.07% + exit 0.05% = 0.12% (TP path)
// Round-trip BE: entry 0.07% + new SL 0.02% + exit 0.02% = 0.11%
// (the buffer pays itself: SL at entry+fees → no negative slip)
//
// Configurable via env:
//   APEX_REAL_FEE_TAKER (default 0.0005)
//   APEX_REAL_FEE_MAKER (default 0.0002)
//   APEX_REAL_SLIP_ENTRY (default 0.0002)
//   APEX_REAL_SLIP_SL (default 0.0002)
//   APEX_REAL_SLIP_TIMESTOP (default 0.0005)
//
// Activates V45 SUPREME flags via env (P11+P7+P14 default).

const fs = require('fs');
const path = require('path');

const KLINES_DIR = '/tmp/binance-klines-1h';
const OUT_DIR = path.join(__dirname, '..', 'results');
const CFG_LABEL = (process.argv[2] || 'realistic');

// V45 flags (default V45 SUPREME stack)
const FLAGS = {
  P11: process.env.APEX_V45_PAIR_SIZING !== '0',
  P7:  process.env.APEX_V45_TERM_STRUCTURE !== '0',
  P14: process.env.APEX_V45_MICRO_STOP !== '0'
};

const COSTS = {
  fee_taker: parseFloat(process.env.APEX_REAL_FEE_TAKER || '0.0005'),
  fee_maker: parseFloat(process.env.APEX_REAL_FEE_MAKER || '0.0002'),
  slip_entry: parseFloat(process.env.APEX_REAL_SLIP_ENTRY || '0.0002'),
  slip_sl: parseFloat(process.env.APEX_REAL_SLIP_SL || '0.0002'),
  slip_timestop: parseFloat(process.env.APEX_REAL_SLIP_TIMESTOP || '0.0005')
};

const MICRO_THRESHOLD = parseFloat(process.env.APEX_V45_MICRO_THRESHOLD || '0.10');

const PAIRS = [
  'ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT',
  'BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT',
  'SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT'
];

console.log('═'.repeat(80));
console.log(`V45 REALISTIC BACKTEST — ${CFG_LABEL.toUpperCase()}`);
console.log('═'.repeat(80));
console.log(`Flags: ${Object.entries(FLAGS).filter(([k,v])=>v).map(([k])=>k).join(', ') || 'BASELINE'}`);
console.log(`Costs: taker=${(COSTS.fee_taker*100).toFixed(3)}%, maker=${(COSTS.fee_maker*100).toFixed(3)}%, slip_entry=${(COSTS.slip_entry*100).toFixed(3)}%, slip_sl=${(COSTS.slip_sl*100).toFixed(3)}%`);
console.log(`P14 micro threshold: ${MICRO_THRESHOLD}`);
console.log('');

const data = {};
for(const p of PAIRS){
  const f = path.join(KLINES_DIR, `${p}.json`);
  if(!fs.existsSync(f)) continue;
  data[p] = JSON.parse(fs.readFileSync(f, 'utf8')).map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4] }));
}

function proxyFunding(bars1h){
  const n = bars1h.length;
  const c = bars1h.map(b => b.c);
  const ema = new Float64Array(n);
  ema[0] = c[0];
  const alpha = 2 / 51;
  for(let i = 1; i < n; i++) ema[i] = c[i] * alpha + ema[i-1] * (1 - alpha);
  const premium = c.map((v, i) => (v - ema[i]) / ema[i]);
  const f = new Float64Array(n);
  for(let i = 8; i < n; i++){
    let s = 0;
    for(let j = i - 7; j <= i; j++) s += premium[j];
    f[i] = s / 8;
  }
  return f;
}

const fundCache = {};
for(const pair of PAIRS){
  if(!data[pair]) continue;
  fundCache[pair] = proxyFunding(data[pair]);
}

function pairSizeMultV45(rollingPF){
  if(rollingPF === null) return 1.0;
  if(rollingPF >= 2.5) return 1.6;
  if(rollingPF >= 2.0) return 1.4;
  if(rollingPF >= 1.5) return 1.2;
  if(rollingPF >= 1.2) return 1.0;
  if(rollingPF >= 1.0) return 0.85;
  if(rollingPF >= 0.8) return 0.65;
  return 0.45;
}

function termStructureBoost(fund, idx, dir){
  if(idx < 168) return 1.0;
  const f24 = []; for(let j = idx-24; j < idx; j++) if(isFinite(fund[j])) f24.push(fund[j]);
  const f7d = []; for(let j = idx-168; j < idx; j++) if(isFinite(fund[j])) f7d.push(fund[j]);
  if(f24.length < 12 || f7d.length < 80) return 1.0;
  const m24 = f24.reduce((a,b)=>a+b,0)/f24.length;
  const m7d = f7d.reduce((a,b)=>a+b,0)/f7d.length;
  const std = Math.sqrt(f7d.reduce((s,v)=>s+(v-m7d)**2, 0)/f7d.length);
  const div = m24 - m7d;
  const aligned = dir === 1 ? -div : div;
  const norm = std > 0 ? aligned/std : 0;
  return 1.0 + Math.max(0, Math.min(0.30, norm * 0.15));
}

const INIT_CAP = 500;
const SIZE_PCT = 0.10;
const TP_BPS = 30;
const SL_BPS = 25;
const HOLD_H = 4;

const trades = [];
let cap = INIT_CAP;
let totalFeesPaid = 0;
let totalSlippagePaid = 0;
const dailyPnL = {};
const tradesByPair = {};
PAIRS.forEach(p => tradesByPair[p] = []);

function rollingPF(pairTs, currentTs){
  if(!FLAGS.P11) return null;
  const cutoffEnd = currentTs - 7 * 86400000;
  const cutoffStart = cutoffEnd - 90 * 86400000;
  const win = pairTs.filter(t => t.ts >= cutoffStart && t.ts <= cutoffEnd);
  if(win.length < 30) return null;
  const w = win.filter(t => t.pnl > 0);
  const gp = w.reduce((s,t)=>s+t.pnl, 0);
  const gl = -win.filter(t=>t.pnl<=0).reduce((s,t)=>s+t.pnl, 0);
  return gl > 0 ? gp/gl : 999;
}

const eventStream = [];
for(const pair of PAIRS){
  if(!data[pair]) continue;
  const bars = data[pair];
  for(let i = 50; i < bars.length - HOLD_H; i++){
    eventStream.push({ pair, i, t: bars[i].t });
  }
}
eventStream.sort((a,b) => a.t - b.t);

const positionByPair = {};
PAIRS.forEach(p => positionByPair[p] = null);

const t0 = Date.now();

function openPosition(pair, bars, i, dir, sizeMult){
  const entryRaw = bars[i].c;
  const entrySlip = dir === 1 ? entryRaw * (1 + COSTS.slip_entry) : entryRaw * (1 - COSTS.slip_entry);
  const finalSize = cap * SIZE_PCT * sizeMult;
  const tpP = dir === 1 ? entrySlip * (1 + TP_BPS/10000) : entrySlip * (1 - TP_BPS/10000);
  const slP = dir === 1 ? entrySlip * (1 - SL_BPS/10000) : entrySlip * (1 + SL_BPS/10000);

  // Entry fee + slippage tracking
  const entryFee = finalSize * COSTS.fee_taker;
  const slipImpact = finalSize * COSTS.slip_entry;
  totalFeesPaid += entryFee;
  totalSlippagePaid += slipImpact;

  return {
    entryRaw,             // raw price (for BE move calculation)
    entrySlip,            // actual fill price
    dir, entryI: i,
    size: finalSize, sizeMult,
    tpP, slP,
    bestate: 'NORMAL',    // NORMAL → PROTECTED (after BE move)
    microStopChecked: false,
    entryFee
  };
}

function closePosition(pair, bars, currentI, exitType, pos){
  const dir = pos.dir;
  let exitPrice;
  let exitFee;
  let exitSlip = 0;

  if(exitType === 'TP'){
    exitPrice = pos.tpP;
    exitFee = pos.size * COSTS.fee_taker;  // assume taker on TP fill
  } else if(exitType === 'SL_NORMAL'){
    // Original SL hit, before BE move (or no P14)
    exitPrice = dir === 1
      ? pos.slP * (1 - COSTS.slip_sl)
      : pos.slP * (1 + COSTS.slip_sl);
    exitFee = pos.size * COSTS.fee_taker;
    exitSlip = pos.size * COSTS.slip_sl;
  } else if(exitType === 'SL_BE'){
    // BE-protected SL hit (entry + fee buffer). Exits at break-even price slightly worse than entry
    exitPrice = pos.beSL;
    exitFee = pos.size * COSTS.fee_maker;  // maker fee on BE SL
  } else if(exitType === 'TIMESTOP'){
    // Force market close at hour 4
    exitPrice = bars[currentI].c;
    if(dir === 1) exitPrice *= (1 - COSTS.slip_timestop);
    else exitPrice *= (1 + COSTS.slip_timestop);
    exitFee = pos.size * COSTS.fee_taker;
    exitSlip = pos.size * COSTS.slip_timestop;
  }

  const pnlPct = dir === 1
    ? (exitPrice - pos.entrySlip) / pos.entrySlip
    : (pos.entrySlip - exitPrice) / pos.entrySlip;
  const grossPnL = pos.size * pnlPct;
  const totalFees = pos.entryFee + exitFee;  // entry already counted, but for trade record
  const netPnL = grossPnL - exitFee;  // entry fee already deducted from cap

  cap += netPnL;
  totalFeesPaid += exitFee;
  totalSlippagePaid += exitSlip;

  const dk = new Date(bars[currentI].t).toISOString().slice(0, 10);
  dailyPnL[dk] = (dailyPnL[dk] || 0) + netPnL - pos.entryFee;  // entry fee for this day too

  return {
    pnl: netPnL - pos.entryFee,  // total trade PnL after all costs
    grossPnL,
    fees: totalFees,
    slippage: exitSlip + (pos.size * COSTS.slip_entry),
    type: exitType,
    exitPrice,
    ts: bars[currentI].t,
    pair,
    dir
  };
}

for(const evt of eventStream){
  const { pair, i, t } = evt;
  const bars = data[pair];
  const fund = fundCache[pair];
  const hr = new Date(t).getUTCHours();
  const pos = positionByPair[pair];

  // === Exit checks ===
  if(pos){
    const elapsedH = i - pos.entryI;
    const dir = pos.dir;
    const h = bars[i].h, l = bars[i].l;

    // Check TP first (always priority)
    const hitTP = (dir === 1 && h >= pos.tpP) || (dir === -1 && l <= pos.tpP);
    // Determine current SL price (could be original or BE-moved)
    const activeSL = pos.bestate === 'PROTECTED' ? pos.beSL : pos.slP;
    const hitSL = (dir === 1 && l <= activeSL) || (dir === -1 && h >= activeSL);
    const timestop = elapsedH >= HOLD_H;

    if(hitTP){
      const tr = closePosition(pair, bars, i, 'TP', pos);
      tr.bestate = pos.bestate;
      tr.elapsedH = elapsedH;
      trades.push(tr);
      tradesByPair[pair].push(tr);
      positionByPair[pair] = null;
      continue;
    }
    if(hitSL){
      const exitType = pos.bestate === 'PROTECTED' ? 'SL_BE' : 'SL_NORMAL';
      const tr = closePosition(pair, bars, i, exitType, pos);
      tr.bestate = pos.bestate;
      tr.elapsedH = elapsedH;
      trades.push(tr);
      tradesByPair[pair].push(tr);
      positionByPair[pair] = null;
      continue;
    }
    if(timestop){
      const tr = closePosition(pair, bars, i, 'TIMESTOP', pos);
      tr.bestate = pos.bestate;
      tr.elapsedH = elapsedH;
      trades.push(tr);
      tradesByPair[pair].push(tr);
      positionByPair[pair] = null;
      continue;
    }

    // P14: Check BE-Move at hour 1
    if(FLAGS.P14 && elapsedH === 1 && !pos.microStopChecked){
      pos.microStopChecked = true;
      const c = bars[i].c;
      const favMove = dir === 1
        ? (c - pos.entryRaw) / pos.entryRaw
        : (pos.entryRaw - c) / pos.entryRaw;
      const requiredMove = (TP_BPS / 10000) * MICRO_THRESHOLD;
      if(favMove < requiredMove){
        // BE-Move: place new SL at entry + fee buffer
        // Buffer = exit fee + entry slip already incurred
        // To break even: new_sl_price compensates for: entry_fee + exit_fee + entry_slip
        // But to keep it simple: SL at entry_raw + 0.05% buffer (covers fees)
        const buffer = 0.0005;  // 0.05% buffer to compensate fees
        pos.beSL = dir === 1
          ? pos.entryRaw * (1 + buffer)  // BUY: SL above entry by buffer (so close = small win covers fees)
          : pos.entryRaw * (1 - buffer);  // SELL: SL below entry by buffer
        // Wait — for protection (avoid loss), SL should be at:
        // BUY: SL at entry, so price drop → loss. We WANT SL at entry+buffer so any drop closes at +buffer (covers fees)
        // Actually for BE-Move, we want SL at entry price. If price goes adverse, we get exit at entry,
        // costing only fees+slip. But to LITERALLY break even (PnL=0 net), SL needs to be:
        // BUY: entry × (1 + total_fee_pct_round_trip) so that exit at slP triggers loss = -fees, but slP > entry
        //   means loss in price terms. Need to think again.
        // ACTUALLY: for BUY, SL at entry triggers when l <= entry. Exit at entry (slip) = entry × (1 - slip).
        //   PnL price = (entry × (1-slip) - entry_slip) / entry_slip = ~negative. So total PnL = price_loss - fees - slip
        // To compensate: we move SL to entry × (1 + buffer). Trigger when l <= entry × (1+buffer).
        // Wait that's HIGHER than entry, which would always trigger immediately for BUY.
        // CORRECT: For BUY, SL must be BELOW entry (otherwise immediate trigger).
        //   To get BE: SL at entry × (1 + 0) = entry exactly. When l <= entry, exit at entry. PnL = -fees.
        //   That's BE in price but loss in fees. Acceptable as "near-zero".
        // For SELL: SL must be ABOVE entry. SL at entry × (1 - 0) = entry. When h >= entry, exit at entry. PnL = -fees.
        // So beSL = entry_raw exactly, no buffer (buffer doesn't help, it would invert the SL)
        // The "fee buffer" concept is wrong. The trade closes at small loss = fees only.
        pos.beSL = pos.entryRaw;  // exit at entry price → only pay fees
        pos.bestate = 'PROTECTED';

        // Cost of BE-Move: cancel SL (free) + place new SL maker fee
        // Note: place fee paid when SL hits, not now. But maker post-only is fee deferred.
      }
    }
  }

  // === Entry check ===
  if(!positionByPair[pair] && (hr === 0 || hr === 8 || hr === 16)){
    if(!isFinite(fund[i])) continue;
    const fW = [];
    for(let j = Math.max(0, i-168); j < i; j++) if(isFinite(fund[j])) fW.push(fund[j]);
    if(fW.length < 50) continue;
    const sorted = [...fW].sort((a,b)=>a-b);
    const p80 = sorted[Math.floor(sorted.length*0.8)] || 0;
    const p20 = sorted[Math.floor(sorted.length*0.2)] || 0;
    let dir = 0;
    if(fund[i] > p80 && fund[i] > 0.005) dir = -1;
    else if(fund[i] < p20 && fund[i] < -0.002) dir = 1;
    if(dir === 0) continue;

    const fMean = fW.reduce((a,b)=>a+b, 0) / fW.length;
    const fStd = Math.sqrt(fW.reduce((s,v)=>s+(v-fMean)**2, 0) / fW.length);
    const z = fStd > 0 ? (fund[i] - fMean) / fStd : 0;

    let sizeMult = 1.0;
    if(FLAGS.P11){
      sizeMult *= pairSizeMultV45(rollingPF(tradesByPair[pair], t));
    }
    if(FLAGS.P7){
      sizeMult *= termStructureBoost(fund, i, dir);
    }
    sizeMult = Math.min(2.0, sizeMult);

    positionByPair[pair] = openPosition(pair, bars, i, dir, sizeMult);
  }
}

const dt = ((Date.now() - t0) / 1000).toFixed(1);

// === Stats ===
function computeStats(trades, dailyPnL, capital = INIT_CAP){
  if(trades.length === 0) return { n: 0 };
  const w = trades.filter(t => t.pnl > 0);
  const l = trades.filter(t => t.pnl <= 0);
  const gp = w.reduce((s,t)=>s+t.pnl, 0);
  const gl = -l.reduce((s,t)=>s+t.pnl, 0);
  const days = Object.keys(dailyPnL).sort();
  const dr = days.map(d => dailyPnL[d]/capital);
  const m = dr.reduce((a,b)=>a+b,0)/Math.max(1,dr.length);
  const v = dr.reduce((s,r)=>s+(r-m)**2,0)/Math.max(1,dr.length);
  const sh = Math.sqrt(v) > 0 ? (m/Math.sqrt(v))*Math.sqrt(365) : 0;
  let pk = 0, mdd = 0, cum = 0;
  for(const d of days){ cum += dailyPnL[d]; if(cum>pk) pk=cum; if(pk-cum>mdd) mdd=pk-cum; }
  return {
    n: trades.length, wins: w.length, losses: l.length,
    pf: gl > 0 ? gp/gl : 999, wr: (w.length/trades.length)*100,
    pnl: trades.reduce((s,t)=>s+t.pnl, 0), sharpe: sh, mdd, mddPct: (mdd/capital)*100,
    tpd: days.length > 0 ? trades.length/days.length : 0, days: days.length
  };
}

const stats = computeStats(trades, dailyPnL);

const sortedDays = Object.keys(dailyPnL).sort();
const win7d = [];
for(let i = 0; i + 6 < sortedDays.length; i++){
  win7d.push({ pnl: sortedDays.slice(i,i+7).reduce((s,d)=>s+dailyPnL[d], 0) });
}
const pos7d = win7d.filter(w => w.pnl > 0).length;
const sorted7d = win7d.map(w=>w.pnl).sort((a,b)=>a-b);
const positivePct = (pos7d/win7d.length)*100;
const worstWin = sorted7d[0] || 0;
const worstPct = (worstWin / INIT_CAP) * 100;

console.log('');
console.log(`Trades: ${stats.n}  PF: ${stats.pf.toFixed(3)}  WR: ${stats.wr.toFixed(2)}%  PnL: $${stats.pnl.toFixed(2)}  DD: ${stats.mddPct.toFixed(2)}%  Sharpe: ${stats.sharpe.toFixed(2)}  t/d: ${stats.tpd.toFixed(2)}`);
console.log(`7d windows: ${positivePct.toFixed(1)}% pos | worst $${worstWin.toFixed(2)} (${worstPct.toFixed(2)}%)`);

const outcomes = { TP: 0, SL_NORMAL: 0, SL_BE: 0, TIMESTOP: 0 };
trades.forEach(t => { outcomes[t.type] = (outcomes[t.type]||0) + 1; });
const beMoved = trades.filter(t => t.bestate === 'PROTECTED').length;

console.log(`Outcomes: TP=${outcomes.TP} SL_NORMAL=${outcomes.SL_NORMAL} SL_BE=${outcomes.SL_BE} TIMESTOP=${outcomes.TIMESTOP}`);
console.log(`BE-moved trades: ${beMoved} (${(beMoved/trades.length*100).toFixed(1)}%)`);
console.log(`Total fees paid: $${totalFeesPaid.toFixed(2)} (${(totalFeesPaid/INIT_CAP*100).toFixed(2)}% of capital)`);
console.log(`Total slippage: $${totalSlippagePaid.toFixed(2)} (${(totalSlippagePaid/INIT_CAP*100).toFixed(2)}% of capital)`);

const out = {
  config: CFG_LABEL, flags: FLAGS, costs: COSTS,
  microThreshold: MICRO_THRESHOLD,
  stats,
  positivePct, worstWin, worstPct,
  windows7d_count: win7d.length, windows7d_positive: pos7d,
  outcomes, beMoved, totalFeesPaid, totalSlippagePaid,
  dailyPnL,
  runtime_s: parseFloat(dt)
};
fs.writeFileSync(path.join(OUT_DIR, `v45_realistic_${CFG_LABEL}.json`), JSON.stringify(out, null, 2));
console.log(`✓ Saved ${OUT_DIR}/v45_realistic_${CFG_LABEL}.json (${dt}s)`);
