import { DataSource } from "typeorm";
import RedisMock from "ioredis-mock";
import type { Redis } from "ioredis";
import {
  FeeScheduleService,
  FEE_SCHEDULE_CACHE_KEY,
  FEE_SCHEDULE_VERSION_KEY,
  FEE_SCHEDULE_CACHE_TTL,
} from "../../../src/services/fee-schedule.service";
import { FeeSchedule, FeeScheduleHistory } from "../../../src/models/FeeSchedule.model";
import { createTestDataSource } from "../../helpers/test-data-source";

describe("FeeScheduleService - Cache Invalidation Race Condition (#714)", () => {
  let dataSource: DataSource;
  let redisClient: Redis;
  let service: FeeScheduleService;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    await dataSource.synchronize(true);
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  }, 30000);

  beforeEach(async () => {
    jest.restoreAllMocks();

    // Reset DB tables
    await dataSource.getRepository(FeeScheduleHistory).clear();
    await dataSource.getRepository(FeeSchedule).clear();

    // Create fresh Redis mock instance and clear shared in-memory store
    redisClient = new RedisMock() as unknown as Redis;
    await redisClient.flushall();
    service = new FeeScheduleService(dataSource, redisClient);
  });

  describe("Controlled interleaving regression test (stale refill race)", () => {
    it("reproduces the stale-refill race and verifies guarded write prevents old reader from repopulating cache", async () => {
      const repository = dataSource.getRepository(FeeSchedule);

      // Step 1: Commit initial schedule (Version 1: 100 bps)
      const scheduleV1 = repository.create({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await repository.save(scheduleV1);
      const v1Id = scheduleV1.id;

      // Step 2: Reader 1 initiates a read on cache miss, reads V1 from DB, but pauses before writing to cache
      const scheduleFromDbV1 = await repository.findOne({
        where: { isActive: true },
        order: { effectiveFrom: "DESC" },
      });
      expect(scheduleFromDbV1).toBeDefined();
      expect(scheduleFromDbV1?.investmentFeeBps).toBe(100);

      const dtoV1 = {
        investmentFeeBps: scheduleFromDbV1!.investmentFeeBps,
        settlementFeeBps: scheduleFromDbV1!.settlementFeeBps,
        platformFeeBps: scheduleFromDbV1!.platformFeeBps,
        secondaryMarketFeeBps: scheduleFromDbV1!.secondaryMarketFeeBps,
        effectiveFrom: scheduleFromDbV1!.effectiveFrom,
        effectiveUntil: scheduleFromDbV1!.effectiveUntil,
        isActive: scheduleFromDbV1!.isActive,
      };

      // [Reader 1 is now paused here before caching]

      // Step 3: Administrator updates the fee schedule to V2 (200 bps)
      const updateResult = await service.updateFeeSchedule(
        { investmentFeeBps: 200, changeReason: "Admin rate increase" },
        "GDADMINWALLET",
        "admin"
      );
      expect(updateResult.investmentFeeBps).toBe(200);

      // Verify cache invalidation set the version guard and deleted current cache
      const versionAfterUpdate = await redisClient.get(FEE_SCHEDULE_VERSION_KEY);
      const cacheAfterUpdate = await redisClient.get(FEE_SCHEDULE_CACHE_KEY);
      expect(versionAfterUpdate).toBeDefined();
      expect(Number(versionAfterUpdate)).toBeGreaterThan(v1Id);
      expect(cacheAfterUpdate).toBeNull();

      // Step 4: Demonstrate that an unguarded setex WOULD have repopulated the cache with stale rates
      // (This documents the bug behavior described in #714)
      await redisClient.setex(FEE_SCHEDULE_CACHE_KEY, FEE_SCHEDULE_CACHE_TTL, JSON.stringify(dtoV1));
      const unguardedPolluted = await redisClient.get(FEE_SCHEDULE_CACHE_KEY);
      expect(JSON.parse(unguardedPolluted!).investmentFeeBps).toBe(100); // Polluted with stale rate!

      // Reset cache key for the guarded test
      await redisClient.del(FEE_SCHEDULE_CACHE_KEY);

      // Step 5: Reader 1 resumes and attempts guarded refill with stale V1
      const writeAccepted = await service.guardedCacheRefill(v1Id, dtoV1);

      // Acceptance Criterion: A reader paused before an update cannot repopulate current rates with old schedule afterward
      expect(writeAccepted).toBe(false);

      // Cache key must NOT be repopulated with V1
      const cacheAfterStaleAttempt = await redisClient.get(FEE_SCHEDULE_CACHE_KEY);
      expect(cacheAfterStaleAttempt).toBeNull();

      // Step 6: Acceptance Criterion: The next completed read after an update observes the new committed rates
      const nextRead = await service.getCurrentFeeSchedule();
      expect(nextRead.investmentFeeBps).toBe(200);

      // Verify that cache is now populated with V2
      const cacheAfterNextRead = await redisClient.get(FEE_SCHEDULE_CACHE_KEY);
      expect(cacheAfterNextRead).toBeDefined();
      const cachedParsed = JSON.parse(cacheAfterNextRead!);
      expect(cachedParsed.data.investmentFeeBps).toBe(200);
      expect(cachedParsed.version).toBe(Number(versionAfterUpdate));

      // Subsequent read hits cache with 200 bps
      const subsequentRead = await service.getCurrentFeeSchedule();
      expect(subsequentRead.investmentFeeBps).toBe(200);
    });
  });

  describe("Cache fallback and error handling", () => {
    it("expired entries fall back to database safely", async () => {
      const repository = dataSource.getRepository(FeeSchedule);
      const schedule = repository.create({
        investmentFeeBps: 150,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await repository.save(schedule);

      // Key does not exist in Redis (expired or never set)
      await redisClient.del(FEE_SCHEDULE_CACHE_KEY);

      const result = await service.getCurrentFeeSchedule();
      expect(result.investmentFeeBps).toBe(150);

      // Cache should now be refilled
      const cached = await redisClient.get(FEE_SCHEDULE_CACHE_KEY);
      expect(cached).toBeDefined();
    });

    it("corrupt JSON in cache falls back to database safely", async () => {
      const repository = dataSource.getRepository(FeeSchedule);
      const schedule = repository.create({
        investmentFeeBps: 120,
        settlementFeeBps: 60,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await repository.save(schedule);

      // Set corrupt, non-JSON value
      await redisClient.set(FEE_SCHEDULE_CACHE_KEY, "{ invalid json malformed");

      const result = await service.getCurrentFeeSchedule();
      expect(result.investmentFeeBps).toBe(120);
    });

    it("corrupt or incomplete structure in cache falls back to database safely", async () => {
      const repository = dataSource.getRepository(FeeSchedule);
      const schedule = repository.create({
        investmentFeeBps: 130,
        settlementFeeBps: 70,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await repository.save(schedule);

      // Set valid JSON but missing required numeric fee rate fields
      await redisClient.set(
        FEE_SCHEDULE_CACHE_KEY,
        JSON.stringify({ version: 1, data: { invalid: "structure" } })
      );

      const result = await service.getCurrentFeeSchedule();
      expect(result.investmentFeeBps).toBe(130);
    });

    it("corrupt date string in cache falls back to database safely", async () => {
      const repository = dataSource.getRepository(FeeSchedule);
      const schedule = repository.create({
        investmentFeeBps: 140,
        settlementFeeBps: 80,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await repository.save(schedule);

      // Set valid JSON with invalid date string
      await redisClient.set(
        FEE_SCHEDULE_CACHE_KEY,
        JSON.stringify({
          version: 1,
          data: {
            investmentFeeBps: 140,
            settlementFeeBps: 80,
            platformFeeBps: 100,
            secondaryMarketFeeBps: 150,
            effectiveFrom: "not-a-valid-date",
            effectiveUntil: null,
            isActive: true,
          },
        })
      );

      const result = await service.getCurrentFeeSchedule();
      expect(result.investmentFeeBps).toBe(140);
    });

    it("Redis read failure falls back to database safely without indefinite stale rates", async () => {
      const repository = dataSource.getRepository(FeeSchedule);
      const schedule = repository.create({
        investmentFeeBps: 175,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await repository.save(schedule);

      // Simulate Redis read error
      jest.spyOn(redisClient, "get").mockRejectedValueOnce(new Error("Redis connection refused"));

      const result = await service.getCurrentFeeSchedule();
      expect(result.investmentFeeBps).toBe(175);
    });

    it("Redis write failure still returns database schedule without crashing", async () => {
      const repository = dataSource.getRepository(FeeSchedule);
      const schedule = repository.create({
        investmentFeeBps: 180,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await repository.save(schedule);

      // Simulate Redis eval error
      jest.spyOn(redisClient, "eval").mockRejectedValueOnce(new Error("Redis OOM error"));

      const result = await service.getCurrentFeeSchedule();
      expect(result.investmentFeeBps).toBe(180);
    });

    it("Redis invalidation failure during update still returns fresh schedule", async () => {
      const repository = dataSource.getRepository(FeeSchedule);
      const schedule = repository.create({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await repository.save(schedule);

      // Pipeline execution failure
      jest.spyOn(redisClient, "pipeline").mockReturnValueOnce({
        set: jest.fn().mockReturnThis(),
        del: jest.fn().mockReturnThis(),
        incr: jest.fn().mockReturnThis(),
        exec: jest.fn().mockRejectedValueOnce(new Error("Redis unavailable")),
      } as any);

      const result = await service.updateFeeSchedule(
        { investmentFeeBps: 250 },
        "GDADMINWALLET",
        "admin"
      );
      expect(result.investmentFeeBps).toBe(250);
    });
  });

  describe("Concurrent reader race with intermediate refill", () => {
    it("older reader cannot overwrite newer schedule when cache was already refilled by an intermediate reader", async () => {
      const repository = dataSource.getRepository(FeeSchedule);

      // 1. Initial schedule v1 (100 bps)
      const s1 = repository.create({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await repository.save(s1);
      const v1Id = s1.id;

      // Reader 1 loads v1 and pauses
      const dtoV1 = {
        investmentFeeBps: s1.investmentFeeBps,
        settlementFeeBps: s1.settlementFeeBps,
        platformFeeBps: s1.platformFeeBps,
        secondaryMarketFeeBps: s1.secondaryMarketFeeBps,
        effectiveFrom: s1.effectiveFrom,
        effectiveUntil: s1.effectiveUntil,
        isActive: s1.isActive,
      };

      // 2. Admin updates to v2 (200 bps)
      await service.updateFeeSchedule({ investmentFeeBps: 200 }, "GDADMINWALLET", "admin");

      // 3. Reader 2 reads v2 from DB and successfully refills cache
      const readV2 = await service.getCurrentFeeSchedule();
      expect(readV2.investmentFeeBps).toBe(200);

      // Verify cache currently holds v2
      const cacheBeforeStaleAttempt = await redisClient.get(FEE_SCHEDULE_CACHE_KEY);
      expect(JSON.parse(cacheBeforeStaleAttempt!).data.investmentFeeBps).toBe(200);

      // 4. Reader 1 unpauses and tries to write v1
      const writeAccepted = await service.guardedCacheRefill(v1Id, dtoV1);
      expect(writeAccepted).toBe(false);

      // 5. Cache still holds v2 (200 bps)
      const cacheAfterStaleAttempt = await redisClient.get(FEE_SCHEDULE_CACHE_KEY);
      expect(JSON.parse(cacheAfterStaleAttempt!).data.investmentFeeBps).toBe(200);

      // 6. Reader 3 reads cache and gets 200 bps
      const readV3 = await service.getCurrentFeeSchedule();
      expect(readV3.investmentFeeBps).toBe(200);
    });
  });
});
