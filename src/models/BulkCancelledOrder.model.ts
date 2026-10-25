import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Orders cancelled via BulkOrdersCancelled events (#688), indexed from
 * the secondary market. Each row represents one cancelled order with
 * its refund amount.
 */
@Entity("bulk_cancelled_orders")
export class BulkCancelledOrder {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "order_id", type: "varchar", length: 64 })
  @Index("idx_bulk_cancelled_order_id", { unique: true })
  orderId!: string;

  @Column({ name: "wallet", type: "varchar", length: 56 })
  @Index("idx_bulk_cancelled_wallet")
  wallet!: string;

  @Column({ name: "invoice_id", type: "varchar", length: 64, nullable: true })
  @Index("idx_bulk_cancelled_invoice_id")
  invoiceId!: string | null;

  @Column({ name: "refund_amount", type: "decimal", precision: 18, scale: 4 })
  refundAmount!: string;

  @Column({ name: "event_id", type: "varchar", length: 128, nullable: true })
  @Index("idx_bulk_cancelled_event_id")
  eventId!: string | null;

  @Column({ name: "cancelled_at", type: "timestamptz", nullable: true })
  cancelledAt!: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
