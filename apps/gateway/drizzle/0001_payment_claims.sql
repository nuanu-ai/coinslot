CREATE TABLE "payment_claims" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL
);
