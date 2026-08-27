CREATE TABLE "cabinet_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cabinet_accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "cabinet_sessions" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cabinet_sessions" ADD CONSTRAINT "cabinet_sessions_account_id_cabinet_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."cabinet_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cabinet_sessions_expires_idx" ON "cabinet_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "cabinet_sessions_account_idx" ON "cabinet_sessions" USING btree ("account_id");