// server.js — FF Platform Service (fixed root + FEIN static + stable shims)
require('dotenv').config();
console.log('[R2] using bucket =', process.env.R2_BUCKET);
console.log('[R2] endpoint =', process.env.R2_ENDPOINT);
const { fetchFromEspnWithCandidates } = require('./routes/espn/espnCred');

const express      = require('express');
const morgan       = require('morgan');
const cookieParser = require('cookie-parser');
const path         = require('path');
const espnAuthRouter = require('./routes/espnAuth');
const ffPointsRouter = require('./routes/ffPoints');

const espnRouter    = require('./routes/espn');
const hydrateEspn   = require('./routes/espn/hydrate');
const imagesPresign = require('./routes/images/presign-r2');
const createImagesRouter = require('./src/routes/images');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ===== Parsers & logs =====
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '5mb', strict: false }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

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
// server.js — add near the top-level after other routes
// Health endpoints (must come before static middleware)
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: new Date().toISOString(), path: '/healthz' });
});

app.get('/api/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: new Date().toISOString(), path: '/api/healthz' });
});



const pool = require('./src/db/pool');
app.set('pg', pool);

app.get('/status', (req, res) => {
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid = c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || null;
  const s2   = c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2'] || null;
  res.set('Cache-Control', 'no-store');
  res.json({ ok:true, name:'ff-platform-service', ts:new Date().toISOString(), espn:{ hasCookies: !!(swid && s2) } });
});


// Mount under your platform namespace
 app.use('/api/platforms/espn', espnAuthRouter({
   pool,
   cookieDomain: 'fortifiedfantasy.com' // set to your apex/root domain
 }));
// requires: const fetch = global.fetch || require('node-fetch');
// wherever fetchFromEspnWithCandidates lives (you showed it in server.js)
const { resolveEspnCredCandidates } = require('./routes/espn/_cred');
const { mask } = require('./routes/espn/_mask');

/* SAFE: 3rd arg optional
async function fetchFromEspnWithCandidates(upstreamUrl, req, ctx = {}) {
  const { leagueId = null, teamId = null, memberId = null } = ctx || {};

  const cands = await resolveEspnCredCandidates({ req, leagueId, teamId, memberId });
  // last attempt unauth
  cands.push({ swid: '', s2: '', source: 'unauth' });

  for (const cand of cands) {
    try {
      const cookie = [
        cand?.swid ? `SWID=${cand.swid}` : '',
        cand?.s2   ? `espn_s2=${cand.s2}` : ''
      ].filter(Boolean).join('; ');

      const r = await fetch(upstreamUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json, text/plain, *//*',
          referer: 'https://fantasy.espn.com/',
          ...(cookie ? { cookie } : {})
        }
      });

      const text = await r.text();
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const okJson = r.ok && (ct.includes('application/json') || /^[\[{]/.test(text.trim()));

      if (okJson) {
        return { status: r.status, body: text };
      }
      // otherwise try next candidate
    } catch {/* keep iterating *//*}
  }
  return { status: 502, body: JSON.stringify({ ok:false, error:'all_candidates_failed' }) };
}
*/


// reuse your fetchFromEspnWithCandidates and the same handler body
// server.js

async function konaHandler(req, res) {
  try {
    const game     = String(req.params.game||'ffl').toLowerCase();
    const season   = Number(req.params.season);
    const leagueId = String(req.params.leagueId);
    const teamId   = req.query.teamId ? String(req.query.teamId) : null;
    const memberId = req.query.memberId ? String(req.query.memberId) : null;

    const upstream = new URL(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/${game}/seasons/${season}/segments/0/leagues/${leagueId}`);
    for (const [k,v] of Object.entries(req.query)) upstream.searchParams.set(k,String(v));

    const { status, body, used } =
      await fetchFromEspnWithCandidates(upstream.toString(), req, { leagueId, teamId, memberId });

    if (used) {
      res.set('X-ESPN-Cred-Source', used.source);
      res.set('X-ESPN-Cred-SWID',   used.swidMasked);
      res.set('X-ESPN-Cred-S2',     used.s2Masked);
      // also log once per request (masked)
      console.log('[kona] used', used);
    }

    res.set('Content-Type','application/json; charset=utf-8');
    res.set('Cache-Control','no-store, private');
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials','true');

    if (req.query.debug === '1' && status >= 200 && status < 300) {
      const j = JSON.parse(body || '{}'); j.__cred = used; return res.status(status).json(j);
    }
    return res.status(status).send(body);
  } catch (e) {
    console.error('[espn kona passthrough]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}

// use this one handler for both routes you already mounted
app.get('/apis/v3/games/:game/seasons/:season/segments/0/leagues/:leagueId', konaHandler);
app.get('/api/platforms/espn/apis/v3/games/:game/seasons/:season/segments/0/leagues/:leagueId', konaHandler);

// server.js
app.use('/api/platforms/espn', require('./routes/espn/free-agents'));

// ✅ Kona passthrough (the path your browser is hitting)
app.get('/apis/v3/games/:game/seasons/:season/segments/0/leagues/:leagueId', async (req, res) => {
  try {
    const game     = String(req.params.game || 'ffl').toLowerCase();
    const season   = Number(req.params.season);
    const leagueId = String(req.params.leagueId);
    if (!season || !leagueId) return res.status(400).json({ ok:false, error:'missing_params' });

    const teamId   = req.query.teamId ? String(req.query.teamId) : null;
    const memberId = req.query.memberId ? String(req.query.memberId) : null;

    const upstream = new URL(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/${game}/seasons/${season}/segments/0/leagues/${leagueId}`);
    for (const [k, v] of Object.entries(req.query)) upstream.searchParams.set(k, String(v));

// in konaHandler AND in free-agents route handler, after the call:
const { status, body, used } = await fetchFromEspnWithCandidates(/*...*/);

// add easy-to-read headers
if (used) {
  res.setHeader('X-ESPN-Cred-Source', used.source);
  res.setHeader('X-ESPN-Cred-SWID',   used.swidMasked);
  res.setHeader('X-ESPN-Cred-S2',     used.s2Masked);
}

// normal passthrough
// If you want an opt-in JSON echo for quick console checks:
if (req.query.debug === '1' && status >= 200 && status < 300) {
  try {
    const j = JSON.parse(body || '{}');
    j.__cred = used; // masked
    return res.status(status).json(j);
  } catch {
    // fall through to raw send
  }
}

return res.status(status).send(body);

  } catch (e) {
    console.error('[espn kona passthrough]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});

// --- helper to accept CJS, ESM default, plain handler, or an Express Router
function asMiddleware(mod) {
  if (!mod) return null;
  // unwrap ESM default
  if (mod.default) return asMiddleware(mod.default);
  // express.Router() has .handle
  if (typeof mod === 'function') return mod;
  if (typeof mod.handle === 'function') return mod;      // Router instance
  if (mod.router && typeof mod.router.handle === 'function') return mod.router;
  if (typeof mod.handler === 'function') return mod.handler;
  return null;
}

// poll
{
  const pollMod = require('./routes/espn/poll');
  const pollMw = asMiddleware(pollMod);
  if (!pollMw) throw new Error('espn/poll export is not a middleware or Router');
  app.use('/api/platforms/espn', pollMw);   // exposes GET /poll under /api/platforms/espn
}
// roster
{
  const rosterMod = require('./routes/espn/roster');
  const rosterMw = asMiddleware(rosterMod);
  if (!rosterMw) throw new Error('espn/roster export is not a middleware or Router');
  // exposes GET /api/platforms/espn/roster
  app.use('/api/platforms/espn', rosterMw);
}
// league
{
  const leagueMod = require('./routes/espn/league');
  const leagueMw = asMiddleware(leagueMod);
  if (!leagueMw) throw new Error('espn/league export is not a middleware or Router');
  // exposes GET /api/platforms/espn/roster
  app.use('/api/platforms/espn', leagueMw);
}
// ...
app.use('/api/ff', ffPointsRouter({ pool }));

// (repeat for other routers if needed)
// const teamsMw = asMiddleware(require('./routes/espn/teams'));
// app.use('/api/platforms/espn', teamsMw);

// Avatar/logo fallback – always serve local logo, never call Mystique
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

// pole-position
{
  const ppMod = require('./routes/espn/pole-position');
  const ppMw = asMiddleware(ppMod);
  if (!ppMw) throw new Error('espn/pole-position export is not a middleware or Router');
  // Exposes: GET /api/platforms/espn/pole-position
  app.use('/api/platforms/espn', ppMw);
}

// Mount under the routes your FE already hits
app.get('/api/platforms/espn/image/:id', sendLogo);
app.get('/api/espn/image/:id',           sendLogo); // legacy alias
app.get('/api/image/:id',                sendLogo); // generic alias
// ===== Early routers =====
app.use('/api/session', require('./routes/session')); // mount early
app.use('/api/identity', require('./routes/identity-status'));
app.use('/api/identity/me', require('./routes/identity/me'));
app.use('/api/images', createImagesRouter()); // presign + upload

// Accept reactions (no-op for now)
app.post('/api/fein/react', express.json(), (_req, res) => res.status(204).end());

// Legacy bootstrap shim that some builds still request
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
// ...other routers...

//app.use('/api/espn', require('./routes/espn-login'));
// Direct link alias → /api/espn/link (preserves query)
app.get('/link', (req, res) => {
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(302, `/api/espn/link${qs}`);
});

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
app.use((req,res,next)=>{
  res.set('Content-Security-Policy',
    "default-src 'self'; connect-src 'self' https://fortifiedfantasy.com; " +
    "img-src 'self' data: https://img.fortifiedfantasy.com https://a.espncdn.com; " +
    "frame-ancestors 'self'; base-uri 'self'");
  next();
});

// ===== 🔧 IMPORTANT: FEIN roster JSON alias (TOP-LEVEL, before FEIN static) =====
// Preserves the original query string (?season=&leagueId=&teamId=&week=)
app.get(['/fein/roster', '/api/roster'], (req, res) => {
  const i = req.originalUrl.indexOf('?');
  const qs = i >= 0 ? req.originalUrl.slice(i) : '';
  res.redirect(307, `/api/platforms/espn/roster${qs}`);
});

// ===== FEIN static hosting + SPA fallback =====
// Redirect root → FEIN with a season (fixes 404 on "/")
app.get('/', (req, res) => {
  const season = (req.query.season && Number(req.query.season)) || new Date().getUTCFullYear();
  const qs = new URLSearchParams({ season }).toString();
  res.redirect(302, `/fein/?${qs}`);
});

// Normalize /fein (no trailing slash) → /fein/?season=YYYY
app.get('/fein', (req, res) => {
  const season = (req.query.season && Number(req.query.season)) || new Date().getUTCFullYear();
  const qs = new URLSearchParams({ season }).toString();
  res.redirect(302, `/fein/?${qs}`);
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

// SPA fallback for /fein/* routes (so deep links work)
app.get(/^\/fein\/?.*$/, (req, res, next) => {
  if (!req.accepts('html')) return next();
  res.sendFile(path.join(FEIN_DIR, 'index.html'));
});

// Robots (keep crawlers off the SPA)
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /');
});

// ===== Public static (non-FEIN) =====
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));
app.use('/api/*', (req, res) => {
  res.status(200).json({
    ok: false,
    soft: true,
    error: 'not_found',
    path: req.originalUrl || req.url,
  });
});

// ===== JSON 404 for /api =====
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
