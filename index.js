// index.js — Express server for Render
import express from "express";
import cors from "cors";
import morgan from "morgan";

// Routers
import feinAuthRouter from "./fein-auth/index.js"; // mounts /api/fein-auth/*
import leaguesRouter from "./fein-auth/by-league.js"; // alias /api/leagues

const app = express();

// Basic middleware
app.use(cors({ origin: "*", methods: ["GET", "OPTIONS"] }));
app.use(express.json());
app.use(morgan("tiny"));

// Health
app.get(["/", "/healthz"], (req, res) => res.json({ ok: true, service: "fein-auth-service" }));

// Routes
app.use("/api/fein-auth", feinAuthRouter); // -> /api/fein-auth/by-league
app.use("/api/leagues", leaguesRouter);    // public alias -> /api/leagues

// 404 fallback
app.use((req, res) => res.status(404).json({ ok: false, error: "Not found", path: req.path }));

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FEIN auth service listening on :${PORT}`);
});
