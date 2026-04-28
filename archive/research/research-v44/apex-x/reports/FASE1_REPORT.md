# APEX X — FASE 1 Report (Backtest 274d)

**Date:** 2026-04-22
**Configuration:** v42 PRO+ directional (Stream A) + V44 Funding Carry (Stream B) with hedge-aware filter
**Universe:** 15 pairs (TOP_15 matching v42 PRO+ deployed config)
**Data:** 2025-07-01 → 2026-03-31 (273 days, 1h bars)
**Params:** ALL FROZEN (v42 PRO+ deployed + V44 funding validated)

---

## RESULTS

|                 | Stream A (direccional) | Stream B (funding) | Combined |
|-----------------|----------------------:|-------------------:|---------:|
| Trades          | 771                   | 4,735              | 5,506    |
| PF              | 1.30                  | 1.48               | 1.30     |
| WR              | 48.0%                 | 68.8%              | 65.9%    |
| Sharpe          | 3.15                  | 6.74               | 2.21     |
| DD              | 24.4%                 | 2.0%               | 25.5%    |
| PnL (273d)      | $10,487               | $131               | $10,618  |
| Trades/day      | 2.82                  | 17.34              | 20.17    |
| PnL contribution| 98.8%                 | 1.2%               | 100%     |

## Validation vs V44 research baseline

- **Stream A** (771t / PF 1.30 / DD 24.4%) reproduces **exactly** the v42 PRO+ deployed metrics (771t / PF 1.30 / DD 24%). ✓
- **Stream B** (4735t / PF 1.48 / WR 68.8%) closely reproduces V44 funding carry standalone (4827t / PF 1.41 / WR 67.9%). Hedge filter dropped 111 trades (2.3%). ✓

## FASE 1 Gates

| Gate | Target | Actual | Status |
|------|--------|--------|--------|
| PF ≥ v42 PRO+ + 0.05 | ≥ 1.35 | **1.30** | ❌ FAIL |
| DD ≤ v42 PRO+ | ≤ 24% | 25.5% | ❌ FAIL (marginal) |
| Rolling corr < 0.4 in 90% of windows | ≥ 90% | **97.5%** | ✅ PASS |
| Funding contributes ≥ 10% of PnL | ≥ 10% | **1.2%** | ❌ FAIL |

**1/4 gates passed.**

---

## CRITICAL FINDING — Stream B contribution too small

The fundamental issue: **V44 frozen sizing ($50/trade on $500 cap) makes Stream B ~80x smaller than Stream A**. Even though Funding Carry has excellent risk-adjusted metrics (PF 1.48, Sharpe 6.74, DD 2.0%), its absolute dollar PnL ($131 vs Stream A's $10,487) is essentially noise in the composite portfolio.

### Evidence:
- Stream B contributes only **1.2%** of total PnL (target ≥ 10%)
- Combined PF (1.30) = Stream A PF because Stream B's $131 can't move the needle against $10,487
- Combined DD (25.5%) = Stream A DD + small additional Stream B DD during A's drawdown periods
- Orthogonality IS confirmed (97.5% of rolling windows below 0.4 correlation) — the streams ARE independent, but one dominates

### Why orthogonality doesn't help here:

Diversification reduces portfolio DD when streams have **comparable magnitudes**. Here Stream B is 80x smaller, so:
- When Stream A loses, Stream B's small wins don't offset
- When Stream A wins, Stream B's small losses don't hurt materially
- Net effect: Stream B is a rounding error

---

## MONTHLY SEGMENTATION (V44 combined)

| Month | Trades | PF | WR | PnL |
|-------|--------|-----|-----|------|
| 2025-07 | 470 | 1.32 | 66.6% | +$9 |
| 2025-08 | 616 | 1.35 | 66.7% | +$13 |
| 2025-09 | 523 | 1.39 | 67.1% | +$12 |
| 2025-10 | 553 | 1.56 | 70.0% | +$17 |
| 2025-11 | 749 | 1.42 | 69.4% | **+$3,997** |
| 2025-12 | 645 | 1.03 | 61.2% | +$183 |
| 2026-01 | 685 | 1.50 | 62.9% | **+$2,679** |
| 2026-02 | 644 | 1.43 | 62.1% | **+$3,009** |
| 2026-03 | 621 | 1.11 | 67.5% | +$698 |

9/9 months positive. But PnL is concentrated in 3 big months (Nov/Jan/Feb) which accounted for $9,685 of $10,618 total (91%).

---

## OPTIONS FOR USER DECISION

### Option A — DO NOT DEPLOY APEX X as designed
Per user spec: "Si falla ≥1 gate → mantener v42 PRO+ solo, Funding Carry queda como módulo research disponible".
- APEX X fails 3/4 gates under strict interpretation
- The composition adds complexity without meaningful benefit
- **v42 PRO+ remains default, Funding Carry documented as standalone research**

### Option B — Continue FASE 2 (holdout) anyway, see if pattern holds
- User protocol: do holdout validation
- Expected outcome: Stream A will fail holdout catastrophically (per V44 research TEST 1: PF 1.00 in holdout)
- Stream B will likely pass holdout (PF 1.47 V44 validated)
- Combined will again be dominated by Stream A's failure
- Likely result: still fails, confirms Option A

### Option C — Relax user's interpretation of "frozen V44 params"
If "Sizing fijo: 20% del capital disponible total" is interpreted as "$100/trade on total $500 cap" (vs V44's $50/trade):
- Stream B gets 2x size → contributes ~2.4% of PnL (still too small)
- Would need ~10x V44 size to reach 10% contribution
- This is RE-TUNING, violates user's explicit "NO re-tunear" rule

### Option D — Scale Stream A DOWN to 20%, Stream B UP to 80%
Invert the ratio so funding carry becomes main stream:
- Stream A position size × 0.25 → smaller contribution
- Stream B size × 4 → $200/trade → ~10-15% contribution
- Violates "80/20 split" spec AND alters V44 frozen params

---

## RECOMMENDATION

**Report Option A to user**: APEX X with frozen V44 params does NOT meet gates. The mathematical reality is that V44's funding carry per-trade size ($50) is too small to meaningfully diversify v42 PRO+'s much larger position sizes ($2000-$3750).

Waiting for user's decision before proceeding to FASE 2 holdout validation.

---

## STATS ARCHIVE

```json
{
  "stream_a": {
    "trades": 771, "pf": 1.30, "wr": 48.0, "sharpe": 3.15,
    "dd_pct": 24.4, "pnl": 10487, "tpd": 2.82,
    "matches_v42_proplus_baseline": true
  },
  "stream_b": {
    "trades": 4735, "pf": 1.48, "wr": 68.8, "sharpe": 6.74,
    "dd_pct": 2.0, "pnl": 131, "tpd": 17.34,
    "matches_v44_funding_validated": true
  },
  "combined": {
    "trades": 5506, "pf": 1.30, "wr": 65.9, "sharpe": 2.21,
    "dd_pct": 25.5, "pnl": 10618, "tpd": 20.17
  },
  "rolling_correlation_30d": {
    "mean": 0.004, "min": -0.410, "max": 0.579,
    "windows_below_0.4": "97.5%"
  },
  "gates_passed": "1/4",
  "verdict": "APEX X fails to improve over v42 PRO+ standalone with frozen params"
}
```
