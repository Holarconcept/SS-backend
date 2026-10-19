import crypto from "crypto";
import express from "express";
import request from "supertest";
import type { DataSource } from "typeorm";

import {
  allowedTransitionsFrom,
  assertTransition,
  createAuditLogEffect,
  createCacheInvalidationEffect,
  createInvoiceStateMachine,
  createSellerNotificationEffect,
  entityManagerTransitionStore,
  InvoiceStateMachine,
  isTerminalStatus,
  type InvoiceTransitionActorRole,
  type InvoiceTransitionStore,
  type TransitionActor,
  type TransitionContext,
} from "../../src/lib/invoice-state-machine";
import { createInvoiceController } from "../../src/controllers/invoice.controller";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { Investment } from "../../src/models/Investment.model";
import { InvestorAcknowledgement } from "../../src/models/InvestorAcknowledgement.model";
import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceStatusHistory } from "../../src/models/InvoiceStatusHistory.model";
import type { AppLogger } from "../../src/observability/logger";
import { logger } from "../../src/observability/logger";
import { InvestmentService } from "../../src/services/investment.service";
import type { InvoiceService } from "../../src/services/invoice.service";
import { SettlementService } from "../../src/services/settlement.service";
import { InvestmentStatus, InvoiceStatus, NotificationType } from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";

const SELLER_ID = "seller-1";
const ALL_STATUSES = Object.values(InvoiceStatus);
const ALL_ROLES: InvoiceTransitionActorRole[] = ["seller", "admin", "system"];

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: crypto.randomUUID(),
    sellerId: SELLER_ID,
    invoiceNumber: "INV-SM-468",
    customerName: "Acme Ltd",
    amount: "1000.0000",
    discountRate: "5.00",
    netAmount: "950.0000",
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ipfsHash: "QmStateMachineDoc",
    riskScore: null,
    status: InvoiceStatus.DRAFT,
    smartContractId: null,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    version: 1,
    ...overrides,
  } as unknown as Invoice;
}

/** In-memory store recording what the machine persisted. */
function createStore() {
  const savedInvoices: Invoice[] = [];
  const history: Array<Omit<InvoiceStatusHistory, "id" | "createdAt">> = [];
  const store: InvoiceTransitionStore = {
    saveInvoice: async (invoice) => {
      savedInvoices.push({ ...invoice } as unknown as Invoice);
      return invoice;
    },
    recordHistory: async (entry) => {
      history.push(entry);
      return { id: crypto.randomUUID(), createdAt: new Date(), ...entry } as unknown as InvoiceStatusHistory;
    },
  };
  return { store, savedInvoices, history };
}

function createMockLogger(): jest.Mocked<AppLogger> {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  } as unknown as jest.Mocked<AppLogger>;
}

/** Actor and context that satisfy each edge's role and precondition. */
function validInputs(
  from: InvoiceStatus,
  to: InvoiceStatus
): { actor: TransitionActor; context: TransitionContext } {
  const admin: TransitionActor = { role: "admin", id: "admin-1" };
  const seller: TransitionActor = { role: "seller", id: SELLER_ID };
  const system: TransitionActor = { role: "system" };

  if (to === InvoiceStatus.REJECTED) return { actor: admin, context: { reason: "Bad docs" } };
  if (to === InvoiceStatus.FUNDED) return { actor: system, context: { fundedAmount: "950" } };
  if (to === InvoiceStatus.SETTLED) return { actor: system, context: {} };
  if (to === InvoiceStatus.FAILED) return { actor: system, context: {} };
  if (from === InvoiceStatus.PENDING && to === InvoiceStatus.PUBLISHED) {
    return { actor: admin, context: {} };
  }
  if (
    to === InvoiceStatus.CANCELLED &&
    [InvoiceStatus.PUBLISHED, InvoiceStatus.FUNDED].includes(from)
  ) {
    return { actor: admin, context: {} };
  }
  return { actor: seller, context: {} };
}

const VALID_EDGES: Array<[InvoiceStatus, InvoiceStatus]> = [
  [InvoiceStatus.DRAFT, InvoiceStatus.PENDING],
  [InvoiceStatus.DRAFT, InvoiceStatus.PUBLISHED],
  [InvoiceStatus.DRAFT, InvoiceStatus.REJECTED],
  [InvoiceStatus.DRAFT, InvoiceStatus.CANCELLED],
  [InvoiceStatus.PENDING, InvoiceStatus.PUBLISHED],
  [InvoiceStatus.PENDING, InvoiceStatus.REJECTED],
  [InvoiceStatus.PENDING, InvoiceStatus.CANCELLED],
  [InvoiceStatus.PUBLISHED, InvoiceStatus.FUNDED],
  [InvoiceStatus.PUBLISHED, InvoiceStatus.CANCELLED],
  [InvoiceStatus.PUBLISHED, InvoiceStatus.FAILED],
  [InvoiceStatus.FUNDED, InvoiceStatus.SETTLED],
  [InvoiceStatus.FUNDED, InvoiceStatus.CANCELLED],
];

const isValidEdge = (from: InvoiceStatus, to: InvoiceStatus) =>
  VALID_EDGES.some(([f, t]) => f === from && t === to);

const INVALID_EDGES = ALL_STATUSES.flatMap((from) =>
  ALL_STATUSES.filter((to) => !isValidEdge(from, to)).map(
    (to) => [from, to] as [InvoiceStatus, InvoiceStatus]
  )
);

describe("invoice status state machine (#468)", () => {
  describe("transition graph", () => {
    it("follows submitted â†’ under review â†’ active â†’ funded â†’ settled", () => {
      expect(allowedTransitionsFrom(InvoiceStatus.DRAFT)).toContain(InvoiceStatus.PENDING);
      expect(allowedTransitionsFrom(InvoiceStatus.PENDING)).toContain(InvoiceStatus.PUBLISHED);
      expect(allowedTransitionsFrom(InvoiceStatus.PUBLISHED)).toContain(InvoiceStatus.FUNDED);
      expect(allowedTransitionsFrom(InvoiceStatus.FUNDED)).toContain(InvoiceStatus.SETTLED);
      expect(allowedTransitionsFrom(InvoiceStatus.PENDING)).toContain(InvoiceStatus.REJECTED);
    });

    it("treats settled, rejected and cancelled as terminal", () => {
      expect(isTerminalStatus(InvoiceStatus.SETTLED)).toBe(true);
      expect(isTerminalStatus(InvoiceStatus.REJECTED)).toBe(true);
      expect(isTerminalStatus(InvoiceStatus.CANCELLED)).toBe(true);
      expect(isTerminalStatus(InvoiceStatus.FAILED)).toBe(true);
      expect(isTerminalStatus(InvoiceStatus.DRAFT)).toBe(false);
    });

    it("declares exactly the expected edges", () => {
      const declared = ALL_STATUSES.flatMap((from) =>
        allowedTransitionsFrom(from).map((to) => `${from}->${to}`)
      );
      expect(declared.sort()).toEqual(VALID_EDGES.map(([f, t]) => `${f}->${t}`).sort());
    });
  });

  describe("valid paths", () => {
    it.each(VALID_EDGES)("applies %s â†’ %s and records it in history", async (from, to) => {
      const invoice = makeInvoice({ status: from });
      const { store, savedInvoices, history } = createStore();
      const { actor, context } = validInputs(from, to);
      const machine = new InvoiceStateMachine([], createMockLogger());

      const transition = await machine.transition(store, invoice, to, {
        actor,
        trigger: "admin_approved",
        context,
      });

      expect(transition.from).toBe(from);
      expect(transition.to).toBe(to);
      expect(invoice.status).toBe(to);
      expect(savedInvoices).toHaveLength(1);
      expect(savedInvoices[0].status).toBe(to);
      expect(history).toEqual([
        expect.objectContaining({
          invoiceId: invoice.id,
          fromStatus: from,
          toStatus: to,
          actorRole: actor.role,
          trigger: "admin_approved",
        }),
      ]);
    });

    it("stores the rejection reason on the invoice and in history", async () => {
      const invoice = makeInvoice({ status: InvoiceStatus.PENDING });
      const { store, history } = createStore();

      await new InvoiceStateMachine().transition(store, invoice, InvoiceStatus.REJECTED, {
        actor: { role: "admin", id: "admin-1" },
        trigger: "admin_rejected",
        context: { reason: "  Missing purchase order  " },
      });

      expect(invoice.rejectionReason).toBe("Missing purchase order");
      expect(history[0]).toMatchObject({ reason: "Missing purchase order", actorId: "admin-1" });
    });
  });

  describe("invalid paths", () => {
    it.each(INVALID_EDGES)("rejects %s â†’ %s with a descriptive 422", (from, to) => {
      const invoice = makeInvoice({ status: from });
      const error = captureError(() =>
        assertTransition(invoice, to, { role: "admin", id: "admin-1" })
      );

      expect(error).toBeInstanceOf(ServiceError);
      expect(error).toMatchObject({
        code: "invalid_status_transition",
        statusCode: 422,
        details: { from, to, allowedTransitions: allowedTransitionsFrom(from) },
      });
      expect(error.message).toContain(from);
      expect(error.message).toContain(to);
    });

    it("says when the current status is terminal", () => {
      const error = captureError(() =>
        assertTransition(makeInvoice({ status: InvoiceStatus.SETTLED }), InvoiceStatus.FUNDED, {
          role: "admin",
        })
      );
      expect(error.message).toMatch(/settled is a terminal status/);
    });

    it("lists the allowed next statuses in the message", () => {
      const error = captureError(() =>
        assertTransition(makeInvoice({ status: InvoiceStatus.FUNDED }), InvoiceStatus.PUBLISHED, {
          role: "admin",
        })
      );
      expect(error.message).toMatch(/Allowed next statuses from funded: settled, cancelled/);
    });

    it("does not modify or persist the invoice", async () => {
      const invoice = makeInvoice({ status: InvoiceStatus.SETTLED });
      const { store, savedInvoices, history } = createStore();

      await expect(
        new InvoiceStateMachine().transition(store, invoice, InvoiceStatus.PUBLISHED, {
          actor: { role: "admin" },
          trigger: "admin_approved",
        })
      ).rejects.toMatchObject({ code: "invalid_status_transition" });

      expect(invoice.status).toBe(InvoiceStatus.SETTLED);
      expect(savedInvoices).toHaveLength(0);
      expect(history).toHaveLength(0);
    });
  });

  describe("role guards", () => {
    const cases = VALID_EDGES.flatMap(([from, to]) => {
      const allowedRole = validInputs(from, to).actor.role;
      return ALL_ROLES.filter((role) => {
        // Some edges accept more than one role; only test roles no rule allows.
        try {
          assertTransition(
            makeInvoice({ status: from }),
            to,
            { role, id: SELLER_ID },
            {
              ...validInputs(from, to).context,
            }
          );
          return false;
        } catch (error) {
          return (error as ServiceError).code === "transition_not_permitted";
        }
      }).map((role) => [from, to, role, allowedRole] as const);
    });

    it("has forbidden roles to check", () => {
      expect(cases.length).toBeGreaterThan(10);
    });

    it.each(cases)("forbids %s â†’ %s for role %s", (from, to, role) => {
      const error = captureError(() =>
        assertTransition(
          makeInvoice({ status: from }),
          to,
          { role, id: SELLER_ID },
          validInputs(from, to).context
        )
      );
      expect(error).toMatchObject({ code: "transition_not_permitted", statusCode: 403 });
    });

    it("only lets the invoice's own seller act as seller", () => {
      const error = captureError(() =>
        assertTransition(makeInvoice({ status: InvoiceStatus.DRAFT }), InvoiceStatus.PUBLISHED, {
          role: "seller",
          id: "someone-else",
        })
      );
      expect(error).toMatchObject({ code: "transition_not_permitted", statusCode: 403 });
      expect(error.message).toMatch(/Only the invoice's seller/);
    });

    it("reserves review approval for admins", () => {
      const error = captureError(() =>
        assertTransition(makeInvoice({ status: InvoiceStatus.PENDING }), InvoiceStatus.PUBLISHED, {
          role: "seller",
          id: SELLER_ID,
        })
      );
      expect(error).toMatchObject({ code: "transition_not_permitted", statusCode: 403 });
    });
  });

  describe("preconditions", () => {
    it("refuses to publish an invoice that fails pre-publish validation", () => {
      const invoice = makeInvoice({ ipfsHash: null });
      const error = captureError(() =>
        assertTransition(invoice, InvoiceStatus.PUBLISHED, { role: "seller", id: SELLER_ID })
      );
      expect(error).toMatchObject({ code: "invoice_not_publishable", statusCode: 422 });
    });

    it("refuses to mark an under-funded invoice as funded", () => {
      const invoice = makeInvoice({ status: InvoiceStatus.PUBLISHED });
      const error = captureError(() =>
        assertTransition(
          invoice,
          InvoiceStatus.FUNDED,
          { role: "system" },
          { fundedAmount: "949.9999" }
        )
      );
      expect(error).toMatchObject({ code: "transition_precondition_failed", statusCode: 422 });
      expect(error.message).toMatch(/949\.9999 of 950\.0000/);
    });

    it("requires the funded amount to mark an invoice as funded", () => {
      const invoice = makeInvoice({ status: InvoiceStatus.PUBLISHED });
      expect(() => assertTransition(invoice, InvoiceStatus.FUNDED, { role: "system" })).toThrow(
        /funded amount is required/
      );
    });

    it("requires a reason to reject", () => {
      const invoice = makeInvoice({ status: InvoiceStatus.PENDING });
      const error = captureError(() =>
        assertTransition(invoice, InvoiceStatus.REJECTED, { role: "admin" }, { reason: "   " })
      );
      expect(error).toMatchObject({ code: "transition_precondition_failed", statusCode: 422 });
    });
  });

  describe("side effects", () => {
    async function publishWith(machine: InvoiceStateMachine) {
      const invoice = makeInvoice();
      return machine.transition(createStore().store, invoice, InvoiceStatus.PUBLISHED, {
        actor: { role: "seller", id: SELLER_ID },
        trigger: "seller_published",
      });
    }

    it("do not run until the transition is dispatched", async () => {
      const effect = jest.fn();
      await publishWith(new InvoiceStateMachine([effect]));
      expect(effect).not.toHaveBeenCalled();
    });

    it("fire exactly once per transition, even if dispatched twice", async () => {
      const effect = jest.fn();
      const machine = new InvoiceStateMachine([effect]);
      const transition = await publishWith(machine);

      await machine.dispatch(transition);
      await machine.dispatch(transition);

      expect(effect).toHaveBeenCalledTimes(1);
      expect(effect).toHaveBeenCalledWith(transition);
    });

    it("never fire for a rejected transition", async () => {
      const effect = jest.fn();
      const machine = new InvoiceStateMachine([effect]);

      await expect(
        machine.transitionAndDispatch(
          createStore().store,
          makeInvoice({ status: InvoiceStatus.CANCELLED }),
          InvoiceStatus.PUBLISHED,
          { actor: { role: "seller", id: SELLER_ID }, trigger: "seller_published" }
        )
      ).rejects.toThrow(ServiceError);

      expect(effect).not.toHaveBeenCalled();
    });

    it("keep running when one effect fails, and log the failure", async () => {
      const log = createMockLogger();
      const failing = jest.fn().mockRejectedValue(new Error("smtp down"));
      const after = jest.fn();
      const machine = new InvoiceStateMachine([failing, after], log);

      await expect(machine.dispatch(await publishWith(machine))).resolves.toBeUndefined();

      expect(after).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        "Invoice transition side effect failed.",
        expect.objectContaining({ error: "smtp down", to_state: InvoiceStatus.PUBLISHED })
      );
    });

    it("writes the lifecycle audit log", async () => {
      const log = createMockLogger();
      const machine = new InvoiceStateMachine([createAuditLogEffect(log)]);
      const transition = await publishWith(machine);
      await machine.dispatch(transition);

      expect(log.info).toHaveBeenCalledWith(
        "Invoice lifecycle state transition.",
        expect.objectContaining({
          invoice_id: transition.invoice.id,
          from_state: InvoiceStatus.DRAFT,
          to_state: InvoiceStatus.PUBLISHED,
          reason: "seller_published",
        })
      );
    });

    it("notifies the seller", async () => {
      const sink = { createNotification: jest.fn().mockResolvedValue(undefined) };
      const machine = new InvoiceStateMachine([createSellerNotificationEffect(sink)]);
      await machine.dispatch(await publishWith(machine));

      expect(sink.createNotification).toHaveBeenCalledWith(
        SELLER_ID,
        NotificationType.INVOICE,
        "Invoice Published",
        expect.stringContaining("INV-SM-468")
      );
    });

    it("invalidates the invoice's cached views", async () => {
      const invalidator = { invalidate: jest.fn() };
      const machine = new InvoiceStateMachine([createCacheInvalidationEffect(invalidator)]);
      const transition = await machine.transition(
        createStore().store,
        makeInvoice({ status: InvoiceStatus.PUBLISHED }),
        InvoiceStatus.FUNDED,
        { actor: { role: "system" }, trigger: "fully_funded", context: { fundedAmount: "950" } }
      );
      await machine.dispatch(transition);

      expect(invalidator.invalidate).toHaveBeenCalledWith([
        `invoice:${transition.invoice.id}`,
        `seller:${SELLER_ID}:invoices`,
        "marketplace:listings",
      ]);
    });

    it("are all wired by createInvoiceStateMachine", async () => {
      const sink = { createNotification: jest.fn().mockResolvedValue(undefined) };
      const invalidator = { invalidate: jest.fn() };
      const extra = jest.fn();
      const machine = createInvoiceStateMachine({
        notificationSink: sink,
        cacheInvalidator: invalidator,
        logger: createMockLogger(),
        effects: [extra],
      });

      await machine.dispatch(await publishWith(machine));

      expect(sink.createNotification).toHaveBeenCalledTimes(1);
      expect(invalidator.invalidate).toHaveBeenCalledTimes(1);
      expect(extra).toHaveBeenCalledTimes(1);
    });
  });

  describe("entityManagerTransitionStore", () => {
    it("writes the invoice and its history row through the same manager", async () => {
      const save = jest.fn(async (_entity: unknown, value: unknown) => value);
      const store = entityManagerTransitionStore({ save } as never);
      const invoice = makeInvoice();

      await new InvoiceStateMachine().transition(store, invoice, InvoiceStatus.PENDING, {
        actor: { role: "seller", id: SELLER_ID },
        trigger: "seller_submitted",
      });

      expect(save).toHaveBeenNthCalledWith(1, Invoice, invoice);
      expect(save).toHaveBeenNthCalledWith(
        2,
        InvoiceStatusHistory,
        expect.objectContaining({
          fromStatus: InvoiceStatus.DRAFT,
          toStatus: InvoiceStatus.PENDING,
        })
      );
    });
  });

  describe("service integration", () => {
    function createFakeDataSource(invoice: Invoice, investments: Investment[] = []) {
      const saves: Array<[unknown, unknown]> = [];
      let failNextCommit = false;
      const manager = {
        createQueryBuilder: () => {
          const builder = {
            setLock: () => builder,
            where: () => builder,
            getOne: async () => invoice,
          };
          return builder;
        },
        find: async () => investments,
        create: (_entity: unknown, data: object) => ({ id: crypto.randomUUID(), ...data }),
        save: async (entity: unknown, value: unknown) => {
          saves.push([entity, value]);
          return value;
        },
      };
      const dataSource = {
        transaction: async (work: (m: typeof manager) => Promise<unknown>) => {
          const result = await work(manager);
          if (failNextCommit) {
            failNextCommit = false;
            throw new Error("commit failed");
          }
          return result;
        },
        // Issue #473 â€” the accreditation gate looks the investor's terms
        // acknowledgement up before creating the investment.
        getRepository: (entity: unknown) =>
          entity === InvestorAcknowledgement
            ? { findOne: async () => ({ acknowledgedAt: new Date() }) }
            : manager,
      } as unknown as DataSource;
      return {
        dataSource,
        saves,
        failCommit: () => {
          failNextCommit = true;
        },
      };
    }

    const historyRows = (saves: Array<[unknown, unknown]>) =>
      saves.filter(([entity]) => entity === InvoiceStatusHistory).map(([, row]) => row);

    it("funds the invoice through the machine and notifies after commit", async () => {
      const invoice = makeInvoice({ status: InvoiceStatus.PUBLISHED });
      const { dataSource, saves } = createFakeDataSource(invoice);
      const effect = jest.fn();
      const service = new InvestmentService(dataSource, new InvoiceStateMachine([effect]));

      await service.createInvestment({
        invoiceId: invoice.id,
        investorId: "investor-1",
        investmentAmount: "950",
        investorWallet: "GINVESTOR0000000000000000000000000000000000000000000000",
      });

      expect(invoice.status).toBe(InvoiceStatus.FUNDED);
      expect(historyRows(saves)).toEqual([
        expect.objectContaining({
          fromStatus: InvoiceStatus.PUBLISHED,
          toStatus: InvoiceStatus.FUNDED,
          actorRole: "system",
          trigger: "fully_funded",
        }),
      ]);
      expect(effect).toHaveBeenCalledTimes(1);
    });

    it("does not fire funding side effects when the transaction fails to commit", async () => {
      const invoice = makeInvoice({ status: InvoiceStatus.PUBLISHED });
      const { dataSource, failCommit } = createFakeDataSource(invoice);
      const effect = jest.fn();
      const service = new InvestmentService(dataSource, new InvoiceStateMachine([effect]));
      failCommit();

      await expect(
        service.createInvestment({
          invoiceId: invoice.id,
          investorId: "investor-1",
          investmentAmount: "950",
          investorWallet: "GINVESTOR0000000000000000000000000000000000000000000000",
        })
      ).rejects.toThrow("commit failed");

      expect(effect).not.toHaveBeenCalled();
    });

    it("settles the invoice through the machine and records history", async () => {
      const invoice = makeInvoice({ status: InvoiceStatus.FUNDED });
      const investment = {
        id: "inv-1",
        invoiceId: invoice.id,
        investorId: "investor-1",
        investmentAmount: "950.0000",
        status: InvestmentStatus.CONFIRMED,
      } as Investment;
      const { dataSource, saves } = createFakeDataSource(invoice, [investment]);
      const effect = jest.fn();
      const infoSpy = jest.spyOn(logger, "info");
      const service = new SettlementService(
        dataSource,
        undefined,
        undefined,
        new InvoiceStateMachine([effect])
      );

      const result = await service.settleInvoice({
        invoiceId: invoice.id,
        proceeds: "1000",
        actorWallet: "GADMIN00000000000000000000000000000000000000000000000000",
      });

      expect(result.status).toBe(InvoiceStatus.SETTLED);
      expect(result.settlements).toEqual([
        expect.objectContaining({ investmentId: "inv-1", actualReturn: "1000.0000" }),
      ]);
      expect(invoice.status).toBe(InvoiceStatus.SETTLED);
      expect(historyRows(saves)).toEqual([
        expect.objectContaining({
          fromStatus: InvoiceStatus.FUNDED,
          toStatus: InvoiceStatus.SETTLED,
        }),
      ]);
      expect(effect).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledWith(
        "Settlement flow completed.",
        expect.objectContaining({ invoice_id: invoice.id, investor_count: 1 })
      );
      infoSpy.mockRestore();
    });

    it("rejects settling an invoice that is not funded without side effects", async () => {
      const invoice = makeInvoice({ status: InvoiceStatus.PUBLISHED });
      const { dataSource, saves } = createFakeDataSource(invoice);
      const effect = jest.fn();
      const service = new SettlementService(
        dataSource,
        undefined,
        undefined,
        new InvoiceStateMachine([effect])
      );

      await expect(
        service.settleInvoice({ invoiceId: invoice.id, proceeds: "1000", actorWallet: "GADMIN" })
      ).rejects.toMatchObject({ code: "INVALID_INVOICE_STATUS" });

      expect(historyRows(saves)).toHaveLength(0);
      expect(effect).not.toHaveBeenCalled();
    });
  });

  describe("HTTP error shape", () => {
    it("returns invalid transitions as a structured 422", async () => {
      const invoiceService = {
        publishInvoice: jest
          .fn()
          .mockRejectedValue(
            captureError(() =>
              assertTransition(
                makeInvoice({ status: InvoiceStatus.SETTLED }),
                InvoiceStatus.PUBLISHED,
                { role: "seller", id: SELLER_ID }
              )
            )
          ),
      } as unknown as InvoiceService;
      const controller = createInvoiceController(invoiceService);

      const app = express();
      app.post(
        "/invoices/:id/publish",
        (req, _res, next) => {
          req.user = { id: SELLER_ID } as never;
          next();
        },
        controller.publishInvoice as express.RequestHandler
      );
      app.use(createErrorMiddleware(createMockLogger()));

      const response = await request(app).post("/invoices/inv-1/publish").expect(422);

      expect(response.body).toEqual({
        success: false,
        error: {
          code: "INVALID_STATUS_TRANSITION",
          message:
            "Cannot transition invoice from settled to published. settled is a terminal status.",
          details: {
            from: InvoiceStatus.SETTLED,
            to: InvoiceStatus.PUBLISHED,
            allowedTransitions: [],
          },
        },
      });
    });
  });
});

function captureError(fn: () => unknown): ServiceError {
  try {
    fn();
  } catch (error) {
    return error as ServiceError;
  }
  throw new Error("Expected function to throw");
}
