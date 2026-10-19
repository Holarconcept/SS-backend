import { Request, Response } from "express";
import type { BenchmarkService } from "../services/benchmark.service";

export class BenchmarkController {
  constructor(private readonly benchmarkService: BenchmarkService) {}

  /** GET /api/v1/benchmarks/:sector */
  getSectorBenchmark = async (req: Request, res: Response) => {
    try {
      const sector = req.params.sector;
      const benchmark = await this.benchmarkService.getSectorBenchmark(sector);
      return res.status(200).json({ success: true, data: benchmark });
    } catch (err: unknown) {
      return sendError(res, err);
    }
  };

  /** GET /api/v1/invoices/:invoiceId/benchmark */
  getInvoiceBenchmark = async (req: Request, res: Response) => {
    try {
      const invoiceId = req.params.invoiceId ?? (req.params as Record<string, string>).invoice_id;
      const comparison = await this.benchmarkService.getInvoiceBenchmark(invoiceId);
      return res.status(200).json({ success: true, data: comparison });
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
