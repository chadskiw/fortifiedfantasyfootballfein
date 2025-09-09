// server.js
const express = require('express');
const feinAuthRouter = require('./routes/fein-auth');
const feinReact = require('./routes/feinReact');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Middleware =====
app.use(express.json()); // <-- this is crucial for req.body
app.use(express.urlencoded({ extended: true }));

// CORS (global)
const ALLOWED = [
  'https://fortifiedfantasy.com',
  'https://fortifiedfantasy4.pages.dev',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
function isAllowed(origin) { return origin && ALLOWED.includes(origin); }
app.use((req, res, next) => {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-fein-key,x-espn-swid,x-espn-s2');
  if (isAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ===== Routes =====
app.get('/health', (_req, res) => res.json({ ok: true, service: 'fein-auth-service' }));

app.use('/api/fein/react', feinReact);
app.use('/fein-auth', feinAuthRouter);
app.use('/api/fein-auth', feinAuthRouter);

// ===== 404 fallback =====
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not Found', path: req.path }));

// ===== Start =====
app.listen(PORT, () => console.log(`fein-auth-service listening on :${PORT}`));
