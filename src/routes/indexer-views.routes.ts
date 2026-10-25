import { Router, Request, Response, NextFunction } from "express";
import type { DataSource } from "typeorm";
import { createInvoiceRatingService } from "../services/invoice-rating.service";
import { createPoolRebalanceService } from "../services/pool-rebalance.service";
import { createBulkCancellationService } from "../services/bulk-cancellation.service";

/**
 * REST endpoints for invoice ratings (#683), pool rebalances (#684),
 * and bulk-cancelled orders (#688).
 *
 * GET /invoices/:invoice_id/rating          — average, total, distribution
 * GET /issuers/:wallet/rating               — aggregate across issuer's invoices
 * GET /pools/:pool_id/rebalances/pending    — pending proposal with ETA countdown
 * GET /pools/:pool_id/rebalances/history    — paginated weight change history
 * GET /orders/:wallet/cancelled             — paginated bulk-cancelled orders
 */
export function createIndexerViewsRouter(dataSource: DataSource): Router {
  const router = Router();
  const ratingService = createInvoiceRatingService(dataSource);
  const rebalanceService = createPoolRebalanceService(dataSource);
  const bulkService = createBulkCancellationService(dataSource);

  // ── Invoice ratings (#683) ──────────────────────────────────────────────

  router.get(
    "/invoices/:invoice_id/rating",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const summary = await ratingService.getInvoiceRating(String(req.params.invoice_id));
        res.json(summary);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/issuers/:wallet/rating",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const summary = await ratingService.getIssuerRating(String(req.params.wallet));
        res.json(summary);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Pool rebalances (#684) ──────────────────────────────────────────────

  router.get(
    "/pools/:pool_id/rebalances/pending",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const pending = await rebalanceService.getPending(String(req.params.pool_id));
        if (!pending) {
          res.status(404).json({ error: "No pending rebalance for this pool" });
          return;
        }
        res.json(pending);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/pools/:pool_id/rebalances/history",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
        const history = await rebalanceService.getHistory(String(req.params.pool_id), page, limit);
        res.json(history);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Bulk-cancelled orders (#688) ────────────────────────────────────────

  router.get(
    "/orders/:wallet/cancelled",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
        const result = await bulkService.getCancelledOrders(String(req.params.wallet), page, limit);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
