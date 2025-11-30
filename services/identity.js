// services/identity.js
const pool = require('../src/db/pool');

async function fetchHue(handle, db) {
  if (!handle) return null;
  const { rows } = await db.query(
    `
      SELECT handle,
             COALESCE(color_hex, color_hex) AS color_hex
        FROM ff_quickhitter
       WHERE handle = $1
       LIMIT 1
    `,
    [handle]
  );
  return rows[0]?.color_hex || null;
}

async function fetchIdentityByMemberId(memberId, db) {
  if (!memberId) return null;
  const normalized = String(memberId).trim();
  if (!normalized) return null;

  const { rows } = await db.query(
    `
      SELECT member_id,
             handle,
             COALESCE(color_hex, color_hex) AS color_hex
        FROM ff_quickhitter
       WHERE member_id = $1
       LIMIT 1
    `,
    [normalized]
  );

  if (!rows[0]) return null;
  return {
    memberId: normalized,
    handle: rows[0].handle || normalized,
    hue: rows[0].color_hex || null,
  };
}

async function fetchIdentityByHandle(handle, db) {
  if (!handle) return null;
  const normalized = String(handle).trim();
  if (!normalized) return null;

  const { rows } = await db.query(
    `
      SELECT member_id,
             handle,
             COALESCE(color_hex, color_hex) AS color_hex
        FROM ff_quickhitter
       WHERE LOWER(handle) = LOWER($1)
       LIMIT 1
    `,
    [normalized]
  );

  if (!rows[0]) return null;
  return {
    memberId: rows[0].member_id || null,
    handle: rows[0].handle || normalized,
    hue: rows[0].color_hex || null,
  };
}

async function getCurrentIdentity(req, db = pool) {
  if (!req || !db) return null;

  if (req.identity?.handle) {
    const hue =
      typeof req.identity.hue === 'string'
        ? req.identity.hue
        : await fetchHue(req.identity.handle, db);
    const memberId =
      req.identity.memberId || req.identity.member_id || null;
    return { memberId, handle: req.identity.handle, hue };
  }

  const memberIdSource =
    req.identity?.member_id ||
    req.member?.member_id ||
    req.cookies?.ff_member_id ||
    req.cookies?.ff_member ||
    req.headers['x-ff-member-id'] ||
    '';
  const memberId =
    typeof memberIdSource === 'string' || typeof memberIdSource === 'number'
      ? String(memberIdSource).trim()
      : '';

  if (memberId) {
    const identity = await fetchIdentityByMemberId(memberId, db);
    if (identity?.handle) return identity;
  }

  const raw =
    (req.cookies?.handle ||
      req.cookies?.ff_handle ||
      req.headers['x-ff-handle'] ||
      '')
      .toString()
      .trim();

  if (!raw) return null;

  const identityByHandle = await fetchIdentityByHandle(raw, db);
  if (identityByHandle) return identityByHandle;

  const hue = await fetchHue(raw, db);
  return { memberId: null, handle: raw, hue };
}

module.exports = {
  getCurrentIdentity,
};
