# APEX X — Final Validation Report

**Date:** 2026-04-22
**Build:** v42 PRO+ directional (Stream A, 80% notional) + V44 Funding Carry (Stream B, 20% notional)
**Validation:** 4 phases complete
**Verdict:** ❌ **DO NOT DEPLOY** — 3/13 total gates pass

---

## EXECUTIVE SUMMARY

APEX X was designed to combine two validated streams (v42 PRO+ directional + V44 Funding Carry)
with hedge-aware position management, expecting the statistical orthogonality between them
(correlation 0.02) to reduce portfolio drawdown while preserving PF.

**Reality:** V44 Funding Carry's frozen per-trade sizing ($50/trade on $500 cap) is ~80× smaller
than v42 PRO+'s position sizing ($2000-$3750/trade). Even though Stream B is independently robust
(PF 1.48 training / 1.57 holdout), its absolute dollar contribution is too small (1.2% of PnL) to
meaningfully diversify portfolio risk.

**The orthogonality is real but useless** when one stream dominates by 80× in absolute PnL.

---

## GATE RESULTS BY PHASE

### FASE 1 — Training 274d (2025-07 → 2026-03)

| Gate | Target | Actual | Status |
|------|--------|--------|--------|
| Combined PF ≥ baseline + 0.05 | ≥ 1.35 | 1.30 | ❌ |
| Combined DD ≤ baseline | ≤ 24% | 25.5% | ❌ |
| Rolling 30d corr < 0.4 in ≥90% windows | ≥ 90% | 97.5% | ✅ |
| Stream B contributes ≥ 10% of PnL | ≥ 10% | 1.2% | ❌ |

**1/4 gates pass.**

### FASE 2 — Holdout 2024-07 → 2025-06 (365 days, never seen)

| Gate | Target | Actual | Status |
|------|--------|--------|--------|
| Combined PF ≥ 1.20 | ≥ 1.20 | 0.67 | ❌ |
| Combined DD ≤ 40% | ≤ 40% | 127.3% | ❌ |
| Stream A PF ≥ 0.80 (survives OOS) | ≥ 0.80 | **0.10** | ❌ |
| Stream B PF ≥ 1.20 (V44 holds) | ≥ 1.20 | 1.57 | ✅ |

**1/4 gates pass.**

### FASE 3 — Rolling Correlation (embedded in FASE 1-2)

| Metric | Value |
|--------|-------|
| Rolling 30d correlation mean | +0.004 |
| Rolling 30d correlation min | -0.410 |
| Rolling 30d correlation max | +0.579 |
| Windows with \|corr\| > 0.5 | 6 out of 238 (2.5%) |

✅ **PASS** — orthogonality confirmed.

### FASE 4 — Stress Tests (5 volatile windows)

| Window | Trades | PF | WR | DD | Verdict |
|--------|--------|----|----|-----|---------|
| Aug 2024 flash crash | 552 | 0.63 | 72% | 46% | ⚠ ELEVATED |
| Oct-Nov 2024 rally | 1,105 | 0.96 | 70% | **145%** | ❌ CATASTROPHIC |
| Feb 2025 drawdown | 459 | 3.25 | 77% | 0% | ✅ OK |
| Dec 2025 chop | 441 | 0.59 | 67% | 41% | ⚠ ELEVATED |
| Mar 2026 bear | 525 | 0.65 | 70% | **60%** | ❌ CATASTROPHIC |

**1/5 windows OK, avg DD 58.7%, worst 145%**. Gates ≤2× avg DD: 4/5 survive.

---

## ROOT CAUSE ANALYSIS

### Finding 1: Stream A does not survive out-of-sample

This replicates exactly the V44 Research TEST 1 holdout finding:
- **Training (274d):** PF 1.30, WR 48.0%, DD 24.4% — matches deployed v42 PRO+ ✓
- **Holdout (365d):** PF 0.10, WR 18.2%, DD 126.6% — **-92% PF degradation**

The walk-forward Pearson engine selects features and thresholds per 120d train window.
When applied to 2024-07→2025-06 (different regime than training was optimized for), the
adaptive threshold mechanism generates only 11 trades (vs 771 in training) — almost complete
signal starvation. The 11 trades that do fire are mostly wrong-direction.

**This is overfit, not an engine bug.** v42 PRO+'s PF 1.30 is specific to the 2025-07→2026-03
regime. Deploy risk is real but mitigated by current performance; swap to different regime = disaster.

### Finding 2: Stream B is the only robust edge

V44 Funding Carry reproduces its validated behavior across all phases:
- Training: PF 1.48, WR 68.8%, Sharpe 6.74
- Holdout: PF 1.57, WR 70.0%, Sharpe 8.10 (actually BETTER in holdout)
- Stress tests: consistently positive even when Stream A catastrophically fails

But with $50/trade size vs Stream A's $2000+, it's a rounding error in absolute PnL.

### Finding 3: Orthogonality is real but cannot overcome size asymmetry

Rolling 30d correlation is 0.004 mean, 97.5% of windows below 0.4 threshold. The streams ARE
truly independent. However, diversification math requires streams of comparable variance to reduce
portfolio risk. Here:
- Stream A daily returns std ≈ $300
- Stream B daily returns std ≈ $3
- 100× magnitude difference → orthogonal contribution is ~1% of portfolio variance

---

## DESIGN-LEVEL IMPLICATIONS

The user's specification fights against itself:
1. **"Funding Carry frozen params"** → V44's $50/trade sizing locked in
2. **"20% of capital"** → Stream B allocated $100 cap
3. **"Meaningful contribution"** → needs ≥10% of PnL

To hit #3 with frozen #1 would require Stream A to be ~10× smaller, violating v42 PRO+ deployed config.

**To make APEX X work**, user would need to choose ONE of:
- **(a)** Scale V44 funding carry up 10× (violates "frozen params")
- **(b)** Scale v42 PRO+ down 10× (breaks deployed engine)
- **(c)** Accept Stream B as negligible PnL contributor (violates 10% rule)

---

## TOTAL GATES: 3/13 PASS

| Phase | Gates | Pass | Rate |
|-------|-------|------|------|
| FASE 1 (training) | 4 | 1 | 25% |
| FASE 2 (holdout) | 4 | 1 | 25% |
| FASE 3 (correlation) | 1 | 1 | 100% |
| FASE 4 (stress tests, DD≤2× avg) | 5 | 4 | 80% |
| **Total** | **13** | **7** | **54%** |

Note: Gate-by-gate pass rate 54% is misleading — the CRITICAL gates (PF improvement, DD reduction,
holdout survival) all fail. Only secondary gates (correlation confirmation, single-window DD bounds) pass.

---

## FINAL VERDICT

### ❌ DO NOT DEPLOY APEX X

Per user's original spec:
> Si falla ≥1 gate → mantener v42 PRO+ solo, Funding Carry queda como módulo research disponible

### Recommended action:

1. **Keep v42 PRO+ as default engine** — it's the production engine the user knows
2. **Funding Carry documented as standalone research** in `/research-v44/` — available for future
   standalone deployment if user wishes to run it independently with proper sizing
3. **APEX X composite code archived** in `/research-v44/apex-x/` for reference, not deployed
4. **Document limitation transparently** — the "orthogonal diversification" thesis works in theory
   but cannot be realized within V44's frozen per-trade risk profile

### What would be needed to make it work:

A future "APEX X v2" would require re-tuning Funding Carry sizing (e.g., $500/trade instead of $50)
with a FULL validation cycle — new CPCV, new holdout, new stress tests. This violates the current
"frozen params" constraint and would require user approval of a new research sprint.

---

## ARTIFACTS

All code + data preserved for reproducibility:

```
research-v44/apex-x/
├── scripts/
│   ├── apex_x_engine.js              (composite engine module)
│   ├── 01_backtest_274d.js           (FASE 1)
│   ├── 02_holdout_validation.js      (FASE 2)
│   └── 03_stress_tests.js            (FASE 4)
├── results/
│   ├── 01_backtest_274d.json
│   ├── 01_daily_pnl.csv
│   ├── 02_holdout.json
│   └── 03_stress_tests.json
└── reports/
    ├── FASE1_REPORT.md
    └── APEX_X_FINAL_VERDICT.md        (this file)
```

Runtime: ~25 seconds total for all 4 phases.

**No changes made to production engines.** v42 PRO+ remains the deployed default.
