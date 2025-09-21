// server.js
// ---------- Boot ----------
require('dotenv').config();

const express      = require('express');
const morgan       = require('morgan');
const path         = require('path');
const cookieParser = require('cookie-parser');
const { Pool }     = require('pg');
const crypto       = require('crypto');

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

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

// ---------- Helpers ----------
function asRouter(mod, name) {
  const candidate = (mod && (mod.router || mod.default || mod));
  if (typeof candidate !== 'function') {
    const keys = candidate && typeof candidate === 'object' ? Object.keys(candidate) : [];
    throw new TypeError(`[${name}] does not export an Express middleware. Got: ${typeof candidate} keys=${keys.join(',')}`);
  }
  return candidate;
}

// Reads/writes the visitor token that keys the invite row
const INVITE_COOKIE = 'ff_interacted';

function getLocale(req) {
  const h = String(req.headers['accept-language'] || '');
  return h.split(',')[0] || null;
}
function getTz(req) {
  return String(req.headers['x-ff-tz'] || '') || null;
}
function makeInteractedCode() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 8).toUpperCase();
}
async function upsertInviteForRequest(req, res) {
  let code = (req.cookies?.[INVITE_COOKIE] || '').trim();
  if (!code) code = makeInteractedCode();

  const ip = String(req.headers['cf-connecting-ip'] || req.ip || '');
  const ipHash = crypto.createHash('sha256').update(ip).digest('hex');

  const landingUrl = String(req.headers['x-ff-landing'] || req.originalUrl || req.url || '');
  const referrer   = String(req.get('referer') || '');
  const ua         = String(req.get('user-agent') || '');
  const locale     = getLocale(req);
  const tz         = getTz(req);

  const { rows } = await pool.query(
    `
    INSERT INTO ff_invite (interacted_code, invited_at, source, medium, campaign,
                           landing_url, referrer, user_agent, ip_hash, locale, tz)
    VALUES ($1, now(), $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (interacted_code) DO UPDATE
      SET landing_url = COALESCE(ff_invite.landing_url, EXCLUDED.landing_url),
          referrer    = COALESCE(ff_invite.referrer,    EXCLUDED.referrer),
          user_agent  = COALESCE(ff_invite.user_agent,  EXCLUDED.user_agent),
          ip_hash     = COALESCE(ff_invite.ip_hash,     EXCLUDED.ip_hash),
          locale      = COALESCE(ff_invite.locale,      EXCLUDED.locale),
          tz          = COALESCE(ff_invite.tz,          EXCLUDED.tz)
    RETURNING invite_id, interacted_code
    `,
    [
      code,
      req.query.source || null,
      req.query.medium || null,
      req.query.campaign || null,
      landingUrl || null,
      referrer || null,
      ua || null,
      ipHash || null,
      locale || null,
      tz || null,
    ]
  );

  const invite = rows[0];
  if (!req.cookies?.[INVITE_COOKIE]) {
    res.cookie(INVITE_COOKIE, invite.interacted_code, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 1000 * 60 * 60 * 24 * 365, // 1y
    });
  }
  return invite;
}

// Validate to known table names to avoid injection
const SPORT_TABLES = new Set(['ff_sport_ffl','ff_sport_flb','ff_sport_fba','ff_sport_fhl']);

async function ensureNumCode(pool, charCode) {
  // Try existing
  const ex = await pool.query('SELECT num_code FROM ff_sport_code_map WHERE char_code=$1', [charCode]);
  if (ex.rows[0]) return ex.rows[0].num_code;

  // Assign next index+1
  const nx = await pool.query('SELECT COALESCE(MAX(num_code),0)+1 AS n FROM ff_sport_code_map');
  const numCode = nx.rows[0].n;
  await pool.query(
    'INSERT INTO ff_sport_code_map (char_code, num_code) VALUES ($1,$2) ON CONFLICT (char_code) DO NOTHING',
    [charCode, numCode]
  );
  return numCode;
}

async function refreshSportCatalog(pool, {
  tableName,          // 'ff_sport_ffl' | ...
  charCode,           // 'ffl'
  season              // 2025
}) {
  if (!SPORT_TABLES.has(tableName)) throw new Error('invalid sport table');
  const numCode = await ensureNumCode(pool, charCode);

  // COUNTs for this season inside the per-sport table
  // (sid is PK there; still use DISTINCT for safety)
  const q = `
    SELECT
      COUNT(*)::int                              AS total_count,
      COUNT(DISTINCT sid)::int                   AS unique_sid_count,
      COUNT(DISTINCT member_id)::int             AS unique_member_count
    FROM ${tableName}
    WHERE season = $1
  `;
  const { rows:[stats] } = await pool.query(q, [season]);

  // Upsert into catalog
  await pool.query(`
    INSERT INTO ff_sport (
      char_code, season, num_code, total_count, unique_sid_count, unique_member_count, table_name
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (char_code, season) DO UPDATE
      SET total_count         = EXCLUDED.total_count,
          unique_sid_count    = EXCLUDED.unique_sid_count,
          unique_member_count = EXCLUDED.unique_member_count,
          num_code            = EXCLUDED.num_code,         -- stays stable
          table_name          = EXCLUDED.table_name,
          last_seen_at        = now()
  `, [charCode, season, numCode,
      stats.total_count || 0, stats.unique_sid_count || 0, stats.unique_member_count || 0,
      tableName
  ]);
}


// Normalizers / validators
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE  = /^\+?[0-9\-\s().]{7,}$/;
const HANDLE_RE = /^[a-zA-Z0-9_.]{3,24}$/;
const HEX_RE    = /^#?[0-9a-f]{6}$/i;

const norm      = (v='') => String(v).trim();
const normEmail = (v='') => norm(v).toLowerCase();
const normPhone = (v='') => '+' + norm(v).replace(/[^\d]/g, '');
const isEmail   = v => EMAIL_RE.test(norm(v));
const isPhone   = v => PHONE_RE.test(norm(v));
const isHandle  = v => HANDLE_RE.test(norm(v));
const normHex   = (v) => {
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

// ---------- Core Middlewares (order matters) ----------
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser()); // before routes that read cookies
app.use(express.urlencoded({ extended: true }));

// Custom CORS + rate limit
const { corsMiddleware } = require('./src/cors');
const { rateLimit }      = require('./src/rateLimit');
app.use(corsMiddleware);
app.use(rateLimit);

// ---------- DB helpers for identity ----------
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
  if (isEmail(raw))  return await fetchMemberByEmailPhoneOrHandle({ email: normEmail(raw) });
  if (isPhone(raw))  return await fetchMemberByEmailPhoneOrHandle({ phone: normPhone(raw) });
  if (isHandle(raw)) return await fetchMemberByEmailPhoneOrHandle({ handle: raw });
  return null;
}

// ---------- Routers (normalized) ----------
const imageUpsertRouter  = asRouter(require('./routes/image-upsert'), 'routes/image-upsert');
const identityRouter     = asRouter(require('./routes/identity-api'), 'routes/identity-api');
const feinAuthRouter     = asRouter(require('./routes/fein-auth'), 'routes/fein-auth');
const authRouter         = feinAuthRouter; // alias
const espnRouter         = asRouter(require('./routers/espnRouter'), 'routers/espnRouter');
const verifyRouter       = asRouter(require('./src/routes/verify'), 'src/routes/verify');
const handleLoginRouter  = asRouter(require('./routes/identity/handle-login.js'), 'routes/identity/handle-login');
const contactsRouter     = asRouter(require('./routes/identity/contacts'), 'routes/identity/contacts');
const espnIngestRouter = require('./src/routes/espn-injest.js')(pool);
app.use('/api/platforms/espn', espnIngestRouter);

// ---------- Mounted Routers ----------
app.use('/api/espn-auth', feinAuthRouter);
app.use('/api/platforms/espn', espnRouter);

app.use('/api/identity', identityRouter);
app.use('/api/identity', handleLoginRouter);
app.use('/api/identity', contactsRouter);

app.use('/api', verifyRouter);                 // POST /api/verify
app.use('/api/image', imageUpsertRouter);
app.use('/api/auth', authRouter);

// ---------- Lightweight identity/UX endpoints ----------
app.get('/api/identity/handle/trust', async (req, res) => {
  try {
    const uParam  = String(req.query.u || '').trim();
    const hexParam = String(req.query.hex || '').trim();
    if (!uParam) return res.status(400).json({ ok:false, error:'bad_request' });

    const memberId = req.cookies?.ff_member || '';
    let trusted = false;

    if (memberId) {
      const r = await pool.query(
        `SELECT username, color_hex FROM ff_member
         WHERE member_id = $1 AND deleted_at IS NULL
         LIMIT 1`,
        [memberId]
      );
      const row = r.rows[0];
      if (row && row.username && row.username.toLowerCase() === uParam.toLowerCase()) {
        if (!hexParam || (row.color_hex || '').toLowerCase() === hexParam.toLowerCase()) {
          trusted = true;
        }
      }
    } else if (req.cookies?.ff_interacted) {
      const code = req.cookies.ff_interacted;
      const r = await pool.query(
        `SELECT first_identifier FROM ff_invite WHERE interacted_code = $1 LIMIT 1`,
        [code]
      );
      const row = r.rows[0];
      if (row && row.first_identifier && row.first_identifier.toLowerCase() === uParam.toLowerCase()) {
        trusted = true;
      }
    }

    res.json({ ok:true, trusted });
  } catch (e) {
    console.error('[GET /api/identity/handle/trust]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

app.get('/api/profile/exists', async (req, res) => {
  try {
    const u    = req.query.username || req.query.u || '';
    const hex  = normHex(req.query.hex || '');
    const limit = Number(req.query.limit);
    const stats = await handleStats(u);
    const pairTaken  = hex ? stats.colors.map(c => (c||'').toLowerCase()).includes((hex||'').toLowerCase()) : null;
    const underLimit = Number.isFinite(limit) ? (stats.count < limit) : null;
    res.json({ ok:true, count:stats.count, colors:stats.colors, pairAvailable:(hex ? !pairTaken : null), handleUnderLimit: underLimit });
  } catch { res.status(500).json({ ok:false, error:'server_error' }); }
});

app.get('/api/profile/check-username', async (req, res) => {
  try {
    const u    = req.query.u || req.query.username || '';
    const hex  = normHex(req.query.hex || '');
    const limit = Number(req.query.limit);
    const stats = await handleStats(u);
    const pairTaken  = hex ? stats.colors.map(c => (c||'').toLowerCase()).includes((hex||'').toLowerCase()) : null;
    res.json({ ok:true, count:stats.count, colors:stats.colors, pairAvailable:(hex ? !pairTaken : null), handleUnderLimit: Number.isFinite(limit) ? (stats.count < limit) : null });
  } catch { res.status(500).json({ ok:false, error:'server_error' }); }
});

app.get('/api/identity/handle/exists', async (req, res) => {
  try {
    const u    = req.query.u || req.query.username || '';
    const hex  = normHex(req.query.hex || '');
    const limit = Number(req.query.limit);
    const stats = await handleStats(u);
    const pairTaken  = hex ? stats.colors.map(c => (c||'').toLowerCase()).includes((hex||'').toLowerCase()) : null;
    res.json({ ok:true, available: Number.isFinite(limit) ? (stats.count < limit) : null, count:stats.count, colors:stats.colors, pairAvailable:(hex ? !pairTaken : null), handleUnderLimit: Number.isFinite(limit) ? (stats.count < limit) : null });
  } catch { res.status(500).json({ ok:false, error:'server_error' }); }
});

// Members find (email/phone explicit)
app.get('/api/members/find', async (req, res) => {
  try {
    const email = req.query.email && isEmail(req.query.email) ? normEmail(req.query.email) : null;
    const phone = req.query.phone && isPhone(req.query.phone) ? normPhone(req.query.phone) : null;
    if (!email && !phone) return res.status(400).json({ ok:false, error:'bad_request' });
    const member = await fetchMemberByEmailPhoneOrHandle({ email, phone });
    res.json({ member });
  } catch { res.status(500).json({ ok:false, error:'server_error' }); }
});

// Members lookup (identifier ← email|phone|handle) — single source of truth + alias
async function membersLookupByIdentifier(req, res) {
  try {
    const id = (req.method === 'GET' ? req.query.identifier : req.body?.identifier) || '';
    const member = await doLookup(id);
    return res.json({ ok: true, member });
  } catch (e) {
    console.error('[members.lookup]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
}
app.get('/api/members/lookup', membersLookupByIdentifier);
app.post('/api/members/lookup', membersLookupByIdentifier);
app.get('/api/identity/member/lookup', membersLookupByIdentifier);
app.post('/api/identity/member/lookup', membersLookupByIdentifier);

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
  res.set('Cache-Control', 'no-store');
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

// --- Members listing (for faces.js) ---
function toLimit(v, def=96) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(1, Math.min(500, n)) : def;
}
function cleanOrder(v) {
  return String(v || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
}

async function listRecentMembersHandler(req, res) {
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
}
async function listMembersHandler(req, res) {
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
}

app.get('/api/members', listMembersHandler);
app.get('/api/identity/members', listMembersHandler);
app.get('/api/members/recent', listRecentMembersHandler);
app.get('/api/identity/members/recent', listRecentMembersHandler);

// --- OPTIONS helpers for common endpoints (preflight) ---
const allow = {
  'access-control-allow-origin': 'https://fortifiedfantasy.com',
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'Content-Type,Authorization,x-espn-swid,x-espn-s2,x-fein-key',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-max-age': '600',
};
app.options(
  [
    '/api/members/lookup',
    '/api/identity/member/lookup',
    '/api/members',
    '/api/identity/members',
    '/api/members/recent',
    '/api/identity/members/recent',
  ],
  (req, res) => res.set(allow).sendStatus(204)
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

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FF Platform Service listening on :${port}`));
