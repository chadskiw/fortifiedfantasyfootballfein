// routes/party.js
const express = require('express');
const pool = require('../src/db/pool');
const { getCurrentIdentity } = require('../services/identity');

const router = express.Router();
const jsonParser = express.json({ limit: '512kb' });
const HANDLE_RE = /^[a-z0-9_.-]{3,32}$/i;

function cleanHandle(value) {
  if (!value && value !== 0) return '';
  return String(value).trim();
}

async function requireIdentity(req, res) {
  const me = await getCurrentIdentity(req, pool);
if (!me) return res.status(401).json({ error: 'Not logged in' });
  return me;
}

async function fetchPartyById(partyId) {
  if (!partyId) return null;
  const { rows } = await pool.query(
    `
      SELECT p.*,
             COALESCE(hq.color_hex, hq.color_hex) AS host_hue
        FROM tt_party p
        LEFT JOIN ff_quickhitter hq ON hq.handle = p.host_handle
       WHERE p.party_id = $1
       LIMIT 1
    `,
    [partyId]
  );
  return rows[0] || null;
}

async function fetchMembership(partyId, handle) {
  if (!partyId || !handle) return null;
  const { rows } = await pool.query(
    `
      SELECT pm.*,
             COALESCE(q.color_hex, q.color_hex) AS member_hue
        FROM tt_party_member pm
        LEFT JOIN ff_quickhitter q
          ON q.handle = pm.handle
       WHERE pm.party_id = $1
         AND pm.handle = $2
       LIMIT 1
    `,
    [partyId, handle]
  );
  return rows[0] || null;
}

function serializeParty(row) {
  if (!row) return null;
  return {
    party_id: row.party_id,
    host_handle: row.host_handle,
    host: row.host_handle
      ? { handle: row.host_handle, hue: row.host_hue || null }
      : null,
    name: row.name,
    description: row.description,
    center_lat: row.center_lat,
    center_lon: row.center_lon,
    radius_m: row.radius_m,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    visibility_mode: row.visibility_mode,
    state: row.state,
    cord_cut_at: row.cord_cut_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeMembership(row) {
  if (!row) return null;
  return {
    party_id: row.party_id,
    handle: row.handle,
    access_level: row.access_level,
    invited_by_handle: row.invited_by_handle,
    arrived_at: row.arrived_at,
    last_seen_at: row.last_seen_at,
    left_at: row.left_at,
    hue: row.member_hue || row.hue || null,
  };
}

function toNullableDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNullableNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function degToRad(v) {
  return (v * Math.PI) / 180;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  ) {
    return null;
  }
  const R = 6371000;
  const dLat = degToRad(lat2 - lat1);
  const dLon = degToRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(degToRad(lat1)) *
      Math.cos(degToRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function cleanHandleList(invitees = []) {
  const seen = new Set();
  const result = [];
  invitees.forEach((raw) => {
    const cleaned = cleanHandle(raw);
    if (!cleaned) return;
    if (!HANDLE_RE.test(cleaned)) return;
    const normalized = cleaned.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

router.post('/', async (req, res) => {
  const me = await getCurrentIdentity(req, pool);
  if (!me) return res.status(401).json({ error: 'Not logged in' });

  const {
    name,
    description,
    centerLat,
    centerLon,
    radiusM,
    startsAt,
    endsAt
  } = req.body || {};

  try {
    const sql = `
      INSERT INTO tt_party (
        host_member_id,     -- keep for legacy
        host_handle,        -- new hotness
        name,
        description,
        center_lat,
        center_lon,
        radius_m,
        starts_at,
        ends_at,
        visibility_mode,
        state
      )
      VALUES (
        $1,  -- host_member_id
        $2,  -- host_handle
        $3,  -- name
        $4,  -- description
        $5,  -- center_lat
        $6,  -- center_lon
        COALESCE($7, 75),  -- radius_m
        $8,  -- starts_at
        $9,  -- ends_at
        'private_party',
        'live'
      )
      RETURNING *;
    `;

    const params = [
      me.memberId,      // $1
      me.handle,        // $2
      name,             // $3
      description,      // $4
      centerLat,        // $5
      centerLon,        // $6
      radiusM,          // $7
      startsAt,         // $8
      endsAt            // $9
    ];

    const { rows } = await pool.query(sql, params);
    return res.json(rows[0]);
  } catch (err) {
    console.error('[party:create] error:', err);
    return res.status(500).json({ error: 'Failed to create party' });
  }
});

router.post('/:partyId/invite', jsonParser, async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId } = req.params;
  const invitees = cleanHandleList(req.body?.invitees);
  if (!invitees.length) {
    return res.status(422).json({ ok: false, error: 'invitees_required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hostRes = await client.query(
      'SELECT 1 FROM tt_party WHERE party_id = $1 AND host_handle = $2 LIMIT 1',
      [partyId, me.handle]
    );
    if (!hostRes.rowCount) {
      await client.query('ROLLBACK');
      return res.status(403).json({ ok: false, error: 'not_party_host' });
    }

    await client.query(
      `
        INSERT INTO tt_party_member (party_id, handle, invited_by_handle, access_level)
        SELECT $1, h, $2, 'card'
          FROM UNNEST($3::text[]) AS h
        ON CONFLICT (party_id, handle)
        DO UPDATE SET
          invited_by_handle = EXCLUDED.invited_by_handle,
          access_level      = 'card'
      `,
      [partyId, me.handle, invitees]
    );

    const { rows } = await client.query(
      `
        SELECT pm.*,
               COALESCE(q.color_hex, q.color_hex) AS member_hue
          FROM tt_party_member pm
          LEFT JOIN ff_quickhitter q ON q.handle = pm.handle
         WHERE pm.party_id = $1
           AND pm.handle = ANY($2::text[])
      `,
      [partyId, invitees]
    );

    await client.query('COMMIT');
    return res.json({
      ok: true,
      members: rows.map(serializeMembership),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[party:invite]', err);
    return res.status(500).json({ ok: false, error: 'party_invite_failed' });
  } finally {
    client.release();
  }
});

router.get('/my', async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  try {
    const { rows } = await pool.query(
      `
        SELECT
          p.*,
          host_q.color_hex AS host_hue,
          pm.handle       AS member_handle,
          pm.access_level,
          pm.arrived_at,
          pm.left_at,
          pm.last_seen_at,
          pm.invited_by_handle,
          mem_q.color_hex   AS member_hue
        FROM tt_party p
        LEFT JOIN tt_party_member pm
          ON pm.party_id = p.party_id
         AND pm.handle   = $1
        LEFT JOIN ff_quickhitter host_q ON host_q.handle = p.host_handle
        LEFT JOIN ff_quickhitter mem_q  ON mem_q.handle  = pm.handle
        WHERE p.host_handle = $1
           OR pm.handle     = $1
        ORDER BY p.starts_at DESC NULLS LAST, p.cord_cut_at DESC NULLS LAST
      `,
      [me.handle]
    );

    const byParty = new Map();
    rows.forEach((row) => {
      if (!byParty.has(row.party_id)) {
        byParty.set(row.party_id, {
          party: serializeParty(row),
          membership: null,
        });
      }
      if (row.member_handle) {
        byParty.get(row.party_id).membership = serializeMembership({
          party_id: row.party_id,
          handle: row.member_handle,
          access_level: row.access_level,
          arrived_at: row.arrived_at,
          left_at: row.left_at,
          last_seen_at: row.last_seen_at,
          invited_by_handle: row.invited_by_handle,
          member_hue: row.member_hue,
        });
      }
    });

    return res.json({
      ok: true,
      parties: Array.from(byParty.values()),
    });
  } catch (err) {
    console.error('[party:my]', err);
    return res.status(500).json({ ok: false, error: 'party_query_failed' });
  }
});

router.post('/:partyId/checkin', jsonParser, async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId } = req.params;
  const lat = toNullableNumber(req.body?.lat);
  const lon = toNullableNumber(req.body?.lon);

  try {
    const party = await fetchPartyById(partyId);
    if (!party) return res.status(404).json({ ok: false, error: 'party_not_found' });
    if (party.state === 'cut') return res.status(410).json({ ok: false, error: 'party_cut' });

    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Number.isFinite(party.center_lat) &&
      Number.isFinite(party.center_lon) &&
      Number.isFinite(party.radius_m)
    ) {
      const distance = distanceMeters(
        party.center_lat,
        party.center_lon,
        lat,
        lon
      );
      if (distance != null && distance > party.radius_m * 1.5) {
        return res.status(403).json({
          ok: false,
          error: 'out_of_range',
          distance_m: distance,
          radius_m: party.radius_m,
        });
      }
    }

    const { rows } = await pool.query(
      `
        INSERT INTO tt_party_member (
          party_id,
          handle,
          invited_by_handle,
          access_level,
          arrived_at,
          last_seen_at
        ) VALUES (
          $1,
          $2,
          NULL,
          'live',
          NOW(),
          NOW()
        )
        ON CONFLICT (party_id, handle)
        DO UPDATE SET
          access_level = 'live',
          arrived_at   = COALESCE(tt_party_member.arrived_at, EXCLUDED.arrived_at),
          last_seen_at = EXCLUDED.last_seen_at
        RETURNING *,
          (SELECT COALESCE(color_hex, color_hex) FROM ff_quickhitter WHERE handle = $2) AS member_hue
      `,
      [partyId, me.handle]
    );

    return res.json({
      ok: true,
      party: serializeParty(party),
      membership: serializeMembership(rows[0]),
    });
  } catch (err) {
    console.error('[party:checkin]', err);
    return res.status(500).json({ ok: false, error: 'party_checkin_failed' });
  }
});

router.post('/:partyId/checkout', async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId } = req.params;
  try {
    const { rows } = await pool.query(
      `
        UPDATE tt_party_member
           SET access_level = 'recap',
               left_at      = COALESCE(left_at, NOW()),
               last_seen_at = NOW()
         WHERE party_id = $1
           AND handle   = $2
         RETURNING *,
           (SELECT COALESCE(color_hex, color_hex) FROM ff_quickhitter WHERE handle = $2) AS member_hue
      `,
      [partyId, me.handle]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'membership_not_found' });
    }

    return res.json({
      ok: true,
      membership: serializeMembership(rows[0]),
    });
  } catch (err) {
    console.error('[party:checkout]', err);
    return res.status(500).json({ ok: false, error: 'party_checkout_failed' });
  }
});

router.post('/:partyId/cut', async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `
        UPDATE tt_party
           SET state = 'cut',
               cord_cut_at = NOW()
         WHERE party_id = $1
           AND host_handle = $2
         RETURNING *,
           (SELECT COALESCE(color_hex, color_hex) FROM ff_quickhitter WHERE handle = host_handle) AS host_hue
      `,
      [partyId, me.handle]
    );

    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ ok: false, error: 'not_party_host' });
    }

    await client.query(
      `
        UPDATE tt_photo
           SET party_id = NULL,
               audience = 'private'
         WHERE party_id = $1
      `,
      [partyId]
    );

    await client.query('COMMIT');
    return res.json({ ok: true, party: serializeParty(rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[party:cut]', err);
    return res.status(500).json({ ok: false, error: 'party_cut_failed' });
  } finally {
    client.release();
  }
});

router.get('/:partyId/feed', async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId } = req.params;
  try {
    const party = await fetchPartyById(partyId);
    if (!party) return res.status(404).json({ ok: false, error: 'party_not_found' });
    if (party.state === 'cut') {
      return res.status(410).json({ ok: false, error: 'party_cut' });
    }

    const membership = await fetchMembership(partyId, me.handle);
    if (!membership && party.host_handle !== me.handle) {
      return res.status(403).json({ ok: false, error: 'not_invited' });
    }

    const now = new Date();
    let rangeStart = party.starts_at || null;
    let rangeEnd = party.ends_at || now;

    if (!membership && party.host_handle === me.handle) {
      rangeStart = party.starts_at || null;
      rangeEnd = party.ends_at || now;
    } else if (membership) {
      if (membership.access_level === 'card') {
        return res.status(403).json({ ok: false, error: 'not_checked_in' });
      }
      rangeStart = membership.arrived_at || party.starts_at || null;
      if (membership.access_level === 'live') {
        rangeEnd = now;
      } else {
        rangeEnd =
          membership.left_at ||
          membership.last_seen_at ||
          party.ends_at ||
          now;
      }
    }

    const { rows: photoRows } = await pool.query(
      `
        SELECT t.*,
               COALESCE(q.color_hex, q.color_hex) AS owner_hue
          FROM tt_photo t
          LEFT JOIN ff_quickhitter q ON q.handle = t.handle
         WHERE t.party_id = $1
           AND t.audience = 'party'
           AND ($2::timestamptz IS NULL OR t.taken_at >= $2)
           AND ($3::timestamptz IS NULL OR t.taken_at <= $3)
         ORDER BY t.taken_at ASC NULLS LAST, t.created_at ASC
      `,
      [partyId, rangeStart, rangeEnd || now]
    );

    return res.json({
      ok: true,
      party: serializeParty(party),
      membership: serializeMembership(membership),
      photos: photoRows.map((row) => ({
        photo_id: row.photo_id,
        handle: row.handle,
        hue: row.owner_hue || null,
        r2_key: row.r2_key,
        original_filename: row.original_filename,
        mime_type: row.mime_type,
        lat: row.lat,
        lon: row.lon,
        taken_at: row.taken_at,
        created_at: row.created_at,
        party_id: row.party_id,
        audience: row.audience,
      })),
    });
  } catch (err) {
    console.error('[party:feed]', err);
    return res.status(500).json({ ok: false, error: 'party_feed_failed' });
  }
});

module.exports = router;
