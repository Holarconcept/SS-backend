import { Router } from "express";
import { BenchmarkController } from "../controllers/benchmark.controller";
import type { BenchmarkService } from "../services/benchmark.service";

export interface BenchmarkRouterDependencies {
  benchmarkService: BenchmarkService;
}

export function createBenchmarkRouter({
  benchmarkService,
}: BenchmarkRouterDependencies): Router {
  const router = Router();
  const controller = new BenchmarkController(benchmarkService);

  // GET /api/v1/benchmarks/:sector — sector benchmark averages (#676)
  router.get("/:sector", controller.getSectorBenchmark);

  return router;
}

/**
 * Invoice-scoped benchmark + boost routes (#676, #678). Mounted under
 * `/api/v1/invoices` alongside the existing invoice router.
 */
export function createInvoiceBenchmarkRouter({
  benchmarkService,
}: BenchmarkRouterDependencies): Router {
  const router = Router();
  const controller = new BenchmarkController(benchmarkService);

  // GET /api/v1/invoices/:invoiceId/benchmark — invoice vs sector benchmark
  router.get("/:invoiceId/benchmark", controller.getInvoiceBenchmark);

  return router;
}
