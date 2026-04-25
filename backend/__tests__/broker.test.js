// Tests unitarios broker.js — parametrización + helpers pure (sin network)
// Run: node --test __tests__/broker.test.js
const test = require('node:test');
const assert = require('node:assert');

// Setea env antes de importar broker para que initMasterKey funcione
process.env.BROKER_MASTER_KEY = process.env.BROKER_MASTER_KEY || 'a'.repeat(64); // 32 bytes hex
const broker = require('../broker');

test('broker — initMasterKey con key válida', () => {
  const ok = broker.initMasterKey();
  assert.strictEqual(ok, true);
});

test('broker — encrypt + decrypt roundtrip', () => {
  broker.initMasterKey();
  const plain = 'my-fake-api-key-secret';
  const enc = broker.encrypt(plain);
  assert.ok(enc.length > 20); // IV + tag + ciphertext + :
  assert.ok(enc !== plain);
  const dec = broker.decrypt(enc);
  assert.strictEqual(dec, plain);
});

test('broker — decrypt con tampering falla (auth tag)', () => {
  broker.initMasterKey();
  const enc = broker.encrypt('sensitive');
  // Tamper con un byte del ciphertext
  const parts = enc.split(':');
  const tampered = parts[0] + ':' + parts[1] + ':0' + parts[2].slice(1);
  assert.throws(() => broker.decrypt(tampered));
});

test('broker — encrypt produce IV diferente cada vez', () => {
  broker.initMasterKey();
  const a = broker.encrypt('same-input');
  const b = broker.encrypt('same-input');
  assert.notStrictEqual(a, b); // IV random, ciphertexts deben diferir
  assert.strictEqual(broker.decrypt(a), 'same-input');
  assert.strictEqual(broker.decrypt(b), 'same-input');
});
