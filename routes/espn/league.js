// routes/espn/league.js
// TRUE_LOCATION: routes/espn/league.js
// IN_USE: yes — FEIN opponents grid + seeding

const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./_cred');
const { fetchJsonWithCred } = require('./_fetch');
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

async function fetchLeagueTeamsFromESPN({ season, leagueId, req, teamId, debug }) {
  if (!season || !leagueId) throw new Error('season and leagueId are required');

  // ESPN league metadata/teams: mTeam + mSettings (no roster needed here)
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
  const url  = `${base}?view=mTeam&view=mSettings`;

  // Try candidates in order: public → request cookies → db (member-linked)
 const candidates = await resolveEspnCredCandidates({ req, leagueId, teamId, memberId: ffMember });
  if (!candidates.length) console.warn('[espn/league] no ESPN creds available for league', { leagueId });

  let data = null;
  let lastCand = null, lastRes = null;

  for (const cand of candidates.length ? candidates : [{ source: 'public', swid: '', s2: '' }]) {
    lastCand = cand;
    const res = await fetchJsonWithCred(url, cand);
    lastRes = res;

    if (res.ok && res.json) {
      try { req.res?.set?.('x-espn-cred-source', cand.source || 'unknown'); } catch {}
      data = res.json;
      break;
    }

    if (res.status === 401) {
      console.warn('[espn/league] 401 with candidate', {
        leagueId, teamId, source: cand.source, member_id: cand.member_id || null,
        bodySnippet: (res.text || '').slice(0, 240)
      });
    } else if (String(res.status).startsWith('5')) {
      console.warn('[espn/league] upstream 5xx', {
        leagueId, teamId, status: res.status, statusText: res.statusText,
        bodySnippet: (res.text || '').slice(0, 240)
      });
    }
  }

  if (!data) {
    console.warn(
      `[espn/league] repro: curl -i '${url}' -H 'Accept: application/json, text/plain, */*' ` +
      `-H 'User-Agent: ff-platform-service/1.0' -H 'Cookie: espn_s2=${lastCand?.s2 || ''}; SWID=${lastCand?.swid || ''}'`
    );
    throw new Error(`ESPN ${lastRes?.status || 401} ${lastRes?.statusText || ''}`);
  }

  // Normalize minimal shape your frontend expects
  const teamNameOf = (t) => {
    const loc = t?.location || t?.teamLocation || '';
    const nick = t?.nickname || t?.teamNickname || '';
    const name = `${loc} ${nick}`.trim();
    return name || t?.name || `Team ${t?.id}`;
  };

  const teams = (data?.teams || []).map(t => ({
    teamId: t?.id,
    team_name: teamNameOf(t),
    logo: t?.logo || t?.logoUrl || t?.teamLogoUrl || null,
    wins: t?.record?.overall?.wins ?? 0,
    losses: t?.record?.overall?.losses ?? 0,
    ties: t?.record?.overall?.ties ?? 0,
  }));

  return {
    ok: true,
    leagueId,
    season,
    teamCount: teams.length,
    teams,
    meta: {
      scoringPeriodId: data?.scoringPeriodId,
      status: data?.status?.type?.name,
    }
  };
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

// routes/espn/league.js
 router.get('/league', async (req, res) => {
   try {

    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '');
    // accept teamId or teamIds=3,8 (first wins)
    const teamId = (() => {
      if (req.query.teamId != null) return Number(req.query.teamId);
            if (req.query.teamIds) {
        const first = String(req.query.teamIds).split(',').map(s=>Number(s.trim())).find(Number.isFinite);
        if (Number.isFinite(first)) return first;
      }
      return undefined;
          })();
    const ffMember = (req.headers['x-ff-member'] || '').trim() || undefined;

     if (!season || !leagueId) {
       return res.status(400).json({ ok:false, error:'missing_params' });
     }

    const raw = await fetchLeagueTeamsFromESPN({ season, leagueId, req, teamId, ffMember });
    try {
      res.set('x-ff-ctx', JSON.stringify({ leagueId, teamId: teamId ?? null, ffMember: ffMember ?? null }));
    } catch {}

  } catch (err) {
    console.error('[espn/league] error:', err);
    return res.status(500).json({ ok:false, error:String(err?.message || err) });
  }
});


/* ---------------- exports ---------------- */

module.exports = router;
