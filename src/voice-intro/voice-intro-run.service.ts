import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { VoiceIntroRun } from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { isUniqueViolation } from '../money/prisma-unique';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import { PLANS_CONFIG, type PlansConfig } from '../plans/plans-config';
import { MakerTierService } from '../plans/maker-tier.service';
import { PointsError } from '../points/points-error';
import {
  jobHoldReference,
  PointsSpendService,
} from '../points/spend/points-spend.service';
import {
  AI_VOICE_PROVIDER,
  AiVoiceProviderError,
  type AiVoiceProvider,
} from '../ai-tools/voice/ai-voice-provider';
import {
  BUSY_MESSAGE,
  CONSENT_REQUIRED_MESSAGE,
  KEY_REQUIRED_MESSAGE,
  RUN_FAILED_MESSAGE,
  RECORDING_REQUIRED_MESSAGE,
  TEXT_REQUIRED_MESSAGE,
  tooLongMessage,
  UNAVAILABLE_MESSAGE,
  VoiceError,
} from './voice-intro-error';
import { introAudioKey, VOICE_FILES, type VoiceFiles } from './voice-files';
import { CONSENT_LINE, VoiceProfileService } from './voice-profile.service';
import type { VoiceIntroView, VoiceRunView } from './voice-intro-view.type';

/** The plan's action a Voice Intro is priced by (200 points, from the settings). */
export const VOICE_INTRO_ACTION = 'voice_intro';
/** The setting that says how long a run may stay `working` before it is given up on. */
const MAX_RUN_MINUTES_SETTING = 'points.job_max_run_minutes';

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;
/** The only try a run's hold has: a failed run is never retried, a new run (and key) is. */
const ATTEMPT = 1;

export interface StartedRun {
  view: VoiceIntroView;
  /** True when the Idempotency-Key had already started this run: nothing ran, nothing was taken again. */
  replayed: boolean;
}

/**
 * Making a Voice Intro in the person's own voice (VOICE-01, R-43, R-66).
 *
 *   1. check the words, consent, sample and that voices are on;
 *   2. pay: the first Voice Intro a tier includes takes no points (its flag is
 *      spent in the same short transaction that writes the run); any other
 *      holds 200 points (a setting) through POINTS-03;
 *   3. write the run and answer `working`; the provider is asked after the
 *      answer, holding no transaction, no connection and no lock;
 *   4. audio back: store it, then COMMIT the hold (the deciding step), then
 *      mark the run done and make the audio the person's Voice Intro.
 *      Anything else: RELEASE the hold (or put the included one back) and mark
 *      the run failed, so no points are taken.
 *
 * One run in flight per person (a unique index), so two tries at once cannot
 * both spend the included one or both hold points. The Idempotency-Key is
 * required; the run's id comes from the person and key, so a retry after a
 * lost answer finds the first run.
 */
@Injectable()
export class VoiceIntroRunService {
  private readonly logger = new Logger(VoiceIntroRunService.name);
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly plan: PlansConfig,
    private readonly settings: PlanSettingsService,
    private readonly spend: PointsSpendService,
    private readonly tiers: MakerTierService,
    private readonly profiles: VoiceProfileService,
    @Inject(AI_VOICE_PROVIDER) private readonly voice: AiVoiceProvider,
    @Inject(VOICE_FILES) private readonly files: VoiceFiles,
  ) {}

  async generate(
    wawuUserId: string,
    idempotencyKey: string | undefined,
    now: Date = new Date(),
  ): Promise<StartedRun> {
    if (!idempotencyKey || !KEY_FORMAT.test(idempotencyKey))
      throw new VoiceError('idempotency_key_required', KEY_REQUIRED_MESSAGE);
    const id = runIdFor(wawuUserId, idempotencyKey);

    // A repeat of a request that already started a run answers that run.
    const earlier = await this.prisma.voiceIntroRun.findUnique({
      where: { id },
    });
    if (earlier) return this.replay(wawuUserId, earlier);

    const profile = await this.prisma.voiceProfile.findUnique({
      where: { wawuUserId },
    });
    const text = profile?.introText?.trim() ?? '';
    if (text === '')
      throw new VoiceError('voice_text_required', TEXT_REQUIRED_MESSAGE);
    if (!profile?.consentAt)
      throw new VoiceError('voice_consent_required', CONSENT_REQUIRED_MESSAGE);
    if (!profile.sampleKey)
      throw new VoiceError('voice_sample_required', RECORDING_REQUIRED_MESSAGE);
    const characters = Array.from(text).length;
    const max = this.profiles.maxChars();
    if (characters > max)
      throw new VoiceError('voice_text_too_long', tooLongMessage(max), {
        maxCharacters: max,
      });
    if (!this.voice.configured)
      throw new VoiceError('voice_unavailable', UNAVAILABLE_MESSAGE);

    // One run at a time: a run that is still going (or just ended) is settled first.
    const going = await this.prisma.voiceIntroRun.findFirst({
      where: { wawuUserId, state: 'working' },
    });
    if (going && (await this.reconcile(going)).state === 'working')
      throw new VoiceError('voice_intro_busy', BUSY_MESSAGE);

    let run: VoiceIntroRun;
    try {
      run =
        (await this.startIncluded(
          wawuUserId,
          id,
          idempotencyKey,
          characters,
          now,
        )) ??
        (await this.startPaid(wawuUserId, id, idempotencyKey, characters, now));
    } catch (e) {
      if (e instanceof LostRace) {
        const winner = await this.prisma.voiceIntroRun.findUnique({
          where: { id },
        });
        if (winner) return this.replay(wawuUserId, winner);
        throw new VoiceError('voice_intro_busy', BUSY_MESSAGE);
      }
      throw e;
    }

    // Nothing is held open from here: the answer goes out, the run goes on.
    this.start(run, text, profile.sampleKey);
    return { view: await this.view(wawuUserId), replayed: false };
  }

  /** The person's Voice Intro as it stands now: words, consent, sample, audio, the next cost and the latest run. */
  async view(
    wawuUserId: string,
    now: Date = new Date(),
  ): Promise<VoiceIntroView> {
    const latest = await this.prisma.voiceIntroRun.findFirst({
      where: { wawuUserId },
      orderBy: { createdAt: 'desc' },
    });
    // Settled first: a finish the settle makes is the person's intro below.
    const run = latest ? await this.reconcile(latest) : null;
    const profile = await this.prisma.voiceProfile.findUnique({
      where: { wawuUserId },
    });
    const held = await this.tiers.tierOf(wawuUserId, now);
    const free = held.voiceIntroIncluded && held.state !== 'ended';
    const action = this.plan.actions.find((a) => a.id === VOICE_INTRO_ACTION);

    let audioUrl: string | null = null;
    if (profile?.audioKey) {
      try {
        audioUrl = await this.files.urlFor(profile.audioKey);
      } catch {
        // The intro is made and kept; the link comes on the next read.
        audioUrl = null;
      }
    }
    const text = profile?.introText ?? null;
    return {
      aiVoice: true,
      text,
      textMaxChars: this.profiles.maxChars(),
      consent: {
        line: CONSENT_LINE,
        given: !!profile?.consentAt,
        at: profile?.consentAt?.toISOString() ?? null,
      },
      sample: {
        recorded: !!profile?.sampleKey,
        at: profile?.sampleAt?.toISOString() ?? null,
      },
      audioUrl,
      next: { free, costPoints: free ? 0 : (action?.points ?? 0) },
      canGenerate:
        this.voice.configured &&
        !!text &&
        !!profile?.consentAt &&
        !!profile?.sampleKey &&
        run?.state !== 'working',
      run: run ? runView(run) : null,
    };
  }

  /** Waits for the runs this server is running. For specs and a clean stop. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  // -------------------------------------------------------------------------

  private async replay(
    wawuUserId: string,
    row: VoiceIntroRun,
  ): Promise<StartedRun> {
    await this.reconcile(row);
    return { view: await this.view(wawuUserId), replayed: true };
  }

  /**
   * The tier's included first Voice Intro: its flag is spent and the run
   * written in ONE short transaction (a run that cannot be written gives the
   * flag back by rolling back). Null when the tier gives none now.
   */
  private async startIncluded(
    wawuUserId: string,
    id: string,
    idempotencyKey: string,
    characters: number,
    now: Date,
  ): Promise<VoiceIntroRun | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const spent = await tx.makerTier.updateMany({
          where: {
            wawuUserId,
            voiceIntroIncluded: true,
            activeUntil: { gt: now },
          },
          data: { voiceIntroIncluded: false },
        });
        if (spent.count === 0) return null;
        return tx.voiceIntroRun.create({
          data: {
            id,
            wawuUserId,
            idempotencyKey,
            characters,
            costPoints: 0,
            includedUsed: true,
          },
        });
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new LostRace();
      throw e;
    }
  }

  /** 200 points (the plan's `voice_intro` action) held through POINTS-03, then the run written. */
  private async startPaid(
    wawuUserId: string,
    id: string,
    idempotencyKey: string,
    characters: number,
    now: Date,
  ): Promise<VoiceIntroRun> {
    // Refuses over a cap (named) or a short balance, and holds nothing when it
    // does. Once per reference, so a second request with this key takes nothing more.
    const held = await this.spend.hold(
      {
        wawuUserId,
        action: VOICE_INTRO_ACTION,
        units: 1,
        reference: jobHoldReference(id, ATTEMPT),
      },
      { now },
    );
    try {
      return await this.prisma.voiceIntroRun.create({
        data: {
          id,
          wawuUserId,
          idempotencyKey,
          characters,
          costPoints: held.costPoints,
          holdId: held.holdId,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        // Another request holds the one place: its run, if it is this key's
        // own, owns the hold. Otherwise this hold belongs to nobody.
        const own = await this.prisma.voiceIntroRun.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!own) await this.giveBack(held.holdId);
        throw new LostRace();
      }
      await this.giveBackUnwritten(id, held.holdId);
      throw e;
    }
  }

  private async giveBack(holdId: string): Promise<void> {
    try {
      await this.spend.release(holdId);
    } catch (err) {
      this.logger.error(
        `voice intro: the points were not given back yet (${(err as Error).name ?? 'Error'}); the stale-hold sweep will`,
      );
    }
  }

  private async giveBackUnwritten(id: string, holdId: string): Promise<void> {
    const row = await this.prisma.voiceIntroRun
      .findUnique({ where: { id }, select: { id: true } })
      .catch(() => null);
    if (!row) await this.giveBack(holdId);
  }

  private start(run: VoiceIntroRun, text: string, sampleKey: string): void {
    const going = this.run(run, text, sampleKey)
      .catch((e: unknown) => {
        this.logger.error(
          `voice intro ${run.id}: the run stopped (${(e as Error).name ?? 'Error'}); a read of the intro will settle it`,
        );
      })
      .finally(() => this.inFlight.delete(going));
    this.inFlight.add(going);
  }

  /** The provider call and what follows. Holds no transaction, connection or lock across a network call. */
  private async run(
    run: VoiceIntroRun,
    text: string,
    sampleKey: string,
  ): Promise<void> {
    let sample: Awaited<ReturnType<VoiceFiles['readSample']>>;
    try {
      sample = await this.files.readSample(sampleKey);
    } catch {
      await this.fail(run, 'sample_unreadable');
      return;
    }
    let spoken: Awaited<ReturnType<AiVoiceProvider['speakInOwnVoice']>>;
    try {
      spoken = await this.voice.speakInOwnVoice({ sample, text });
    } catch (e) {
      await this.fail(
        run,
        e instanceof AiVoiceProviderError && e.kind === 'rejected'
          ? 'provider_failed'
          : 'provider_unavailable',
      );
      return;
    }
    let key: string;
    try {
      key = await this.files.putAudio(run.wawuUserId, run.id, spoken.audio);
    } catch {
      await this.fail(run, 'store_failed');
      return;
    }
    if (run.holdId) {
      try {
        // The deciding step: the sweep that gave the points back first wins,
        // and then this finish is refused.
        await this.spend.commit(run.holdId);
      } catch (e) {
        if (e instanceof PointsError && e.code === 'points_hold_settled') {
          await this.files.remove(key);
          await this.endFailed(run, 'timed_out');
          return;
        }
        throw e;
      }
    }
    await this.endDone(run, key);
  }

  /** The run did not work: every held point goes back (or the included one), then the run says so. */
  private async fail(run: VoiceIntroRun, failureCode: string): Promise<void> {
    if (run.holdId) {
      try {
        await this.spend.release(run.holdId);
      } catch (e) {
        if (!(e instanceof PointsError && e.code === 'points_hold_settled')) {
          // The points stay held; the sweep gives them back and `reconcile`
          // then marks the run failed.
          this.logger.error(
            `voice intro ${run.id}: the points were not given back yet (${(e as Error).name ?? 'Error'})`,
          );
          return;
        }
      }
    }
    await this.endFailed(run, failureCode);
  }

  /**
   * Moves a `working` run to `failed`, once, and puts the tier's included
   * first Voice Intro back when this run had spent it (same transaction, so a
   * run that already ended gives nothing back twice).
   */
  private async endFailed(
    run: VoiceIntroRun,
    failureCode: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const ended = await tx.voiceIntroRun.updateMany({
        where: { id: run.id, state: 'working' },
        data: { state: 'failed', failureCode, finishedAt: new Date() },
      });
      if (ended.count === 1 && run.includedUsed)
        await tx.makerTier.updateMany({
          where: { wawuUserId: run.wawuUserId },
          data: { voiceIntroIncluded: true },
        });
    });
  }

  /**
   * Moves a `working` run to `done` once and makes its audio the person's
   * Voice Intro (the one the public profile serves). A run that already ended
   * (given up on while the provider was slow) leaves the audio out and removes it.
   */
  private async endDone(run: VoiceIntroRun, audioKey: string): Promise<void> {
    const now = new Date();
    const earlier = await this.prisma.$transaction(async (tx) => {
      const ended = await tx.voiceIntroRun.updateMany({
        where: { id: run.id, state: 'working' },
        data: { state: 'done', audioKey, finishedAt: now },
      });
      if (ended.count === 0) return { applied: false, previous: null };
      const before = await tx.voiceProfile.findUnique({
        where: { wawuUserId: run.wawuUserId },
        select: { audioKey: true },
      });
      await tx.voiceProfile.update({
        where: { wawuUserId: run.wawuUserId },
        data: { audioKey, audioAt: now },
      });
      return { applied: true, previous: before?.audioKey ?? null };
    });
    if (!earlier.applied) await this.files.remove(audioKey);
    else if (earlier.previous && earlier.previous !== audioKey)
      await this.files.remove(earlier.previous);
  }

  /**
   * A `working` run follows what happened to it: a paid one follows its hold
   * (given back means failed, spent means done); one the included first paid
   * for is given up on once it has run longer than a job may
   * (`points.job_max_run_minutes`), which puts the included one back.
   */
  private async reconcile(run: VoiceIntroRun): Promise<VoiceIntroRun> {
    if (run.state !== 'working') return run;
    if (run.holdId) {
      const hold = await this.prisma.pointHold.findUnique({
        where: { id: run.holdId },
        select: { state: true },
      });
      if (!hold || hold.state === 'held') return run;
      if (hold.state === 'committed')
        await this.endDone(run, introAudioKey(run.wawuUserId, run.id));
      else await this.endFailed(run, 'timed_out');
    } else {
      const maxMinutes = this.settings.number(MAX_RUN_MINUTES_SETTING);
      if (Date.now() - run.createdAt.getTime() <= maxMinutes * 60_000)
        return run;
      await this.endFailed(run, 'timed_out');
    }
    return (
      (await this.prisma.voiceIntroRun.findUnique({ where: { id: run.id } })) ??
      run
    );
  }
}

/** Another request got the one place for a run first. */
class LostRace extends Error {}

function runView(run: VoiceIntroRun): VoiceRunView {
  return {
    id: run.id,
    state: run.state,
    costPoints: run.costPoints,
    included: run.includedUsed,
    message: run.state === 'failed' ? RUN_FAILED_MESSAGE : null,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
  };
}

/** The run's id from the person and key: a UUID-shaped text, the same for the same pair. */
export function runIdFor(wawuUserId: string, idempotencyKey: string): string {
  const h = createHash('sha256')
    .update(`wawu-voice-intro.v1\n${wawuUserId}\n${idempotencyKey}`)
    .digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
