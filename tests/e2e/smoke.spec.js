// Playwright E2E smoke tests — RX Trading
// Install: npm i -D @playwright/test && npx playwright install chromium
// Run: npx playwright test tests/e2e/smoke.spec.js
//
// Las suites completas (trading flow, paper, signals, autotrading) se ejecutan contra
// testnet/staging con credenciales reales en CI. Este archivo es el smoke mínimo deployable.

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://rxtrading.net';

test.describe('Landing + public pages', () => {
  test('landing responde 200 con título correcto', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page).toHaveTitle(/RX Trading/i);
  });

  test('privacy page bilingüe funciona', async ({ page }) => {
    await page.goto(BASE_URL + '/privacy.html');
    await expect(page.locator('h1')).toContainText('Política de Privacidad');
    await page.click('#lang-toggle');
    await expect(page.locator('h1')).toContainText('Privacy Policy');
  });

  test('terms, cookies, refund responden 200', async ({ page }) => {
    for (const path of ['/terms.html', '/cookies.html', '/refund.html']) {
      const resp = await page.goto(BASE_URL + path);
      expect(resp.status()).toBe(200);
    }
  });
});

test.describe('App — CORE flow sin VIP', () => {
  test('app.html carga sin errores de consola', async ({ page }) => {
    const errors = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto(BASE_URL + '/app.html');
    await page.waitForLoadState('networkidle', { timeout: 10000 });
    await page.waitForTimeout(2000);
    // V44 engine debe cargar
    const hasV44 = await page.evaluate(() => typeof window.genApexV44LiveSignal === 'function');
    expect(hasV44).toBe(true);
    // Cache compartido
    const hasCache = await page.evaluate(() => typeof window._v44SigCache === 'object');
    expect(hasCache).toBe(true);
    // No errores críticos
    expect(errors.filter(e => !e.includes('favicon') && !e.includes('CORS'))).toEqual([]);
  });

  test('feed /api/public-signals responde', async ({ request }) => {
    const backendUrl = process.env.BACKEND_URL || 'https://rxtrading-1.onrender.com';
    const resp = await request.get(backendUrl + '/api/public-signals?limit=5');
    expect(resp.ok()).toBe(true);
    const body = await resp.json();
    expect(body).toHaveProperty('signals');
    expect(body).toHaveProperty('last_scan');
    expect(body).toHaveProperty('universe');
    expect(Array.isArray(body.universe)).toBe(true);
    expect(body.universe.length).toBe(15);
  });
});

test.describe('App — security headers', () => {
  test('/health endpoint existe', async ({ request }) => {
    const backendUrl = process.env.BACKEND_URL || 'https://rxtrading-1.onrender.com';
    const resp = await request.get(backendUrl + '/health');
    expect([200, 503]).toContain(resp.status());
    const body = await resp.json();
    expect(body).toHaveProperty('ok');
    expect(body).toHaveProperty('checks');
  });
});
