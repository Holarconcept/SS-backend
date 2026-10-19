import { DataSource } from "typeorm";
import { SecondaryAuction } from "../models/SecondaryAuction.model";
import { SecondaryBid } from "../models/SecondaryBid.model";
import { AuctionStatus } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { TtlCache } from "../lib/ttl-cache";

const ACTIVE_CACHE_TTL_MS = 10_000;
const SETTLED_CACHE_TTL_MS = 300_000;
const BIDS_PAGE_SIZE = 20;

export interface AuctionCreatedEvent {
  auctionId: string;
  seller: string;
  invoiceId?: string | null;
  reservePrice: string;
  startsAt?: Date;
  endsAt?: Date;
  eventId?: string;
  occurredAt?: Date;
}

export interface BidPlacedEvent {
  auctionId: string;
  bidder: string;
  amount: string;
  eventId?: string;
  occurredAt?: Date;
}

export interface AuctionSettledEvent {
  auctionId: string;
  winner?: string | null;
  settlementAmount?: string;
  eventId?: string;
  occurredAt?: Date;
}

export interface AuctionView {
  auctionId: string;
  status: AuctionStatus;
  seller: string;
  invoiceId: string | null;
  highestBid: string;
  highestBidder: string | null;
  reservePrice: string;
  reserveMet: boolean;
  bidCount: number;
  startsAt: string | null;
  endsAt: string | null;
  settledAt: string | null;
  winner: string | null;
  settlementAmount: string | null;
  countdownSeconds: number | null;
}

export interface BidPage {
  data: Array<{
    bidder: string;
    amount: string;
    placedAt: string | null;
  }>;
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/**
 * Secondary-market fraction auctions (#679). Assembles auction state from
 * AuctionCreated / BidPlaced / AuctionSettled events. Active auctions cache
 * for 10s; settled ones for 300s.
 */
export class SecondaryAuctionService {
  /** Active auctions: short TTL so countdown / highest bid stay fresh. */
  private readonly activeCache = new TtlCache<AuctionView>(ACTIVE_CACHE_TTL_MS);
  /** Settled auctions are immutable, so they can be cached much longer. */
  private readonly settledCache = new TtlCache<AuctionView>(SETTLED_CACHE_TTL_MS);

  constructor(
    private readonly dataSource: DataSource,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private cacheFor(view: Pick<AuctionView, "status">): TtlCache<AuctionView> {
    return view.status === AuctionStatus.ACTIVE ? this.activeCache : this.settledCache;
  }

  private invalidate(auctionId: string): void {
    this.activeCache.delete(auctionId);
    this.settledCache.delete(auctionId);
  }

  /** Indexer: create/refresh an auction from AuctionCreated. */
  async ingestAuctionCreated(event: AuctionCreatedEvent): Promise<SecondaryAuction> {
    const repo = this.dataSource.getRepository(SecondaryAuction);
    let row = await repo.findOneBy({ auctionId: event.auctionId });
    if (!row) {
      row = repo.create({ auctionId: event.auctionId });
    }

    row.seller = event.seller;
    row.invoiceId = event.invoiceId ?? null;
    row.reservePrice = event.reservePrice;
    row.startsAt = event.startsAt ?? event.occurredAt ?? this.now();
    row.endsAt = event.endsAt ?? null;
    if (row.status === undefined) row.status = AuctionStatus.ACTIVE;
    if (event.eventId) row.createdEventId = event.eventId;

    const saved = await repo.save(row);
    this.invalidate(event.auctionId);
    return saved;
  }

  /** Indexer: append a bid and refresh highest-bid state. */
  async ingestBidPlaced(event: BidPlacedEvent): Promise<SecondaryBid> {
    const auctionRepo = this.dataSource.getRepository(SecondaryAuction);
    const auction = await auctionRepo.findOneBy({ auctionId: event.auctionId });
    if (!auction) {
      throw new ServiceError("AUCTION_NOT_FOUND", `Auction "${event.auctionId}" not found`, 404);
    }

    const bidRepo = this.dataSource.getRepository(SecondaryBid);
    const bid = bidRepo.create({
      auctionId: event.auctionId,
      bidder: event.bidder,
      amount: event.amount,
      eventId: event.eventId ?? null,
      placedAt: event.occurredAt ?? this.now(),
    });
    const savedBid = await bidRepo.save(bid);

    auction.bidCount += 1;
    const amount = Number(event.amount);
    const currentHighest = Number(auction.highestBid);
    if (auction.bidCount === 1 || amount > currentHighest) {
      auction.highestBid = event.amount;
      auction.highestBidder = event.bidder;
    }
    await auctionRepo.save(auction);

    this.invalidate(event.auctionId);
    return savedBid;
  }

  /** Indexer: settle an auction from AuctionSettled. */
  async ingestAuctionSettled(event: AuctionSettledEvent): Promise<SecondaryAuction> {
    const repo = this.dataSource.getRepository(SecondaryAuction);
    const row = await repo.findOneBy({ auctionId: event.auctionId });
    if (!row) {
      throw new ServiceError("AUCTION_NOT_FOUND", `Auction "${event.auctionId}" not found`, 404);
    }

    row.status = AuctionStatus.SETTLED;
    row.settledAt = event.occurredAt ?? this.now();
    row.winner = event.winner ?? row.highestBidder;
    row.settlementAmount = event.settlementAmount ?? row.highestBid;

    const saved = await repo.save(row);
    this.invalidate(event.auctionId);
    return saved;
  }

  async getAuction(auctionId: string): Promise<AuctionView> {
    const activeHit = this.activeCache.get(auctionId);
    if (activeHit) return activeHit;
    const settledHit = this.settledCache.get(auctionId);
    if (settledHit) return settledHit;

    const row = await this.dataSource.getRepository(SecondaryAuction).findOneBy({ auctionId });
    if (!row) {
      throw new ServiceError("AUCTION_NOT_FOUND", `Auction "${auctionId}" not found`, 404);
    }

    const view = toView(row, this.now());
    this.cacheFor(view).set(auctionId, view);
    return view;
  }

  async getBids(auctionId: string, page = 1, limit = BIDS_PAGE_SIZE): Promise<BidPage> {
    const auction = await this.dataSource.getRepository(SecondaryAuction).findOneBy({ auctionId });
    if (!auction) {
      throw new ServiceError("AUCTION_NOT_FOUND", `Auction "${auctionId}" not found`, 404);
    }

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));

    const bidRepo = this.dataSource.getRepository(SecondaryBid);
    const [rows, total] = await bidRepo.findAndCount({
      where: { auctionId },
      order: { placedAt: "DESC", createdAt: "DESC" },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });

    return {
      data: rows.map((r) => ({
        bidder: r.bidder,
        amount: r.amount,
        placedAt: r.placedAt ? r.placedAt.toISOString() : null,
      })),
      meta: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      },
    };
  }

  /** Active and recent auctions for an invoice (#679). */
  async getAuctionsForInvoice(invoiceId: string): Promise<AuctionView[]> {
    const repo = this.dataSource.getRepository(SecondaryAuction);
    const rows = await repo.find({
      where: { invoiceId },
      order: { updatedAt: "DESC" },
    });
    return rows.map((row) => toView(row, this.now()));
  }
}

function toView(row: SecondaryAuction, now: Date): AuctionView {
  const reserveMet = Number(row.highestBid) >= Number(row.reservePrice) && Number(row.reservePrice) > 0;
  let countdownSeconds: number | null = null;
  if (row.status === AuctionStatus.ACTIVE && row.endsAt) {
    const endsAt = row.endsAt instanceof Date ? row.endsAt : new Date(row.endsAt);
    countdownSeconds = Math.max(0, Math.round((endsAt.getTime() - now.getTime()) / 1000));
  }

  return {
    auctionId: row.auctionId,
    status: row.status,
    seller: row.seller,
    invoiceId: row.invoiceId,
    highestBid: row.highestBid,
    highestBidder: row.highestBidder,
    reservePrice: row.reservePrice,
    reserveMet,
    bidCount: row.bidCount,
    startsAt: row.startsAt ? row.startsAt.toISOString() : null,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    settledAt: row.settledAt ? row.settledAt.toISOString() : null,
    winner: row.winner,
    settlementAmount: row.settlementAmount,
    countdownSeconds,
  };
}

export function createSecondaryAuctionService(
  dataSource: DataSource,
  now?: () => Date,
): SecondaryAuctionService {
  return new SecondaryAuctionService(dataSource, now);
}
