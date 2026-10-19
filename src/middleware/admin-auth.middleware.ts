import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import { HttpError } from "@/utils/http-error";
import { buildAuthFailureDetails, classifyJwtError } from "@/lib/auth-failure";
import type { AuthenticatedRequest } from "@/types/auth";
import { UserType, KYCStatus } from "@/types/enums";

interface AdminTokenPayload {
  sub: string;
  role: "admin";
  iat?: number;
  exp?: number;
}

export function authenticateAdminJWT(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    next(
      new HttpError(
        401,
        "Admin authorization token is required.",
        buildAuthFailureDetails(undefined, "missing_token")
      )
    );
    return;
  }

  const token = authHeader.slice(7);

  try {
    const secret = process.env.ADMIN_JWT_SECRET ?? process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET missing");

    const payload = jwt.verify(token, secret) as AdminTokenPayload;

    if (payload.role !== "admin") {
      next(
        new HttpError(
          403,
          "Admin role required.",
          buildAuthFailureDetails(token, "insufficient_role")
        )
      );
      return;
    }

    (req as AuthenticatedRequest).user = {
      id: payload.sub,
      stellarAddress: payload.sub,
      email: null,
      userType: UserType.BOTH,
      kycStatus: KYCStatus.APPROVED,
      isKycVerified: true,
      createdAt: new Date(payload.iat ? payload.iat * 1000 : Date.now()),
      updatedAt: new Date(),
    };

    (req as AuthenticatedRequest).user!.role = "admin";

    next();
  } catch (error) {
    next(
      new HttpError(
        401,
        "Invalid or expired admin token.",
        buildAuthFailureDetails(token, classifyJwtError(error))
      )
    );
  }
}