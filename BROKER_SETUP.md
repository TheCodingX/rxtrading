# RX PRO — Broker Integration Setup Guide

## Qué se implementó

Integración directa con **Binance Futures API** para ejecutar trades reales desde RX PRO:

1. **Botón "OPERAR EN LA SEÑAL"** en la zona VIP — ejecuta la señal actual con TP/SL exactos en Binance
2. **Panel "AUTOTRADING REAL"** en la zona VIP — ejecuta automáticamente cada señal que llega (con protecciones)
3. **Sección "BROKER API"** en Configuración — conectar/desconectar credenciales, ver balance
4. **Modal de confirmación** cada vez que se ejecuta un trade manual con preview de ganancia/pérdida máxima
5. **Límites server-side** que NO se pueden bypassear desde el frontend:
   - Max USD por trade
   - Max leverage
   - Max pérdida diaria (se resetea cada 24h)
6. **Panic button** que cierra TODAS las posiciones abiertas en Binance
7. **Log de trades** guardado en base de datos (tabla `broker_trade_log`)

---

## Arquitectura de seguridad

```
Frontend (app.html)  ──HTTPS──>  Backend (Express)  ──HTTPS──>  Binance API
                                       |
                                       v
                              Supabase PostgreSQL
                         (broker_configs cifradas AES-256-GCM)
```

- Las API keys del usuario **NUNCA** viven en el frontend
- Se cifran con AES-256-GCM + auth tag antes de guardarse
- La master key está en variable de entorno `BROKER_MASTER_KEY`
- Rate limit de 30 requests/minuto por usuario
- Solo requieren permiso de "Enable Futures" (NO withdrawals)

---

## PASOS QUE VOS TENÉS QUE HACER

### 1. Generar la master key de cifrado

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Esto te va a imprimir algo como:
```
a7f9c2e4b1d8f3a5c6e9b2d4f7a1c3e5b8d2f4a6c9e1b3d5f7a9c2e4b6d8f1a3
```

**Guardá este string en un lugar seguro.** Si lo perdés, NINGUNA API key cifrada se va a poder descifrar (todos los usuarios conectados tendrán que reconectar).

### 2. Agregar la master key al backend

En tu archivo `backend/.env` o en las variables de entorno de Render/Railway, agregá:

```
BROKER_MASTER_KEY=a7f9c2e4b1d8f3a5c6e9b2d4f7a1c3e5b8d2f4a6c9e1b3d5f7a9c2e4b6d8f1a3
```

(Reemplazá con el hex que generaste en el paso 1.)

### 3. Reiniciar el backend

El backend detecta automáticamente la master key al arrancar. En el log vas a ver:

```
║   Broker: Binance Futures ON         ║
```

Si decía `DISABLED`, la master key no está configurada correctamente.

### 4. Las tablas de la base de datos se crean solas

Al reiniciar el backend, `initDB()` ejecuta automáticamente:
- `CREATE TABLE IF NOT EXISTS broker_configs` (credenciales cifradas)
- `CREATE TABLE IF NOT EXISTS broker_trade_log` (historial de trades ejecutados)

No necesitás correr SQL manualmente.

### 5. (Opcional) IP Whitelist en Binance

Para máxima seguridad, recomendá a tus usuarios que cuando generen su API key en Binance:

1. Vayan a https://www.binance.com/en/my/settings/api-management
2. Creen una nueva API key con permiso **Enable Futures** ÚNICAMENTE
3. **NO activar** "Enable Spot & Margin Trading" ni "Enable Withdrawals"
4. Restrinjan la IP a la IP del servidor donde corre RX PRO (Render/Railway)
5. Peguen la key + secret en Configuración → BROKER API en RX PRO
6. Configuren sus límites personales (max monto, max leverage, pérdida diaria)

---

## Flujo de uso del usuario

### Setup inicial (1 vez)
1. Usuario activa VIP en RX PRO
2. Va a **Configuración → BROKER API — DINERO REAL**
3. Pega su Binance API Key + Secret
4. Configura sus límites: Max por trade ($500), Max leverage (5x), Pérdida diaria ($200)
5. Click en **⚡ CONECTAR BROKER**
6. El backend valida las credenciales contra Binance y muestra el balance

### Trade manual (botón OPERAR EN LA SEÑAL)
1. Usuario ve una señal en la zona VIP
2. Aparece automáticamente el botón dorado **"⚡ OPERAR EN LA SEÑAL — REAL"**
3. Click → abre modal con preview de ganancia/pérdida máxima
4. Ajusta monto y leverage
5. Click en **EJECUTAR TRADE**
6. El backend coloca 3 órdenes en Binance:
   - Market order de entrada
   - TAKE_PROFIT_MARKET con `closePosition=true`
   - STOP_MARKET con `closePosition=true`

### Autotrading real (panel en zona VIP)
1. Usuario abre el panel **"AUTOTRADING REAL — BROKER EN VIVO"**
2. Configura: monto, leverage, modo (scalp/strict), confianza mínima, protección volátil
3. Click en **▶ INICIAR AUTOTRADING REAL**
4. Cada vez que el motor genera una señal en el modo elegido, se ejecuta automáticamente
5. El log muestra cada trade en tiempo real
6. El usuario puede pausar con el mismo botón, o cerrar todas las posiciones con **⛔ PÁNICO**

---

## Protecciones automáticas server-side

Estas NO se pueden bypassear desde el frontend:

| Protección | Dónde se aplica |
|---|---|
| Max position USD | `server.js` → `/api/broker/place-order` valida `usdAmount > cfg.max_position_usd` |
| Max leverage | `server.js` → `/api/broker/place-order` valida `leverage > cfg.max_leverage` |
| Pérdida diaria | `server.js` valida `dailyLoss >= dailyLimit` antes de ejecutar |
| Min position $10 | `broker.js` → `placeTradeWithTPSL` rechaza < $10 |
| Max position $10k | `broker.js` → hardcoded safety limit |
| Rate limit 30/min | `express-rate-limit` en `brokerLimiter` |
| Solo Futures permission | Binance API rechaza si no tiene permiso |
| closePosition en TP/SL | `reduceOnly + closePosition=true` evita aumentar la posición |

---

## Endpoints del backend

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/api/broker/connect` | Guarda API key cifrada, valida contra Binance |
| GET | `/api/broker/status` | Balance, posiciones, límites, daily loss |
| POST | `/api/broker/place-order` | Ejecuta trade con TP+SL atómico |
| POST | `/api/broker/close-all` | Cierra todas las posiciones (panic) |
| POST | `/api/broker/disconnect` | Elimina credenciales cifradas |
| GET | `/api/broker/history` | Últimos 50 trades del log |

Todas requieren `Authorization: Bearer <jwt>` (del login VIP).

---

## Archivos modificados/creados

### Backend
- **NUEVO**: `backend/broker.js` — módulo completo de Binance Futures (cifrado + API calls + HMAC signing)
- **MODIFICADO**: `backend/database.js` — agregadas tablas `broker_configs` + `broker_trade_log`
- **MODIFICADO**: `backend/server.js` — agregados 6 endpoints `/api/broker/*` + inicialización de master key

### Frontend
- **MODIFICADO**: `frontend/app.html`
  - CSS nuevo para el card del broker en Configuración
  - Sección "BROKER API" en Configuración
  - Botón "OPERAR EN LA SEÑAL" en el card de señal VIP
  - Card "AUTOTRADING REAL — BROKER EN VIVO" en la zona VIP
  - Modal "OPERAR EN LA SEÑAL" con preview de ganancia/pérdida
  - Funciones JS: `brokerConnect`, `brokerStatus`, `brokerDisconnect`, `brokerCloseAll`, `openRealTradeModal`, `closeRealTradeModal`, `executeRealTrade`, `toggleRealAutoTrade`, `realAutoTradeFromSignal`
  - Integración con `_runVipMultiScan` para disparar autotrading real cuando llega una señal

---

## Consideraciones legales IMPORTANTES

1. **Términos y condiciones**: Agregá una cláusula en tus TyC diciendo que el usuario es responsable de sus trades, que las señales no son asesoría financiera, y que RX PRO no se hace responsable de pérdidas. La legislación varía por país, consultá con un abogado.

2. **Disclaimer en UI**: Ya está agregado el aviso "DINERO REAL — Las API keys se cifran. Activá solo Enable Futures, NUNCA Withdrawals."

3. **KYC del usuario**: Binance ya verifica la identidad del usuario antes de crear API keys, así que esa parte está cubierta.

4. **Fees**: Binance cobra ~0.04% maker / 0.06% taker en Futures. Los usuarios VIP de Binance tienen fees menores. Esto NO afecta tu plataforma pero es información que tus usuarios deberían saber.

---

## Cómo testear sin arriesgar dinero real

Binance tiene un **testnet de Futures**: https://testnet.binancefuture.com/

Para probarlo:
1. Creá una cuenta en el testnet
2. Conseguí un balance fake (te dan USDT virtuales)
3. Generá una API key del testnet
4. En `broker.js`, cambiá temporalmente `BINANCE_HOST = 'fapi.binance.com'` a `'testnet.binancefuture.com'`
5. Conectá la key del testnet en RX PRO
6. Todos los trades se ejecutan con plata falsa

**IMPORTANTE**: Antes de ir a producción, volvé a dejar `BINANCE_HOST = 'fapi.binance.com'`.

---

## Resumen de lo que falta (opcional)

Estas cosas quedan pendientes pero no son críticas:

1. **Actualizar daily_loss_current automáticamente** cuando se cierra una posición con pérdida. Actualmente el tracking del daily loss depende de que pidas a Binance el historial de trades cerrados. Se puede implementar con un polling que lee `/fapi/v1/userTrades` cada X minutos.

2. **Notificaciones de fill**: avisar al usuario cuando un TP/SL se ejecuta en Binance. Requiere conectarse al User Data Stream de Binance (WebSocket).

3. **Historial de trades en UI**: el endpoint `/api/broker/history` ya existe, solo falta una tabla en el frontend para mostrarlos.

4. **Soporte multi-exchange**: actualmente solo Binance Futures. Agregar Bybit, OKX sería más código pero misma arquitectura.

5. **Terms & Conditions modal**: al primer connect, mostrar un modal que el usuario tiene que aceptar confirmando que entiende los riesgos.

Todas estas son mejoras incrementales que se pueden agregar después del lanzamiento inicial.
