/**
 * Shared enums for entity status and type fields.
 */

export enum UserType {
  SELLER = "seller",
  INVESTOR = "investor",
  BOTH = "both",
  ADMIN = "admin",
}

/** Roles accepted by the administrative endpoints. */
export enum AdminRole {
  ADMIN = "admin",
}

export enum KYCStatus {
  PENDING = "pending",
  IN_REVIEW = "in_review",
  APPROVED = "approved",
  REJECTED = "rejected",
  EXPIRED = "expired",
}

export enum InvoiceStatus {
  DRAFT = "draft",
  PENDING = "pending",
  PUBLISHED = "published",
  FUNDED = "funded",
  SETTLED = "settled",
  CANCELLED = "cancelled",
  REJECTED = "rejected",
  /** Reached maturity without being fully funded. */
  FAILED = "failed",
}

export enum InvestmentStatus {
  PENDING = "pending",
  CONFIRMED = "confirmed",
  SETTLED = "settled",
  CANCELLED = "cancelled",
}

export enum TransactionType {
  INVESTMENT = "investment",
  PAYMENT = "payment",
  WITHDRAWAL = "withdrawal",
  REFUND = "refund",
}

export enum TransactionStatus {
  PENDING = "pending",
  COMPLETED = "completed",
  FAILED = "failed",
}

export enum KYCVerificationType {
  IDENTITY = "identity",
  ADDRESS = "address",
  BUSINESS = "business",
}

export enum NotificationType {
  INVOICE = "invoice",
  INVESTMENT = "investment",
  PAYMENT = "payment",
  KYC = "kyc",
  SYSTEM = "system",
  INVOICE_REJECTED = "invoice_rejected",
  KYC_APPROVED = "kyc_approved",
  KYC_REJECTED = "kyc_rejected",
  INVESTMENT_CONFIRMED = "investment_confirmed",
  INVOICE_FUNDED = "invoice_funded",
  INVOICE_SETTLED = "invoice_settled",
  INVESTMENT_CREATED = "investment_created",
  INVOICE_APPROVED = "invoice_approved",
  /** Funding deadline extended after admin approval (issue #477). */
  INVOICE_DEADLINE_EXTENDED = "invoice_deadline_extended",
  INVOICE_MATURED = "invoice_matured",
  SETTLEMENT_RECEIVED = "settlement_received",
  REFUND_PROCESSED = "refund_processed",
  SECONDARY_MARKET_SOLD = "secondary_market_sold",
  KYC_STATUS_CHANGE = "kyc_status_change",
  SUBSCRIPTION = "subscription",
  SUBSCRIPTION_EXPIRING = "subscription_expiring",
}

/** Seller funding-deadline extension request lifecycle (issue #477). */
export enum ExtensionRequestStatus {
  PENDING = "pending",
  APPROVED = "approved",
  REJECTED = "rejected",
}

/** Secondary market listing status for invoice fraction trading. */
export enum ListingStatus {
  ACTIVE = "active",
  SOLD = "sold",
  CANCELLED = "cancelled",
  EXPIRED = "expired",
}

/** Risk band an auto-invest rule can require (issue #596), derived from `Invoice.riskScore` (0-100, lower is safer). `null` on the rule matches any tier. */
export enum RiskTier {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
}

export enum AutoInvestExecutionStatus {
  EXECUTED = "executed",
  SKIPPED_INSUFFICIENT_BALANCE = "skipped_insufficient_balance",
  FAILED = "failed",
}

/** Investor referral tier (#677). Standard is the default for wallets with no referral history. */
export enum ReferralTierLevel {
  STANDARD = "standard",
  BRONZE = "bronze",
  SILVER = "silver",
  GOLD = "gold",
}

/** Wallet loyalty tier used for yield-boost eligibility (#678). Bronze is not eligible. */
export enum LoyaltyTier {
  BRONZE = "bronze",
  SILVER = "silver",
  GOLD = "gold",
  PLATINUM = "platinum",
}

export enum AuctionStatus {
  ACTIVE = "active",
  SETTLED = "settled",
  CANCELLED = "cancelled",
}

export enum BidStatus {
  PLACED = "placed",
  OUTBID = "outbid",
  WON = "won",
  LOST = "lost",
}
