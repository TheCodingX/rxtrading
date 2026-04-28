# V45 REALISTIC — Deploy Decision Final

**Fecha:** 2026-04-27
**Veredicto:** ❌ **NO DEPLOY V45 SUPREME** — V44.5 P11+P7 queda como producción final

---

## 1. EXECUTIVE SUMMARY — HONESTIDAD BRUTAL

El backtest "ideal" V45 SUPREME (PF 2.08, %win7d 96.6%) era un **artifact metodológico**, no un edge real.

**Bug del backtest ideal:** P14 (micro time-stop) chequeaba antes que TP/SL hits. En live trading, el SL/TP triggerea inmediatamente cuando el precio toca el level. Por hour 1, el ~95% de trades ya cerraron normalmente. P14 solo afecta al ~2% de trades restantes.

**V45 SUPREME realistic vs V44.5 realistic:**
- PF +0.017 (+1.3%) ← marginal
- PnL +$10 (+5.5%) ← negligible
- %win7d +1.7pp ← dentro del margen de ruido
- Worst7d +0.02pp ← ninguna mejora

**P14 no aporta valor en condiciones reales.** Implementar la infraestructura (timer, BE-Move, reconciliación, error handling) cuesta 4-6h de dev + riesgo operacional para un beneficio de <2% en PF.

---

## 2. COMPARACIÓN COMPLETA — IDEAL vs REALISTIC

| Métrica | V44 Ideal | V44 Real | V44.5 Ideal | V44.5 Real | V45 Ideal | V45 Real |
|---|---|---|---|---|---|---|
| PF | 1.461 | **1.164** | 1.616 | **1.305** | 2.081 | **1.322** |
| PnL | $201 | $86 | $354 | $179 | $351 | $189 |
| DD% | 3.44% | 5.24% | 5.00% | 5.99% | 1.13% | **5.99%** |
| Sharpe | 6.62 | 2.57 | 7.63 | 4.18 | 11.02 | 4.36 |
| %win7d | 86.4% | 68.1% | 90.7% | **75.7%** | 96.6% | **77.4%** |
| Worst 7d | -2.15% | -3.29% | -3.03% | -3.71% | -0.78% | **-3.73%** |

**Hallazgos clave:**
1. **Costos consumen 30-40% del edge** en todas las configs (fees 0.05% × 2 + slippage × 6984 trades = ~$550 en fees)
2. **V45 SUPREME P14 colapsa a V44.5 nivel** en realistic (DD 5.99% vs ideal 1.13%)
3. **V44.5 P11+P7 es la config production-ready REAL** con PF 1.305 realistic

---

## 3. POR QUÉ P14 FALLA EN REALISTIC

### Bug del backtest ideal
```javascript
// IDEAL (incorrect order)
if(P14_check_at_hour_1) → close_BE
else if(hitTP || hitSL) → close_normal
```

P14 chequea ANTES que TP/SL. Trades que en realidad hubieran tocado SL en minuto 30 son "rescatados" virtualmente al hour 1.

### Realidad live
```javascript
// REALISTIC (correct order)
if(hitTP) → close_TP             // immediate
if(hitSL) → close_SL             // immediate
if(elapsedH === 1) → P14_check   // only IF still open at h=1
```

Por hour 1, ~95% de trades ya cerraron. Solo 141 trades (2% en realistic) llegan al timer P14.

### Métricas reales
- **Trades que llegan al check P14**: 141-235 (2-3.4% según threshold)
- **Mejora de DD**: insignificante porque la mayoría de SL hits ocurrieron antes del check
- **Costo operacional**: cron job 60s + DB tracking + Binance order modifications + reconciliación = alta complejidad para ~$10 PnL extra/año

---

## 4. COSTOS REALES MODELED

```
ENTRY (market):         fee taker 0.05% + slippage 0.02% = 0.07%
TP HIT:                 fee taker 0.05% = 0.05%
SL HIT (no BE):         fee taker 0.05% + slippage 0.02% = 0.07%
BE-MOVE @ 1h:           cancel SL (free) + new SL maker 0.02% = 0.02%
SL_BE eventual hit:     fee maker 0.02% = 0.02%
TIMESTOP_4H:            fee taker 0.05% + slippage 0.05% = 0.10%
```

**Round-trip total:**
- Trade TP normal: 0.07% (entry) + 0.05% (TP) = **0.12%**
- Trade SL normal: 0.07% + 0.07% = **0.14%**
- Trade BE-protected hit: 0.07% + 0.02% (BE move) + 0.02% (BE close) = **0.11%**

Sobre 6984 trades × ~$50 size promedio = ~$8.4 fees/trade × 6984 = **~$550 fees total** (109% del capital base).

**Esto es porque el motor opera mucho** (19.4 t/d). Funding carry alta-frecuencia paga muchos fees.

---

## 5. VEREDICTO FINAL POR CONFIG

| Config | PF Real | %win7d Real | Verdict |
|---|---|---|---|
| **V44 baseline** (no palancas) | 1.164 | 68.1% | ⚠️ Marginal — pasa PF >1.0 pero apenas |
| **V44.5 P11+P7** (production) | **1.305** | **75.7%** | ✅ **PRODUCTION READY** |
| **V45 SUPREME P11+P7+P14** | 1.322 | 77.4% | ⚠️ **+1.3% solo, no vale la complejidad** |

### Decisión:

**KEEP V44.5 P11+P7 como producción final.** Las flags actuales en Render son las correctas:
```bash
APEX_V45_PAIR_SIZING=1
APEX_V45_TERM_STRUCTURE=1
# APEX_V45_MICRO_STOP — DO NOT enable in production (insufficient real edge)
```

**No deployar V45 SUPREME** porque:
1. Ganancia real <2% PF
2. Requiere infraestructura compleja (timer, BE-Move, error handling)
3. Riesgo operacional de bugs en producción
4. V44.5 ya cumple targets razonables (PF 1.30, %win7d 75%, +35% anual)

---

## 6. STATS FINAL V44.5 P11+P7 — REALISTIC

```
Trades:      6984 over 365 days
PF:          1.305
WR:          68.21%
PnL:         $179.10 (capital $500 → $679 in 365d = +35.8% annual)
DD:          5.99% max
Sharpe:      4.18
t/d:         19.40
%win7d:      75.7% (270 of 357 windows positive)
Worst 7d:    -3.71% ($-18.54 on $500)
Best 7d:     +6.2% ($+31)
Median 7d:   +0.6% ($+3)

Total fees paid:       $542.34 (108% of capital)
Total slippage cost:   $140.62 (28% of capital)
Net edge after costs:  $179 (35.8% over 365d)
```

**Annualized edge**: +35.8% per $500 capital = realistic, defensible to VIP users.

---

## 7. MARKETING HONESTO POST-DEPLOY

**Frase principal V44.5:**
> "APEX Engine V44.5 — funding carry institucional con sizing dinámico por par. Backtest holdout 365d: PF 1.30 con costos reales (fees Binance + slippage). 75.7% de semanas positivas."

**Disclaimer obligatorio:**
> "Stats incluyen costos reales: fee taker 0.05%, slippage estimado 0.02%, sobre 6984 trades en 365 días. Resultados pasados no garantizan futuros. Drawdown máximo histórico: 5.99%. Worst 7d: -3.71%."

**NO decir:**
- "PF 2.08" (era stat ideal sin costos)
- "96.6% wins" (era stat ideal sin costos)
- "Drawdown <1%" (no es real con fees)

**SÍ decir:**
- "PF 1.30 net of costs (Binance fees + slippage)"
- "+35.8% annualized backtest holdout 365d"
- "75.7% de semanas positivas"

---

## 8. LECCIONES APRENDIDAS

### 1. Backtest ideal vs realistic puede DIVERGIR drásticamente
- V45 SUPREME ideal PF 2.08 → realistic 1.32 (-37%)
- V44 baseline ideal PF 1.46 → realistic 1.16 (-21%)
- Costos no son lineales: alta-frecuencia (19 t/d) come 30-40% del edge

### 2. Order de checks importa
Bug típico de backtest: chequear time-stops/exits antes de TP/SL hits naturales. En vivo, las órdenes Binance triggerean inmediatamente.

### 3. P14 (BE-Move) requiere micro-tick data
Para que P14 sea efectivo, debería chequear cada 5-15 minutos, no cada hora. Con bars 1h, la mayoría de trades ya cerraron.

### 4. Operational complexity tiene costo
Implementar timer + cron + Binance order modification + reconciliación cuesta:
- Dev time: 4-6h
- Test time: 2h
- Riesgo de bugs en producción
- Surface area de errores aumenta

Para ganar <2% PF, no vale el costo.

---

## 9. PRÓXIMOS PASOS

### Inmediatos (este sprint)
- ✅ Mantener V44.5 P11+P7 deployed (env vars actuales en Render)
- ✅ Documentar este veredicto en `/audit/V45-REALISTIC-DEPLOY-DECISION.md`
- ✅ NO modificar `backend/v44-engine.js` para activar P14 default
- ✅ Dejar `APEX_V45_MICRO_STOP=0` (no setear) en producción

### Próximo sprint (después de 30d live)
- Analizar live performance V44.5 vs backtest realistic
- Si live PF < backtest realistic, ajustar slippage assumptions
- Si live PF > backtest realistic (improbable), confirma engine funciona
- Sprint PRODUCTO: animaciones UI, dashboard, marketing actualizado

### Si en futuro queremos retomar P14
- Implementar con tick-data 1m (no 1h bars)
- Check cada 5 min, no 1h
- Modelar fees reales del BE-Move (cancel + replace)
- Validar OOS antes de deploy

---

## 10. CIERRE TÉCNICO ABSOLUTO

**V44.5 P11+P7 = motor final de producción.**

Configuración Render:
```bash
APEX_V45_PAIR_SIZING=1
APEX_V45_TERM_STRUCTURE=1
# Otros V45 flags = OFF / not set
```

Stats backtest realistic 365d:
- PF 1.305 (above 1.0 = profitable after costs)
- WR 68.21%
- %win7d 75.7%
- +35.8% annualized

Próximo prompt de motor: NO antes de 30 días de live data.

**GO PRODUCTO.**
