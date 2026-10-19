import { ipWhitelistMiddleware } from "@/middleware/ip-whitelist.middleware";

describe("ipWhitelistMiddleware", () => {
  const allowedCidrs = ["127.0.0.0/8", "::1/128", "10.0.0.0/8"];

  function makeReq(overrides: Record<string, unknown> = {}) {
    return {
      ip: undefined as string | undefined,
      headers: {} as Record<string, string>,
      socket: { remoteAddress: undefined as string | undefined },
      ...overrides,
    };
  }

  function makeRes() {
    return {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
  }

  function makeNext() {
    return jest.fn();
  }

  it("calls next() when client IP is in the whitelist CIDR", () => {
    const middleware = ipWhitelistMiddleware(allowedCidrs);
    const req = makeReq({ ip: "127.0.0.1" });
    const res = makeRes();
    const next = makeNext();

    middleware(req as never, res as never, next as never);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("calls next() when client IP matches a CIDR in the whitelist", () => {
    const middleware = ipWhitelistMiddleware(["192.168.1.0/24"]);
    const req = makeReq({ ip: "192.168.1.42" });
    const res = makeRes();
    const next = makeNext();

    middleware(req as never, res as never, next as never);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 403 when client IP is not in any whitelisted CIDR", () => {
    const middleware = ipWhitelistMiddleware(allowedCidrs);
    const req = makeReq({ ip: "203.0.113.50" });
    const res = makeRes();
    const next = makeNext();

    middleware(req as never, res as never, next as never);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Access denied: IP address not authorized.",
    });
  });

  it("returns 403 when client IP is undefined and no fallback is available", () => {
    const middleware = ipWhitelistMiddleware(allowedCidrs);
    const req = makeReq({ ip: undefined, socket: { remoteAddress: undefined } });
    const res = makeRes();
    const next = makeNext();

    middleware(req as never, res as never, next as never);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("extracts client IP from X-Forwarded-For header", () => {
    const middleware = ipWhitelistMiddleware(allowedCidrs);
    const req = makeReq({
      headers: { "x-forwarded-for": "127.0.0.1, 70.41.3.18, 150.172.238.178" },
    });
    const res = makeRes();
    const next = makeNext();

    middleware(req as never, res as never, next as never);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 403 when the first IP in X-Forwarded-For is not whitelisted", () => {
    const middleware = ipWhitelistMiddleware(allowedCidrs);
    const req = makeReq({
      headers: { "x-forwarded-for": "203.0.113.50, 127.0.0.1" },
    });
    const res = makeRes();
    const next = makeNext();

    middleware(req as never, res as never, next as never);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("falls back to req.socket.remoteAddress when req.ip is undefined", () => {
    const middleware = ipWhitelistMiddleware(allowedCidrs);
    const req = makeReq({
      ip: undefined,
      socket: { remoteAddress: "::1" },
    });
    const res = makeRes();
    const next = makeNext();

    middleware(req as never, res as never, next as never);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 403 when req.socket.remoteAddress is not in whitelist", () => {
    const middleware = ipWhitelistMiddleware(allowedCidrs);
    const req = makeReq({
      ip: undefined,
      socket: { remoteAddress: "203.0.113.50" },
    });
    const res = makeRes();
    const next = makeNext();

    middleware(req as never, res as never, next as never);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns 403 for an empty allowed CIDRs list", () => {
    const middleware = ipWhitelistMiddleware([]);
    const req = makeReq({ ip: "127.0.0.1" });
    const res = makeRes();
    const next = makeNext();

    middleware(req as never, res as never, next as never);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("works with IPv6 whitelisted addresses", () => {
    const middleware = ipWhitelistMiddleware(["::1/128"]);
    const req = makeReq({ ip: "::1" });
    const res = makeRes();
    const next = makeNext();

    middleware(req as never, res as never, next as never);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns 403 for IPv6 addresses not in the whitelist", () => {
    const middleware = ipWhitelistMiddleware(["::1/128"]);
    const req = makeReq({ ip: "2001:db8::1" });
    const res = makeRes();
    const next = makeNext();

    middleware(req as never, res as never, next as never);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
