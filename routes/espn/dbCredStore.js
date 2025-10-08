// routes/espn/dbCredStore.js
const pg = require('pg');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const LEAGUE_TO_MEMBER_SQL = `
  select distinct f.member_id
  from ff_sport_ffl f
  where f.league_id = $1
    and f.member_id is not null
    and trim(f.member_id) <> ''
`;

const CREDS_FOR_MEMBERS_SQL = `
  select c.member_id, c.swid, coalesce(c.espn_s2, c.s2) as espn_s2, c.last_seen
  from ff_espn_cred c
  where c.member_id = any($1)
    and c.swid is not null and trim(c.swid) <> ''
    and coalesce(c.espn_s2, c.s2) is not null and trim(coalesce(c.espn_s2, c.s2)) <> ''
  order by c.last_seen desc nulls last
  limit 10
`;

async function memberIdsForLeague(leagueId) {
  const { rows } = await pool.query(LEAGUE_TO_MEMBER_SQL, [String(leagueId)]);
  return rows.map(r => r.member_id);
}

async function credsForMembers(memberIds) {
  if (!memberIds?.length) return [];
  const { rows } = await pool.query(CREDS_FOR_MEMBERS_SQL, [memberIds]);
  return rows.map(r => ({
    member_id: r.member_id,
    swid: r.swid,
    s2: r.espn_s2
  }));
}

module.exports = { memberIdsForLeague, credsForMembers };
