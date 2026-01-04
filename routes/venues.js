const express = require('express');
const { randomUUID } = require('crypto');
const pool = require('../src/db/pool');

const router = express.Router();

function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function formatMenuItem(row) {
  return {
    id: row.item_id,
    name: row.name,
    description: row.description,
    category: row.category,
    price_cents: row.price_cents,
    price: typeof row.price_cents === 'number' ? `$${(row.price_cents / 100).toFixed(2)}` : null,
    metadata: row.metadata,
    sort_order: row.sort_order,
  };
}

router.get(
  '/:venueId/menu',
  asyncHandler(async (req, res) => {
    const { venueId } = req.params;
    const { rows } = await pool.query(
      `
      SELECT item_id, venue_id, name, description, price_cents, category, metadata, sort_order
      FROM ff_venue_menu_item
      WHERE venue_id = $1
      ORDER BY sort_order NULLS LAST, name ASC
    `,
      [venueId]
    );
    res.json({ items: rows.map(formatMenuItem) });
  })
);

router.get(
  '/:venueId/events',
  asyncHandler(async (req, res) => {
    const { venueId } = req.params;
    const from = req.query.from ? new Date(String(req.query.from)) : new Date();
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      res.status(400).json({ error: 'Invalid from/to query' });
      return;
    }
    const { rows } = await pool.query(
      `
      SELECT event_id, venue_id, title, details, start_at, end_at, metadata
      FROM ff_venue_event
      WHERE venue_id = $1 AND start_at >= $2 AND start_at <= $3
      ORDER BY start_at ASC
    `,
      [venueId, from.toISOString(), to.toISOString()]
    );
    res.json({ events: rows });
  })
);

router.post(
  '/:venueId/devices',
  asyncHandler(async (req, res) => {
    const { venueId } = req.params;
    const { expo_push_token, platform, app_build } = req.body;
    if (!expo_push_token) {
      res.status(400).json({ error: 'expo_push_token is required' });
      return;
    }
    const deviceId = randomUUID();
    const now = new Date().toISOString();
    const { rows } = await pool.query(
      `
      INSERT INTO ff_venue_device (device_id, venue_id, expo_push_token, platform, app_build, opt_in, last_seen_at)
      VALUES ($1, $2, $3, $4, $5, true, $6)
      ON CONFLICT (venue_id, expo_push_token)
      DO UPDATE SET platform = $4, app_build = $5, last_seen_at = $6, opt_in = true
      RETURNING device_id
    `,
      [deviceId, venueId, expo_push_token, platform ?? null, app_build ?? null, now]
    );
    res.status(201).json({ deviceId: rows[0]?.device_id || deviceId });
  })
);

router.get(
  '/:venueId/status',
  asyncHandler(async (req, res) => {
    const { venueId } = req.params;
    const eventsResult = await pool.query(
      `
      SELECT event_id, title, start_at, end_at
      FROM ff_venue_event
      WHERE venue_id = $1 AND start_at >= now() AND start_at <= now() + interval '24 hours'
      ORDER BY start_at ASC
    `,
      [venueId]
    );
    const leaderboard = await pool.query(
      `
      SELECT data
      FROM ff_venue_leaderboard
      WHERE venue_id = $1 AND scope = 'today'
      ORDER BY updated_at DESC
      LIMIT 1
    `,
      [venueId]
    );
    const leaderboardData = leaderboard.rows[0]?.data ?? null;
    const matches = await pool.query(
      `
      SELECT table_no, player_a, player_b, winner, created_at
      FROM ff_pool_match
      WHERE venue_id = $1
      ORDER BY created_at DESC
      LIMIT 4
    `,
      [venueId]
    );
    const tables = [1, 2].map((tableNo) => {
      const lastMatch = matches.rows.find((m) => m.table_no === tableNo);
      return {
        tableNo,
        nowPlaying: lastMatch
          ? {
              playerA: lastMatch.player_a,
              playerB: lastMatch.player_b,
              winner: lastMatch.winner,
              playedAt: lastMatch.created_at,
            }
          : null,
        upNext: [],
      };
    });
    res.json({
      pool: {
        active: tables.some((t) => t.nowPlaying !== null),
        mode: leaderboardData?.poolMode ?? 'casual',
        king: leaderboardData?.king ?? null,
        tables,
      },
      eventsNext24h: eventsResult.rows,
    });
  })
);

router.get(
  '/:venueId/leaderboard',
  asyncHandler(async (req, res) => {
    const { venueId } = req.params;
    const scope = String(req.query.scope ?? 'today');
    const { rows } = await pool.query(
      `
      SELECT data
      FROM ff_venue_leaderboard
      WHERE venue_id = $1 AND scope = $2
      ORDER BY updated_at DESC
      LIMIT 1
    `,
      [venueId, scope]
    );
    res.json(rows[0]?.data ?? { scope, players: [] });
  })
);

router.post(
  '/:venueId/pool/session/start',
  asyncHandler(async (req, res) => {
    const { venueId } = req.params;
    const { mode, rules } = req.body;
    if (!mode) {
      res.status(400).json({ error: 'mode is required' });
      return;
    }
    const id = randomUUID();
    await pool.query(
      `
      INSERT INTO ff_pool_session (id, venue_id, mode, rules, active)
      VALUES ($1, $2, $3, $4, true)
    `,
      [id, venueId, mode, rules ?? {}]
    );
    res.status(201).json({ session_id: id });
  })
);

router.post(
  '/:venueId/pool/match/end',
  asyncHandler(async (req, res) => {
    const { venueId } = req.params;
    const { session_id, table_no, player_a, player_b, winner } = req.body;
    if (!session_id || !table_no || !player_a || !player_b || !winner) {
      res.status(400).json({ error: 'session_id, table_no, player_a, player_b, and winner are required' });
      return;
    }
    await pool.query(
      `
      INSERT INTO ff_pool_match (id, venue_id, session_id, table_no, player_a, player_b, winner)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
      [randomUUID(), venueId, session_id, table_no, player_a, player_b, winner]
    );
    const sessionRow = await pool.query(
      'SELECT mode FROM ff_pool_session WHERE id = $1 AND venue_id = $2',
      [session_id, venueId]
    );
    const sessionMode = sessionRow.rows[0]?.mode ?? null;
    const leaderboardData = await recomputeLeaderboard(venueId, sessionMode, session_id);
    res.json({ leaderboard: leaderboardData });
  })
);

router.post(
  '/:venueId/push',
  asyncHandler(async (req, res) => {
    const { venueId } = req.params;
    const { title, message, deep_link, send_at } = req.body;
    if (!title || !message) {
      res.status(400).json({ error: 'title and message are required' });
      return;
    }
    const campaignId = randomUUID();
    const sendAt = send_at ? new Date(send_at) : new Date();
    const now = new Date();
    const pending = await pool.query(
      `
      SELECT device_id, expo_push_token
      FROM ff_venue_device
      WHERE venue_id = $1 AND opt_in = true
    `,
      [venueId]
    );
    await pool.query(
      `
      INSERT INTO ff_venue_push_campaign (campaign_id, venue_id, title, message, deep_link, send_at, status, recipient_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
      [campaignId, venueId, title, message, deep_link ?? null, sendAt.toISOString(), 'pending', pending.rowCount]
    );
    if (sendAt.getTime() <= now.getTime()) {
      // record the campaign as sent even though pushes aren't relayed here
      await pool.query(
        `
        UPDATE ff_venue_push_campaign
        SET status = 'sent', sent_at = now()
        WHERE campaign_id = $1
      `,
        [campaignId]
      );
    }
    res.status(201).json({ campaign_id: campaignId });
  })
);

router.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const { slug } = req.params;
    const venueResult = await pool.query(
      'SELECT venue_id, slug, name, description, timezone FROM ff_venue WHERE slug = $1',
      [slug]
    );
    if (!venueResult.rows.length) {
      res.status(404).json({ ok: false, error: 'Venue not found' });
      return;
    }
    const venue = venueResult.rows[0];
    const configResult = await pool.query(
      `
      SELECT theme, features, logo_url, updated_at
      FROM ff_venue_config
      WHERE venue_id = $1
      ORDER BY updated_at DESC
      LIMIT 1
    `,
      [venue.venue_id]
    );
    res.json({
      venue: {
        id: venue.venue_id,
        slug: venue.slug,
        name: venue.name,
        description: venue.description,
        timezone: venue.timezone,
      },
      config: configResult.rows[0] ?? null,
    });
  })
);

async function recomputeLeaderboard(venueId, sessionMode, sessionId) {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const matches = await pool.query(
    `
    SELECT winner, session_id, player_a, player_b, table_no, created_at
    FROM ff_pool_match
    WHERE venue_id = $1 AND created_at >= $2
    ORDER BY created_at ASC
  `,
    [venueId, startOfDay.toISOString()]
  );
  const winCounts = new Map();
  for (const row of matches.rows) {
    const count = winCounts.get(row.winner) || 0;
    winCounts.set(row.winner, count + 1);
  }
  const players = Array.from(winCounts.entries());
  players.sort((a, b) => b[1] - a[1]);
  const topPlayers = players.slice(0, 10).map(([name, wins]) => ({ name, wins }));

  let king = null;
  if (sessionMode === 'winner_stays') {
    const sessionMatches = matches.rows.filter((m) => m.session_id === sessionId);
    let streak = 0;
    let lastWinner = null;
    for (const match of sessionMatches) {
      if (match.winner === lastWinner) {
        streak += 1;
      } else {
        streak = 1;
        lastWinner = match.winner;
      }
      if (!king || streak > king.streak) {
        king = { name: match.winner, streak };
      }
    }
  }
  if (!king && topPlayers.length) {
    king = { name: topPlayers[0].name, streak: topPlayers[0].wins };
  }
  const payload = {
    scope: 'today',
    king,
    topPlayers,
    poolMode: sessionMode || 'casual',
    updated_at: new Date().toISOString(),
  };
  await pool.query(
    `
    INSERT INTO ff_venue_leaderboard (venue_id, scope, data)
    VALUES ($1, $2, $3)
    ON CONFLICT (venue_id, scope)
    DO UPDATE SET data = $3, updated_at = now()
  `,
    [venueId, 'today', payload]
  );
  return payload;
}

module.exports = router;
