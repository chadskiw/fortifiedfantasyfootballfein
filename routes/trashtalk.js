// routes/trashtalk.js
const express = require('express');
const multer = require('multer');
const exifr = require('exifr'); // now installed
const { uploadToR2 } = require('../services/r2Client');
const { pool } = require('../src/db');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});

router.post(
  '/upload',
  upload.array('photos', 10),
  async (req, res) => {
    try {
      const memberId = (req.user && req.user.member_id) || req.body.member_id;

      if (!memberId) {
        return res.status(400).json({ error: 'member_id required' });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const results = [];

      for (const file of req.files) {
        if (!file.mimetype.startsWith('image/')) continue;

        let exifData = null;
        try {
          exifData = await exifr.parse(file.buffer);
        } catch (err) {
          console.warn('EXIF parse failed for', file.originalname, err.message);
        }

        const timestamp = Date.now();
        const safeName = file.originalname.replace(/[^\w.\-]+/g, '_');
        const r2Key = `trashtalk/${memberId}/${timestamp}_${safeName}`;

        await uploadToR2({
          key: r2Key,
          body: file.buffer,
          contentType: file.mimetype,
        });

        const insertQuery = `
          INSERT INTO tt_photo (
            member_id,
            r2_key,
            original_filename,
            mime_type,
            exif
          )
          VALUES ($1, $2, $3, $4, $5)
          RETURNING photo_id, member_id, r2_key, created_at;
        `;

        const { rows } = await pool.query(insertQuery, [
          memberId,
          r2Key,
          file.originalname,
          file.mimetype,
          exifData ? JSON.stringify(exifData) : null,
        ]);

        results.push(rows[0]);
      }

      return res.status(201).json({
        uploaded: results.length,
        photos: results,
      });
    } catch (err) {
      console.error('TrashTalk upload error', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
);

module.exports = router;
