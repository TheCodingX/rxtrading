# Deployment Guide

## Render (Backend)

1. **Create Web Service** from GitHub repo, directory `backend/`
2. **Build command:** `npm install`
3. **Start command:** `npm start`
4. **Environment variables** (copy from `.env.example`):
   - `JWT_SECRET` (required, ≥32 chars high entropy)
   - `DATABASE_URL` (required, Render Postgres addon)
   - `BROKER_MASTER_KEY` (required in prod, for encrypt broker API keys)
   - `NODE_ENV=production`
   - `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
   - `MP_ACCESS_TOKEN` + `MP_WEBHOOK_SECRET`
   - `NOWPAYMENTS_API_KEY` + `NOWPAYMENTS_IPN_SECRET`
   - `ADMIN_SECRET`
   - `CORS_ORIGIN=https://rxtrading.net`
5. **Add PostgreSQL addon** — Render auto-injects `DATABASE_URL`
6. **Deploy** — first boot runs migrations automatically (idempotent `ALTER TABLE IF NOT EXISTS`)
7. **Verify** — hit `/health` endpoint, must return `{ok: true, checks: {db: true, jwt: true}}`

## Netlify (Frontend)

1. **New site from Git** — directory `frontend/`
2. **Build command:** none (static)
3. **Publish directory:** `frontend/`
4. **Deploy**

## Webhooks (one-time setup)

### Stripe
- Dashboard → Developers → Webhooks → Add endpoint
- URL: `https://your-backend.onrender.com/api/webhooks/stripe`
- Events: `checkout.session.completed`
- Copy signing secret → `STRIPE_WEBHOOK_SECRET` env var

### MercadoPago
- Dashboard → Webhooks → Add webhook
- URL: `https://your-backend.onrender.com/api/webhooks/mercadopago`
- Events: `payment`
- Copy secret → `MP_WEBHOOK_SECRET`

### NOWPayments
- Dashboard → Settings → IPN
- URL: `https://your-backend.onrender.com/api/webhooks/nowpayments`
- Copy IPN secret → `NOWPAYMENTS_IPN_SECRET`

## Switch testnet ↔ mainnet

**Testnet:** set `BINANCE_TESTNET=true` in Render env vars + redeploy.
**Mainnet:** unset (or `BINANCE_TESTNET=false`) + redeploy.

Users must connect with corresponding API keys (testnet.binancefuture.com vs binance.com).

## Rollback

1. Render → Deploys tab → previous successful deploy → "Rollback to this deploy"
2. DB migrations are idempotent and forward-only (never drop columns)

## V44 Server-side Signals Scheduler

The backend runs `v44-engine.js` as an internal scheduler (no external cron). It wakes on server start and scans the 15-pair universe every 10 minutes, filtering by UTC settlement windows (PRE/MID/POST of 00/08/16 UTC). Signals are stored in memory and exposed via `GET /api/public-signals`.

**Keep server awake on Render Free tier:** configure UptimeRobot (or equivalent) to ping `https://your-backend.onrender.com/health` every 5 minutes. Render puts free instances to sleep after 15 minutes of idle; this keeps the scheduler running 24/7.

## Pre-deploy checklist

- [ ] `node --check backend/server.js && node --check backend/broker.js && node --check backend/v44-engine.js`
- [ ] `cd backend && npm audit --audit-level=high` → 0 vulnerabilities
- [ ] All required env vars set in Render dashboard (list in README)
- [ ] Webhook secrets set for production (server refuses to boot without them if `NODE_ENV=production`)
- [ ] UptimeRobot configured to ping `/health` every 5 min
- [ ] `BROKER_MASTER_KEY` backed up securely (rotation = all user API keys must be re-encrypted)
- [ ] Netlify serves `index.html` — verify it matches `landing.html` latest state
- [ ] `git tag backup-v42pro-plus` pushed (legacy engine backup before V44 migration)
