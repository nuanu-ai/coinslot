CREATE TABLE "cabinet_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"issuer" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cabinet_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "cabinet_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "cabinet_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cabinet_accounts" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cabinet_accounts" ADD COLUMN "name" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Added in three steps rather than one, and the three are not interchangeable.
-- A NOT NULL column with no default cannot be added to a table that already has
-- a row in it, and this table has one: the account on the deployed server. The
-- generated single statement would stop here with the cabinet's tables half
-- moved. So the column arrives empty, every row already there is given the
-- moment it was made, and only then is the column held to being filled in.
ALTER TABLE "cabinet_accounts" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
UPDATE "cabinet_accounts" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;--> statement-breakpoint
ALTER TABLE "cabinet_accounts" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cabinet_credentials" ADD CONSTRAINT "cabinet_credentials_user_id_cabinet_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."cabinet_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cabinet_sessions" ADD CONSTRAINT "cabinet_sessions_user_id_cabinet_accounts_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."cabinet_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cabinet_credentials_account_idx" ON "cabinet_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cabinet_sessions_account_idx" ON "cabinet_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cabinet_sessions_expires_idx" ON "cabinet_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "cabinet_verifications_identifier_idx" ON "cabinet_verifications" USING btree ("identifier");