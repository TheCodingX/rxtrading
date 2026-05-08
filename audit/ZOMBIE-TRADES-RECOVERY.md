# ZOMBIE TRADES RECOVERY — incident playbook

**Incidente:** trades quedan en `OPEN` indefinidamente aunque el signal asociado cerró.
**Detectado:** 2026-05-07 (reporte de usuario).
**Root cause:** ver `audit/CLOSE-SYSTEM-DIAGNOSIS.md`. Resumen: faltaba un cron server-side que propagara el cierre del signal a los signal_trades. Frontend cerraba paper trades client-side (frágil — depende de browser abierto).
**Fix:** `runTradeCloseCycle` agregado a `backend/signal-cron.js` (deploy 2026-05-07).
**Modos afectados:**
- `paper`: total. Casi cualquier trade abierto cuyo browser estuvo cerrado al momento del cierre del signal quedó zombie.
- `real_testnet` / `real_mainnet`: parcial. La mayoría se cerró por reconcile cycle (5min lag), pero algunos quedaron si el broker config se desactivó o hubo problemas de API.

---

## Procedure de recovery

### Paso 1 — DEPLOY del fix (REQUIRED first)

El cron nuevo debe estar corriendo antes de la recovery, sino los zombies se van a re-acumular.

```bash
git push origin <branch>   # deploy a Render
# Confirmar logs:
heroku logs -t | grep "trade close propagator started"
# o en Render Dashboard → Logs → buscar "[SignalCron] trade close propagator"
```

Verificar:
```bash
curl https://api.rxtrading.net/api/admin/autotrade-status -H "x-admin-secret: $ADMIN_SECRET"
# Forzar primer ciclo manual para drenar zombies inmediatamente:
curl -X POST https://api.rxtrading.net/api/admin/run-trade-close -H "x-admin-secret: $ADMIN_SECRET" | jq .
```

### Paso 2 — DRY-RUN del recovery script

```bash
DATABASE_URL="$RENDER_DATABASE_URL" \
  node backend/scripts/zombie-recovery.js > /tmp/zombies-dry-run.csv

# Inspeccionar:
wc -l /tmp/zombies-dry-run.csv
head -5 /tmp/zombies-dry-run.csv
# Distribución por mode:
awk -F, 'NR>1 {print $4}' /tmp/zombies-dry-run.csv | sort | uniq -c
# Distribución por outcome:
awk -F, 'NR>1 {print $9}' /tmp/zombies-dry-run.csv | sort | uniq -c
```

**Decision point:** si el script reporta > 1000 zombies, alta probabilidad de que el cron también haya tomado parte ya. Re-correr `--dry-run` para ver el delta:

```bash
sleep 120
node backend/scripts/zombie-recovery.js > /tmp/zombies-dry-run-2.csv
diff -q /tmp/zombies-dry-run.csv /tmp/zombies-dry-run-2.csv || echo "list shrinking — cron working"
```

### Paso 3 — EXECUTE recovery (paper only)

```bash
DATABASE_URL="$RENDER_DATABASE_URL" \
  node backend/scripts/zombie-recovery.js --execute > /tmp/zombies-executed.csv
```

Confirmar que `action_taken=closed` para todas las paper:
```bash
awk -F, 'NR>1 {print $NF}' /tmp/zombies-executed.csv | sort | uniq -c
```

### Paso 4 — Real trades — manual con verificación Binance

El script NO toca `real_*` automáticamente. Para cada uno, verificar contra Binance:

```bash
# Listar real zombies:
awk -F, 'NR>1 && ($4=="real_testnet" || $4=="real_mainnet")' /tmp/zombies-dry-run.csv

# Por cada user_key_id, pedir reconcile manual:
curl -X POST https://api.rxtrading.net/api/broker/reconcile \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json"

# Si la posición ya no existe en Binance pero sigue OPEN en DB:
curl -X POST https://api.rxtrading.net/api/admin/close-user-trades/$KEY_ID \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d '{"reason":"RECONCILE_EXTERNAL"}'
```

### Paso 5 — Compensación a usuarios afectados

Para cada zombie en el CSV ejecutado, comparar PnL teórico (`derived_pnl`) con qué habría sido si el cierre hubiera sido inmediato:

```bash
# Generar CSV de impacto:
awk -F, 'NR==1 {print "key_id,trade_id,symbol,outcome,delayed_pnl,age_hours_at_close"} \
         NR>1 && $9=="WIN" {print $3","$1","$5","$9","$11","$12}' \
         /tmp/zombies-executed.csv > /tmp/zombie-impact.csv
```

Para WINs que cerraron tarde: ver si el precio se movió en contra durante el delay (el user "perdió" parte del win). Para LOSSes: el SL ya estaba puesto, no hay diferencia en el outcome teórico — el delay no afecta el PnL final, sólo la disponibilidad del slot.

**Política de compensación recomendada:**
- WINs cerrados con delay < 24h: notif al user con explicación, sin compensación.
- WINs cerrados con delay > 24h y diff PnL > 5%: crédito de membresía proporcional al diff.
- Cualquier real_* afectado: revisión 1:1 con el user.
- Todos los users afectados reciben notif `eventType='trade_close'` + email explicativo (template en `audit/USER-COMMUNICATION-V447.md` adaptado).

### Paso 6 — Reporte final

Crear archivo con timestamp:
```
audit/zombie-recovery-2026-05-07.json
```
Con:
- Total zombies: paper / real
- Total cerrados por el script
- Total cerrados manualmente
- Compensaciones aplicadas
- Anomalías sin resolver
- Tiempo total de la recovery operation

---

## Verificación post-recovery

```bash
# 1. ¿Quedan zombies?
curl "https://api.rxtrading.net/api/admin/open-trades?anomalies_only=1&limit=2000" \
  -H "x-admin-secret: $ADMIN_SECRET" | jq '.summary.total'

# 2. ¿El cron sigue corriendo?
# (revisar logs Render últimas 5 min: debería haber al menos 10 ciclos de [SignalCron][TradeClose])

# 3. ¿La sample del propagator es razonable?
curl "https://api.rxtrading.net/api/admin/run-trade-close" \
  -X POST -H "x-admin-secret: $ADMIN_SECRET" | jq '{evaluated, closed, skipped, deferred}'
```

Estado healthy: `evaluated < 100`, `closed=0`, `skipped` cubriendo el resto.

---

## Si el script falla en producción

El script usa la misma instancia del pool de la DB que el server. Si el server está corriendo, esto debería ser sin riesgo de race (el cron y el script compiten por las mismas filas, pero `closeTrade` es idempotente — solo afecta rows en OPEN/PENDING_*).

**Si ves errores `connection_pool_exhausted` o `query_timeout`:**
1. Bajar `--limit=200` para procesar en chunks.
2. Esperar 30s entre chunks para que el pool se recupere.
3. Si persiste, ejecutar fuera de hora pico.

**Si ves `trade_not_open_or_not_found` en muchas filas:**
- Es lo esperado si el cron ya cerró estos trades antes que el script. Ignorar.

---

## Rollback (si el fix mismo causa problemas)

Si `runTradeCloseCycle` cierra trades incorrectamente (por bug en derive logic):

```bash
# Desactivar el cron sin redeploy: setting env var a 0 NO funciona porque el timer ya
# está creado. Hay que reiniciar.
# 1. Pause autotrade global:
curl -X POST https://api.rxtrading.net/api/admin/pause-autotrade -H "x-admin-secret: $ADMIN_SECRET"

# 2. Rollback deploy:
# Render Dashboard → Deploys → click rollback en el deploy anterior

# 3. Después del rollback, identificar trades cerrados incorrectamente:
psql $DATABASE_URL -c "
  SELECT id, signal_id, key_id, mode, close_reason, closed_at, meta
  FROM signal_trades
  WHERE meta::text LIKE '%propagated_from_signal%'
    AND closed_at > '2026-05-07 00:00:00'
  ORDER BY closed_at DESC
  LIMIT 100;
"

# 4. Re-abrirlos manualmente si fue un cierre incorrecto (UPDATE trade_state='OPEN' …)
```

Esto es escenario worst-case. El cron se diseñó para ser conservador (idempotente, defer a reconcile en real_*, derive reasons solo cuando outcome está set explícitamente).
