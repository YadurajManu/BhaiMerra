-- An installation belongs to somebody.
--
-- Until now nothing recorded which org installed the GitHub App. Every route
-- read the App's *global* installation list, so any signed-up user could list
-- every account that had ever installed Fleet, browse their private
-- repositories, connect one to a fleet of their own, and have the control
-- plane clone that source with a token minted against the victim's
-- installation. The App was scoped correctly on GitHub's side; Fleet simply
-- never checked whose it was.
--
-- This table is that check. `installation_id` is globally unique on purpose:
-- an installation is claimed once, by the org that completed the install flow,
-- and a second org asking for the same one is refused rather than quietly
-- sharing it.

CREATE TABLE "github_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "installation_id" text NOT NULL,
  "account" text NOT NULL,
  "account_type" text NOT NULL DEFAULT 'User',
  "connected_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  -- GitHub suspends an installation without deleting it; a suspended one must
  -- stop minting tokens but should come back on unsuspend rather than needing
  -- the whole install flow again.
  "suspended_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_installation_key" ON "github_installations" USING btree ("installation_id");
--> statement-breakpoint
CREATE INDEX "github_installations_org_idx" ON "github_installations" USING btree ("org_id");
--> statement-breakpoint
-- Repositories connected before this table existed already prove an org used
-- an installation. Claim each one for whichever org connected it first, so an
-- upgrade does not silently disconnect a working push-deploy setup.
INSERT INTO "github_installations" ("org_id", "installation_id", "account", "account_type", "created_at")
SELECT DISTINCT ON (r."installation_id")
  f."org_id",
  r."installation_id",
  r."account",
  'User',
  r."created_at"
FROM "github_repositories" r
JOIN "fleets" f ON f."id" = r."fleet_id"
WHERE r."installation_id" IS NOT NULL
ORDER BY r."installation_id", r."created_at" ASC
ON CONFLICT DO NOTHING;
