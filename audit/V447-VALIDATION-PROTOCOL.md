# V44.7 LIVE VALIDATION PROTOCOL

**Date:** 2026-05-07
**Engine version under validation:** `apex-v44.7-funding-carry-real-1.0` (and `…-bayes-hawkes-1.0` when V46 flags active)
**Pre-V44.7 status:** V44.5/V44.6 ran with EMA-based funding *proxy*. Live performance degraded to ~coin-flip (PF ≈ 1.05, WR ≈ 48% over ~750 closed trades / 42 days). Backtest claim of PF 1.40 was based on the same proxy and never replicated.
**V44.7 fix:** real Binance perpetual `premium index` is now the funding signal. Engine logic is otherwise unchanged.
**Today's live data on V44.7:** ~3 days. Statistically meaningless. **Do not draw conclusions before the protocol below is complete.**

---

## 1. What "validated" means

A live engine is **GREEN** (validated) only when *all four* gates hold simultaneously:

| Gate | Threshold | Why |
|---|---|---|
| Decisive trades | ≥ 200 (W+L only, NO_HIT excluded) | Below this, CIs are too wide to distinguish edge from noise |
| WR Wilson 95% lower bound | > 52% | Stat-sig edge over 50% baseline |
| PF bootstrap 95% lower CI | ≥ 1.20 | Realistic floor; matches the post-fee target after slippage |
| Funding source consistency | `funding_source = "premium_index_real"` ≥ 99% of signals | Confirms the V44.5/V44.6 EMA-proxy bug stays fixed |

Time to reach 200 decisive trades depends on signal cadence. With current settings (~18 t/d on 15 pairs, of which a fraction will be decisive in the 4h hold window) **expected wall-clock to gate is 14–30 days.**

---

## 2. Tools available

### 2.1 CLI: `backend/scripts/health-check-v447.js`

```bash
DATABASE_URL=postgres://… node backend/scripts/health-check-v447.js --days=30
DATABASE_URL=postgres://… node backend/scripts/health-check-v447.js --days=14 --json | jq .verdict
```

- `--days=N` window (default 30)
- `--json` machine-readable output
- Exit codes: `0=GREEN` `1=YELLOW` `2=RED` `3=ERROR` — designed for cron / CI

Recommended cron (Render scheduled job or GitHub Actions, daily at 14:00 UTC):

```
0 14 * * *  cd /opt/render/project/src && node backend/scripts/health-check-v447.js --days=30 --json > /tmp/v447-health.json && node backend/scripts/notify-on-red.js < /tmp/v447-health.json
```

(Alert hookup is up to you — Slack/Telegram/email. Exit code 2 = page on-call.)

### 2.2 Admin endpoint: `GET /api/admin/health-v447`

Same payload as the script (single source of truth — both consume `backend/health-v447.js`).

```
GET /api/admin/health-v447?days=30
Header: x-admin-secret: <ADMIN_SECRET>
```

Use this from the admin dashboard or an ops bookmark. Response example shape:

```json
{
  "engine_filter": "apex-v44.7%",
  "window_days": 30,
  "sample": { "total_with_outcome": 412, "wins": 218, "losses": 184, "no_hits": 10, "decisive": 402, "sufficient": true },
  "funding_source": { "real": 412, "proxy": 0, "unknown": 0 },
  "metrics": {
    "wr_pct": 54.23, "wr_wilson_lower95_pct": 52.41, "wr_p_value_vs_50": 0.0073,
    "pf": 1.31, "pf_ci95_lower": 1.18, "pf_ci95_upper": 1.46,
    "trades_per_day": 9.6, "max_consec_losses": 5
  },
  "verdict": { "status": "YELLOW", "reason": "PF lower=1.18, WR lower=52.41% — borderline" }
}
```

### 2.3 Per-trade structured log (`signal-cron.js`)

Every closed signal now emits a line of the form:

```
[SignalCron][TRADE] sig=… sym=BTCUSDT dir=BUY entry=… exit=… tp=… sl=… outcome=WIN reason=TP_HIT holdMin=… pnlBps=… engine=apex-v44.7-funding-carry-real-1.0 fundingSrc=premium_index_real fundingZ=2.150 window=PRE_FUND conf=…
```

Forward Render logs to your log shipper of choice (Datadog, Logtail, Better Stack, Loki). With this you can compute live PF/WR without DB access and graph rolling windows.

---

## 3. Daily checklist (manual, ~5 min/day)

Run for the next 14–30 days, every day, 14:00 UTC:

1. `GET /api/admin/health-v447?days=30` (or run the script)
2. Record in spreadsheet/notion:
   - `decisive` count
   - `funding_source.real` / total (must be ~100%; if `proxy_ema` > 0 → bug is back, page on-call)
   - `wr_wilson_lower95_pct`
   - `pf_ci95_lower`
   - `verdict.status`
3. If verdict is **RED** for 2 consecutive days **or** `funding_source.proxy` > 0 → halt autotrade for affected users, investigate before resuming.
4. If verdict is **GREEN** with `decisive ≥ 200` for 3 consecutive days → engine validated, proceed to remove "in validation" disclaimers from marketing.

---

## 4. Failure modes and responses

| Symptom | Likely cause | Action |
|---|---|---|
| `funding_source.proxy > 0` while `engine LIKE 'apex-v44.7%'` | Code regression — proxy fallback re-enabled | Revert to last known-good `signal-generator.js`/`v44-engine.js`. Re-deploy. |
| `decisive` stuck < 50 after 7 days | Filter too restrictive OR data feed problem | Inspect `[SignalGen] skips: …` aggregate logs; verify Binance API status. |
| `wr ≈ 50%` AND `funding_source.real = 100%` | The strategy itself is the issue, not implementation | Mean-revert vs trend regime: check `funding_zscore` distribution per outcome. Consider param sweep on `F_POS_MIN_REAL` / `F_NEG_MAX_REAL`. |
| `pf > 1.20` but `decisive < 200` | Insufficient sample, looks good but not statistically conclusive | Keep observing. Do not announce success. |
| `max_consec_losses` ≥ 8 | Cluster losing streak (regime change) | Review losing trades: same window? Same direction? Same pair? |

---

## 5. What we will *not* do during validation

- **No new marketing claims** about PF, WR, Sharpe based on V44.5/V44.6 backtests.
- **No autotrade promotion** to new users until GREEN.
- **No silent parameter tweaks** during the validation window — that contaminates the sample.
- **No selection of "best 14d window"** in retrospect. The metric is the rolling 30-day window starting from V44.7 deploy, full stop.

---

## 6. Sample-size math (for reference)

Detecting a true WR of 55% (vs 50% null) at α=0.05 power 0.80 needs ~330 trades.
Detecting 53% needs ~960. Detecting 60% needs ~80.

We use **N≥200** as the gate because:
- It rules out the most obvious noise scenarios.
- At N=200, Wilson 95% lower bound on observed WR=55% is ~48% — still borderline. So gate also requires `wrLower95 > 52%`, which forces *true* WR to be comfortably above 50%.
- Bootstrap PF 95% lower CI ≥ 1.20 with N=200 typically requires observed PF ≥ 1.30, which is the realistic post-fee target.

---

## 7. Decision tree at end of validation

```
After ≥ 30 days OR ≥ 200 decisive trades, whichever comes later:

  decisive ≥ 200 AND verdict = GREEN
  └─ Engine validated. Update marketing with V44.7 live numbers (with CI). Resume normal promotion.

  decisive ≥ 200 AND verdict = YELLOW for ≥ 7 consecutive days
  └─ Edge marginal. Decide: continue cautious operation (no growth), or switch off autotrade and pivot to signals-only product.

  decisive ≥ 200 AND verdict = RED
  └─ Engine has no edge in current regime. Switch off autotrade for users. Refund/credit per damage-control playbook. Engineering effort moves to engine R&D before any further promotion.

  decisive < 200 after 30 days
  └─ Signal cadence too low. Either lower thresholds (param sweep) or accept the engine produces too few trades for retail product. Decide before extending validation.
```

---

## 8. Files touched by this protocol

```
backend/health-v447.js                    # shared stats module (CLI + endpoint use this)
backend/scripts/health-check-v447.js      # CLI wrapper, exit-coded
backend/server.js                         # GET /api/admin/health-v447
backend/signal-cron.js                    # per-trade [TRADE] structured log
audit/V447-VALIDATION-PROTOCOL.md         # this document
```

Nothing about the engine logic itself was changed by this protocol — only observability + go/no-go criteria. The engine is what it is; this document is so we can tell honestly whether it works.
