// src/services/UserOverviewService.js
const { pool } = require('../src/db'); // adjust if your pool is elsewhere
const {
  appendVisibilityFilter,
  formatVisibilityRow,
} = require('./photoVisibility');

let ffMemberHasHandle = true;
let ffMemberHasDisplayName = true;
let ffMemberHasAvatarUrl = true;
let ffQuickhitterHasColorHex = true;
let ttUserThemeExists = true;

const DEFAULT_THEME_STATE = {
  map_hue: 214,
  map_sat: 68,
  map_light: 46,
  motion_enabled: false,
};

function clamp(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function hslToHex(h, s, l) {
  if (
    typeof h !== 'number' ||
    typeof s !== 'number' ||
    typeof l !== 'number'
  ) {
    return null;
  }
  const sat = s / 100;
  const light = l / 100;

  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;

  if (hp >= 0 && hp < 1) {
    r = c;
    g = x;
  } else if (hp >= 1 && hp < 2) {
    r = x;
    g = c;
  } else if (hp >= 2 && hp < 3) {
    g = c;
    b = x;
  } else if (hp >= 3 && hp < 4) {
    g = x;
    b = c;
  } else if (hp >= 4 && hp < 5) {
    r = x;
    b = c;
  } else if (hp >= 5 && hp < 6) {
    r = c;
    b = x;
  }

  const m = light - c / 2;
  const toHex = (channel) =>
    Math.round((channel + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

async function loadUserTheme(memberId) {
  if (!ttUserThemeExists || !memberId) {
    return null;
  }

  try {
    const { rows } = await pool.query(
      `
        SELECT
          map_hue,
          map_sat,
          map_light,
          motion_enabled
        FROM tt_user_theme
        WHERE member_id = $1
        LIMIT 1
      `,
      [memberId]
    );

    if (!rows.length) {
      return null;
    }

    const row = rows[0];
    const hue = clamp(row.map_hue, 0, 360, DEFAULT_THEME_STATE.map_hue);
    const sat = clamp(row.map_sat, 10, 100, DEFAULT_THEME_STATE.map_sat);
    const light = clamp(row.map_light, 10, 70, DEFAULT_THEME_STATE.map_light);
    const accentHex = hslToHex(hue, sat, light);

    return {
      map_hue: hue,
      map_sat: sat,
      map_light: light,
      motion_enabled: row.motion_enabled === true,
      accent_hex: accentHex,
    };
  } catch (err) {
    const lowered = (err?.message || '').toLowerCase();
    if (ttUserThemeExists && lowered.includes('tt_user_theme')) {
      ttUserThemeExists = false;
      console.warn('UserOverview: tt_user_theme table missing, skipping theme load');
      return null;
    }
    console.warn('UserOverview: tt_user_theme lookup failed', err?.message || err);
    return null;
  }
}

async function loadMemberProfile(memberId) {
  const selectBits = ['member_id'];

  selectBits.push(
    ffMemberHasHandle
      ? 'handle'
      : "NULL::text AS handle"
  );

  selectBits.push(
    ffMemberHasDisplayName
      ? 'display_name'
      : "NULL::text AS display_name"
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

    if (ffMemberHasHandle && lowered.includes('handle')) {
      ffMemberHasHandle = false;
      retry = true;
    } else if (ffMemberHasDisplayName && lowered.includes('display_name')) {
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

async function loadQuickhitterProfile(memberId) {
  if (!ffQuickhitterHasColorHex) {
    return null;
  }
  try {
    const { rows } = await pool.query(
      `
        SELECT color_hex
        FROM ff_quickhitter
        WHERE member_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [memberId]
    );
    return rows[0] || null;
  } catch (err) {
    const lowered = (err?.message || '').toLowerCase();
    if (ffQuickhitterHasColorHex && lowered.includes('color_hex')) {
      ffQuickhitterHasColorHex = false;
      return null;
    }
    console.warn('UserOverview: ff_quickhitter lookup failed', err?.message || err);
    return null;
  }
}

class UserOverviewService {
  /**
   * Return high-level overview of a user's Trash Talk activity.
   * viewerId (if provided) is used to filter photos based on visibility rules.
   */
  async getOverview(memberId, options = {}) {
    if (!memberId) {
      throw new Error('memberId is required');
    }
    const viewerId = options.viewerId || null;
    const rawRecentLimit = options?.recentLimit ?? options?.limit;
    const recentLimit = Math.min(
      500,
      Math.max(1, Number.parseInt(rawRecentLimit, 10) || 24)
    );

    // Try to pull core member info from ff_member if it exists
let member = await loadMemberProfile(memberId);
let quickhitter = await loadQuickhitterProfile(memberId);
const theme = await loadUserTheme(memberId);

    const statsParams = [memberId];
    const statsClause = appendVisibilityFilter({
      viewerId,
      alias: 'vis',
      params: statsParams,
    });

    const statsSql = `
      SELECT
        COUNT(*)::int AS photo_count,
        COUNT(*) FILTER (WHERE p.lat IS NOT NULL AND p.lon IS NOT NULL)::int AS geo_count,
        MIN(p.lat) FILTER (WHERE p.lat IS NOT NULL AND p.lon IS NOT NULL) AS min_lat,
        MAX(p.lat) FILTER (WHERE p.lat IS NOT NULL AND p.lon IS NOT NULL) AS max_lat,
        MIN(p.lon) FILTER (WHERE p.lat IS NOT NULL AND p.lon IS NOT NULL) AS min_lon,
        MAX(p.lon) FILTER (WHERE p.lat IS NOT NULL AND p.lon IS NOT NULL) AS max_lon,
        AVG(p.lat) FILTER (WHERE p.lat IS NOT NULL AND p.lon IS NOT NULL) AS center_lat,
        AVG(p.lon) FILTER (WHERE p.lat IS NOT NULL AND p.lon IS NOT NULL) AS center_lon,
        MAX(p.taken_at) AS last_taken_at
      FROM tt_photo p
      JOIN vw_photo_effective_visibility vis
        ON vis.photo_id = p.photo_id
      WHERE p.member_id = $1
        AND ${statsClause}
    `;

    const { rows: statRows } = await pool.query(statsSql, statsParams);

    const stats = statRows[0] || {};
    const hasGeo =
      (stats.geo_count || 0) > 0 &&
      stats.center_lat !== null &&
      stats.center_lon !== null;

    const recentParams = [memberId];
    const recentClause = appendVisibilityFilter({
      viewerId,
      alias: 'vis',
      params: recentParams,
    });
    recentParams.push(recentLimit);

    const recentSql = `
      SELECT
        p.photo_id,
        p.r2_key,
        p.lat,
        p.lon,
        p.taken_at,
        p.created_at,
        vis.audience_mode,
        vis.relationship_tiers,
        vis.party_id,
        vis.allowed_member_ids,
        vis.expires_at,
        vis.policy_updated_at
      FROM tt_photo p
      JOIN vw_photo_effective_visibility vis
        ON vis.photo_id = p.photo_id
      WHERE p.member_id = $1
        AND ${recentClause}
      ORDER BY p.taken_at DESC NULLS LAST, p.created_at DESC
      LIMIT $2
    `;

    const { rows: recentPhotos } = await pool.query(recentSql, recentParams);

    const accentFromTheme = theme?.accent_hex || null;
    const handleColor =
      quickhitter && quickhitter.color_hex ? quickhitter.color_hex : null;

    return {
      member_id: memberId,
      handle:  (member && member.handle) ? member.handle : memberId,
      display_name: member && member.display_name ? member.display_name : null,
      color_hex: handleColor,
      accent_hex: accentFromTheme || handleColor,
      avatar_url: member && member.avatar_url ? member.avatar_url : null,
      map_theme: theme,
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
      recent_photos: recentPhotos.map((row) => ({
        photo_id: row.photo_id,
        r2_key: row.r2_key,
        lat: row.lat,
        lon: row.lon,
        taken_at: row.taken_at,
        created_at: row.created_at,
        visibility: formatVisibilityRow(row),
      })),
    };
  }
}

module.exports = new UserOverviewService();
