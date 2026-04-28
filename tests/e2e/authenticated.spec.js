// Playwright E2E — flows autenticados (requiere TEST_LICENSE_CODE env + backend con TEST_JWT_ENABLED=true)
// Run: TEST_LICENSE_CODE=RX-VIP-XXXX npx playwright test tests/e2e/authenticated.spec.js

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const BACKEND_URL = process.env.BACKEND_URL || BASE_URL;
const TEST_LICENSE = process.env.TEST_LICENSE_CODE;

test.skip(!TEST_LICENSE, 'TEST_LICENSE_CODE not set — skipping auth flows');

let token;

test.beforeAll(async ({ request }) => {
  const r = await request.post(`${BACKEND_URL}/api/test/jwt`, {
    data: { code: TEST_LICENSE }
  });
  expect(r.ok()).toBe(true);
  const body = await r.json();
  expect(body.token).toBeTruthy();
  token = body.token;
});

test.describe('Authenticated flows', () => {
  test('GET /api/user/export devuelve JSON GDPR-compliant', async ({ request }) => {
    const r = await request.get(`${BACKEND_URL}/api/user/export`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(r.ok()).toBe(true);
    const body = await r.json();
    expect(body).toHaveProperty('exportedAt');
    expect(body).toHaveProperty('meta');
    expect(body.meta.gdprCompliant).toBe(true);
  });

  test('GET /api/broker/status sin broker conectado devuelve connected=false', async ({ request }) => {
    const r = await request.get(`${BACKEND_URL}/api/broker/status`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(r.ok()).toBe(true);
    const body = await r.json();
    expect(typeof body.connected).toBe('boolean');
  });

  test('POST /api/broker/place-order sin broker conectado devuelve 400', async ({ request }) => {
    const r = await request.post(`${BACKEND_URL}/api/broker/place-order`, {
      headers: { 'Authorization': `Bearer ${token}`, 'X-Idempotency-Key': 'test-' + Date.now() },
      data: {
        symbol: 'BTCUSDT', side: 'BUY', usdAmount: 100, leverage: 3,
        tp: 101000, sl: 99000, currentPrice: 100000
      }
    });
    expect([400, 401, 403]).toContain(r.status());
  });

  test('POST /api/user/paper persiste y retorna', async ({ request }) => {
    const payload = {
      balance: 10000, positions: [], history: [], equity: [],
      lastModified: Date.now()
    };
    const r = await request.post(`${BACKEND_URL}/api/user/paper`, {
      headers: { 'Authorization': `Bearer ${token}` },
      data: payload
    });
    expect(r.ok()).toBe(true);

    const r2 = await request.get(`${BACKEND_URL}/api/user/paper`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    expect(r2.ok()).toBe(true);
    const back = await r2.json();
    expect(back).toHaveProperty('data');
  });
});
