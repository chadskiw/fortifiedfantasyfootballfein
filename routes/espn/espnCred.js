// routes/espn/espnCred.js
const { resolveEspnCredCandidates } = require('./_cred');

// ASCII-only, header-safe mask (no unicode)
const maskHeaderSafe = (s, keep = 6) => {
  if (!s) return '';
  const raw = String(s);
  const start = raw.slice(0, keep).replace(/[^A-Za-z0-9{}\-]/g, '*');
  const end   = raw.slice(-keep).replace(/[^A-Za-z0-9{}\-]/g, '*');
  // 3 dots, ASCII only
  return `${start}...${end}`;
};

async function fetchFromEspnWithCandidates(upstreamUrl, req, ctx = {}) {
  const {
    leagueId = req.params?.leagueId || req.query?.leagueId || null,
    teamId   = req.query?.teamId   || null,
    memberId = req.query?.memberId || null,
    extraHeaders = null
  } = ctx || {};

  const cands = await resolveEspnCredCandidates({ req, leagueId, teamId, memberId });
  cands.push({ swid: '', s2: '', source: 'unauth' });

  for (const cand of cands) {
    try {
      const cookie = [
        cand?.swid ? `SWID=${cand.swid}` : '',
        cand?.s2   ? `espn_s2=${cand.s2}` : ''
      ].filter(Boolean).join('; ');

      const headers = {
        accept: 'application/json, text/plain, */*',
        referer: 'https://fantasy.espn.com/',
        ...(req.headers['user-agent'] ? { 'user-agent': req.headers['user-agent'] } : {}),
        ...(cookie ? { cookie } : {})
      };

      if (extraHeaders && typeof extraHeaders === 'object') {
        for (const [key, value] of Object.entries(extraHeaders)) {
          if (value !== undefined && value !== null && value !== '') {
            headers[key] = value;
          }
        }
      }

      const r = await fetch(upstreamUrl, {
        method: 'GET',
        headers
      });

      const text = await r.text();
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      const looksJson = ct.includes('application/json') || /^[\[{]/.test((text||'').trim());

      if (r.ok && looksJson) {
        return {
          status: r.status,
          body: text,
          used: {
            source: cand.source || 'unknown',
            // header-safe
            swidMasked: maskHeaderSafe(cand.swid || ''),
            s2Masked:   maskHeaderSafe(cand.s2   || ''),
          }
        };
      }
      // else try next candidate
    } catch { /* keep iterating */ }
  }

  return { status: 502, body: JSON.stringify({ ok:false, error:'all_candidates_failed' }), used: null };
}

module.exports = { fetchFromEspnWithCandidates, maskHeaderSafe };
