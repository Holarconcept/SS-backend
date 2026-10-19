import { Router } from "express";
import { SecondaryAuctionController } from "../controllers/secondary-auction.controller";
import type { SecondaryAuctionService } from "../services/secondary-auction.service";

export interface SecondaryAuctionRouterDependencies {
  secondaryAuctionService: SecondaryAuctionService;
}

export function createSecondaryAuctionRouter({
  secondaryAuctionService,
}: SecondaryAuctionRouterDependencies): Router {
  const router = Router();
  const controller = new SecondaryAuctionController(secondaryAuctionService);

  // GET /api/v1/auctions/:auctionId — status, highest bid, countdown (#679)
  router.get("/:auctionId", controller.getAuction);

  // GET /api/v1/auctions/:auctionId/bids — paginated bids, newest first (#679)
  router.get("/:auctionId/bids", controller.getBids);

  return router;
}

/**
 * Invoice-scoped auction listing (#679). Mounted under `/api/v1/invoices`.
 */
export function createInvoiceAuctionRouter({
  secondaryAuctionService,
}: SecondaryAuctionRouterDependencies): Router {
  const router = Router();
  const controller = new SecondaryAuctionController(secondaryAuctionService);

  // GET /api/v1/invoices/:invoiceId/auctions — active + recent auctions
  router.get("/:invoiceId/auctions", controller.getInvoiceAuctions);

  return router;
}
