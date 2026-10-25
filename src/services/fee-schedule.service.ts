import { DataSource, EntityManager } from "typeorm";
import { FeeSchedule, FeeScheduleHistory } from "../models/FeeSchedule.model";
import { ServiceError } from "../utils/service-error";
import { logger } from "../observability/logger";
import Redis from "ioredis";

export const FEE_SCHEDULE_CACHE_KEY = "fee_schedule:current";
export const FEE_SCHEDULE_VERSION_KEY = "fee_schedule:version";
export const FEE_SCHEDULE_CACHE_TTL = 3600; // 1 hour

export interface FeeScheduleDTO {
  investmentFeeBps: number;
  settlementFeeBps: number;
  platformFeeBps: number;
  secondaryMarketFeeBps: number;
}

export interface FeeScheduleWithMeta extends FeeScheduleDTO {
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  isActive: boolean;
}

export interface FeeScheduleHistoryDTO {
  id: number;
  actorWallet: string;
  actorRole: string;
  oldValues: Partial<FeeScheduleDTO> | null;
  newValues: FeeScheduleDTO;
  changeReason: string | null;
  createdAt: Date;
}

export interface UpdateFeeScheduleInput {
  investmentFeeBps?: number;
  settlementFeeBps?: number;
  platformFeeBps?: number;
  secondaryMarketFeeBps?: number;
  changeReason?: string;
}

export interface FeeScheduleHistoryQuery {
  limit?: number;
  offset?: number;
}

const FEE_BOUNDS = {
  MIN: 0,
  MAX: 1000, // 10% in basis points
};

export class FeeScheduleService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redisClient?: Redis
  ) {}

  /**
   * Validates fee rates are within allowed bounds.
   */
  private validateFeeRate(feeBps: number, feeName: string): void {
    if (feeBps < FEE_BOUNDS.MIN || feeBps > FEE_BOUNDS.MAX) {
      throw new ServiceError(
        "INVALID_FEE_RATE",
        `${feeName} must be between ${FEE_BOUNDS.MIN} and ${FEE_BOUNDS.MAX} basis points`,
        400
      );
    }
  }

  /**
   * Parses and validates cached schedule payload.
   * Safely returns null on corrupt, malformed, or invalid entries to trigger fallback to DB.
   */
  private parseCachedSchedule(cached: string): { version?: number; data: FeeScheduleWithMeta } | null {
    try {
      const parsed = JSON.parse(cached);
      if (!parsed || typeof parsed !== "object") {
        return null;
      }

      let version: number | undefined;
      let rawData: Record<string, unknown>;

      if ("data" in parsed && parsed.data && typeof parsed.data === "object") {
        version = typeof parsed.version === "number" ? parsed.version : undefined;
        rawData = parsed.data as Record<string, unknown>;
      } else {
        // Support legacy raw FeeScheduleWithMeta cache format
        rawData = parsed as Record<string, unknown>;
      }

      if (
        typeof rawData.investmentFeeBps !== "number" ||
        typeof rawData.settlementFeeBps !== "number" ||
        typeof rawData.platformFeeBps !== "number" ||
        typeof rawData.secondaryMarketFeeBps !== "number" ||
        isNaN(rawData.investmentFeeBps) ||
        isNaN(rawData.settlementFeeBps) ||
        isNaN(rawData.platformFeeBps) ||
        isNaN(rawData.secondaryMarketFeeBps)
      ) {
        return null;
      }

      const effectiveFrom = new Date(rawData.effectiveFrom as string | number | Date);
      if (isNaN(effectiveFrom.getTime())) {
        return null;
      }

      const effectiveUntil = rawData.effectiveUntil ? new Date(rawData.effectiveUntil as string | number | Date) : null;
      if (rawData.effectiveUntil && isNaN(effectiveUntil!.getTime())) {
        return null;
      }

      return {
        version,
        data: {
          investmentFeeBps: rawData.investmentFeeBps,
          settlementFeeBps: rawData.settlementFeeBps,
          platformFeeBps: rawData.platformFeeBps,
          secondaryMarketFeeBps: rawData.secondaryMarketFeeBps,
          effectiveFrom,
          effectiveUntil,
          isActive: Boolean(rawData.isActive),
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * Guarded cache write using an atomic Redis Lua script.
   * Ensures an older reader (e.g. delayed by event-loop or network lag)
   * cannot overwrite a newer schedule or repopulate after invalidation.
   */
  async guardedCacheRefill(
    version: number,
    dto: FeeScheduleWithMeta
  ): Promise<boolean> {
    if (!this.redisClient) {
      return false;
    }

    const payload = JSON.stringify({
      version,
      data: dto,
    });

    const script = `
local current_ver = redis.call('get', KEYS[2])
if current_ver and tonumber(ARGV[2]) < tonumber(current_ver) then
  return 0
end
redis.call('setex', KEYS[1], ARGV[1], ARGV[3])
if not current_ver or tonumber(ARGV[2]) > tonumber(current_ver) then
  redis.call('set', KEYS[2], ARGV[2])
end
return 1
`;

    try {
      const result = await this.redisClient.eval(
        script,
        2,
        FEE_SCHEDULE_CACHE_KEY,
        FEE_SCHEDULE_VERSION_KEY,
        FEE_SCHEDULE_CACHE_TTL,
        String(version),
        payload
      );
      const success = Number(result) === 1;
      if (success) {
        logger.debug("fee_schedule.cache_refill_success", { version });
      } else {
        logger.warn("fee_schedule.cache_refill_rejected_stale", { version });
      }
      return success;
    } catch (error) {
      logger.warn("fee_schedule.cache_set_error", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Gets the current active fee schedule from cache or database.
   */
  async getCurrentFeeSchedule(): Promise<FeeScheduleWithMeta> {
    // Try cache first
    if (this.redisClient) {
      try {
        const cached = await this.redisClient.get(FEE_SCHEDULE_CACHE_KEY);
        if (cached) {
          const parsed = this.parseCachedSchedule(cached);
          if (parsed) {
            logger.debug("fee_schedule.cache_hit", { version: parsed.version });
            return parsed.data;
          }
          logger.warn("fee_schedule.cache_corrupted", { cached });
        }
      } catch (error) {
        logger.warn("fee_schedule.cache_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fallback to database
    const repository = this.dataSource.getRepository(FeeSchedule);
    const schedule = await repository.findOne({
      where: { isActive: true },
      order: { effectiveFrom: "DESC" },
    });

    if (!schedule) {
      throw new ServiceError("NO_ACTIVE_FEE_SCHEDULE", "No active fee schedule found", 404);
    }

    const dto: FeeScheduleWithMeta = {
      investmentFeeBps: schedule.investmentFeeBps,
      settlementFeeBps: schedule.settlementFeeBps,
      platformFeeBps: schedule.platformFeeBps,
      secondaryMarketFeeBps: schedule.secondaryMarketFeeBps,
      effectiveFrom: schedule.effectiveFrom,
      effectiveUntil: schedule.effectiveUntil,
      isActive: schedule.isActive,
    };

    // Cache the result using guarded write bound to committed schedule version
    if (this.redisClient) {
      await this.guardedCacheRefill(schedule.id, dto);
    }

    return dto;
  }

  /**
   * Updates the fee schedule with validation and history logging.
   */
  async updateFeeSchedule(
    input: UpdateFeeScheduleInput,
    actorWallet: string,
    actorRole: string = "admin"
  ): Promise<FeeScheduleWithMeta> {
    const { investmentFeeBps, settlementFeeBps, platformFeeBps, secondaryMarketFeeBps, changeReason } = input;

    // Validate provided fee rates
    if (investmentFeeBps !== undefined) {
      this.validateFeeRate(investmentFeeBps, "investmentFeeBps");
    }
    if (settlementFeeBps !== undefined) {
      this.validateFeeRate(settlementFeeBps, "settlementFeeBps");
    }
    if (platformFeeBps !== undefined) {
      this.validateFeeRate(platformFeeBps, "platformFeeBps");
    }
    if (secondaryMarketFeeBps !== undefined) {
      this.validateFeeRate(secondaryMarketFeeBps, "secondaryMarketFeeBps");
    }

    // At least one fee must be updated
    if (
      investmentFeeBps === undefined &&
      settlementFeeBps === undefined &&
      platformFeeBps === undefined &&
      secondaryMarketFeeBps === undefined
    ) {
      throw new ServiceError("NO_CHANGES", "At least one fee rate must be provided", 400);
    }

    const result = await this.dataSource.transaction(async (manager: EntityManager) => {
      const repository = manager.getRepository(FeeSchedule);

      // Get current active schedule
      const currentSchedule = await repository.findOne({
        where: { isActive: true },
        order: { effectiveFrom: "DESC" },
      });

      if (!currentSchedule) {
        throw new ServiceError("NO_ACTIVE_FEE_SCHEDULE", "No active fee schedule found", 404);
      }

      // Record old values
      const oldValues: Partial<FeeScheduleDTO> = {
        investmentFeeBps: currentSchedule.investmentFeeBps,
        settlementFeeBps: currentSchedule.settlementFeeBps,
        platformFeeBps: currentSchedule.platformFeeBps,
        secondaryMarketFeeBps: currentSchedule.secondaryMarketFeeBps,
      };

      // Update fee rates
      const newInvestmentFeeBps = investmentFeeBps ?? currentSchedule.investmentFeeBps;
      const newSettlementFeeBps = settlementFeeBps ?? currentSchedule.settlementFeeBps;
      const newPlatformFeeBps = platformFeeBps ?? currentSchedule.platformFeeBps;
      const newSecondaryMarketFeeBps = secondaryMarketFeeBps ?? currentSchedule.secondaryMarketFeeBps;

      // Deactivate old schedule
      currentSchedule.isActive = false;
      currentSchedule.effectiveUntil = new Date();
      await repository.save(currentSchedule);

      // Create new active schedule
      const newSchedule = repository.create({
        investmentFeeBps: newInvestmentFeeBps,
        settlementFeeBps: newSettlementFeeBps,
        platformFeeBps: newPlatformFeeBps,
        secondaryMarketFeeBps: newSecondaryMarketFeeBps,
        isActive: true,
        effectiveFrom: new Date(),
        effectiveUntil: null,
      });
      const savedSchedule = await repository.save(newSchedule);

      // Record history
      const historyRepository = manager.getRepository(FeeScheduleHistory);
      const history = historyRepository.create({
        feeScheduleId: savedSchedule.id,
        actorWallet,
        actorRole,
        oldInvestmentFeeBps: oldValues.investmentFeeBps,
        oldSettlementFeeBps: oldValues.settlementFeeBps,
        oldPlatformFeeBps: oldValues.platformFeeBps,
        oldSecondaryMarketFeeBps: oldValues.secondaryMarketFeeBps,
        newInvestmentFeeBps: newInvestmentFeeBps,
        newSettlementFeeBps: newSettlementFeeBps,
        newPlatformFeeBps: newPlatformFeeBps,
        newSecondaryMarketFeeBps: newSecondaryMarketFeeBps,
        changeReason,
      });
      await historyRepository.save(history);

      logger.info("fee_schedule.updated", {
        actor: actorWallet,
        oldValues,
        newValues: {
          investmentFeeBps: newInvestmentFeeBps,
          settlementFeeBps: newSettlementFeeBps,
          platformFeeBps: newPlatformFeeBps,
          secondaryMarketFeeBps: newSecondaryMarketFeeBps,
        },
      });

      return savedSchedule;
    });

    // Invalidate cache with the newly committed schedule version
    await this.invalidateCache(result.id);

    return {
      investmentFeeBps: result.investmentFeeBps,
      settlementFeeBps: result.settlementFeeBps,
      platformFeeBps: result.platformFeeBps,
      secondaryMarketFeeBps: result.secondaryMarketFeeBps,
      effectiveFrom: result.effectiveFrom,
      effectiveUntil: result.effectiveUntil,
      isActive: result.isActive,
    };
  }

  /**
   * Gets paginated change history for fee schedules.
   */
  async getFeeScheduleHistory(query: FeeScheduleHistoryQuery = {}): Promise<{
    history: FeeScheduleHistoryDTO[];
    total: number;
  }> {
    const { limit = 50, offset = 0 } = query;

    const repository = this.dataSource.getRepository(FeeScheduleHistory);
    const [history, total] = await repository.findAndCount({
      order: { createdAt: "DESC" },
      take: limit,
      skip: offset,
    });

    const historyDTOs: FeeScheduleHistoryDTO[] = history.map((h) => ({
      id: h.id,
      actorWallet: h.actorWallet,
      actorRole: h.actorRole,
      oldValues:
        h.oldInvestmentFeeBps !== null ||
        h.oldSettlementFeeBps !== null ||
        h.oldPlatformFeeBps !== null ||
        h.oldSecondaryMarketFeeBps !== null
          ? {
              investmentFeeBps: h.oldInvestmentFeeBps ?? undefined,
              settlementFeeBps: h.oldSettlementFeeBps ?? undefined,
              platformFeeBps: h.oldPlatformFeeBps ?? undefined,
              secondaryMarketFeeBps: h.oldSecondaryMarketFeeBps ?? undefined,
            }
          : null,
      newValues: {
        investmentFeeBps: h.newInvestmentFeeBps,
        settlementFeeBps: h.newSettlementFeeBps,
        platformFeeBps: h.newPlatformFeeBps,
        secondaryMarketFeeBps: h.newSecondaryMarketFeeBps,
      },
      changeReason: h.changeReason,
      createdAt: h.createdAt,
    }));

    return {
      history: historyDTOs,
      total,
    };
  }

  /**
   * Invalidates the fee schedule cache.
   * If a committedVersion is provided, sets the version guard so older
   * concurrent readers are rejected when attempting to refill.
   */
  async invalidateCache(committedVersion?: number): Promise<void> {
    if (this.redisClient) {
      try {
        const pipeline = this.redisClient.pipeline();
        if (committedVersion !== undefined) {
          pipeline.set(FEE_SCHEDULE_VERSION_KEY, String(committedVersion));
        } else {
          pipeline.incr(FEE_SCHEDULE_VERSION_KEY);
        }
        pipeline.del(FEE_SCHEDULE_CACHE_KEY);
        await pipeline.exec();
        logger.debug("fee_schedule.cache_invalidated", { committedVersion });
      } catch (error) {
        logger.warn("fee_schedule.cache_invalidation_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Gets a specific fee rate by type.
   */
  async getFeeRate(feeType: keyof FeeScheduleDTO): Promise<number> {
    const schedule = await this.getCurrentFeeSchedule();
    return schedule[feeType];
  }
}

export function createFeeScheduleService(dataSource: DataSource, redisClient?: Redis): FeeScheduleService {
  return new FeeScheduleService(dataSource, redisClient);
}
