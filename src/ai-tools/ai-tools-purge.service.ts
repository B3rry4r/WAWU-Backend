import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { AccountPurgeHooks } from '../account-purge/purge-hooks';
import { PrismaService } from '../common/prisma/prisma.service';
import { copyOfFlow, parseFlowRef, type FlowRef } from './flow/flow-support';
import { AiCloneService } from './own-voice/ai-clone.service';
import { ReceptionistService } from './receptionist/receptionist.service';
import {
  CONVERSATION_GIVE_UP_MS,
  copyOfMarker,
  ProviderCopyService,
} from './voice/provider-copy.service';

/** A flow note that did not parse names no assets. */
const NO_FLOW: FlowRef = { kind: 'image', generationId: 'none', assetIds: [] };

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
    // AITOOLS-11: a saved clone is a copy of the person's voice the provider holds until it is deleted.
    private readonly clones: AiCloneService,
    // AITOOLS-06: a Receptionist and what it knows are copies of the person's words the provider holds until they are deleted.
    @Optional() private readonly receptionist?: ReceptionistService,
  ) {}

  onModuleInit(): void {
    this.hooks.register((wawuUserId) => this.beforeErase(wawuUserId));
  }

  async beforeErase(wawuUserId: string): Promise<void> {
    await this.prisma.voiceProfile.updateMany({
      where: { wawuUserId, ownVoiceConsentAt: { not: null } },
      data: { ownVoiceConsentAt: null, ownVoiceConsentLine: null },
    });
    // AITOOLS-09 and -10: the person's photo and voice sent up as assets are a
    // copy of them too (`asset:<ids>`), removed the same way as a voice copy.
    const holdsCopy = {
      OR: [
        { providerRef: { startsWith: 'voice:' } },
        { providerRef: { startsWith: 'asset:' } },
        // REC-PRIVACY: a Receptionist conversation the provider still keeps. A note older than the sweep's give-up age
        // is ignored (the provider's own one-day limit has passed and the sweep drops it), so it cannot hold the purge.
        {
          providerRef: { startsWith: 'conversation:' },
          createdAt: { gte: new Date(Date.now() - CONVERSATION_GIVE_UP_MS) },
        },
      ],
    };
    // A picture or video still being made holds its assets under a `genrun:`
    // note: they are named there, so they are noted and removed first.
    const following = await this.prisma.aiToolJob.findMany({
      where: { wawuUserId, providerRef: { startsWith: 'genrun:' } },
      select: { id: true, providerRef: true },
      take: PURGE_BATCH,
    });
    for (const job of following) {
      const copy = copyOfFlow(parseFlowRef(job.providerRef) ?? NO_FLOW);
      if (!copy) continue;
      await this.copies.note(job.id, copy);
    }
    const noted = await this.prisma.aiToolJob.findMany({
      where: { wawuUserId, ...holdsCopy },
      select: { id: true, providerRef: true },
      orderBy: { createdAt: 'asc' },
      take: PURGE_BATCH,
    });
    for (const job of noted) {
      const copy = copyOfMarker(job.providerRef);
      if (!copy) continue;
      await this.copies.discard(job.id, copy.copy);
    }
    // AITOOLS-11: every saved clone of the person is deleted at the provider before its row goes (throws while one is left).
    await this.clones.beforeErase(wawuUserId);
    // AITOOLS-06: the agent and every document of the person's Receptionist are deleted at the provider before the rows go (throws while one is left).
    await this.receptionist?.beforeErase(wawuUserId);
    const left = await this.prisma.aiToolJob.count({
      where: { wawuUserId, ...holdsCopy },
    });
    if (left > 0) {
      this.logger.warn(
        `account purge: ${left} copies of one person's voice or photo are still held by the AI provider; the purge waits`,
      );
      throw new Error(
        'The AI provider still holds a copy of a voice or photo. The purge will try again.',
      );
    }
  }
}
