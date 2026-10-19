import { Router, Request, Response, NextFunction } from "express";
import { DataSource } from "typeorm";
import { logger } from "../../observability/logger";
import type { WaitlistService } from "../../services/waitlist.service";
import { AppError } from "../../utils/http-error";
import type { AuthService } from "../../services/auth.service";

interface AuthenticatedRequest extends Request {
  user?: { wallet: string };
}

export function createWaitlistRouter(
  dataSource: DataSource,
  waitlistService: WaitlistService,
  authService: AuthService,
  notificationService?: unknown
) {
  const router = Router();

  router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const page = Math.max(1, parseInt(String(_req.query.page ?? 1), 10));
      const pageSize = Math.min(100, Math.max(1, parseInt(String(_req.query.pageSize ?? 50), 10)));
      const status = (_req.query.status as "pending" | "approved" | "all") ?? "pending";

      if (!["pending", "approved", "all"].includes(status)) {
        throw new AppError(400, "Invalid status parameter", "INVALID_STATUS");
      }

      const result = await waitlistService.getWaitlistQueue(page, pageSize, status);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/:wallet/approve",
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { wallet } = req.params;

        if (!wallet || wallet.trim().length === 0) {
          throw new AppError(400, "Wallet address is required", "MISSING_WALLET");
        }

        const entry = await waitlistService.approveSingleWallet(wallet);

        logger.info("waitlist.approval.email.queued", {
          wallet: entry.wallet,
          email: entry.email,
        });

        res.json({
          success: true,
          data: entry,
          message: `Wallet ${wallet} approved`,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/bulk-approve",
    async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
        const { count } = req.body;

        if (typeof count !== "number" || count <= 0 || !Number.isInteger(count)) {
          throw new AppError(400, "Count must be a positive integer", "INVALID_COUNT");
        }

        if (count > 10000) {
          throw new AppError(
            400,
            "Cannot approve more than 10000 wallets at once",
            "COUNT_TOO_LARGE"
          );
        }

        const approved = await waitlistService.bulkApproveTop(count);

        if (approved.length > 0) {
          logger.info("waitlist.bulk_approval.emails.queued", {
            count: approved.length,
          });
        }

        res.json({
          success: true,
          data: {
            approved: approved.map((e) => ({ wallet: e.wallet, email: e.email })),
            count: approved.length,
          },
          message: `${approved.length} wallets approved`,
        });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}
