// routes/rooms.js
const express = require('express');
const RoomService = require('../services/roomService');

const router = express.Router();

/**
 * GET /api/rooms/vanity/:lane
 * Example: /api/rooms/vanity/c?ty=MiltonPA
 *          /api/rooms/vanity/p?rty=OceansMiami
 *
 * Front-end for /p, /t, /c just hits this to get the room descriptor.
 */
router.get('/vanity/:lane', async (req, res, next) => {
  try {
    const lane = req.params.lane; // 'c', 'p', 't', 's', 'b', 'g', etc

    const entries = Object.entries(req.query || {});
    if (entries.length !== 1) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_vanity_query',
        message: 'Expected exactly one query param: mask=slug (e.g. ?ty=MiltonPA)',
      });
    }

    const [mask, slug] = entries[0];

    // However you're tracking logged-in user ID:
    const memberId =
      req.user?.member_id ||
      req.cookies?.ff_member_id ||
      null;

    const room = await RoomService.resolveFromVanity({
      lane,
      mask,
      slug,
      memberId,
      autoCreate: true,
    });

    return res.json({ ok: true, room });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/rooms/:room_id
 * Fetch a specific room by ID (used when deep-linking).
 */
router.get('/:room_id', async (req, res, next) => {
  try {
    const room = await RoomService.getRoomById(req.params.room_id);
    if (!room) {
      return res.status(404).json({ ok: false, error: 'room_not_found' });
    }

    const settings = await RoomService.getRoomSettings(room.room_id);

    return res.json({ ok: true, room, settings });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/rooms
 * List rooms for the current member (for "My rooms" UI).
 */
router.get('/', async (req, res, next) => {
  try {
    const memberId =
      req.user?.member_id ||
      req.cookies?.ff_member_id ||
      null;

    if (!memberId) {
      return res.status(401).json({ ok: false, error: 'not_authenticated' });
    }

    const rooms = await RoomService.listRoomsForMember(memberId);
    return res.json({ ok: true, rooms });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/rooms/types
 * For dev tools: inspect what room types exist and their defaults.
 */
router.get('/types/all', async (req, res, next) => {
  try {
    const types = await RoomService.listRoomTypes();
    return res.json({ ok: true, types });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/rooms/:room_id/settings
 * Update a specific setting (dev tools later).
 */
router.patch('/:room_id/settings', async (req, res, next) => {
  try {
    const { key, value } = req.body;
    if (!key) {
      return res.status(400).json({ ok: false, error: 'missing_key' });
    }

    const memberId =
      req.user?.member_id ||
      req.cookies?.ff_member_id ||
      null;

    const setting = await RoomService.setRoomSetting(
      req.params.room_id,
      key,
      value,
      memberId
    );

    return res.json({ ok: true, setting });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
