-- Explanations for failed deploys, cached by what makes a failure that failure.
--
-- Keyed on the signature rather than the deployment: the same broken lockfile
-- produces the same answer for every user forever, and paying per deploy for
-- an answer that never changes is the whole thing this table exists to avoid.
-- Rows are shared across fleets deliberately - a missing base image is not
-- anybody's private information, and the log it came from is not stored here.
CREATE TABLE IF NOT EXISTS deployment_explanations (
  signature    text PRIMARY KEY,
  summary      text NOT NULL,
  steps        jsonb NOT NULL DEFAULT '[]'::jsonb,
  model        text NOT NULL,
  tokens_in    integer NOT NULL DEFAULT 0,
  tokens_out   integer NOT NULL DEFAULT 0,
  -- How often this failure has been seen. Worth showing a reader: "four other
  -- deploys hit this" is the difference between a mysterious error and a
  -- known one.
  hits         integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Per fleet, because the key and the bill belong to whoever owns the fleet.
-- Off unless someone turns it on: a product whose pitch is "your own hardware"
-- does not post build logs to a third party by default.
ALTER TABLE fleets ADD COLUMN IF NOT EXISTS ai_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE fleets ADD COLUMN IF NOT EXISTS ai_base_url text;
ALTER TABLE fleets ADD COLUMN IF NOT EXISTS ai_model text NOT NULL DEFAULT 'claude-sonnet-4-8';
-- The key itself lives in the secrets store, encrypted with SECRETS_MASTER_KEY.
-- This column holds only the name it is filed under.
ALTER TABLE fleets ADD COLUMN IF NOT EXISTS ai_key_ref text;
