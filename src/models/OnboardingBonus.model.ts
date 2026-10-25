import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity("onboarding_bonuses")
export class OnboardingBonus {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 56, unique: true })
  wallet!: string;

  @Column({ name: "bonus_amount", type: "decimal", precision: 20, scale: 7 })
  bonusAmount!: string;

  @Column({ name: "invoice_id", type: "varchar", length: 64, nullable: true })
  invoiceId!: string | null;

  @Column({ name: "claimed_at", type: "timestamptz" })
  claimedAt!: Date;

  @Column({ name: "event_id", type: "varchar", length: 128, nullable: true, unique: true })
  eventId!: string | null;
}
