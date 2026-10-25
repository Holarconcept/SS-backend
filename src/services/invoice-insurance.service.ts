import { DataSource } from "typeorm";
import { TtlCache } from "../lib/ttl-cache";

export interface InsurancePolicy {
  invoiceId: string;
  wallet: string;
  isActive: boolean;
  coverageBps: number;
  premiumPaid: string;
  expiry: number;
  purchasedAt: number;
}

export interface InsurancePayout {
  invoiceId: string;
  wallet: string;
  amount: string;
  triggerDate: number;
  txHash: string;
}

export interface InvoiceInsuranceResponse {
  isActive: boolean;
  coverageBps: number;
  premiumPaid: string;
  expiry: number;
}

interface InvoiceInsuranceRow {
  is_active: boolean;
  coverage_bps: number;
  premium_paid: string;
  expiry: number;
}

interface InsurancePolicyRow extends InvoiceInsuranceRow {
  invoice_id: string;
  wallet: string;
  purchased_at: number;
}

interface InsurancePayoutRow {
  invoice_id: string;
  wallet: string;
  amount: string;
  trigger_date: number;
  tx_hash: string;
}

/**
 * #680 — Invoice insurance indexer and policy status REST API.
 * Indexes InsurancePurchased and InsurancePayoutTriggered events.
 */
export class InvoiceInsuranceService {
  private cache: TtlCache;

  constructor(private readonly dataSource: DataSource) {
    this.cache = new TtlCache({ ttlSeconds: 60, namespace: "insurance" });
  }

  async getInvoiceInsurance(invoiceId: string, wallet: string): Promise<InvoiceInsuranceResponse | null> {
    const cacheKey = `invoice:${invoiceId}:${wallet}`;
    const cached = await this.cache.get<InvoiceInsuranceResponse>(cacheKey);
    if (cached) return cached;

    const row = (await this.dataSource.query(
      `SELECT is_active, coverage_bps, premium_paid, expiry
       FROM invoice_insurance WHERE invoice_id = $1 AND wallet = $2`,
      [invoiceId, wallet],
    )) as InvoiceInsuranceRow[];

    if (!row.length) return null;

    const result = {
      isActive: row[0].is_active,
      coverageBps: row[0].coverage_bps,
      premiumPaid: row[0].premium_paid,
      expiry: row[0].expiry,
    };

    await this.cache.set(cacheKey, result);
    return result;
  }

  async getWalletActivePolicies(wallet: string): Promise<InsurancePolicy[]> {
    const cacheKey = `wallet:${wallet}`;
    const cached = await this.cache.get<InsurancePolicy[]>(cacheKey);
    if (cached) return cached;

    const rows = (await this.dataSource.query(
      `SELECT invoice_id, wallet, is_active, coverage_bps, premium_paid, expiry, purchased_at
       FROM invoice_insurance WHERE wallet = $1 AND is_active = true`,
      [wallet],
    )) as InsurancePolicyRow[];

    const policies = rows.map((row) => ({
      invoiceId: row.invoice_id,
      wallet: row.wallet,
      isActive: row.is_active,
      coverageBps: row.coverage_bps,
      premiumPaid: row.premium_paid,
      expiry: row.expiry,
      purchasedAt: row.purchased_at,
    }));

    await this.cache.set(cacheKey, policies);
    return policies;
  }

  async getWalletPayoutHistory(wallet: string): Promise<InsurancePayout[]> {
    const cacheKey = `payouts:${wallet}`;
    const cached = await this.cache.get<InsurancePayout[]>(cacheKey);
    if (cached) return cached;

    const rows = (await this.dataSource.query(
      `SELECT invoice_id, wallet, amount, trigger_date, tx_hash
       FROM insurance_payouts WHERE wallet = $1 ORDER BY trigger_date DESC`,
      [wallet],
    )) as InsurancePayoutRow[];

    const payouts = rows.map((row) => ({
      invoiceId: row.invoice_id,
      wallet: row.wallet,
      amount: row.amount,
      triggerDate: row.trigger_date,
      txHash: row.tx_hash,
    }));

    await this.cache.set(cacheKey, payouts);
    return payouts;
  }

  /** Invalidate cache for a wallet/invoice pair when an insurance event occurs. */
  async invalidate(invoiceId: string, wallet: string): Promise<void> {
    await Promise.all([
      this.cache.delete(`invoice:${invoiceId}:${wallet}`),
      this.cache.delete(`wallet:${wallet}`),
      this.cache.delete(`payouts:${wallet}`),
    ]);
  }
}
