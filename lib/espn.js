const fetch = require('node-fetch');

function normalizeSwid(raw=''){
  return String(raw)
    .trim()
    .replace(/^%7B|%7D$/gi, '')  // encoded braces
    .replace(/[{}]/g, '')        // literal braces
    .toUpperCase();
}

// Optional hard verify (server-side) against ESPN.
// If you want to skip real verification for now, return !!(swid && s2).
async function verifyEspnAuth({ swid, s2 }) {
  if (!swid || !s2) return false;
  try {
    const r = await fetch('https://fantasy.espn.com/apis/v3/games/ffl/seasons/2025', {
      headers: { cookie: `SWID={${swid}}; espn_s2=${s2}` }
    });
    return r.ok;  // true if credentials worked
  } catch {
    return false;
  }
}

module.exports = { normalizeSwid, verifyEspnAuth };
