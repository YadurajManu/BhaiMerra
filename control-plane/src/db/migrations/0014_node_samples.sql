-- Telemetry history.
--
-- Heartbeats land in Redis under a TTL, deliberately: losing Redis should cost
-- one detection cycle, not data. The consequence is that the control plane has
-- never been able to answer "what was this node doing an hour ago" — every
-- number in the dashboard is an instant with no before.
--
-- This is the before. One row per node per sample, downsampled by the sweeper
-- so it does not grow without bound: roughly 3 MB per node per month.

CREATE TABLE IF NOT EXISTS "node_samples" (
  "node_id"       uuid NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
  "at"            timestamptz NOT NULL,
  "cpu_pct"       real,
  "ram_used_mb"   integer,
  "disk_used_mb"  integer,
  "disk_total_mb" integer,
  "containers"    integer,
  -- Which resolution this row belongs to. Rows are rolled up into coarser
  -- buckets and the fine ones deleted, so a chart asks for the grain it needs
  -- instead of scanning a month of ten-second samples.
  "grain"         text NOT NULL DEFAULT 'fine',
  PRIMARY KEY ("node_id", "at", "grain")
);

-- Every query is "this node, this window, this grain", newest first.
CREATE INDEX IF NOT EXISTS "node_samples_node_at_idx"
  ON "node_samples" ("node_id", "grain", "at" DESC);

-- Retention sweeps ask "what is older than X at grain Y" across all nodes.
CREATE INDEX IF NOT EXISTS "node_samples_grain_at_idx"
  ON "node_samples" ("grain", "at");
