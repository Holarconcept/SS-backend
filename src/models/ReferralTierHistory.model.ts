import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";
import { ReferralTierLevel } from "../types/enums";

/**
 * Append-only referral tier upgrade log (#677), written on every
 * ReferralTierUpgraded event. Powers GET /referrals/:wallet/tier/history.
 */
@Entity("referral_tier_history")
export class ReferralTierHistory {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 56 })
  @Index("idx_referral_tier_history_wallet")
  wallet!: string;

  @Column({ type: "enum", enum: ReferralTierLevel })
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
