// routes/espn/_cred.js
const { memberIdsForLeague, credsForMembers } = require('./dbCredStore');

function normSwid(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  return s.startsWith('{') ? s : `{${s.replace(/^\{|\}$/g,'')}}`;
}
const pick = v => (v && String(v).trim()) ? String(v).trim() : '';

async function resolveEspnCredCandidates({ req, leagueId, teamId, debug }) {
  const out = [];

  // 1) Public (no cookies) – lets truly public leagues work
  out.push({ source: 'public', swid: '', s2: '' });

  // 2) Request-supplied (headers/cookies from FE)
  const h = req?.headers || {}, c = req?.cookies || {};
  const reqSwid = normSwid(pick(h['x-espn-swid']) || pick(c.SWID) || pick(c.swid));
  const reqS2   = pick(h['x-espn-s2'] || c.espn_s2 || c.ESPN_S2);
  if (reqSwid && reqS2) out.push({ source:'request', swid:reqSwid, s2:reqS2 });

  // 3) DB: league → member(s) → creds (this is the piece you’re missing)
  try {
    const memberIds = await memberIdsForLeague(leagueId);
    if (memberIds.length) {
      const creds = await credsForMembers(memberIds);
      for (const r of creds) {
        const swid = normSwid(pick(r.swid)), s2 = pick(r.s2);
        if (swid && s2) out.push({ source:'db', member_id:r.member_id, swid, s2 });
      }
    }
  } catch (e) {
    console.warn('[espn/cred] db lookup failed', { leagueId, err: String(e?.message||e) });
  }

  // 4) Optional test creds only with debug=1
  if (String(req?.query?.debug||'') === '1' && process.env.TEST_SWID && process.env.TEST_S2) {
    out.push({ source:'test', swid:normSwid(process.env.TEST_SWID), s2:process.env.TEST_S2 });
  }

  // Dedup while preserving order
  const seen = new Set(), dedup = [];
  for (const cand of out) {
    const key = `${cand.swid}|${cand.s2}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(cand);
  }
  return dedup;
}

module.exports = { resolveEspnCredCandidates };
