import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";

/**
 * Sector-level benchmark aggregates (#676), refreshed from BenchmarkUpdated
 * contract events. One row per sector; averages are last-write-wins from the
 * event payload (the contract computes them off-chain).
 */
@Entity("sector_benchmarks")
export class SectorBenchmark {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 64 })
  @Index("idx_sector_benchmarks_sector", { unique: true })
  sector!: string;

  /** Average yield (percentage) across the sector, e.g. "6.50". */
  @Column({ name: "avg_yield", type: "decimal", precision: 5, scale: 2, default: 0 })
  avgYield!: string;

  /** Average calendar days from listing to settlement. */
  @Column({ name: "avg_days_to_settle", type: "decimal", precision: 8, scale: 2, default: 0 })
  avgDaysToSettle!: string;

  /** Default rate as a percentage, e.g. "2.10". */
  @Column({ name: "default_rate", type: "decimal", precision: 5, scale: 2, default: 0 })
  defaultRate!: string;

  @Column({ name: "sample_count", type: "integer", default: 0 })
  sampleCount!: number;

  @Column({ name: "last_event_id", type: "varchar", length: 128, nullable: true })
  lastEventId!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
