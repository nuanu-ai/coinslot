CREATE TABLE "cards" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_item_id" text NOT NULL,
	"card" jsonb NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	CONSTRAINT "cards_merchant_item_id_unique" UNIQUE("merchant_item_id")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"open" boolean NOT NULL,
	"item_id" text NOT NULL,
	"merchant_item_id" text NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_claims" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"order_id" text PRIMARY KEY NOT NULL,
	"receipt" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "orders_open_idx" ON "orders" USING btree ("open","created_at");