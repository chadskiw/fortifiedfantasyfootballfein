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

const app = express();
app.disable('x-powered-by');

// If you’re behind a proxy/Cloudflare/Heroku/etc, enable trust proxy so secure cookies work
app.set('trust proxy', 1);

// --- Parsers & infra middlewares
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));

app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());              // <- REQUIRED for /api/fein-auth to read cookies
app.use(corsMiddleware);
app.use(rateLimit);
app.use('/api/image', imageUpsertRouter);    // POST /api/image/upsert  (binary image)
// Request/verify login codes
app.use('/api/identity', identityRouter);// --- ✅ Mount API routers BEFORE any static or SPA fallback
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
