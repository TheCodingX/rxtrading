# AI FORECAST — Backtest Report (HONESTO)
Fecha: 2026-04-24

## TL;DR

**🔴 GATE ≥80% — NO PASA. Recomendación: NO DEPLOY de la sección.**

| Configuración | Predicciones | Accuracy | Veredicto |
|---|---|---|---|
| 30d, threshold 0.85, 3 símbolos | 108 | **25.9%** | Peor que coin-flip (modelo inverso) |
| 60d, threshold 0.80, 5 símbolos | 2 116 | **47.7%** | Coin-flip (sin edge) |
| 60d, threshold 0.92, 5 símbolos | 0 | — | Modelo nunca llega a 0.92 confidence |

Ningún threshold produce accuracy ≥80% con cobertura ≥1 predicción/día. La sección **no cumple los gates de deploy del protocolo**.

---

## Metodología

- Datos: Binance Futures **klines públicas reales** (`/fapi/v1/klines`), no sintéticos.
- Walk-forward hora a hora, **sin look-ahead**: cada predicción usa solo barras cerradas antes de `t`.
- Ensemble de 3 modelos independientes (momentum + microstructure + macro) — ver `backend/forecast-engine.js`.
- Gate: los 3 modelos deben coincidir en dirección AND confidence ponderada ≥ threshold.
- Evaluación: hit si `predictedDir === actualDir` al horizonte.

Reproducir:
```
node backend/backtest-forecast.js --days 60 --threshold 0.80 \
  --symbols BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT
```

---

## Resultados honestos

### Threshold 0.85 / 30d / 3 criptos (muestra inicial)
```
2h: 7/27  = 25.9%
4h: 7/27  = 25.9%
6h: 9/27  = 33.3%
8h: 5/27  = 18.5%
BTC: 19.2%  ETH: 12.5%  SOL: 46.9%
Overall 28/108 = 25.9%
```

### Threshold 0.80 / 60d / 5 criptos (sample grande)
```
2h: 260/529 = 49.1%
4h: 257/529 = 48.6%
6h: 257/529 = 48.6%
8h: 235/529 = 44.4%
BTC 49.1%  ETH 41.2%  SOL 51.8%  BNB 39.7%  XRP 55.1%
Overall 1 009/2 116 = 47.7%
Reported conf avg 82.1% vs actual 47.7% → calibration GAP -34pp
```

### Threshold 0.92 / 60d / 5 criptos
```
0 predictions.
El ensemble nunca alcanza 0.92 — techo real ~0.89 con estos features.
```

---

## Análisis de por qué falla

El diseño inicial asume que **coincidencia entre 3 modelos basados en indicadores técnicos** produce edge predictivo ≥80%. Los números muestran que **no es así**. Razones:

1. **Indicadores lagging**: MTF EMA cross, RSI, MACD reflejan el pasado. A horizontes 2-8 h el mercado es dominado por orderflow + flujo de posición, no por momentum técnico.
2. **Sin microstructure real**: usamos volume delta + taker ratio proxy de klines (agregado), no tick-level L2 book ni trades flow. El modelo 2 pierde >90% de su señal real.
3. **Sin macro real**: F&G se calcula como proxy de retorno 30d (no la API real). BTC dominance y SPX bias están hardcoded a 0. El modelo 3 aporta casi nada direccional.
4. **Sin funding real**: `funding = 0` en backtest (no guardamos historical funding rates). El modelo 1 pierde la señal contra-tendencia de funding extremo.
5. **Calibration gap**: confidence reportada 82% pero accuracy real 47.7% → el **score de confidence no refleja probabilidad real**. Requiere entrenamiento bayesiano o isotonic regression.

---

## Lo que se requeriría para ≥80% accuracy

No es sólo cuestión de "ajustar threshold". Para llegar al gate, el ensemble tendría que alimentarse con:

- **Tick-level orderflow**: stream de trades (buy/sell aggressor) + book imbalance L2. Requiere WebSocket dedicado + storage multi-TB.
- **Funding rate histórico**: archive desde Binance API `/fapi/v1/fundingRate` (retrocede ~1 año con paginación).
- **Feed macro**: Alternative.me F&G API, SPX intraday, VIX, BTC dominance (CoinGecko).
- **Modelo ML entrenado**: XGBoost/LightGBM con ~200 features, cross-validated, calibrated (Platt scaling o isotonic).
- **Regime HMM**: detectar rangos chop/trend/caos para filtrar predicciones solo en regímenes predecibles.
- **News/sentiment filter**: CryptoPanic / Twitter stream para supresión durante noticias.

Esfuerzo estimado realista: **2-4 semanas de research + build + validación**. No es un scope de 1 sesión.

---

## Decisión GO/NO-GO (per user rules)

El protocolo dice:
> "Si accuracy backtest <80%: ajustar threshold hasta llegar o NO deploy la sección."

Intentamos threshold 0.80, 0.85, 0.92 — ninguno llega. Threshold alto mata cobertura, threshold bajo mantiene accuracy ~coin-flip.

**Veredicto: NO DEPLOY de la sección AI FORECAST como está diseñada.**

---

## Alternativas honestas para el user

### Opción A — NO DEPLOY (recomendada)
Dejar la sección fuera del producto hasta tener budget de 2-4 semanas para research con datos de calidad. Cumple la regla "no publicar accuracy inflado".

### Opción B — DEPLOY con marketing HONESTO
Reformular el claim: no "85% accuracy" sino "señales probabilísticas con edge modesto (~52-55% en ciertos regímenes)". Esto es legal + honesto pero **no vende premium VIP**.

### Opción C — DEPLOY como "BIAS INDICATOR" no predicción
Convertir la sección en **indicador de sesgo del ensemble** (UP/DOWN con confidence) sin claim de accuracy futuro. Mostrar solo tendencia actual + drivers, sin proyección de precio. Transparencia sobre que es "señal de análisis", no "predicción del futuro".

### Opción D — INVERTIR el modelo (research adicional)
El 25.9% inicial (en sample chico) sugiere posible miscalibration direccional. Flipear la dirección predicha y re-backtestear. Si flipeada llega a 70%+ consistente, hay algo ahí. **Pero esto requiere más research y no es lo que "AI FORECAST" vende al usuario.**

---

## Entregables de FASE 1

- ✅ `backend/forecast-engine.js` — ensemble 3 modelos (momentum + microstructure + macro)
- ✅ `backend/backtest-forecast.js` — runner walk-forward con klines reales Binance
- ✅ `audit/AI-FORECAST-BACKTEST-RAW.json` — datos crudos del último run
- ✅ Este documento — reporte honesto con accuracy real
- 🔴 **GATE ≥80% NO pasa → FASES 2-7 (UI, backend prod, animaciones, features) NO se ejecutan.**

---

## Qué sigue

Decisión del usuario:
1. Aceptar NO-DEPLOY (opción A) → archivar `forecast-engine.js` como research y no exponer sección VIP.
2. Aceptar marketing honesto (opción B) → seguir FASES 2-7 con claims ajustados al accuracy real.
3. Reformular como "bias indicator" (opción C) → seguir FASES 2-7 sin claim de predicción.
4. Pedir research adicional (opción D) → 2-4 semanas de trabajo extra antes de UI.

**No avanzo a FASE 2 (backend prod) ni FASE 3 (UI) hasta que confirmes opción.** Los gates del protocolo son inmutables.
