// server.js — CLEAN MOUNT
require('dotenv').config();

const express       = require('express');
const morgan        = require('morgan');
const path          = require('path');
const cookieParser  = require('cookie-parser');
const cors          = require('cors');
const crypto        = require('crypto');

const pool          = require('./src/db/pool'); // <- uses your existing pool.js (exports pg.Pool instance)

// Routers (CommonJS)
const identityHandleRouter = require('./routes/identity/handle');        // /handle/exists, /handle/upsert
const profileClaimRouter   = require('./routes/profile/claim-username');  // /claim-username
const requestCodeRouter    = require('./routes/identity/request-code');   // POST request/send code

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ---------- CORS ----------
const ALLOWED_ORIGINS = [
  /^(https?:\/\/)?localhost(:\d+)?$/i,
  /^(https?:\/\/)?127\.0\.0\.1(:\d+)?$/i,
  /^(https?:\/\/)?fortifiedfantasy\.com$/i,
  /^(https?:\/\/)?.*\.fortifiedfantasy\.com$/i,
];

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // same-origin / curl
    const ok = ALLOWED_ORIGINS.some((rx) => rx.test(origin));
    cb(null, ok);
  },
  credentials: true,
}));

// Common headers for manual preflights
function corsHeaders(req) {
  const origin = req.headers.origin || '*';
  const h = {
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Content-Type,Authorization,x-espn-swid,x-espn-s2,x-fein-key'
  };
  return h;
}

// Global preflight for anything under /api/*
app.options('/api/*', (req, res) => {
  res.set(corsHeaders(req)).status(204).end();
});

// ---------- Logging + parsers ----------
app.use(morgan('dev'));
app.use(cookieParser());

// Safe JSON parser: keep going on bad JSON (so routes can recover)
app.use(express.json({
  limit: '1mb',
}));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    // Malformed JSON → treat as empty; routes can read raw via text if needed
    req.body = {};
    return next();
  }
  return next(err);
});
app.use(express.urlencoded({ extended: true }));

// ---------- Helpers ----------
const norm = (v='') => String(v).trim();
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE  = /^\+?[0-9\-\s().]{7,}$/;
const HANDLE_RE = /^[a-zA-Z0-9_.]{3,24}$/;
const isEmail   = v => EMAIL_RE.test(norm(v));
const isPhone   = v => PHONE_RE.test(norm(v));
const isHandle  = v => HANDLE_RE.test(norm(v));

async function handleStats(username) {
  const u = norm(username);
  if (!isHandle(u)) return { count: 0, colors: [] };
  const r = await pool.query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(ARRAY_AGG(DISTINCT color_hex) FILTER (WHERE color_hex IS NOT NULL), '{}') AS colors
       FROM ff_member
      WHERE deleted_at IS NULL AND LOWER(username)=LOWER($1)`,
    [u]
  );
  return r.rows[0] || { count: 0, colors: [] };
}

function readCookiesHeader(header = '') {
  const out = {};
  (header || '').split(/;\s*/).forEach(p => {
    if (!p) return;
    const i = p.indexOf('=');
    const k = i < 0 ? p : p.slice(0, i);
    const v = i < 0 ? '' : decodeURIComponent(p.slice(i + 1));
    out[k] = v;
  });
  return out;
}
function normalizeSwid(raw = '') {
  const v = String(raw || '').trim();
  if (!v) return '';
  return v.startsWith('{') ? v.toUpperCase() : `{${v.replace(/[{}]/g,'').toUpperCase()}}`;
}
function extractEspnCreds(req) {
  const swidH = req.get('x-espn-swid') || '';
  const s2H   = req.get('x-espn-s2')   || '';
  const c     = req.cookies?.ff_espn_swid ? req.cookies : readCookiesHeader(req.headers.cookie || '');
  const swidC = c.ff_espn_swid || c.SWID || '';
  const s2C   = c.ff_espn_s2   || c.espn_s2 || c.ESPN_S2 || '';
  const swid = normalizeSwid(swidH || swidC);
  const s2   = (s2H || s2C || '').trim();
  if (swid && s2) {
    req.espn = { swid, s2 };
    return true;
  }
  return false;
}

// ---------- Identity: request-code ----------
app.post('/api/identity/request-code', (req, res, next) => {
  // requestCodeRouter already expects JSON; req.body is set by express.json()
  res.set(corsHeaders(req));
  return requestCodeRouter(req, res, next);
});
app.post('/api/identity/send-code', (req, res, next) => {
  res.set(corsHeaders(req));
  return requestCodeRouter(req, res, next);
});

// ---------- Identity: handle exists + upsert + alias ----------
app.use('/api/identity', (req, res, next) => { res.set(corsHeaders(req)); next(); }, identityHandleRouter);
app.use('/api/profile',  (req, res, next) => { res.set(corsHeaders(req)); next(); }, profileClaimRouter);

// ---------- Lightweight identity UX helpers ----------
app.get('/api/identity/handle/exists', async (req, res) => {
  try {
    res.set(corsHeaders(req));
    const u    = req.query.u || req.query.username || '';
    const hex  = (req.query.hex || '').trim();
    const limit = Number(req.query.limit);
    const stats = await handleStats(u);
    const pairTaken  = hex ? stats.colors.map(c => (c||'').toLowerCase()).includes(hex.toLowerCase()) : null;
    res.json({
      ok:true,
      available: Number.isFinite(limit) ? (stats.count < limit) : (stats.count === 0),
      count:stats.count,
      colors:stats.colors,
      pairAvailable:(hex ? !pairTaken : null),
      handleUnderLimit: Number.isFinite(limit) ? (stats.count < limit) : null
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// ---------- ESPN diag ----------
app.get('/api/platforms/espn/authcheck', (req, res) => {
  res.set(corsHeaders(req));
  const authed = extractEspnCreds(req);
  res.json({ ok:true, authed });
});

// ---------- FEIN meta quick-patch (unchanged logic) ----------
const { upsertFeinMeta, getFeinMetaByKey } = require('./src/db/feinMeta');

app.post('/api/fein-auth/fein/meta/upsert', async (req, res) => {
  res.set(corsHeaders(req));
  try {
    const season    = Number(req.body?.season);
    const platform  = String(req.body?.platform || '').toLowerCase();
    const league_id = String(req.body?.league_id || '').trim();
    const team_id   = String(req.body?.team_id || '').trim();
    if (!season || !platform || !league_id || !team_id) return res.status(400).json({ ok:false, error:'Missing required fields' });
    if (platform !== 'espn') return res.status(400).json({ ok:false, error:'platform must be "espn"' });

    const cookies = readCookiesHeader(req.headers.cookie || '');
    const swidHdr = req.get('x-espn-swid') || req.body?.swid || cookies.SWID || '';
    const s2Hdr   = req.get('x-espn-s2')   || req.body?.s2   || cookies.espn_s2 || '';
    const swid = normalizeSwid(swidHdr.trim());
    const s2   = decodeURIComponent((s2Hdr || '').trim());
    if (!swid || !s2) return res.status(400).json({ ok:false, error:'Missing swid/s2 credentials' });

    const row = await upsertFeinMeta({ season, platform, league_id, team_id, name:null, handle:null, league_size:null, fb_groups:null, swid, espn_s2:s2 });
    res.json({ ok:true, row });
  } catch (err) {
    console.error('[quickpatch upsert] error', err);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

app.get('/api/fein-auth/fein/meta/row', async (req, res) => {
  res.set(corsHeaders(req));
  try {
    const season    = Number(req.query.season);
    const platform  = String(req.query.platform || '').toLowerCase();
    const league_id = String(req.query.leagueId || '').trim();
    const team_id   = String(req.query.teamId || '').trim();
    if (!season || !platform || !league_id || !team_id) return res.status(400).json({ ok:false, error:'Missing required fields' });
    const row = await getFeinMetaByKey({ season, platform, league_id, team_id });
    if (!row) return res.status(404).json({ ok:false, error:'not_found' });
    res.json({ ok:true, row });
  } catch (err) {
    console.error('[quickpatch get row] error', err);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// ---------- Members (list) ----------
function toLimit(v, def=96) { const n = Number(v); return Number.isFinite(n) ? Math.max(1, Math.min(500, n)) : def; }
function cleanOrder(v) { return String(v || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC'; }

async function listRecentMembersHandler(_req, res) {
  try {
    const rows = (await pool.query(
      `SELECT
        member_id, username, color_hex, email, phone_e164,
        image_key, image_etag, image_format, image_width, image_height, image_version, last_image_at,
        event_count, first_seen_at, last_seen_at
       FROM ff_member
       WHERE deleted_at IS NULL
       ORDER BY last_seen_at DESC
       LIMIT 96`
    )).rows;
    res.json({ ok: true, items: rows, limit: 96 });
  } catch (e) {
    console.error('[GET /api/members/recent]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
}
async function listMembersHandler(req, res) {
  try {
    const limit = toLimit(req.query.limit);
    const orderSql = cleanOrder(req.query.order);
    const rows = (await pool.query(
      `SELECT
        member_id, username, color_hex, email, phone_e164,
        image_key, image_etag, image_format, image_width, image_height, image_version, last_image_at,
        event_count, first_seen_at, last_seen_at
       FROM ff_member
       WHERE deleted_at IS NULL
       ORDER BY last_seen_at ${orderSql}
       LIMIT $1`, [limit]
    )).rows;
    res.json({ ok: true, items: rows, limit, order: orderSql.toLowerCase() });
  } catch (e) {
    console.error('[GET /api/members]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
}
app.get('/api/members', listMembersHandler);
app.get('/api/members/recent', listRecentMembersHandler);

// ---------- Health BEFORE static ----------
app.get('/healthz', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const r = await pool.query('SELECT 1 AS ok');
    res.type('application/json').json({ ok: true, db: r.rows?.[0]?.ok === 1, ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).type('application/json').json({ ok: false, db: false, error: e.message, ts: new Date().toISOString() });
  }
});

// ---------- Static AFTER APIs ----------
app.use('/fein', express.static(path.join(__dirname, 'public/fein'), {
  immutable: true, maxAge: '4h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js'))  res.type('application/javascript');
    if (filePath.endsWith('.css')) res.type('text/css');
    if (filePath.endsWith('.wasm')) res.type('application/wasm');
  }
}));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// parsers
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// health/ping
app.get('/api/_ping', (_req, res) => {
  res.type('application/json').send({ ok:true, ts:new Date().toISOString() });
});

// NEW: quickhitter-first routes
app.use('/api/quickhitter', require('./src/routes/quickhitter')); // check, exists, colors, handle/:handle

// identity: request/send code + handle upsert (if you keep it here)
app.use('/api/identity', require('./src/routes/identity'));       // POST /request-code, /send-code
app.use('/api/identity', require('./src/routes/upsert'));         // POST /handle/upsert

// optional profile alias if you want /api/profile/claim-username to exist
try { app.use('/api/profile', require('./src/routes/upsert')); } catch { /* optional */ }

// images (R2 presign/commit)
app.use('/api/images', require('./src/routes/images'));

// legacy shims so older JS doesn’t 404
try { app.use('/api/members', require('./src/routes/members')); } catch { /* optional */ }

// JSON 404 for /api
app.use('/api', (req, res) => res.status(404).json({ ok:false, error:'not_found', path:req.originalUrl }));

// JSON error handler
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(err.status || 500).json({ ok:false, error:'server_error', message: err.message });
});



// ---------- JSON 404 for /api ----------
app.use('/api', (req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ ok:false, error:'not_found', path:req.originalUrl });
});

// ---------- Error handler ----------
app.use((err, req, res, _next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return;
  const status = err.status || 500;
  res.status(status).json({ ok:false, error: status === 400 ? 'bad_request' : 'server_error' });
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FF Platform Service listening on :${port}`));
