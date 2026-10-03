import { HttpException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FintavaClient } from '../../fintava/fintava-client';
import { FINTAVA_DEFAULTS } from '../../fintava/fintava-config';
import {
  FintavaError,
  type FintavaErrorKind,
} from '../../fintava/fintava-error';
import type { FintavaSelfieResult } from '../../fintava/fintava.interface';
import { MoneyError } from '../money-error';
import type { SelfieMatchDto } from './dto/identity-request.dto';
import {
  BVN_CHECK_WINDOW_MS,
  type DailyAttemptLedger,
  IdentityHasher,
  reserveDailyAttempt,
} from './identity-config';
import type { SelfieMatchView } from './identity-view.type';
import {
  BVN_NOT_CHECKED_MESSAGE,
  type PassedBvnCheck,
  WALLET_ALREADY_OPEN_MESSAGE,
  WalletIdentityService,
} from './wallet-identity.service';

/** A16, word for word (title and line): the selfie did not match the BVN photo. */
export const SELFIE_NOT_MATCHED_MESSAGE =
  "We couldn't match your face. It must match your BVN photo. Good light, no glasses or cap.";
export const SELFIE_CHECKS_EXHAUSTED_MESSAGE =
  'You have used today’s selfie checks. Try again later.';
export const SELFIE_ALREADY_MATCHED_MESSAGE =
  'Your selfie already matches your BVN.';
export const SELFIE_UNAVAILABLE_MESSAGE =
  'We could not check your selfie right now. Try again in a moment.';

/**
 * Fintava kinds after which nothing reached the face-match provider, so
 * nothing was charged and the try is given back: no key or no base URL (not
 * sent at all), or a key Fintava refused. Narrower than the BVN check's
 * list: the selfie match was charged while WAWU's sandbox merchant was
 * inactive (`sandbox/05-bvn-selfie.md`), so a merchant refusal is not
 * assumed free. Everything else counts, a timeout included (it may have
 * been charged).
 */
const NOT_CHARGED: readonly FintavaErrorKind[] = ['not_configured', 'auth'];

/**
 * The selfie match to the BVN photo (task KYC-02, A6, A7, A16), after a
 * passed BVN check (KYC-01).
 *
 * Fintava's `POST /compliance/verify/bvn/selfie` compares the selfie with
 * the BVN record's photo. It is a face match, not a liveness check: Fintava
 * offers none, and nothing here claims one.
 *
 * The selfie lives only in the request that carries it: it goes to Fintava
 * and is dropped. It is never stored and never logged, and neither is the
 * BVN photo or anything else Fintava answers with (the MONEY-06 client
 * passes on only the verdict and a confidence score, and logs no body; it
 * masks image-like runs in Fintava's messages). The BVN is compared with
 * the keyed hash KYC-01 stored (WalletIdentityService.checkedBvn) and is
 * never stored either.
 *
 * What is stored, one SelfieMatchAttempt row per match sent: the outcome,
 * when it was taken and answered, Fintava's confidence score when it gives
 * one, and the passed BVN check it was compared against (when it passed and
 * its keyed hash), read once at the start of the request. A match counts
 * only while that is still the person's current check: a BVN check for
 * another BVN that passes while the selfie is being matched does not inherit
 * it. The row is also the per-person daily limit, counted the same way as
 * the BVN check's (reserveDailyAttempt), so parallel requests cannot get
 * past it.
 *
 * Only an explicit match from Fintava sets a match (the MONEY-06 client
 * reads the answer failing closed): an explicit "no" is A16, and an answer
 * with no verdict is counted and answered 503, never a match.
 *
 * Everything is keyed on the caller's token: no route names another person.
 */
@Injectable()
export class SelfieMatchService {
  private readonly logger = new Logger(SelfieMatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fintava: FintavaClient,
    private readonly hasher: IdentityHasher,
    private readonly identity: WalletIdentityService,
  ) {}

  async view(wawuUserId: string): Promise<SelfieMatchView> {
    const [matchedAt, used] = await Promise.all([
      this.currentMatchedAt(wawuUserId),
      this.used(wawuUserId, this.since()),
    ]);
    return this.toView(matchedAt, this.left(used));
  }

  /**
   * True when this person's selfie matched the BVN photo of their current
   * passed BVN check.
   */
  async selfieMatched(wawuUserId: string): Promise<boolean> {
    return (await this.currentMatchedAt(wawuUserId)) !== null;
  }

  /**
   * For account opening (MONEY-12): when this person's selfie matched
   * against exactly this BVN check (the same time and keyed hash, as
   * WalletIdentityService.checkedIdentity read it once), or null. Never a
   * second read of the current check.
   */
  matchedFor(wawuUserId: string, check: PassedBvnCheck): Promise<Date | null> {
    return this.matchedAt(wawuUserId, check);
  }

  async match(
    wawuUserId: string,
    input: SelfieMatchDto,
  ): Promise<SelfieMatchView> {
    if (
      !this.hasher.configured ||
      this.fintava.environment === 'unconfigured'
    ) {
      throw this.unavailable();
    }

    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId },
      select: { wawuUserId: true },
    });
    if (wallet) {
      throw new MoneyError('wallet_already_open', WALLET_ALREADY_OPEN_MESSAGE);
    }
    // The BVN must be the one whose check passed (compared as a keyed hash).
    // That check is read once, here, and everything below is tied to it.
    const check = await this.identity.checkedBvn(wawuUserId, input.bvn);
    if (!check) {
      throw new MoneyError('bvn_not_checked', BVN_NOT_CHECKED_MESSAGE);
    }
    if ((await this.matchedAt(wawuUserId, check)) !== null) {
      throw new MoneyError(
        'selfie_already_matched',
        SELFIE_ALREADY_MATCHED_MESSAGE,
      );
    }

    const attempt = await reserveDailyAttempt(
      this.ledger(check),
      wawuUserId,
      this.hasher.selfieChecksPerDay,
      (retryAfterSeconds) =>
        new MoneyError(
          'selfie_checks_exhausted',
          SELFIE_CHECKS_EXHAUSTED_MESSAGE,
          { retryAfterSeconds },
        ),
    );

    let result: FintavaSelfieResult;
    try {
      result = await this.fintava.verifyBvnSelfie({
        bvn: input.bvn,
        imageBase64: input.image,
      });
    } catch (e) {
      if (!(e instanceof FintavaError)) {
        await this.settle(attempt.id, 'unavailable');
        throw e;
      }
      if (NOT_CHARGED.includes(e.kind)) {
        await this.prisma.selfieMatchAttempt.delete({
          where: { id: attempt.id },
        });
        throw this.unavailable();
      }
      if (e.kind === 'identity_refused' || e.kind === 'validation') {
        await this.settle(attempt.id, 'not_matched');
        throw this.notMatched(attempt.used);
      }
      await this.settle(attempt.id, 'unavailable');
      throw this.unavailable();
    }

    if (!result.matched) {
      await this.settle(attempt.id, 'not_matched', result.confidence);
      throw this.notMatched(attempt.used);
    }
    await this.prisma.selfieMatchAttempt.update({
      where: { id: attempt.id },
      data: {
        outcome: 'matched',
        confidence: result.confidence,
        settledAt: new Date(),
      },
    });
    // The match is for the check it was compared against. If another BVN
    // check passed meanwhile, that is the current check now and this
    // selfie does not count for it: the BVN sent is no longer the checked
    // one.
    const matchedAt = await this.currentMatchedAt(wawuUserId);
    if (matchedAt === null) {
      throw new MoneyError('bvn_not_checked', BVN_NOT_CHECKED_MESSAGE);
    }
    return this.toView(matchedAt, this.left(attempt.used));
  }

  // -------------------------------------------------------------------------

  /**
   * SelfieMatchAttempt, as the shared daily limit counts it. A row it
   * writes records the BVN check the selfie is compared against.
   */
  private ledger(check: PassedBvnCheck): DailyAttemptLedger {
    return {
      create: async (wawuUserId) =>
        (
          await this.prisma.selfieMatchAttempt.create({
            data: {
              wawuUserId,
              bvnVerifiedAt: check.verifiedAt,
              bvnHash: check.bvnHash,
            },
            select: { id: true },
          })
        ).id,
      count: (wawuUserId, since) => this.used(wawuUserId, since),
      remove: async (id) => {
        await this.prisma.selfieMatchAttempt.delete({ where: { id } });
      },
      oldestSince: async (wawuUserId, since) =>
        (
          await this.prisma.selfieMatchAttempt.findFirst({
            where: { wawuUserId, createdAt: { gt: since } },
            orderBy: { createdAt: 'asc' },
            select: { createdAt: true },
          })
        )?.createdAt ?? null,
    };
  }

  private used(wawuUserId: string, since: Date): Promise<number> {
    return this.prisma.selfieMatchAttempt.count({
      where: { wawuUserId, createdAt: { gt: since } },
    });
  }

  /** matchedAt, for the person's passed BVN check as it stands now. */
  private async currentMatchedAt(wawuUserId: string): Promise<Date | null> {
    const check = await this.identity.currentBvnCheck(wawuUserId);
    return check ? this.matchedAt(wawuUserId, check) : null;
  }

  /**
   * When the selfie matched against this BVN check, or null: a selfie
   * counts only for the check it was compared against (the same time and
   * the same keyed hash), so a new BVN check (the same BVN or another) needs
   * a new selfie, and a check that passed while a selfie was being matched
   * does not inherit it.
   */
  private async matchedAt(
    wawuUserId: string,
    check: PassedBvnCheck,
  ): Promise<Date | null> {
    const row = await this.prisma.selfieMatchAttempt.findFirst({
      where: {
        wawuUserId,
        outcome: 'matched',
        bvnVerifiedAt: check.verifiedAt,
        bvnHash: check.bvnHash,
      },
      orderBy: { settledAt: 'desc' },
      select: { settledAt: true },
    });
    return row?.settledAt ?? null;
  }

  private toView(matchedAt: Date | null, checksLeft: number): SelfieMatchView {
    return { matchedAt: matchedAt?.toISOString() ?? null, checksLeft };
  }

  private since(): Date {
    return new Date(Date.now() - BVN_CHECK_WINDOW_MS);
  }

  private left(used: number): number {
    return Math.max(0, this.hasher.selfieChecksPerDay - used);
  }

  private notMatched(used: number): MoneyError {
    return new MoneyError('selfie_not_matched', SELFIE_NOT_MATCHED_MESSAGE, {
      checksLeft: this.left(used),
    });
  }

  private async settle(
    id: string,
    outcome: string,
    confidence: number | null = null,
  ): Promise<void> {
    try {
      await this.prisma.selfieMatchAttempt.update({
        where: { id },
        data: { outcome, confidence, settledAt: new Date() },
      });
    } catch {
      // The row still counts toward the limit as `pending`, which is the
      // safe side; the refusal the caller is about to get matters more.
      this.logger.warn('Selfie match: could not record the outcome of a match');
    }
  }

  private unavailable(): HttpException {
    return new MoneyError('provider_unreachable', SELFIE_UNAVAILABLE_MESSAGE, {
      retryAfterSeconds: FINTAVA_DEFAULTS.retryAfterSeconds,
    });
  }
}
