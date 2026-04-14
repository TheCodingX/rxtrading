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

async function getSymbolInfo(symbol) {
  // Public endpoint — no auth needed
  const info = await binanceRequest('GET', '/fapi/v1/exchangeInfo', {}, 'public', 'public', false);
  const sym = info.symbols.find(s => s.symbol === symbol.toUpperCase());
  if (!sym) throw new Error('Symbol not found: ' + symbol);
  const lotFilter = sym.filters.find(f => f.filterType === 'LOT_SIZE');
  const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
  return {
    symbol: sym.symbol,
    stepSize: parseFloat(lotFilter.stepSize),
    minQty: parseFloat(lotFilter.minQty),
    maxQty: parseFloat(lotFilter.maxQty),
    tickSize: parseFloat(priceFilter.tickSize),
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
    throw new Error(`Position too small for ${symbol}. Minimum: ${symbolInfo.minQty}`);
  }
  // Cap quantity to maxQty (testnet has lower limits than production)
  if (symbolInfo.maxQty && quantity > symbolInfo.maxQty) {
    console.log(`[Broker] ${symbol}: qty ${quantity} > maxQty ${symbolInfo.maxQty}, capping to max`);
    quantity = roundToStep(symbolInfo.maxQty, symbolInfo.stepSize);
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

  // 2. Take Profit (reduce-only stop-market) — uses ADJUSTED price
  // FIX: Use CONTRACT_PRICE (last trade price) instead of MARK_PRICE
  // MARK_PRICE diverges from the actual trading price and causes premature SL hits
  try {
    result.tp = await binanceRequest('POST', '/fapi/v1/order', {
      symbol: symbol.toUpperCase(),
      side: closeSide,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: tpPrice,
      closePosition: 'true',
      workingType: 'CONTRACT_PRICE'
    }, apiKey, apiSecret, true);
  } catch (e) {
    result.tpError = e.message;
  }

  // 3. Stop Loss (reduce-only stop-market) — uses ADJUSTED price
  // FIX: Use CONTRACT_PRICE to match actual trading price (not mark price)
  try {
    result.sl = await binanceRequest('POST', '/fapi/v1/order', {
      symbol: symbol.toUpperCase(),
      side: closeSide,
      type: 'STOP_MARKET',
      stopPrice: slPrice,
      closePosition: 'true',
      workingType: 'CONTRACT_PRICE'
    }, apiKey, apiSecret, true);
  } catch (e) {
    result.slError = e.message;
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
  const results = [];
  for (const pos of open) {
    try {
      const r = await closePosition(apiKey, apiSecret, pos.symbol);
      results.push({ symbol: pos.symbol, ok: true, order: r });
    } catch (e) {
      results.push({ symbol: pos.symbol, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = {
  initMasterKey,
  encrypt,
  decrypt,
  testConnection,
  getAccountInfo,
  setLeverage,
  placeTradeWithTPSL,
  cancelAllOrders,
  closePosition,
  closeAllPositions
};
