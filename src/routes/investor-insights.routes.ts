import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import type { AuthService } from "../services/auth.service";
import type { InvestorInsightsService } from "../services/investor-insights.service";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import type { AuthenticatedRequest } from "../types/auth";
import { HttpError } from "../utils/http-error";

function requireOwnWallet(req: AuthenticatedRequest, wallet: string): void {
  if (!req.user) throw new HttpError(401, "Authentication required.");
  if (req.user.stellarAddress !== wallet) {
    throw new HttpError(403, "You may only view insights for your own wallet.");
  }
}

export function createInvestorInsightsRouter(
  service: InvestorInsightsService,
  authService: AuthService,
): Router {
  const router = Router();
  router.use(createAuthMiddleware(authService));

  router.get(
    "/:wallet/onboarding-bonus",
    async (req: Request<{ wallet: string }>, res: Response, next: NextFunction) => {
      try {
        const authReq = req as AuthenticatedRequest;
        requireOwnWallet(authReq, req.params.wallet);
        const status = await service.getOnboardingBonus(req.params.wallet);
        res.status(200).json({ success: true, data: status });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:wallet/alert-preferences",
    async (req: Request<{ wallet: string }>, res: Response, next: NextFunction) => {
      try {
        const authReq = req as AuthenticatedRequest;
        requireOwnWallet(authReq, req.params.wallet);
        const preferences = await service.getAlertPreferences(req.params.wallet);
        res.status(200).json({ success: true, data: preferences });
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
}

export function createYieldAdjustmentRouter(service: InvestorInsightsService): Router {
  const router = Router();

  router.get(
    "/:invoice_id/yield-adjustment",
    async (req: Request<{ invoice_id: string }>, res: Response, next: NextFunction) => {
      try {
        const adjustment = await service.getYieldAdjustment(req.params.invoice_id);
        res.status(200).json({ success: true, data: adjustment });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get(
    "/:invoice_id/yield-adjustment/history",
    async (req: Request<{ invoice_id: string }>, res: Response, next: NextFunction) => {
      try {
        const history = await service.getYieldAdjustmentHistory(req.params.invoice_id);
        res.status(200).json({ success: true, data: history });
      } catch (error) {
        next(error);
      }
    },
  );
  return router;
}
