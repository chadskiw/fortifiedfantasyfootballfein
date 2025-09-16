// src/lib/idCodec.js (server-only)
'use strict';

// 3-digit platform codes. Only digits allowed.
// Add more as needed but KEEP 3 digits per code.
const PLAT_MAP = {
  espn:    '018',
  sleeper: '016',
  yahoo:   '014',
  cbs:     '012',
  mfl:     '010',
  google: '999',
};
const CODE_TO_PLAT = Object.fromEntries(Object.entries(PLAT_MAP).map(([k,v]) => [v,k]));

const TOTAL_LEN = 21;

function onlyDigits(s) {
  return String(s == null ? '' : s).replace(/\D+/g, '');
}
function leftPadDigits(s, width) {
  const d = onlyDigits(s);
  if (d.length >= width) return d.slice(-width); // rightmost width digits
  return d.padStart(width, '0');
}
function twoDigit(nLike) {
  const d = onlyDigits(nLike);
  const n = d ? Number(d) : 0;
  if (!Number.isFinite(n) || n < 0 || n > 99) {
    throw new Error(`idCodec.create: teamId out of range (0..99): ${nLike}`);
  }
  return String(n).padStart(2, '0');
}
function year4(yLike) {
  const d = onlyDigits(yLike);
  if (d.length !== 4) {
    throw new Error(`idCodec.create: season must be 4 digits (YYYY), got "${yLike}"`);
  }
  return d;
}
function platformCode(platform) {
  const key = String(platform || '').toLowerCase().trim();
  const code = PLAT_MAP[key];
  if (!code) {
    const list = Object.keys(PLAT_MAP).join(', ');
    throw new Error(`idCodec.create: unknown platform "${platform}". Known: ${list}`);
  }
  return code; // 3 digits
}

/**
 * Create a 21-digit ID (string).
 * Layout: YYYY PPP LLLLLLLLLLLL TT
 */
function create({ platform = 'espn', season, leagueId, teamId }) {
  const yyyy = year4(season);
  const ppp  = platformCode(platform);
  const l12  = leftPadDigits(leagueId, 12);
  const tt   = twoDigit(teamId);

  const id = `${yyyy}${ppp}${l12}${tt}`;
  if (id.length !== TOTAL_LEN || /\D/.test(id)) {
    throw new Error(`idCodec.create: internal error, produced invalid id "${id}"`);
  }
  return id;
}

/**
 * Parse a 21-digit ID back to parts.
 * Returns: { platform, season (Number), leagueId (string), teamId (string) }
 */
function dissect(id) {
  const s = String(id || '');
  if (s.length !== TOTAL_LEN || /\D/.test(s)) {
    throw new Error(`idCodec.dissect: malformed id "${id}"`);
  }
  const seasonStr   = s.slice(0, 4);
  const platCode    = s.slice(4, 7);
  const leagueFixed = s.slice(7, 19); // 12 digits
  const teamFixed   = s.slice(19, 21); // 2 digits

  const platform = CODE_TO_PLAT[platCode];
  if (!platform) {
    throw new Error(`idCodec.dissect: unknown platform code "${platCode}"`);
  }

  // Recover leagueId by stripping leading zeros (but keep "0" if all zeros)
  const leagueId = leagueFixed.replace(/^0+(?=\d)/, '') || '0';
  const teamId   = String(Number(teamFixed)); // "07" -> "7" (if you prefer keep "07", remove Number())

  return {
    platform,
    season: Number(seasonStr),
    leagueId,
    teamId,
  };
}

/** Optional: quick validator without throwing */
function isValid(id) {
  try { dissect(id); return true; }
  catch { return false; }
}

module.exports = { create, dissect, isValid, PLAT_MAP };
