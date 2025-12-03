const express = require('express');
const pool = require('../src/db/pool');
const Bouncer = require('./Bouncer');

const router = express.Router();
let ffMemberHasHandle = true;
let ffMemberHasDisplayName = true;
const CONTACT_CHANNEL_TYPES = new Set(['phone_call', 'phone_text', 'email']);

function normalizeChannelValue(row) {
  if (!row) return null;
  return row.value || row.channel_value || row.channelValue || null;
}

async function fetchMemberContactValue(memberId, channelType) {
  if (!memberId || !channelType) return null;
  if (!CONTACT_CHANNEL_TYPES.has(channelType)) return null;

  const { rows } = await pool.query(
    `
      SELECT value, channel_value
      FROM tt_member_contact_channel
      WHERE member_id = $1
        AND channel_type = $2
        AND (is_active IS NULL OR is_active = TRUE)
      ORDER BY
        is_primary DESC NULLS LAST,
        created_at DESC NULLS LAST
      LIMIT 1
    `,
    [memberId, channelType]
  );

  return normalizeChannelValue(rows[0]);
}

function buildContactRequestMessage({ contactValue, note }) {
  const payload = {};
  if (contactValue) payload.contact_value = contactValue;
  if (note) payload.note = note;
  if (!Object.keys(payload).length) return '';
  try {
    return JSON.stringify(payload);
  } catch {
    return note || '';
  }
}

function parseContactRequestMessage(raw) {
  if (!raw) return { note: '', contact_value: null };
  try {
    const parsed = JSON.parse(raw);
    return {
      note: typeof parsed.note === 'string' ? parsed.note : '',
      contact_value:
        typeof parsed.contact_value === 'string' ? parsed.contact_value : null,
    };
  } catch {
    return { note: raw, contact_value: null };
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

router.post('/request', Bouncer.guardContactRequest, async (req, res) => {
  const guard = req.contactGuard;
  if (!guard) {
    return res.status(400).json({ error: 'invalid_contact_request' });
  }

  try {
    const contactValue = await fetchMemberContactValue(
      guard.requesterId,
      guard.requestedChannelType
    );
    if (!contactValue) {
      return res.status(400).json({ error: 'contact_value_missing' });
    }

    const note =
      typeof req.body?.message === 'string'
        ? req.body.message.trim().slice(0, 280)
        : '';
    const messagePayload = buildContactRequestMessage({ contactValue, note });

    const { rows } = await pool.query(
      `
        INSERT INTO tt_contact_request (
          requester_member_id,
          target_member_id,
          channel_type,
          status,
          message
        )
        VALUES ($1, $2, $3, 'pending', $4)
        RETURNING request_id, status, created_at
      `,
      [
        guard.requesterId,
        guard.targetId,
        guard.requestedChannelType,
        messagePayload || null,
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
        SELECT *
        FROM tt_member_contact_channel
        WHERE member_id = $1
          AND (is_active IS NULL OR is_active = TRUE)
        ORDER BY
          is_primary DESC NULLS LAST,
          channel_type ASC
      `,
      [targetId]
    );

    const channels = (rows || [])
      .map(normalizeChannelRow)
      .filter(Boolean);

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
    const rows = await fetchPendingContactRequests(targetId);

    return res.json({
      ok: true,
      requests: rows.map((row) => ({
        request_id: row.request_id,
        requester_member_id: row.requester_member_id,
        requester_handle: row.requester_handle || row.requester_member_id,
        requester_name: row.requester_name || row.requester_handle || row.requester_member_id,
        channel_type: row.channel_type,
        message: row.message || '',
        status: row.status,
        guardian_reason: row.guardian_reason || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        ...parseContactRequestMessage(row.message),
      })),
    });
  } catch (err) {
    console.error('contact.requests error', err);
    return res.status(500).json({ error: 'contact_requests_failed' });
  }
});

async function fetchPendingContactRequests(targetId) {
  const selectHandle = ffMemberHasHandle ? 'fm.handle AS requester_handle' : 'NULL::text AS requester_handle';
  const selectName = ffMemberHasDisplayName ? 'fm.display_name AS requester_name' : 'NULL::text AS requester_name';
  const joinClause = ffMemberHasHandle || ffMemberHasDisplayName
    ? 'LEFT JOIN ff_member fm ON fm.member_id = r.requester_member_id'
    : '';

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
      r.message,
      ${selectHandle},
      ${selectName}
    FROM tt_contact_request r
    ${joinClause}
    WHERE r.target_member_id = $1
      AND r.status = 'pending'
    ORDER BY r.created_at DESC
    LIMIT 100
  `;

  try {
    const { rows } = await pool.query(sql, [targetId]);
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
      return fetchPendingContactRequests(targetId);
    }
    throw err;
  }
}

module.exports = router;
