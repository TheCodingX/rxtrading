const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

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

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_key_code ON license_keys(key_code)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activation_key ON activations(key_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activation_fp ON activations(fingerprint)`);
}

module.exports = { pool, initDB };
