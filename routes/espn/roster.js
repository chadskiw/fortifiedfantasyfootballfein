// routes/espn/roster.js
const express = require('express');
const router  = express.Router();
const { resolveEspnCredCandidates } = require('./_cred');

// ====== Week helpers =======================================================
const NFL_MAX_WEEK  = 18;
const DEFAULT_WEEK  = Number(process.env.CURRENT_WEEK || 7);
function safeWeek(req) {
  const raw = req.query.week ?? req.query.scoringPeriodId ?? req.query.sp;
  const w = Number(raw);
  return Number.isFinite(w) && w >= 1 ? Math.min(w, NFL_MAX_WEEK) : DEFAULT_WEEK;
}
function teamTotalsFor(players) {
  let proj = 0, projRaw = 0, actual = 0, hasActuals = false, starters = 0;
  for (const p of players) {
    proj        += Number(p?.projApplied ?? (p?.isStarter ? (p?.proj ?? 0) : 0));
    projRaw     += Number(p?.proj_raw   ?? 0);                 // totals the raw weekly proj (bye => 0 now)
    actual      += Number(p?.appliedPoints ?? 0);              // zero-filled starter totals
    hasActuals ||= !!p?.hasActual;
    if (p?.isStarter) starters++;
  }
  return { proj, proj_raw: projRaw, actual, hasActuals, starters };
}

// ====== ESPN fetch =========================================================
async function espnGET(url, cand) {
  const fetch = global.fetch || (await import('node-fetch')).default;
  const headers = {
    'accept': 'application/json',
    'user-agent': 'ff-platform-service/1.0',
    'x-fantasy-platform': 'web',
    'x-fantasy-source':   'kona'
  };
  const cookie = cand?.s2 && cand?.swid ? `espn_s2=${cand.s2}; SWID=${cand.swid};` : '';
  const resp = await fetch(url, cookie ? { headers: { ...headers, cookie } } : { headers });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: resp.ok, status: resp.status, json, text };
}

// ====== Mapping helpers ====================================================
const TEAM_ABBR = {1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GB',10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',17:'NE',18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',25:'SF',26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU'};
const POS       = {1:'QB',2:'RB',3:'WR',4:'TE',5:'K',16:'DST'};
const SLOT      = {0:'QB',2:'RB',4:'WR',6:'TE',7:'OP',16:'DST',17:'K',20:'BN',21:'IR',23:'FLEX',24:'FLEX',25:'FLEX',26:'FLEX',27:'FLEX'};

function headshotFor(p, pos, abbr) {
  return p?.headshot?.href || p?.image?.href || p?.photo?.href ||
    (pos === 'DST' && abbr
      ? `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nfl/500/${String(abbr).toLowerCase()}.png&h=80&w=80&scale=crop`
      : (p?.id ? `https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png` : '/img/placeholders/player.png'));
}

function pickProjected(stats, week) {
  if (!Array.isArray(stats)) return null;
  const exact = stats.find(s => Number(s?.statSourceId) === 1 && Number(s?.scoringPeriodId) === Number(week));
  if (exact && Number.isFinite(+exact.appliedTotal)) return +exact.appliedTotal;
  const any = stats.find(s => Number(s?.statSourceId) === 1 && Number.isFinite(+s.appliedTotal));
  return any ? +any.appliedTotal : null;
}

function pickActual(stats, week) {
  if (!Array.isArray(stats)) return null;
  // Only count the exact scoring period for statSourceId=0 (actuals). No fallbacks.
  const exact = stats.find(s =>
    Number(s?.statSourceId) === 0 &&
    Number(s?.scoringPeriodId) === Number(week) &&
    Number.isFinite(+s.appliedTotal)           // 0 is valid
  );
  return exact ? +exact.appliedTotal : null;   // null ⇒ “no actuals yet”
}


function teamNameOf(t) {
  return `${t?.location || t?.teamLocation || ''} ${t?.nickname || t?.teamNickname || ''}`.trim()
      || t?.name
      || `Team ${t?.id}`;
}

function mapEntriesToPlayers(entries, week) {
  return entries.map(e => {
    const slotId = Number(e?.lineupSlotId);
    const slot   = SLOT[slotId] || 'BN';
    const isStarter = ![20,21].includes(slotId) && slot !== 'BN' && slot !== 'IR';

    const p     = e?.playerPoolEntry?.player || e.player || {};
    const pos   = POS[p?.defaultPositionId] || p?.defaultPosition || p?.primaryPosition || '';
    const abbr  = p?.proTeamAbbreviation || (p?.proTeamId ? TEAM_ABBR[p.proTeamId] : null);
    const stats = p?.stats || e?.playerStats || [];

    // Raw values from ESPN (may be null)
// inside mapEntriesToPlayers(...)
const projRaw = pickProjected(stats, week);                  // can be null on byes
const ptsRaw  = pickActual(stats, week);                     // null unless the WEEK row exists
const hasActual  = (ptsRaw != null);
const projZero   = projRaw == null ? 0 : Number(projRaw);    // bye ⇒ 0
const points     = hasActual ? Number(ptsRaw) : null;        // raw actuals (nullable)
const appliedPts = isStarter ? (points ?? 0) : 0;            // starter total (zero until live)
const projApplied= isStarter ? projZero : 0;

return {
  slot, isStarter,
      name: p?.fullName || [p?.firstName, p?.lastName].filter(Boolean).join(' ') || p?.name || '',
  position: pos,
  teamAbbr: abbr || '',
  proj: projZero,                  // now zero-filled
  points,                          // only set when week actual exists (0 allowed)
  appliedPoints: appliedPts,       // numeric always (starters zero-filled)
  headshot: headshotFor(p, pos, abbr),
  playerId: p?.id,
  lineupSlotId: slotId,

  // optional helpers you already added
  proj_raw: projRaw == null ? null : Number(projRaw),
  projApplied, hasActual, bye: (projRaw == null && ptsRaw == null)
};

  });
}


// ====== Route ==============================================================
router.get('/roster', async (req, res) => {
  try {
    const season   = Number(req.query.season);
    const leagueId = String(req.query.leagueId || '').trim();
    const teamId   = req.query.teamId != null && req.query.teamId !== '' ? Number(req.query.teamId) : null;
    const week     = safeWeek(req);

    if (!Number.isFinite(season) || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    // Build ESPN URL (single call covers teams, roster, settings, boxscore for week)
    const base   = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}`;
    const params = new URLSearchParams({
      scoringPeriodId: String(week),
      matchupPeriodId: String(week)
    });
    params.append('view','mTeam');
    params.append('view','mRoster');
    params.append('view','mSettings');
    params.append('view','mBoxscore');
    const url = `${base}?${params.toString()}`;

    // Resolve ESPN cred candidates (server-side only)
    const cands = await resolveEspnCredCandidates({ req, season, leagueId, teamId: Number.isFinite(teamId) ? teamId : null });

    // Try candidates in order; if all 401, try public once
    let used = null;
    let last = null;
    let data = null;

    if (Array.isArray(cands) && cands.length) {
      for (const cand of cands) {
        const r = await espnGET(url, cand);
        last = r;
        if (r.ok && r.json) { used = cand; data = r.json; break; }
        if (r.status !== 401) break; // hard-fail types
      }
    }

    if (!data) {
      // Public fallback (handles public leagues)
      const rPub = await espnGET(url, null);
      last = rPub;
      if (rPub.ok && rPub.json) {
        data = rPub.json;
        used = null; // public
      }
    }

    // If still nothing, emit meaningful error
    if (!data) {
      if (last?.status === 401 && cands?.length) {
        const first = cands[0];
        return res.status(401).json({
          ok: false,
          error: first?.stale ? 'espn_cred_stale' : 'espn_not_visible',
          hint:  first?.stale ? 'Please re-link ESPN (cookie expired)' : 'Creds exist but do not have access to this league',
        });
      }
      return res.status(last?.status || 500).json({
        ok:false, error:'upstream_error', detail: (last?.text || '').slice(0, 240)
      });
    }

    // Response headers for debugging
    try {
      res.set('x-espn-cred-source', used?.source || 'public');
      res.set('x-espn-cred-stale', used?.stale ? '1' : '0');
      if (used?.swid) res.set('x-ff-cred-swid', String(used.swid).slice(0, 12) + '…');
    } catch {}

    const teams = Array.isArray(data?.teams) ? data.teams : [];

    if (teamId != null && Number.isFinite(teamId)) {
      const t = teams.find(x => Number(x?.id) === Number(teamId));
      if (!t) return res.status(404).json({ ok:false, error:'team_not_found' });

const entries = t?.roster?.entries || [];
const players = mapEntriesToPlayers(entries, week);
const totals  = teamTotalsFor(players);

return res.json({
  ok: true, platform:'espn', leagueId, season, week,
  teamId, team_name: teamNameOf(t),
  totals,                 // <— NEW (non-breaking)
  players
});

    }

    // No teamId provided → return all teams with mapped players
const teamsOut = teams.map(t => {
  const players = mapEntriesToPlayers(t?.roster?.entries || [], week);
  return {
    teamId: Number(t?.id),
    team_name: teamNameOf(t),
    totals: teamTotalsFor(players),   // <— NEW (non-breaking)
    players
  };
});


  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
});

module.exports = router;
