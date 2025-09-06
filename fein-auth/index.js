// fein-auth/index.js
import { Router } from "express";
import byLeague from "./by-league.js";

const router = Router();

// Document the available endpoints
router.get("/", (req, res) => {
  res.json({
    ok: true,
    routes: [
      { path: "/api/fein-auth/by-league?season=2025", public: true, desc: "List leagues (no auth)" },
    ],
  });
});

// /api/fein-auth/by-league
router.use("/by-league", byLeague);

export default router;
