import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DittoInviteClient } from './ditto-invite.client';
import {
  DITTO_DISCOUNT_PERCENT,
  DITTO_SIGNUP_URL,
  DITTO_TIER,
} from './ditto.constants';

export interface DittoState {
  /** Whether this account's plan includes distribution at all. */
  eligible: boolean;
  optedIn: boolean;
  optedInAt: string | null;
  /** Only present once opted in — the link IS the benefit, so it is not given away early. */
  signupUrl: string | null;
  discountPercent: number;
  /** False when there was no address to send to. The link is still in the app. */
  emailed: boolean;
}

/**
 * Ditto Music distribution: an OPT-IN, not an entitlement that fires on
 * payment.
 *
 * The distinction is the whole point of this service. Pro Max includes
 * distribution, but enrolling somebody with a third party is theirs to choose
 * — so nothing here is triggered by a successful charge, and a paid Pro Max
 * account with no opt-in row is a normal account, not a broken one.
 */
@Injectable()
export class DittoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invites: DittoInviteClient,
  ) {}

  async stateFor(wawuUserId: string): Promise<DittoState> {
    const [state, optIn] = await Promise.all([
      this.prisma.creatorState.findUnique({
        where: { wawuUserId },
        select: { tier: true },
      }),
      this.prisma.dittoOptIn.findUnique({ where: { wawuUserId } }),
    ]);

    const eligible = state?.tier === DITTO_TIER;
    return {
      eligible,
      optedIn: optIn !== null,
      optedInAt: optIn?.optedInAt.toISOString() ?? null,
      signupUrl: optIn ? DITTO_SIGNUP_URL : null,
      discountPercent: DITTO_DISCOUNT_PERCENT,
      emailed: optIn?.emailedAt !== null && optIn?.emailedAt !== undefined,
    };
  }

  /**
   * Records the opt-in and sends the link.
   *
   * Idempotent: opting in twice returns the same row and does NOT re-send. A
   * button a creator can press repeatedly must not be a way to mail-bomb their
   * own inbox.
   */
  async optIn(wawuUserId: string): Promise<DittoState> {
    const state = await this.prisma.creatorState.findUnique({
      where: { wawuUserId },
      select: { tier: true },
    });
    if (state?.tier !== DITTO_TIER) {
      throw new ForbiddenException(
        'Music distribution through Ditto is part of Pro Max. Move up to Pro Max to opt in.',
      );
    }

    const existing = await this.prisma.dittoOptIn.findUnique({
      where: { wawuUserId },
    });
    if (existing) return this.stateFor(wawuUserId);

    // The row is written BEFORE the email is attempted. If the order were
    // reversed, a mail failure would lose the opt-in itself and the creator
    // would be shown the button again as though they had never pressed it.
    await this.prisma.dittoOptIn.create({ data: { wawuUserId } });

    const emailed = await this.invites.send(
      wawuUserId,
      DITTO_SIGNUP_URL,
      DITTO_DISCOUNT_PERCENT,
    );
    if (emailed) {
      await this.prisma.dittoOptIn.update({
        where: { wawuUserId },
        data: { emailedAt: new Date() },
      });
    }

    return this.stateFor(wawuUserId);
  }
}
