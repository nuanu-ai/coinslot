-- Every merchant is a row, and every card, order and receipt names one
-- (ADR-0010).
--
-- Hand-written rather than left as drizzle-kit generated it, because the
-- generated form adds three NOT NULL columns with no default and Postgres
-- refuses that on a table with rows in it. What is here does the same work in
-- the order a database that has been selling can survive: add the column empty,
-- fill it, then hold it to NOT NULL.
--
-- Everything already in any database belongs to one merchant. That is not an
-- assumption — until this migration there was nowhere for a second merchant's
-- rows to come from, since the store named its one merchant in a constant and
-- the gateway held one key in its environment. So the backfill assigns every
-- card, order and receipt to that merchant, written down here under a fixed
-- identifier so that the process seeding the sandbox's key can find the same
-- row without being told.

CREATE TABLE "merchant_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"label" text NOT NULL,
	"digest" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "merchant_keys_digest_unique" UNIQUE("digest")
);
--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "created_at" timestamp with time zone;--> statement-breakpoint
-- A merchant row exists only where somebody pressed the selling switch, so a
-- database that has been selling happily may have none at all. Either way the
-- row that carries the selling word keeps it: the name and the creation time
-- are filled in around it, and nothing here puts a merchant who had paused back
-- on sale.
UPDATE "merchants" SET "name" = coalesce("name", "id"), "created_at" = coalesce("created_at", "updated_at");--> statement-breakpoint
INSERT INTO "merchants" ("id", "name", "selling", "created_at", "updated_at")
VALUES ('the_merchant', 'The pilot merchant', 'open', now(), now())
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cards" ADD COLUMN "merchant_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "merchant_id" text;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "merchant_id" text;--> statement-breakpoint
UPDATE "cards" SET "merchant_id" = 'the_merchant' WHERE "merchant_id" IS NULL;--> statement-breakpoint
UPDATE "orders" SET "merchant_id" = 'the_merchant' WHERE "merchant_id" IS NULL;--> statement-breakpoint
UPDATE "receipts" SET "merchant_id" = 'the_merchant' WHERE "merchant_id" IS NULL;--> statement-breakpoint
-- The order document carries the merchant as well as the column does, and both
-- are read: the column is what a merchant's list of their own orders filters
-- on, and the document is what tells the interpreter whose stream a redelivery
-- of this order goes on. An order left with a column and no field in its
-- document would be one whose next envelope reached nobody.
UPDATE "orders" SET "record" = jsonb_set("record", '{merchantId}', to_jsonb("merchant_id"));--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "merchant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "merchant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ALTER COLUMN "merchant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_keys" ADD CONSTRAINT "merchant_keys_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_keys_merchant_idx" ON "merchant_keys" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "cards_merchant_idx" ON "cards" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "receipts_merchant_idx" ON "receipts" USING btree ("merchant_id","updated_at");--> statement-breakpoint
DROP INDEX "orders_open_idx";--> statement-breakpoint
-- A merchant lists their own orders, the open ones first among them, so the
-- merchant leads the index. On the old one every merchant's list would have
-- walked every merchant's orders.
CREATE INDEX "orders_open_idx" ON "orders" USING btree ("merchant_id","open","created_at");--> statement-breakpoint
-- A merchant's own identifier for a product is unique inside their catalog and
-- nowhere else, which is what the card contract has always said it means. Held
-- unique across the gateway, the second merchant to publish a "sku-1" would
-- edit the first merchant's card instead of publishing their own.
ALTER TABLE "cards" DROP CONSTRAINT "cards_merchant_item_id_unique";--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_merchant_item_unique" UNIQUE("merchant_id","merchant_item_id");
