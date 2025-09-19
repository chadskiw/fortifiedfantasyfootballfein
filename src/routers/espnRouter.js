// routers/espnRouter.js
const express = require('express');
const espn = require('../api/platforms/espn'); // your adapter
const router = express.Router();

/* ---------------- helpers ---------------- */
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
  // Always return {UUID} uppercased (ESPN normal form)
  return v.startsWith('{') ? v.toUpperCase() : `{${v.replace(/[{}]/g, '').toUpperCase()}}`;
}
function extractEspnCreds(req) {
  // 1) Prefer custom headers (bookmarklet / client can send)
  const swidH = req.get('x-espn-swid') || '';
  const s2H   = req.get('x-espn-s2')   || '';

  // 2) Then FEIN-auth cookies you set on your domain
  //    (HttpOnly recommended): ff_espn_swid / ff_espn_s2 / fein_has_espn=1
  const cJar  = req.cookies && Object.keys(req.cookies).length ? req.cookies
               : readCookiesHeader(req.headers.cookie || '');
  const swidC = cJar.ff_espn_swid || cJar.SWID || cJar.swid || '';
  const s2C   = cJar.ff_espn_s2   || cJar.espn_s2 || cJar.ESPN_S2 || '';

  const swid = normalizeSwid(swidH || swidC);
  const s2   = (s2H || s2C || '').trim();

  if (swid && s2) {
    req.espn = { swid, s2 };
    return true;
  }
  return false;
}

function attachCreds(req, _res, next) {
  extractEspnCreds(req); // best effort; may be false
  next();
}
function requireCreds(req, res, next) {
  if (extractEspnCreds(req)) return next();
  return res.status(401).json({ ok: false, error: 'no_espn_creds' });
}

function num(v, dflt = undefined) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/* ---------------- routes ---------------- */

// sanity / ping
router.get('/', (_req, res) => res.json({ ok: true, platform: 'espn' }));

// for client bootstrap: tells if creds are present (headers or cookies)
router.get('/authcheck', attachCreds, (req, res) =>
  res.json({ ok: true, authed: !!req.espn })
);

// list leagues (fan view)
router.get('/leagues', requireCreds, async (req, res) => {
  try {
    const season = num(req.query.season, new Date().getUTCFullYear());
    const { swid, s2 } = req.espn;
    const data = await espn.getLeagues({ season, swid, s2 });
    // adapter can return { leagues } or raw; normalize:
    const leagues = Array.isArray(data?.leagues) ? data.leagues : (Array.isArray(data) ? data : []);
    res.json({ ok: true, platform: 'espn', season, leagues });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to fetch leagues' });
  }
});

// list teams by league (query variant)
router.get('/teams', requireCreds, async (req, res) => {
  try {
    const season  = num(req.query.season, new Date().getUTCFullYear());
    const leagueId = String(req.query.leagueId || req.query.leagueID || '').trim();
    if (!leagueId) return res.status(400).json({ ok:false, error:'missing leagueId' });

    const { swid, s2 } = req.espn;
    const data = await espn.getTeams({ season, leagueId, swid, s2 });
    const teams = Array.isArray(data?.teams) ? data.teams : (Array.isArray(data) ? data : []);
    res.json({ ok: true, platform: 'espn', season, leagueId, teams });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to fetch teams' });
  }
});

// list teams by league (path variant / your original)
router.get('/leagues/:leagueId/teams', requireCreds, async (req, res) => {
  try {
    const season  = num(req.query.season, new Date().getUTCFullYear());
    const leagueId = String(req.params.leagueId || '').trim();
    if (!leagueId) return res.status(400).json({ ok:false, error:'missing leagueId' });

    const { swid, s2 } = req.espn;
    const data = await espn.getTeams({ season, leagueId, swid, s2 });
    const teams = Array.isArray(data?.teams) ? data.teams : (Array.isArray(data) ? data : []);
    res.json({ ok: true, platform: 'espn', season, leagueId, teams });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || 'Failed to fetch teams' });
  }
});

// optional: whoami for debugging (does not hit ESPN; just reflects what we have)
router.get('/whoami', attachCreds, (req, res) => {
  const swid = req.espn?.swid || '';
  const s2   = req.espn?.s2   || '';
  const obf = (s) => s ? (s.slice(0,6) + '…' + s.slice(-4)) : '';
  res.json({ ok:true, swid, swid_obf: obf(swid), s2_obf: obf(s2), present: !!(swid && s2) });
});

module.exports = router;
