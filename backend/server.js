require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool, initDB } = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5500';

if (!JWT_SECRET || JWT_SECRET.includes('CAMBIA_ESTO')) {
  console.error('\n[ERROR] Debes cambiar JWT_SECRET en el archivo .env antes de ejecutar.\n');
  process.exit(1);
}

// Middleware
app.use(helmet());
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '10kb' }));

// Trust proxy for rate limiting behind reverse proxy
app.set('trust proxy', 1);

// Rate limiting — general
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Intenta en 15 minutos.' }
});

// Rate limiting — strict for validation endpoint
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de validación. Intenta en 15 minutos.' }
});

// Rate limiting — admin endpoints
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Demasiadas peticiones admin.' }
});

app.use('/api/', generalLimiter);

// ════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════

function generateKeyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'RX-VIP-';
  for (let i = 0; i < 8; i++) {
    code += chars[crypto.randomInt(chars.length)];
  }
  return code;
}

function verifyAdminSecret(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Acceso denegado.' });
  }
  next();
}

function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido.' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    req.license = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
}

function getClientIP(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
}

// ════════════════════════════════════════════════════
//  API ENDPOINTS
// ════════════════════════════════════════════════════

// POST /api/keys/validate — Validate a license key
app.post('/api/keys/validate', validateLimiter, async (req, res) => {
  const { code, fingerprint } = req.body;

  if (!code || !fingerprint) {
    return res.status(400).json({ error: 'Código y fingerprint requeridos.' });
  }

  const cleanCode = code.trim().toUpperCase().replace(/\s/g, '');

  if (cleanCode.length < 6) {
    return res.status(400).json({ error: 'Código demasiado corto.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM license_keys WHERE key_code = $1',
      [cleanCode]
    );
    const keyRow = rows[0];

    if (!keyRow) {
      return res.status(401).json({ error: 'CÓDIGO INVÁLIDO — Verifica e intenta de nuevo.' });
    }

    if (keyRow.is_revoked) {
      return res.status(403).json({ error: 'Este código ha sido revocado.' });
    }

    if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
      return res.status(403).json({ error: 'Este código ha expirado.' });
    }

    const { rows: existingRows } = await pool.query(
      'SELECT * FROM activations WHERE key_id = $1 AND fingerprint = $2 AND is_active = 1',
      [keyRow.id, fingerprint]
    );
    const existingActivation = existingRows[0];

    if (existingActivation) {
      await pool.query(
        'UPDATE activations SET last_seen = NOW() WHERE id = $1',
        [existingActivation.id]
      );

      const token = jwt.sign(
        { keyId: keyRow.id, code: cleanCode, name: keyRow.owner_name, fp: fingerprint },
        JWT_SECRET,
        { expiresIn: '30d' }
      );

      return res.json({
        valid: true,
        token,
        name: keyRow.owner_name,
        code: cleanCode,
        expiresAt: keyRow.expires_at
      });
    }

    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*) as cnt FROM activations WHERE key_id = $1 AND is_active = 1',
      [keyRow.id]
    );
    const activeCount = parseInt(countRows[0].cnt, 10);

    if (activeCount >= keyRow.max_activations) {
      return res.status(403).json({
        error: 'Este código ya alcanzó el máximo de dispositivos permitidos (' + keyRow.max_activations + ').'
      });
    }

    await pool.query(
      'INSERT INTO activations (key_id, fingerprint, user_agent, ip_address) VALUES ($1, $2, $3, $4)',
      [keyRow.id, fingerprint, req.headers['user-agent'] || '', getClientIP(req)]
    );

    const token = jwt.sign(
      { keyId: keyRow.id, code: cleanCode, name: keyRow.owner_name, fp: fingerprint },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      valid: true,
      token,
      name: keyRow.owner_name,
      code: cleanCode,
      expiresAt: keyRow.expires_at
    });
  } catch (err) {
    console.error('Error validating key:', err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// GET /api/keys/status — Check if current session is valid
app.get('/api/keys/status', verifyToken, async (req, res) => {
  const { keyId, fp } = req.license;

  try {
    const { rows } = await pool.query(
      'SELECT * FROM license_keys WHERE id = $1',
      [keyId]
    );
    const keyRow = rows[0];

    if (!keyRow || keyRow.is_revoked) {
      return res.status(403).json({ valid: false, error: 'Licencia revocada.' });
    }

    if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
      return res.status(403).json({ valid: false, error: 'Licencia expirada.' });
    }

    const { rows: actRows } = await pool.query(
      'SELECT * FROM activations WHERE key_id = $1 AND fingerprint = $2 AND is_active = 1',
      [keyId, fp]
    );
    const activation = actRows[0];

    if (!activation) {
      return res.status(403).json({ valid: false, error: 'Activación no encontrada.' });
    }

    await pool.query(
      'UPDATE activations SET last_seen = NOW() WHERE id = $1',
      [activation.id]
    );

    res.json({
      valid: true,
      code: keyRow.key_code,
      name: keyRow.owner_name,
      expiresAt: keyRow.expires_at
    });
  } catch (err) {
    console.error('Error checking status:', err);
    res.status(500).json({ valid: false, error: 'Error interno.' });
  }
});

// POST /api/keys/logout — Deactivate current session
app.post('/api/keys/logout', verifyToken, async (req, res) => {
  const { keyId, fp } = req.license;

  try {
    await pool.query(
      'UPDATE activations SET is_active = 0 WHERE key_id = $1 AND fingerprint = $2',
      [keyId, fp]
    );
    res.json({ success: true, message: 'Sesión VIP cerrada.' });
  } catch (err) {
    console.error('Error logging out:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// ════════════════════════════════════════════════════
//  ADMIN ENDPOINTS
// ════════════════════════════════════════════════════

// POST /api/admin/keys/generate — Generate new license keys
app.post('/api/admin/keys/generate', adminLimiter, verifyAdminSecret, async (req, res) => {
  const { count = 1, ownerName = '', maxActivations = 1, expiresInDays = null } = req.body;

  if (count < 1 || count > 50) {
    return res.status(400).json({ error: 'Cantidad debe ser entre 1 y 50.' });
  }

  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
    : null;

  const keys = [];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (let i = 0; i < count; i++) {
      let keyCode;
      do {
        keyCode = generateKeyCode();
        const { rows } = await client.query(
          'SELECT id FROM license_keys WHERE key_code = $1',
          [keyCode]
        );
        if (rows.length === 0) break;
      } while (true);

      const keyHash = await bcrypt.hash(keyCode, 10);
      await client.query(
        'INSERT INTO license_keys (key_code, key_hash, owner_name, max_activations, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [keyCode, keyHash, ownerName, maxActivations, expiresAt]
      );
      keys.push({ code: keyCode, owner: ownerName, maxActivations, expiresAt });
    }

    await client.query('COMMIT');
    res.json({ generated: keys.length, keys });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error generating keys:', err);
    res.status(500).json({ error: 'Error interno.' });
  } finally {
    client.release();
  }
});

// GET /api/admin/keys — List all license keys
app.get('/api/admin/keys', adminLimiter, verifyAdminSecret, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT k.*,
        (SELECT COUNT(*) FROM activations a WHERE a.key_id = k.id AND a.is_active = 1) as active_devices
      FROM license_keys k
      ORDER BY k.created_at DESC
    `);
    res.json({ keys: rows });
  } catch (err) {
    console.error('Error listing keys:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// POST /api/admin/keys/revoke — Revoke a specific key
app.post('/api/admin/keys/revoke', adminLimiter, verifyAdminSecret, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Código requerido.' });

  try {
    const { rowCount } = await pool.query(
      'UPDATE license_keys SET is_revoked = 1 WHERE key_code = $1',
      [code.toUpperCase()]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Código no encontrado.' });
    }

    const { rows } = await pool.query(
      'SELECT id FROM license_keys WHERE key_code = $1',
      [code.toUpperCase()]
    );
    if (rows[0]) {
      await pool.query(
        'UPDATE activations SET is_active = 0 WHERE key_id = $1',
        [rows[0].id]
      );
    }

    res.json({ success: true, message: 'Código revocado y todas las sesiones cerradas.' });
  } catch (err) {
    console.error('Error revoking key:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// DELETE /api/admin/keys/:code — Delete a key entirely
app.delete('/api/admin/keys/:code', adminLimiter, verifyAdminSecret, async (req, res) => {
  const code = req.params.code.toUpperCase();

  try {
    const { rows } = await pool.query(
      'SELECT id FROM license_keys WHERE key_code = $1',
      [code]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Código no encontrado.' });

    await pool.query('DELETE FROM activations WHERE key_id = $1', [rows[0].id]);
    await pool.query('DELETE FROM license_keys WHERE id = $1', [rows[0].id]);

    res.json({ success: true, message: 'Código eliminado permanentemente.' });
  } catch (err) {
    console.error('Error deleting key:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// ════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════

async function start() {
  try {
    await initDB();
    app.listen(PORT, () => {
      console.log(`\n  ╔══════════════════════════════════════╗`);
      console.log(`  ║   RX PRO — Backend API v1.0          ║`);
      console.log(`  ║   Puerto: ${PORT}                        ║`);
      console.log(`  ║   CORS:   ${CORS_ORIGIN.padEnd(25)} ║`);
      console.log(`  ╚══════════════════════════════════════╝\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
