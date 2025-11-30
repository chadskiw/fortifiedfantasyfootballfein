// src/services/UserOverviewService.js
const { pool } = require('../src/db'); // adjust if your pool is elsewhere

class UserOverviewService {
  /**
   * Return high-level overview of a user's Trash Talk activity.
   * Shape:
   * {
   *   member_id,
   *   display_name,
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
    let member = null;
    try {
      const { rows } = await pool.query(
        `
        SELECT member_id, display_name, avatar_url
        FROM ff_member
        WHERE member_id = $1
        `,
        [memberId]
      );
      if (rows.length) {
        member = rows[0];
      }
    } catch (err) {
      console.warn('UserOverview: ff_member lookup failed', err.message);
    }

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
      WHERE member_id = $1
        AND lat IS NOT NULL
        AND lon IS NOT NULL
      `,
      [memberId]
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
      WHERE member_id = $1
      ORDER BY taken_at DESC NULLS LAST, created_at DESC
      LIMIT 24
      `,
      [memberId]
    );

    return {
      member_id: memberId,
      display_name: (member && member.display_name) || memberId,
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
