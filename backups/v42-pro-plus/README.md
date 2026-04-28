# V42 PRO+ Backup — 2026-04-23

Motor legacy **APEX V42 PRO+** funcional a la fecha de este backup. Guardado como referencia histórica y posible fallback futuro. **NO usar en producción.**

Reemplazado por **APEX Engine v44 Funding Carry** (PF 1.81, WR 73.5%, DD 4.58%, holdout OOS 365d).

## Contenido

- `app.html.v42proplus-snapshot.html` — snapshot completo del frontend con lógica V42 PRO+ intacta (incluye `runApexV16OnData`, `APEX_V16_MODEL`, `genV16APEXSignal`, universo v42pro de 15 pares).
- `models/apex-v16-model.json` — modelo ML exportado (feature weights) usado por V16/V40/V42 PRO+.
- `models/apex-v16-export-model.js` — script de exportación del modelo.
- `backtests/backtest-v42-max.js` — backtest max-overlay del motor V42 Max.
- `backtests/backtest-v42-max-overlay.js` — variante overlay.
- `backtests/backtest-v42-pro.js` — backtest puro del V42 PRO.
- `backtests/backtest-v42-1a-pairselect.js` — variante con pair selection 1A.

## Restauración (si alguna vez hace falta)

```bash
git checkout backup-v42pro-plus -- frontend/app.html
# o copiar el snapshot manualmente:
cp backups/v42-pro-plus/app.html.v42proplus-snapshot.html frontend/app.html
```

## Git tag

```
git tag backup-v42pro-plus
```

## Notas

- El V42 PRO+ usa el mismo modelo exportado `apex-v16-model.json` (rebranded, no reentrenado).
- Estrategia: momentum + mean-reversion dual-stream con filtros MTF gate 4H + P45 + maxPos 6.
- Universo (15 pares): ADA, RENDER, ARB, ETH, XRP, BTC, 1000PEPE, ATOM, LINK, POL, SOL, SUI, TRX, NEAR, INJ.
