// routes/espn/league.js
// TRUE_LOCATION: routes/espn/league.js
// IN_USE: yes — FEIN opponents grid + seeding

const express = require('express');
const router  = express.Router();

/* ---------------- creds from cookies/headers ---------------- */

function readEspnCreds(req) {
  const c = req.cookies || {};
  const h = req.headers || {};
  const swid =
    c.SWID || c.swid || c.ff_espn_swid ||
    h['x-espn-swid'] || h['x-espn-s2-swid'] || null;
  const s2 =
    c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 ||
    h['x-espn-s2'] || null;
  return { swid, s2 };
}

/* ---------------- tiny util helpers ---------------- */

function escapeStr(s) {
  return String(s == null ? '' : s);
}
function first(a, b, c, d) {
  if (a != null && a !== '') return a;
  if (b != null && b !== '') return b;
  if (c != null && c !== '') return c;
  return d;
}

function teamDisplayName(t) {
  const loc  = t?.location || t?.teamLocation || '';
  const nick = t?.nickname || t?.teamNickname || '';
  const joined = `${loc} ${nick}`.trim();
  return joined || t?.name || `Team ${t?.id}`;
}

function leagueDisplayName(data) {
  // ESPN puts league name in multiple places depending on view
  return first(
    data?.settings?.name,
    data?.metadata?.leagueName,
    data?.name,
    `League ${data?.id ?? ''}`.trim()
  );
}

function safeLogo(t) {
  // common fields ESPN uses in different payloads
  return first(
    t?.logo,
    t?.logoUrl,
    t?.avatar,
    t?.teamLogo || t?.teamLogoUrl,
    ''
  );
}

function parseRecord(t) {
  // Handle different shapes gracefully
  // examples:
  // t.record.overall.{wins,losses,ties}
  // t.record.{wins,losses,ties}
  // or flat wins/losses/ties attached by other endpoints
  const r =
    t?.record?.overall ||
    t?.record ||
    {};
  return {
    wins: Number(r.wins ?? t?.wins ?? 0),
    losses: Number(r.losses ?? t?.losses ?? 0),
    ties: Number(r.ties ?? t?.ties ?? 0),
  };
}

function primaryOwner(t) {
  // ESPN usually has t.primaryOwner as an owner id/email; sometimes `owners` array
  // We'll surface primaryOwner as provided; FE treats this as a free-form string.
  return first(t?.primaryOwner, Array.isArray(t?.owners) ? t.owners[0] : '', '');
}

/* ---------------- upstream fetcher (ESPN v3) ---------------- */

async function fetchLeagueTeamsFromESPN({ season, leagueId, req, debug }) {
  const { swid, s2 } = readEspnCreds(req);
  if (!swid || !s2) {
    console.warn('[league] Missing SWID/S2 — ESPN may reject');
  }

  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const url  = new URL(base);
  url.searchParams.append('view', 'mTeam');
  url.searchParams.append('view', 'mSettings');

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'ff-platform-service/1.0',
  };
  if (swid && s2) {
    // cookie order matters on some edges
    headers['Cookie']    = `espn_s2=${s2}; SWID=${swid}`;
    headers['x-espn-s2'] = s2;
    headers['x-espn-swid'] = swid;
  }

  const r = await fetch(url.toString(), { headers });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const msg = `ESPN ${r.status} ${r.statusText}`;
    const full = debug ? `${msg} – ${text.slice(0, 512)}` : msg;
    throw new Error(full);
  }
  const data = await r.json();
  return { data, usedUrl: url.toString() };
}

/* ---------------- normalization ---------------- */

function normalizeTeamsPayload(raw, leagueId, season) {
  const data = raw || {};
  const leagueName = leagueDisplayName(data);
  const arr = Array.isArray(data?.teams) ? data.teams : [];

  const teams = arr.map(t => {
    const id   = t?.id ?? t?.teamId;
    const name = teamDisplayName(t);
    const rec  = parseRecord(t);
    const logo = sanitizeImg(t);
    const owner= primaryOwner(t);

    return {
      leagueId: String(leagueId),
      season: Number(season),
      teamId: String(id ?? ''),
      teamName: name,
      leagueName,
      logo,
      wins: rec.wins,
      losses: rec.losses,
      ties: rec.ties,
      owner,
      // Keep a couple of raw fields that are often handy downstream:
      primaryOwner: owner,
      abbrev: t?.abbrev || t?.teamAbbrev || '',
    };
  });

  return { leagueName, teams };
}
const CDN_IMG = 'https://img.fortifiedfantasy.com';
const DEFAULT_IMG = `${CDN_IMG}/avatars/default.png`;
if (!window.state) window.state = {};
if (!Number.isFinite(+state.season)) {
  const qsSeason = Number(new URLSearchParams(location.search).get('season'));
  state.season = Number.isFinite(qsSeason) ? qsSeason : new Date().getUTCFullYear();
}

function sanitizeImg(src){
  if (!src) return DEFAULT_IMG;
  const s = String(src).trim();
  if (/^myst(ic|ique):/i.test(s)) return DEFAULT_IMG;
  if (!/^https?:\/\//i.test(s)) {
    if (/^data:/i.test(s)) return s; // allow legitimate data URIs
    return DEFAULT_IMG;
  }
  try {
    const u = new URL(s);
    if (/\bmystic\b|\bmystique\b/i.test(u.hostname)) return DEFAULT_IMG;
    return u.href;
  } catch { return DEFAULT_IMG; }
}
/* ---------------- routes ---------------- */

router.get('/league/selftest', (_req, res) => {
  res.json({ ok:true, msg:'league router mounted' });
});

// GET /api/platforms/espn/league?season=2025&leagueId=123456
// Optional: &debug=1 to include upstream snippet/hint
router.get('/league', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    const debug    = String(req.query.debug || '') === '1';

    if (!season || !leagueId) {
      return res.status(400).json({ ok:false, error:'season and leagueId are required' });
    }

    const { data, usedUrl } = await fetchLeagueTeamsFromESPN({ season, leagueId, req, debug });
    const { leagueName, teams } = normalizeTeamsPayload(data, leagueId, season);

    // Helpful hint when ESPN returns 200 but no league array
    const meta = {
      source: 'lm-api-reads',
      hint: (!Array.isArray(data?.teams) || data.teams.length === 0)
        ? { reason: 'no_league', possibilities: ['private_or_not_member', 'season_mismatch', 'views_missing'] }
        : null,
    };
    if (debug) {
      meta.request = { url: usedUrl };
      // include a tiny upstream snippet for troubleshooting
      try {
        meta.upstreamKeys = Object.keys(data || {});
        meta.upstreamTeamsLen = Array.isArray(data?.teams) ? data.teams.length : 0;
      } catch {}
    }

    res.json({
      ok: true,
      leagueId,
      season,
      teamCount: teams.length,
      leagueName,
      teams,
      meta,
    });
  } catch (err) {
    console.error('[espn/league] error:', err);
    res.status(500).json({ ok:false, error:String(err?.message || err) });
  }
});

/* ---------------- exports ---------------- */

module.exports = router;
