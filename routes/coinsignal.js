// routes/coinsignal.js
const express = require('express');

module.exports = function coinsignalRouter({ pool }) {
  const router = express.Router();
  router.use(express.json());

  // ---------- helpers ----------
  const ALLOWED = new Set([60, 300, 900, 3600, 21600, 86400]); // 1m,5m,15m,1h,6h,1d
  const cache = new Map(); // key -> { ts, data }
  const getCache = (k, ttl) => {
    const v = cache.get(k);
    return v && (Date.now() - v.ts < ttl) ? v.data : null;
  };
  const setCache = (k, data) => cache.set(k, { ts: Date.now(), data });

  function downsample(arr, factor) {
    if (factor <= 1) return arr;
    const out = [];
    for (let i = factor - 1; i < arr.length; i += factor) out.push(arr[i]);
    return out.length ? out : [arr.at(-1)];
  }

  async function fetchCoinbaseCandles(productId, upstreamGran) {
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(productId)}/candles?granularity=${upstreamGran}`;
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'ff-coinsignal/1.0' } });
    const raw = await r.text();
    let rows;
    try { rows = JSON.parse(raw); } catch { throw new Error(`Upstream ${r.status} non-JSON: ${raw.slice(0,120)}`); }
    if (!r.ok) throw new Error(rows?.message ? `Coinbase error: ${rows.message}` : `Upstream status=${r.status}`);
    if (!Array.isArray(rows)) throw new Error(`Unexpected upstream shape: ${JSON.stringify(rows).slice(0,200)}`);

    // newest→oldest -> oldest→newest  [time, low, high, open, close, volume]
    const asc = rows.slice().reverse().map(([t, low, high, open, close, volume]) => ({
      ts: new Date(t * 1000).toISOString(),
      open, high, low, close, volume
    }));
    return asc;
  }

  async function upsertCandles({ symbol, granularity, ascCandles }) {
    if (!ascCandles?.length) return;
    const payload = JSON.stringify(
      ascCandles.map(c => ({
        symbol, granularity,
        ts: c.ts,
        open: +c.open, high: +c.high, low: +c.low, close: +c.close, volume: +c.volume
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

  // simple TA
  const ema = (arr, p) => {
    if (!arr?.length) return [];
    const k = 2 / (p + 1);
    let e = arr[0];
    const out = [e];
    for (let i = 1; i < arr.length; i++) { e = arr[i] * k + e * (1 - k); out.push(e); }
    return out;
  };
  const rsi = (arr, n=14) => {
    if ((arr?.length||0) < n+1) return Array(arr?.length||0).fill(50);
    let gains=0, losses=0;
    for (let i=1;i<=n;i++){ const d=arr[i]-arr[i-1]; if (d>=0) gains+=d; else losses-=d; }
    const out = Array(arr.length).fill(50);
    let avgG=gains/n, avgL=losses/n;
    for (let i=n;i<arr.length;i++){
      const d=arr[i]-arr[i-1];
      const g=Math.max(0,d), l=Math.max(0,-d);
      avgG=(avgG*(n-1)+g)/n; avgL=(avgL*(n-1)+l)/n;
      const rs = avgL===0 ? 100 : avgG/avgL;
      out[i] = 100 - 100/(1+rs);
    }
    return out;
  };
  const macdCalc = (arr, fast=12, slow=26, sig=9) => {
    const f = ema(arr, fast); const s = ema(arr, slow);
    const m = f.map((v,i)=> v - (s[i] ?? v));
    const sl = ema(m, sig);
    const h = m.map((v,i)=> v - (sl[i] ?? 0));
    return { macd: m, signal: sl, hist: h };
  };
  const sma = (arr, n) => arr.map((_,i)=> i+1<n ? null : arr.slice(i+1-n, i+1).reduce((a,b)=>a+b,0)/n);

  // ---------- routes ----------

  // GET /api/coinsignal/candles?productId=BTC-USD&granularity=3600
  router.get('/candles', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, no-transform');
      const productId = String(req.query.productId || 'BTC-USD').toUpperCase();
      let granularity = Number(req.query.granularity || 3600);

      let upstreamGran = granularity;
      let factor = 1;
      if (!ALLOWED.has(granularity)) {
        if (granularity === 14400) { upstreamGran = 3600; factor = 4; }
        else if (granularity === 604800) { upstreamGran = 86400; factor = 7; }
        else { upstreamGran = 3600; factor = Math.max(1, Math.round(granularity/3600)); }
      }

      const ttlMs = upstreamGran <= 300 ? 10_000 : upstreamGran <= 3600 ? 30_000 : 60_000;
      const key = `${productId}|${upstreamGran}`;
      let asc = getCache(key, ttlMs);
      if (!asc) {
        asc = await fetchCoinbaseCandles(productId, upstreamGran);
        setCache(key, asc);
        // persist raw upstream granularity
        await upsertCandles({ symbol: productId, granularity: upstreamGran, ascCandles: asc });
      }

      // API returns closes only (UI uses this shape)
      let closes = asc.map(c => +c.close);
      if (factor > 1) closes = downsample(closes, factor);

      res.json({ closes, price: closes.at(-1) });
    } catch (err) {
      console.error('[coinsignal/candles]', err.message || err);
      res.status(502).json({ ok:false, error:String(err?.message || err) });
    }
  });

  // GET /api/coinsignal/candles/history?symbol=BTC-USD&granularity=3600&since=7d
  router.get('/candles/history', async (req, res) => {
    try {
      const { symbol='BTC-USD', granularity=3600, since='7d' } = req.query;
      const sql = `
        SELECT ts, open, high, low, close, volume
        FROM cs_candle
        WHERE symbol=$1 AND granularity=$2
          AND ts >= now() - ($3)::interval
        ORDER BY ts ASC
      `;
      const { rows } = await pool.query(sql, [symbol, +granularity, String(since)]);
      res.json({ symbol, granularity:+granularity, rows });
    } catch (err) {
      console.error('[coinsignal/candles/history]', err);
      res.status(500).json({ ok:false, error:'history_failed' });
    }
  });

  // GET /api/coinsignal/indicators?productId=BTC-USD&granularity=3600
  router.get('/indicators', async (req, res) => {
    try {
      const { productId='BTC-USD', granularity='3600' } = req.query;
      // Reuse the /candles path internally (use upstream gran mapping from that handler)
      const g = Number(granularity);
      const r = await fetch(`${req.protocol}://${req.get('host')}/api/coinsignal/candles?productId=${encodeURIComponent(productId)}&granularity=${g}`);
      const j = await r.json();
      if (!Array.isArray(j.closes)) return res.status(502).json({ ok:false, error: j.error || 'no_closes' });

      const closes = j.closes.map(Number);
      const ema20  = ema(closes, 20);
      const ema50  = ema(closes, 50);
      const ema200 = ema(closes, 200);
      const rsi14  = rsi(closes, 14);
      const macd   = macdCalc(closes, 12, 26, 9);
      const volumes = []; // optional: populate from DB if needed
      const volAvg = sma(volumes.length ? volumes : Array(closes.length).fill(0), 20);

      res.json({
        productId, granularity: g,
        latest: closes.at(-1),
        ema: { e20: ema20.at(-1), e50: ema50.at(-1), e200: ema200.at(-1) },
        rsi: rsi14.at(-1),
        macd: { macd: macd.macd.at(-1), signal: macd.signal.at(-1), hist: macd.hist.at(-1) },
        volume: { last: volumes.at(-1) || 0, avg20: volAvg.at(-1) || 0 }
      });
    } catch (err) {
      console.error('[coinsignal/indicators]', err);
      res.status(500).json({ ok:false, error:'indicators_failed' });
    }
  });

  // GET /api/coinsignal/orderbook?productId=BTC-USD
  router.get('/orderbook', async (req, res) => {
    try {
      const { productId='BTC-USD' } = req.query;
      const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(productId)}/book?level=2`;
      const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'ff-coinsignal/1.0' }});
      const ob = await r.json();
      if (!Array.isArray(ob?.bids) || !Array.isArray(ob?.asks)) return res.status(502).json({ ok:false, error:'bad_orderbook' });

      const top = 15;
      const bids = ob.bids.slice(0, top).map(([px, sz]) => ({ px:+px, sz:+sz }));
      const asks = ob.asks.slice(0, top).map(([px, sz]) => ({ px:+px, sz:+sz }));
      const bestBid = bids[0]?.px, bestAsk = asks[0]?.px, mid = (bestBid + bestAsk) / 2;
      const cum = arr => arr.reduce((a,x)=> (a.push({px:x.px, cum:(a.at(-1)?.cum||0)+x.sz}), a), []);
      const cumBids = cum(bids), cumAsks = cum(asks);
      const bid5 = cumBids.filter(x => (mid - x.px) / mid <= 0.0005).at(-1)?.cum || 0;
      const ask5 = cumAsks.filter(x => (x.px - mid) / mid <= 0.0005).at(-1)?.cum || 0;
      const imbalance = (bid5 - ask5) / Math.max(1e-9, bid5 + ask5);

      res.json({ productId, bestBid, bestAsk, mid, bids, asks, bands: { bidSize5bps: bid5, askSize5bps: ask5, imbalance } });
    } catch (err) {
      console.error('[coinsignal/orderbook]', err);
      res.status(500).json({ ok:false, error:'orderbook_failed' });
    }
  });

  // GET /api/coinsignal/signals?symbol=BTC-USD&timeframe=ensemble&since=7d
  router.get('/signals', async (req, res) => {
    try {
      const { symbol='BTC-USD', timeframe='ensemble', since='7d' } = req.query;
      const sql = `
        SELECT ts, rec, confidence, price, reason, active_since
        FROM cs_signal
        WHERE symbol=$1 AND timeframe=$2
          AND ts >= now() - ($3)::interval
        ORDER BY ts ASC
      `;
      const { rows } = await pool.query(sql, [symbol, String(timeframe), String(since)]);
      res.json({ symbol, timeframe, rows });
    } catch (err) {
      console.error('[coinsignal/signals]', err);
      res.status(500).json({ ok:false, error:'signals_failed' });
    }
  });

  return router;
};
