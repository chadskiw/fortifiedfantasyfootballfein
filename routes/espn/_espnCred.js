// resolver/_espnCred.js (or wherever your resolver lives)
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

const cleanStr = v => (v == null ? undefined : String(v).trim() || undefined);
const cleanInt = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const normalizeSwid = (v) => {
  const s = cleanStr(v);
  if (!s) return undefined;
  // Accept raw GUID or {GUID}, force {lowercase}
  const m = s.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (!m) return undefined;
  return `{${m[0].toLowerCase()}}`;
};

async function resolveEspnCredCandidates({ req, leagueId, teamId }) {
  const LID = cleanStr(leagueId);
  const TID = cleanInt(teamId);

  // 1) Try to infer member_id from the team ownership (server-side only)
  let memberId;
  if (LID && TID != null) {
    const row = await req.db.oneOrNone(SQL.ownerByTeam, [LID, TID]).catch(() => null);
    if (row?.member_id) memberId = cleanStr(row.member_id);
  }

  // 2) If not found via team, use the authenticated user on the server
  //    (comes from your auth/session middleware; DO NOT read from client headers)
  if (!memberId) {
    memberId =
      cleanStr(req?.auth?.member_id) ||
      cleanStr(req?.user?.member_id) ||
      cleanStr(req?.session?.member_id) ||
      cleanStr(req?.cookies?.ff_member_id); // ok to read server-side; not echoed to client
  }

  // 3) Map member -> quick_snap (== SWID), then SWID -> cred
  let swid;
  if (memberId) {
    const qh = await req.db.oneOrNone(SQL.quickSnapByMember, [memberId]).catch(() => null);
    swid = normalizeSwid(qh?.quick_snap);
  }

  const candidates = [];

  if (swid) {
    const cred = await req.db.oneOrNone(SQL.credBySwid, [swid]).catch(() => null);
    if (cred?.espn_s2) {
      candidates.push({
        source: 'quickhitter_swid',
        swid: cred.swid,
        s2: cred.espn_s2
      });
    }
  }

  // 4) Optionally: add any other fallbacks you already have (e.g., league-scoped cache)
  // candidates.push(...existingFallbacks);

  return candidates;
}

module.exports = { resolveEspnCredCandidates };
