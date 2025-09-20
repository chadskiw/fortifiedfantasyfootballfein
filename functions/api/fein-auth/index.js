CHECK THIS OUT
// TRUE_LOCATION: functions/api/fein-auth/index.js
// IN_USE: FALSE
// CommonJS router wrapper
const { Router } = require("express");
const byLeague = require("./by-league");

const router = Router();

router.get("/", (req, res) => {
  res.json({
    ok: true,
    routes: [
      { path: "/api/fein-auth/by-league?season=2025", public: true, desc: "List leagues (no auth)" }
    ]
  });
});

router.use("/by-league", byLeague);

module.exports = router;
