// routes/userLanding.js
const express = require('express');
const path = require('path');
const userOverviewService = require('../services/UserOverviewService');
const pool = require('../src/db/pool');
const Bouncer = require('./Bouncer');

const router = express.Router();

const DEFAULT_THEME = {
  hue: 214,
  sat: 68,
  light: 46,
  motion: false,
};

function clampThemeValue(value, min, max, fallback) {
  const num = Number(value);
  if (Number.isNaN(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function normalizeThemePayload(payload = {}) {
  return {
    map_hue: clampThemeValue(
      payload.hue ?? payload.map_hue,
      0,
      360,
      DEFAULT_THEME.hue
    ),
    map_sat: clampThemeValue(
      payload.sat ?? payload.map_sat,
      10,
      100,
      DEFAULT_THEME.sat
    ),
    map_light: clampThemeValue(
      payload.light ?? payload.map_light,
      10,
      70,
      DEFAULT_THEME.light
    ),
    motion_enabled:
      payload.motion_enabled === true || payload.motionEnabled === true,
  };
}

function hslToHex(h, s, l) {
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

function formatThemeResponse(row) {
  const hue = clampThemeValue(row.map_hue, 0, 360, DEFAULT_THEME.hue);
  const sat = clampThemeValue(row.map_sat, 0, 100, DEFAULT_THEME.sat);
  const light = clampThemeValue(row.map_light, 0, 100, DEFAULT_THEME.light);
  return {
    map_hue: hue,
    map_sat: sat,
    map_light: light,
    motion_enabled: row.motion_enabled === true,
    accent_hex: hslToHex(hue, sat, light),
  };
}

function maskOverviewForAccess(overview, decision) {
  if (!overview) return overview;
  if (!decision || decision.accessLevel === 'full') {
    return overview;
  }

  const masked = {
    ...overview,
    recent_photos: [],
  };

  if (Array.isArray(overview.map_photos)) {
    masked.map_photos = [];
  }

  masked.photo_bounds = { has_geo: false };
  return masked;
}

function buildAccessPayload(decision = {}, req) {
  const viewerId = Bouncer.getViewerId(req);
  const accessLevel = decision.accessLevel || 'limited';
  const isStranger = decision.isStranger !== false;
  const isOwner = !!decision.isOwner;
  const canUseContactMe = !!viewerId && accessLevel !== 'none' && !isStranger;

  return {
    level: accessLevel,
    canRequestContact: !!decision.canRequestContact,
    isStranger,
    isOwner,
    reason: decision.reason || null,
    guardianBlockReason: decision.guardianBlockReason || null,
    viewerIsAuthenticated: !!viewerId,
    canUseContactMe: canUseContactMe && !isOwner,
  };
}

// JSON API: user overview
router.get('/api/users/:memberId/overview', Bouncer.guardMemberPage, async (req, res) => {
  const { memberId } = req.params;
  const accessDecision = req.accessDecision || null;
  const viewerId = Bouncer.getViewerId(req);

  try {
    const overview = await userOverviewService.getOverview(memberId, {
      viewerId,
    });
    if (!overview) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const payload = maskOverviewForAccess(overview, accessDecision);
    payload.access = buildAccessPayload(accessDecision, req);
    res.json(payload);
  } catch (err) {
    console.error('User overview error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/api/users/:memberId/theme', async (req, res) => {
  const viewerId = Bouncer.getViewerId(req);
  if (!viewerId) {
    return res.status(401).json({ error: 'not_authenticated' });
  }

  const { memberId } = req.params;
  if (!memberId || viewerId !== memberId) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const theme = normalizeThemePayload(req.body || {});

  try {
    const { rows } = await pool.query(
      `
        INSERT INTO tt_user_theme (
          member_id,
          map_hue,
          map_sat,
          map_light,
          motion_enabled,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (member_id)
        DO UPDATE SET
          map_hue = EXCLUDED.map_hue,
          map_sat = EXCLUDED.map_sat,
          map_light = EXCLUDED.map_light,
          motion_enabled = EXCLUDED.motion_enabled,
          updated_at = NOW()
        RETURNING map_hue, map_sat, map_light, motion_enabled
      `,
      [
        memberId,
        theme.map_hue,
        theme.map_sat,
        theme.map_light,
        theme.motion_enabled,
      ]
    );

    if (!rows.length) {
      return res.status(500).json({ error: 'theme_save_failed' });
    }

    const formatted = formatThemeResponse(rows[0]);
    return res.json({ ok: true, theme: formatted });
  } catch (err) {
    console.error('user theme save failed', err);
    return res.status(500).json({ error: 'theme_save_failed' });
  }
});

// HTML page: /u/:memberId
router.get('/u/:memberId', Bouncer.guardMemberPage, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'trashtalk', 'u.html'));
});

// Optional: /u -> current user's page
router.get('/u', (req, res) => {
  if (req.user && req.user.member_id) {
    return res.redirect(`/u/${encodeURIComponent(req.user.member_id)}`);
  }
  return res.redirect('/');
});

module.exports = router;
