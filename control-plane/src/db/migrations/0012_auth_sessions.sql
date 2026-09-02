-- Remembered sign-ins, so a new one can be recognised as new.
--
-- Without any memory of previous logins every sign-in looks unfamiliar, and an
-- alert that fires every time is one people learn to delete unread. That is
-- worse than sending nothing: it trains the recipient to ignore the one that
-- matters.

CREATE TABLE IF NOT EXISTS "auth_sessions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- Coarse on purpose: browser family and OS family only, no versions. A
  -- Chrome minor bump must not read as a new device and raise an alarm.
  "device_hash" text NOT NULL,
  "user_agent"  text,
  "ip"          text,
  -- Two-letter country from the edge. A different country is a real signal;
  -- a different IP inside the same country usually just means mobile data.
  "country"     text,
  "first_seen"  timestamptz NOT NULL DEFAULT now(),
  "last_seen"   timestamptz NOT NULL DEFAULT now(),
  "login_count" integer NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_user_device_key"
  ON "auth_sessions" ("user_id", "device_hash");

CREATE INDEX IF NOT EXISTS "auth_sessions_user_seen_idx"
  ON "auth_sessions" ("user_id", "last_seen" DESC);
