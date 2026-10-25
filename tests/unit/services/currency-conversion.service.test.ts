import {
  CurrencyConversionService,
  STELLAR_USDC_ISSUERS,
  DEFAULT_QUOTE_ASSET_CODE,
} from "../../../src/services/currency-conversion.service";
import { ServiceError } from "../../../src/utils/service-error";
import type { AppLogger } from "../../../src/observability/logger";

describe("CurrencyConversionService - Quote Asset Issuer Fix (#586 follow-up)", () => {
  let mockLogger: AppLogger;

  // Known valid 56-character public key fixtures
  const VALID_MAINNET_ISSUER = STELLAR_USDC_ISSUERS.mainnet; // GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
  const VALID_TESTNET_ISSUER = STELLAR_USDC_ISSUERS.testnet; // GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
  const TRUNCATED_INVALID_ISSUER = "GA5ZSEEX23J59UQ8Y47XM2GQ7X25NOX7MB6M23F4OB3A"; // 44 chars, invalid StrKey

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as AppLogger;
  });

  describe("Configuration and Validation", () => {
    it("rejects the existing truncated 44-character issuer at configuration time", () => {
      expect(() => {
        new CurrencyConversionService({
          horizonUrl: "https://horizon-testnet.stellar.org",
          logger: mockLogger,
          quoteAssetIssuer: TRUNCATED_INVALID_ISSUER,
        });
      }).toThrow(ServiceError);

      try {
        new CurrencyConversionService({
          horizonUrl: "https://horizon-testnet.stellar.org",
          logger: mockLogger,
          quoteAssetIssuer: TRUNCATED_INVALID_ISSUER,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceError);
        const serviceError = err as ServiceError;
        expect(serviceError.code).toBe("INVALID_QUOTE_ASSET_ISSUER");
        expect(serviceError.message).toContain("valid 56-character Stellar public key");
      }
    });

    it("rejects invalid issuer public keys (bad checksum, secret key, malformed)", () => {
      const invalidKeys = [
        "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA9", // Bad checksum
        "SBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", // Secret key
        "not-a-stellar-key",
        "",
      ];

      for (const invalidKey of invalidKeys) {
        expect(() => {
          new CurrencyConversionService({
            horizonUrl: "https://horizon-testnet.stellar.org",
            logger: mockLogger,
            quoteAssetIssuer: invalidKey,
          });
        }).toThrow(ServiceError);
      }
    });

    it("rejects invalid quote asset codes", () => {
      const invalidCodes = ["", "WAYTOOLONGASSETCODE123", "BAD@CODE", "TOOLONG1234567"];

      for (const code of invalidCodes) {
        expect(() => {
          new CurrencyConversionService({
            horizonUrl: "https://horizon-testnet.stellar.org",
            logger: mockLogger,
            quoteAssetCode: code,
          });
        }).toThrow(ServiceError);
      }
    });

    it("accepts known valid public issuer fixtures at configuration time", () => {
      const serviceMainnet = new CurrencyConversionService({
        horizonUrl: "https://horizon.stellar.org",
        logger: mockLogger,
        quoteAssetIssuer: VALID_MAINNET_ISSUER,
      });
      expect(serviceMainnet.quoteAssetIssuer).toBe(VALID_MAINNET_ISSUER);

      const serviceTestnet = new CurrencyConversionService({
        horizonUrl: "https://horizon-testnet.stellar.org",
        logger: mockLogger,
        quoteAssetIssuer: VALID_TESTNET_ISSUER,
      });
      expect(serviceTestnet.quoteAssetIssuer).toBe(VALID_TESTNET_ISSUER);
    });

    it("selects the supported quote-asset issuer for mainnet and testnet automatically", () => {
      const mainnetService = new CurrencyConversionService({
        horizonUrl: "https://horizon.stellar.org",
        logger: mockLogger,
        network: "mainnet",
      });
      expect(mainnetService.quoteAssetIssuer).toBe(VALID_MAINNET_ISSUER);
      expect(mainnetService.quoteAssetCode).toBe(DEFAULT_QUOTE_ASSET_CODE);

      const testnetService = new CurrencyConversionService({
        horizonUrl: "https://horizon-testnet.stellar.org",
        logger: mockLogger,
        network: "testnet",
      });
      expect(testnetService.quoteAssetIssuer).toBe(VALID_TESTNET_ISSUER);
      expect(testnetService.quoteAssetCode).toBe(DEFAULT_QUOTE_ASSET_CODE);
    });

    it("infers testnet from horizonUrl when network is not explicitly passed", () => {
      const service = new CurrencyConversionService({
        horizonUrl: "https://horizon-testnet.stellar.org",
        logger: mockLogger,
      });
      expect(service.quoteAssetIssuer).toBe(VALID_TESTNET_ISSUER);
    });
  });

  describe("Order-Book Request Construction", () => {
    it("constructs the order_book query using the complete issuer and expected quote asset", () => {
      const service = new CurrencyConversionService({
        horizonUrl: "https://horizon.stellar.org/",
        logger: mockLogger,
        quoteAssetCode: "USDC",
        quoteAssetIssuer: VALID_MAINNET_ISSUER,
      });

      const url = service.getOrderBookUrl();
      expect(url).toBe(
        `https://horizon.stellar.org/order_book?selling_asset_type=native&buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer=${VALID_MAINNET_ISSUER}`
      );
      expect(url).not.toContain(TRUNCATED_INVALID_ISSUER);
    });

    it("uses credit_alphanum12 for asset codes longer than 4 characters", () => {
      const service = new CurrencyConversionService({
        horizonUrl: "https://horizon-testnet.stellar.org",
        logger: mockLogger,
        quoteAssetCode: "USDCOIN",
        quoteAssetIssuer: VALID_TESTNET_ISSUER,
      });

      const url = service.getOrderBookUrl();
      expect(url).toContain("buying_asset_type=credit_alphanum12");
      expect(url).toContain("buying_asset_code=USDCOIN");
      expect(url).toContain(`buying_asset_issuer=${VALID_TESTNET_ISSUER}`);
    });
  });

  describe("Live Rate Lookup vs Fallback", () => {
    it("successful order-book response produces its live price rather than the fallback", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          bids: [
            { price: "0.1450000", amount: "1000.0000000" },
            { price: "0.1440000", amount: "2000.0000000" },
          ],
        }),
      });

      const service = new CurrencyConversionService({
        horizonUrl: "https://horizon.stellar.org",
        logger: mockLogger,
        quoteAssetIssuer: VALID_MAINNET_ISSUER,
        fetchImplementation: mockFetch as unknown as typeof fetch,
      });

      const rate = await service.getXlmUsdRate();

      expect(rate).toBe(0.145);
      expect(rate).not.toBe(0.12); // Fallback is 0.12
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(service.getOrderBookUrl());
    });

    it("caches live rate and avoids repeat fetch calls within cache TTL", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          bids: [{ price: "0.1500000" }],
        }),
      });

      const service = new CurrencyConversionService({
        horizonUrl: "https://horizon.stellar.org",
        logger: mockLogger,
        quoteAssetIssuer: VALID_MAINNET_ISSUER,
        fetchImplementation: mockFetch as unknown as typeof fetch,
      });

      const rate1 = await service.getXlmUsdRate();
      const rate2 = await service.getXlmUsdRate();

      expect(rate1).toBe(0.15);
      expect(rate2).toBe(0.15);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Cached
    });

    it("falls back to 0.12 when Horizon request fails", async () => {
      const mockFetch = jest.fn().mockRejectedValue(new Error("Network timeout"));

      const service = new CurrencyConversionService({
        horizonUrl: "https://horizon.stellar.org",
        logger: mockLogger,
        quoteAssetIssuer: VALID_MAINNET_ISSUER,
        fetchImplementation: mockFetch as unknown as typeof fetch,
      });

      const rate = await service.getXlmUsdRate();

      expect(rate).toBe(0.12);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch XLM/USD orderbook rate from Horizon"),
        expect.any(Object)
      );
    });

    it("falls back to 0.12 when Horizon returns empty bids", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ bids: [] }),
      });

      const service = new CurrencyConversionService({
        horizonUrl: "https://horizon.stellar.org",
        logger: mockLogger,
        quoteAssetIssuer: VALID_MAINNET_ISSUER,
        fetchImplementation: mockFetch as unknown as typeof fetch,
      });

      const rate = await service.getXlmUsdRate();
      expect(rate).toBe(0.12);
    });
  });

  describe("Currency Conversion Calculations", () => {
    it("converts XLM to USD accurately using live rate", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          bids: [{ price: "0.2000000" }],
        }),
      });

      const service = new CurrencyConversionService({
        horizonUrl: "https://horizon.stellar.org",
        logger: mockLogger,
        quoteAssetIssuer: VALID_MAINNET_ISSUER,
        fetchImplementation: mockFetch as unknown as typeof fetch,
      });

      // 500 XLM at $0.20/XLM = $100.00
      const usd = await service.convertXlmToUsd(500);
      expect(usd).toBe(100);
    });

    it("converts USD to XLM accurately using live rate", async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          bids: [{ price: "0.2000000" }],
        }),
      });

      const service = new CurrencyConversionService({
        horizonUrl: "https://horizon.stellar.org",
        logger: mockLogger,
        quoteAssetIssuer: VALID_MAINNET_ISSUER,
        fetchImplementation: mockFetch as unknown as typeof fetch,
      });

      // $100 USD at $0.20/XLM = 500 XLM
      const xlm = await service.convertUsdToXlm(100);
      expect(xlm).toBe(500);
    });

    it("throws ServiceError for negative conversion amounts", async () => {
      const service = new CurrencyConversionService({
        horizonUrl: "https://horizon.stellar.org",
        logger: mockLogger,
        quoteAssetIssuer: VALID_MAINNET_ISSUER,
      });

      await expect(service.convertXlmToUsd(-10)).rejects.toMatchObject({
        code: "INVALID_AMOUNT",
      });
      await expect(service.convertUsdToXlm(-10)).rejects.toMatchObject({
        code: "INVALID_AMOUNT",
      });
    });
  });
});
