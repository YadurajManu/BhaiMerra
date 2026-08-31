-- What a stateful service actually needs.
--
-- volume_path: every volume mounted at /data, which for Postgres means the
-- volume is attached and unused — the appearance of persistence without any.
-- The image decides where its data lives, so the manifest has to be able to say.
--
-- health_*: `health: { path, timeout, interval }` has been in the spec since the
-- beginning. Only `path` was ever stored, and even that was never applied to a
-- container. Storing the timings is the half that needed a column.

ALTER TABLE "services" ADD COLUMN "volume_path" text;
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "health_interval_sec" integer DEFAULT 15 NOT NULL;
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "health_timeout_sec" integer DEFAULT 5 NOT NULL;
--> statement-breakpoint
-- Not every image carries a shell probe. A distroless or scratch container has
-- no wget and no curl, and a health check it can never pass would hold the
-- rollout open forever, so opting out has to be a first-class answer.
ALTER TABLE "services" ADD COLUMN "health_disabled" boolean DEFAULT false NOT NULL;
