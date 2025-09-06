// CommonJS entry for Render
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

// Routers
const feinAuthRouter = require("./fein-auth");          // mounts /api/fein-auth/*
const leaguesRouter  = require("./fein-auth/by-league"); // alias /api/leagues

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "OPTIONS"] }));
app.use(express.json());
app.use(morgan("tiny"));

app.get(["/", "/healthz"], (req, res) =>
  res.json({ ok: true, service: "fein-auth-service" })
);

// Routes
app.use("/api/fein-auth", feinAuthRouter);
app.use("/api/leagues", leaguesRouter);

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: "Not found", path: req.path }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FEIN auth service listening on :${PORT}`));
