// routes/espn/_espnCred.js
// Resolve ESPN credentials strictly on the server using DB lookups.
// We do NOT accept member id from the client and we do NOT read SWID/S2 from client cookies.

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

  // 1) Infer member_id from league/team ownership (server-side only)
  let memberId;
  if (LID && TID != null) {
    try {
      const row = await req.db.oneOrNone(SQL.ownerByTeam, [LID, TID]);
      if (row?.member_id) memberId = cleanStr(row.member_id);
    } catch {}
  }

  // 2) If we can't infer from team, try the authenticated session (still server-side only)
  if (!memberId) {
    memberId =
      cleanStr(req?.auth?.member_id) ||
      cleanStr(req?.user?.member_id) ||
      cleanStr(req?.session?.member_id) ||
      cleanStr(req?.cookies?.ff_member_id) || // only read server-side; never echo to client
      undefined;
  }

  // 3) Map member -> quick_snap (== SWID), then SWID -> espn_s2
  let swid;
  if (memberId) {
    try {
      const qh = await req.db.oneOrNone(SQL.quickSnapByMember, [memberId]);
      swid = normalizeSwid(qh?.quick_snap);
    } catch {}
  }

  const candidates = [];
  if (swid) {
    try {
      const cred = await req.db.oneOrNone(SQL.credBySwid, [swid]);
      if (cred?.espn_s2) {
        candidates.push({
          source: 'quickhitter_swid',
          swid: cred.swid,
          s2: cred.espn_s2
        });
      }
    } catch {}
  }

  // Optional: add other internal fallbacks here if you have them.

  return candidates; // array for fetchJsonWithCred to try in order
}

module.exports = { resolveEspnCredCandidates };
