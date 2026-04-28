// ══════════════════════════════════════════════════════════
// RX PRO — BROKER INTEGRATION MODULE
// Binance Futures API + AES-256-GCM encryption + HMAC signing
// ══════════════════════════════════════════════════════════

const crypto = require('crypto');
const https = require('https');

// ═══ ENCRYPTION ═══
// AES-256-GCM: authenticated encryption (prevents tampering)
// Master key from env: BROKER_MASTER_KEY (64 hex chars = 32 bytes)

const MASTER_KEY_HEX = process.env.BROKER_MASTER_KEY || '';
let MASTER_KEY = null;

function initMasterKey() {
  if (!MASTER_KEY_HEX || MASTER_KEY_HEX.length !== 64) {
    console.error('\n[BROKER] ERROR: BROKER_MASTER_KEY missing or invalid.');
    console.error('[BROKER] Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    console.error('[BROKER] Then add to .env as BROKER_MASTER_KEY=<that hex string>\n');
    return false;
  }
  MASTER_KEY = Buffer.from(MASTER_KEY_HEX, 'hex');
  return true;
}

function encrypt(plaintext) {
  if (!MASTER_KEY) throw new Error('Master key not initialized');
  const iv = crypto.randomBytes(12); // GCM standard: 12 bytes
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv(12) + authTag(16) + ciphertext (all hex)
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(blob) {
  if (!MASTER_KEY) throw new Error('Master key not initialized');
  const parts = blob.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted blob');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const ciphertext = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// ═══ BINANCE FUTURES API CLIENT ═══
// Use BINANCE_TESTNET=true in env to switch to testnet
const BINANCE_HOST = process.env.BINANCE_TESTNET === 'true'
  ? 'testnet.binancefuture.com'
  : 'fapi.binance.com';

function signQuery(params, secret) {
  const query = Object.keys(params)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
  return query + '&signature=' + signature;
}

function _binanceRequestOnce(method, path, params, apiKey, apiSecret, isSigned = true) {
  return new Promise((resolve, reject) => {
    let query = '';
    if (isSigned) {
      params = { ...params, timestamp: Date.now(), recvWindow: 5000 };
      query = signQuery(params, apiSecret);
    } else {
      query = Object.keys(params)
        .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
        .join('&');
    }

    const options = {
      host: BINANCE_HOST,
      path: path + (query ? '?' + query : ''),
      method,
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const err = new Error(parsed.msg || `Binance error ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.binanceCode = parsed.code;
            reject(err);
          } else {
            resolve(parsed);
          }
        } catch (e) {
          const err = new Error('Binance response parse error: ' + data.substring(0, 200));
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });

    req.on('error', (e) => { e.isNetworkError = true; reject(e); });
    req.on('timeout', () => { req.destroy(); const e = new Error('Binance request timeout'); e.isTimeout = true; reject(e); });
    req.end();
  });
}

// Wrapper with exponential backoff retry for transient errors (429, 503, timeouts)
async function binanceRequest(method, path, params, apiKey, apiSecret, isSigned = true, maxRetries = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await _binanceRequestOnce(method, path, params, apiKey, apiSecret, isSigned);
    } catch (err) {
      lastErr = err;
      const isTransient = err.statusCode === 429 || err.statusCode === 418 || err.statusCode === 503 || err.isTimeout || err.isNetworkError;
      // 4xx client errors (except 429/418) should fail fast
      if (!isTransient) throw err;
      if (attempt === maxRetries - 1) break;
      // Exponential backoff: 500ms, 1.5s, 4s
      const delay = Math.min(4000, 500 * Math.pow(3, attempt));
      console.warn(`[Binance] Transient error (${err.statusCode || err.message}), retry ${attempt+1}/${maxRetries} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ═══ HIGH-LEVEL API FUNCTIONS ═══

async function testConnection(apiKey, apiSecret) {
  // Check server time + account info (requires valid key)
  await binanceRequest('GET', '/fapi/v1/time', {}, apiKey, apiSecret, false);
  const account = await binanceRequest('GET', '/fapi/v2/account', {}, apiKey, apiSecret, true);
  return {
    ok: true,
    canTrade: account.canTrade === true,
    totalWalletBalance: parseFloat(account.totalWalletBalance),
    availableBalance: parseFloat(account.availableBalance),
    feeTier: account.feeTier
  };
}

async function getAccountInfo(apiKey, apiSecret) {
  const account = await binanceRequest('GET', '/fapi/v2/account', {}, apiKey, apiSecret, true);
  return {
    totalWalletBalance: parseFloat(account.totalWalletBalance),
    availableBalance: parseFloat(account.availableBalance),
    totalUnrealizedProfit: parseFloat(account.totalUnrealizedProfit),
    positions: (account.positions || [])
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => ({
        symbol: p.symbol,
        positionAmt: parseFloat(p.positionAmt),
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice || 0),
        unrealizedProfit: parseFloat(p.unrealizedProfit),
        leverage: parseInt(p.leverage)
      }))
  };
}

async function setLeverage(apiKey, apiSecret, symbol, leverage) {
  return binanceRequest('POST', '/fapi/v1/leverage', {
    symbol: symbol.toUpperCase(),
    leverage: parseInt(leverage)
  }, apiKey, apiSecret, true);
}

// Cache exchangeInfo for 10 min to avoid hammering Binance
let _exchangeInfoCache = null;
let _exchangeInfoCacheAt = 0;
async function getExchangeInfoCached() {
  const now = Date.now();
  if (_exchangeInfoCache && (now - _exchangeInfoCacheAt) < 10 * 60 * 1000) return _exchangeInfoCache;
  const info = await binanceRequest('GET', '/fapi/v1/exchangeInfo', {}, 'public', 'public', false);
  _exchangeInfoCache = info;
  _exchangeInfoCacheAt = now;
  return info;
}

// Validate that a set of symbols is actually tradeable on Binance mainnet/testnet
async function validatePairs(symbols) {
  try {
    const info = await getExchangeInfoCached();
    const tradeable = new Set(info.symbols.filter(s => s.status === 'TRADING' && s.contractType === 'PERPETUAL').map(s => s.symbol));
    const valid = [];
    const invalid = [];
    for (const sym of symbols) {
      if (tradeable.has(sym.toUpperCase())) valid.push(sym);
      else invalid.push(sym);
    }
    return { valid, invalid, totalTradeable: tradeable.size };
  } catch (e) {
    return { valid: symbols, invalid: [], error: e.message };
  }
}

async function getSymbolInfo(symbol) {
  const info = await getExchangeInfoCached();
  const sym = info.symbols.find(s => s.symbol === symbol.toUpperCase());
  if (!sym) throw new Error('Symbol not found or not tradeable on current Binance host: ' + symbol);
  if (sym.status !== 'TRADING') throw new Error(`Symbol ${symbol} is not in TRADING state (status: ${sym.status})`);
  const lotFilter = sym.filters.find(f => f.filterType === 'LOT_SIZE');
  const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
  const minNotionalFilter = sym.filters.find(f => f.filterType === 'MIN_NOTIONAL');
  return {
    symbol: sym.symbol,
    stepSize: parseFloat(lotFilter.stepSize),
    minQty: parseFloat(lotFilter.minQty),
    maxQty: parseFloat(lotFilter.maxQty),
    tickSize: parseFloat(priceFilter.tickSize),
    minNotional: minNotionalFilter ? parseFloat(minNotionalFilter.notional) : 5,
    quantityPrecision: sym.quantityPrecision,
    pricePrecision: sym.pricePrecision
  };
}

function roundToStep(value, step) {
  const precision = Math.max(0, -Math.floor(Math.log10(step)));
  return parseFloat((Math.floor(value / step) * step).toFixed(precision));
}

function roundToTick(value, tick) {
  const precision = Math.max(0, -Math.floor(Math.log10(tick)));
  return parseFloat((Math.round(value / tick) * tick).toFixed(precision));
}

// Place a complete trade: entry market order + TP + SL (reduce-only)
async function placeTradeWithTPSL(apiKey, apiSecret, opts) {
  const { symbol, side, usdAmount, leverage, tp, sl, currentPrice } = opts;

  if (!symbol || !side || !usdAmount || !leverage || !tp || !sl || !currentPrice) {
    throw new Error('Missing required trade parameters');
  }
  if (side !== 'BUY' && side !== 'SELL') throw new Error('Invalid side');
  if (usdAmount < 10) throw new Error('Minimum position size: $10');
  if (usdAmount > 10000) throw new Error('Maximum position size: $10,000 (safety limit)');

  const symbolInfo = await getSymbolInfo(symbol);

  // Set leverage — BLOCKING: fail trade if can't set (prevents 5x under-exposure)
  try {
    await setLeverage(apiKey, apiSecret, symbol, leverage);
  } catch (e) {
    // Binance returns code -4046 if leverage is already set to that value (OK)
    if (e.binanceCode !== -4046 && !String(e.message || '').includes('No need to change leverage')) {
      throw new Error(`Cannot set leverage ${leverage}x on ${symbol}: ${e.message}. Trade aborted for safety.`);
    }
  }

  // Detect position mode (One-Way vs Hedge) for correct positionSide param
  let positionMode = 'one-way';
  try {
    const account = await binanceRequest('GET', '/fapi/v2/account', {}, apiKey, apiSecret, true, 2);
    if (account.dualSidePosition === true) positionMode = 'hedge';
  } catch(e) { /* default to one-way if check fails */ }
  const positionSide = positionMode === 'hedge' ? (side === 'BUY' ? 'LONG' : 'SHORT') : undefined;

  // Calculate quantity: usdAmount * leverage / price
  const notional = usdAmount * leverage;
  const rawQty = notional / currentPrice;
  let quantity = roundToStep(rawQty, symbolInfo.stepSize);

  if (quantity < symbolInfo.minQty) {
    throw new Error(`Position too small for ${symbol}. Minimum qty: ${symbolInfo.minQty}`);
  }
  // Cap quantity to maxQty (testnet has lower limits than production)
  if (symbolInfo.maxQty && quantity > symbolInfo.maxQty) {
    console.log(`[Broker] ${symbol}: qty ${quantity} > maxQty ${symbolInfo.maxQty}, capping to max`);
    quantity = roundToStep(symbolInfo.maxQty, symbolInfo.stepSize);
  }
  // CRITICAL: Validate minNotional (Binance rejects orders below this)
  const notionalValue = quantity * currentPrice;
  if (symbolInfo.minNotional && notionalValue < symbolInfo.minNotional) {
    throw new Error(`Notional too small for ${symbol}. Minimum: $${symbolInfo.minNotional} (got $${notionalValue.toFixed(2)})`);
  }
  // CRITICAL: Validate TP/SL direction vs side to prevent Binance rejection
  //   BUY:  entry ~currentPrice, TP > entry, SL < entry
  //   SELL: entry ~currentPrice, TP < entry, SL > entry
  if (side === 'BUY') {
    if (tp <= currentPrice) throw new Error(`Invalid TP for BUY: TP ($${tp}) must be above current price ($${currentPrice})`);
    if (sl >= currentPrice) throw new Error(`Invalid SL for BUY: SL ($${sl}) must be below current price ($${currentPrice})`);
  } else { // SELL
    if (tp >= currentPrice) throw new Error(`Invalid TP for SELL: TP ($${tp}) must be below current price ($${currentPrice})`);
    if (sl <= currentPrice) throw new Error(`Invalid SL for SELL: SL ($${sl}) must be above current price ($${currentPrice})`);
  }
  // Sanity check: reasonable SL distance (prevent SL too close = instant stop, or too far = huge loss)
  const slPct = Math.abs(sl - currentPrice) / currentPrice;
  if (slPct > 0.25) throw new Error(`SL distance too large (${(slPct*100).toFixed(1)}% > 25% cap)`);
  if (slPct < 0.001) throw new Error(`SL distance too small (${(slPct*100).toFixed(3)}% < 0.1% min)`);

  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

  // 2026-04-23 fix 1.1: unique clientOrderId per trade attempt protects against retry duplicates.
  // Binance rejects duplicate clientOrderId → idempotent retry within 24h window.
  // Max 36 chars, alphanumeric + underscore/dash per Binance spec.
  const tradeCorrelationId = `rx_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const entryClientOrderId = `${tradeCorrelationId}_e`.slice(0, 36);
  const tpClientOrderId = `${tradeCorrelationId}_t`.slice(0, 36);
  const slClientOrderId = `${tradeCorrelationId}_s`.slice(0, 36);

  // 2026-04-28: maker-priority entry (slippage minimization)
  // Strategy: try LIMIT GTX (post-only) at favorable side of currentPrice. If fills within
  // MAKER_TIMEOUT_MS, save 0.03% (taker→maker fee delta) + 0.02% slippage = ~0.05% per trade.
  // If not filled (price ran away or post-only rejected), cancel + fall back to MARKET.
  // Controlled by env APEX_MAKER_PRIORITY=1 (default OFF for backward compat).
  const MAKER_PRIORITY_ENABLED = process.env.APEX_MAKER_PRIORITY === '1';
  const MAKER_TIMEOUT_MS = parseInt(process.env.APEX_MAKER_TIMEOUT_MS || '5000', 10);
  const MAKER_OFFSET_TICKS = parseInt(process.env.APEX_MAKER_OFFSET_TICKS || '1', 10);

  let entryOrder = null;
  let entryMode = 'market';
  let makerLimitPrice = null;

  if (MAKER_PRIORITY_ENABLED) {
    try {
      // For BUY: post-only limit at currentPrice - N ticks (sit on the bid side, won't cross)
      // For SELL: post-only limit at currentPrice + N ticks (sit on the ask side, won't cross)
      const tickOffset = symbolInfo.tickSize * MAKER_OFFSET_TICKS;
      makerLimitPrice = side === 'BUY'
        ? roundToTick(currentPrice - tickOffset, symbolInfo.tickSize)
        : roundToTick(currentPrice + tickOffset, symbolInfo.tickSize);

      const makerParams = {
        symbol: symbol.toUpperCase(),
        side,
        type: 'LIMIT',
        timeInForce: 'GTX', // Post-only — rejected if would cross spread
        quantity,
        price: makerLimitPrice,
        newClientOrderId: entryClientOrderId,
        ...(positionSide && { positionSide })
      };
      const makerOrder = await binanceRequest('POST', '/fapi/v1/order', makerParams, apiKey, apiSecret, true);

      // Poll for fill up to MAKER_TIMEOUT_MS
      const pollStart = Date.now();
      let pollOrder = makerOrder;
      while (Date.now() - pollStart < MAKER_TIMEOUT_MS) {
        if (pollOrder.status === 'FILLED') break;
        await new Promise(r => setTimeout(r, 500));
        try {
          pollOrder = await binanceRequest('GET', '/fapi/v1/order', {
            symbol: symbol.toUpperCase(),
            origClientOrderId: entryClientOrderId
          }, apiKey, apiSecret, true, 1);
        } catch (e) { break; }
      }

      if (pollOrder.status === 'FILLED') {
        entryOrder = pollOrder;
        entryMode = 'maker';
        console.log(`[Broker] ${symbol} ${side}: MAKER fill at ${pollOrder.avgPrice} (saved ~0.05% vs market)`);
      } else {
        // Cancel pending limit order
        try {
          await binanceRequest('DELETE', '/fapi/v1/order', {
            symbol: symbol.toUpperCase(),
            origClientOrderId: entryClientOrderId
          }, apiKey, apiSecret, true, 1);
        } catch (e) { /* may already be filled or cancelled */ }
        console.log(`[Broker] ${symbol} ${side}: maker limit not filled in ${MAKER_TIMEOUT_MS}ms (status=${pollOrder.status}), falling back to MARKET`);
      }
    } catch (e) {
      // GTX rejected (would cross) or other error → fall back to market
      const reason = e.binanceCode === -5022 ? 'post_only_would_cross' : e.message?.slice(0, 60);
      console.log(`[Broker] ${symbol} ${side}: maker priority skipped (${reason}), using MARKET`);
    }
  }

  // Fallback: MARKET order (or when maker priority disabled/failed)
  if (!entryOrder) {
    // Use a fresh clientOrderId for the market fallback (different from the limit one)
    const marketClientOrderId = `${tradeCorrelationId}_em`.slice(0, 36);
    const entryParams = {
      symbol: symbol.toUpperCase(),
      side,
      type: 'MARKET',
      quantity,
      newClientOrderId: marketClientOrderId,
      ...(positionSide && { positionSide })
    };
    entryOrder = await binanceRequest('POST', '/fapi/v1/order', entryParams, apiKey, apiSecret, true);
    entryMode = 'market';
  }

  // Validate entry order filled correctly before placing TP/SL
  if (entryOrder.status && !['FILLED', 'NEW'].includes(entryOrder.status)) {
    throw new Error(`Entry order not filled properly: status=${entryOrder.status}. Refusing to place TP/SL.`);
  }
  // Get actual fill price — prefer avgPrice, fallback to price from executedQty calc, finally currentPrice
  let actualEntry = parseFloat(entryOrder.avgPrice);
  if (!actualEntry && entryOrder.executedQty && entryOrder.cumQuote) {
    actualEntry = parseFloat(entryOrder.cumQuote) / parseFloat(entryOrder.executedQty);
  }
  if (!actualEntry) actualEntry = currentPrice;
  // Sanity: if slippage >5% between signal and actual, abort (market likely illiquid or dumped)
  // 2026-04-23 fix 2.9: slippage threshold configurable per-pair.
  // Micro-caps (1000PEPE/SHIB/etc) tienen spreads más anchos, BTC/ETH muy tight.
  // 2026-04-28: tightened slippage caps. With APEX_MAKER_PRIORITY=1 most orders fill at limit
  // (zero slippage). Even market fallback should hit <0.5% on liquid pairs. Old caps (2-7%)
  // were too permissive — accepting trades with -2% slippage erodes the funding edge entirely.
  const SLIPPAGE_PER_PAIR = {
    'BTCUSDT': 0.005, 'ETHUSDT': 0.005, 'BNBUSDT': 0.008,    // blue chips: 0.5-0.8%
    'SOLUSDT': 0.010, 'XRPUSDT': 0.010, 'ADAUSDT': 0.012, 'LINKUSDT': 0.012,
    'ARBUSDT': 0.015, 'POLUSDT': 0.015, 'ATOMUSDT': 0.015, 'NEARUSDT': 0.015, 'SUIUSDT': 0.015, 'TRXUSDT': 0.015, 'INJUSDT': 0.015, 'RENDERUSDT': 0.018,
    '1000PEPEUSDT': 0.025, 'DOGEUSDT': 0.020, 'SHIBUSDT': 0.030 // memecoins: 2-3%
  };
  const maxSlippage = SLIPPAGE_PER_PAIR[symbol.toUpperCase()] || 0.020; // default 2%
  const slippagePct = Math.abs(actualEntry - currentPrice) / currentPrice;
  if (slippagePct > maxSlippage) {
    // Emergency close the position
    try {
      await binanceRequest('POST', '/fapi/v1/order', {
        symbol: symbol.toUpperCase(),
        side: closeSide,
        type: 'MARKET',
        quantity,
        reduceOnly: 'true',
        ...(positionSide && { positionSide })
      }, apiKey, apiSecret, true, 2);
    } catch(e) {}
    throw new Error(`Excessive slippage ${(slippagePct*100).toFixed(2)}% (cap ${(maxSlippage*100).toFixed(1)}% para ${symbol}) — position closed for safety`);
  }

  // ═══ CRITICAL FIX: Recalculate TP/SL relative to ACTUAL entry price ═══
  // This preserves the R:R regardless of entry delay/slippage
  // Original distances: tpDist = |tp - signalPrice|, slDist = |sl - signalPrice|
  const tpDist = Math.abs(tp - currentPrice);
  const slDist = Math.abs(sl - currentPrice);

  let adjustedTP, adjustedSL;
  if (side === 'BUY') {
    adjustedTP = actualEntry + tpDist;  // TP above entry by same distance
    adjustedSL = actualEntry - slDist;  // SL below entry by same distance
  } else {
    adjustedTP = actualEntry - tpDist;  // TP below entry by same distance
    adjustedSL = actualEntry + slDist;  // SL above entry by same distance
  }

  const tpPrice = roundToTick(adjustedTP, symbolInfo.tickSize);
  const slPrice = roundToTick(adjustedSL, symbolInfo.tickSize);

  // Validate against PRICE_FILTER (Binance rejects prices outside minPrice/maxPrice range)
  const info = await getExchangeInfoCached();
  const symObj = info.symbols.find(s => s.symbol === symbol.toUpperCase());
  const priceFilter = symObj && symObj.filters.find(f => f.filterType === 'PRICE_FILTER');
  if (priceFilter) {
    const minP = parseFloat(priceFilter.minPrice);
    const maxP = parseFloat(priceFilter.maxPrice);
    if (minP > 0 && (tpPrice < minP || tpPrice > maxP || slPrice < minP || slPrice > maxP)) {
      // Emergency close entry if TP/SL out of range
      try {
        await binanceRequest('POST', '/fapi/v1/order', {
          symbol: symbol.toUpperCase(), side: closeSide, type: 'MARKET', quantity, reduceOnly: 'true',
          ...(positionSide && { positionSide })
        }, apiKey, apiSecret, true, 2);
      } catch(e){}
      throw new Error(`TP/SL price out of PRICE_FILTER range [${minP}, ${maxP}] — position closed for safety`);
    }
  }

  console.log(`[Broker] ${symbol} ${side}${positionMode==='hedge'?' ['+positionSide+']':''}: signal@${currentPrice} → actual@${actualEntry} | TP: ${tp}→${tpPrice} | SL: ${sl}→${slPrice} | R:R preserved`);

  const result = {
    entry: entryOrder,
    actualEntry,
    entryMode, // 'maker' or 'market' — for slippage tracking + UI display
    makerLimitPrice, // null if went direct market
    tp: null,
    sl: null,
    tpPrice,
    slPrice,
    quantity,
    symbol,
    side
  };

  // 2. Take Profit — use TAKE_PROFIT_MARKET with reduceOnly + quantity (Binance Futures standard)
  // NOTE: closePosition:'true' is NOT supported on all endpoints (causes "Order type not supported")
  // Using reduceOnly+quantity works reliably on both testnet and mainnet
  try {
    result.tp = await binanceRequest('POST', '/fapi/v1/order', {
      symbol: symbol.toUpperCase(),
      side: closeSide,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tpPrice,
      quantity,
      reduceOnly: 'true',
      workingType: 'CONTRACT_PRICE',
      priceProtect: 'true',
      newClientOrderId: tpClientOrderId,
      ...(positionSide && { positionSide })
    }, apiKey, apiSecret, true);
  } catch (e) {
    // Fallback: TAKE_PROFIT limit order with explicit quantity
    try {
      result.tp = await binanceRequest('POST', '/fapi/v1/order', {
        symbol: symbol.toUpperCase(),
        side: closeSide,
        type: 'TAKE_PROFIT',
        stopPrice: tpPrice,
        price: tpPrice,
        quantity,
        newClientOrderId: `${tpClientOrderId}f`.slice(0,36),
        reduceOnly: 'true',
        timeInForce: 'GTC',
        workingType: 'CONTRACT_PRICE',
        ...(positionSide && { positionSide })
      }, apiKey, apiSecret, true);
    } catch (e2) {
      result.tpError = e2.message;
      console.error(`[Broker] TP failed for ${symbol}:`, e.message, '| Fallback:', e2.message);
    }
  }

  // 3. Stop Loss — use STOP_MARKET with reduceOnly + quantity (Binance Futures standard)
  try {
    result.sl = await binanceRequest('POST', '/fapi/v1/order', {
      symbol: symbol.toUpperCase(),
      side: closeSide,
      type: 'STOP_MARKET',
      stopPrice: slPrice,
      quantity,
      reduceOnly: 'true',
      workingType: 'CONTRACT_PRICE',
      priceProtect: 'true',
      newClientOrderId: slClientOrderId,
      ...(positionSide && { positionSide })
    }, apiKey, apiSecret, true);
  } catch (e) {
    // Fallback: STOP limit order with explicit quantity
    try {
      result.sl = await binanceRequest('POST', '/fapi/v1/order', {
        symbol: symbol.toUpperCase(),
        side: closeSide,
        type: 'STOP',
        stopPrice: slPrice,
        price: slPrice,
        quantity,
        reduceOnly: 'true',
        timeInForce: 'GTC',
        workingType: 'CONTRACT_PRICE',
        newClientOrderId: `${slClientOrderId}f`.slice(0,36),
        ...(positionSide && { positionSide })
      }, apiKey, apiSecret, true);
    } catch (e2) {
      result.slError = e2.message;
      console.error(`[Broker] SL failed for ${symbol}:`, e.message, '| Fallback:', e2.message);
      // CRITICAL: SL failed — cancel all orders + close position to avoid unprotected exposure
      // With retry logic: try cancel + market close up to 3 times each
      let emergencyAttempts = 0;
      const emergencyErrors = [];
      while (emergencyAttempts < 3 && !result.emergencyClosed) {
        emergencyAttempts++;
        try {
          await binanceRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: symbol.toUpperCase() }, apiKey, apiSecret, true, 2);
          await binanceRequest('POST', '/fapi/v1/order', {
            symbol: symbol.toUpperCase(),
            side: closeSide,
            type: 'MARKET',
            quantity,
            reduceOnly: 'true'
          }, apiKey, apiSecret, true, 2);
          result.emergencyClosed = true;
          result.emergencyCloseAttempts = emergencyAttempts;
          console.warn(`[Broker] EMERGENCY close succeeded on attempt ${emergencyAttempts} for ${symbol}`);
        } catch (e3) {
          emergencyErrors.push(e3.message);
          if (emergencyAttempts < 3) await new Promise(r => setTimeout(r, 1000 * emergencyAttempts));
        }
      }
      if (!result.emergencyClosed) {
        result.emergencyCloseError = emergencyErrors.join(' | ');
        console.error(`[Broker] CRITICAL: emergency close FAILED for ${symbol} after 3 attempts:`, emergencyErrors);
      }
    }
  }

  return result;
}

async function cancelAllOrders(apiKey, apiSecret, symbol) {
  return binanceRequest('DELETE', '/fapi/v1/allOpenOrders', {
    symbol: symbol.toUpperCase()
  }, apiKey, apiSecret, true);
}

async function closePosition(apiKey, apiSecret, symbol) {
  // Get current position
  const account = await binanceRequest('GET', '/fapi/v2/account', {}, apiKey, apiSecret, true);
  const pos = account.positions.find(p => p.symbol === symbol.toUpperCase() && parseFloat(p.positionAmt) !== 0);
  if (!pos) throw new Error('No open position for ' + symbol);

  const qty = Math.abs(parseFloat(pos.positionAmt));
  const side = parseFloat(pos.positionAmt) > 0 ? 'SELL' : 'BUY';

  // Cancel pending orders first (TP/SL)
  try { await cancelAllOrders(apiKey, apiSecret, symbol); } catch (e) {}

  return binanceRequest('POST', '/fapi/v1/order', {
    symbol: symbol.toUpperCase(),
    side,
    type: 'MARKET',
    quantity: qty,
    reduceOnly: 'true'
  }, apiKey, apiSecret, true);
}

async function closeAllPositions(apiKey, apiSecret) {
  const account = await binanceRequest('GET', '/fapi/v2/account', {}, apiKey, apiSecret, true);
  const open = account.positions.filter(p => parseFloat(p.positionAmt) !== 0);
  // PARALLEL closure for fast panic response — critical in crash scenarios
  // Sort by absolute unrealized loss desc (close biggest losers first)
  open.sort((a, b) => parseFloat(a.unRealizedProfit) - parseFloat(b.unRealizedProfit));
  const results = await Promise.all(open.map(async (pos) => {
    try {
      // Timeout per position: 5s max
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Close timeout 5s')), 5000));
      const closePromise = closePosition(apiKey, apiSecret, pos.symbol);
      const r = await Promise.race([closePromise, timeoutPromise]);
      return { symbol: pos.symbol, ok: true, order: r };
    } catch (e) {
      return { symbol: pos.symbol, ok: false, error: e.message };
    }
  }));
  return results;
}

// listenKey management for userDataStream (real-time balance/position/order push)
async function revokeListenKey(apiKey) {
  const BINANCE_HOST = process.env.BINANCE_TESTNET === 'true' ? 'testnet.binancefuture.com' : 'fapi.binance.com';
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.request({ host: BINANCE_HOST, path: '/fapi/v1/listenKey', method: 'DELETE', headers: { 'X-MBX-APIKEY': apiKey } }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}
async function createListenKey(apiKey) {
  // Revoke any existing listenKey first (prevents accumulating keys in Binance)
  try { await revokeListenKey(apiKey); } catch(e) { /* best-effort */ }
  const BINANCE_HOST = process.env.BINANCE_TESTNET === 'true' ? 'testnet.binancefuture.com' : 'fapi.binance.com';
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request({ host: BINANCE_HOST, path: '/fapi/v1/listenKey', method: 'POST', headers: { 'X-MBX-APIKEY': apiKey } }, (res) => {
      let data = ''; res.on('data', (c) => data += c);
      res.on('end', () => { try { const j = JSON.parse(data); if (j.listenKey) resolve(j.listenKey); else reject(new Error(j.msg || 'no listenKey')); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}
async function keepAliveListenKey(apiKey) {
  const BINANCE_HOST = process.env.BINANCE_TESTNET === 'true' ? 'testnet.binancefuture.com' : 'fapi.binance.com';
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request({ host: BINANCE_HOST, path: '/fapi/v1/listenKey', method: 'PUT', headers: { 'X-MBX-APIKEY': apiKey }, timeout: 10000 }, (res) => {
      let data = ''; res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error(`keepAlive HTTP ${res.statusCode}`));
        else resolve(true);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('keepAlive timeout')); });
    req.end();
  });
}

module.exports = {
  initMasterKey,
  encrypt,
  decrypt,
  testConnection,
  getAccountInfo,
  getExchangeInfoCached,
  validatePairs,
  setLeverage,
  placeTradeWithTPSL,
  cancelAllOrders,
  closePosition,
  closeAllPositions,
  createListenKey,
  keepAliveListenKey,
  revokeListenKey
};
