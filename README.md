CHECK THIS OUT
<!-- TRUE_LOCATION: README.md -->
<!-- IN_USE: FALSE -->
# FF Platforms Server

Unified API exposing **ESPN** and **Sleeper** under one process.

- `/api/espn/*` → proxies your existing ESPN service
- `/api/sleeper/*` → direct Sleeper API with normalization
- CORS, rate limit, TTL cache, health check

## Quick start

```bash
cp .env.example .env
npm i
npm run dev
# open http://localhost:5050/health
