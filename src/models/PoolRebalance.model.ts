import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Pool rebalance proposals and executions (#684), indexed from
 * PoolRebalanceProposed and PoolRebalanceExecuted events.
 */
@Entity("pool_rebalances")
export class PoolRebalance {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "pool_id", type: "varchar", length: 64 })
  @Index("idx_pool_rebalances_pool_id")
  poolId!: string;

  @Column({ type: "varchar", length: 32 })
  @Index("idx_pool_rebalances_status")
  status!: "pending" | "executed";

  @Column({ name: "old_weights", type: "jsonb" })
  oldWeights!: Record<string, string>;

  @Column({ name: "new_weights", type: "jsonb" })
  newWeights!: Record<string, string>;

  @Column({ name: "eta", type: "timestamptz", nullable: true })
  eta!: Date | null;

  @Column({ name: "proposed_at", type: "timestamptz", nullable: true })
  proposedAt!: Date | null;

  @Column({ name: "executed_at", type: "timestamptz", nullable: true })
  executedAt!: Date | null;

  @Column({ name: "proposed_event_id", type: "varchar", length: 128, nullable: true })
  @Index("idx_pool_rebalances_proposed_event", { unique: true })
  proposedEventId!: string | null;

  @Column({ name: "executed_event_id", type: "varchar", length: 128, nullable: true })
  @Index("idx_pool_rebalances_executed_event", { unique: true })
  executedEventId!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
