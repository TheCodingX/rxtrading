# SMOKE TESTS — E2E Flows (Área 9)
**Fecha:** 2026-04-22
**Status:** ⏸️ **PENDIENTE EJECUCIÓN** — bloqueado hasta fix CRÍTICOS

Los smoke tests NO se ejecutaron en este pass. Por política, los flows E2E se ejecutan **después** de cerrar los CRÍTICOS identificados en `PRE-DEPLOY-AUDIT-REPORT.md`, porque:

1. Un flow E2E que pasa con 184 XSS abiertos da falsa confianza
2. Los secrets en git invalidan cualquier testing en prod
3. Legacy engine accesible vía DevTools puede hacer pasar smoke tests con motor equivocado

## Checklist de smoke tests a ejecutar post-fixes

### 9.1 FREE user flow
- [ ] Abrir rxtrading.net en ventana incógnito
- [ ] Verificar landing carga <2.5s (LCP)
- [ ] Click "Enter Dashboard" o "Open Platform"
- [ ] Verificar no se redirige a VIP automáticamente
- [ ] Probar modo FREE: señales aparecen
- [ ] Backtest interactivo con engine FREE ejecuta
- [ ] No hay errores en console
- [ ] Cookie banner aparece y aceptar no re-dispara

**Criterio pass:** Usuario FREE puede usar demo sin errores, sin pedir license, sin exponer VIP features.

---

### 9.2 VIP signup flow (con test mode si existe, o mock)
- [ ] Landing → Pricing → elegir plan 1 mes
- [ ] Click "Buy" → checkout redirect
- [ ] Verificar URL de checkout coincide con whitelist (stripe/mp/nowpayments)
- [ ] En test mode: completar checkout con test card
- [ ] Webhook recibido en backend (verificar logs)
- [ ] License generada en DB (SELECT * FROM license_keys WHERE ...)
- [ ] Email de delivery enviado
- [ ] Usuario recibe código RX-VIP-XXXXX
- [ ] Activar código en app: backend valida, emite JWT
- [ ] Welcome animation muestra
- [ ] VIP zone unlock

**Criterio pass:** Ciclo completo pago → key → VIP activo sin manual intervention.

---

### 9.3 VIP onboarding wizard
- [ ] Como VIP recién activado, entrar a app
- [ ] Wizard step 1 (capital input) aparece
- [ ] Ingresar $500 → warning "recomendado $1000+" visible
- [ ] Ingresar $2000 → checkmark verde, continuar desbloqueado
- [ ] Step 2 (expectativas): 4 stats cards count-up animan
- [ ] Step 3 (horizonte): 6 meses calendar aparece
- [ ] Step 4 (terms): obligatorio scroll hasta el final
- [ ] Step 5 (broker setup) si aplica: link a Binance
- [ ] API keys field acepta formato válido
- [ ] Conectar broker → `/api/broker/connect` → balance se muestra
- [ ] LS keys set: `rx_rt_onboarding_v1`, `rx_terms_accepted_v1`
- [ ] Broker badge testnet/mainnet correcto

**Criterio pass:** Flow completo onboarding sin skip posible del terms/capital warnings.

---

### 9.4 Autotrade flow (TESTNET ONLY primera vez)
- [ ] Con broker conectado en testnet
- [ ] Activar "Inteligente de Mercado" toggle
- [ ] Activar Autotrade Real
- [ ] Confirm dialog aparece (tipear "OPERAR REAL")
- [ ] Motor APEX corre scan cada X segundos
- [ ] Log de eventos muestra "esperando settlement window"
- [ ] Al llegar settlement hour (0/8/16 UTC ±30min): detecta funding extremo
- [ ] Signal aparece en UI + historical feed
- [ ] `/api/broker/place-order` dispara con engine='apex'
- [ ] Binance testnet recibe orden (verificar en Binance testnet UI)
- [ ] TP + SL orders se colocan
- [ ] Position aparece en Binance + en app
- [ ] Cuando TP/SL hit: position cierra
- [ ] PnL reporta en UI + DB trade_log
- [ ] Stats del período (7d/30d/60d/120d) se actualizan
- [ ] `apexSafetyRecordTrade` se llama

**Criterio pass:** Trade completo ejecuta sin intervención y datos coinciden entre Binance y app.

---

### 9.5 Safety trigger flows

#### 5 losses → circuit breaker
- [ ] Manualmente inyectar 5 losses via `/api/broker/trade-result` (admin endpoint con test flag)
- [ ] Verificar `consecutive_losses = 5` en DB
- [ ] Verificar `circuit_breaker_until` set a +6h
- [ ] Próximo intento de autotrade: bloqueado con reason "circuit_breaker"
- [ ] Banner UI visible "Circuit breaker activo hasta HH:MM"
- [ ] Notif al admin enviado

#### DD 25% peak
- [ ] Reset stats. Simular equity peak $10k
- [ ] Inyectar losses hasta equity $7.5k (25% DD)
- [ ] Autotrade bloquea con reason "max_dd"
- [ ] Usuario no puede reanudar sin admin override

#### Daily loss 5%
- [ ] Reset stats. Balance $10k
- [ ] Inyectar losses hasta -$500 en el día UTC
- [ ] Próximo trade: bloqueado
- [ ] Al día siguiente UTC: reset automático

**Criterio pass:** Los 3 gates disparan en los umbrales correctos y el estado persiste entre page refreshes.

---

### 9.6 Backtest interactivo
- [ ] VIP zone → sección Backtest Interactivo
- [ ] Selector de período: 7d / 30d / 60d / 120d
- [ ] Selector engine: APEX / FREE (no v42)
- [ ] Click "Ejecutar Backtest"
- [ ] Loading state visible
- [ ] Resultados coinciden con stats advertidos (PF, WR, DD, PnL)
- [ ] Equity curve se dibuja correctamente
- [ ] Export CSV funciona (si aplica)

**Criterio pass:** Backtest es determinista (misma data → mismos resultados) y coincide ±2% con stats del motor card.

---

### 9.7 Emergency pause flow
- [ ] Admin ejecuta `POST /api/admin/autotrade/pause-all` con ADMIN_SECRET
- [ ] Todos los usuarios VIP pausados en DB
- [ ] En UI: banner rojo "Autotrading pausado por administrador"
- [ ] Usuario no puede "Resume" — botón disabled
- [ ] Admin ejecuta `POST /api/admin/autotrade/resume-all` → todos reanudan
- [ ] Log admin audit muestra la acción con timestamp + admin ID

**Criterio pass:** Pause global efectivo en <30s; resume restaura sin inconsistencias.

---

### 9.8 Session timeout / reauth
- [ ] Login con license key
- [ ] Esperar expiración JWT (o forzar con dev tool `Date.now()` mock)
- [ ] Próxima llamada a `/api/broker/status` devuelve 401
- [ ] Frontend detecta 401 + dispara `/api/keys/refresh` con cookie
- [ ] Refresh devuelve nuevo JWT
- [ ] Llamada reintenta y OK
- [ ] Usuario no ve nada (transparente)

**Criterio pass:** Refresh transparente sin romper UX.

---

### 9.9 Offline → online recovery
- [ ] Autotrade activo con 2 posiciones abiertas
- [ ] Desconectar network (devtools offline)
- [ ] Esperar 2 min
- [ ] Reconectar
- [ ] Reconciliation corre + detecta posiciones
- [ ] Estado sync con Binance (TP/SL siguen activos)
- [ ] Offline queue flush (si aplica)
- [ ] No trades duplicados

**Criterio pass:** Sin pérdida de estado ni trades duplicados al reanudar.

---

## Resumen

**Status actual:** ⏸️ **0/9 smoke tests ejecutados**
**Blocker:** CRÍTICOS sin resolver (ver `PRE-DEPLOY-AUDIT-REPORT.md`)

Los smoke tests se ejecutarán **después** del Día 4 de remediación, en `GO-NOGO-DECISION.md` se re-evalúa con los resultados.

Después de pasar los 9 flows (con testnet primero), soft-launch a 5-10 usuarios internos por 48h antes de abrir al público.
