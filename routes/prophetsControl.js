const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const pool = require('../src/db/pool');

const router = express.Router();

const PROPHET_PIN = (process.env.PROPHET_PANEL_PIN || 'aahs').trim().toLowerCase();

router.use(express.json({ limit: '1mb' }));

async function ensureControlTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prophets_tour_dates (
      id uuid PRIMARY KEY,
      show_date date NOT NULL,
      city text NOT NULL,
      venue text NOT NULL,
      notes text,
      link text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prophets_appearance (
      id integer PRIMARY KEY,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    INSERT INTO prophets_appearance (id, config)
    VALUES (1, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);
}

ensureControlTables().catch((err) => {
  console.error('[prophets-control] schema setup failed', err);
});

function normalizePin(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function requireProphetPin(req, res, next) {
  const headerPin = normalizePin(req.header('x-prophet-pin'));
  const queryPin = normalizePin(req.query?.pin);
  const bodyPin = normalizePin(req.body?.pin);
  const pin = headerPin || queryPin || bodyPin;
  if (!pin) {
    return res.status(401).json({ error: 'missing_pin' });
  }
  if (pin !== PROPHET_PIN) {
    return res.status(403).json({ error: 'invalid_pin' });
  }
  next();
}

const LoginSchema = z.object({
  pin: z.string().min(1),
});

const TourDateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  city: z.string().min(1).max(120),
  venue: z.string().min(1).max(160),
  notes: z.string().max(400).optional().nullable(),
  link: z.string().url().max(220).optional().nullable(),
});

const TourDateUpdateSchema = TourDateSchema.deepPartial().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field is required',
});

const AppearanceUpdateSchema = z.object({
  heroTitle: z.string().max(200).optional(),
  heroSubtitle: z.string().max(400).optional(),
  layoutMode: z.enum(['dark', 'light', 'auto']).optional(),
  palette: z
    .object({
      primary: z.string().max(30).optional(),
      accent: z.string().max(30).optional(),
      background: z.string().max(30).optional(),
    })
    .partial()
    .optional(),
});

function formatTourRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.show_date ? row.show_date.toISOString().slice(0, 10) : null,
    city: row.city,
    venue: row.venue,
    notes: row.notes,
    link: row.link,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.post('/login', async (req, res) => {
  const body = LoginSchema.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: 'missing_pin' });
  }
  if (normalizePin(body.data.pin) !== PROPHET_PIN) {
    return res.status(403).json({ error: 'invalid_pin' });
  }

  const tourResult = await pool.query(`
    SELECT id, show_date, city, venue, notes, link, created_at, updated_at
    FROM prophets_tour_dates
    ORDER BY show_date ASC, created_at DESC
  `);
  const appearanceResult = await pool.query('SELECT config, updated_at FROM prophets_appearance WHERE id=1');

  res.json({
    ok: true,
    tourDates: tourResult.rows.map(formatTourRow).filter(Boolean),
    appearance: appearanceResult.rows[0]?.config || {},
    appearanceUpdatedAt: appearanceResult.rows[0]?.updated_at || null,
  });
});

router.use(['/tour-dates', '/appearance'], requireProphetPin);

router.get('/tour-dates', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT id, show_date, city, venue, notes, link, created_at, updated_at
    FROM prophets_tour_dates
    ORDER BY show_date ASC, created_at DESC
  `);
  res.json({ tourDates: rows.map(formatTourRow).filter(Boolean) });
});

router.post('/tour-dates', async (req, res) => {
  const body = TourDateSchema.parse(req.body);
  const id = crypto.randomUUID();
  const values = [
    id,
    body.date,
    body.city,
    body.venue,
    body.notes ?? null,
    body.link ?? null,
  ];
  const { rows } = await pool.query(
    `
      INSERT INTO prophets_tour_dates (id, show_date, city, venue, notes, link)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id, show_date, city, venue, notes, link, created_at, updated_at
    `,
    values
  );
  res.status(201).json({ tourDate: formatTourRow(rows[0]) });
});

router.put('/tour-dates/:id', async (req, res) => {
  const body = TourDateUpdateSchema.parse(req.body);
  const updates = [];
  const values = [];
  const pushUpdate = (field, value) => {
    updates.push(`${field} = $${values.length + 1}`);
    values.push(value);
  };
  if (body.date) pushUpdate('show_date', body.date);
  if (body.city) pushUpdate('city', body.city);
  if (body.venue) pushUpdate('venue', body.venue);
  if (body.notes !== undefined) pushUpdate('notes', body.notes);
  if (body.link !== undefined) pushUpdate('link', body.link);
  if (!updates.length) {
    return res.status(400).json({ error: 'nothing_to_update' });
  }
  const id = req.params.id;
  values.push(id);
  const { rows } = await pool.query(
    `
      UPDATE prophets_tour_dates
      SET ${updates.join(', ')}, updated_at = now()
      WHERE id = $${values.length}
      RETURNING id, show_date, city, venue, notes, link, created_at, updated_at
    `,
    values
  );
  if (!rows.length) {
    return res.status(404).json({ error: 'tour_date_not_found' });
  }
  res.json({ tourDate: formatTourRow(rows[0]) });
});

router.delete('/tour-dates/:id', async (req, res) => {
  const { rows } = await pool.query('DELETE FROM prophets_tour_dates WHERE id = $1 RETURNING id', [
    req.params.id,
  ]);
  if (!rows.length) {
    return res.status(404).json({ error: 'tour_date_not_found' });
  }
  res.status(204).end();
});

router.get('/appearance', async (_req, res) => {
  const { rows } = await pool.query('SELECT config, updated_at FROM prophets_appearance WHERE id=1');
  res.json({
    appearance: rows[0]?.config || {},
    updatedAt: rows[0]?.updated_at || null,
  });
});

router.patch('/appearance', async (req, res) => {
  const body = AppearanceUpdateSchema.parse(req.body);
  const payload = {};
  if (body.heroTitle) payload.heroTitle = body.heroTitle;
  if (body.heroSubtitle) payload.heroSubtitle = body.heroSubtitle;
  if (body.layoutMode) payload.layoutMode = body.layoutMode;
  if (body.palette) payload.palette = body.palette;

  if (!Object.keys(payload).length) {
    return res.status(400).json({ error: 'nothing_to_update' });
  }

  const { rows } = await pool.query(
    `
      UPDATE prophets_appearance
      SET config = config || $1::jsonb,
          updated_at = now()
      WHERE id = 1
      RETURNING config, updated_at
    `,
    [JSON.stringify(payload)]
  );

  res.json({
    appearance: rows[0]?.config || {},
    updatedAt: rows[0]?.updated_at || null,
  });
});

module.exports = router;
