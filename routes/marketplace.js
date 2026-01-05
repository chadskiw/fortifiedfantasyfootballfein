const express = require('express');
const pool = require('../src/db/pool');

const router = express.Router();

function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function normalizePrice(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error('price must be a numeric value');
  }
  return parsed;
}

function formatListing(row) {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description ?? null,
    price: row.price === null || row.price === undefined ? null : Number(row.price),
    imageUrl: row.image_url ?? null,
    location: row.location ?? null,
    createdAt,
  };
}

function getActorId(req) {
  const headerId = req.header('x-user-id');
  if (headerId) return headerId;
  const bodyId = req.body?.user_id;
  if (typeof bodyId === 'string' && bodyId.trim()) return bodyId;
  const queryId = req.query?.user_id;
  if (typeof queryId === 'string' && queryId.trim()) return queryId;
  return null;
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const whereClauses = [];
    const values = [];
    const userId = getActorId(req);
    if (userId) {
      values.push(userId);
      whereClauses.push(`user_id = $${values.length}`);
    }
    const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `
      SELECT id, user_id, title, description, price, image_url, location, created_at
      FROM am_listings
      ${where}
      ORDER BY created_at DESC
    `,
      values
    );

    res.json({
      listings: rows.map(formatListing),
    });
  })
);

router.get(
  '/:listingId',
  asyncHandler(async (req, res) => {
    const { listingId } = req.params;
    const { rows } = await pool.query(
      `
      SELECT id, user_id, title, description, price, image_url, location, created_at
      FROM am_listings
      WHERE id = $1
    `,
      [listingId]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Listing not found' });
      return;
    }
    res.json({ listing: formatListing(rows[0]) });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const userId = getActorId(req);
    if (!userId) {
      res.status(401).json({ error: 'x-user-id header or user_id is required' });
      return;
    }
    const { title, description, price, image_url, location } = req.body || {};
    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'title is required' });
      return;
    }
    let parsedPrice = null;
    try {
      parsedPrice = normalizePrice(price);
    } catch (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    const { rows } = await pool.query(
      `
      INSERT INTO am_listings (user_id, title, description, price, image_url, location)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, user_id, title, description, price, image_url, location, created_at
    `,
      [userId, title, description ?? null, parsedPrice, image_url ?? null, location ?? null]
    );

    res.status(201).json({ listing: formatListing(rows[0]) });
  })
);

router.patch(
  '/:listingId',
  asyncHandler(async (req, res) => {
    const { listingId } = req.params;
    const userId = getActorId(req);
    if (!userId) {
      res.status(401).json({ error: 'x-user-id header or user_id is required' });
      return;
    }
    const fields = [];
    const { title, description, price, image_url, location } = req.body || {};

    if (title !== undefined) {
      if (!title) {
        res.status(400).json({ error: 'title must be a non-empty string' });
        return;
      }
      fields.push({ column: 'title', value: title });
    }
    if (description !== undefined) {
      fields.push({ column: 'description', value: description ?? null });
    }
    if (image_url !== undefined) {
      fields.push({ column: 'image_url', value: image_url ?? null });
    }
    if (location !== undefined) {
      fields.push({ column: 'location', value: location ?? null });
    }
    if (price !== undefined) {
      let parsedPrice = null;
      try {
        parsedPrice = normalizePrice(price);
      } catch (error) {
        res.status(400).json({ error: error.message });
        return;
      }
      fields.push({ column: 'price', value: parsedPrice });
    }

    if (!fields.length) {
      res.status(400).json({ error: 'At least one value must be provided for update' });
      return;
    }

    const assignments = fields.map((f, index) => `${f.column} = $${index + 1}`);
    const values = fields.map((f) => f.value);
    values.push(listingId, userId);

    const { rows } = await pool.query(
      `
      UPDATE am_listings
      SET ${assignments.join(', ')}
      WHERE id = $${values.length - 1} AND user_id = $${values.length}
      RETURNING id, user_id, title, description, price, image_url, location, created_at
    `,
      values
    );

    if (!rows.length) {
      res.status(404).json({ error: 'Listing not found or you do not own it' });
      return;
    }
    res.json({ listing: formatListing(rows[0]) });
  })
);

router.delete(
  '/:listingId',
  asyncHandler(async (req, res) => {
    const { listingId } = req.params;
    const userId = getActorId(req);
    if (!userId) {
      res.status(401).json({ error: 'x-user-id header or user_id is required' });
      return;
    }
    const { rows } = await pool.query(
      `
      DELETE FROM am_listings
      WHERE id = $1 AND user_id = $2
      RETURNING id
    `,
      [listingId, userId]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Listing not found or you do not own it' });
      return;
    }
    res.status(204).end();
  })
);

module.exports = router;
