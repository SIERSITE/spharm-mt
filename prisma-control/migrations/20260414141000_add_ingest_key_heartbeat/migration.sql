-- Bidirectional integration: ingest API key + agent heartbeat (control plane).
-- Additive-only.

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "ingestApiKeyHash"     TEXT,
  ADD COLUMN IF NOT EXISTS "ingestApiKeyIssuedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastAgentHeartbeatAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastAgentIp"          TEXT,
  ADD COLUMN IF NOT EXISTS "lastAgentVersion"     TEXT;
