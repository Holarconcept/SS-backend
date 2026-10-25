import { MigrationInterface, QueryRunner } from "typeorm";

export class AddInvestorOnboardingAlertAndYieldData1732200000000
  implements MigrationInterface
{
  name = "AddInvestorOnboardingAlertAndYieldData1732200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "soroban_indexer_checkpoints" (
        "indexer_id" character varying(512) NOT NULL,
        "ledger_sequence" bigint NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_soroban_indexer_checkpoints" PRIMARY KEY ("indexer_id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "soroban_event_logs"
      ADD COLUMN "event_id" character varying(128)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "idx_soroban_event_logs_event_id"
      ON "soroban_event_logs" ("event_id")
      WHERE "event_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "onboarding_bonuses" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "wallet" character varying(56) NOT NULL,
        "bonus_amount" numeric(20,7) NOT NULL,
        "invoice_id" character varying(64),
        "claimed_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "event_id" character varying(128),
        CONSTRAINT "PK_onboarding_bonuses" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_onboarding_bonuses_wallet" UNIQUE ("wallet"),
        CONSTRAINT "UQ_onboarding_bonuses_event_id" UNIQUE ("event_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_onboarding_bonuses_wallet"
      ON "onboarding_bonuses" ("wallet")
    `);

    await queryRunner.query(`
      CREATE TABLE "alert_preferences" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "wallet" character varying(56) NOT NULL,
        "settlement_enabled" boolean NOT NULL DEFAULT true,
        "kyc_expiry_enabled" boolean NOT NULL DEFAULT true,
        "watchlist_change_enabled" boolean NOT NULL DEFAULT true,
        "auto_invest_enabled" boolean NOT NULL DEFAULT true,
        "maturity_enabled" boolean NOT NULL DEFAULT true,
        "event_id" character varying(128),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_alert_preferences" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_alert_preferences_wallet" UNIQUE ("wallet")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_alert_preferences_wallet"
      ON "alert_preferences" ("wallet")
    `);

    await queryRunner.query(`
      CREATE TABLE "yield_adjustments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "invoice_id" character varying(64) NOT NULL,
        "settlement_event_id" character varying(128) NOT NULL,
        "adjustment_bps" integer NOT NULL DEFAULT 0,
        "basis_rating" numeric(12,4),
        "adjusted_yield" numeric(12,6),
        "settled_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "transaction_hash" character varying(128) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_yield_adjustments" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_yield_adjustments_settlement_event_id" UNIQUE ("settlement_event_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "idx_yield_adjustments_invoice_settled"
      ON "yield_adjustments" ("invoice_id", "settled_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "yield_adjustments"`);
    await queryRunner.query(`DROP TABLE "alert_preferences"`);
    await queryRunner.query(`DROP TABLE "onboarding_bonuses"`);
    await queryRunner.query(`DROP INDEX "idx_soroban_event_logs_event_id"`);
    await queryRunner.query(`ALTER TABLE "soroban_event_logs" DROP COLUMN "event_id"`);
    await queryRunner.query(`DROP TABLE "soroban_indexer_checkpoints"`);
  }
}
