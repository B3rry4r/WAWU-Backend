import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { VOICE_FILES, type VoiceFiles } from '../../voice-intro/voice-files';
import { OWN_VOICE_ID } from './own-voice-id';
import {
  AiToolError,
  OWN_VOICE_LINE_CHANGED_MESSAGE,
  OWN_VOICE_NAME_REQUIRED_MESSAGE,
  OWN_VOICE_RECORDING_REQUIRED_MESSAGE,
} from '../ai-tools-error';
import type { OwnVoiceRemovedView, OwnVoiceView } from '../ai-tools-view.type';
import {
  AI_VOICE_PROVIDER,
  type AiVoiceProvider,
  type VoiceSample,
} from '../voice/ai-voice-provider';
import {
  copyOfMarker,
  ProviderCopyService,
} from '../voice/provider-copy.service';

export { OWN_VOICE_ID };

/**
 * The words a person agrees to before their own voice reads a VoiceOver: the
 * Voice Intro's line (VF8) with its last words changed, because the board draws
 * no consent for VoiceOver and the Voice Intro's covers intros only (R-29,
 * G-AITOOLS-07-1). It names no provider (R-68).
 */
export function ownVoiceConsentLineFor(name: string): string {
  const who = name.trim();
  if (!who) return OWN_VOICE_NAME_REQUIRED_MESSAGE;
  return `I am ${who}. I agree that Who Made This? may create an AI version of my voice for my VoiceOver.`;
}

/** The most notes of a copy of a person's voice one delete looks at (a person has no more than a few at a time). */
const REMOVE_BATCH = 50;

/**
 * "Your voice" in VoiceOver (AITOOLS-07): the person's own recording (their
 * Voice Intro's, VOICE-01) made into an AI version of their voice for ONE
 * VoiceOver at a time, and removed at the provider when it is read. Three rules:
 *
 *   1. only the person's own recording ever goes to the provider, and only after
 *      they agreed to these words for VoiceOver (a separate agreement from the
 *      Voice Intro's, stored with the time);
 *   2. the provider keeps no standing copy: the pipeline notes the voice on the
 *      job the moment it exists and deletes it when the job ends, trying again
 *      and then by sweep until the provider has dropped it (`ProviderCopyService`);
 *   3. `remove` takes the agreement back (no new copy can be made) and asks the
 *      provider to drop every copy of the person's voice it still holds.
 */
@Injectable()
export class OwnVoiceService {
  private readonly logger = new Logger(OwnVoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(VOICE_FILES) private readonly files: VoiceFiles,
    @Inject(AI_VOICE_PROVIDER) private readonly voice: AiVoiceProvider,
    private readonly copies: ProviderCopyService,
  ) {}

  async view(wawuUserId: string, name: string): Promise<OwnVoiceView> {
    const row = await this.prisma.voiceProfile.findUnique({
      where: { wawuUserId },
      select: {
        sampleKey: true,
        ownVoiceConsentAt: true,
        ownVoiceConsentLine: true,
      },
    });
    const hasRecording = !!row?.sampleKey;
    const given = !!row?.ownVoiceConsentAt;
    const available = this.voice.configured;
    return {
      available,
      hasRecording,
      consent: {
        line: row?.ownVoiceConsentLine ?? ownVoiceConsentLineFor(name),
        given,
        at: row?.ownVoiceConsentAt?.toISOString() ?? null,
      },
      ready: available && hasRecording && given,
    };
  }

  /**
   * Records that the person agreed to exactly the words the Hub served for
   * them, and when. Any other words are refused. Needs their Voice Intro
   * recording (their voice is made from nothing else).
   */
  async giveConsent(
    wawuUserId: string,
    name: string,
    line: string,
    now: Date = new Date(),
  ): Promise<OwnVoiceView> {
    if (name.trim() === '')
      throw new AiToolError(
        'own_voice_name_required',
        OWN_VOICE_NAME_REQUIRED_MESSAGE,
      );
    if (line !== ownVoiceConsentLineFor(name))
      throw new AiToolError(
        'own_voice_consent_line_changed',
        OWN_VOICE_LINE_CHANGED_MESSAGE,
      );
    const row = await this.prisma.voiceProfile.findUnique({
      where: { wawuUserId },
      select: { sampleKey: true },
    });
    if (!row?.sampleKey)
      throw new AiToolError(
        'own_voice_recording_required',
        OWN_VOICE_RECORDING_REQUIRED_MESSAGE,
      );
    await this.prisma.voiceProfile.update({
      where: { wawuUserId },
      data: { ownVoiceConsentAt: now, ownVoiceConsentLine: line },
    });
    return this.view(wawuUserId, name);
  }

  /** True when the person can have a VoiceOver read in their own voice right now. */
  async ready(wawuUserId: string): Promise<boolean> {
    if (!this.voice.configured) return false;
    const row = await this.prisma.voiceProfile.findUnique({
      where: { wawuUserId },
      select: { sampleKey: true, ownVoiceConsentAt: true },
    });
    return !!row?.sampleKey && !!row.ownVoiceConsentAt;
  }

  /**
   * The person's own recording, for one run: only while they have agreed and
   * only THEIR recording (the key is read from their own row; no request names
   * a key). Null when the agreement was taken back, or no recording is there.
   */
  async sampleFor(wawuUserId: string): Promise<VoiceSample | null> {
    const row = await this.prisma.voiceProfile.findUnique({
      where: { wawuUserId },
      select: { sampleKey: true, ownVoiceConsentAt: true },
    });
    if (!row?.sampleKey || !row.ownVoiceConsentAt) return null;
    return this.files.readSample(row.sampleKey);
  }

  /**
   * Takes the agreement back, then asks the provider to drop every copy of the
   * person's voice it still holds (a copy is only ever left by a try that
   * failed; each is noted on its job). The agreement goes FIRST, so no job can
   * make a new copy while the old ones are removed. The Voice Intro and its
   * recording stay: they have their own agreement.
   */
  async remove(wawuUserId: string, name: string): Promise<OwnVoiceRemovedView> {
    await this.prisma.voiceProfile.updateMany({
      where: { wawuUserId },
      data: { ownVoiceConsentAt: null, ownVoiceConsentLine: null },
    });
    const noted = await this.prisma.aiToolJob.findMany({
      where: { wawuUserId, providerRef: { startsWith: 'voice:' } },
      select: { id: true, providerRef: true },
      take: REMOVE_BATCH,
    });
    for (const job of noted) {
      const copy = copyOfMarker(job.providerRef);
      if (!copy) continue;
      await this.copies.discard(job.id, copy.copy);
    }
    const left = await this.prisma.aiToolJob.count({
      where: { wawuUserId, providerRef: { startsWith: 'voice:' } },
    });
    if (left > 0)
      this.logger.warn(
        `own voice: ${left} copies are still being removed at the provider for one person`,
      );
    return {
      own: await this.view(wawuUserId, name),
      atProvider: left === 0 ? 'gone' : 'pending',
    };
  }
}
