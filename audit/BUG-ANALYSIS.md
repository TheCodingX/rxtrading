# BUG-ANALYSIS — FASE 1 (forense)
Fecha: 2026-04-24
Scope: señal SELL ATOM 71% operada 2× en paper trading + cierre positivo sin aviso.

---

## BUG 1 — SEÑAL DUPLICADA (ATOM SELL 71% operada 2 veces)

### Reproducción lógica

Pipeline actual de `refreshPaperSignal` → `autoTradeFromSignal`:

1. Scan loop corre cada ~15s (VIP) / ~30s (paper).
2. Obtiene señal V44 de `_v44SigCache` (TTL 4h) o fresca de `genApexV44LiveSignal`.
3. Si `autoTradeActive`, invoca `autoTradeFromSignal(sym, signal, conf, entry, tp, sl, mode)` — `app.html:14659-14661`.
4. `autoTradeFromSignal` (`app.html:15013-15074`) deduplica **por símbolo** y **por cooldown de 30 s**, NO por ID de señal:
   ```js
   const existing = paperData.positions.find(p=>p.sym===sym);
   if(existing) return;
   const cooldownTime = autoTradeCooldowns[sym] || 0;
   if(Date.now() - cooldownTime < 30000) return;
   ```

### Root cause

**La señal V44 vive 4 h (`hold_hours`), pero el cooldown por símbolo es de 30 s.** Secuencia que reproduce el bug:

| t      | Estado paper                         | Scanner                               |
|--------|--------------------------------------|---------------------------------------|
| 00:00  | Sin posición ATOM                    | Emite SELL ATOM 71 % #sig-A           |
| 00:00  | Abre pos #1 (auto)                   | —                                     |
| 00:03  | TP ATOM tocado → `closePaperTrade`   | Signal #sig-A sigue en `_v44SigCache` |
| 00:03  | Se vacía posición ATOM, `autoTradeCooldowns['ATOMUSDT']=t` | —                                     |
| 00:35  | Cooldown (30 s) expiró               | Scanner repite → misma señal #sig-A cacheada |
| 00:35  | `autoTradeFromSignal` vuelve a entrar | Abre pos #2 con **los mismos** entry/TP/SL de #sig-A |

Esto es **duplicación por misma señal** (mismo `timestamp`, mismo TP, mismo SL, misma dirección). La señal es la misma instancia en cache; se opera 2× porque:

1. `autoTradeFromSignal` no guarda `signalId` de trades operados.
2. `_v44SigCache[sym]` retorna siempre la misma señal mientras esté en TTL.
3. El cooldown de 30 s < hold_hours de 4 h permite reentrar con la misma señal.

### Evidencia adicional

- `applyPaperSignal()` (botón OPERAR manual, `app.html:14764-14843`) tampoco deduplica por `signalId`. Dos clics rápidos pueden crear dos trades **aunque el mutex `_paperTradeOpening` exista** — el mutex es síncrono: se libera en el mismo frame del event loop, los clicks encolados ven `_paperTradeOpening=false` cuando llegan.
- ID de posición: `Date.now() + Math.floor(Math.random()*1000)` (`app.html:15063`) — no es UUIDv4 crypto, posible colisión bajo carga.
- `_firedSigHashes` (`app.html:12715-12735`) existe para el **banner de "nueva señal"**, pero **no** para dedup de trades.

### Clasificación

**FAIL A.1 (unicidad de señales)**, **FAIL B.1 (dedup pre-open)**, **FAIL A.2 (estabilidad)** — la señal se re-entra aunque no cambió.

---

## BUG 2 — CIERRE PREMATURO SIN AVISO

### Síntoma
Trade cerró positivo antes de que el gráfico muestre el TP tocado. Sin notificación de razón.

### Análisis del close path

Solo hay **dos** puntos de cierre en paper:

1. **Auto-close TP/SL** en `renderPaper()`, `app.html:14241-14244`:
   ```js
   if(p.tp&&p.dir==='BUY'&&cur>=p.tp) toClose.push({id:p.id, exitPrice:p.tp});
   else if(p.tp&&p.dir==='SELL'&&cur<=p.tp) toClose.push({id:p.id, exitPrice:p.tp});
   else if(p.sl&&p.dir==='BUY'&&cur<=p.sl) toClose.push({id:p.id, exitPrice:p.sl});
   else if(p.sl&&p.dir==='SELL'&&cur>=p.sl) toClose.push({id:p.id, exitPrice:p.sl});
   ```
2. **Manual close** desde botón `CERRAR` (`app.html:14331`) → `closePaperTrade(id)` sin `exactExitPrice` → usa `px[sym]`.

### Root cause

`closePaperTrade(id, exactExitPrice)` (`app.html:14176-14207`) **no acepta `reason`**:

```js
paperData.history.push({...pos,exit:exitPrice,pnl,closedAt:new Date().toISOString()});
...
toast(`Cerrado ${pos.sym.replace('USDT','')} — P&L: ${pnl>=0?'+':''}$${pnl.toFixed(2)}`);
```

- Ni el `history` ni el `toast` diferencian TP_HIT / SL_HIT / MANUAL_CLOSE / SAFETY_GATE.
- El `history` no persiste la razón → imposible reconstruir qué cerró el trade.
- El usuario ve "Cerrado ATOM — P&L: +$5.23" sin saber si fue TP, SL o cierre manual.

### Por qué "antes de tocar TP visible"

El `renderPaper()` chequea `cur = px[p.sym]` — precio **spot de WebSocket**, actualizado en tiempo real. Si hubo un spike intrabar (wick de 1-3 s) que tocó `p.tp`, el check dispara cierre. El chart que ve el usuario opera en TF 15 m / 5 m — el wick de 1-3 s **no se dibuja** en esos TFs.

Resultado: el cierre **fue real**, pero **no explicado**:
- Sin razón en `history` → no hay forma de auditarlo post-factum.
- Sin razón en `toast` → el usuario no sabe qué pasó.
- Sin marker en el chart con label "TP_HIT 17:03:42 @ 0.3284" → invisible.

### Clasificación

**FAIL B.4 (cierre sin razón categorizada)**, **FAIL C.2 (estados de trade)**, **FAIL C.3 (gráfico sin marker de razón)**, **FAIL C.4 (notificación sin razón)**.

---

## BUG 3 — DELAY

### Puntos medidos en el código

| Stage                                 | Tiempo           | Fuente                                       |
|---------------------------------------|------------------|----------------------------------------------|
| V44 signal generation                 | 200-800 ms       | `_genApexV44LiveSignalInner` con fetch klines |
| UI display (paper-sig-dir render)     | <50 ms           | `_updatePaperSigDisplay`                     |
| Autotrade dispatch                    | <10 ms sync      | `autoTradeFromSignal` (local state)          |
| Place-order backend (real broker)     | 100-500 ms       | `/api/broker/place-order` + Binance API      |
| Scan loop interval                    | 15-30 s          | paper + VIP                                  |

### Observación
- Paper: latencia total señal → trade ~ **1 s**.
- Real autotrading: señal → orden ~ **0.8-1.5 s** + red Binance.
- NO hay websocket de señales; el frontend **polea**. Scan interval de 15-30 s significa que una señal emitida por el motor puede tardar hasta 30 s en aparecer en UI.

### Clasificación

**WARN A.4 (scan interval razonable pero podría ser más agresivo para scalp)**. No es bug crítico pero limita UX.

---

## BUG 4 — DESAPARICIÓN/REAPARICIÓN

### Comportamiento actual
La señal V44 se cachea en `_v44SigCache[sym]` con TTL 4 h. Mientras esté viva:
- Mismo `timestamp`
- Mismo `tp`/`sl`/`entry`/`confidence`
- Purgada si `_isSignalBreached(cached, sym)` detecta precio fuera de TP/SL

### Issue detectado
La purga por breach (`app.html:10310-10313`) elimina del cache → siguiente scan **regenera una señal fresca** con NUEVOS TP/SL basados en el precio actual. Si el breach fue un wick falso, la UI mostrará dos señales distintas en ventanas de 30 s. El usuario percibe "la señal cambió sin razón".

### Clasificación
**FAIL A.2 (estabilidad — la señal muta post-breach)**.

---

## ROOT CAUSES CONSOLIDADOS

| # | Bug                     | Root cause                                                                                   | Archivo:línea                   | Fix requerido |
|---|-------------------------|----------------------------------------------------------------------------------------------|---------------------------------|---------------|
| 1 | Señal duplicada         | `autoTradeFromSignal` y `applyPaperSignal` no deduplican por `signalId` estable.            | app.html:14764, 15013           | Asignar `signalId = hash(sym+dir+entryTs+engineVersion)` al cachear; rechazar dispatch si `_operatedSignalIds.has(signalId)` |
| 2 | Cierre silencioso       | `closePaperTrade` sin parámetro `reason`; history no registra causa.                         | app.html:14176, 14189, 14206    | Agregar param `reason`; persistir en history; toast con razón explícita |
| 3 | Mutex ineficaz          | `_paperTradeOpening` sync → se libera mismo frame → doble-click → 2 trades.                  | app.html:14143-14173            | Mutex que persista hasta guardado en localStorage completado |
| 4 | ID de posición colisiona| `Date.now() + random*1000` no garantiza unicidad bajo 1 ms.                                  | app.html:15063                  | Reemplazar por `crypto.randomUUID()` |
| 5 | Señal post-breach muta  | Purga cache + regenera con TP/SL nuevos al precio actual.                                    | app.html:10310-10317            | Mantener señal con flag `_closed:true,reason` en lugar de purgar |
| 6 | Wick invisible          | Chart TF 15 m no muestra spikes de 1-3 s que tocaron TP/SL.                                  | renderPaperSigChart             | Dibujar marker explícito con timestamp+precio en el chart al cerrar |

---

## SIGUIENTE PASO
→ FASE 2: auditoría sistemática de Áreas A-E (`SIGNALS-TRADING-AUDIT.md`).
→ FASE 3: fixes de los 6 root causes arriba + tests.
