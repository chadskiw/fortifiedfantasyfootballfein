// routes/Bouncer.js
//
// Central access-control logic for s1c / TrashTalk.
// Controls who can see whose page and who can send contact requests.

const rawDb = require('../src/db');
const pool = rawDb.pool || rawDb;
const ALLOWED_REQUEST_CHANNELS = new Set(['phone_call', 'phone_text', 'email', 'relationship']);

// -----------------------------
// Basic helpers
// -----------------------------

function getViewerId(req) {
  if (req.member && req.member.member_id) return req.member.member_id;
  if (req.ff_member_id) return req.ff_member_id;
  if (req.user && req.user.member_id) return req.user.member_id;
  if (req.cookies && req.cookies.ff_member_id) return req.cookies.ff_member_id;
  if (req.cookies && req.cookies.ff_member) return req.cookies.ff_member;
  if (req.headers['x-member-id']) return String(req.headers['x-member-id']);
  if (req.headers['x-ff-member']) return String(req.headers['x-ff-member']);
  return null;
}

function calculateAge(dob) {
  if (!dob) return null;
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) {
    age -= 1;
  }
  return age;
}

async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

// -----------------------------
// DB fetch helpers
// -----------------------------

async function fetchMemberContext(client, memberId) {
  const { rows } = await client.query(
    `
    SELECT
      m.member_id,
      d.date_of_birth,
      d.gender,
      d.is_minor,
      d.age_source,
      ts.trust_level,
      ts.risk_score
    FROM ff_member AS m
    LEFT JOIN tt_member_demographic AS d
      ON d.member_id = m.member_id
    LEFT JOIN tt_member_trust_state AS ts
      ON ts.member_id = m.member_id
    WHERE m.member_id = $1
    `,
    [memberId]
  );

  if (!rows.length) return null;

  const row = rows[0];
  const age = row.date_of_birth ? calculateAge(row.date_of_birth) : null;
  return {
    memberId: row.member_id,
    dob: row.date_of_birth,
    gender: row.gender,
    isMinor: row.is_minor === true,
    ageSource: row.age_source,
    age,
    trustLevel: row.trust_level || 'normal',
    riskScore: row.risk_score || 0
  };
}

async function fetchGuardianControl(client, childMemberId) {
  const { rows } = await client.query(
    `
    SELECT
      child_member_id,
      guardian_member_id,
      block_adult_men_over_age,
      adult_age_cutoff,
      block_male_gender,
      allow_requests_from_strangers
    FROM tt_guardian_control
    WHERE child_member_id = $1
    `,
    [childMemberId]
  );
  return rows[0] || null;
}

async function fetchRelationship(client, memberA, memberB) {
  // No IDs, no relationship
  if (!memberA || !memberB) return null;

  // Self-relationship: don't hit the DB, just return a synthetic object
  if (memberA === memberB) {
    return {
      relationship_id: null,           // no DB row
      member_id_from: memberA,
      member_id_to: memberB,
      relationship_type: 'self',
      role_from: 'Self',
      role_to: 'Self',
      status: 'active',
      is_mutual: true,
      created_at: new Date().toISOString(), // or null if you prefer
    };
  }

  // Normal relationship lookup between two distinct members
  const { rows } = await client.query(
    `
    SELECT
      relationship_id,
      member_id_from,
      member_id_to,
      relationship_type_from AS relationship_type,
      relationship_label_from AS role_from,
      relationship_label_to   AS role_to,
      status,
      is_mutual,
      established_at          AS created_at
    FROM tt_relationships_accepted
    WHERE
      status = 'active'
      AND (
        (member_id_from = $1 AND member_id_to = $2)
        OR
        (member_id_from = $2 AND member_id_to = $1)
      )
    ORDER BY established_at DESC
    LIMIT 1
    `,
    [memberA, memberB]
  );

  if (rows[0]) {
    return rows[0];
  }

  // Fallback: accepted-but-not-promoted contact request (optional)
  return fetchAcceptedRelationshipRequest(client, memberA, memberB);
}


async function fetchAcceptedRelationshipRequest(client, memberA, memberB) {
  const { rows } = await client.query(
    `
    SELECT request_id
    FROM tt_contact_request
    WHERE
      channel_type = 'relationship'
      AND status = 'accepted'
      AND (
        (requester_member_id = $1 AND target_member_id = $2)
        OR
        (requester_member_id = $2 AND target_member_id = $1)
      )
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    [memberA, memberB]
  );
  if (!rows.length) return null;
  return {
    relationship_id: rows[0].request_id,
    member_id_from: memberA,
    member_id_to: memberB,
    relationship_type: 'relationship_request',
    status: 'active',
    is_mutual: true,
  };
}

async function fetchBlock(client, memberA, memberB) {
  if (!memberA || !memberB) return null;
  const { rows } = await client.query(
    `
    SELECT blocker_member_id, blocked_member_id, block_type
    FROM tt_member_block
    WHERE
      (blocker_member_id = $1 AND blocked_member_id = $2)
      OR
      (blocker_member_id = $2 AND blocked_member_id = $1)
    LIMIT 1
    `,
    [memberA, memberB]
  );
  return rows[0] || null;
}

// -----------------------------
// Core decision logic
// -----------------------------

function classifyGuardianAdultMale(viewerCtx, guardianControl) {
  if (!guardianControl) {
    return { isAdultMaleBlocked: false, reason: null };
  }

  const cutoff = guardianControl.adult_age_cutoff || 22;

  let age = viewerCtx ? viewerCtx.age : null;
  if (age == null && viewerCtx && viewerCtx.isMinor === false) {
    // No DOB but explicitly not minor; treat as adult for safety
    age = cutoff;
  }

  const isAdultByCutoff = age != null ? age >= cutoff : true;

  const gender = (viewerCtx && viewerCtx.gender ? viewerCtx.gender : '').toLowerCase();
  const isMale =
    guardianControl.block_male_gender &&
    (gender === 'male' || gender === 'm' || gender === 'man');

  const isAdultMaleBlocked = isAdultByCutoff && isMale && guardianControl.block_adult_men_over_age;
  return {
    isAdultMaleBlocked,
    reason: isAdultMaleBlocked ? 'guardian_block_adult_male' : null
  };
}

/**
 * Evaluate whether viewer can see target's page and at what level.
 *
 * Returns:
 * {
 *   allowed: boolean,
 *   httpStatus: number,
 *   accessLevel: 'none'|'limited'|'full',
 *   reason: string|null,
 *   isOwner: boolean,
 *   isStranger: boolean,
 *   canRequestContact: boolean,
 *   viewer: {...} | null,
 *   target: {...} | null,
 *   guardianBlockReason: string | null
 * }
 */
async function evaluateMemberPageAccess({ client, viewerId, targetId }) {
  if (!targetId) {
    return {
      allowed: false,
      httpStatus: 404,
      accessLevel: 'none',
      reason: 'no_target',
      isOwner: false,
      isStranger: true,
      canRequestContact: false,
      viewer: null,
      target: null,
      guardianBlockReason: null
    };
  }

  const targetCtx = await fetchMemberContext(client, targetId);
  if (!targetCtx) {
    return {
      allowed: false,
      httpStatus: 404,
      accessLevel: 'none',
      reason: 'target_not_found',
      isOwner: false,
      isStranger: true,
      canRequestContact: false,
      viewer: null,
      target: null,
      guardianBlockReason: null
    };
  }

  let viewerCtx = null;
  if (viewerId) {
    viewerCtx = await fetchMemberContext(client, viewerId);
    if (!viewerCtx) {
      // Viewer ID is bogus; treat as anonymous
      viewerCtx = null;
      viewerId = null;
    }
  }

  const isOwner = !!viewerId && viewerId === targetId;

  // Banned target: treat as not-found
  if (targetCtx.trustLevel === 'banned') {
    return {
      allowed: false,
      httpStatus: 404,
      accessLevel: 'none',
      reason: 'target_banned',
      isOwner,
      isStranger: !viewerId || viewerId !== targetId,
      canRequestContact: false,
      viewer: viewerCtx,
      target: targetCtx,
      guardianBlockReason: null
    };
  }

  // Banned viewer: no access
  if (viewerCtx && viewerCtx.trustLevel === 'banned') {
    return {
      allowed: false,
      httpStatus: 403,
      accessLevel: 'none',
      reason: 'viewer_banned',
      isOwner: false,
      isStranger: true,
      canRequestContact: false,
      viewer: viewerCtx,
      target: targetCtx,
      guardianBlockReason: null
    };
  }

  // Blocks in either direction
  const blockRow = viewerId ? await fetchBlock(client, viewerId, targetId) : null;
  if (blockRow) {
    return {
      allowed: false,
      httpStatus: 404,
      accessLevel: 'none',
      reason: 'blocked',
      isOwner,
      isStranger: true,
      canRequestContact: false,
      viewer: viewerCtx,
      target: targetCtx,
      guardianBlockReason: null
    };
  }

  // Relationship / stranger classification
  const rel = viewerId ? await fetchRelationship(client, viewerId, targetId) : null;
  const hasRelationship = !!rel;
  const isStranger = !viewerId || !hasRelationship;

  // Guardian logic (for minors)
  let guardian = null;
  let guardianBlock = null;
  if (targetCtx.isMinor) {
    guardian = await fetchGuardianControl(client, targetId);
    if (viewerCtx && guardian) {
      guardianBlock = classifyGuardianAdultMale(viewerCtx, guardian);
    }
  }

  const guardianBlocksAdultMale =
    !!guardian &&
    guardianBlock &&
    guardianBlock.isAdultMaleBlocked &&
    isStranger;

  // Decide access level
  let accessLevel = 'full';
  let reason = null;
  let canRequestContact = !!viewerId;

  if (!viewerId) {
    accessLevel = 'limited';
    canRequestContact = false;
    reason = 'anonymous_viewer';
  }

  if (guardian && targetCtx.isMinor) {
    if (guardianBlocksAdultMale) {
      // Adult male stranger: allow only very limited view, no contact
      accessLevel = 'limited';
      canRequestContact = false;
      reason = guardianBlock.reason;
    } else if (isStranger && guardian.allow_requests_from_strangers === false) {
      // Guardian does not allow strangers at all: limited view, no contact
      accessLevel = 'limited';
      canRequestContact = false;
      reason = 'guardian_blocks_strangers';
    }
  }

  if (isOwner) {
    accessLevel = 'full';
    canRequestContact = false;
    reason = null;
  }

  return {
    allowed: accessLevel !== 'none',
    httpStatus: 200,
    accessLevel,
    reason,
    isOwner,
    isStranger,
    canRequestContact,
    viewer: viewerCtx,
    target: targetCtx,
    guardianBlockReason: guardianBlock ? guardianBlock.reason : null
  };
}

/**
 * Evaluate whether a contact request is allowed given requester + target + guardian rules.
 *
 * Returns:
 * {
 *   allowed: boolean,
 *   httpStatus: number,
 *   reason: string|null,
 *   guardianBlocked: boolean
 * }
 */
async function evaluateContactRequest({ client, requesterId, targetId, requestedChannelType }) {
  if (!requesterId) {
    return {
      allowed: false,
      httpStatus: 401,
      reason: 'not_authenticated',
      guardianBlocked: false
    };
  }

  const access = await evaluateMemberPageAccess({ client, viewerId: requesterId, targetId });
  if (!access.allowed) {
    return {
      allowed: false,
      httpStatus: access.httpStatus || 403,
      reason: access.reason || 'access_denied',
      guardianBlocked: access.reason && access.reason.startsWith('guardian_')
    };
  }

  if (!access.canRequestContact) {
    const guardianBlocked =
      access.reason === 'guardian_block_adult_male' ||
      access.reason === 'guardian_blocks_strangers';

    return {
      allowed: false,
      httpStatus: 403,
      reason: access.reason || 'contact_not_allowed',
      guardianBlocked
    };
  }

  if (!ALLOWED_REQUEST_CHANNELS.has(requestedChannelType)) {
    return {
      allowed: false,
      httpStatus: 400,
      reason: 'invalid_channel_type',
      guardianBlocked: false
    };
  }

  return {
    allowed: true,
    httpStatus: 200,
    reason: null,
    guardianBlocked: false
  };
}

// -----------------------------
// Express middlewares
// -----------------------------

// Guard viewing a member page.
// Usage example in a route file:
// router.get('/u/:memberId', Bouncer.guardMemberPage, handler);
async function guardMemberPage(req, res, next) {
  const viewerId = getViewerId(req);
  const targetId = req.params.memberId || req.params.member_id || req.query.member_id;

  try {
    const decision = await withClient(client =>
      evaluateMemberPageAccess({ client, viewerId, targetId })
    );

    if (!decision.allowed) {
      const status = decision.httpStatus || 403;
      if (status === 404) {
        return res.status(404).send('Not found');
      }
      return res.status(status).json({
        error: 'access_denied',
        reason: decision.reason || 'access_denied'
      });
    }

    // Attach decision for downstream handlers (to decide what to show)
    req.accessDecision = decision;
    return next();
  } catch (err) {
    console.error('guardMemberPage error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

// Guard attempting a contact request.
// Expects targetId in req.body.target_member_id or req.params.memberId.
async function guardContactRequest(req, res, next) {
  const requesterId = getViewerId(req);
  const targetId =
    req.body?.target_member_id ||
    req.params.memberId ||
    req.params.member_id ||
    req.query.target_member_id;

  const requestedChannelType =
    (req.body && req.body.channel_type) ||
    (req.query && req.query.channel_type) ||
    null;

  try {
    const decision = await withClient(client =>
      evaluateContactRequest({
        client,
        requesterId,
        targetId,
        requestedChannelType
      })
    );

    if (!decision.allowed) {
      return res.status(decision.httpStatus || 403).json({
        error: 'contact_not_allowed',
        reason: decision.reason || 'contact_not_allowed',
        guardianBlocked: decision.guardianBlocked
      });
    }

    req.contactGuard = {
      requesterId,
      targetId,
      requestedChannelType
    };

    return next();
  } catch (err) {
    console.error('guardContactRequest error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
}

// -----------------------------
// Exports
// -----------------------------

module.exports = {
  getViewerId,
  evaluateMemberPageAccess,
  evaluateContactRequest,
  guardMemberPage,
  guardContactRequest
};
