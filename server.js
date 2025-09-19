// server.js
require('dotenv').config();
const express = require('express');

const morgan  = require('morgan');
const path    = require('path');
const imageUpsertRouter = require('./routes/image-upsert');
const identityRouter    = require('./routes/identity-api');
const cookieParser = require('cookie-parser');

const { corsMiddleware } = require('./src/cors');
const { rateLimit }      = require('./src/rateLimit');
const platformRouter     = require('./src/routes/platforms');
const espnRouter         = require('./routers/espnRouter');
const feinAuthRouter     = require('./routes/fein-auth');
const authRouter     = require('./routes/fein-auth');
// ----- QUICK PATCH: identity/profile/members endpoints used by signup flows -----
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
// If some clients still hit /api/espn-auth, route them to the same handler as /api/fein-auth
app.use('/api/espn-auth', feinAuthRouter);

// Tiny helpers (keep in server.js for now)
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const PHONE_RE  = /^\+?[0-9\-\s().]{7,}$/;
const HANDLE_RE = /^[a-zA-Z0-9_.]{3,24}$/;

const norm = (v='') => String(v).trim();
const normEmail = (v='') => norm(v).toLowerCase();
const normPhone = (v='') => '+' + norm(v).replace(/[^\d]/g, '');
const isEmail = v => EMAIL_RE.test(norm(v));
const isPhone = v => PHONE_RE.test(norm(v));
const isHandle= v => HANDLE_RE.test(norm(v));

// ---- Username availability (three aliases -> same impl)
async function usernameTaken(username) {
  const u = norm(username);
  if (!isHandle(u)) return false; // treat bad shapes as "not taken"
  const q = `SELECT 1 FROM ff_member WHERE LOWER(username)=LOWER($1) LIMIT 1`;
  const r = await pool.query(q, [u]);
  return r.rowCount > 0;
}

app.get('/api/profile/exists', async (req, res) => {
  try {
    const taken = await usernameTaken(req.query.username || '');
    return res.json({ exists: taken });
  } catch (e) { return res.status(500).json({ ok:false, error:'server_error' }); }
});
app.get('/api/profile/check-username', async (req, res) => {
  try {
    const taken = await usernameTaken(req.query.u || '');
    return res.json({ ok: true, taken });
  } catch (e) { return res.status(500).json({ ok:false, error:'server_error' }); }
});
app.get('/api/identity/handle/exists', async (req, res) => {
  try {
    const taken = await usernameTaken(req.query.u || '');
    return res.json({ available: !taken });
  } catch (e) { return res.status(500).json({ ok:false, error:'server_error' }); }
});

// ---- Member find / lookup
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

app.get('/api/members/find', async (req, res) => {
  try {
    const email = req.query.email && isEmail(req.query.email) ? normEmail(req.query.email) : null;
    const phone = req.query.phone && isPhone(req.query.phone) ? normPhone(req.query.phone) : null;
    if (!email && !phone) return res.status(400).json({ ok:false, error:'bad_request' });
    const member = await fetchMemberByEmailPhoneOrHandle({ email, phone });
    return res.json({ member });
  } catch (e) { return res.status(500).json({ ok:false, error:'server_error' }); }
});

async function doLookup(identifier) {
  const raw = norm(identifier);
  if (isEmail(raw)) return await fetchMemberByEmailPhoneOrHandle({ email: normEmail(raw) });
  if (isPhone(raw)) return await fetchMemberByEmailPhoneOrHandle({ phone: normPhone(raw) });
  if (isHandle(raw)) return await fetchMemberByEmailPhoneOrHandle({ handle: raw });
  return null;
}

app.get('/api/members/lookup', async (req, res) => {
  try { return res.json({ member: await doLookup(req.query.identifier || '') }); }
  catch (e) { return res.status(500).json({ ok:false, error:'server_error' }); }
});
app.post('/api/members/lookup', async (req, res) => {
  try { return res.json({ member: await doLookup(req.body?.identifier || '') }); }
  catch (e) { return res.status(500).json({ ok:false, error:'server_error' }); }
});
// identity aliases
app.get('/api/identity/member/lookup', (req, res, next) => app._router.handle(Object.assign(req, { url:'/api/members/lookup' }), res, next));
app.post('/api/identity/member/lookup', (req, res, next) => app._router.handle(Object.assign(req, { url:'/api/members/lookup' }), res, next));

// ---- Upsert used by signup page (three aliases)
async function upsertFromSignup({ handle, hex, primary_contact }) {
  const handleVal = isHandle(handle) ? handle : null;
  const emailVal  = isEmail(primary_contact) ? normEmail(primary_contact) : null;
  const phoneVal  = (!emailVal && isPhone(primary_contact)) ? normPhone(primary_contact) : null;

  // Try to locate an existing member by handle/email/phone
  const existing = await fetchMemberByEmailPhoneOrHandle({
    email: emailVal, phone: phoneVal, handle: handleVal
  });

  if (existing) {
    await pool.query(
      `UPDATE ff_member
          SET username   = COALESCE($1, username),
              email      = COALESCE($2, email),
              phone_e164 = COALESCE($3, phone_e164),
              color_hex  = COALESCE($4, color_hex),
              last_seen_at = NOW()
        WHERE member_id = $5`,
      [handleVal, emailVal, phoneVal, hex || null, existing.member_id]
    );
    return { ok: true, member_id: existing.member_id, updated: true };
  }

// INSERT (use column default only when hex is missing)
let r;
if (hex) {
  r = await pool.query(
    `INSERT INTO ff_member (username, email, phone_e164, color_hex, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,NOW(),NOW())
     RETURNING member_id`,
    [handleVal, emailVal, phoneVal, hex]
  );
} else {
  r = await pool.query(
    `INSERT INTO ff_member (username, email, phone_e164, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,NOW(),NOW())
     RETURNING member_id`,
    [handleVal, emailVal, phoneVal]
  );
}
return { ok: true, member_id: r.rows[0].member_id, created: true };
}

async function handleSignupUpsert(req, res) {
  try {
    if (!req.is('application/json')) return res.status(415).json({ ok:false, error:'unsupported_media_type' });
    const { handle, hex, primary_contact } = req.body || {};
    if (!handle && !primary_contact) return res.status(400).json({ ok:false, error:'bad_request' });
    const result = await upsertFromSignup({ handle, hex, primary_contact });
    return res.json(result);
  } catch (e) { return res.status(500).json({ ok:false, error:'server_error' }); }
}

app.post('/api/members/upsert', handleSignupUpsert);
app.post('/api/profile/update', handleSignupUpsert);
app.post('/api/identity/signup', handleSignupUpsert);

// ---- Verification starter (email/SMS) — stubbed success so UI can proceed
app.post('/api/verify/start', async (req, res) => {
  try {
    // In production, enqueue email/SMS here; for now just 200 OK
    return res.json({ ok: true, sent: true });
  } catch (e) { return res.status(500).json({ ok:false, error:'server_error' }); }
});

// ----- END QUICK PATCH -----


const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};



// (Optional) light gate so headers are present for ESPN platform routes only
const requireEspnHeaders = (req, res, next) =>
  (!req.get('x-espn-swid') || !req.get('x-espn-s2'))
    ? res.status(401).json({ ok:false, error:'Missing x-espn-swid or x-espn-s2' })
    : next();



// If you’re behind a proxy/Cloudflare/Heroku/etc, enable trust proxy so secure cookies work
// in server.js (once)
// --- Parsers & infra middlewares
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));

app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());              // <- REQUIRED for /api/fein-auth to read cookies
app.use(corsMiddleware);
app.use(rateLimit);
app.use('/api/image', imageUpsertRouter);    // POST /api/image/upsert  (binary image)
// Request/verify login codes  --- ✅ Mount BEFORE any static
app.use('/api/identity', require('./routes/identity/request-code.js'));
app.use('/api/fein-auth', feinAuthRouter);     
// server.js
app.use('/api/auth', authRouter);

            // same-origin cookie endpoints + meta upsert
app.use('/api/platforms/espn', requireEspnHeaders, espnRouter);
// If/when you restore other platforms aggregate router:
// app.use('/api/platforms', platformRouter);

// --- Static AFTER APIs (so /api/* never hits the static handler)
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));
// --- Quick-patch endpoints (bypass router wiring for now)

// --- JSON 404 for API paths (optional, nicer DX)
app.use('/api', (req, res, next) => {
  if (res.headersSent) return next();
  return res.status(404).json({ ok:false, error:'not_found', path:req.originalUrl });
});

// --- JSON error handler (prevents HTML 'Error' pages)
// keep this as the LAST middleware
app.use((err, req, res, _next) => {
  console.error('[unhandled]', err);
  if (res.headersSent) return;
  const status = err.status || 500;
  res.status(status).json({ ok:false, error: status === 400 ? 'bad_request' : 'server_error' });
});

const { upsertFeinMeta, getFeinMetaByKey } = require('./src/db/feinMeta');

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
  try {
    const v = decodeURIComponent(raw);
    // Ensure braces; ESPN expects {UUID}
    if (!/^\{[0-9A-F-]{36}\}$/i.test(v) && /^\w/.test(v)) {
      const n = v.replace(/^\{?/, '{').replace(/\}?$/, '}');
      return n;
    }
    return v;
  } catch { return raw; }
}

// POST /api/fein-auth/fein/meta/upsert
app.post('/api/fein-auth/fein/meta/upsert', async (req, res) => {
  try {
    const season    = Number(req.body?.season);
    const platform  = String(req.body?.platform || '').toLowerCase();
    const league_id = String(req.body?.league_id || '').trim();
    const team_id   = String(req.body?.team_id || '').trim();

    if (!season || !platform || !league_id || !team_id) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    if (platform !== 'espn') {
      return res.status(400).json({ ok: false, error: 'platform must be "espn"' });
    }

    const cookies = readCookiesHeader(req.headers.cookie || '');
    const swidHdr = req.get('x-espn-swid') || req.body?.swid || cookies.SWID || '';
    const s2Hdr   = req.get('x-espn-s2')   || req.body?.s2   || cookies.espn_s2 || '';

    const swid = normalizeSwid(swidHdr.trim());
    const s2   = decodeURIComponent((s2Hdr || '').trim());

    if (!swid || !s2) {
      return res.status(400).json({ ok: false, error: 'Missing swid/s2 credentials' });
    }

    const row = await upsertFeinMeta({
      season, platform, league_id, team_id,
      name: null, handle: null, league_size: null, fb_groups: null,
      swid, espn_s2: s2,
    });

    return res.status(200).json({ ok: true, row });
  } catch (err) {
    console.error('[quickpatch upsert] error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// GET /api/fein-auth/fein/meta/row?season=2025&platform=espn&leagueId=...&teamId=...
app.get('/api/fein-auth/fein/meta/row', async (req, res) => {
  try {
    const season    = Number(req.query.season);
    const platform  = String(req.query.platform || '').toLowerCase();
    const league_id = String(req.query.leagueId || '').trim();
    const team_id   = String(req.query.teamId || '').trim();

    if (!season || !platform || !league_id || !team_id) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    const row = await getFeinMetaByKey({ season, platform, league_id, team_id });
    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });

    return res.json({ ok: true, row });
  } catch (err) {
    console.error('[quickpatch get row] error', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});
// --- Diagnostics (DB + creds echo)
app.get('/api/fein-auth/fein/meta/selftest', async (req, res) => {
  const { Pool } = require('pg');
  try {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
    });
    const r = await pool.query('SELECT 1 AS ok');
    const fromHeaders = { swid: !!req.get('x-espn-swid'), s2: !!req.get('x-espn-s2') };
    const fromCookies = { SWID: /SWID=/.test(req.headers.cookie || ''), espn_s2: /espn_s2=/.test(req.headers.cookie || '') };
    res.json({ ok: true, db: r.rows[0], credsSeen: { headers: fromHeaders, cookies: fromCookies } });
  } catch (e) {
    res.status(500).json({ ok:false, error:'db_error', code: e.code, message: e.message });
  }
});



// --- Health
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// --- Start
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`FF Platform Service listening on :${port}`));
