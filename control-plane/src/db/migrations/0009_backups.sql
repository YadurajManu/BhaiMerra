-- Volumes are the one thing Fleet cannot replace.
--
-- Everything else here is derived: an image rebuilds from a commit, a
-- container recreates from a manifest, a route recomputes from a placement. A
-- volume is the exception — it exists on exactly one disk in one machine, and
-- until now there was no way to copy it anywhere. A homelab can live with that.
-- An agency running a client's database on a laptop cannot.
--
-- A `backups` table has existed since the first migration and was never
-- written to: volume_ref, storage_location, a size, a retention date. It
-- described an artifact and had no room for the thing that actually needs
-- recording — the attempt. A backup is a job before it is a file: the row is
-- created when one is asked for, the node holding the volume performs it, and
-- the archive arrives afterwards. Attempts that failed stay in the table,
-- because "the last three backups failed" is the half people need when they
-- come looking.
--
-- Altered rather than replaced, and every existing column is kept, so a
-- deployment that somehow does have rows loses nothing.

CREATE TYPE "public"."backup_status" AS ENUM('pending', 'running', 'complete', 'failed');
--> statement-breakpoint

-- The node that holds the volume. Kept when that node is removed: a backup
-- from a machine that no longer exists is exactly when its origin matters.
ALTER TABLE "backups" ADD COLUMN "node_id" uuid REFERENCES "nodes"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "status" "backup_status" DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
-- sha256 of the archive, so a restore can prove it got what was stored.
ALTER TABLE "backups" ADD COLUMN "checksum" text;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "failure_reason" text;
--> statement-breakpoint
-- Distinguishes a backup somebody asked for from one the schedule made.
ALTER TABLE "backups" ADD COLUMN "scheduled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "finished_at" timestamp with time zone;
--> statement-breakpoint

-- storage_location was NOT NULL, which cannot hold for a job that has not run
-- yet — the path is not known until the archive lands.
ALTER TABLE "backups" ALTER COLUMN "storage_location" DROP NOT NULL;
--> statement-breakpoint
-- A tar of a database volume passes 2GB without trying.
ALTER TABLE "backups" ALTER COLUMN "size_bytes" TYPE bigint;
--> statement-breakpoint

CREATE INDEX "backups_service_idx" ON "backups" USING btree ("service_id","created_at" DESC);
--> statement-breakpoint
-- The agent's query: anything pending for my node.
CREATE INDEX "backups_pending_idx" ON "backups" USING btree ("node_id","status");
--> statement-breakpoint

-- How often to back a service up without being asked. Null means never, which
-- is what every existing service means today.
ALTER TABLE "services" ADD COLUMN "backup_schedule" text;
