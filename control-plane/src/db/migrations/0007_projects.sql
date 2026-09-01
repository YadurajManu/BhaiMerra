-- A manifest is a project.
--
-- fleet.yaml describes a stack, and the moment it was applied that structure
-- was lost: four related services became four unrelated rows in one flat list,
-- indistinguishable from a service applied from some other manifest entirely.
-- Docker Compose groups by project name and GitHub groups by repository;
-- Fleet grouped by nothing.
--
-- It also makes the orphan warning mean what it always claimed. "X is no
-- longer in fleet.yaml" was computed across the whole fleet, so applying one
-- manifest warned about every service belonging to another.

ALTER TABLE "services" ADD COLUMN "project" text DEFAULT 'default' NOT NULL;
--> statement-breakpoint
-- Services applied before projects existed all came from somewhere; there is
-- no record of where, so they land in 'default' together and can be moved by
-- re-applying their manifest with a project name.
CREATE INDEX "services_fleet_project_idx" ON "services" USING btree ("fleet_id","project");
