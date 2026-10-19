import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from "typeorm";
import { LoyaltyTier } from "../types/enums";

/**
 * Yield boost applied to an invoice for a specific wallet (#678), indexed
 * from YieldBoostApplied events. One row per (invoice, wallet) pair; a later
 * event for the same pair supersedes the previous boost.
 */
@Entity("yield_boosts")
@Unique("uq_yield_boosts_invoice_wallet", ["invoiceId", "wallet"])
export class YieldBoost {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  @Index("idx_yield_boosts_invoice_id")
  invoiceId!: string;

  @Column({ type: "varchar", length: 56 })
  @Index("idx_yield_boosts_wallet")
  wallet!: string;

  @Column({ type: "enum", enum: LoyaltyTier })
  tier!: LoyaltyTier;

  /** Boost in basis points added to the invoice's base yield. */
  @Column({ name: "boost_bps", type: "integer", default: 0 })
  boostBps!: number;

  @Column({ name: "last_event_id", type: "varchar", length: 128, nullable: true })
  lastEventId!: string | null;

  @Column({ name: "applied_at", type: "timestamptz", nullable: true })
  appliedAt!: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
