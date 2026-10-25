import { createHash } from "crypto";
import { SorobanRpc, scValToNative, xdr } from "stellar-sdk";
import type { DataSource, Repository } from "typeorm";
import type { AppLogger } from "../../observability/logger";
import { logger as globalLogger } from "../../observability/logger";
import { Investment } from "../../models/Investment.model";
import { Invoice } from "../../models/Invoice.model";
import { SorobanEventLog } from "../../models/SorobanEventLog.model";
import { SorobanIndexerCheckpoint } from "../../models/SorobanIndexerCheckpoint.model";
import { InvestmentStatus, InvoiceStatus } from "../../types/enums";
import type { DecodedSorobanEvent } from "../../types/soroban.types";
import type { ContractEventBus } from "../contract-event-bus.service";
import type { InvestorInsightsService } from "../investor-insights.service";

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
  investorInsightsService?: InvestorInsightsService;
  lagAlertThresholdLedgers?: number;
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
  private readonly investorInsightsService?: InvestorInsightsService;
  private readonly checkpointId: string;
  private readonly lagAlertThresholdLedgers: number;
  private readonly eventBus?: ContractEventBus;

  private intervalHandle: NodeJS.Timeout | null = null;
  private lastIndexedLedger = 0;
  private latestObservedLedger = 0;
  private latestLedgerSeen = 0;
  private nextCursor?: string;
  private polling = false;
  private pollInFlight = false;
  private lagAlertActive = false;

  constructor(dependencies: EventIndexerServiceDependencies) {
    if (!dependencies.contractIds || dependencies.contractIds.length === 0) {
      throw new Error("At least one contractId is required.");
    }

    this.contractIds = dependencies.contractIds;
    this.checkpointId = createHash("sha256")
      .update([...dependencies.contractIds].sort().join(","))
      .digest("hex");
    this.logger = dependencies.logger ?? globalLogger;
    this.dataSource = dependencies.dataSource;
    this.investorInsightsService = dependencies.investorInsightsService;
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

  private getCheckpointKey(): string {
    return this.contractIds[0] ?? this.checkpointId;
  }

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
        : typeof (rawEvent.contractId as unknown as { contractId?: () => string }).contractId === "function"
          ? (rawEvent.contractId as unknown as { contractId: () => string }).contractId()
          : String(rawEvent.contractId)
      : "";

    const txHash =
      typeof rawRecord.txHash === "string"
        ? rawRecord.txHash
        : typeof rawRecord.pagingToken === "string"
          ? rawRecord.pagingToken
          : rawEvent.id;
    const occurredAt = new Date(rawEvent.ledgerClosedAt);

    return {
      id: rawEvent.id,
      contractId: contractIdStr,
      ledger: Number(rawEvent.ledger),
      ledgerClosedAt: rawEvent.ledgerClosedAt,
      occurredAt: Number.isNaN(occurredAt.getTime()) ? undefined : occurredAt,
      txHash,
      topic: primaryTopic,
      topics: decodedTopics,
      data: decodedData,
      inSuccessfulContractCall: rawEvent.inSuccessfulContractCall ?? true,
    };
  }

  public async pollContractEvents(options: PollEventsOptions = {}): Promise<DecodedSorobanEvent[]> {
    const startLedger = options.startLedger ?? (await this.getLastIndexedLedger()) + 1;

    try {
      const filters: NonNullable<SorobanRpc.Server.GetEventsRequest["filters"]> = [];
      for (let index = 0; index < this.contractIds.length; index += 5) {
        filters.push({
          type: "contract",
          contractIds: this.contractIds.slice(index, index + 5),
        });
      }

      const requestParams: SorobanRpc.Server.GetEventsRequest = {
        filters,
        limit: options.limit ?? 100,
      };

      if (startLedger > 1 && !options.cursor) {
        requestParams.startLedger = startLedger;
      }

      let cursor = options.cursor;
      const seenCursors = new Set<string>();
      const decodedEvents: DecodedSorobanEvent[] = [];

      do {
        const params: SorobanRpc.Server.GetEventsRequest = { ...requestParams };
        if (cursor) {
          params.cursor = cursor;
          delete params.startLedger;
        }

        const response = await this.rpcServer.getEvents(params);
        const responseWithCursor = response as SorobanRpc.Api.GetEventsResponse & { cursor?: string };

        this.latestObservedLedger = Math.max(this.latestObservedLedger, response.latestLedger ?? 0);
        this.latestLedgerSeen = Math.max(this.latestLedgerSeen, response.latestLedger ?? 0);

        decodedEvents.push(...(response.events ?? []).map((event) => this.decodeEvent(event)));

        const nextCursor = responseWithCursor.cursor;
        if (!nextCursor || nextCursor === cursor) break;
        if (seenCursors.has(nextCursor)) {
          throw new Error("Soroban RPC returned a repeated event cursor.");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);

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

  public async ingestEvents(events: DecodedSorobanEvent[]): Promise<number> {
    let processedCount = 0;
    let highestProcessedLedger = this.lastIndexedLedger;

    for (const event of events) {
      const eventId = event.id || `${event.txHash}:${event.topic}:${event.ledger}`;
      try {
        const existingLog = this.eventLogRepository
          ? await this.eventLogRepository.findOne({ where: { eventId } })
          : null;

        if (existingLog?.processed) {
          highestProcessedLedger = Math.max(highestProcessedLedger, event.ledger);
          processedCount++;
          continue;
        }

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
          if (existingLog) {
            await this.eventLogRepository.update({ eventId }, { processed: false });
          } else {
            const logEntry = this.eventLogRepository.create({
              eventId,
              contractId: event.contractId,
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
            await this.eventLogRepository.save(logEntry);
          }
        }

        await this.applyEventStateTransition(event);
        await this.investorInsightsService?.processEvent(event);

        if (this.eventBus) {
          await this.eventBus.dispatch(event);
        }

        if (this.eventLogRepository) {
          await this.eventLogRepository.update({ eventId }, { processed: true });
        }

        highestProcessedLedger = Math.max(highestProcessedLedger, event.ledger);
        processedCount++;
      } catch (err) {
        this.logger.error("Error processing Soroban event", {
          err,
          eventId: event.id,
          topic: event.topic,
        });
        throw err;
      }
    }

    this.lastIndexedLedger = highestProcessedLedger;
    const checkpointLedger = Math.max(highestProcessedLedger, this.latestObservedLedger);
    if (checkpointLedger > 0 && this.checkpointRepository) {
      const checkpoint = this.checkpointRepository.create({
        checkpointKey: this.getCheckpointKey(),
        ledgerSequence: checkpointLedger.toString(),
      });
      await this.checkpointRepository.save(checkpoint);
      this.lastIndexedLedger = checkpointLedger;
    }

    return processedCount;
  }

  public async saveCheckpoint(ledgerSequence: number): Promise<void> {
    if (!Number.isInteger(ledgerSequence) || ledgerSequence < 0) {
      throw new Error("ledgerSequence must be a non-negative integer.");
    }

    if (this.checkpointRepository) {
      const checkpoint = await this.checkpointRepository.findOne({
        where: { checkpointKey: this.getCheckpointKey() },
      });

      const durableLedger = Number(checkpoint?.ledgerSequence ?? 0);
      if (ledgerSequence <= durableLedger) return;

      await this.checkpointRepository.save(
        this.checkpointRepository.create({
          ...(checkpoint ?? {}),
          checkpointKey: this.getCheckpointKey(),
          ledgerSequence: ledgerSequence.toString(),
        }),
      );
    }

    this.lastIndexedLedger = Math.max(this.lastIndexedLedger, ledgerSequence);
  }

  private async applyEventStateTransition(event: DecodedSorobanEvent): Promise<void> {
    const topic = event.topic.toLowerCase();

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

    if (topic === "investment_funded") {
      const investmentId = this.extractInvestmentId(event);
      if (investmentId && this.investmentRepository) {
        const investment = await this.investmentRepository.findOne({ where: { id: investmentId } });
        if (investment) {
          investment.status = InvestmentStatus.CONFIRMED;
          investment.transactionHash = event.txHash;
          investment.fundingBlock = String(event.ledger);
          await this.investmentRepository.save(investment);
        }
      }
    }
  }

  private extractInvoiceId(event: DecodedSorobanEvent): string | null {
    if (event.topics.length > 1 && typeof event.topics[1] === "string") {
      return event.topics[1];
    }
    if (event.data && typeof event.data === "object") {
      const dataObj = event.data as Record<string, unknown>;
      if ("invoice_id" in dataObj) {
        return String(dataObj.invoice_id);
      }
    }
    return null;
  }

  private extractInvestmentId(event: DecodedSorobanEvent): string | null {
    if (event.data && typeof event.data === "object") {
      const dataObj = event.data as Record<string, unknown>;
      if ("investment_id" in dataObj) {
        return String(dataObj.investment_id);
      }
    }
    return null;
  }

  public async getLastIndexedLedger(): Promise<number> {
    if (this.lastIndexedLedger > 0) {
      return this.lastIndexedLedger;
    }

    if (this.checkpointRepository) {
      const checkpoint = await this.checkpointRepository.findOne({
        where: { checkpointKey: this.getCheckpointKey() },
      });
      if (checkpoint && checkpoint.ledgerSequence) {
        this.lastIndexedLedger = Number(checkpoint.ledgerSequence);
        return this.lastIndexedLedger;
      }
    }

    if (this.eventLogRepository) {
      const latest = await this.eventLogRepository.findOne({
        where: {},
        order: { ledgerSequence: "DESC" },
      });
      if (latest && latest.ledgerSequence) {
        this.lastIndexedLedger = Number(latest.ledgerSequence);
        return this.lastIndexedLedger;
      }
    }

    return 0;
  }

  public start(intervalMs = 10000): void {
    if (this.intervalHandle) return;

    this.logger.info("Starting Soroban event indexer service", {
      contractIds: this.contractIds,
      intervalMs,
    });

    this.intervalHandle = setInterval(async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        const events = await this.pollContractEvents();
        if (events.length > 0) {
          await this.ingestEvents(events);
        }
      } catch (err) {
        this.logger.error("Error in Soroban event indexer poll cycle", { err });
      } finally {
        this.polling = false;
      }
    }, intervalMs);
  }

  public stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info("Stopped Soroban event indexer service");
    }
  }
}