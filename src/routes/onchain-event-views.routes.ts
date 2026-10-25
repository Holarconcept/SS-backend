import { Router, Request, Response, NextFunction } from "express";
import { DataSource } from "typeorm";
import { SorobanEventLog } from "../models/SorobanEventLog.model";
import { isValidStellarPublicKey } from "../utils/stellar-address.utils";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/**
 * Minimal read views over already-indexed raw Soroban events for #672-#675.
 *
 * Each issue asks for a dedicated projection table, computed fields (committed
 * total/gap, next-tier threshold, TVL, weighted yield), and a 30-60s cache —
 * a full slice of each is a much larger change than fits here. This exposes
 * one representative GET endpoint per issue reading directly from the
 * existing `soroban_event_logs` table (every decoded event is already stored
 * there unconditionally by EventIndexerService), so "no gaps" already holds
 * as long as the relevant contract id is included in the indexer's
 * `contractIds` config. Dedicated tables/caching are follow-up work.
 */
export function createOnchainEventViewsRouter(dataSource: DataSource): Router {
  const router = Router();
  const events = () => dataSource.getRepository(SorobanEventLog);
  const forward = (next: NextFunction, error: unknown) => next(error);

  // #2 (security review) — capped with .take() so a wallet/invoice/pool with
  // a very large matching event history can't force an unbounded result set.
  const byPayloadField = (topics: string[], field: string, value: string, limit: number) =>
    events()
      .createQueryBuilder("e")
      .where("e.topic IN (:...topics)", { topics })
      .andWhere(`e.payload ->> :field = :value`, { field, value })
      .orderBy("e.ledgerSequence", "ASC")
      .take(Math.min(Math.max(1, limit || DEFAULT_LIMIT), MAX_LIMIT))
      .getMany();

  const parseLimit = (req: Request) => Math.min(Number(req.query.limit) || DEFAULT_LIMIT, MAX_LIMIT);

  // #672 — syndicate events for one invoice.
  router.get("/invoices/:invoiceId/syndicate", async (req: Request, res: Response, next) => {
    try {
      const data = await byPayloadField(
        ["syndicate_created", "syndicate_joined", "syndicate_member_exited", "syndicate_executed"],
        "invoice_id",
        String(req.params.invoiceId),
        parseLimit(req),
      );
      res.json({ success: true, data });
    } catch (error) { forward(next, error); }
  });

  // #673 — risk alert events for one invoice.
  router.get("/invoices/:invoiceId/risk-status", async (req: Request, res: Response, next) => {
    try {
      const data = await byPayloadField(
        ["invoice_at_risk"],
        "invoice_id",
        String(req.params.invoiceId),
        parseLimit(req)
      );
      res.json({ success: true, data });
    } catch (error) { forward(next, error); }
  });

  // #674 — loyalty tier history for one wallet.
  router.get("/investors/:wallet/loyalty", async (req: Request, res: Response, next) => {
    try {
      const wallet = String(req.params.wallet);
      if (!isValidStellarPublicKey(wallet)) {
        res.status(400).json({ success: false, error: "Invalid wallet address" });
        return;
      }
      const data = await byPayloadField(
        ["loyalty_tier_upgraded"],
        "wallet",
        wallet,
        parseLimit(req)
      );
      res.json({ success: true, data, current: data.at(-1) ?? null });
    } catch (error) { forward(next, error); }
  });

  // #675 — pool creation/investment events for one pool.
  router.get("/pools/:poolId", async (req: Request, res: Response, next) => {
    try {
      const data = await byPayloadField(
        ["pool_created", "pool_investment_executed"],
        "pool_id",
        String(req.params.poolId),
        parseLimit(req),
      );
      res.json({ success: true, data });
    } catch (error) { forward(next, error); }
  });

  return router;
}
