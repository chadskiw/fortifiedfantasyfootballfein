// routes/espn/_cred.js
// Resolve ESPN cred candidates using your DB only
// Chain: ff_sport_ffl.member_id -> ff_quickhitter.quick_snap (SWID) -> ff_espn_cred.espn_s2

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const s = (v) => (v == null ? undefined : String(v).trim() || undefined);
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : undefined; };
const normSwid = (swid) => {
  const raw = s(swid);
  if (!raw) return undefined;
  const m = raw.replace(/[{}]/g,'').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? `{${m[0].toLowerCase()}}` : undefined;
};

// 1) Map league/team -> member_ids (accept '018' or 'espn'; guard teamId)
async function memberIdsForContext({ season, leagueId, teamId }) {
  const params = [String(season||''), String(leagueId||'')];
  let sql = `
    SELECT DISTINCT member_id
    FROM ff_sport_ffl
    WHERE (platform = '018' OR lower(platform) = 'espn')
      AND season = $1
      AND league_id = $2
      AND member_id IS NOT NULL
  `;
  const tid = n(teamId);
  if (Number.isFinite(tid)) {
    params.push(tid);
    sql += ` AND team_id = $3::int`;
  }
  const { rows } = await pool.query(sql, params);
  return rows.map(r => r.member_id).filter(Boolean);
}

// 2a) Creds directly by member_id (freshest per member)
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
    source: 'member_link',
    memberId: r.member_id,
    swid: normSwid(r.swid),
    s2: String(r.espn_s2).trim(),
  }));
}

// 2b) Fallback: member -> quick_snap (SWID) -> cred by SWID
async function credsViaQuickSnap(memberIds) {
  if (!memberIds?.length) return [];
  const sql = `
    SELECT q.member_id, q.quick_snap, c.swid, c.espn_s2, c.last_seen
    FROM ff_quickhitter q
    JOIN ff_espn_cred c
      ON lower(replace(c.swid, '{','')) = lower(replace(q.quick_snap, '{',''))
    WHERE q.member_id = ANY($1::text[])
      AND c.espn_s2 IS NOT NULL
    ORDER BY c.last_seen DESC NULLS LAST
  `;
  const { rows } = await pool.query(sql, [memberIds]);
  return rows.map(r => ({
    source: 'quick_snap',
    memberId: r.member_id,
    swid: normSwid(r.swid || r.quick_snap),
    s2: String(r.espn_s2).trim(),
  }));
}

async function resolveEspnCredCandidates({ req, season, leagueId, teamId, debug=false }) {
  const out = [];
  try {
    const members = await memberIdsForContext({ season, leagueId, teamId });
    out.push(...await credsForMembers(members));
    if (!out.length) out.push(...await credsViaQuickSnap(members));
  } catch (e) {
    console.warn('[espn/_cred] member lookup failed:', e.message);
  }

  // No request/cookie candidates; no global-any fallback (security policy)
  if (debug) {
    console.log('[espn/_cred] candidates:', out.map(c => ({
      source: c.source, memberId: c.memberId, hasS2: !!c.s2, hasSWID: !!c.swid
    })));
  }
  return out;
}

module.exports = { resolveEspnCredCandidates };
