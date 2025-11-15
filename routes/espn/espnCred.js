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
    season = req.query?.season || req.params?.season || null,
    leagueId = req.params?.leagueId || req.query?.leagueId || null,
    teamId   = req.query?.teamId   || null,
    memberId = req.query?.memberId || null,
    cand = null,
    allowPublicFallback = !cand,
    extraHeaders = null
  } = ctx || {};

  let cands = [];
  if (cand) {
    cands = [cand];
  } else {
    cands = await resolveEspnCredCandidates({ req, season, leagueId, teamId, memberId });
  }

  if (allowPublicFallback) {
    cands.push({ swid: '', s2: '', source: 'public' });
  }

  const attempts = [];
  let lastStatus = 0;
  let lastBody = null;
  let lastError = null;

  for (const candItem of cands) {
    try {
      const cookie = [
        candItem?.swid ? `SWID=${candItem.swid}` : '',
        candItem?.s2   ? `espn_s2=${candItem.s2}` : ''
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

      attempts.push({
        status: r.status,
        source: candItem?.source || (candItem?.swid || candItem?.s2 ? 'candidate' : 'public'),
        stale: !!candItem?.stale,
        public: !(candItem?.swid && candItem?.s2),
        swidMasked: candItem?.swid ? maskHeaderSafe(candItem.swid) : ''
      });

      lastStatus = r.status;
      lastBody = text;
      if (r.ok && looksJson) {
        const used =
          candItem?.swid && candItem?.s2
            ? {
                source: candItem.source || 'candidate',
                stale: !!candItem.stale,
                swid: candItem.swid,
                s2: candItem.s2,
                swidMasked: maskHeaderSafe(candItem.swid),
                s2Masked: maskHeaderSafe(candItem.s2)
              }
            : null;
        return {
          status: r.status,
          body: text,
          used,
          attempts
        };
      }
      lastError = `status_${r.status}`;
    } catch (err) {
      attempts.push({
        status: 0,
        source: candItem?.source || (candItem?.swid || candItem?.s2 ? 'candidate' : 'public'),
        stale: !!candItem?.stale,
        public: !(candItem?.swid && candItem?.s2),
        swidMasked: candItem?.swid ? maskHeaderSafe(candItem.swid) : '',
        error: String(err?.message || err)
      });
      lastError = lastError || err;
    }
  }

  return {
    status: lastStatus || 502,
    body: lastBody ?? JSON.stringify({ ok:false, error:'all_candidates_failed' }),
    used: null,
    attempts,
    error: lastError ? String(lastError?.message || lastError) : 'all_candidates_failed'
  };
}

module.exports = { fetchFromEspnWithCandidates, maskHeaderSafe };
