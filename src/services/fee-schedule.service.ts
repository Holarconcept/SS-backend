import { DataSource, EntityManager } from "typeorm";
import { FeeSchedule, FeeScheduleHistory } from "../models/FeeSchedule.model";
import { ServiceError } from "../utils/service-error";
import { logger } from "../observability/logger";
import Redis from "ioredis";

const FEE_SCHEDULE_CACHE_KEY = "fee_schedule:current";
const FEE_SCHEDULE_CACHE_TTL = 3600; // 1 hour

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
   * Gets the current active fee schedule from cache or database.
   */
  async getCurrentFeeSchedule(): Promise<FeeScheduleWithMeta> {
    // Try cache first
    if (this.redisClient) {
      try {
        const cached = await this.redisClient.get(FEE_SCHEDULE_CACHE_KEY);
        if (cached) {
          logger.debug("fee_schedule.cache_hit");
          return JSON.parse(cached) as FeeScheduleWithMeta;
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

    // Cache the result
    if (this.redisClient) {
      try {
        await this.redisClient.setex(FEE_SCHEDULE_CACHE_KEY, FEE_SCHEDULE_CACHE_TTL, JSON.stringify(dto));
      } catch (error) {
        logger.warn("fee_schedule.cache_set_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
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

    // Invalidate cache
    await this.invalidateCache();

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
   */
  private async invalidateCache(): Promise<void> {
    if (this.redisClient) {
      try {
        await this.redisClient.del(FEE_SCHEDULE_CACHE_KEY);
        logger.debug("fee_schedule.cache_invalidated");
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
