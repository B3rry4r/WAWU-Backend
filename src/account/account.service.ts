import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AccountDeletionResponse } from '../common/types';
import { WAWU_ID_ACCOUNT_GATEWAY, type WawuIdAccountGateway } from './wawu-id-account.gateway';

/** 48h soft-deletion grace period, per registry.json's Account endpoint note. */
const GRACE_PERIOD_MS = 48 * 60 * 60 * 1000;

/**
 * Account has no Prisma model (registry.json fields: [] -- see
 * prisma/schema.prisma header comment). DELETE /account acts directly on
 * the caller's wawuUserId: nothing local to write, only the 48h grace
 * period marker to compute and WAWU ID's own account deletion to trigger.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(@Inject(WAWU_ID_ACCOUNT_GATEWAY) private readonly wawuIdGateway: WawuIdAccountGateway) {}

  async deleteAccount(wawuUserId: string): Promise<AccountDeletionResponse> {
    const deletionScheduledAt = new Date(Date.now() + GRACE_PERIOD_MS).toISOString();

    try {
      await this.wawuIdGateway.scheduleAccountDeletion(wawuUserId);
    } catch (error) {
      // Never silently swallow: log loudly, but the 48h local grace-period
      // marker still stands even if WAWU ID's own deletion call fails --
      // the two are orchestrated separately per the registry note, and a
      // WAWU ID outage should not block this backend's own soft-deletion
      // clock from starting.
      this.logger.error(
        `WAWU ID account deletion orchestration failed for ${wawuUserId}: ${(error as Error).message}`,
      );
    }

    return { deletionScheduledAt };
  }
}
