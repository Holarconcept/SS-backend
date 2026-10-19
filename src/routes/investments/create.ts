import type { Response } from "express";
import { requireApprovedKyc } from "@/lib/kyc";
import type { AuthenticatedRequest } from "@/types/auth";

export async function createInvestment(req: AuthenticatedRequest, res: Response) {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    requireApprovedKyc(user);

    return res.status(201).json({ success: true });
  } catch (err: unknown) {
    const appErr = err as { status?: number; code?: string; message?: string };
    return res.status(appErr.status ?? 500).json({
      error: {
        code: appErr.code ?? "INTERNAL_ERROR",
        message: appErr.message ?? "Internal server error",
      },
    });
  }
}
