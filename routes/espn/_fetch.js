// routes/espn/_fetch.js
async function fetchJsonWithCred(url, cand) {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'ff-platform-service/1.0',
  };
  if (cand?.s2 && cand?.swid) {
    headers['Cookie'] = `espn_s2=${cand.s2}; SWID=${cand.swid}`;
    // (Optional) pass-thru headers too
    headers['x-espn-s2'] = cand.s2; headers['x-espn-swid'] = cand.swid;
  }
  const r = await fetch(url, { headers });
  const text = await r.text().catch(()=> '');
  let json = null; try { json = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, statusText: r.statusText, text, json };
}
module.exports = { fetchJsonWithCred };
