import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * #680, #681, #682, #685 — Create tables for invoice insurance,
 * extension proposals, contract registry, and issuer blacklist.
 */
export class AddInsuranceExtensionRegistryBlacklistTables1732900000000
  implements MigrationInterface
{
  name = "AddInsuranceExtensionRegistryBlacklistTables1732900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // #680 — Invoice insurance
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS invoice_insurance (
        id SERIAL PRIMARY KEY,
        invoice_id VARCHAR NOT NULL,
        wallet VARCHAR NOT NULL,
        is_active BOOLEAN DEFAULT true,
        coverage_bps INTEGER NOT NULL,
        premium_paid DECIMAL NOT NULL,
        expiry BIGINT NOT NULL,
        purchased_at BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(invoice_id, wallet)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS insurance_payouts (
        id SERIAL PRIMARY KEY,
        invoice_id VARCHAR NOT NULL,
        wallet VARCHAR NOT NULL,
        amount DECIMAL NOT NULL,
        trigger_date BIGINT NOT NULL,
        tx_hash VARCHAR NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    // #681 — Extension proposals
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS extension_proposals (
        id VARCHAR PRIMARY KEY,
        invoice_id VARCHAR NOT NULL,
        proposed_by VARCHAR NOT NULL,
        new_deadline BIGINT NOT NULL,
        status VARCHAR DEFAULT 'active',
        votes_for INTEGER DEFAULT 0,
        votes_against INTEGER DEFAULT 0,
        quorum_bps INTEGER DEFAULT 5000,
        eta BIGINT,
        created_at BIGINT NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS extension_votes (
        id SERIAL PRIMARY KEY,
        invoice_id VARCHAR NOT NULL,
        wallet VARCHAR NOT NULL,
        vote VARCHAR NOT NULL,
        weight DECIMAL NOT NULL,
        voted_at BIGINT NOT NULL,
        UNIQUE(invoice_id, wallet)
      )
    `);

    // #682 — Contract registry
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS contract_registry (
        name VARCHAR PRIMARY KEY,
        version VARCHAR NOT NULL,
        address VARCHAR NOT NULL,
        last_upgraded BIGINT NOT NULL,
        registered_at BIGINT NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS contract_version_history (
        id SERIAL PRIMARY KEY,
        contract_name VARCHAR NOT NULL,
        version VARCHAR NOT NULL,
        address VARCHAR NOT NULL,
        upgraded_at BIGINT NOT NULL,
        upgraded_by VARCHAR NOT NULL
      )
    `);

    // #685 — Issuer blacklist
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS issuer_blacklist (
        wallet VARCHAR PRIMARY KEY,
        is_blacklisted BOOLEAN DEFAULT false,
        reason TEXT,
        blacklisted_at BIGINT,
        restored_at BIGINT
      )
    `);

    // Indexes
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_insurance_wallet ON invoice_insurance(wallet)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_insurance_invoice ON invoice_insurance(invoice_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_payouts_wallet ON insurance_payouts(wallet)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_extension_invoice ON extension_proposals(invoice_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_extension_votes_invoice ON extension_votes(invoice_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_contract_history_name ON contract_version_history(contract_name)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS issuer_blacklist`);
    await queryRunner.query(`DROP TABLE IF EXISTS contract_version_history`);
    await queryRunner.query(`DROP TABLE IF EXISTS contract_registry`);
    await queryRunner.query(`DROP TABLE IF EXISTS extension_votes`);
    await queryRunner.query(`DROP TABLE IF EXISTS extension_proposals`);
    await queryRunner.query(`DROP TABLE IF EXISTS insurance_payouts`);
    await queryRunner.query(`DROP TABLE IF EXISTS invoice_insurance`);
  }
}
