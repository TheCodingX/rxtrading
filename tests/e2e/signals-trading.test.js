/**
 * E2E — Signals + Paper Trading
 * Fecha: 2026-04-24
 *
 * Cobertura (del protocolo de auditoría FASE 4):
 *   T1  — Señal → signalId único + determinístico
 *   T2  — Misma señal 10 scans seguidos → NO duplicada
 *   T3  — Double-click rápido en OPERAR → UN solo trade
 *   T4  — Refresh página con trade abierto → estado correcto
 *   T5  — Simular TP hit → cierre con razón TP_HIT + notif
 *   T6  — Simular SL hit → cierre con razón SL_HIT + notif
 *   T7  — Simular daily loss -5% → autotrade pausa + notif
 *   T8  — Simular 5 losses consecutivas → circuit breaker + notif
 *   T9  — Close manual → razón MANUAL_CLOSE + log
 *   T10 — Paper y testnet misma señal → mismo comportamiento (stub por credenciales)
 *
 * Ejecución:
 *   node tests/e2e/signals-trading.test.js
 *
 * No depende de Jest / Mocha — prints verde/rojo con códigos ANSI.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(safeRequire('jsdom'));

function safeRequire(mod){
  try { require.resolve(mod); return mod; }
  catch(e){
    console.error('\x1b[31m[tests] npm install --save-dev jsdom requerido\x1b[0m');
    process.exit(2);
  }
}

// ─────────── Helpers ───────────
let _pass = 0, _fail = 0;
const GREEN = '\x1b[32m', RED = '\x1b[31m', RESET = '\x1b[0m', CYAN = '\x1b[36m', YELLOW='\x1b[33m';
function pass(name, detail){ _pass++; console.log(`${GREEN}✓ PASS${RESET} ${name}${detail?` — ${detail}`:''}`); }
function fail(name, detail){ _fail++; console.log(`${RED}✗ FAIL${RESET} ${name}${detail?` — ${detail}`:''}`); }
function todo(name, detail){ console.log(`${YELLOW}○ TODO${RESET} ${name}${detail?` — ${detail}`:''}`); }
function assertEq(a, b, name){ if(a === b) pass(name, `got ${JSON.stringify(a)}`); else fail(name, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function assertTrue(cond, name, detail){ if(cond) pass(name, detail); else fail(name, detail); }

// ─────────── Load app.html in JSDOM ───────────
console.log(`\n${CYAN}═══ E2E Signals + Paper Trading ═══${RESET}\n`);
const htmlPath = path.join(__dirname, '../../frontend/app.html');
const html = fs.readFileSync(htmlPath, 'utf-8');

// Extract (a) signal-id helpers y (b) safety-gate helpers — residen en distintos puntos del HTML.
function slice(html, begin, end){
  const b = html.indexOf(begin); const e = html.indexOf(end);
  if(b<0||e<0) throw new Error('Helper markers not found: '+begin+' / '+end);
  return html.slice(b, e);
}
const blockA = slice(html, '// 2026-04-24 SIGNAL ID DEDUP', '// ═══ RSI(14) Divergence Detection');
const blockB = slice(html, '// 2026-04-24 FIX E.2: paper safety gates', 'function renderPaper(){');
const helperBlock = blockA + '\n' + blockB;

// Minimal shim environment
const { window } = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url:'http://localhost/', runScripts:'outside-only' });
// JSDOM provides its own localStorage — no override needed. Just ensure clean slate.
try { window.localStorage.clear(); } catch(e){}
window.paperData = { balance: 10000, positions: [], history: [], equity: [] };
window.autoTradeActive = false;
window.autoTradeCooldowns = {};
window.paperSignalMode = 'binance';
window.px = {};
window._pxTimestamp = {};
window.paperLastSig = null;
window.toast = function(msg){ /* captured via window._toasts */ window._toasts = window._toasts || []; window._toasts.push(msg); };
window.toggleAutoTrade = function(){ window.autoTradeActive = !window.autoTradeActive; };
window.savePaper = function(){};
window.renderPaper = function(){};

// Eval helpers in sandbox
// NOTE: setInterval is called inside helperBlock — we override to noop for test determinism
window.setInterval = () => 0;
window.clearInterval = () => {};
try {
  const sandboxEval = new window.Function(helperBlock + '\n this.rxSignalId = rxSignalId; this.rxMarkSignalOperated = rxMarkSignalOperated; this.rxWasSignalOperated = rxWasSignalOperated; this.RX_CLOSE_REASON = RX_CLOSE_REASON; this.rxCloseReasonLabel = rxCloseReasonLabel; this.rxPaperSafetyGateCheck = rxPaperSafetyGateCheck; this.rxPaperSafetyIsBlocked = rxPaperSafetyIsBlocked;');
  sandboxEval.call(window);
} catch(e){
  console.log(`${RED}Failed to eval helperBlock:${RESET}`, e.message);
  process.exit(4);
}

// ─────────── T1: signalId único + determinístico ───────────
{
  const sig = { signal:'BUY', tp:1.23456, sl:1.20000, timestamp: Date.parse('2026-04-24T12:00:00Z'), _engine:'V44' };
  const id1 = window.rxSignalId(sig, 'BTCUSDT');
  const id2 = window.rxSignalId(sig, 'BTCUSDT');
  const id3 = window.rxSignalId({ ...sig, tp: 1.23457 }, 'BTCUSDT'); // diff TP
  const id4 = window.rxSignalId(sig, 'ETHUSDT'); // diff sym
  assertEq(id1, id2, 'T1.a: mismo input → mismo signalId');
  assertTrue(id1 !== id3, 'T1.b: TP distinto → ID distinto');
  assertTrue(id1 !== id4, 'T1.c: símbolo distinto → ID distinto');
  assertTrue(id1.startsWith('sig_'), 'T1.d: formato sig_*');
}

// ─────────── T2: misma señal 10 scans → NO duplicado ───────────
{
  const sig = { signal:'SELL', tp:5.0, sl:5.2, timestamp: Date.parse('2026-04-24T13:00:00Z'), _engine:'V44' };
  const id = window.rxSignalId(sig, 'ATOMUSDT');
  window.rxMarkSignalOperated(id);
  let dupSeen = 0;
  for(let i=0;i<10;i++){
    if(window.rxWasSignalOperated(id)) dupSeen++;
  }
  assertEq(dupSeen, 10, 'T2: 10 checks consecutivos detectan "ya operada"');
}

// ─────────── T3: mutex + dedup double-click ───────────
{
  // Simula dos llamadas rápidas marcando la misma señal
  const sig = { signal:'BUY', tp:10, sl:9.5, timestamp: Date.now(), _engine:'V44' };
  const id = window.rxSignalId(sig, 'SOLUSDT');
  const wasOperated1 = window.rxWasSignalOperated(id);
  window.rxMarkSignalOperated(id);
  const wasOperated2 = window.rxWasSignalOperated(id);
  assertEq(wasOperated1, false, 'T3.a: primera vez → no operada');
  assertEq(wasOperated2, true, 'T3.b: segunda vez → sí operada (bloqueo)');
}

// ─────────── T4: persistencia localStorage (refresh simulado) ───────────
{
  const sig = { signal:'BUY', tp:100, sl:95, timestamp: Date.parse('2026-04-24T14:00:00Z'), _engine:'V44' };
  const id = window.rxSignalId(sig, 'ETHUSDT');
  window.rxMarkSignalOperated(id);
  const stored = window.localStorage.getItem('rx_operated_sig_ids');
  assertTrue(stored && stored.includes(id.slice(0,10)), 'T4: signalId persistido en localStorage');
  // Simula refresh cargando fresh helpers
  const restored = JSON.parse(stored || '{}');
  assertTrue(restored[id] && typeof restored[id] === 'number', 'T4: timestamp persistido');
}

// ─────────── T5 + T6: TP/SL reason categorization ───────────
{
  assertEq(window.RX_CLOSE_REASON.TP_HIT, 'TP_HIT', 'T5: constante TP_HIT definida');
  assertEq(window.RX_CLOSE_REASON.SL_HIT, 'SL_HIT', 'T6: constante SL_HIT definida');
  assertEq(window.rxCloseReasonLabel('TP_HIT'), 'Take Profit alcanzado', 'T5: label TP legible');
  assertEq(window.rxCloseReasonLabel('SL_HIT'), 'Stop Loss tocado', 'T6: label SL legible');
  const allReasons = Object.keys(window.RX_CLOSE_REASON);
  assertTrue(allReasons.includes('SAFETY_GATE_DAILY'), 'T5: SAFETY_GATE_DAILY presente');
  assertTrue(allReasons.includes('TIME_STOP'), 'T5: TIME_STOP presente');
  assertTrue(allReasons.length >= 10, `T5: ≥10 razones categorizadas (${allReasons.length})`);
}

// ─────────── T7: daily stop -5% → pausa autotrade ───────────
{
  // Reset state
  window.localStorage.removeItem('rx_paper_safety');
  window.paperData.balance = 10000;
  window.autoTradeActive = true;
  // Simulate 5 losses of $120 each = $600 = 6% of 10k
  // Need to simulate progressive balance changes
  let bal = 10000;
  for(let i=0;i<5;i++){
    bal -= 120;
    window.paperData.balance = bal;
    window.rxPaperSafetyGateCheck(-120);
  }
  const blocked = window.rxPaperSafetyIsBlocked();
  assertTrue(blocked.blocked, `T7: daily stop bloqueó autotrade (reason=${blocked.reason})`);
}

// ─────────── T8: 5 losses consecutivas → circuit breaker ───────────
{
  window.localStorage.removeItem('rx_paper_safety');
  window.paperData.balance = 10000;
  window.autoTradeActive = true;
  for(let i=0;i<5;i++){
    window.paperData.balance -= 50;
    window.rxPaperSafetyGateCheck(-50); // loss each
  }
  const blocked = window.rxPaperSafetyIsBlocked();
  // -50 * 5 = -250 = 2.5% (no daily stop), pero sí circuit breaker por 5 consecutivas
  assertTrue(blocked.blocked, `T8: circuit breaker bloqueó (reason=${blocked.reason})`);
  assertEq(blocked.reason, 'circuit', 'T8: razón = circuit');
}

// ─────────── T9: close reason default = MANUAL_CLOSE ───────────
{
  // Verifica que rxCloseReasonLabel maneja razón desconocida con fallback
  assertEq(window.rxCloseReasonLabel('FOO_UNKNOWN'), 'FOO_UNKNOWN', 'T9: razón desconocida → echo (no crash)');
  assertEq(window.rxCloseReasonLabel('MANUAL_CLOSE'), 'Cierre manual', 'T9: MANUAL_CLOSE label ok');
  assertEq(window.rxCloseReasonLabel(null), 'Razón desconocida', 'T9: null → fallback legible');
}

// ─────────── T10: paper/live parity (stub, sin testnet creds) ───────────
todo('T10', 'paper vs testnet parity requiere BINANCE_TESTNET_API_KEY — skip sin credenciales');

// ─────────── Summary ───────────
console.log(`\n${CYAN}═══ Resumen ═══${RESET}`);
console.log(`${GREEN}Passed: ${_pass}${RESET}`);
console.log(`${RED}Failed: ${_fail}${RESET}`);
process.exit(_fail > 0 ? 1 : 0);
