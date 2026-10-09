import type { PrismaService } from '../../common/prisma/prisma.service';
import { BVN_CHECK_WINDOW_MS } from '../identity/identity-config';
import { MoneyError } from '../money-error';

/**
 * The daily limit on opening attempts that name a BVN or NIN, when a provider
 * reviews the person (NUV-02 round 2, U2; lead ruling "attempt cap").
 *
 * Under Fintava the BVN check was the step that sent a BVN out, and it was
 * capped at 3 in 24 hours per person (`BVN_CHECKS_PER_DAY`,
 * `BvnCheckAttempt`). Under Nuvion that step is gone: the opening itself
 * names the BVN and NIN, so it carries the same limit, from the same setting
 * and the same ledger (a row holds only an id, the person and a time; its
 * `outcome` is `opening`).
 *
 * What counts as an attempt: a request that takes the claim on a BVN (a
 * first try, a try after a refusal or a lost answer, a correction), and one
 * that tries to and finds the number held by another account. Taps that find
 * an opening already in flight, being checked or stopped send and claim
 * nothing, so they count for nothing and a double tap never burns the limit.
 *
 * Before the claim the limit is read (over it: `429`, nothing claimed). After
 * it the attempt is written; an answer that says "held by another account"
 * writes first and counts after, so a burst of probes at once learns that
 * answer at most `perDay` times.
 */

/** `BvnCheckAttempt.outcome` of a row written for an opening attempt. */
export const OPENING_ATTEMPT_OUTCOME = 'opening';

export const OPENING_ATTEMPTS_EXHAUSTED_MESSAGE =
  'You have used today’s tries to open your wallet. Try again later.';

export class OpeningAttempts {
  constructor(
    private readonly prisma: Pick<PrismaService, 'bvnCheckAttempt'>,
    private readonly perDay: number,
  ) {}

  private since(): Date {
    return new Date(Date.now() - BVN_CHECK_WINDOW_MS);
  }

  private async exhausted(wawuUserId: string): Promise<MoneyError> {
    const oldest = await this.prisma.bvnCheckAttempt.findFirst({
      where: { wawuUserId, createdAt: { gt: this.since() } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    const freesAt =
      (oldest?.createdAt.getTime() ?? Date.now()) + BVN_CHECK_WINDOW_MS;
    return new MoneyError(
      'identity_checks_exhausted',
      OPENING_ATTEMPTS_EXHAUSTED_MESSAGE,
      {
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((freesAt - Date.now()) / 1000),
        ),
      },
    );
  }

  /** Throws the 429 when today's attempts are used up. Writes nothing. */
  async assertLeft(wawuUserId: string): Promise<void> {
    const used = await this.prisma.bvnCheckAttempt.count({
      where: { wawuUserId, createdAt: { gt: this.since() } },
    });
    if (used >= this.perDay) throw await this.exhausted(wawuUserId);
  }

  /**
   * Writes one attempt. With `refuseOver`, an attempt beyond the limit (a
   * burst raced past `assertLeft`) is taken back out and the 429 is thrown;
   * without it the attempt stands (the request already holds its claim).
   */
  async spend(wawuUserId: string, refuseOver: boolean): Promise<void> {
    const row = await this.prisma.bvnCheckAttempt.create({
      data: { wawuUserId, outcome: OPENING_ATTEMPT_OUTCOME },
      select: { id: true },
    });
    if (!refuseOver) return;
    const used = await this.prisma.bvnCheckAttempt.count({
      where: { wawuUserId, createdAt: { gt: this.since() } },
    });
    if (used <= this.perDay) return;
    await this.prisma.bvnCheckAttempt.delete({ where: { id: row.id } });
    throw await this.exhausted(wawuUserId);
  }
}
