import { DataSource } from "typeorm";
import { BenchmarkService } from "../src/services/benchmark.service";
import { SectorBenchmark } from "../src/models/SectorBenchmark.model";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceStatus } from "../src/types/enums";
import { ServiceError } from "../src/utils/service-error";

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "invoice-1",
    sellerId: "issuer-1",
    invoiceNumber: "INV-1",
    customerName: "Acme",
    amount: "1000.0000",
    discountRate: "5.00",
    netAmount: "950.0000",
    dueDate: new Date("2026-02-01T00:00:00Z"),
    category: "logistics",
    ipfsHash: null,
    riskScore: null,
    status: InvoiceStatus.PUBLISHED,
    smartContractId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  } as Invoice;
}

function createFakeDataSource(benchmarks: SectorBenchmark[] = [], invoices: Invoice[] = []) {
  const saved = [...benchmarks];

  return {
    getRepository: (entity: unknown) => {
      if (entity === SectorBenchmark) {
        return {
          findOneBy: async (where: { sector: string }) =>
            saved.find((b) => b.sector === where.sector) ?? null,
          create: (data: Partial<SectorBenchmark>) => ({ ...data }) as SectorBenchmark,
          save: async (row: SectorBenchmark) => {
            const idx = saved.findIndex((b) => b.sector === row.sector);
            const full = {
              id: row.id ?? `bench-${saved.length + 1}`,
              sampleCount: 0,
              lastEventId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              ...row,
            } as SectorBenchmark;
            if (idx >= 0) saved[idx] = full;
            else saved.push(full);
            return full;
          },
        };
      }
      if (entity === Invoice) {
        return {
          findOneBy: async (where: { id: string }) =>
            invoices.find((i) => i.id === where.id) ?? null,
        };
      }
      throw new Error(`Unexpected entity in test fake: ${String(entity)}`);
    },
  } as unknown as DataSource;
}

describe("BenchmarkService", () => {
  it("indexes BenchmarkUpdated events and returns sector averages", async () => {
    const service = new BenchmarkService(createFakeDataSource());

    await service.ingestBenchmarkUpdated({
      sector: "Logistics",
      avgYield: "6.50",
      avgDaysToSettle: "45.00",
      defaultRate: "2.10",
      sampleCount: 12,
      eventId: "evt-1",
    });

    const result = await service.getSectorBenchmark("logistics");

    expect(result.sector).toBe("logistics");
    expect(result.avgYield).toBe("6.50");
    expect(result.avgDaysToSettle).toBe("45.00");
    expect(result.defaultRate).toBe("2.10");
    expect(result.sampleCount).toBe(12);
  });

  it("returns 404 for sectors with no benchmark data", async () => {
    const service = new BenchmarkService(createFakeDataSource());

    await expect(service.getSectorBenchmark("unknown-sector")).rejects.toMatchObject({
      code: "BENCHMARK_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("invalidates the sector cache when a new BenchmarkUpdated arrives", async () => {
    const stored: SectorBenchmark[] = [];
    const dataSource = createFakeDataSource(stored);
    const service = new BenchmarkService(dataSource);

    await service.ingestBenchmarkUpdated({
      sector: "retail",
      avgYield: "5.00",
      avgDaysToSettle: "30.00",
      defaultRate: "1.00",
    });
    const first = await service.getSectorBenchmark("retail");
    expect(first.avgYield).toBe("5.00");

    // Second event must replace the cached value.
    await service.ingestBenchmarkUpdated({
      sector: "retail",
      avgYield: "7.25",
      avgDaysToSettle: "28.00",
      defaultRate: "1.50",
    });
    const second = await service.getSectorBenchmark("retail");
    expect(second.avgYield).toBe("7.25");
  });

  it("compares invoice metrics side-by-side with its sector benchmark", async () => {
    const invoice = makeInvoice();
    const service = new BenchmarkService(
      createFakeDataSource([], [invoice]),
    );

    await service.ingestBenchmarkUpdated({
      sector: "logistics",
      avgYield: "6.50",
      avgDaysToSettle: "45.00",
      defaultRate: "2.10",
    });

    const comparison = await service.getInvoiceBenchmark("invoice-1");

    expect(comparison.sector).toBe("logistics");
    expect(comparison.invoice.yield).toBe("5.00");
    expect(comparison.invoice.daysToSettle).toBe(31);
    expect(comparison.benchmark?.avgYield).toBe("6.50");
  });

  it("returns a null benchmark when the invoice has no sector data", async () => {
    const invoice = makeInvoice({ category: null });
    const service = new BenchmarkService(createFakeDataSource([], [invoice]));

    const comparison = await service.getInvoiceBenchmark("invoice-1");

    expect(comparison.benchmark).toBeNull();
  });

  it("rejects an event without a sector", async () => {
    const service = new BenchmarkService(createFakeDataSource());

    await expect(
      service.ingestBenchmarkUpdated({
        sector: "  ",
        avgYield: "1.00",
        avgDaysToSettle: "1.00",
        defaultRate: "0.00",
      }),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});
