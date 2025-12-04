const AUDIENCE_MODES = new Set(['public', 'self', 'relationships', 'party', 'custom_list']);
const DEFAULT_RELATIONSHIP_TIERS = ['any'];

function normalizeAudienceMode(raw, fallback = 'public') {
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim().toLowerCase();
  if (!value || !AUDIENCE_MODES.has(value)) return fallback;
  return value;
}

function normalizeRelationshipTiers(raw, fallback = DEFAULT_RELATIONSHIP_TIERS) {
  if (!Array.isArray(raw)) return fallback.slice();
  const cleaned = Array.from(
    new Set(
      raw
        .map((val) => (typeof val === 'string' ? val.trim().toLowerCase() : ''))
        .filter(Boolean)
    )
  );
  if (!cleaned.length) return fallback.slice();
  return cleaned;
}

function normalizeAllowedMembers(raw) {
  if (!Array.isArray(raw)) return [];
  return Array.from(
    new Set(
      raw
        .map((val) => (typeof val === 'string' ? val.trim() : ''))
        .filter(Boolean)
    )
  );
}

function normalizeDate(value) {
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function formatPolicyRow(row) {
  if (!row) {
    return {
      member_id: null,
      default_audience_mode: 'public',
      default_relationship_tiers: DEFAULT_RELATIONSHIP_TIERS.slice(),
      default_party_scope: 'attended',
      auto_share_current_party: true,
    };
  }
  return {
    member_id: row.member_id,
    default_audience_mode: normalizeAudienceMode(row.default_audience_mode, 'public'),
    default_relationship_tiers: Array.isArray(row.default_relationship_tiers)
      ? row.default_relationship_tiers
      : DEFAULT_RELATIONSHIP_TIERS.slice(),
    default_party_scope: typeof row.default_party_scope === 'string'
      ? row.default_party_scope
      : 'attended',
    auto_share_current_party: row.auto_share_current_party !== false,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function formatPhotoSetRow(row) {
  if (!row) return null;
  return {
    photo_set_id: row.photo_set_id,
    member_id: row.member_id,
    label: row.label,
    description: row.description || null,
    default_audience_mode: row.default_audience_mode
      ? normalizeAudienceMode(row.default_audience_mode, 'public')
      : null,
    default_relationship_tiers: Array.isArray(row.default_relationship_tiers)
      ? row.default_relationship_tiers
      : null,
    default_party_id: row.default_party_id || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    photo_count: row.photo_count != null ? Number(row.photo_count) : null,
  };
}

function formatVisibilityRow(row) {
  if (!row) return null;
  return {
    photo_id: row.photo_id,
    owner_member_id: row.owner_member_id,
    audience_mode: row.audience_mode,
    relationship_tiers: Array.isArray(row.relationship_tiers)
      ? row.relationship_tiers
      : DEFAULT_RELATIONSHIP_TIERS.slice(),
    party_id: row.party_id || null,
    allowed_member_ids: Array.isArray(row.allowed_member_ids) ? row.allowed_member_ids : [],
    expires_at: row.expires_at || null,
    policy_updated_at: row.policy_updated_at || null,
  };
}

function buildRelationshipMatchClause(alias, viewerParam) {
  const loweredTiers = `
    ARRAY(
      SELECT LOWER(t)
      FROM unnest(${alias}.relationship_tiers) AS t
    )
  `;

  return `
    EXISTS (
      SELECT 1
      FROM tt_relationships_accepted r
      WHERE r.status = 'active'
        AND (
          (
            r.member_id_from = ${alias}.owner_member_id
            AND r.member_id_to = ${viewerParam}
            AND (
              'any' = ANY(${alias}.relationship_tiers)
              OR LOWER(COALESCE(r.relationship_type_from, '')) = ANY(${loweredTiers})
            )
          )
          OR
          (
            r.member_id_to = ${alias}.owner_member_id
            AND r.member_id_from = ${viewerParam}
            AND (
              'any' = ANY(${alias}.relationship_tiers)
              OR LOWER(COALESCE(r.relationship_type_to, '')) = ANY(${loweredTiers})
            )
          )
        )
    )
  `;
}

function buildPartyMatchClause(alias, viewerParam) {
  return `
    ${alias}.party_id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1
        FROM tt_party p
        WHERE p.party_id = ${alias}.party_id
          AND p.host_member_id = ${viewerParam}
      )
      OR EXISTS (
        SELECT 1
        FROM tt_party_member pm
        WHERE pm.party_id = ${alias}.party_id
          AND pm.member_id = ${viewerParam}
          AND pm.access_level IN ('live','host','cohost')
      )
    )
  `;
}

/**
 * Append a WHERE clause fragment that enforces photo visibility rules.
 * @param {Object} options
 * @param {string|null} options.viewerId
 * @param {string} [options.alias='vis']
 * @param {string[]} options.params
 * @returns {string}
 */
function appendVisibilityFilter({ viewerId, alias = 'vis', params }) {
  if (!alias) alias = 'vis';
  if (!Array.isArray(params)) {
    throw new Error('params array is required for appendVisibilityFilter');
  }

  const notExpired = `(${alias}.expires_at IS NULL OR ${alias}.expires_at > NOW())`;
  const clauses = [`(${alias}.audience_mode = 'public' AND ${notExpired})`];
  let viewerParam = null;

  if (viewerId) {
    params.push(viewerId);
    viewerParam = `$${params.length}`;

    clauses.push(`${alias}.owner_member_id = ${viewerParam}`);

    clauses.push(`
      (${notExpired}
        AND ${alias}.audience_mode = 'custom_list'
        AND ${viewerParam} = ANY(${alias}.allowed_member_ids)
      )
    `);

    clauses.push(`
      (${notExpired}
        AND ${alias}.audience_mode = 'relationships'
        AND ${buildRelationshipMatchClause(alias, viewerParam)}
      )
    `);

    clauses.push(`
      (${notExpired}
        AND ${alias}.audience_mode = 'party'
        AND ${buildPartyMatchClause(alias, viewerParam)}
      )
    `);
  }

  return clauses.length ? `(${clauses.join(' OR ')})` : 'TRUE';
}

module.exports = {
  appendVisibilityFilter,
  normalizeAudienceMode,
  normalizeRelationshipTiers,
  normalizeAllowedMembers,
  normalizeDate,
  formatPolicyRow,
  formatPhotoSetRow,
  formatVisibilityRow,
  DEFAULT_RELATIONSHIP_TIERS,
};
