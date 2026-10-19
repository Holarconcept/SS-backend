import { Request, Response } from "express";
import type { YieldBoostService } from "../services/yield-boost.service";

export class YieldBoostController {
  constructor(private readonly yieldBoostService: YieldBoostService) {}

  /** GET /api/v1/invoices/:invoiceId/boost/:wallet */
  getBoost = async (req: Request, res: Response) => {
    try {
      const invoiceId = req.params.invoiceId ?? (req.params as Record<string, string>).invoice_id;
      const wallet = req.params.wallet;
      const boost = await this.yieldBoostService.getBoost(invoiceId, wallet);
      return res.status(200).json({ success: true, data: boost });
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
