-- Keep the peaks, and make room for what the agent will soon report.
--
-- The roll-up averaged cpu_pct when folding ten-second samples into minutes,
-- and averaged again into hours. A spike to 100% lasting twenty seconds became
-- roughly 17% at minute grain and nothing at all at hour grain, so "peak CPU in
-- the last 24 hours" was not merely unbuilt, it was unanswerable.
--
-- Storing min and max alongside the mean fixes it permanently: max of maxima is
-- still the true peak however many times a row is folded.

ALTER TABLE "node_samples" ADD COLUMN IF NOT EXISTS "cpu_max"       real;
ALTER TABLE "node_samples" ADD COLUMN IF NOT EXISTS "cpu_min"       real;
ALTER TABLE "node_samples" ADD COLUMN IF NOT EXISTS "ram_max_mb"    integer;

-- Reported as a rate, not a counter. The OS exposes bytes-since-boot, so the
-- agent differences two readings and sends the result - a counter would reset
-- on every reboot and draw a cliff.
ALTER TABLE "node_samples" ADD COLUMN IF NOT EXISTS "net_rx_kbps"   integer;
ALTER TABLE "node_samples" ADD COLUMN IF NOT EXISTS "net_tx_kbps"   integer;

-- CPU percent hides queueing; load does not. One minute average is enough to
-- chart - the five and fifteen are derivable by eye from the shape.
ALTER TABLE "node_samples" ADD COLUMN IF NOT EXISTS "load1"         real;

-- A Raspberry Pi throttles at 80 C while its CPU chart looks perfectly calm.
ALTER TABLE "node_samples" ADD COLUMN IF NOT EXISTS "temp_c"        real;

-- Swapping is the difference between "memory is full" and "memory is full and
-- it hurts".
ALTER TABLE "node_samples" ADD COLUMN IF NOT EXISTS "swap_used_mb"  integer;

-- Whether Docker answered at this instant. Already in every heartbeat and never
-- stored, which is why a node reading "Docker Unavailable" has no start time.
ALTER TABLE "node_samples" ADD COLUMN IF NOT EXISTS "docker_ok"     boolean;

-- Backfill the peak columns for rows already collected. They are the sample
-- itself at fine grain, so min = max = mean is exactly right; for minute rows
-- already folded the peak is genuinely lost and the mean is the best available.
UPDATE "node_samples"
   SET "cpu_max"    = COALESCE("cpu_max", "cpu_pct"),
       "cpu_min"    = COALESCE("cpu_min", "cpu_pct"),
       "ram_max_mb" = COALESCE("ram_max_mb", "ram_used_mb")
 WHERE "cpu_max" IS NULL OR "cpu_min" IS NULL OR "ram_max_mb" IS NULL;
