import { DataSource } from "typeorm";
import { Invoice } from "../../../src/models/Invoice.model";
import { Investment } from "../../../src/models/Investment.model";
import { InvestorReturn } from "../../../src/models/InvestorReturn.model";
import { SettlementIntent } from "../../../src/models/SettlementIntent.model";
import { User } from "../../../src/models/User.model";
import { SettlementService } from "../../../src/services/settlement.service";
import type { PaymentDistributorContractService } from "../../../src/services/stellar/payment-distributor-contract.service";
import { InvoiceStatus, InvestmentStatus } from "../../../src/types/enums";
import type { InvoiceStateMachine } from "../../../src/lib/invoice-state-machine";

function setupSettlement() {
  const invoice = {
    id: "invoice-1",
    sellerId: "seller-1",
    status: InvoiceStatus.FUNDED,
    settlementRemainder: "0.0000",
  } as Invoice;
  const investment = {
    id: "investment-1",
    invoiceId: invoice.id,
    investorId: "investor-1",
    investmentAmount: "100.0000",
    expectedReturn: "120.0000",
    actualReturn: null,
    status: InvestmentStatus.CONFIRMED,
    investor: { stellarAddress: "GTESTINVESTOR" },
  } as Investment;
  const investments = new Map([[investment.id, investment]]);
  const intents = new Map<string, SettlementIntent>();
  let activeTransactionCount = 0;
  let failReturnSave = false;

  const manager = {
    createQueryBuilder: jest.fn(() => {
      const builder: {
        setLock: jest.Mock;
        where: jest.Mock;
        getOne: jest.Mock;
      } = {
        setLock: jest.fn(),
        where: jest.fn(),
        getOne: jest.fn(async () => invoice),
      };
      builder.setLock.mockReturnValue(builder);
      builder.where.mockReturnValue(builder);
      return builder;
    }),
    findOne: jest.fn(
      async (
        entity: typeof Invoice | typeof User | typeof SettlementIntent,
        options: {
          where: { id?: string; invoiceId?: string };
        }
      ) => {
        if (entity === Invoice) return invoice;
        if (entity === User) return { id: "seller-1", stellarAddress: "GTESTSELLER" };
        if (entity === SettlementIntent) {
          return options.where.id
            ? ([...intents.values()].find((intent) => intent.id === options.where.id) ?? null)
            : ([...intents.values()].find(
                (intent) => intent.invoiceId === options.where.invoiceId
              ) ?? null);
        }
        return null;
      }
    ),
    find: jest.fn(async (entity: typeof Investment) =>
      entity === Investment
        ? [...investments.values()].filter((item) => item.status === InvestmentStatus.CONFIRMED)
        : []
    ),
    create: jest.fn((_entity, value) => ({ id: "created-record", ...value })),
    save: jest.fn(async (entity, value) => {
      if (entity === SettlementIntent) {
        intents.set(value.id, value);
      } else if (entity === Investment) {
        investments.set(value.id, value);
      } else if (entity === Invoice) {
        Object.assign(invoice, value);
      } else if (entity === InvestorReturn && failReturnSave) {
        failReturnSave = false;
        throw new Error("database write failed");
      }
      return value;
    }),
  };

  const dataSource = {
    transaction: jest.fn(async (callback) => {
      const invoiceSnapshot = { ...invoice };
      const investmentSnapshot = [...investments.values()].map((item) => ({ ...item }));
      const intentSnapshot = [...intents.values()].map((intent) => ({ ...intent }));
      activeTransactionCount++;
      try {
        return await callback(manager);
      } catch (error) {
        Object.assign(invoice, invoiceSnapshot);
        investments.clear();
        for (const item of investmentSnapshot) investments.set(item.id, item as Investment);
        intents.clear();
        for (const intent of intentSnapshot) intents.set(intent.id, intent as SettlementIntent);
        throw error;
      } finally {
        activeTransactionCount--;
      }
    }),
  } as unknown as DataSource;

  const distributePayouts = jest.fn(async () => {
    expect(activeTransactionCount).toBe(0);
    return { transactionHash: "stellar-hash", ledger: 123 };
  });
  const stateMachine = {
    transition: jest.fn(async (store, entity, to, options) => {
      const from = entity.status;
      entity.status = to;
      await store.saveInvoice(entity);
      return { invoice: entity, from, to, actor: options.actor, trigger: options.trigger };
    }),
    dispatch: jest.fn(),
  } as unknown as InvoiceStateMachine;
  const service = new SettlementService(
    dataSource,
    { distributePayouts } as unknown as PaymentDistributorContractService,
    { feeRecipient: "GTESTFEE", feeBps: 0 },
    stateMachine
  );

  return {
    service,
    invoice,
    investment,
    intents,
    manager,
    distributePayouts,
    failFinalizationWrite: () => {
      failReturnSave = true;
    },
  };
}

const settlementInput = {
  invoiceId: "invoice-1",
  proceeds: "120.0000",
  actorWallet: "GTESTSELLER",
};

describe("SettlementService payout intents", () => {
  it("submits the payout outside database transactions and finalizes the intent", async () => {
    const context = setupSettlement();

    const result = await context.service.settleInvoice(settlementInput);

    expect(context.distributePayouts).toHaveBeenCalledTimes(1);
    expect(context.intents.get("created-record")).toMatchObject({
      status: "completed",
      transactionHash: "stellar-hash",
    });
    expect(context.invoice.status).toBe(InvoiceStatus.SETTLED);
    expect(result.distributionTransactionHash).toBe("stellar-hash");
  });

  it("reuses a confirmed payout after a database finalization failure", async () => {
    const context = setupSettlement();
    context.failFinalizationWrite();

    await expect(context.service.settleInvoice(settlementInput)).rejects.toThrow(
      "database write failed"
    );
    expect([...context.intents.values()][0]).toMatchObject({
      status: "distributed",
      transactionHash: "stellar-hash",
    });

    const result = await context.service.settleInvoice(settlementInput);

    expect(context.distributePayouts).toHaveBeenCalledTimes(1);
    expect(context.invoice.status).toBe(InvoiceStatus.SETTLED);
    expect(result.distributionTransactionHash).toBe("stellar-hash");
  });

  it("fails closed rather than resubmitting after an ambiguous payout error", async () => {
    const context = setupSettlement();
    context.distributePayouts.mockRejectedValueOnce(new Error("RPC timed out"));

    await expect(context.service.settleInvoice(settlementInput)).rejects.toThrow("RPC timed out");
    await expect(context.service.settleInvoice(settlementInput)).rejects.toMatchObject({
      code: "SETTLEMENT_RECONCILIATION_REQUIRED",
      statusCode: 409,
    });
    expect(context.distributePayouts).toHaveBeenCalledTimes(1);
    expect([...context.intents.values()][0]?.status).toBe("submitting");
  });
});
