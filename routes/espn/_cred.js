// routes/espn/_cred.js
// Resolve ESPN cred candidates using your actual tables:
// - ff_sport_ffl(season, league_id, team_id, member_id, platform='espn', ...)
// - ff_espn_cred(cred_id, swid, espn_s2, member_id, first_seen, last_seen, ...)

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

function normSwid(swid) {
  if (!swid) return '';
  const raw = String(swid).replace(/[{}]/g, '').trim();
  return `{${raw}}`;
}

// Pull any creds passed on the request (headers/session/cookies)
function reqCandidates(req) {
  const c = req.cookies || {};
  const h = req.headers || {};
  const s = req.session || {};

  const s2   = h['x-espn-s2']   || s.espn_s2   || c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || '';
  const swid = h['x-espn-swid'] || s.espn_swid || c.SWID    || c.swid    || c.ff_espn_swid || '';

  const out = [];
  if (s2 && swid) {
    out.push({
      source: 'req',
      member_id: s.member_id || null,
      swid: normSwid(swid),
      espn_s2: String(s2).trim(),
    });
  }
  return out;
}

// Map league/team -> member_ids from ff_sport_ffl
async function memberIdsForContext({ season, leagueId, teamId }) {
  const params = [String(season || ''), String(leagueId || '')];
  let sql = `
    SELECT DISTINCT member_id
    FROM ff_sport_ffl
    WHERE platform = 'espn'
      AND season = $1
      AND league_id = $2
      AND member_id IS NOT NULL
  `;
  if (teamId != null && teamId !== '') {
    params.push(String(teamId));
    sql += ` AND team_id = $3`;
  }

  const { rows } = await pool.query(sql, params);
  return rows.map(r => r.member_id).filter(Boolean);
}

// Get freshest creds per member from ff_espn_cred
async function credsForMembers(memberIds) {
  if (!memberIds?.length) return [];
  const sql = `
    SELECT DISTINCT ON (member_id)
      member_id, swid, espn_s2, last_seen
    FROM ff_espn_cred
    WHERE member_id = ANY($1::text[])
      AND swid IS NOT NULL
      AND espn_s2 IS NOT NULL
    ORDER BY member_id, last_seen DESC
  `;
  const { rows } = await pool.query(sql, [memberIds]);
  return rows.map(r => ({
    source: 'db',
    member_id: r.member_id,
    swid: normSwid(r.swid),
    espn_s2: String(r.espn_s2).trim(),
  }));
}

// Optional global fallback: freshest cred in the table (no member_id link)
// If you don't want this, return [] instead.
async function freshestAnyCred() {
  const { rows } = await pool.query(`
    SELECT swid, espn_s2
    FROM ff_espn_cred
    WHERE swid IS NOT NULL AND espn_s2 IS NOT NULL
    ORDER BY last_seen DESC
    LIMIT 1
  `);
  if (!rows.length) return [];
  return [{
    source: 'db-any',
    member_id: null,
    swid: normSwid(rows[0].swid),
    espn_s2: String(rows[0].espn_s2).trim(),
  }];
}

async function resolveEspnCredCandidates({ req, season, leagueId, teamId, debug = false }) {
  const list = [];

  // 1) DB creds tied to this league/team via ff_sport_ffl -> member_id
  try {
    const members = await memberIdsForContext({ season, leagueId, teamId });
    const byMember = await credsForMembers(members);
    list.push(...byMember);
  } catch (e) {
    console.warn('[espn/_cred] member lookup failed:', e.message);
  }

  // 2) Request-provided creds (headers/session/cookies)
  list.push(...reqCandidates(req));

  // 3) Optional: freshest table cred as last resort
  if (!list.length) {
    try {
      list.push(...await freshestAnyCred());
    } catch (e) {
      console.warn('[espn/_cred] global fallback failed:', e.message);
    }
  }

  if (debug) {
    console.log('[espn/_cred] candidates:',
      list.map(c => ({
        source: c.source, member_id: c.member_id,
        hasS2: !!c.espn_s2, hasSWID: !!c.swid
      }))
    );
  }
  return list;
}

module.exports = { resolveEspnCredCandidates };
