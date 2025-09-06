// src/fein-auth.js
const { Router } = require("express");
const router = Router();

// Public route — no auth required
router.get("/", async (req, res) => {
  res.json({
    ok: true,
    routes: [
      { path: "/api/fein-auth/by-league?season=2025", public: true, desc: "List leagues" }
    ]
  });
});

module.exports = router;
