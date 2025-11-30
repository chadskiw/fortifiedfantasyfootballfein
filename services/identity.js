// services/identity.js
const pool = require('../src/db/pool');

async function fetchHue(handle, db) {
  if (!handle) return null;
  const { rows } = await db.query(
    `
      SELECT handle,
             COALESCE(hue_hex, color_hex) AS hue_hex
        FROM ff_quickhitter
       WHERE handle = $1
       LIMIT 1
    `,
    [handle]
  );
  return rows[0]?.hue_hex || null;
}

async function getCurrentIdentity(req, db = pool) {
  if (!req || !db) return null;

  if (req.identity?.handle) {
    const hue =
      typeof req.identity.hue === 'string'
        ? req.identity.hue
        : await fetchHue(req.identity.handle, db);
    return { handle: req.identity.handle, hue };
  }

  const raw =
    (req.cookies?.handle ||
      req.cookies?.ff_handle ||
      req.headers['x-ff-handle'] ||
      '')
      .toString()
      .trim();

  if (!raw) return null;

  const hue = await fetchHue(raw, db);
  return { handle: raw, hue };
}

module.exports = {
  getCurrentIdentity,
};
