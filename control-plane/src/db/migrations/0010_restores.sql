-- Putting a backup back.
--
-- A backup nobody has ever restored is a belief, not a safety net. Taking
-- copies was half the feature; this is the half that makes the copies mean
-- something.
--
-- A restore is its own job rather than a field on the backup, because the same
-- archive can legitimately be restored more than once — onto a rebuilt node,
-- into a fresh volume, twice in an afternoon while something is being
-- debugged. Recording it on the backup row would keep only the last attempt
-- and quietly lose the history that matters most when a restore goes wrong.

CREATE TYPE "public"."restore_status" AS ENUM('pending', 'running', 'complete', 'failed');
--> statement-breakpoint

CREATE TABLE "restores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "backup_id" uuid NOT NULL REFERENCES "backups"("id") ON DELETE CASCADE,
  "service_id" uuid NOT NULL REFERENCES "services"("id") ON DELETE CASCADE,
  -- The node that will receive the data. Not necessarily the one the backup
  -- came from: restoring onto a replacement machine is the case this exists for.
  "node_id" uuid REFERENCES "nodes"("id") ON DELETE SET NULL,
  "volume_name" text NOT NULL,
  "status" "restore_status" NOT NULL DEFAULT 'pending',
  "failure_reason" text,
  "requested_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint

CREATE INDEX "restores_service_idx" ON "restores" USING btree ("service_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "restores_pending_idx" ON "restores" USING btree ("node_id","status");
