# V44 Anti-Overfitting Validation Report

**Date:** 2026-04-22
**V44 config:** v42 PRO Pearson directional + Entropy filter + DD brake + HRP sizing + Funding carry stream
**Frozen params:** all V44 parameters held FIXED during validation

---

## EXECUTIVE VERDICT

# 🔴 OVERFIT CONFIRMED — DO NOT DEPLOY

**Gates passed: 2/10** (<5 per user spec → overfit)

V44 fails holdout validation catastrophically. Edge is regime-specific, parameter-fragile, and dependent on a few outlier pairs. **v42 PRO+ remains the production default.**

---

## GATE RESULTS TABLE

| Test | Gate | Result | Verdict |
|------|------|--------|---------|
| 1. Holdout Sacrosanto | PF holdout ≥ 1.30 | PF **1.00** (0.54× train) | ❌ OVERFIT |
| 2. Bootstrap 2000 iter | Median PF ≥ 1.5, frac<1.0 <5% | Median 1.88, frac<1 1.5% | ✅ ROBUST |
| 3. Param Sensitivity ±20% | Max PF drop ≤ 15% @ ±10% | Max drop **41.5%** (prngGate) | ❌ OVER-TUNED |
| 4. MC Trade Shuffle 1000 | DD in P20-P80 | DD P19.7% (near-miss) | ❌ FAIL |
| 5. Quarterly Segmentation | PF variation ≤ 40% | Variation **73%** | ❌ REGIME-DEP |
| 6. Pair Ablation | Max PF drop ≤15% any pair | **33.8%** (-1000PEPE) | ❌ OUTLIER-DEP |
| 7. Short Rolling CV 60/20 + 30/10 | Median PF≥1.4, min≥1.1 | Min **0.11-0.14** | ❌ UNSTABLE |
| 8. DSR Rigorous @ 100 trials | DSR > 1.0 | DSR **-2.14** | ❌ NOT SIGNIFICANT |
| 9. Feature Stability | Avg top-1 stability ≥60% | 57.3% (near-miss) | ❌ UNSTABLE |
| 10. Random Benchmark | V44 ≥ P99 | V44 at **P99.8%** | ✅ REAL EDGE |

**Score: 2/10 PASS**

---

## DETAILED FINDINGS

### TEST 1 — HOLDOUT SACROSANTO (MOST DECISIVE)

| Window | PF | WR | DD | Sharpe | PnL |
|--------|-----|-----|-----|--------|-----|
| Training 2025-07→2026-03 | 1.85 | 67.7% | 15.5% | 1.75 | $2,066 |
| **Holdout 2024-07→2025-06** | **1.00** | 68.4% | **211.3%** | 0.02 | $15 |
| Ratio | **0.54×** | 1.01× | 13.6× | 0.01× | 0.01× |

**Directional engine standalone on holdout: PF 0.94, DD 247%, Sharpe -0.72** — complete failure.
Funding stream alone: PF 1.47 (consistent across periods).

The V44 directional edge is **regime-specific** — it worked in 2025-07→2026-03 but not in 2024-07→2025-06. The "combined" PF of 1.85 is driven by favorable regime + funding carry.

### TEST 2 — BOOTSTRAP (ONLY STATISTICAL PASS)

- Median PF: 1.88
- 95% CI: [1.07, 3.26]
- Fraction PF<1.0: 1.50%
- Fraction PF<1.3: 9.65%

The bootstrap PASSES because it measures statistical stability of the trades IN the training window. It says "given these 4890 trades, the PF 1.88 is robust to resampling". But it does NOT validate edge across NEW data.

### TEST 3 — PARAMETER SENSITIVITY

| Parameter | -20% | -10% | base | +10% | +20% | Max Δ |
|-----------|------|------|------|------|------|-------|
| entropyPct | 1.56 | 1.62 | 1.85 | **2.55** | 1.63 | -15.7% |
| entropyWindowDays | 1.23 | 2.06 | 1.85 | 1.66 | 2.23 | -33.8% |
| ddStop14 | 1.46 | 1.64 | 1.85 | 1.87 | 1.68 | -21.4% |
| ddStop30 | 1.56 | 1.64 | 1.85 | 2.15 | 2.20 | -15.8% |
| slMNormal | 1.96 | 1.77 | 1.85 | 1.94 | 1.31 | -29.2% |
| tpRNormal | 1.60 | 1.78 | 1.85 | 1.84 | 1.79 | -13.5% |
| **prngGate** | **1.09** | 1.38 | 1.85 | 1.74 | 1.71 | **-41.5%** |
| peakThresh | 1.85 | 1.85 | 1.85 | 1.77 | 1.59 | -14.1% |

The **prngGate parameter** causes a 41.5% PF swing with just ±20% perturbation. This is a random sampling gate — the fact that moving it ±20% drops PF to 1.09 (near break-even) suggests the "edge" is at the margin of randomness.

### TEST 4 — MC SHUFFLE

- Realized DD: $397
- MC P5/P20/P50/P80/P95: $326 / $399 / $495 / $627 / $796
- Realized percentile: **19.7%** (just below P20)

Realized DD is slightly lower than median → very marginal "luck" factor. DD could realistically be 25% worse in live trading.

### TEST 5 — QUARTERLY

| Quarter | Trades | PF | WR | DD | PnL |
|---------|--------|-----|-----|-----|------|
| 2025-Q3 | 1,602 | 1.31 | 66.4% | 1.7% | $31 |
| **2025-Q4** | 1,645 | **2.27** | 70.9% | 16.2% | **$1,425** |
| 2026-Q1 | 1,643 | 1.51 | 65.9% | 35.8% | $611 |

PF variation 73% — V44 is **regime-dependent**. Most of 2025-Q4 PnL (~$1,425) drives the overall PF 1.85. Q3 and Q1 are marginal.

### TEST 6 — PAIR ABLATION

| Pair Removed | Δ PF% | Δ DD pp |
|--------------|-------|---------|
| **1000PEPEUSDT** | **-33.8%** | **+76.8pp** |
| XRPUSDT | -30.8% | +48.8pp |
| ADAUSDT | -30.7% | +42.2pp |
| DOTUSDT | -29.1% | +35.0pp |
| DOGEUSDT | -22.3% | +37.2pp |
| BNBUSDT | -18.8% | +25.7pp |
| ETHUSDT | -15.4% | +17.2pp |

**V44 edge is concentrated in specific pairs** — particularly 1000PEPEUSDT (meme coin with extreme moves benefits entropy filter). Remove it and DD jumps from 15.7% to 92.5%.

Six pairs cause >15% PF swings when removed. Removing any of them destroys V44.

### TEST 7 — SHORT ROLLING CV

| Scheme | Windows | Min PF | P25 | Median | P75 | Max |
|--------|---------|--------|-----|--------|-----|-----|
| TRAIN 60d / TEST 20d | 20 | 0.14 | 0.30 | 1.07 | 1.45 | 1.68 |
| TRAIN 30d / TEST 10d | 47 | 0.11 | 0.81 | 1.34 | 1.71 | 5.47 |

Shorter windows expose the fragility hidden by the 120/30 walk-forward used in training. **Median PF drops to 1.07-1.34, minimum hits 0.11-0.14** — complete collapse in many windows.

### TEST 8 — DSR RIGOROUS

Accounting for ~100 configurations tested during V44 research (ablation variants × parameter tuning):

| Scenario | N trials | E[max Sh] | DSR | p-value |
|----------|----------|-----------|-----|---------|
| Low (10) | 10 | 1.575 | 0.47 | 0.68 |
| **Realistic (100)** | 100 | 2.531 | **-2.14** | **0.016** |
| Paranoid (500) | 500 | 3.053 | -3.56 | 0.0002 |

With realistic trial count, the expected max Sharpe under the null exceeds V44's realized Sharpe. **Statistically, V44's Sharpe 1.75 is what you'd expect by chance from 100 random trials.**

### TEST 9 — FEATURE STABILITY

Average top-1 feature stability across 5 walk-forward windows: **57.3%**

Per-pair stability varies wildly (40% for ADA/XRP/DOT/LINK up to 80% for BTC/ATOM/AVAX/BNB). Many pairs show top feature changing every window — confirms edge is NOT anchored to consistent predictive signal.

### TEST 10 — RANDOM BENCHMARK (ONLY REAL-EDGE PASS)

- Random strategy PF distribution: mean 0.97, P50 0.95, P95 1.38, P99 1.66
- V44 PF: 1.85 → **P99.8%** of random distribution

V44 IS better than random. But the difference (1.85 vs P99=1.66) is driven mainly by **the funding carry stream** (which contributes PF 1.41 on its own — random entries + funding would already reach ~1.4+).

---

## ROOT CAUSE ANALYSIS

**Why did V44 pass the training backtest (PF 1.85) but fail holdout (PF 1.00)?**

1. **Meme coin outlier (1000PEPEUSDT):** this pair had extreme swings in 2025-Q4 that the entropy filter + adaptive sizing captured perfectly. In 2024-07→2025-06, the pair behaved differently.

2. **Regime concentration:** 69% of V44's PnL came from 2025-Q4 alone. The engine captured one specific bull regime's microstructure.

3. **Parameter over-tuning:** entropy_window_days, prngGate, and slM parameters are at narrow optima. Even ±10% perturbation destroys performance.

4. **Walk-forward window size (120/30) masks instability:** shorter windows (60/20 or 30/10) reveal 11-14% of windows with PF near 0.

5. **Multiple-testing not adjusted:** DSR at 100 trials is -2.14, meaning V44's Sharpe 1.75 is no better than you'd get from random exploration of 100 configurations.

---

## COMPARATIVE METRICS

```
                TRAINING       HOLDOUT        DEGRADATION
                2025-07→03     2024-07→06
PF              1.85           1.00           -46%
WR              67.7%          68.4%          +1%   (WR preserved, edge NOT)
DD              15.5%          211.3%         13.6×
Sharpe          1.75           0.02           -99%
Monthly pos     8/9 (89%)      ?              not tested
PnL/day         $7.83          $0.04          -99.5%
```

WR staying near 68% is DECEPTIVE — with a funding carry stream (70%+ WR structurally) dominating trade count, the overall WR is maintained while the directional edge collapses.

---

## FINAL RECOMMENDATION

### ❌ DO NOT DEPLOY V44

Per user's score criteria:
- 9-10 gates: deploy as beta ❌
- 7-8 gates: deploy with warnings ❌
- 5-6 gates: no deploy, research only ❌
- **<5 gates: overfit confirmed, v42 PRO+ is the ceiling ✓ (current: 2/10)**

### What to preserve

- **Funding Carry Stream** is the ONLY validated orthogonal edge (PF 1.41 holdout, 1.47 training — consistent).
- **v42 PRO+** remains production engine.
- **Research scripts** preserved in `/research-v44/` for reproducibility.

### What this means for roadmap

The practical "V44 edge" was an artifact of:
1. A favorable regime (2025-Q4 bull phase)
2. One exceptional pair (1000PEPE memecoin)
3. Parameter optimization that didn't generalize

**The honest ceiling with current data + features is v42 PRO+ PF 1.26.** Real improvements require:
- Live trading data to calibrate (not more backtesting)
- Richer data sources (actual orderbook L2, options Greeks, on-chain flow NOT proxies)
- Longer holdout periods with multiple regime transitions

### Suggested next steps

1. **Deploy funding carry stream** as supplementary engine to v42 PRO+ (this DID validate)
2. **Paper trade v42 PRO+ live** for 60-90 days to collect real microstructure data
3. **Re-research when you have 2+ years of real execution data**, not just backtest simulation

---

## VALIDATION ARTIFACTS

All 10 test scripts + results preserved in `/research-v44/validation/`:

```
/research-v44/validation/
├── v44_engine.js                      ← Shared V44 module (frozen params)
├── download_holdout.js                ← Holdout data downloader
├── 01_test_holdout.js                 ← CATASTROPHIC FAIL
├── 02_test_bootstrap.js               ← PASS
├── 03_test_sensitivity.js             ← FAIL (over-tuned)
├── 04_test_mc_shuffle.js              ← FAIL (near-miss)
├── 05_test_quarterly.js               ← FAIL (regime-dep)
├── 06_test_pair_ablation.js           ← FAIL (outlier-dep)
├── 07_test_short_rolling_cv.js        ← FAIL (unstable)
├── 08_test_dsr_rigorous.js            ← FAIL (not significant)
├── 09_test_feature_stability.js       ← FAIL (unstable)
├── 10_test_random_benchmark.js        ← PASS
└── results/
    ├── 01_test_holdout.json
    ├── 02_test_bootstrap.json
    ├── 03_test_sensitivity.json
    ├── 04_test_mc_shuffle.json
    ├── 05_test_quarterly.json
    ├── 06_test_pair_ablation.json
    ├── 07_test_short_rolling_cv.json
    ├── 08_test_dsr_rigorous.json
    ├── 09_test_feature_stability.json
    └── 10_test_random_benchmark.json
```

Plus 800MB of holdout data in `/tmp/binance-klines-1m-holdout/` (15 pairs × 12 months 2024-07→2025-06).

---

## HONESTY STATEMENT

All 10 tests executed with FROZEN V44 parameters. No retuning occurred. Every result reported honestly, including bad ones. The 3 improvements over v42 PRO+ baseline seen in training (entropy filter, HRP sizing, funding carry) did NOT survive out-of-sample validation. **v42 PRO+ remains the evidence-based production default.**
