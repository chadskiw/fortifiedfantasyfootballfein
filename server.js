// server.js — FF Platform Service (fixed root + FEIN static + stable shims)
require('dotenv').config();
console.log('[R2] using bucket =', process.env.R2_BUCKET);
console.log('[R2] endpoint =', process.env.R2_ENDPOINT);

const express      = require('express');
const morgan       = require('morgan');
const cookieParser = require('cookie-parser');
const path         = require('path');

const espnRouter   = require('./routes/espn');
const hydrateEspn  = require('./routes/espn/hydrate');
const imagesPresign = require('./routes/images/presign-r2');
const createImagesRouter = require('./src/routes/images');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
// add once in server.js
app.post('/api/fein/react', express.json(), (req, res) => {
  // TODO: write to reactions tables later. For now, accept and no-op.
  res.status(204).end();
});

// ===== FEIN bootstrap guard (legacy asset that some builds still request) =====
app.get(['/fein/fein-espn-bootstrap.js'], (_req, res) => {
  res.type('application/javascript').set('Cache-Control','no-store').send(
`/* disabled: unified bootstrap in use */
export {};
(function(){ /* no-op */ })();
`);
});

// ===== Parsers & logs =====
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '5mb', strict: false }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ===== Early routers =====
app.use('/api/session', require('./routes/session')); // mount early
app.use('/api/identity', require('./routes/identity-status'));
app.use('/api/identity/me', require('./routes/identity/me'));
app.use('/api/images', createImagesRouter()); // presign + upload

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
  res.json({ ok: true, ts: new Date().toISOString() });
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

app.use('/api/session/bootstrap', require('./routes/session/bootstrap'));
// Complete method: fetchRoster() – front end
async function fetchRoster({ season, leagueId, teamId, scope }) {
  const params = new URLSearchParams({
    season: String(season),
    leagueId: String(leagueId),
    teamId: String(teamId || ''),
    scope: String(scope || 'week'),
  });

  // Prefer the alias (/fein/roster) — _redirects maps it to /api/roster
  const res = await fetch(`/fein/roster?${params}`, { credentials: 'include' });

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text().catch(() => '');
    throw new Error(`Non-JSON from /fein/roster (${res.status}). First bytes: ${text.slice(0,80)}`);
  }
  return await res.json();
}

// ===== ESPN hydrate + routers (canonical + legacy) =====
app.use(hydrateEspn());
app.use('/api/platforms/espn', espnRouter);
app.use('/api/espn-auth',      espnRouter); // alias
app.use('/api/espn',           espnRouter); // legacy short base

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
app.post('/api/verify/start', require('./routes/identity/request-code')); // legacy alias

const qh = require('./routes/quickhitter');
app.use('/api/identity', require('./src/routes/identity-signup-email'));
app.use('/api/profile',  require('./src/routes/profile'));
app.use('/api/session', require('./routes/session')); // /check, /exists, /lookup, /avatar, /qh-upsert
app.use('/api/quickhitter', qh);
app.use('/api/identity',   qh); // alias for legacy FE calls

// ===== Compatibility shims the FE expects =====
app.post('/api/verify/start', (req, res) => res.redirect(307, '/api/identity/request-code'));
app.post('/api/verify/confirm', (req, res) => res.redirect(307, '/api/identity/verify-code'));
app.post('/api/quickhitter/upsert', (req, res) => res.redirect(307, '/api/quickhitter/qh-upsert'));
app.post('/api/identity/upsert', (req, res) => res.redirect(307, '/api/quickhitter/qh-upsert'));
app.get('/api/identity/whoami', (req, res) => res.redirect(307, '/api/whoami'));

// Lightweight bootstrap (never 401)
app.get('/bootstrap', async (req, res) => {
  try {
    const getSession = require('./routes/session/getSession'); // if you have a helper, otherwise stub false
    const sess = await getSession?.(req.cookies?.ff_sid || null);
    res.set('Cache-Control','no-store');
    res.json({ ok: true, authenticated: !!sess, member_id: sess?.member_id || null });
  } catch {
    res.status(200).json({ ok: true, authenticated: false });
  }
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

// Serve built FEIN assets (adjust path if your build lives elsewhere)
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
