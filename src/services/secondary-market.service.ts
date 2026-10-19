import { DataSource, EntityManager } from "typeorm";
import { Decimal } from "decimal.js";
import { SecondaryListing } from "../models/SecondaryListing.model";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { ListingStatus, InvoiceStatus, InvestmentStatus, NotificationType } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { logger } from "../observability/logger";
import type { NotificationService } from "./notification.service";

export interface CreateListingInput {
  invoiceId: string;
  sellerWallet: string;
  sellerId?: string;
  quantity: string;
  pricePerFraction: string;
  expiresAt: Date;
}

export interface ListingFilters {
  invoiceId?: string;
  sellerWallet?: string;
  status?: ListingStatus;
  minPrice?: number;
  maxPrice?: number;
  sortBy?: "price" | "expires_at" | "created_at";
  sortOrder?: "ASC" | "DESC";
}

export interface PaginationOptions {
  page: number;
  limit: number;
}

export interface BuyListingInput {
  listingId: string;
  buyerWallet: string;
  buyerId: string;
  quantity?: string;
}

export interface ListingResult {
  id: string;
  invoiceId: string;
  sellerWallet: string;
  quantity: string;
  pricePerFraction: string;
  totalPrice: string;
  status: ListingStatus;
  expiresAt: Date;
  createdAt: Date;
}

export interface ListingDetailResult extends ListingResult {
  invoice: {
    id: string;
    invoiceNumber: string;
    customerName: string;
    amount: string;
    status: InvoiceStatus;
    dueDate: Date;
  };
}

export interface BuyListingResult {
  listingId: string;
  buyerWallet: string;
  quantity: string;
  totalPrice: string;
  transactionHash?: string;
}

export class SecondaryMarketService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly notificationService?: NotificationService
  ) {}

  /**
   * Create a new secondary market listing for invoice fractions.
   * Validates quantity against seller's available holding balance.
   */
  async createListing(input: CreateListingInput): Promise<SecondaryListing> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const { invoiceId, sellerWallet, sellerId, quantity, pricePerFraction, expiresAt } = input;

      // Validate input
      const quantityDecimal = new Decimal(quantity);
      const priceDecimal = new Decimal(pricePerFraction);

      if (quantityDecimal.lte(0)) {
        throw new ServiceError("INVALID_QUANTITY", "Quantity must be greater than zero", 400);
      }

      if (priceDecimal.lte(0)) {
        throw new ServiceError("INVALID_PRICE", "Price per fraction must be greater than zero", 400);
      }

      if (new Date(expiresAt) <= new Date()) {
        throw new ServiceError("INVALID_EXPIRY", "Expiry date must be in the future", 400);
      }

      // Get invoice
      const invoice = await manager.findOne(Invoice, { where: { id: invoiceId } });
      if (!invoice) {
        throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
      }

      if (invoice.status !== InvoiceStatus.FUNDED && invoice.status !== InvoiceStatus.SETTLED) {
        throw new ServiceError(
          "INVALID_INVOICE_STATUS",
          "Only funded or settled invoices can be listed on secondary market",
          400
        );
      }

      // Get seller's investments in this invoice
      const investments = await manager.find(Investment, {
        where: {
          invoiceId,
          investorWallet: sellerWallet,
          status: InvestmentStatus.CONFIRMED,
        },
      });

      if (investments.length === 0) {
        throw new ServiceError(
          "NO_HOLDINGS",
          "Seller has no confirmed investments in this invoice",
          400
        );
      }

      // Calculate total holdings
      const totalHoldings = investments.reduce(
        (sum, inv) => sum.plus(new Decimal(inv.investmentAmount)),
        new Decimal(0)
      );

      // Check if quantity exceeds holdings
      if (quantityDecimal.gt(totalHoldings)) {
        throw new ServiceError(
          "INSUFFICIENT_HOLDINGS",
          `Requested quantity ${quantity} exceeds available holdings ${totalHoldings.toFixed(4)}`,
          400
        );
      }

      // Calculate total price
      const totalPrice = quantityDecimal.times(priceDecimal);

      // Create listing
      const listing = manager.create(SecondaryListing, {
        invoiceId,
        sellerWallet,
        sellerId: sellerId || null,
        quantity: quantityDecimal.toFixed(4),
        pricePerFraction: priceDecimal.toFixed(4),
        totalPrice: totalPrice.toFixed(4),
        status: ListingStatus.ACTIVE,
        expiresAt: new Date(expiresAt),
      });

      const saved = await manager.save(listing);

      logger.info("secondary.listing.created", {
        listing_id: saved.id,
        invoice_id: invoiceId,
        seller_wallet: sellerWallet,
        quantity: quantity,
        price_per_fraction: pricePerFraction,
      });

      return saved;
    });
  }

  /**
   * Get active listings with filters and pagination.
   * Expired listings are excluded from results.
   */
  async getListings(
    filters: ListingFilters = {},
    pagination: PaginationOptions = { page: 1, limit: 20 }
  ): Promise<{ data: ListingResult[]; meta: { total: number; page: number; limit: number; totalPages: number } }> {
    const repository = this.dataSource.getRepository(SecondaryListing);
    const queryBuilder = repository
      .createQueryBuilder("listing")
      .leftJoinAndSelect("listing.invoice", "invoice")
      .where("listing.deleted_at IS NULL")
      .andWhere("listing.status = :status", { status: ListingStatus.ACTIVE })
      .andWhere("listing.expires_at > :now", { now: new Date() });

    // Apply filters
    if (filters.invoiceId) {
      queryBuilder.andWhere("listing.invoice_id = :invoiceId", { invoiceId: filters.invoiceId });
    }

    if (filters.sellerWallet) {
      queryBuilder.andWhere("listing.seller_wallet = :sellerWallet", {
        sellerWallet: filters.sellerWallet,
      });
    }

    if (filters.minPrice !== undefined) {
      queryBuilder.andWhere("CAST(listing.price_per_fraction AS DECIMAL) >= :minPrice", {
        minPrice: filters.minPrice,
      });
    }

    if (filters.maxPrice !== undefined) {
      queryBuilder.andWhere("CAST(listing.price_per_fraction AS DECIMAL) <= :maxPrice", {
        maxPrice: filters.maxPrice,
      });
    }

    // Apply sorting
    const sortColumn = this.getSortColumn(filters.sortBy || "created_at");
    queryBuilder.orderBy(sortColumn, filters.sortOrder || "DESC");
    queryBuilder.addOrderBy("listing.id", "ASC");

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const offset = (pagination.page - 1) * pagination.limit;
    queryBuilder.skip(offset).take(pagination.limit);

    const listings = await queryBuilder.getMany();

    const data: ListingResult[] = listings.map((listing) => ({
      id: listing.id,
      invoiceId: listing.invoiceId,
      sellerWallet: listing.sellerWallet,
      quantity: listing.quantity,
      pricePerFraction: listing.pricePerFraction,
      totalPrice: listing.totalPrice,
      status: listing.status,
      expiresAt: listing.expiresAt,
      createdAt: listing.createdAt,
    }));

    return {
      data,
      meta: {
        total,
        page: pagination.page,
        limit: pagination.limit,
        totalPages: Math.ceil(total / pagination.limit),
      },
    };
  }

  /**
   * Get a specific listing by ID with full details.
   */
  async getListingById(id: string): Promise<ListingDetailResult> {
    const repository = this.dataSource.getRepository(SecondaryListing);
    const listing = await repository.findOne({
      where: { id },
      relations: ["invoice"],
    });

    if (!listing) {
      throw new ServiceError("LISTING_NOT_FOUND", "Listing not found", 404);
    }

    return {
      id: listing.id,
      invoiceId: listing.invoiceId,
      sellerWallet: listing.sellerWallet,
      quantity: listing.quantity,
      pricePerFraction: listing.pricePerFraction,
      totalPrice: listing.totalPrice,
      status: listing.status,
      expiresAt: listing.expiresAt,
      createdAt: listing.createdAt,
      invoice: {
        id: listing.invoice.id,
        invoiceNumber: listing.invoice.invoiceNumber,
        customerName: listing.invoice.customerName,
        amount: listing.invoice.amount,
        status: listing.invoice.status,
        dueDate: listing.invoice.dueDate,
      },
    };
  }

  /**
   * Execute purchase of a listing and transfer fractions.
   * This would integrate with Soroban for actual fraction transfer.
   */
  async buyListing(input: BuyListingInput): Promise<BuyListingResult> {
    let wasSold = false;
    let soldSellerId: string | undefined;
    let soldSellerWallet: string | undefined;
    let soldListingId: string | undefined;
    let soldBuyerWallet: string | undefined;
    let soldQuantity: string | undefined;
    let soldTotalPrice: string | undefined;

    const result = await this.dataSource.transaction(async (manager: EntityManager) => {
      const { listingId, buyerWallet, quantity } = input;

      // Get listing
      const listing = await manager.findOne(SecondaryListing, {
        where: { id: listingId },
        relations: ["invoice"],
      });

      if (!listing) {
        throw new ServiceError("LISTING_NOT_FOUND", "Listing not found", 404);
      }

      if (listing.status !== ListingStatus.ACTIVE) {
        throw new ServiceError("LISTING_NOT_ACTIVE", "Listing is not active", 400);
      }

      if (listing.isExpired()) {
        throw new ServiceError("LISTING_EXPIRED", "Listing has expired", 400);
      }

      if (listing.sellerWallet === buyerWallet) {
        throw new ServiceError("SELF_PURCHASE", "Cannot buy your own listing", 400);
      }

      // Determine quantity to buy (default to full listing quantity)
      const buyQuantity = quantity ? new Decimal(quantity) : new Decimal(listing.quantity);

      if (buyQuantity.lte(0)) {
        throw new ServiceError("INVALID_QUANTITY", "Quantity must be greater than zero", 400);
      }

      if (buyQuantity.gt(new Decimal(listing.quantity))) {
        throw new ServiceError(
          "INSUFFICIENT_QUANTITY",
          `Requested quantity ${buyQuantity.toFixed(4)} exceeds available ${listing.quantity}`,
          400
        );
      }

      // Calculate total price
      const totalPrice = buyQuantity.times(new Decimal(listing.pricePerFraction));

      // TODO: Submit Soroban fraction transfer transaction here
      // This would integrate with the Soroban contract to transfer fractions
      // For now, we'll simulate with a placeholder transaction hash
      const transactionHash = `simulated_${Date.now()}`;

      // Update listing status if fully sold
      if (buyQuantity.equals(new Decimal(listing.quantity))) {
        listing.status = ListingStatus.SOLD;
        await manager.save(listing);

        // Track data for post-transaction notification
        wasSold = true;
        soldListingId = listingId;
        soldSellerId = listing.sellerId ?? undefined;
        soldSellerWallet = listing.sellerWallet;
        soldBuyerWallet = buyerWallet;
        soldQuantity = buyQuantity.toFixed(4);
        soldTotalPrice = totalPrice.toFixed(4);
      } else {
        // Partial sale - reduce quantity
        const remainingQuantity = new Decimal(listing.quantity).minus(buyQuantity);
        listing.quantity = remainingQuantity.toFixed(4);
        listing.totalPrice = remainingQuantity.times(new Decimal(listing.pricePerFraction)).toFixed(4);
        await manager.save(listing);
      }

      logger.info("secondary.listing.purchased", {
        listing_id: listingId,
        buyer_wallet: buyerWallet,
        quantity: buyQuantity.toFixed(4),
        total_price: totalPrice.toFixed(4),
        transaction_hash: transactionHash,
      });

      return {
        listingId,
        buyerWallet,
        quantity: buyQuantity.toFixed(4),
        totalPrice: totalPrice.toFixed(4),
        transactionHash,
      };
    });

    // Fire notification after transaction commits — never throw out of here
    if (wasSold && this.notificationService) {
      try {
        const userId = soldSellerId ?? soldSellerWallet;
        if (!userId) {
          logger.warn("secondary.notification.skipped", {
            listing_id: soldListingId,
            reason: "no_seller_identity",
          });
          return result;
        }
        await this.notificationService.createNotification(
          userId,
          NotificationType.SECONDARY_MARKET_SOLD,
          "Listing Sold",
          "Your listing for an invoice fraction has been fully purchased.",
          {
            listingId: soldListingId,
            buyerWallet: soldBuyerWallet,
            quantity: soldQuantity,
            totalPrice: soldTotalPrice,
          }
        );
      } catch (error) {
        logger.warn("secondary.notification.failed", { listing_id: soldListingId, error });
      }
    }

    return result;
  }

  /**
   * Cancel a listing (restricted to listing owner only).
   */
  async cancelListing(listingId: string, sellerWallet: string, reason?: string): Promise<SecondaryListing> {
    const repository = this.dataSource.getRepository(SecondaryListing);
    const listing = await repository.findOne({ where: { id: listingId } });

    if (!listing) {
      throw new ServiceError("LISTING_NOT_FOUND", "Listing not found", 404);
    }

    if (listing.sellerWallet !== sellerWallet) {
      throw new ServiceError("FORBIDDEN", "Only the listing owner can cancel this listing", 403);
    }

    if (listing.status !== ListingStatus.ACTIVE) {
      throw new ServiceError("LISTING_NOT_ACTIVE", "Only active listings can be cancelled", 400);
    }

    listing.status = ListingStatus.CANCELLED;
    listing.cancellationReason = reason || null;

    const saved = await repository.save(listing);

    logger.info("secondary.listing.cancelled", {
      listing_id: listingId,
      seller_wallet: sellerWallet,
      reason,
    });

    return saved;
  }

  private getSortColumn(sort: string): string {
    const sortMap: Record<string, string> = {
      price: "listing.price_per_fraction",
      expires_at: "listing.expires_at",
      created_at: "listing.created_at",
    };

    return sortMap[sort] || "listing.created_at";
  }
}

export function createSecondaryMarketService(dataSource: DataSource, notificationService?: NotificationService): SecondaryMarketService {
  return new SecondaryMarketService(dataSource, notificationService);
}
