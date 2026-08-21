ALTER TABLE "deployments" ADD COLUMN "host_port" integer;--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "advertise_addr" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "container_port" integer DEFAULT 8080 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "hostname" text;--> statement-breakpoint
CREATE INDEX "deployments_live_idx" ON "deployments" USING btree ("status","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_hostname_key" ON "services" USING btree ("hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "services_domain_key" ON "services" USING btree ("domain");