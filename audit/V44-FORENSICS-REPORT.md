# V44 BASELINE FORENSICS REPORT
**Período:** Holdout 2024-07-01 → 2025-06-30
**Total trades:** 6984
**Source:** Real backtest re-run with full trade-level instrumentation

## B.1 — Performance por par (sorted worst→best PF)

| Pair | Trades | WR% | PF | PnL$ | Avg$ |
|------|--------|-----|------|------|------|
| TRXUSDT | 470 | 50.2 | 0.636 | -19.09 | -0.041 |
| BTCUSDT | 455 | 54.3 | 0.752 | -9.86 | -0.022 |
| ETHUSDT | 456 | 62.5 | 1.047 | 1.54 | 0.003 |
| ADAUSDT | 480 | 65.4 | 1.189 | 5.51 | 0.011 |
| XRPUSDT | 467 | 68.7 | 1.391 | 10.90 | 0.023 |
| ATOMUSDT | 492 | 69.9 | 1.461 | 13.94 | 0.028 |
| SOLUSDT | 460 | 70.0 | 1.466 | 14.25 | 0.031 |
| LINKUSDT | 461 | 72.0 | 1.618 | 16.71 | 0.036 |
| POLUSDT | 462 | 72.3 | 1.642 | 17.67 | 0.038 |
| ARBUSDT | 466 | 72.3 | 1.642 | 15.50 | 0.033 |
| NEARUSDT | 470 | 74.9 | 1.871 | 23.90 | 0.051 |
| INJUSDT | 452 | 77.2 | 2.129 | 28.00 | 0.062 |
| SUIUSDT | 483 | 77.6 | 2.177 | 29.23 | 0.061 |
| RENDERUSDT | 435 | 78.4 | 2.275 | 21.74 | 0.050 |
| 1000PEPEUSDT | 475 | 82.3 | 2.923 | 31.76 | 0.067 |

## B.2 — Performance por hora UTC

| Hour | Trades | WR% | PF | PnL$ |
|------|--------|-----|------|------|
| 0 | 2445 | 70.0 | 1.476 | 71.67 |
| 8 | 2234 | 65.8 | 1.218 | 34.30 |
| 16 | 2305 | 73.7 | 1.770 | 95.72 |

## B.3 — Performance por dirección

| Direction | Trades | WR% | PF | PnL$ |
|-----------|--------|-----|------|------|
| BUY | 3560 | 71.6 | 1.592 | 123.02 |
| SELL | 3424 | 68.1 | 1.351 | 78.67 |

## B.4 — Performance por settlement window

| Window | Trades | WR% | PF | PnL$ |
|--------|--------|-----|------|------|
| 00UTC | 2445 | 70.0 | 1.476 | 71.67 |
| 08UTC | 2234 | 65.8 | 1.218 | 34.30 |
| 16UTC | 2305 | 73.7 | 1.770 | 95.72 |

## B.5 — Alpha retention curve por z-score bucket

| Bucket | Trades | WR% | PF | PnL$ | Avg$ |
|--------|--------|-----|------|------|------|
| 0_0-1 | 1049 | 70.3 | 1.493 | 31.50 | 0.030 |
| 1_1-1.5 | 2587 | 70.6 | 1.510 | 79.88 | 0.031 |
| 2_1.5-2 | 1678 | 69.0 | 1.420 | 44.67 | 0.027 |
| 3_2-2.5 | 880 | 70.1 | 1.485 | 26.19 | 0.030 |
| 4_2.5-3 | 406 | 66.5 | 1.273 | 7.55 | 0.019 |
| 5_3+ | 384 | 70.8 | 1.516 | 11.91 | 0.031 |

## C — Cluster de losses simultáneos

Distribución de # de pairs perdiendo en el mismo día:

| Pairs perdiendo | # días |
|----------------|--------|
| 1 | 59 |
| 2 | 41 |
| 3 | 31 |
| 4 | 32 |
| 5 | 24 |
| 6 | 30 |
| 7 | 11 |
| 8 | 25 |
| 9 | 11 |
| 10 | 10 |
| 11 | 17 |
| 12 | 5 |
| 13 | 8 |
| 14 | 7 |
| 15 | 5 |

## D — Tipos de loss (forensic classification)

| Tipo | Count | % |
|------|-------|---|
| T1_BadEntry | 1969 | 93.6% |
| T2_RevertedFromFav | 72 | 3.4% |
| T3_FlatNegative | 17 | 0.8% |
| T4_Whipsaw | 46 | 2.2% |

## INSIGHTS ACTIONABLES

- **TRXUSDT es el peor par** con PF 0.64 y WR 50.2%. Considerar Palanca 5 (correlation cluster) o exclusion específica.
- **1000PEPEUSDT domina el PnL** con PF 2.92. Sizing dinámico (Palanca 1) ya capitaliza esto.
- **Asimetría direccional**: BUY PF 1.59 vs SELL PF 1.35. Dirección dominante: BUY.
- **Cluster days detectados**: 5p×24d, 6p×30d, 7p×11d, 8p×25d, 9p×11d, 10p×10d, 11p×17d, 12p×5d, 13p×8d, 14p×7d, 15p×5d. Justifica Palanca 5 (correlation management).
