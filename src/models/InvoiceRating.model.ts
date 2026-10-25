import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Individual rating submitted for an invoice (#683), indexed from
 * RatingSubmitted events. Append-only: every event inserts a row so the
 * rating distribution can be computed accurately.
 */
@Entity("invoice_ratings")
@Index("idx_invoice_ratings_invoice_id_rating", ["invoiceId", "rating"])
export class InvoiceRating {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "varchar", length: 64 })
  @Index("idx_invoice_ratings_invoice_id")
  invoiceId!: string;

  @Column({ name: "issuer_wallet", type: "varchar", length: 56 })
  @Index("idx_invoice_ratings_issuer")
  issuerWallet!: string;

  @Column({ name: "rater_wallet", type: "varchar", length: 56 })
  @Index("idx_invoice_ratings_rater")
  raterWallet!: string;

  @Column({ type: "int" })
  rating!: number;

  @Column({ name: "event_id", type: "varchar", length: 128, nullable: true })
  @Index("idx_invoice_ratings_event_id", { unique: true })
  eventId!: string | null;

  @Column({ name: "rated_at", type: "timestamptz", nullable: true })
  ratedAt!: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
