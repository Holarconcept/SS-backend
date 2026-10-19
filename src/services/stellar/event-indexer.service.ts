import { SorobanRpc, scValToNative, xdr } from "stellar-sdk";
import { In, type DataSource, type Repository } from "typeorm";
import type { AppLogger } from "../../observability/logger";
import { logger as globalLogger } from "../../observability/logger";
import { SorobanEventLog } from "../../models/SorobanEventLog.model";
import { Invoice } from "../../models/Invoice.model";
import { Investment } from "../../models/Investment.model";
import { SorobanIndexerCheckpoint } from "../../models/SorobanIndexerCheckpoint.model";
import { InvestmentStatus, InvoiceStatus } from "../../types/enums";
import type { DecodedSorobanEvent } from "../../types/soroban.types";
import type { ContractEventBus } from "../contract-event-bus.service";

export interface EventIndexerServiceDependencies {
  contractIds: string[];
  rpcUrl?: string;
  server?: SorobanRpc.Server;
  dataSource?: DataSource;
  logger?: AppLogger;
  eventLogRepository?: Repository<SorobanEventLog>;
  checkpointRepository?: Repository<SorobanIndexerCheckpoint>;
  invoiceRepository?: Repository<Invoice>;
  investmentRepository?: Repository<Investment>;
  lagAlertThresholdLedgers?: number;
  /**
   * Optional fan-out for read-model projections derived from contract events
   * (ACL, curve migrations, atomic swaps, key config). Omitting it preserves
   * the previous behaviour exactly.
   */
  eventBus?: ContractEventBus;
}

export interface PollEventsOptions {
  startLedger?: number;
  limit?: number;
  cursor?: string;
}

export class EventIndexerService {
  readonly contractIds: string[];
  private readonly rpcServer: SorobanRpc.Server;
  private readonly dataSource?: DataSource;
  private readonly logger: AppLogger;
  private readonly eventLogRepository?: Repository<SorobanEventLog>;
  private readonly checkpointRepository?: Repository<SorobanIndexerCheckpoint>;
  private readonly invoiceRepository?: Repository<Invoice>;
  private readonly investmentRepository?: Repository<Investment>;
  private readonly lagAlertThresholdLedgers: number;
  private readonly eventBus?: ContractEventBus;
  private intervalHandle: NodeJS.Timeout | null = null;
  private lastIndexedLedger = 0;
  private latestLedgerSeen = 0;
  private nextCursor?: string;
  private pollInFlight = false;
  private lagAlertActive = false;

  constructor(dependencies: EventIndexerServiceDependencies) {
    if (!dependencies.contractIds || dependencies.contractIds.length === 0) {
      throw new Error("At least one contractId is required.");
    }
    this.contractIds = dependencies.contractIds;
    this.logger = dependencies.logger ?? globalLogger;
    this.dataSource = dependencies.dataSource;
    this.lagAlertThresholdLedgers = dependencies.lagAlertThresholdLedgers ?? 100;
    this.eventBus = dependencies.eventBus;

    if (dependencies.server) {
      this.rpcServer = dependencies.server;
    } else {
      const url = dependencies.rpcUrl ?? "https://soroban-testnet.stellar.org";
      this.rpcServer = new SorobanRpc.Server(url, {
        allowHttp: url.startsWith("http://"),
      });
    }

    if (dependencies.eventLogRepository) {
      this.eventLogRepository = dependencies.eventLogRepository;
    } else if (this.dataSource) {
      this.eventLogRepository = this.dataSource.getRepository(SorobanEventLog);
    }

    if (dependencies.checkpointRepository) {
      this.checkpointRepository = dependencies.checkpointRepository;
    } else if (this.dataSource) {
      this.checkpointRepository = this.dataSource.getRepository(SorobanIndexerCheckpoint);
    }

    if (dependencies.invoiceRepository) {
      this.invoiceRepository = dependencies.invoiceRepository;
    } else if (this.dataSource) {
      this.invoiceRepository = this.dataSource.getRepository(Invoice);
    }

    if (dependencies.investmentRepository) {
      this.investmentRepository = dependencies.investmentRepository;
    } else if (this.dataSource) {
      this.investmentRepository = this.dataSource.getRepository(Investment);
    }
  }

  /**
   * Decodes a raw Soroban event from RPC getEvents response into structured JS object.
   */
  public decodeEvent(rawEvent: SorobanRpc.Api.GetEventsResponse["events"][0]): DecodedSorobanEvent {
    const decodedTopics: unknown[] = [];

    if (rawEvent.topic) {
      for (const topicXdr of rawEvent.topic) {
        try {
          const scVal =
            typeof topicXdr === "string"
              ? xdr.ScVal.fromXDR(topicXdr, "base64")
              : (topicXdr as unknown as xdr.ScVal);
          decodedTopics.push(scValToNative(scVal));
        } catch {
          decodedTopics.push(topicXdr);
        }
      }
    }

    let decodedData: unknown = null;
    if (rawEvent.value) {
      try {
        const scVal =
          typeof rawEvent.value === "string"
            ? xdr.ScVal.fromXDR(rawEvent.value, "base64")
            : (rawEvent.value as unknown as xdr.ScVal);
        decodedData = scValToNative(scVal);
      } catch {
        decodedData = rawEvent.value;
      }
    }

    const primaryTopic =
      decodedTopics.length > 0 && typeof decodedTopics[0] === "string"
        ? (decodedTopics[0] as string)
        : String(decodedTopics[0] ?? "unknown");

    const rawRecord = rawEvent as unknown as Record<string, unknown>;
    const contractIdStr = rawEvent.contractId
      ? typeof rawRecord.contractId === "string"
        ? (rawRecord.contractId as string)
        : typeof (rawEvent.contractId as unknown as { contractId?: () => string }).contractId ===
            "function"
          ? (rawEvent.contractId as unknown as { contractId: () => string }).contractId()
          : String(rawEvent.contractId)
      : "";

    const txHash =
      typeof rawRecord.txHash === "string"
        ? rawRecord.txHash
        : typeof rawRecord.pagingToken === "string"
          ? rawRecord.pagingToken
          : rawEvent.id;

    return {
      id: rawEvent.id,
      contractId: contractIdStr,
      ledger: Number(rawEvent.ledger),
      ledgerClosedAt: rawEvent.ledgerClosedAt,
      txHash,
      topic: primaryTopic,
      topics: decodedTopics,
      data: decodedData,
      inSuccessfulContractCall: rawEvent.inSuccessfulContractCall ?? true,
    };
  }

  /**
   * Polls contract events from Soroban RPC matching configured contract IDs.
   */
  public async pollContractEvents(options: PollEventsOptions = {}): Promise<DecodedSorobanEvent[]> {
    const startLedger = options.startLedger ?? (await this.getLastIndexedLedger()) + 1;

    try {
      const filters = [
        {
          type: "contract" as const,
          contractIds: this.contractIds,
        },
      ];

      const requestParams: SorobanRpc.Server.GetEventsRequest = {
        filters,
        limit: options.limit ?? 100,
      };

      if (startLedger > 1) {
        requestParams.startLedger = startLedger;
      }

      if (options.cursor) {
        requestParams.cursor = options.cursor;
      }

      const response = await this.rpcServer.getEvents(requestParams);
      const events = response.events || [];
      this.latestLedgerSeen = Math.max(this.latestLedgerSeen, response.latestLedger ?? 0);
      this.nextCursor = events.length > 0 ? events[events.length - 1].id : undefined;

      const lastIndexedLedger = await this.getLastIndexedLedger();
      const lag = Math.max(0, this.latestLedgerSeen - lastIndexedLedger);
      if (lag >= this.lagAlertThresholdLedgers && !this.lagAlertActive) {
        this.lagAlertActive = true;
        this.logger.warn("Soroban event indexer is behind the latest ledger", {
          latestLedger: this.latestLedgerSeen,
          lastIndexedLedger,
          lagLedgers: lag,
          thresholdLedgers: this.lagAlertThresholdLedgers,
        });
      } else if (lag < this.lagAlertThresholdLedgers) {
        this.lagAlertActive = false;
      }

      const decodedEvents = events.map((e) => this.decodeEvent(e));

      this.logger.info("Polled Soroban contract events", {
        startLedger,
        eventCount: decodedEvents.length,
      });

      return decodedEvents;
    } catch (error) {
      this.logger.error("Failed to poll Soroban contract events", {
        err: error,
        startLedger,
      });
      throw error;
    }
  }

  /**
   * Ingests, persists, and reconciles a list of decoded Soroban events into the database.
   */
  public async ingestEvents(events: DecodedSorobanEvent[]): Promise<number> {
    let processedCount = 0;

    for (const event of events) {
      try {
        const existing = this.eventLogRepository
          ? await this.eventLogRepository.findOne({
              where: { contractId: event.contractId, eventId: event.id },
            })
          : null;

        if (existing?.processed) {
          processedCount++;
          continue;
        }

        if (this.eventLogRepository) {
          const logEntry =
            existing ??
            this.eventLogRepository.create({
              contractId: event.contractId,
              eventId: event.id,
              ledgerSequence: event.ledger.toString(),
              topic: event.topic,
              txHash: event.txHash,
              payload: {
                topics: event.topics,
                data: event.data,
                ledgerClosedAt: event.ledgerClosedAt,
              },
              processed: false,
            });
          if (!existing) await this.eventLogRepository.save(logEntry);
        }

        if (event.inSuccessfulContractCall) {
          await this.applyEventStateTransition(event);
        }

        // Fan out to the registered read-model projections (ACL, curve
        // migrations, swaps, key config). Failures inside a handler are logged
        // by the bus and never abort ingestion of the remaining events.
        if (this.eventBus) {
          await this.eventBus.dispatch(event);
        }

        if (this.eventLogRepository) {
          await this.eventLogRepository.update(
            { contractId: event.contractId, eventId: event.id },
            { processed: true }
          );
        }

        processedCount++;
      } catch (err) {
        this.logger.error("Error processing Soroban event", {
          err,
          eventId: event.id,
          topic: event.topic,
        });
      }
    }

    return processedCount;
  }

  public async saveCheckpoint(ledgerSequence: number): Promise<void> {
    if (!Number.isInteger(ledgerSequence) || ledgerSequence < 0) {
      throw new Error("ledgerSequence must be a non-negative integer.");
    }

    const checkpointKey = this.getCheckpointKey();
    if (this.checkpointRepository) {
      const checkpoint = await this.checkpointRepository.findOne({ where: { checkpointKey } });
      const durableLedger = Number(checkpoint?.ledgerSequence ?? 0);
      if (ledgerSequence <= durableLedger) return;
      await this.checkpointRepository.save(
        this.checkpointRepository.create({
          ...(checkpoint ?? {}),
          checkpointKey,
          ledgerSequence: ledgerSequence.toString(),
        })
      );
    } else if (ledgerSequence <= this.lastIndexedLedger) {
      return;
    }

    this.lastIndexedLedger = Math.max(this.lastIndexedLedger, ledgerSequence);
  }

  /**
   * Applies domain state updates to Invoice / Investment models based on on-chain event topics.
   */
  private async applyEventStateTransition(event: DecodedSorobanEvent): Promise<void> {
    const topic = event.topic.toLowerCase();
    const investment = await this.findInvestmentForEvent(event);
    const invoiceId = this.extractInvoiceId(event);

    if (
      investment &&
      ["fund_escrow", "fund", "investment_funded", "investment_confirmed"].includes(topic) &&
      investment.status === InvestmentStatus.PENDING
    ) {
      investment.status = InvestmentStatus.CONFIRMED;
      investment.transactionHash = event.txHash;
      investment.fundingBlock = String(event.ledger);
      await this.investmentRepository?.save(investment);
    }

    if (
      invoiceId &&
      ["settle_escrow", "settle", "payment_recorded", "payment", "investment_settled"].includes(
        topic
      ) &&
      this.investmentRepository
    ) {
      await this.investmentRepository.update(
        { invoiceId, status: In([InvestmentStatus.PENDING, InvestmentStatus.CONFIRMED]) },
        { status: InvestmentStatus.SETTLED }
      );
    }

    if (
      investment &&
      ["settle_escrow", "settle", "investment_settled"].includes(topic) &&
      investment.status !== InvestmentStatus.SETTLED
    ) {
      investment.status = InvestmentStatus.SETTLED;
      await this.investmentRepository?.save(investment);
    }

    // Event: "create_escrow"
    if (topic === "create_escrow") {
      const invoiceId = this.extractInvoiceId(event);
      if (invoiceId && this.invoiceRepository) {
        const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId } });
        if (invoice && invoice.status === InvoiceStatus.DRAFT) {
          invoice.status = InvoiceStatus.PUBLISHED;
          await this.invoiceRepository.save(invoice);
        }
      }
    }

    // Event: "fund_escrow" or "fund"
    if (topic === "fund_escrow" || topic === "fund") {
      const invoiceId = this.extractInvoiceId(event);
      if (invoiceId && this.invoiceRepository) {
        const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId } });
        if (invoice && invoice.status === InvoiceStatus.PUBLISHED) {
          invoice.status = InvoiceStatus.FUNDED;
          await this.invoiceRepository.save(invoice);
        }
      }
    }

    // Event: "payment_recorded" or "payment"
    if (topic === "payment_recorded" || topic === "payment") {
      const invoiceId = this.extractInvoiceId(event);
      if (invoiceId && this.invoiceRepository) {
        const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId } });
        if (invoice && invoice.status === InvoiceStatus.FUNDED) {
          invoice.status = InvoiceStatus.SETTLED;
          await this.invoiceRepository.save(invoice);
        }
      }
    }

    // Event: "settle_escrow" or "settle"
    if (topic === "settle_escrow" || topic === "settle") {
      const invoiceId = this.extractInvoiceId(event);
      if (invoiceId && this.invoiceRepository) {
        const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId } });
        if (invoice) {
          invoice.status = InvoiceStatus.SETTLED;
          await this.invoiceRepository.save(invoice);
        }
      }
    }
  }

  private async findInvestmentForEvent(event: DecodedSorobanEvent): Promise<Investment | null> {
    if (!this.investmentRepository) return null;

    const data =
      event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
    const investmentId = this.stringValue(data.investment_id ?? data.investmentId);
    if (investmentId) {
      const byId = await this.investmentRepository.findOne({ where: { id: investmentId } });
      if (byId) return byId;
    }

    const byTransaction = await this.investmentRepository.findOne({
      where: { transactionHash: event.txHash },
    });
    if (byTransaction) return byTransaction;

    const invoiceId = this.extractInvoiceId(event);
    const wallet = this.stringValue(
      data.investor ?? data.investor_wallet ?? data.investorWallet ?? event.topics[2]
    );
    if (invoiceId && wallet) {
      return this.investmentRepository.findOne({ where: { invoiceId, investorWallet: wallet } });
    }

    return null;
  }

  private stringValue(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private getCheckpointKey(): string {
    return this.contractIds.slice().sort().join(",");
  }

  private extractInvoiceId(event: DecodedSorobanEvent): string | null {
    if (event.topics.length > 1 && typeof event.topics[1] === "string") {
      return event.topics[1];
    }
    if (event.data && typeof event.data === "object") {
      const dataObj = event.data as Record<string, unknown>;
      const invoiceId = dataObj.invoice_id ?? dataObj.invoiceId;
      if (invoiceId !== undefined && invoiceId !== null) {
        return String(invoiceId);
      }
    }
    return null;
  }

  /**
   * Retrieves the last processed ledger sequence number.
   */
  public async getLastIndexedLedger(): Promise<number> {
    if (this.lastIndexedLedger > 0) {
      return this.lastIndexedLedger;
    }

    if (this.checkpointRepository) {
      const checkpoint = await this.checkpointRepository.findOne({
        where: { checkpointKey: this.getCheckpointKey() },
      });
      if (checkpoint?.ledgerSequence) {
        this.lastIndexedLedger = Number(checkpoint.ledgerSequence);
        return this.lastIndexedLedger;
      }
      return 0;
    }

    if (this.eventLogRepository) {
      const latest = await this.eventLogRepository.findOne({
        where: { processed: true, contractId: In(this.contractIds) },
        order: { ledgerSequence: "DESC" },
      });
      if (latest && latest.ledgerSequence) {
        this.lastIndexedLedger = Number(latest.ledgerSequence);
        return this.lastIndexedLedger;
      }
    }

    return 0;
  }

  private async runPollCycle(): Promise<void> {
    const startLedger = (await this.getLastIndexedLedger()) + 1;
    let cursor: string | undefined;
    let allEventsProcessed = true;

    do {
      const requestedCursor = cursor;
      const events = await this.pollContractEvents({ startLedger, limit: 100, cursor });
      if (events.length > 0) {
        const processedCount = await this.ingestEvents(events);
        if (processedCount !== events.length) {
          allEventsProcessed = false;
          break;
        }
      }
      cursor = this.nextCursor;
      if (events.length < 100) break;
      if (!cursor || cursor === requestedCursor) {
        allEventsProcessed = false;
        break;
      }
    } while (cursor);

    if (allEventsProcessed && this.latestLedgerSeen >= startLedger) {
      await this.saveCheckpoint(this.latestLedgerSeen);
    }
  }

  /**
   * Starts periodic polling in background.
   */
  public start(intervalMs = 10000): void {
    if (this.intervalHandle) return;

    this.logger.info("Starting Soroban event indexer service", {
      contractIds: this.contractIds,
      intervalMs,
    });

    this.intervalHandle = setInterval(async () => {
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      try {
        await this.runPollCycle();
      } catch (err) {
        this.logger.error("Error in Soroban event indexer poll cycle", { err });
      } finally {
        this.pollInFlight = false;
      }
    }, intervalMs);
  }

  /**
   * Stops periodic polling.
   */
  public stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info("Stopped Soroban event indexer service");
    }
  }
}
