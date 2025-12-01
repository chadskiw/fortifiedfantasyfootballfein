// routes/party.js
const express = require('express');
const crypto = require('crypto');
const pool = require('../src/db/pool');
const { getCurrentIdentity } = require('../services/identity');

const router = express.Router();
const jsonParser = express.json({ limit: '512kb' });
const HANDLE_RE = /^[a-z0-9_.-]{3,32}$/i;
const REACTION_TYPES = new Set(['heart', 'fire']);
const REACTION_ENTITY_KINDS = new Set(['photo', 'message']);

function createReactionSnapshot() {
  return {
    heart: { total: 0, self: false },
    fire: { total: 0, self: false },
  };
}

function cloneReactionSnapshot(snapshot) {
  const base = createReactionSnapshot();
  if (!snapshot) return base;
  REACTION_TYPES.forEach((type) => {
    if (snapshot[type]) {
      base[type] = {
        total: Number.isFinite(snapshot[type].total) ? snapshot[type].total : 0,
        self: Boolean(snapshot[type].self),
      };
    }
  });
  return base;
}

function buildPartyEntityKey(kind, id) {
  const safeKind = String(kind || '').toLowerCase();
  const safeId =
    id === null || id === undefined ? '' : String(id).trim();
  if (safeKind === 'photo') return `ttphoto:${safeId}`;
  if (safeKind === 'message') return `ttmsg:${safeId}`;
  if (safeKind === 'party') return `ttparty:${safeId}`;
  return `${safeKind}:${safeId}`;
}

function normalizeReactionType(value) {
  const type = String(value || '').toLowerCase();
  if (REACTION_TYPES.has(type)) return type;
  return null;
}

function isReactableKind(kind) {
  return REACTION_ENTITY_KINDS.has(String(kind || '').toLowerCase());
}

async function fetchReactionSnapshots(client, entityKeys, userId) {
  const uniqueKeys = Array.from(
    new Set((entityKeys || []).filter((key) => typeof key === 'string' && key))
  );
  const map = new Map();
  if (!uniqueKeys.length) {
    return map;
  }

  const { rows: totalRows } = await client.query(
    `
      SELECT entity_key, type, total
        FROM tt_reaction_totals
       WHERE entity_key = ANY($1::text[])
    `,
    [uniqueKeys]
  );

  totalRows.forEach((row) => {
    const type = normalizeReactionType(row.type);
    if (!type) return;
    if (!map.has(row.entity_key)) {
      map.set(row.entity_key, createReactionSnapshot());
    }
    map.get(row.entity_key)[type].total = Number(row.total) || 0;
  });

  if (userId) {
    const { rows: userRows } = await client.query(
      `
        SELECT entity_key, type, qty
          FROM tt_reaction_user
         WHERE entity_key = ANY($1::text[])
           AND user_id = $2
      `,
      [uniqueKeys, String(userId)]
    );

    userRows.forEach((row) => {
      const type = normalizeReactionType(row.type);
      if (!type) return;
      if (!map.has(row.entity_key)) {
        map.set(row.entity_key, createReactionSnapshot());
      }
      map.get(row.entity_key)[type].self = Number(row.qty) > 0;
    });
  }

  uniqueKeys.forEach((key) => {
    if (!map.has(key)) {
      map.set(key, createReactionSnapshot());
    }
  });

  return map;
}

async function resolvePartyReactionTarget(client, partyId, targetKindRaw, targetId) {
  const kind = String(targetKindRaw || '').toLowerCase();
  if (!isReactableKind(kind)) return null;
  if (!targetId) return null;

  if (kind === 'photo') {
    const { rows } = await client.query(
      `
        SELECT photo_id, party_id, audience
          FROM tt_photo
         WHERE photo_id::text = $1::text
           AND party_id = $2
         LIMIT 1
      `,
      [String(targetId), partyId]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      entityKey: buildPartyEntityKey('photo', row.photo_id),
      kind: 'photo',
      partyId: row.party_id,
      audience: row.audience || 'party',
      targetId: row.photo_id,
    };
  }

  if (kind === 'message') {
    const { rows } = await client.query(
      `
        SELECT message_id, party_id
          FROM tt_party_message
         WHERE message_id::text = $1::text
           AND party_id = $2
         LIMIT 1
      `,
      [String(targetId), partyId]
    );
    if (!rows.length) return null;
    const row = rows[0];
    return {
      entityKey: buildPartyEntityKey('message', row.message_id),
      kind: 'message',
      partyId: row.party_id,
      audience: 'party',
      targetId: row.message_id,
    };
  }

  return null;
}

async function applyReactionDelta(client, payload) {
  const {
    entityKey,
    kind,
    reactionType,
    userId,
    partyId,
    audience,
  } = payload;

  const normalizedType = normalizeReactionType(reactionType);
  if (!normalizedType) {
    throw new Error('invalid_reaction');
  }
  const userKey = String(userId || '').trim();
  if (!userKey) {
    throw new Error('user_required');
  }

  const existing = await client.query(
    `
      SELECT qty
        FROM tt_reaction_user
       WHERE entity_key = $1
         AND kind = $2
         AND user_id = $3
         AND type = $4
       LIMIT 1
    `,
    [entityKey, kind, userKey, normalizedType]
  );

  let delta = 1;
  if (existing.rows.length && Number(existing.rows[0].qty) > 0) {
    delta = -1;
    await client.query(
      `
        UPDATE tt_reaction_user
           SET qty = 0,
               updated_at = NOW()
         WHERE entity_key = $1
           AND kind = $2
           AND user_id = $3
           AND type = $4
      `,
      [entityKey, kind, userKey, normalizedType]
    );
  } else {
    await client.query(
      `
        INSERT INTO tt_reaction_user (
          entity_key,
          kind,
          party_id,
          audience,
          user_id,
          type,
          qty
        )
        VALUES ($1, $2, $3, $4, $5, $6, 1)
        ON CONFLICT (kind, entity_key, user_id, type)
        DO UPDATE SET
          qty = 1,
          updated_at = NOW()
      `,
      [entityKey, kind, partyId, audience, userKey, normalizedType]
    );
  }

  await client.query(
    `
      INSERT INTO tt_reaction_totals (
        entity_key,
        kind,
        party_id,
        audience,
        type,
        total
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (kind, entity_key, type)
      DO UPDATE SET
        total = GREATEST(tt_reaction_totals.total + $6, 0),
        updated_at = NOW()
    `,
    [entityKey, kind, partyId, audience, normalizedType, delta]
  );

  return delta;
}

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

async function requirePartyAccess(req, res, next) {
  try {
    const me = await getCurrentIdentity(req, pool);
    if (!me) {
      return res.status(401).json({ error: 'not_logged_in' });
    }
    const { partyId } = req.params;
    if (!partyId) {
      return res.status(400).json({ error: 'party_id_required' });
    }
    const party = await fetchPartyById(partyId);
    if (!party) {
      return res.status(404).json({ error: 'party_not_found' });
    }
    if ((party.state || '').toLowerCase() === 'cut') {
      return res.status(410).json({ error: 'party_cut' });
    }

    const hostHandle = (party.host_handle || '').toLowerCase();
    const myHandle = (me.handle || '').toLowerCase();
    const isHost = hostHandle && myHandle && hostHandle === myHandle;

    let membership = null;
    if (!isHost) {
      membership = await fetchMembership(partyId, me.handle);
      if (!membership) {
        return res.status(403).json({ error: 'not_invited' });
      }
      const accessLevel = (membership.access_level || '').toLowerCase();
      if (accessLevel === 'declined') {
        return res.status(403).json({ error: 'party_declined' });
      }
      if (accessLevel === 'card') {
        return res.status(403).json({ error: 'not_checked_in' });
      }
    } else {
      membership = {
        party_id: party.party_id,
        member_id: me.memberId || me.member_id || null,
        handle: me.handle,
        access_level: 'host',
      };
    }

    req.me = me;
    req.party = party;
    req.membership = membership;
    req.member = {
      member_id: membership?.member_id || me.memberId || me.member_id || null,
      handle: me.handle,
      access_level: membership?.access_level || (isHost ? 'host' : 'guest'),
    };
    req.isPartyHost = isHost;
    next();
  } catch (err) {
    next(err);
  }
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
    member_id: row.member_id || null,
    handle: row.handle,
    access_level: row.access_level,
    invited_by_handle: row.invited_by_handle,
    arrived_at: row.arrived_at,
    last_seen_at: row.last_seen_at,
    left_at: row.left_at,
    invite_token: row.invite_token || null,
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

    const hostMemberId = me.memberId || me.member_id || me.handle || null;

    await client.query(
      `
        WITH incoming AS (
          SELECT DISTINCT ON (LOWER(h)) h AS raw_handle, LOWER(h) AS norm_handle
            FROM UNNEST($3::text[]) AS h
        ),
        resolved AS (
          SELECT
            $1::uuid AS party_id,
            COALESCE(q.member_id, incoming.raw_handle) AS member_id,
            COALESCE(q.handle, incoming.raw_handle)    AS handle
          FROM incoming
          LEFT JOIN ff_quickhitter q
            ON LOWER(q.handle) = incoming.norm_handle
        )
        INSERT INTO tt_party_member (
          party_id,
          member_id,
          handle,
          invited_by,
          invited_by_handle,
          access_level
        )
        SELECT
          party_id,
          member_id,
          handle,
          $4,
          $2,
          'card'
        FROM resolved
        ON CONFLICT (party_id, handle)
        DO UPDATE SET
          invited_by_handle = EXCLUDED.invited_by_handle,
          invited_by        = COALESCE(EXCLUDED.invited_by, tt_party_member.invited_by),
          access_level      = COALESCE(tt_party_member.access_level, 'card'),
          member_id         = COALESCE(tt_party_member.member_id, EXCLUDED.member_id)
      `,
      [partyId, me.handle, invitees, hostMemberId]
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

router.post('/:partyId/reactions', jsonParser, requirePartyAccess, async (req, res) => {
  const { partyId } = req.params;
  const targetKind = String(req.body?.targetKind || '').toLowerCase();
  const targetId = req.body?.targetId;
  const reactionType = normalizeReactionType(req.body?.reaction);

  if (!isReactableKind(targetKind)) {
    return res.status(422).json({ ok: false, error: 'unsupported_entity_kind' });
  }
  if (!targetId) {
    return res.status(422).json({ ok: false, error: 'target_required' });
  }
  if (!reactionType) {
    return res.status(422).json({ ok: false, error: 'invalid_reaction' });
  }

  const userId =
    req.member?.member_id ||
    req.me?.memberId ||
    req.me?.member_id ||
    null;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'not_logged_in' });
  }

  const client = await pool.connect();
  try {
    const target = await resolvePartyReactionTarget(
      client,
      partyId,
      targetKind,
      targetId
    );
    if (!target) {
      return res.status(404).json({ ok: false, error: 'target_not_found' });
    }

    await client.query('BEGIN');
    await applyReactionDelta(client, {
      entityKey: target.entityKey,
      kind: target.kind,
      reactionType,
      userId,
      partyId: target.partyId || partyId,
      audience: target.audience || 'party',
    });
    const snapshots = await fetchReactionSnapshots(
      client,
      [target.entityKey],
      userId
    );
    await client.query('COMMIT');
    return res.json({
      ok: true,
      entityKey: target.entityKey,
      reactions: snapshots.get(target.entityKey) || createReactionSnapshot(),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[party:reaction]', err);
    return res.status(500).json({ ok: false, error: 'reaction_failed' });
  } finally {
    client.release();
  }
});

router.post('/:partyId/rsvp', jsonParser, async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId } = req.params;
  const decisionRaw = (req.body?.decision || 'yes').toString().toLowerCase();
  const decision = decisionRaw === 'no' ? 'no' : 'yes';

  try {
    const party = await fetchPartyById(partyId);
    if (!party) {
      return res.status(404).json({ ok: false, error: 'party_not_found' });
    }
    if (party.state === 'cut') {
      return res.status(410).json({ ok: false, error: 'party_cut' });
    }

    const inviteToken = crypto.randomBytes(12).toString('hex');
    const memberIdValue = me.memberId || me.member_id || me.handle;

    const { rows } = await pool.query(
      `
        INSERT INTO tt_party_member (
          party_id,
          member_id,
          handle,
          invite_token,
          invited_by_handle,
          access_level,
          last_seen_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          NULL,
          CASE WHEN $5 = 'no' THEN 'declined' ELSE 'card' END,
          NOW()
        )
        ON CONFLICT (party_id, handle)
        DO UPDATE SET
          member_id = COALESCE(tt_party_member.member_id, EXCLUDED.member_id),
          invite_token = EXCLUDED.invite_token,
          access_level = CASE
            WHEN $5 = 'no' THEN 'declined'
            ELSE COALESCE(tt_party_member.access_level, 'card')
          END,
          last_seen_at = NOW()
        RETURNING *,
          (SELECT COALESCE(color_hex, color_hex) FROM ff_quickhitter WHERE handle = $3) AS member_hue
      `,
      [partyId, memberIdValue, me.handle, inviteToken, decision]
    );

    if (!rows.length) {
      return res.status(500).json({ ok: false, error: 'party_rsvp_failed' });
    }

    return res.json({
      ok: true,
      membership: serializeMembership(rows[0]),
    });
  } catch (err) {
    console.error('[party:rsvp]', err);
    return res.status(500).json({ ok: false, error: 'party_rsvp_failed' });
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
          pm.member_id,
          pm.handle       AS member_handle,
          pm.access_level,
          pm.arrived_at,
          pm.left_at,
          pm.last_seen_at,
          pm.invited_by_handle,
          pm.invite_token,
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
    const meHandleLower = (me.handle || '').toLowerCase();
    const hostPartyIds = new Set();
    rows.forEach((row) => {
      if (!byParty.has(row.party_id)) {
        byParty.set(row.party_id, {
          party: serializeParty(row),
          membership: null,
          guests: [],
        });
      }
      if ((row.host_handle || '').toLowerCase() === meHandleLower) {
        hostPartyIds.add(row.party_id);
      }
      if (row.member_handle) {
        byParty.get(row.party_id).membership = serializeMembership({
          party_id: row.party_id,
          member_id: row.member_id,
          handle: row.member_handle,
          access_level: row.access_level,
          arrived_at: row.arrived_at,
          left_at: row.left_at,
          last_seen_at: row.last_seen_at,
          invited_by_handle: row.invited_by_handle,
          invite_token: row.invite_token,
          member_hue: row.member_hue,
        });
      }
    });

    if (hostPartyIds.size) {
      const { rows: guestRows } = await pool.query(
        `
          SELECT
            pm.*,
            COALESCE(q.color_hex, q.color_hex) AS member_hue
          FROM tt_party_member pm
          LEFT JOIN ff_quickhitter q ON q.handle = pm.handle
          WHERE pm.party_id = ANY($1::uuid[])
        `,
        [Array.from(hostPartyIds)]
      );

      guestRows.forEach((memberRow) => {
        const entry = byParty.get(memberRow.party_id);
        if (!entry) return;
        const hostHandle = (entry.party?.host_handle || '').toLowerCase();
        if ((memberRow.handle || '').toLowerCase() === hostHandle) return;
        entry.guests.push(serializeMembership(memberRow));
      });
    }

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

router.get('/:partyId/feed', requirePartyAccess, async (req, res, next) => {
  const { partyId } = req.params;
  const memberId = req.member.member_id;
  const client = await pool.connect();

  try {
    // 1) Load party
    const { rows: [party] } = await client.query(`
      SELECT
        p.*,
        host.handle AS host_handle
      FROM tt_party p
      JOIN ff_member host ON host.member_id = p.host_member_id
      WHERE p.party_id = $1
    `, [partyId]);

    if (!party) {
      return res.status(404).json({ error: 'party_not_found' });
    }

    // 2) Load posts: messages + photos, all as unified "posts"
    const { rows: posts } = await client.query(`
      WITH party_ctx AS (
        SELECT
          party_id,
          host_member_id,
          starts_at,
          COALESCE(ends_at, starts_at + INTERVAL '12 hours') AS ends_at
        FROM tt_party
        WHERE party_id = $1
      )

      SELECT *
      FROM (
        -- Text messages
        SELECT
          'message' AS kind,
          m.message_id      AS id,
          m.party_id,
          m.member_id,
          u.handle,
          m.body,
          NULL::text        AS r2_key,
          NULL::timestamptz AS taken_at,
          m.created_at      AS event_time,
          CASE
            WHEN m.created_at <  ctx.starts_at THEN 'preparty'
            WHEN m.created_at >  ctx.ends_at   THEN 'recap'
            ELSE 'live'
          END AS phase
        FROM tt_party_message m
        JOIN party_ctx ctx ON ctx.party_id = m.party_id
        JOIN ff_member u   ON u.member_id  = m.member_id

        UNION ALL

        -- Photos
        SELECT
          'photo'          AS kind,
          ph.photo_id      AS id,
          ph.party_id,
          ph.member_id,
          u.handle,
          NULL::text       AS body,
          ph.r2_key,
          ph.taken_at,
          COALESCE(ph.taken_at, ph.created_at) AS event_time,
          CASE
            WHEN COALESCE(ph.taken_at, ph.created_at) < ctx.starts_at THEN 'preparty'
            WHEN COALESCE(ph.taken_at, ph.created_at) > ctx.ends_at   THEN 'recap'
            ELSE 'live'
          END AS phase
        FROM tt_photo ph
        JOIN party_ctx ctx ON ctx.party_id = ph.party_id
        JOIN ff_member u   ON u.member_id  = ph.member_id
      ) all_posts
      WHERE party_id = $1
      ORDER BY event_time ASC
      LIMIT 512;
    `, [partyId]);

    const reactionKeys = [];
    posts.forEach((row) => {
      if (!isReactableKind(row.kind)) return;
      row.entity_key = buildPartyEntityKey(row.kind, row.id);
      reactionKeys.push(row.entity_key);
    });

    const reactionSnapshots = await fetchReactionSnapshots(
      client,
      reactionKeys,
      memberId
    );
    posts.forEach((row) => {
      if (row.entity_key) {
        row.reactions =
          reactionSnapshots.get(row.entity_key) || createReactionSnapshot();
      }
    });

    // 3) Break into hype / live / recap, but only host gets to seed Hypefest
    const hype = posts.filter(p =>
      p.phase === 'preparty' &&
      p.member_id === party.host_member_id
    );

    const live = posts.filter(p => p.phase === 'live');
    const recap = posts.filter(p => p.phase === 'recap');

    res.json({
      party,
      membership: serializeMembership(req.membership),
      hype,
      feed: live,
      recap,
    });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

router.post('/:partyId/message', jsonParser, requirePartyAccess, async (req, res) => {
  const { partyId } = req.params;
  const memberId = req.member.member_id;
  const body = (req.body?.body || '').trim();

  if (!req.isPartyHost) {
    return res.status(403).json({ ok: false, error: 'host_only' });
  }

  if (!body) {
    return res.status(422).json({ ok: false, error: 'message_required' });
  }

  try {
    const { rows } = await pool.query(
      `
        INSERT INTO tt_party_message (party_id, member_id, body)
        VALUES ($1, $2, $3)
        RETURNING message_id, party_id, member_id, body, created_at
      `,
      [partyId, memberId, body]
    );

    return res.json({
      ok: true,
      message: rows[0],
    });
  } catch (err) {
    console.error('[party:message]', err);
    return res.status(500).json({ ok: false, error: 'party_message_failed' });
  }
});

// POST /api/party/:partyId/invite
router.post('/:partyId/invite', async (req, res) => {
  const me = await getCurrentIdentity(req, pool);
  if (!me) return res.status(401).json({ error: 'Not logged in' });

  const { partyId } = req.params;
  const { invitees } = req.body || {};      // ["handle1","handle2",...]

  if (!Array.isArray(invitees) || invitees.length === 0) {
    return res.status(400).json({ error: 'No invitees provided' });
  }

  try {
    // 1) Make sure caller is the host
    const hostCheck = await pool.query(
      `SELECT party_id
         FROM tt_party
        WHERE party_id = $1
          AND host_handle = $2`,
      [partyId, me.handle]
    );

    if (hostCheck.rowCount === 0) {
      return res.status(403).json({ error: 'Only the host can invite' });
    }

    // 2) Insert / upsert party_member rows
    const sql = `
      INSERT INTO tt_party_member (
        party_id, handle, invited_by_handle, access_level
      )
      VALUES ($1, $2, $3, 'card')
      ON CONFLICT (party_id, handle)
      DO UPDATE SET
        invited_by_handle = EXCLUDED.invited_by_handle,
        access_level      = 'card'
      RETURNING party_id, handle, invited_by_handle, access_level, arrived_at, left_at;
    `;

    const invitedRows = [];
    for (const h of invitees) {
      const trimmed = String(h).trim();
      if (!trimmed) continue;
      const { rows } = await pool.query(sql, [partyId, trimmed, me.handle]);
      invitedRows.push(rows[0]);
    }

    return res.json({ success: true, invited: invitedRows });
  } catch (err) {
    console.error('[party:invite] error:', err);
    return res.status(500).json({ error: 'Failed to send invites' });
  }
});
module.exports = router;
