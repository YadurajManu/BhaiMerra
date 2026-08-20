CREATE TYPE "public"."alert_channel" AS ENUM('webhook', 'email', 'discord', 'slack', 'push');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('queued', 'building', 'pushing', 'scheduling', 'deploying', 'running', 'failed', 'rolled_back', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."node_status" AS ENUM('online', 'offline', 'cordoned', 'draining');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'admin', 'deployer', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."placement_policy" AS ENUM('pinned', 'preferred', 'flexible');--> statement-breakpoint
CREATE TYPE "public"."placement_reason" AS ENUM('initial', 'manual', 'failover', 'reclaim', 'drain', 'redeploy');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('free', 'fleet', 'self_hosted');--> statement-breakpoint
CREATE TYPE "public"."reclaim_policy" AS ENUM('eager', 'idle', 'manual');--> statement-breakpoint
CREATE TYPE "public"."reliability_tier" AS ENUM('opportunistic', 'standard', 'high');--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fleet_id" uuid NOT NULL,
	"channel_type" "alert_channel" NOT NULL,
	"channel_config" jsonb NOT NULL,
	"event_types" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_kind" text DEFAULT 'user' NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"volume_ref" text NOT NULL,
	"storage_location" text NOT NULL,
	"size_bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retention_expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"git_sha" text,
	"status" "deployment_status" DEFAULT 'queued' NOT NULL,
	"node_id" uuid,
	"image_tags" text[] DEFAULT '{}' NOT NULL,
	"failure_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "fleets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"default_reclaim_policy" "reclaim_policy" DEFAULT 'idle' NOT NULL,
	"heartbeat_interval_sec" integer DEFAULT 5 NOT NULL,
	"heartbeat_miss_threshold" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fleet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"arch" text NOT NULL,
	"os" text DEFAULT 'linux' NOT NULL,
	"cpu_cores" integer NOT NULL,
	"ram_mb" integer NOT NULL,
	"disk_mb" integer NOT NULL,
	"has_gpu" boolean DEFAULT false NOT NULL,
	"connectivity" text DEFAULT 'nat' NOT NULL,
	"reliability_tier" "reliability_tier" DEFAULT 'standard' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"status" "node_status" DEFAULT 'offline' NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"mesh_pubkey" text,
	"agent_token_hash" text NOT NULL,
	"agent_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "org_role" DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pairing_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fleet_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"issued_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_node_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "placement_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"from_node_id" uuid,
	"to_node_id" uuid,
	"reason" "placement_reason" NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"key" text NOT NULL,
	"encrypted_value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fleet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"repo_url" text,
	"build_context" text,
	"image" text,
	"placement_policy" "placement_policy" DEFAULT 'flexible' NOT NULL,
	"pinned_node_id" uuid,
	"request_ram_mb" integer DEFAULT 256 NOT NULL,
	"request_cpu" text DEFAULT '0.25' NOT NULL,
	"requires_gpu" boolean DEFAULT false NOT NULL,
	"min_reliability_tier" "reliability_tier" DEFAULT 'opportunistic' NOT NULL,
	"compatible_arches" text[] DEFAULT '{}' NOT NULL,
	"affinity" text[] DEFAULT '{}' NOT NULL,
	"anti_affinity" text[] DEFAULT '{}' NOT NULL,
	"persistent_volume" boolean DEFAULT false NOT NULL,
	"volume_name" text,
	"replicas" integer DEFAULT 1 NOT NULL,
	"health_check_path" text DEFAULT '/',
	"domain" text,
	"reclaim_policy" "reclaim_policy",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_fleet_id_fleets_id_fk" FOREIGN KEY ("fleet_id") REFERENCES "public"."fleets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fleets" ADD CONSTRAINT "fleets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_fleet_id_fleets_id_fk" FOREIGN KEY ("fleet_id") REFERENCES "public"."fleets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_tokens" ADD CONSTRAINT "pairing_tokens_fleet_id_fleets_id_fk" FOREIGN KEY ("fleet_id") REFERENCES "public"."fleets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_tokens" ADD CONSTRAINT "pairing_tokens_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_events" ADD CONSTRAINT "placement_events_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_events" ADD CONSTRAINT "placement_events_from_node_id_nodes_id_fk" FOREIGN KEY ("from_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_events" ADD CONSTRAINT "placement_events_to_node_id_nodes_id_fk" FOREIGN KEY ("to_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_fleet_id_fleets_id_fk" FOREIGN KEY ("fleet_id") REFERENCES "public"."fleets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_pinned_node_id_nodes_id_fk" FOREIGN KEY ("pinned_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_org_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "deployments_service_idx" ON "deployments" USING btree ("service_id","started_at");--> statement-breakpoint
CREATE INDEX "deployments_node_idx" ON "deployments" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fleets_org_name_key" ON "fleets" USING btree ("org_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_fleet_name_key" ON "nodes" USING btree ("fleet_id","name");--> statement-breakpoint
CREATE INDEX "nodes_fleet_status_idx" ON "nodes" USING btree ("fleet_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_pk" ON "org_members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "org_members_user_idx" ON "org_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_tokens_hash_key" ON "pairing_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "placement_events_service_idx" ON "placement_events" USING btree ("service_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_service_key_key" ON "secrets" USING btree ("service_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "services_fleet_name_key" ON "services" USING btree ("fleet_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");