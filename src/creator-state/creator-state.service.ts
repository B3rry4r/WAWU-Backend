import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreatorStateResponse } from '../common/types/creator-state.type';
import type { UpdateDmSettingsDto } from './dto/update-dm-settings.dto';
import {
  TICK_COLUMNS,
  holdsTick,
  uploadAllowanceFor,
} from '../common/creator-allowance';

/**
 * CreatorState is the creator-only entitlement/gate resource. There is one
 * gate left on it: kycStatus gates EARNING. The upload gate went with
 * subscriptions (build brief B1: "Do not gate uploads behind payment"), so
 * uploading is bounded only by the cap in creator-allowance.ts, which a
 * tick raises (R-7).
 * Both endpoints on this resource require the caller to already
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
  private toResponse(
    state: {
      wawuUserId: string;
      kycStatus: string;
      slotsUsed: number;
      dmPrice: number | null;
      dmEnabled: boolean;
      dmResponseHours: number;
    },
    hasSubmitted: boolean,
    tickHeld: boolean,
  ): CreatorStateResponse {
    return {
      ...state,
      kycStatus:
        state.kycStatus === 'pending' && !hasSubmitted
          ? 'not_started'
          : state.kycStatus,
      slotsTotal: uploadAllowanceFor(tickHeld).total,
    } as CreatorStateResponse;
  }

  async getState(wawuUserId: string): Promise<CreatorStateResponse> {
    const [state, submissionCount, profile] = await Promise.all([
      this.prisma.creatorState.findUnique({ where: { wawuUserId } }),
      this.prisma.kycSubmission.count({ where: { wawuUserId } }),
      this.prisma.userProfile.findUnique({
        where: { wawuUserId },
        select: { accountType: true, ...TICK_COLUMNS },
      }),
    ]);
    const tickHeld = holdsTick(profile);
    if (!state) {
      // A PLAIN USER gets 403, because this is not their area. A CREATOR
      // account with no row yet is a normal account and gets a real answer.
      //
      // `accountType` is now the only test. It used to have a fallback: an
      // existing CreatorSubscription counted as proof of a creator account
      // when the flag had been lost at signup. Nothing has replaced it,
      // because nothing else in the database is bought only by creators. This
      // narrows who is recognised, it does not widen it.
      if (profile?.accountType !== 'creator') {
        throw new ForbiddenException(
          'This account has no creator state - a creator account type is required.',
        );
      }
      // CreatorState is written the first time a creator publishes or
      // configures something, so between signing up and doing either there is
      // no row. That is every new creator, and it is not an error: this used
      // to throw and the app rendered the raw sentence with a "Try again"
      // button that could never work.
      return this.startingState(wawuUserId, submissionCount > 0, tickHeld);
    }
    return this.toResponse(state, submissionCount > 0, tickHeld);
  }

  /**
   * What a creator account looks like before it has published or configured
   * anything.
   *
   * `kycStatus: 'pending'` is the real starting value and still gates earning;
   * `slotsUsed: 0` means nothing has been published against the account yet.
   */
  private startingState(
    wawuUserId: string,
    hasSubmitted: boolean,
    tickHeld: boolean,
  ): CreatorStateResponse {
    return this.toResponse(
      {
        wawuUserId,
        kycStatus: 'pending',
        slotsUsed: 0,
        dmPrice: null,
        dmEnabled: false,
        dmResponseHours: 24,
      },
      hasSubmitted,
      tickHeld,
    );
  }

  async updateDmSettings(
    wawuUserId: string,
    dto: UpdateDmSettingsDto,
  ): Promise<CreatorStateResponse> {
    const [existing, submissionCount, profile] = await Promise.all([
      this.prisma.creatorState.findUnique({ where: { wawuUserId } }),
      this.prisma.kycSubmission.count({ where: { wawuUserId } }),
      this.prisma.userProfile.findUnique({
        where: { wawuUserId },
        select: TICK_COLUMNS,
      }),
    ]);
    if (!existing) {
      throw new ForbiddenException(
        'This account has no creator state - a creator account type is required.',
      );
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
    // The tick is passed the same way, so both report the same slotsTotal.
    return this.toResponse(updated, submissionCount > 0, holdsTick(profile));
  }
}
