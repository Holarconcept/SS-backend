import { Decimal } from "decimal.js";
import { In, type EntityManager } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { SettlementIntent, SettlementIntentStatus } from "../models/SettlementIntent.model";
import {
  InvoiceStatusHistory,
  type InvoiceTransitionActorRole,
} from "../models/InvoiceStatusHistory.model";
import { logger as defaultLogger, type AppLogger } from "../observability/logger";
import { InvoiceStatus, NotificationType } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { logInvoiceTransition, type InvoiceTransitionReason } from "./invoice-lifecycle-log";
import { validateInvoiceForPublish } from "./validate-invoice-for-publish";

/**
 * Invoice status state machine (issue #468).
 *
 * The lifecycle maps onto the stored statuses as follows:
 *
 *   draft (submitted) → pending (under review) → published (active)
 *     → funded → settled
 *
 * with `rejected` reachable from draft/pending and `cancelled` as an escape
 * hatch before settlement. `failed` is set by the maturity job when a
 * published invoice is still not fully funded at its due date. Sellers may still publish a draft directly, which
 * is the existing self-serve flow; `pending` is the path for invoices that go
 * through admin review first.
 *
 * Every status change must go through {@link InvoiceStateMachine.transition}
 * so the graph, role checks and preconditions are enforced in one place, the
 * change is recorded in `invoice_status_history`, and side effects fire
 * exactly once after the change is committed.
 */

export type { InvoiceTransitionActorRole } from "../models/InvoiceStatusHistory.model";

export interface TransitionActor {
  role: InvoiceTransitionActorRole;
  /** User id for sellers/admins; checked against the invoice owner for sellers. */
  id?: string | null;
  /** Stellar address, used in the audit log when known. */
  wallet?: string | null;
}

export interface TransitionContext {
  /** Total amount committed to the invoice; required to move published → funded. */
  fundedAmount?: string;
  /** Free-text reason; required to reject. */
  reason?: string | null;
}

interface TransitionRule {
  from: InvoiceStatus;
  to: InvoiceStatus;
  roles: readonly InvoiceTransitionActorRole[];
  /** Returns a failure message when the precondition is not met. */
  guard?: (invoice: Invoice, context: TransitionContext) => string | null;
  /** Error code for a failed guard; defaults to `transition_precondition_failed`. */
  guardCode?: string;
}

const publishReady = (invoice: Invoice): string | null => {
  const errors = validateInvoiceForPublish(invoice);
  return errors.length > 0
    ? `Invoice failed pre-publish validation: ${errors.map((e) => e.message).join(" ")}`
    : null;
};

const reasonRequired = (_invoice: Invoice, context: TransitionContext): string | null =>
  context.reason?.trim() ? null : "A reason is required to reject an invoice.";

const fullyFunded = (invoice: Invoice, context: TransitionContext): string | null => {
  if (context.fundedAmount === undefined) {
    return "The funded amount is required to mark an invoice as funded.";
  }
  const funded = new Decimal(context.fundedAmount);
  return funded.gte(invoice.netAmount)
    ? null
    : `Invoice is not fully funded: ${funded.toFixed(4)} of ${new Decimal(invoice.netAmount).toFixed(4)} committed.`;
};

const TRANSITION_RULES: readonly TransitionRule[] = Object.freeze([
  {
    from: InvoiceStatus.DRAFT,
    to: InvoiceStatus.PENDING,
    roles: ["seller"],
    guard: publishReady,
    guardCode: "invoice_not_publishable",
  },
  {
    from: InvoiceStatus.DRAFT,
    to: InvoiceStatus.PUBLISHED,
    roles: ["seller"],
    guard: publishReady,
    guardCode: "invoice_not_publishable",
  },
  {
    from: InvoiceStatus.PENDING,
    to: InvoiceStatus.PUBLISHED,
    roles: ["admin"],
    guard: publishReady,
    guardCode: "invoice_not_publishable",
  },
  {
    from: InvoiceStatus.DRAFT,
    to: InvoiceStatus.REJECTED,
    roles: ["admin"],
    guard: reasonRequired,
  },
  {
    from: InvoiceStatus.PENDING,
    to: InvoiceStatus.REJECTED,
    roles: ["admin"],
    guard: reasonRequired,
  },
  {
    from: InvoiceStatus.PUBLISHED,
    to: InvoiceStatus.FUNDED,
    roles: ["system"],
    guard: fullyFunded,
  },
  { from: InvoiceStatus.FUNDED, to: InvoiceStatus.SETTLED, roles: ["admin", "system"] },
  // Maturity job: still not fully funded when the due date arrives.
  { from: InvoiceStatus.PUBLISHED, to: InvoiceStatus.FAILED, roles: ["system"] },
  { from: InvoiceStatus.DRAFT, to: InvoiceStatus.CANCELLED, roles: ["seller", "admin"] },
  { from: InvoiceStatus.PENDING, to: InvoiceStatus.CANCELLED, roles: ["seller", "admin"] },
  { from: InvoiceStatus.PUBLISHED, to: InvoiceStatus.CANCELLED, roles: ["admin"] },
  { from: InvoiceStatus.FUNDED, to: InvoiceStatus.CANCELLED, roles: ["admin"] },
]);

/** Statuses reachable from `from`, in declaration order. Empty for terminal states. */
export function allowedTransitionsFrom(from: InvoiceStatus): InvoiceStatus[] {
  return TRANSITION_RULES.filter((rule) => rule.from === from).map((rule) => rule.to);
}

export function isTerminalStatus(status: InvoiceStatus): boolean {
  return allowedTransitionsFrom(status).length === 0;
}

function findRule(from: InvoiceStatus, to: InvoiceStatus): TransitionRule | undefined {
  return TRANSITION_RULES.find((rule) => rule.from === from && rule.to === to);
}

/**
 * Throws a {@link ServiceError} describing why `actor` may not move `invoice`
 * to `to`, or returns normally when the transition is allowed:
 *
 * - 422 `invalid_status_transition` — the edge is not in the graph
 * - 403 `transition_not_permitted` — the actor's role (or, for sellers,
 *   ownership) does not allow it
 * - 422 `invoice_not_publishable` / `transition_precondition_failed` — the
 *   edge exists but its precondition (publishable, fully funded, reason
 *   given) does not hold
 */
export function assertTransition(
  invoice: Invoice,
  to: InvoiceStatus,
  actor: TransitionActor,
  context: TransitionContext = {}
): void {
  const from = invoice.status;
  const rule = findRule(from, to);

  if (!rule) {
    const allowed = allowedTransitionsFrom(from);
    throw new ServiceError(
      "invalid_status_transition",
      `Cannot transition invoice from ${from} to ${to}. ` +
        (allowed.length > 0
          ? `Allowed next statuses from ${from}: ${allowed.join(", ")}.`
          : `${from} is a terminal status.`),
      422,
      { from, to, allowedTransitions: allowed }
    );
  }

  const ownerMismatch = actor.role === "seller" && actor.id !== invoice.sellerId;
  if (!rule.roles.includes(actor.role) || ownerMismatch) {
    throw new ServiceError(
      "transition_not_permitted",
      ownerMismatch && rule.roles.includes("seller")
        ? `Only the invoice's seller can move it from ${from} to ${to}.`
        : `Role ${actor.role} cannot move an invoice from ${from} to ${to}.`,
      403,
      { from, to, allowedRoles: rule.roles }
    );
  }

  const failure = rule.guard?.(invoice, context);
  if (failure) {
    throw new ServiceError(rule.guardCode ?? "transition_precondition_failed", failure, 422, {
      from,
      to,
    });
  }
}

/** A committed status change, handed to side effects. */
export interface InvoiceTransition {
  invoice: Invoice;
  from: InvoiceStatus;
  to: InvoiceStatus;
  actor: TransitionActor;
  trigger: InvoiceTransitionReason;
  reason: string | null;
  history: InvoiceStatusHistory | null;
  occurredAt: Date;
}

export type TransitionEffect = (transition: InvoiceTransition) => void | Promise<void>;

/**
 * Where the machine writes a transition. Both writes should share one
 * database transaction; {@link entityManagerTransitionStore} does that when
 * given a transactional EntityManager.
 */
export interface InvoiceTransitionStore {
  saveInvoice(invoice: Invoice): Promise<Invoice>;
  /** Omitted only by stores without a database (e.g. repository mocks). */
  recordHistory?(
    entry: Omit<InvoiceStatusHistory, "id" | "createdAt">
  ): Promise<InvoiceStatusHistory>;
}

export function entityManagerTransitionStore(manager: EntityManager): InvoiceTransitionStore {
  return {
    saveInvoice: async (invoice) => {
      if (invoice.status === InvoiceStatus.CANCELLED) {
        try {
          await manager
            .createQueryBuilder(Invoice, "invoice")
            .setLock("pessimistic_write")
            .where("invoice.id = :id", { id: invoice.id })
            .getOne();
        } catch {
          await manager.findOne(Invoice, { where: { id: invoice.id } });
        }
        const settlementIntent = await manager.findOne(SettlementIntent, {
          where: {
            invoiceId: invoice.id,
            status: In([
              SettlementIntentStatus.PREPARED,
              SettlementIntentStatus.SUBMITTING,
              SettlementIntentStatus.DISTRIBUTED,
            ]),
          },
        });
        if (settlementIntent) {
          throw new ServiceError(
            "SETTLEMENT_IN_PROGRESS",
            "Invoice cannot be cancelled while a settlement payout is pending",
            409
          );
        }
      }
      return manager.save(Invoice, invoice);
    },
    recordHistory: (entry) =>
      manager.save(
        InvoiceStatusHistory,
        entry as InvoiceStatusHistory
      ) as Promise<InvoiceStatusHistory>,
  };
}

export interface TransitionOptions {
  actor: TransitionActor;
  trigger: InvoiceTransitionReason;
  context?: TransitionContext;
}

export class InvoiceStateMachine {
  // Tracks which transitions have had their effects run, so a caller that
  // dispatches twice (e.g. from a retry path) cannot double-notify.
  private readonly dispatched = new WeakSet<InvoiceTransition>();

  constructor(
    private readonly effects: readonly TransitionEffect[] = [],
    private readonly log: AppLogger = defaultLogger
  ) {}

  /**
   * Validates and applies a transition: updates the invoice, saves it and
   * appends a history row through `store`. Side effects are NOT run here;
   * call {@link dispatch} once the surrounding database transaction has
   * committed, so a rollback never leaves a notification behind.
   */
  async transition(
    store: InvoiceTransitionStore,
    invoice: Invoice,
    to: InvoiceStatus,
    { actor, trigger, context = {} }: TransitionOptions
  ): Promise<InvoiceTransition> {
    assertTransition(invoice, to, actor, context);

    const from = invoice.status;
    const reason = context.reason?.trim() || null;

    invoice.status = to;
    if (to === InvoiceStatus.REJECTED) {
      invoice.rejectionReason = reason;
    }

    const saved = await store.saveInvoice(invoice);
    const history = store.recordHistory
      ? await store.recordHistory({
          invoiceId: invoice.id,
          fromStatus: from,
          toStatus: to,
          actorRole: actor.role,
          actorId: actor.id ?? actor.wallet ?? null,
          trigger,
          reason,
        })
      : null;

    return {
      invoice: saved ?? invoice,
      from,
      to,
      actor,
      trigger,
      reason,
      history,
      occurredAt: new Date(),
    };
  }

  /**
   * Runs every registered side effect for a committed transition, at most
   * once per transition. A failing effect is logged and does not stop the
   * others: the status change has already been committed and must not be
   * reported to the caller as failed.
   */
  async dispatch(transition: InvoiceTransition): Promise<void> {
    if (this.dispatched.has(transition)) {
      return;
    }
    this.dispatched.add(transition);

    for (const effect of this.effects) {
      try {
        await effect(transition);
      } catch (error) {
        this.log.warn("Invoice transition side effect failed.", {
          invoice_id: transition.invoice.id,
          from_state: transition.from,
          to_state: transition.to,
          effect: effect.name || "anonymous",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Convenience for callers without an outer database transaction. */
  async transitionAndDispatch(
    store: InvoiceTransitionStore,
    invoice: Invoice,
    to: InvoiceStatus,
    options: TransitionOptions
  ): Promise<InvoiceTransition> {
    const transition = await this.transition(store, invoice, to, options);
    await this.dispatch(transition);
    return transition;
  }
}

// ── Side effects ───────────────────────────────────────────────────────────

/**
 * Minimal contract for notifying a user, satisfied by
 * `NotificationService.createNotification` (see notification.service.ts).
 */
export interface NotificationSink {
  createNotification(
    userId: string,
    type: NotificationType,
    title: string,
    message: string
  ): Promise<unknown>;
}

/** Cache layer hook; each key names a cached view the transition makes stale. */
export interface CacheInvalidator {
  invalidate(keys: string[]): void | Promise<void>;
}

export function createAuditLogEffect(log: AppLogger = defaultLogger): TransitionEffect {
  return function auditLog(transition) {
    logInvoiceTransition(log, {
      invoiceId: transition.invoice.id,
      fromState: transition.from,
      toState: transition.to,
      actorWallet: transition.actor.wallet ?? transition.actor.id ?? transition.actor.role,
      reason: transition.trigger,
    });
  };
}

const SELLER_MESSAGES: Partial<
  Record<InvoiceStatus, (invoice: Invoice, reason: string | null) => [string, string]>
> = {
  [InvoiceStatus.PENDING]: (invoice) => [
    "Invoice Submitted for Review",
    `Your invoice ${invoice.invoiceNumber} has been submitted and is awaiting review.`,
  ],
  [InvoiceStatus.PUBLISHED]: (invoice) => [
    "Invoice Published",
    `Your invoice ${invoice.invoiceNumber} is now live on the marketplace.`,
  ],
  [InvoiceStatus.REJECTED]: (invoice, reason) => [
    "Invoice Rejected",
    `Your invoice ${invoice.invoiceNumber} has been rejected: ${reason ?? "no reason given"}`,
  ],
  [InvoiceStatus.FUNDED]: (invoice) => [
    "Invoice Funded",
    `Your invoice ${invoice.invoiceNumber} has been fully funded.`,
  ],
  [InvoiceStatus.SETTLED]: (invoice) => [
    "Invoice Settled",
    `Your invoice ${invoice.invoiceNumber} has been settled.`,
  ],
  [InvoiceStatus.CANCELLED]: (invoice) => [
    "Invoice Cancelled",
    `Your invoice ${invoice.invoiceNumber} has been cancelled.`,
  ],
  [InvoiceStatus.FAILED]: (invoice) => [
    "Invoice Failed",
    `Your invoice ${invoice.invoiceNumber} reached maturity without being fully funded.`,
  ],
};

// Lifecycle events with their own type so clients can filter on them;
// other status changes are reported as generic invoice notifications.
const SELLER_NOTIFICATION_TYPES: Partial<Record<InvoiceStatus, NotificationType>> = {
  [InvoiceStatus.REJECTED]: NotificationType.INVOICE_REJECTED,
  [InvoiceStatus.FUNDED]: NotificationType.INVOICE_FUNDED,
  [InvoiceStatus.SETTLED]: NotificationType.INVOICE_SETTLED,
};

export function createSellerNotificationEffect(sink: NotificationSink): TransitionEffect {
  return async function notifySeller(transition) {
    const build = SELLER_MESSAGES[transition.to];
    if (!build) return;
    const [title, message] = build(transition.invoice, transition.reason);
    await sink.createNotification(
      transition.invoice.sellerId,
      SELLER_NOTIFICATION_TYPES[transition.to] ?? NotificationType.INVOICE,
      title,
      message
    );
  };
}

export function invoiceCacheKeys(invoice: Invoice): string[] {
  return [`invoice:${invoice.id}`, `seller:${invoice.sellerId}:invoices`, "marketplace:listings"];
}

export function createCacheInvalidationEffect(invalidator: CacheInvalidator): TransitionEffect {
  return async function invalidateCaches(transition) {
    await invalidator.invalidate(invoiceCacheKeys(transition.invoice));
  };
}

export interface InvoiceStateMachineDependencies {
  notificationSink?: NotificationSink;
  cacheInvalidator?: CacheInvalidator;
  logger?: AppLogger;
  /** Extra effects, run after the built-in ones. */
  effects?: TransitionEffect[];
}

export function createInvoiceStateMachine({
  notificationSink,
  cacheInvalidator,
  logger: log = defaultLogger,
  effects = [],
}: InvoiceStateMachineDependencies = {}): InvoiceStateMachine {
  return new InvoiceStateMachine(
    [
      createAuditLogEffect(log),
      ...(cacheInvalidator ? [createCacheInvalidationEffect(cacheInvalidator)] : []),
      ...(notificationSink ? [createSellerNotificationEffect(notificationSink)] : []),
      ...effects,
    ],
    log
  );
}
