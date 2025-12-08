// services/RoomService.js
const pool = require('../src/db/pool'); // whatever you use in other services (pg Pool wrapper)

class RoomService {
  /**
   * Resolve a vanity URL like:
   *   lane='c', mask='ty', slug='MiltonPA'
   * into a tt_room row. If none exists, optionally auto-create it.
   */
  static async resolveFromVanity({ lane, mask, slug, memberId = null, autoCreate = true }) {
    if (!lane || !mask || !slug) {
      throw new Error('resolveFromVanity requires lane, mask, and slug');
    }

    // 1) Look up room_type based on lane+mask
    const { rows: typeRows } = await pool.query(
      `
      SELECT room_type, default_visibility_mode, default_settings
      FROM tt_room_type
      WHERE lane = $1 AND mask = $2
      `,
      [lane, mask]
    );

    if (typeRows.length === 0) {
      if (!autoCreate) return null;
      // If we ever want truly "unknown" types, we could map to 'custom' here.
      throw new Error(`No room_type registered for lane="${lane}" mask="${mask}"`);
    }

    const roomTypeRow = typeRows[0];

    // 2) Try to find existing room
    const { rows: existingRows } = await pool.query(
      `
      SELECT *
      FROM tt_room
      WHERE lane = $1 AND mask = $2 AND slug = $3
      `,
      [lane, mask, slug]
    );

    if (existingRows.length > 0) {
      return existingRows[0];
    }

    if (!autoCreate) return null;

    // 3) Auto-create new room instance using defaults
    const name = slug; // you can later prettify or let host rename
    const visibilityMode = roomTypeRow.default_visibility_mode || 'public';

    const insertQuery = `
      INSERT INTO tt_room (
        room_type,
        lane,
        mask,
        slug,
        name,
        host_member_id,
        visibility_mode
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `;

    const { rows: createdRows } = await pool.query(insertQuery, [
      roomTypeRow.room_type,
      lane,
      mask,
      slug,
      name,
      memberId,
      visibilityMode,
    ]);

    const room = createdRows[0];

    // Optionally auto-add host as room_member
    if (memberId) {
      await pool.query(
        `
        INSERT INTO tt_room_member (room_id, member_id, role, join_state, is_favorite)
        VALUES ($1, $2, 'host', 'joined', TRUE)
        ON CONFLICT (room_id, member_id) DO NOTHING
        `,
        [room.room_id, memberId]
      );
    }

    return room;
  }

  static async getRoomById(roomId) {
    const { rows } = await pool.query(
      `SELECT * FROM tt_room WHERE room_id = $1`,
      [roomId]
    );
    return rows[0] || null;
  }

  static async getRoomByVanity({ lane, mask, slug }) {
    const { rows } = await pool.query(
      `SELECT * FROM tt_room WHERE lane = $1 AND mask = $2 AND slug = $3`,
      [lane, mask, slug]
    );
    return rows[0] || null;
  }

  static async ensureBinding(roomId, { bindingKind, bindingId }) {
    await pool.query(
      `
      INSERT INTO tt_room_binding (room_id, binding_kind, binding_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (room_id, binding_kind, binding_id) DO NOTHING
      `,
      [roomId, bindingKind, bindingId]
    );
  }

  static async listRoomsForMember(memberId) {
    const { rows } = await pool.query(
      `
      SELECT r.*
      FROM tt_room_member rm
      JOIN tt_room r ON r.room_id = rm.room_id
      WHERE rm.member_id = $1
      ORDER BY rm.is_favorite DESC, r.updated_at DESC
      `,
      [memberId]
    );
    return rows;
  }

  static async setRoomSetting(roomId, key, value, updatepoolyMemberId = null) {
    const { rows } = await pool.query(
      `
      INSERT INTO tt_room_setting (room_id, key, value, updated_by_member_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (room_id, key)
      DO UPDATE SET
        value = EXCLUDED.value,
        updated_by_member_id = EXCLUDED.updated_by_member_id,
        updated_at = NOW()
      RETURNING *
      `,
      [roomId, key, value, updatedByMemberId]
    );
    return rows[0];
  }

  static async getRoomSettings(roomId) {
    const { rows } = await pool.query(
      `
      SELECT key, value
      FROM tt_room_setting
      WHERE room_id = $1
      ORDER BY key
      `,
      [roomId]
    );
    const result = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  static async listRoomTypes() {
    const { rows } = await pool.query(
      `SELECT * FROM tt_room_type ORDER BY is_system DESC, room_type`
    );
    return rows;
  }
}

module.exports = RoomService;
