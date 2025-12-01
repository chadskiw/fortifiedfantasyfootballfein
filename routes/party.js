// routes/party.js
const express = require('express');
const crypto = require('crypto');
const pool = require('../src/db/pool');
const { getCurrentIdentity } = require('../services/identity');

const router = express.Router();
const jsonParser = express.json({ limit: '512kb' });
const HANDLE_RE = /^[a-z0-9_.-]{3,32}$/i;
const ITEM_KINDS = new Set(['supply', 'task', 'ride', 'cash', 'other']);
const CLAIM_STATUSES = new Set(['promised', 'brought', 'cancelled']);
const NOTE_KINDS = new Set(['note', 'thank_you', 'request', 'announcement']);
const DEFAULT_VIBE = Object.freeze({
  hue: 330,
  saturation: 72,
  brightness: 55,
});
const REACTION_TYPES = new Set(['heart', 'fire']);
const REACTION_ENTITY_KINDS = new Set(['photo', 'message']);
const PARTY_TYPES = new Set(['public', 'private', 'arrival', 'ticket']);
const LOCATION_REQUIRED_PARTY_TYPES = new Set(['arrival', 'ticket']);
const CHECKIN_VIA_VALUES = new Set([
  'manual',
  'auto',
  'nfc',
  'qr',
  'ticket',
  'ticket_scanned',
]);
const DEFAULT_CHECKIN_VIA = 'manual';
const LOCATION_TOLERANCE_MULTIPLIER = 1.5;
const TICKET_OPEN_STATUSES = new Set(['issued', 'assigned', 'pending']);
const TICKET_REDEEMED_STATUS = 'redeemed';
const TICKET_VOID_STATUS = 'void';
const LATE_ENTRY_DEFAULT_GRACE_MINUTES = 0;

class PartyCheckinError extends Error {
  constructor(status, code, meta = null) {
    super(code);
    this.status = status;
    this.code = code;
    this.meta = meta;
  }
}

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

function sanitizeCheckinVia(value) {
  const via = String(value || '').trim().toLowerCase();
  if (CHECKIN_VIA_VALUES.has(via)) {
    return via;
  }
  return DEFAULT_CHECKIN_VIA;
}

function normalizePartyType(party) {
  const value = String(party?.party_type || '').trim().toLowerCase();
  if (PARTY_TYPES.has(value)) {
    return value;
  }
  return 'private';
}

function requiresLocationForParty(party) {
  const type = normalizePartyType(party);
  return LOCATION_REQUIRED_PARTY_TYPES.has(type);
}

function computeLateEntryCutoffMs(party) {
  if (!party?.starts_at) return null;
  const startMs = Date.parse(party.starts_at);
  if (Number.isNaN(startMs)) return null;
  const minutes = Number.isFinite(Number(party.late_entry_grace_minutes))
    ? Number(party.late_entry_grace_minutes)
    : LATE_ENTRY_DEFAULT_GRACE_MINUTES;
  const graceMs = minutes > 0 ? minutes * 60 * 1000 : 0;
  return startMs + graceMs;
}

function hasMemberDeparted(membership) {
  if (!membership) return false;
  return Boolean(membership.left_at);
}

function getMemberIdentifiers(subject = {}) {
  return {
    memberId:
      subject.memberId ??
      subject.member_id ??
      null,
    handle: subject.handle || null,
  };
}

function cleanTicketToken(value) {
  if (value == null) return '';
  return String(value).trim();
}

async function fetchReactionSnapshots(client, entityKeys, userId) {
  const uniqueKeys = Array.from(
    new Set((entityKeys || []).filter((key) => typeof key === 'string' && key))
  );
  const map = new Map();
  if (!uniqueKeys.length) {
    return map;
  }

  // 🔧 totals: reaction -> alias as "type" so the rest of the code keeps working
  const { rows: totalRows } = await client.query(
    `
      SELECT
        entity_key,
        reaction AS type,
        total
      FROM tt_reaction_totals
      WHERE entity_key = ANY($1::text[])
    `,
    [uniqueKeys]
  );

  totalRows.forEach((row) => {
    const type = normalizeReactionType(row.type); // "heart", "fire", etc
    if (!type) return;
    if (!map.has(row.entity_key)) {
      map.set(row.entity_key, createReactionSnapshot());
    }
    map.get(row.entity_key)[type].total = Number(row.total) || 0;
  });

  if (userId) {
    // 🔧 per-user: use member_id + alias reaction as "type"
    const { rows: userRows } = await client.query(
      `
        SELECT
          entity_key,
          reaction AS type,
          qty
        FROM tt_reaction_user
        WHERE entity_key = ANY($1::text[])
          AND member_id = $2
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

  // Ensure every requested key has at least an empty snapshot
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

function cleanText(value, limit = 512) {
  if (value == null) return '';
  const result = String(value).trim();
  if (!limit || limit <= 0) return result;
  return result.slice(0, limit);
}

function equalsIgnoreCase(a, b) {
  if (a == null || b == null) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
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
    host_member_id: row.host_member_id || null,
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
    vibe_hue: toNullableNumber(row.vibe_hue),
    vibe_saturation: toNullableNumber(row.vibe_saturation),
    vibe_brightness: toNullableNumber(row.vibe_brightness),
    party_type: normalizePartyType(row),
    no_late_entry: Boolean(row.no_late_entry),
    no_reentry: Boolean(row.no_reentry),
    late_entry_grace_minutes: toNullableNumber(row.late_entry_grace_minutes),
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

function clampNumber(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return Number.isFinite(min) ? min : Number.isFinite(max) ? max : 0;
  if (Number.isFinite(min) && num < min) return min;
  if (Number.isFinite(max) && num > max) return max;
  return num;
}

function toNumeric(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeVibeValue(input, fallback, min, max) {
  if (Number.isFinite(Number(input))) {
    return clampNumber(input, min, max);
  }
  if (Number.isFinite(Number(fallback))) {
    return clampNumber(fallback, min, max);
  }
  if (Number.isFinite(min)) return min;
  if (Number.isFinite(max)) return max;
  return DEFAULT_VIBE.hue;
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

const TicketService = {
  async findTicketByToken(partyId, token) {
    if (!partyId || !token) return null;
    const { rows } = await pool.query(
      `
        SELECT *
          FROM tt_party_ticket
         WHERE party_id = $1
           AND ticket_token = $2
         LIMIT 1
      `,
      [partyId, token]
    );
    return rows[0] || null;
  },

  async findTicketForMember(partyId, identifiers) {
    if (!partyId) return null;
    const memberId = toNullableNumber(
      identifiers?.memberId ?? identifiers?.member_id
    );
    const handleLower = (identifiers?.handle || '')
      .trim()
      .toLowerCase();
    if (memberId == null && !handleLower) {
      return null;
    }
    const { rows } = await pool.query(
      `
        SELECT *
          FROM tt_party_ticket
         WHERE party_id = $1
           AND status NOT IN ($4, $5)
           AND (
             ($2::bigint IS NOT NULL AND assigned_member_id = $2)
             OR ($3::text IS NOT NULL AND LOWER(assigned_handle) = $3)
           )
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1
      `,
      [
        partyId,
        memberId,
        handleLower || null,
        TICKET_REDEEMED_STATUS,
        TICKET_VOID_STATUS,
      ]
    );
    return rows[0] || null;
  },

  async memberHasRedeemedTicket(partyId, identifiers) {
    if (!partyId) return false;
    const memberId = toNullableNumber(
      identifiers?.memberId ?? identifiers?.member_id
    );
    const handleLower = (identifiers?.handle || '')
      .trim()
      .toLowerCase();
    if (memberId == null && !handleLower) {
      return false;
    }
    const { rows } = await pool.query(
      `
        SELECT ticket_id
          FROM tt_party_ticket
         WHERE party_id = $1
           AND status = $2
           AND (
             ($3::bigint IS NOT NULL AND (assigned_member_id = $3 OR redeemed_by_member_id = $3))
             OR ($4::text  IS NOT NULL AND (LOWER(assigned_handle) = $4 OR LOWER(redeemed_by_handle) = $4))
           )
         LIMIT 1
      `,
      [
        partyId,
        TICKET_REDEEMED_STATUS,
        memberId,
        handleLower || null,
      ]
    );
    return rows.length > 0;
  },

  canUseTicket(party, ticket, identifiers) {
    if (!ticket) {
      return { ok: false, status: 404, error: 'ticket_not_found' };
    }
    const status = String(ticket.status || '').toLowerCase();
    if (status === TICKET_VOID_STATUS) {
      return { ok: false, status: 410, error: 'ticket_void' };
    }
    if (status === TICKET_REDEEMED_STATUS) {
      return { ok: false, status: 409, error: 'ticket_already_redeemed' };
    }

    const memberId = toNullableNumber(
      identifiers?.memberId ?? identifiers?.member_id
    );
    const handleLower = (identifiers?.handle || '')
      .trim()
      .toLowerCase();

    const assignedMemberId = toNullableNumber(ticket.assigned_member_id);
    const assignedHandle = (ticket.assigned_handle || '').trim().toLowerCase();

    if (assignedMemberId != null && memberId != null && assignedMemberId !== memberId) {
      return {
        ok: false,
        status: 403,
        error: 'ticket_assigned_to_other',
      };
    }
    if (assignedHandle && handleLower && assignedHandle !== handleLower) {
      return {
        ok: false,
        status: 403,
        error: 'ticket_assigned_to_other',
      };
    }
    return { ok: true };
  },

  async redeemTicket({
    party,
    ticket,
    ticketToken,
    member,
    membership,
    actorHandle,
    via = 'ticket',
  }) {
    let targetTicket = ticket;
    if (!targetTicket && ticketToken) {
      targetTicket = await TicketService.findTicketByToken(
        party.party_id,
        ticketToken
      );
    }
    if (!targetTicket) {
      throw new PartyCheckinError(404, 'ticket_not_found');
    }

    if (party?.no_reentry && hasMemberDeparted(membership)) {
      throw new PartyCheckinError(403, 'no_reentry');
    }

    const canUse = TicketService.canUseTicket(party, targetTicket, member);
    if (!canUse.ok) {
      throw new PartyCheckinError(canUse.status, canUse.error, canUse.meta);
    }

    const memberId = toNullableNumber(member?.memberId ?? member?.member_id);
    const handleValue = (member?.handle || '').trim() || null;

    const { rows } = await pool.query(
      `
        UPDATE tt_party_ticket
           SET status = $3,
               redeemed_by_member_id = COALESCE($4, redeemed_by_member_id),
               redeemed_by_handle    = COALESCE($5, redeemed_by_handle),
               redeemed_at           = NOW(),
               assigned_member_id    = COALESCE(assigned_member_id, $4),
               assigned_handle       = COALESCE(assigned_handle, $5),
               updated_at            = NOW()
         WHERE ticket_id = $1
           AND party_id = $2
           AND status NOT IN ($6, $7)
         RETURNING *
      `,
      [
        targetTicket.ticket_id,
        party.party_id,
        TICKET_REDEEMED_STATUS,
        memberId,
        handleValue,
        TICKET_REDEEMED_STATUS,
        TICKET_VOID_STATUS,
      ]
    );

    if (!rows.length) {
      throw new PartyCheckinError(409, 'ticket_redemption_conflict');
    }
    return rows[0];
  },
};

function cleanHandleList(invitees = []) {
  const seen = new Set();
  const result = [];
  invitees.forEach((raw) => {
    const rawValue = cleanHandle(raw);
    if (!rawValue) return;
    const cleaned = rawValue.replace(/^@+/, '');
    if (!cleaned) return;
    if (!HANDLE_RE.test(cleaned)) return;
    const normalized = cleaned.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

function serializePartyItem(row) {
  if (!row) return null;
  const qtyNeeded = toNumeric(row.qty_needed);
  const qtyClaimed = toNumeric(row.qty_claimed);
  return {
    party_item_id: row.party_item_id,
    party_id: row.party_id,
    label: row.label,
    details: row.details,
    kind: row.kind,
    qty_needed: qtyNeeded,
    qty_unit: row.qty_unit,
    created_by_member_id: row.created_by_member_id,
    created_at: row.created_at,
    qty_claimed: qtyClaimed ?? 0,
    qty_remaining:
      qtyNeeded != null && qtyClaimed != null
        ? qtyNeeded - qtyClaimed
        : null,
  };
}

function serializePartyItemClaim(row) {
  if (!row) return null;
  return {
    party_item_claim_id: row.party_item_claim_id,
    party_item_id: row.party_item_id,
    member_id: row.member_id,
    qty_promised: toNumeric(row.qty_promised),
    qty_brought: toNumeric(row.qty_brought),
    status: row.status,
    thank_you_note: row.thank_you_note,
    thanked_at: row.thanked_at,
    created_at: row.created_at,
    member_handle: row.member_handle || row.claimer_handle || null,
    member_hue: row.member_hue || null,
  };
}

function serializePartyNote(row) {
  if (!row) return null;
  return {
    party_note_id: row.party_note_id,
    party_id: row.party_id,
    from_member_id: row.from_member_id,
    to_member_id: row.to_member_id,
    related_item_id: row.related_item_id,
    kind: row.kind,
    body: row.body,
    created_at: row.created_at,
    from_handle: row.from_handle || null,
    from_hue: row.from_hue || null,
    to_handle: row.to_handle || null,
    to_hue: row.to_hue || null,
  };
}

async function resolvePartyAccess(partyId, me) {
  if (!partyId) return { ok: false, status: 400, error: 'party_id_required' };
  if (!me?.handle) {
    return { ok: false, status: 403, error: 'handle_required' };
  }

  const party = await fetchPartyById(partyId);
  if (!party) {
    return { ok: false, status: 404, error: 'party_not_found' };
  }

  const isHost = equalsIgnoreCase(party.host_handle, me.handle);

  if (isHost) {
    return { ok: true, party, membership: null, isHost: true };
  }

  const membership = await fetchMembership(partyId, me.handle);
  if (!membership) {
    return { ok: false, status: 403, error: 'not_invited' };
  }

  return { ok: true, party, membership, isHost: false };
}

async function performPartyCheckin({
  party,
  subjectHandle,
  subjectMemberId,
  lat,
  lon,
  via = DEFAULT_CHECKIN_VIA,
  membership,
  ticketVerified = false,
  locationOverride = false,
}) {
  if (!party?.party_id) {
    throw new PartyCheckinError(404, 'party_not_found');
  }
  const handle = cleanHandle(subjectHandle);
  if (!handle) {
    throw new PartyCheckinError(400, 'handle_required');
  }

  const partyId = party.party_id;
  const partyType = normalizePartyType(party);
  const isHostSubject = equalsIgnoreCase(party.host_handle, handle);
  const identifiers = getMemberIdentifiers({
    memberId: subjectMemberId,
    handle,
  });

  const requiresLocation = requiresLocationForParty(party);
  let memberRecord = membership;
  if (!memberRecord) {
    memberRecord = await fetchMembership(partyId, handle);
  }
  const alreadyArrived = Boolean(memberRecord?.arrived_at);

  if (party.no_reentry && hasMemberDeparted(memberRecord) && !alreadyArrived && !isHostSubject) {
    throw new PartyCheckinError(403, 'no_reentry');
  }

  if (party.no_late_entry && !alreadyArrived && !isHostSubject) {
    const cutoffMs = computeLateEntryCutoffMs(party);
    if (cutoffMs && Date.now() > cutoffMs) {
      throw new PartyCheckinError(403, 'late_entry_closed', {
        cutoff_at: new Date(cutoffMs).toISOString(),
      });
    }
  }

  let coords = null;
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    coords = { lat, lon };
  }
  const hasCoords = coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon);
  if (requiresLocation && !locationOverride && !isHostSubject) {
    if (!hasCoords) {
      throw new PartyCheckinError(422, 'location_required');
    }
    if (
      !Number.isFinite(party.center_lat) ||
      !Number.isFinite(party.center_lon) ||
      !Number.isFinite(party.radius_m)
    ) {
      throw new PartyCheckinError(500, 'party_radius_missing');
    }
    const distance = distanceMeters(
      party.center_lat,
      party.center_lon,
      coords.lat,
      coords.lon
    );
    if (distance == null || distance > Number(party.radius_m)) {
      throw new PartyCheckinError(403, 'outside_radius', {
        distance_m: distance,
        radius_m: party.radius_m,
      });
    }
  } else if (
    hasCoords &&
    Number.isFinite(party.center_lat) &&
    Number.isFinite(party.center_lon) &&
    Number.isFinite(party.radius_m)
  ) {
    const distance = distanceMeters(
      party.center_lat,
      party.center_lon,
      coords.lat,
      coords.lon
    );
    if (distance != null && distance > party.radius_m * LOCATION_TOLERANCE_MULTIPLIER) {
      throw new PartyCheckinError(403, 'out_of_range', {
        distance_m: distance,
        radius_m: party.radius_m,
      });
    }
  }

  if (partyType === 'ticket' && !isHostSubject) {
    const hasTicket =
      ticketVerified ||
      (await TicketService.memberHasRedeemedTicket(partyId, identifiers));
    if (!hasTicket) {
      throw new PartyCheckinError(403, 'ticket_required');
    }
  }

  const memberIdValue = toNullableNumber(identifiers.memberId);

  const { rows } = await pool.query(
    `
      INSERT INTO tt_party_member (
        party_id,
        member_id,
        handle,
        invited_by_handle,
        access_level,
        arrived_at,
        last_seen_at
      ) VALUES (
        $1,
        $2,
        $3,
        NULL,
        'live',
        NOW(),
        NOW()
      )
      ON CONFLICT (party_id, handle)
      DO UPDATE SET
        member_id   = COALESCE(tt_party_member.member_id, EXCLUDED.member_id),
        access_level = 'live',
        arrived_at   = COALESCE(tt_party_member.arrived_at, EXCLUDED.arrived_at),
        last_seen_at = EXCLUDED.last_seen_at,
        left_at      = NULL
      RETURNING *,
        (SELECT COALESCE(color_hex, color_hex) FROM ff_quickhitter WHERE handle = $3) AS member_hue
    `,
    [partyId, memberIdValue, handle]
  );

  if (!rows.length) {
    throw new PartyCheckinError(500, 'checkin_failed');
  }

  return serializeMembership(rows[0]);
}

async function fetchClaimsForItemIds(itemIds = []) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(
    `
      SELECT c.*,
             q.handle AS member_handle,
             q.color_hex AS member_hue
        FROM tt_party_item_claim c
        LEFT JOIN ff_quickhitter q
          ON q.member_id = c.member_id
       WHERE c.party_item_id = ANY($1::bigint[])
       ORDER BY c.created_at ASC
    `,
    [itemIds]
  );
  return rows;
}

async function fetchClaimById(claimId) {
  if (!claimId) return null;
  const { rows } = await pool.query(
    `
      SELECT c.*,
             q.handle AS member_handle,
             q.color_hex AS member_hue,
             i.party_id
        FROM tt_party_item_claim c
        JOIN tt_party_item i ON i.party_item_id = c.party_item_id
        LEFT JOIN ff_quickhitter q ON q.member_id = c.member_id
       WHERE c.party_item_claim_id = $1::bigint
       LIMIT 1
    `,
    [claimId]
  );
  return rows[0] || null;
}

async function fetchNoteById(noteId) {
  if (!noteId) return null;
  const { rows } = await pool.query(
    `
      SELECT n.*,
             from_q.handle AS from_handle,
             from_q.color_hex AS from_hue,
             to_q.handle   AS to_handle,
             to_q.color_hex AS to_hue
        FROM tt_party_note n
        LEFT JOIN ff_quickhitter from_q ON from_q.member_id = n.from_member_id
        LEFT JOIN ff_quickhitter to_q   ON to_q.member_id   = n.to_member_id
       WHERE n.party_note_id = $1::bigint
       LIMIT 1
    `,
    [noteId]
  );
  return rows[0] || null;
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
    endsAt,
    partyType,
    noLateEntry,
    noReentry,
    lateEntryGraceMinutes,
  } = req.body || {};

  let normalizedPartyType = String(partyType || '').trim().toLowerCase();
  if (!PARTY_TYPES.has(normalizedPartyType)) {
    normalizedPartyType = 'private';
  }
  const visibilityMode =
    normalizedPartyType === 'public' ? 'public_party' : 'private_party';
  const noLateEntryFlag = Boolean(noLateEntry);
  const noReentryFlag = Boolean(noReentry);
  let graceMinutes = toNullableNumber(lateEntryGraceMinutes);
  if (graceMinutes != null) {
    graceMinutes = clampNumber(graceMinutes, 0, 720);
  }

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
        state,
        party_type,
        no_late_entry,
        no_reentry,
        late_entry_grace_minutes
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
        $10,
        'live',
        $11,
        $12,
        $13,
        $14
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
      endsAt,           // $9
      visibilityMode,   // $10
      normalizedPartyType, // $11
      noLateEntryFlag,  // $12
      noReentryFlag,    // $13
      graceMinutes,     // $14
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

router.get('/:partyId/items', async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId } = req.params;

  try {
    const access = await resolvePartyAccess(partyId, me);
    if (!access.ok) {
      return res.status(access.status).json({ ok: false, error: access.error });
    }

    const { rows } = await pool.query(
      `
        SELECT i.*,
               COALESCE(
                 SUM(c.qty_promised) FILTER (WHERE c.status <> 'cancelled'),
                 0
               ) AS qty_claimed
          FROM tt_party_item i
          LEFT JOIN tt_party_item_claim c
            ON c.party_item_id = i.party_item_id
         WHERE i.party_id = $1
         GROUP BY i.party_item_id
         ORDER BY i.created_at ASC
      `,
      [partyId]
    );

    const itemIds = rows.map((row) => row.party_item_id).filter(Boolean);
    const claimRows = await fetchClaimsForItemIds(itemIds);
    const claimsByItem = new Map();
    claimRows.forEach((row) => {
      if (!claimsByItem.has(row.party_item_id)) {
        claimsByItem.set(row.party_item_id, []);
      }
      claimsByItem.get(row.party_item_id).push(serializePartyItemClaim(row));
    });

    const items = rows.map((row) => {
      const serialized = serializePartyItem(row);
      serialized.claims = claimsByItem.get(row.party_item_id) || [];
      return serialized;
    });

    return res.json({
      ok: true,
      party: serializeParty(access.party),
      items,
    });
  } catch (err) {
    console.error('[party:items:list]', err);
    return res
      .status(500)
      .json({ ok: false, error: 'party_items_fetch_failed' });
  }
});

router.post('/:partyId/items', jsonParser, async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId } = req.params;
  const label = cleanText(req.body?.label, 120);
  const details = cleanText(req.body?.details, 1024) || null;
  const kindRaw = String(req.body?.kind || '').trim().toLowerCase();
  const qtyNeeded = toNullableNumber(
    req.body?.qtyNeeded ?? req.body?.qty_needed ?? null
  );
  const qtyUnit = cleanText(req.body?.qtyUnit ?? req.body?.qty_unit, 64) || null;

  if (!label) {
    return res.status(422).json({ ok: false, error: 'item_label_required' });
  }
  if (qtyNeeded != null && qtyNeeded < 0) {
    return res.status(422).json({ ok: false, error: 'invalid_qty_needed' });
  }

  const kind = ITEM_KINDS.has(kindRaw) ? kindRaw : 'other';
  const createdByMemberId = me.memberId || me.member_id || null;

  try {
    const access = await resolvePartyAccess(partyId, me);
    if (!access.ok) {
      return res.status(access.status).json({ ok: false, error: access.error });
    }
    if (!access.isHost) {
      return res.status(403).json({ ok: false, error: 'not_party_host' });
    }

    const { rows } = await pool.query(
      `
        INSERT INTO tt_party_item (
          party_id,
          label,
          details,
          kind,
          qty_needed,
          qty_unit,
          created_by_member_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *
      `,
      [partyId, label, details, kind, qtyNeeded, qtyUnit, createdByMemberId]
    );

    const item = serializePartyItem({ ...rows[0], qty_claimed: 0 });
    item.claims = [];

    return res.status(201).json({ ok: true, item });
  } catch (err) {
    console.error('[party:items:create]', err);
    return res
      .status(500)
      .json({ ok: false, error: 'party_item_create_failed' });
  }
});

router.post('/:partyId/items/:itemId/claims', jsonParser, async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId, itemId } = req.params;
  const qtyPromised = toNullableNumber(
    req.body?.qtyPromised ?? req.body?.qty_promised ?? 1
  );

  if (!qtyPromised || qtyPromised <= 0) {
    return res.status(422).json({ ok: false, error: 'qty_promised_required' });
  }

  const memberIdValue = me.memberId || me.member_id || me.handle || null;
  if (!memberIdValue) {
    return res.status(403).json({ ok: false, error: 'member_id_required' });
  }

  try {
    const access = await resolvePartyAccess(partyId, me);
    if (!access.ok) {
      return res.status(access.status).json({ ok: false, error: access.error });
    }

    const itemCheck = await pool.query(
      `
        SELECT party_item_id
          FROM tt_party_item
         WHERE party_id = $1
           AND party_item_id = $2::bigint
         LIMIT 1
      `,
      [partyId, itemId]
    );

    if (!itemCheck.rowCount) {
      return res.status(404).json({ ok: false, error: 'party_item_not_found' });
    }

    const { rows } = await pool.query(
      `
        INSERT INTO tt_party_item_claim (
          party_item_id,
          member_id,
          qty_promised,
          status
        ) VALUES ($1::bigint,$2,$3,'promised')
        RETURNING party_item_claim_id
      `,
      [itemId, memberIdValue, qtyPromised]
    );

    const claimRow = await fetchClaimById(rows[0].party_item_claim_id);
    return res
      .status(201)
      .json({ ok: true, claim: serializePartyItemClaim(claimRow) });
  } catch (err) {
    console.error('[party:item_claim:create]', err);
    return res
      .status(500)
      .json({ ok: false, error: 'party_item_claim_failed' });
  }
});

router.patch('/items/claims/:claimId', jsonParser, async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const claimId = String(req.params.claimId || '').trim();
  if (!/^\d+$/.test(claimId)) {
    return res.status(400).json({ ok: false, error: 'invalid_claim_id' });
  }

  const updates = [];
  const values = [];
  let paramIndex = 1;

  const qtyPromised = toNullableNumber(
    req.body?.qtyPromised ?? req.body?.qty_promised
  );
  if (qtyPromised != null) {
    if (qtyPromised <= 0) {
      return res.status(422).json({ ok: false, error: 'invalid_qty_promised' });
    }
    updates.push(`qty_promised = $${paramIndex++}`);
    values.push(qtyPromised);
  }

  const qtyBrought = toNullableNumber(
    req.body?.qtyBrought ?? req.body?.qty_brought
  );
  if (qtyBrought != null) {
    if (qtyBrought < 0) {
      return res.status(422).json({ ok: false, error: 'invalid_qty_brought' });
    }
    updates.push(`qty_brought = $${paramIndex++}`);
    values.push(qtyBrought);
  }

  const statusRaw = String(req.body?.status || '').trim().toLowerCase();
  if (statusRaw) {
    if (!CLAIM_STATUSES.has(statusRaw)) {
      return res.status(422).json({ ok: false, error: 'invalid_claim_status' });
    }
    updates.push(`status = $${paramIndex++}`);
    values.push(statusRaw);
    if (statusRaw === 'brought' && qtyBrought == null) {
      updates.push('qty_brought = COALESCE(qty_brought, qty_promised)');
    }
  }

  const hasThankYou =
    Object.prototype.hasOwnProperty.call(req.body || {}, 'thankYouNote') ||
    Object.prototype.hasOwnProperty.call(req.body || {}, 'thank_you_note');
  let thankYouNote = null;
  if (hasThankYou) {
    thankYouNote = cleanText(
      req.body?.thankYouNote ?? req.body?.thank_you_note,
      1024
    );
  }

  if (hasThankYou) {
    const noteValue = thankYouNote || null;
    updates.push(`thank_you_note = $${paramIndex++}`);
    values.push(noteValue);
    if (noteValue) {
      updates.push('thanked_at = COALESCE(thanked_at, NOW())');
    } else {
      updates.push('thanked_at = NULL');
    }
  }

  if (!updates.length) {
    return res.status(422).json({ ok: false, error: 'no_updates_supplied' });
  }

  try {
    const existing = await fetchClaimById(claimId);
    if (!existing) {
      return res.status(404).json({ ok: false, error: 'claim_not_found' });
    }

    const party = await fetchPartyById(existing.party_id);
    if (!party) {
      return res.status(404).json({ ok: false, error: 'party_not_found' });
    }

    const isHost = equalsIgnoreCase(party.host_handle, me.handle);
    const memberIdValue = me.memberId || me.member_id || me.handle || null;
    const isOwner = memberIdValue
      ? equalsIgnoreCase(memberIdValue, existing.member_id)
      : false;

    if (!isHost && !isOwner) {
      return res.status(403).json({ ok: false, error: 'not_allowed' });
    }
    if (hasThankYou && !isHost) {
      return res.status(403).json({ ok: false, error: 'host_only' });
    }

    values.push(claimId);
    const { rows } = await pool.query(
      `
        UPDATE tt_party_item_claim
           SET ${updates.join(', ')}
         WHERE party_item_claim_id = $${paramIndex}::bigint
         RETURNING party_item_claim_id
      `,
      values
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'claim_not_found' });
    }

    const updated = await fetchClaimById(rows[0].party_item_claim_id);
    return res.json({
      ok: true,
      claim: serializePartyItemClaim(updated),
    });
  } catch (err) {
    console.error('[party:item_claim:update]', err);
    return res
      .status(500)
      .json({ ok: false, error: 'party_item_claim_update_failed' });
  }
});

router.get('/:partyId/notes', async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId } = req.params;

  try {
    const access = await resolvePartyAccess(partyId, me);
    if (!access.ok) {
      return res.status(access.status).json({ ok: false, error: access.error });
    }

    const { rows } = await pool.query(
      `
        SELECT n.*,
               from_q.handle AS from_handle,
               from_q.color_hex AS from_hue,
               to_q.handle   AS to_handle,
               to_q.color_hex AS to_hue
          FROM tt_party_note n
          LEFT JOIN ff_quickhitter from_q ON from_q.member_id = n.from_member_id
          LEFT JOIN ff_quickhitter to_q   ON to_q.member_id   = n.to_member_id
         WHERE n.party_id = $1
         ORDER BY n.created_at ASC
      `,
      [partyId]
    );

    return res.json({
      ok: true,
      notes: rows.map(serializePartyNote),
    });
  } catch (err) {
    console.error('[party:notes:list]', err);
    return res.status(500).json({ ok: false, error: 'party_notes_failed' });
  }
});

router.post('/:partyId/notes', jsonParser, async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId } = req.params;
  const bodyText = cleanText(req.body?.body, 2048);

  if (!bodyText) {
    return res.status(422).json({ ok: false, error: 'note_body_required' });
  }

  const kindRaw = String(req.body?.kind || '').trim().toLowerCase();
  const kind = NOTE_KINDS.has(kindRaw) ? kindRaw : 'note';
  const fromMemberId = me.memberId || me.member_id || me.handle || null;
  if (!fromMemberId) {
    return res.status(403).json({ ok: false, error: 'member_id_required' });
  }

  const toMemberIdRaw =
    req.body?.toMemberId ?? req.body?.to_member_id ?? null;
  const toMemberId = cleanText(toMemberIdRaw, 128) || null;
  const relatedItemRaw =
    req.body?.relatedItemId ?? req.body?.related_item_id ?? null;
  const relatedItemId =
    relatedItemRaw != null && relatedItemRaw !== ''
      ? String(relatedItemRaw).trim()
      : null;
  if (relatedItemId != null && !/^\d+$/.test(relatedItemId)) {
    return res.status(422).json({ ok: false, error: 'invalid_related_item' });
  }

  try {
    const access = await resolvePartyAccess(partyId, me);
    if (!access.ok) {
      return res.status(access.status).json({ ok: false, error: access.error });
    }

    if (relatedItemId != null) {
      const itemCheck = await pool.query(
        `
          SELECT party_item_id
            FROM tt_party_item
           WHERE party_id = $1
             AND party_item_id = $2::bigint
           LIMIT 1
        `,
        [partyId, relatedItemId]
      );
      if (!itemCheck.rowCount) {
        return res
          .status(404)
          .json({ ok: false, error: 'party_item_not_found' });
      }
    }

    const { rows } = await pool.query(
      `
        INSERT INTO tt_party_note (
          party_id,
          from_member_id,
          to_member_id,
          related_item_id,
          kind,
          body
        ) VALUES ($1,$2,$3,$4::bigint,$5,$6)
        RETURNING party_note_id
      `,
      [partyId, fromMemberId, toMemberId, relatedItemId, kind, bodyText]
    );

    const noteRow = await fetchNoteById(rows[0].party_note_id);

    return res.status(201).json({
      ok: true,
      note: serializePartyNote(noteRow),
    });
  } catch (err) {
    console.error('[party:notes:create]', err);
    return res.status(500).json({ ok: false, error: 'party_note_create_failed' });
  }
});

router.patch('/:partyId/vibe', jsonParser, async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId } = req.params;

  try {
    const access = await resolvePartyAccess(partyId, me);
    if (!access.ok) {
      return res.status(access.status).json({ ok: false, error: access.error });
    }
    if (!access.isHost) {
      return res.status(403).json({ ok: false, error: 'not_party_host' });
    }

    const party = access.party || (await fetchPartyById(partyId));
    if (!party) {
      return res.status(404).json({ ok: false, error: 'party_not_found' });
    }

    const hue = normalizeVibeValue(
      req.body?.hue ?? req.body?.vibeHue,
      party.vibe_hue ?? DEFAULT_VIBE.hue,
      0,
      360
    );
    const saturation = normalizeVibeValue(
      req.body?.saturation ?? req.body?.vibeSaturation,
      party.vibe_saturation ?? DEFAULT_VIBE.saturation,
      10,
      100
    );
    const brightness = normalizeVibeValue(
      req.body?.brightness ?? req.body?.vibeBrightness,
      party.vibe_brightness ?? DEFAULT_VIBE.brightness,
      5,
      95
    );

    const { rows } = await pool.query(
      `
        UPDATE tt_party
           SET vibe_hue        = $2,
               vibe_saturation = $3,
               vibe_brightness = $4,
               updated_at      = NOW()
         WHERE party_id = $1
         RETURNING *
      `,
      [partyId, hue, saturation, brightness]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'party_not_found' });
    }

    const updatedParty = serializeParty(rows[0]);
    return res.json({
      ok: true,
      party: updatedParty,
      vibe: {
        hue: updatedParty.vibe_hue,
        saturation: updatedParty.vibe_saturation,
        brightness: updatedParty.vibe_brightness,
      },
    });
  } catch (err) {
    console.error('[party:vibe:update]', err);
    return res.status(500).json({ ok: false, error: 'party_vibe_update_failed' });
  }
});

router.post('/:partyId/checkin', jsonParser, async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId } = req.params;
  const lat = toNullableNumber(req.body?.lat);
  const lon = toNullableNumber(req.body?.lon);
  const via = sanitizeCheckinVia(req.body?.via);
  const ticketToken = cleanTicketToken(
    req.body?.ticketToken ?? req.body?.ticket_token
  );

  try {
    const party = await fetchPartyById(partyId);
    if (!party) return res.status(404).json({ ok: false, error: 'party_not_found' });
    if (party.state === 'cut') return res.status(410).json({ ok: false, error: 'party_cut' });
    const subjectHandle = me.handle;
    const subjectMemberId = me.memberId || me.member_id || null;
    let membership = await fetchMembership(partyId, subjectHandle);
    const isHost = equalsIgnoreCase(party.host_handle, subjectHandle);
    let ticketVerified = false;

    if (normalizePartyType(party) === 'ticket' && ticketToken) {
      await TicketService.redeemTicket({
        party,
        ticketToken,
        member: { memberId: subjectMemberId, handle: subjectHandle },
        membership,
        actorHandle: me.handle,
        via,
      });
      ticketVerified = true;
    }

    const membershipRecord = await performPartyCheckin({
      party,
      subjectHandle,
      subjectMemberId,
      lat,
      lon,
      via,
      membership,
      ticketVerified,
      locationOverride: isHost,
    });

    return res.json({
      ok: true,
      party: serializeParty(party),
      membership: membershipRecord,
    });
  } catch (err) {
    if (err instanceof PartyCheckinError) {
      return res
        .status(err.status || 400)
        .json({ ok: false, error: err.code, ...(err.meta || {}) });
    }
    console.error('[party:checkin]', err);
    return res.status(500).json({ ok: false, error: 'party_checkin_failed' });
  }
});

router.post('/:partyId/tickets/redeem', jsonParser, async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId } = req.params;
  const lat = toNullableNumber(req.body?.lat);
  const lon = toNullableNumber(req.body?.lon);
  const via = sanitizeCheckinVia(req.body?.via || 'ticket');
  const ticketToken = cleanTicketToken(
    req.body?.ticketToken ?? req.body?.ticket_token
  );
  const useAssigned =
    req.body?.useAssigned === true || req.body?.use_assigned === true;

  try {
    const party = await fetchPartyById(partyId);
    if (!party) return res.status(404).json({ ok: false, error: 'party_not_found' });
    if (party.state === 'cut') return res.status(410).json({ ok: false, error: 'party_cut' });
    if (normalizePartyType(party) !== 'ticket') {
      return res.status(400).json({ ok: false, error: 'not_ticket_party' });
    }

    const subjectHandle = me.handle;
    const subjectMemberId = me.memberId || me.member_id || null;
    let membership = await fetchMembership(partyId, subjectHandle);
    const identifiers = {
      memberId: subjectMemberId,
      handle: subjectHandle,
    };

    let ticketRecord = null;
    if (ticketToken) {
      ticketRecord = await TicketService.findTicketByToken(partyId, ticketToken);
    } else if (useAssigned) {
      ticketRecord = await TicketService.findTicketForMember(partyId, identifiers);
    }
    if (!ticketRecord) {
      throw new PartyCheckinError(404, 'ticket_not_found');
    }

    await TicketService.redeemTicket({
      party,
      ticket: ticketRecord,
      member: identifiers,
      membership,
      actorHandle: me.handle,
      via,
    });

    const membershipRecord = await performPartyCheckin({
      party,
      subjectHandle,
      subjectMemberId,
      lat,
      lon,
      via,
      membership,
      ticketVerified: true,
      locationOverride: equalsIgnoreCase(party.host_handle, subjectHandle),
    });

    return res.json({
      ok: true,
      party: serializeParty(party),
      membership: membershipRecord,
    });
  } catch (err) {
    if (err instanceof PartyCheckinError) {
      return res
        .status(err.status || 400)
        .json({ ok: false, error: err.code, ...(err.meta || {}) });
    }
    console.error('[party:tickets:redeem]', err);
    return res.status(500).json({ ok: false, error: 'ticket_redeem_failed' });
  }
});

router.post('/:partyId/tickets/take', jsonParser, async (req, res) => {
  const me = await requireIdentity(req, res);
  if (!me) return;

  const { partyId } = req.params;
  const lat = toNullableNumber(req.body?.lat);
  const lon = toNullableNumber(req.body?.lon);
  const via = sanitizeCheckinVia(req.body?.via || 'ticket_scanned');
  const ticketToken = cleanTicketToken(
    req.body?.ticketToken ?? req.body?.ticket_token
  );
  const targetHandleInput = cleanHandle(
    req.body?.targetHandle ?? req.body?.target_handle
  );
  const targetMemberId = toNullableNumber(
    req.body?.targetMemberId ?? req.body?.target_member_id
  );

  try {
    const access = await resolvePartyAccess(partyId, me);
    if (!access.ok) {
      return res.status(access.status).json({ ok: false, error: access.error });
    }
    if (!access.isHost) {
      return res.status(403).json({ ok: false, error: 'not_party_host' });
    }

    const party = access.party;
    if (party.state === 'cut') return res.status(410).json({ ok: false, error: 'party_cut' });
    if (normalizePartyType(party) !== 'ticket') {
      return res.status(400).json({ ok: false, error: 'not_ticket_party' });
    }
    if (!ticketToken) {
      return res.status(422).json({ ok: false, error: 'ticket_token_required' });
    }

    let ticketRecord = await TicketService.findTicketByToken(partyId, ticketToken);
    if (!ticketRecord) {
      throw new PartyCheckinError(404, 'ticket_not_found');
    }

    const subjectHandle =
      targetHandleInput ||
      cleanHandle(ticketRecord.assigned_handle) ||
      '';
    if (!subjectHandle) {
      return res.status(422).json({ ok: false, error: 'target_handle_required' });
    }

    const subjectMemberId =
      targetMemberId ??
      toNullableNumber(ticketRecord.assigned_member_id) ??
      null;

    const identifiers = {
      memberId: subjectMemberId,
      handle: subjectHandle,
    };

    let membership = await fetchMembership(partyId, subjectHandle);

    await TicketService.redeemTicket({
      party,
      ticket: ticketRecord,
      member: identifiers,
      membership,
      actorHandle: me.handle,
      via,
    });

    const membershipRecord = await performPartyCheckin({
      party,
      subjectHandle,
      subjectMemberId,
      lat,
      lon,
      via,
      membership,
      ticketVerified: true,
      locationOverride: true,
    });

    return res.json({
      ok: true,
      party: serializeParty(party),
      membership: membershipRecord,
    });
  } catch (err) {
    if (err instanceof PartyCheckinError) {
      return res
        .status(err.status || 400)
        .json({ ok: false, error: err.code, ...(err.meta || {}) });
    }
    console.error('[party:tickets:take]', err);
    return res.status(500).json({ ok: false, error: 'ticket_take_failed' });
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

module.exports = router;
