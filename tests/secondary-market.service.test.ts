import { DataSource } from "typeorm";
import { SecondaryMarketService } from "../src/services/secondary-market.service";
import { Invoice } from "../src/models/Invoice.model";
import { Investment } from "../src/models/Investment.model";
import { SecondaryListing } from "../src/models/SecondaryListing.model";
import { InvestmentStatus, InvoiceStatus, ListingStatus } from "../src/types/enums";

describe("SecondaryMarketService", () => {
  const invoice = { id: "invoice-1", status: InvoiceStatus.FUNDED } as Invoice;
  const investments = [
    { investmentAmount: "100.0000", status: InvestmentStatus.CONFIRMED } as Investment,
  ];
  const existingListing = {
    quantity: "60.0000",
    status: ListingStatus.ACTIVE,
  } as SecondaryListing;
  let manager: {
    findOne: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let service: SecondaryMarketService;

  beforeEach(() => {
    manager = {
      findOne: jest.fn((entity: typeof Invoice) =>
        Promise.resolve(entity === Invoice ? invoice : null)
      ),
      find: jest.fn((entity: typeof Investment | typeof SecondaryListing) =>
        Promise.resolve(entity === Investment ? investments : [existingListing])
      ),
      create: jest.fn((_entity, values) => values),
      save: jest.fn((listing) => Promise.resolve({ id: "listing-new", ...listing })),
    };
    const dataSource = {
      transaction: jest.fn((callback) => callback(manager)),
    } as unknown as DataSource;
    service = new SecondaryMarketService(dataSource);
  });

  const listingInput = {
    invoiceId: "invoice-1",
    sellerWallet: "seller-wallet",
    quantity: "50",
    pricePerFraction: "2",
    expiresAt: new Date(Date.now() + 60_000),
  };

  it("rejects a listing that overlaps the seller's existing active listings", async () => {
    await expect(service.createListing(listingInput)).rejects.toMatchObject({
      code: "INSUFFICIENT_HOLDINGS",
      statusCode: 400,
    });

    expect(manager.find).toHaveBeenCalledWith(
      Investment,
      expect.objectContaining({
        lock: { mode: "pessimistic_write" },
      })
    );
    expect(manager.find).toHaveBeenCalledWith(
      SecondaryListing,
      expect.objectContaining({
        where: expect.objectContaining({
          invoiceId: listingInput.invoiceId,
          sellerWallet: listingInput.sellerWallet,
          status: ListingStatus.ACTIVE,
        }),
      })
    );
    expect(manager.save).not.toHaveBeenCalled();
  });

  it("allows listing exactly the remaining unlisted holdings", async () => {
    const result = await service.createListing({ ...listingInput, quantity: "40" });

    expect(result.quantity).toBe("40.0000");
    expect(manager.save).toHaveBeenCalledTimes(1);
  });
});
