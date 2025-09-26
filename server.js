// server.js — FF Platform Service (cleaned)
require('dotenv').config();

const express      = require('express');
const morgan       = require('morgan');
const cookieParser = require('cookie-parser');
const path         = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// --- DB ----------------------------------------------------------------------
const pool = require('./src/db/pool');

// --- Helpers -----------------------------------------------------------------
function requireIfExists(p) {
  try { return require(p); } catch { return null; }
}
function mountRouter(mountPath, mod, ...factoryArgs) {
  if (!mod) return;

  // If it's an Express Router instance, it's a function with .use and .handle.
  const isExpressRouterFn =
    typeof mod === 'function' && mod && typeof mod.use === 'function' && typeof mod.handle === 'function';

  let router;

  if (isExpressRouterFn) {
    // Already a router instance → don't call it.
    router = mod;
  } else if (typeof mod === 'function') {
    // Factory → call it with provided deps (e.g., pool)
    router = mod(...factoryArgs);
  } else {
    // Could already be a router object (rare), accept if it looks like one.
    router = mod;
  }

  const looksLikeRouter =
    typeof router === 'function' && router && typeof router.use === 'function' && typeof router.handle === 'function';

  if (!looksLikeRouter) {
    console.warn('[mountRouter] Skipping', mountPath, '— module is not an Express router:', typeof router, router && Object.keys(router));
    return;
  }

  app.use(mountPath, router);
}

function redirect307(from, to) {
  app.all(from, (req, res) => res.redirect(307, to));
}

// --- Logging & Parsers -------------------------------------------------------
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '5mb', strict: false }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// after you init app, cookies, etc.


// --- CORS (single, global) ---------------------------------------------------
const CORS_ALLOW = {
  'access-control-allow-origin':      'https://fortifiedfantasy.com',
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers':     'Content-Type,Authorization,x-espn-swid,x-espn-s2,x-fein-key',
  'access-control-allow-methods':     'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-max-age':           '600',
};
app.options('*', (req, res) => res.set(CORS_ALLOW).sendStatus(204));
app.use((req, res, next) => { res.set(CORS_ALLOW); next(); });

// --- Health & Status ---------------------------------------------------------
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: new Date().toISOString() });
});
const createImagesRouter = require('./src/routes/images');
app.use('/api/images', createImagesRouter());
app.get('/status', (req, res) => {
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid = c.SWID || c.swid || c.ff_espn_swid || h['x-espn-swid'] || null;
  const s2   = c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || h['x-espn-s2'] || null;
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    name: 'ff-platform-service',
    ts: new Date().toISOString(),
    espn: { hasCookies: !!(swid && s2) }
  });
});

// --- Core Routers ------------------------------------------------------------
// NOTE: mount order matters—session early since other routes may read session.

mountRouter('/api/session', requireIfExists('./routes/session'));                // whoami, logout, etc.
mountRouter('/api/session/bootstrap', requireIfExists('./routes/session/bootstrap'));

// Identity (status/resolve + request/verify + signup + loginFromPre)
mountRouter('/api/identity', requireIfExists('./routes/identity-status'));
mountRouter('/api/identity', requireIfExists('./routes/identity/resolve'));
mountRouter('/api/identity', requireIfExists('./routes/identity/request-code'));
mountRouter('/api/identity', requireIfExists('./routes/identity/verify-code'));
mountRouter('/api/identity', requireIfExists('./routes/identity/avatar'));
mountRouter('/api/identity', requireIfExists('./src/routes/identity-signup-email'));
mountRouter('/api/session',  requireIfExists('./routes/session/loginFromPre'));

// Profile
mountRouter('/api/profile',  requireIfExists('./src/routes/profile'));

// Images (use the one you actually ship)
mountRouter('/api/images',   requireIfExists('./routes/images'));
// mountRouter('/api/images',   requireIfExists('./src/routes/images')); // alt path

// Members
mountRouter('/api/members',  requireIfExists('./routes/members'));

// Quickhitter (mounted once, add aliases later)
const quickhitter = requireIfExists('./routes/quickhitter');
mountRouter('/api/quickhitter', quickhitter);

// Ghosts (optional)
mountRouter('/api/ghosts',   requireIfExists('./routes/ghosts'));

// ESPN platform (unified entry; support both new & legacy)
// Ingest (factory or router)
mountRouter('/api/platforms/espn', requireIfExists('./routes/espn-ingest'), pool);
// Canonical ESPN API
mountRouter('/api/platforms/espn', requireIfExists('./routes/espn'));
mountRouter('/api/espn',            requireIfExists('./routes/espn')); // legacy alias

// Whoami (single canonical source + simple alias)
redirect307(['/whoami', '/api/whoami'], '/api/session/whoami');

// --- Compatibility Shims (keep FE happy, no duplicates) ---------------------

// Legacy verify API → identity routes
redirect307('/api/verify/start',   '/api/identity/request-code');
redirect307('/api/verify/confirm', '/api/identity/verify-code');

// Legacy quickhitter upsert call variants
app.post('/api/quickhitter/upsert', (req, res) => res.redirect(307, '/api/quickhitter/qh-upsert'));
app.post('/api/identity/upsert',    (req, res) => res.redirect(307, '/api/quickhitter/qh-upsert'));

// Legacy identity whoami → session whoami
redirect307('/api/identity/whoami', '/api/session/whoami');

// (Optional) Debug
mountRouter('/api/debug', requireIfExists('./routes/debug/db'));

// --- Static Files ------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// --- JSON 404 for /api -------------------------------------------------------
app.use('/api', (req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ ok:false, error:'not_found', path:req.originalUrl });
});

// --- Errors ------------------------------------------------------------------
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ ok:false, error:'server_error' });
});

// --- Boot --------------------------------------------------------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FF Platform Service listening on :${port}`));
