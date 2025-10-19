// routes/espn/_fetch.js
// Wraps fetch to add ESPN Cookie header when creds present.

async function fetchJsonWithCred(url, cand = {}) {
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'User-Agent': 'ff-platform-service/1.0'
  };

  const s2   = (cand && cand.s2)   ? String(cand.s2).trim() : '';
  const swid = (cand && cand.swid) ? String(cand.swid).trim() : '';

  if (s2 && swid) {
    headers['Cookie'] = `espn_s2=${s2}; SWID=${swid}`;
  }

  const r = await fetch(url, { headers });
  const text = await r.text().catch(()=>'');
  let json = null; try { json = JSON.parse(text); } catch {}

  return { ok: r.ok, status: r.status, statusText: r.statusText, text, json };
}

module.exports = { fetchJsonWithCred };
