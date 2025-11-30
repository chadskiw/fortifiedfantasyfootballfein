// src/services/UserOverviewService.js
const { pool } = require('../src/db'); // adjust if your pool is elsewhere

let ffMemberHasDisplayName = true;
let ffMemberHasAvatarUrl = true;

async function loadMemberProfile(memberId) {
  const selectBits = ['member_id'];

  selectBits.push(
    ffMemberHasDisplayName
      ? 'handle'
      : "NULL::text AS handle"
  );

  selectBits.push(
    ffMemberHasAvatarUrl
      ? 'avatar_url'
      : "NULL::text AS avatar_url"
  );

  const sql = `
    SELECT ${selectBits.join(', ')}
    FROM ff_member
    WHERE member_id = $1
    LIMIT 1
  `;

  try {
    const { rows } = await pool.query(sql, [memberId]);
    return rows[0] || null;
  } catch (err) {
    const msg = err?.message || '';
    const lowered = msg.toLowerCase();
    let retry = false;

    if (ffMemberHasDisplayName && lowered.includes('handle')) {
      ffMemberHasDisplayName = false;
      retry = true;
    } else if (ffMemberHasAvatarUrl && lowered.includes('avatar_url')) {
      ffMemberHasAvatarUrl = false;
      retry = true;
    } else {
      console.warn('UserOverview: ff_member lookup failed', msg);
    }

    if (retry) {
      return loadMemberProfile(memberId);
    }
    return null;
  }
}

class UserOverviewService {
  /**
   * Return high-level overview of a user's Trash Talk activity.
   * Shape:
   * {
   *   member_id,
   *   handle,
   *   avatar_url,
   *   photo_count,
   *   last_taken_at,
   *   photo_bounds: { has_geo, min_lat, max_lat, ... },
   *   recent_photos: [{ photo_id, r2_key, lat, lon, taken_at, created_at }, ...]
   * }
   */
  async getOverview(memberId) {
    if (!memberId) {
      throw new Error('memberId is required');
    }

    // Try to pull core member info from ff_member if it exists
    let member = await loadMemberProfile(memberId);

    const memberHandle = (member && member.handle) || null;
    const identifierClause = memberHandle
      ? '(member_id = $1 OR handle = $2)'
      : 'member_id = $1';
    const identifierParams = memberHandle
      ? [memberId, memberHandle]
      : [memberId];

    // Geo stats from tt_photo
    const { rows: statRows } = await pool.query(
      `
      SELECT
        COUNT(*)::int AS photo_count,
        MIN(lat)      AS min_lat,
        MAX(lat)      AS max_lat,
        MIN(lon)      AS min_lon,
        MAX(lon)      AS max_lon,
        AVG(lat)      AS center_lat,
        AVG(lon)      AS center_lon,
        MAX(taken_at) AS last_taken_at
      FROM tt_photo
      WHERE ${identifierClause}
        AND lat IS NOT NULL
        AND lon IS NOT NULL
      `,
      identifierParams
    );

    const stats = statRows[0] || {};
    const hasGeo =
      (stats.photo_count || 0) > 0 &&
      stats.center_lat !== null &&
      stats.center_lon !== null;

    // Recent photos (for grid + optional markers)
    const { rows: recentPhotos } = await pool.query(
      `
      SELECT
        photo_id,
        r2_key,
        lat,
        lon,
        taken_at,
        created_at
      FROM tt_photo
      WHERE ${identifierClause}
      ORDER BY taken_at DESC NULLS LAST, created_at DESC
      LIMIT 24
      `,
      identifierParams
    );

    return {
      member_id: memberId,
      handle: (member && member.handle) || memberId,
      avatar_url: member && member.avatar_url ? member.avatar_url : null,
      photo_count: stats.photo_count || 0,
      last_taken_at: stats.last_taken_at || null,
      photo_bounds: hasGeo
        ? {
            min_lat: stats.min_lat,
            max_lat: stats.max_lat,
            min_lon: stats.min_lon,
            max_lon: stats.max_lon,
            center_lat: stats.center_lat,
            center_lon: stats.center_lon,
            has_geo: true,
          }
        : { has_geo: false },
      recent_photos: recentPhotos,
    };
  }
}

module.exports = new UserOverviewService();
