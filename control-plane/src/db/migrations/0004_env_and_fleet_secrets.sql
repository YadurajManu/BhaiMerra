-- Configuration that actually reaches the container.
--
-- `env` and `secret_refs` carry the manifest's `env:` and `secrets:` blocks,
-- both of which were parsed and then discarded. `secrets` moves from
-- service-scoped to fleet-scoped with a per-service override, because the same
-- credential is normally needed by more than one service in a stack.

ALTER TABLE "services" ADD COLUMN "env" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "secret_refs" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "fleet_id" uuid;
--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
-- Backfill from the owning service. Nothing writes to this table today, so in
-- practice there is nothing to move — but a migration that would silently lose
-- rows if there were is not one worth shipping.
UPDATE "secrets" s
   SET "fleet_id" = sv."fleet_id"
  FROM "services" sv
 WHERE sv."id" = s."service_id"
   AND s."fleet_id" IS NULL;
--> statement-breakpoint
-- Any row whose service has already been deleted has no fleet to belong to.
DELETE FROM "secrets" WHERE "fleet_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "secrets" ALTER COLUMN "fleet_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "secrets" ALTER COLUMN "service_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_fleet_id_fleets_id_fk" FOREIGN KEY ("fleet_id") REFERENCES "public"."fleets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DROP INDEX IF EXISTS "secrets_service_key_key";
--> statement-breakpoint
-- Two partial uniques rather than one plain one: every fleet-wide row has a
-- null service_id, and nulls never collide, so a unique on (service_id, key)
-- would let the same fleet-wide key be inserted any number of times.
CREATE UNIQUE INDEX "secrets_fleet_key_key" ON "secrets" USING btree ("fleet_id","key") WHERE "service_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_service_key_key" ON "secrets" USING btree ("service_id","key") WHERE "service_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "secrets_fleet_idx" ON "secrets" USING btree ("fleet_id");
