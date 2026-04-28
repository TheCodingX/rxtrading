// k6 load test — baseline 200 usuarios concurrentes
// Install: brew install k6   OR  docker run --rm -i grafana/k6 run -
// Run: k6 run tests/load/k6-baseline.js
//      k6 run --vus 200 --duration 5m tests/load/k6-baseline.js
//
// Scenarios:
//   1. public: pull /api/public-signals cada 30s (feed público)
//   2. health: ping /health cada 60s (UptimeRobot simulation)
//   3. landing: GET landing periódicamente (marketing visitors)
//
// No incluye paths autenticados (trades, paper sync) — requieren JWT válidos
// generados per-VU desde un setup phase. Extender con /api/keys/validate en CI.

import http from 'k6/http';
import { check, sleep } from 'k6/metrics';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export const options = {
  scenarios: {
    public_signals: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },   // Ramp up
        { duration: '2m',  target: 200 },  // Sustained load
        { duration: '30s', target: 0 }     // Ramp down
      ],
      gracefulRampDown: '30s',
      exec: 'pollPublicSignals'
    },
    health_monitor: {
      executor: 'constant-vus',
      vus: 5,
      duration: '3m',
      exec: 'healthCheck'
    },
    landing: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 30 },
        { duration: '1m', target: 30 },
        { duration: '30s', target: 0 }
      ],
      exec: 'browseLanding'
    }
  },
  thresholds: {
    'http_req_duration{scenario:public_signals}': ['p(95)<500'],   // p95 bajo 500ms
    'http_req_duration{scenario:health_monitor}': ['p(95)<200'],   // p95 bajo 200ms
    'http_req_failed': ['rate<0.01'],                              // <1% errors
    'errors': ['rate<0.02']
  }
};

const BACKEND = __ENV.BACKEND_URL || 'https://rxtrading-1.onrender.com';
const FRONTEND = __ENV.FRONTEND_URL || 'https://rxtrading.net';

export function pollPublicSignals() {
  const r = http.get(`${BACKEND}/api/public-signals?limit=30`);
  const ok = check(r, {
    'status 200': (res) => res.status === 200,
    'has signals array': (res) => {
      try { return Array.isArray(JSON.parse(res.body).signals); } catch { return false; }
    }
  });
  errorRate.add(!ok);
  sleep(30); // emula poll cada 30s del cliente
}

export function healthCheck() {
  const r = http.get(`${BACKEND}/health`);
  check(r, { 'health 200|503': (res) => res.status === 200 || res.status === 503 });
  sleep(60);
}

export function browseLanding() {
  const r = http.get(FRONTEND);
  check(r, {
    'landing 200': (res) => res.status === 200,
    'html content': (res) => res.body.includes('RX Trading')
  });
  sleep(Math.random() * 10 + 5);
}
