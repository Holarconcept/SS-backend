import { DataSource, EntityManager } from "typeorm";
import { Decimal } from "decimal.js";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { User } from "../models/User.model";
import { InvestorReturn } from "../models/InvestorReturn.model";
import { SettlementRemainder } from "../models/SettlementRemainder.model";
import { SettlementIntent, SettlementIntentStatus } from "../models/SettlementIntent.model";
import { InvoiceStatus, InvestmentStatus, NotificationType } from "../types/enums";
import { TransactionStatus, TransactionType } from "../types/enums";
import { Transaction } from "../models/Transaction.model";
import { ServiceError } from "../utils/service-error";
import { computeInvestorReturn } from "../lib/investor-return";
import { decimalStringToScaledBigInt, scaledBigIntToDecimalString } from "../lib/decimal-bigint";
import {
  createInvoiceStateMachine,
  entityManagerTransitionStore,
  type InvoiceStateMachine,
} from "../lib/invoice-state-machine";
import { logger } from "../observability/logger";
import {
  logSettlementStart,
  logSettlementFailure,
  logSettlementSuccess,
} from "../lib/settlement-observability";
import type { InvoiceTransitionReason } from "../lib/invoice-lifecycle-log";
import {
  settlementEventEmitter,
  SettlementEventEmitter,
  type SettlementEventPayload,
  type SettlementEventListener,
} from "../lib/settlement-events";
import type { PaymentDistributorContractService } from "./stellar/payment-distributor-contract.service";
import type { NotificationService } from "./notification.service";
import type { IssuerReputationService } from "./issuer-reputation.service";

// settlement.service.ts stores/computes amounts as decimal strings scaled by
// 10^4 (see decimal-bigint.ts), while stroopsToXlm expects a stroops count
// (10^7 scale). Multiplying by 10^3 converts between the two without any
// loss of precision, since 7 - 4 = 3.
const DECIMAL_SCALE_TO_STROOP_FACTOR = 10n ** 3n;

/**
 * Identity recorded when a background job, rather than a wallet holder,
 * triggers settlement. It is never a Stellar address, so it must never be
 * compared against a seller's wallet.
 */
export const SYSTEM_SETTLEMENT_ACTOR = "system";

/**
 * Settlement triggers that only automated infrastructure may request. They
 * authorize settlement without the actor impersonating the seller's wallet.
 */
export type SystemSettlementTrigger = "system_matured";

export type SettlementTrigger = InvoiceTransitionReason | SystemSettlementTrigger;

/**
 * System actors are either the bare `system` identity or a namespaced job
 * actor such as `system:invoice-maturity-job`. Anything else is treated as a
 * wallet address and is still subject to the seller equality check.
 */
export function isSystemSettlementActor(actorWallet: string | null | undefined): boolean {
  if (!actorWallet) return false;
  return (
    actorWallet === SYSTEM_SETTLEMENT_ACTOR || actorWallet.startsWith(`${SYSTEM_SETTLEMENT_ACTOR}:`)
  );
}

export interface SettleInvoiceInput {
  invoiceId: string;
  proceeds: string;
  actorWallet: string;
  /** Recorded in the status history; defaults to `admin_settled`. */
  trigger?: SettlementTrigger;
  /** Set for automated settlement of a matured invoice by a background job. */
  systemTrigger?: SystemSettlementTrigger;
  sellerId?: string;
}

export interface PaymentDistributorSettlementConfig {
  feeRecipient: string;
  feeBps: number;
}

export interface InvestorSettlement {
  investmentId: string;
  investorId: string;
  investmentAmount: string;
  actualReturn: string;
}

export interface SettleInvoiceResult {
  invoiceId: string;
  sellerId?: string;
  status: InvoiceStatus.SETTLED;
  proceeds: string;
  totalDistributed: string;
  remainder: string;
  remainderDust: string;
  settlements: InvestorSettlement[];
  distributionTransactionHash?: string;
}

interface SettlementIntentInvestment {
  id: string;
  investorId: string;
  investmentAmount: string;
  recipientAddress: string;
  returnAmountStroops: string;
}

interface SettlementIntentPayload {
  proceeds: string;
  actorWallet: string;
  sellerId?: string;
  trigger: InvoiceTransitionReason;
  feeRecipient: string;
  feeBps: number;
  investments: SettlementIntentInvestment[];
}

export class SettlementService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly paymentDistributor?: PaymentDistributorContractService,
    private readonly distributorConfig?: PaymentDistributorSettlementConfig,
    private readonly stateMachine: InvoiceStateMachine = createInvoiceStateMachine(),
    private readonly eventEmitter: SettlementEventEmitter = settlementEventEmitter,
    private readonly notificationService?: NotificationService,
    private readonly issuerReputationService?: IssuerReputationService
  ) {}

  /**
   * Registers a callback listener for settlement events.
   */
  public onSettlement(listener: SettlementEventListener): this {
    this.eventEmitter.on("settlement", listener);
    return this;
  }

  /**
   * Returns the event emitter instance used by this service.
   */
  public getEventEmitter(): SettlementEventEmitter {
    return this.eventEmitter;
  }

  /**
   * Calculates each fractional investor's return using floor division,
   * along with the total distributed amount and remainder dust.
   *
   * Verifies that the sum of all returns never exceeds the distributable settlement amount.
   */
  public calculateInvestorReturns(
    investments: Array<{ id: string; investorId: string; investmentAmount: string }>,
    proceedsAmount: string | Decimal,
    feeBps = 0
  ): {
    totalFunded: string;
    distributable: string;
    fee: string;
    totalDistributed: string;
    remainder: string;
    returns: Array<{
      investmentId: string;
      investorId: string;
      investmentAmount: string;
      returnAmount: string;
    }>;
  } {
    const proceeds = new Decimal(proceedsAmount);
    if (proceeds.isNegative() || proceeds.isZero()) {
      throw new ServiceError("INVALID_PROCEEDS", "Settlement proceeds must be greater than zero");
    }

    const totalFunded = investments.reduce(
      (sum, inv) => sum.plus(new Decimal(inv.investmentAmount)),
      new Decimal(0)
    );
    if (totalFunded.isZero() || totalFunded.isNegative()) {
      throw new ServiceError(
        "INVALID_FUNDED_AMOUNT",
        "Total funded amount must be greater than zero"
      );
    }

    const totalFundedScaled = decimalStringToScaledBigInt(totalFunded.toFixed(4));
    const proceedsScaled = decimalStringToScaledBigInt(proceeds.toFixed(4));
    const feeScaled = feeBps > 0 ? (proceedsScaled * BigInt(feeBps)) / 10_000n : 0n;
    const distributableScaled = proceedsScaled - feeScaled;

    let sumOfReturnsScaled = 0n;
    const returns: Array<{
      investmentId: string;
      investorId: string;
      investmentAmount: string;
      returnAmount: string;
    }> = [];

    for (const inv of investments) {
      const investmentAmountScaled = decimalStringToScaledBigInt(inv.investmentAmount);
      const returnScaled = computeInvestorReturn(
        investmentAmountScaled,
        totalFundedScaled,
        distributableScaled
      );
      sumOfReturnsScaled += returnScaled;
      returns.push({
        investmentId: inv.id,
        investorId: inv.investorId,
        investmentAmount: inv.investmentAmount,
        returnAmount: scaledBigIntToDecimalString(returnScaled),
      });
    }

    const remainderScaled = distributableScaled - sumOfReturnsScaled;

    return {
      totalFunded: totalFunded.toFixed(4),
      distributable: scaledBigIntToDecimalString(distributableScaled),
      fee: scaledBigIntToDecimalString(feeScaled),
      totalDistributed: scaledBigIntToDecimalString(sumOfReturnsScaled),
      remainder: scaledBigIntToDecimalString(remainderScaled),
      returns,
    };
  }

  /**
   * Settles a funded invoice by distributing proceeds to each investor
   * pro-rata to their share using floor division.
   *
   * Records individual return amounts in the investor_returns table,
   * handles remainder dust after floor division separately, and emits
   * a settlement event for downstream processing.
   */
  async settleInvoice(input: SettleInvoiceInput): Promise<SettleInvoiceResult> {
    const {
      invoiceId,
      proceeds: proceedsInput,
      actorWallet,
      sellerId,
      trigger = "admin_settled",
      systemTrigger,
    } = input;
    const authorizedForAutomatedSettlement =
      isSystemSettlementActor(actorWallet) || Boolean(systemTrigger);

    const proceeds = new Decimal(proceedsInput);
    if (proceeds.isNegative() || proceeds.isZero()) {
      throw new ServiceError("INVALID_PROCEEDS", "Settlement proceeds must be greater than zero");
    }

    const startedAt = Date.now();
    logSettlementStart(logger, {
      invoiceId,
      actorWallet,
      startedAt: new Date(startedAt).toISOString(),
    });

    try {
      let settlementIntent: SettlementIntent | undefined;
      let settlementIntentPayload: SettlementIntentPayload | undefined;
      let distributionTransactionHash: string | undefined;

      if (this.paymentDistributor) {
        if (!this.distributorConfig) {
          throw new ServiceError(
            "DISTRIBUTOR_CONFIGURATION_MISSING",
            "Payment distributor fee configuration is required"
          );
        }

        const prepared = await this.prepareSettlementIntent({
          invoiceId,
          proceeds: proceeds.toFixed(4),
          actorWallet,
          sellerId,
          trigger: trigger === "system_matured" ? "maturity_settled" : trigger,
          feeRecipient: this.distributorConfig.feeRecipient,
          feeBps: this.distributorConfig.feeBps,
        });
        settlementIntent = prepared.intent;
        settlementIntentPayload = prepared.payload;

        // A lost RPC response may still mean the transaction was submitted.
        if (settlementIntent.status === SettlementIntentStatus.SUBMITTING) {
          throw new ServiceError(
            "SETTLEMENT_RECONCILIATION_REQUIRED",
            "A payout submission is already in progress or has an unknown outcome; reconcile it before retrying",
            409,
            { invoiceId }
          );
        }

        if (settlementIntent.status === SettlementIntentStatus.PREPARED) {
          settlementIntent = await this.claimSettlementIntent(settlementIntent.id);
          const distribution = await this.paymentDistributor.distributePayouts({
            invoiceId,
            totalAmountStroops:
              decimalStringToScaledBigInt(settlementIntentPayload.proceeds) *
              DECIMAL_SCALE_TO_STROOP_FACTOR,
            feeRecipient: settlementIntentPayload.feeRecipient,
            feeBps: settlementIntentPayload.feeBps,
            recipients: settlementIntentPayload.investments.map((investment) => ({
              address: investment.recipientAddress,
              amountStroops: BigInt(investment.returnAmountStroops),
            })),
          });
          distributionTransactionHash = distribution.transactionHash;
          settlementIntent = await this.markSettlementDistributed(
            settlementIntent.id,
            distribution.transactionHash
          );
        } else if (settlementIntent.status === SettlementIntentStatus.DISTRIBUTED) {
          if (!settlementIntent.transactionHash) {
            throw new ServiceError(
              "SETTLEMENT_RECONCILIATION_REQUIRED",
              "The confirmed payout transaction hash is missing; reconcile it before retrying",
              409,
              { invoiceId }
            );
          }
          distributionTransactionHash = settlementIntent.transactionHash;
        } else {
          throw new ServiceError(
            "SETTLEMENT_RECONCILIATION_REQUIRED",
            "Settlement intent is not in a retryable state",
            409,
            { invoiceId }
          );
        }
      }

      const { result, transition, proceedsScaled, settlementEvent } =
        await this.dataSource.transaction(async (transactionalEntityManager: EntityManager) => {
          // 1. Lock the invoice row for update (if supported by the driver).
          //    SQLite does not support row-level locking, so we fall back to a plain read.
          let invoice: Invoice | null;
          try {
            invoice = await transactionalEntityManager
              .createQueryBuilder(Invoice, "invoice")
              .setLock("pessimistic_write")
              .where("invoice.id = :id", { id: invoiceId })
              .getOne();
          } catch {
            invoice = await transactionalEntityManager
              .createQueryBuilder(Invoice, "invoice")
              .where("invoice.id = :id", { id: invoiceId })
              .getOne();
          }

          if (!invoice) {
            throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
          }

          if (sellerId && invoice.sellerId && invoice.sellerId !== sellerId) {
            throw new ServiceError("FORBIDDEN", "Only the seller can settle this invoice", 403);
          }

          // Automated settlement runs without a seller wallet: the worker
          // identifies itself as a system actor instead of impersonating the
          // seller. Skip the wallet equality check in that case, otherwise it
          // would reject every invoice whose seller wallet is unknown. The
          // explicit sellerId check above still applies.
          if (
            !authorizedForAutomatedSettlement &&
            actorWallet &&
            invoice.sellerId &&
            typeof transactionalEntityManager.findOne === "function"
          ) {
            const seller = await transactionalEntityManager.findOne(User, {
              where: { id: invoice.sellerId },
            });
            if (seller && seller.stellarAddress && seller.stellarAddress !== actorWallet) {
              throw new ServiceError(
                "FORBIDDEN",
                "Only the invoice seller can settle this invoice",
                403
              );
            }
          }

          // 2. Validate invoice status
          if (invoice.status === InvoiceStatus.SETTLED) {
            throw new ServiceError(
              "invoice_already_settled",
              "Cannot settle an invoice with status settled",
              409
            );
          }
          if (invoice.status !== InvoiceStatus.FUNDED) {
            throw new ServiceError(
              "INVALID_INVOICE_STATUS",
              `INVALID_INVOICE_STATUS: Cannot settle an invoice with status ${invoice.status}`
            );
          }

          // 3. Find confirmed investments backing this invoice
          const investments = await transactionalEntityManager.find(Investment, {
            where: { invoiceId: invoice.id, status: InvestmentStatus.CONFIRMED },
            relations: { investor: true },
          });

          if (investments.length === 0) {
            throw new ServiceError(
              "NO_CONFIRMED_INVESTMENTS",
              "Invoice has no confirmed investments to settle"
            );
          }

          if (settlementIntentPayload) {
            const currentSnapshot = investments
              .map((investment) => ({
                id: investment.id,
                investmentAmount: new Decimal(investment.investmentAmount).toFixed(4),
              }))
              .sort((left, right) => left.id.localeCompare(right.id));
            const intentSnapshot = settlementIntentPayload.investments
              .map((investment) => ({
                id: investment.id,
                investmentAmount: new Decimal(investment.investmentAmount).toFixed(4),
              }))
              .sort((left, right) => left.id.localeCompare(right.id));
            if (JSON.stringify(currentSnapshot) !== JSON.stringify(intentSnapshot)) {
              throw new ServiceError(
                "SETTLEMENT_SNAPSHOT_CHANGED",
                "Confirmed investment holdings changed after payout preparation; reconciliation is required",
                409,
                { invoiceId }
              );
            }
          }

          // 4. Distribute proceeds pro-rata to each investor's share using floor division
          const totalFunded = investments.reduce(
            (sum, investment) => sum.plus(new Decimal(investment.investmentAmount)),
            new Decimal(0)
          );
          const totalFundedScaled = decimalStringToScaledBigInt(totalFunded.toFixed(4));
          const proceedsScaled = decimalStringToScaledBigInt(proceeds.toFixed(4));
          const feeScaled = this.distributorConfig
            ? (proceedsScaled * BigInt(this.distributorConfig.feeBps)) / 10_000n
            : 0n;
          const distributableScaled = proceedsScaled - feeScaled;
          const settlements: InvestorSettlement[] = [];
          if (distributionTransactionHash) {
            await transactionalEntityManager.save(
              Transaction,
              transactionalEntityManager.create(Transaction, {
                userId: invoice.sellerId,
                invoiceId: invoice.id,
                investmentId: null,
                type: TransactionType.PAYMENT,
                amount: proceeds.toFixed(4),
                stellarTxHash: distributionTransactionHash,
                stellarOperationIndex: 0,
                status: TransactionStatus.COMPLETED,
              })
            );
          }

          let sumOfReturnsScaled = 0n;

          for (const investment of investments) {
            const investmentAmountScaled = decimalStringToScaledBigInt(investment.investmentAmount);
            // Calculate each investor's share using floor division on total return amount
            const actualReturnScaled = computeInvestorReturn(
              investmentAmountScaled,
              totalFundedScaled,
              distributableScaled
            );
            sumOfReturnsScaled += actualReturnScaled;

            const actualReturnStr = scaledBigIntToDecimalString(actualReturnScaled);
            investment.actualReturn = actualReturnStr;
            investment.status = InvestmentStatus.SETTLED;
            await transactionalEntityManager.save(Investment, investment);

            // Record individual return amounts in investor_returns table
            const investorReturnRecord = transactionalEntityManager.create(InvestorReturn, {
              invoiceId: invoice.id,
              investmentId: investment.id,
              investorId: investment.investorId,
              returnAmount: actualReturnStr,
              amount: actualReturnStr,
            });
            await transactionalEntityManager.save(InvestorReturn, investorReturnRecord);

            settlements.push({
              investmentId: investment.id,
              investorId: investment.investorId,
              investmentAmount: investment.investmentAmount,
              actualReturn: investment.actualReturn,
            });
          }

          // Handle remainder dust after floor division
          // The remainder is handled and recorded separately from investor returns.
          const remainderScaled = distributableScaled - sumOfReturnsScaled;
          const remainderStr = scaledBigIntToDecimalString(remainderScaled);
          const totalDistributedStr = scaledBigIntToDecimalString(sumOfReturnsScaled);

          // Record remainder on the invoice
          invoice.settlementRemainder = remainderStr;

          // Record remainder in settlement_remainders table
          const settlementRemainderRecord = transactionalEntityManager.create(SettlementRemainder, {
            invoiceId: invoice.id,
            remainderAmount: remainderStr,
            totalSettlementAmount: proceeds.toFixed(4),
            totalDistributedAmount: totalDistributedStr,
          });
          await transactionalEntityManager.save(SettlementRemainder, settlementRemainderRecord);

          // 5. Transition invoice to SETTLED (history row written in this transaction)
          // `system_matured` has no lifecycle reason of its own; it records the
          // same settlement outcome as the maturity job does.
          const transitionReason: InvoiceTransitionReason =
            trigger === "system_matured" ? "maturity_settled" : trigger;
          const transition = await this.stateMachine.transition(
            entityManagerTransitionStore(transactionalEntityManager),
            invoice,
            InvoiceStatus.SETTLED,
            { actor: { role: "system", wallet: actorWallet }, trigger: transitionReason }
          );

          if (settlementIntent) {
            const completedIntent = await transactionalEntityManager.findOne(SettlementIntent, {
              where: { id: settlementIntent.id },
              lock: { mode: "pessimistic_write" },
            });
            if (
              !completedIntent ||
              completedIntent.status !== SettlementIntentStatus.DISTRIBUTED ||
              completedIntent.transactionHash !== distributionTransactionHash
            ) {
              throw new ServiceError(
                "SETTLEMENT_INTENT_INVALID",
                "Confirmed settlement intent is missing or inconsistent",
                409,
                { invoiceId }
              );
            }
            completedIntent.status = SettlementIntentStatus.COMPLETED;
            await transactionalEntityManager.save(SettlementIntent, completedIntent);
          }

          const eventPayload: SettlementEventPayload = {
            invoiceId: invoice.id,
            sellerId: invoice.sellerId,
            totalSettlementAmount: proceeds.toFixed(4),
            totalDistributedAmount: totalDistributedStr,
            remainderAmount: remainderStr,
            settledAt: new Date(),
            distributionTransactionHash: distributionTransactionHash ?? null,
            returns: settlements.map((s) => ({
              investmentId: s.investmentId,
              investorId: s.investorId,
              returnAmount: s.actualReturn,
            })),
          };

          return {
            transition,
            proceedsScaled,
            settlementEvent: eventPayload,
            result: {
              invoiceId: invoice.id,
              sellerId: invoice.sellerId,
              status: InvoiceStatus.SETTLED as const,
              proceeds: proceeds.toFixed(4),
              totalDistributed: totalDistributedStr,
              remainder: remainderStr,
              remainderDust: remainderStr,
              settlements,
              distributionTransactionHash,
            },
          };
        });

      await this.stateMachine.dispatch(transition);

      // Emit settlement event for downstream processing
      this.eventEmitter.emitSettlement(settlementEvent);

      // Update issuer reputation after settlement
      if (this.issuerReputationService && result.sellerId) {
        try {
          const user = await this.dataSource
            .getRepository(User)
            .findOne({ where: { id: result.sellerId } });
          if (user?.stellarAddress) {
            const invoice = await this.dataSource
              .getRepository(Invoice)
              .findOne({ where: { id: result.invoiceId } });
            if (invoice) {
              const dueDate = new Date(invoice.dueDate);
              const settledDate = new Date();
              const wasOnTime = settledDate <= dueDate;

              await this.issuerReputationService.updateReputationOnSettlement(
                user.stellarAddress,
                result.invoiceId,
                wasOnTime
              );

              logger.info("settlement.reputation_updated", {
                invoiceId: result.invoiceId,
                wallet: user.stellarAddress,
                wasOnTime,
              });
            }
          }
        } catch (reputationError) {
          logger.error("settlement.reputation_update_failed", {
            invoiceId: result.invoiceId,
            error:
              reputationError instanceof Error ? reputationError.message : String(reputationError),
          });
          // Don't fail settlement if reputation update fails
        }
      }

      // Dispatch settlement notifications to all holders
      if (this.notificationService) {
        try {
          for (const settlement of result.settlements) {
            await this.notificationService.createNotification(
              settlement.investorId,
              NotificationType.SETTLEMENT_RECEIVED,
              "Settlement Received",
              `You have received ${settlement.actualReturn} for your investment in invoice #${result.invoiceId}`,
              {
                invoiceId: result.invoiceId,
                investmentId: settlement.investmentId,
                amount: settlement.actualReturn,
              }
            );
          }
          logger.info("settlement.notifications.sent", {
            invoiceId: result.invoiceId,
            recipientCount: result.settlements.length,
          });
        } catch (notificationError) {
          logger.error("settlement.notifications.failed", {
            invoiceId: result.invoiceId,
            error:
              notificationError instanceof Error
                ? notificationError.message
                : String(notificationError),
          });
          // Don't fail the settlement if notifications fail
        }
      }

      logSettlementSuccess(logger, {
        invoiceId: result.invoiceId,
        totalProceedsStroops: proceedsScaled * DECIMAL_SCALE_TO_STROOP_FACTOR,
        investorCount: result.settlements.length,
        durationMs: Date.now() - startedAt,
        distributionTxHash: result.distributionTransactionHash ?? null,
      });

      return result;
    } catch (err) {
      logSettlementFailure(logger, {
        invoiceId,
        error: err,
        durationMs: Date.now() - startedAt,
        category: err instanceof ServiceError ? err.code : undefined,
      });

      throw err;
    }
  }

  private async prepareSettlementIntent(input: {
    invoiceId: string;
    proceeds: string;
    actorWallet: string;
    sellerId?: string;
    trigger: InvoiceTransitionReason;
    feeRecipient: string;
    feeBps: number;
  }): Promise<{ intent: SettlementIntent; payload: SettlementIntentPayload }> {
    if (!Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 10_000) {
      throw new ServiceError(
        "INVALID_DISTRIBUTOR_FEE",
        "Distributor fee must be an integer between 0 and 10000 basis points",
        400
      );
    }

    return this.dataSource.transaction(async (manager: EntityManager) => {
      let invoice: Invoice | null;
      try {
        invoice = await manager
          .createQueryBuilder(Invoice, "invoice")
          .setLock("pessimistic_write")
          .where("invoice.id = :id", { id: input.invoiceId })
          .getOne();
      } catch {
        invoice = await manager.findOne(Invoice, { where: { id: input.invoiceId } });
      }

      if (!invoice) {
        throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
      }
      if (input.sellerId && invoice.sellerId && invoice.sellerId !== input.sellerId) {
        throw new ServiceError("FORBIDDEN", "Only the seller can settle this invoice", 403);
      }
      if (input.actorWallet && invoice.sellerId) {
        const seller = await manager.findOne(User, { where: { id: invoice.sellerId } });
        if (seller?.stellarAddress && seller.stellarAddress !== input.actorWallet) {
          throw new ServiceError(
            "FORBIDDEN",
            "Only the invoice seller can settle this invoice",
            403
          );
        }
      }
      if (invoice.status !== InvoiceStatus.FUNDED) {
        throw new ServiceError(
          invoice.status === InvoiceStatus.SETTLED
            ? "invoice_already_settled"
            : "INVALID_INVOICE_STATUS",
          `Cannot settle an invoice with status ${invoice.status}`,
          invoice.status === InvoiceStatus.SETTLED ? 409 : 400
        );
      }

      const existing = await manager.findOne(SettlementIntent, {
        where: { invoiceId: invoice.id },
        lock: { mode: "pessimistic_write" },
      });
      if (existing) {
        const payload = JSON.parse(existing.payload) as SettlementIntentPayload;
        if (
          payload.proceeds !== input.proceeds ||
          payload.actorWallet !== input.actorWallet ||
          payload.sellerId !== input.sellerId ||
          payload.trigger !== input.trigger ||
          payload.feeRecipient !== input.feeRecipient ||
          payload.feeBps !== input.feeBps
        ) {
          throw new ServiceError(
            "SETTLEMENT_INTENT_CONFLICT",
            "A settlement intent already exists with different parameters",
            409,
            { invoiceId: input.invoiceId }
          );
        }
        return { intent: existing, payload };
      }

      const investments = await manager.find(Investment, {
        where: { invoiceId: invoice.id, status: InvestmentStatus.CONFIRMED },
        relations: { investor: true },
        lock: { mode: "pessimistic_write" },
      });
      if (investments.length === 0) {
        throw new ServiceError(
          "NO_CONFIRMED_INVESTMENTS",
          "Invoice has no confirmed investments to settle"
        );
      }

      const totalFunded = investments.reduce(
        (sum, investment) => sum.plus(new Decimal(investment.investmentAmount)),
        new Decimal(0)
      );
      const totalFundedScaled = decimalStringToScaledBigInt(totalFunded.toFixed(4));
      const proceedsScaled = decimalStringToScaledBigInt(input.proceeds);
      const feeScaled = (proceedsScaled * BigInt(input.feeBps)) / 10_000n;
      const distributableScaled = proceedsScaled - feeScaled;
      const payload: SettlementIntentPayload = {
        proceeds: input.proceeds,
        actorWallet: input.actorWallet,
        sellerId: input.sellerId,
        trigger: input.trigger,
        feeRecipient: input.feeRecipient,
        feeBps: input.feeBps,
        investments: investments
          .map((investment) => ({
            id: investment.id,
            investorId: investment.investorId,
            investmentAmount: new Decimal(investment.investmentAmount).toFixed(4),
            recipientAddress: investment.investor?.stellarAddress ?? investment.investorId,
            returnAmountStroops: (
              computeInvestorReturn(
                decimalStringToScaledBigInt(investment.investmentAmount),
                totalFundedScaled,
                distributableScaled
              ) * DECIMAL_SCALE_TO_STROOP_FACTOR
            ).toString(),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      };
      const intent = manager.create(SettlementIntent, {
        invoiceId: invoice.id,
        status: SettlementIntentStatus.PREPARED,
        payload: JSON.stringify(payload),
        transactionHash: null,
      });
      return { intent: await manager.save(SettlementIntent, intent), payload };
    });
  }

  private async claimSettlementIntent(intentId: string): Promise<SettlementIntent> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const intent = await manager.findOne(SettlementIntent, {
        where: { id: intentId },
        lock: { mode: "pessimistic_write" },
      });
      if (!intent) {
        throw new ServiceError("SETTLEMENT_INTENT_NOT_FOUND", "Settlement intent not found", 404);
      }
      if (intent.status !== SettlementIntentStatus.PREPARED) {
        throw new ServiceError(
          "SETTLEMENT_RECONCILIATION_REQUIRED",
          "Settlement payout has already been claimed; reconcile it before retrying",
          409,
          { invoiceId: intent.invoiceId }
        );
      }
      intent.status = SettlementIntentStatus.SUBMITTING;
      return manager.save(SettlementIntent, intent);
    });
  }

  private async markSettlementDistributed(
    intentId: string,
    transactionHash: string
  ): Promise<SettlementIntent> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const intent = await manager.findOne(SettlementIntent, {
        where: { id: intentId },
        lock: { mode: "pessimistic_write" },
      });
      if (!intent || intent.status !== SettlementIntentStatus.SUBMITTING) {
        throw new ServiceError(
          "SETTLEMENT_INTENT_INVALID",
          "Settlement intent cannot be marked as distributed",
          409
        );
      }
      intent.status = SettlementIntentStatus.DISTRIBUTED;
      intent.transactionHash = transactionHash;
      return manager.save(SettlementIntent, intent);
    });
  }
}

export function createSettlementService(
  dataSource: DataSource,
  paymentDistributor?: PaymentDistributorContractService,
  distributorConfig?: PaymentDistributorSettlementConfig,
  stateMachine?: InvoiceStateMachine,
  eventEmitter?: SettlementEventEmitter,
  notificationService?: NotificationService,
  issuerReputationService?: IssuerReputationService
): SettlementService {
  return new SettlementService(
    dataSource,
    paymentDistributor,
    distributorConfig,
    stateMachine,
    eventEmitter,
    notificationService,
    issuerReputationService
  );
}
