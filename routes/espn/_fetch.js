// routes/espn/_fetch.js
async function fetchJsonWithCred(url, cand = {}) {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'ff-platform-service/1.0'
  };

  const s2   = cand?.espn_s2 ? String(cand.espn_s2).trim() : '';
  const swid = cand?.swid    ? String(cand.swid).trim()    : '';

  if (s2 && swid) {
    headers.Cookie = `espn_s2=${s2}; SWID=${swid}`;
  }

  const r = await fetch(url, { headers });
  const text = await r.text().catch(()=>'');
  let json = null; try { json = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, text, json };
}

module.exports = { fetchJsonWithCred };
