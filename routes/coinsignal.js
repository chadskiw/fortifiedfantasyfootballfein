// routes/coinsignal.js — full working version
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

module.exports = function coinsignalRouter({ pool }) {
  const router = express.Router();
  router.use(express.json());

  const ALLOWED = new Set([60, 300, 900, 3600, 21600, 86400]);
  const _cache = new Map();

  // ─── Helpers ─────────────────────────────────────────────
  function getCache(key, ttlMs) {
    const v = _cache.get(key);
    return v && (Date.now() - v.ts < ttlMs) ? v.data : null;
  }
  function setCache(key, data) { _cache.set(key, { ts: Date.now(), data }); }

  function downsample(arr, factor) {
    if (factor <= 1) return arr;
    const out = [];
    for (let i = factor - 1; i < arr.length; i += factor) out.push(arr[i]);
    return out.length ? out : [arr.at(-1)];
  }

  async function fetchCoinbaseCandles(productId, granularity) {
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(productId)}/candles?granularity=${granularity}`;
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'ff-coinsignal/1.0' } });
    const raw = await r.text();
    let rows;
    try { rows = JSON.parse(raw); } catch { throw new Error(`Bad JSON: ${raw.slice(0,100)}`); }
    if (!Array.isArray(rows)) throw new Error(`Unexpected shape: ${JSON.stringify(rows)}`);
    const asc = rows.slice().reverse().map(([t, low, high, open, close, vol]) => ({
      ts: new Date(t * 1000).toISOString(),
      open, high, low, close, volume: vol
    }));
    return asc;
  }

  async function upsertCandles({ symbol, granularity, ascCandles }) {
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

  // ─── Watchlist persistence ───────────────────────────────
  async function ensureWatchlistTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cs_watchlist (
        symbol text PRIMARY KEY,
        first_seen timestamptz NOT NULL DEFAULT now(),
        last_seen  timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
      );
    `);
  }
  ensureWatchlistTable().catch(e => console.error('[watchlist/init]', e));

  async function registerSymbol(symbol, ttlMinutes = 30*24*60) {
    await pool.query(`
      INSERT INTO cs_watchlist(symbol, last_seen, expires_at)
      VALUES ($1, now(), now() + ($2 || ' minutes')::interval)
      ON CONFLICT (symbol) DO UPDATE
        SET last_seen = EXCLUDED.last_seen,
            expires_at = EXCLUDED.expires_at;
    `, [symbol, String(ttlMinutes)]);
  }

  const DEFAULTS = ['BTC-USD','ETH-USD','SOL-USD','ADA-USD','AVAX-USD','XRP-USD','LTC-USD','LINK-USD','DOGE-USD','ATOM-USD'];
  async function symbolsToTrack(limit = 10) {
    const { rows } = await pool.query(`
      SELECT symbol
      FROM cs_watchlist
      WHERE expires_at > now()
      ORDER BY last_seen DESC
      LIMIT $1
    `, [limit]);
    const set = new Set(rows.map(r => r.symbol));
    for (const d of DEFAULTS) { if (set.size >= limit) break; set.add(d); }
    return Array.from(set).slice(0, limit);
  }

  router.post('/watch', async (req, res) => {
    try {
      const sym = String(req.body?.symbol || '').toUpperCase();
      if (!/^[A-Z0-9\-]{3,15}$/.test(sym)) return res.status(400).json({ ok:false, error:'bad_symbol' });
      await registerSymbol(sym);
      res.json({ ok:true, symbol:sym });
    } catch (e) {
      console.error('[watch]', e);
      res.status(500).json({ ok:false, error:'watch_failed' });
    }
  });
  router.get('/watch', async (_req, res) => {
    try { res.json({ ok:true, symbols: await symbolsToTrack(10) }); }
    catch (e) { res.status(500).json({ ok:false, error:'watch_list_failed' }); }
  });

  // ─── Signal / TA helpers ─────────────────────────────────
  function emaArr(a, p){ const k=2/(p+1); let e=a[0]; const out=[e]; for(let i=1;i<a.length;i++){ e=a[i]*k+e*(1-k); out.push(e);} return out; }
  function rsiArr(a, n=14){
    if (a.length<n+1) return Array(a.length).fill(50);
    let g=0,l=0; for(let i=1;i<=n;i++){ const d=a[i]-a[i-1]; if(d>=0)g+=d; else l-=d; }
    let AG=g/n, AL=l/n; const out=Array(a.length).fill(50);
    for(let i=n;i<a.length;i++){ const d=a[i]-a[i-1]; const G=Math.max(0,d), L=Math.max(0,-d);
      AG=(AG*(n-1)+G)/n; AL=(AL*(n-1)+L)/n; const rs=AL===0?100:AG/AL; out[i]=100-100/(1+rs); }
    return out;
  }
  function macdArr(a, f=12, s=26, sig=9){
    const F=emaArr(a,f), S=emaArr(a,s);
    const M=F.map((v,i)=>v-(S[i]??v)); const SL=emaArr(M,sig); const H=M.map((v,i)=>v-(SL[i]??0));
    return { macd:M, signal:SL, hist:H };
  }

  function modelRecommend(closes){
    const e20=emaArr(closes,20), e50=emaArr(closes,50);
    const rsi=rsiArr(closes,14).at(-1);
    const macd=macdArr(closes); const hist=macd.hist.at(-1);
    let rec='HOLD', conf=60, reason='neutral';
    if (rsi<=30 && e20.at(-1)>e50.at(-1) && hist>0){ rec='BUY'; conf=75; reason='oversold + ema up + macd+'; }
    else if (rsi>=70 && hist<0){ rec='SELL'; conf=75; reason='overbought + macd-'; }
    return { rec, conf, reason };
  }

  async function insertSignal({ symbol, timeframe, rec, confidence, price, reason, activeSince }) {
    await pool.query(`
      INSERT INTO cs_signal (symbol, timeframe, ts, rec, confidence, price, reason, active_since)
      VALUES ($1,$2,now(),$3,$4,$5,$6,$7)
      ON CONFLICT (symbol, timeframe, ts) DO NOTHING;
    `, [symbol, timeframe, rec, confidence, price, reason, new Date(activeSince).toISOString()]);
  }

  const lastRec = new Map();
  async function recordSignalIfNeeded({ symbol, timeframe, closes }) {
    if (!closes?.length) return;
    const price = closes.at(-1);
    const { rec, conf, reason } = modelRecommend(closes);
    const key = `${symbol}|${timeframe}`;
    const prev = lastRec.get(key) || {};
    const elapsed = Date.now() - (prev.ts || 0);
    const changed = !prev.rec || prev.rec !== rec;
    const shouldSnapshot = elapsed > 10 * 60 * 1000;

    if (changed || shouldSnapshot) {
      await insertSignal({
        symbol, timeframe, rec, confidence: conf, price, reason,
        activeSince: changed ? Date.now() : (prev.activeSince || Date.now())
      });
      lastRec.set(key, { rec, ts: Date.now(), activeSince: changed ? Date.now() : (prev.activeSince || Date.now()) });
    }
  }

  // ─── Orderbook helpers ───────────────────────────────────
  async function insertOrderbookBand({ symbol, mid, bid5, ask5, imb }) {
    await pool.query(`
      INSERT INTO cs_orderbook_band (symbol, ts, mid, bid_size_5bps, ask_size_5bps, imbalance)
      VALUES ($1, now(), $2, $3, $4, $5)
      ON CONFLICT (symbol, ts) DO NOTHING;
    `, [symbol, mid, bid5, ask5, imb]);
  }

  async function fetchOrderbookBands(symbol) {
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/book?level=2`;
    const r = await fetch(url, { headers: { Accept:'application/json', 'User-Agent':'ff-coinsignal/1.0' }});
    const ob = await r.json();
    if (!Array.isArray(ob?.bids) || !Array.isArray(ob?.asks)) return null;
    const top = 15;
    const bids = ob.bids.slice(0, top).map(([px, sz]) => ({ px:+px, sz:+sz }));
    const asks = ob.asks.slice(0, top).map(([px, sz]) => ({ px:+px, sz:+sz }));
    const bestBid = bids[0]?.px, bestAsk = asks[0]?.px, mid = (bestBid + bestAsk) / 2;
    const cum = arr => arr.reduce((a,x)=> (a.push({px:x.px, cum:(a.at(-1)?.cum||0)+x.sz}), a), []);
    const bid5 = cum(bids).filter(x => (mid - x.px) / mid <= 0.0005).at(-1)?.cum || 0;
    const ask5 = cum(asks).filter(x => (x.px - mid) / mid <= 0.0005).at(-1)?.cum || 0;
    const imb  = (bid5 - ask5) / Math.max(1e-9, bid5 + ask5);
    return { mid, bid5, ask5, imb };
  }

  // ─── Background workers ──────────────────────────────────
  const TF = [{ name:'15m', gran:900 }, { name:'1h', gran:3600 }, { name:'4h', gran:14400 }];

  // Every 30 s — orderbook bands
  setInterval(async () => {
    try {
      const list = await symbolsToTrack(10);
      for (const sym of list) {
        try {
          const bands = await fetchOrderbookBands(sym);
          if (bands) await insertOrderbookBand({ symbol: sym, ...bands });
        } catch (e) { console.warn('[ob]', sym, e.message); }
      }
    } catch (e) { console.error('[worker/ob]', e); }
  }, 30_000);

  // Every 5 m — analyze + record signals
  setInterval(async () => {
    try {
      const list = await symbolsToTrack(10);
      for (const sym of list) {
        for (const { name, gran } of TF) {
          try {
            const upstreamGran = (gran === 14400 ? 3600 : gran);
            const factor = (gran === 14400 ? 4 : 1);
            const asc = await fetchCoinbaseCandles(sym, upstreamGran);
            await upsertCandles({ symbol: sym, granularity: upstreamGran, ascCandles: asc });
            let closes = asc.map(c => +c.close);
            if (factor > 1) closes = downsample(closes, factor);
            await recordSignalIfNeeded({ symbol: sym, timeframe: name, closes });
          } catch (e) { console.error('[analyze]', sym, e.message); }
        }
      }
    } catch (e) { console.error('[worker/signal]', e); }
  }, 5 * 60 * 1000);

  // ─── Routes ───────────────────────────────────────────────
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
        await upsertCandles({ symbol: productId, granularity: upstreamGran, ascCandles: asc });
      }

      let closes = asc.map(c => +c.close);
      if (factor > 1) closes = downsample(closes, factor);
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
router.get('/signals', async (req, res) => {
  try {
    const { symbol, timeframe = '1h', since = '7d' } = req.query;
    if (!symbol) return res.status(400).json({ ok: false, error: 'missing_symbol' });

    const m = /^(\d+)\s*(m|h|d|w)?$/i.exec(since);
    const num = m ? Number(m[1]) : 7;
    const unit = (m ? m[2] : 'd')?.toLowerCase() || 'd';
    const multiplier =
      unit === 'm' ? 'minutes' :
      unit === 'h' ? 'hours'   :
      unit === 'w' ? 'weeks'   : 'days';

    let q, params;

    if (timeframe === 'ensemble') {
      // 👇 Combine all available timeframes
      q = `
        SELECT symbol, timeframe, ts, rec, confidence, price, reason, active_since
        FROM cs_signal
        WHERE symbol = $1
          AND ts >= NOW() - INTERVAL '${num} ${multiplier}'
        ORDER BY ts ASC;
      `;
      params = [symbol];
    } else {
      q = `
        SELECT symbol, timeframe, ts, rec, confidence, price, reason, active_since
        FROM cs_signal
        WHERE symbol = $1
          AND timeframe = $2
          AND ts >= NOW() - INTERVAL '${num} ${multiplier}'
        ORDER BY ts ASC;
      `;
      params = [symbol, timeframe];
    }

    const { rows } = await pool.query(q, params);

    if (!rows.length) return res.json({ ok: false, soft: true, error: 'not_found' });
    return res.json({ ok: true, rows });
  } catch (err) {
    console.error('[coinsignal] /signals error', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});
  router.get('/api/coinsignal/latest', async (req, res) => {
    try {
      const timeframe = (req.query.timeframe || '1h').trim();
      const symbols   = (req.query.symbols || '').trim();

      let rows;
      if (symbols) {
        const list = symbols.split(',').map(s => s.trim()).filter(Boolean);
        rows = await db.any(
          `SELECT * FROM cs_signal_latest
           WHERE timeframe = $1 AND symbol = ANY($2::text[])
           ORDER BY symbol ASC`,
          [timeframe, list]
        );
      } else {
        rows = await db.any(
          `SELECT * FROM cs_signal_latest
           WHERE timeframe = $1
           ORDER BY symbol ASC`,
          [timeframe]
        );
      }

      res.json({ ok:true, timeframe, rows });
    } catch (e) {
      console.error('[coinsignal/latest]', e);
      res.status(500).json({ ok:false, error:'latest_failed' });
    }
  });

  // (Optional) holdstats endpoint
  router.get('/api/coinsignal/holdstats', async (req, res) => {
    try {
      const rows = await db.any(`SELECT * FROM cs_signal_holdstats`);
      res.json({ ok:true, rows });
    } catch (e) {
      console.error('[coinsignal/holdstats]', e);
      res.status(500).json({ ok:false, error:'holdstats_failed' });
    }
  });
  router.get('/ping', (_req, res) => res.json({ ok:true, ts:new Date().toISOString() }));
  return router;
};
