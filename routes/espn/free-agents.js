// routes/espn/free-agents.js
const express = require('express');
const router  = express.Router();
const { fetchFromEspnWithCandidates } = require('./espnCred');

const PAGES_ORIGIN = process.env.PAGES_ORIGIN || 'https://fortifiedfantasy.com';
// If your worker moved, set FUNCTION_FREE_AGENTS_PATH in env (ex: '/api/platforms/espn/free-agents')
const FUNCTION_FREE_AGENTS_PATH = process.env.FUNCTION_FREE_AGENTS_PATH || '/api/free-agents';

function buildFreeAgentsUrl({ season, leagueId, week, pos, minProj, onlyEligible }) {
  const u = new URL(FUNCTION_FREE_AGENTS_PATH, PAGES_ORIGIN);
  u.searchParams.set('season', String(season));
  u.searchParams.set('leagueId', String(leagueId));
  u.searchParams.set('week', String(week));
  if (pos) u.searchParams.set('pos', String(pos));
  u.searchParams.set('minProj', String(minProj));
  u.searchParams.set('onlyEligible', String(onlyEligible));
  return u;
}

function boolParam(v, dft = false) {
  if (v === undefined || v === null || v === '') return !!dft;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

function numParam(v, dft = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dft;
}

function safeParseJSON(body) {
  try { return JSON.parse(body || '{}'); }
  catch { return { ok:false, error: 'invalid_json' }; }
}

async function fetchUpstream(url, req, leagueId) {
  const { status, body, used } = await fetchFromEspnWithCandidates(url, req, { leagueId });
  return { status, body, used, json: safeParseJSON(body) };
}

router.get('/free-agents', async (req, res) => {
  try {
    const season       = numParam(req.query.season);              // required
    const leagueId     = String(req.query.leagueId || '');        // required
    const week         = numParam(req.query.week, 1);
    const pos          = String(req.query.pos || 'ALL').toUpperCase();
    const minProj      = numParam(req.query.minProj, 0);          // default 0 (was 2)
    const onlyEligible = boolParam(req.query.onlyEligible, true); // default true
    const autoFallback = boolParam(req.query.autofallback, true); // try once w/ onlyEligible=false if empty
    const echoUpstream = boolParam(req.query.debug, false);       // include upstream URL in JSON too

    if (!season || !leagueId) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    const upstream = buildFreeAgentsUrl({ season, leagueId, week, pos, minProj, onlyEligible });

    // ---- primary call
    const first = await fetchUpstream(upstream.toString(), req, leagueId);

    // creds headers (helpful for debugging which SWID/S2 was used)
    if (first.used) {
      res.set('X-ESPN-Cred-Source', first.used.source);
      res.set('X-ESPN-Cred-SWID',   first.used.swidMasked);
      res.set('X-ESPN-Cred-S2',     first.used.s2Masked);
    }

    // CORS + caching
    res.set('Access-Control-Allow-Origin', req.headers.origin || 'https://fortifiedfantasy.com');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Cache-Control', 'no-store, private');

    // Always expose which upstream URL we called
    res.set('X-FF-FA-Upstream', upstream.toString());

    // If HTTP OK, return JSON (and maybe fallback if it's empty)
    if (first.status >= 200 && first.status < 300) {
      let payload = (first.json && typeof first.json === 'object') ? first.json : {};

       // Determine if "empty" — many workers return {players: []} or {data: []} etc.

      const players = Array.isArray(payload?.players) ? payload.players
                    : Array.isArray(payload?.data)    ? payload.data
                    : Array.isArray(payload?.results) ? payload.results
                    : [];
      // Always expose a players array for downstream consumers
      if (!Array.isArray(payload.players)) payload.players = players;

       const empty = !players || players.length === 0;


      if (empty && autoFallback && onlyEligible === true) {
        // Try one relaxed pass: allow all eligibilities (some weeks ESPN hides FAs unless filters are relaxed)
        const fallbackUrl = buildFreeAgentsUrl({
          season, leagueId, week, pos,
          minProj: 0,
          onlyEligible: false
        });
        const second = await fetchUpstream(fallbackUrl.toString(), req, leagueId);

        res.set('X-FF-FA-Fallback', '1');
        res.set('X-FF-FA-Upstream2', fallbackUrl.toString());

        if (second.status >= 200 && second.status < 300) {
          payload = (second.json && typeof second.json === 'object') ? second.json : {};
          // Mark in the payload for visibility on the client if desired
          if (echoUpstream) {
            payload._ff_debug = {
              primary: upstream.toString(),
              fallback: fallbackUrl.toString()
            };
          }
          return res.json({ ok:true, ...payload });
        }

        // Fallback failed — surface a clear signal
        return res.status(200).json({
          ok:false,
          error: String(second.body || 'fa_upstream_empty'),
          upstream: upstream.toString(),
          upstream_fallback: fallbackUrl.toString()
        });
      }

      if (echoUpstream) {
        payload._ff_debug = { primary: upstream.toString() };
      }
      return res.json({ ok:true, ...payload });
    }

    // Non-2xx from upstream — bubble details
    return res.status(200).json({
      ok:false,
      error: String(first.body || 'upstream_error'),
      upstream: upstream.toString()
    });

  } catch (e) {
    // Last-resort safety
    return res.status(200).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
