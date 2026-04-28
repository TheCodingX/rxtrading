# ANÁLISIS A — Distribución 7d rolling

```
======================================================================
ANÁLISIS A — Distribución de PnL en ventanas 7d rolling
======================================================================

Fuente: V44 stream_b funding carry (production engine)
Período: 2025-07-03 → 2026-03-31
Capital base: $10,000

Total ventanas 7d generadas: 266

--- DISTRIBUCIÓN PnL ---
Ventanas con PnL > 0:    218 (82.0%)
Ventanas con PnL < 0:    48 (18.0%)
Ventanas con PnL = 0:    0 (0.0%)
Ventanas con PF > 1.0:   218 (82.0%)

--- PERCENTILES PnL (USD) ---
P5 (worst 5%):    $-3.17
P10:              $-1.52
P25:              $0.96
P50 (median):     $3.72
P75:              $6.17
P90:              $7.54
P95 (best 5%):    $9.14

--- PERCENTILES PnL (% capital) ---
P5:    -0.032%
P10:   -0.015%
P25:   0.010%
P50:   0.037%
P75:   0.062%
P90:   0.075%
P95:   0.091%

--- PERCENTILES PF ---
P5 PF:     0.335
P25 PF:    1.273
P50 PF:    2.959
P75 PF:    6.912
P95 PF:    44.697

--- PEORES 5 VENTANAS 7d ---
  2026-02-21 → 2026-02-27: PnL $-6.02 (-0.06%) | wins=1 losses=6 PF=0.11
  2026-02-20 → 2026-02-26: PnL $-5.81 (-0.06%) | wins=1 losses=6 PF=0.15
  2025-09-18 → 2025-09-24: PnL $-5.74 (-0.06%) | wins=2 losses=4 PF=0.12
  2025-09-17 → 2025-09-23: PnL $-5.45 (-0.05%) | wins=2 losses=4 PF=0.17
  2026-02-22 → 2026-02-28: PnL $-5.17 (-0.05%) | wins=2 losses=5 PF=0.23

--- MEJORES 5 VENTANAS 7d ---
  2025-10-08 → 2025-10-14: PnL $+14.21 (+0.14%) | wins=7 losses=0 PF=999.00
  2025-10-09 → 2025-10-15: PnL $+13.35 (+0.13%) | wins=7 losses=0 PF=999.00
  2025-11-20 → 2025-11-26: PnL $+12.97 (+0.13%) | wins=6 losses=1 PF=57.22
  2025-11-19 → 2025-11-25: PnL $+12.00 (+0.12%) | wins=6 losses=1 PF=53.02
  2025-10-07 → 2025-10-13: PnL $+11.88 (+0.12%) | wins=6 losses=1 PF=26.32

======================================================================
CONCLUSIÓN ANÁLISIS A
======================================================================

Target user: 85% mínimo, 95% ideal de ventanas 7d positivas
Actual V44: 82.0% positivas
Gap a target 85%: +3.0pp
Gap a target 95%: +13.0pp

❌ V44 NO cumple 85%. Gap de 3.0pp requiere intervención.
✅ Worst 7d (-0.06%) cumple target -1%
```
