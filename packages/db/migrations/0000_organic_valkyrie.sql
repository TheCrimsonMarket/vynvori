CREATE SCHEMA "vynvori_infrastructure";
--> statement-breakpoint
CREATE TABLE "vynvori_infrastructure"."synthetic_probes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"fixture" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synthetic_only" CHECK ("vynvori_infrastructure"."synthetic_probes"."fixture" = 'm2-synthetic-v1')
);
