import { Router } from "express";
import { YieldBoostController } from "../controllers/yield-boost.controller";
import type { YieldBoostService } from "../services/yield-boost.service";

export interface YieldBoostRouterDependencies {
  yieldBoostService: YieldBoostService;
}

/**
 * Boost lookup routes (#678). Mounted under `/api/v1/invoices`.
 */
export function createYieldBoostRouter({
  yieldBoostService,
}: YieldBoostRouterDependencies): Router {
  const router = Router();
  const controller = new YieldBoostController(yieldBoostService);

  // GET /api/v1/invoices/:invoiceId/boost/:wallet — eligibility + boosted yield
  router.get("/:invoiceId/boost/:wallet", controller.getBoost);

  return router;
}
