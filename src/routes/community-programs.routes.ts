import { Router, Request, Response, NextFunction } from "express";
import { DataSource } from "typeorm";
import { createAuthMiddleware, requireAdmin } from "../middleware/auth.middleware";
import type { AuthService } from "../services/auth.service";
import type { AuthenticatedRequest } from "../types/auth";
import { CommunityProgramsService } from "../services/community-programs.service";
import { FraudReportStatus } from "../models/InvoiceFraudReport.model";
import { WaitlistEntry } from "../models/WaitlistEntry.model";

export function createCommunityProgramsRouter(dataSource: DataSource, authService: AuthService): Router {
  const router = Router();
  const service = new CommunityProgramsService(dataSource);
  const authenticate = createAuthMiddleware(authService);
  const forward = (next: NextFunction, error: unknown) => next(error);

  router.post("/referrals/register", authenticate, async (req: AuthenticatedRequest, res: Response, next) => {
    try { res.status(201).json({ success: true, data: await service.registerReferral(String(req.body?.referrerWallet ?? ""), String(req.user?.stellarAddress ?? "")) }); }
    catch (error) { forward(next, error); }
  });
  router.get("/referrals/stats", authenticate, async (req: Request, res: Response, next) => {
    try { res.json({ success: true, data: await service.referralStats(String(req.query.wallet ?? "")) }); }
    catch (error) { forward(next, error); }
  });
  router.get("/referrals/history", authenticate, async (req: Request, res: Response, next) => {
    try { res.json({ success: true, data: (await service.referralStats(String(req.query.wallet ?? ""))).history }); }
    catch (error) { forward(next, error); }
  });
  router.post("/referrals/claim", authenticate, async (req: AuthenticatedRequest, res: Response, next) => {
    try { res.json({ success: true, data: await service.buildReferralClaim(String(req.user?.stellarAddress ?? req.body?.wallet ?? "")) }); }
    catch (error) { forward(next, error); }
  });

  router.post("/waitlist", async (req: Request, res: Response, next) => {
    try { res.status(201).json({ success: true, data: await service.registerWaitlist(String(req.body?.wallet ?? ""), String(req.body?.email ?? ""), req.body?.referralCode) }); }
    catch (error) { forward(next, error); }
  });
  router.get("/waitlist/:wallet", async (req: Request, res: Response, next) => {
    try {
      const entry = await dataSource.getRepository(WaitlistEntry).findOne({ where: { wallet: req.params.wallet } });
      if (!entry) { res.status(404).json({ success: false, error: "Waitlist entry not found" }); return; }
      res.json({ success: true, data: await service.waitlistView(entry as never) });
    } catch (error) { forward(next, error); }
  });
  router.post("/waitlist/referral", async (req: Request, res: Response, next) => {
    try { const result = await dataSource.getRepository(WaitlistEntry).increment({ referralCode: String(req.body?.referralCode ?? "") }, "referralCount", 1); res.json({ success: true, data: { recorded: Boolean(result.affected) } }); }
    catch (error) { forward(next, error); }
  });

  router.post("/invoices/:id/reports", authenticate, async (req: AuthenticatedRequest, res: Response, next) => {
    try { res.status(201).json({ success: true, data: await service.createFraudReport({ invoiceId: req.params.id, wallet: String(req.user?.stellarAddress ?? ""), reason: String(req.body?.reason ?? ""), detail: String(req.body?.detail ?? "") }) }); }
    catch (error) { forward(next, error); }
  });

  const admin = Router();
  admin.use(authenticate, requireAdmin((process.env.ADMIN_WALLETS ?? "").split(",").map((wallet) => wallet.trim()).filter(Boolean)));
  admin.get("/reports", async (req: Request, res: Response, next) => {
    try { const page = Math.max(1, Number(req.query.page) || 1); const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25)); const [items, total] = await service.listFraudReports(page, pageSize); res.json({ success: true, data: items, pagination: { page, pageSize, total } }); }
    catch (error) { forward(next, error); }
  });
  admin.patch("/reports/:id", async (req: Request, res: Response, next) => {
    try { res.json({ success: true, data: await service.reviewFraudReport(req.params.id, String(req.body?.status) as FraudReportStatus, req.body?.reviewNote) }); }
    catch (error) { forward(next, error); }
  });
  admin.post("/waitlist/:wallet/approve", async (req: Request, res: Response, next) => {
    try { res.json({ success: true, data: await service.approveWaitlist(req.params.wallet) }); }
    catch (error) { forward(next, error); }
  });
  router.use("/admin", admin);
  return router;
}
