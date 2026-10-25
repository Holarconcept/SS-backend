import { Request, Response } from "express";
import { IssuerBlacklistService } from "../services/issuer-blacklist.service";

/**
 * #685 — Issuer blacklist REST API endpoints.
 */
export class IssuerBlacklistController {
  constructor(private readonly blacklistService: IssuerBlacklistService) {}

  getBlacklistStatus = async (req: Request, res: Response) => {
    try {
      const wallet = String(req.params.wallet);
      const result = await this.blacklistService.getBlacklistStatus(wallet);
      return res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      return res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
    }
  };

  getBlacklistedIssuers = async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 100);
      const result = await this.blacklistService.getBlacklistedIssuers(page, pageSize);
      return res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      return res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
    }
  };
}
