#!/usr/bin/env bash
set -Eeuo pipefail

# Compute build version once per deploy
BUILD_VERSION="$(date -u +%Y.%m.%d.%H%M)-${RENDER_GIT_BRANCH:-main}-$(echo -n "${RENDER_GIT_COMMIT:-}" | cut -c1-7)"
export BUILD_VERSION

# Write version.json using Node (avoids heredoc pitfalls)
node - <<'NODE'
const fs = require('fs');
const path = require('path');

const outDir = 'public'; // adjust if your static dir differs
fs.mkdirSync(outDir, { recursive: true });

const payload = {
  version: process.env.BUILD_VERSION || 'dev',
  branch: process.env.RENDER_GIT_BRANCH || '',
  commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7),
  builtAt: new Date().toISOString(),
};

const outFile = path.join(outDir, 'version.json');
fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
console.log('Wrote', outFile, payload);
NODE

# Install & build your app
npm ci
npm run build || true

# If your build outputs to "dist", ship version.json too:
if [ -d "dist" ]; then
  mkdir -p dist
  cp -f public/version.json dist/version.json
fi

# Validate JSON
node -e "JSON.parse(require('fs').readFileSync('public/version.json','utf8'))"
