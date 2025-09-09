// index.js
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// import your router
const feinAuthRouter = require('./fein-auth');

// HEALTH
app.get('/health', (_req, res) => res.json({ ok: true, service: 'fein-auth-service' }));

// Mount the SAME router in BOTH places so either URL works:
app.use('/fein-auth', feinAuthRouter);      // e.g. /fein-auth/by-league
app.use('/api/fein-auth', feinAuthRouter);  // e.g. /api/fein-auth/by-league

// 404 (json)
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not Found', path: req.path }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FEIN Auth listening on :${PORT}`));
