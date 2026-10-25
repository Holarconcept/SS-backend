import crypto from "crypto";
import type { IncomingHttpHeaders } from "http";
import type { AuthenticatedRequest } from "@/types/auth";

/**
 * Timing-safe string comparison (#607).
 */
export function isTimingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Validates admin authentication via either valid admin JWT or x-admin-key (#607, #608).
 */
export function isValidAdminAuth(req: { headers: IncomingHttpHeaders; user?: unknown }): boolean {
  const authReq = req as AuthenticatedRequest;
  if (authReq.user && authReq.user.role === "admin") {
    return true;
  }

  const suppliedKey = req.headers["x-admin-key"];
  const expectedKey = process.env.ADMIN_API_KEY;

  if (typeof suppliedKey === "string" && typeof expectedKey === "string" && expectedKey.length > 0) {
    if (expectedKey === "dev-admin-key" && process.env.NODE_ENV === "production") {
      return false; // Reject weak default keys in production
    }
    return isTimingSafeEqual(suppliedKey, expectedKey);
  }

  return false;
}
