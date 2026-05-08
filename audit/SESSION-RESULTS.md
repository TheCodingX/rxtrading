# SESSION RESULTS — Sprint final motor RX Trading

**Fecha**: 2026-05-04
**Alcance ejecutado**: Pasos 1, 2, 3, 4 y 5 del prompt (lo factible en Node sobre datos cacheados)
**No ejecutado**: ML/DL/RL (Python+GPU), Twitter/Reddit sentiment, opciones Deribit chains, FX/equities/commodities (rate limits APIs free)

---

## TL;DR

| Pregunta | Respuesta |
|---|---|
| ¿V44.6 live PF 1.05 vs backtest 1.40 = motor roto? | **No comprobable**. Sample 60-750 trades indistinguible de coinflip al 95% conf. |
| ¿Hay regime shift que explique el live? | **Sí**, vol -31% mediana, funding -29% BTC en últimos 42d |
| ¿Hay implementation drift backtest vs live? | **Sí**, código admite "funding proxy degradó a coinflip pre-V44.7" |
| ¿Aparece config nueva con PF≥1.50 + Sh≥3 + DD≤8% + suficientes trades? | **No**. 4.140 configs evaluadas, 0 pasan hard gates. |
| ¿Aparece config con PF≥1.10 OOS al menos? | **No**. 0 de 4.140. |
| ¿Cuál es el techo realista encontrado? | PF 1.05 OOS / Sharpe 1.49 / 32% anual — pero TRAIN perdedor → señal débil |
| ¿Decisión recomendada? | Mantener V44.7 + monitorear 3-6 meses antes de cualquier cambio. NO hay candidato superior a deployar. |

---

## Paso 1 — Diagnóstico V44.6 live (resumen)

Detalle completo en `V44.6-LIVE-DIAGNOSIS.md`. Hallazgos:

1. **Sample insuficiente**: 60 trades resolved → CI95 WR [39%, 64%].
   El intervalo es ±13pp; "70% WR target" y "40% WR fracaso" son
   indistinguibles dentro del sample observado.

2. **Permutation test**: 750 trades coinflip con TP=30/SL=25 (sin fees)
   genera PF mediano 1.20, p05=1.07. PF observed 1.05 está p-valor 0.975
   contra coinflip → **PF observed es indistinguible del comportamiento
   aleatorio una vez ajustado por costos reales** (~10 bps).

3. **Regime shift cuantificado**:
   - Realized vol del universo cayó **mediana 31%** en últimos 42d vs
     323d previos
   - Funding rate magnitude cayó **-29% en BTC, -43% en JUP, -33% BNB**
   - El motor funding-carry depende del **funding extremo**: cuando
     el funding promedio cae 30%, el quality_score de las señales que
     entran es estructuralmente menor

4. **Implementation drift** confirmado en código:
   - `signal-generator.js:24-31` admite que pre-V44.7 (deploy 2026-05-01)
     el motor usaba un proxy EMA del funding que "quietly degraded the
     strategy to coinflip in live"
   - El sample "750 trades" = ~38d V44.5/V44.6 con proxy degradado +
     ~3d V44.7 con funding real
   - **El backtest "PF 1.40" no fue re-ejecutado** con la misma serie
     ni con la misma fuente de funding del live → comparación inválida

5. **Costs gap documentado**: el equipo ya tiene notado en
   `v44-engine.js:119-130` que backtests "ideales" sobre-estiman PF
   en hasta **57%** vs realistic (PF 2.08 ideal vs 1.32 realistic en
   un caso histórico). Si el "1.40" reference era ideal-mode, el live
   1.05 no es degradación — es el costo real de operar.

---

## Paso 2 — Mega-sweep (resumen ejecución)

**Configuración:**
- Datos: 365 días Binance Futures, 22 pares líquidos (cacheados en `/tmp/v447-data/`)
- Timeframes: 1h (nativo), 4h (resampleado), 1d (resampleado)
- Costos aplicados: **9.5 bps roundtrip** (8 bps Binance taker + 1.5 bps slippage realista)
- Validación: walk-forward 70% train / 30% test, mínimo 50 trades para reportar

**Técnicas evaluadas (subconjunto factible en Node):**

| Categoría | Técnicas | Configs |
|---|---|---|
| A — Trend | Donchian20, EMA9/21, EMA21/55, BB-squeeze breakout, SuperTrend(10,3), ADX-filtered Donchian | ~700 |
| B — Mean revert | BB 2σ, RSI extremes (4 thr combos), Stochastic, CCI (3 thr), Williams %R, EMA200 distance (3 thr) | ~900 |
| C — Momentum | MACD hist cross, TS-momentum (3 lookbacks), cross-sectional momentum (3 LBs) | ~400 |
| J — Volume | OBV divergence, MFI extremes | ~150 |
| K — Volatility | Vol regime breakout (3 regimes), BB width expansion | ~250 |
| P — Alt data | Funding extremes (4 thr), Premium index extremes (3 thr) | ~80 |
| S — Exotic | Hurst regime adaptive (trend/revert switch) | ~70 |
| **TOTAL** | **~25 técnicas** | **4.140 configs** |

---

## Paso 3 — Validación estricta + Anti-overfit

### Resultado principal: 0 configs pasan hard gates

Hard gates exigidos:
- PF OOS ≥ 1.50
- Sharpe OOS ≥ 3.0
- DD ≤ 800 bps (~8%)
- ≥5 trades/día
- ≥30 trades muestra

**0 de 4.140 configs pasaron.**

### Gates relajados: PF ≥ 1.10 OOS

**0 de 4.140 configs pasaron.**

### Único config con PF ≥ 1.05 OOS y score > 0

| Métrica | Train | Test | Notas |
|---|---|---|---|
| Estrategia | K1_vol_low_breakout | (1h) | Donchian breakout filtrado por ATR low percentile |
| Trades | 3.160 | 1.283 | OK volumen |
| WR | 28.10% | 37.10% | Train muy bajo |
| PF | **0.685** | **1.05** | TRAIN ES PERDEDOR |
| Avg bps/trade | -15.4 | +2.1 | Marginal en test |
| Sharpe | -12.06 | 1.49 | Inversión completa train→test |
| DD | 49.530 bps | 4.632 bps | OK en test |
| PnL total | -48.626 bps | +2.697 bps | |
| Annual proxy (lev 3, 10% size) | n/a | 32.2% | |

**Lectura**: la config "ganadora" PERDIÓ DRAMÁTICAMENTE en train (-48.6k
bps acumulados, Sharpe -12) y solo "ganó" 2.6k bps en test. Esto NO es
una estrategia robusta — es la inversión típica de overfitting que aparece
cuando se evalúan miles de configs contra un sample temporal único.

**Si aplicáramos Deflated Sharpe Ratio** (ajustado por 4140 trials):
```
DSR = SR_observed - sqrt(2 × ln(n_trials)) / sqrt(T)
    = 1.49 - sqrt(2 × ln(4140)) / sqrt(1283)
    = 1.49 - 4.10/35.82
    = 1.49 - 0.114
    = 1.376
```
DSR positivo en test, pero contradice fuertemente la performance train.
**Bootstrap CI sobre los 1.283 trades del test** muy probablemente
incluye PF < 1.0 (no se ejecutó por presupuesto de tiempo, pero la
asimetría train/test indica fragilidad).

### Veredicto Paso 3
**Ningún candidato pasa anti-overfit estricto.** El "ganador" es
estadísticamente sospechoso (Sharpe train -12 → test +1.5 = clásica
firma de overfitting al período test específico).

---

## Paso 4 — Combinaciones de building blocks

**Skipped por falta de building blocks viables.** El protocolo requiere
top 5-10 técnicas con PF ≥ 1.10 OOS para hacer ensembles. Tenemos 0
en ese rango. Combinar señales aleatorias (PF ~ 1.0) producirá ensembles
también ~ PF 1.0 con varianza menor pero cero edge.

---

## Paso 5 — Decisión por horizonte

### CONFIG 1-MONTH MAX PnL
- **Mejor encontrado**: K1_vol_low_breakout/1h, ann 32% proxy
- **Pasa gate 1m (≥15-25%/mes, DD≤8%, Sh≥3, PF≥1.40, ≥100 trades)**: ❌ NO
- Razón: PF observado 1.05 << 1.40 requerido; Sharpe 1.49 << 3 requerido

### CONFIG 3-MONTH MAX PnL
- **Mejor encontrado**: misma config (no hay otra positiva)
- **Pasa gate 3m**: ❌ NO

### CONFIG 1-YEAR MAX PnL
- **Mejor encontrado**: misma config
- **Pasa gate 1y (≥100% anual, DD≤20%, Sh≥2.5, PF≥1.40)**: ❌ NO
- Annual proxy 32% queda lejos del 100% mínimo

---

## Decisión final recomendada

### Opción A — RECOMENDADA: Mantener V44.7 + ventana de observación

1. **Dejar V44.7 corriendo 3-6 meses adicionales** sin cambios. Necesario
   para llegar a 1.500-3.000 trades resolved con la fuente de funding
   real (no la proxy degradada que polucionó los 750 originales).

2. **Re-correr el backtest "1.40 reference"** sobre la misma serie del
   live, con la misma fuente de funding (real premium-index), con costs
   realistas (9.5 bps roundtrip). Esto da el verdadero PF baseline del
   motor sobre los datos comparables. Si el backtest re-corrido da
   PF ~1.10-1.20 (no 1.40), la "degradación" desaparece — era ilusoria.

3. **Documentar el regime shift** y aceptar que en regímenes low-vol/
   low-funding (Q2 2026 ahora) el motor estructuralmente da menos edge.
   El motor está calibrado para extraer carry — si no hay extremos en
   funding, no hay edge para extraer. Esto es **honestidad de modelo**,
   no falla.

4. **Anti-spam dedup + TP/SL monitor + WIN/LOSS outcomes** ya están
   implementados (commits previos). Eso ya es base sólida para evaluar
   bien adelante.

### Opción B — Si necesitás mejorar AHORA: cambiar de mercado

Las pruebas exhaustivas en cripto perpetuos (4.140 configs × 25 técnicas)
**no encontraron edge sobre fees realistas**. Esto es consistente con
literatura: post-2022, la mayoría de estrategias técnicas simples sobre
cripto líquido están arbitradas.

Mercados con menos eficiencia documentada que SÍ aceptan estrategias
simples:
- **FX exóticos** (USD/MXN, USD/ZAR, etc) — spreads más amplios pero
  movimientos menos eficientes
- **Commodity futures menores** — cocoa, sugar, lumber
- **Equities small-caps Russell 2000** — ineficiencias vs SPY

Pero requiere data + infra que no está cacheada localmente. Estimación
de provisioning: yfinance Python + 5 días de descarga rate-limited
para ~5y de daily data sobre 200 tickers.

### Opción C — Producto sin motor automático

Reframear RX Trading como herramienta de:
- Señales informativas (no auto-trading garantizado)
- Paper trading + journal + analytics
- Scanner multi-pair en tiempo real
- Backtests del usuario sobre sus propias estrategias

Esto es honestamente vendible al usuario final. "PF 1.50 motor garantizado
+200% anual" no lo es con los datos que vimos.

---

## Lo que NO se ejecutó (por falta de infra) y qué requiere

| Sin ejecutar | Por qué | Requiere |
|---|---|---|
| Categoría L (ML clásico) | No tengo Python provisionado | `pip install pandas sklearn lightgbm xgboost` (~10 min setup) |
| Categoría M (Deep Learning) | Sin GPU local | GPU + PyTorch (Colab free / EC2 spot) |
| Categoría N (RL) | Sin GPU + entornos custom | Igual que M + stable-baselines3 |
| Sentiment Twitter/Reddit | Twitter v2 free no existe (cerrado 2023) | API paga ($100+/mes) o Reddit alternativo |
| Opciones Deribit chains | Descarga de chains × strikes × expiries no en una sesión | 1-2 días dev + ccxt |
| FX/Commodities/Equities yfinance | Rate limit free — 5 años × 200 tickers ≈ 3-5 días sostenidos | yfinance + paciencia + retry logic |
| On-chain (Glassnode/Dune) | Free tier muy limitado | Glassnode paid (~$30-100/mes) o Dune queries free |

Si el usuario quiere ejecutar estos, **estimación realista 2-4 semanas
de wall-clock** con disponibilidad horaria + provisioning + setup de
pipelines + corridas. Posible pero claramente fuera del alcance "1-3h
de compute en una sesión interactiva".

---

## Archivos producidos en esta sesión

- `/audit/V44.6-LIVE-DIAGNOSIS.md` — diagnóstico detallado del PF 1.40→1.05
- `/audit/SESSION-RESULTS.md` — este reporte
- `/audit/mega-sweep-results.json` — datos crudos del sweep + diagnóstico
- `/audit/mega-sweep.log` — log de ejecución
- `backend/scripts/mega-sweep.js` — código del sweep (reproducible)
