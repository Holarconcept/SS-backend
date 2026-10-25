import { StrKey } from "stellar-sdk";
import type { AppLogger } from "../observability/logger";
import { ServiceError } from "../utils/service-error";

export const DEFAULT_QUOTE_ASSET_CODE = "USDC";

export const STELLAR_USDC_ISSUERS = {
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
} as const;

export type StellarNetwork = "mainnet" | "testnet";

export interface CurrencyConversionDependencies {
  horizonUrl: string;
  logger: AppLogger;
  fetchImplementation?: typeof fetch;
  quoteAssetCode?: string;
  quoteAssetIssuer?: string;
  network?: "mainnet" | "testnet" | string;
}

export class CurrencyConversionService {
  private readonly horizonUrl: string;
  private readonly logger: AppLogger;
  private readonly fetchImplementation: typeof fetch;
  readonly quoteAssetCode: string;
  readonly quoteAssetIssuer: string;
  private cachedXlmUsdRate: { rate: number; expiresAt: number } | null = null;
  static readonly RATE_CACHE_TTL_MS = 60_000; // 1 minute cache

  constructor(deps: CurrencyConversionDependencies) {
    if (!deps.horizonUrl || typeof deps.horizonUrl !== "string") {
      throw new ServiceError("INVALID_HORIZON_URL", "horizonUrl is required", 400);
    }
    this.horizonUrl = deps.horizonUrl;
    this.logger = deps.logger;
    this.fetchImplementation = deps.fetchImplementation ?? fetch;

    // Resolve quote asset code
    this.quoteAssetCode =
      deps.quoteAssetCode ??
      process.env.STELLAR_USDC_ASSET_CODE ??
      process.env.QUOTE_ASSET_CODE ??
      DEFAULT_QUOTE_ASSET_CODE;

    if (!this.quoteAssetCode || !/^[A-Za-z0-9]{1,12}$/.test(this.quoteAssetCode)) {
      throw new ServiceError(
        "INVALID_QUOTE_ASSET_CODE",
        `Invalid quote asset code: "${this.quoteAssetCode}". Asset code must be 1 to 12 alphanumeric characters.`,
        400
      );
    }

    // Resolve network
    const networkRaw = (
      deps.network ??
      process.env.STELLAR_NETWORK ??
      (deps.horizonUrl.includes("testnet") ? "testnet" : "mainnet")
    ).toLowerCase();

    const network: StellarNetwork =
      networkRaw === "mainnet" || networkRaw === "public" || networkRaw === "pubnet"
        ? "mainnet"
        : "testnet";

    // Resolve quote asset issuer
    this.quoteAssetIssuer =
      deps.quoteAssetIssuer ??
      process.env.STELLAR_USDC_ASSET_ISSUER ??
      process.env.QUOTE_ASSET_ISSUER ??
      STELLAR_USDC_ISSUERS[network];

    // Validate issuer Stellar public-key encoding at configuration time
    if (!this.quoteAssetIssuer || !StrKey.isValidEd25519PublicKey(this.quoteAssetIssuer)) {
      throw new ServiceError(
        "INVALID_QUOTE_ASSET_ISSUER",
        `Invalid quote asset issuer: "${this.quoteAssetIssuer}". Issuer must be a valid 56-character Stellar public key.`,
        400
      );
    }
  }

  /**
   * Constructs the Horizon order_book query URL using the configured asset code and issuer.
   */
  getOrderBookUrl(): string {
    const buyingAssetType = this.quoteAssetCode.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
    const base = this.horizonUrl.replace(/\/$/, "");
    return `${base}/order_book?selling_asset_type=native&buying_asset_type=${buyingAssetType}&buying_asset_code=${encodeURIComponent(
      this.quoteAssetCode
    )}&buying_asset_issuer=${this.quoteAssetIssuer}`;
  }

  /**
   * Fetches real-time XLM/USD rate from Stellar Horizon or returns cached rate (#586).
   */
  async getXlmUsdRate(): Promise<number> {
    const now = Date.now();
    if (this.cachedXlmUsdRate && this.cachedXlmUsdRate.expiresAt > now) {
      return this.cachedXlmUsdRate.rate;
    }

    try {
      const url = this.getOrderBookUrl();
      const response = await this.fetchImplementation(url);
      if (response.ok) {
        const data = (await response.json()) as { bids?: Array<{ price: string }> };
        if (data.bids && data.bids.length > 0 && data.bids[0]?.price) {
          const rate = parseFloat(data.bids[0].price);
          if (Number.isFinite(rate) && rate > 0) {
            this.cachedXlmUsdRate = { rate, expiresAt: now + CurrencyConversionService.RATE_CACHE_TTL_MS };
            return rate;
          }
        }
      }
    } catch (err) {
      this.logger.warn("Failed to fetch XLM/USD orderbook rate from Horizon, falling back to 0.12", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const fallbackRate = 0.12;
    this.cachedXlmUsdRate = { rate: fallbackRate, expiresAt: now + CurrencyConversionService.RATE_CACHE_TTL_MS };
    return fallbackRate;
  }

  /**
   * Convert amount from XLM to USD or USDC.
   */
  async convertXlmToUsd(xlmAmount: number): Promise<number> {
    if (xlmAmount < 0) throw new ServiceError("INVALID_AMOUNT", "Amount cannot be negative", 400);
    const rate = await this.getXlmUsdRate();
    return Math.round(xlmAmount * rate * 100) / 100;
  }

  /**
   * Convert amount from USD/USDC to XLM.
   */
  async convertUsdToXlm(usdAmount: number): Promise<number> {
    if (usdAmount < 0) throw new ServiceError("INVALID_AMOUNT", "Amount cannot be negative", 400);
    const rate = await this.getXlmUsdRate();
    if (rate === 0) throw new ServiceError("RATE_UNAVAILABLE", "Conversion rate unavailable", 503);
    return Math.round((usdAmount / rate) * 10_000_000) / 10_000_000;
  }
}

export function createCurrencyConversionService(
  deps: CurrencyConversionDependencies
): CurrencyConversionService {
  return new CurrencyConversionService(deps);
}
