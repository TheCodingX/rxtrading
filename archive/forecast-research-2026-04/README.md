# AI Forecast — Archived Research (2026-04-24)

## Status: NO DEPLOY

Research archivado tras backtest con resultado **47.7% accuracy** en 2116 predicciones (60d / 5 símbolos / threshold 0.80). El ensemble de 3 modelos (momentum + microstructure proxy + macro proxy) no produce edge predictivo ≥80% en horizontes 2-8h con data pública.

## Por qué se archiva
- Cumplir regla "no publicar accuracy inflado".
- Llegar a 80% requiere tick-level orderflow + ML entrenado + datos histórico-funding/macro → 2-4 semanas research extra.

## Pivot
El user pivotó a **AI Market Intelligence** (informacional, sin claims predictivos) — ver `frontend/app.html` sección `#vip-intel`.

## Qué hay acá
- `forecast-engine.js` — ensemble 3 modelos (momentum, microstructure, macro) + indicadores base (RSI, EMA, MACD, ATR)
- `backtest-forecast.js` — runner walk-forward contra Binance Futures klines reales
- `AI-FORECAST-BACKTEST.md` — reporte honesto con resultados
- `AI-FORECAST-BACKTEST-RAW.json` — sample de predicciones + aggregations

Re-usable si eventualmente: (a) conseguimos stream tick-level, (b) entrenamos XGBoost/LightGBM, (c) agregamos HMM regime + news filter.
