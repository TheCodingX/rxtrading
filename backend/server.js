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

if (!JWT_SECRET || JWT_SECRET.includes('CAMBIA_ESTO')) {
  console.error('\n[ERROR] Debes cambiar JWT_SECRET en el archivo .env antes de ejecutar.\n');
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
  '7d':  { name: 'RXTrading VIP - 7 Days',   days: 7,   usd: 39.99 },
  '1m':  { name: 'RXTrading VIP - 1 Month',  days: 30,  usd: 119.99 },
  '3m':  { name: 'RXTrading VIP - 3 Months', days: 90,  usd: 339.99 },
  '1y':  { name: 'RXTrading VIP - Yearly',   days: 365, usd: 499.99 },
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
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

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
      // Check if already processed
      const { rows } = await pool.query(
        'SELECT status FROM payments WHERE payment_id = $1',
        [paymentId]
      );
      if (rows[0]?.status === 'completed') {
        console.log('[Stripe Webhook] Payment already processed:', paymentId);
        return res.status(200).json({ received: true });
      }

      // Update email/name on the payment record
      await pool.query(
        'UPDATE payments SET email = $1, customer_name = $2, provider_ref = $3 WHERE payment_id = $4',
        [email, customerName, session.id, paymentId]
      );

      const keyCode = await generateVIPKeyForPayment(paymentId, planId, email, customerName);
      console.log('[Stripe Webhook] Payment completed:', paymentId, '- Key:', keyCode);
    } catch (err) {
      console.error('[Stripe Webhook] Error processing payment:', err);
      return res.status(500).json({ error: 'Processing error' });
    }
  }

  res.status(200).json({ received: true });
});

// ════════════════════════════════════════════════════
//  GLOBAL MIDDLEWARE
// ════════════════════════════════════════════════════

// Hardened helmet config with CSP
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://js.stripe.com", "https://www.gstatic.com", "https://*.firebaseapp.com", "https://*.firebaseio.com"],
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
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false, // Allow Firebase iframe/worker loading
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (CORS_ORIGINS.includes(origin)) return callback(null, true);
    // Dev: accept any localhost:* origin (covers 8090 preview, 5500, etc.)
    if (/^http:\/\/localhost:\d+$/.test(origin) || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(express.json({ limit: '200kb' }));
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

const validateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de validación. Intenta en 15 minutos.' }
});

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
  const keyHash = await bcrypt.hash(keyCode, 10);

  await pool.query(
    'INSERT INTO license_keys (key_code, key_hash, owner_name, max_activations, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [keyCode, keyHash, customerName || email || '', 1, expiresAt]
  );

  await pool.query(
    'UPDATE payments SET key_code = $1, status = $2, completed_at = NOW() WHERE payment_id = $3',
    [keyCode, 'completed', paymentId]
  );

  return keyCode;
}

// ════════════════════════════════════════════════════
//  LICENSE KEY ENDPOINTS
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
        { keyId: keyRow.id, code: cleanCode, name: keyRow.owner_name, fp: fingerprint, type: 'access' },
        JWT_SECRET,
        { expiresIn: '7d' } // Shorter-lived access token
      );
      const refreshToken = jwt.sign(
        { keyId: keyRow.id, fp: fingerprint, type: 'refresh' },
        JWT_SECRET,
        { expiresIn: '90d' }
      );
      // Set refresh token as httpOnly cookie (cannot be read via XSS)
      try {
        res.cookie('rx_refresh', refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          maxAge: 90 * 24 * 60 * 60 * 1000,
          path: '/api/keys/refresh'
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
      { expiresIn: '7d' }
    );
    const refreshToken = jwt.sign(
      { keyId: keyRow.id, fp: fingerprint, type: 'refresh' },
      JWT_SECRET,
      { expiresIn: '90d' }
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
app.post('/api/keys/logout', verifyToken, async (req, res) => {
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

// POST /api/keys/refresh — exchange httpOnly refresh cookie for fresh access token
app.post('/api/keys/refresh', generalLimiter, async (req, res) => {
  const rt = req.cookies && req.cookies.rx_refresh;
  if (!rt) return res.status(401).json({ error: 'No refresh token' });
  try {
    const decoded = jwt.verify(rt, JWT_SECRET);
    if (decoded.type !== 'refresh') return res.status(401).json({ error: 'Invalid token type' });
    // Validate activation still active
    const { rows } = await pool.query(
      'SELECT lk.id, lk.key_code, lk.owner_name, lk.expires_at, lk.is_revoked FROM license_keys lk JOIN activations a ON a.key_id = lk.id WHERE lk.id = $1 AND a.fingerprint = $2 AND a.is_active = 1',
      [decoded.keyId, decoded.fp]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Sesión revocada' });
    const row = rows[0];
    if (row.is_revoked) return res.status(401).json({ error: 'Licencia revocada' });
    const token = jwt.sign(
      { keyId: row.id, code: row.key_code, name: row.owner_name, fp: decoded.fp, type: 'access' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ valid: true, token, name: row.owner_name, expiresAt: row.expires_at });
  } catch (err) {
    return res.status(401).json({ error: 'Refresh inválido o expirado' });
  }
});

// ════════════════════════════════════════════════════
//  HEALTH CHECK — public
// ════════════════════════════════════════════════════
app.get(['/health', '/api/health'], (req, res) => {
  res.json({
    ok: true,
    service: 'rxtrading-backend',
    mode: process.env.BINANCE_TESTNET === 'true' ? 'testnet' : 'mainnet',
    env: process.env.NODE_ENV || 'development',
    uptime: Math.round(process.uptime()),
    ts: new Date().toISOString()
  });
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

  const plan = PLANS[planId];
  const paymentId = `pay_${crypto.randomUUID()}`;

  try {
    await pool.query(
      'INSERT INTO payments (payment_id, provider, plan_id, amount_usd, email, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [paymentId, 'stripe', planId, plan.usd, email || '', 'pending']
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
      success_url: `${FRONTEND_URL}/app.html?payment=success&session_id={CHECKOUT_SESSION_ID}#vip`,
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

    res.json({ url: session.url, paymentId });
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

  const plan = PLANS[planId];
  const paymentId = `pay_${crypto.randomUUID()}`;

  try {
    await pool.query(
      'INSERT INTO payments (payment_id, provider, plan_id, amount_usd, email, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [paymentId, 'mercadopago', planId, plan.usd, email || '', 'pending']
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
      console.error('[MP Webhook] Failed to fetch payment:', mpResponse.status);
      return res.status(200).json({ received: true });
    }

    const mpPayment = await mpResponse.json();

    if (mpPayment.status === 'approved') {
      const paymentId = mpPayment.external_reference;

      if (!paymentId) {
        console.error('[MP Webhook] No external_reference in payment:', data.id);
        return res.status(200).json({ received: true });
      }

      // Check if already processed
      const { rows } = await pool.query(
        'SELECT * FROM payments WHERE payment_id = $1',
        [paymentId]
      );
      const payment = rows[0];

      if (!payment) {
        console.error('[MP Webhook] Payment not found:', paymentId);
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
  // Verify IPN signature
  if (NOWPAYMENTS_IPN_SECRET) {
    const hmac = crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET);
    // NOWPayments requires sorting keys before hashing
    const sorted = Object.keys(req.body).sort().reduce((obj, key) => { obj[key] = req.body[key]; return obj; }, {});
    hmac.update(JSON.stringify(sorted));
    const signature = hmac.digest('hex');
    const receivedSig = req.headers['x-nowpayments-sig'];

    if (!receivedSig || signature !== receivedSig) {
      console.error('[NOWPayments Webhook] Invalid signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }
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

  const plan = PLANS[planId];
  const paymentId = `pay_${crypto.randomUUID()}`;

  try {
    await pool.query(
      'INSERT INTO payments (payment_id, provider, plan_id, amount_usd, email, status) VALUES ($1, $2, $3, $4, $5, $6)',
      [paymentId, 'usdt', planId, plan.usd, email || '', 'pending']
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

// POST /api/user/paper — Save paper trading data to cloud
app.post('/api/user/paper', syncLimiter, verifyToken, async (req, res) => {
  const { keyId } = req.license;
  const { data } = req.body;

  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Data inválida.' });
  }

  try {
    await pool.query(`
      INSERT INTO user_paper_data (key_id, data, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key_id)
      DO UPDATE SET data = $2, updated_at = NOW()
    `, [keyId, JSON.stringify(data)]);

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

// POST /api/user/signals — Save signal history to cloud
app.post('/api/user/signals', syncLimiter, verifyToken, async (req, res) => {
  const { keyId } = req.license;
  const { data } = req.body;

  if (!Array.isArray(data)) {
    return res.status(400).json({ error: 'Data debe ser un array.' });
  }

  // Limit to last 500 signals to avoid bloat
  const trimmed = data.slice(-500);

  try {
    await pool.query(`
      INSERT INTO user_signal_history (key_id, data, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key_id)
      DO UPDATE SET data = $2, updated_at = NOW()
    `, [keyId, JSON.stringify(trimmed)]);

    res.json({ success: true });
  } catch (err) {
    console.error('[Sync] Error saving signal history:', err);
    res.status(500).json({ error: 'Error interno.' });
  }
});

// GDPR/CCPA — DELETE all user data (right to erasure)
app.post('/api/user/delete-all', syncLimiter, verifyToken, async (req, res) => {
  const { keyId } = req.license;
  const { confirm } = req.body;
  if (confirm !== 'DELETE_MY_DATA') {
    return res.status(400).json({ error: 'Envía { confirm: "DELETE_MY_DATA" } para confirmar.' });
  }
  try {
    await pool.query('BEGIN');
    await pool.query('DELETE FROM user_data WHERE key_id = $1', [keyId]).catch(()=>{});
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

// Rate limiter for broker endpoints (max 30 req / min per user)
const brokerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados requests al broker. Espera un minuto.' }
});

// Connect broker: user sends API key + secret, we encrypt and store
app.post('/api/broker/connect', verifyToken, brokerLimiter, async (req, res) => {
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

    const account = await broker.getAccountInfo(apiKey, apiSecret);

    // Reset daily loss if > 24h old
    const resetAt = new Date(cfg.daily_reset_at);
    const hoursSince = (Date.now() - resetAt.getTime()) / 3600000;
    let dailyLossCurrent = parseFloat(cfg.daily_loss_current || 0);
    if (hoursSince >= 24) {
      await pool.query('UPDATE broker_configs SET daily_loss_current = 0, daily_reset_at = NOW() WHERE id = $1', [cfg.id]);
      dailyLossCurrent = 0;
    }

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
      }
    });
  } catch (err) {
    console.error('[Broker] status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Place a real trade (market entry + TP + SL)
app.post('/api/broker/place-order', verifyToken, brokerLimiter, async (req, res) => {
  try {
    const { symbol, side, usdAmount, leverage, tp, sl, currentPrice } = req.body;
    if (!symbol || !side || !usdAmount || !leverage || !tp || !sl || !currentPrice) {
      return res.status(400).json({ error: 'Parámetros incompletos' });
    }

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

    // UTC daily reset (00:00 UTC boundary, not rolling 24h)
    const resetAt = new Date(cfg.daily_reset_at);
    const nowUTC = new Date();
    const todayUTC = Date.UTC(nowUTC.getUTCFullYear(), nowUTC.getUTCMonth(), nowUTC.getUTCDate());
    const resetAtUTC = Date.UTC(resetAt.getUTCFullYear(), resetAt.getUTCMonth(), resetAt.getUTCDate());
    if (todayUTC > resetAtUTC) {
      await pool.query("UPDATE broker_configs SET daily_loss_current = 0, daily_reset_at = NOW() AT TIME ZONE 'UTC', consecutive_losses = 0, circuit_breaker_until = NULL WHERE id = $1", [cfg.id]);
      dailyLoss = 0;
    }

    // Circuit breaker check — if tripped, reject trade
    if (cfg.circuit_breaker_until) {
      const cbUntil = new Date(cfg.circuit_breaker_until).getTime();
      if (Date.now() < cbUntil) {
        const remainingMin = Math.ceil((cbUntil - Date.now()) / 60000);
        return res.status(400).json({ error: `Circuit breaker activo: ${cfg.consecutive_losses || 5} pérdidas consecutivas. Retoma en ${remainingMin}min.` });
      }
    }

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
    const apiKey = broker.decrypt(cfg.api_key_enc);
    const apiSecret = broker.decrypt(cfg.api_secret_enc);

    try {
      const accountSnapshot = await broker.getAccountInfo(apiKey, apiSecret);
      const openPositions = (accountSnapshot.positions || []).filter(p => parseFloat(p.positionAmt) !== 0);
      const maxConcurrent = parseInt(cfg.max_concurrent_positions || 4);
      if (openPositions.length >= maxConcurrent) {
        return res.status(400).json({ error: `Máximo ${maxConcurrent} posiciones simultáneas. Cerrá una para abrir otra.` });
      }
      // Total deployed notional check: sum of all open positions + this new one
      const currentNotional = openPositions.reduce((sum, p) => sum + Math.abs(parseFloat(p.positionAmt) * parseFloat(p.entryPrice || 0)), 0);
      const newNotional = parseFloat(usdAmount) * parseInt(leverage);
      const totalBalance = parseFloat(accountSnapshot.totalWalletBalance || 0);
      const maxDeployPct = parseFloat(cfg.max_capital_deployed_pct || 50) / 100;
      if (totalBalance > 0 && (currentNotional + newNotional) > (totalBalance * maxDeployPct * parseInt(leverage))) {
        return res.status(400).json({ error: `Exposición total excede ${Math.round(maxDeployPct*100)}% del balance.` });
      }
    } catch (e) {
      console.warn('[Broker] Concurrent position check failed:', e.message);
      // Fail open — don't block on check failure, but log
    }

    const result = await broker.placeTradeWithTPSL(apiKey, apiSecret, {
      symbol, side, usdAmount: parseFloat(usdAmount),
      leverage: parseInt(leverage), tp: parseFloat(tp), sl: parseFloat(sl),
      currentPrice: parseFloat(currentPrice)
    });

    // Log the trade
    await pool.query(`
      INSERT INTO broker_trade_log (key_id, symbol, side, usd_amount, leverage, entry_price, tp_price, sl_price, binance_order_id, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'placed')
    `, [
      req.license.keyId, symbol, side, parseFloat(usdAmount), parseInt(leverage),
      parseFloat(currentPrice), parseFloat(tp), parseFloat(sl),
      String(result.entry.orderId || '')
    ]);

    await pool.query('UPDATE broker_configs SET last_used = NOW() WHERE id = $1', [cfg.id]);

    res.json({ ok: true, result });
  } catch (err) {
    console.error('[Broker] place-order error:', err);
    // Log the error too
    try {
      await pool.query(`
        INSERT INTO broker_trade_log (key_id, symbol, side, usd_amount, leverage, status, error_msg)
        VALUES ($1, $2, $3, $4, $5, 'error', $6)
      `, [req.license.keyId, req.body.symbol, req.body.side, req.body.usdAmount, req.body.leverage, err.message]);
    } catch (e) {}
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

// Reconcile — sync DB state with live Binance state (call after server restart or long disconnects)
app.post('/api/broker/reconcile', verifyToken, brokerLimiter, async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// Close all positions (panic button)
app.post('/api/broker/close-all', verifyToken, brokerLimiter, async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// Disconnect broker (deletes encrypted keys)
app.post('/api/broker/disconnect', verifyToken, brokerLimiter, async (req, res) => {
  try {
    await pool.query('DELETE FROM broker_configs WHERE key_id = $1', [req.license.keyId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get trade history (last 50)
app.get('/api/broker/history', verifyToken, brokerLimiter, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT symbol, side, usd_amount, leverage, entry_price, tp_price, sl_price, status, error_msg, created_at FROM broker_trade_log WHERE key_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.license.keyId]
    );
    res.json({ trades: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
async function start() {
  try {
    // Initialize broker encryption key
    brokerOk = broker.initMasterKey();
    if (!brokerOk) {
      console.warn('[Broker] Real trading DISABLED (set BROKER_MASTER_KEY in .env to enable)');
    }
    await initDB();
    app.listen(PORT, () => {
      console.log(`\n  ╔══════════════════════════════════════╗`);
      console.log(`  ║   RX PRO — Backend API v1.1          ║`);
      console.log(`  ║   Puerto: ${PORT}                        ║`);
      console.log(`  ║   CORS:   ${CORS_ORIGINS.join(', ').slice(0,25).padEnd(25)} ║`);
      console.log(`  ║   Stripe: ${stripe ? 'Configured' : 'Not configured'}             ║`);
      console.log(`  ║   MP:     ${MP_ACCESS_TOKEN ? 'Configured' : 'Not configured'}             ║`);
      console.log(`  ║   USDT:   ${NOWPAYMENTS_API_KEY ? 'NOWPayments OK' : 'Manual only'}          ║`);
      console.log(`  ║   Broker: ${brokerOk ? 'Binance Futures ON' : 'DISABLED'}         ║`);
      console.log(`  ╚══════════════════════════════════════╝\n`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
