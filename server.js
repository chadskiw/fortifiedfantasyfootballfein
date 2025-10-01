// server.js — FF Platform Service
require('dotenv').config();
console.log('[R2] using bucket =', process.env.R2_BUCKET);
console.log('[R2] endpoint =', process.env.R2_ENDPOINT);

const express      = require('express');
const morgan       = require('morgan');
const cookieParser = require('cookie-parser');
const path         = require('path');
const espnRouter = require('./routes/espn');

// const imagesPresign = require('./routes/images/presign');
const imagesPresign = require('./routes/images/presign-r2');
// ✅ single mount
const createImagesRouter = require('./src/routes/images');   // <- your file above


const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
// in server.js, BEFORE app.use(express.static(...))
app.get(['/fein/fein-espn-bootstrap.js'], (_req, res) => {
  res.type('application/javascript').set('Cache-Control','no-store')
     .send(`/* disabled: unified bootstrap in use */
export {};
// Hard guard if someone re-includes this accidentally:
(function(){ /* no-op */ })();
`);
});

// Parsers & logs
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '5mb', strict: false }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/api/session', require('./routes/session')); // mount early
app.use('/api/identity', require('./routes/identity-status'));
app.use('/api/identity/me', require('./routes/identity/me'));
// images router (presign + upload)
// ✅ mount early, before any /api catch-all 404
app.use('/api/images', createImagesRouter());

// … later …
//app.use('/api', (req, res) => {
//  if (res.headersSent) return;
//  res.status(404).json({ ok:false, error:'not_found', path:req.originalUrl });
//});


// CORS
const allow = {
  'access-control-allow-origin': 'https://fortifiedfantasy.com',
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'Content-Type,Authorization,x-espn-swid,x-espn-s2,x-fein-key',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-max-age': '600',
};
app.options('*', (req, res) => res.set(allow).sendStatus(204));
app.use((req, res, next) => { res.set(allow); next(); });

// Health & Status
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: new Date().toISOString() });
});
const pool = require('./src/db/pool');
// make pg pool available to routers that use req.app.get('pg')
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
// in your main server file (e.g., index.js/app.js)
//app.use('/api/platforms/espn', require('./routes/espn-ingest', './routes/session/bootstrap', pool));
// server.js (or app.js)

// Canonical base
app.use('/api/platforms/espn', espnRouter);

// Legacy/short base used by older FE and tools
app.use('/api/espn', espnRouter);
// server.js (or app.js) — put this AFTER body parsers and BEFORE your SPA/static/404
app.get('/link', (req, res) => {
  const qs = req.originalUrl.includes('?')
    ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
    : '';
  res.redirect(302, `/api/espn/link${qs}`);
});
app.use('/api/pp', require('./src/routes/pp/teams'));

// Routers (canonical locations under src/routes/*)
app.use('/api/session',          require('./routes/session'));               // whoami source of truth
//app.get(['/whoami','/api/whoami'], (req,res)=>res.redirect(307, '/api/session/whoami'));
app.use('/api/whoami', require('./routes/whoami'));
app.use('/api/ghosts', require('./routes/ghosts'));
// server.js
app.use('/api/signin', require('./routes/identity/resolve')); // -> POST /api/signin/resolve
app.use('/api/session', require('./routes/session/loginFromPre'));

//app.use('/api/platforms/espn/cred', require('./routes/espn-cred'));
app.use('/api/identity', require('./routes/identity/request-code'));
app.use('/api/identity', require('./routes/identity/verify-code'));
app.post('/api/verify/start', require('./routes/identity/request-code')); // legacy alias



const qh = require('./routes/quickhitter');  
// map legacy FE calls to the new images endpoints
// server.js
//app.use('/api/platforms/espn', require('./routes/full-pool'));

// server.js (or app.js)
app.use('/api/identity', require('./src/routes/identity-signup-email')); // exposes POST /signup
app.use('/api/profile',  require('./src/routes/profile'));                // exposes POST /update


app.set('trust proxy', 1); // so req.ip works behind CF/Render
app.use('/api/session', require('./routes/session'));
                        // /check, /exists, /lookup, /avatar, /qh-upsert
app.use('/api/quickhitter', qh);
app.use('/api/identity',   qh); // alias for legacy FE calls

app.use('/api/members',          require('./routes/members'));
// server.js
//app.use('/api/platforms/espn', require('./routes/espn-ingest'));


//app.use('/api/platforms/espn', require('./routes/espn')); 
//app.use('/api/espn',             require('./routes/espn'));                  // consolidated ESPN (dir with index.js)
//app.use('/api/platforms/espn',   require('./routes/platforms/espn'));        // legacy alias surface
// optional: if login is its own file and not included above
//try { app.use('/api/espn/login', require('./routes/espn/login')); } catch (_) {}

// optional debug
try { app.use('/api/debug',      require('./routes/debug/db')); } catch (_) {}
// ---- Compatibility adapters (keep the FE happy without code changes)

// 1) FE calls /api/verify/start → send a one-time code
//    Forward (307 preserves method+body) to your existing identity route.
app.post('/api/verify/start', (req, res) => {
  res.redirect(307, '/api/identity/request-code');
});

// (optional) If your FE ever calls /api/verify/confirm, map it to your verifier.
// If your verifier is at /api/identity/verify-code, keep that; if you only have
// /api/identity/send-code, change the target accordingly.
app.post('/api/verify/confirm', (req, res) => {
  res.redirect(307, '/api/identity/verify-code'); // or '/api/identity/send-code' if that's your confirm path
});

// 2) FE may post /api/quickhitter/upsert or /api/identity/upsert,
//    but your router exposes /api/quickhitter/qh-upsert.
//    Add light 307 shims for both.
app.post('/api/quickhitter/upsert', (req, res) => {
  res.redirect(307, '/api/quickhitter/qh-upsert');
});
app.post('/api/identity/upsert', (req, res) => {
  res.redirect(307, '/api/quickhitter/qh-upsert');
});

// 3) Some FE builds hit /api/identity/whoami; normalize to your whoami.
app.get('/api/identity/whoami', (req, res) => {
  res.redirect(307, '/api/whoami');
});
// GET /api/session/bootstrap  → always 200 with a simple status
app.get('/bootstrap', async (req, res) => {
  try {
    const sess = await getSession(req.cookies?.ff_sid || null);
    res.set('Cache-Control','no-store');
    res.json({ ok: true, authenticated: !!sess, member_id: sess?.member_id || null });
  } catch (e) {
    res.status(200).json({ ok: true, authenticated: false }); // never 401 here
  }
});
// in your main server file, after mounting /api/session
app.get('/api/whoami', async (req, res) => {
  try {
    const r = await fetch(new URL('/routes/session/whoami', `${req.protocol}://${req.get('host')}`), {
      headers: { cookie: req.headers.cookie || '' }
    });
    if (r.status === 401) return res.json({ ok:true, authenticated:false });
    const j = await r.json();
    res.json({ ok:true, authenticated:true, member: j.member });
  } catch {
    res.json({ ok:true, authenticated:false });
  }
});

// Static
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// JSON 404 for /api
app.use('/api', (req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ ok:false, error:'not_found', path:req.originalUrl });
});






// Errors
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ ok:false, error:'server_error' });
});

// Boot
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FF Platform Service listening on :${port}`));
