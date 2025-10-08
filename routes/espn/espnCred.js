// routes/espn/espnCred.js
// Build an ordered list of candidate ESPN creds for a (leagueId, teamId).
// Order: team owner → any member seen in league (most recent) → request cookies.

const HEADER_SWID_KEYS = ['x-espn-swid', 'x-espn-s2-swid'];
const HEADER_S2_KEYS   = ['x-espn-s2'];

function normalizeSwid(s) {
  if (!s) return '';
  const raw = String(s).trim();
  const inner = raw.replace(/^\{|\}$/g, '');
  return `{${inner}}`;
}

function readReqCreds(req) {
  const c = req.cookies || {};
  const h = req.headers || {};
  let swid =
    c.SWID || c.swid || c.ff_espn_swid || null;
  let s2 =
    c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || null;

  for (const k of HEADER_SWID_KEYS) if (!swid && h[k]) swid = h[k];
  for (const k of HEADER_S2_KEYS)   if (!s2   && h[k]) s2   = h[k];

  if (swid && s2) {
    return [{ swid: normalizeSwid(swid), s2, source: 'request' }];
  }
  return [];
}

// Return an array of {swid, s2, source, member_id?} sorted by preference.
async function resolveEspnCredCandidates({ req, leagueId, teamId = null, memberId = null }) {
  const db = req.app?.get?.('db') || req.db;
  const out = [];

  // If no DB, just return request cookies.
  if (!db) return readReqCreds(req);

  // 1) Explicit memberId (if provided)
  if (memberId) {
    const row = await db.oneOrNone(`
      SELECT swid, espn_s2, member_id
      FROM ff_espn_cred
      WHERE member_id = $1
      ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST
      LIMIT 1
    `, [memberId]);
    if (row?.swid && row?.espn_s2) {
      out.push({ swid: normalizeSwid(row.swid), s2: row.espn_s2, source: 'db:member', member_id: row.member_id });
    }
  }

  // 2) Owner of (league, team) if known
  if (leagueId && teamId != null) {
    const own = await db.oneOrNone(`
      SELECT f.member_id, c.swid, c.espn_s2
      FROM ff_sport_ffl f
      JOIN ff_espn_cred c ON c.member_id = f.member_id
      WHERE f.league_id = $1 AND f.team_id = $2
      ORDER BY c.last_seen DESC NULLS LAST, f.last_seen_at DESC NULLS LAST
      LIMIT 1
    `, [String(leagueId), String(teamId)]);
    if (own?.swid && own?.espn_s2) {
      out.push({ swid: normalizeSwid(own.swid), s2: own.espn_s2, source: 'db:league-team', member_id: own.member_id });
    }
  }

  // 3) Any member seen in this league (most recent first) — add a few
  if (leagueId) {
    const any = await db.any(`
      SELECT DISTINCT ON (c.member_id) c.member_id, c.swid, c.espn_s2, c.last_seen
      FROM ff_sport_ffl f
      JOIN ff_espn_cred c ON c.member_id = f.member_id
      WHERE f.league_id = $1
      ORDER BY c.member_id, c.last_seen DESC NULLS LAST
      LIMIT 5
    `, [String(leagueId)]);
    for (const r of any) {
      if (r?.swid && r?.espn_s2) {
        out.push({ swid: normalizeSwid(r.swid), s2: r.espn_s2, source: 'db:any-in-league', member_id: r.member_id });
      }
    }
  }

  // 4) Request cookies last
  out.push(...readReqCreds(req));

  // De-dupe by (swid,s2)
  const seen = new Set();
  const uniq = [];
  for (const cand of out) {
    const key = `${cand.swid}|${cand.s2}`;
    if (!seen.has(key)) { seen.add(key); uniq.push(cand); }
  }
  return uniq;
}

module.exports = { resolveEspnCredCandidates, normalizeSwid };
