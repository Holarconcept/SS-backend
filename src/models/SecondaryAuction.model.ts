import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from "typeorm";
import { AuctionStatus } from "../types/enums";

/**
 * Secondary-market fraction auction (#679), assembled from AuctionCreated,
 * BidPlaced and AuctionSettled events. `auctionId` is the on-chain id; the
 * row is upserted as subsequent events arrive.
 */
@Entity("secondary_auctions")
export class SecondaryAuction {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "auction_id", type: "varchar", length: 64 })
  @Index("idx_secondary_auctions_auction_id", { unique: true })
  auctionId!: string;

  @Column({ type: "varchar", length: 56 })
  @Index("idx_secondary_auctions_seller")
  seller!: string;

  @Column({ name: "invoice_id", type: "uuid", nullable: true })
  @Index("idx_secondary_auctions_invoice_id")
  invoiceId!: string | null;

  @Column({ type: "enum", enum: AuctionStatus, default: AuctionStatus.ACTIVE })
  @Index("idx_secondary_auctions_status")
  status!: AuctionStatus;

  @Column({ name: "highest_bid", type: "decimal", precision: 18, scale: 4, default: 0 })
  highestBid!: string;

  @Column({ name: "highest_bidder", type: "varchar", length: 56, nullable: true })
  highestBidder!: string | null;

  @Column({ name: "reserve_price", type: "decimal", precision: 18, scale: 4, default: 0 })
  reservePrice!: string;

  @Column({ name: "bid_count", type: "integer", default: 0 })
  bidCount!: number;

  @Column({ name: "starts_at", type: "timestamptz", nullable: true })
  startsAt!: Date | null;

  @Column({ name: "ends_at", type: "timestamptz", nullable: true })
  @Index("idx_secondary_auctions_ends_at")
  endsAt!: Date | null;

  @Column({ name: "settled_at", type: "timestamptz", nullable: true })
  settledAt!: Date | null;

  @Column({ name: "winner", type: "varchar", length: 56, nullable: true })
  winner!: string | null;

  @Column({ name: "settlement_amount", type: "decimal", precision: 18, scale: 4, nullable: true })
  settlementAmount!: string | null;

  @Column({ name: "created_event_id", type: "varchar", length: 128, nullable: true })
  createdEventId!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
