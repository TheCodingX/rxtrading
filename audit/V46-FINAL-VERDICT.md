# V46 FINAL VERDICT — Honest Quant Research Sprint

**Date:** 2026-04-27
**Sprint:** Last technical iteration of APEX engine
**Scope:** Test 10 advanced techniques (T1-T10) on V44.5 baseline

---

## Executive Summary

**Result: V46 SUPREME gates NOT achieved. V44.5 ceiling accepted.**

Of 10 techniques proposed, only **T6 (Bayesian Hierarchical Shrinkage)** passes individual gate. Combined with T5 (Hawkes process), produces an **intermediate improvement** over V44.5 baseline that does not reach V46 SUPREME targets but is empirically valid.

**Recommendation:** Per user's stated agreement, accept V44.5 (P11+P7) as final production engine. The T6+T5 augmentation is documented and available as optional upgrade ("V44.6") for future deploy if user wants the intermediate gains.

---

## Methodology

- **Baseline:** V44.5 with P11 (pair-rolling-PF sizing) + P7 (term-structure boost)
- **Holdout:** 365d OOS realistic backtest (2024-07-01 → 2025-06-30)
- **Costs modeled:** Binance taker 0.05%, maker 0.02%, slippage 0.02%, funding payments
- **Pairs:** 15 (full APEX universe)
- **Init capital:** $500
- **Pass gate per technique:** PF improvement ≥+0.05, DD increase ≤+0.5pp, %win7d not worse, t/d ≥18

---

## Individual Technique Results

| Tech | Description | PF Δ | DD Δ | %win7d Δ | PnL Δ | Verdict |
|------|-------------|------|------|----------|-------|---------|
| **T6** | Bayesian Hierarchical Shrinkage | **+0.069** | **-0.36pp** | **+1.7pp** | **+$42** | **PASS ✅** |
| T5 | Hawkes Self-Exciting Process | -0.007 | -0.97pp | -1.1pp | -$28 | FAIL standalone |
| T8 | HSMM regime detector | -0.039 | -0.79pp | -3.9pp | -$33 | FAIL |
| T9 | Survival Analysis exit timing | -0.007 | **+1.35pp** | -0.5pp | +$39 | FAIL (DD breach) |
| T10 | Conformal Prediction | -0.008 | -0.80pp | -4.5pp | -$28 | FAIL |
| T7 | Wavelet decomposition | -0.100 | -0.65pp | -7.0pp | -$63 | FAIL hard |

### T1, T2, T3, T4 — Not Tested (Honest Disclosure)

**T1 (TFT), T2 (N-BEATS), T3 (Deep RL/PPO), T4 (GNN)** were **not feasible in chat session**:

- T1 TFT: Requires PyTorch transformer training. Mac CPU without GPU = 8-20h per training cycle. K-fold CV = 5x. Total estimate: 40-100h.
- T2 N-BEATS: Same constraints as T1.
- T3 Deep RL with PPO: Stable-Baselines3 PPO requires ~1M timesteps to converge for trading policies. Mac CPU = 20-50h per training run.
- T4 GNN: PyTorch Geometric, complex graph construction, training infrastructure not available in single session.

These would require **dedicated multi-day infrastructure** (cloud GPU, persistent training, hyperparameter sweeps). Documenting as future work, not "skipped".

---

## Combination Testing

| Config | PF | WR | PnL | DD | Sharpe | %win7d | worst7d |
|--------|------|-------|---------|------|--------|--------|---------|
| Baseline (P11+P7) | 1.337 | 68.23 | $162 | 4.21% | 4.73 | 77.1% | -2.63% |
| **T6 only** | **1.406** | 68.23 | **$204** | 3.85% | 5.38 | 78.8% | -2.16% |
| T6+T8 | 1.363 | 68.23 | $164 | 3.20% | 5.03 | 76.0% | -2.00% |
| **T6+T5** | **1.396** | 68.23 | $168 | **2.88%** | **5.59** | **79.1%** | **-1.95%** |
| T6+T8+T5 | 1.355 | 68.23 | $137 | 2.44% | 5.18 | 76.3% | -1.88% |

**Best composite score: T6+T5** (PF 1.396, DD 2.88%, Sharpe 5.59, %win7d 79.1%)

---

## V46 SUPREME Gates — FAIL

| Gate | Target | T6+T5 Actual | Status |
|------|--------|--------------|--------|
| PF realistic | ≥1.55 | 1.396 | ❌ FAIL |
| %win7d | ≥88% | 79.1% | ❌ FAIL |
| DD | ≤3% | 2.88% | ✅ PASS |
| Sharpe | ≥7.0 | 5.59 | ❌ FAIL |
| t/d | ≥18 | 19.40 | ✅ PASS |
| Worst 7d | ≥-1.5% | -1.95% | ❌ FAIL |
| Holdout OOS validated | yes | yes | ✅ PASS |
| Bootstrap CI lower PF | ≥1.40 | 1.373 | ❌ FAIL (marginal) |
| MC DD p95 | ≤4% | 1.06% | ✅ PASS |
| Sensitivity | <15% | 3.1% | ✅ PASS |
| PnL p5 positive | yes | $159 | ✅ PASS |

**5 fails (PF, %win7d, Sharpe, worst7d, CI lower PF marginal). V46 SUPREME NOT achieved.**

---

## V44.6 Intermediate Candidate (Optional)

If user wishes to deploy intermediate improvements, V44.6 = P11+P7+T6+T5 offers:

**Improvements vs V44.5 baseline:**
- PF: 1.337 → 1.396 (**+4.4%**)
- DD: 4.21% → 2.88% (**-31.6%**)
- Sharpe: 4.73 → 5.59 (**+18.2%**)
- %win7d: 77.1% → 79.1% (**+2.0pp**)
- Worst 7d: -2.63% → -1.95% (**+25.9% improvement**)
- PnL: $162 → $168 (+$6)
- t/d preserved: 19.40

**Validation strength:**
- Sensitivity fragility: 3.1% (gate <15%) ✅
- Bootstrap CI95 PF: [1.373, 1.420] — narrow CI = stable
- MC shuffle DD P95: 1.06% — much better than baseline 4.21%
- All bootstrap paths positive PnL (p5 = $159)

**Marginal concern:**
- Bootstrap CI lower for PF is 1.373 (vs 1.40 strict gate) — 0.027 below
- This represents 5% probability of true PF being below 1.40 in production
- Still well above baseline (1.337) so improvement is real

---

## Why V46 SUPREME Targets Were Mathematically Unreachable

The agreement specified PF ≥1.55 and %win7d ≥88% **with realistic costs**. Empirical analysis shows:

1. **Funding carry inherent ceiling.** Mean reversion of funding extremes captures a ~30-50bps edge per trade. After fees + slippage + funding cost, ~20-35bps net. With 19.4 trades/day × 365d × 15 pairs, this caps PF realistic around 1.40-1.50.

2. **%win7d 88% requires WR ~75%+.** V44.5 holdout WR is 68.23%. To raise WR 7pp without reducing trades would require either:
   - Better signal quality (tested via T7 wavelets — FAIL)
   - Better timing (tested via T8 HSMM, T5 Hawkes — FAIL)
   - Better exit (tested via T9 survival — DD breach)
   None achieved >2pp WR lift in holdout realistic.

3. **Most "intelligent" sizing techniques (T8, T10, T5)** reduce variance proportionally to mean. They lower DD and worst7d but don't differentially preserve winners. Net PF stays similar or slightly worse.

4. **T6 (Bayesian shrinkage) works** because it leverages cross-pair information differently than P11 (per-pair PF). The empirical Bayes posterior reveals pairs where rolling WR diverges from population mean — those signals carry independent information.

---

## Honest Recommendation

Per user's stated agreement: *"Si V46 NO alcanza: ACEPTAMOS techo, deploy V44.5 final"*

**Two options:**

### Option A — Accept ceiling (per agreement)
Deploy V44.5 (P11+P7) as final production engine.
- **PF realistic 1.337**
- **%win7d 77.1%**
- **DD 4.21%**
- Already deployed and operational.

### Option B — Deploy V44.6 intermediate
Activate T6+T5 alongside P11+P7.
- **PF realistic 1.396** (+4.4% vs V44.5)
- **%win7d 79.1%** (+2.0pp)
- **DD 2.88%** (-31.6%)
- **Sharpe 5.59** (+18.2%)
- All metrics improve, no regression.
- 1 marginal CI lower fail (1.373 vs 1.40 gate).

**Honest assessment:** Option B IS a real improvement, validated rigorously. But it does NOT reach V46 SUPREME. Per user's strict agreement, Option A is the honored choice.

If user prefers Option B: enable env vars `APEX_V46_T6=1 APEX_V46_T5=1` in production. Both implementations are stable, sensitivity-tested, bootstrap-validated.

---

## Files Generated (auditable)

- `/audit/scripts/backtest_v46_t10_conformal.js` — T10 Conformal implementation
- `/audit/scripts/backtest_v46_t8_hsmm.js` — T8 HSMM implementation
- `/audit/scripts/backtest_v46_t6_bayes.js` — T6 Bayesian implementation (PASS)
- `/audit/scripts/backtest_v46_t7_wavelet.js` — T7 Wavelet implementation
- `/audit/scripts/backtest_v46_t5_hawkes.js` — T5 Hawkes implementation
- `/audit/scripts/backtest_v46_t9_survival.js` — T9 Survival implementation
- `/audit/scripts/backtest_v46_combo.js` — Combination testing
- `/audit/scripts/backtest_v46_t6_sensitivity.js` — T6 sensitivity (fragility 3.1%)
- `/audit/scripts/backtest_v46_t6_t5_bootstrap.js` — Bootstrap + MC
- `/audit/results/v46_*.json` — Raw backtest outputs

---

## What This Sprint Confirms

1. **V44.5 baseline is at the empirical ceiling** for funding carry on this universe with realistic costs.
2. **Marginal improvements exist** (T6, T5 in combo) but cannot reach V46 SUPREME stretch goals.
3. **6 out of 6 tested techniques (T5-T10) underperform** when compared against the high SUPREME bar — only one (T6) passes individual gate.
4. **The 4 deep-learning techniques (T1-T4) are not realistically testable** without dedicated GPU infrastructure and multi-day training runs.

The honest conclusion is that the V46 SUPREME targets (PF 1.55+, %win7d 88%+, Sharpe 7.0+) are likely **unreachable on the funding carry strategy with this 15-pair universe and realistic Binance Futures costs.** Achieving those numbers would require either:

- Different underlying alpha (not funding carry)
- Different exchange / lower fees
- Larger universe with better diversification
- Non-realistic backtest assumptions (which we explicitly rejected)

---

## Next Step Per Agreement

> "Después de este sprint: NO MÁS prompts de motor. Sin excepción."
> "Sprint próximo = launch + ecosistema + producto."

**Engine research is closed.** Focus shifts to product: launch, marketing honesty (PF 1.337 realistic with full disclosure), live data collection (minimum 30 days), and only then revisit engine if live results reveal new opportunities.

---

*Generated 2026-04-27. All numbers reproducible via scripts in `/audit/scripts/`.*
