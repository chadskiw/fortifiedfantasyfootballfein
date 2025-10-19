// routes/espn/_cred.js
// Provides ESPN credential candidates in strongest-first order.
// Order: DB (team+league) → DB (league) → session → headers/cookies → public.

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

// Change this to your actual cred table name/columns.
const TABLE = process.env.FF_ESPN_CRED_TABLE || 'ff_espn_cred'; 
// expected columns: member_id, league_id, team_id, swid, s2, is_active, updated_at

function normSwid(swid) {
  if (!swid) return '';
  const raw = String(swid).replace(/[{}]/g, '').trim();
  return `{${raw}}`;
}

function fromReq(req) {
  const c = req.cookies || {};
  const h = req.headers || {};
  const sess = req.session || {};

  const s2 = h['x-espn-s2'] || sess.espn_s2 || c.espn_s2 || c.ESPN_S2 || c.ff_espn_s2 || '';
  const sw = h['x-espn-swid'] || sess.espn_swid || c.SWID || c.swid || c.ff_espn_swid || '';
  const memberId = sess.member_id || null;

  const arr = [];
  if (s2 && sw) arr.push({ source:'req', s2:String(s2).trim(), swid:normSwid(sw), member_id: memberId });
  return { arr, memberId };
}

async function dbCreds({ leagueId, teamId, memberId }) {
  const out = [];

  const qParts = [];
  const params = [];
  let i = 1;

  // strongest: exact league+team match
  if (leagueId && teamId) {
    qParts.push(`(league_id = $${i++} AND team_id = $${i++})`);
    params.push(String(leagueId), String(teamId));
  }
  // league-only
  if (leagueId) {
    qParts.push(`(league_id = $${i++} AND team_id IS NULL)`);
    params.push(String(leagueId));
  }
  // member-only (user’s default creds)
  if (memberId) {
    qParts.push(`(member_id = $${i++} AND league_id IS NULL)`);
    params.push(String(memberId));
  }

  if (!qParts.length) return out;

  const sql = `
    SELECT member_id, league_id, team_id, swid, s2
    FROM ${TABLE}
    WHERE is_active = TRUE
      AND ( ${qParts.join(' OR ')} )
    ORDER BY 
      -- prioritize exact matches first:
      (league_id IS NOT NULL AND team_id IS NOT NULL) DESC,
      (league_id IS NOT NULL AND team_id IS NULL) DESC,
      (member_id IS NOT NULL) DESC,
      updated_at DESC
    LIMIT 5;
  `;
  try {
    const { rows } = await pool.query(sql, params);
    for (const r of rows) {
      if (!r?.s2 || !r?.swid) continue;
      out.push({
        source: 'db',
        member_id: r.member_id || null,
        league_id: r.league_id || null,
        team_id: r.team_id || null,
        s2: String(r.s2).trim(),
        swid: normSwid(r.swid),
      });
    }
  } catch (e) {
    console.warn('[espn/_cred] DB query failed:', e.message);
  }
  return out;
}

async function resolveEspnCredCandidates({ req, leagueId, teamId, debug }) {
  const { arr: reqCands, memberId } = fromReq(req);
  const dbCands = await dbCreds({ leagueId, teamId, memberId });

  // strongest-first list; append a public try LAST in the routers (they already do).
  const list = [...dbCands, ...reqCands];
  if (debug) console.log('[espn/_cred] candidates:', list.map(c => ({ source:c.source, league_id:c.league_id, team_id:c.team_id, member_id:c.member_id })));
  return list;
}

module.exports = { resolveEspnCredCandidates };
