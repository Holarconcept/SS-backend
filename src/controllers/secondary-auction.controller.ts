import { Request, Response } from "express";
import type { SecondaryAuctionService } from "../services/secondary-auction.service";

export class SecondaryAuctionController {
  constructor(private readonly secondaryAuctionService: SecondaryAuctionService) {}

  /** GET /api/v1/auctions/:auctionId */
  getAuction = async (req: Request, res: Response) => {
    try {
      const auctionId = req.params.auctionId ?? (req.params as Record<string, string>).auction_id;
      const auction = await this.secondaryAuctionService.getAuction(auctionId);
      return res.status(200).json({ success: true, data: auction });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  };

  /** GET /api/v1/auctions/:auctionId/bids */
  getBids = async (req: Request, res: Response) => {
    try {
      const auctionId = req.params.auctionId ?? (req.params as Record<string, string>).auction_id;
      const page = Number(req.query.page ?? 1);
      const limit = Number(req.query.limit ?? 20);
      const bids = await this.secondaryAuctionService.getBids(auctionId, page, limit);
      return res.status(200).json({ success: true, ...bids });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  };

  /** GET /api/v1/invoices/:invoiceId/auctions */
  getInvoiceAuctions = async (req: Request, res: Response) => {
    try {
      const invoiceId = req.params.invoiceId ?? (req.params as Record<string, string>).invoice_id;
      const auctions = await this.secondaryAuctionService.getAuctionsForInvoice(invoiceId);
      return res.status(200).json({ success: true, data: auctions });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  };
}

function sendError(res: Response, err: unknown): Response {
  const statusCode =
    (err as { statusCode?: number }).statusCode || (err as { status?: number }).status || 500;
  return res.status(statusCode).json({
    error: {
      code: (err as { code?: string }).code || "INTERNAL_ERROR",
      message: (err as { message?: string }).message || "Internal server error",
    },
  });
}
