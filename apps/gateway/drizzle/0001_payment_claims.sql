CREATE TABLE "payment_claims" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "payment_claims_swept_idx" ON "payment_claims" USING btree ("claimed_at");--> statement-breakpoint
CREATE INDEX "payment_claims_order_idx" ON "payment_claims" USING btree ("order_id");