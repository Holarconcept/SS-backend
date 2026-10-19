import { Router } from "express";
import { ReferralTierController } from "../controllers/referral-tier.controller";
import type { ReferralTierService } from "../services/referral-tier.service";

export interface ReferralTierRouterDependencies {
  referralTierService: ReferralTierService;
}

export function createReferralTierRouter({
  referralTierService,
}: ReferralTierRouterDependencies): Router {
  const router = Router();
  const controller = new ReferralTierController(referralTierService);

  // GET /api/v1/referrals/:wallet/tier — current tier + commission rate (#677)
  router.get("/:wallet/tier", controller.getTier);

  // GET /api/v1/referrals/:wallet/tier/history — paginated upgrade log (#677)
  router.get("/:wallet/tier/history", controller.getTierHistory);

  return router;
}
