const DEFAULT_SEASON = new Date().getUTCFullYear();
const BASE = (season) => `https://fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0`;

function readCookies(h = "") {
  const o = {}; (h||"").split(/;\s*/).forEach(p=>{
    const i=p.indexOf("="); const k=i<0?p:p.slice(0,i); const v=i<0?"":decodeURIComponent(p.slice(i+1));
    o[k]=v;
  }); return o;
}
function creds(req){
  const c = readCookies(req.headers.get("cookie")||"");
  return {
    SWID: (req.headers.get("X-ESPN-SWID") || c.SWID || "").trim(),
    s2:   (req.headers.get("X-ESPN-S2")   || c.espn_s2 || "").trim()
  };
}
export const onRequestGet = async ({ request }) => {
  const { SWID, s2 } = creds(request);
  const season = Number(new URL(request.url).searchParams.get("season")) || DEFAULT_SEASON;
  if(!SWID || !s2) return new Response(JSON.stringify({error:"missing SWID/espn_s2"}), {status:401});

  const url = `${BASE(season)}/users/${SWID}?view=mTeam`;
  const r = await fetch(url, { headers: { cookie: `SWID=${SWID}; espn_s2=${s2}` }});
  const txt = await r.text();
  return new Response(JSON.stringify({status:r.status, ok:r.ok, url, preview:txt.slice(0,400)}), {
    headers: {"content-type":"application/json"}
  });
};
