// routes/espn/link.js
const express = require('express');
const router  = express.Router();

/* -------------------------- helpers -------------------------- */
function decodePlus(s){ try{ return decodeURIComponent(String(s||'').replace(/\+/g,'%20')); } catch { return String(s||''); } }
function normalizeSwid(raw){
  let v = decodePlus(raw||'').trim(); if (!v) return '';
  v = v.replace(/^%7B/i,'{').replace(/%7D$/i,'}');
  if (!v.startsWith('{')) v = `{${v.replace(/^\{?/, '').replace(/\}?$/, '')}}`;
  return v.toUpperCase();
}
function absoluteOrigin(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host  = req.get('x-forwarded-host')  || req.get('host');
  return host ? `${proto}://${host}` : 'https://fortifiedfantasy.com';
}
function setCredCookies(req, res, swid, s2) {
  const oneYear = 31536000000;
  const optsReadable = { httpOnly:false, sameSite:'Lax', secure:true, maxAge:oneYear, domain:'fortifiedfantasy.com', path:'/' };
  if (swid) res.cookie('SWID',    swid, optsReadable);
  if (s2)   res.cookie('espn_s2', s2,   optsReadable);
}
function headerCreds(req) {
  return {
    'x-espn-swid': req.cookies?.SWID || '',
    'x-espn-s2'  : req.cookies?.espn_s2 || '',
    'accept'     : 'application/json'
  };
}

/* ----------------------- HTML Progress UI -------------------- */
// GET /api/espn/link
router.get('/link', async (req, res) => {
  // If explicitly asked to old-behavior redirect, keep it.
  if (String(req.query.mode||'').toLowerCase() === 'redirect') {
    return legacyRedirectFlow(req, res);
  }

  // Normalize & set cookies so the stream endpoint can read them
  const swid = normalizeSwid(req.query.swid || req.query.SWID || req.cookies?.SWID || '');
  const s2   = decodePlus(req.query.espn_s2 || req.query.ESPN_S2 || req.query.s2 || req.cookies?.espn_s2 || '');
  setCredCookies(req, res, swid, s2);

  const season = Number(req.query.season) || new Date().getUTCFullYear();
  const to     = String(req.query.to || `${absoluteOrigin(req)}/fein/?season=${season}`);
  const games  = String(req.query.games || 'ffl');

  // Render a very small no-build HTML page with a live log.
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Linking ESPN…</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.45 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 0; }
  .wrap { max-width: 760px; margin: 40px auto; padding: 0 16px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  .card { background: rgba(127,127,127,.08); border: 1px solid rgba(127,127,127,.25); border-radius: 12px; padding: 16px; }
  .row { display: grid; grid-template-columns: 120px 1fr; gap: 8px 12px; margin: 8px 0; }
  .row b { white-space: nowrap; }
  .log { margin-top: 16px; background: rgba(0,0,0,.06); border-radius: 10px; padding: 12px; height: 360px; overflow:auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;}
  .ok { color: #2f9e44; }
  .warn { color:#e67700; }
  .err { color: #c92a2a; }
  .muted { opacity:.75; }
  .actions { display:flex; gap:12px; margin-top:12px; align-items:center; }
  .btn { appearance: none; border:1px solid rgba(127,127,127,.35); background: transparent; padding:8px 12px; border-radius: 10px; cursor: pointer; }
  a.btn { text-decoration:none; color: inherit; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Connecting your ESPN account…</h1>
  <div class="card">
    <div class="row"><b>Season</b><div>${season}</div></div>
    <div class="row"><b>Games</b><div>${games}</div></div>
    <div class="row"><b>Destination</b><div class="muted">${to.replace(/&/g,'&amp;')}</div></div>
    <div class="actions">
      <a id="skip" class="btn" href="${to.replace(/"/g,'&quot;')}" style="display:none">Skip to app →</a>
      <button id="retry" class="btn" style="display:none">Retry</button>
    </div>
    <div id="status" class="muted" style="margin-top:8px;">Starting…</div>
    <div id="log" class="log" aria-live="polite"></div>
  </div>
</div>
<script>
(function(){
  const qs = new URLSearchParams({ season: '${season}', games: '${games}', to: '${to.replace(/'/g,"\\'")}' });
  const src = new EventSource('/api/espn/link/stream?' + qs.toString(), { withCredentials: true });
  const logEl = document.getElementById('log');
  const statusEl = document.getElementById('status');
  const skipEl = document.getElementById('skip');
  const retryEl = document.getElementById('retry');

  function addLine(text, cls){
    const d = document.createElement('div');
    if (cls) d.className = cls;
    const ts = new Date().toLocaleTimeString();
    d.textContent = '['+ts+'] ' + text;
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
  }

  src.addEventListener('status', (e) => {
    statusEl.textContent = e.data;
    addLine(e.data);
  });

  src.addEventListener('info', (e) => addLine(e.data, 'muted'));
  src.addEventListener('ok',   (e) => addLine('✔ ' + e.data, 'ok'));
  src.addEventListener('warn', (e) => addLine('⚠ ' + e.data, 'warn'));
  src.addEventListener('err',  (e) => addLine('✖ ' + e.data, 'err'));

  src.addEventListener('leagues', (e) => addLine('Leagues: ' + e.data, 'muted'));
  src.addEventListener('league',  (e) => addLine('League: ' + e.data));
  src.addEventListener('team',    (e) => addLine('Team: ' + e.data, 'muted'));

  src.addEventListener('done', (e) => {
    addLine('Done. Redirecting…', 'ok');
    statusEl.textContent = 'Complete';
    skipEl.style.display = '';
    setTimeout(() => { location.href = '${to.replace(/'/g,"\\'")}'; }, 750);
  });

  src.onerror = (e) => {
    addLine('Connection lost. You can retry or continue to the app.', 'warn');
    retryEl.style.display = '';
    skipEl.style.display = '';
  };
  retryEl.onclick = () => location.reload();
})();
</script>
</body>
</html>`);
});

/* ---------------------- SSE progress stream ------------------ */
// GET /api/espn/link/stream?season=2025&games=ffl&to=https://.../fein/?season=2025
router.get('/link/stream', async (req, res) => {
  // Prepare SSE
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${String(data)}\n\n`);

  try {
    // Ensure creds from cookies are present
    const swid = req.cookies?.SWID || '';
    const s2   = req.cookies?.espn_s2 || '';
    if (!swid || !s2) {
      send('err', 'Missing ESPN credentials. Please try linking again.');
      send('status', 'Missing credentials');
      return res.end();
    }

    const season = Number(req.query.season) || new Date().getUTCFullYear();
    const games  = String(req.query.games || 'ffl');
    const origin = absoluteOrigin(req);
    const headers = headerCreds(req);

    send('status', 'Validating credentials…');
    // quick cred check
    try {
      const credR = await fetch(`${origin}/api/platforms/espn/cred`, { headers, redirect:'manual' });
      if (!credR.ok) throw new Error(`cred ${credR.status}`);
      send('ok', 'ESPN credentials accepted');
    } catch(e) {
      send('warn', 'Could not verify credentials via /espn/cred; continuing…');
    }

    send('status', 'Discovering your leagues…');
    const pollR = await fetch(`${origin}/api/platforms/espn/poll?season=${season}&scope=season&_t=${Date.now()}`, { headers });
    if (!pollR.ok) throw new Error(`poll ${pollR.status}`);
    const poll = await pollR.json();
    const leagueIds = Array.isArray(poll?.leagues) ? [...new Set(poll.leagues.map(String))] :
                      Array.isArray(poll?.data)    ? [...new Set(poll.data.map(x=>String(x.leagueId||x.league_id)).filter(Boolean))] :
                      Array.isArray(poll)          ? [...new Set(poll.map(x=>String(x.leagueId||x.league_id)).filter(Boolean))] : [];
    send('leagues', leagueIds.length);
    if (!leagueIds.length) {
      send('warn', 'No leagues found for this season.');
    }

    // Show league + team hydration (read-only) so the user sees activity
    for (const leagueId of leagueIds) {
      const leagueR = await fetch(`${origin}/api/platforms/espn/league?season=${season}&leagueId=${leagueId}&_t=${Date.now()}`, { headers });
      if (leagueR.ok) {
        const league = await leagueR.json();
        const name   = league?.name || league?.leagueName || leagueId;
        send('league', `${name} (${leagueId})`);
        const teamCount = Array.isArray(league?.teams) ? league.teams.length : 10;
        for (const t of (league?.teams || Array.from({length:teamCount}, (_,i)=>({teamId:i+1})))) {
          const teamId = Number(t.teamId ?? t.id);
          if (!Number.isFinite(teamId)) continue;
          // touch roster (server prefetcher does this too)
          await fetch(`${origin}/api/platforms/espn/roster?season=${season}&leagueId=${leagueId}&teamId=${teamId}&scope=season&_t=${Date.now()}`, { headers });
          send('team', `hydrated teamId=${teamId}`);
        }
      } else {
        send('warn', `League ${leagueId} fetch failed (${leagueR.status})`);
      }
    }

    // Now trigger the official ingest (writes DB)
    send('status', 'Writing teams & points to database…');
    const ingestUrl = `${origin}/api/ingest/espn/fan/season?season=${season}&games=${encodeURIComponent(games)}`;
    const ingestR = await fetch(ingestUrl, { method:'POST', headers });
    if (!ingestR.ok) {
      const body = await ingestR.text().catch(()=> '');
      send('warn', `Ingest returned ${ ingestR.status } ${ ingestR.statusText } ${ body ? '— see logs' : '' }`);
    } else {
      const rj = await ingestR.json().catch(()=>({}));
      send('ok', `Ingest complete${rj?.leaguesCount != null ? ` (${rj.leaguesCount} leagues)` : ''}`);
    }

    // Quick verify via pp/teams
    send('status', 'Verifying data is available…');
    const ppR = await fetch(`${origin}/api/pp/teams?sport=ffl&season=${season}`, { headers });
    if (ppR.ok) {
      const arr = await ppR.json();
      const n = Array.isArray(arr) ? arr.length : 0;
      send('ok', `Found ${n} teams in cache`);
    }

    send('done', 'ok');
    res.end();
  } catch (e) {
    send('err', e.message || String(e));
    res.end();
  }
});

/* ---------------- legacy “redirect-only” flow --------------- */
async function legacyRedirectFlow(req, res) {
  try {
    const swid = normalizeSwid(req.query.swid || req.query.SWID || req.cookies?.SWID || '');
    const s2   = decodePlus(req.query.espn_s2 || req.query.ESPN_S2 || req.query.s2 || req.cookies?.espn_s2 || '');
    setCredCookies(req, res, swid, s2);

    const season = Number(req.query.season) || new Date().getUTCFullYear();
    const to     = String(req.query.to || `${absoluteOrigin(req)}/fein/?season=${season}`);
    const games  = String(req.query.games || 'ffl');

    const origin = absoluteOrigin(req);
    const headers = headerCreds(req);
    await fetch(`${origin}/api/ingest/espn/fan/season?season=${season}&games=${encodeURIComponent(games)}`, { method:'POST', headers });

    return res.redirect(302, to);
  } catch (e) {
    console.error('[espn/link redirect]', e);
    const season = new Date().getUTCFullYear();
    return res.redirect(302, `/fein/?season=${season}`);
  }
}

module.exports = router;
