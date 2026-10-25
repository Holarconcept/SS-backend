import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import type { Invoice } from "./Invoice.model";

export enum SettlementIntentStatus {
  PREPARED = "prepared",
  SUBMITTING = "submitting",
  DISTRIBUTED = "distributed",
  COMPLETED = "completed",
}

@Entity("settlement_intents")
@Index("uq_settlement_intents_invoice_id", ["invoiceId"], { unique: true })
@Index("idx_settlement_intents_status", ["status"])
export class SettlementIntent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "invoice_id", type: "uuid" })
  invoiceId!: string;

  @Column({ type: "varchar", length: 20 })
  status!: SettlementIntentStatus;

  @Column({ type: "text" })
  payload!: string;

  @Column({ name: "transaction_hash", type: "varchar", length: 64, nullable: true })
  transactionHash!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @ManyToOne("Invoice", { onDelete: "CASCADE" })
  @JoinColumn({ name: "invoice_id" })
  invoice!: Invoice;
}
