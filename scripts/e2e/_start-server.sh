#!/bin/bash
# Arranca o servidor standalone local para o ensaio E2E (base descartável).
cd "$(dirname "$0")/../.." || exit 1
mkdir -p .next/standalone/.next && rm -rf .next/standalone/.next/static && cp -r .next/static .next/standalone/.next/static && cp -r public .next/standalone/public 2>/dev/null
cd .next/standalone && PORT=3100 HOSTNAME=localhost ALLOW_LEGACY_DATABASE_FALLBACK=1 SERVER_ACTIONS_ALLOWED_ORIGINS=localhost:3100,127.0.0.1:3100 AUTH_SECRET=${E2E_AUTH_SECRET:-e2e-test-secret-e2e-test-secret-0123456789} DATABASE_URL=${E2E_DATABASE_URL:-postgresql://postgres:test@localhost:55432/spharm_e2e} exec node server.js
