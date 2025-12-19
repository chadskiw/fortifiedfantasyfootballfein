const pool = require('../src/db/pool');

async function ensurePrivatePartyForMember(memberId, hostHandle = null) {
  if (!memberId) {
    return null;
  }

  const normalizedHandle =
    typeof hostHandle === 'string' ? hostHandle.trim() || null : null;

  try {
    const existing = await pool.query(
      `
        SELECT party_id
          FROM public.tt_party
         WHERE host_member_id = $1
           AND party_type = 'private'
         ORDER BY created_at DESC
         LIMIT 1
      `,
      [memberId],
    );
    if (existing.rows.length && existing.rows[0].party_id) {
      return existing.rows[0].party_id;
    }
  } catch (err) {
    console.error('[personalParty] lookup failed', err);
  }

  try {
    const inserted = await pool.query(
      `
        INSERT INTO public.tt_party (
          party_id,
          host_member_id,
          name,
          description,
          center_lat,
          center_lon,
          radius_m,
          party_type,
          visibility_mode,
          host_handle
        )
        VALUES (
          gen_random_uuid(),
          $1,
          'Private Party',
          'Auto-created private party',
          0,
          0,
          5000,
          'private',
          'private',
          $2
        )
        RETURNING party_id
      `,
      [memberId, normalizedHandle],
    );
    if (inserted.rows.length && inserted.rows[0].party_id) {
      return inserted.rows[0].party_id;
    }
  } catch (err) {
    console.error('[personalParty] creation failed', err);
  }

  return null;
}

module.exports = {
  ensurePrivatePartyForMember,
};
