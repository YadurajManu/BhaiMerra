-- Deleting an account, with a way back.
--
-- Deletion here is genuinely destructive: an org cascades to its fleets, and a
-- fleet cascades to its nodes, services, deployments, secrets and backups.
-- There is no undo once it runs, so the flow is deliberately slow - confirm by
-- email, then a grace period during which the account still works normally and
-- one click calls it off.
--
-- The grace period is not politeness. It is the difference between a
-- compromised session being an inconvenience and it being the end of somebody's
-- infrastructure, because an attacker who reaches "delete" still has to wait
-- out a window in which the real owner gets told and can cancel.

ALTER TABLE "users" ADD COLUMN "deletion_scheduled_for" timestamptz;
ALTER TABLE "users" ADD COLUMN "deletion_requested_at" timestamptz;

-- The sweeper asks "what is due" on a schedule, so index the due date and skip
-- the overwhelming majority of rows where it is null.
CREATE INDEX IF NOT EXISTS "users_deletion_due_idx"
  ON "users" ("deletion_scheduled_for") WHERE "deletion_scheduled_for" IS NOT NULL;
