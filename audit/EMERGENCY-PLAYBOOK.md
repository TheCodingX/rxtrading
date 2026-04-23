# EMERGENCY PLAYBOOK — RX PRO Trading Platform
**Fecha:** 2026-04-22
**Audience:** Admin/operador de la plataforma
**Scope:** Procedimientos de emergencia para incidentes comunes

---

## Contactos de emergencia

| Rol | Nombre | Contacto | Disponibilidad |
|-----|--------|----------|----------------|
| Admin principal | (pendiente) | (pendiente) | 24/7 |
| Backup admin | (pendiente) | (pendiente) | business hours |
| Legal counsel | (pendiente) | (pendiente) | on-demand |

**ACCIÓN REQUERIDA:** Completar esta tabla antes del deploy.

---

## Decisión rápida: ¿GO o KILL SWITCH?

Si estás frente a un incidente, responde estas 3 preguntas:

1. **¿Hay pérdida financiera activa (trading real)?** → KILL SWITCH inmediato
2. **¿Hay exposición de datos sensibles (secrets, PII)?** → KILL SWITCH + incident response
3. **¿Es un bug UX no financiero?** → rollback deploy a versión anterior, no kill switch

---

## Kill Switches

### 1. PAUSE AUTOTRADE GLOBAL (bloquea nuevos trades, no cierra abiertos)

```bash
# Requiere ADMIN_SECRET
curl -X POST https://api.rxtrading.net/api/admin/autotrade/pause-all \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"reason":"emergency — reason here","durationHours":24}'
```

**Efecto:** Todos los users VIP ven banner "Autotrading pausado por administrador". Nuevas signals bloqueadas. Posiciones abiertas **SIGUEN ACTIVAS** con TP/SL en Binance.

### 2. CLOSE ALL POSITIONS (emergency only)

```bash
# Cierra todas las posiciones abiertas de todos los users
curl -X POST https://api.rxtrading.net/api/admin/positions/close-all \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d '{"reason":"emergency","confirmPhrase":"CLOSE-ALL-POSITIONS-NOW"}'
```

**Efecto:** Market close reduceOnly de cada position abierta. Users reciben notification. TP/SL orders canceladas.

**⚠️ USAR SOLO EN CATASTROFE** (data breach, motor comprometido, Binance account compromiso).

### 3. ROLLBACK DEPLOY

Opción A — Render (backend):
- Dashboard → servicio `rxtrading-1` → tab Deploys → click rollback en deploy anterior ✓

Opción B — Netlify (frontend):
- Dashboard → site → Deploys → click "Publish deploy" en deploy anterior ✓

Ambos tardan ~30s en propagar.

### 4. BLOQUEAR USER ESPECÍFICO

```bash
curl -X POST https://api.rxtrading.net/api/admin/keys/revoke \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d '{"code":"RX-VIP-XXXX","reason":"suspicious activity"}'
```

---

## Playbooks por tipo de incidente

### A. Binance API cae / rate limits exhausted

**Síntomas:**
- `/api/broker/place-order` retorna 500 o timeout
- Logs muestran errores 429 o 503 de Binance
- Users reportan "no pueden colocar trades"

**Respuesta:**
1. Verificar Binance status: https://www.binance.com/en/support/announcement/status-of-binance
2. Si es Binance down:
   - PAUSE AUTOTRADE GLOBAL con reason "Binance API maintenance"
   - Publicar banner en UI: "Binance API inaccesible — autotrade en pausa"
3. Si es rate limit nuestro:
   - Aumentar backoff en `backend/broker.js:115`
   - Reducir frequency de scans temporalmente
4. Resume cuando Binance ok: `/api/admin/autotrade/resume-all`

**Timing esperado:** 15 min - 2h según Binance.

---

### B. Motor da resultados anómalos (PF live << backtest)

**Síntomas:**
- Win rate live 30% cuando backtest dice 70%
- DD creciendo rápido
- Users reportando pérdidas

**Respuesta:**
1. PAUSE AUTOTRADE GLOBAL inmediato
2. Verificar data feeds:
   - `/api/macro/spx` respondiendo? (SPX filter)
   - Funding rates de Binance correctos?
   - Klines frescos?
3. Revisar últimos 100 trades en `broker_trade_log`:
   ```sql
   SELECT symbol, side, entry_price, tp_price, sl_price, pnl, status, created_at
   FROM broker_trade_log
   WHERE created_at > NOW() - INTERVAL '24 hours'
   ORDER BY created_at DESC LIMIT 100;
   ```
4. Identificar patrón (ej: todos los BUYs de BTC perdiendo, funding carry invertido)
5. Si es bug del engine: fix + deploy + soft-relaunch con capital reducido
6. Si es régimen de mercado adverso: notificar users, dejar pausado 24-48h

**Post-mortem obligatorio.**

---

### C. Usuario reporta pérdida grande inesperada

**Respuesta:**
1. Obtener del user:
   - Código license (RX-VIP-XXXX)
   - Timestamp aprox del trade
   - Monto esperado vs actual
2. Query DB:
   ```sql
   SELECT * FROM broker_trade_log
   WHERE key_id = (SELECT id FROM license_keys WHERE code = 'RX-VIP-XXXX')
   ORDER BY created_at DESC LIMIT 20;
   ```
3. Cross-reference con Binance (user debe dar acceso temporal o API key readonly)
4. Determinar causa:
   - Slippage alto? → revisar mercado en ese momento
   - TP/SL no colocaron? → bug del broker.js
   - Safety gate bypass? → bug frontend
   - User overrode algo? → review audit logs
5. Si es bug nuestro: reembolso + disclosure público
6. Si es mercado: comunicar honestamente, no reembolso pero apoyo

**Siempre comunicar al usuario dentro de 24h.**

---

### D. Ataque DDoS

**Síntomas:**
- CPU/memoria del servidor al 100%
- Render/Netlify alerting
- Response times >10s

**Respuesta:**
1. Render: aumentar instances temporalmente
2. Cloudflare (si está frente): enable "Under Attack Mode"
3. Identificar IP patterns en logs → blacklist
4. Si persiste: aplicar reglas más agresivas en rate limiter
5. Comunicar users en status page

---

### E. Data breach / secrets leak

**Respuesta INMEDIATA:**
1. KILL SWITCH autotrade global
2. Rotar TODOS los secrets en el siguiente orden:
   - `ADMIN_SECRET` (afecta backend admin endpoints)
   - `JWT_SECRET` (invalida todas las sesiones — users tendrán que re-login)
   - `BROKER_MASTER_KEY` (afecta encryption de Binance keys guardadas)
   - `STRIPE_WEBHOOK_SECRET`, `MP_WEBHOOK_SECRET`, `NOWPAYMENTS_IPN_SECRET`
   - DB password (Supabase)
3. Purgar secrets leakados del git si fue commiteado: `git filter-repo`
4. Notificar users en <72h (GDPR Article 34 requisito)
5. Desconectar todos los brokers: endpoint `/api/admin/broker/disconnect-all`
6. Users deben reconectar con nuevas keys Binance + regenerar licencias

**Post-incident:**
- Transparency report a users
- Legal: si hubo exposición PII, notificar a autoridad regulatoria (DPA si EU)
- Password reset campaign

---

### F. Deploy rompió producción (bug crítico)

**Respuesta:**
1. Rollback inmediato (ver Kill Switch #3)
2. Confirmar rollback funcionó: `curl /health → ok:true`
3. Abrir GitHub issue con bug report
4. NO re-deployar hasta tener fix + test
5. Post-mortem del proceso de deploy (¿por qué no se detectó en staging?)

---

### G. Account takeover / suspicious activity

**Síntomas:**
- User reporta no poder acceder
- Trades ejecutados que el user no reconoce
- Broker disconnected sin acción del user

**Respuesta:**
1. Revisar audit logs:
   ```sql
   SELECT * FROM audit_log
   WHERE actor = 'user' AND details LIKE '%keyId=XX%'
   ORDER BY created_at DESC LIMIT 50;
   ```
2. Identificar patrón:
   - IPs nuevas/raras
   - User-Agents distintos
   - Timestamps 3am cuando user no opera
3. Si sospechoso:
   - Revocar license temporalmente
   - Forzar re-activación con 2FA (manual por ahora)
   - Notificar user por email
4. Si confirma takeover:
   - Revocar license permanente
   - Emitir license nueva
   - Investigar vector (phishing? XSS?)

---

## Comunicación con users durante incidentes

**Templates:**

### Template A — Pausa autotrade
```
🛑 Aviso importante
Autotrading RX PRO pausado temporalmente por [razón].
Tus posiciones abiertas siguen activas con TP/SL en Binance.
Estimamos resumir en [X horas].
Actualización en rxtrading.net/status
```

### Template B — Maintenance window
```
🔧 Mantenimiento programado
RX PRO realizará mantenimiento el [fecha] de [HH:MM] a [HH:MM] UTC.
Durante esa ventana:
- Autotrading pausado
- VIP zone no disponible
- Trades abiertos no afectados (TP/SL en Binance)
```

### Template C — Data breach (¡template completo por compliance!)
```
Asunto: Aviso importante sobre seguridad de tu cuenta RX PRO

[Texto legal completo según GDPR Art. 34 — redactar con counsel]
```

---

## Monitoreo continuo

### Alertas críticas (atender en <15 min)
- `/health` fail >2 min consecutivos
- Error rate >10% en últimos 5 min
- Webhook payment success rate <90% en 1h
- DB connection pool >90%
- Circuit breaker triggered en >5% users simultáneamente

### Alertas high (atender en <1h)
- p95 latency >5s
- Rate limit 429 >100 requests/min (posible ataque)
- Sentry error spike (>50 errors en 10min)
- Binance reconnection retries >3 consecutivos

### Alertas medium (atender en <24h)
- Orphaned positions detectadas
- Trade reconciliation discrepancies
- `/api/broker/listen-key/keepalive` fails
- User churn spike

---

## Post-mortem template

Después de cada incidente severo, escribir post-mortem:

```markdown
# Post-mortem: [Título]
**Fecha:** YYYY-MM-DD
**Duración:** HH:MM — HH:MM
**Impacto:** [users afectados, pérdida $$, downtime]

## Timeline
- HH:MM — Detection (¿quién / cómo?)
- HH:MM — Response start
- HH:MM — Mitigation
- HH:MM — Resolution
- HH:MM — Full recovery

## Root cause
[Análisis técnico]

## Qué funcionó
- ...

## Qué no funcionó
- ...

## Action items
- [ ] Fix #1
- [ ] Improvement #2
- [ ] Runbook update #3
```

Guardar en `/audit/post-mortems/YYYY-MM-DD-titulo.md`.

---

## Logs & forensics

Para cualquier incidente, capturar ASAP:

```bash
# Render logs (últimas 6h)
render logs --tail 6h > /tmp/render-logs-$(date +%Y%m%d-%H%M).log

# DB audit log últimas 24h
psql $DATABASE_URL -c "COPY (SELECT * FROM audit_log WHERE created_at > NOW() - INTERVAL '24 hours') TO STDOUT WITH CSV" > /tmp/audit-$(date +%Y%m%d).csv

# Broker trade log últimas 24h
psql $DATABASE_URL -c "COPY (SELECT * FROM broker_trade_log WHERE created_at > NOW() - INTERVAL '24 hours') TO STDOUT WITH CSV" > /tmp/trades-$(date +%Y%m%d).csv
```

Guardar en storage seguro (cifrado) por mínimo 90 días para forensics.

---

## Checklist reactivo (imprimí y tené a mano)

```
[ ] Identificar severidad: ¿pérdida financiera activa?
[ ] Si sí: KILL SWITCH autotrade
[ ] Communicate a users (banner UI + email si aplica)
[ ] Abrir war-room (Discord/Slack)
[ ] Capturar logs + DB snapshots (forensics)
[ ] Root cause analysis
[ ] Mitigate / fix / rollback
[ ] Verify resolution (`/health`, user test)
[ ] Resume gradual (monitoreo agresivo 24h)
[ ] Post-mortem writeup
[ ] Comunicación final a users (disclosure)
[ ] Update runbooks con lessons learned
```

---

## Mantener este playbook

Revisar cada trimestre. Actualizar cuando:
- Hay un incidente nuevo no cubierto aquí
- Cambia infraestructura (nuevo provider, nuevo endpoint)
- Cambia la regulación aplicable
- Cambia el equipo de oncall

**Próxima revisión:** 2026-07-22 (3 meses).
