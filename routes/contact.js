const express = require('express');
const pool = require('../src/db/pool');
const Bouncer = require('./Bouncer');

const router = express.Router();
let ffMemberHasHandle = true;
let ffMemberHasDisplayName = true;
const CONTACT_CHANNEL_TYPES = new Set(['phone_call', 'phone_text', 'email']);
const RELATIONSHIP_CHANNEL_TYPE = 'relationship';
const RELATIONSHIP_LABEL_MAX = 80;


function normalizeChannelValue(row, channelType) {
  if (!row || !channelType) return null;

  // Phone (both call + text use the same stored phone number)
  if (channelType === 'phone_call' || channelType === 'phone_text') {
    if (!row.phone) return null;
    return {
      value: row.phone,
      is_verified: row.phone_is_verified === true,
    };
  }

  // Email
  if (channelType === 'email') {
    if (!row.email) return null;
    return {
      value: row.email,
      is_verified: row.email_is_verified === true,
    };
  }

  return null;
}
async function ensureAcceptedRelationshipFromRequest(db, row, messagePayload, viewerId) {
  const memberFrom = row.requester_member_id;  // sender
  const memberTo   = row.target_member_id;     // acceptor

  // Requester side (already baked into the original message)
  const typeFrom =
    typeof messagePayload.relationship_type === 'string'
      ? messagePayload.relationship_type
      : 'relationship';

  const labelFrom =
    typeof messagePayload.relationship_label === 'string'
      ? messagePayload.relationship_label
      : typeFrom;

  // Acceptor side (can be set when accepting)
  const typeTo =
    typeof messagePayload.target_relationship_type === 'string'
      ? messagePayload.target_relationship_type
      : typeFrom; // fallback if not specified

  const labelTo =
    typeof messagePayload.target_relationship_label === 'string'
      ? messagePayload.target_relationship_label
      : typeTo;

  const note =
    typeof messagePayload.note === 'string'
      ? messagePayload.note
      : null;

  await db.none(
    `
      INSERT INTO tt_relationships_accepted (
        member_id_from,
        member_id_to,
        relationship_type_from,
        relationship_type_to,
        relationship_label_from,
        relationship_label_to,
        status,
        is_mutual,
        source_request_id,
        created_by_member_id,
        note
      )
      VALUES ($1,$2,$3,$4,$5,$6,'active',TRUE,$7,$8,$9)
      ON CONFLICT (member_id_from, member_id_to)
      DO UPDATE SET
        relationship_type_from  = EXCLUDED.relationship_type_from,
        relationship_type_to    = EXCLUDED.relationship_type_to,
        relationship_label_from = EXCLUDED.relationship_label_from,
        relationship_label_to   = EXCLUDED.relationship_label_to,
        status                  = 'active',
        is_mutual               = TRUE,
        source_request_id       = EXCLUDED.source_request_id,
        note                    = EXCLUDED.note,
        last_modified_at        = now()
    `,
    [
      memberFrom,
      memberTo,
      typeFrom,
      typeTo,
      labelFrom,
      labelTo,
      row.request_id,
      viewerId,
      note
    ]
  );
}


async function fetchMemberContactValue(memberId, channelType) {
  if (!memberId || !channelType) return null;
  if (!CONTACT_CHANNEL_TYPES.has(channelType)) return null;

  const { rows } = await pool.query(
    `
      SELECT
        phone,
        phone_is_verified,
        email,
        email_is_verified
      FROM ff_quickhitter
      WHERE member_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [memberId]
  );

  const row = rows && rows[0];
  return normalizeChannelValue(row, channelType);
}

function normalizeRelationshipLabel(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, RELATIONSHIP_LABEL_MAX);
}


function buildContactRequestMessage({
  contactValue,
  note,
  isVerified,
  relationshipLabel,
  targetRelationshipLabel,
}) {
  const payload = {};
  if (contactValue) payload.contact_value = contactValue;
  if (typeof isVerified === 'boolean') payload.is_verified = isVerified;
  if (note) payload.note = note;
  if (relationshipLabel) payload.relationship_label = relationshipLabel;
  if (targetRelationshipLabel) payload.target_relationship_label = targetRelationshipLabel;
  if (!Object.keys(payload).length) return '';
  try {
    return JSON.stringify(payload);
  } catch {
    return note || relationshipLabel || '';
  }
}


function parseContactRequestMessage(raw) {
  const empty = {
    note: '',
    contact_value: null,
    is_verified: null,
    relationship_type: null,
    relationship_label: null,
    relationship_note: '',
    target_relationship_label: null,
  };
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    return {
      note: typeof parsed.note === 'string' ? parsed.note : '',
      contact_value:
        typeof parsed.contact_value === 'string' ? parsed.contact_value : null,
      is_verified:
        typeof parsed.is_verified === 'boolean' ? parsed.is_verified : null,
      relationship_type:
        typeof parsed.relationship_type === 'string' ? parsed.relationship_type : null,
      relationship_label:
        typeof parsed.relationship_label === 'string' ? parsed.relationship_label : null,
      relationship_note:
        typeof parsed.relationship_note === 'string' ? parsed.relationship_note : '',
      target_relationship_label:
        typeof parsed.target_relationship_label === 'string'
          ? parsed.target_relationship_label
          : null,
    };
  } catch {
    return { ...empty, note: raw };
  }
}


function normalizeChannelRow(row) {
  if (!row) return null;
  const value =
    row.value ??
    row.channel_value ??
    row.channelValue ??
    row.contact_value ??
    null;

  if (!value) return null;

  return {
    channel_id: row.channel_id || row.id || null,
    channel_type: row.channel_type,
    value,
    display_label: row.display_label || row.label || row.channel_type,
    is_primary: row.is_primary === true,
    verified_at: row.verified_at || null,
  };
}

function isGuardianReason(reason) {
  return reason === 'guardian_block_adult_male' || reason === 'guardian_blocks_strangers';
}

function normalizeViewedFilter(raw) {
  if (typeof raw !== 'string') return 'unviewed';
  const value = raw.trim().toLowerCase();
  if (!value) return 'unviewed';
  if (['true', '1', 'yes', 'viewed', 'revealed', 'archive'].includes(value)) {
    return 'viewed';
  }
  if (['all', 'any', '*'].includes(value)) {
    return 'all';
  }
  return 'unviewed';
}

function normalizeStatusFilter(raw) {
  if (typeof raw !== 'string') return 'pending';
  const value = raw.trim().toLowerCase();
  if (!value) return 'pending';
  if (['all', '*', 'any'].includes(value)) return 'all';
  if (['pending', 'accepted', 'ignored', 'blocked'].includes(value)) return value;
  return 'pending';
}

router.post('/request', Bouncer.guardContactRequest, async (req, res) => {
  const guard = req.contactGuard;
  if (!guard) {
    return res.status(400).json({ error: 'invalid_contact_request' });
  }

  const channelType = guard.requestedChannelType;

  try {
    if (channelType === RELATIONSHIP_CHANNEL_TYPE) {
      const relationshipLabel = normalizeRelationshipLabel(req.body?.relationship_label);
      if (!relationshipLabel) {
        return res.status(400).json({ error: 'relationship_detail_required' });
      }

      const messagePayload = buildContactRequestMessage({
        relationshipLabel,
      });

      const { rows } = await pool.query(
        `
          INSERT INTO tt_contact_request (
            requester_member_id,
            target_member_id,
            channel_type,
            status,
            message,
            channel_value
          )
          VALUES ($1, $2, $3, 'pending', $4, NULL)
          RETURNING request_id, status, created_at
        `,
        [
          guard.requesterId,
          guard.targetId,
          channelType,
          messagePayload || relationshipLabel,
        ]
      );

      const payload = rows && rows[0]
        ? {
            request_id: rows[0].request_id || null,
            status: rows[0].status || 'pending',
            created_at: rows[0].created_at || null,
          }
        : { request_id: null, status: 'pending' };

      return res.json({ ok: true, ...payload });
    }

    if (!CONTACT_CHANNEL_TYPES.has(channelType)) {
      return res.status(400).json({ error: 'invalid_channel_type' });
    }

    const contactInfo = await fetchMemberContactValue(guard.requesterId, channelType);
    if (!contactInfo || !contactInfo.value) {
      return res.status(400).json({ error: 'contact_value_missing' });
    }

    const note =
      typeof req.body?.note === 'string'
        ? req.body.note.trim().slice(0, 280)
        : '';

    const messagePayload = buildContactRequestMessage({
      contactValue: contactInfo.value,
      note,
      isVerified: contactInfo.is_verified,
    });

    const { rows } = await pool.query(
      `
        INSERT INTO tt_contact_request (
          requester_member_id,
          target_member_id,
          channel_type,
          status,
          message,
          channel_value
        )
        VALUES ($1, $2, $3, 'pending', $4, $5)
        RETURNING request_id, status, created_at
      `,
      [
        guard.requesterId,
        guard.targetId,
        channelType,
        messagePayload || null,
        contactInfo.value,
      ]
    );

    const payload = rows && rows[0]
      ? {
          request_id: rows[0].request_id || null,
          status: rows[0].status || 'pending',
          created_at: rows[0].created_at || null,
        }
      : { request_id: null, status: 'pending' };

    return res.json({ ok: true, ...payload });
  } catch (err) {
    console.error('contact.request insert failed', err);
    return res.status(500).json({ error: 'contact_request_failed' });
  }
});
async function ensureMemberRelationshipFromRequest(row, messagePayload) {
  const memberFrom = row.requester_member_id;
  const memberTo = row.target_member_id;

  // Pull any type / labels we captured in the message
  const relationshipType =
    typeof messagePayload.relationship_type === 'string'
      ? messagePayload.relationship_type
      : 'relationship';

  const roleFrom =
    typeof messagePayload.relationship_label === 'string'
      ? messagePayload.relationship_label
      : relationshipType;

  const roleTo =
    typeof messagePayload.target_relationship_label === 'string'
      ? messagePayload.target_relationship_label
      : roleFrom;

  // Create / reactivate the relationship
  await pool.query(
    `
      INSERT INTO tt_member_relationship (
        member_id_from,
        member_id_to,
        relationship_type,
        role_from,
        role_to,
        status,
        is_mutual
      )
      VALUES ($1, $2, $3, $4, $5, 'active', TRUE)
      ON CONFLICT (member_id_from, member_id_to)
      DO UPDATE SET
        relationship_type = EXCLUDED.relationship_type,
        role_from        = EXCLUDED.role_from,
        role_to          = EXCLUDED.role_to,
        status           = 'active',
        is_mutual        = TRUE
    `,
    [memberFrom, memberTo, relationshipType, roleFrom, roleTo]
  );
}

router.post('/request/:requestId/relationship', async (req, res) => {
  const viewerId = Bouncer.getViewerId(req);
  // ... load row, check permissions, etc.

  const decision = req.body?.decision;

  if (decision === 'accept') {
    let messagePayload = {};
    if (row.message) {
      try {
        const parsed = JSON.parse(row.message);
        if (parsed && typeof parsed === 'object') {
          messagePayload = parsed;
        }
      } catch {
        messagePayload = {};
      }
    }

    // Requester side (already set when they sent the request)
    // messagePayload.relationship_type        (from)
    // messagePayload.relationship_label       (from)
    // messagePayload.target_relationship_label (maybe)

    // Acceptor POV coming from the body:
    const rawAcceptorType  = req.body?.relationship_type || req.body?.target_relationship_type;
    const rawAcceptorLabel = req.body?.relationship_label || req.body?.target_relationship_label;

    // Require at least *something* from the acceptor side or previously stored target label/type
    if (
      !rawAcceptorType &&
      !rawAcceptorLabel &&
      !messagePayload.target_relationship_type &&
      !messagePayload.target_relationship_label
    ) {
      return res.status(400).json({ error: 'relationship_detail_required' });
    }

    if (rawAcceptorType) {
      messagePayload.target_relationship_type = rawAcceptorType;
    }

    if (rawAcceptorLabel) {
      messagePayload.target_relationship_label = normalizeRelationshipLabel(rawAcceptorLabel);
    }

    // Auto-promote into tt_relationships_accepted with asymmetry preserved
    await ensureAcceptedRelationshipFromRequest(req.db, row, messagePayload, viewerId);

    const nextMessage = JSON.stringify(messagePayload);
    const nextStatus  = 'accepted';

    await req.db.none(
      `
        UPDATE tt_contact_request
        SET status = $2,
            message = $3,
            updated_at = now()
        WHERE request_id = $1
      `,
      [row.request_id, nextStatus, nextMessage]
    );

    return res.json({
      ok: true,
      status: nextStatus,
      message: messagePayload
    });
  }

  // ... handle other decisions (reject, block, etc.)
});


router.post('/me', async (req, res) => {
  const viewerId = Bouncer.getViewerId(req);
  if (!viewerId) {
    return res.status(401).json({ error: 'not_authenticated' });
  }

  const targetId =
    req.body?.target_member_id ||
    req.body?.targetMemberId ||
    req.body?.member_id ||
    req.body?.memberId ||
    null;

  if (!targetId) {
    return res.status(400).json({ error: 'missing_target_member_id' });
  }

  const client = await pool.connect();
  try {
    const access = await Bouncer.evaluateMemberPageAccess({
      client,
      viewerId,
      targetId,
    });

    if (!access.allowed || access.accessLevel === 'none') {
      return res.status(access.httpStatus || 403).json({
        error: 'contact_not_allowed',
        reason: access.reason || 'access_denied',
        guardianBlocked: isGuardianReason(access.reason),
      });
    }

    if (access.isStranger) {
      return res.status(403).json({
        error: 'contact_not_allowed',
        reason: 'relationship_required',
        guardianBlocked: false,
      });
    }

    if (access.isOwner) {
      return res.status(400).json({
        error: 'contact_not_allowed',
        reason: 'self_contact_not_supported',
        guardianBlocked: false,
      });
    }

    if (isGuardianReason(access.guardianBlockReason)) {
      return res.status(403).json({
        error: 'contact_not_allowed',
        reason: access.guardianBlockReason,
        guardianBlocked: true,
      });
    }

const { rows } = await client.query(
  `
    SELECT
      phone,
      phone_is_verified,
      email,
      email_is_verified
    FROM ff_quickhitter
    WHERE member_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `,
  [targetId]
);

const row = rows && rows[0];

const channels = [];

if (row && row.phone) {
  channels.push({
    channel_id: null, // no per-channel row in ff_quickhitter
    channel_type: 'phone_text',
    value: row.phone,
    display_label: 'Text',
    is_primary: true,
    verified_at: null,
    is_verified: row.phone_is_verified === true,
  });

  channels.push({
    channel_id: null,
    channel_type: 'phone_call',
    value: row.phone,
    display_label: 'Call',
    is_primary: false,
    verified_at: null,
    is_verified: row.phone_is_verified === true,
  });
}

if (row && row.email) {
  channels.push({
    channel_id: null,
    channel_type: 'email',
    value: row.email,
    display_label: 'Email',
    is_primary: !row.phone, // primary if no phone
    verified_at: null,
    is_verified: row.email_is_verified === true,
  });
}

if (!channels.length) {
  return res.status(404).json({ error: 'no_contact_channels' });
}


    await Promise.all(
      channels
        .filter((channel) => channel.channel_id)
        .map((channel) =>
          client
            .query(
              `
                INSERT INTO tt_contact_exposure (
                  viewer_member_id,
                  target_member_id,
                  channel_id,
                  channel_type
                )
                VALUES ($1, $2, $3, $4)
              `,
              [viewerId, targetId, channel.channel_id, channel.channel_type]
            )
            .catch((err) => {
              console.warn('contact exposure insert failed', err);
              return null;
            })
        )
    );

    return res.json({ ok: true, channels });
  } catch (err) {
    console.error('contact.me error', err);
    return res.status(500).json({ error: 'contact_me_failed' });
  } finally {
    client.release();
  }
});

router.get('/requests', async (req, res) => {
  const viewerId = Bouncer.getViewerId(req);
  if (!viewerId) {
    return res.status(401).json({ error: 'not_authenticated' });
  }

  const targetId =
    req.query?.target_member_id ||
    req.query?.targetMemberId ||
    req.query?.member_id ||
    req.query?.memberId ||
    viewerId;

  if (targetId !== viewerId) {
    return res.status(403).json({ error: 'forbidden' });
  }

  try {
    const viewFilter = normalizeViewedFilter(req.query?.viewed);
    const statusFilter = normalizeStatusFilter(req.query?.status);
    const rows = await fetchContactRequests(targetId, { viewFilter, statusFilter });

return res.json({
  ok: true,
  requests: rows.map((row) => ({
    request_id: row.request_id,
    requester_member_id: row.requester_member_id,
    requester_handle: row.requester_handle || row.requester_member_id,
    requester_name:
      row.requester_name || row.requester_handle || row.requester_member_id,
    channel_type: row.channel_type,
    message: row.message || '',
    status: row.status,
    guardian_reason: row.guardian_reason || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    viewed_at: row.viewed_at,
    channel_value: row.channel_value || null,
    requester_color_hex: row.requester_color_hex || null,
    ...parseContactRequestMessage(row.message),
  })),
    });
  } catch (err) {
    console.error('contact.requests error', err);
    return res.status(500).json({ error: 'contact_requests_failed' });
  }
});

async function fetchContactRequests(targetId, { viewFilter = 'unviewed', statusFilter = 'pending' } = {}) {
  const selectHandle = ffMemberHasHandle ? 'fm.handle AS requester_handle' : 'NULL::text AS requester_handle';
  const selectName = ffMemberHasDisplayName ? 'fm.display_name AS requester_name' : 'NULL::text AS requester_name';
  const joinClause = ffMemberHasHandle || ffMemberHasDisplayName
    ? 'LEFT JOIN ff_member fm ON fm.member_id = r.requester_member_id'
    : '';
  const whereClauses = ['r.target_member_id = $1'];
  const params = [targetId];
  if (statusFilter === 'pending') {
    whereClauses.push("r.status = 'pending'");
  } else if (statusFilter !== 'all') {
    params.push(statusFilter);
    whereClauses.push(`r.status = $${params.length}`);
  }
  if (viewFilter === 'viewed') {
    whereClauses.push('r.viewed_at IS NOT NULL');
  } else if (viewFilter !== 'all') {
    whereClauses.push('r.viewed_at IS NULL');
  }
  const orderBy =
    viewFilter === 'viewed'
      ? 'ORDER BY r.viewed_at DESC NULLS LAST'
      : 'ORDER BY r.created_at DESC';

const sql = `
  SELECT
    r.request_id,
    r.requester_member_id,
    r.target_member_id,
    r.channel_type,
    r.message,
    r.status,
    r.guardian_reason,
    r.created_at,
    r.updated_at,
    r.viewed_at,
    r.channel_value,
    ${selectHandle},
    ${selectName},
    qh.color_hex AS requester_color_hex
  FROM tt_contact_request r
  ${joinClause}
  LEFT JOIN LATERAL (
    SELECT color_hex
    FROM ff_quickhitter
    WHERE member_id = r.requester_member_id
    ORDER BY created_at DESC
    LIMIT 1
  ) qh ON TRUE
  WHERE ${whereClauses.join('\n    AND ')}
  ${orderBy}
  LIMIT 100
`;


  try {
  const { rows } = await pool.query(sql, params);
    return rows;
  } catch (err) {
    const msg = (err?.message || '').toLowerCase();
    let retry = false;
    if (ffMemberHasHandle && msg.includes('handle')) {
      ffMemberHasHandle = false;
      retry = true;
    }
    if (ffMemberHasDisplayName && msg.includes('display_name')) {
      ffMemberHasDisplayName = false;
      retry = true;
    }
    if (retry) {
      return fetchContactRequests(targetId, { viewFilter });
    }
    throw err;
  }
}
router.post('/request/:requestId/viewed', async (req, res) => {
  const viewerId = Bouncer.getViewerId(req);
  if (!viewerId) {
    return res.status(401).json({ error: 'not_authenticated' });
  }

  const requestId = req.params.requestId;
  if (!requestId) {
    return res.status(400).json({ error: 'missing_request_id' });
  }

  try {
    const { rows } = await pool.query(
      `
        UPDATE tt_contact_request
        SET viewed_at = COALESCE(viewed_at, NOW()),
            updated_at = NOW()
        WHERE request_id = $1
          AND target_member_id = $2
        RETURNING request_id, viewed_at
      `,
      [requestId, viewerId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'request_not_found' });
    }

    return res.json({
      ok: true,
      request_id: rows[0].request_id,
      viewed_at: rows[0].viewed_at,
    });
  } catch (err) {
    console.error('contact.request_viewed error', err);
    return res.status(500).json({ error: 'mark_viewed_failed' });
  }
});

module.exports = router;
