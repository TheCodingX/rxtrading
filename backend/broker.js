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

function binanceRequest(method, path, params, apiKey, apiSecret, isSigned = true) {
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
            reject(new Error(parsed.msg || `Binance error ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error('Binance response parse error: ' + data.substring(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Binance request timeout')); });
    req.end();
  });
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

  // Set leverage first (non-fatal if already set)
  try { await setLeverage(apiKey, apiSecret, symbol, leverage); } catch (e) {}

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

  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';

  // 1. Entry market order FIRST — get the ACTUAL fill price
  const entryOrder = await binanceRequest('POST', '/fapi/v1/order', {
    symbol: symbol.toUpperCase(),
    side,
    type: 'MARKET',
    quantity
  }, apiKey, apiSecret, true);

  // Get actual fill price from the entry order
  const actualEntry = parseFloat(entryOrder.avgPrice) || currentPrice;

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

  console.log(`[Broker] ${symbol} ${side}: signal@${currentPrice} → actual@${actualEntry} | TP: ${tp}→${tpPrice} | SL: ${sl}→${slPrice} | R:R preserved`);

  const result = {
    entry: entryOrder,
    actualEntry,
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
      priceProtect: 'true'
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
        reduceOnly: 'true',
        timeInForce: 'GTC',
        workingType: 'CONTRACT_PRICE'
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
      priceProtect: 'true'
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
        workingType: 'CONTRACT_PRICE'
      }, apiKey, apiSecret, true);
    } catch (e2) {
      result.slError = e2.message;
      console.error(`[Broker] SL failed for ${symbol}:`, e.message, '| Fallback:', e2.message);
      // CRITICAL: SL failed — cancel all orders + close position to avoid unprotected exposure
      try {
        await binanceRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: symbol.toUpperCase() }, apiKey, apiSecret, true);
        await binanceRequest('POST', '/fapi/v1/order', {
          symbol: symbol.toUpperCase(),
          side: closeSide,
          type: 'MARKET',
          quantity,
          reduceOnly: 'true'
        }, apiKey, apiSecret, true);
        result.emergencyClosed = true;
      } catch (e3) {
        result.emergencyCloseError = e3.message;
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
async function createListenKey(apiKey) {
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
    const req = https.request({ host: BINANCE_HOST, path: '/fapi/v1/listenKey', method: 'PUT', headers: { 'X-MBX-APIKEY': apiKey } }, (res) => {
      let data = ''; res.on('data', (c) => data += c);
      res.on('end', () => resolve(true));
    });
    req.on('error', reject); req.end();
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
  keepAliveListenKey
};
