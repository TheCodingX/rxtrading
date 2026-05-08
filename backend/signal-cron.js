/**
 * SIGNAL CRON JOBS — Server-side periodic maintenance.
 *
 * 1. Expiration job (60s): UPDATE signals SET state='EXPIRED' WHERE state='ACTIVE' AND expires_at < NOW().
 *    Emits signal_event 'expired' for each. WS broadcasts to clients to remove from UI.
 *
 * 2. Reconciliation job (5min): for each user with broker connected,
 *    fetch open positions from Binance and reconcile with signal_trades.
 *    If divergence: log + alert admin (do not auto-close blindly).
 *
 * 3. TP/SL monitor (30s): intrabar OHLC 5m to detect TP/SL hits at SIGNAL level.
 *
 * 4. (2026-05-07) Trade close propagator (30s): when a SIGNAL closes (state=EXPIRED with
 *    outcome WIN/LOSS/NO_HIT), propagate the close to all signal_trades attached to it.
 *    Fixes the gap where paper trades stayed OPEN forever after signal closed because
 *    no server-side mechanism mirrored the close from level-1 (signals) to level-2
 *    (signal_trades). Mode=paper always closes immediately. Mode=real_* defers to
 *    reconcile cycle when Binance still shows position open (avoids double-close).
 *
 * Author: 2026-04-25 audit phase 3 · 2026-05-07 trade close propagator
 */
'use strict';

const { pool } = require('./database');
const sigStore = require('./signal-store');

const EXPIRATION_INTERVAL_MS = parseInt(process.env.SIGNAL_EXPIRE_INTERVAL_MS || '60000', 10); // 60s
const RECONCILE_INTERVAL_MS = parseInt(process.env.SIGNAL_RECONCILE_INTERVAL_MS || '300000', 10); // 5min
const TPSL_MONITOR_INTERVAL_MS = parseInt(process.env.SIGNAL_TPSL_INTERVAL_MS || '30000', 10); // 30s
// 2026-05-07 — trade close propagator interval. Same cadence as TPSL since they're complementary.
const TRADE_CLOSE_INTERVAL_MS = parseInt(process.env.SIGNAL_TRADE_CLOSE_INTERVAL_MS || '30000', 10);
// 2026-05-07 — TIME_STOP grace window. After signal.expires_at, wait this long before
// force-closing the trade with reason=TIME_STOP. Gives expire+TPSL crons time to land
// the proper outcome first.
const TIME_STOP_GRACE_MS = parseInt(process.env.SIGNAL_TIME_STOP_GRACE_MS || '3600000', 10); // 1h

let _expireTimer = null;
let _reconcileTimer = null;
let _tpslTimer = null;
let _tradeCloseTimer = null;
let _onSignalExpiredCb = null;
let _onSignalClosedCb = null;
let _onTradeClosedCb = null;
let _onReconcileDivergence = null;

/**
 * Run expiration cycle. Returns { expiredCount, ids }.
 */
async function runExpirationCycle() {
  try {
    const ids = await sigStore.expireStale();
    if (ids.length > 0) {
      console.log('[SignalCron] expired', ids.length, 'signals');
      if (_onSignalExpiredCb) {
        for (const sid of ids) {
          try { await _onSignalExpiredCb(sid); } catch (_) {}
        }
      }
    }
    return { expiredCount: ids.length, ids };
  } catch (err) {
    console.error('[SignalCron] expiration error:', err.message);
    return { error: err.message };
  }
}

/**
 * Run reconciliation cycle. For each user with broker_configs is_active=1, query Binance positions
 * and compare with signal_trades trade_state='OPEN' for that user.
 *
 * Strategy:
 *   • If our DB has OPEN trade but Binance has no position → trade was closed externally. Mark CLOSED with reason RECONCILE_EXTERNAL.
 *   • If Binance has position but our DB has no OPEN trade → log divergence + alert (manual investigation).
 *
 * Note: this requires broker.js + decryption of api keys. Using existing helpers.
 */
async function runReconcileCycle() {
  try {
    // Lazy-load broker to avoid circular deps
    let broker;
    try { broker = require('./broker'); } catch (_) { return { skipped: 'no_broker' }; }
    const { rows: configs } = await pool.query(
      `SELECT bc.id, bc.key_id, bc.api_key_enc, bc.api_secret_enc
         FROM broker_configs bc
         JOIN license_keys lk ON lk.id = bc.key_id
        WHERE bc.is_active = 1
          AND lk.is_revoked = 0
          AND COALESCE(lk.is_deleted,0) = 0
        LIMIT 200`
    );
    const stats = { users_checked: 0, divergences: 0, externally_closed: 0 };
    for (const cfg of configs) {
      stats.users_checked++;
      try {
        // Decrypt keys (broker.decryptKeys helper expected; if absent, skip)
        let creds;
        try {
          creds = typeof broker.decryptKeys === 'function'
            ? broker.decryptKeys({ api_key_enc: cfg.api_key_enc, api_secret_enc: cfg.api_secret_enc })
            : null;
        } catch (_) { creds = null; }
        if (!creds || !creds.apiKey || !creds.apiSecret) continue;
        // Get open Binance positions
        const positions = typeof broker.getOpenPositions === 'function'
          ? await broker.getOpenPositions(creds).catch(() => [])
          : [];
        const binanceSymbols = new Set(positions.map(p => p.symbol));

        // Get our DB OPEN trades for this user
        const { rows: openTrades } = await pool.query(
          `SELECT t.id, t.signal_id, t.binance_order_id, s.symbol
             FROM signal_trades t
             JOIN signals s ON s.signal_id = t.signal_id
            WHERE t.key_id = $1 AND t.trade_state = 'OPEN' AND t.mode IN ('real_testnet','real_mainnet')`,
          [cfg.key_id]
        );

        for (const t of openTrades) {
          if (!binanceSymbols.has(t.symbol)) {
            // Externally closed — mark in our DB
            await sigStore.closeTrade({
              tradeId: t.id,
              closePrice: null,
              closeReason: 'RECONCILE_EXTERNAL',
              pnl: null,
              meta: { reconciled_at: new Date().toISOString() }
            });
            stats.externally_closed++;
          }
        }

        // Detect Binance positions without DB record (divergence)
        const dbSymbols = new Set(openTrades.map(t => t.symbol));
        for (const pos of positions) {
          if (!dbSymbols.has(pos.symbol)) {
            stats.divergences++;
            console.warn('[SignalCron] divergence — user', cfg.key_id, 'has Binance position', pos.symbol, 'with no DB trade');
            if (_onReconcileDivergence) {
              try { await _onReconcileDivergence({ keyId: cfg.key_id, position: pos }); } catch (_) {}
            }
          }
        }
      } catch (err) {
        console.warn('[SignalCron] reconcile user err', cfg.key_id, err.message);
      }
    }
    return stats;
  } catch (err) {
    console.error('[SignalCron] reconcile error:', err.message);
    return { error: err.message };
  }
}

/**
 * 2026-05-01 — Fetch OHLC 5m klines from Binance fapi (or Bybit fallback) for a given symbol
 * starting at sinceMs. Returns [{ t, h, l, c }, ...] in chronological order. Used by TP/SL
 * monitor to detect intrabar wick hits (TP/SL targets in the 25–30 bps range can be hit and
 * reverse within a single 1h bar — using 1h close as price proxy systematically misses them).
 */
async function fetchOHLC5m(symbol, sinceMs) {
  const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const opts = { headers: { 'User-Agent': UA, 'Accept': 'application/json' } };
  // Binance fapi (preferred — matches the source funding/perpetual context)
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&startTime=${sinceMs}&limit=500`;
    const r = await fetch(url, opts);
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length > 0) {
        return arr.map(k => ({
          t: parseInt(k[0]),
          h: parseFloat(k[2]),
          l: parseFloat(k[3]),
          c: parseFloat(k[4])
        }));
      }
    }
  } catch (_) {}
  // Bybit linear fallback
  try {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=5&start=${sinceMs}&limit=500`;
    const r = await fetch(url, opts);
    if (r.ok) {
      const j = await r.json();
      const list = j?.result?.list;
      if (Array.isArray(list) && list.length > 0) {
        // Bybit returns newest-first → reverse to chronological
        return list.map(k => ({
          t: parseInt(k[0]),
          h: parseFloat(k[2]),
          l: parseFloat(k[3]),
          c: parseFloat(k[4])
        })).reverse();
      }
    }
  } catch (_) {}
  return null;
}

/**
 * 2026-05-01 — Fallback: latest close price proxy (preserves old behavior when OHLC source is
 * unavailable). Used only as a last resort so the monitor doesn't go silent.
 */
async function fetchLatestCloseFallback(symbol) {
  try {
    const v44 = require('./v44-engine');
    const bars = await v44.fetchBars1h(symbol, 800);
    if (bars && bars.length > 0) return parseFloat(bars[bars.length - 1].c);
  } catch (_) {}
  return null;
}

/**
 * 2026-05-01 — TP/SL monitor (intrabar OHLC variant).
 *
 * For each ACTIVE signal, fetch 5m OHLC klines from the signal's `ts` to now, then iterate
 * chronologically: the first bar whose high crosses TP (BUY) or low crosses SL → that decides
 * the outcome. If both TP and SL fall inside the same 5m bar (rare for 25–30 bps targets),
 * conservative resolution = LOSS (we can't tell tick order without trade data).
 *
 * Klines are fetched per-symbol (one call covers all signals on that symbol → de-duped).
 * If the OHLC source is unreachable, falls back to the legacy close-price proxy so we never
 * stop monitoring entirely.
 */
async function runTpslMonitorCycle() {
  try {
    // 2026-05-07: include engine_version, confidence, meta so we can log per-trade detail
    // (entry, exit, hold time, pnl_bps, funding_source) — needed to validate V44.7 in live
    // and detect any per-symbol or per-window regression vs backtest expectation.
    //
    // 2026-05-07 RACE FIX: query also includes signals whose expires_at passed up to
    // 5 minutes ago. Without this overlap, the expire cycle (60s cadence) could mark a
    // signal as EXPIRED+NO_HIT in the same window where TPSL would have detected the
    // hit and resolved it as WIN/LOSS. The closeSignalWithOutcome path uses FOR UPDATE
    // and only succeeds on state='ACTIVE', so it's a no-op if expire already won — no
    // double-close risk.
    const { rows: openSigs } = await pool.query(
      `SELECT signal_id, symbol, direction, entry, tp, sl, ts, expires_at,
              engine_version, confidence, meta
         FROM signals
        WHERE state = 'ACTIVE'
          AND expires_at > NOW() - INTERVAL '5 minutes'`
    );
    if (openSigs.length === 0) return { monitored: 0, closed: 0 };

    // Group signals by symbol so we fetch klines once per symbol
    const bySymbol = {};
    for (const s of openSigs) {
      if (!bySymbol[s.symbol]) bySymbol[s.symbol] = [];
      bySymbol[s.symbol].push(s);
    }

    const closed = [];
    let ohlcOk = 0;
    let ohlcFail = 0;

    for (const symbol of Object.keys(bySymbol)) {
      const signals = bySymbol[symbol];
      // earliest signal ts on this symbol — single fetch covers all
      const earliestTs = signals.reduce((m, s) => {
        const t = new Date(s.ts).getTime();
        return t < m ? t : m;
      }, Date.now());

      const klines = await fetchOHLC5m(symbol, earliestTs);

      if (klines && klines.length > 0) {
        ohlcOk++;
        for (const sig of signals) {
          const sigTs = new Date(sig.ts).getTime();
          const tp = parseFloat(sig.tp);
          const sl = parseFloat(sig.sl);
          let outcome = null, exitPrice = null, reason = null;
          for (const bar of klines) {
            if (bar.t < sigTs) continue; // ignore bars before signal entry
            if (sig.direction === 'BUY') {
              const tpHit = bar.h >= tp;
              const slHit = bar.l <= sl;
              if (tpHit && slHit) { outcome = 'LOSS'; exitPrice = sl; reason = 'AMBIG_BAR'; break; }
              if (tpHit)          { outcome = 'WIN';  exitPrice = tp; reason = 'TP_HIT';   break; }
              if (slHit)          { outcome = 'LOSS'; exitPrice = sl; reason = 'SL_HIT';   break; }
            } else { // SELL
              const tpHit = bar.l <= tp;
              const slHit = bar.h >= sl;
              if (tpHit && slHit) { outcome = 'LOSS'; exitPrice = sl; reason = 'AMBIG_BAR'; break; }
              if (tpHit)          { outcome = 'WIN';  exitPrice = tp; reason = 'TP_HIT';   break; }
              if (slHit)          { outcome = 'LOSS'; exitPrice = sl; reason = 'SL_HIT';   break; }
            }
          }
          if (outcome) {
            const res = await sigStore.closeSignalWithOutcome({
              signalId: sig.signal_id, outcome, exitPrice, reason
            });
            if (res.ok) closed.push({
              signalId: sig.signal_id, outcome, exitPrice, reason, symbol,
              direction: sig.direction, entry: parseFloat(sig.entry),
              tp: parseFloat(sig.tp), sl: parseFloat(sig.sl),
              tsMs: sigTs, engineVersion: sig.engine_version,
              confidence: sig.confidence, meta: sig.meta
            });
          }
        }
      } else {
        // Fallback: latest close as price proxy (legacy behavior)
        ohlcFail++;
        const price = await fetchLatestCloseFallback(symbol);
        if (price == null || !isFinite(price)) continue;
        for (const sig of signals) {
          const tp = parseFloat(sig.tp);
          const sl = parseFloat(sig.sl);
          let outcome = null, exitPrice = null, reason = null;
          if (sig.direction === 'BUY') {
            if (price >= tp)      { outcome = 'WIN';  exitPrice = tp; reason = 'TP_HIT_FALLBACK'; }
            else if (price <= sl) { outcome = 'LOSS'; exitPrice = sl; reason = 'SL_HIT_FALLBACK'; }
          } else {
            if (price <= tp)      { outcome = 'WIN';  exitPrice = tp; reason = 'TP_HIT_FALLBACK'; }
            else if (price >= sl) { outcome = 'LOSS'; exitPrice = sl; reason = 'SL_HIT_FALLBACK'; }
          }
          if (outcome) {
            const res = await sigStore.closeSignalWithOutcome({
              signalId: sig.signal_id, outcome, exitPrice, reason
            });
            if (res.ok) closed.push({
              signalId: sig.signal_id, outcome, exitPrice, reason, symbol,
              direction: sig.direction, entry: parseFloat(sig.entry),
              tp: parseFloat(sig.tp), sl: parseFloat(sig.sl),
              tsMs: new Date(sig.ts).getTime(), engineVersion: sig.engine_version,
              confidence: sig.confidence, meta: sig.meta
            });
          }
        }
      }
    }

    if (closed.length > 0) {
      // 2026-05-07: per-trade structured log for V44.7 live validation. Each closed trade
      // emits one [TRADE] line with everything needed to reproduce or audit the outcome.
      // Also enables external log shippers (Render → Datadog/Loki) to compute live PF/WR
      // without DB access. Format is parser-friendly: key=value pairs.
      for (const c of closed) {
        const entry = c.entry, exit = c.exitPrice;
        const holdMin = entry && c.tsMs ? Math.round((Date.now() - c.tsMs) / 60000) : null;
        let pnlBps = null;
        if (entry && exit && isFinite(entry) && isFinite(exit) && entry > 0) {
          pnlBps = c.direction === 'BUY'
            ? ((exit - entry) / entry) * 10000
            : ((entry - exit) / entry) * 10000;
          pnlBps = Math.round(pnlBps * 10) / 10;
        }
        const m = c.meta || {};
        const fundingSrc = m.funding_source || 'unknown';
        const fundingZ = (typeof m.funding_zscore === 'number') ? m.funding_zscore.toFixed(3) : 'n/a';
        const win = m.window_type || 'n/a';
        console.log(
          `[SignalCron][TRADE] sig=${c.signalId} sym=${c.symbol} dir=${c.direction} ` +
          `entry=${entry} exit=${exit} tp=${c.tp} sl=${c.sl} outcome=${c.outcome} reason=${c.reason} ` +
          `holdMin=${holdMin} pnlBps=${pnlBps} engine=${c.engineVersion || 'n/a'} ` +
          `fundingSrc=${fundingSrc} fundingZ=${fundingZ} window=${win} conf=${c.confidence}`
        );
      }
      console.log('[SignalCron][TPSL] closed', closed.length, 'signals:',
        closed.map(c => `${c.symbol}=${c.outcome}/${c.reason}`).join(', '),
        `(ohlc=${ohlcOk}/fallback=${ohlcFail})`);
      if (_onSignalClosedCb) {
        for (const c of closed) {
          try { await _onSignalClosedCb(c); } catch (_) {}
        }
      }
    }
    return { monitored: openSigs.length, closed: closed.length, ohlcOk, ohlcFail, details: closed };
  } catch (err) {
    console.error('[SignalCron][TPSL] error:', err.message);
    return { error: err.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 2026-05-07 — TRADE CLOSE PROPAGATOR
// ════════════════════════════════════════════════════════════════════════════
// Maps signal-level outcome → trade-level close_reason.
// closeSignalWithOutcome stores reasons like 'TP_HIT', 'SL_HIT', 'AMBIG_BAR',
// 'TP_HIT_FALLBACK', 'SL_HIT_FALLBACK' inside signal_events, but at the signals
// row we only have outcome ∈ {WIN,LOSS,NO_HIT}. We need a more granular reason
// for signal_trades.close_reason. Strategy: derive from outcome + presence of
// outcome_price relative to TP/SL. If outcome_price equals tp → TP_HIT. If
// equals sl → SL_HIT. Else (NO_HIT or fallback) → TIME_STOP.
function _deriveCloseReason(signal) {
  const out = signal.outcome;
  if (out === 'WIN') return 'TP_HIT';
  if (out === 'LOSS') return 'SL_HIT';
  // NO_HIT or NULL: TTL expired without TP/SL touch
  return 'TIME_STOP';
}

// Compute realized PnL for a trade based on signal outcome and position sizing.
// For mode=paper, pnl is purely simulated from open_price and outcome_price using
// notional from meta (if present) and leverage from meta.
// For mode=real_*, we compute the same way as a fallback but reconcile with Binance
// is the source of truth (this number is used only if Binance reconcile didn't already
// close the trade with its own pnl from order fills).
function _computeTradePnL({ direction, openPrice, outcomePrice, meta }) {
  if (!isFinite(openPrice) || !isFinite(outcomePrice) || openPrice <= 0) return null;
  const sign = direction === 'BUY' ? 1 : -1;
  const pctMove = ((outcomePrice - openPrice) / openPrice) * sign;
  const m = meta || {};
  const notional = parseFloat(m.notional || m.quote_amount || m.amt || 0);
  const leverage = parseFloat(m.leverage || m.lev || 1);
  if (!notional || notional <= 0) {
    // No sizing info — return pct-only pnl (caller can interpret as pnl_pct, not pnl_usd)
    return null;
  }
  return +(notional * leverage * pctMove).toFixed(8);
}

/**
 * 2026-05-07 — Trade close propagator.
 *
 * For each signal_trade in OPEN/PENDING_OPEN/PENDING_CLOSE state, check the parent
 * signal. If signal has closed (state EXPIRED + outcome set), propagate the close
 * to the trade.
 *
 * Mode=paper:    close immediately (no exchange to reconcile against).
 * Mode=real_*:   close only if signal closed AND (the trade is older than the grace
 *                window OR signal closed with TP_HIT/SL_HIT — meaning Binance should
 *                have already executed). If reconcile cycle hasn't yet caught up,
 *                we still close from our side because we have explicit signal outcome;
 *                reconcile will idempotently confirm later.
 *
 * Idempotent: closeTrade only updates rows where trade_state IN ('OPEN','PENDING_CLOSE'),
 * so concurrent reconcile calls are safe.
 */
async function runTradeCloseCycle() {
  try {
    // Pull every trade still considered open along with the signal it belongs to.
    // We use a JOIN so we can see signal.state + outcome + outcome_price + expires_at
    // in one round trip. The query is bounded by trade_state filter; expected size <500.
    const { rows } = await pool.query(`
      SELECT t.id              AS trade_id,
             t.signal_id,
             t.key_id,
             t.mode,
             t.trade_state,
             t.open_price,
             t.opened_at,
             t.meta            AS trade_meta,
             s.symbol,
             s.direction,
             s.entry,
             s.tp,
             s.sl,
             s.state           AS signal_state,
             s.outcome,
             s.outcome_price,
             s.closed_at,
             s.expires_at,
             s.engine_version,
             s.confidence,
             s.meta            AS signal_meta
        FROM signal_trades t
        JOIN signals s ON s.signal_id = t.signal_id
       WHERE t.trade_state IN ('OPEN', 'PENDING_OPEN', 'PENDING_CLOSE')
       ORDER BY t.opened_at ASC NULLS FIRST
       LIMIT 1000
    `);

    if (rows.length === 0) return { evaluated: 0, closed: 0, skipped: 0 };

    let closed = [];
    let skipped = 0;
    let deferred = 0;

    for (const r of rows) {
      const sigClosed = (
        (r.signal_state === 'EXPIRED' || r.signal_state === 'CANCELED' || r.signal_state === 'SUPERSEDED') &&
        r.outcome != null
      );
      const ttlPassedWithGrace = r.expires_at && (Date.now() - new Date(r.expires_at).getTime() > TIME_STOP_GRACE_MS);

      // Determine close path
      let shouldClose = false;
      let reason = null;
      let exitPrice = null;

      if (sigClosed) {
        reason = _deriveCloseReason(r);
        // Use outcome_price when available; fall back to TP for WIN, SL for LOSS, entry for NO_HIT
        if (r.outcome_price != null) {
          exitPrice = parseFloat(r.outcome_price);
        } else if (r.outcome === 'WIN') {
          exitPrice = parseFloat(r.tp);
        } else if (r.outcome === 'LOSS') {
          exitPrice = parseFloat(r.sl);
        } else {
          exitPrice = parseFloat(r.entry); // NO_HIT — no realized move
        }
        shouldClose = true;
      } else if (ttlPassedWithGrace) {
        // Signal still ACTIVE somehow (cron lag?) but TTL passed > 1h ago. Force TIME_STOP.
        reason = 'TIME_STOP';
        // We don't know outcome_price — use signal.entry (zero-PnL conservative)
        // The pnl will reflect the user's open_price → entry difference, which is normally near zero.
        exitPrice = parseFloat(r.entry);
        shouldClose = true;
      }

      if (!shouldClose) { skipped++; continue; }

      // For real modes, reconcile cycle is the authoritative source. We still close from
      // here for safety, but log it specially so anomalies are visible. closeTrade is
      // idempotent (only affects rows in OPEN/PENDING_CLOSE), so a later reconcile call
      // is a no-op.
      const isReal = r.mode === 'real_testnet' || r.mode === 'real_mainnet';

      const pnl = _computeTradePnL({
        direction: r.direction,
        openPrice: parseFloat(r.open_price || r.entry),
        outcomePrice: exitPrice,
        meta: r.trade_meta
      });

      const closeMeta = {
        propagated_from_signal: true,
        signal_outcome: r.outcome,
        signal_state: r.signal_state,
        signal_closed_at: r.closed_at,
        ttl_passed_with_grace: ttlPassedWithGrace,
        derived_reason: reason,
        derived_exit_price: exitPrice,
        derived_pnl: pnl,
        propagated_at: new Date().toISOString()
      };

      try {
        const result = await sigStore.closeTrade({
          tradeId: r.trade_id,
          closePrice: exitPrice,
          closeReason: reason,
          pnl,
          meta: closeMeta
        });
        if (result.ok) {
          closed.push({
            tradeId: r.trade_id,
            signalId: r.signal_id,
            keyId: r.key_id,
            mode: r.mode,
            symbol: r.symbol,
            direction: r.direction,
            reason,
            exitPrice,
            pnl,
            isReal,
            engineVersion: r.engine_version
          });
        } else {
          // 'trade_not_open_or_not_found' is expected if reconcile or another cycle won the race
          if (result.reason !== 'trade_not_open_or_not_found') {
            console.warn(`[SignalCron][TradeClose] trade=${r.trade_id} skip: ${result.reason}`);
            deferred++;
          }
        }
      } catch (e) {
        console.error(`[SignalCron][TradeClose] error closing trade=${r.trade_id}:`, e.message);
        deferred++;
      }
    }

    if (closed.length > 0) {
      // Per-trade structured log so log shippers can compute live PF/WR per user/mode/engine.
      for (const c of closed) {
        console.log(
          `[SignalCron][TRADE_CLOSE] trade=${c.tradeId} sig=${c.signalId} key=${c.keyId} mode=${c.mode} ` +
          `sym=${c.symbol} dir=${c.direction} reason=${c.reason} exit=${c.exitPrice} pnl=${c.pnl} ` +
          `engine=${c.engineVersion} isReal=${c.isReal}`
        );
      }
      // Aggregate summary line for ops monitoring
      const counts = {};
      for (const c of closed) counts[c.reason] = (counts[c.reason] || 0) + 1;
      const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`[SignalCron][TradeClose] closed ${closed.length} trades · ${summary} · evaluated=${rows.length} skipped=${skipped} deferred=${deferred}`);

      // Fire callbacks (notif-store wiring done at server.js level)
      if (_onTradeClosedCb) {
        for (const c of closed) {
          try { await _onTradeClosedCb(c); } catch (_) {}
        }
      }
    }

    return {
      evaluated: rows.length,
      closed: closed.length,
      skipped,
      deferred,
      details: closed
    };
  } catch (err) {
    console.error('[SignalCron][TradeClose] cycle error:', err.message);
    return { error: err.message };
  }
}

function start({ onSignalExpired, onSignalClosed, onTradeClosed, onReconcileDivergence } = {}) {
  if (onSignalExpired) _onSignalExpiredCb = onSignalExpired;
  if (onSignalClosed) _onSignalClosedCb = onSignalClosed;
  if (onTradeClosed) _onTradeClosedCb = onTradeClosed;
  if (onReconcileDivergence) _onReconcileDivergence = onReconcileDivergence;
  if (!_expireTimer) {
    setTimeout(() => runExpirationCycle().catch(e => console.warn(e.message)), 8000);
    _expireTimer = setInterval(() => {
      runExpirationCycle().catch(e => console.warn(e.message));
    }, EXPIRATION_INTERVAL_MS);
    console.log('[SignalCron] expiration job started — every', EXPIRATION_INTERVAL_MS, 'ms');
  }
  if (!_reconcileTimer) {
    setTimeout(() => runReconcileCycle().catch(e => console.warn(e.message)), 30000);
    _reconcileTimer = setInterval(() => {
      runReconcileCycle().catch(e => console.warn(e.message));
    }, RECONCILE_INTERVAL_MS);
    console.log('[SignalCron] reconciliation job started — every', RECONCILE_INTERVAL_MS, 'ms');
  }
  if (!_tpslTimer) {
    setTimeout(() => runTpslMonitorCycle().catch(e => console.warn(e.message)), 15000);
    _tpslTimer = setInterval(() => {
      runTpslMonitorCycle().catch(e => console.warn(e.message));
    }, TPSL_MONITOR_INTERVAL_MS);
    console.log('[SignalCron] TP/SL monitor started — every', TPSL_MONITOR_INTERVAL_MS, 'ms');
  }
  // 2026-05-07 — trade close propagator. Stagger 5s after TPSL so signals close
  // (level 1) before we look at trades (level 2) on the same tick.
  if (!_tradeCloseTimer) {
    setTimeout(() => runTradeCloseCycle().catch(e => console.warn('[SignalCron][TradeClose] err', e.message)), 20000);
    _tradeCloseTimer = setInterval(() => {
      runTradeCloseCycle().catch(e => console.warn('[SignalCron][TradeClose] err', e.message));
    }, TRADE_CLOSE_INTERVAL_MS);
    console.log('[SignalCron] trade close propagator started — every', TRADE_CLOSE_INTERVAL_MS, 'ms (TIME_STOP grace', TIME_STOP_GRACE_MS / 60000, 'min)');
  }
}

function stop() {
  if (_expireTimer) { clearInterval(_expireTimer); _expireTimer = null; }
  if (_reconcileTimer) { clearInterval(_reconcileTimer); _reconcileTimer = null; }
  if (_tpslTimer) { clearInterval(_tpslTimer); _tpslTimer = null; }
  if (_tradeCloseTimer) { clearInterval(_tradeCloseTimer); _tradeCloseTimer = null; }
}

module.exports = {
  EXPIRATION_INTERVAL_MS,
  RECONCILE_INTERVAL_MS,
  TPSL_MONITOR_INTERVAL_MS,
  TRADE_CLOSE_INTERVAL_MS,
  TIME_STOP_GRACE_MS,
  runExpirationCycle,
  runReconcileCycle,
  runTpslMonitorCycle,
  runTradeCloseCycle,
  start,
  stop,
  // 2026-05-07 — internal helpers exposed for unit testing only
  _internal: {
    deriveCloseReason: _deriveCloseReason,
    computeTradePnL: _computeTradePnL
  }
};
