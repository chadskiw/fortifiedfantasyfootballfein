// functions/api/platforms/shared/http.js
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

async function jsonFetch(url, { headers = {}, cookies = {}, method = 'GET' } = {}) {
  const h = { 'accept': 'application/json,text/plain,*/*', ...headers };
  const cookieParts = [];
  if (cookies.SWID || cookies.swid) cookieParts.push(`SWID=${cookies.SWID || cookies.swid}`);
  if (cookies.espn_s2) cookieParts.push(`espn_s2=${cookies.espn_s2}`);
  if (cookieParts.length) h['cookie'] = cookieParts.join('; ');
  const res = await fetch(url, { method, headers: h });
  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}: ${text?.slice(0,240)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

module.exports = { jsonFetch };
