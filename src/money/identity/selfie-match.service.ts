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
 * the keyed hash KYC-01 stored (WalletIdentityService.matchesCheckedIdentity)
 * and is never stored either.
 *
 * What is stored, one SelfieMatchAttempt row per match sent: the outcome,
 * when it was taken and answered, and Fintava's confidence score when it
 * gives one. That row is also the per-person daily limit, counted the same
 * way as the BVN check's (reserveDailyAttempt), so parallel requests cannot
 * get past it.
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
      this.matchedAt(wawuUserId),
      this.ledger.count(wawuUserId, this.since()),
    ]);
    return this.toView(matchedAt, this.left(used));
  }

  /**
   * True when this person's selfie matched the BVN photo after their last
   * passed BVN check. For account opening (MONEY-12).
   */
  async selfieMatched(wawuUserId: string): Promise<boolean> {
    return (await this.matchedAt(wawuUserId)) !== null;
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
    if (
      !(await this.identity.matchesCheckedIdentity(wawuUserId, input.bvn, null))
    ) {
      throw new MoneyError('bvn_not_checked', BVN_NOT_CHECKED_MESSAGE);
    }
    if (await this.selfieMatched(wawuUserId)) {
      throw new MoneyError(
        'selfie_already_matched',
        SELFIE_ALREADY_MATCHED_MESSAGE,
      );
    }

    const attempt = await reserveDailyAttempt(
      this.ledger,
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
    const settledAt = new Date();
    await this.prisma.selfieMatchAttempt.update({
      where: { id: attempt.id },
      data: {
        outcome: 'matched',
        confidence: result.confidence,
        settledAt,
      },
    });
    return this.toView(settledAt, this.left(attempt.used));
  }

  // -------------------------------------------------------------------------

  /** SelfieMatchAttempt, as the shared daily limit counts it. */
  private readonly ledger: DailyAttemptLedger = {
    create: async (wawuUserId) =>
      (
        await this.prisma.selfieMatchAttempt.create({
          data: { wawuUserId },
          select: { id: true },
        })
      ).id,
    count: (wawuUserId, since) =>
      this.prisma.selfieMatchAttempt.count({
        where: { wawuUserId, createdAt: { gt: since } },
      }),
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

  /**
   * When the selfie last matched, if that was after the BVN check that
   * passed last: a selfie counts only for the BVN it was matched against,
   * and a new BVN check (the same BVN or another) needs a new selfie.
   */
  private async matchedAt(wawuUserId: string): Promise<Date | null> {
    const verifiedAt = await this.identity.bvnVerifiedAt(wawuUserId);
    if (!verifiedAt) return null;
    const row = await this.prisma.selfieMatchAttempt.findFirst({
      where: {
        wawuUserId,
        outcome: 'matched',
        createdAt: { gt: verifiedAt },
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
