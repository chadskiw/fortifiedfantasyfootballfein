// routes/espn/espnCred.js
const { resolveEspnCredCandidates } = require('./_cred');

// simple masker for logging/headers
function mask(val, keep = 4) {
  if (!val) return '';
  const s = String(val);
  if (s.length <= keep * 2) return s[0] + '…' + s.slice(-1);
  return s.slice(0, keep) + '…' + s.slice(-keep);
}

/**
 * Fetch ESPN with multiple credential candidates.
 * - ctx is OPTIONAL
 * - returns { status, body, used }
 */
async function fetchFromEspnWithCandidates(upstreamUrl, req, ctx = {}) {
  const { leagueId = null, teamId = null, memberId = null } = ctx || {};

  const cands = await resolveEspnCredCandidates({ req, leagueId, teamId, memberId });
  // final unauth try
  cands.push({ swid: '', s2: '', source: 'unauth' });

  for (const cand of cands) {
    try {
      const cookie = [
        cand?.swid ? `SWID=${cand.swid}`   : '',
        cand?.s2   ? `espn_s2=${cand.s2}` : ''
      ].filter(Boolean).join('; ');

      const r = await fetch(upstreamUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json, text/plain, */*',
          referer: 'https://fantasy.espn.com/',
          ...(cookie ? { cookie } : {})
        }
      });

      const text = await r.text();
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const okJson = r.ok && (ct.includes('application/json') || /^[\[{]/.test(text.trim()));
      if (okJson) {
        return {
          status: r.status,
          body: text,
          used: {
            source: cand.source || 'unknown',
            swidMasked: mask(cand.swid, 6),
            s2Masked:   mask(cand.s2,  6),
          }
        };
      }
      // else: try next candidate
    } catch {
      // continue to next candidate
    }
  }
  return { status: 502, body: JSON.stringify({ ok:false, error:'all_candidates_failed' }), used: null };
}

module.exports = { fetchFromEspnWithCandidates };
