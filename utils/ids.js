// utils/ids.js
function readLeagueId(raw){
  const s = String(raw ?? '').trim();
  if (s === '' || s.toLowerCase() === 'null' || s.toLowerCase() === 'undefined') return null;
  return /^\d{6,}$/.test(s) ? s : null; // ESPN league ids are numeric with >= 6 digits
}
module.exports = { readLeagueId };
