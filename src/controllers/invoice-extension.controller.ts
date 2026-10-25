import { Request, Response } from "express";
import { ExtensionProposalService } from "../services/extension-proposal.service";

/**
 * #681 — Invoice extension proposal REST API endpoints.
 */
export class InvoiceExtensionController {
  constructor(private readonly extensionService: ExtensionProposalService) {}

  getActiveProposal = async (req: Request, res: Response) => {
    try {
      const invoiceId = String(req.params.invoiceId);
      const result = await this.extensionService.getActiveProposal(invoiceId);
      return res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      return res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
    }
  };

  getWalletVote = async (req: Request, res: Response) => {
    try {
      const invoiceId = String(req.params.invoiceId);
      const wallet = String(req.params.wallet);
      const result = await this.extensionService.getWalletVote(invoiceId, wallet);
      return res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      return res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
    }
  };

  getProposalHistory = async (req: Request, res: Response) => {
    try {
      const invoiceId = String(req.params.invoiceId);
      const result = await this.extensionService.getProposalHistory(invoiceId);
      return res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      return res.status(500).json({ error: { code: "INTERNAL", message: (err as Error).message } });
    }
  };
}
