// routes/espn/espnCred.js
// Resolves the best ESPN cookies for a league/team/member.
// Order of preference:
//   1) DB creds for the member that owns (leagueId, teamId)
//   2) DB creds for any member seen in that league (last_seen desc)
//   3) Request headers/cookies
//   4) Nothing

const HEADER_SWID_KEYS = ['x-espn-swid', 'x-espn-s2-swid', 'x-espen-swid']; // permissive
const HEADER_S2_KEYS   = ['x-espn-s2', 'x-espen-s2'];

function readReqCreds(req) {
  const c = req.cookies || {};
  const h = req.headers || {};
  let swid =
    c.SWID || c.swid || c.ff_espn_swid || null;
  let s2 =
    c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || null;

  // permissive header read
  for (const k of HEADER_SWID_KEYS) if (!swid && h[k]) swid = h[k];
  for (const k of HEADER_S2_KEYS)   if (!s2   && h[k]) s2   = h[k];

  return { swid, s2, source: 'request' };
}

// normalize { GUID } format; ESPN is picky
function normalizeSwid(s) {
  if (!s) return '';
  const raw = String(s).trim();
  const inner = raw.replace(/^\{|\}$/g, '');
  return `{${inner}}`;
}

async function resolveEspnCred({ req, leagueId, teamId = null, memberId = null }) {
  const db = req.app?.get?.('db') || req.db;
  const wantLeague = String(leagueId || '').trim();
  const wantTeam   = teamId != null ? String(teamId) : null;

  // If no DB, just use request creds
  if (!db) return readReqCreds(req);

  // 1) If caller passed memberId, try direct lookup
  if (memberId) {
    const row = await db.oneOrNone(
      `SELECT swid, espn_s2
         FROM ff_espn_cred
        WHERE member_id = $1
        ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST
        LIMIT 1`,
      [memberId]
    );
    if (row?.swid && row?.espn_s2) {
      return { swid: normalizeSwid(row.swid), s2: row.espn_s2, source: 'db:member' };
    }
  }

  // 2) Use ff_sport_ffl to find the owning member for this league/team
  if (wantLeague) {
    // try precise (league + team) first
    if (wantTeam) {
      const own = await db.oneOrNone(
        `SELECT member_id
           FROM ff_sport_ffl
          WHERE league_id = $1 AND team_id = $2
          ORDER BY last_seen_at DESC NULLS LAST, updated_at DESC NULLS LAST
          LIMIT 1`,
        [wantLeague, wantTeam]
      );
      if (own?.member_id) {
        const cred = await db.oneOrNone(
          `SELECT swid, espn_s2
             FROM ff_espn_cred
            WHERE member_id = $1
            ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST
            LIMIT 1`,
          [own.member_id]
        );
        if (cred?.swid && cred?.espn_s2) {
          return { swid: normalizeSwid(cred.swid), s2: cred.espn_s2, source: 'db:league-team' };
        }
      }
    }

    // fall back: anyone seen in this league recently
    const any = await db.oneOrNone(
      `SELECT c.swid, c.espn_s2
         FROM ff_sport_ffl f
         JOIN ff_espn_cred c ON c.member_id = f.member_id
        WHERE f.league_id = $1
        ORDER BY c.last_seen DESC NULLS LAST, f.last_seen_at DESC NULLS LAST
        LIMIT 1`,
      [wantLeague]
    );
    if (any?.swid && any?.espn_s2) {
      return { swid: normalizeSwid(any.swid), s2: any.espn_s2, source: 'db:any-in-league' };
    }
  }

  // 3) Request cookies/headers fallback
  return readReqCreds(req);
}

module.exports = { resolveEspnCred, normalizeSwid };
