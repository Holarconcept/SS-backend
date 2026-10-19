import { nativeToScVal, xdr } from "stellar-sdk";
import { EventIndexerService } from "../../../../src/services/stellar/event-indexer.service";
import { InvestmentStatus, InvoiceStatus } from "../../../../src/types/enums";
import type { AppLogger } from "../../../../src/observability/logger";

describe("EventIndexerService (Issue #135)", () => {
  const ESCROW_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const TOKEN_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  let mockLogger: AppLogger;
  let mockEventLogRepo: any;
  let mockCheckpointRepo: any;
  let mockInvoiceRepo: any;
  let mockInvestmentRepo: any;
  let mockRpcServer: any;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
    };

    mockEventLogRepo = {
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest
        .fn()
        .mockImplementation(({ where }) =>
          Promise.resolve(where?.eventId ? null : { ledgerSequence: "500" })
        ),
    };

    mockCheckpointRepo = {
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
      findOne: jest.fn().mockResolvedValue(null),
    };

    mockInvoiceRepo = {
      findOne: jest.fn().mockResolvedValue({ id: "INV-100", status: InvoiceStatus.DRAFT }),
      save: jest.fn().mockImplementation((inv) => Promise.resolve(inv)),
    };

    mockInvestmentRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation((inv) => Promise.resolve(inv)),
    };

    mockRpcServer = {
      getEvents: jest.fn().mockResolvedValue({
        events: [],
      }),
    };
  });

  describe("Initialization", () => {
    it("should throw an error when contractIds array is empty", () => {
      expect(() => new EventIndexerService({ contractIds: [] })).toThrow(
        "At least one contractId is required."
      );
    });

    it("should initialize with valid contract IDs", () => {
      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID, TOKEN_CONTRACT_ID],
        logger: mockLogger,
      });
      expect(service.contractIds).toEqual([ESCROW_CONTRACT_ID, TOKEN_CONTRACT_ID]);
    });
  });

  describe("decodeEvent", () => {
    it("should decode raw Soroban ScVal event topics and payload data", () => {
      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        logger: mockLogger,
      });

      const topicSymbolScVal = nativeToScVal("fund_escrow", { type: "symbol" });
      const invoiceIdScVal = nativeToScVal("INV-2026-001", { type: "string" });
      const amountScVal = nativeToScVal(100_000n, { type: "i128" });

      const rawEvent = {
        id: "evt-001",
        contractId: ESCROW_CONTRACT_ID,
        ledger: 1050,
        ledgerClosedAt: "2026-08-25T12:00:00Z",
        txHash: "0xdeadbeef123",
        topic: [topicSymbolScVal.toXDR("base64"), invoiceIdScVal.toXDR("base64")],
        value: amountScVal.toXDR("base64"),
        inSuccessfulContractCall: true,
      };

      const decoded = service.decodeEvent(rawEvent as any);
      expect(decoded.id).toBe("evt-001");
      expect(decoded.contractId).toBe(ESCROW_CONTRACT_ID);
      expect(decoded.ledger).toBe(1050);
      expect(decoded.topic).toBe("fund_escrow");
      expect(decoded.topics).toEqual(["fund_escrow", "INV-2026-001"]);
      expect(BigInt(decoded.data as any)).toBe(100_000n);
    });
  });

  describe("pollContractEvents", () => {
    it("should query getEvents with contract filters and decode returned events", async () => {
      const topicScVal = nativeToScVal("create_escrow", { type: "symbol" });
      const invoiceIdScVal = nativeToScVal("INV-100", { type: "string" });

      mockRpcServer.getEvents.mockResolvedValue({
        events: [
          {
            id: "evt-002",
            contractId: ESCROW_CONTRACT_ID,
            ledger: 2000,
            ledgerClosedAt: "2026-08-25T12:05:00Z",
            txHash: "0xabcdef",
            topic: [topicScVal.toXDR("base64"), invoiceIdScVal.toXDR("base64")],
            value: null,
            inSuccessfulContractCall: true,
          },
        ],
      });

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        server: mockRpcServer,
        eventLogRepository: mockEventLogRepo,
        logger: mockLogger,
      });

      const events = await service.pollContractEvents({ startLedger: 1999, limit: 50 });
      expect(events).toHaveLength(1);
      expect(events[0].topic).toBe("create_escrow");
      expect(events[0].ledger).toBe(2000);
      expect(mockRpcServer.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          startLedger: 1999,
          limit: 50,
          filters: [{ type: "contract", contractIds: [ESCROW_CONTRACT_ID] }],
        })
      );
    });
  });

  describe("ingestEvents & State Transitions", () => {
    it("should ingest create_escrow event and transition invoice to PUBLISHED", async () => {
      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: mockEventLogRepo,
        invoiceRepository: mockInvoiceRepo,
        logger: mockLogger,
      });

      const decodedEvent = {
        id: "evt-001",
        contractId: ESCROW_CONTRACT_ID,
        ledger: 2001,
        ledgerClosedAt: "2026-08-25T12:06:00Z",
        txHash: "0x123",
        topic: "create_escrow",
        topics: ["create_escrow", "INV-100"],
        data: null,
        inSuccessfulContractCall: true,
      };

      const processed = await service.ingestEvents([decodedEvent]);
      expect(processed).toBe(1);
      expect(mockEventLogRepo.save).toHaveBeenCalled();
      expect(mockInvoiceRepo.findOne).toHaveBeenCalledWith({ where: { id: "INV-100" } });
      expect(mockInvoiceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "INV-100", status: InvoiceStatus.PUBLISHED })
      );
    });

    it("should ingest fund_escrow event and transition invoice to FUNDED", async () => {
      mockInvoiceRepo.findOne.mockResolvedValue({ id: "INV-100", status: InvoiceStatus.PUBLISHED });

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: mockEventLogRepo,
        invoiceRepository: mockInvoiceRepo,
        logger: mockLogger,
      });

      const decodedEvent = {
        id: "evt-002",
        contractId: ESCROW_CONTRACT_ID,
        ledger: 2002,
        ledgerClosedAt: "2026-08-25T12:07:00Z",
        txHash: "0x456",
        topic: "fund_escrow",
        topics: ["fund_escrow", "INV-100"],
        data: { amount: "500000" },
        inSuccessfulContractCall: true,
      };

      await service.ingestEvents([decodedEvent]);
      expect(mockInvoiceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "INV-100", status: InvoiceStatus.FUNDED })
      );
    });

    it("should ingest payment_recorded event and transition invoice to REPAID", async () => {
      mockInvoiceRepo.findOne.mockResolvedValue({ id: "INV-100", status: InvoiceStatus.FUNDED });

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: mockEventLogRepo,
        invoiceRepository: mockInvoiceRepo,
        logger: mockLogger,
      });

      const decodedEvent = {
        id: "evt-003",
        contractId: ESCROW_CONTRACT_ID,
        ledger: 2003,
        ledgerClosedAt: "2026-08-25T12:08:00Z",
        txHash: "0x789",
        topic: "payment_recorded",
        topics: ["payment_recorded", "INV-100"],
        data: null,
        inSuccessfulContractCall: true,
      };

      await service.ingestEvents([decodedEvent]);
      expect(mockInvoiceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "INV-100", status: InvoiceStatus.SETTLED })
      );
    });

    it("should ingest settle_escrow event and transition invoice to SETTLED", async () => {
      mockInvoiceRepo.findOne.mockResolvedValue({ id: "INV-100", status: InvoiceStatus.FUNDED });

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: mockEventLogRepo,
        invoiceRepository: mockInvoiceRepo,
        logger: mockLogger,
      });

      const decodedEvent = {
        id: "evt-004",
        contractId: ESCROW_CONTRACT_ID,
        ledger: 2004,
        ledgerClosedAt: "2026-08-25T12:09:00Z",
        txHash: "0xabc",
        topic: "settle_escrow",
        topics: ["settle_escrow", "INV-100"],
        data: null,
        inSuccessfulContractCall: true,
      };

      await service.ingestEvents([decodedEvent]);
      expect(mockInvoiceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "INV-100", status: InvoiceStatus.SETTLED })
      );
    });

    it("skips a previously processed event on redelivery", async () => {
      mockEventLogRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ processed: true });
      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: mockEventLogRepo,
        invoiceRepository: mockInvoiceRepo,
        logger: mockLogger,
      });
      const event = {
        id: "evt-duplicate",
        contractId: ESCROW_CONTRACT_ID,
        ledger: 2005,
        ledgerClosedAt: "2026-08-25T12:10:00Z",
        txHash: "0xdef",
        topic: "create_escrow",
        topics: ["create_escrow", "INV-100"],
        data: null,
        inSuccessfulContractCall: true,
      };

      await service.ingestEvents([event]);
      await service.ingestEvents([event]);

      expect(mockInvoiceRepo.save).toHaveBeenCalledTimes(1);
      expect(mockEventLogRepo.save).toHaveBeenCalledTimes(1);
    });

    it("confirms an investment identified by the event payload", async () => {
      const investment = {
        id: "investment-1",
        status: InvestmentStatus.PENDING,
        transactionHash: null,
        fundingBlock: null,
      };
      mockInvestmentRepo.findOne.mockResolvedValue(investment);
      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        investmentRepository: mockInvestmentRepo,
        logger: mockLogger,
      });

      await service.ingestEvents([
        {
          id: "evt-investment-funded",
          contractId: ESCROW_CONTRACT_ID,
          ledger: 2006,
          ledgerClosedAt: "2026-08-25T12:11:00Z",
          txHash: "0xinvestment",
          topic: "investment_funded",
          topics: ["investment_funded"],
          data: { investment_id: "investment-1" },
          inSuccessfulContractCall: true,
        },
      ]);

      expect(mockInvestmentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "investment-1",
          status: InvestmentStatus.CONFIRMED,
          transactionHash: "0xinvestment",
          fundingBlock: "2006",
        })
      );
    });
  });

  describe("Last Indexed Ledger & Lifecycle", () => {
    it("should retrieve last indexed ledger from database", async () => {
      mockEventLogRepo.findOne.mockResolvedValue({ ledgerSequence: "9999" });

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: mockEventLogRepo,
        logger: mockLogger,
      });

      const lastLedger = await service.getLastIndexedLedger();
      expect(lastLedger).toBe(9999);
    });

    it("persists a checkpoint independently of event rows", async () => {
      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        checkpointRepository: mockCheckpointRepo,
        logger: mockLogger,
      });

      await service.saveCheckpoint(1200);

      expect(mockCheckpointRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          checkpointKey: ESCROW_CONTRACT_ID,
          ledgerSequence: "1200",
        })
      );
    });

    it("should start and stop timer loop without errors", () => {
      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        server: mockRpcServer,
        logger: mockLogger,
      });

      service.start(5000);
      service.stop();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Starting Soroban event indexer service",
        expect.any(Object)
      );
      expect(mockLogger.info).toHaveBeenCalledWith("Stopped Soroban event indexer service");
    });
  });
});
