import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AccountPurgeHooks } from '../account-purge/purge-hooks';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  copyOfMarker,
  ProviderCopyService,
} from './voice/provider-copy.service';

/** The most notes of a person's voice one purge pass looks at (a person has no more than a few at a time). */
const PURGE_BATCH = 50;

/**
 * When a WAWU account is purged (SETTINGS-06) the AI provider must not keep a
 * copy of the person's voice (AITOOLS-07, R-68). "Your voice" is made for one
 * VoiceOver and noted on the job (`providerRef` `voice:<id>`); the purge deletes
 * the job rows, and with them the only note of a copy the provider still holds.
 * So before any row goes this step:
 *
 *   1. takes the person's VoiceOver agreement back, so no new copy can be made
 *      while the old ones are removed;
 *   2. asks the provider to drop every copy still noted, by the removal path
 *      the job itself and `DELETE /ai-tools/own-voice` use (`ProviderCopyService`);
 *   3. throws while any note is left. The purge then stops before it deletes
 *      anything, the note stays on its job row, and the sweep that called it
 *      tries again on its next pass. Nothing is deleted behind a copy the
 *      provider still holds.
 *
 * Safe to run again. No log line or message holds an id of the provider.
 */
@Injectable()
export class AiToolsPurgeService implements OnModuleInit {
  private readonly logger = new Logger(AiToolsPurgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly copies: ProviderCopyService,
    private readonly hooks: AccountPurgeHooks,
  ) {}

  onModuleInit(): void {
    this.hooks.register((wawuUserId) => this.beforeErase(wawuUserId));
  }

  async beforeErase(wawuUserId: string): Promise<void> {
    await this.prisma.voiceProfile.updateMany({
      where: { wawuUserId, ownVoiceConsentAt: { not: null } },
      data: { ownVoiceConsentAt: null, ownVoiceConsentLine: null },
    });
    const noted = await this.prisma.aiToolJob.findMany({
      where: { wawuUserId, providerRef: { startsWith: 'voice:' } },
      select: { id: true, providerRef: true },
      orderBy: { createdAt: 'asc' },
      take: PURGE_BATCH,
    });
    for (const job of noted) {
      const copy = copyOfMarker(job.providerRef);
      if (!copy) continue;
      await this.copies.discard(job.id, copy.copy);
    }
    const left = await this.prisma.aiToolJob.count({
      where: { wawuUserId, providerRef: { startsWith: 'voice:' } },
    });
    if (left > 0) {
      this.logger.warn(
        `account purge: ${left} copies of one person's voice are still held by the AI provider; the purge waits`,
      );
      throw new Error(
        'The AI provider still holds a copy of a voice. The purge will try again.',
      );
    }
  }
}
