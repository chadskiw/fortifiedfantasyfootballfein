// routes/fein-auth.js
// CommonJS; keeps your existing endpoints and adds same-origin auth cookie flows
// Requires: app has cookie-parser middleware mounted

const express = require('express');
const { query } = require('../src/db');
const { readAuthFromRequest } = require('../auth');

const router = express.Router();
const WRITE_KEY = (process.env.FEIN_AUTH_KEY || '').trim();

/* ----------------------------- small utils ------------------------------ */
const ok   = (res, data) => res.json({ ok: true, ...data });
const bad  = (res, msg)  => res.status(400).json({ ok: false, error: msg || 'Bad request' });
const boom = (res, err)  => res.status(500).json({ ok: false, error: String(err?.message || err) });

const s = v => (v == null ? '' : String(v));
const n = v => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const dedup = arr => Array.from(new Set((arr || []).flat().map(x => s(x).trim()).filter(Boolean)));

/* ---------- ID helpers: build 21-char team id (season+platform+league+team) ---------- */
function padLeagueId12(leagueId) {
  const t = s(leagueId);
  return t.length >= 12 ? t.slice(0, 12) : t.padEnd(12, '0'); // RIGHT pad with 0s
}
function padTeamId2(teamId) {
  const t = s(teamId);
  return t.length >= 2 ? t.slice(-2) : t.padStart(2, '0'); // LEFT pad to 2
}
/**
 * platformCode: 3 digits as string, e.g. ESPN=018, Sleeper=016
 * If not provided, we try to infer ESPN (018) when SWID/S2 present, else '000'.
 */
function normalizePlatform3(platformCode, { swid, s2 } = {}) {
  const p = s(platformCode).replace(/\D+/g, '');
  if (p) return p.padStart(3, '0').slice(-3);
  if (swid && s2) return '018'; // naive inference: ESPN cookies present
  return '000';
}
function buildTeamId({ season, platformCode, leagueId, teamId }) {
  const yyyy = s(season).padStart(4, '0').slice(-4);
  const plat = normalizePlatform3(platformCode);
  const L = padLeagueId12(leagueId);
  const T = padTeamId2(teamId);
  return `${yyyy}${plat}${L}${T}`; // 4 + 3 + 12 + 2 = 21
}

// Short, non-guessable public id (user-level, per SWID; minted on first upsert)
function makePublicId() {
  return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function ensureBracedSWID(v) {
  const t = s(v).trim();
  if (!t) return '';
  if (/^\{.*\}$/.test(t)) return t.toUpperCase();
  return `{${t.replace(/^\{|\}$/g, '').toUpperCase()}}`;
}
const cleanS2 = v => s(v).trim();

/* --------------------------- cookie helpers ----------------------------- */
// NOTE: In dev over http, set SECURE_COOKIES=false
const SECURE_COOKIES = String(process.env.SECURE_COOKIES ?? 'true') !== 'false';
const ONE_YEAR = 1000 * 60 * 60 * 24 * 365;

const BASE_COOKIE = {
  httpOnly: true,
  secure:   SECURE_COOKIES,
  sameSite: SECURE_COOKIES ? 'lax' : 'lax',
  path:     '/',
};

function setHelper(res, on) {
  res.cookie('fein_has_espn', on ? '1' : '', {
    path: '/',
    sameSite: 'lax',
    secure: SECURE_COOKIES,
    maxAge: on ? ONE_YEAR : 0,
  });
}

function setAuthCookies(res, { swid, s2 }) {
  res.cookie('SWID', swid,   { ...BASE_COOKIE, maxAge: ONE_YEAR });
  res.cookie('espn_s2', s2,  { ...BASE_COOKIE, maxAge: ONE_YEAR });
  setHelper(res, true);
}

function clearAuthCookies(res, req) {
  // Clear normal host cookies
  res.clearCookie('SWID',      { ...BASE_COOKIE });
  res.clearCookie('espn_s2',   { ...BASE_COOKIE });
  res.clearCookie('fein_has_espn', { path: '/' });

  // Belt & suspenders: try common variants that may have been set previously
  const hosts = [req.hostname];
  const parts = req.hostname.split('.');
  if (parts.length >= 2) hosts.push('.' + parts.slice(-2).join('.'));
  const paths = ['/', '/fein', '/fein/'];

  const past = new Date(0).toUTCString();
  for (const d of hosts) {
    for (const p of paths) {
      res.append('Set-Cookie', `fein_has_espn=; Expires=${past}; Max-Age=0; Path=${p}; Domain=${d}; SameSite=Lax;${SECURE_COOKIES ? ' Secure;' : ''}`);
      res.append('Set-Cookie', `fein_has_espn=; Expires=${past}; Max-Age=0; Path=${p}; SameSite=Lax;${SECURE_COOKIES ? ' Secure;' : ''}`);
    }
  }
}

/* ========================== NEW: AUTH ENDPOINTS ===========================
   Same-origin cookie setter/clearer used by the interceptor & bookmarklet.
   Mount path: app.use('/api/fein-auth', routerFromThisFile)
=========================================================================== */

// GET /api/fein-auth?swid=&s2=&to=
router.get('/', (req, res) => {
  const swid = ensureBracedSWID(req.query.swid);
  const s2   = cleanS2(req.query.s2);
  const to   = req.query.to ? String(req.query.to) : null;

  if (!swid || !s2) return res.status(400).json({ ok:false, error:'missing swid/s2' });
  setAuthCookies(res, { swid, s2 });

  if (to) return res.redirect(to);
  return res.json({ ok:true });
});

// POST /api/fein-auth  { swid, s2, to? }
router.post('/', express.json(), (req, res) => {
  const swid = ensureBracedSWID(req.body?.swid);
  const s2   = cleanS2(req.body?.s2);
  const to   = req.body?.to ? String(req.body.to) : null;

  if (!swid || !s2) return res.status(400).json({ ok:false, error:'missing swid/s2' });
  setAuthCookies(res, { swid, s2 });
  return res.json({ ok:true, to });
});

// DELETE /api/fein-auth
router.delete('/', (req, res) => {
  clearAuthCookies(res, req);
  return res.json({ ok:true, cleared:true });
});

// GET /api/fein-auth/status  -> { ok:true, authed:boolean }
router.get('/status', (req, res) => {
  const authed = Boolean(req.cookies?.SWID && req.cookies?.espn_s2);
  if (authed) setHelper(res, true); // keep helper cookie in sync
  return res.json({ ok:true, authed });
});

/* ======================= YOUR EXISTING ENDPOINTS ======================== */

/**
 * GET /fein-auth/by-league?season=2025&size=12[&leagueId=...]
 * Returns user-level id (public), team_key (21-char), and platform_code.
 */
router.get('/by-league', async (req, res) => {
  try {
    const season   = s(req.query.season || '').trim();
    const size     = Number(req.query.size || '');
    const leagueId = s(req.query.leagueId || '').trim();

    if (!season) return bad(res, 'season required');
    if (!Number.isFinite(size)) return bad(res, 'size required');

    const params = [season, size];
    let sql = `
      SELECT id, team_key, season, platform_code, league_id, team_id,
             name AS team_name, handle, league_size, fb_groups, updated_at
      FROM fein_meta
      WHERE season = $1 AND league_size = $2
    `;
    if (leagueId) { sql += ` AND league_id = $3`; params.push(leagueId); }
    sql += ` ORDER BY league_id, team_id`;

    const rows = await query(sql, params).then(r => r.rows);
    return ok(res, { count: rows.length, rows });
  } catch (e) { return boom(res, e); }
});

/**
 * GET /fein-auth/pool?size=12[&season=2025]
 * Returns user-level id (public), team_key (21-char), and platform_code.
 */
router.get('/pool', async (req, res) => {
  try {
    const size   = Number(req.query.size || '');
    const season = s(req.query.season || '').trim();
    if (!Number.isFinite(size)) return bad(res, 'size required');

    const params = [size];
    let sql = `
      SELECT id, team_key, season, platform_code, league_id, team_id,
             name AS team_name, handle, league_size, fb_groups, updated_at
      FROM fein_meta
      WHERE league_size = $1
    `;
    if (season) { sql += ` AND season = $2`; params.push(season); }
    sql += ` ORDER BY season DESC, platform_code, league_id, team_id`;

    const rows = await query(sql, params).then(r => r.rows);
    return ok(res, { count: rows.length, rows });
  } catch (e) { return boom(res, e); }
});

/**
 * POST /fein-auth/upsert-meta
 * Body accepts:
 *  - season, leagueId, teamId, teamName/name, handle/owner, leagueSize, fb_groups[]
 *  - platformCode (3-digit string, e.g. '018' ESPN; '016' Sleeper)
 *  - swid, s2 (ESPN creds) OR auto-read from request via readAuthFromRequest
 * Writes:
 *  - id: user_public_id (per SWID; minted on first upsert)
 *  - team_key: 21-char composite
 */
router.post('/upsert-meta', async (req, res) => {
  try {
    // Require server key (prevents browser from calling this directly)
    if (WRITE_KEY) {
      const k = s(req.headers['x-fein-key'] || '').trim();
      if (!k || k !== WRITE_KEY) {
        return res.status(401).json({ ok:false, error:'Unauthorized (bad x-fein-key)' });
      }
    }

    const b = req.body || {};

    // Identity fields are accepted ONLY from trusted server calls.
    const season       = s(b.season || new Date().getFullYear()).trim();
    const platformCode = s(b.platformCode || b.platform_code || '').padStart(3, '0').slice(-3) || '018';
    const leagueId     = s(b.leagueId || b.league_id).trim();
    const teamId       = s(b.teamId   || b.team_id).trim();

    if (!season || !leagueId || !teamId) {
      return bad(res, 'season, leagueId, teamId required');
    }

    // Optional mutable fields
    const leagueSize = n(b.leagueSize ?? b.league_size);
    const name       = s(b.teamName ?? b.name).slice(0,120) || null;
    const handle     = s(b.owner    ?? b.handle).slice(0,120) || null;
    const fb_groups  = Array.isArray(b.fb_groups) ? b.fb_groups : dedup([b.fbName, b.fbHandle, b.fbGroup]);

    // ESPN creds are allowed from server (not from browser directly)
    let swid = s(b.swid || b.SWID);
    let s2   = s(b.s2   || b.espn_s2);
    if (!swid || !s2) {
      const fromReq = readAuthFromRequest?.(req) || {};
      if (!swid) swid = fromReq.swid || '';
      if (!s2)   s2   = fromReq.s2   || '';
    }
    swid = ensureBracedSWID(swid);
    s2   = cleanS2(s2);

    // Compute team_key (21-char)
    const team_key = buildTeamId({
      season,
      platformCode,
      leagueId,
      teamId
    });

    // Derive or reuse user_public_id by SWID; mint if none exists
    let user_public_id = null;
    if (swid) {
      const found = await query(
        `SELECT id FROM fein_meta WHERE swid = $1 ORDER BY updated_at DESC LIMIT 1`,
        [swid]
      ).then(r => r.rows?.[0]?.id || null);
      user_public_id = found || makePublicId();
    } else {
      user_public_id = makePublicId();
    }

    // UPSERT — write id (user_public_id) and team_key
    const sql = `
      INSERT INTO fein_meta
        (id, team_key, season, platform_code, league_id, team_id, name, handle,
         league_size, fb_groups, swid, s2, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8,
         $9, COALESCE($10::jsonb, '[]'::jsonb), $11, $12, now())
      ON CONFLICT (season, league_id, team_id)
      DO UPDATE SET
        -- keep user's public id once set (don't overwrite with another user's)
        id            = COALESCE(fein_meta.id, EXCLUDED.id),
        team_key      = EXCLUDED.team_key,
        platform_code = EXCLUDED.platform_code,
        name          = COALESCE(EXCLUDED.name, fein_meta.name),
        league_size   = COALESCE(EXCLUDED.league_size, fein_meta.league_size),
        handle        = COALESCE(NULLIF(EXCLUDED.handle,''), fein_meta.handle),
        fb_groups     = CASE
                          WHEN EXCLUDED.fb_groups IS NOT NULL AND jsonb_array_length(EXCLUDED.fb_groups) > 0
                          THEN (
                            SELECT jsonb_agg(DISTINCT x)
                            FROM jsonb_array_elements(COALESCE(fein_meta.fb_groups,'[]'::jsonb) || EXCLUDED.fb_groups) t(x)
                          )
                          ELSE fein_meta.fb_groups
                        END,
        swid          = COALESCE(NULLIF(EXCLUDED.swid,''), fein_meta.swid),
        s2            = COALESCE(NULLIF(EXCLUDED.s2  ,''), fein_meta.s2),
        updated_at    = now()
      RETURNING id, team_key, season, platform_code, league_id, team_id,
                name, handle, league_size, fb_groups, swid, s2, updated_at
    `;

    const params = [
      user_public_id,             // $1  id (user-scoped public id)
      team_key,                   // $2  21-char team composite
      season,                     // $3
      platformCode,               // $4
      leagueId,                   // $5
      teamId,                     // $6
      name,                       // $7
      handle,                     // $8
      leagueSize,                 // $9
      Array.isArray(fb_groups) ? JSON.stringify(dedup(fb_groups)) : null, // $10
      swid || null,               // $11
      s2   || null                // $12
    ];

    const rows = await query(sql, params).then(r => r.rows);
    return ok(res, { row: rows[0] || null });
  } catch (e) {
    return boom(res, e);
  }
});

/**
 * GET /fein-auth/creds?leagueId=... [&season=...]
 * unchanged, but left here for completeness
 */
router.get('/creds', async (req, res) => {
  try {
    if (WRITE_KEY) {
      const k = s(req.headers['x-fein-key'] || '').trim();
      if (!k || k !== WRITE_KEY) return res.status(401).json({ ok:false, error:'Unauthorized (bad x-fein-key)' });
    }

    const leagueId = s(req.query.leagueId || req.query.league_id || '').trim();
    const season   = s(req.query.season   || req.query.year      || '').trim();
    if (!leagueId) return bad(res, 'leagueId required');

    let sqlText, params;
    if (season) {
      sqlText = `
        SELECT swid, s2
        FROM fein_meta
        WHERE league_id = $1 AND season = $2
          AND swid IS NOT NULL AND s2 IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `;
      params = [leagueId, season];
    } else {
      sqlText = `
        SELECT swid, s2
        FROM fein_meta
        WHERE league_id = $1
          AND swid IS NOT NULL AND s2 IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT 1
      `;
      params = [leagueId];
    }

    const rows = await query(sqlText, params).then(r => r.rows);
    const row = rows?.[0];
    if (!row?.swid || !row?.s2) return res.status(404).json({ ok:false, error:'no stored creds' });

    return ok(res, { swid: row.swid, s2: row.s2 });
  } catch (e) { return boom(res, e); }
});

module.exports = router;
