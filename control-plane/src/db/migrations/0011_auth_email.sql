-- Password reset and email verification.
--
-- Until now a forgotten password was unrecoverable: there was no reset path,
-- so the only fix was editing password_hash in this database by hand. That is
-- workable for one operator and disqualifying for anyone else.

ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamptz;

-- Existing accounts predate verification. Treat them as verified rather than
-- locking out the operator who has been using the system all along; the flag
-- exists to gate new signups, not to retroactively invalidate old ones.
UPDATE "users" SET "email_verified_at" = "created_at" WHERE "email_verified_at" IS NULL;

CREATE TABLE IF NOT EXISTS "auth_tokens" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  -- sha256 of the token, never the token. The plaintext exists only in the
  -- email that carried it, so a dump of this table is not a set of working
  -- reset links.
  "token_hash" text NOT NULL,
  "purpose"    text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at"    timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "auth_tokens_hash_key" ON "auth_tokens" ("token_hash");

-- Lookup path for "invalidate every outstanding token for this user", which is
-- what has to happen the moment one of them is successfully redeemed.
CREATE INDEX IF NOT EXISTS "auth_tokens_user_purpose_idx"
  ON "auth_tokens" ("user_id", "purpose") WHERE "used_at" IS NULL;
