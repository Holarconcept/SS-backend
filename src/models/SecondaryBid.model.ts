import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from "typeorm";

/**
 * Individual bid on a secondary-market auction (#679), indexed from
 * BidPlaced events. Append-only: every event inserts a row so the bid
 * history can be paginated in descending order.
 */
@Entity("secondary_bids")
export class SecondaryBid {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "auction_id", type: "varchar", length: 64 })
  @Index("idx_secondary_bids_auction_id")
  auctionId!: string;

  @Column({ type: "varchar", length: 56 })
  @Index("idx_secondary_bids_bidder")
  bidder!: string;

  @Column({ type: "decimal", precision: 18, scale: 4 })
  amount!: string;

  @Column({ name: "event_id", type: "varchar", length: 128, nullable: true })
  @Index("idx_secondary_bids_event_id", { unique: true })
  eventId!: string | null;

  @Column({ name: "placed_at", type: "timestamptz", nullable: true })
  placedAt!: Date | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
