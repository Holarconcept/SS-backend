import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSettlementIntents1754000000000 implements MigrationInterface {
  name = "CreateSettlementIntents1754000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "settlement_intents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "invoice_id" uuid NOT NULL,
        "status" varchar(20) NOT NULL,
        "payload" text NOT NULL,
        "transaction_hash" varchar(64),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_settlement_intents_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_settlement_intents_invoice_id" FOREIGN KEY ("invoice_id")
          REFERENCES "invoices"("id") ON DELETE CASCADE
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_settlement_intents_invoice_id"
      ON "settlement_intents" ("invoice_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_settlement_intents_status"
      ON "settlement_intents" ("status");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_settlement_intents_status";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_settlement_intents_invoice_id";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "settlement_intents";`);
  }
}
