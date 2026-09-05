-- What a service has actually been seen using, against what it reserved.
--
-- Every service `fleet init` generates reserves 512Mi, because 512Mi is a round
-- number. Measured on this fleet: a steady 60MB and 20MB against that. The
-- scheduler plans capacity around the reservation for the life of the service,
-- so the gap is invisible on one node and is the difference between fitting and
-- `no_eligible_node` on a fleet where it matters.
--
-- The peak, not the average: a reservation below the peak is an OOM kill, and a
-- spike that raises this errs in the safe direction. A running maximum rather
-- than a samples table, because the question is "what does this need" and that
-- is one number, not a row per service per five seconds for ever.
ALTER TABLE services ADD COLUMN IF NOT EXISTS observed_ram_peak_mb integer;
ALTER TABLE services ADD COLUMN IF NOT EXISTS observed_ram_since timestamp with time zone;
