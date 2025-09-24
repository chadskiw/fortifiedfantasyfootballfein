// src/routes/espn/index.js
// API-only ESPN endpoints:
//   GET /api/espn/status
//   GET /api/espn/login
//   GET /api/espn/leagues?season=2025&inject=1888700373,12345678
//
// Notes
// - Requires ESPN cookies (SWID, espn_s2) or headers (x-espn-swid, x-espn-s2).
// - If both cookies & headers are absent, will try TEST_ESPN_SWID / TEST_ESPN_S2 env vars (for dev).
// - "inject" is a comma-separated list of league IDs to fetch/normalize.

const express = require('express');
const router  = express.Router();
const { normalizeLeague } = require('./normalize');

// --- creds helpers ---
function readEspnCreds(req) {
  const c = req.cookies || {};
  const h = req.headers || {};

  // cookies set on your domain (preferred)
  let swid = c.SWID || c.swid || c.ff_espn_swid || null;
  let s2   = c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || null;

  // allow forwarding via headers (dev/testing)
  swid = swid || h['x-espn-swid'] || process.env.TEST_ESPN_SWID || null;
  s2   = s2   || h['x-espn-s2']   || process.env.TEST_ESPN_S2   || null;

  // ensure SWID has braces
  if (swid && !/^\{.*\}$/.test(decodeURIComponent(String(swid)))) {
    const d = decodeURIComponent(String(swid));
    swid = d.startsWith('{') ? d : `{${d.replace(/^\{?|\}?$/g,'')}}`;
  } else if (swid) {
    swid = decodeURIComponent(String(swid));
  }

  return { swid, s2 };
}

function buildCookieHeader({ swid, s2 }) {
  if (!swid || !s2) return null;
  return `SWID=${encodeURIComponent(swid)}; espn_s2=${s2}`;
}

// --- ESPN fetch helper ---
async function espnFetchJson(url, cookie) {
  const res = await fetch(url, {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
      ...(cookie ? { 'cookie': cookie } : {}),
      // UA helps avoid some oddities; not strictly required
      'user-agent': 'FortifiedFantasy/1.0 (+https://fortifiedfantasy.com)',
    },
    redirect: 'follow',
    // no credentials here; we send cookies explicitly to espn.com
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err  = new Error(`ESPN ${res.status} ${res.statusText} for ${url}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return res.json();
}

// Try lm-api-reads first (generally faster), then fantasy.espn.com as fallback.
async function fetchLeagueRaw({ season, leagueId, cookie }) {
  const qs = 'view=mTeam&view=mSettings';
  const urls = [
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?${qs}`,
    `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?${qs}`,
  ];
  let lastErr = null;
  for (const u of urls) {
    try { return await espnFetchJson(u, cookie); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('league_fetch_failed');
}

// --- routes ---

router.get('/status', (req, res) => {
  const { swid, s2 } = readEspnCreds(req);
  res.set('Cache-Control','no-store');
  res.json({
    ok: true,
    hasEspnCookies: !!(swid && s2),
    swidShort: swid ? String(swid).slice(0, 12) + '…' : null
  });
});

router.get('/login', (req, res) => {
  const { swid, s2 } = readEspnCreds(req);
  res.set('Cache-Control','no-store');
  if (swid && s2) return res.json({ ok: true, step: 'logged_in' });
  return res.json({ ok: true, step: 'link_needed' });
});

router.get('/leagues', async (req, res) => {
  const season = parseInt(req.query.season, 10) || new Date().getFullYear();
  const inject = String(req.query.inject || '').trim();
  const { swid, s2 } = readEspnCreds(req);
  const cookie = buildCookieHeader({ swid, s2 });

  res.set('Cache-Control','no-store');

  // No creds? you can still hit public leagues, but typically you want creds.
  if (!cookie) {
    return res.json({ ok: true, season, leagues: [], message: 'missing_espn_creds' });
  }

  // Parse inject list
  const leagueIds = inject
    ? inject.split(/[,\s]+/).map(x => x.replace(/[^\d]/g,'')).filter(Boolean)
    : [];

  if (leagueIds.length === 0) {
    // Nothing to fetch yet; return empty so UI stays stable
    return res.json({ ok: true, season, leagues: [], message: 'no_inject_ids' });
  }

  try {
    const results = await Promise.all(leagueIds.map(async id => {
      try {
        const raw = await fetchLeagueRaw({ season, leagueId: id, cookie });
        const norm = normalizeLeague(raw);
        return { ok: true, leagueId: id, league: norm, raw }; // include raw if you want to debug; remove in prod
      } catch (e) {
        return { ok: false, leagueId: id, error: e.message, status: e.status || null };
      }
    }));

    // Filter successful ones and expose normalized list
    const leagues = results
      .filter(r => r.ok && r.league)
      .map(r => r.league);

    return res.json({
      ok: true,
      season,
      leagues,
      errors: results.filter(r => !r.ok).map(r => ({ leagueId: r.leagueId, error: r.error, status: r.status })),
    });
  } catch (e) {
    console.error('[espn/leagues] error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
