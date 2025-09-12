// server.js
const express = require('express');
const cookieParser = require('cookie-parser');             // NEW
const feinAuthRouter = require('./routes/fein-auth');
const feinReact = require('./routes/feinReact');

const app = express();
const PORT = process.env.PORT || 3000;

// If behind a proxy/HTTPS (Render/Heroku), this lets "secure" cookies set properly.
app.set('trust proxy', 1);                                  // NEW

// ===== Middleware =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());                                    // NEW

// CORS (global)
const ALLOWED = [
  'https://fortifiedfantasy.com',
  'https://fortifiedfantasy4.pages.dev',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const isAllowed = (origin) => origin && ALLOWED.includes(origin);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // ALLOW DELETE (needed for logout)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');   // CHANGED

  // Add any custom headers you use
  res.setHeader(
    'Access-Control-Allow-Headers',
    'content-type,x-fein-key,x-espn-swid,x-espn-s2'
  );

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

// Mount same router on both paths your frontend might call
app.use('/api/fein-auth', feinAuthRouter);
app.use('/fein-auth', feinAuthRouter);

// ===== 404 fallback =====
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not Found', path: req.path }));

// ===== Start =====
app.listen(PORT, () => console.log(`fein-auth-service listening on :${PORT}`));
