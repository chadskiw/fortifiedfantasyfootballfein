// TRUE_LOCATION: routes/espn/poll.js
// Express Router that builds a Pole Position "pool" directly from ff_sport_ffl
// and returns a flat list suitable for your FE PolePosition UI.

const express = require('express');
const router = express.Router();

// DB pool (same as used by routes/pp/teams.js)
let db = require('../../src/db/pool');
let pool = db.pool || db;
if (!pool || typeof pool.query !== 'function') {
  throw new Error('[espn/poll] pg pool missing/invalid import');
}

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

// Try to read W-L string safely (fallback when record not present)
function toRecord(rec) {
  if (!rec) return '0–0';
  if (typeof rec === 'string') return rec.replace('-', '–');
  const { wins = 0, losses = 0, ties = 0 } = rec;
  return `${wins}–${losses}${ties ? `–${ties}` : ''}`;
}

/**
 * Query ff_sport_ffl and quickhitter to produce a leagues → teams structure:
 * [
 *   { leagueId, leagueName, teams: [ { id, name, logo, record, owner... } ] }
 * ]
 */
async function fetchEspnTeams({ season, sport = 'ffl' }) {
  if (String(sport).toLowerCase() !== 'ffl') {
    return [];
  }

  // Pull core league/team info; owner adornments are optional but nice for PP
  const sql = `
    SELECT
      f.season,
      f.league_id::text             AS "leagueId",
      COALESCE(f.league_name,'League') AS "leagueName",
      f.team_id::text               AS "teamId",
      NULLIF(f.team_name,'')        AS "teamName",
      COALESCE(f.team_logo_url,'')  AS "logo",
      q.handle                      AS "ownerHandle",
      q.color_hex                   AS "ownerColorHex",
      CASE
        WHEN q.image_key IS NOT NULL AND q.image_key <> ''
          THEN ('https://img.fortifiedfantasy.com/avatars/anon/' || q.image_key)
        ELSE NULL
      END                           AS "ownerBadgeUrl"
    FROM ff_sport_ffl f
    LEFT JOIN ff_quickhitter q
      ON q.member_id = f.member_id
    WHERE f.season = $1
    ORDER BY f.league_id::text, f.team_id::text
  `;
  const { rows } = await pool.query(sql, [season]);

  // Group rows into leagues
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.leagueId)) {
      map.set(r.leagueId, { leagueId: r.leagueId, leagueName: r.leagueName, teams: [] });
    }
    map.get(r.leagueId).teams.push({
      id: r.teamId,
      name: r.teamName || `Team ${r.teamId}`,
      logo: sanitizeImg(r.logo),
      record: toRecord(null), // if you add W/L later, wire it here
      ownerHandle: r.ownerHandle || null,
      ownerColorHex: r.ownerColorHex || null,
      ownerBadgeUrl: (r.ownerBadgeUrl || '').replace(
        'https://img.fortifiedfantasy.com//',
        'https://img.fortifiedfantasy.com/'
      ) || null,
    });
  }
  return Array.from(map.values());
}

/**
 * Build a flat "pool" list from leagues payload:
 *   [{ leagueId, leagueName, teamId, teamName, logo, record, ownerHandle, ownerColorHex, ownerBadgeUrl }]
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
        ownerHandle: t.ownerHandle || null,
        ownerColorHex: t.ownerColorHex || null,
        ownerBadgeUrl: t.ownerBadgeUrl || null,
      });
    }
  }

  // Deterministic order: league then team
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

    const leagues = await fetchEspnTeams({ season, sport });
    const data = buildPoolFromTeams(leagues, { size });

    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, season, size, data, meta: { ts: Date.now() } });
  } catch (e) {
    console.error('[espn/poll] synth error:', e);
    return res.status(200).json({ ok: false, soft: true, code: 'POLL_BUILD_FAILED', data: [] });
  }
}

// Mount GET /poll under whatever base path server.js uses (e.g., /api/platforms/espn)
router.get('/poll', pollHandler);

module.exports = router;
