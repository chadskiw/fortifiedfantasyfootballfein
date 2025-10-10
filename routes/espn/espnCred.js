// routes/espn/espnCred.js  (new/central helper)
const { resolveEspnCredCandidates } = require('./_cred');

const mask = (s, keep=6) => !s ? '' : (String(s).length <= keep*2
  ? s[0]+'…'+s.slice(-1)
  : s.slice(0,keep)+'…'+s.slice(-keep));

async function fetchFromEspnWithCandidates(upstreamUrl, req, ctx = {}) {
  const { leagueId = null, teamId = null, memberId = null } = ctx || {};
  const cands = await resolveEspnCredCandidates({ req, leagueId, teamId, memberId });
  cands.push({ swid:'', s2:'', source:'unauth' });

  for (const cand of cands) {
    try {
      const cookie = [
        cand?.swid ? `SWID=${cand.swid}`   : '',
        cand?.s2   ? `espn_s2=${cand.s2}` : ''
      ].filter(Boolean).join('; ');

      const r = await fetch(upstreamUrl, {
        headers: { accept:'application/json, */*', referer:'https://fantasy.espn.com/', ...(cookie?{cookie}:{}) }
      });
      const text = await r.text();
      const okJson = r.ok && ((r.headers.get('content-type')||'').includes('json') || /^[\[{]/.test(text.trim()));
      if (okJson) {
        return { status:r.status, body:text, used:{
          source: cand.source || 'unknown',
          swidMasked: mask(cand.swid),
          s2Masked:   mask(cand.s2),
        }};
      }
    } catch {}
  }
  return { status:502, body: JSON.stringify({ ok:false, error:'all_candidates_failed' }), used:null };
}

module.exports = { fetchFromEspnWithCandidates };
