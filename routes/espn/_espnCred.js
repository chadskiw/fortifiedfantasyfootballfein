// Resolve ESPN credentials strictly on the server using DB lookups.
// No frontend member id; no client cookies.

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
    select swid, espn_s2
    from ff_espn_cred
    where swid = $1
       or swid = upper($1)
       or swid = lower($1)
       or swid = ('{'||lower(regexp_replace($1, '[{}]', '', 'g'))||'}')
    order by last_seen desc nulls last
    limit 1
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

  // 1) Infer member_id from league/team ownership
  let memberId;
  if (LID && TID != null) {
    try {
      const row = await db.oneOrNone(SQL.ownerByTeam, [LID, TID]);
      if (row?.member_id) memberId = s(row.member_id);
    } catch {}
  }

  // 2) If not found via team, try authenticated session (server-side only)
  if (!memberId) {
    memberId =
      s(req?.auth?.member_id) ||
      s(req?.user?.member_id) ||
      s(req?.session?.member_id) ||
      s(req?.cookies?.ff_member_id) || // server-side read only; never echoed to client
      undefined;
  }

  // 3) member -> quick_snap (SWID) -> ff_espn_cred (espn_s2)
  let swid;
  if (memberId) {
    try {
      const qh = await db.oneOrNone(SQL.quickSnapByMember, [memberId]);
      swid = normalizeSwid(qh?.quick_snap);
    } catch {}
  }

  const out = [];
  if (swid) {
    try {
      const cred = await db.oneOrNone(SQL.credBySwid, [swid]);
      if (cred?.espn_s2) {
        out.push({ source: 'quickhitter_swid', swid: cred.swid, s2: cred.espn_s2 });
      }
    } catch {}
  }

  return out;
}

module.exports = { resolveEspnCredCandidates };
