// routes/espn/_cred.js
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

const s = v => (v == null ? undefined : String(v).trim() || undefined);
const n = v => { const x = Number(v); return Number.isFinite(x) ? x : undefined; };

// ESPN is picky: keep braces + UPPERCASE hex
// ESPN is picky: keep braces + UPPERCASE hex
function normSwid(swid) {
  const raw = (swid ?? '').toString().trim();
  if (!raw) return undefined;

  // strip any braces first
  const noBraces = raw.replace(/[{}]/g, '');

  // strict GUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), case-insensitive
  const m = noBraces.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  if (!m) return undefined;

  return `{${m[0].toUpperCase()}}`;
}


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
  if (Number.isFinite(tid)) { params.push(tid); sql += ` AND team_id = $3::int`; }
  const { rows } = await pool.query(sql, params);
  return rows.map(r => r.member_id).filter(Boolean);
}

// First: use the member's *current* quick_snap SWID, then pull cred by SWID
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
  return rows.map(r => ({
    source: 'quick_snap',
    memberId: r.member_id,
    swid: normSwid(r.swid || r.quick_snap),
    s2: String(r.espn_s2).trim(),
    last_seen: r.last_seen
  }));
}

// Second: any cred rows for that member (legacy, fallback)
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
  return rows.map(r => ({
    source: 'member_link',
    memberId: r.member_id,
    swid: normSwid(r.swid),
    s2: String(r.espn_s2).trim(),
    last_seen: r.last_seen
  }));
}

function isStale(ts, days=3) {
  if (!ts) return true;
  const ageMs = Date.now() - new Date(ts).getTime();
  return ageMs > days*24*3600*1000;
}

// Exported resolver
async function resolveEspnCredCandidates({ req, season, leagueId, teamId }) {
  const out = [];
  try {
    const members = await memberIdsForContext({ season, leagueId, teamId });
    // 1) Prefer quick_snap-specific cred (correct SWID for today)
    out.push(...await credsViaQuickSnap(members));
    // 2) Fallback: any cred by member_id
    if (!out.length) out.push(...await credsForMembers(members));
  } catch (e) {
    console.warn('[espn/_cred] member lookup failed:', e.message);
  }
  // annotate staleness (used by routes to message the FE)
  return out.map(c => ({ ...c, stale: isStale(c.last_seen, 3) }));
}

module.exports = { resolveEspnCredCandidates };
