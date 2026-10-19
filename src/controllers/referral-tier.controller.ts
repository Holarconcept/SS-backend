import { Request, Response } from "express";
import type { ReferralTierService } from "../services/referral-tier.service";

export class ReferralTierController {
  constructor(private readonly referralTierService: ReferralTierService) {}

  /** GET /api/v1/referrals/:wallet/tier */
  getTier = async (req: Request, res: Response) => {
    try {
      const wallet = req.params.wallet;
      const tier = await this.referralTierService.getTier(wallet);
      return res.status(200).json({ success: true, data: tier });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  };

  /** GET /api/v1/referrals/:wallet/tier/history */
  getTierHistory = async (req: Request, res: Response) => {
    try {
      const wallet = req.params.wallet;
      const page = Number(req.query.page ?? 1);
      const limit = Number(req.query.limit ?? 20);
      const history = await this.referralTierService.getTierHistory(wallet, page, limit);
      return res.status(200).json({ success: true, ...history });
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
