// routes/coinsignal.js
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args)); // safe for CJS

module.exports = function coinsignalRouter({ pool }) {
  const router = express.Router();
  router.use(express.json());

  const ALLOWED = new Set([60, 300, 900, 3600, 21600, 86400]);
  const _cache = new Map();

  function getCache(key, ttlMs) {
    const v = _cache.get(key);
    return v && (Date.now() - v.ts < ttlMs) ? v.data : null;
  }
  function setCache(key, data) { _cache.set(key, { ts: Date.now(), data }); }

  function downsampleCloses(closes, factor) {
    if (factor <= 1) return closes;
    const out = [];
    for (let i = factor - 1; i < closes.length; i += factor) out.push(closes[i]);
    return out.length ? out : [closes.at(-1)];
  }

  async function fetchCoinbaseCandles(productId, granularity) {
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(productId)}/candles?granularity=${granularity}`;
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'ff-coinsignal/1.0' }
    });
    const raw = await r.text();
    let rows;
    try { rows = JSON.parse(raw); } catch { throw new Error(`Bad JSON: ${raw.slice(0,100)}`); }
    if (!Array.isArray(rows)) throw new Error(`Unexpected shape: ${JSON.stringify(rows)}`);
    const asc = rows.slice().reverse().map(([t, low, high, open, close, vol]) => ({
      ts: new Date(t * 1000).toISOString(), open, high, low, close, volume: vol
    }));
    return asc;
  }

  async function upsertCandles(pool, { symbol, granularity, ascCandles }) {
    if (!ascCandles?.length) return;
    const payload = JSON.stringify(
      ascCandles.map(c => ({
        symbol, granularity, ts: c.ts,
        open:+c.open, high:+c.high, low:+c.low, close:+c.close, volume:+c.volume
      }))
    );
    const sql = `
      INSERT INTO cs_candle (symbol, granularity, ts, open, high, low, close, volume)
      SELECT symbol, granularity, ts, open, high, low, close, volume
      FROM jsonb_to_recordset($1::jsonb)
        AS x(symbol text, granularity int, ts timestamptz,
             open numeric, high numeric, low numeric, close numeric, volume numeric)
      ON CONFLICT (symbol, granularity, ts) DO UPDATE
        SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
            close=EXCLUDED.close, volume=EXCLUDED.volume;
    `;
    await pool.query(sql, [payload]);
  }
// every 30s per symbol
const SYMBOLS = ['BTC-USD','ETH-USD','SOL-USD'];
setInterval(async ()=> {
  for (const sym of SYMBOLS) {
    try {
      const r = await fetch(`${HOST}/api/coinsignal/orderbook?productId=${encodeURIComponent(sym)}`);
      const j = await r.json();
      if (!j?.mid) continue;
      // compute bid5/ask5/imb if not already returned (yours returns bands), then:
      await pool.query(
        `INSERT INTO cs_orderbook_band (symbol, ts, mid, bid_size_5bps, ask_size_5bps, imbalance)
         VALUES ($1, now(), $2, $3, $4, $5) ON CONFLICT (symbol, ts) DO NOTHING`,
        [sym, j.mid, j.bands.bidSize5bps, j.bands.askSize5bps, j.bands.imbalance]
      );
    } catch(e){ console.warn('[ob]', sym, e.message); }
  }
}, 30_000);
const TIMEFRAMES = [{tf:'15m', gran:900}, {tf:'1h', gran:3600}, {tf:'4h', gran:14400}];

// pseudo "analysis" function (replace with your real model)
function getRecommendation({ ema, rsi, macd }) {
  if (rsi < 30 && ema.e20 > ema.e50 && macd.hist > 0) return { rec: 'BUY', conf: 85, reason: 'bullish momentum' };
  if (rsi > 70 && macd.hist < 0) return { rec: 'SELL', conf: 80, reason: 'overbought / weakening' };
  return { rec: 'HOLD', conf: 60, reason: 'neutral' };
}

async function analyzeAndRecord(pool) {
  for (const sym of SYMBOLS) {
    for (const { tf, gran } of TIMEFRAMES) {
      try {
        const ind = await (await fetch(`${HOST}/api/coinsignal/indicators?productId=${sym}&granularity=${gran}`)).json();
        const { rec, conf, reason } = getRecommendation(ind);
        await recordSignal(sym, tf, rec, ind.latest, reason, Date.now());
      } catch (e) {
        console.error('[analyze]', sym, tf, e.message);
      }
    }
  }
}

// run every 5 minutes
setInterval(() => analyzeAndRecord(pool), 5 * 60 * 1000);

  // ---------- routes ----------
  router.get('/candles', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const productId = String(req.query.productId || 'BTC-USD').toUpperCase();
      let gran = Number(req.query.granularity || 3600);

      let upstreamGran = gran, factor = 1;
      if (!ALLOWED.has(gran)) {
        if (gran === 14400) { upstreamGran = 3600; factor = 4; }
        else if (gran === 604800) { upstreamGran = 86400; factor = 7; }
        else { upstreamGran = 3600; factor = Math.max(1, Math.round(gran / 3600)); }
      }

      const ttl = upstreamGran <= 300 ? 10_000 : upstreamGran <= 3600 ? 30_000 : 60_000;
      const key = `${productId}|${upstreamGran}`;
      let asc = getCache(key, ttl);
      if (!asc) {
        asc = await fetchCoinbaseCandles(productId, upstreamGran);
        setCache(key, asc);
        await upsertCandles(pool, { symbol: productId, granularity: upstreamGran, ascCandles: asc });
      }

      let closes = asc.map(c => +c.close);
      if (factor > 1) closes = downsampleCloses(closes, factor);
      res.json({ closes, price: closes.at(-1) });
    } catch (err) {
      console.error('[coinsignal/candles]', err);
      res.status(502).json({ ok:false, error:String(err.message||err) });
    }
  });

  router.get('/candles/history', async (req, res) => {
    try {
      const { symbol='BTC-USD', granularity=3600, since='7d' } = req.query;
      const q = `
        SELECT ts, open, high, low, close, volume
        FROM cs_candle
        WHERE symbol=$1 AND granularity=$2
          AND ts >= now() - ($3)::interval
        ORDER BY ts ASC;
      `;
      const { rows } = await pool.query(q, [symbol, +granularity, String(since)]);
      res.json({ symbol, granularity:+granularity, rows });
    } catch (err) {
      console.error('[coinsignal/candles/history]', err);
      res.status(500).json({ ok:false, error:'history_failed' });
    }
  });

  // lightweight health route
  router.get('/ping', (_req, res) => res.json({ ok:true, ts:new Date().toISOString() }));

  return router;
};
