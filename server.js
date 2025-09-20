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
const verifyRouter = require('./src/routes/verify');

// ----- QUICK PATCH: identity/profile/members endpoints used by signup flows -----
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
// If some clients still hit /api/espn-auth, route them to the same handler as /api/fein-auth
app.use('/api', verifyRouter);
app.use('/api/espn-auth', feinAuthRouter);
// ... later, with other app.use()
app.use('/api/identity', signupEmailRouter); // POST /api/identity/signup-email
app.use('/api', verifyRouter);               // POST /api/verify
const HEX_RE = /^#?[0-9a-f]{6}$/i;
const normHex = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  if (!HEX_RE.test(s)) return null;
  return s.startsWith('#') ? s.toUpperCase() : ('#' + s.toUpperCase());
};
const EFFECTIVE_WHITE = '#FFFFFF';
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
  return new Set(r.rows.map(x => x.hex.toUpperCase()));
}
function sanitizePalette(pal) {
  if (!Array.isArray(pal)) return [];
  return pal
    .map(normHex)
    .filter(Boolean)
    .map(x => x.toUpperCase());
}

function pickAvailableColor(requestedHex, usedSet, palette) {
  // 1) if requested is free, use it
  const req = (requestedHex || EFFECTIVE_WHITE).toUpperCase();
  if (!usedSet.has(req)) return req;

  // 2) else pick a random color from the palette that isn’t used
  const pool = palette.filter(h => !usedSet.has(h));
  if (pool.length) {
    return pool[(Math.random() * pool.length) | 0];
  }

  // 3) none available
  return null;
}


// Handle usage stats (no hard limits here)
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
    const u = req.query.username || req.query.u || '';
    const hex = normHex(req.query.hex || '');
    const limit = Number(req.query.limit);
    const stats = await handleStats(u);

    const pairTaken = hex ? stats.colors.map(c => (c||'').toLowerCase())
                                    .includes(hex) : null;
    const underLimit = Number.isFinite(limit) ? (stats.count < limit) : null;

    return res.json({
      ok: true,
      count: stats.count,
      colors: stats.colors,       // array of hex strings already in use for this handle
      pairAvailable: (hex ? !pairTaken : null),
      handleUnderLimit: underLimit
    });
  } catch { return res.status(500).json({ ok:false, error:'server_error' }); }
});
app.get('/api/profile/check-username', async (req, res) => {
  try {
    const u = req.query.u || req.query.username || '';
    const hex = normHex(req.query.hex || '');
    const limit = Number(req.query.limit);
    const stats = await handleStats(u);
    const pairTaken = hex ? stats.colors.map(c => (c||'').toLowerCase()).includes(hex) : null;

    return res.json({
      ok: true,
      count: stats.count,
      colors: stats.colors,
      pairAvailable: (hex ? !pairTaken : null),
      handleUnderLimit: Number.isFinite(limit) ? (stats.count < limit) : null
    });
  } catch { return res.status(500).json({ ok:false, error:'server_error' }); }
});
app.get('/api/identity/handle/exists', async (req, res) => {
  try {
    const u = req.query.u || req.query.username || '';
    const hex = normHex(req.query.hex || '');
    const limit = Number(req.query.limit);
    const stats = await handleStats(u);
    const pairTaken = hex ? stats.colors.map(c => (c||'').toLowerCase()).includes(hex) : null;

    return res.json({
      ok: true,
      available: Number.isFinite(limit) ? (stats.count < limit) : null, // legacy shape
      count: stats.count,
      colors: stats.colors,
      pairAvailable: (hex ? !pairTaken : null),
      handleUnderLimit: Number.isFinite(limit) ? (stats.count < limit) : null
    });
  } catch { return res.status(500).json({ ok:false, error:'server_error' }); }
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
async function fetchByHandleColor(username, colorHex) {
  if (!isHandle(username)) return null;
  const hex = normHex(colorHex);
  if (!hex) return null;
  const r = await pool.query(
    `SELECT member_id, username, color_hex, email, phone_e164
       FROM ff_member
      WHERE deleted_at IS NULL
        AND LOWER(username)=LOWER($1)
        AND LOWER(color_hex)=LOWER($2)
      LIMIT 1`,
    [username, hex]
  );
  return r.rows[0] || null;
}

async function upsertFromSignupSmart({
  handle,
  hex,                   // optional requested hex
  primary_contact,       // email or phone
  palette,               // optional array of hex from client
  max_per_handle = 10,   // client may override (e.g., 5 or 10)
}) {
  const handleVal = isHandle(handle) ? handle : null;
  const emailVal  = isEmail(primary_contact) ? normEmail(primary_contact) : null;
  const phoneVal  = (!emailVal && isPhone(primary_contact)) ? normPhone(primary_contact) : null;
  const requested = normHex(hex); // may be null -> treated as #FFFFFF later
  const pal = sanitizePalette(palette);

  if (!handleVal && !emailVal && !phoneVal) {
    return { ok:false, error:'bad_request' };
  }

  // 1) If we already know this user by contact, *update that member* (do not create duplicates).
  if (emailVal || phoneVal) {
    const existingByContact = await fetchByContactsOnly({ email: emailVal, phone: phoneVal });
    if (existingByContact) {
      const chosenHex = requested || existingByContact.color_hex || EFFECTIVE_WHITE;
      await pool.query(
        `UPDATE ff_member
           SET username     = COALESCE($1, username),
               color_hex    = COALESCE($2, color_hex),
               last_seen_at = NOW()
         WHERE member_id = $3`,
        [handleVal, chosenHex, existingByContact.member_id]
      );
      return {
        ok: true,
        member_id: existingByContact.member_id,
        created: false,
        updated: true,
        username: handleVal || existingByContact.username,
        color_hex: chosenHex,
        login_valid: true
      };
    }
  }

  // 2) New member path. We allow same handle with different color.
  //    Enforce "max per handle" (client-driven). We count existing rows for that handle.
  let handleCount = 0;
  if (handleVal) {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c
         FROM ff_member
        WHERE LOWER(username)=LOWER($1) AND deleted_at IS NULL`,
      [handleVal]
    );
    handleCount = r.rows[0].c || 0;
  }

  if (handleVal && handleCount >= max_per_handle) {
    // We still *insert* (per your ask), but mark login invalid so the UI can gate
    // and you can decide whether to purge/merge later.
    const chosenHex = requested || EFFECTIVE_WHITE;
    const ins = await pool.query(
      `INSERT INTO ff_member (username, email, phone_e164, color_hex, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,NOW(),NOW())
       RETURNING member_id, username, color_hex`,
      [handleVal, emailVal, phoneVal, chosenHex]
    );
    const row = ins.rows[0];
    return { ok:true, member_id: row.member_id, created:true, username: row.username, color_hex: row.color_hex, login_valid: false, reason:'handle_capacity' };
  }

  // 3) pick a color that isn't already used for this handle (NULL counts as #FFFFFF)
  let finalHex = EFFECTIVE_WHITE;
  if (handleVal) {
    const used = await fetchUsedColorsForHandle(handleVal);
    const pick = pickAvailableColor(requested, used, pal);
    if (pick) {
      finalHex = pick;
    } else {
      // No colors available (palette spacing exhausted) — insert anyway but return login_valid:false
      finalHex = requested || EFFECTIVE_WHITE;
      const ins = await pool.query(
        `INSERT INTO ff_member (username, email, phone_e164, color_hex, first_seen_at, last_seen_at)
         VALUES ($1,$2,$3,$4,NOW(),NOW())
         RETURNING member_id, username, color_hex`,
        [handleVal, emailVal, phoneVal, finalHex]
      );
      const row = ins.rows[0];
      return { ok:true, member_id: row.member_id, created:true, username: row.username, color_hex: row.color_hex, login_valid:false, reason:'no_color_available' };
    }
  } else {
    // no handle; just honor requested/default color
    finalHex = requested || EFFECTIVE_WHITE;
  }

  // 4) Normal insert (color is free)
  const r = await pool.query(
    `INSERT INTO ff_member (username, email, phone_e164, color_hex, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,NOW(),NOW())
     RETURNING member_id, username, color_hex`,
    [handleVal, emailVal, phoneVal, finalHex]
  );
  const row = r.rows[0];
  return { ok:true, member_id: row.member_id, created:true, username: row.username, color_hex: row.color_hex, login_valid:true };
}


async function handleSignupUpsert(req, res) {
  try {
    if (!req.is('application/json')) return res.status(415).json({ ok:false, error:'unsupported_media_type' });

    const {
      handle,
      hex,                 // optional single color request
      primary_contact,     // email or phone
      palette,             // optional array of hex strings from the frontend
      max_per_handle,      // optional int (frontend controls, e.g. 5 or 10)
    } = req.body || {};

    if (!handle && !primary_contact) {
      return res.status(400).json({ ok:false, error:'bad_request' });
    }

    const out = await upsertFromSignupSmart({
      handle,
      hex,
      primary_contact,
      palette,
      max_per_handle: Number.isInteger(max_per_handle) ? Math.max(1, max_per_handle) : 10,
    });

    return res.status(out.ok ? 200 : 400).json(out);
  } catch (e) {
    console.error('[signup upsert]', e);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
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
app.get('/api/diag/egress', async (_req, res) => {
  try {
    const r4 = await fetch('https://api.ipify.org?format=json').then(r=>r.json());
    const r6 = await fetch('https://api64.ipify.org?format=json').then(r=>r.json()).catch(()=>null);
    res.json({ egress_ipv4: r4?.ip || null, egress_ipv6: r6?.ip || null });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// server.js
app.get('/api/identity/status', async (_req, res) => {
  // If you have a session-auth user, look them up; otherwise return false.
  // For now we'll just reflect "verified" if either timestamp is set.
  try {
    // TODO: wire this to your session/user resolution if available
    // const member = await getCurrentMember(_req); // <- your implementation
    const member = null; // fallback: treat as unverified
    const verified = !!(member?.email_verified_at || member?.phone_verified_at);
    res.json({ ok:true, verified });
  } catch {
    res.json({ ok:true, verified:false });
  }
});

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
// server.js (top, near other helpers)
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
  // 1) custom headers (bookmarklet / FEIN client can send them)
  const swidH = req.get('x-espn-swid') || '';
  const s2H   = req.get('x-espn-s2')   || '';
  // 2) your own domain cookies (set by /api/fein-auth or /api/espn-auth)
  const c     = req.cookies?.ff_espn_swid ? req.cookies : readCookiesHeader(req.headers.cookie || '');
  const swidC = c.ff_espn_swid || c.SWID || '';
  const s2C   = c.ff_espn_s2   || c.espn_s2 || c.ESPN_S2 || '';

  const swid = normalizeSwid(swidH || swidC);
  const s2   = (s2H || s2C || '').trim();
  if (swid && s2) {
    req.espn = { swid, s2 };     // attach for downstream router
    return true;
  }
  return false;
}






// If you’re behind a proxy/Cloudflare/Heroku/etc, enable trust proxy so secure cookies work
// in server.js (once)
// --- Parsers & infra middlewares
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));

app.use(express.urlencoded({ extended: true }));
// server.js
app.use('/api/platforms/espn', espnRouter);

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
// server.js (after espnRouter mount is fine)
app.get('/api/platforms/espn/authcheck', (req, res) => {
  const authed = extractEspnCreds(req);
  res.json({ ok: true, authed });
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
