import { Request, Response } from "express";
import type { InvoiceService } from "@/services/invoice.service";
import { ServiceError } from "@/utils/service-error";
import { logger } from "@/observability/logger";
import { isValidAdminAuth } from "@/lib/admin-auth-helper";

interface ApproveInvoiceParams {
  id: string;
}

/**
 * POST /api/v1/admin/invoices/:id/approve (issue #468)
 *
 * Admin-only endpoint that approves an invoice under review, moving it from
 * pending to published. Uses the same `x-admin-key` gating as the other
 * admin endpoints; the state machine enforces that only pending invoices can
 * be approved and that they still pass pre-publish validation.
 */
export async function approveInvoice(
  req: Request<ApproveInvoiceParams>,
  res: Response,
  invoiceService: InvoiceService
) {
  try {
    if (!isValidAdminAuth(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const result = await invoiceService.approveInvoice({
      invoiceId: req.params.id,
      actorId: "admin",
    });

    logger.info("Admin invoice review decision", {
      invoice_id: req.params.id,
      decision: "approved",
      decided_at: new Date().toISOString(),
    });

    return res.status(200).json({ success: true, data: result });
  } catch (err: unknown) {
    if (err instanceof ServiceError) {
      return res.status(err.statusCode).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }

    return res.status(500).json({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  }
}
