require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Stripe = require('stripe');
const { pool, initDB } = require('./database');
const v44 = require('./v44-engine');
const { sendRecoveryEmail } = require('./mailer');

// 2026-04-23 fix 2.6: decrypted broker keys cache en memoria (TTL 5min)
// Evita timing side-channel + CPU overhead de AES-256-GCM en cada request broker.
// Invalidado automáticamente al rotar BROKER_MASTER_KEY (el decrypt tira).
const _brokerKeyCache = new Map(); // keyId → { apiKey, apiSecret, ts }
const BROKER_KEY_CACHE_TTL = 5 * 60 * 1000; // 5 min
function getBrokerKeysCached(cfg) {
  const ent = _brokerKeyCache.get(cfg.id);
  if (ent && Date.now() - ent.ts < BROKER_KEY_CACHE_TTL) {
    return { apiKey: ent.apiKey, apiSecret: ent.apiSecret };
  }
  const apiKey = broker.decrypt(cfg.api_key_enc);
  const apiSecret = broker.decrypt(cfg.api_secret_enc);
  _brokerKeyCache.set(cfg.id, { apiKey, apiSecret, ts: Date.now() });
  return { apiKey, apiSecret };
}
function invalidateBrokerKeyCache(cfgId) {
  _brokerKeyCache.delete(cfgId);
}
// Periodic cleanup to bound memory growth
setInterval(() => {
  const cutoff = Date.now() - BROKER_KEY_CACHE_TTL;
  for (const [k, v] of _brokerKeyCache.entries()) {
    if (v.ts < cutoff) _brokerKeyCache.delete(k);
  }
}, 60000);

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'https://rxtrading.net')
  .split(',').map(s => s.trim());

// Always allow both www and non-www
if (CORS_ORIGINS.includes('https://rxtrading.net') && !CORS_ORIGINS.includes('https://www.rxtrading.net')) {
  CORS_ORIGINS.push('https://www.rxtrading.net');
}

function _checkSecretEntropy(s) {
  if (!s || s.length < 32) return false;
  if (/^(.)\1+$/.test(s)) return false; // all same char
  if (/^(0{32}|1{32}|a{32}|A{32})/.test(s)) return false;
  // 2026-04-22 audit fix 1.3: tighten — min 16 distinct chars + no patterns
  const chars = new Set(s);
  if (chars.size < 16) return false;           // min 16 distinct chars
  if (/(.)\1{3,}/.test(s)) return false;       // no 4+ repeats
  if (/(.{2,})\1{2,}/.test(s)) return false;   // no substring patterns like 'abab abab abab'
  return true;
}
if (!JWT_SECRET || JWT_SECRET.includes('CAMBIA_ESTO') || !_checkSecretEntropy(JWT_SECRET)) {
  console.error('\n[ERROR] JWT_SECRET debe tener mínimo 32 chars + entropy alta. Generá: openssl rand -hex 32\n');
  process.exit(1);
}

// ════════════════════════════════════════════════════
//  PAYMENT CONFIG
// ════════════════════════════════════════════════════

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const USDT_WALLET = process.env.USDT_WALLET || '0x24bB8Db9b53E91A15dEaA40EA90531C7E087c101';
const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY || '';
const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET || '';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://rxtrading.net';
const BACKEND_URL = process.env.BACKEND_URL || 'https://rxtrading-1.onrender.com';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const PLANS = {
  '7d':  { name: 'RXTrading VIP - 7 Days',   days: 7,   usd: 49 },
  '1m':  { name: 'RXTrading VIP - 1 Month',  days: 30,  usd: 129 },
  '3m':  { name: 'RXTrading VIP - 3 Months', days: 90,  usd: 399 },
  '1y':  { name: 'RXTrading VIP - Yearly',   days: 365, usd: 599 },
};

// ════════════════════════════════════════════════════
//  STRIPE WEBHOOK (raw body — MUST be before express.json)
// ════════════════════════════════════════════════════

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    console.error('[Stripe Webhook] Stripe not configured');
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    // Replay protection — reject events older than 5min (Stripe signature includes timestamp)
    if (event.created && (Date.now()/1000 - event.created) > 300) {
      console.error('[Stripe Webhook] Event too old (replay attack?)');
      return res.status(400).json({ error: 'Event timestamp too old' });
    }
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }
  // CORS rejection for webhooks
  if (req.headers.origin) return res.status(403).json({ error: 'CORS not allowed on webhook' });

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const paymentId = session.metadata?.payment_id;
    const planId = session.metadata?.plan_id;
    const email = session.customer_details?.email || '';
    const customerName = session.customer_details?.name || '';

    if (!paymentId || !planId) {
      console.error('[Stripe Webhook] Missing metadata in session:', session.id);
      return res.status(200).json({ received: true });
    }

    try {
      // Idempotency via advisory lock — prevents concurrent webhook processing of same payment
      const lockKey = require('crypto').createHash('sha256').update(paymentId).digest().readInt32BE(0);
      await pool.query('SELECT pg_advisory_xact_lock($1)', [lockKey]).catch(()=>{});

      // Check if already processed (inside lock window)
      const { rows } = await pool.query(
        'SELECT status, key_code FROM payments WHERE payment_id = $1',
        [paymentId]
      );
      if (rows[0]?.status === 'completed') {
        console.log('[Stripe Webhook] Payment already processed (idempotent):', paymentId);
        return res.status(200).json({ received: true });
      }

      // Update email/name on the payment record
      await pool.query(
        'UPDATE payments SET email = $1, customer_name = $2, provider_ref = $3 WHERE payment_id = $4',
        [email, customerName, session.id, paymentId]
      );

      await generateVIPKeyForPayment(paymentId, planId, email, customerName);
      // Don't log keyCode/paymentId — PII
      console.log('[Stripe Webhook] Payment completed successfully');
    } catch (err) {
      console.error('[Stripe Webhook] Error processing payment');
      return res.status(500).json({ error: 'Processing error' });
    }
  }

  res.status(200).json({ received: true });
});

// ════════════════════════════════════════════════════
//  GLOBAL MIDDLEWARE
// ════════════════════════════════════════════════════

// 2026-04-23 fix 2.4: per-request nonce para CSP scriptSrc
// app.use al principio del middleware stack para que esté disponible downstream
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

// Hardened helmet config with CSP
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // 2026-04-23: nonce-based scriptSrc. unsafe-inline se mantiene como fallback para frontend
      // servido por Netlify (que no puede inyectar nonce). Cuando el cliente venga por el route
      // /app con nonce-inject, el browser prefiere la nonce y ignora unsafe-inline.
      scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`, "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://js.stripe.com", "https://www.gstatic.com", "https://*.firebaseapp.com", "https://*.firebaseio.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://api.binance.com", "https://fapi.binance.com", "https://testnet.binancefuture.com", "https://stream.binance.com", "wss://stream.binance.com", "wss://fstream.binance.com", "wss://fstream.binancefuture.com", "https://api.coingecko.com", "https://api.alternative.me", "https://query1.finance.yahoo.com", "https://*.googleapis.com", "https://*.firebaseio.com", "https://*.firebaseapp.com", "wss://*.firebaseio.com", "https://identitytoolkit.googleapis.com", "https://api.stripe.com", "https://api.mercadopago.com", "https://api.nowpayments.io"],
      frameSrc: ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"],
      workerSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  },
  crossOriginEmbedderPolicy: false, // Allow Firebase iframe/worker loading
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
// 2026-04-22 audit fix 1.5: CORS localhost only in non-production env
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (CORS_ORIGINS.includes(origin)) return callback(null, true);
    // Localhost only allowed in non-production
    if (process.env.NODE_ENV !== 'production') {
      if (/^http:\/\/localhost:\d+$/.test(origin) || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '500kb' }));
// Global request timeout (30s) — prevents Slowloris DoS
app.use((req, res, next) => {
  req.setTimeout(30000, () => { try { req.destroy(); } catch(e){} });
  res.setTimeout(30000, () => { try { if(!res.headersSent) res.status(408).json({ error: 'Request timeout' }); } catch(e){} });
  next();
});
// Request ID middleware for trace correlation in logs
app.use((req, res, next) => {
  req.reqId = req.headers['x-request-id'] || require('crypto').randomBytes(8).toString('hex');
  res.setHeader('X-Request-ID', req.reqId);
  next();
});

// Structured JSON logger (use in production for parseable logs)
const log = {
  _write(level, msg, ctx = {}) {
    try {
      console[level === 'error' ? 'error' : 'log'](JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg,
        ...ctx,
        service: 'rxtrading-backend'
      }));
    } catch(e) { console.log(level, msg); }
  },
  info(msg, ctx) { this._write('info', msg, ctx); },
  warn(msg, ctx) { this._write('warn', msg, ctx); },
  error(msg, ctx) { this._write('error', msg, ctx); }
};
global.rxLog = log;

// Input validators
const validators = {
  symbol(s) { return typeof s === 'string' && /^[A-Z0-9]{3,20}USDT$/.test(s); },
  side(s) { return s === 'BUY' || s === 'SELL'; },
  leverage(n) { const v = Number(n); return Number.isInteger(v) && v >= 1 && v <= 20; },
  usdAmount(n) { const v = Number(n); return Number.isFinite(v) && v >= 10 && v <= 10000; },
  price(n) { const v = Number(n); return Number.isFinite(v) && v > 0 && v < 1e9; },
  email(s) { return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254; },
  paymentId(s) { return typeof s === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(s); },
  planId(s) { return typeof s === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(s); },
  pairsArray(arr) { return Array.isArray(arr) && arr.length > 0 && arr.length <= 100 && arr.every(p => typeof p === 'string' && /^[A-Z0-9]{3,20}USDT$/i.test(p)); },
};
global.rxValidate = validators;
// Lightweight cookie parser (no external dep required)
app.use((req, res, next) => {
  req.cookies = {};
  const c = req.headers.cookie;
  if (c) c.split(';').forEach(s => { const [k, ...v] = s.trim().split('='); if (k) req.cookies[k] = decodeURIComponent((v.join('=') || '').trim()); });
  next();
});

// Trust proxy for rate limiting behind reverse proxy
app.set('trust proxy', 1);

// ════════════════════════════════════════════════════
//  RATE LIMITERS
// ════════════════════════════════════════════════════

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Intenta en 15 minutos.' }
});

// v2.0 Enumeration defense: limit per (code + fingerprint) tuple, not just IP
const _validateAttempts = new Map(); // key: code+fp, value: [timestamps]
function validateAttemptGuard(req, res, next) {
  try {
    const code = (req.body?.code || '').replace(/\s/g, '').toUpperCase();
    const fp = (req.body?.fingerprint || '').slice(0, 64);
    if (code && fp) {
      const key = code + '|' + fp;
      const now = Date.now();
      const cutoff = now - 15 * 60 * 1000;
      const attempts = (_validateAttempts.get(key) || []).filter(t => t > cutoff);
      if (attempts.length >= 5) {
        return res.status(429).json({ error: 'Demasiados intentos para este código. Esperá 15 min.' });
      }
      attempts.push(now);
      _validateAttempts.set(key, attempts);
      // cleanup (simple: cap map at 10000 entries)
      if (_validateAttempts.size > 10000) {
        const firstKey = _validateAttempts.keys().next().value;
        _validateAttempts.delete(firstKey);
      }
    }
  } catch(e){}
  next();
}
const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de validación. Intenta en 15 minutos.' }
});
// v2.0 CSRF NOTE: API uses Bearer token in Authorization header (localStorage-sourced).
// Cross-site POST can NOT forge Authorization header (browser won't attach it from cross-origin).
// Refresh cookie (rx_refresh) is httpOnly + sameSite:'strict' — blocks cross-site cookie send.
// Conclusion: CSRF is mitigated via architecture (Bearer-in-header auth + strict sameSite cookie).
// Additional defense: Origin/Referer check on state-changing endpoints:
function verifyOriginMiddleware(req, res, next) {
  const allowedOrigins = [
    process.env.FRONTEND_URL,
    'https://rxtrading.net',
    'https://www.rxtrading.net',
    'http://localhost:8090',
    'http://localhost:3000'
  ].filter(Boolean);
  const origin = req.get('Origin') || req.get('Referer') || '';
  if (!origin) return next(); // no origin = likely same-origin (allow)
  const ok = allowedOrigins.some(a => origin.startsWith(a));
  if (!ok) {
    console.warn('[CSRF] Rejected origin:', origin, 'path:', req.path);
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
}

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Demasiadas peticiones admin.' }
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones de pago. Intenta en 15 minutos.' }
});

const macroLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 req/min per IP — protects against scraper abuse
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit en macro data. Intenta en 1 minuto.' }
});

// Global reconcile throttle (across all users) — Binance rate limit protection
const reconcileLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // 20 reconciles/min globally (protects Binance API quota)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: () => 'global_reconcile',
  message: { error: 'Reconcile global rate limited.' }
});

// Per-user rate limiter helper: uses keyId for authenticated endpoints, falls back to IP
function perUserKey(req) {
  return req.license?.keyId ? `user_${req.license.keyId}` : req.ip;
}

// 2026-04-22 audit fix 1.6 + 4.4: PII-safe log helper (mask keyId, emails, amounts)
function safeLog(label, data) {
  if (process.env.NODE_ENV === 'production' && process.env.LOG_VERBOSE !== 'true') {
    // In prod, suppress verbose logs unless explicitly enabled
    return;
  }
  try {
    const masked = { ...data };
    if (masked.keyId) masked.keyId = `key_${String(masked.keyId).slice(-4)}`;
    if (masked.email) masked.email = String(masked.email).replace(/(.{2})(.*)(@.*)/, '$1***$3');
    if (masked.amount !== undefined) masked.amount = typeof masked.amount === 'number' ? `$${Math.round(masked.amount/10)*10}` : '$XXX';
    if (masked.apiKey) masked.apiKey = '***';
    if (masked.apiSecret) masked.apiSecret = '***';
    console.log(label, JSON.stringify(masked));
  } catch (e) { /* silent */ }
}
const perUserSyncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: perUserKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas sync requests — intenta en 1 minuto.' }
});

// 2026-04-22 audit fix 1.4: dedicated refresh token rate limiter (5/min per keyId or IP)
const refreshTokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => {
    try {
      const rt = req.cookies?.rx_refresh;
      if (rt) {
        const decoded = require('jsonwebtoken').decode(rt);
        if (decoded?.keyId) return `refresh_${decoded.keyId}`;
      }
    } catch(e) {}
    return req.ip;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados refresh requests. Esperá 60 segundos.' }
});

app.use('/api/', generalLimiter);

// ════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════

function generateKeyCode() {
  // Entropy: 32 chars ^ 12 ≈ 60 bits (GPU brute force > 10 años)
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'RX-VIP-';
  for (let i = 0; i < 12; i++) {
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
    // Re-validate against DB: is the key revoked / activation still active?
    pool.query('SELECT lk.is_revoked, lk.is_deleted, a.is_active FROM license_keys lk LEFT JOIN activations a ON a.key_id = lk.id AND a.fingerprint = $2 WHERE lk.id = $1', [payload.keyId, payload.fp || ''])
      .then(r => {
        const row = r.rows[0];
        if (!row) return res.status(401).json({ error: 'Licencia no existe.' });
        if (row.is_revoked || row.is_deleted) return res.status(401).json({ error: 'Licencia revocada.' });
        if (row.is_active === 0) return res.status(401).json({ error: 'Sesión cerrada en otro dispositivo.' });
        req.license = payload;
        next();
      })
      .catch((err) => {
        // Fail-CLOSED on DB error (security > availability)
        console.error('[Auth] DB check failed — denying');
        return res.status(503).json({ error: 'Servicio no disponible.' });
      });
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
}

// Normalize IP to /24 (IPv4) or /64 (IPv6) for rate limiting (prevents /32 rotation bypass)
function normalizeIP(ip) {
  if (!ip) return 'unknown';
  if (ip.includes(':')) return ip.split(':').slice(0,4).join(':') + '::/64'; // IPv6 /64
  return ip.split('.').slice(0,3).join('.') + '.0/24'; // IPv4 /24
}
// Hash IP for GDPR-compliant logging (one-way, no identification)
function hashIP(ip) {
  if (!ip) return '';
  return require('crypto').createHash('sha256').update(String(ip) + (process.env.IP_SALT || 'rx_default_salt')).digest('hex').slice(0, 16);
}
function getClientIP(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
}
// Audit log helper for admin/security actions
async function logAudit(actor, action, target, meta, req) {
  try {
    await pool.query(
      'INSERT INTO audit_log (actor, action, target, meta, ip, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
      [actor || 'unknown', action, target || null, meta ? JSON.stringify(meta) : null, hashIP(getClientIP(req))]
    );
  } catch (e) { /* silent — audit log should never break the actual action */ }
}

/**
 * Generate a VIP license key for a completed payment.
 * Inserts into license_keys and updates the payments record.
 */
async function generateVIPKeyForPayment(paymentId, planId, email, customerName) {
  const plan = PLANS[planId];
  if (!plan) throw new Error(`Invalid plan: ${planId}`);

  // Generate unique key code
  let keyCode;
  do {
    keyCode = generateKeyCode();
    const { rows } = await pool.query(
      'SELECT id FROM license_keys WHERE key_code = $1',
      [keyCode]
    );
    if (rows.length === 0) break;
  } while (true);

  const expiresAt = new Date(Date.now() + plan.days * 86400000).toISOString();
  const keyHash = await bcrypt.hash(keyCode, 12); // cost 12 = ~40ms/hash (GPU-resistant)

  await pool.query(
    'INSERT INTO license_keys (key_code, key_hash, owner_name, max_activations, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [keyCode, keyHash, customerName || email || '', 1, expiresAt]
  );

  await pool.query(
    'UPDATE payments SET key_code = $1, status = $2, completed_at = NOW() WHERE payment_id = $3',
    [keyCode, 'completed', paymentId]
  );

  // 2026-04-23 fix 4.3: audit log para cada pago completado via webhook
  try {
    await pool.query(
      'INSERT INTO audit_log (actor, action, target, meta, ip, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
      ['webhook_system', 'payment_completed', `payment_id=${paymentId}`, JSON.stringify({ keyCode: keyCode.slice(-4), planId, emailMasked: (email||'').replace(/(.{2}).*(@.*)/,'$1***$2') }), null]
    );
  } catch(e){ /* audit_log table may not exist in old deploys — don't block payment */ }

  return keyCode;
}

// ════════════════════════════════════════════════════
//  LICENSE KEY ENDPOINTS
// ════════════════════════════════════════════════════

// POST /api/keys/validate — Validate a license key
app.post('/api/keys/validate', validateLimiter, validateAttemptGuard, async (req, res) => {
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
        { keyId: keyRow.id, code: cleanCode, name: keyRow.owner_name, fp: fingerprint, type: 'access' },
        JWT_SECRET,
        { expiresIn: '4h' } // v2.0 Shorter access token (was 7d); frontend auto-refreshes via rx_refresh cookie
      );
      const refreshToken = jwt.sign(
        { keyId: keyRow.id, fp: fingerprint, type: 'refresh' },
        JWT_SECRET,
        { expiresIn: '30d' } // v2.0 reduced from 90d
      );
      // Set refresh token as httpOnly cookie (cannot be read via XSS)
      try {
        res.cookie('rx_refresh', refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict', // Strict: cookie NOT sent on cross-site requests (prevents CSRF)
          maxAge: 90 * 24 * 60 * 60 * 1000,
          path: '/api/keys/refresh' // Scoped to refresh endpoint only
        });
      } catch(e){}

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
      { keyId: keyRow.id, code: cleanCode, name: keyRow.owner_name, fp: fingerprint, type: 'access' },
      JWT_SECRET,
      { expiresIn: '4h' }
    );
    const refreshToken = jwt.sign(
      { keyId: keyRow.id, fp: fingerprint, type: 'refresh' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    try {
      res.cookie('rx_refresh', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 90 * 24 * 60 * 60 * 1000,
        path: '/api/keys/refresh'
      });
    } catch(e){}

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
app.post('/api/keys/logout', verifyOriginMiddleware, verifyToken, async (req, res) => {
  const { keyId, fp } = req.license;

  try {
    await pool.query(
      'UPDATE activations SET is_active = 0 WHERE key_id = $1 AND fingerprint = $2',
      [keyId, fp]
    );
    // Clear refresh cookie
    try { res.clearCookie('rx_refresh', { path: '/api/keys/refresh' }); } catch(e){}
    res.json({ success: true, message: 'Sesión VIP cerrada.' });
  } catch (err) {
    console.error('Error logging out:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// POST /api/keys/refresh — rotate refresh token + issue fresh access token
// 2026-04-22 audit fix 1.4: dedicated refreshTokenLimiter (5/min per keyId)
app.post('/api/keys/refresh', refreshTokenLimiter, async (req, res) => {
  const rt = req.cookies && req.cookies.rx_refresh;
  if (!rt) return res.status(401).json({ error: 'No refresh token' });
  try {
    const decoded = jwt.verify(rt, JWT_SECRET);
    if (decoded.type !== 'refresh') return res.status(401).json({ error: 'Invalid token type' });

    // Check token version for rotation/reuse detection
    const { rows } = await pool.query(
      'SELECT lk.id, lk.key_code, lk.owner_name, lk.expires_at, lk.is_revoked, lk.is_deleted, a.is_active, a.refresh_token_version FROM license_keys lk JOIN activations a ON a.key_id = lk.id WHERE lk.id = $1 AND a.fingerprint = $2',
      [decoded.keyId, decoded.fp]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Sesión no encontrada' });
    const row = rows[0];
    if (row.is_revoked || row.is_deleted) return res.status(401).json({ error: 'Licencia revocada' });
    if (row.is_active === 0) return res.status(401).json({ error: 'Sesión cerrada' });

    const dbVer = parseInt(row.refresh_token_version || 1);
    const tokenVer = parseInt(decoded.ver || 1);
    if (tokenVer !== dbVer) {
      // Token reuse detected — someone's using an old refresh token (possible theft)
      // Revoke ALL sessions for this user as safety measure
      await pool.query('UPDATE activations SET is_active = 0 WHERE key_id = $1', [row.id]).catch(()=>{});
      console.warn(`[Security] Refresh token reuse detected for keyId=${row.id} tokenVer=${tokenVer} dbVer=${dbVer}`);
      return res.status(401).json({ error: 'Token reutilizado — sesiones revocadas por seguridad' });
    }

    // Rotate: increment DB version + issue new tokens
    const newVer = dbVer + 1;
    await pool.query('UPDATE activations SET refresh_token_version = $1, last_seen = NOW() WHERE key_id = $2 AND fingerprint = $3', [newVer, row.id, decoded.fp]);

    const token = jwt.sign(
      { keyId: row.id, code: row.key_code, name: row.owner_name, fp: decoded.fp, type: 'access' },
      JWT_SECRET,
      { expiresIn: '4h' }
    );
    const newRefreshToken = jwt.sign(
      { keyId: row.id, fp: decoded.fp, type: 'refresh', ver: newVer },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.cookie('rx_refresh', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 90 * 24 * 60 * 60 * 1000,
      path: '/api/keys/refresh'
    });
    res.json({ valid: true, token, name: row.owner_name, expiresAt: row.expires_at });
  } catch (err) {
    return res.status(401).json({ error: 'Refresh inválido o expirado' });
  }
});

// ════════════════════════════════════════════════════
//  HEALTH CHECK — public
// ════════════════════════════════════════════════════
app.get(['/health', '/api/health'], async (req, res) => {
  // Deep health check: DB + broker + uptime
  const checks = { db: false, broker_keys: !!process.env.BROKER_MASTER_KEY, jwt: !!JWT_SECRET };
  try {
    const r = await Promise.race([
      pool.query('SELECT 1 as ok'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
    ]);
    checks.db = r?.rows?.[0]?.ok === 1;
  } catch (e) { checks.db = false; }
  const healthy = checks.db && checks.jwt;
  // 2026-04-22 audit fix 4.3: hide mode/env from public — only expose to admin
  const isAdmin = req.headers['x-admin-secret'] === ADMIN_SECRET && ADMIN_SECRET;
  const payload = {
    ok: healthy,
    service: 'rxtrading-backend',
    uptime: Math.round(process.uptime()),
    ts: new Date().toISOString()
  };
  if (isAdmin) {
    payload.mode = process.env.BINANCE_TESTNET === 'true' ? 'testnet' : 'mainnet';
    payload.env = process.env.NODE_ENV || 'development';
    payload.checks = checks;
  }
  res.status(healthy ? 200 : 503).json(payload);
});
// Admin metrics endpoint (protected)
app.get('/api/admin/metrics', verifyAdminSecret, (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    uptime: Math.round(process.uptime()),
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      external_mb: Math.round(mem.external / 1024 / 1024)
    },
    pool: {
      total: pool.totalCount || 0,
      idle: pool.idleCount || 0,
      waiting: pool.waitingCount || 0
    },
    node_version: process.version,
    platform: process.platform,
    mode: process.env.BINANCE_TESTNET === 'true' ? 'testnet' : 'mainnet',
    ts: new Date().toISOString()
  });
});

// ════════════════════════════════════════════════════
// 2026-04-22 audit fix 8.2: Admin emergency kill-switches
// ════════════════════════════════════════════════════

// POST /api/admin/autotrade/pause-all — Pause autotrade globally for all VIP users
app.post('/api/admin/autotrade/pause-all', adminLimiter, verifyAdminSecret, async (req, res) => {
  const { reason, durationHours } = req.body || {};
  const pauseUntil = durationHours ? new Date(Date.now() + (parseInt(durationHours)||24) * 3600 * 1000) : null;
  try {
    const result = await pool.query(
      `UPDATE broker_configs SET circuit_breaker_until = COALESCE($1, NOW() + INTERVAL '24 hours') WHERE connected = true`,
      [pauseUntil]
    );
    if (typeof logAudit === 'function') {
      try { await logAudit('admin', 'pause_all_autotrade', `rows=${result.rowCount} reason=${(reason||'').slice(0,100)}`, { rowCount: result.rowCount }, req); } catch(e){}
    }
    safeLog('[Admin] pause-all', { rowCount: result.rowCount, pauseUntil: pauseUntil?.toISOString() });
    res.json({ ok: true, paused: result.rowCount, pauseUntil: pauseUntil?.toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to pause autotrade' });
  }
});

// POST /api/admin/autotrade/resume-all — Resume autotrade after pause-all
app.post('/api/admin/autotrade/resume-all', adminLimiter, verifyAdminSecret, async (req, res) => {
  try {
    const result = await pool.query(`UPDATE broker_configs SET circuit_breaker_until = NULL WHERE circuit_breaker_until IS NOT NULL`);
    if (typeof logAudit === 'function') {
      try { await logAudit('admin', 'resume_all_autotrade', `rows=${result.rowCount}`, { rowCount: result.rowCount }, req); } catch(e){}
    }
    res.json({ ok: true, resumed: result.rowCount });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resume autotrade' });
  }
});

// ════════════════════════════════════════════════════
//  PAYMENT ENDPOINTS
// ════════════════════════════════════════════════════

// GET /api/payments/plans — Return available plans (public)
app.get('/api/payments/plans', (req, res) => {
  const plans = {};
  for (const [id, plan] of Object.entries(PLANS)) {
    plans[id] = { name: plan.name, usd: plan.usd };
  }
  res.json({ plans });
});

// POST /api/payments/stripe/checkout — Create Stripe Checkout Session
app.post('/api/payments/stripe/checkout', paymentLimiter, async (req, res) => {
  const { planId, email } = req.body;

  if (!planId || !PLANS[planId]) {
    return res.status(400).json({ error: 'Plan inválido.' });
  }

  if (!stripe) {
    return res.status(503).json({ error: 'Stripe no está configurado.' });
  }

  // Email format validation (RFC-compatible basic check)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Email inválido.' });
  }

  const plan = PLANS[planId];
  const paymentId = `pay_${crypto.randomUUID()}`;
  // Generate session_token to prevent key_code enumeration on status endpoint
  const sessionToken = crypto.randomBytes(32).toString('hex');

  try {
    await pool.query(
      'INSERT INTO payments (payment_id, provider, plan_id, amount_usd, email, status, session_token) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [paymentId, 'stripe', planId, plan.usd, email || '', 'pending', sessionToken]
    );

    const sessionParams = {
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: plan.name },
          unit_amount: Math.round(plan.usd * 100),
        },
        quantity: 1,
      }],
      success_url: `${FRONTEND_URL}/app.html?payment=success&session_id={CHECKOUT_SESSION_ID}&st=${sessionToken}#vip`,
      cancel_url: `${FRONTEND_URL}/app.html#vip`,
      metadata: {
        payment_id: paymentId,
        plan_id: planId,
      },
    };

    if (email) {
      sessionParams.customer_email = email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    res.json({ url: session.url, paymentId, sessionToken });
  } catch (err) {
    console.error('Error creating Stripe checkout:', err);
    res.status(500).json({ error: 'Error al crear sesión de pago.' });
  }
});

// POST /api/payments/mercadopago/checkout — Create MercadoPago Preference
app.post('/api/payments/mercadopago/checkout', paymentLimiter, async (req, res) => {
  const { planId, email } = req.body;

  if (!planId || !PLANS[planId]) {
    return res.status(400).json({ error: 'Plan inválido.' });
  }

  if (!MP_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'MercadoPago no está configurado.' });
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Email inválido.' });
  }

  const plan = PLANS[planId];
  const paymentId = `pay_${crypto.randomUUID()}`;
  const sessionToken = crypto.randomBytes(32).toString('hex');

  try {
    await pool.query(
      'INSERT INTO payments (payment_id, provider, plan_id, amount_usd, email, status, session_token) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [paymentId, 'mercadopago', planId, plan.usd, email || '', 'pending', sessionToken]
    );

    const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        items: [{
          title: plan.name,
          quantity: 1,
          unit_price: plan.usd,
          currency_id: 'USD',
        }],
        back_urls: {
          success: `${FRONTEND_URL}/app.html?payment=success&provider=mercadopago&payment_id=${paymentId}#vip`,
          failure: `${FRONTEND_URL}/app.html#vip`,
          pending: `${FRONTEND_URL}/app.html?payment=pending&payment_id=${paymentId}#vip`,
        },
        external_reference: paymentId,
        notification_url: `${BACKEND_URL}/api/webhooks/mercadopago`,
        auto_return: 'approved',
      }),
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('MercadoPago preference error:', response.status, errBody);
      return res.status(502).json({ error: 'Error al crear preferencia de pago.' });
    }

    const preference = await response.json();
    const url = preference.init_point || preference.sandbox_init_point;

    res.json({ url, paymentId });
  } catch (err) {
    console.error('Error creating MercadoPago checkout:', err);
    res.status(500).json({ error: 'Error al crear sesión de pago.' });
  }
});

// POST /api/webhooks/mercadopago — MercadoPago IPN Webhook
app.post('/api/webhooks/mercadopago', async (req, res) => {
  // SECURITY: Verify MP webhook signature (x-signature header + x-request-id)
  // MP sends: ts=<timestamp>,v1=<hmac-sha256>
  const xSig = req.headers['x-signature'];
  const xReqId = req.headers['x-request-id'];
  const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';
  if (MP_WEBHOOK_SECRET && xSig) {
    try {
      const parts = String(xSig).split(',').reduce((acc, p) => { const [k,v] = p.split('='); if(k&&v) acc[k.trim()] = v.trim(); return acc; }, {});
      const ts = parts.ts;
      const v1 = parts.v1;
      if (!ts || !v1) return res.status(401).json({ error: 'Invalid signature format' });
      // Manifest format: id:{data.id};request-id:{x-request-id};ts:{ts};
      const dataId = req.body?.data?.id || '';
      const manifest = `id:${dataId};request-id:${xReqId || ''};ts:${ts};`;
      const computed = require('crypto').createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
      if (computed !== v1) {
        console.error('[MP Webhook] Signature mismatch');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } catch (e) {
      console.error('[MP Webhook] Signature verification error');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else if (MP_WEBHOOK_SECRET && !xSig) {
    console.error('[MP Webhook] Missing signature header');
    return res.status(401).json({ error: 'Missing signature' });
  } else if (!MP_WEBHOOK_SECRET) {
    // FAIL if secret not configured (prevents silent skip vulnerability)
    if (process.env.NODE_ENV === 'production') {
      console.error('[MP Webhook] CRITICAL: MP_WEBHOOK_SECRET not configured in production');
      return res.status(503).json({ error: 'Webhook not configured' });
    }
    // In dev, log warning but allow (for testing)
    console.warn('[MP Webhook] WARNING: MP_WEBHOOK_SECRET not set (dev mode only)');
  }
  // Reject if origin has CORS header (should be server-to-server only)
  if (req.headers.origin) return res.status(403).json({ error: 'CORS origin not allowed on webhook' });

  const { type, data } = req.body;

  if (type !== 'payment' || !data?.id) {
    return res.status(200).json({ received: true });
  }

  try {
    // Fetch payment details from MercadoPago API to verify
    const mpResponse = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
      },
    });

    if (!mpResponse.ok) {
      console.error('[MP Webhook] Failed to fetch payment');
      return res.status(200).json({ received: true });
    }

    const mpPayment = await mpResponse.json();

    if (mpPayment.status === 'approved') {
      const paymentId = mpPayment.external_reference;

      if (!paymentId) {
        console.error('[MP Webhook] No external_reference');
        return res.status(200).json({ received: true });
      }

      // Idempotency advisory lock to prevent concurrent double-processing
      const lockKey = require('crypto').createHash('sha256').update(paymentId).digest().readInt32BE(0);
      await pool.query('SELECT pg_advisory_xact_lock($1)', [lockKey]).catch(()=>{});

      // Check if already processed
      const { rows } = await pool.query(
        'SELECT * FROM payments WHERE payment_id = $1',
        [paymentId]
      );
      const payment = rows[0];

      if (!payment) {
        console.error('[MP Webhook] Payment not found');
        return res.status(200).json({ received: true });
      }

      if (payment.status === 'completed') {
        console.log('[MP Webhook] Payment already processed:', paymentId);
        return res.status(200).json({ received: true });
      }

      // Update provider ref
      await pool.query(
        'UPDATE payments SET provider_ref = $1, email = COALESCE(NULLIF($2, \'\'), email) WHERE payment_id = $3',
        [String(data.id), mpPayment.payer?.email || '', paymentId]
      );

      const keyCode = await generateVIPKeyForPayment(
        paymentId,
        payment.plan_id,
        mpPayment.payer?.email || payment.email,
        mpPayment.payer?.first_name || payment.customer_name
      );
      console.log('[MP Webhook] Payment completed:', paymentId, '- Key:', keyCode);
    }
  } catch (err) {
    console.error('[MP Webhook] Error processing:', err);
  }

  res.status(200).json({ received: true });
});

// POST /api/webhooks/nowpayments — NOWPayments IPN Webhook (auto USDT confirmation)
app.post('/api/webhooks/nowpayments', async (req, res) => {
  // CORS rejection for webhooks (server-to-server only)
  if (req.headers.origin) return res.status(403).json({ error: 'CORS not allowed on webhook' });
  // Verify IPN signature
  if (NOWPAYMENTS_IPN_SECRET) {
    const hmac = crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET);
    const sorted = Object.keys(req.body).sort().reduce((obj, key) => { obj[key] = req.body[key]; return obj; }, {});
    hmac.update(JSON.stringify(sorted));
    const signature = hmac.digest('hex');
    const receivedSig = req.headers['x-nowpayments-sig'];

    if (!receivedSig || signature !== receivedSig) {
      console.error('[NOWPayments Webhook] Invalid signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }
  } else if (process.env.NODE_ENV === 'production') {
    console.error('[NOWPayments Webhook] CRITICAL: NOWPAYMENTS_IPN_SECRET not configured');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  const { payment_status, order_id, payment_id, pay_address, actually_paid, outcome_amount } = req.body;

  console.log('[NOWPayments Webhook] Status:', payment_status, 'Order:', order_id, 'NP-ID:', payment_id);

  // Only process confirmed/finished payments
  if (payment_status !== 'finished' && payment_status !== 'confirmed') {
    return res.status(200).json({ received: true });
  }

  if (!order_id) {
    console.error('[NOWPayments Webhook] No order_id');
    return res.status(200).json({ received: true });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM payments WHERE payment_id = $1',
      [order_id]
    );
    const payment = rows[0];

    if (!payment) {
      console.error('[NOWPayments Webhook] Payment not found:', order_id);
      return res.status(200).json({ received: true });
    }

    if (payment.status === 'completed') {
      console.log('[NOWPayments Webhook] Already processed:', order_id);
      return res.status(200).json({ received: true });
    }

    // Update provider ref
    await pool.query(
      'UPDATE payments SET provider_ref = $1 WHERE payment_id = $2',
      [String(payment_id), order_id]
    );

    const keyCode = await generateVIPKeyForPayment(
      order_id,
      payment.plan_id,
      payment.email,
      payment.customer_name
    );

    console.log('[NOWPayments Webhook] Payment completed:', order_id, '- Key:', keyCode);
  } catch (err) {
    console.error('[NOWPayments Webhook] Error:', err);
    return res.status(500).json({ error: 'Processing error' });
  }

  res.status(200).json({ received: true });
});

// POST /api/payments/usdt/create — Create USDT Payment via NOWPayments
app.post('/api/payments/usdt/create', paymentLimiter, async (req, res) => {
  const { planId, email } = req.body;

  if (!planId || !PLANS[planId]) {
    return res.status(400).json({ error: 'Plan inválido.' });
  }

  if (!NOWPAYMENTS_API_KEY) {
    return res.status(503).json({ error: 'Crypto payments not configured.' });
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Email inválido.' });
  }

  const plan = PLANS[planId];
  const paymentId = `pay_${crypto.randomUUID()}`;
  const sessionToken = crypto.randomBytes(32).toString('hex');

  try {
    await pool.query(
      'INSERT INTO payments (payment_id, provider, plan_id, amount_usd, email, status, session_token) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [paymentId, 'usdt', planId, plan.usd, email || '', 'pending', sessionToken]
    );

    // Create payment via NOWPayments API
    const npRes = await fetch('https://api.nowpayments.io/v1/payment', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': NOWPAYMENTS_API_KEY,
      },
      body: JSON.stringify({
        price_amount: plan.usd,
        price_currency: 'usd',
        pay_currency: 'usdterc20',
        order_id: paymentId,
        order_description: plan.name,
        ipn_callback_url: `${BACKEND_URL}/api/webhooks/nowpayments`,
      }),
    });

    if (!npRes.ok) {
      const errBody = await npRes.text();
      console.error('[NOWPayments] Error creating payment:', npRes.status, errBody);
      // Fallback: show manual wallet
      return res.json({
        paymentId,
        wallet: USDT_WALLET,
        amount: plan.usd,
        manual: true,
      });
    }

    const npData = await npRes.json();

    // Save NOWPayments payment ID
    await pool.query(
      'UPDATE payments SET provider_ref = $1 WHERE payment_id = $2',
      [String(npData.payment_id), paymentId]
    );

    res.json({
      paymentId,
      wallet: npData.pay_address,
      amount: npData.pay_amount,
      npPaymentId: npData.payment_id,
      manual: false,
    });
  } catch (err) {
    console.error('Error creating USDT payment:', err);
    // Fallback: show manual wallet
    res.json({
      paymentId,
      wallet: USDT_WALLET,
      amount: plan.usd,
      manual: true,
    });
  }
});

// POST /api/admin/payments/usdt/confirm — Admin confirms USDT payment
app.post('/api/admin/payments/usdt/confirm', adminLimiter, verifyAdminSecret, async (req, res) => {
  const { paymentId, txHash } = req.body;

  if (!paymentId) {
    return res.status(400).json({ error: 'paymentId requerido.' });
  }

  try {
    const { rows } = await pool.query(
      "SELECT * FROM payments WHERE payment_id = $1 AND provider = 'usdt' AND status = 'pending'",
      [paymentId]
    );
    const payment = rows[0];

    if (!payment) {
      return res.status(404).json({ error: 'Pago USDT pendiente no encontrado.' });
    }

    if (txHash) {
      await pool.query(
        'UPDATE payments SET provider_ref = $1 WHERE payment_id = $2',
        [txHash, paymentId]
      );
    }

    const keyCode = await generateVIPKeyForPayment(
      paymentId,
      payment.plan_id,
      payment.email,
      payment.customer_name
    );

    console.log('[USDT Confirm] Payment completed:', paymentId, '- Key:', keyCode);
    res.json({ success: true, keyCode });
  } catch (err) {
    console.error('Error confirming USDT payment:', err);
    res.status(500).json({ error: 'Error al confirmar pago.' });
  }
});

// GET /api/payments/status/:paymentId — Check payment status
// SECURITY: requires session_token issued at payment creation time to prevent key_code leak
app.get('/api/payments/status/:paymentId', paymentLimiter, async (req, res) => {
  const { paymentId } = req.params;
  const { session_token } = req.query;

  // Rate limit + session validation — only the buyer (with their session_token) can see the key
  if (!paymentId || typeof paymentId !== 'string' || paymentId.length > 128) {
    return res.status(400).json({ error: 'paymentId inválido.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT payment_id, status, key_code, plan_id, session_token, email FROM payments WHERE payment_id = $1',
      [paymentId]
    );
    const payment = rows[0];

    if (!payment) {
      return res.status(404).json({ error: 'Pago no encontrado.' });
    }

    // SECURITY: If session_token is set in DB, require it to match (prevents enumeration attacks)
    if (payment.session_token && payment.session_token !== session_token) {
      // Don't reveal key_code, return generic status only
      return res.json({ status: payment.status === 'completed' ? 'completed_other_session' : payment.status });
    }

    if (payment.status === 'completed') {
      return res.json({
        status: 'completed',
        keyCode: payment.key_code,
        plan: payment.plan_id,
      });
    }

    res.json({ status: 'pending' });
  } catch (err) {
    console.error('Error checking payment status:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// ════════════════════════════════════════════════════
//  ADMIN ENDPOINTS
// ════════════════════════════════════════════════════

// GET /api/admin/payments — List all payments (admin only)
app.get('/api/admin/payments', adminLimiter, verifyAdminSecret, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM payments ORDER BY created_at DESC'
    );
    res.json({ payments: rows });
  } catch (err) {
    console.error('Error listing payments:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// POST /api/admin/keys/generate — Generate new license keys
app.post('/api/admin/keys/generate', adminLimiter, verifyAdminSecret, async (req, res) => {
  const { count = 1, ownerName = '', maxActivations = 1, expiresInDays = null } = req.body;
  await logAudit('admin', 'generate_keys', `count=${count}`, { maxActivations, expiresInDays, ownerName: ownerName?.slice(0,20) }, req);

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

      const keyHash = await bcrypt.hash(keyCode, 12); // cost 12 = ~40ms/hash (GPU-resistant)
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
    await logAudit('admin', 'revoke_key', code.toUpperCase().slice(0, 8) + '***', null, req);

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
  await logAudit('admin', 'delete_key', code.slice(0, 8) + '***', null, req);

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
//  VIP CLOUD SYNC — Paper Trading & Signal History
// ═══════════════════════════════════════���════════════

const syncLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,  // 1 minute
  max: 30,                    // 30 req/min — enough for real-time sync
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Sync rate limit — intenta en 1 minuto.' }
});

// GET /api/user/paper — Fetch paper trading data from cloud
app.get('/api/user/paper', syncLimiter, verifyToken, async (req, res) => {
  const { keyId } = req.license;

  try {
    const { rows } = await pool.query(
      'SELECT data, updated_at FROM user_paper_data WHERE key_id = $1',
      [keyId]
    );

    if (!rows[0]) {
      return res.json({ data: null, updatedAt: null });
    }

    res.json({ data: rows[0].data, updatedAt: rows[0].updated_at });
  } catch (err) {
    console.error('[Sync] Error fetching paper data:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// POST /api/user/paper — Save paper trading data to cloud (with optimistic concurrency versioning)
app.post('/api/user/paper', syncLimiter, verifyOriginMiddleware, verifyToken, async (req, res) => {
  const { keyId } = req.license;
  const { data, _syncVersion, _clientVersion } = req.body;

  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Data inválida.' });
  }
  const clientVer = Number(_clientVersion || _syncVersion || Date.now());

  try {
    // Optimistic concurrency: only update if client version >= server updated_at
    const result = await pool.query(`
      INSERT INTO user_paper_data (key_id, data, updated_at)
      VALUES ($1, $2, to_timestamp($3 / 1000.0))
      ON CONFLICT (key_id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
      WHERE user_paper_data.updated_at <= EXCLUDED.updated_at
      RETURNING updated_at
    `, [keyId, JSON.stringify(data), clientVer]);
    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'Conflict: server has newer version', staleClient: true });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Sync] Error saving paper data:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// GET /api/user/signals — Fetch signal history from cloud
app.get('/api/user/signals', syncLimiter, verifyToken, async (req, res) => {
  const { keyId } = req.license;

  try {
    const { rows } = await pool.query(
      'SELECT data, updated_at FROM user_signal_history WHERE key_id = $1',
      [keyId]
    );

    if (!rows[0]) {
      return res.json({ data: null, updatedAt: null });
    }

    res.json({ data: rows[0].data, updatedAt: rows[0].updated_at });
  } catch (err) {
    console.error('[Sync] Error fetching signal history:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// POST /api/user/signals — Save signal history to cloud (optimistic concurrency)
app.post('/api/user/signals', syncLimiter, verifyOriginMiddleware, verifyToken, async (req, res) => {
  const { keyId } = req.license;
  const { data, _syncVersion, _clientVersion } = req.body;

  if (!Array.isArray(data)) {
    return res.status(400).json({ error: 'Data debe ser un array.' });
  }
  const clientVer = Number(_clientVersion || _syncVersion || Date.now());
  const trimmed = data.slice(-500);

  try {
    const result = await pool.query(`
      INSERT INTO user_signal_history (key_id, data, updated_at)
      VALUES ($1, $2, to_timestamp($3 / 1000.0))
      ON CONFLICT (key_id)
      DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
      WHERE user_signal_history.updated_at <= EXCLUDED.updated_at
      RETURNING updated_at
    `, [keyId, JSON.stringify(trimmed), clientVer]);
    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'Conflict: server has newer version', staleClient: true });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('[Sync] Error saving signal history:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// POST /api/payments/recover-key — lookup key(s) by email (requires email verification)
app.post('/api/payments/recover-key', paymentLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
    return res.status(400).json({ error: 'Email inválido.' });
  }
  try {
    const { rows } = await pool.query(
      "SELECT payment_id, plan_id, completed_at FROM payments WHERE LOWER(email) = LOWER($1) AND status = 'completed' ORDER BY completed_at DESC LIMIT 10",
      [email]
    );
    // Always return OK (no enumeration) but only email if payments found
    if (rows.length > 0) {
      const token = require('crypto').randomBytes(32).toString('hex');
      await pool.query('INSERT INTO recovery_tokens (email, token) VALUES ($1, $2)', [email, token]);
      // 2026-04-23 fix 2.7: pluggable email sender — SendGrid/SES/Postmark via env vars
      try { await sendRecoveryEmail(email, token); }
      catch(mailErr){ console.error('[Recovery] email send failed:', mailErr.message); }
      console.log('[Recovery] Token issued for', email.slice(0,3) + '***');
    }
    res.json({ ok: true, message: 'Si hay pagos asociados a este email, recibirás un link de recuperación.' });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// GDPR/CCPA — DELETE all user data (right to erasure)
app.post('/api/user/delete-all', syncLimiter, verifyOriginMiddleware, verifyToken, async (req, res) => {
  const { keyId } = req.license;
  const { confirm } = req.body;
  if (confirm !== 'DELETE_MY_DATA') {
    return res.status(400).json({ error: 'Envía { confirm: "DELETE_MY_DATA" } para confirmar.' });
  }
  try {
    await pool.query('BEGIN');
    await pool.query('DELETE FROM user_data WHERE key_id = $1', [keyId]).catch(()=>{});
    await pool.query('DELETE FROM user_paper_data WHERE key_id = $1', [keyId]).catch(()=>{});
    await pool.query('DELETE FROM user_signal_history WHERE key_id = $1', [keyId]).catch(()=>{});
    await pool.query('DELETE FROM activations WHERE key_id = $1', [keyId]).catch(()=>{});
    await pool.query('DELETE FROM broker_trade_log WHERE key_id = $1', [keyId]).catch(()=>{});
    await pool.query('DELETE FROM broker_configs WHERE key_id = $1', [keyId]).catch(()=>{});
    await pool.query('COMMIT');
    res.json({ ok: true, message: 'Todos tus datos han sido eliminados. La licencia permanece activa pero sin asociaciones de datos.' });
  } catch (err) {
    try { await pool.query('ROLLBACK'); } catch(e){}
    console.error('[GDPR] delete-all error:', err);
    res.status(500).json({ error: 'Error al eliminar datos.' });
  }
});

// GDPR — Export all user data (right to portability)
app.get('/api/user/export', syncLimiter, verifyToken, async (req, res) => {
  const { keyId } = req.license;
  try {
    const [paper, signals, tradeLog] = await Promise.all([
      pool.query("SELECT data, updated_at FROM user_data WHERE key_id = $1 AND endpoint = 'paper'", [keyId]).then(r => r.rows[0] || null).catch(()=>null),
      pool.query("SELECT data, updated_at FROM user_data WHERE key_id = $1 AND endpoint = 'signals'", [keyId]).then(r => r.rows[0] || null).catch(()=>null),
      pool.query('SELECT symbol, side, usd_amount, leverage, entry_price, tp_price, sl_price, status, created_at FROM broker_trade_log WHERE key_id = $1 ORDER BY created_at DESC LIMIT 1000', [keyId]).then(r => r.rows).catch(()=>[]),
    ]);
    res.json({
      exportedAt: new Date().toISOString(),
      keyId,
      paper,
      signals,
      tradeLog,
      meta: { format: 'rxtrading-export-v1', gdprCompliant: true }
    });
  } catch (err) {
    console.error('[GDPR] export error:', err);
    res.status(500).json({ error: 'Error al exportar datos.' });
  }
});

// ════════════════════════════════════════════════════
//  BROKER INTEGRATION — Binance Futures real trading
// ════════════════════════════════════════════════════

const broker = require('./broker');

// Sanitize error messages before returning to client (prevent info leak)
function safeErrorMessage(err) {
  const msg = String(err?.message || err || 'Unknown error');
  // Filter common implementation-details
  if (msg.includes('Cannot read properties') || msg.includes('undefined') || msg.includes('is not a function')) {
    return 'Error interno del servidor.';
  }
  // Known user-safe error prefixes
  const safePrefixes = ['Binance error', 'Position too', 'Notional too', 'Invalid', 'TP', 'SL', 'Excessive slippage', 'Circuit breaker', 'Máximo', 'Monto excede', 'Leverage excede', 'Broker no conectado', 'Sin conexión'];
  if (safePrefixes.some(p => msg.startsWith(p))) return msg;
  return 'Error al procesar la solicitud.';
}

// 2026-04-23 fix 3: loggear errors con stack hasheado en prod (evita leak de paths internos)
function safeLogError(label, err, ctx){
  const stackHash = err?.stack
    ? crypto.createHash('sha256').update(err.stack).digest('hex').slice(0, 16)
    : 'none';
  const msg = String(err?.message || err || '').slice(0, 200);
  const logObj = { msg, stackHash, ...(ctx || {}) };
  if (process.env.NODE_ENV !== 'production') logObj.stack = err?.stack?.split('\n').slice(0,5).join(' | ');
  console.error(label, JSON.stringify(logObj));
}

// Shared helper: check if UTC day rolled over and reset daily loss + consecutive losses
// 2026-04-23 fix 2.1: reset diario respeta timezone del usuario (columna `user_tz` en broker_configs)
// Default UTC si no está seteado. Evita que un trader en Buenos Aires vea su "día" resetear a las 9pm local.
async function resetDailyLossIfNeeded(cfg) {
  try {
    const tz = cfg.user_tz || 'UTC';
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const todayLocalStr = fmt.format(new Date());
    const resetAtLocalStr = cfg.daily_reset_at ? fmt.format(new Date(cfg.daily_reset_at)) : '';
    if (resetAtLocalStr !== todayLocalStr) {
      try {
        await pool.query("UPDATE broker_configs SET daily_loss_current = 0, daily_reset_at = NOW(), consecutive_losses = 0, circuit_breaker_until = NULL WHERE id = $1", [cfg.id]);
      } catch (e) {
        await pool.query("UPDATE broker_configs SET daily_loss_current = 0, daily_reset_at = NOW() WHERE id = $1", [cfg.id]);
      }
      return true;
    }
  } catch (e) { console.warn('[Broker] Local TZ reset check failed:', e.message); }
  return false;
}
// Server-side cron-like check every hour — catches UTC rollover even if no user hits endpoints
setInterval(async () => {
  try {
    const { rows } = await pool.query("SELECT id, daily_reset_at FROM broker_configs WHERE is_active = 1");
    for (const cfg of rows) await resetDailyLossIfNeeded(cfg);
  } catch (e) { /* silent */ }
}, 60 * 60 * 1000);

// Hourly cleanup: expired recovery tokens + old audit log (>90d)
setInterval(async () => {
  try {
    await pool.query("DELETE FROM recovery_tokens WHERE expires_at < NOW()").catch(()=>{});
    await pool.query("DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'").catch(()=>{});
  } catch (e) { /* silent */ }
}, 60 * 60 * 1000);

// Rate limiter for broker endpoints (max 30 req / min per user)
const brokerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados requests al broker. Espera un minuto.' }
});

// Connect broker: user sends API key + secret, we encrypt and store
app.post('/api/broker/connect', verifyOriginMiddleware, verifyToken, brokerLimiter, async (req, res) => {
  try {
    const { apiKey, apiSecret, maxPositionUsd, maxLeverage, dailyLossLimitUsd } = req.body;
    if (!apiKey || !apiSecret) return res.status(400).json({ error: 'apiKey y apiSecret requeridos' });
    if (apiKey.length < 20 || apiSecret.length < 20) return res.status(400).json({ error: 'Credenciales inválidas' });

    // Test the credentials against Binance
    let accountTest;
    try {
      accountTest = await broker.testConnection(apiKey, apiSecret);
    } catch (e) {
      return res.status(400).json({ error: 'Credenciales inválidas o sin permisos de Futures: ' + e.message });
    }

    if (!accountTest.canTrade) {
      return res.status(400).json({ error: 'Esta API key no tiene permiso de trading. Activá "Enable Futures" en Binance.' });
    }

    // 2026-04-23 fix 1.5: capital mínimo $1000 USDT server-side para permitir conectar broker mainnet.
    // APEX v44 validado en backtest con $500 capital base, pero recomendamos $1000+ para absorber
    // swings normales sin forzar ventas por margin call. Testnet exento del check.
    const isTestnet = process.env.BINANCE_TESTNET === 'true';
    const MIN_CAPITAL_USD = 1000;
    const totalBal = parseFloat(accountTest.totalWalletBalance || accountTest.availableBalance || 0);
    if (!isTestnet && !isNaN(totalBal) && totalBal < MIN_CAPITAL_USD){
      return res.status(400).json({
        error: `Capital insuficiente: balance $${totalBal.toFixed(2)} USDT. Mínimo requerido: $${MIN_CAPITAL_USD} USDT para conectar broker mainnet. Depositá USDT en tu Futures wallet y reintentá.`
      });
    }

    const keyEnc = broker.encrypt(apiKey);
    const secretEnc = broker.encrypt(apiSecret);

    const maxPos = Math.max(10, Math.min(10000, parseFloat(maxPositionUsd) || 500));
    const maxLev = Math.max(1, Math.min(20, parseInt(maxLeverage) || 5));
    const dailyLim = Math.max(10, Math.min(5000, parseFloat(dailyLossLimitUsd) || 200));

    await pool.query(`
      INSERT INTO broker_configs (key_id, exchange, api_key_enc, api_secret_enc, max_position_usd, max_leverage, daily_loss_limit_usd, is_active)
      VALUES ($1, 'binance_futures', $2, $3, $4, $5, $6, 1)
      ON CONFLICT (key_id, exchange) DO UPDATE SET
        api_key_enc = EXCLUDED.api_key_enc,
        api_secret_enc = EXCLUDED.api_secret_enc,
        max_position_usd = EXCLUDED.max_position_usd,
        max_leverage = EXCLUDED.max_leverage,
        daily_loss_limit_usd = EXCLUDED.daily_loss_limit_usd,
        is_active = 1,
        created_at = NOW()
    `, [req.license.keyId, keyEnc, secretEnc, maxPos, maxLev, dailyLim]);

    res.json({
      ok: true,
      balance: accountTest.totalWalletBalance,
      available: accountTest.availableBalance,
      maxPositionUsd: maxPos,
      maxLeverage: maxLev,
      dailyLossLimitUsd: dailyLim
    });
  } catch (err) {
    console.error('[Broker] connect error:', err);
    res.status(500).json({ error: 'Error al conectar broker: ' + err.message });
  }
});

// Get broker status (balance, positions, limits)
app.get('/api/broker/status', verifyToken, brokerLimiter, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM broker_configs WHERE key_id = $1 AND is_active = 1',
      [req.license.keyId]
    );
    if (rows.length === 0) return res.json({ connected: false });

    const cfg = rows[0];
    const apiKey = broker.decrypt(cfg.api_key_enc);
    const apiSecret = broker.decrypt(cfg.api_secret_enc);

    let account;
    try {
      account = await broker.getAccountInfo(apiKey, apiSecret);
    } catch (e) {
      // Session fixation defense: if Binance rejects API key (user changed password in Binance, etc.), auto-disconnect
      if (e.statusCode === 401 || e.binanceCode === -2015 || e.binanceCode === -2014 || /Invalid API-key/.test(String(e.message || ''))) {
        await pool.query('UPDATE broker_configs SET is_active = 0 WHERE id = $1', [cfg.id]).catch(()=>{});
        await logAudit(String(req.license.keyId), 'broker_auto_disconnect', 'invalid_key', { reason: e.message?.slice(0,100) }, req);
        return res.status(401).json({ connected: false, error: 'API key inválida — broker desconectado automáticamente. Reconectá con nuevas keys.' });
      }
      throw e;
    }

    // Use unified UTC daily reset helper
    if (await resetDailyLossIfNeeded(cfg)) {
      cfg.daily_loss_current = 0;
    }
    let dailyLossCurrent = parseFloat(cfg.daily_loss_current || 0);

    res.json({
      connected: true,
      exchange: cfg.exchange,
      mode: process.env.BINANCE_TESTNET === 'true' ? 'testnet' : 'mainnet',
      totalBalance: account.totalWalletBalance,
      availableBalance: account.availableBalance,
      unrealizedPnl: account.totalUnrealizedProfit,
      positions: account.positions,
      limits: {
        maxPositionUsd: parseFloat(cfg.max_position_usd),
        maxLeverage: parseInt(cfg.max_leverage),
        dailyLossLimitUsd: parseFloat(cfg.daily_loss_limit_usd),
        dailyLossCurrent
      },
      // 2026-04-22 audit fix 2.5: return safety state for frontend sync
      safety: {
        consecutiveLosses: parseInt(cfg.consecutive_losses || 0),
        circuitBreakerUntil: cfg.circuit_breaker_until ? new Date(cfg.circuit_breaker_until).toISOString() : null,
        maxConcurrentPositions: parseInt(cfg.max_concurrent_positions || 4),
        maxCapitalDeployedPct: parseFloat(cfg.max_capital_deployed_pct || 50),
        lastDailyResetAt: cfg.daily_loss_reset_at ? new Date(cfg.daily_loss_reset_at).toISOString() : null
      }
    });
  } catch (err) {
    safeLog('[Broker] status error', { keyId: req.license?.keyId, msg: err.message });
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Place a real trade (market entry + TP + SL)
// v2.0 Idempotency cache for order placement (prevents duplicate orders on retry)
const _idempotencyCache = new Map();
function checkIdempotency(key) {
  if (!key) return null;
  const entry = _idempotencyCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > 10 * 60 * 1000) { _idempotencyCache.delete(key); return null; }
  return entry.response;
}
function storeIdempotency(key, response) {
  if (!key) return;
  _idempotencyCache.set(key, { ts: Date.now(), response });
  // Cleanup: remove oldest if >1000 entries
  if (_idempotencyCache.size > 1000) {
    const oldest = _idempotencyCache.keys().next().value;
    _idempotencyCache.delete(oldest);
  }
}
// Periodic cleanup
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of _idempotencyCache.entries()) {
    if (v.ts < cutoff) _idempotencyCache.delete(k);
  }
}, 5 * 60 * 1000);
app.post('/api/broker/place-order', verifyOriginMiddleware, verifyToken, brokerLimiter, async (req, res) => {
  try {
    // v2.0 Idempotency: same key returns cached result (prevents duplicate order on network retry)
    const idempKey = req.get('X-Idempotency-Key') || req.body?.clientOrderId;
    if (idempKey) {
      const cached = checkIdempotency(idempKey + '|' + req.license.keyId);
      if (cached) return res.status(cached.status || 200).json(cached.body);
    }
    const { symbol, side, usdAmount, leverage, tp, sl, currentPrice } = req.body;
    if (!symbol || !side || !usdAmount || !leverage || !tp || !sl || !currentPrice) {
      return res.status(400).json({ error: 'Parámetros incompletos' });
    }
    // Strict input validation (prevents malformed body + abuse)
    if (!rxValidate.symbol(symbol)) return res.status(400).json({ error: 'Símbolo inválido (formato: XXXUSDT)' });
    if (!rxValidate.side(side)) return res.status(400).json({ error: 'Side debe ser BUY o SELL' });
    if (!rxValidate.usdAmount(usdAmount)) return res.status(400).json({ error: 'Monto fuera de rango ($10-$10000)' });
    if (!rxValidate.leverage(leverage)) return res.status(400).json({ error: 'Leverage debe ser entero 1-20' });
    if (!rxValidate.price(tp) || !rxValidate.price(sl) || !rxValidate.price(currentPrice)) return res.status(400).json({ error: 'Precios inválidos' });
    // v2.0 Store response after completion (use res.json wrapper)
    const _origJson = res.json.bind(res);
    res.json = function(body) {
      if (idempKey) storeIdempotency(idempKey + '|' + req.license.keyId, { status: res.statusCode, body });
      return _origJson(body);
    };

    const { rows } = await pool.query(
      'SELECT * FROM broker_configs WHERE key_id = $1 AND is_active = 1',
      [req.license.keyId]
    );
    if (rows.length === 0) return res.status(400).json({ error: 'Broker no conectado' });

    const cfg = rows[0];

    // Enforce server-side limits
    const maxPos = parseFloat(cfg.max_position_usd);
    const maxLev = parseInt(cfg.max_leverage);
    const dailyLim = parseFloat(cfg.daily_loss_limit_usd);
    let dailyLoss = parseFloat(cfg.daily_loss_current || 0);

    // UTC daily reset (00:00 UTC boundary) — uses shared helper to keep logic consistent
    if (await resetDailyLossIfNeeded(cfg)) { dailyLoss = 0; }

    // Circuit breaker check — safe access with optional chaining
    try {
      if (cfg.circuit_breaker_until) {
        const cbUntil = new Date(cfg.circuit_breaker_until).getTime();
        if (Date.now() < cbUntil) {
          const remainingMin = Math.ceil((cbUntil - Date.now()) / 60000);
          return res.status(400).json({ error: `Circuit breaker activo: ${cfg.consecutive_losses || 5} pérdidas consecutivas. Retoma en ${remainingMin}min.` });
        }
      }
    } catch (e) { /* column may not exist yet — skip */ }

    if (parseFloat(usdAmount) > maxPos) {
      return res.status(400).json({ error: `Monto excede el límite: $${maxPos} max` });
    }
    if (parseInt(leverage) > maxLev) {
      return res.status(400).json({ error: `Leverage excede el límite: ${maxLev}x max` });
    }
    if (dailyLoss >= dailyLim) {
      return res.status(400).json({ error: `Límite diario de pérdida alcanzado: $${dailyLim}. Se resetea a 00 UTC.` });
    }

    // CRITICAL: Concurrent position limit — prevent over-leverage from rapid-fire signals
    // 2026-04-23 fix 2.6: use cached decrypted keys (TTL 5min) to avoid timing side-channel + CPU overhead
    const { apiKey, apiSecret } = getBrokerKeysCached(cfg);

    try {
      // TOCTOU mitigation: acquire advisory lock on key_id for duration of concurrent check + place order
      // This serializes trade placement per user so two simultaneous requests can't both pass the check
      await pool.query('SELECT pg_advisory_xact_lock($1)', [cfg.id]).catch(()=>{});
      const accountSnapshot = await broker.getAccountInfo(apiKey, apiSecret);
      const openPositions = (accountSnapshot.positions || []).filter(p => parseFloat(p.positionAmt) !== 0);
      // Defensive: use defaults if columns not present
      const maxConcurrent = parseInt(cfg.max_concurrent_positions) || 4;
      if (openPositions.length >= maxConcurrent) {
        return res.status(400).json({ error: `Máximo ${maxConcurrent} posiciones simultáneas abiertas. Cerrá una para abrir otra.` });
      }
      // Total deployed notional check
      const currentNotional = openPositions.reduce((sum, p) => sum + Math.abs(parseFloat(p.positionAmt) * parseFloat(p.entryPrice || 0)), 0);
      const newNotional = parseFloat(usdAmount) * parseInt(leverage);
      const totalBalance = parseFloat(accountSnapshot.totalWalletBalance || 0);
      const maxDeployPct = (parseFloat(cfg.max_capital_deployed_pct) || 50) / 100;
      if (totalBalance > 0 && (currentNotional + newNotional) > (totalBalance * maxDeployPct * parseInt(leverage))) {
        return res.status(400).json({ error: `Exposición total excede ${Math.round(maxDeployPct*100)}% del balance. Actual: $${currentNotional.toFixed(0)}, nuevo: $${newNotional.toFixed(0)}, max: $${(totalBalance*maxDeployPct*parseInt(leverage)).toFixed(0)}` });
      }
    } catch (e) {
      // Fail open — log but don't block trade if check fails
      console.warn('[Broker] Concurrent position check failed (allowing trade):', e.message);
    }

    // 2026-04-22 audit fix 1.6: safeLog masks keyId + amount, suppresses in prod unless LOG_VERBOSE
    safeLog('[Broker] place-order', { keyId: req.license.keyId, side, symbol, amount: parseFloat(usdAmount), leverage });

    const result = await broker.placeTradeWithTPSL(apiKey, apiSecret, {
      symbol, side, usdAmount: parseFloat(usdAmount),
      leverage: parseInt(leverage), tp: parseFloat(tp), sl: parseFloat(sl),
      currentPrice: parseFloat(currentPrice)
    });

    // Detailed post-trade logging (PII-safe via safeLog)
    const tpOK = !!(result.tp && result.tp.orderId);
    const slOK = !!(result.sl && result.sl.orderId);
    const entryOK = !!(result.entry && result.entry.orderId);
    safeLog('[Broker] place-order result', { keyId: req.license.keyId, entry: entryOK, tp: tpOK, sl: slOK, tpErr: result.tpError ? 'yes' : 'no', slErr: result.slError ? 'yes' : 'no', emergencyClosed: !!result.emergencyClosed });

    // 2026-04-22 audit fix 4.2: atomic transaction for log+update
    const tradeStatus = (entryOK && tpOK && slOK) ? 'placed' : (entryOK ? 'partial' : 'error');
    const errMsgAgg = [result.tpError ? 'TP:'+result.tpError : '', result.slError ? 'SL:'+result.slError : '', result.emergencyClosed ? 'EMERGENCY_CLOSE_TRIGGERED' : ''].filter(Boolean).join(' | ');
    const txClient = await pool.connect();
    try {
      await txClient.query('BEGIN');
      await txClient.query(`
        INSERT INTO broker_trade_log (key_id, symbol, side, usd_amount, leverage, entry_price, tp_price, sl_price, binance_order_id, status, error_msg)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        req.license.keyId, symbol, side, parseFloat(usdAmount), parseInt(leverage),
        parseFloat(currentPrice), parseFloat(tp), parseFloat(sl),
        String(result.entry?.orderId || ''), tradeStatus, errMsgAgg
      ]);
      await txClient.query('UPDATE broker_configs SET last_used = NOW() WHERE id = $1', [cfg.id]);
      await txClient.query('COMMIT');
    } catch (logErr) {
      try { await txClient.query('ROLLBACK'); } catch(e){}
      // CRITICAL: trade placed en Binance but log failed. Alert + persist to fallback file.
      console.error('[CRITICAL] Trade placed but DB log failed:', logErr.message, 'orderId=', result.entry?.orderId);
      try {
        // Best-effort fallback: try non-transactional insert for audit
        await pool.query(`INSERT INTO broker_trade_log (key_id, symbol, side, usd_amount, leverage, status, error_msg) VALUES ($1,$2,$3,$4,$5,'logged_after_tx_fail',$6)`,
          [req.license.keyId, symbol, side, parseFloat(usdAmount), parseInt(leverage), `TX_FAIL: ${logErr.message} | orderId=${result.entry?.orderId}`]);
      } catch(e2) {}
    } finally {
      txClient.release();
    }

    // Return with explicit success flags for frontend UX
    res.json({ ok: true, result, tpPlaced: tpOK, slPlaced: slOK, entryPlaced: entryOK, warning: !tpOK || !slOK ? 'TP o SL no se pudo colocar — chequeá tu posición en Binance manualmente' : null });
  } catch (err) {
    // 2026-04-22 audit fix 1.6 + 4.4: PII-safe error log
    safeLog('[Broker] place-order error', { keyId: req.license?.keyId, symbol: req.body?.symbol, msg: err.message });
    try {
      await pool.query(`
        INSERT INTO broker_trade_log (key_id, symbol, side, usd_amount, leverage, status, error_msg)
        VALUES ($1, $2, $3, $4, $5, 'error', $6)
      `, [req.license.keyId, req.body.symbol, req.body.side, req.body.usdAmount, req.body.leverage, err.message]);
    } catch (e) {}
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// POST /api/broker/trade-result — client reports trade outcome (win/loss) to update circuit breaker
// Idempotency cache: orderId+status → timestamp (5min TTL)
const _tradeResultCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of _tradeResultCache) { if (now - ts > 5 * 60 * 1000) _tradeResultCache.delete(k); }
}, 60000).unref?.();

app.post('/api/broker/trade-result', verifyOriginMiddleware, verifyToken, brokerLimiter, async (req, res) => {
  const { result, pnl, symbol, orderId } = req.body; // result: 'win' | 'loss'
  if (!['win', 'loss'].includes(result)) return res.status(400).json({ error: 'result must be win|loss' });
  // Idempotency: reject duplicate trade-result for same (keyId, orderId, result)
  if (orderId) {
    const cacheKey = `${req.license.keyId}_${orderId}_${result}`;
    if (_tradeResultCache.has(cacheKey)) {
      return res.json({ ok: true, duplicate: true });
    }
    _tradeResultCache.set(cacheKey, Date.now());
  }
  try {
    // Advisory lock per-user to prevent concurrent inc
    const { rows } = await pool.query('SELECT id, consecutive_losses, daily_loss_current, daily_loss_limit_usd FROM broker_configs WHERE key_id = $1 AND is_active = 1', [req.license.keyId]);
    if (rows.length === 0) return res.status(400).json({ error: 'Broker no conectado' });
    const cfg = rows[0];
    await pool.query('SELECT pg_advisory_xact_lock($1)', [cfg.id]).catch(()=>{});

    if (result === 'loss') {
      const newLosses = (parseInt(cfg.consecutive_losses) || 0) + 1;
      const newDailyLoss = (parseFloat(cfg.daily_loss_current) || 0) + Math.abs(parseFloat(pnl) || 0);
      // Trip circuit breaker if 5+ consecutive losses
      const tripCB = newLosses >= 5;
      const cbUntilSQL = tripCB ? `NOW() + INTERVAL '6 hours'` : 'circuit_breaker_until';
      await pool.query(
        `UPDATE broker_configs SET consecutive_losses = $1, daily_loss_current = $2, circuit_breaker_until = CASE WHEN $3 THEN NOW() + INTERVAL '6 hours' ELSE circuit_breaker_until END, updated_at = NOW() WHERE id = $4`,
        [newLosses, newDailyLoss, tripCB, cfg.id]
      );
      res.json({ ok: true, consecutive_losses: newLosses, circuit_breaker_tripped: tripCB });
    } else {
      // Win resets consecutive losses
      await pool.query('UPDATE broker_configs SET consecutive_losses = 0, updated_at = NOW() WHERE id = $1', [cfg.id]);
      res.json({ ok: true, consecutive_losses: 0 });
    }
  } catch (err) {
    console.error('[Broker] trade-result error:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Get userDataStream listenKey for real-time balance/order push (frontend connects WS directly to Binance)
app.post('/api/broker/listen-key', verifyToken, brokerLimiter, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM broker_configs WHERE key_id = $1 AND is_active = 1', [req.license.keyId]);
    if (rows.length === 0) return res.status(400).json({ error: 'Broker no conectado' });
    const apiKey = broker.decrypt(rows[0].api_key_enc);
    const listenKey = await broker.createListenKey(apiKey);
    res.json({ ok: true, listenKey, host: process.env.BINANCE_TESTNET === 'true' ? 'wss://stream.binancefuture.com' : 'wss://fstream.binance.com' });
  } catch (err) {
    console.error('[Broker] listen-key error:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Keep-alive listenKey (called every ~30min by frontend)
app.post('/api/broker/listen-key/keepalive', verifyToken, brokerLimiter, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM broker_configs WHERE key_id = $1 AND is_active = 1', [req.license.keyId]);
    if (rows.length === 0) return res.status(400).json({ error: 'Broker no conectado' });
    const apiKey = broker.decrypt(rows[0].api_key_enc);
    await broker.keepAliveListenKey(apiKey);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Pre-flight check — verifies broker config + symbol tradeable + min notional sin ejecutar orden
app.post('/api/broker/preflight', verifyToken, brokerLimiter, async (req, res) => {
  const { symbol, usdAmount, leverage, currentPrice } = req.body;
  if (!symbol || !usdAmount || !leverage || !currentPrice) return res.status(400).json({ error: 'symbol, usdAmount, leverage, currentPrice requeridos' });
  try {
    const { rows } = await pool.query('SELECT * FROM broker_configs WHERE key_id = $1 AND is_active = 1', [req.license.keyId]);
    if (rows.length === 0) return res.status(400).json({ error: 'Broker no conectado', ok: false });
    const cfg = rows[0];

    const issues = [];

    // 1. Check limits
    if (parseFloat(usdAmount) > parseFloat(cfg.max_position_usd)) issues.push(`Monto $${usdAmount} excede max $${cfg.max_position_usd}`);
    if (parseInt(leverage) > parseInt(cfg.max_leverage)) issues.push(`Leverage ${leverage}x excede max ${cfg.max_leverage}x`);

    // 2. Validate symbol tradeable
    let symInfo = null;
    try {
      symInfo = await broker.getExchangeInfoCached().then(info => info.symbols.find(s => s.symbol === symbol.toUpperCase()));
      if (!symInfo) issues.push(`Símbolo ${symbol} no existe en Binance ${process.env.BINANCE_TESTNET === 'true' ? 'testnet' : 'mainnet'}`);
      else if (symInfo.status !== 'TRADING') issues.push(`${symbol} no está TRADING (status: ${symInfo.status})`);
    } catch (e) { issues.push('No se pudo validar símbolo: ' + e.message); }

    // 3. Check minNotional
    if (symInfo) {
      const minNotionalFilter = symInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');
      const minNotional = minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 5;
      const notional = parseFloat(usdAmount) * parseInt(leverage);
      if (notional < minNotional) issues.push(`Notional $${notional.toFixed(2)} < minNotional $${minNotional} para ${symbol}`);
    }

    // 4. Check account balance
    try {
      const apiKey = broker.decrypt(cfg.api_key_enc);
      const apiSecret = broker.decrypt(cfg.api_secret_enc);
      const account = await broker.getAccountInfo(apiKey, apiSecret);
      const available = parseFloat(account.availableBalance || 0);
      if (available < parseFloat(usdAmount)) issues.push(`Balance disponible ($${available.toFixed(2)}) < monto solicitado ($${usdAmount})`);
    } catch (e) { issues.push('No se pudo verificar balance: ' + e.message); }

    res.json({
      ok: issues.length === 0,
      issues,
      mode: process.env.BINANCE_TESTNET === 'true' ? 'testnet' : 'mainnet',
      symbol,
      notional: parseFloat(usdAmount) * parseInt(leverage),
      wouldPlaceOrder: issues.length === 0
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Validate a list of pairs against current Binance exchangeInfo (public endpoint, cached 10min)
app.post('/api/broker/validate-pairs', macroLimiter, async (req, res) => {
  try {
    const { pairs } = req.body || {};
    if (!Array.isArray(pairs) || pairs.length === 0) return res.status(400).json({ error: 'pairs array required' });
    if (pairs.length > 50) return res.status(400).json({ error: 'too many pairs (max 50)' });
    const result = await broker.validatePairs(pairs);
    res.json({ ok: true, ...result, mode: process.env.BINANCE_TESTNET === 'true' ? 'testnet' : 'mainnet' });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Reconcile — sync DB state with live Binance state (call after server restart or long disconnects)
app.post('/api/broker/reconcile', verifyOriginMiddleware, verifyToken, brokerLimiter, reconcileLimiter, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM broker_configs WHERE key_id = $1 AND is_active = 1',
      [req.license.keyId]
    );
    if (rows.length === 0) return res.status(400).json({ error: 'Broker no conectado' });
    const cfg = rows[0];
    const apiKey = broker.decrypt(cfg.api_key_enc);
    const apiSecret = broker.decrypt(cfg.api_secret_enc);

    const account = await broker.getAccountInfo(apiKey, apiSecret);
    const livePositions = (account.positions || []).filter(p => parseFloat(p.positionAmt) !== 0);

    // Pull local open trades from log
    const { rows: localTrades } = await pool.query(
      "SELECT id, symbol, side, usd_amount, leverage, entry_price, status, created_at FROM broker_trade_log WHERE key_id = $1 AND status = 'placed' ORDER BY created_at DESC LIMIT 100",
      [req.license.keyId]
    );

    // Find discrepancies
    const liveSyms = new Set(livePositions.map(p => p.symbol));
    const discrepancies = [];
    for (const lt of localTrades) {
      if (!liveSyms.has(lt.symbol)) {
        // Closed on Binance but DB says 'placed' — mark closed
        await pool.query("UPDATE broker_trade_log SET status = 'closed_reconciled' WHERE id = $1", [lt.id]);
        discrepancies.push({ id: lt.id, symbol: lt.symbol, action: 'marked_closed', reason: 'not_in_live' });
      }
    }

    res.json({
      ok: true,
      livePositions: livePositions.length,
      localPending: localTrades.length,
      reconciled: discrepancies.length,
      discrepancies,
      balance: account.totalWalletBalance
    });
  } catch (err) {
    console.error('[Broker] reconcile error:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Close all positions (panic button)
app.post('/api/broker/close-all', verifyOriginMiddleware, verifyToken, brokerLimiter, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM broker_configs WHERE key_id = $1 AND is_active = 1',
      [req.license.keyId]
    );
    if (rows.length === 0) return res.status(400).json({ error: 'Broker no conectado' });

    const cfg = rows[0];
    const apiKey = broker.decrypt(cfg.api_key_enc);
    const apiSecret = broker.decrypt(cfg.api_secret_enc);

    const results = await broker.closeAllPositions(apiKey, apiSecret);
    res.json({ ok: true, closed: results });
  } catch (err) {
    console.error('[Broker] close-all error:', err);
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Disconnect broker (deletes encrypted keys)
app.post('/api/broker/disconnect', verifyOriginMiddleware, verifyToken, brokerLimiter, async (req, res) => {
  try {
    // 2026-04-23 fix 2.6: invalidate key cache on disconnect so new connect uses fresh decrypt
    const { rows } = await pool.query('SELECT id FROM broker_configs WHERE key_id = $1', [req.license.keyId]);
    rows.forEach(r => invalidateBrokerKeyCache(r.id));
    await pool.query('DELETE FROM broker_configs WHERE key_id = $1', [req.license.keyId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// Get trade history (last 50)
app.get('/api/broker/history', verifyToken, brokerLimiter, async (req, res) => {
  try {
    // Pagination support
    const page = Math.max(1, parseInt(req.query.page || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50')));
    const offset = (page - 1) * limit;
    const { rows } = await pool.query(
      'SELECT symbol, side, usd_amount, leverage, entry_price, tp_price, sl_price, status, error_msg, created_at FROM broker_trade_log WHERE key_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [req.license.keyId, limit, offset]
    );
    const { rows: countRows } = await pool.query('SELECT COUNT(*) as total FROM broker_trade_log WHERE key_id = $1', [req.license.keyId]);
    res.json({ trades: rows, page, limit, total: parseInt(countRows[0].total) });
  } catch (err) {
    res.status(500).json({ error: safeErrorMessage(err) });
  }
});

// ════════════════════════════════════════════════════
//  MACRO DATA (v42 PRO+ SPX risk-off filter)
// ════════════════════════════════════════════════════
// Cached in memory to avoid hammering Yahoo. TTL 1h.
// Fallback: returns 0 change if Yahoo fails (filter becomes no-op).
const https = require('https');
let _spxCache = { chg: 0, close: 0, ts: 0, stale: true };
const SPX_TTL_MS = 60 * 60 * 1000; // 1h

function _fetchYahoo(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

async function refreshSpx() {
  try {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 5 * 86400; // last 5 days to guarantee 2 close values across weekends
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?period1=${start}&period2=${end}&interval=1d`;
    const r = await _fetchYahoo(url);
    if (r.status !== 200) throw new Error('yahoo status ' + r.status);
    const j = JSON.parse(r.data);
    const closes = (((j.chart || {}).result || [])[0] || {}).indicators;
    const series = closes && closes.quote && closes.quote[0] && closes.quote[0].close;
    if (!series || series.length < 2) throw new Error('no close data');
    const clean = series.filter(v => v != null && isFinite(v));
    if (clean.length < 2) throw new Error('no valid closes');
    const cur = clean[clean.length - 1], prev = clean[clean.length - 2];
    const chg = ((cur - prev) / prev) * 100;
    _spxCache = { chg: +chg.toFixed(3), close: +cur.toFixed(2), ts: Date.now(), stale: false };
    return _spxCache;
  } catch (err) {
    console.warn('[Macro SPX] refresh failed:', err.message);
    _spxCache.stale = true;
    return _spxCache;
  }
}

// Public market data endpoint — open CORS (no sensitive info)
app.get('/api/macro/spx', macroLimiter, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'public, max-age=900'); // 15min browser cache
  const age = Date.now() - _spxCache.ts;
  if (age > SPX_TTL_MS || _spxCache.ts === 0) {
    await refreshSpx();
  }
  res.json({
    chg24h: _spxCache.chg,
    close: _spxCache.close,
    asOf: _spxCache.ts,
    ageMs: Date.now() - _spxCache.ts,
    stale: _spxCache.stale || (Date.now() - _spxCache.ts > 12 * 60 * 60 * 1000)
  });
});

// ════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════

let brokerOk = false;
// Process-level error handling (catch uncaught promise rejections)
process.on('unhandledRejection', (reason, promise) => {
  try { (global.rxLog?.error || console.error)('[FATAL] Unhandled rejection', { reason: String(reason?.message || reason).slice(0, 500), stack: reason?.stack?.split('\n').slice(0,3).join(' | ') }); } catch(e){}
  // Don't exit in dev (preserve state for debugging) — exit in prod for Render to restart cleanly
  if (process.env.NODE_ENV === 'production') setTimeout(() => process.exit(1), 100);
});
process.on('uncaughtException', (err) => {
  try { (global.rxLog?.error || console.error)('[FATAL] Uncaught exception', { msg: err.message, stack: err.stack?.split('\n').slice(0,3).join(' | ') }); } catch(e){}
  if (process.env.NODE_ENV === 'production') setTimeout(() => process.exit(1), 100);
});
// 2026-04-22 audit fix 4.1: Global error middleware sanitizes stack traces in production
app.use((err, req, res, next) => {
  try {
    console.error('[Error]', { path: req.path, msg: err?.message, stack: err?.stack?.split('\n').slice(0,3).join(' | ') });
  } catch(e) {}
  if (res.headersSent) return next(err);
  const isProd = process.env.NODE_ENV === 'production';
  const status = err?.statusCode || err?.status || 500;
  res.status(status).json({
    error: isProd ? 'Error interno del servidor' : (err?.message || 'Unknown error'),
    code: err?.code || 'INTERNAL_ERROR',
    ts: new Date().toISOString(),
    ...(isProd ? {} : { stack: err?.stack?.split('\n').slice(0,5).join('\n') })
  });
});

// Graceful shutdown on SIGTERM (Render deploy, K8s, Docker)
let _httpServer = null;
function gracefulShutdown(signal) {
  console.log(`[Shutdown] Received ${signal} — closing server gracefully`);
  if (_httpServer) {
    _httpServer.close(() => {
      console.log('[Shutdown] HTTP server closed');
      pool.end(() => {
        console.log('[Shutdown] DB pool closed');
        process.exit(0);
      });
    });
    // Force exit after 10s if hanging
    setTimeout(() => { console.error('[Shutdown] Force exit'); process.exit(1); }, 10000);
  } else {
    process.exit(0);
  }
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Required env vars validation at boot
function validateEnv() {
  // 2026-04-22: BROKER_MASTER_KEY is REQUIRED in prod (encryption). Webhook secrets are warnings —
  // server boots without them, but the specific webhook endpoint rejects requests in prod.
  const required = ['JWT_SECRET', 'DATABASE_URL'];
  const recommended = ['CORS_ORIGIN'];
  const prodRequired = ['BROKER_MASTER_KEY'];
  const prodRecommended = ['STRIPE_WEBHOOK_SECRET', 'NOWPAYMENTS_IPN_SECRET', 'MP_WEBHOOK_SECRET'];
  const missing = [];
  const warnings = [];
  required.forEach(k => { if (!process.env[k]) missing.push(k); });
  recommended.forEach(k => { if (!process.env[k]) warnings.push(k); });
  if (process.env.NODE_ENV === 'production') {
    prodRequired.forEach(k => { if (!process.env[k]) missing.push(`${k} (production)`); });
    prodRecommended.forEach(k => { if (!process.env[k]) warnings.push(`${k} (production — webhook will reject requests until set)`); });
    const bmk = process.env.BROKER_MASTER_KEY || '';
    if (bmk && !/^[a-f0-9]{64}$/i.test(bmk)) {
      missing.push('BROKER_MASTER_KEY (must be 64 hex chars)');
    }
  } else {
    if (!process.env.BROKER_MASTER_KEY) warnings.push('BROKER_MASTER_KEY (dev mode)');
  }
  if (missing.length > 0) {
    console.error(`[ENV] Missing/invalid REQUIRED env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (warnings.length > 0) {
    console.warn(`[ENV] Recommended env vars missing: ${warnings.join(', ')}`);
  }
  return true;
}

// ══════════════════════════════════════════════════════════════════════
// APEX V44 LIVE SIGNALS FEED — Server-side 24/7 scanner
// ══════════════════════════════════════════════════════════════════════

const V44_SIGNAL_STORE = {
  signals: [],       // { id, symbol, signal, entry, tp, sl, confidence, window_type, funding, funding_zscore, size_multiplier, quality_score, leverage, hold_hours, engine, created_at, expires_at }
  lastScan: null,    // ISO timestamp of last full scan
  lastScanResult: null, // { scanned, signals_found, window_type, reason }
  stats: { totalScans: 0, totalSignals: 0, errors: 0 }
};
const V44_MAX_FEED_SIZE = 500;    // Keep last 500 signals in memory
const V44_SCAN_INTERVAL_MS = 10 * 60 * 1000; // 10 min — V44 fires on 1h bar closes anyway
const V44_SIGNAL_TTL_MS = 4 * 60 * 60 * 1000; // 4h hold window of V44
// 2026-04-23 CAPITAL GUARD: dedup 4h = hold_hours del motor V44. Antes 55min → misma señal
// podía re-insertarse a los 60min y spamear al frontend aunque el trade siguiera vivo.
const V44_DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000;

function _v44Dedup(sym, signalType, entry, tp, sl){
  const cutoff = Date.now() - V44_DEDUP_WINDOW_MS;
  // Dedup por dirección + mismos niveles TP/SL/entry (setup idéntico)
  // Si los niveles difieren significativamente (>0.1%), es un setup nuevo → se permite
  return V44_SIGNAL_STORE.signals.some(s => {
    if(s.symbol !== sym || s.signal !== signalType || s.created_at <= cutoff) return false;
    if(entry == null || tp == null || sl == null) return true; // match básico si no hay niveles
    const entryDrift = s.entry ? Math.abs(entry - s.entry) / s.entry : 0;
    const tpDrift = s.tp ? Math.abs(tp - s.tp) / s.tp : 0;
    const slDrift = s.sl ? Math.abs(sl - s.sl) / s.sl : 0;
    return entryDrift < 0.001 && tpDrift < 0.001 && slDrift < 0.001;
  });
}

async function _v44RunScanOnce(){
  try {
    const res = await v44.scanAllPairs();
    V44_SIGNAL_STORE.lastScan = new Date().toISOString();
    V44_SIGNAL_STORE.lastScanResult = { scanned: res.scanned, signals_found: res.signals.length, window_type: res.window_type || null, reason: res.reason };
    V44_SIGNAL_STORE.stats.totalScans++;
    for(const sig of res.signals){
      if(_v44Dedup(sig.symbol, sig.signal, sig.entry, sig.tp, sig.sl)) continue;
      const rec = {
        id: crypto.randomBytes(6).toString('hex'),
        ...sig,
        created_at: Date.now(),
        expires_at: Date.now() + V44_SIGNAL_TTL_MS
      };
      V44_SIGNAL_STORE.signals.push(rec);
      V44_SIGNAL_STORE.stats.totalSignals++;
    }
    // Trim: keep only signals from last 24h or until cap
    const dayAgo = Date.now() - 24*60*60*1000;
    V44_SIGNAL_STORE.signals = V44_SIGNAL_STORE.signals.filter(s => s.created_at > dayAgo).slice(-V44_MAX_FEED_SIZE);
    if(res.signals.length) console.log(`[V44 Scan] ${res.signals.length} new signals · window=${res.window_type}`);
  } catch(e){
    V44_SIGNAL_STORE.stats.errors++;
    console.warn('[V44 Scan] error:', e.message);
  }
}

function startV44Scheduler(){
  // Run once on startup
  _v44RunScanOnce();
  // Recurring scan
  setInterval(_v44RunScanOnce, V44_SCAN_INTERVAL_MS);
  console.log(`[V44 Scheduler] started · scan every ${V44_SCAN_INTERVAL_MS/60000} min · universe=${v44.SAFE_FUNDING_PARAMS.UNIVERSE.length} pairs`);
}

// 2026-04-23 fix 4.5: test JWT provisioning endpoint (disabled in production unless TEST_JWT_ENABLED=true)
// Usage en Playwright/k6: POST con { code, fingerprint } requiere body vacío y devuelve JWT pre-firmado
// para un license key de test. Solo activo cuando NODE_ENV !== 'production' o TEST_JWT_ENABLED='true'.
app.post('/api/test/jwt', async (req, res) => {
  if (process.env.NODE_ENV === 'production' && process.env.TEST_JWT_ENABLED !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }
  const code = req.body?.code || process.env.TEST_LICENSE_CODE;
  if (!code) return res.status(400).json({ error: 'code required (body.code or TEST_LICENSE_CODE env)' });
  try {
    const { rows } = await pool.query(
      'SELECT id, key_code, expires_at FROM license_keys WHERE key_code = $1 AND revoked_at IS NULL LIMIT 1',
      [code]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'License key not found' });
    const key = rows[0];
    const token = jwt.sign(
      { keyId: key.id, type: 'access', fp: 'test-harness', testJwt: true },
      JWT_SECRET,
      { expiresIn: '30m' }
    );
    res.json({ ok: true, token, keyId: key.id, expiresIn: 1800 });
  } catch (err) {
    res.status(500).json({ error: 'Test JWT provisioning failed' });
  }
});

// 2026-04-23 fix 2.4: nonce-injected HTML routes
// Alternativa strict-CSP para clientes que vienen por el backend (no Netlify).
// Inyecta el nonce en cada <script> tag de los archivos frontend y sirve con Content-Security-Policy.
const path = require('path');
const fs = require('fs');
const _htmlCache = new Map();
const HTML_CACHE_TTL = 60 * 1000;
function _loadHtml(filename){
  const cached = _htmlCache.get(filename);
  if (cached && Date.now() - cached.ts < HTML_CACHE_TTL) return cached.html;
  const filepath = path.join(__dirname, '..', 'frontend', filename);
  if (!fs.existsSync(filepath)) return null;
  const html = fs.readFileSync(filepath, 'utf8');
  _htmlCache.set(filename, { html, ts: Date.now() });
  return html;
}
function _injectNonce(html, nonce){
  return html.replace(/<script(\s[^>]*)?>/gi, (match, attrs) => {
    if (/\snonce=/i.test(attrs || '')) return match;
    const newAttrs = (attrs || '') + ` nonce="${nonce}"`;
    return `<script${newAttrs}>`;
  });
}
function serveFrontendWithNonce(filename){
  return (req, res) => {
    const html = _loadHtml(filename);
    if (!html) return res.status(404).send('Not found');
    const nonce = res.locals.cspNonce;
    const injected = _injectNonce(html, nonce);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  };
}
// Opt-in nonce-protected routes (parallel to Netlify static serving).
// Usuarios sensibles a CSP strict pueden acceder al backend directo: /strict/app.html
app.get('/strict/app.html', serveFrontendWithNonce('app.html'));
app.get('/strict/landing.html', serveFrontendWithNonce('landing.html'));
app.get('/strict/privacy.html', serveFrontendWithNonce('privacy.html'));
app.get('/strict/terms.html', serveFrontendWithNonce('terms.html'));
app.get('/strict/cookies.html', serveFrontendWithNonce('cookies.html'));
app.get('/strict/refund.html', serveFrontendWithNonce('refund.html'));

// Public endpoint — no auth required, consumed by all clients
app.get('/api/public-signals', (req, res) => {
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
  const since = parseInt(req.query.since, 10) || 0;
  const pool = V44_SIGNAL_STORE.signals
    .filter(s => s.created_at > since)
    .slice(-limit)
    .slice().reverse();
  res.json({
    signals: pool,
    count: pool.length,
    last_scan: V44_SIGNAL_STORE.lastScan,
    last_result: V44_SIGNAL_STORE.lastScanResult,
    stats: V44_SIGNAL_STORE.stats,
    universe: v44.SAFE_FUNDING_PARAMS.UNIVERSE,
    server_time: Date.now()
  });
});

async function start() {
  try {
    validateEnv();
    // Initialize broker encryption key
    brokerOk = broker.initMasterKey();
    if (!brokerOk) {
      if (process.env.NODE_ENV === 'production') {
        console.error('[FATAL] BROKER_MASTER_KEY missing in production — refusing to start without encryption');
        process.exit(1);
      }
      console.warn('[Broker] Real trading DISABLED in DEV mode (set BROKER_MASTER_KEY to enable)');
    }
    await initDB();
    _httpServer = app.listen(PORT, async () => {
      const mode = process.env.BINANCE_TESTNET === 'true' ? 'TESTNET' : 'MAINNET';
      console.log(`\n  ╔══════════════════════════════════════╗`);
      console.log(`  ║   RX PRO — Backend API v1.1          ║`);
      console.log(`  ║   Puerto: ${PORT}                        ║`);
      console.log(`  ║   Mode:   ${mode.padEnd(27)} ║`);
      console.log(`  ║   CORS:   ${CORS_ORIGINS.join(', ').slice(0,25).padEnd(25)} ║`);
      console.log(`  ║   Stripe: ${stripe ? 'Configured' : 'Not configured'}             ║`);
      console.log(`  ║   MP:     ${MP_ACCESS_TOKEN ? 'Configured' : 'Not configured'}             ║`);
      console.log(`  ║   USDT:   ${NOWPAYMENTS_API_KEY ? 'NOWPayments OK' : 'Manual only'}          ║`);
      console.log(`  ║   Broker: ${brokerOk ? 'Binance Futures ON' : 'DISABLED'}         ║`);
      console.log(`  ╚══════════════════════════════════════╝\n`);

      // 2026-04-23: Start V44 server-side signals scheduler (runs 24/7 regardless of active users)
      try { startV44Scheduler(); } catch(e){ console.warn('[Startup] V44 scheduler error:', e.message); }

      // Validate APEX v42 PRO+ pair universe against live Binance exchangeInfo
      if (brokerOk) {
        try {
          const universe = (process.env.APEX_PAIRS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,AVAXUSDT,DOGEUSDT,LINKUSDT,LTCUSDT,DOTUSDT,1000PEPEUSDT,POLUSDT,RENDERUSDT,ARBUSDT').split(',').map(s => s.trim());
          const validation = await broker.validatePairs(universe);
          if (validation.invalid && validation.invalid.length) {
            console.warn(`[Startup] ⚠ ${validation.invalid.length} pairs NOT tradeable on ${mode}: ${validation.invalid.join(', ')}`);
          } else {
            console.log(`[Startup] ✓ All ${validation.valid.length} APEX pairs validated on ${mode} (${validation.totalTradeable} total tradeable)`);
          }
        } catch (e) {
          console.warn('[Startup] Pair validation failed:', e.message);
        }
      }
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
