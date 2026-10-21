import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { PrismaService } from '../common/prisma/prisma.service';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import {
  AI_VOICE_PROVIDER,
  AiVoiceProviderError,
  type AiVoiceProvider,
} from '../ai-tools/voice/ai-voice-provider';
import {
  CONSENT_CHANGED_MESSAGE,
  CONSENT_REQUIRED_MESSAGE,
  PREVIEW_LIMIT_MESSAGE,
  PREVIEW_UNAVAILABLE_MESSAGE,
  RECORDING_UNUSABLE_MESSAGE,
  TEXT_EMPTY_MESSAGE,
  tooLongMessage,
  UNAVAILABLE_MESSAGE,
  VoiceError,
} from './voice-intro-error';
import {
  NAME_PREVIEW_NAME,
  RECORDING_FOLDER,
  VOICE_FILES,
  type VoiceFiles,
} from './voice-files';
import type {
  MyVoiceView,
  NamePreviewView,
  PublicVoiceIntroView,
} from './voice-intro-view.type';
import type { NamePreviewDto } from './voice-intro.dto';

/** The setting: characters a Voice Intro script can have. */
export const INTRO_MAX_CHARS_SETTING = 'voice.intro_max_chars';
/** The setting: free name previews one person can ask for in an hour. */
export const NAME_PREVIEWS_SETTING = 'voice.name_previews_per_hour';

/**
 * The words a person agrees to before they record (VF8, the lead's ruling of 21 Oct 2026): the board's line with the person's own name,
 * from the Hub's record of them (the name on their sign-in, as `GET /users/me` gives it). The Hub serves them as `consent.line`, stores
 * exactly them with the time the person agreed, and takes back only the words it served. They name no provider (R-68).
 */
export function consentLineFor(name: string): string {
  const who = name.trim();
  return `${who ? `I am ${who}. ` : ''}I agree that Who Made This? may create an AI version of my voice for my intros.`;
}

/** The person's name as the Hub holds it: first, middle (when there is one) and last, as `GET /users/me` shows it. */
export function personName(
  claims: Pick<WawuJwtClaims, 'firstName' | 'middleName' | 'lastName'>,
): string {
  return [claims.firstName, claims.middleName, claims.lastName]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

/** The setting: the shortest recording the app takes, in seconds. */
export const RECORDING_MIN_SECONDS_SETTING = 'voice_intro.sample_min_seconds';
/** The setting: the longest recording the app takes, in seconds. */
export const RECORDING_MAX_SECONDS_SETTING = 'voice_intro.sample_max_seconds';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** The shape presign gives a stored recording: `<uuid>.<ext>`. */
const FILE_NAME = /^[0-9a-f-]{36}\.[a-z0-9]{2,4}$/;

/**
 * A person's own voice: how their name is said, the words of their Voice
 * Intro, their consent and their 30 second recording (VOICE-01, R-43, R-66).
 * Every method takes the caller's own id from the token; no route takes
 * another person's id, so there is no way to ask for or use someone else's
 * voice. Provider calls hold no transaction, connection or lock.
 */
@Injectable()
export class VoiceProfileService {
  private readonly logger = new Logger(VoiceProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlanSettingsService,
    private readonly blocked: BlockedAccountService,
    @Inject(AI_VOICE_PROVIDER) private readonly voice: AiVoiceProvider,
    @Inject(VOICE_FILES) private readonly files: VoiceFiles,
  ) {}

  /** The most characters a Voice Intro script can have, from the settings. */
  maxChars(): number {
    return this.settings.number(INTRO_MAX_CHARS_SETTING);
  }

  /** The shortest and longest recording, in seconds, from the settings (the app times the take; the Hub does not read a file's length). */
  sampleSeconds(): { min: number; max: number } {
    const max = this.settings.number(RECORDING_MAX_SECONDS_SETTING);
    // A shortest set above the longest could never be met: it is held down to the longest.
    return {
      min: Math.min(this.settings.number(RECORDING_MIN_SECONDS_SETTING), max),
      max,
    };
  }

  async mine(wawuUserId: string): Promise<MyVoiceView> {
    const row = await this.prisma.voiceProfile.findUnique({
      where: { wawuUserId },
      select: { namePhonetic: true, nameSavedAt: true },
    });
    return {
      namePhonetic: row?.namePhonetic ?? null,
      nameSavedAt: row?.nameSavedAt?.toISOString() ?? null,
      available: this.voice.configured,
    };
  }

  /**
   * Says the name in the studio voice. Free, so it is limited per hour by a
   * setting: the count is made and the try recorded under the person's lock,
   * then the provider is asked holding nothing.
   */
  async previewName(
    wawuUserId: string,
    dto: NamePreviewDto,
    now: Date = new Date(),
  ): Promise<NamePreviewView> {
    if (!this.voice.configured)
      throw new VoiceError('voice_unavailable', UNAVAILABLE_MESSAGE);
    const limit = this.settings.number(NAME_PREVIEWS_SETTING);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`voice-preview:${wawuUserId}`}, 0))`;
      await tx.voiceNamePreview.deleteMany({
        where: {
          wawuUserId,
          createdAt: { lt: new Date(now.getTime() - DAY_MS) },
        },
      });
      const recent = await tx.voiceNamePreview.count({
        where: {
          wawuUserId,
          createdAt: { gt: new Date(now.getTime() - HOUR_MS) },
        },
      });
      if (recent >= limit)
        throw new VoiceError('voice_preview_limit', PREVIEW_LIMIT_MESSAGE);
      await tx.voiceNamePreview.create({ data: { wawuUserId } });
    });

    const say = (dto.phonetic ?? dto.name).trim();
    let audio: Buffer;
    try {
      audio = (await this.voice.previewName({ text: say })).audio;
    } catch (e) {
      if (!(e instanceof AiVoiceProviderError))
        this.logger.error(
          `name preview: ${(e as Error).name ?? 'Error'} from the provider seam`,
        );
      throw new VoiceError('voice_unavailable', PREVIEW_UNAVAILABLE_MESSAGE);
    }
    try {
      const key = await this.files.putAudio(
        wawuUserId,
        NAME_PREVIEW_NAME,
        audio,
      );
      return { audioUrl: await this.files.urlFor(key), aiVoice: true };
    } catch {
      throw new VoiceError('voice_unavailable', PREVIEW_UNAVAILABLE_MESSAGE);
    }
  }

  /**
   * Another person's Voice Intro, as anyone looking at their profile sees it
   * (R-66): the audio link and `aiVoice: true`, or null when they have none.
   * A person who does not exist, or who blocked the viewer or was blocked by
   * them, answers the same 404 as the profile does. Only the audio is public:
   * never the words, the consent or the recording.
   */
  async publicIntro(
    viewerWawuId: string,
    wawuUserId: string,
  ): Promise<PublicVoiceIntroView> {
    const notFound = 'User not found';
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId },
      select: { wawuUserId: true },
    });
    if (!profile) throw new NotFoundException(notFound);
    await this.blocked.assertVisible(viewerWawuId, wawuUserId, notFound);
    const row = await this.prisma.voiceProfile.findUnique({
      where: { wawuUserId },
      select: { audioKey: true },
    });
    if (!row?.audioKey) return { voiceIntro: null };
    try {
      return {
        voiceIntro: {
          url: await this.files.urlFor(row.audioKey),
          aiVoice: true,
        },
      };
    } catch {
      // The intro is made and kept; its link comes on the next look.
      return { voiceIntro: null };
    }
  }

  async saveName(
    wawuUserId: string,
    phonetic: string | null,
    now: Date = new Date(),
  ): Promise<MyVoiceView> {
    const value = phonetic === null ? null : phonetic.trim();
    await this.prisma.voiceProfile.upsert({
      where: { wawuUserId },
      create: { wawuUserId, namePhonetic: value, nameSavedAt: now },
      update: { namePhonetic: value, nameSavedAt: now },
    });
    return this.mine(wawuUserId);
  }

  async saveText(
    wawuUserId: string,
    text: string,
    now: Date = new Date(),
  ): Promise<void> {
    const value = text.trim();
    const max = this.maxChars();
    if (value === '')
      throw new VoiceError('voice_text_empty', TEXT_EMPTY_MESSAGE);
    if (Array.from(value).length > max)
      throw new VoiceError('voice_text_too_long', tooLongMessage(max), {
        maxCharacters: max,
      });
    await this.prisma.voiceProfile.upsert({
      where: { wawuUserId },
      create: { wawuUserId, introText: value, introTextAt: now },
      update: { introText: value, introTextAt: now },
    });
  }

  /**
   * Records that the person agreed to exactly the words the Hub served for
   * them (`consentLineFor` their name), and when. Any other words are refused.
   */
  async giveConsent(
    wawuUserId: string,
    name: string,
    line: string,
    now: Date = new Date(),
  ): Promise<void> {
    const served = consentLineFor(name);
    if (line !== served)
      throw new VoiceError(
        'voice_consent_line_changed',
        CONSENT_CHANGED_MESSAGE,
      );
    await this.prisma.voiceProfile.upsert({
      where: { wawuUserId },
      create: { wawuUserId, consentAt: now, consentLine: served },
      update: { consentAt: now, consentLine: served },
    });
  }

  /**
   * Keeps the recording the person uploaded as their sample. It must be their
   * own file (FIX-77's rule): a link of this bucket, in `voice/sample`, with
   * the person's own id in the key and their own landed upload behind it. The
   * consent comes first; the time of that consent is stored with the sample.
   * The earlier sample, if any, is removed.
   */
  async setSample(
    wawuUserId: string,
    fileUrl: string,
    now: Date = new Date(),
  ): Promise<void> {
    const profile = await this.prisma.voiceProfile.findUnique({
      where: { wawuUserId },
      select: { consentAt: true, sampleKey: true },
    });
    if (!profile?.consentAt)
      throw new VoiceError('voice_consent_required', CONSENT_REQUIRED_MESSAGE);

    const unusable = () =>
      new VoiceError('voice_sample_unusable', RECORDING_UNUSABLE_MESSAGE);
    const key = await this.files.keyFromLink(fileUrl);
    if (key === null) throw unusable();
    const parts = key.split('/');
    const folderParts = RECORDING_FOLDER.split('/');
    const own =
      parts.length === folderParts.length + 2 &&
      folderParts.every((part, i) => parts[i] === part) &&
      parts[folderParts.length] === wawuUserId &&
      FILE_NAME.test(parts[parts.length - 1]);
    if (!own) throw unusable();
    const row = await this.prisma.storageObject.findUnique({
      where: { key },
      select: { wawuUserId: true, folder: true, status: true },
    });
    // Landed: `POST /uploads/confirm` made the row `confirmed`.
    if (
      !row ||
      row.wawuUserId !== wawuUserId ||
      row.folder !== RECORDING_FOLDER ||
      row.status !== 'confirmed'
    )
      throw unusable();

    await this.prisma.voiceProfile.update({
      where: { wawuUserId },
      data: {
        sampleKey: key,
        sampleAt: now,
        sampleConsentAt: profile.consentAt,
      },
    });
    if (profile.sampleKey && profile.sampleKey !== key)
      await this.files.remove(profile.sampleKey);
  }
}
