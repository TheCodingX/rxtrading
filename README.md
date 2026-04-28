# RX Trading

Plataforma de señales algorítmicas para Binance Futures. Paper trading, autotrading real y feed público de señales 24/7.

## Motores

Solo existen **dos** motores de señales:

| Motor | Acceso | Estrategia | Métricas validadas |
|---|---|---|---|
| **CORE Engine** | Gratis (modo `frequent`) | Momentum + mean-reversion básico · 4 pares | Entrada para probar la plataforma |
| **APEX Engine v44** | VIP (modo `strict` / `binance`) | Funding Carry · z-sizing + multi-window + quality filter top 40% + 3x leverage + compounding · 15 pares | **PF 1.81 · WR 73.5% · DD 4.58% · Holdout OOS 365d · +436% PnL · 0 liquidaciones · 4/4 stress tests pass** |

**Universo APEX v44 (15 pares):** ADA, RENDER, ARB, ETH, XRP, BTC, 1000PEPE, ATOM, LINK, POL, SOL, SUI, TRX, NEAR, INJ.

## Stack

- **Frontend:** HTML/JS vanilla (Netlify). Archivos: `frontend/app.html`, `landing.html`, `index.html`, `privacy.html`, `terms.html`, `cookies.html`, `refund.html`.
- **Backend:** Node.js 18+ / Express (Render). Archivos: `backend/server.js`, `backend/v44-engine.js` (scheduler 24/7), `backend/broker.js` (Binance Futures).
- **Base de datos:** PostgreSQL (Supabase).
- **Pagos:** Stripe + MercadoPago + NOWPayments (crypto).

## Feed público 24/7

El backend corre `v44-engine.js` como scheduler (cada 10 min) que escanea los 15 pares dentro de ventanas UTC de settlement (00, 08, 16 ± 1h). Señales se publican en `GET /api/public-signals`. El frontend hace polling cada 30s. No depende de usuarios activos — UptimeRobot mantiene el server despierto.

## Quick start

```bash
# Backend
cd backend
cp .env.example .env    # editar con tus keys
npm install
npm start               # puerto 3001

# Frontend (dev local)
cd ../frontend
python3 -m http.server 8080
```

Producción: `https://rxtrading.net` (frontend en Netlify) → `https://rxtrading-1.onrender.com` (backend en Render).

## Env vars requeridas

Ver `backend/.env.example`. Críticas:

- `JWT_SECRET` (32+ chars, alta entropía)
- `ADMIN_SECRET` (32+ chars)
- `DATABASE_URL` (Supabase pooler)
- `BROKER_MASTER_KEY` (encripción AES-256 de API keys de Binance)
- `CORS_ORIGIN=https://rxtrading.net`

Opcionales (pero recomendadas): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`.

## Documentación

- [DEPLOYMENT.md](./DEPLOYMENT.md) — deploy a Render + Netlify
- [OPERATIONS.md](./OPERATIONS.md) — runbook operativo
- [SECURITY.md](./SECURITY.md) — modelo de amenazas y mitigaciones
- [BROKER_SETUP.md](./BROKER_SETUP.md) — conexión Binance Futures mainnet/testnet

## Backups

El motor legacy **V42 PRO+** (funcional hasta 2026-04-23) está archivado en `backups/v42-pro-plus/` con tag git `backup-v42pro-plus`. **No usar en producción.** Referencia histórica únicamente.

## Disclaimer legal

El trading con dinero real conlleva riesgo de pérdida total. APEX Engine v44 es un sistema de señales algorítmicas validado sobre backtest OOS 365d. **El rendimiento pasado no garantiza resultados futuros.** Costos reales (fees, slippage, funding) reducen el PnL neto vs el backtest. Recomendamos comenzar con capital pequeño ($100–500) y/o testnet mainnet antes de escalar.

## License

Proprietary · RX Trading · 2026.
