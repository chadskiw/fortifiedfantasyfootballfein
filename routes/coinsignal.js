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
