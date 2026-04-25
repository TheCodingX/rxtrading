// Tests para el motor V44 Funding Carry (pure functions — no network)
// Run: node --test __tests__/v44-engine.test.js
const test = require('node:test');
const assert = require('node:assert');
const v44 = require('../v44-engine');

test('V44 — universe tiene 15 pares', () => {
  assert.strictEqual(v44.SAFE_FUNDING_PARAMS.UNIVERSE.length, 15);
  assert.ok(v44.SAFE_FUNDING_PARAMS.UNIVERSE.includes('BTCUSDT'));
  assert.ok(v44.SAFE_FUNDING_PARAMS.UNIVERSE.includes('ETHUSDT'));
});

test('V44 — isEligibleHour reconoce ventanas PRE/MID/POST de 0/8/16 UTC', () => {
  // MID windows
  assert.strictEqual(v44.isEligibleHour(0), true);
  assert.strictEqual(v44.isEligibleHour(8), true);
  assert.strictEqual(v44.isEligibleHour(16), true);
  // PRE windows (sh-1)
  assert.strictEqual(v44.isEligibleHour(23), true);
  assert.strictEqual(v44.isEligibleHour(7), true);
  assert.strictEqual(v44.isEligibleHour(15), true);
  // POST windows (sh+1)
  assert.strictEqual(v44.isEligibleHour(1), true);
  assert.strictEqual(v44.isEligibleHour(9), true);
  assert.strictEqual(v44.isEligibleHour(17), true);
  // Hours fuera de ventana
  assert.strictEqual(v44.isEligibleHour(2), false);
  assert.strictEqual(v44.isEligibleHour(5), false);
  assert.strictEqual(v44.isEligibleHour(10), false);
  assert.strictEqual(v44.isEligibleHour(14), false);
  assert.strictEqual(v44.isEligibleHour(20), false);
});

test('V44 — getWindowTypeForHour devuelve label correcto', () => {
  assert.strictEqual(v44.getWindowTypeForHour(8), 'MID');
  assert.strictEqual(v44.getWindowTypeForHour(7), 'PRE');
  assert.strictEqual(v44.getWindowTypeForHour(9), 'POST');
  assert.strictEqual(v44.getWindowTypeForHour(10), null);
});

test('V44 — evaluateFundingCarry retorna null con datos insuficientes', () => {
  assert.strictEqual(v44.evaluateFundingCarry('BTCUSDT', []), null);
  assert.strictEqual(v44.evaluateFundingCarry('BTCUSDT', Array(100).fill({ t: 0, c: 50000 })), null);
});

test('V44 — findNextEligibleHour cicla ventanas correctamente', () => {
  // Desde hour 2 → next eligible es 7 (PRE de 8)
  assert.strictEqual(v44.findNextEligibleHour(2), 7);
  // Desde 10 → next 15
  assert.strictEqual(v44.findNextEligibleHour(10), 15);
  // Desde 18 → next 23
  assert.strictEqual(v44.findNextEligibleHour(18), 23);
});

test('V44 — parámetros frozen — valores inmutables', () => {
  const p = v44.SAFE_FUNDING_PARAMS;
  // Object.freeze silently ignora mutation en non-strict; los valores deben seguir iguales
  try { p.LEVERAGE = 10; } catch(e){}
  assert.strictEqual(p.LEVERAGE, 3.0);
  assert.strictEqual(p.TP_BPS, 30);
  assert.strictEqual(p.SL_BPS, 25);
  assert.strictEqual(Object.isFrozen(p), true);
});
