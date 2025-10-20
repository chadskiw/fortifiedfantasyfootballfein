// routes/espn/_espnCred.js
// Server-only ESPN cred resolution. No frontend member id, no client cookies.

const getDb = (req) => req.db || req.pg || req.app?.get?.('db');

const SQL = {
  ownerByTeam: `
    select member_id
    from ff_sport_ffl
    where platform = '018' and league_id = $1 and team_id = $2
    limit 1
  `,
  quickSnapByMember: `
    select quick_snap
    from ff_quickhitter
    where member_id = $1
    limit 1
  `,
  credBySwid: `
    select swid, espn_s2, last_seen
    from ff_espn_cred
    where swid = $1
       or swid = upper($1)
       or swid = lower($1)
       or swid = ('{'||lower(regexp_replace($1, '[{}]', '', 'g'))||'}')
    order by last_seen desc nulls last
    limit 1
  `,
  // Fallback: some rows already carry member_id in ff_espn_cred
  credByMember: `
    select swid, espn_s2, last_seen
    from ff_espn_cred
    where member_id = $1
    order by last_seen desc nulls last
    limit 3
  `
};

const s = (v) => (v == null ? undefined : String(v).trim() || undefined);
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : undefined; };
const normalizeSwid = (v) => {
  const q = s(v);
  if (!q) return undefined;
  const m = q.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  return m ? `{${m[0].toLowerCase()}}` : undefined;
};

async function resolveEspnCredCandidates({ req, leagueId, teamId }) {
  const db = getDb(req);
  if (!db) return [];

  const LID = s(leagueId);
  const TID = n(teamId);

  // --- 1) infer owner member_id from league/team (preferred, server-only) ---
  let memberId;
  if (LID && TID != null) {
    try {
      const row = await db.oneOrNone(SQL.ownerByTeam, [LID, TID]);
      if (row?.member_id) memberId = s(row.member_id);
    } catch {}
  }

  // --- 2) else use authenticated session (still server-side only) ---
  if (!memberId) {
    memberId =
      s(req?.auth?.member_id) ||
      s(req?.user?.member_id) ||
      s(req?.session?.member_id) ||
      s(req?.cookies?.ff_member_id) || // read-only on server; never exposed
      undefined;
  }

  const out = [];
  // --- 3) PRIMARY: member -> ff_quickhitter.quick_snap (SWID) -> ff_espn_cred by SWID ---
  if (memberId) {
    try {
      const qh = await db.oneOrNone(SQL.quickSnapByMember, [memberId]);
      const swid = normalizeSwid(qh?.quick_snap);
      if (swid) {
        const cred = await db.oneOrNone(SQL.credBySwid, [swid]);
        if (cred?.espn_s2) {
          out.push({ source: 'quickhitter_swid', swid: cred.swid, s2: cred.espn_s2, memberId });
        }
      }
    } catch {}
  }

  // --- 4) SECONDARY: direct ff_espn_cred by member_id (covers older imports / no quick_snap) ---
  if (!out.length && memberId) {
    try {
      const rows = await db.manyOrNone(SQL.credByMember, [memberId]);
      for (const r of rows) {
        if (s(r.espn_s2) && s(r.swid)) out.push({ source: 'member_fallback', swid: r.swid, s2: r.espn_s2, memberId });
      }
    } catch {}
  }

  return out;
}

module.exports = { resolveEspnCredCandidates };
