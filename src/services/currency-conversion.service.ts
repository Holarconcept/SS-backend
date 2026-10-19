import type { AppLogger } from "../observability/logger";
import { ServiceError } from "../utils/service-error";

export interface CurrencyConversionDependencies {
  horizonUrl: string;
  logger: AppLogger;
  fetchImplementation?: typeof fetch;
}

export class CurrencyConversionService {
  private readonly horizonUrl: string;
  private readonly logger: AppLogger;
  private readonly fetchImplementation: typeof fetch;
  private cachedXlmUsdRate: { rate: number; expiresAt: number } | null = null;
  private static readonly RATE_CACHE_TTL_MS = 60_000; // 1 minute cache

  constructor(deps: CurrencyConversionDependencies) {
    this.horizonUrl = deps.horizonUrl;
    this.logger = deps.logger;
    this.fetchImplementation = deps.fetchImplementation ?? fetch;
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
      const url = `${this.horizonUrl.replace(/\/$/, "")}/order_book?selling_asset_type=native&buying_asset_type=credit_alphanum4&buying_asset_code=USDC&buying_asset_issuer=GA5ZSEEX23J59UQ8Y47XM2GQ7X25NOX7MB6M23F4OB3A`;
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
