// TRUE_LOCATION: server.js
// IN_USE: TRUE
// server.js
require('dotenv').config();

const express       = require('express');
const morgan        = require('morgan');
const path          = require('path');
const cookieParser  = require('cookie-parser');
const { Pool }      = require('pg');

const imageUpsertRouter = require('./routes/image-upsert');
const identityRouter    = require('./routes/identity-api');
const feinAuthRouter    = require('./routes/fein-auth');
const authRouter        = require('./routes/fein-auth');            // alias used elsewhere
const espnRouter        = require('./routers/espnRouter');
const verifyRouter      = require('./src/routes/verify');           // POST /api/verify

const { corsMiddleware } = require('./src/cors');
const { rateLimit }      = require('./src/rateLimit');
// const platformRouter  = require('./src/routes/platforms');        // (optional, not mounted below)

// ---------- DB ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
});

// quick export for modules that `require('../server')`
module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ---------- Shared helpers ----------
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE  = /^\+?[0-9\-\s().]{7,}$/;
const HANDLE_RE = /^[a-zA-Z0-9_.]{3,24}$/;
const HEX_RE    = /^#?[0-9a-f]{6}$/i;

const EFFECTIVE_WHITE = '#FFFFFF';
const norm        = (v='') => String(v).trim();
const normEmail   = (v='') => norm(v).toLowerCase();
const normPhone   = (v='') => '+' + norm(v).replace(/[^\d]/g, '');
const isEmail     = v => EMAIL_RE.test(norm(v));
const isPhone     = v => PHONE_RE.test(norm(v));
const isHandle    = v => HANDLE_RE.test(norm(v));
const normHex     = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  if (!HEX_RE.test(s)) return null;
  return s.startsWith('#') ? s.toUpperCase() : ('#' + s.toUpperCase());
};

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

// ESPN creds extractor (used by /authcheck; not used as a gate in this file)
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

// ---------- Middlewares (order matters) ----------
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());                 // must be before routes that read cookies
app.use(corsMiddleware);
app.use(rateLimit);

// ---------- Signup/Profile helpers used by FE pages ----------
async function fetchByContactsOnly({ email, phone }) {
  const params = [], conds = [];
  if (email) { params.push(email); conds.push(`LOWER(email)=LOWER($${params.length})`); }
  if (phone) { params.push(phone); conds.push(`phone_e164=$${params.length}`); }
  if (!conds.length) return null;
  const r = await pool.query(`
    SELECT member_id, username, email, phone_e164, color_hex
      FROM ff_member
     WHERE (${conds.join(' OR ')}) AND deleted_at IS NULL
     ORDER BY member_id ASC
     LIMIT 1
  `, params);
  return r.rows[0] || null;
}

async function fetchUsedColorsForHandle(handle) {
  const r = await pool.query(`
    SELECT COALESCE(color_hex, '${EFFECTIVE_WHITE}') AS hex
      FROM ff_member
     WHERE LOWER(username)=LOWER($1) AND deleted_at IS NULL
  `, [handle]);
  return new Set(r.rows.map(x => (x.hex || EFFECTIVE_WHITE).toUpperCase()));
}

function sanitizePalette(pal) {
  if (!Array.isArray(pal)) return [];
  return pal.map(normHex).filter(Boolean).map(x => x.toUpperCase());
}

function pickAvailableColor(requestedHex, usedSet, palette) {
  const req = (requestedHex || EFFECTIVE_WHITE).toUpperCase();
  if (!usedSet.has(req)) return req;
  const poolColors = palette.filter(h => !usedSet.has(h));
  if (poolColors.length) return poolColors[(Math.random() * poolColors.length) | 0];
  return null;
}

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

async function fetchMemberByEmailPhoneOrHandle({ email, phone, handle }) {
  const params = [];
  const conds = [];
  if (email) { params.push(email);  conds.push(`LOWER(email)=LOWER($${params.length})`); }
  if (phone) { params.push(phone);  conds.push(`phone_e164=$${params.length}`); }
  if (handle){ params.push(handle); conds.push(`LOWER(username)=LOWER($${params.length})`); }
  if (!conds.length) return null;
  const r = await pool.query(
    `SELECT member_id, username, email, phone_e164, color_hex
       FROM ff_member
      WHERE ${conds.join(' OR ')}
      ORDER BY member_id ASC
      LIMIT 1`,
    params
  );
  return r.rows[0] || null;
}

async function doLookup(identifier) {
  const raw = norm(identifier);
  if (isEmail(raw)) return await fetchMemberByEmailPhoneOrHandle({ email: normEmail(raw) });
  if (isPhone(raw)) return await fetchMemberByEmailPhoneOrHandle({ phone: normPhone(raw) });
  if (isHandle(raw))return await fetchMemberByEmailPhoneOrHandle({ handle: raw });
  return null;
}

// ---------- Routes (mount each once) ----------

// ESPN auth (legacy alias) + router
app.use('/api/espn-auth', feinAuthRouter);
app.use('/api/platforms/espn', espnRouter);

// Identity API + request-code endpoints (your existing routers)
app.use('/api/identity', identityRouter);
app.use('/api/identity', require('./routes/identity/request-code.js')); // POST /api/identity/request-code

// Verify (server-side anagram flow)
app.use('/api', verifyRouter); // POST /api/verify

// Image upsert
app.use('/api/image', imageUpsertRouter);

// Auth alias
app.use('/api/auth', authRouter);

// ---- Lightweight endpoints used by signup/UX ----
app.get('/api/profile/exists', async (req, res) => {
  try {
    const u = req.query.username || req.query.u || '';
    const hex = normHex(req.query.hex || '');
    const limit = Number(req.query.limit);
    const stats = await handleStats(u);
    const pairTaken = hex ? stats.colors.map(c => (c||'').toLowerCase()).includes(hex) : null;
    const underLimit = Number.isFinite(limit) ? (stats.count < limit) : null;
    res.json({ ok:true, count:stats.count, colors:stats.colors, pairAvailable:(hex ? !pairTaken : null), handleUnderLimit: underLimit });
  } catch { res.status(500).json({ ok:false, error:'server_error' }); }
});

app.get('/api/profile/check-username', async (req, res) => {
  try {
    const u = req.query.u || req.query.username || '';
    const hex = normHex(req.query.hex || '');
    const limit = Number(req.query.limit);
    const stats = await handleStats(u);
    const pairTaken = hex ? stats.colors.map(c => (c||'').toLowerCase()).includes(hex) : null;
    res.json({ ok:true, count:stats.count, colors:stats.colors, pairAvailable:(hex ? !pairTaken : null), handleUnderLimit: Number.isFinite(limit) ? (stats.count < limit) : null });
  } catch { res.status(500).json({ ok:false, error:'server_error' }); }
});

app.get('/api/identity/handle/exists', async (req, res) => {
  try {
    const u = req.query.u || req.query.username || '';
    const hex = normHex(req.query.hex || '');
    const limit = Number(req.query.limit);
    const stats = await handleStats(u);
    const pairTaken = hex ? stats.colors.map(c => (c||'').toLowerCase()).includes(hex) : null;
    res.json({ ok:true, available: Number.isFinite(limit) ? (stats.count < limit) : null, count:stats.count, colors:stats.colors, pairAvailable:(hex ? !pairTaken : null), handleUnderLimit: Number.isFinite(limit) ? (stats.count < limit) : null });
  } catch { res.status(500).json({ ok:false, error:'server_error' }); }
});

app.get('/api/members/find', async (req, res) => {
  try {
    const email = req.query.email && isEmail(req.query.email) ? normEmail(req.query.email) : null;
    const phone = req.query.phone && isPhone(req.query.phone) ? normPhone(req.query.phone) : null;
    if (!email && !phone) return res.status(400).json({ ok:false, error:'bad_request' });
    const member = await fetchMemberByEmailPhoneOrHandle({ email, phone });
    res.json({ member });
  } catch { res.status(500).json({ ok:false, error:'server_error' }); }
});

app.get('/api/members/lookup', async (req, res) => {
  try { res.json({ member: await doLookup(req.query.identifier || '') }); }
  catch { res.status(500).json({ ok:false, error:'server_error' }); }
});
app.post('/api/members/lookup', async (req, res) => {
  try { res.json({ member: await doLookup(req.body?.identifier || '') }); }
  catch { res.status(500).json({ ok:false, error:'server_error' }); }
});

// Aliases
app.get('/api/identity/member/lookup', (req, res, next) => app._router.handle(Object.assign(req, { url:'/api/members/lookup' }), res, next));
app.post('/api/identity/member/lookup', (req, res, next) => app._router.handle(Object.assign(req, { url:'/api/members/lookup' }), res, next));

// Verify starter stub (kept for FE flows)
app.post('/api/verify/start', async (_req, res) => {
  try { res.json({ ok:true, sent:true }); }
  catch { res.status(500).json({ ok:false, error:'server_error' }); }
});

// ESPN authcheck (diagnostic)
app.get('/api/platforms/espn/authcheck', (req, res) => {
  const authed = extractEspnCreds(req);
  res.json({ ok:true, authed });
});

// FEIN Meta quick-patch endpoints
const { upsertFeinMeta, getFeinMetaByKey } = require('./src/db/feinMeta');

app.post('/api/fein-auth/fein/meta/upsert', async (req, res) => {
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

// DB + creds echo
app.get('/api/fein-auth/fein/meta/selftest', async (req, res) => {
  const { Pool } = require('pg');
  try {
    const testPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
    });
    const r = await testPool.query('SELECT 1 AS ok');
    const fromHeaders = { swid: !!req.get('x-espn-swid'), s2: !!req.get('x-espn-s2') };
    const fromCookies = { SWID: /SWID=/.test(req.headers.cookie || ''), espn_s2: /espn_s2=/.test(req.headers.cookie || '') };
    res.json({ ok:true, db:r.rows[0], credsSeen:{ headers: fromHeaders, cookies: fromCookies } });
  } catch (e) {
    res.status(500).json({ ok:false, error:'db_error', code:e.code, message:e.message });
  }
});
// --- Health (place BEFORE static/catch-alls) ---
app.get('/healthz', async (_req, res) => {
  res.set('Cache-Control', 'no-store'); // avoid CDN/browser caching
  try {
    const r = await pool.query('SELECT 1 AS ok');
    res.type('application/json').json({
      ok: true,
      db: r.rows?.[0]?.ok === 1,
      ts: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).type('application/json').json({
      ok: false,
      db: false,
      error: e.message,
      ts: new Date().toISOString()
    });
  }
});

// --- MEMBERS LISTING ENDPOINTS (for faces.js) ---
function toLimit(v, def=96) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(500, n)) : def;
}
function cleanOrder(v) {
  return String(v || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
}

// GET /api/members?limit=96&order=desc
app.get('/api/members', async (req, res) => {
  try {
    const limit = toLimit(req.query.limit);
    const orderSql = cleanOrder(req.query.order);
    const rows = (await pool.query(
      `
      SELECT
        member_id, username, color_hex, email, phone_e164,
        image_key, image_etag, image_format, image_width, image_height, image_version, last_image_at,
        event_count, first_seen_at, last_seen_at
      FROM ff_member
      WHERE deleted_at IS NULL
      ORDER BY last_seen_at ${orderSql}
      LIMIT $1
      `, [limit]
    )).rows;

    res.json({ ok: true, items: rows, limit, order: orderSql.toLowerCase() });
  } catch (e) {
    console.error('[GET /api/members]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

// GET /api/members/recent?limit=96
app.get('/api/members/recent', async (req, res) => {
  try {
    const limit = toLimit(req.query.limit);
    const rows = (await pool.query(
      `
      SELECT
        member_id, username, color_hex, email, phone_e164,
        image_key, image_etag, image_format, image_width, image_height, image_version, last_image_at,
        event_count, first_seen_at, last_seen_at
      FROM ff_member
      WHERE deleted_at IS NULL
      ORDER BY last_seen_at DESC
      LIMIT $1
      `, [limit]
    )).rows;

    res.json({ ok: true, items: rows, limit });
  } catch (e) {
    console.error('[GET /api/members/recent]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});
// then in server.js
app.post('/api/verify/start', async (req, res) => {
  try {
    const { kind, value, code } = req.body || {};
    if (!value || !code) return res.status(400).json({ ok: false, error: 'bad_request' });

    await notificationApi.send({
      notificationId: 'signup-code',
      user: { id: value, email: kind === 'email' ? value : undefined },
      mergeTags: { code },
    });

    res.json({ ok: true, sent: true });
  } catch (e) {
    console.error('[verify/start]', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});
// alias used by some clients: /api/identity/members
app.get('/api/identity/members', (req, res, next) =>
  app._router.handle(Object.assign(req, { url: '/api/members' }), res, next)
);

// ---------- Static AFTER APIs ----------
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

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

// ---------- Health ----------
// app.get('/healthz', (_req, res) => res.json({ ok:true, ts:new Date().toISOString() }));

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FF Platform Service listening on :${port}`));
