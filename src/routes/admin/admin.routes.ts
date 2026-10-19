import { Router } from "express";
import { DataSource } from "typeorm";
import { Request, Response, NextFunction } from "express";

import { ipWhitelistMiddleware } from "@/middleware/ip-whitelist.middleware";
import { createAuthMiddleware, requireAdmin } from "@/middleware/auth.middleware";
import { User } from "@/models/User.model";
import { requireAdminRole } from "@/middleware/require-admin-role.middleware";
import type { AuthService } from "@/services/auth.service";
import type { AclService } from "@/services/acl.service";
import type { InvoiceService } from "@/services/invoice.service";
import type { AdminUserService } from "@/services/admin-user.service";
import { createAdminUsersRouter } from "./users.routes";
import type { InvoiceExtensionService } from "@/services/invoice-extension.service";
import type { AdminMetricsService, AdminMetricsQuery } from "@/services/admin-metrics.service";
import type { AdminSettlementService } from "@/services/admin-settlement.service";
import type { InvoiceEscrowContractService } from "@/services/stellar/invoice-escrow-contract.service";
import type { FeeScheduleService } from "@/services/fee-schedule.service";
import { approveKYC } from "./approve-kyc";
import { rejectKYC } from "./reject-kyc";
import { revokeKYC } from "./revoke-kyc";
import { approveInvoice } from "./approve-invoice";
import { rejectInvoice } from "./reject-invoice";
import { createAclController } from "./acl";
import { createRoyaltyAnalyticsService } from "@/services/royalty-analytics.service";
import { createAdminRoyaltiesRouter } from "./royalties.routes";
import { createAnalyticsSnapshotService } from "@/services/analytics-snapshot.service";
import { createAdminAnalyticsTrendsRouter } from "./analytics-trends.routes";
import { createAdminSettlementRouter } from "./settlement.routes";
import { createAdminFeesRouter } from "./fees.routes";
import { createWaitlistRouter } from "./waitlist.routes";
import { AppError } from "@/utils/http-error";
import { logger } from "@/observability/logger";
import type { AuthenticatedRequest } from "@/types/auth";
import { listInvoices } from "./list-invoices";
import { reviewInvoice } from "./review-invoice";
import type { WaitlistService } from "@/services/waitlist.service";
import { createWaitlistService } from "@/services/waitlist.service";

export interface AdminRouterDependencies {
  dataSource: DataSource;
  allowedCidrs: string[];
  authService: AuthService;
  aclService?: AclService;
  invoiceService?: InvoiceService;
  /** Optional: enables the /users management endpoints (admin JWT required). */
  adminUserService?: AdminUserService;
  extensionService?: InvoiceExtensionService;
  /** Issue #478 — platform metrics aggregation for the admin dashboard. */
  metricsService?: AdminMetricsService;
  /** Optional: enables POST /invoices/:invoiceId/settle for admin settlement. */
  adminSettlementService?: AdminSettlementService;
  adminWallets?: string[];
  invoiceEscrowContractService?: InvoiceEscrowContractService;
  feeScheduleService?: FeeScheduleService;
  /** Optional: enables waitlist management endpoints (issue #599) */
  waitlistService?: WaitlistService;
  notificationService?: import("@/services/notification.service").NotificationService;
}

interface ExtensionReviewBody {
  decision?: string;
  reviewNote?: string;
}

/**
 * Parses an optional ISO 8601 date boundary, rejecting garbage rather than
 * silently widening or emptying the reporting window.
 */
function parseDateBoundary(raw: unknown, field: string): Date | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = new Date(String(raw));
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(400, `Invalid '${field}' date format. Use ISO 8601.`, "INVALID_DATE");
  }
  return parsed;
}

/**
 * Defers building a sub-router until it is actually requested.
 *
 * The analytics projections are only needed by their own endpoints, so
 * constructing them on the first request keeps the admin router mountable
 * without a live database connection.
 */
function lazyRouter(create: () => Router): Router {
  const router = Router();
  let delegate: Router | null = null;

  router.use((req: Request, res: Response, next: NextFunction) => {
    delegate ??= create();
    delegate(req, res, next);
  });

  return router;
}

export function createAdminRouter({
  dataSource,
  allowedCidrs,
  authService,
  aclService,
  invoiceService,
  adminUserService,
  extensionService: _extensionService,
  metricsService: _metricsService,
  adminSettlementService,
  adminWallets = [],
  invoiceEscrowContractService,
  feeScheduleService,
  waitlistService: _waitlistService,
  notificationService: _notificationService
}: AdminRouterDependencies): Router {
  const router = Router();

  // ---- Gate 1: IP whitelist (issue #478) ----
  // With no CIDRs configured the gate is open, so an unconfigured deployment
  // behaves like a normal router instead of rejecting every admin call.
  if (allowedCidrs.length > 0) {
    router.use(ipWhitelistMiddleware(allowedCidrs));
  }

  // ---- Gate 2: admin role on the JWT (issue #543) ----
  // The analytics and metrics routers below have no handler-level credential
  // check of their own, so without this the IP whitelist would be the only
  // thing standing between a caller and the platform's numbers. A valid
  // `x-admin-key` still passes, which keeps the older KYC and invoice review
  // flows working exactly as they did before this gate existed.
  const requireAdminRoleMiddleware = requireAdminRole();
  router.use((req: Request, res: Response, next: NextFunction): void => {
    const adminKey = req.headers["x-admin-key"];
    if (adminKey && adminKey === process.env.ADMIN_API_KEY) {
      next();
      return;
    }

    const authMiddleware = createAuthMiddleware(authService);
    authMiddleware(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      requireAdminRoleMiddleware(req, res, next);
    });
  });

  router.post("/approve-kyc", (req, res) => {
    approveKYC(req, res, dataSource);
  });

  router.post("/reject-kyc", (req, res) => {
    rejectKYC(req, res, dataSource);
  });

  router.post("/revoke-kyc", (req, res) => {
    revokeKYC(req, res, dataSource);
  });

  if (invoiceService) {
    // Legacy x-admin-key routes
    router.post("/invoices/:id/approve", (req, res) => {
      approveInvoice(req, res, invoiceService);
    });

    router.post("/invoices/:id/reject", (req, res) => {
      rejectInvoice(req, res, invoiceService);
    });

    // New JWT-authenticated admin routes for invoices
    if (authService) {
      const authenticateJWT = createAuthMiddleware(authService);
      const requireAdminJWT = requireAdmin(adminWallets);

      router.get(
        "/invoices",
        authenticateJWT,
        requireAdminJWT,
        (req, res) => {
          listInvoices(req, res, invoiceService);
        }
      );

      router.patch(
        "/invoices/:invoiceId",
        authenticateJWT,
        requireAdminJWT,
        (req, res) => {
          reviewInvoice(req, res, invoiceService, invoiceEscrowContractService, async (sellerId) => {
            const seller = await dataSource.getRepository(User).findOne({ where: { id: sellerId } });
            return seller?.stellarAddress ?? "UNKNOWN";
          });
        }
      );
    }
  }

  // ---- Admin user management (role assignment, suspension) ----
  if (adminUserService) {
    router.use("/users", createAdminUsersRouter(adminUserService, authService));
  }

  // ---- Integration ACL projected from ACLUpdated events ----
  if (aclService) {
    const acl = createAclController(aclService);
    router.get("/acl", acl.getAcl);
    router.get("/acl/log", acl.getAclLog);
  }

  // ---- Platform metrics (issue #478) ----
  if (_metricsService) {
    router.get("/metrics", async (req: Request, res: Response, next: NextFunction) => {
      try {
        const query: AdminMetricsQuery = {
          from: parseDateBoundary(req.query.from, "from"),
          to: parseDateBoundary(req.query.to, "to"),
        };
        const metrics = await _metricsService.getMetrics(query);
        res.status(200).json({ success: true, data: metrics });
      } catch (error) {
        next(error);
      }
    });
  }

  // ---- Invoice deadline extension review ----
  if (_extensionService) {
    router.post(
      "/invoices/:invoiceId/extensions/:requestId/review",
      async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        try {
          const body = (req.body ?? {}) as ExtensionReviewBody;
          const decision = String(body.decision ?? "");
          if (decision !== "approve" && decision !== "reject") {
            next(
              new AppError(
                400,
                "'decision' must be either 'approve' or 'reject'.",
                "INVALID_EXTENSION_DECISION"
              )
            );
            return;
          }

          const reviewedBy = req.user?.stellarAddress ?? "admin";
          const result = await _extensionService.reviewExtension({
            invoiceId: String(req.params.invoiceId),
            requestId: String(req.params.requestId),
            decision,
            reviewedBy,
            reviewNote: body.reviewNote ? String(body.reviewNote) : null,
          });

          logger.info("Admin reviewed invoice deadline extension", {
            invoice_id: String(req.params.invoiceId),
            request_id: String(req.params.requestId),
            decision,
            reviewed_by: reviewedBy,
          });

          res.status(200).json({ success: true, data: result.request });
        } catch (error) {
          logger.error("Admin extension review failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          next(error);
        }
      }
    );
  }

  // ---- Royalty analytics (GET /admin/royalties/analytics) ----
  router.use(
    "/royalties",
    lazyRouter(() => {
      const royaltyAnalyticsService = createRoyaltyAnalyticsService(dataSource);
      return createAdminRoyaltiesRouter({ royaltyAnalyticsService });
    })
  );

  // ---- Analytics trends / daily snapshots (GET /admin/analytics/trends) ----
  router.use(
    "/analytics",
    lazyRouter(() => {
      const analyticsSnapshotService = createAnalyticsSnapshotService(dataSource);
      return createAdminAnalyticsTrendsRouter({ analyticsSnapshotService });
    })
  );

  if (adminSettlementService) {
    router.use("/", createAdminSettlementRouter({ adminSettlementService }));
  }

  // ---- Fee schedule management (issue #592) ----
  if (feeScheduleService) {
    router.use("/", createAdminFeesRouter(feeScheduleService));
  }

  // ---- Waitlist management (issue #599) ----
  if (_waitlistService) {
    router.use(
      "/waitlist",
      createWaitlistRouter(dataSource, _waitlistService, authService, _notificationService)
    );
  }

  return router;
}
