// server.js (or routes/platforms-espn.js)
const express = require('express');
const router = express.Router();

function toInt(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }

// Hard timeout helper (Node 18+: AbortSignal.timeout exists)
function withTimeout(ms) {
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout
    ? AbortSignal.timeout(ms)
    : (() => {
        const c = new AbortController();
        setTimeout(() => c.abort(), ms);
        return c.signal;
      })();
}

router.get('/api/platforms/espn/roster', async (req, res) => {
  try {
    const season   = toInt(req.query.season, new Date().getFullYear());
    const leagueId = String(req.query.leagueId || req.query.league || '');
    const teamId   = String(req.query.teamId || req.query.team || '');
    const scope    = (String(req.query.scope || 'season').toLowerCase() === 'week') ? 'week' : 'season';

    if (!leagueId || !teamId) {
      // Always a JSON shape the client understands
      return res.status(200).json({ players: [] });
    }

    // ESPN auth (header, cookie, or env fallback)
    const swid = (req.get('x-espn-swid') || req.cookies?.swid || process.env.ESPN_SWID || '').trim();
    const s2   = (req.get('x-espn-s2')   || req.cookies?.espn_s2 || process.env.ESPN_S2   || '').trim();

    // If you don’t have creds, still return empty — don’t 401 an API
    if (!swid || !s2) {
      return res.status(200).json({ players: [] });
    }

    // League w/ roster view
    const url = `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=mRoster`;

    const upstream = await fetch(url, {
      headers: {
        Cookie: `SWID=${swid}; espn_s2=${s2}`,
        'User-Agent': 'FortifiedFantasy/1.0 (+https://fortifiedfantasy.com)',
        Accept: 'application/json',
      },
      redirect: 'follow',
      signal: withTimeout(3500),
    }).catch(() => null);

    if (!upstream || !upstream.ok) {
      // Upstream trouble → safe empty JSON
      return res
        .status(200)
        .set('Cache-Control', 'no-store')
        .json({ players: [] });
    }

    const json = await upstream.json().catch(() => ({}));
    const teams = Array.isArray(json?.teams) ? json.teams : [];
    const me = teams.find(t => String(t.id) === teamId) || {};
    const entries = me?.roster?.entries || [];

    // Normalize a tiny shape the client can adapt
    const players = entries.map(e => {
      const p = e?.playerPoolEntry?.player || e?.player || {};
      return {
        id:        p.id,
        name:      p.fullName || p.name || '',
        position:  (p.defaultPositionId ?? p.primaryPosition) ?? '',
        team:      p.proTeamAbbreviation || p.proTeam || '',
        lineupSlot: e?.lineupSlotId ?? e?.lineupSlot ?? '',
        // include more fields as needed…
      };
    });

    return res
      .status(200)
      .set('Cache-Control', 'no-store') // avoid caching stale empties
      .json({ players, scope });
  } catch (e) {
    // Final safety: never 5xx this route
    return res
      .status(200)
      .set('Cache-Control', 'no-store')
      .json({ players: [] });
  }
});

module.exports = router;
