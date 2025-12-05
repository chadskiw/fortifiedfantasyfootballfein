// services/identity.js
const pool = require('../src/db/pool');

function normalizeText(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }
  return '';
}

function buildIdentity(handle, memberId, hue) {
  const normalizedHandle = normalizeText(handle) || null;
  const normalizedMemberId = normalizeText(memberId) || null;
  const normalizedHue = typeof hue === 'string' ? hue : null;

  if (!normalizedHandle && !normalizedMemberId) return null;

  return {
    handle: normalizedHandle,
    memberId: normalizedMemberId,
    member_id: normalizedMemberId,
    hue: normalizedHue,
  };
}

async function fetchIdentityByHandle(handle, db) {
  const normalized = normalizeText(handle);
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

  if (!rows[0]) {
    return buildIdentity(normalized, null, null);
  }

  return buildIdentity(rows[0].handle || normalized, rows[0].member_id, rows[0].color_hex);
}

async function fetchIdentityByMemberId(memberId, db) {
  const normalized = normalizeText(memberId);
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

  if (!rows[0]) {
    return buildIdentity(null, normalized, null);
  }

  return buildIdentity(rows[0].handle, rows[0].member_id, rows[0].color_hex);
}

const PUBLIC_VIEWER_HANDLE = normalizeText(
  process.env.PUBLIC_VIEWER_HANDLE || 'PUBGHOST'
);

function readPublicViewerOverride(req) {
  const rawOverride =
    req.headers?.['x-public-viewer'] ||
    req.headers?.['x-public-viewer-id'] ||
    req.query?.viewerId ||
    req.query?.viewer_id ||
    req.body?.viewerId ||
    req.body?.viewer_id;

  const normalized = normalizeText(rawOverride);
  if (
    normalized &&
    PUBLIC_VIEWER_HANDLE &&
    normalized.toUpperCase() === PUBLIC_VIEWER_HANDLE.toUpperCase()
  ) {
    return PUBLIC_VIEWER_HANDLE;
  }
  return '';
}

function pickMemberId(req) {
  const candidates = [
    req.identity?.member_id,
    req.identity?.memberId,
    req.member?.member_id,
    req.cookies?.ff_member_id,
    req.cookies?.ff_member,
    req.headers?.['x-ff-member-id'],
  ];

  for (const value of candidates) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }

  const publicOverride = readPublicViewerOverride(req);
  if (publicOverride) {
    return publicOverride;
  }

  return '';
}

function pickHandle(req) {
  const candidates = [
    req.identity?.handle,
    req.cookies?.handle,
    req.cookies?.ff_handle,
    req.headers?.['x-ff-handle'],
  ];

  for (const value of candidates) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return '';
}

async function getCurrentIdentity(req, db = pool) {
  if (!req || !db) return null;

  const inlineHue =
    typeof req.identity?.hue === 'string' ? req.identity.hue : null;

  const memberId = pickMemberId(req);
  if (memberId) {
    let identity = await fetchIdentityByMemberId(memberId, db);
    if (identity) {
      if (!identity.handle) {
        const fallbackHandle = pickHandle(req);
        if (fallbackHandle) {
          identity = { ...identity, handle: fallbackHandle };
        }
      }
      return inlineHue ? { ...identity, hue: inlineHue } : identity;
    }
  }

  const handle = pickHandle(req);
  if (!handle) return null;

  const identity = await fetchIdentityByHandle(handle, db);
  if (!identity) return null;
  return inlineHue ? { ...identity, hue: inlineHue } : identity;
}

module.exports = {
  getCurrentIdentity,
};
