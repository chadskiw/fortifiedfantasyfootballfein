// server.js — FF Platform Service (fixed root + FEIN static + stable shims)
require('dotenv').config();

console.log('[R2] using bucket =', process.env.R2_BUCKET);
console.log('[R2] endpoint =', process.env.R2_ENDPOINT);

const express       = require('express');
const morgan        = require('morgan');
const cookieParser  = require('cookie-parser');
const path          = require('path');
const espnConnectRouter = require('./routes/espnconnect');

// Routers (only require what you actually have in your repo)
const espnLink          = require('./routes/espn/link');               // <-- new UI route (GET /api/espn/link, POST /api/espn/link/ingest)
const espnAuthRouter    = require('./routes/espnAuth');
const ffPointsRouter    = require('./routes/ffPoints');
const espnRouter        = require('./routes/espn');
const hydrateEspn       = require('./routes/espn/hydrate');
const imagesPresign     = require('./routes/images/presign-r2');       // if used elsewhere
const createImagesRouter= require('./src/routes/images');              // if used elsewhere
const pool              = require('./src/db/pool');

// Optional helpers used by Kona passthrough
const { fetchFromEspnWithCandidates } = require('./routes/espn/espnCred');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ===== Parsers & logs =====
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '5mb', strict: false }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// === ESPN Fan API proxy (reads leagues straight from ESPN with SWID + s2) ===
function normalizeSwid(raw){
  try{
    let v = decodeURIComponent(String(raw||'')).trim();
    if (!v) return '';
    v = v.replace(/^%7B/i,'{').replace(/%7D$/i,'}');
    if (!v.startsWith('{')) v = `{${v.replace(/^\{?/, '').replace(/\}?$/, '')}}`;
    return v.toUpperCase();
  }catch{ return String(raw||''); }
}

async function fanProxyHandler(req, res){
  try {
    const swid = normalizeSwid(req.params?.id || req.query?.SWID || req.query?.swid || req.cookies?.SWID || '');
    const s2   = req.cookies?.espn_s2 || req.query?.s2 || req.query?.espn_s2 || '';
    if (!swid || !s2) return res.status(400).json({ ok:false, error:'missing_swid_or_s2' });

    const url = `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(swid)}`;
    const r = await fetch(url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        cookie: `SWID=${swid}; espn_s2=${s2}`,
        referer: 'https://www.espn.com/'
      }
    });

    const text = await r.text(); // pass-through
    res.status(r.status)
       .set('Content-Type','application/json; charset=utf-8')
       .set('Cache-Control','no-store')
       .send(text);
  } catch (e) {
    console.error('[espn/fan proxy]', e);
    res.status(502).json({ ok:false, error:'espn_fan_upstream_failed' });
  }
}

app.get('/api/platforms/espn/fan/me', fanProxyHandler);
app.get('/api/platforms/espn/fan/:id', fanProxyHandler);

// ===== CORS (CF fronted) =====
const allow = {
  'access-control-allow-origin': 'https://fortifiedfantasy.com',
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'Content-Type,Authorization,x-espn-swid,x-espn-s2,x-fein-key',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-max-age': '600',
};
app.options('*', (req, res) => res.set(allow).sendStatus(204));
app.use((req, res, next) => { res.set(allow); next(); });

// ===== Health & status =====
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: new Date().toISOString(), path: '/healthz' });
});
app.get('/api/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: new Date().toISOString(), path: '/api/healthz' });
});

app.set('pg', pool);

app.get('/status', (req, res) => {
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid = c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || null;
  const s2   = c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2'] || null;
  res.set('Cache-Control', 'no-store');
  res.json({ ok:true, name:'ff-platform-service', ts:new Date().toISOString(), espn:{ hasCookies: !!(swid && s2) } });
});
// --- ESPN Connect static (UI) ---
const ESPN_CONNECT_DIR = path.join(__dirname, 'public', 'espnconnect');
app.use('/espnconnect', express.static(ESPN_CONNECT_DIR, {
  index: 'index.html',
  maxAge: '0'
}));

// --- ESPN Connect API (fan + ingest) ---
app.use('/api/espnconnect', espnConnectRouter);
// expose the Fan endpoint under the platforms namespace too, so FE can use one base:
app.use('/api/platforms/espn', espnConnectRouter);

// --- CSP: allow same-origin scripts and inline styles for the page ---
app.use((req, res, next) => {
  res.set('Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' https://fortifiedfantasy.com",
      "img-src 'self' data: https://img.fortifiedfantasy.com https://a.espncdn.com https://g.espncdn.com",
      "frame-ancestors 'self'",
      "base-uri 'self'"
    ].join('; ')
  );
  next();
});

// ===== Mount the ESPN Link UI (must be before generic espnRouter/catch-alls) =====
app.use('/api/espn', espnLink); // serves GET /api/espn/link page + POST /api/espn/link/ingest

// ===== ESPN auth/platform namespace =====
app.use('/api/platforms/espn', espnAuthRouter({ pool, cookieDomain: 'fortifiedfantasy.com' }));
app.use('/api/espnconnect', espnConnectRouter);

// ===== Kona passthrough (ESPN reads) with masked-cred headers =====
async function konaHandler(req, res) {
  try {
    const game     = String(req.params.game || 'ffl').toLowerCase();
    const season   = Number(req.params.season);
    const leagueId = String(req.params.leagueId);
    if (!season || !leagueId) return res.status(400).json({ ok:false, error:'missing_params' });

    const upstream = new URL(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/${game}/seasons/${season}/segments/0/leagues/${leagueId}`);
    for (const [k, v] of Object.entries(req.query)) upstream.searchParams.set(k, String(v));

    const { status, body, used } =
      await fetchFromEspnWithCandidates(upstream.toString(), req, {
        leagueId,
        teamId:   req.query?.teamId   || null,
        memberId: req.query?.memberId || null,
      });

    try {
      if (used) {
        if (used.source)     res.set('X-ESPN-Cred-Source', String(used.source));
        if (used.swidMasked) res.set('X-ESPN-Cred-SWID',   String(used.swidMasked));
        if (used.s2Masked)   res.set('X-ESPN-Cred-S2',     String(used.s2Masked));
      }
    } catch {}

    if (used) console.log('[kona] used', used);

    res.set('Content-Type','application/json; charset=utf-8');
    res.set('Cache-Control','no-store, private');
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials','true');

    if (req.query.debug === '1' && status >= 200 && status < 300) {
      const j = JSON.parse(body || '{}');
      j.__cred = used;
      return res.status(status).json(j);
    }
    return res.status(status).send(body);
  } catch (e) {
    console.error('[espn kona passthrough]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}
app.get('/apis/v3/games/:game/seasons/:season/segments/0/leagues/:leagueId', konaHandler);
app.get('/api/platforms/espn/apis/v3/games/:game/seasons/:season/segments/0/leagues/:leagueId', konaHandler);

// ===== Free agents + ingest + poll/roster/league endpoints your FE expects =====
app.use('/api/platforms/espn', require('./routes/espn/free-agents'));
app.use('/api/platforms/espn', require('./routes/espn/free-agents-with-team'));
app.use('/api/ingest/espn/fan', require('./routes/ingest/espn-fan'));

// Helper to accept Router or handler exports
function asMiddleware(mod) {
  if (!mod) return null;
  if (mod.default) return asMiddleware(mod.default);
  if (typeof mod === 'function') return mod;
  if (typeof mod.handle === 'function') return mod;
  if (mod.router && typeof mod.router.handle === 'function') return mod.router;
  if (typeof mod.handler === 'function') return mod.handler;
  return null;
}
// poll
{
  const pollMod = require('./routes/espn/poll');
  const pollMw = asMiddleware(pollMod);
  if (!pollMw) throw new Error('espn/poll export is not a middleware or Router');
  app.use('/api/platforms/espn', pollMw);
}
// roster
{
  const rosterMod = require('./routes/espn/roster');
  const rosterMw = asMiddleware(rosterMod);
  if (!rosterMw) throw new Error('espn/roster export is not a middleware or Router');
  app.use('/api/platforms/espn', rosterMw);
}
// league
{
  const leagueMod = require('./routes/espn/league');
  const leagueMw = asMiddleware(leagueMod);
  if (!leagueMw) throw new Error('espn/league export is not a middleware or Router');
  app.use('/api/platforms/espn', leagueMw);
}

// ===== FF points API =====
app.use('/api/ff', ffPointsRouter({ pool }));

// ===== Avatar/logo fallback =====
const sendLogo = (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
    return res.sendFile(path.join(process.cwd(), 'public', 'logo.png'));
  } catch {
    res
      .status(200)
      .set('Cache-Control', 'public, max-age=600')
      .set('Content-Type', 'image/svg+xml')
      .send('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0f1422"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="system-ui" font-size="10" fill="#9fb2c9">FF</text></svg>');
  }
};
app.get('/api/platforms/espn/image/:id', sendLogo);
app.get('/api/espn/image/:id',           sendLogo); // legacy alias
app.get('/api/image/:id',                sendLogo); // generic alias

// ===== Early routers =====
app.use('/api/session', require('./routes/session')); // mount early
app.use('/api/identity', require('./routes/identity-status'));
app.use('/api/identity/me', require('./routes/identity/me'));
app.use('/api/images', createImagesRouter());

// Accept reactions (no-op for now)
app.post('/api/fein/react', express.json(), (_req, res) => res.status(204).end());

// Legacy bootstrap shim
app.get(['/fein/fein-espn-bootstrap.js'], (_req, res) => {
  res.type('application/javascript').set('Cache-Control','no-store').send(
`/* disabled: unified bootstrap in use */
export {};
(function(){ /* no-op */ })();
`);
});

// ===== ESPN hydrate + routers (canonical + legacy) =====
app.use(hydrateEspn());
app.use('/api/platforms/espn', espnRouter);
app.use('/api/espn-auth',      espnRouter); // alias
app.use('/api/espn',           espnRouter); // legacy short base

// IMPORTANT: remove any legacy top-level redirect that forced the old flow
// app.get('/link', (req, res) => { const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''; res.redirect(302, `/api/espn/link${qs}`); });

// ===== PP & identity/session routes =====
app.use('/api/pp', require('./routes/pp/teams'));
app.use('/api/whoami', require('./routes/whoami'));
app.use('/api/ghosts', require('./routes/ghosts'));
app.use('/api/signin', require('./routes/identity/resolve'));
app.use('/api/session', require('./routes/session/loginFromPre'));
app.use('/api/identity', require('./routes/identity/request-code'));
app.use('/api/identity', require('./routes/identity/verify-code'));

const qh = require('./routes/quickhitter');
app.use('/api/identity', require('./src/routes/identity-signup-email'));
app.use('/api/profile',  require('./src/routes/profile'));
app.use('/api/session',  require('./routes/session')); // /check, /exists, /lookup, /avatar, /qh-upsert
app.use('/api/quickhitter', qh);
app.use('/api/identity',   qh); // alias for legacy FE calls

// ===== Compatibility shims the FE expects =====
app.post('/api/verify/start',   (req, res) => res.redirect(307, '/api/identity/request-code'));
app.post('/api/verify/confirm', (req, res) => res.redirect(307, '/api/identity/verify-code'));
app.post('/api/quickhitter/upsert', (req, res) => res.redirect(307, '/api/quickhitter/qh-upsert'));
app.post('/api/identity/upsert',    (req, res) => res.redirect(307, '/api/quickhitter/qh-upsert'));
app.get('/api/identity/whoami',     (req, res) => res.redirect(307, '/api/whoami'));

// Lightweight bootstrap (never 401)
app.get('/bootstrap', async (req, res) => {
  try {
    const getSession = require('./routes/session/getSession');
    const sess = await getSession?.(req.cookies?.ff_sid || null);
    res.set('Cache-Control','no-store');
    res.json({ ok: true, authenticated: !!sess, member_id: sess?.member_id || null });
  } catch {
    res.status(200).json({ ok: true, authenticated: false });
  }
});

// ===== Content Security Policy (allow inline script for /api/espn/link page) =====
app.use((req,res,next)=>{
  res.set('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +                // <-- needed for link page inline JS
    "connect-src 'self' https://fortifiedfantasy.com; " +
    "img-src 'self' data: https://img.fortifiedfantasy.com https://a.espncdn.com https://g.espncdn.com; " +
    "frame-ancestors 'self'; base-uri 'self'");
  next();
});
// /api/coinsignal/candles?productId=BTC-USD&granularity=3600
// put near top of server.js (once)
app.set('etag', false); // globally disable ETag; or do per-route below

const ALLOWED = new Set([60, 300, 900, 3600, 21600, 86400]); // 1m,5m,15m,1h,6h,1d

// quick in-memory cache to avoid rate-limit thrash
const _cache = new Map(); // key: `${productId}|${granularity}` -> {ts, data}
function getCache(key, ttlMs){ const v = _cache.get(key); return (v && (Date.now()-v.ts < ttlMs)) ? v.data : null; }
function setCache(key, data){ _cache.set(key, { ts: Date.now(), data }); }

// helper: downsample an array of closes by a factor (use the last of each block)
function downsampleCloses(closes, factor){
  if (factor <= 1) return closes;
  const out = [];
  for (let i = factor-1; i < closes.length; i += factor){
    out.push(closes[i]);
  }
  return out.length ? out : [closes.at(-1)];
}

app.get('/api/coinsignal/candles', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-transform'); // prevent 304 to client

    const productId  = String(req.query.productId || 'BTC-USD').toUpperCase();
    let granularity  = Number(req.query.granularity || 3600);

    // Map unsupported granularities to a supported upstream + a downsample factor
    let upstreamGran = granularity;
    let factor = 1;
    if (!ALLOWED.has(granularity)) {
      if (granularity === 14400) {       // 4h -> fetch 1h, factor 4
        upstreamGran = 3600; factor = 4;
      } else if (granularity === 604800) { // 1w -> fetch 1d, factor 7
        upstreamGran = 86400; factor = 7;
      } else {
        // default fallback: use 1h
        upstreamGran = 3600;
        factor = Math.max(1, Math.round(granularity / 3600));
      }
    }

    // small TTL based on upstream granularity (tune as you like)
    const ttlMs = upstreamGran <= 300 ? 10_000 : upstreamGran <= 3600 ? 30_000 : 60_000;
    const cacheKey = `${productId}|${upstreamGran}`;
    const cached = getCache(cacheKey, ttlMs);
    if (cached) {
      const closes = factor > 1 ? downsampleCloses(cached.closes, factor) : cached.closes;
      return res.json({ closes, price: closes.at(-1) });
    }

    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(productId)}/candles?granularity=${upstreamGran}`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'ff-coinsignal/1.0' } });

    // Parse safely (avoid crashing on non-JSON or HTML error pages)
    const raw = await r.text();
    let rows;
    try { rows = JSON.parse(raw); }
    catch {
      throw new Error(`Upstream ${r.status} non-JSON: ${raw.slice(0,120)}`);
    }

    if (!r.ok) {
      // Coinbase error shape: { message: "..." }
      const msg = (rows && rows.message) ? rows.message : `status=${r.status}`;
      throw new Error(`Coinbase error: ${msg}`);
    }

    if (!Array.isArray(rows)) {
      // rows is probably {message: "..."} or something else
      throw new Error(`Unexpected upstream shape: ${JSON.stringify(rows).slice(0,200)}`);
    }

    // Coinbase candles format: newest first [[time, low, high, open, close, volume], ...]
    const asc = rows.slice().reverse();
    let closes = asc.map(row => row[4]);
    if (!closes.length) throw new Error('Empty candle set from upstream');

    // Downsample if requested timeframe was unsupported
    if (factor > 1) closes = downsampleCloses(closes, factor);

    setCache(cacheKey, { closes });
    res.json({ closes, price: closes.at(-1) });
  } catch (err) {
    console.error('[coinsignal] candles error:', err?.message || err);
    res.status(502).json({ ok:false, error:String(err?.message || err) });
  }
});


// ===== FEIN roster JSON alias (TOP-LEVEL, before FEIN static) =====
app.get(['/fein/roster', '/api/roster'], (req, res) => {
  const i = req.originalUrl.indexOf('?');
  const qs = i >= 0 ? req.originalUrl.slice(i) : '';
  res.redirect(307, `/api/platforms/espn/roster${qs}`);
});

// ===== FEIN static hosting + SPA fallback =====
app.get('/', (req, res) => {
  const season = (req.query.season && Number(req.query.season)) || new Date().getUTCFullYear();
  const qs = new URLSearchParams({ season }).toString();
  res.redirect(302, `/fein/?${qs}`);
});
app.get('/fein', (req, res, next) => {
  // Only redirect if season is missing
  if (!('season' in (req.query || {}))) {
    const season = new Date().getUTCFullYear();
    const qs = new URLSearchParams({ season }).toString();
    return res.redirect(302, `/fein/?${qs}`);
  }
  return next(); // let the static / SPA fallback handle it
});


// Serve built FEIN assets
const FEIN_DIR = path.join(__dirname, 'public', 'fein');
app.use('/fein', express.static(FEIN_DIR, {
  index: 'index.html',
  fallthrough: true,
  maxAge: '1h',
  setHeaders(res) {
    const ct = res.getHeader('Content-Type');
    if (ct && String(ct).includes('text/html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// SPA fallback for /fein/* routes
app.get(/^\/fein\/?.*$/, (req, res, next) => {
  if (!req.accepts('html')) return next();
  res.sendFile(path.join(FEIN_DIR, 'index.html'));
});

// Robots
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /');
});

// ===== Public static (non-FEIN) =====
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// ===== JSON 404 for /api (after all routers!) =====
app.use('/api/*', (req, res) => {
  res.status(200).json({
    ok: false,
    soft: true,
    error: 'not_found',
    path: req.originalUrl || req.url,
  });
});
app.use('/api', (req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ ok:false, error:'not_found', path:req.originalUrl });
});

// ===== Errors =====
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ ok:false, error:'server_error' });
});

// ===== Boot =====
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FF Platform Service listening on :${port}`));

module.exports = { fetchFromEspnWithCandidates };
