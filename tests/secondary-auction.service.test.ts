import { DataSource } from "typeorm";
import { SecondaryAuctionService } from "../src/services/secondary-auction.service";
import { SecondaryAuction } from "../src/models/SecondaryAuction.model";
import { SecondaryBid } from "../src/models/SecondaryBid.model";
import { AuctionStatus } from "../src/types/enums";

function createFakeDataSource(
  auctions: SecondaryAuction[] = [],
  bids: SecondaryBid[] = [],
) {
  const auctionRows = [...auctions];
  const bidRows = [...bids];

  return {
    getRepository: (entity: unknown) => {
      if (entity === SecondaryAuction) {
        return {
          findOneBy: async (where: { auctionId: string }) =>
            auctionRows.find((a) => a.auctionId === where.auctionId) ?? null,
          find: async (options: { where: { invoiceId: string | null } }) =>
            auctionRows.filter((a) => a.invoiceId === options.where.invoiceId),
          create: (data: Partial<SecondaryAuction>) => ({ ...data }) as SecondaryAuction,
          save: async (row: SecondaryAuction) => {
            const idx = auctionRows.findIndex((a) => a.auctionId === row.auctionId);
            const full = {
              id: row.id ?? `auc-${auctionRows.length + 1}`,
              bidCount: 0,
              highestBid: "0.0000",
              highestBidder: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...row,
            } as SecondaryAuction;
            if (idx >= 0) auctionRows[idx] = full;
            else auctionRows.push(full);
            return full;
          },
        };
      }
      if (entity === SecondaryBid) {
        return {
          create: (data: Partial<SecondaryBid>) => ({ ...data }) as SecondaryBid,
          save: async (row: SecondaryBid) => {
            const full = {
              id: `bid-${bidRows.length + 1}`,
              createdAt: new Date(),
              ...row,
            } as SecondaryBid;
            bidRows.push(full);
            return full;
          },
          findAndCount: async (options: {
            where: { auctionId: string };
            order: Record<string, string>;
            skip: number;
            take: number;
          }) => {
            const matched = bidRows
              .filter((b) => b.auctionId === options.where.auctionId)
              .sort((a, b) => {
                const aT = a.placedAt?.getTime() ?? 0;
                const bT = b.placedAt?.getTime() ?? 0;
                return options.order.placedAt === "DESC" ? bT - aT : aT - bT;
              });
            return [matched.slice(options.skip, options.skip + options.take), matched.length];
          },
        };
      }
      throw new Error(`Unexpected entity in test fake: ${String(entity)}`);
    },
  } as unknown as DataSource;
}

const NOW = new Date("2026-03-01T12:00:00Z");

describe("SecondaryAuctionService", () => {
  it("indexes all three events and returns accurate status and highest bid", async () => {
    const service = new SecondaryAuctionService(createFakeDataSource(), () => NOW);

    await service.ingestAuctionCreated({
      auctionId: "auc-1",
      seller: "GSELLER",
      invoiceId: "inv-1",
      reservePrice: "100.0000",
      startsAt: NOW,
      endsAt: new Date("2026-03-02T12:00:00Z"),
      eventId: "evt-create",
    });
    await service.ingestBidPlaced({
      auctionId: "auc-1",
      bidder: "GBIDDER1",
      amount: "150.0000",
      eventId: "evt-bid-1",
      occurredAt: NOW,
    });
    await service.ingestBidPlaced({
      auctionId: "auc-1",
      bidder: "GBIDDER2",
      amount: "120.0000",
      eventId: "evt-bid-2",
      occurredAt: NOW,
    });

    const auction = await service.getAuction("auc-1");

    expect(auction.status).toBe(AuctionStatus.ACTIVE);
    expect(auction.seller).toBe("GSELLER");
    expect(auction.highestBid).toBe("150.0000");
    expect(auction.highestBidder).toBe("GBIDDER1");
    expect(auction.bidCount).toBe(2);
    expect(auction.reserveMet).toBe(true);
    expect(auction.countdownSeconds).toBe(86_400);
  });

  it("returns paginated bids in descending order", async () => {
    const service = new SecondaryAuctionService(createFakeDataSource(), () => NOW);

    await service.ingestAuctionCreated({
      auctionId: "auc-2",
      seller: "GSELLER",
      reservePrice: "50.0000",
    });
    for (let i = 1; i <= 5; i++) {
      await service.ingestBidPlaced({
        auctionId: "auc-2",
        bidder: `GBIDDER${i}`,
        amount: `${100 + i}.0000`,
        eventId: `evt-${i}`,
        occurredAt: new Date(NOW.getTime() + i * 1000),
      });
    }

    const page1 = await service.getBids("auc-2", 1, 2);

    expect(page1.meta.total).toBe(5);
    expect(page1.meta.totalPages).toBe(3);
    expect(page1.data).toHaveLength(2);
    expect(page1.data[0].bidder).toBe("GBIDDER5");
    expect(page1.data[1].bidder).toBe("GBIDDER4");
  });

  it("settles an auction and returns winner + settlement amount", async () => {
    const service = new SecondaryAuctionService(createFakeDataSource(), () => NOW);

    await service.ingestAuctionCreated({
      auctionId: "auc-3",
      seller: "GSELLER",
      reservePrice: "100.0000",
    });
    await service.ingestBidPlaced({
      auctionId: "auc-3",
      bidder: "GWINNER",
      amount: "200.0000",
      eventId: "evt-b1",
    });
    await service.ingestAuctionSettled({
      auctionId: "auc-3",
      eventId: "evt-settle",
      occurredAt: NOW,
    });

    const auction = await service.getAuction("auc-3");

    expect(auction.status).toBe(AuctionStatus.SETTLED);
    expect(auction.winner).toBe("GWINNER");
    expect(auction.settlementAmount).toBe("200.0000");
    expect(auction.settledAt).toBe(NOW.toISOString());
    expect(auction.countdownSeconds).toBeNull();
  });

  it("returns active and settled auctions for an invoice", async () => {
    const service = new SecondaryAuctionService(createFakeDataSource(), () => NOW);

    await service.ingestAuctionCreated({
      auctionId: "auc-active",
      seller: "GSELLER",
      invoiceId: "inv-9",
      reservePrice: "10.0000",
    });
    await service.ingestAuctionCreated({
      auctionId: "auc-done",
      seller: "GSELLER",
      invoiceId: "inv-9",
      reservePrice: "10.0000",
    });
    await service.ingestAuctionSettled({ auctionId: "auc-done" });

    const auctions = await service.getAuctionsForInvoice("inv-9");

    expect(auctions).toHaveLength(2);
    const statuses = auctions.map((a) => a.status).sort();
    expect(statuses).toEqual([AuctionStatus.ACTIVE, AuctionStatus.SETTLED]);
  });

  it("404s for an unknown auction", async () => {
    const service = new SecondaryAuctionService(createFakeDataSource(), () => NOW);

    await expect(service.getAuction("missing")).rejects.toMatchObject({
      code: "AUCTION_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("404s when a bid references an unknown auction", async () => {
    const service = new SecondaryAuctionService(createFakeDataSource(), () => NOW);

    await expect(
      service.ingestBidPlaced({
        auctionId: "missing",
        bidder: "G",
        amount: "1.0000",
      }),
    ).rejects.toMatchObject({ code: "AUCTION_NOT_FOUND", statusCode: 404 });
  });
});
