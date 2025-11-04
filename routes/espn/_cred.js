// routes/espn/_cred.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const s = (v) => (v == null ? undefined : String(v).trim() || undefined);

function parseSeason(value) {
  const str = s(value);
  if (!str) return undefined;
  const num = Number.parseInt(str, 10);
  return Number.isFinite(num) ? String(num) : undefined;
}

function parseTeamId(value) {
  const str = s(value);
  if (!str) return undefined;
  if (!/^\d+$/.test(str)) return undefined;
  const num = Number.parseInt(str, 10);
  return Number.isFinite(num) ? num : undefined;
}

// ESPN is picky: keep braces + UPPERCASE hex
function normSwid(swid) {
  const raw = (swid ?? '').toString().trim();
  if (!raw) return undefined;

  const noBraces = raw.replace(/[{}]/g, '');
  const m = noBraces.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  if (!m) return undefined;

  return `{${m[0].toUpperCase()}}`;
}

async function memberIdsForContext({ season, leagueId, teamId, memberId }) {
  const seen = new Set();
  const add = (value) => {
    const cleaned = s(value);
    if (cleaned) seen.add(cleaned);
  };

  add(memberId);

  const seasonStr = parseSeason(season);
  const leagueStr = s(leagueId);
  const tid = parseTeamId(teamId);

  if (!leagueStr) {
    return Array.from(seen);
  }

  if (seasonStr && tid != null) {
    const { rows } = await pool.query(
      `
        SELECT DISTINCT member_id
        FROM ff_sport_ffl
        WHERE (platform = '018' OR lower(platform) = 'espn')
          AND season = $1
          AND league_id = $2
          AND team_id = $3::int
          AND member_id IS NOT NULL
      `,
      [seasonStr, leagueStr, tid]
    );
    rows.forEach((r) => add(r.member_id));
    if (seen.size) return Array.from(seen);
  }

  if (seasonStr) {
    const { rows } = await pool.query(
      `
        SELECT DISTINCT member_id
        FROM ff_sport_ffl
        WHERE (platform = '018' OR lower(platform) = 'espn')
          AND season = $1
          AND league_id = $2
          AND member_id IS NOT NULL
      `,
      [seasonStr, leagueStr]
    );
    rows.forEach((r) => add(r.member_id));
    if (seen.size) return Array.from(seen);
  }

  const { rows: anyRows } = await pool.query(
    `
      SELECT DISTINCT member_id
      FROM ff_sport_ffl
      WHERE (platform = '018' OR lower(platform) = 'espn')
        AND league_id = $1
        AND member_id IS NOT NULL
      ORDER BY updated_at DESC NULLS LAST
    `,
    [leagueStr]
  );
  anyRows.forEach((r) => add(r.member_id));

  return Array.from(seen);
}

async function credsViaQuickSnap(memberIds) {
  if (!memberIds?.length) return [];
  const sql = `
    SELECT q.member_id, q.quick_snap, c.swid, c.espn_s2, c.last_seen
    FROM ff_quickhitter q
    JOIN ff_espn_cred c ON replace(upper(c.swid),'{','') = replace(upper(q.quick_snap),'{','')
    WHERE q.member_id = ANY($1::text[])
      AND c.espn_s2 IS NOT NULL
    ORDER BY c.last_seen DESC NULLS LAST
  `;
  const { rows } = await pool.query(sql, [memberIds]);
  return rows.map((r) => ({
    source: 'quick_snap',
    memberId: r.member_id,
    swid: normSwid(r.swid || r.quick_snap),
    s2: String(r.espn_s2).trim(),
    last_seen: r.last_seen,
  }));
}

async function credsForMembers(memberIds) {
  if (!memberIds?.length) return [];
  const sql = `
    SELECT DISTINCT ON (member_id) member_id, swid, espn_s2, last_seen
    FROM ff_espn_cred
    WHERE member_id = ANY($1::text[])
      AND swid IS NOT NULL
      AND espn_s2 IS NOT NULL
    ORDER BY member_id, last_seen DESC NULLS LAST
  `;
  const { rows } = await pool.query(sql, [memberIds]);
  return rows.map((r) => ({
    source: 'member_link',
    memberId: r.member_id,
    swid: normSwid(r.swid),
    s2: String(r.espn_s2).trim(),
    last_seen: r.last_seen,
  }));
}

function isStale(ts, days = 3) {
  if (!ts) return true;
  const ageMs = Date.now() - new Date(ts).getTime();
  return ageMs > days * 24 * 3600 * 1000;
}

async function resolveEspnCredCandidates({ req, season, leagueId, teamId, memberId }) {
  const out = [];
  try {
    const members = await memberIdsForContext({ season, leagueId, teamId, memberId });
    out.push(...await credsViaQuickSnap(members));
    if (!out.length) out.push(...await credsForMembers(members));
  } catch (e) {
    console.warn('[espn/_cred] member lookup failed:', e.message);
  }
  return out.map((c) => ({ ...c, stale: isStale(c.last_seen, 3) }));
}

module.exports = { resolveEspnCredCandidates };