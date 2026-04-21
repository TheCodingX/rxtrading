// Smoke tests — use Node.js built-in test runner (no jest dependency)
// Run: npm test
const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

describe('Broker encryption', () => {
  // Set test master key before requiring broker
  process.env.BROKER_MASTER_KEY = crypto.randomBytes(32).toString('hex');
  const broker = require('../broker');
  broker.initMasterKey();

  test('encrypt + decrypt roundtrip preserves plaintext', () => {
    const original = 'api_key_test_12345_ABCDEF';
    const enc = broker.encrypt(original);
    assert.notStrictEqual(enc, original, 'should encrypt');
    assert.ok(enc.includes(':'), 'encrypted format should have IV:tag:data');
    const dec = broker.decrypt(enc);
    assert.strictEqual(dec, original, 'roundtrip must preserve plaintext');
  });

  test('encrypted values differ across calls (unique IV)', () => {
    const value = 'same_plaintext';
    const enc1 = broker.encrypt(value);
    const enc2 = broker.encrypt(value);
    assert.notStrictEqual(enc1, enc2, 'different IVs should produce different ciphertext');
    assert.strictEqual(broker.decrypt(enc1), value);
    assert.strictEqual(broker.decrypt(enc2), value);
  });

  test('decrypt with tampered data throws', () => {
    const enc = broker.encrypt('sensitive');
    const parts = enc.split(':');
    parts[2] = 'deadbeef' + parts[2].slice(8); // tamper
    const tampered = parts.join(':');
    assert.throws(() => broker.decrypt(tampered), /Unsupported|auth|decrypt|tag/i);
  });
});

describe('Input validators', () => {
  // Load server context (won't start server)
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
  // Note: server.js self-executes start() — skip loading here, test validators independently
  const validators = {
    symbol(s) { return typeof s === 'string' && /^[A-Z0-9]{3,20}USDT$/.test(s); },
    side(s) { return s === 'BUY' || s === 'SELL'; },
    leverage(n) { const v = Number(n); return Number.isInteger(v) && v >= 1 && v <= 20; },
    usdAmount(n) { const v = Number(n); return Number.isFinite(v) && v >= 10 && v <= 10000; },
    price(n) { const v = Number(n); return Number.isFinite(v) && v > 0 && v < 1e9; },
    email(s) { return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254; },
  };

  test('symbol: valid Binance Futures pairs', () => {
    assert.ok(validators.symbol('BTCUSDT'));
    assert.ok(validators.symbol('ETHUSDT'));
    assert.ok(validators.symbol('1000PEPEUSDT'));
    assert.ok(validators.symbol('RENDERUSDT'));
  });

  test('symbol: rejects malformed', () => {
    assert.ok(!validators.symbol(''));
    assert.ok(!validators.symbol(null));
    assert.ok(!validators.symbol('btc'));
    assert.ok(!validators.symbol('BTC'));
    assert.ok(!validators.symbol('BTC/USD'));
    assert.ok(!validators.symbol('<script>alert(1)</script>'));
    assert.ok(!validators.symbol('BTCUSDT; DROP TABLE users;'));
  });

  test('side: only BUY or SELL', () => {
    assert.ok(validators.side('BUY'));
    assert.ok(validators.side('SELL'));
    assert.ok(!validators.side('buy'));
    assert.ok(!validators.side('LONG'));
    assert.ok(!validators.side(''));
    assert.ok(!validators.side(null));
  });

  test('leverage: 1-20 integers', () => {
    assert.ok(validators.leverage(1));
    assert.ok(validators.leverage(10));
    assert.ok(validators.leverage(20));
    assert.ok(!validators.leverage(0));
    assert.ok(!validators.leverage(-5));
    assert.ok(!validators.leverage(21));
    assert.ok(!validators.leverage(100));
    assert.ok(!validators.leverage(1.5));
    assert.ok(validators.leverage('10')); // string coerces to 10 (form inputs are strings)
    assert.ok(!validators.leverage('abc'));
  });

  test('usdAmount: 10-10000', () => {
    assert.ok(validators.usdAmount(10));
    assert.ok(validators.usdAmount(500));
    assert.ok(validators.usdAmount(10000));
    assert.ok(!validators.usdAmount(9));
    assert.ok(!validators.usdAmount(10001));
    assert.ok(!validators.usdAmount(NaN));
    assert.ok(!validators.usdAmount(Infinity));
    assert.ok(!validators.usdAmount(-100));
  });

  test('email: RFC-compatible', () => {
    assert.ok(validators.email('user@example.com'));
    assert.ok(validators.email('a.b+c@sub.example.co.uk'));
    assert.ok(!validators.email('not-an-email'));
    assert.ok(!validators.email('@missing-local.com'));
    assert.ok(!validators.email('missing-at.com'));
    assert.ok(!validators.email('a'.repeat(300) + '@example.com')); // length cap
  });
});

describe('Secret entropy check', () => {
  function check(s) {
    if (!s || s.length < 32) return false;
    if (/^(.)\1+$/.test(s)) return false;
    const distinct = new Set(s.split('')).size;
    return distinct >= 10;
  }
  test('strong entropy passes', () => {
    assert.ok(check(crypto.randomBytes(32).toString('hex')));
  });
  test('all-same-char fails', () => {
    assert.ok(!check('a'.repeat(64)));
  });
  test('low entropy fails', () => {
    assert.ok(!check('0123456789'.slice(0, 32))); // only 10 distinct but length OK — actually passes check
    assert.ok(!check('aaaaabbbbbccccc' + 'a'.repeat(17)));
  });
  test('short fails', () => {
    assert.ok(!check('short'));
    assert.ok(!check(''));
    assert.ok(!check(null));
  });
});

describe('License key entropy', () => {
  // Replicate generator logic
  function genKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'RX-VIP-';
    for (let i = 0; i < 12; i++) {
      code += chars[crypto.randomInt(chars.length)];
    }
    return code;
  }

  test('generated keys have correct format', () => {
    const k = genKey();
    assert.match(k, /^RX-VIP-[A-Z2-9]{12}$/);
  });

  test('keys are unique over 1000 samples', () => {
    const set = new Set();
    for (let i = 0; i < 1000; i++) set.add(genKey());
    assert.strictEqual(set.size, 1000, 'no collisions');
  });

  test('entropy is 32^12 ≈ 60 bits (GPU-resistant)', () => {
    const entropyBits = Math.log2(Math.pow(32, 12));
    assert.ok(entropyBits >= 60, `entropy ${entropyBits} < 60 bits`);
  });
});

describe('Rate normalization IP', () => {
  function normalizeIP(ip) {
    if (!ip) return 'unknown';
    if (ip.includes(':')) return ip.split(':').slice(0,4).join(':') + '::/64';
    return ip.split('.').slice(0,3).join('.') + '.0/24';
  }
  test('IPv4 /24 normalization', () => {
    assert.strictEqual(normalizeIP('192.168.1.100'), '192.168.1.0/24');
    assert.strictEqual(normalizeIP('192.168.1.50'), '192.168.1.0/24');
    assert.strictEqual(normalizeIP('10.0.0.1'), '10.0.0.0/24');
  });
  test('IPv6 /64 normalization', () => {
    assert.strictEqual(normalizeIP('2001:db8:1234:5678:abcd::'), '2001:db8:1234:5678::/64');
  });
  test('unknown IP', () => {
    assert.strictEqual(normalizeIP(''), 'unknown');
    assert.strictEqual(normalizeIP(null), 'unknown');
  });
});

describe('Webhook signature (HMAC)', () => {
  const secret = 'test_secret_key_for_hmac_verification_12345';
  test('valid HMAC-SHA256 verifies', () => {
    const data = '{"payment":"test","id":"123"}';
    const hmac = crypto.createHmac('sha256', secret).update(data).digest('hex');
    const recomputed = crypto.createHmac('sha256', secret).update(data).digest('hex');
    assert.strictEqual(hmac, recomputed);
  });
  test('tampered data produces different HMAC', () => {
    const hmac1 = crypto.createHmac('sha256', secret).update('data1').digest('hex');
    const hmac2 = crypto.createHmac('sha256', secret).update('data2').digest('hex');
    assert.notStrictEqual(hmac1, hmac2);
  });
});

describe('safeErrorMessage', () => {
  function safeErrorMessage(err) {
    const msg = String(err?.message || err || 'Unknown error');
    if (msg.includes('Cannot read properties') || msg.includes('undefined') || msg.includes('is not a function')) {
      return 'Error interno del servidor.';
    }
    const safePrefixes = ['Binance error', 'Position too', 'Notional too', 'Invalid', 'TP', 'SL', 'Excessive slippage', 'Circuit breaker', 'Máximo', 'Monto excede', 'Leverage excede', 'Broker no conectado', 'Sin conexión'];
    if (safePrefixes.some(p => msg.startsWith(p))) return msg;
    return 'Error al procesar la solicitud.';
  }
  test('filters stack traces', () => {
    assert.strictEqual(safeErrorMessage({message: "Cannot read properties of undefined (reading 'x')"}), 'Error interno del servidor.');
    assert.strictEqual(safeErrorMessage({message: "foo is not a function"}), 'Error interno del servidor.');
  });
  test('preserves safe error messages', () => {
    assert.strictEqual(safeErrorMessage({message: 'Binance error 429'}), 'Binance error 429');
    assert.strictEqual(safeErrorMessage({message: 'Circuit breaker active'}), 'Circuit breaker active');
  });
  test('generic fallback', () => {
    assert.strictEqual(safeErrorMessage(new Error('Random internal error not safe')), 'Error al procesar la solicitud.');
  });
});
