CREATE TABLE "merchants" (
	"id" text PRIMARY KEY NOT NULL,
	"selling" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;