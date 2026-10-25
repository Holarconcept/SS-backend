/**
 * Tests for the post-transaction notification paths in SecondaryMarketService.
 * Covers: full-sale notification, partial-sale no-notification, and error suppression.
 */
import { SecondaryMarketService } from "../src/services/secondary-market.service";
import { ListingStatus, InvoiceStatus, NotificationType } from "../src/types/enums";
import type { NotificationService } from "../src/services/notification.service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildNotificationService(
  overrides: Partial<{ createNotification: jest.Mock }> = {}
): NotificationService {
  return {
    createNotification: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as NotificationService;
}

function buildListing(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "listing-1",
    invoiceId: "invoice-1",
    sellerWallet: "GSELLER0000000000000000000000000000000000000000000000",
    sellerId: "seller-user-id",
    quantity: "100.0000",
    pricePerFraction: "1.0000",
    totalPrice: "100.0000",
    status: ListingStatus.ACTIVE,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 1 day out
    cancellationReason: null,
    isExpired: () => false,
    isActive: () => true,
    invoice: {
      id: "invoice-1",
      status: InvoiceStatus.FUNDED,
    },
    ...overrides,
  };
}

function buildDataSource(listing: ReturnType<typeof buildListing>, failCommit = false) {
  const manager = {
    findOne: jest
      .fn()
      .mockResolvedValueOnce(listing)
      .mockResolvedValueOnce({ status: InvoiceStatus.FUNDED }),
    find: jest.fn().mockResolvedValue([
      { investmentAmount: "100.0000", expectedReturn: "110.0000" },
    ]),
    create: jest.fn((_entity: unknown, values: object) => values),
    save: jest.fn().mockImplementation(async (entity: unknown) => entity),
  };
  return {
    transaction: jest.fn().mockImplementation(async (callback: (m: typeof manager) => unknown) => {
      const result = await callback(manager);
      if (failCommit) throw new Error("commit failed");
      return result;
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SecondaryMarketService — notification paths", () => {
  const buyInput = {
    listingId: "listing-1",
    buyerWallet: "GBUYER0000000000000000000000000000000000000000000000",
    buyerId: "buyer-user-id",
  };

  it("calls createNotification with SECONDARY_MARKET_SOLD when a listing is fully sold", async () => {
    const notificationService = buildNotificationService();
    const listing = buildListing();
    const dataSource = buildDataSource(listing);
    const service = new SecondaryMarketService(dataSource as any, notificationService);

    await service.buyListing({ ...buyInput, quantity: "100.0000" });

    expect(notificationService.createNotification).toHaveBeenCalledWith(
      "seller-user-id", // sellerId takes precedence over sellerWallet
      NotificationType.SECONDARY_MARKET_SOLD,
      "Listing Sold",
      expect.any(String),
      expect.objectContaining({ listingId: "listing-1" })
    );
  });

  it("falls back to sellerWallet as userId when sellerId is null", async () => {
    const notificationService = buildNotificationService();
    const listing = buildListing({ sellerId: null });
    const dataSource = buildDataSource(listing);
    const service = new SecondaryMarketService(dataSource as any, notificationService);

    await service.buyListing({ ...buyInput, quantity: "100.0000" });

    expect(notificationService.createNotification).toHaveBeenCalledWith(
      listing.sellerWallet,
      NotificationType.SECONDARY_MARKET_SOLD,
      expect.any(String),
      expect.any(String),
      expect.any(Object)
    );
  });

  it("does NOT call createNotification on a partial sale", async () => {
    const notificationService = buildNotificationService();
    const listing = buildListing();
    const dataSource = buildDataSource(listing);
    const service = new SecondaryMarketService(dataSource as any, notificationService);

    // Buy only half the quantity
    await service.buyListing({ ...buyInput, quantity: "50.0000" });

    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it("does NOT call createNotification when no notificationService is provided", async () => {
    const listing = buildListing();
    const dataSource = buildDataSource(listing);
    const service = new SecondaryMarketService(dataSource as any); // no notification service

    // Should not throw even without a notification service
    await expect(service.buyListing({ ...buyInput, quantity: "100.0000" })).resolves.toBeDefined();
  });

  it("swallows createNotification errors and still returns the BuyListingResult", async () => {
    const notificationService = buildNotificationService({
      createNotification: jest.fn().mockRejectedValue(new Error("notification db down")),
    });
    const listing = buildListing();
    const dataSource = buildDataSource(listing);
    const service = new SecondaryMarketService(dataSource as any, notificationService);

    const result = await service.buyListing({ ...buyInput, quantity: "100.0000" });

    // The buy should complete successfully despite the notification failure
    expect(result.listingId).toBe("listing-1");
    expect(result.buyerWallet).toBe(buyInput.buyerWallet);
  });
});
