import { MigrationInterface, QueryRunner } from "typeorm";

export class AddContractEventIndexers1732000000000 implements MigrationInterface {
  name = "AddContractEventIndexers1732000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // #676 sector benchmarks
    await queryRunner.query(`
      CREATE TABLE "sector_benchmarks" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "sector" character varying(64) NOT NULL,
        "avg_yield" decimal(5,2) NOT NULL DEFAULT 0,
        "avg_days_to_settle" decimal(8,2) NOT NULL DEFAULT 0,
        "default_rate" decimal(5,2) NOT NULL DEFAULT 0,
        "sample_count" integer NOT NULL DEFAULT 0,
        "last_event_id" character varying(128),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sector_benchmarks" PRIMARY KEY ("id")
      );
      CREATE UNIQUE INDEX "idx_sector_benchmarks_sector" ON "sector_benchmarks" ("sector");
    `);

    // #677 referral tiers
    await queryRunner.query(`
      CREATE TYPE "public"."referral_tiers_tier_enum" AS ENUM('standard', 'bronze', 'silver', 'gold');

      CREATE TABLE "referral_tiers" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "wallet" character varying(56) NOT NULL,
        "tier" "public"."referral_tiers_tier_enum" NOT NULL DEFAULT 'standard',
        "commission_rate_bps" integer NOT NULL DEFAULT 0,
        "cumulative_referred_volume" decimal(18,4) NOT NULL DEFAULT 0,
        "last_event_id" character varying(128),
        "upgraded_at" TIMESTAMPTZ,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_referral_tiers" PRIMARY KEY ("id")
      );
      CREATE UNIQUE INDEX "idx_referral_tiers_wallet" ON "referral_tiers" ("wallet");

      CREATE TABLE "referral_tier_history" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "wallet" character varying(56) NOT NULL,
        "tier" "public"."referral_tiers_tier_enum" NOT NULL,
        "commission_rate_bps" integer NOT NULL DEFAULT 0,
        "cumulative_referred_volume" decimal(18,4) NOT NULL DEFAULT 0,
        "last_event_id" character varying(128),
        "upgraded_at" TIMESTAMPTZ,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_referral_tier_history" PRIMARY KEY ("id")
      );
      CREATE INDEX "idx_referral_tier_history_wallet" ON "referral_tier_history" ("wallet");
    `);

    // #678 yield boosts
    await queryRunner.query(`
      CREATE TYPE "public"."yield_boosts_tier_enum" AS ENUM('bronze', 'silver', 'gold', 'platinum');

      CREATE TABLE "yield_boosts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "invoice_id" uuid NOT NULL,
        "wallet" character varying(56) NOT NULL,
        "tier" "public"."yield_boosts_tier_enum" NOT NULL,
        "boost_bps" integer NOT NULL DEFAULT 0,
        "last_event_id" character varying(128),
        "applied_at" TIMESTAMPTZ,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_yield_boosts" PRIMARY KEY ("id"),
        CONSTRAINT "uq_yield_boosts_invoice_wallet" UNIQUE ("invoice_id", "wallet")
      );
      CREATE INDEX "idx_yield_boosts_invoice_id" ON "yield_boosts" ("invoice_id");
      CREATE INDEX "idx_yield_boosts_wallet" ON "yield_boosts" ("wallet");
    `);

    // #679 secondary market auctions + bids
    await queryRunner.query(`
      CREATE TYPE "public"."secondary_auctions_status_enum" AS ENUM('active', 'settled', 'cancelled');

      CREATE TABLE "secondary_auctions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "auction_id" character varying(64) NOT NULL,
        "seller" character varying(56) NOT NULL,
        "invoice_id" uuid,
        "status" "public"."secondary_auctions_status_enum" NOT NULL DEFAULT 'active',
        "highest_bid" decimal(18,4) NOT NULL DEFAULT 0,
        "highest_bidder" character varying(56),
        "reserve_price" decimal(18,4) NOT NULL DEFAULT 0,
        "bid_count" integer NOT NULL DEFAULT 0,
        "starts_at" TIMESTAMPTZ,
        "ends_at" TIMESTAMPTZ,
        "settled_at" TIMESTAMPTZ,
        "winner" character varying(56),
        "settlement_amount" decimal(18,4),
        "created_event_id" character varying(128),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_secondary_auctions" PRIMARY KEY ("id")
      );
      CREATE UNIQUE INDEX "idx_secondary_auctions_auction_id" ON "secondary_auctions" ("auction_id");
      CREATE INDEX "idx_secondary_auctions_seller" ON "secondary_auctions" ("seller");
      CREATE INDEX "idx_secondary_auctions_invoice_id" ON "secondary_auctions" ("invoice_id");
      CREATE INDEX "idx_secondary_auctions_status" ON "secondary_auctions" ("status");
      CREATE INDEX "idx_secondary_auctions_ends_at" ON "secondary_auctions" ("ends_at");

      CREATE TABLE "secondary_bids" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "auction_id" character varying(64) NOT NULL,
        "bidder" character varying(56) NOT NULL,
        "amount" decimal(18,4) NOT NULL,
        "event_id" character varying(128),
        "placed_at" TIMESTAMPTZ,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_secondary_bids" PRIMARY KEY ("id")
      );
      CREATE INDEX "idx_secondary_bids_auction_id" ON "secondary_bids" ("auction_id");
      CREATE INDEX "idx_secondary_bids_bidder" ON "secondary_bids" ("bidder");
      CREATE UNIQUE INDEX "idx_secondary_bids_event_id" ON "secondary_bids" ("event_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "secondary_bids"`);
    await queryRunner.query(`DROP TABLE "secondary_auctions"`);
    await queryRunner.query(`DROP TYPE "public"."secondary_auctions_status_enum"`);
    await queryRunner.query(`DROP TABLE "yield_boosts"`);
    await queryRunner.query(`DROP TYPE "public"."yield_boosts_tier_enum"`);
    await queryRunner.query(`DROP TABLE "referral_tier_history"`);
    await queryRunner.query(`DROP TABLE "referral_tiers"`);
    await queryRunner.query(`DROP TYPE "public"."referral_tiers_tier_enum"`);
    await queryRunner.query(`DROP TABLE "sector_benchmarks"`);
  }
}
