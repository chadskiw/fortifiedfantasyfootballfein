// routes/espn/link.js
const express = require('express');
const router  = express.Router();

const oneYear = 31536000000;
const cookieOpts = { httpOnly:false, sameSite:'Lax', secure:true, maxAge:oneYear, domain:'fortifiedfantasy.com', path:'/' };

function decodePlus(s){ try{ return decodeURIComponent(String(s||'').replace(/\+/g,'%20')); } catch { return String(s||''); } }
function normalizeSwid(raw){
  let v = decodePlus(raw||'').trim(); if (!v) return '';
  v = v.replace(/^%7B/i,'{').replace(/%7D$/i,'}');
  if (!v.startsWith('{')) v = `{${v.replace(/^\{?/, '').replace(/\}?$/, '')}}`;
  return v.toUpperCase();
}
function mask(s, keep=4){ if(!s) return ''; const mid=Math.max(0,s.length-keep*2); return s.slice(0,keep)+'•'.repeat(mid)+s.slice(-keep); }
function corsOrigin(req){ return req.headers.origin || 'https://fortifiedfantasy.com'; }
function absoluteOrigin(req) {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host  = req.get('x-forwarded-host')  || req.get('host');
  return host ? `${proto}://${host}` : 'https://fortifiedfantasy.com';
}
async function espnFetch(req, path, qs = {}) {
  const origin = absoluteOrigin(req);
  const url = new URL(`${origin}/api/platforms/espn/${path.replace(/^\/+/, '')}`);
  Object.entries(qs).forEach(([k,v]) => { if (v!==undefined && v!==null) url.searchParams.set(k, String(v)); });
  url.searchParams.set('_t', Date.now());
  const headers = {
    'accept': 'application/json',
    'x-espn-swid': req._link?.swid || req.cookies?.SWID || '',
    'x-espn-s2'  : req._link?.s2   || req.cookies?.espn_s2 || '',
  };
  const r = await fetch(url, { headers, redirect:'follow' });
  if (!r.ok) throw new Error(`[${path}] ${r.status} ${r.statusText}`);
  return r.json();
}

router.get('/link', async (req, res) => {
  const ui     = String(req.query.ui || '1') === '1';
  const season = Number(req.query.season) || new Date().getUTCFullYear();
  const to     = String(req.query.to || `${absoluteOrigin(req)}/fein/?season=${season}`);

  // capture creds from query and set cookies for downstream calls
  const swid = normalizeSwid(req.query.swid || req.query.SWID || '');
  const s2   = decodePlus(req.query.s2   || req.query.ESPN_S2 || '');
  req._link  = { swid, s2 };
  if (swid) res.cookie('SWID', swid, cookieOpts);
  if (s2)   res.cookie('espn_s2', s2, cookieOpts);

  if (!ui) {
    // legacy: auto-ingest all (keep for backward compat)
    try { await fetch(`${absoluteOrigin(req)}/api/ingest/espn/fan/season?season=${season}&games=ffl`, {
      method:'POST',
      headers: { 'x-espn-swid': swid, 'x-espn-s2': s2, 'content-type':'application/json' },
      body: JSON.stringify({ season })
    }); } catch {}
    return res.redirect(302, to);
  }

  // Serve the picker UI
  res.type('html').set('Cache-Control','no-store').send(`<!doctype html>
<html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Fortified Fantasy • Link ESPN</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;background:#0f1422;color:#e7eef7;margin:0}
  header,footer{padding:16px 20px}
  main{padding:16px 20px;max-width:960px;margin:0 auto}
  .card{background:#121a2c;border:1px solid #233046;border-radius:14px;margin:12px 0;overflow:hidden}
  .card h3{margin:0;padding:12px 14px;border-bottom:1px solid #223046;font-weight:600}
  .row{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px dashed #223046}
  .row:first-child{border-top:0}
  .btn{background:#2a7fff;color:#fff;border:none;border-radius:10px;padding:10px 14px;cursor:pointer;font-weight:600}
  .btn.secondary{background:#25324a}
  .pill{font-size:12px;background:#1b2538;color:#9fb2c9;border:1px solid #26344c;border-radius:999px;padding:2px 8px;margin-left:8px}
  .muted{color:#9fb2c9}
  .grid{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center}
  a { color:#9fd0ff }
</style>
</head>
<body>
<header>
  <h2>Link your ESPN account<span class="pill">season ${season}</span></h2>
  <div class="muted">SWID: ${mask(swid)} &nbsp;•&nbsp; s2: ${mask(s2)}</div>
</header>
<main>
  <div id="status" class="muted">Fetching your leagues…</div>
  <div id="leagues"></div>
  <div style="margin-top:16px;display:flex;gap:10px">
    <button id="ingest" class="btn">Ingest selected teams</button>
    <button id="tofe" class="btn secondary">Skip to FEIN</button>
  </div>
</main>
<footer class="muted">Problems? Your cookie must include <code>SWID</code> and <code>espn_s2</code> from espn.com. Then reload this page.</footer>

<script>
(async function(){
  const season = ${season};
  const to     = ${JSON.stringify(to)};
  const leaguesEl = document.getElementById('leagues');
  const statusEl  = document.getElementById('status');
  const sel = {};

  function row(html){ const d=document.createElement('div'); d.className='row grid'; d.innerHTML=html; return d; }
  function card(title){ const d=document.createElement('div'); d.className='card'; d.innerHTML='<h3>'+title+'</h3>'; return d; }

  try{
    const poll = await (await fetch('/api/platforms/espn/poll?season='+season+'&scope=season',{credentials:'include'})).json();
    const ids  = (poll.data||poll.leagues||[]).map(x=>String(x.leagueId||x.league_id)).filter(Boolean);
    if(!ids.length){ statusEl.textContent='No leagues found for this season.'; return; }

    statusEl.textContent = 'Found '+ids.length+' league'+(ids.length>1?'s':'');

    for(const leagueId of ids){
      const league = await (await fetch('/api/platforms/espn/league?season='+season+'&leagueId='+leagueId,{credentials:'include'})).json();
      const name = league?.settings?.name || league?.leagueName || league?.name || ('League '+leagueId);
      const teams = (league.teams||[]).map(t=>({id:String(t.teamId||t.id), name:(t.team_name||t.teamName||t.name||'Team '+(t.teamId||t.id)), logo:t.logo||''}));

      const c = card(name+' <span class="pill">ID '+leagueId+'</span>');
      const wrap = document.createElement('div');
      for(const t of teams){
        wrap.appendChild(row('<label><input type="checkbox" data-l="'+leagueId+'" data-t="'+t.id+'"> '+t.name+' <span class="muted">(#'+t.id+')</span></label><img src="'+(t.logo||'/api/image/x')+'" alt="" width="28" height="28" style="border-radius:6px">'));
      }
      c.appendChild(wrap);
      leaguesEl.appendChild(c);
    }

    leaguesEl.addEventListener('change', (e)=>{
      const el = e.target; if(el.tagName!=='INPUT') return;
      const L = el.getAttribute('data-l'); const T = el.getAttribute('data-t');
      sel[L] = sel[L] || new Set();
      if(el.checked) sel[L].add(T); else sel[L].delete(T);
    });

    document.getElementById('ingest').onclick = async ()=>{
      const payload = { season, leagues: Object.entries(sel).map(([leagueId,set])=>({ leagueId, teamIds: Array.from(set) })) };
      if(!payload.leagues.length) { alert('Pick at least one team.'); return; }
      const r = await fetch('/api/espn/link/ingest', { method:'POST', headers:{'content-type':'application/json'}, credentials:'include', body: JSON.stringify(payload) });
      const j = await r.json();
      if(!j.ok){ alert('Ingest failed: '+(j.error||'unknown')); return; }
      location.href = to;
    };

    document.getElementById('tofe').onclick = ()=>{ location.href = to; };

  }catch(e){
    statusEl.textContent = 'Error loading leagues: '+e;
  }
})();
</script>
</body></html>`);
});

// JSON ingest of selected teams into ff_sport_ffl (+cache nudge)
router.post('/link/ingest', async (req, res) => {
  try{
    const pool = req.app.get('pg');
    const { season, leagues } = req.body || {};
    if (!season || !Array.isArray(leagues)) return res.status(400).json({ ok:false, error:'bad_request' });

    for (const L of leagues){
      const leagueId = String(L.leagueId);
      const league = await espnFetch(req, 'league', { season, leagueId });
      const teamById = new Map((league.teams||[]).map(t => [String(t.teamId||t.id), t]));
      for (const teamId of (L.teamIds||[])){
        const t = teamById.get(String(teamId)); if (!t) continue;
        const teamName = t.team_name || t.teamName || t.name || '';
        const ownerGuid = t.ownerGuid || t.memberGuid || t.memberId || null;
        const seasonPts = Number(t?.record?.overall?.pointsFor ?? t?.pointsFor ?? 0) || 0;

        await pool.query(`
          INSERT INTO ff_sport_ffl
            (season, platform, league_id, team_id, team_name, owner_guid, season_pts, updated_at)
          VALUES ($1,'espn',$2,$3,$4,$5,$6,now())
          ON CONFLICT (season, platform, league_id, team_id)
          DO UPDATE SET team_name=EXCLUDED.team_name,
                        owner_guid = COALESCE(EXCLUDED.owner_guid, ff_sport_ffl.owner_guid),
                        season_pts = EXCLUDED.season_pts,
                        updated_at = now()
        `, [season, leagueId, teamId, teamName, ownerGuid, seasonPts]);

        // cache nudge for FEIN list (optional)
        await pool.query(`
          INSERT INTO ff_team_points_cache
            (season, league_id, team_id, team_name, scoring, week, week_pts, season_pts, updated_at)
          VALUES ($1,$2,$3,$4,'PPR',1,$5,$5,now())
          ON CONFLICT (season, league_id, team_id, scoring, week)
          DO UPDATE SET team_name=EXCLUDED.team_name,
                        week_pts=EXCLUDED.week_pts,
                        season_pts=EXCLUDED.season_pts,
                        updated_at=now()
        `, [season, leagueId, teamId, teamName, seasonPts]);
      }
    }
    res.json({ ok:true });
  }catch(e){
    console.error('[link/ingest]', e);
    res.status(500).json({ ok:false, error:'server_error' });
  }
});

module.exports = router;
