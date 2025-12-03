const express = require('express');
const pool = require('../src/db/pool');
const Bouncer = require('./Bouncer');

const router = express.Router();

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
    const { rows } = await pool.query(
      `
        INSERT INTO tt_contact_request (
          requester_member_id,
          target_member_id,
          channel_type,
          status
        )
        VALUES ($1, $2, $3, 'pending')
        RETURNING request_id, status, created_at
      `,
      [guard.requesterId, guard.targetId, guard.requestedChannelType]
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
      channels.map((channel) =>
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

module.exports = router;
