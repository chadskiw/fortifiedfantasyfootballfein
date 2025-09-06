// CommonJS entry for Render
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const feinAuthRouter = require("./fein-auth"); // this is the router you just fixed
const byLeagueRouter = require("./fein-auth/by-league");

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "OPTIONS"] }));
app.use(express.json());
app.use(morgan("tiny"));

app.get(["/", "/healthz"], (req, res) => {
  res.json({ ok: true, service: "fein-auth-service" });
});

// Mount routers
app.use("/api/fein-auth", feinAuthRouter);
app.use("/api/fein-auth/by-league", byLeagueRouter);

// 404 fallback
app.use((req, res) => res.status(404).json({ ok: false, error: "Not found", path: req.path }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on :${PORT}`));
