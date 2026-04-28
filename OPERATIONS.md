# Operations Runbook

## Health Checks

```bash
# Basic health
curl https://rxtrading-1.onrender.com/health

# Expected (healthy):
# {"ok":true,"checks":{"db":true,"jwt":true,"broker_keys":true},"mode":"mainnet","uptime":12345,...}

# Expected (unhealthy):
# {"ok":false,"checks":{"db":false,...}}  → HTTP 503
```

## Metrics (admin)

```bash
curl -H "x-admin-secret: YOUR_ADMIN_SECRET" \
     https://rxtrading-1.onrender.com/api/admin/metrics

# Returns: memory (rss/heap), pool stats (total/idle/waiting), uptime, platform
```

## Logs

All logs are structured JSON (stdout, captured by Render):

```json
{"ts":"2026-04-20T21:34:56.123Z","level":"error","msg":"[Broker] place-order error","reqId":"a1b2c3d4","keyId":42,"service":"rxtrading-backend"}
```

Grep for specific request trace: filter by `reqId`.

## Common Operations

### Rotate JWT_SECRET
1. Generate new: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Update Render env var
3. Redeploy
4. All users must re-login (expected)

### Rotate BROKER_MASTER_KEY (CAREFUL)
⚠️ This invalidates ALL encrypted broker API keys in DB. Users must reconnect their brokers.
1. Before rotation: announce maintenance window to users
2. Run migration: decrypt all broker_configs with old key, re-encrypt with new key
3. OR simpler: accept that users will reconnect (mark all broker_configs.is_active=0)

### Rotate webhook secrets
1. Stripe dashboard → Webhooks → regenerate
2. Update `STRIPE_WEBHOOK_SECRET` env var in Render
3. Redeploy (< 30s downtime)
4. Repeat for MP and NOWPayments

### Admin audit query
```sql
-- Last 24h admin actions
SELECT actor, action, target, meta, created_at
FROM audit_log
WHERE created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;
```

### Find user by email
```sql
SELECT payment_id, plan_id, status, completed_at
FROM payments
WHERE LOWER(email) = LOWER('user@example.com')
ORDER BY completed_at DESC;
```

### Revoke a license key
```bash
curl -X POST -H "x-admin-secret: ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"code":"RX-VIP-XXXXXXXXXXXX"}' \
  https://rxtrading-1.onrender.com/api/admin/keys/revoke
```

## Database

### Backup (Render managed Postgres)
- Render dashboard → Database → Backups tab → daily automated
- Point-in-time recovery: last 7 days (paid tier)

### Manual backup
```bash
pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql
```

### Apply migrations
Migrations run automatically on every boot via `initDB()` in `database.js`. All `ALTER TABLE ... IF NOT EXISTS` (idempotent, no rollback needed).

### Common queries
```sql
-- Active users (activations in last 7d)
SELECT COUNT(DISTINCT key_id) FROM activations WHERE last_seen > NOW() - INTERVAL '7 days';

-- Payments last 30d by provider
SELECT provider, COUNT(*), SUM(amount_usd)
FROM payments
WHERE status = 'completed' AND completed_at > NOW() - INTERVAL '30 days'
GROUP BY provider;

-- Trade log last 24h
SELECT COUNT(*), status
FROM broker_trade_log
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY status;
```

## Monitoring

### Key metrics to watch
- `/health` returning 503 → DB down, PagerDuty alert
- Memory > 80% of dyno limit → scale up
- DB pool waiting > 0 consistently → bump `DB_POOL_MAX`
- Error rate > 1% → check logs for `level:"error"`
- `audit_log` entries for `broker_auto_disconnect` → investigate

### Alerts to configure (Render + external)
- HTTP 500s > 1% of requests
- `/health` 503 for > 2 min
- Memory usage > 400MB sustained
- DB connection errors

## Incident Response

### "Users can't log in"
1. Check `/health` → DB status
2. Check Render logs for recent deploys / errors
3. Check JWT_SECRET env var not accidentally changed
4. Verify CORS_ORIGIN matches frontend domain

### "Trades failing"
1. Check `/api/broker/status` for user — if auto-disconnected, API key invalid
2. Check Binance status: https://www.binance.com/en/support/announcement
3. Check rate limit logs: `level:"warn"` with `[Binance] Transient error`
4. Verify exchangeInfo cache is fresh

### "Duplicate key codes generated"
1. Check `audit_log` for same `paymentId` in multiple webhooks
2. Verify `pg_advisory_xact_lock` is working
3. Check payment provider for duplicate webhook deliveries

## Scheduled Tasks (in-process)

| Task | Frequency | Location |
|------|-----------|----------|
| UTC daily loss reset | Every hour | `server.js` cron |
| Recovery tokens cleanup | Every hour | `server.js` cron |
| Audit log prune (>90d) | Every hour | `server.js` cron |
| **V44 signals scan** | **Every 10 min** | **`server.js` → `v44-engine.scanAllPairs()`** |

## V44 Engine Monitoring

```bash
# Inspect current signals feed
curl https://rxtrading-1.onrender.com/api/public-signals?limit=10

# Expected response:
# {
#   "signals": [...],         # last 10 signals (4h TTL each)
#   "count": N,
#   "last_scan": "2026-04-23T14:30:00.000Z",
#   "last_result": {"scanned":15, "signals_found":3, "window_type":"MID"},
#   "stats": {"totalScans":N, "totalSignals":M, "errors":0},
#   "universe": ["BTCUSDT", ...],
#   "server_time": 1730000000000
# }
```

**Healthy:** `last_result.reason === 'ok'` during UTC settlement windows (hours 23, 0, 1, 7, 8, 9, 15, 16, 17). Outside windows, `reason === 'outside_window'` is expected — not an error.

**Unhealthy signs:**
- `stats.errors` growing → Binance API unreachable, check network or rate limits
- `last_scan` older than 20 min → scheduler crashed, restart server
- `stats.totalSignals === 0` for 24h+ → market might be out of extreme funding regime (not a bug, but worth investigating)

## Legacy Engine Backups

- Git tag `backup-v42pro-plus` captures the V42 PRO+ engine state before V44 migration (2026-04-23)
- `/backups/v42-pro-plus/` contains snapshot HTML + models + backtests for reference
- V16/V40/V42 code paths are archived in `/archive/` (100+ backtest scripts, research files)

## Scaling Playbook

| Users | DB Pool | Dyno | Redis? |
|-------|---------|------|--------|
| 1-50 | 10 | Free | No |
| 50-200 | 20 | Starter | No |
| 200-1000 | 40 | Standard | Yes (rate limits + cache) |
| 1000+ | 80 | Pro + Read replica | Yes + load balancer |
