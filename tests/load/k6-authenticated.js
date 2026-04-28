// k6 load — authenticated scenarios (broker status + user paper sync)
// Requiere: TEST_LICENSE_CODE env + backend con TEST_JWT_ENABLED=true
// Run: TEST_LICENSE_CODE=RX-VIP-XXXX k6 run tests/load/k6-authenticated.js

import http from 'k6/http';
import { check, sleep } from 'k6/metrics';
import { Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const errorRate = new Rate('errors');
const BACKEND = __ENV.BACKEND_URL || 'https://rxtrading-1.onrender.com';
const TEST_CODE = __ENV.TEST_LICENSE_CODE;

if (!TEST_CODE) {
  throw new Error('TEST_LICENSE_CODE env var required. Set it to a valid test license key.');
}

// Setup: provisionar JWT una vez para toda la corrida
export function setup() {
  const r = http.post(`${BACKEND}/api/test/jwt`, JSON.stringify({ code: TEST_CODE }), {
    headers: { 'Content-Type': 'application/json' }
  });
  if (r.status !== 200) {
    throw new Error(`JWT provisioning failed: ${r.status} ${r.body}`);
  }
  const body = JSON.parse(r.body);
  return { token: body.token };
}

export const options = {
  scenarios: {
    broker_status: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '2m', target: 100 },
        { duration: '30s', target: 0 }
      ],
      exec: 'brokerStatus'
    },
    paper_sync: {
      executor: 'constant-vus',
      vus: 20,
      duration: '3m',
      exec: 'paperSync'
    }
  },
  thresholds: {
    'http_req_duration{scenario:broker_status}': ['p(95)<400'],
    'http_req_duration{scenario:paper_sync}': ['p(95)<600'],
    'http_req_failed': ['rate<0.02'],
    'errors': ['rate<0.03']
  }
};

export function brokerStatus(data) {
  const r = http.get(`${BACKEND}/api/broker/status`, {
    headers: { 'Authorization': `Bearer ${data.token}` }
  });
  const ok = check(r, {
    'status 200|401': (res) => res.status === 200 || res.status === 401,
    'valid JSON': (res) => { try { JSON.parse(res.body); return true; } catch { return false; } }
  });
  errorRate.add(!ok);
  sleep(5);
}

export function paperSync(data) {
  const payload = JSON.stringify({
    balance: 10000 + Math.random() * 1000,
    positions: [],
    history: [],
    equity: [],
    lastModified: Date.now()
  });
  const r = http.post(`${BACKEND}/api/user/paper`, payload, {
    headers: { 'Authorization': `Bearer ${data.token}`, 'Content-Type': 'application/json' }
  });
  check(r, { 'paper sync 200': (res) => res.status === 200 });
  sleep(10);
}
