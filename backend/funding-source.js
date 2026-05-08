/**
 * REAL FUNDING SOURCE — Replaces the legacy `computeFundingProxy` (price - EMA50)/EMA50
 * which is a technical mean-reversion proxy, NOT actual perpetual funding.
 *
 * For a strategy literally named "funding-carry", the input must be the real perpetual
 * funding rate from the exchange. This module fetches:
 *
 *   • premiumIndexKlines (hourly average premium index) — the continuous "funding signal"
 *     between the perpetual mark price and the spot index. This is what determines the
 *     8h funding payment. Hourly granularity is ideal for our 1h evaluation cadence.
 *   • fundingRate history (every 8h) — the actual settled rates, used as cross-check.
 *
 * Cascade: Binance fapi → OKX → Bybit. Cached in-memory (TTL 50min, like fetchBars1h).
 *
 * If ALL sources fail (e.g. Render IP geo-block + OKX rate limit + Bybit down), the caller
 * (v44-engine) gracefully falls back to the legacy EMA proxy so the engine keeps operating
 * (degraded — equivalent to the pre-2026-05-01 behavior).
 *
 * Author: 2026-05-01 — funding-carry root-cause fix
 */
'use strict';

const PREMIUM_CACHE_TTL_MS = 50 * 60 * 1000; // 50min — matches fetchBars1h cache
const _premiumCache = new Map(); // symbol → { bars, ts }

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FETCH_OPTS = { headers: { 'User-Agent': UA, 'Accept': 'application/json' } };

const stripPrefix = (s) => s.startsWith('1000') ? s.slice(4) : s;

/**
 * Fetch hourly average premium index for a perpetual contract. Returns array of
 * { t, c } in ascending chronological order, where `c` is the average premium
 * index over that hour (a small dimensionless number, typically ±0.0005).
 *
 * Cascade Binance fapi → OKX → Bybit. Cached.
 */
async function fetchPremiumIndex1h(symbol, limit = 800) {
  const cached = _premiumCache.get(symbol);
  if (cached && (Date.now() - cached.ts) < PREMIUM_CACHE_TTL_MS && cached.bars && cached.bars.length >= limit * 0.85) {
    return cached.bars;
  }

  // 1. Binance fapi — premiumIndexKlines (most direct + accurate for funding-carry)
  // https://binance-docs.github.io/apidocs/futures/en/#premium-index-kline-data
  try {
    const url = `https://fapi.binance.com/fapi/v1/premiumIndexKlines?symbol=${symbol}&interval=1h&limit=${Math.min(limit, 1500)}`;
    const r = await fetch(url, FETCH_OPTS);
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length > 0) {
        // [openTime, open, high, low, close, ...]
        const bars = arr.map(k => ({ t: parseInt(k[0]), c: parseFloat(k[4]) }))
                       .filter(b => isFinite(b.c));
        if (bars.length > 0) {
          _premiumCache.set(symbol, { bars, ts: Date.now() });
          return bars;
        }
      }
    }
  } catch (_) {}

  // 2. OKX — funding-rate history (every 8h, but we'll forward-fill to hourly downstream)
  // Returns funding rate values, similar magnitude/meaning as premium index for our purpose.
  try {
    if (symbol.endsWith('USDT')) {
      const base = stripPrefix(symbol.slice(0, -4));
      const inst = `${base}-USDT-SWAP`;
      // OKX funding rate history: every 8h, max 100 per call. limit=800 hours = 100 funding periods
      const url = `https://www.okx.com/api/v5/public/funding-rate-history?instId=${inst}&limit=100`;
      const r = await fetch(url, FETCH_OPTS);
      if (r.ok) {
        const j = await r.json();
        const arr = j?.data;
        if (Array.isArray(arr) && arr.length > 0) {
          // OKX returns newest-first. Each entry: { fundingTime, realizedRate, fundingRate, ... }
          // Forward-fill to hourly: each funding rate applies to the 8h preceding it
          const fundings = arr
            .map(x => ({ t: parseInt(x.fundingTime), c: parseFloat(x.realizedRate || x.fundingRate) }))
            .filter(b => isFinite(b.c))
            .sort((a, b) => a.t - b.t);
          if (fundings.length > 0) {
            // Build hourly forward-fill array spanning [first.t-7h, last.t]
            const hourlyBars = [];
            for (let i = 0; i < fundings.length; i++) {
              const f = fundings[i];
              // Funding applies to the 8h ending at f.t. Build hourly bars at hours
              // f.t-7h, f.t-6h, ..., f.t, all with same value.
              for (let h = -7; h <= 0; h++) {
                hourlyBars.push({ t: f.t + h * 3600000, c: f.c });
              }
            }
            // Sort + dedupe by timestamp
            hourlyBars.sort((a, b) => a.t - b.t);
            const dedup = [];
            let lastT = -1;
            for (const b of hourlyBars) {
              if (b.t !== lastT) { dedup.push(b); lastT = b.t; }
            }
            if (dedup.length > 0) {
              _premiumCache.set(symbol, { bars: dedup, ts: Date.now() });
              return dedup;
            }
          }
        }
      }
    }
  } catch (_) {}

  // 3. Bybit — premiumIndex kline (linear perp, similar to Binance)
  try {
    const url = `https://api.bybit.com/v5/market/premium-index-price-kline?category=linear&symbol=${symbol}&interval=60&limit=${Math.min(limit, 1000)}`;
    const r = await fetch(url, FETCH_OPTS);
    if (r.ok) {
      const j = await r.json();
      const list = j?.result?.list;
      if (Array.isArray(list) && list.length > 0) {
        // Bybit returns newest-first
        const bars = list
          .map(k => ({ t: parseInt(k[0]), c: parseFloat(k[4]) }))
          .filter(b => isFinite(b.c))
          .reverse();
        if (bars.length > 0) {
          _premiumCache.set(symbol, { bars, ts: Date.now() });
          return bars;
        }
      }
    }
  } catch (_) {}

  // 4. Bybit funding-rate history (last resort, also 8h granularity)
  try {
    const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=200`;
    const r = await fetch(url, FETCH_OPTS);
    if (r.ok) {
      const j = await r.json();
      const list = j?.result?.list;
      if (Array.isArray(list) && list.length > 0) {
        const fundings = list
          .map(x => ({ t: parseInt(x.fundingRateTimestamp), c: parseFloat(x.fundingRate) }))
          .filter(b => isFinite(b.c))
          .sort((a, b) => a.t - b.t);
        if (fundings.length > 0) {
          const hourlyBars = [];
          for (const f of fundings) {
            for (let h = -7; h <= 0; h++) {
              hourlyBars.push({ t: f.t + h * 3600000, c: f.c });
            }
          }
          hourlyBars.sort((a, b) => a.t - b.t);
          const dedup = [];
          let lastT = -1;
          for (const b of hourlyBars) {
            if (b.t !== lastT) { dedup.push(b); lastT = b.t; }
          }
          if (dedup.length > 0) {
            _premiumCache.set(symbol, { bars: dedup, ts: Date.now() });
            return dedup;
          }
        }
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Align a funding-source series (typed { t, c }[] in chronological order) to a target
 * bars1h array, returning a Float64Array of the same length as bars1h. For each target
 * bar, finds the funding value with timestamp <= bar.t and uses it (forward-fill).
 *
 * Returns null if too few funding values matched (less than 60% coverage).
 */
function alignFundingToBars(bars1h, fundingBars) {
  if (!Array.isArray(bars1h) || bars1h.length === 0) return null;
  if (!Array.isArray(fundingBars) || fundingBars.length === 0) return null;

  const out = new Float64Array(bars1h.length);
  let j = 0;
  let lastVal = NaN;
  let matched = 0;

  for (let i = 0; i < bars1h.length; i++) {
    const targetT = bars1h[i].t;
    while (j < fundingBars.length && fundingBars[j].t <= targetT) {
      lastVal = fundingBars[j].c;
      j++;
    }
    if (isFinite(lastVal)) {
      out[i] = lastVal;
      matched++;
    } else {
      out[i] = NaN;
    }
  }

  if (matched < bars1h.length * 0.6) return null;
  return out;
}

/**
 * Drop in-memory cache (admin/diag). Forces full refetch on next scan.
 */
function clearPremiumCache() { _premiumCache.clear(); }

function getPremiumCacheStats() {
  const stats = [];
  for (const [sym, v] of _premiumCache.entries()) {
    stats.push({ symbol: sym, bars: v.bars?.length || 0, ageMs: Date.now() - v.ts });
  }
  return stats;
}

module.exports = {
  fetchPremiumIndex1h,
  alignFundingToBars,
  clearPremiumCache,
  getPremiumCacheStats
};
