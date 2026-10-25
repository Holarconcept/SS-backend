import type { NextFunction, Request, Response } from "express";
import ipRangeCheck from "ip-range-check";

export function ipWhitelistMiddleware(allowedCidrs: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const clientIp = req.ip || req.socket.remoteAddress;

    if (!clientIp || !ipRangeCheck(clientIp, allowedCidrs)) {
      res.status(403).json({
        error: "Access denied: IP address not authorized.",
      });
      return;
    }

    next();
  };
}
