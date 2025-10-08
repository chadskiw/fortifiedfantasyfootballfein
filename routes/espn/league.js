// routes/espn/league.js
// TRUE_LOCATION: routes/espn/league.js
// IN_USE: yes — FEIN opponents grid + seeding

const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./espnCred'); // <-- NEW
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
  const x =     (t?.logo,
    t?.logoUrl,
    t?.avatar,
    t?.teamLogo) || t?.teamLogoUrl;
    const y = sanitizeImg(x);
  return y;
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
// inside your fetchLeagueTeamsFromESPN or similar:
const { swid, s2 } = await resolveEspnCredCandidates({ req, leagueId });
const headers = {
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'ff-platform-service/1.0',
};
if (swid && s2) headers['Cookie'] = `espn_s2=${s2}; SWID=${swid}`;

  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const url  = new URL(base);
  url.searchParams.append('view', 'mTeam');
  url.searchParams.append('view', 'mSettings');

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
    const logo = safeLogo(t);
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

function sanitizeImg(src){
  if (!src) return DEFAULT_IMG;
  const s = String(src).trim();
  if (/^mystique:/i.test(s)) return DEFAULT_IMG;
return src;
}
/* ---------------- routes ---------------- */

router.get('/league/selftest', (_req, res) => {
  res.json({ ok:true, msg:'league router mounted' });
});

// GET /api/platforms/espn/league?season=2025&leagueId=123456
// Optional: &debug=1 to include upstream snippet/hint
function mask(v){ if(!v) return ''; const s=String(v); return s.length<=12?s:'{'+s.slice(1,7)+'…'+s.slice(-7)+'}'; }
const ESPN_BASE_HOST = 'https://lm-api-reads.fantasy.espn.com';

async function espnGET(url, { swid, s2, debug }) {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'ff-platform-service/1.0'
  };
  if (s2 && swid) headers['Cookie'] = `espn_s2=${s2}; SWID=${swid}`;
  const r = await fetch(url, { headers });
  const text = await r.text().catch(()=>'');
  let json = null; try { json = JSON.parse(text); } catch {}
  return { ok:r.ok, status:r.status, statusText:r.statusText, text, json };
}

// Normalizes ESPN teams to a compact shape your FE already expects
function toTeamsPayload(data = {}) {
  const teams = (data.teams || []).map(t => ({
    teamId: t.id,
    teamName: [t.location || t.teamLocation || '', t.nickname || t.teamNickname || ''].join(' ').trim() || t.name || `Team ${t.id}`,
    wins: t.record?.overall?.wins ?? t.record?.overallWins ?? t.wins ?? 0,
    losses: t.record?.overall?.losses ?? t.record?.overallLosses ?? t.losses ?? 0,
    ties: t.record?.overall?.ties ?? t.ties ?? 0,
    logo: t.logo || t.logoURL || t.logoUrl || t.avatar,
    owner: t.primaryOwner || t.owner || ''
  }));
  return { teamCount: teams.length, teams };
}

router.get('/league', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    const debug    = String(req.query.debug || '') === '1';
    if (!season || !leagueId) return res.status(400).json({ ok:false, error:'season and leagueId are required' });

    const base = `${ESPN_BASE_HOST}/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
    const params = new URLSearchParams();
    // mTeam + mSettings covers names/owners/record; add more views if needed
    params.append('view','mTeam');
    params.append('view','mSettings');
    const url = `${base}?${params.toString()}`;

    // try candidate creds in order
    const { resolveEspnCredCandidates } = require('./espnCred'); // your helper
    const cands = await resolveEspnCredCandidates({ req, leagueId });
    if (!Array.isArray(cands) || !cands.length) {
      console.warn('[espn/league] no ESPN creds available for league', { leagueId });
    }

    let lastErr = null;
    let winner  = null;
    let data    = null;

    const tryWith = async (cand, label) => {
      const out = await espnGET(url, { swid: cand?.swid, s2: cand?.s2, debug });
      if (out.ok) {
        data = out.json;
        winner = label;
        return true;
      }
      if (out.status === 401) {
        console.warn('[espn/league] 401 with candidate', {
          leagueId, source: label,
          bodySnippet: out.text?.slice(0, 240)
        });
      } else {
        console.warn('[espn/league] upstream %s: %s', out.status, out.statusText);
      }
      lastErr = out;
      return false;
    };

    // order: request → db:league-team → db:any-in-league
    for (const cand of (cands || [])) {
      if (await tryWith(cand, cand.source || 'unknown')) break;
    }

    if (!data) {
      const s2 = cands?.[0]?.s2, swid = cands?.[0]?.swid;
      console.warn(
        "[espn/league] repro: curl -i '%s' -H 'Accept: application/json, text/plain, */*' -H 'User-Agent: ff-platform-service/1.0' -H 'Cookie: espn_s2=%s; SWID=%s'",
        url, mask(s2), mask(swid)
      );
      const status = lastErr?.status || 500;
      // Soft 200 with empty list keeps FE happy if you prefer:
      // return res.json({ ok:true, leagueId, season, teamCount:0, teams:[], meta:{ reason:'unauthorized' } });
      return res.status(status).json({ ok:false, error:'ESPN league fetch failed', status, detail:lastErr?.statusText || 'unknown' });
    }

    // success
    try { res.set('x-espn-cred-source', String(winner || 'request')); } catch {}
    const { teams, teamCount } = toTeamsPayload(data);
    return res.json({ ok:true, leagueId, season, teamCount, teams, meta: { source:winner || 'request' } });

  } catch (err) {
    console.error('[espn/league] error:', err);
    return res.status(500).json({ ok:false, error:String(err?.message || err) });
  }
});

/* ---------------- exports ---------------- */

module.exports = router;
