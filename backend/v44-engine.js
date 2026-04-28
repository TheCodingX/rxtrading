// ══════════════════════════════════════════════════════════════════════
// APEX V44 FUNDING CARRY — Server-side engine (port from frontend app.html)
// Runs 24/7 on backend, publishes to /api/public-signals
// Source: research-v44/apex-x/scripts/apex_elite_engine.js (validated OOS 365d)
//
// V44.5 PALANCAS (env-controlled — set in Render dashboard):
//   APEX_V45_FINE_SIZING=1      — enable Palanca 1 (continuous sizing)
//   APEX_V45_REENTRY_COOLDOWN=1 — enable Palanca 9 (post-SL cooldown 8h)
//   APEX_V45_TERM_STRUCTURE=1   — enable Palanca 7 (funding term-structure boost)
// All flags default OFF for production safety. Enable individually after monitoring.
// ══════════════════════════════════════════════════════════════════════

const _flag = (name) => process.env[name] === '1' || process.env[name] === 'true';

// 2026-04-27: Threshold env-configurable for adaptive low-vol regimes.
// Default = backtest validated (0.5% / 0.2%). Lower for current low-vol.
// APEX_F_POS_MIN=0.003 / APEX_F_NEG_MAX=-0.001 → roughly 2x signal frequency
const _envFloat = (name, def) => {
  const v = process.env[name];
  if(v === undefined || v === '') return def;
  const f = parseFloat(v);
  return isFinite(f) ? f : def;
};

const SAFE_FUNDING_PARAMS = Object.freeze({
  TP_BPS: _envFloat('APEX_TP_BPS', 30),
  SL_BPS: _envFloat('APEX_SL_BPS', 25),
  HOLD_H: parseInt(process.env.APEX_HOLD_H || '4', 10),
  P80_Q: 0.80, P20_Q: 0.20,
  F_POS_MIN: _envFloat('APEX_F_POS_MIN', 0.005),
  F_NEG_MAX: _envFloat('APEX_F_NEG_MAX', -0.002),
  SIZE_PCT: 0.10,
  ELITE_M1_ENABLED: true,
  Z_LOW: 1.0, Z_MID: 2.0, Z_HIGH: 3.0,
  SIZE_MULT_LOW: 0.7, SIZE_MULT_NORMAL: 1.0,
  SIZE_MULT_HIGH: 1.35, SIZE_MULT_EXTREME: 1.6,
  Z_LOOKBACK_H: 720,
  ELITE_M2_ENABLED: true,
  SETTLEMENT_HOURS: [0, 8, 16],
  WINDOW_HOURS_OFFSET: [-1, 0, 1],
  SETTLEMENT_MIN_OFFSET: 30,
  ULTRA_A_ENABLED: true,
  // 2026-04-27: env-configurable for low-vol regime adaptation.
  // Default 1.101 = backtest validated (high-vol 2024-25 regime).
  // For low-vol regimes (current 2026 Q2), recommend 0.5-0.7 to maintain signal flow.
  // Trade-off: lower threshold = more trades but lower individual quality.
  // Production current uses 0.6 due to observed z-scores 0.3-0.5 in current regime.
  QUALITY_THRESHOLD: _envFloat('APEX_QUALITY_THRESHOLD', 1.101),
  WINDOW_WEIGHT_MID: 1.0,
  WINDOW_WEIGHT_PRE: 0.85,
  WINDOW_WEIGHT_POST: 0.75,
  ULTRA_B_ENABLED: true,
  LEVERAGE: 3.0,
  MAX_MARGIN_UTIL: 0.60,
  MAX_TRADE_LOSS_PCT: 2.0,
  ULTRA_C_ENABLED: true,
  // ─── V44.5 PALANCA 1: SIZING DINÁMICO POR QUALITY SCORE ───────────────
  // Validado por Análisis F (08_ultra_fase1.json): el quality_score
  // correlaciona monótonamente con WR/PF/DD. Esta palanca refina el
  // sizing de 4 buckets discretos (V44) a continuo piecewise-linear.
  // Calibración basada en percentile thresholds reales del backtest.
  // Disabled por defecto — habilitar tras validación holdout.
  V45_ELITE_M1_FINE_ENABLED: _flag('APEX_V45_FINE_SIZING'),
  V45_QUALITY_BREAKPOINTS: [
    // [quality_score, size_multiplier]
    // Trades qualifying must have quality >= QUALITY_THRESHOLD (1.101)
    [1.101, 0.70],  // entry threshold — bottom of qualifying band
    [1.296, 0.85],  // P30 threshold from Análisis F (PF 1.910, WR 73.75%)
    [1.559, 1.20],  // P20 threshold (PF 2.005, WR 74.66%, DD 0.76%)
    [2.015, 1.65],  // P10 threshold (PF 2.201, WR 76.72%)
    [2.500, 1.90],  // beyond P10 — extreme conviction
    [3.500, 2.00]   // saturation cap (no leverage runaway)
  ],
  // ─── V44.5 PALANCA 9: REENTRY POST-LOSS COOLDOWN ─────────────────────
  // Si pair X tomó SL en última señal, cooldown de 1 settlement window
  // (8h). Evita clustering de losses observado en Feb 20-28 + Sep 17-24.
  V45_REENTRY_COOLDOWN_ENABLED: _flag('APEX_V45_REENTRY_COOLDOWN'),
  V45_REENTRY_COOLDOWN_H: 8,
  // ─── V44.5 PALANCA 7: FUNDING TERM-STRUCTURE FEATURES ────────────────
  // Enriquece quality_score con:
  //   - funding 24h trend vs 7d (mean reversion strength)
  //   - funding 2nd derivative (aceleración) → predicts inflection
  // No filtra trades, modula sizing vía quality_score.
  V45_TERM_STRUCTURE_ENABLED: _flag('APEX_V45_TERM_STRUCTURE'),
  V45_TS_TREND_LOOKBACK_24H: 24,
  V45_TS_TREND_LOOKBACK_7D: 168,
  V45_TS_TREND_BOOST_MAX: 0.30,   // máximo 30% boost a quality_score
  V45_TS_ACCEL_BOOST_MAX: 0.20,   // máximo 20% boost por aceleración favorable
  // ─── V44.5 PALANCA 11: BY-PAIR DYNAMIC SIZING ─────────────────────────
  // Validated in holdout 2024-07 → 2025-06: PF 1.638 vs 1.467 baseline,
  // %win7d 90.7% vs 86.2%, PnL +76%. The winning lever.
  // Logic: rolling PF (90d window, 7d purge gap) per pair → size multiplier.
  // No filtering, only modulates sizing → preserves t/d ≥18 constraint.
  V45_PAIR_SIZING_ENABLED: _flag('APEX_V45_PAIR_SIZING'),
  V45_PAIR_LOOKBACK_DAYS: 90,
  V45_PAIR_GAP_DAYS: 7,
  V45_PAIR_MIN_TRADES: 30,
  // Sizing breakpoints validated in holdout: pairs with rolling PF >= X get mult Y
  V45_PAIR_BREAKPOINTS: [
    [2.5, 1.6],
    [2.0, 1.4],
    [1.5, 1.2],
    [1.2, 1.0],
    [1.0, 0.85],
    [0.8, 0.65],
    [0.0, 0.45]
  ],
  // ─── V45 SUPREME PALANCA 14: MICRO TIME-STOP ──────────────────────────
  // ⚠️  DO NOT ACTIVATE IN PRODUCTION ⚠️
  // Validation realistic (with Binance fees + slippage 2026-04-27):
  //   - V45 SUPREME P14 realistic PF: 1.322 (vs V44.5 P11+P7 PF 1.305)
  //   - Improvement: only +1.3% PF, +1.7pp %win7d
  //   - In ideal backtest P14 looked great (PF 2.08) but that was an
  //     ARTIFACT: P14 check ran BEFORE TP/SL hit detection, virtually
  //     "rescuing" trades that IRL would have hit SL within hour 1.
  //   - In realistic: only 141 trades/365d (2%) reach the hour-1 check
  //     because most TP/SL hits happen earlier.
  //   - Implementing live (timer cron + Binance order modification +
  //     reconciliation) costs 4-6h dev for marginal benefit. NOT WORTH IT.
  // Code preserved for future iteration with tick-level data (5min checks).
  // See: /audit/V45-REALISTIC-DEPLOY-DECISION.md
  V45_MICRO_STOP_ENABLED: _flag('APEX_V45_MICRO_STOP'),  // KEEP FALSE in prod
  V45_MICRO_THRESHOLD: parseFloat(process.env.APEX_V45_MICRO_THRESHOLD || '0.10'),
  V45_MICRO_CHECK_HOUR: 1,  // hours after entry to evaluate
  // ─── V46 PALANCAS (validated holdout 365d realistic CV K=5: 5/5 folds positive) ──────
  // Holdout PF improvement: V44.5 1.337 → V46 1.426 (+6.7%)
  // %win7d: 77.1% → 80.8% (+3.7pp)  |  DD: 4.21% → 3.67% (-0.54pp)
  // Bootstrap PF lower CI 95%: 1.828 (robust). MC DD p95: 3.84%.
  // See: /audit/V46-DEPLOY-DECISION.md
  V46_R3_MAKER_PRIORITY: _flag('APEX_V46_R3'),
  V46_R3_PAIRS: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
  V46_R5_WINDOW_WEIGHTS: _flag('APEX_V46_R5'),
  V46_R5_WEIGHTS: { 0: 1.0, 8: 0.85, 16: 1.15 },  // calibrated from forensics
  V46_R6_CORR_DAMPENER: _flag('APEX_V46_R6'),
  V46_R6_CLUSTERS: {
    BTCUSDT: 'L1maj', ETHUSDT: 'L1maj',
    SOLUSDT: 'SOLadj', SUIUSDT: 'SOLadj', NEARUSDT: 'SOLadj',
    ARBUSDT: 'L2', POLUSDT: 'L2',
    LINKUSDT: 'DeFi', ATOMUSDT: 'DeFi', INJUSDT: 'DeFi',
    XRPUSDT: 'Other', ADAUSDT: 'Other', TRXUSDT: 'Other',
    '1000PEPEUSDT': 'MemesAI', RENDERUSDT: 'MemesAI'
  },
  // ─── V44.6 PALANCAS (T6 Bayesian Hierarchical + T5 Hawkes Process) ──────────────────
  // 2026-04-27 V44.6 deploy from V46 sprint. T6+T5 combo passes individual gate + composite score.
  // Holdout 365d realistic: PF 1.337 → 1.396 (+4.4%), DD 4.21% → 2.88% (-31.6%), Sharpe +18.2%.
  // Bootstrap CI95 PF [1.373, 1.420]. Sensitivity fragility 3.1%. MC P95 DD 1.06%.
  // See: /audit/V46-FINAL-VERDICT.md
  V46_T6_BAYESIAN: _flag('APEX_V46_T6'),
  V46_T6_HIGH_WR_THRESHOLD: 0.72,
  V46_T6_LOW_WR_THRESHOLD: 0.62,
  V46_T6_HIGH_MULT: 1.25,
  V46_T6_LOW_MULT: 0.70,
  V46_T6_PAIR_BUFFER_MAX: 30,
  V46_T6_GLOBAL_BUFFER_MAX: 200,
  V46_T6_MIN_PAIR_OBS: 10,
  V46_T6_PRIOR_STRENGTH: 0.10,  // 10% of global obs as prior
  V46_T5_HAWKES: _flag('APEX_V46_T5'),
  V46_T5_BASELINE_MU: 1.0,
  V46_T5_ALPHA: 0.3,
  V46_T5_BETA: 1.0,  // decay rate per hour
  V46_T5_LAMBDA_THRESHOLD: 2.0,
  V46_T5_DECAY_WINDOW_H: 12,
  V46_T5_VERY_HIGH_MULT: 0.55,
  V46_T5_HIGH_MULT: 0.80,
  V46_T5_LOW_MULT: 1.10,
  UNIVERSE: ['ADAUSDT','RENDERUSDT','ARBUSDT','ETHUSDT','XRPUSDT','BTCUSDT','1000PEPEUSDT','ATOMUSDT','LINKUSDT','POLUSDT','SOLUSDT','SUIUSDT','TRXUSDT','NEARUSDT','INJUSDT']
});

// ─── V44.6 T6 Bayesian Hierarchical Shrinkage state ─────────────────────────────────
// Per-pair rolling outcomes + global pool for empirical Bayes posterior WR
const _v46T6PairOutcomes = {};
const _v46T6GlobalOutcomes = [];
SAFE_FUNDING_PARAMS.UNIVERSE.forEach(p => { _v46T6PairOutcomes[p] = []; });

/**
 * Update T6 Bayesian buffers when a trade closes.
 * @param {string} pair
 * @param {boolean} isWin true if trade was profitable
 */
function v46T6RecordOutcome(pair, isWin){
  if(!_v46T6PairOutcomes[pair]) _v46T6PairOutcomes[pair] = [];
  const outcome = isWin ? 1 : 0;
  _v46T6PairOutcomes[pair].push(outcome);
  if(_v46T6PairOutcomes[pair].length > SAFE_FUNDING_PARAMS.V46_T6_PAIR_BUFFER_MAX){
    _v46T6PairOutcomes[pair].shift();
  }
  _v46T6GlobalOutcomes.push(outcome);
  if(_v46T6GlobalOutcomes.length > SAFE_FUNDING_PARAMS.V46_T6_GLOBAL_BUFFER_MAX){
    _v46T6GlobalOutcomes.shift();
  }
}

/**
 * Compute T6 Bayesian posterior win-rate for a pair using empirical Bayes shrinkage.
 * Returns null if insufficient data (uses size mult 1.0).
 */
function v46T6PosteriorWR(pair){
  if(!SAFE_FUNDING_PARAMS.V46_T6_BAYESIAN) return null;
  const pa = _v46T6PairOutcomes[pair];
  if(!pa || pa.length < SAFE_FUNDING_PARAMS.V46_T6_MIN_PAIR_OBS) return null;
  const pa_wins = pa.filter(o => o === 1).length;
  const pa_n = pa.length;
  if(_v46T6GlobalOutcomes.length < 50) return pa_wins / pa_n;
  const gl_wins = _v46T6GlobalOutcomes.filter(o => o === 1).length;
  const gl_n = _v46T6GlobalOutcomes.length;
  const k = SAFE_FUNDING_PARAMS.V46_T6_PRIOR_STRENGTH;
  const prior_alpha = gl_wins * k;
  const prior_beta  = (gl_n - gl_wins) * k;
  return (prior_alpha + pa_wins) / (prior_alpha + prior_beta + pa_n);
}

/**
 * T6 size multiplier. Returns 1.0 if disabled or insufficient data.
 */
function v46T6SizeMult(pair){
  const wr = v46T6PosteriorWR(pair);
  if(wr === null) return 1.0;
  if(wr > SAFE_FUNDING_PARAMS.V46_T6_HIGH_WR_THRESHOLD) return SAFE_FUNDING_PARAMS.V46_T6_HIGH_MULT;
  if(wr < SAFE_FUNDING_PARAMS.V46_T6_LOW_WR_THRESHOLD) return SAFE_FUNDING_PARAMS.V46_T6_LOW_MULT;
  return 1.0;
}

// ─── V44.6 T5 Hawkes Process self-exciting trade intensity ─────────────────────────
// Track recent signal entries across all pairs; compute exponential-decay intensity
const _v46T5RecentEvents = [];

/**
 * Record a new signal entry for T5 Hawkes intensity.
 */
function v46T5RecordEvent(tsMs){
  _v46T5RecentEvents.push(tsMs);
  // Trim events older than decay window
  const cutoff = tsMs - SAFE_FUNDING_PARAMS.V46_T5_DECAY_WINDOW_H * 3600 * 1000;
  while(_v46T5RecentEvents.length > 0 && _v46T5RecentEvents[0] < cutoff){
    _v46T5RecentEvents.shift();
  }
}

/**
 * Compute T5 Hawkes intensity at given timestamp.
 * λ(t) = μ + Σ α·exp(-β·(t-tᵢ))
 */
function v46T5Intensity(tsMs){
  if(!SAFE_FUNDING_PARAMS.V46_T5_HAWKES) return 0;
  const cutoff = tsMs - SAFE_FUNDING_PARAMS.V46_T5_DECAY_WINDOW_H * 3600 * 1000;
  while(_v46T5RecentEvents.length > 0 && _v46T5RecentEvents[0] < cutoff){
    _v46T5RecentEvents.shift();
  }
  let sum = SAFE_FUNDING_PARAMS.V46_T5_BASELINE_MU;
  for(const ts of _v46T5RecentEvents){
    const dh = (tsMs - ts) / 3600000;
    sum += SAFE_FUNDING_PARAMS.V46_T5_ALPHA * Math.exp(-SAFE_FUNDING_PARAMS.V46_T5_BETA * dh);
  }
  return sum;
}

/**
 * T5 size multiplier. Returns 1.0 if disabled.
 * High clustering = potential illiquidity = underweight.
 * Low intensity = clean entry environment = overweight slightly.
 */
function v46T5SizeMult(tsMs){
  if(!SAFE_FUNDING_PARAMS.V46_T5_HAWKES) return 1.0;
  const lambda = v46T5Intensity(tsMs);
  if(lambda > SAFE_FUNDING_PARAMS.V46_T5_LAMBDA_THRESHOLD * 1.5) return SAFE_FUNDING_PARAMS.V46_T5_VERY_HIGH_MULT;
  if(lambda > SAFE_FUNDING_PARAMS.V46_T5_LAMBDA_THRESHOLD) return SAFE_FUNDING_PARAMS.V46_T5_HIGH_MULT;
  return SAFE_FUNDING_PARAMS.V46_T5_LOW_MULT;
}

function computeFundingProxy(bars1h){
  const n = bars1h.length;
  if(n < 60) return null;
  const closes = bars1h.map(b => b.c);
  const ema = new Float64Array(n);
  ema[0] = closes[0];
  const alpha = 2 / (50 + 1);
  for(let i = 1; i < n; i++) ema[i] = closes[i] * alpha + ema[i-1] * (1 - alpha);
  const premium = closes.map((v, i) => (v - ema[i]) / ema[i]);
  const funding = new Float64Array(n);
  const w = 8;
  for(let i = w; i < n; i++){
    let s = 0;
    for(let j = i - w + 1; j <= i; j++) s += premium[j];
    funding[i] = s / w;
  }
  return funding;
}

function fundingZScore(fundArr, idx, lookback){
  if(idx < lookback) return 0;
  let sum = 0;
  for(let j = idx - lookback + 1; j <= idx; j++) sum += fundArr[j];
  const mean = sum / lookback;
  let vsum = 0;
  for(let j = idx - lookback + 1; j <= idx; j++) vsum += (fundArr[j] - mean) ** 2;
  const std = Math.sqrt(vsum / lookback);
  return std > 0 ? (fundArr[idx] - mean) / std : 0;
}

function sizeMultFromZ(z){
  const p = SAFE_FUNDING_PARAMS;
  if(!p.ELITE_M1_ENABLED) return 1.0;
  const absZ = Math.abs(z);
  if(absZ >= p.Z_HIGH) return p.SIZE_MULT_EXTREME;
  if(absZ >= p.Z_MID) return p.SIZE_MULT_HIGH;
  if(absZ < p.Z_LOW) return p.SIZE_MULT_LOW;
  return p.SIZE_MULT_NORMAL;
}

// V44.5 PALANCA 1: Continuous sizing from quality_score
// Piecewise-linear interpolation between breakpoints calibrated from
// Análisis F (alpha retention curve over 19666 trades).
// Returns multiplier ∈ [0.7, 2.0] proportional to quality_score.
function sizeMultFromQuality(quality_score){
  const p = SAFE_FUNDING_PARAMS;
  if(!p.V45_ELITE_M1_FINE_ENABLED) return null;  // signal: use legacy z-based
  const bp = p.V45_QUALITY_BREAKPOINTS;
  const q = Math.max(0, quality_score);

  // Below first breakpoint: cap at lowest mult (shouldn't happen if QUALITY_THRESHOLD active)
  if(q <= bp[0][0]) return bp[0][1];
  // At/above last breakpoint: cap at highest mult
  if(q >= bp[bp.length - 1][0]) return bp[bp.length - 1][1];
  // Find segment and linear-interp
  for(let i = 0; i < bp.length - 1; i++){
    const [q1, m1] = bp[i];
    const [q2, m2] = bp[i + 1];
    if(q >= q1 && q <= q2){
      const t = (q - q1) / (q2 - q1);
      return m1 + t * (m2 - m1);
    }
  }
  return 1.0;
}

// ⚠️  V45 SUPREME / P14 — DO NOT ACTIVATE IN PRODUCTION ⚠️
// Verdict 2026-04-27: realistic backtest with Binance fees + slippage shows
// V45 SUPREME (P11+P7+P14) improves only +1.3% PF over V44.5 (P11+P7).
// The "PF 2.08" from ideal backtest was a methodological artifact.
// V44.5 P11+P7 = production. P14 stays in code but disabled by default.
// See /audit/V45-REALISTIC-DEPLOY-DECISION.md

// V44.5 PALANCA 11: By-pair rolling stats tracker
// In-memory: "{pair}" → array of {ts, pnl} of past trades (FIFO, max 1000)
// Used to compute rolling PF over [now-LOOKBACK-GAP, now-GAP] window.
const _v45PairTrades = new Map();

function recordTradeForPairStats(pair, ts, pnl){
  const p = SAFE_FUNDING_PARAMS;
  if(!p.V45_PAIR_SIZING_ENABLED) return;
  let arr = _v45PairTrades.get(pair);
  if(!arr){ arr = []; _v45PairTrades.set(pair, arr); }
  arr.push({ ts, pnl });
  // Cap memory usage
  const maxRetainMs = (p.V45_PAIR_LOOKBACK_DAYS + p.V45_PAIR_GAP_DAYS + 30) * 86400000;
  const cutoff = ts - maxRetainMs;
  while(arr.length > 0 && arr[0].ts < cutoff) arr.shift();
}

function rollingPairPF(pair, currentTs){
  const p = SAFE_FUNDING_PARAMS;
  if(!p.V45_PAIR_SIZING_ENABLED) return null;
  const arr = _v45PairTrades.get(pair);
  if(!arr) return null;
  const cutoffEnd = currentTs - p.V45_PAIR_GAP_DAYS * 86400000;
  const cutoffStart = cutoffEnd - p.V45_PAIR_LOOKBACK_DAYS * 86400000;
  const win = arr.filter(t => t.ts >= cutoffStart && t.ts <= cutoffEnd);
  if(win.length < p.V45_PAIR_MIN_TRADES) return null;
  let gp = 0, gl = 0;
  for(const t of win){
    if(t.pnl > 0) gp += t.pnl;
    else gl -= t.pnl;
  }
  return gl > 0 ? gp / gl : 999;
}

function pairSizeMultV45(rollingPF){
  const p = SAFE_FUNDING_PARAMS;
  if(rollingPF === null || rollingPF === undefined) return 1.0;  // No data — neutral
  for(const [thr, mult] of p.V45_PAIR_BREAKPOINTS){
    if(rollingPF >= thr) return mult;
  }
  return p.V45_PAIR_BREAKPOINTS[p.V45_PAIR_BREAKPOINTS.length - 1][1];
}

// ═══════════════════════════════════════════════════════════════════
// V46 PALANCAS — R3 (maker priority), R5 (window weights), R6 (corr dampener)
// ═══════════════════════════════════════════════════════════════════

// R3: Detect if pair qualifies for maker-only entry attempt
function shouldUseMakerPriority(pair){
  const p = SAFE_FUNDING_PARAMS;
  if(!p.V46_R3_MAKER_PRIORITY) return false;
  return p.V46_R3_PAIRS.includes(pair);
}

// R5: Settlement window weight (sizing modifier)
function settlementWindowWeight(hourUTC){
  const p = SAFE_FUNDING_PARAMS;
  if(!p.V46_R5_WINDOW_WEIGHTS) return 1.0;
  return p.V46_R5_WEIGHTS[hourUTC] || 1.0;
}

// R6: Correlation cluster dampener — caller passes count of concurrent
// signals in same cluster within current settlement window
function correlationDampener(sameClusterCount){
  const p = SAFE_FUNDING_PARAMS;
  if(!p.V46_R6_CORR_DAMPENER) return 1.0;
  if(sameClusterCount <= 1) return 1.0;
  return 1.0 / Math.sqrt(sameClusterCount);
}

// Helper: get cluster for pair (used by signal-generator to track concurrent signals)
function clusterForPair(pair){
  return SAFE_FUNDING_PARAMS.V46_R6_CLUSTERS[pair] || 'Other';
}

// V45 SUPREME PALANCA 14: Micro time-stop check
// Called by client/broker after `checkHourH` hours of position open.
// Returns true if position should close at break-even.
//
// Args:
//   entryPrice (number): position entry price
//   currentPrice (number): current market price
//   direction (string|number): 'BUY' or 'SELL', or 1/-1
//   elapsedHours (number): hours since entry (1.0 = check at hour 1)
//
// Returns: { shouldClose: boolean, reason: string }
function checkMicroStop(entryPrice, currentPrice, direction, elapsedHours){
  const p = SAFE_FUNDING_PARAMS;
  if(!p.V45_MICRO_STOP_ENABLED) return { shouldClose: false, reason: 'palanca_disabled' };
  if(elapsedHours < p.V45_MICRO_CHECK_HOUR) return { shouldClose: false, reason: 'too_early' };
  if(elapsedHours >= p.V45_MICRO_CHECK_HOUR + 1) return { shouldClose: false, reason: 'check_window_passed' };

  const dir = (direction === 'BUY' || direction === 1) ? 1 : -1;
  const favMove = dir === 1
    ? (currentPrice - entryPrice) / entryPrice
    : (entryPrice - currentPrice) / entryPrice;
  const requiredMove = (p.TP_BPS / 10000) * p.V45_MICRO_THRESHOLD;

  if(favMove < requiredMove){
    return { shouldClose: true, reason: 'micro_stop_be', favMove, requiredMove };
  }
  return { shouldClose: false, reason: 'movement_ok', favMove, requiredMove };
}

// V44.5 PALANCA 9: Reentry cooldown tracker
// In-memory map: "{symbol}:{direction}" → timestamp of last SL hit.
// Cleared on engine restart (acceptable — clustering effect is short-term).
const _v45ReentryCooldown = new Map();

function isReentryCooldownActive(pair, direction, nowMs){
  const p = SAFE_FUNDING_PARAMS;
  if(!p.V45_REENTRY_COOLDOWN_ENABLED) return false;
  const key = `${pair}:${direction}`;
  const lastSL = _v45ReentryCooldown.get(key);
  if(!lastSL) return false;
  const cooldownMs = p.V45_REENTRY_COOLDOWN_H * 3600 * 1000;
  if(nowMs - lastSL < cooldownMs) return true;
  _v45ReentryCooldown.delete(key);
  return false;
}

function markSLHitForCooldown(pair, direction, tsMs){
  _v45ReentryCooldown.set(`${pair}:${direction}`, tsMs);
}

// V44.5 PALANCA 7: Term-structure features
// Computes funding 24h vs 7d trend strength (mean-reversion potential)
// and funding 2nd derivative (acceleration → inflection predictor).
// Returns multiplier ∈ [1.0, 1.5] applied to quality_score.
function termStructureBoost(fundArr, idx, dir){
  const p = SAFE_FUNDING_PARAMS;
  if(!p.V45_TERM_STRUCTURE_ENABLED) return 1.0;
  const N24 = p.V45_TS_TREND_LOOKBACK_24H;
  const N7D = p.V45_TS_TREND_LOOKBACK_7D;
  if(idx < N7D) return 1.0;

  const f24 = fundArr.slice(idx - N24, idx).filter(isFinite);
  const f7d = fundArr.slice(idx - N7D, idx).filter(isFinite);
  if(f24.length < N24/2 || f7d.length < N7D/2) return 1.0;

  const mean24 = f24.reduce((a,b)=>a+b, 0) / f24.length;
  const mean7d = f7d.reduce((a,b)=>a+b, 0) / f7d.length;

  // Trend strength: how much current 24h diverges from 7d baseline
  // For dir=+1 (BUY → funding negative): want mean24 < mean7d (extending negative)
  // For dir=-1 (SELL → funding positive): want mean24 > mean7d (extending positive)
  const divergence = mean24 - mean7d;
  const alignedDivergence = dir === 1 ? -divergence : divergence;
  const stdDev = Math.sqrt(f7d.reduce((s,v)=>s+(v-mean7d)*(v-mean7d), 0) / f7d.length);
  const normalizedDivergence = stdDev > 0 ? alignedDivergence / stdDev : 0;
  const trendBoost = Math.max(0, Math.min(p.V45_TS_TREND_BOOST_MAX,
    normalizedDivergence * 0.15));  // 1σ divergence → +15% boost

  // Acceleration: 2nd derivative around current bar (using 6h windows)
  const f6_recent = fundArr.slice(idx - 6, idx).filter(isFinite);
  const f6_prev = fundArr.slice(idx - 12, idx - 6).filter(isFinite);
  const f6_older = fundArr.slice(idx - 18, idx - 12).filter(isFinite);
  let accelBoost = 0;
  if(f6_recent.length >= 3 && f6_prev.length >= 3 && f6_older.length >= 3){
    const m1 = f6_recent.reduce((a,b)=>a+b, 0) / f6_recent.length;
    const m2 = f6_prev.reduce((a,b)=>a+b, 0) / f6_prev.length;
    const m3 = f6_older.reduce((a,b)=>a+b, 0) / f6_older.length;
    // Accelerating in the right direction:
    // dir=+1: want funding decreasing FASTER (m1<m2<m3, gaps growing)
    // dir=-1: want funding increasing FASTER (m1>m2>m3, gaps growing)
    const v1 = m1 - m2;
    const v2 = m2 - m3;
    const accel = v1 - v2;  // 2nd derivative
    const alignedAccel = dir === 1 ? -accel : accel;
    if(alignedAccel > 0 && stdDev > 0){
      accelBoost = Math.min(p.V45_TS_ACCEL_BOOST_MAX, (alignedAccel / stdDev) * 0.25);
    }
  }

  return 1.0 + trendBoost + accelBoost;
}

function confidenceScore(z, windowType){
  const p = SAFE_FUNDING_PARAMS;
  const zAbs = Math.abs(z);
  let w = p.WINDOW_WEIGHT_MID;
  if(windowType === 'PRE') w = p.WINDOW_WEIGHT_PRE;
  else if(windowType === 'POST') w = p.WINDOW_WEIGHT_POST;
  return zAbs * w;
}

function passQualityFilter(z, windowType){
  const p = SAFE_FUNDING_PARAMS;
  if(!p.ULTRA_A_ENABLED) return true;
  return confidenceScore(z, windowType) >= p.QUALITY_THRESHOLD;
}

function getWindowTypeForHour(hr){
  const p = SAFE_FUNDING_PARAMS;
  for(const sh of p.SETTLEMENT_HOURS){
    if(hr === sh) return 'MID';
    if(hr === ((sh - 1 + 24) % 24)) return 'PRE';
    if(hr === ((sh + 1) % 24)) return 'POST';
  }
  return null;
}

function isEligibleHour(hr){
  return getWindowTypeForHour(hr) !== null;
}

function evaluateFundingCarry(pair, bars1h){
  const p = SAFE_FUNDING_PARAMS;
  if(!bars1h || bars1h.length < p.Z_LOOKBACK_H + 50) return null;
  const idx = bars1h.length - 1;
  const bar = bars1h[idx];
  const hr = new Date(bar.t).getUTCHours();
  const windowType = getWindowTypeForHour(hr);
  if(!windowType) return null;

  const fundArr = computeFundingProxy(bars1h);
  if(!fundArr) return null;
  const f = fundArr[idx];
  if(!isFinite(f)) return null;

  const fWin = Array.from(fundArr.slice(Math.max(0, idx - 168), idx)).filter(isFinite);
  if(fWin.length < 50) return null;
  const sorted = [...fWin].sort((a, b) => a - b);
  const p80 = sorted[Math.floor(sorted.length * p.P80_Q)] || 0;
  const p20 = sorted[Math.floor(sorted.length * p.P20_Q)] || 0;

  let dir = 0;
  if(f > p80 && f > p.F_POS_MIN) dir = -1;
  else if(f < p20 && f < p.F_NEG_MAX) dir = 1;
  if(dir === 0) return null;

  const z = fundingZScore(fundArr, idx, p.Z_LOOKBACK_H);
  if(!passQualityFilter(z, windowType)) return null;

  // V44.5 PALANCA 9: Cooldown post-loss check (evita clustering)
  const direction = dir === 1 ? 'BUY' : 'SELL';
  if(isReentryCooldownActive(pair, direction, bar.t)) return null;

  let quality_score = confidenceScore(z, windowType);
  // V44.5 PALANCA 7: Term-structure boost (modulates quality_score upward
  // when funding trend/acceleration aligns with trade direction)
  const tsBoost = termStructureBoost(fundArr, idx, dir);
  quality_score *= tsBoost;
  // V44.5 PALANCA 1: Sizing fino preferred over coarse 4-bucket if enabled
  const fineMult = sizeMultFromQuality(quality_score);
  let sizeMult = fineMult !== null ? fineMult : sizeMultFromZ(z);
  // V44.5 PALANCA 11: By-pair rolling sizing (winner in holdout validation)
  // Multiplies on top of base sizing — capped at 2.0× total to prevent runaway
  const rollingPF = rollingPairPF(pair, bar.t);
  const pairMult = pairSizeMultV45(rollingPF);
  sizeMult = sizeMult * pairMult;
  // V46 R5: Settlement window weighting (calibrated from forensics)
  const r5Weight = settlementWindowWeight(hr);
  sizeMult *= r5Weight;
  // V44.6 T6: Bayesian Hierarchical Shrinkage (empirical Bayes posterior WR)
  const t6Mult = v46T6SizeMult(pair);
  sizeMult *= t6Mult;
  // V44.6 T5: Hawkes Self-Excitation intensity dampener
  const t5Mult = v46T5SizeMult(bar.t);
  sizeMult *= t5Mult;
  // V46 R6: Correlation cluster dampener
  // Note: caller (signal-generator) tracks concurrent signals via signalCountInCluster
  // For standalone evaluateFundingCarry call, sameClusterCount=1 (no dampening)
  // Real dampening happens at signal-generator level when batch processing
  // Cap final mult at 2.0
  sizeMult = Math.min(2.0, sizeMult);

  const entry = bar.c;
  const tp = dir === 1 ? entry * (1 + p.TP_BPS / 10000) : entry * (1 - p.TP_BPS / 10000);
  const sl = dir === 1 ? entry * (1 - p.SL_BPS / 10000) : entry * (1 + p.SL_BPS / 10000);

  const baseConf = Math.min(85, 50 + Math.abs(f - (dir === 1 ? p20 : p80)) * 1000);
  const zBoost = sizeMult >= 1.6 ? 15 : (sizeMult >= 1.35 ? 8 : 3);
  const confidence = Math.min(98, Math.round(baseConf + zBoost));

  const v45active = fineMult !== null || p.V45_PAIR_SIZING_ENABLED || p.V45_TERM_STRUCTURE_ENABLED;
  const v44_6active = p.V46_T6_BAYESIAN || p.V46_T5_HAWKES;
  // Record event for T5 Hawkes (only when actually entering — caller does this if it operates)
  // We record on signal generation as a proxy for entry intensity
  if(p.V46_T5_HAWKES) v46T5RecordEvent(bar.t);
  return {
    symbol: pair,
    signal: direction,
    confidence,
    entry, tp, sl,
    funding: f,
    funding_zscore: z,
    size_multiplier: sizeMult,
    sizing_engine: v44_6active ? 'V44.6' : (v45active ? 'V44.5' : 'V44_coarse'),
    quality_score,
    ts_boost: tsBoost,
    pair_rolling_pf: rollingPF,
    pair_size_mult: pairMult,
    r5_window_weight: r5Weight,
    t6_size_mult: t6Mult,
    t5_size_mult: t5Mult,
    cluster: clusterForPair(pair),
    use_maker_priority: shouldUseMakerPriority(pair),
    window_type: windowType,
    leverage: p.LEVERAGE,
    hold_hours: p.HOLD_H,
    micro_stop: p.V45_MICRO_STOP_ENABLED ? {
      enabled: true,
      check_hour: p.V45_MICRO_CHECK_HOUR,
      threshold_pct: p.V45_MICRO_THRESHOLD,
      required_move_pct: (p.TP_BPS / 10000) * p.V45_MICRO_THRESHOLD * 100,
      description: `Auto-close at break-even if price hasn't moved ${((p.TP_BPS / 10000) * p.V45_MICRO_THRESHOLD * 100).toFixed(3)}% favorable after ${p.V45_MICRO_CHECK_HOUR}h`
    } : null,
    timestamp: Date.now(),
    engine: (p.V45_MICRO_STOP_ENABLED || v45active) ? (p.V45_MICRO_STOP_ENABLED ? 'APEX_V45_SUPREME' : 'APEX_V44.5_SERVER') : 'APEX_V44_SERVER'
  };
}

// CoinGecko symbol → coin id mapping (free tier, no auth, hourly bars up to 90d)
// Coverage: todos los pares del APEX universe
const COINGECKO_ID_MAP = {
  BTCUSDT: 'bitcoin', ETHUSDT: 'ethereum', SOLUSDT: 'solana', BNBUSDT: 'binancecoin',
  XRPUSDT: 'ripple', ADAUSDT: 'cardano', DOGEUSDT: 'dogecoin', LINKUSDT: 'chainlink',
  ARBUSDT: 'arbitrum', ATOMUSDT: 'cosmos', '1000PEPEUSDT': 'pepe', TRXUSDT: 'tron',
  NEARUSDT: 'near', POLUSDT: 'matic-network', INJUSDT: 'injective-protocol',
  SUIUSDT: 'sui', RENDERUSDT: 'render-token', AVAXUSDT: 'avalanche-2',
  DOTUSDT: 'polkadot', '1000SHIBUSDT': 'shiba-inu', OPUSDT: 'optimism',
  JUPUSDT: 'jupiter-exchange-solana'
};

// Fetch 1h klines with multi-source fallback chain.
// 2026-04-27: Render IP geo-blocks Binance/Bybit. Solution: CoinGecko (universal, no auth).
async function fetchBars1h(symbol, limit = 800){
  const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const fetchOpts = { headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' } };
  const REQUIRED_MIN = Math.min(limit, 770);

  let best = null;
  const considerCandidate = (bars) => {
    if (!bars || bars.length === 0) return false;
    if (!best || bars.length > best.length) best = bars;
    return bars.length >= REQUIRED_MIN;
  };

  // Helper: normalizar 1000PEPE/1000SHIB → PEPE/SHIB para exchanges sin 1000-prefix
  const stripPrefix = (s) => s.startsWith('1000') ? s.slice(4) : s;

  // 1. Binance fapi (puede 451 desde Render)
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=${limit}`, fetchOpts);
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length > 0) {
        const bars = arr.map(k => ({ t: parseInt(k[0]), c: parseFloat(k[4]) }));
        if (considerCandidate(bars)) return bars;
      }
    }
  } catch(e){}

  // 2. Bybit linear perp (puede 403 desde Render)
  try {
    const r = await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=${Math.min(limit, 1000)}`, fetchOpts);
    if (r.ok) {
      const j = await r.json();
      const list = j?.result?.list;
      if (Array.isArray(list) && list.length > 0) {
        const bars = list.map(k => ({ t: parseInt(k[0]), c: parseFloat(k[4]) })).reverse();
        if (considerCandidate(bars)) return bars;
      }
    }
  } catch(e){}

  // 3. CoinGecko (FREE TIER, no auth, hourly hasta 90d, public, no geo-block)
  // Endpoint /coins/{id}/market_chart con days=35 → ~840 bars hourly close prices
  try {
    const cgId = COINGECKO_ID_MAP[symbol];
    if (cgId) {
      const days = 40; // 40 días × 24h = 960 bars (>770 requerido)
      const url = `https://api.coingecko.com/api/v3/coins/${cgId}/market_chart?vs_currency=usd&days=${days}&interval=hourly`;
      const r = await fetch(url, fetchOpts);
      if (r.ok) {
        const j = await r.json();
        const prices = j?.prices;
        if (Array.isArray(prices) && prices.length > 0) {
          // CoinGecko: [[ts_ms, price], ...] oldest-first
          const bars = prices.map(p => ({ t: parseInt(p[0]), c: parseFloat(p[1]) }));
          if (considerCandidate(bars)) return bars;
        }
      }
    }
  } catch(e){}

  // 4. OKX paginated. Two endpoints with distinct rules:
  //   - /market/candles: limit max 300, returns recent bars
  //   - /market/history-candles: limit max 100 (silently capped), supports `after=<ts>` for older bars
  // Strategy: 1 call /candles (300) + N calls /history-candles?after=<oldestTs>&limit=100 to fill ≥770
  try {
    if (symbol.endsWith('USDT')) {
      const base = stripPrefix(symbol.slice(0, -4));
      const okxSym = `${base}-USDT-SWAP`;
      const collected = [];
      let oldestTs = null;

      // Initial call: /candles for latest 300
      try {
        const r = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${okxSym}&bar=1H&limit=300`, fetchOpts);
        if (r.ok) {
          const j = await r.json();
          const arr = j?.data;
          if (Array.isArray(arr) && arr.length > 0) {
            // OKX returns newest-first: arr[0]=newest, arr[last]=oldest in this batch
            const batch = arr.map(k => ({ t: parseInt(k[0]), c: parseFloat(k[4]) }));
            collected.push(...batch);
            oldestTs = batch[batch.length - 1].t;
          }
        }
      } catch(e){}

      // Paginated history-candles with after=<oldestTs> (= older than ts). Max 100 per call.
      // 2026-04-28: throttle 150ms between calls to avoid OKX rate limit when scanAllPairs
      // runs 15 pairs in parallel via Promise.all (15 × 7 calls = 105 simultaneous = throttled)
      const MAX_HIST_CALLS = 8;
      const PAGINATION_DELAY_MS = 150;
      for (let i = 0; i < MAX_HIST_CALLS && collected.length < limit + 100 && oldestTs; i++){
        if (i > 0) {
          // Small jittered delay to spread load across parallel pairs (avoids burst)
          await new Promise(r => setTimeout(r, PAGINATION_DELAY_MS + Math.floor(Math.random() * 100)));
        }
        try {
          const url = `https://www.okx.com/api/v5/market/history-candles?instId=${okxSym}&bar=1H&after=${oldestTs}&limit=100`;
          const r = await fetch(url, fetchOpts);
          if (!r.ok) {
            // 429 or 503: backoff harder and retry once
            if (r.status === 429 || r.status === 503) {
              await new Promise(rs => setTimeout(rs, 800 + Math.floor(Math.random() * 400)));
              const r2 = await fetch(url, fetchOpts);
              if (!r2.ok) break;
              const j2 = await r2.json();
              const arr2 = j2?.data;
              if (!Array.isArray(arr2) || arr2.length === 0) break;
              const batch2 = arr2.map(k => ({ t: parseInt(k[0]), c: parseFloat(k[4]) }));
              collected.push(...batch2);
              const newOldest2 = batch2[batch2.length - 1].t;
              if (newOldest2 >= oldestTs) break;
              oldestTs = newOldest2;
              if (batch2.length < 100) break;
              continue;
            }
            break;
          }
          const j = await r.json();
          const arr = j?.data;
          if (!Array.isArray(arr) || arr.length === 0) break;
          const batch = arr.map(k => ({ t: parseInt(k[0]), c: parseFloat(k[4]) }));
          collected.push(...batch);
          // Update oldestTs to oldest in this batch (last item, newest-first)
          const newOldest = batch[batch.length - 1].t;
          if (newOldest >= oldestTs) break; // no progress, avoid infinite loop
          oldestTs = newOldest;
          if (batch.length < 100) break; // no more history available
        } catch(e){ break; }
      }

      if (collected.length > 0){
        collected.sort((a, b) => a.t - b.t);
        const dedup = [];
        let lastT = -1;
        for (const b of collected){
          if (b.t !== lastT){ dedup.push(b); lastT = b.t; }
        }
        if (considerCandidate(dedup)) return dedup;
      }
    }
  } catch(e){}

  // 5. CryptoCompare (universal, limit hasta 2000 — formato V2 con .Data.Data nested)
  try {
    if (symbol.endsWith('USDT')) {
      const ccBase = stripPrefix(symbol.slice(0, -4));
      // CryptoCompare a veces requiere tsym=USD si USDT no est\u00e1 disponible
      const tryEndpoints = [
        `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${ccBase}&tsym=USDT&limit=${Math.min(limit, 2000)}`,
        `https://min-api.cryptocompare.com/data/v2/histohour?fsym=${ccBase}&tsym=USD&limit=${Math.min(limit, 2000)}`
      ];
      for (const url of tryEndpoints){
        try {
          const r = await fetch(url, fetchOpts);
          if (!r.ok) continue;
          const j = await r.json();
          // V2 estructura: { Response, Data: { Data: [...] } }
          const arr = j?.Data?.Data || j?.Data;
          if (Array.isArray(arr) && arr.length > 0){
            const bars = arr
              .filter(k => k && k.time && k.close)
              .map(k => ({ t: parseInt(k.time) * 1000, c: parseFloat(k.close) }));
            if (bars.length > 0 && considerCandidate(bars)) return bars;
          }
        } catch(e){}
      }
    }
  } catch(e){}

  // 6. Binance spot (puede 451)
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${Math.min(limit, 1000)}`, fetchOpts);
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length > 0) {
        const bars = arr.map(k => ({ t: parseInt(k[0]), c: parseFloat(k[4]) }));
        if (considerCandidate(bars)) return bars;
      }
    }
  } catch(e){}

  // Retornar el mejor candidato (puede ser <REQUIRED pero al menos no null)
  return best;
}

// Scan all pairs in the validated universe. Returns array of signals (non-null only).
// 2026-04-28: process pairs in chunks of 3 to avoid OKX rate limit when paginating
// (15 pairs × 7 OKX calls each = 105 simultaneous = throttled if all parallel).
// Chunks of 3 = ~21 simultaneous calls, fits within OKX limits comfortably.
async function scanAllPairs(){
  const p = SAFE_FUNDING_PARAMS;
  const hr = new Date().getUTCHours();
  if(!isEligibleHour(hr)){
    return { scanned: 0, signals: [], reason: 'outside_window', next_window_utc: findNextEligibleHour(hr) };
  }
  const CHUNK = 3;
  const insufficient = []; // track pairs that didn't get enough bars (for logging)
  const errors = [];        // track pairs that errored
  const results = [];
  for (let i = 0; i < p.UNIVERSE.length; i += CHUNK) {
    const chunk = p.UNIVERSE.slice(i, i + CHUNK);
    const chunkResults = await Promise.all(chunk.map(async (sym) => {
      try {
        const bars = await fetchBars1h(sym, 800);
        if(!bars || bars.length < p.Z_LOOKBACK_H + 50) {
          insufficient.push({ sym, bars: bars?.length || 0 });
          return null;
        }
        return evaluateFundingCarry(sym, bars);
      } catch(e){
        errors.push({ sym, err: e.message?.slice(0, 80) });
        return null;
      }
    }));
    results.push(...chunkResults);
    // Brief pause between chunks to spread load on OKX
    if (i + CHUNK < p.UNIVERSE.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  const signals = results.filter(Boolean);
  return {
    scanned: p.UNIVERSE.length,
    signals,
    window_type: getWindowTypeForHour(hr),
    reason: 'ok',
    insufficient_pairs: insufficient.length > 0 ? insufficient : undefined,
    errored_pairs: errors.length > 0 ? errors : undefined
  };
}

function findNextEligibleHour(fromHr){
  const p = SAFE_FUNDING_PARAMS;
  const eligible = new Set();
  for(const sh of p.SETTLEMENT_HOURS){
    for(const off of p.WINDOW_HOURS_OFFSET) eligible.add((sh + off + 24) % 24);
  }
  for(let h = fromHr + 1; h < fromHr + 25; h++){
    if(eligible.has(h % 24)) return h % 24;
  }
  return p.SETTLEMENT_HOURS[0];
}

module.exports = {
  SAFE_FUNDING_PARAMS,
  evaluateFundingCarry,
  fetchBars1h,
  scanAllPairs,
  isEligibleHour,
  getWindowTypeForHour,
  findNextEligibleHour,
  // V44.5 lever exports
  sizeMultFromZ,
  sizeMultFromQuality,
  confidenceScore,
  markSLHitForCooldown,
  isReentryCooldownActive,
  // V44.5 P11 exports (winner)
  recordTradeForPairStats,
  rollingPairPF,
  pairSizeMultV45,
  // V45 SUPREME P14 exports (winner)
  checkMicroStop,
  // V46 palanca exports
  shouldUseMakerPriority,
  settlementWindowWeight,
  correlationDampener,
  clusterForPair,
  // V44.6 deploy exports (T6 Bayesian + T5 Hawkes)
  v46T6RecordOutcome,
  v46T6PosteriorWR,
  v46T6SizeMult,
  v46T5RecordEvent,
  v46T5Intensity,
  v46T5SizeMult
};
