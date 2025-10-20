// routes/espn/roster.js
const express = require('express');
const router  = express.Router();

const { resolveEspnCredCandidates } = require('./_cred');

// Prefer shared helper if present; otherwise use a tiny local fetcher.
let fetchJsonWithCred = null;
try { ({ fetchJsonWithCred } = require('./_fetch')); } catch {}

// --- ESPN fetch wrapper -----------------------------------------------------
async function espnGET(url, cand) {
  if (fetchJsonWithCred) return fetchJsonWithCred(url, cand);

  const fetch = global.fetch || (await import('node-fetch')).default;
  const headers = {
    // ESPN only cares about these cookies for private leagues
    cookie: `espn_s2=${cand?.s2 || ''}; SWID=${cand?.swid || ''};`,
    'x-fantasy-platform': 'web',
    'x-fantasy-source': 'kona',
    'accept': 'application/json, text/plain, */*',
    'user-agent': 'ff-platform-service/1.0'
  };
  const resp = await fetch(url, { headers });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: resp.ok, status: resp.status, statusText: resp.statusText, json, text };
}

// --- Week guards ------------------------------------------------------------
const NFL_MAX_WEEK = 18;
const DEFAULT_WEEK = Number(process.env.CURRENT_WEEK || 7);

function safeWeek(req){
  const raw = req.query.week ?? req.query.scoringPeriodId ?? req.query.sp ?? req.query.w;
  const w = Number(raw);
  if (Number.isFinite(w) && w >= 1) return Math.min(w, NFL_MAX_WEEK);
  return DEFAULT_WEEK;
}

// --- Normalization helpers (shaped to FE expectations) ----------------------
const TEAM_ABBR = {
  1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GB',
  10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',17:'NE',
  18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',25:'SF',
  26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU'
};
const POS   = { 1:'QB',2:'RB',3:'WR',4:'TE',5:'K',16:'DST' };
const SLOT  = {
  0:'QB',2:'RB',4:'WR',6:'TE',7:'OP',16:'DST',17:'K',
  20:'BN',21:'IR',
  23:'FLEX',24:'FLEX',25:'FLEX',26:'FLEX',27:'FLEX'
};

const teamNameOf = (t) =>
  `${t?.location || t?.teamLocation || ''} ${t?.nickname || t?.teamNickname || ''}`.trim()
  || t?.name || (t?.id != null ? `Team ${t.id}` : 'Team');

const headshotFor = (p, position, teamAbbr) => {
  const cand = p?.headshot?.href || p?.headshot || p?.image?.href || p?.photo?.href || p?.avatar?.href || null;
  if (cand) return String(cand);
  if (position === 'DST' && teamAbbr) {
    const slug = String(teamAbbr).toLowerCase();
    return `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${slug}.png&h=80&w=80&scale=crop`;
  }
  if (p?.id) return `https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`;
  return '/img/placeholders/player.png';
};

const pickProjected = (stats, week) => {
  if (!Array.isArray(stats)) return null;
  const exact = stats.find(s => s?.statSourceId === 1 && Number(s?.scoringPeriodId) === Number(week));
  if (exact && Number.isFinite(+exact.appliedTotal)) return +exact.appliedTotal;
  const anyProj = stats.find(s => s?.statSourceId === 1 && Number.isFinite(+s.appliedTotal));
  return anyProj ? +anyProj.appliedTotal : null;
};

const pickActual = (stats, week) => {
  if (!Array.isArray(stats)) return null;
  const exact = stats.find(s => s?.statSourceId === 0 && Number(s?.scoringPeriodId) === Number(week));
  if (exact && Number.isFinite(+exact.appliedTotal)) return +exact.appliedTotal;
  const anyAct = stats.find(s => s?.statSourceId === 0 && Number.isFinite(+s.appliedTotal));
  return anyAct ? +anyAct.appliedTotal : null;
};

// Build a light index of the week’s matchups to decorate opponent labels (optional)
function buildGameIndex(data, week){
  const idx = Object.create(null);
  const sch = Array.isArray(data?.schedule) ? data.schedule : [];
  for (const m of sch) {
    const sp = Number(m?.matchupPeriodId);
    if (sp !== Number(week)) continue;
    const h = m?.home?.teamId, a = m?.away?.teamId;
    if (h != null && a != null) {
      idx[h] = { oppId:a };
      idx[a] = { oppId:h };
    }
  }
  return idx;
}

function entryToCanon(e, week, gameIdx) {
  const slotId = Number(e?.lineupSlotId);
  const slot   = SLOT[slotId] || 'BN';
  const isStarter = ![20,21].includes(slotId) && slot !== 'BN' && slot !== 'IR';

  const p = e?.playerPoolEntry?.player || e.player || {};
  const position = POS[p?.defaultPositionId] || p?.defaultPosition || '';
  const proTeamId = Number.isFinite(+p?.proTeamId) ? +p.proTeamId : null;
  const teamAbbr  = p?.proTeamAbbreviation || (proTeamId ? TEAM_ABBR[proTeamId] : null);

  const proj = pickProjected(p?.stats || e?.playerStats, week);
  const pts  = pickActual(p?.stats || e?.playerStats, week);

  return {
    slot,
    isStarter,
    name: p?.fullName || [p?.firstName, p?.lastName].filter(Boolean).join(' ') || p?.name || '',
    position,
    teamAbbr: teamAbbr || '',
    proj: proj == null ? null : Number(proj),
    points: pts == null ? null : Number(pts),
    appliedPoints: pts == null ? null : Number(pts), // alias used by some FE paths
    headshot: headshotFor(p, position, teamAbbr)
  };
}

// --- Route ------------------------------------------------------------------
// GET /api/platforms/espn/roster?season=2025&leagueId=1634950747&teamId=7&week=7
router.get('/roster', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '').trim();
    const teamId   = req.query.teamId != null ? Number(req.query.teamId) : null;
    const week     = safeWeek(req);

    if (!Number.isFinite(season) || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    // Resolve ESPN auth strictly from DB: ff_sport_ffl -> quick_snap -> ff_espn_cred
    const candidates = await resolveEspnCredCandidates({ req, season, leagueId, teamId });

    if (!candidates.length) {
      // no DB-linked creds = clearly private league we can't view
      return res.status(401).json({ ok:false, error:'no_espn_cred' });
    }

    const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
    const params = new URLSearchParams({
      scoringPeriodId: String(week),
      matchupPeriodId: String(week),
      view: 'mTeam'
    });
    params.append('view','mRoster');
    params.append('view','mSettings');
    params.append('view','mBoxscore');
    const url = `${base}?${params.toString()}`;

    let used=null, data=null, last=null;
    for (const cand of candidates) {
      const r = await espnGET(url, cand);
      last = r;
      if (r.ok && r.json) { used=cand; data=r.json; break; }
      if (r.status === 401) {
        // Try next cred candidate on auth failure
        continue;
      } else {
        // Non-auth failures (5xx) -> stop; ESPN is down or throttling
        break;
      }
    }

    if (!data) {
      const status = last?.status || 500;
      const detail = (last?.text || '').slice(0, 240);
      return res.status(status).json({ ok:false, error:'upstream_error', status, detail });
    }

    // Debug headers (handy in the Network tab)
    try {
      res.set('x-espn-cred-source', used?.source || 'unknown');
      if (used?.memberId) res.set('x-ff-cred-member', String(used.memberId));
      res.set('x-ff-cred-swid', (used?.swid||'').slice(0,12) + '…');
    } catch {}

    // Normalize response
    const gameIdx = buildGameIndex(data, week);

    if (teamId != null && Number.isFinite(teamId)) {
      const t = (data?.teams || []).find(x => Number(x?.id) === Number(teamId));
      const entries = t?.roster?.entries || [];
      const players = entries.map(e => entryToCanon(e, week, gameIdx));
      return res.json({
        ok: true,
        platform: 'espn',
        leagueId,
        season,
        week,
        teamId,
        team_name: t ? teamNameOf(t) : `Team ${teamId}`,
        players
      });
    }

    // If no team specified, return all teams with their rosters
    const teams = (data?.teams || []).map(t => {
      const entries = t?.roster?.entries || [];
      return {
        teamId: t.id,
        team_name: teamNameOf(t),
        players: entries.map(e => entryToCanon(e, week, gameIdx))
      };
    });

    return res.json({ ok:true, platform:'espn', leagueId, season, week, teams });
  } catch (err) {
    const status = err?.meta?.status >= 500 ? 502 : 500;
    return res.status(status).json({
      ok: false,
      error: err?.message || 'server_error',
      status: err?.meta?.status || status,
      detail: err?.meta?.text || undefined
    });
  }
});

module.exports = router;
