import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreatorTier } from '../../generated/prisma/enums';
import type { CreatorStateResponse } from '../common/types/creator-state.type';
import type { UpdateDmSettingsDto } from './dto/update-dm-settings.dto';
import { uploadAllowanceFor } from '../common/creator-tier-allowance';


/**
 * CreatorState is the creator-only entitlement/gate resource (CLAUDE.md: two
 * independent gates — subscriptionPaid gates uploading, kycStatus gates
 * earning). Both endpoints on this resource require the caller to already
 * be a creator: the "creator" role in the registry's endpoint contract is
 * enforced here by requiring a CreatorState row to exist for the caller's
 * wawuUserId (a plain user, e.g. the seeded 00000000-...-000000000001, has
 * none — a 403, not a 404, since the resource concept exists, they simply
 * aren't entitled to it).
 */
@Injectable()
export class CreatorStateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `kycStatus` is stored as a ReviewStatus, whose `pending` covers two states
   * that are nothing alike: "has never started KYC" and "submitted, waiting on
   * a reviewer". Reporting both as pending told creators who had done nothing
   * that their verification was in review, with no way to begin it.
   *
   * The distinction is derived from whether a KycSubmission actually exists
   * rather than stored, so it cannot drift out of step with the submissions
   * table.
   */
  private toResponse(state: {
    wawuUserId: string;
    tier: CreatorTier;
    subscriptionPaid: boolean;
    kycStatus: string;
    slotsUsed: number;
    dmPrice: number | null;
    dmEnabled: boolean;
    dmResponseHours: number;
  }, hasSubmitted = true): CreatorStateResponse {
    return {
      ...state,
      kycStatus:
        state.kycStatus === 'pending' && !hasSubmitted
          ? 'not_started'
          : state.kycStatus,
      slotsTotal: uploadAllowanceFor(state.tier).total,
    } as CreatorStateResponse;
  }

  async getState(wawuUserId: string): Promise<CreatorStateResponse> {
    const [state, submissionCount, profile, subscriptionCount] = await Promise.all([
      this.prisma.creatorState.findUnique({ where: { wawuUserId } }),
      this.prisma.kycSubmission.count({ where: { wawuUserId } }),
      this.prisma.userProfile.findUnique({
        where: { wawuUserId },
        select: { accountType: true },
      }),
      // Evidence, as opposed to a flag. See the gate below.
      this.prisma.creatorSubscription.count({ where: { creatorWawuId: wawuUserId } }),
    ]);
    if (!state) {
      // The route carries only WawuAuthGuard, so until now the CreatorState
      // row was doing two jobs at once: the data AND the authorisation. That
      // is why its absence had to be a 403.
      //
      // Splitting them: a PLAIN USER still gets 403, because this is not
      // their area. A CREATOR account with no row is a creator who has not
      // subscribed yet, which is a normal state and gets a real answer.
      /*
        A FLAG, OR PROOF.

        accountType alone was the whole test, and it is a single column that
        one lost write at signup leaves saying "user" for a creator. When that
        happened to somebody who had not subscribed yet there was no row to
        fall back on either, so this 403'd, the client cleared their creator
        state, and a creator account was shown the app in plain user mode with
        nothing on any screen explaining why.

        A CreatorSubscription is proof rather than a claim: nobody buys a
        creator plan by accident. So either the flag says creator, or they have
        paid for creator access at some point, and either is enough.
      */
      const isCreator = profile?.accountType === 'creator' || subscriptionCount > 0;
      if (!isCreator) {
        throw new ForbiddenException(
          'This account has no creator state — a creator account type is required.',
        );
      }
      // A creator who has not subscribed YET is a normal account, not an
      // error. CreatorState is only written when a subscription is paid for,
      // so between signing up as a creator and paying there is no row — which
      // is every new creator, for as long as it takes them to decide.
      //
      // This used to throw, and the app rendered the raw sentence with a "Try
      // again" button that could never work. Production had eight creator
      // accounts and ONE CreatorState row: every one of the other seven was
      // looking at that screen.
      //
      // CreatorAccountGuard has already established this caller IS a creator
      // account, so nothing is being handed to somebody who is not one. The
      // unpaid shape reports subscriptionPaid: false, which is exactly what
      // every gate downstream already keys on to withhold uploading.
      return this.unsubscribedState(wawuUserId, submissionCount > 0);
    }
    return this.toResponse(state, submissionCount > 0);
  }

  /**
   * What a creator account looks like before it has paid for anything.
   *
   * `tier` reports `basic` because the column is not nullable and every
   * consumer reads it for a label. It is never mistaken for an entitlement:
   * `subscriptionPaid: false` is what decides that, and `slotsUsed: 0` means
   * nothing has been published against it either.
   */
  private unsubscribedState(
    wawuUserId: string,
    hasSubmitted: boolean,
  ): CreatorStateResponse {
    return this.toResponse(
      {
        wawuUserId,
        tier: 'basic',
        subscriptionPaid: false,
        kycStatus: 'pending',
        slotsUsed: 0,
        dmPrice: null,
        dmEnabled: false,
        dmResponseHours: 24,
      },
      hasSubmitted,
    );
  }

  async updateDmSettings(wawuUserId: string, dto: UpdateDmSettingsDto): Promise<CreatorStateResponse> {
    const [existing, submissionCount] = await Promise.all([
      this.prisma.creatorState.findUnique({ where: { wawuUserId } }),
      this.prisma.kycSubmission.count({ where: { wawuUserId } }),
    ]);
    if (!existing) {
      throw new ForbiddenException('This account has no creator state — a creator account type is required.');
    }
    const updated = await this.prisma.creatorState.update({
      where: { wawuUserId },
      data: {
        dmEnabled: dto.dmEnabled,
        dmPrice: dto.dmPrice,
        // Omitted means "unchanged". Changing it never moves a deadline
        // already sold — each DM carries the window it was paid against.
        ...(dto.dmResponseHours === undefined
          ? {}
          : { dmResponseHours: dto.dmResponseHours }),
      },
    });
    // Must pass `hasSubmitted` through, exactly as getState does. Letting it
    // default to `true` made this endpoint report 'pending' for an account
    // GET /creator/state reported as 'not_started' — the same creator saw two
    // different KYC states depending on which call refreshed the screen.
    return this.toResponse(updated, submissionCount > 0);
  }
}
