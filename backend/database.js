const { Pool } = require('pg');

// SSL: use Render/Heroku CA (rejectUnauthorized:true if proper cert chain available)
// Override via DB_SSL_STRICT=true in env if managed DB has valid cert
const sslConfig = process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: process.env.DB_SSL_STRICT === 'true' }
  : false;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
  max: parseInt(process.env.DB_POOL_MAX || '10'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000, // 30s query timeout (prevents hanging queries)
  query_timeout: 30000
});
// Global error handler (prevent crash on idle client errors)
pool.on('error', (err) => { console.error('[DB Pool] Unexpected error:', err.message); });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS license_keys (
      id SERIAL PRIMARY KEY,
      key_code TEXT UNIQUE NOT NULL,
      key_hash TEXT NOT NULL,
      owner_name TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ DEFAULT NULL,
      max_activations INTEGER DEFAULT 1,
      is_revoked INTEGER DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activations (
      id SERIAL PRIMARY KEY,
      key_id INTEGER NOT NULL REFERENCES license_keys(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      user_agent TEXT DEFAULT '',
      ip_address TEXT DEFAULT '',
      activated_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW(),
      is_active INTEGER DEFAULT 1
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      payment_id TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      amount_usd NUMERIC(10,2),
      email TEXT DEFAULT '',
      customer_name TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      key_code TEXT DEFAULT NULL,
      provider_ref TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ DEFAULT NULL
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_key_code ON license_keys(key_code)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activation_key ON activations(key_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activation_fp ON activations(fingerprint)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_id ON payments(payment_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payment_status ON payments(status)`);

  // ══ VIP CLOUD SYNC — Paper Trading & Signal History ══
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_paper_data (
      id SERIAL PRIMARY KEY,
      key_id INTEGER NOT NULL REFERENCES license_keys(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(key_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_signal_history (
      id SERIAL PRIMARY KEY,
      key_id INTEGER NOT NULL REFERENCES license_keys(id) ON DELETE CASCADE,
      data JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(key_id)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_paper_key ON user_paper_data(key_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_sighist_key ON user_signal_history(key_id)`);

  // ══ BROKER INTEGRATION — Encrypted API keys per VIP user ══
  await pool.query(`
    CREATE TABLE IF NOT EXISTS broker_configs (
      id SERIAL PRIMARY KEY,
      key_id INTEGER NOT NULL REFERENCES license_keys(id) ON DELETE CASCADE,
      exchange TEXT NOT NULL DEFAULT 'binance_futures',
      api_key_enc TEXT NOT NULL,
      api_secret_enc TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      max_position_usd NUMERIC(10,2) DEFAULT 500,
      max_leverage INTEGER DEFAULT 10,
      daily_loss_limit_usd NUMERIC(10,2) DEFAULT 200,
      daily_loss_current NUMERIC(10,2) DEFAULT 0,
      daily_reset_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_used TIMESTAMPTZ DEFAULT NULL,
      UNIQUE(key_id, exchange)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS broker_trade_log (
      id SERIAL PRIMARY KEY,
      key_id INTEGER NOT NULL REFERENCES license_keys(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      usd_amount NUMERIC(10,2),
      leverage INTEGER,
      entry_price NUMERIC(20,8),
      tp_price NUMERIC(20,8),
      sl_price NUMERIC(20,8),
      binance_order_id TEXT,
      status TEXT DEFAULT 'placed',
      error_msg TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_broker_key ON broker_configs(key_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_broker_log_key ON broker_trade_log(key_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_broker_log_created ON broker_trade_log(created_at)`);

  // ══ MIGRATIONS — idempotent column additions for v42 safety features ══
  // These ALTER TABLE ADD COLUMN IF NOT EXISTS statements run on every boot and are no-ops if columns exist
  const migrations = [
    // Circuit breaker tracking
    `ALTER TABLE broker_configs ADD COLUMN IF NOT EXISTS consecutive_losses INTEGER DEFAULT 0`,
    `ALTER TABLE broker_configs ADD COLUMN IF NOT EXISTS circuit_breaker_until TIMESTAMPTZ DEFAULT NULL`,
    // Concurrent position + capital deployment limits
    `ALTER TABLE broker_configs ADD COLUMN IF NOT EXISTS max_concurrent_positions INTEGER DEFAULT 4`,
    `ALTER TABLE broker_configs ADD COLUMN IF NOT EXISTS max_capital_deployed_pct NUMERIC(5,2) DEFAULT 50`,
    // Session token for payment verification
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS session_token TEXT DEFAULT NULL`,
    // Soft-delete support
    `ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS is_deleted INTEGER DEFAULT 0`,
    // Audit timestamps
    `ALTER TABLE broker_configs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`,
    // Refresh token rotation support
    `ALTER TABLE activations ADD COLUMN IF NOT EXISTS refresh_token_version INTEGER DEFAULT 1`,
    // Index for refresh token version lookups
    `CREATE INDEX IF NOT EXISTS idx_activations_fp_ver ON activations(fingerprint, refresh_token_version DESC)`,
    // Recovery tokens for account recovery via email
    `CREATE TABLE IF NOT EXISTS recovery_tokens (id SERIAL PRIMARY KEY, email TEXT NOT NULL, token TEXT UNIQUE NOT NULL, used INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '1 hour')`,
    `CREATE INDEX IF NOT EXISTS idx_recovery_token ON recovery_tokens(token)`,
    `CREATE INDEX IF NOT EXISTS idx_recovery_email ON recovery_tokens(email)`,
    // Audit log immutable table
    `CREATE TABLE IF NOT EXISTS audit_log (id SERIAL PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, meta JSONB, ip TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor)`,
    // Indices para performance
    `CREATE INDEX IF NOT EXISTS idx_license_keys_key_code ON license_keys(key_code)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_payment_id ON payments(payment_id)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)`,
    `CREATE INDEX IF NOT EXISTS idx_activations_key_id ON activations(key_id)`
  ];
  for (const sql of migrations) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.warn('[Migration] Skipped (may be unsupported feature):', err.message.slice(0, 100));
    }
  }
  console.log('[DB] Migrations applied (safety columns + indices)');
}

module.exports = { pool, initDB };
