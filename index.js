// Minimal Express service exposing /fein/upsert-meta
// No DB here—just echoes back so you can verify the route exists.

import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

// CORS + JSON
app.use(express.json());
app.use((req, res, next) => {
  res.set({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-fein-key"
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Optional GET so you can hit it in a browser
app.get("/fein/upsert-meta", (_req, res) => {
  res.json({
    ok: true,
    hint: "POST JSON here to upsert team meta",
    expect: {
      leagueId: "12345",
      teamId: "7",
      season: "2025",
      leagueSize: 12,
      teamName: "Team Name",
      owner: "Owner",
      fb_groups: ["Name", "@handle", "Group A"]
    }
  });
});

// The POST your CF Pages function will call
app.post("/fein/upsert-meta", (req, res) => {
  const b = req.body || {};
  if (!b.leagueId || !b.teamId || !b.season) {
    return res.status(400).json({ ok: false, error: "leagueId, teamId, season required" });
  }
  // TODO: upsert into your DB here.
  res.json({ ok: true, stored: true, row: b });
});

// Start
app.listen(PORT, () => {
  console.log(`fein-auth-service listening on :${PORT}`);
});
