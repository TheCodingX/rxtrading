/**
 * Tests para signal-store.js
 *
 * Pure-function tests siempre corren (computeSignalId, computeBucket).
 * DB-integration tests SOLO si DATABASE_URL está disponible (skip elsewhere).
 *
 * Run: node --test __tests__/signal-store.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const sigStore = require('../signal-store');

// ─── Pure helpers ───────────────────────────────────────────────────────

test('computeSignalId — determinístico (mismo input → mismo id)', () => {
  const a = sigStore.computeSignalId('BTCUSDT', 'BUY', 1700000000000, 'apex-v44', 100, 95);
  const b = sigStore.computeSignalId('BTCUSDT', 'BUY', 1700000000000, 'apex-v44', 100, 95);
  assert.strictEqual(a, b);
  assert.match(a, /^sig_[a-f0-9]{16}$/);
});

test('computeSignalId — symbol distinto → id distinto', () => {
  const a = sigStore.computeSignalId('BTCUSDT', 'BUY', 1700000000000, 'apex-v44', 100, 95);
  const b = sigStore.computeSignalId('ETHUSDT', 'BUY', 1700000000000, 'apex-v44', 100, 95);
  assert.notStrictEqual(a, b);
});

test('computeSignalId — direction distinta → id distinto', () => {
  const a = sigStore.computeSignalId('BTCUSDT', 'BUY', 1700000000000, 'apex-v44', 100, 95);
  const b = sigStore.computeSignalId('BTCUSDT', 'SELL', 1700000000000, 'apex-v44', 100, 95);
  assert.notStrictEqual(a, b);
});

test('computeSignalId — bucket distinto → id distinto', () => {
  const a = sigStore.computeSignalId('BTCUSDT', 'BUY', 1700000000000, 'apex-v44', 100, 95);
  const b = sigStore.computeSignalId('BTCUSDT', 'BUY', 1700000300000, 'apex-v44', 100, 95);
  assert.notStrictEqual(a, b);
});

test('computeSignalId — TP precision 8 decimales (PEPE/SHIB) — diff 1e-8 → id distinto', () => {
  const a = sigStore.computeSignalId('1000PEPEUSDT', 'BUY', 1700000000000, 'apex-v44', 0.00000123, 0.00000119);
  const b = sigStore.computeSignalId('1000PEPEUSDT', 'BUY', 1700000000000, 'apex-v44', 0.00000124, 0.00000119);
  assert.notStrictEqual(a, b);
});

test('computeBucket — alinea timestamp a inicio de bucket de 5 min', () => {
  const ts = 1700000123456;
  const bucket = sigStore.computeBucket(ts);
  // 1700000123456 / 300000 = 5666666.74... × 300000 = 1700000000000
  assert.strictEqual(bucket, 1700000100000);
  // dentro del mismo bucket
  const bucket2 = sigStore.computeBucket(ts + 60000); // +1min
  assert.strictEqual(bucket2, bucket);
  // siguiente bucket
  const bucket3 = sigStore.computeBucket(ts + 5 * 60 * 1000); // +5min
  assert.strictEqual(bucket3, bucket + 300000);
});

test('VALID_TRANSITIONS — ACTIVE → TRADED/EXPIRED/SUPERSEDED/CANCELED solo', () => {
  assert.deepStrictEqual(sigStore.VALID_TRANSITIONS.ACTIVE, ['TRADED', 'EXPIRED', 'SUPERSEDED', 'CANCELED']);
  assert.deepStrictEqual(sigStore.VALID_TRANSITIONS.TRADED, []);
  assert.deepStrictEqual(sigStore.VALID_TRANSITIONS.EXPIRED, []);
});

// ─── DB-integration tests (skip if no DATABASE_URL) ─────────────────────
const hasDB = !!process.env.DATABASE_URL;

test('insertSignal — idempotente (mismo bucket+symbol+direction+engine no duplica)', { skip: !hasDB }, async () => {
  const baseTs = Date.now();
  const r1 = await sigStore.insertSignal({
    symbol: 'TESTUSDT', direction: 'BUY', engineVersion: 'test-engine-1',
    entry: 100, tp: 105, sl: 98, confidence: 75,
    ts: baseTs, ttlMs: 60000
  });
  assert.strictEqual(r1.created, true);
  assert.ok(r1.signal.signal_id);
  // Re-insert same params → should be duplicate
  const r2 = await sigStore.insertSignal({
    symbol: 'TESTUSDT', direction: 'BUY', engineVersion: 'test-engine-1',
    entry: 100, tp: 105, sl: 98, confidence: 75,
    ts: baseTs, ttlMs: 60000
  });
  assert.strictEqual(r2.created, false);
});

test('transitionState — ACTIVE → TRADED solo si row state == ACTIVE', { skip: !hasDB }, async () => {
  const baseTs = Date.now();
  const r = await sigStore.insertSignal({
    symbol: 'TESTTRDUSDT', direction: 'SELL', engineVersion: 'test-engine-2',
    entry: 200, tp: 195, sl: 204, confidence: 80,
    ts: baseTs, ttlMs: 60000
  });
  assert.strictEqual(r.created, true);
  const sigId = r.signal.signal_id;
  const t1 = await sigStore.transitionState(sigId, 'ACTIVE', 'EXPIRED');
  assert.strictEqual(t1.ok, true);
  // Now state is EXPIRED — try to transition again
  const t2 = await sigStore.transitionState(sigId, 'ACTIVE', 'TRADED');
  assert.strictEqual(t2.ok, false);
  assert.strictEqual(t2.reason, 'state_mismatch');
});

test('expireStale — marca señales con expires_at < NOW como EXPIRED', { skip: !hasDB }, async () => {
  const past = Date.now() - 120000; // 2 min ago
  const r = await sigStore.insertSignal({
    symbol: 'TESTEXPUSDT', direction: 'BUY', engineVersion: 'test-engine-3',
    entry: 50, tp: 52, sl: 49, confidence: 70,
    ts: past, ttlMs: 60000  // expired 1 min ago
  });
  assert.strictEqual(r.created, true);
  const expired = await sigStore.expireStale();
  assert.ok(Array.isArray(expired));
  assert.ok(expired.includes(r.signal.signal_id));
  // Try state transition — should fail because already EXPIRED
  const t = await sigStore.transitionState(r.signal.signal_id, 'ACTIVE', 'TRADED');
  assert.strictEqual(t.ok, false);
});
