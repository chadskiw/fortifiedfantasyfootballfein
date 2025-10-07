// TRUE_LOCATION: routes/espn/poll.js
// Synthesizes Pole Position "pool" from the working /teams endpoint.

const { fetchEspnTeams } = require('./teams'); // see note below

const CDN = 'https://img.fortifiedfantasy.com';
const DEFAULT_IMG = `${CDN}/avatars/default.png`;

function sanitizeImg(src) {
  if (!src) return DEFAULT_IMG;
  const s = String(src).trim();
  if (/^myst(ic|ique):/i.test(s)) return DEFAULT_IMG;
  if (!/^https?:\/\//i.test(s)) {
    if (/^data:/i.test(s)) return s;
    return DEFAULT_IMG;
  }
  try {
    const u = new URL(s);
    if (/\bmystic\b|\bmystique\b|\bsec-trc\b/i.test(u.hostname)) return DEFAULT_IMG;
    return u.href;
  } catch { return DEFAULT_IMG; }
}

// Try to read W-L string safely
function toRecord(rec) {
  if (!rec) return '0–0';
  if (typeof rec === 'string') return rec.replace('-', '–');
  const { wins=0, losses=0, ties=0 } = rec;
  return `${wins}–${losses}${ties ? `–${ties}` : ''}`;
}

/**
 * Build a flat "pool" list:
 *   [{ leagueId, leagueName, teamId, teamName, logo, record }]
 */
function buildPoolFromTeams(teamsPayload, { size = 10 } = {}) {
  const leagues = Array.isArray(teamsPayload?.leagues)
    ? teamsPayload.leagues
    : Array.isArray(teamsPayload)
      ? teamsPayload
      : [];

  const rows = [];
  for (const lg of leagues) {
    const lid = lg.leagueId ?? lg.id ?? lg.league_id;
    const lname = lg.name ?? lg.leagueName ?? `League ${lid}`;
    const list = Array.isArray(lg.teams) ? lg.teams : [];
    for (const t of list) {
      rows.push({
        leagueId: String(lid),
        leagueName: lname,
        teamId: String(t.id ?? t.teamId),
        teamName: t.name ?? t.teamName ?? `Team ${t.id}`,
        logo: sanitizeImg(t.logo ?? t.logoUrl ?? t.avatar),
        record: toRecord(t.record),
      });
    }
  }

  // Simple deterministic order: by league then by team name
  rows.sort((a, b) =>
    a.leagueId.localeCompare(b.leagueId) || a.teamName.localeCompare(b.teamName)
  );

  return rows.slice(0, size);
}

async function pollHandler(req, res) {
  try {
    const season = Number(req.query.season) || new Date().getUTCFullYear();
    const size   = Number(req.query.size) || 10;
    const sport  = (req.query.sport || 'ffl').toLowerCase();

    // Pull the same data your /teams route uses
    // If you don't have fetchEspnTeams exported yet, export it from routes/espn/teams.js
    const teamsPayload = await fetchEspnTeams({ season, sport, req });

    const data = buildPoolFromTeams(teamsPayload, { size });

    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, season, size, data, meta: { ts: Date.now() } });
  } catch (e) {
    console.error('[espn/poll] synth error:', e);
    return res.status(200).json({ ok: false, soft: true, code: 'POLL_BUILD_FAILED', data: [] });
  }
}

module.exports = { pollHandler, buildPoolFromTeams };
