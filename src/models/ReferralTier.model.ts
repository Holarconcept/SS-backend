import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";
import { ReferralTierLevel } from "../types/enums";

/**
 * Current referral tier snapshot per wallet (#677). Refreshed from
 * ReferralTierUpgraded events. Wallets with no row get Standard defaults
 * at read time rather than being seeded here.
 */
@Entity("referral_tiers")
export class ReferralTier {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 56 })
  @Index("idx_referral_tiers_wallet", { unique: true })
  wallet!: string;

  @Column({ type: "enum", enum: ReferralTierLevel, default: ReferralTierLevel.STANDARD })
  tier!: ReferralTierLevel;

  @Column({ name: "commission_rate_bps", type: "integer", default: 0 })
  commissionRateBps!: number;

  @Column({ name: "cumulative_referred_volume", type: "decimal", precision: 18, scale: 4, default: 0 })
  cumulativeReferredVolume!: string;

  @Column({ name: "last_event_id", type: "varchar", length: 128, nullable: true })
  lastEventId!: string | null;

  @Column({ name: "upgraded_at", type: "timestamptz", nullable: true })
  upgradedAt!: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
