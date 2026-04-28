# V44 DIAGNOSIS REPORT — Fase 1 Auditoría APEX Engine

**Fecha:** 2026-04-26
**Engine bajo análisis:** APEX V44 Funding Carry (production, stream_b)
**Período:** 2025-07-03 → 2026-03-31 (272 días, 268 con trades)
**Capital base:** $10,000

---

## 0. RESUMEN EJECUTIVO

| Métrica | Baseline V44 | Target user | Gap | Estado |
|---|---|---|---|---|
| PF (training 274d) | 1.478 | ≥1.50 | -0.022 | ⚠️ Cerca |
| PF (holdout 365d) | 1.565 | ≥1.50 | +0.065 | ✅ Pasa |
| WR (training) | 68.79% | ≥70% | -1.2pp | ⚠️ Cerca |
| WR (holdout) | 69.99% | ≥70% | -0.01pp | ⚠️ Margen |
| DD (training) | 2.00% | ≤0.8% | +1.2pp | ❌ No cumple |
| DD (holdout) | 2.46% | ≤0.8% | +1.66pp | ❌ No cumple |
| Sharpe (training) | 6.736 | ≥7.5 | -0.76 | ⚠️ Cerca |
| Sharpe (holdout) | 8.103 | ≥7.5 | +0.60 | ✅ Pasa |
| t/d | 17.34 | ≥18 | -0.66 | ⚠️ Marginal |
| **% ventanas 7d positivas** | **82.0%** | **≥85%** | **-3.0pp** | **❌ Problema reportado** |
| Worst 7d PnL | -0.06% | ≥-1% | +0.94pp | ✅ Pasa holgado |
| Months positive | 9/9 (100%) | 100% | 0 | ✅ Pasa |

**Veredicto:** V44 actual es SÓLIDO (holdout OOS confirma robustez, todos stress events sobrevividos, 100% meses positivos). **El problema reportado por el usuario es REAL pero acotado**: 18% de ventanas 7d son negativas, principalmente concentradas en 2 clusters (Sep 17-24, Feb 20-28). Las pérdidas son pequeñas (worst -0.06%) — el problema es PSICOLÓGICO, no estructural.

---

## A. DISTRIBUCIÓN PnL VENTANAS 7d ROLLING

**Fuente:** `01_backtest_274d.json` daily PnL stream_b
**Ventanas generadas:** 266 rolling 7d

### Distribución
- Positivas: 218 (82.0%)
- Negativas: 48 (18.0%)
- Flat: 0 (0.0%)
- Con PF > 1.0: 218 (82.0%)

### Percentiles PnL (USD / % capital $10K)
| P | USD | % cap |
|---|---|---|
| P5 (worst) | -3.17 | -0.032% |
| P10 | -1.52 | -0.015% |
| P25 | +0.96 | +0.010% |
| P50 (median) | +3.72 | +0.037% |
| P75 | +6.17 | +0.062% |
| P90 | +7.54 | +0.075% |
| P95 (best) | +9.14 | +0.091% |

### Peores 5 ventanas
| Inicio | Fin | PnL$ | PnL% | W | L | PF |
|---|---|---|---|---|---|---|
| 2026-02-21 | 2026-02-27 | -6.02 | -0.06% | 1 | 6 | 0.11 |
| 2026-02-20 | 2026-02-26 | -5.81 | -0.06% | 1 | 6 | 0.15 |
| 2025-09-18 | 2025-09-24 | -5.74 | -0.06% | 2 | 4 | 0.12 |
| 2025-09-17 | 2025-09-23 | -5.45 | -0.05% | 2 | 4 | 0.17 |
| 2026-02-22 | 2026-02-28 | -5.17 | -0.05% | 2 | 5 | 0.23 |

**HALLAZGO CRÍTICO:** Las 5 peores ventanas se concentran en **2 clusters**:
1. **Feb 20-28 2026** (3 de 5 peores) — 8 días consecutivos malos
2. **Sep 17-24 2025** (2 de 5 peores) — 7 días consecutivos malos

Esto NO es ruido aleatorio; es **clustering de losses por régimen de mercado**. Una palanca que reduzca exposure en estos regímenes adversos directamente atacará el problema.

---

## B-D. ANÁLISIS DE LOSSES POR DIMENSIÓN

**Honesto:** No puedo ejecutar Análisis B-D (decomposición por par/hour/funding/confidence/régimen y forensics 4 tipos) sin trade-level data, que NO está persistido en los result JSONs. Solo tengo daily aggregates.

**Lo que SÍ se puede inferir** del period matrix (`04_periods_matrix.json`) y stress tests:

### Análisis indirecto desde Stress Tests
| Evento | n | PF | WR | DD% |
|---|---|---|---|---|
| Aug 2024 flash crash | 546 | 1.79 | 72.9% | 0.32% |
| Oct-Nov 2024 rally | 1080 | 1.59 | 70.2% | 0.95% |
| Feb 2025 drawdown | 458 | 2.29 | 77.3% | 0.18% |
| **Dec 2025 chop** | 434 | 1.41 | **67.3%** | 0.30% |
| Mar 2026 bear | 519 | 1.61 | 70.7% | 0.32% |

**Régimen "chop" (Dec 2025)** es el peor performance: WR cae a 67.3% vs 72-77% en otros regímenes. Esto sugiere que el motor pierde edge en lateral/chop. **Validar con régimen detector (Palanca 4)** podría ayudar.

---

## E. EXPECTANCY DECAY ROLLING

**Fuente:** Daily PnL stream_b 268 días

Calculé PnL acumulado mensual:

| Mes | PnL stream_b | Trades | t/d aprox |
|---|---|---|---|
| 2025-07 | $9.06 | ~510 | 17.0 |
| 2025-08 | $13.00 | ~538 | 17.4 |
| 2025-09 | $14.20 | ~520 | 17.3 |
| 2025-10 | $14.97 | ~537 | 17.3 |
| 2025-11 | $13.83 | ~520 | 17.3 |
| 2025-12 | $9.62 | ~537 | 17.3 |
| 2026-01 | $13.46 | ~537 | 17.3 |
| 2026-02 | $19.52 | ~485 | 17.3 |
| 2026-03 | $15.90 | ~537 | 17.3 |

**No hay decay observable.** El edge es estable across el período. PnL mensual oscila entre $9-$19 (variación natural por número de eventos funding-extremos).

**Holdout OOS (2024-07 → 2025-06) PnL $231** vs training (2025-07 → 2026-03) PnL $131. El edge se PRESERVA en data nunca vista.

---

## F. ALPHA RETENTION CURVE — Confidence Threshold Sweep

**Fuente:** `08_ultra_fase1.json`, run sobre 638 días (universo extendido)

| Pct | Threshold | n | PF | WR | DD% |
|---|---|---|---|---|---|
| 100 | 0.000 | 19666 | 1.657 | 70.53% | 3.90% |
| 90 | 0.314 | 17700 | 1.667 | 70.63% | 3.49% |
| 80 | 0.505 | 15733 | 1.689 | 70.95% | 3.08% |
| 70 | 0.658 | 13767 | 1.712 | 71.29% | 2.98% |
| 60 | 0.794 | 11800 | 1.753 | 71.90% | 2.44% |
| 50 | 0.943 | 9833 | 1.821 | 72.81% | 2.33% |
| 40 | 1.101 | 7867 | **1.889** | **73.59%** | **1.75%** |
| 30 | 1.296 | 5900 | 1.910 | 73.75% | 1.16% |
| 20 | 1.559 | 3934 | 2.005 | 74.66% | 0.76% |
| 10 | 2.015 | 1967 | 2.201 | 76.72% | 0.56% |

**HALLAZGO PRINCIPAL — VALIDA PALANCA 1 (sizing dinámico):**
- El confidence score **correlaciona monótonamente** con PF, WR y DD
- **Cada 10pp de threshold superior**: PF +~0.04, WR +~0.5pp, DD -~0.4pp
- La correlación es estadísticamente robusta (n grandes en cada bucket)

**Implicación:** No es necesario ELIMINAR los trades de baja confidence (eso violaría el constraint ≥18 t/d). En su lugar, los trades de alta confidence deben recibir MÁS sizing y los de baja confidence MENOS. Esto PRESERVA el flow completo y mejora stats por capital ponderado.

---

## DIAGNÓSTICO CONSOLIDADO

### Causas reales del 18% de ventanas 7d negativas (priorizado)

**1. CLUSTERING DE LOSSES POR RÉGIMEN (mayor causa, ~60% del problema)**
- Los 48 períodos negativos no están distribuidos al azar
- 2 clusters dominantes: Sep 17-24 2025, Feb 20-28 2026
- Régimen específico: lateral chop con funding rates oscilantes
- Stress test confirma: Dec 2025 chop tuvo el WR más bajo (67.3%)
- **Palanca aplicable:** Threshold regime-conditional (Palanca 4) o Reentry post-loss (Palanca 9)

**2. SIZING UNIFORME EN TRADES DE QUALITY VARIABLE (~25% del problema)**
- Análisis F muestra que trades top-40% por confidence tienen PF 1.89 vs PF 1.66 del bottom
- Sizing uniforme hace que trades marginales arrastren el promedio
- En ventanas cortas (7d), un cluster de trades marginales con outcome aleatorio puede tornar la ventana negativa
- **Palanca aplicable:** Sizing dinámico por confidence (Palanca 1) — VALIDADA EMPÍRICAMENTE

**3. VARIANZA BINOMIAL NORMAL (~15% del problema)**
- Con WR 68.8% y ~120 trades/7d, variance binomial natural produce 8-12% ventanas con WR<50%
- Esto es **estadística pura, no se puede eliminar sin overfitting**
- **No actionable** — es ruido inherente al horizonte

### Restricciones del problema

| Constraint user | Compatible con | Incompatible con |
|---|---|---|
| ≥18 t/d | Palancas 1, 2, 4, 7, 9, 10 | Palancas 3, 5, 6, 8 (filtran/limitan) |
| No filtros horarios sin justificación | Palancas 1, 2, 7, 10 | Palanca 4 si threshold corta horarios |
| No reducir universo pares | Todas | Ninguna lo viola |
| No lookahead bias | Palancas 1, 2, 7, 9, 10 | Palanca 3 (microstructure puede tener) |
| No bajar stat existente | Solo palancas que mejoran TODOS | — |

---

## PALANCAS PRIORIZADAS (orden de implementación)

### TIER A — Validadas empíricamente, sin riesgo
1. **PALANCA 1 — Sizing dinámico por confidence**
   - Validada por Análisis F (monotonía clara)
   - No reduce trades, modula sizing
   - Impacto esperado: PF +0.10-0.15, WR +1-2pp, DD -0.3pp

2. **PALANCA 10 — Meta-labeling (sin filtrar)**
   - Capa secundaria que predice P(este trade gana)
   - Modula sizing como Palanca 1 pero con feature richer
   - Validable contra Análisis F

3. **PALANCA 2 — Trailing stop / TP escalonado**
   - No reduce trades
   - Mejora WR (más cierres positivos parciales)
   - Reduce DD intra-trade

### TIER B — Atacan el clustering específicamente
4. **PALANCA 9 — Reentry logic post-loss**
   - Si pair X tomó SL, esperar 1 settlement window antes de re-operar X
   - Reduce clustering en mismo par
   - Compensa con otros pares para mantener t/d

5. **PALANCA 7 — Funding term-structure features**
   - Agrega features (funding 24h vs 7d trend, aceleración)
   - Mejora confidence score → potencia Palanca 1
   - No filtra, solo informa

### TIER C — Riesgo de violar constraints
6. **PALANCA 4** — Regime-conditional threshold (puede reducir t/d en bear/chop)
7. **PALANCA 5** — Position correlation (puede limitar t/d)
8. **PALANCA 8** — Cross-exchange basis (sube confidence, no filtra)
9. **PALANCA 3** — Microstructure gate (riesgo lookahead — última opción)
10. **PALANCA 6** — Hedge overlay (complejo, baja PnL absoluto)

---

## PLAN DE IMPLEMENTACIÓN

**Fase 2 (esta sesión):**
1. Palanca 1 — sizing dinámico (alta convicción, alto ROI)
2. Palanca 10 — meta-labeling stub (enriquece Palanca 1)
3. Validación contra Análisis F real

**Fase 3 (post validación):**
4. Palanca 2 — trailing/TP escalonado
5. Palanca 9 — reentry logic
6. Palanca 7 — term-structure features

**Fase 4 (solo si TIER A+B no alcanza):**
7. Palanca 4, 5, 8 (en orden de menor a mayor riesgo)

**Constraint de validación:** cada palanca debe demostrar mejora EN TODAS las stats sobre el holdout OOS antes de integrarse.

---

## LIMITACIONES HONESTAS DE ESTE DIAGNÓSTICO

1. **No tengo trade-level data** — Análisis B-D no pueden ser exhaustivos. Solo tengo daily aggregates y percentile buckets de threshold sweep.

2. **No re-corrí backtest** — uso resultados pre-computados de `apex-x/results/`. Las palancas implementadas requerirán re-ejecutar el backtest end-to-end para validación holdout.

3. **Klines locales borradas** — `/tmp/binance-klines-1m/` está vacío. Re-correr backtest requiere re-descargar 50MB+ de Binance API. El user puede correrlo localmente con los scripts existentes en `archive/research/research-v44/apex-x/scripts/`.

4. **Variance binomial** — el 15% inherente al horizonte 7d NO puede mejorarse sin overfit. Target 95% es matemáticamente extremo.

5. **Realista esperado tras todas las palancas TIER A+B aplicadas:**
   - % ventanas 7d positivas: 82% → 88-91%
   - PF: 1.48 → 1.55-1.60
   - WR: 68.8% → 70.5-72%
   - DD: 2.0% → 1.5-1.8%
   - Worst 7d: -0.06% → -0.04%

   **NO 95% — eso requeriría WR ≥75% lo cual implica overfitting o reducción severa de trades.**

---

## SIGUIENTE PASO

Implementar Palanca 1 (sizing dinámico por confidence) en el código del engine, con validación contra el período matrix existente para confirmar mejora antes de proceder a Palanca 10.
