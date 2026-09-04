-- Explaining failures is configured by whoever runs the control plane, not per
-- fleet.
--
-- The first shape asked each fleet for a base URL, a model and a provider key.
-- That is the wrong person to ask: someone whose build just failed should not
-- have to go and find an API provider before they can be told why. The
-- operator holds one key, pays for the calls, and the per-person daily limit
-- is what bounds the cost.
ALTER TABLE fleets DROP COLUMN IF EXISTS ai_enabled;
ALTER TABLE fleets DROP COLUMN IF EXISTS ai_base_url;
ALTER TABLE fleets DROP COLUMN IF EXISTS ai_model;
ALTER TABLE fleets DROP COLUMN IF EXISTS ai_key_ref;
