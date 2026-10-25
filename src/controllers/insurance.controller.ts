import { Request, Response } from "express";
import { InvoiceInsuranceService } from "../services/invoice-insurance.service";

/**
 * #680 — Invoice insurance REST API endpoints.
 */
export class InsuranceController {
  constructor(private readonly insuranceService: InvoiceInsuranceService) {}

  getInvoiceInsurance = async (req: Request, res: Response) => {
    try {
      const invoiceId = String(req.params.invoiceId);
      const wallet = String(req.params.wallet);
      const result = await this.insuranceService.getInvoiceInsurance(invoiceId, wallet);
      if (!result) {
        return res.status(404).json({ error: { code: "NOT_FOUND", message: "Insurance policy not found" } });
      }
      return res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      return res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
    }
  };

  getWalletPolicies = async (req: Request, res: Response) => {
    try {
      const wallet = String(req.params.wallet);
      const result = await this.insuranceService.getWalletActivePolicies(wallet);
      return res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      return res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
    }
  };

  getWalletPayoutHistory = async (req: Request, res: Response) => {
    try {
      const wallet = String(req.params.wallet);
      const result = await this.insuranceService.getWalletPayoutHistory(wallet);
      return res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      return res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
    }
  };
}
