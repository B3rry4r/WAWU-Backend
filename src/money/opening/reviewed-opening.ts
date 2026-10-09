import {
  BadRequestException,
  type HttpException,
  Logger,
} from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';
import { toLocalNigerianPhone } from '../../wallet-provider/nigerian-phone';
import { isRowOf } from '../../wallet-provider/provider-rows';
import type {
  ProviderReviewDetails,
  ProviderReviewState,
  WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import {
  UNDER_REVIEW_MESSAGE,
  WalletProviderError,
} from '../../wallet-provider/wallet-provider-error';
import type { IdentityHasher } from '../identity/identity-config';
import { MoneyError } from '../money-error';
import type { WalletReviewView } from '../money-view.type';
import { alignClaim, CLAIM_LOST, heldBvnHash } from './bvn-claim';
import { noteDocumentRefusals } from './document-refusals';
import type { OpenNairaWalletDto } from './dto/open-wallet.dto';
import { REVIEW_REQUIRED_FIELDS } from './dto/open-wallet.dto';
import { OpeningAttempts } from './opening-attempts';
import {
  isNewDecision,
  numbersFailed,
  openingStateForStage,
  type ReviewRecord,
  reviewStageOf,
  reviewViewOf,
} from './review-stage';

/** An opening row as the reviewed path reads it. */
export interface ReviewedOpeningRow {
  wawuUserId: string;
  state: string;
  bvnHash: string;
  phone: string;
  attempts: number;
  attemptStartedAt: Date;
  checkedAt: Date | null;
  failure: string | null;
  provider?: string | null;
}

/** What the reviewed path needs from the opening service. */
export interface ReviewedOpeningHost {
  readonly prisma: PrismaService;
  readonly provider: WalletProvider;
  readonly hasher: IdentityHasher;
  dbNow(): Promise<Date>;
  opening(wawuUserId: string): Promise<ReviewedOpeningRow | null>;
  unstick(row: ReviewedOpeningRow, now: Date): Promise<ReviewedOpeningRow>;
  hasWallet(wawuUserId: string): Promise<boolean>;
  /** The provider may have made something although the call failed. */
  mayHaveOpened(e: WalletProviderError): boolean;
  /** A refusal about the details sent (422) or anything else (503). */
  refusal(e: WalletProviderError): HttpException;
  unavailable(): HttpException;
  resendAfterMs(): number;
  recheckAfterMs: number;
}

export const EMAIL_NEEDED_FOR_REVIEW =
  'Add an email address to your account, then try again.';
export const PHONE_NOT_NIGERIAN_FOR_REVIEW =
  'Your account needs a Nigerian mobile number to open a naira wallet.';
/**
 * The one answer for a BVN (or phone) another account holds, whether that
 * account has a wallet or its opening is still being checked: it says
 * neither, and gives a way forward (NUV-02 round 2, no existence oracle).
 * `identity_has_wallet` is its stable code.
 */
export const OPENING_HELD_MESSAGE =
  "We can't use this BVN or phone number for a new wallet. If it's yours, contact support.";
export const CHECK_HANDLE_UNDER_REVIEW =
  'Send bvn and nin with your details: this wallet is opened without a separate BVN check.';

/** Why an opening failed or was held, in our own words. */
const ENTITY_HELD = 'entity_held_by_another_account';

/** NuvionEntity's columns the review is read from. */
const ENTITY_SELECT = {
  wawuUserId: true,
  entityId: true,
  status: true,
  decidedAt: true,
  correctedAt: true,
  entityUpdatedAt: true,
  bvnStatus: true,
  ninStatus: true,
  documentStatus: true,
  addressProofStatus: true,
  rejectionReasons: true,
} as const;

type EntityRow = ReviewRecord & {
  wawuUserId: string;
  entityId: string | null;
  entityUpdatedAt: Date | null;
};

/** The moment before a create goes out found the claim no longer ours. */
class ClaimMoved extends Error {}

function isUniqueViolation(
  e: unknown,
): e is { code: 'P2002'; meta?: unknown; message?: string } {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Opening a wallet with a provider that reviews the person itself
 * (`capabilities.separateKyc`: Nuvion), task NUV-02. The opening service
 * (wallet-opening.service.ts) hands every such opening here; Fintava's path
 * is untouched.
 *
 * There is no BVN check before it (Nuvion has no BVN lookup: KYC-01's route
 * answers 503 under nuvion) and no selfie match (NUV-03's hosted selfie, if
 * any, comes with the documents). `POST /money/wallet/open` takes the
 * details, the BVN and the NIN together, and the provider's customer (a
 * Nuvion entity) is made once:
 *
 * - **The claim.** The same FintavaWalletOpening row as MONEY-12's, stamped
 *   `nuvion`: claimed before anything is sent (a new row, or a `failed` one
 *   by a conditional update on its attempt), checked again just before the
 *   one call, so double taps and other servers send nothing. Its keyed BVN
 *   hash and the account's phone are unique, and the BVN is held by the
 *   account only while its opening is with Nuvion or approved
 *   (`bvn-claim.ts`): another account with that BVN or phone gets one plain
 *   `409 identity_has_wallet` that says neither "wallet" nor "check in
 *   progress", counted against the day's tries (`opening-attempts.ts`). A
 *   rejected, failed or stopped opening lets go of its BVN at once. The
 *   claim follows what Nuvion was told: a correction moves it only in the
 *   step that sends the new number. Under nuvion `bvnVerifiedAt` is when the
 *   BVN was taken for Nuvion's review.
 * - **A lost answer** leaves the row `unknown`; nothing is sent again
 *   blindly. The entity is recorded when Nuvion's `entities.created` or
 *   `entities.updated` delivery names it (the opening handler adopts it by
 *   the phone and the time), and the sweep then settles the row. Once the
 *   money timeout plus the resend safety has passed, the person's next
 *   request (which brings the details again) may try once more, and that
 *   try first looks for the entity at Nuvion and makes one only when Nuvion
 *   proves there is none (src/nuvion/areas/opening.ts).
 * - **The record.** NuvionEntity holds the entity, its person, Nuvion's
 *   review word and each check's word. The opening row follows the stage
 *   (`review-stage.ts`): `review` (documents needed, or refused: the wallet
 *   gate answers `wallet_not_open`), `open` (being checked, or approved
 *   with the account number on its way: `wallet_opening`), `stopped`
 *   (failed or suspended: `wallet_not_open`).
 * - **A refusal** (`rejected`): GET /money/wallet says why and what to fix,
 *   and the person may send corrected details, which correct the same
 *   entity (`PATCH`); the review then starts again from the documents.
 *
 * Never stored or logged: the BVN, the NIN, the ID number, the name, the
 * date of birth, the address. Stored: the keyed BVN hash and the phone (the
 * claim), Nuvion's ids and words.
 */
export class ReviewedOpening {
  private readonly logger = new Logger('WalletOpeningService');

  /** Today's tries that name a BVN or NIN (BVN_CHECKS_PER_DAY). */
  private readonly attempts: OpeningAttempts;

  constructor(private readonly host: ReviewedOpeningHost) {
    this.attempts = new OpeningAttempts(host.prisma, host.hasher.checksPerDay);
  }

  private get prisma(): PrismaService {
    return this.host.prisma;
  }

  /**
   * The review GET /money/wallet tells: null when nothing was sent yet. The
   * person's opening row (state and failure) is the caller's, already read.
   */
  async reviewOf(
    wawuUserId: string,
    opening: { state: string; failure: string | null } | null,
  ): Promise<WalletReviewView | null> {
    const entity = await this.entity(wawuUserId);
    if (!entity?.entityId) return null;
    // Stopped because the BVN is now another account's: told as the stop
    // it is (contact support), whatever Nuvion's word says.
    if (opening?.state === 'stopped' && opening.failure === CLAIM_LOST) {
      return reviewViewOf({ ...entity, status: 'suspended' });
    }
    return reviewViewOf(entity);
  }

  // -------------------------------------------------------------------------
  // POST /money/wallet/open
  // -------------------------------------------------------------------------

  /** Answers nothing: the caller answers the wallet view afterwards. */
  async open(
    wawuUserId: string,
    claims: {
      email: string | null | undefined;
      phone: string | null | undefined;
    },
    input: OpenNairaWalletDto,
  ): Promise<void> {
    const host = this.host;
    if (!host.hasher.configured || !host.provider.configured) {
      throw host.unavailable();
    }
    if (await host.hasWallet(wawuUserId)) return;
    const details = this.details(input);
    const mail = (claims.email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      throw new MoneyError('account_not_opened', EMAIL_NEEDED_FOR_REVIEW);
    }
    const local = toLocalNigerianPhone(claims.phone ?? '');
    if (local === null) {
      throw new MoneyError('phone_not_nigerian', PHONE_NOT_NIGERIAN_FOR_REVIEW);
    }
    const phone = `+234${local.slice(1)}`;
    const send = {
      bvn: input.bvn!,
      nin: input.nin!,
      email: mail,
      phone,
      details,
      input,
    };

    let row = await host.opening(wawuUserId);
    if (
      row &&
      row.state !== 'failed' &&
      !isRowOf(host.provider.name, row.provider)
    ) {
      return;
    }
    if (row) row = await host.unstick(row, await host.dbNow());
    if (row) {
      switch (row.state) {
        case 'review': {
          const entity = await this.entity(wawuUserId);
          if (entity?.entityId && reviewStageOf(entity) === 'rejected') {
            await this.correct(row, entity, send);
          }
          return;
        }
        case 'unknown': {
          if (await this.settleFromRecord(row)) return;
          const now = await host.dbNow();
          if (
            now.getTime() - row.attemptStartedAt.getTime() <
            host.resendAfterMs()
          ) {
            return;
          }
          await this.attempts.assertLeft(wawuUserId);
          const attempt = await this.claim(wawuUserId, row, 'unknown', send);
          if (attempt === null) return;
          await this.attempts.spend(wawuUserId, false);
          await this.create(wawuUserId, attempt, send, row.attemptStartedAt);
          return;
        }
        case 'failed': {
          if (await this.settleFromRecord(row)) return;
          await this.attempts.assertLeft(wawuUserId);
          const attempt = await this.claim(wawuUserId, row, 'failed', send);
          if (attempt === null) return;
          await this.attempts.spend(wawuUserId, false);
          await this.create(wawuUserId, attempt, send, null);
          return;
        }
        default:
          // opening (in flight), open, stopped, conflict: nothing to send.
          return;
      }
    }
    await this.attempts.assertLeft(wawuUserId);
    const attempt = await this.claim(wawuUserId, null, 'new', send);
    if (attempt === null) return;
    await this.attempts.spend(wawuUserId, false);
    await this.create(wawuUserId, attempt, send, null);
  }

  // -------------------------------------------------------------------------
  // The sweep: an opening whose answer was lost
  // -------------------------------------------------------------------------

  /**
   * One `unknown` opening: settled from NuvionEntity once Nuvion's delivery
   * named the entity (`open`), else `wait`. It never sends a create: the
   * details are not kept, and a create after a lost one is only ever the
   * person's own next request.
   */
  async reconcile(
    row: ReviewedOpeningRow,
  ): Promise<'open' | 'wait' | 'nothing_to_do'> {
    if (row.state !== 'unknown') return 'nothing_to_do';
    const now = await this.host.dbNow();
    const asking = await this.prisma.fintavaWalletOpening.updateMany({
      where: {
        wawuUserId: row.wawuUserId,
        attempts: row.attempts,
        state: 'unknown',
        OR: [
          { checkedAt: null },
          {
            checkedAt: {
              lt: new Date(now.getTime() - this.host.recheckAfterMs),
            },
          },
        ],
      },
      data: { checkedAt: now },
    });
    if (asking.count !== 1) return 'nothing_to_do';
    // The seam's phone lookup first, as for every provider; Nuvion keeps
    // none and answers "cannot tell", so the record below decides.
    try {
      await this.host.provider.findCustomerByPhone(row.phone, (bvn) =>
        this.host.hasher.hash('bvn', bvn),
      );
    } catch {
      // A failed lookup tells nothing either way.
    }
    return (await this.settleFromRecord(row)) ? 'open' : 'wait';
  }

  // -------------------------------------------------------------------------

  private entity(wawuUserId: string): Promise<EntityRow | null> {
    return this.prisma.nuvionEntity.findUnique({
      where: { wawuUserId },
      select: ENTITY_SELECT,
    });
  }

  /**
   * An `unknown` or `failed` opening whose entity is recorded (a delivery
   * named it): the row takes the review's stage. True when it did.
   */
  private async settleFromRecord(row: ReviewedOpeningRow): Promise<boolean> {
    const entity = await this.entity(row.wawuUserId);
    if (!entity?.entityId) return false;
    const stage = reviewStageOf(entity);
    const moved = await this.prisma.fintavaWalletOpening.updateMany({
      where: {
        wawuUserId: row.wawuUserId,
        attempts: row.attempts,
        state: { in: ['unknown', 'failed', 'opening'] },
      },
      data: {
        state: openingStateForStage(stage),
        failure: null,
      },
    });
    if (moved.count === 1) {
      await alignClaim(this.prisma, row.wawuUserId, stage);
      this.logger.log(
        'wallet opening (review): a lost answer was found at the provider',
      );
    }
    return true;
  }

  /**
   * The fields this opening needs beyond MONEY-12's (a plain 400 naming
   * the first one missing, as the ValidationPipe answers a malformed field).
   */
  private details(
    input: OpenNairaWalletDto,
  ): Omit<
    ProviderReviewDetails,
    'customerId' | 'numbersAgain' | 'lostAttemptAt'
  > {
    if (input.checkHandle !== undefined) {
      throw new BadRequestException(CHECK_HANDLE_UNDER_REVIEW);
    }
    for (const field of REVIEW_REQUIRED_FIELDS) {
      // A null is a missing field (the DTO turns it into one; a caller that
      // skips the pipe is held to the same rule).
      if (input[field] === undefined || input[field] === null) {
        throw new BadRequestException(
          `${field} is required to open this wallet`,
        );
      }
    }
    return {
      middleName: input.middleName ?? null,
      gender: input.gender!,
      nationality: 'NG',
      address: {
        line1: input.address,
        line2: input.addressLine2 ?? null,
        city: input.city!,
        state: input.state!,
        postalCode: input.postalCode!,
        countryCode: 'NG',
      },
      idDocument: {
        type: input.idType!,
        number: input.idNumber!,
        issueDate: input.idIssueDate ?? null,
        expiryDate: input.idExpiryDate ?? null,
        issuingCountry: 'NG',
      },
      proofOfAddressType: input.proofOfAddressType!,
    };
  }

  /**
   * Takes the person's opening for a new attempt: a new row, or a `failed`
   * or (past the resend window) `unknown` one, by a conditional update on
   * the attempt it was read with. The attempt number, or null when another
   * request holds it.
   *
   * The claim on the BVN is taken here for a new or `failed` opening (the
   * number about to be sent). A lost answer (`unknown`) keeps the claim it
   * has: the earlier create may have reached Nuvion with that number, so the
   * claim moves to the typed one only just before a create goes out
   * (`moveClaim`, after the look for the earlier one found nothing).
   *
   * A BVN or phone another account holds is the one plain answer
   * (`heldByAnother`), counted as a try.
   */
  private async claim(
    wawuUserId: string,
    row: ReviewedOpeningRow | null,
    from: 'new' | 'failed' | 'unknown',
    send: { bvn: string; phone: string },
  ): Promise<number | null> {
    const startedAt = await this.host.dbNow();
    const bvnHash = this.host.hasher.hash('bvn', send.bvn);
    try {
      if (row === null) {
        await this.prisma.fintavaWalletOpening.create({
          data: {
            wawuUserId,
            state: 'opening',
            attempts: 1,
            attemptStartedAt: startedAt,
            provider: this.host.provider.name,
            bvnHash,
            bvnVerifiedAt: startedAt,
            phone: send.phone,
          },
        });
        return 1;
      }
      const next = row.attempts + 1;
      const taken = await this.prisma.fintavaWalletOpening.updateMany({
        where: {
          wawuUserId,
          state: from,
          attempts: row.attempts,
          ...(from === 'unknown'
            ? { attemptStartedAt: row.attemptStartedAt }
            : {}),
        },
        data: {
          // A lost answer keeps its claim until a create really goes out.
          ...(from === 'unknown' ? {} : { bvnHash }),
          bvnVerifiedAt: startedAt,
          phone: send.phone,
          state: 'opening',
          attempts: next,
          attemptStartedAt: startedAt,
          failure: from === 'unknown' ? 'looking_first' : null,
          checkedAt: null,
          provider: this.host.provider.name,
        },
      });
      return taken.count === 1 ? next : null;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      if (
        !/bvnHash|phone/.test(
          JSON.stringify(e.meta ?? null) + (e.message ?? ''),
        )
      ) {
        return null;
      }
      // A concurrent request of this same account may have taken its own
      // row first (the unique index can name either key): that is not
      // another account's hold.
      if (row === null && (await this.host.opening(wawuUserId)) !== null) {
        return null;
      }
      return this.heldByAnother(wawuUserId);
    }
  }

  /**
   * The BVN (or phone) is another account's: one plain `409
   * identity_has_wallet`, the same whether that account has a wallet or its
   * opening is being checked, and the try is spent first (a burst of probes
   * at once learns the answer at most `BVN_CHECKS_PER_DAY` times; past it
   * the answer is the 429).
   */
  private async heldByAnother(wawuUserId: string): Promise<never> {
    await this.attempts.spend(wawuUserId, true);
    throw new MoneyError('identity_has_wallet', OPENING_HELD_MESSAGE);
  }

  /**
   * A lost answer being sent again, the look for the earlier create found
   * nothing, and a create is about to go out: the claim moves to the BVN
   * that create names. Another account holding it is the plain answer and
   * nothing is sent.
   */
  private async moveClaim(
    wawuUserId: string,
    attempt: number,
    bvn: string,
  ): Promise<void> {
    let moved;
    try {
      moved = await this.prisma.fintavaWalletOpening.updateMany({
        where: { wawuUserId, attempts: attempt, state: 'opening' },
        data: { bvnHash: this.host.hasher.hash('bvn', bvn) },
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // This request's try is already spent (it won the claim); the number
      // is another account's, so nothing goes out.
      throw new MoneyError('identity_has_wallet', OPENING_HELD_MESSAGE);
    }
    if (moved.count !== 1) throw new ClaimMoved();
  }

  /** The one call that makes the entity (or finds the one a lost call made). */
  private async create(
    wawuUserId: string,
    attempt: number,
    send: {
      bvn: string;
      nin: string;
      email: string;
      phone: string;
      details: Omit<
        ProviderReviewDetails,
        'customerId' | 'numbersAgain' | 'lostAttemptAt' | 'beforeCreate'
      >;
      input: OpenNairaWalletDto;
    },
    lostAttemptAt: Date | null,
  ): Promise<void> {
    const prisma = this.prisma;
    // Last look at the claim before the call that cannot be taken back.
    const sentAt = await this.host.dbNow();
    const still = await prisma.fintavaWalletOpening.updateMany({
      where: { wawuUserId, attempts: attempt, state: 'opening' },
      data: { attemptStartedAt: sentAt },
    });
    if (still.count !== 1) return;

    let opened;
    try {
      opened = await this.host.provider.openWallet({
        firstName: send.input.firstName,
        lastName: send.input.lastName,
        phone: send.phone,
        email: send.email,
        address: send.input.address,
        dateOfBirth: send.input.dateOfBirth,
        bvn: send.bvn,
        nin: send.nin,
        review: {
          ...send.details,
          customerId: null,
          numbersAgain: true,
          lostAttemptAt,
          // After a lost answer the claim still names the earlier number:
          // it moves to this one only if a create really goes out.
          ...(lostAttemptAt === null
            ? {}
            : {
                beforeCreate: () =>
                  this.moveClaim(wawuUserId, attempt, send.bvn),
              }),
        },
      });
    } catch (e) {
      if (e instanceof ClaimMoved) return;
      if (e instanceof WalletProviderError && e.kind === 'under_review') {
        await this.lost(wawuUserId, attempt);
        throw new MoneyError('identity_under_review', UNDER_REVIEW_MESSAGE);
      }
      if (!(e instanceof WalletProviderError) || this.host.mayHaveOpened(e)) {
        await this.lost(wawuUserId, attempt);
        if (!(e instanceof WalletProviderError)) throw e;
        return;
      }
      const refused = await prisma.fintavaWalletOpening.updateMany({
        where: { wawuUserId, attempts: attempt, state: 'opening' },
        data: { state: 'failed', failure: `refused_${e.kind}` },
      });
      // Nuvion made nothing: the BVN is let go at once.
      if (refused.count === 1) await alignClaim(prisma, wawuUserId, 'stopped');
      throw this.host.refusal(e);
    }
    if (opened.state !== 'provisioning' || !opened.review) {
      // A reviewing provider answers the customer and its review; anything
      // else cannot be recorded, so it is reconciled like a lost answer.
      this.logger.error(
        'wallet opening (review): the provider answered without its review; reconciled as a lost answer',
      );
      await this.lost(wawuUserId, attempt);
      return;
    }
    await this.record(wawuUserId, attempt, opened.customerId, opened.review);
  }

  /**
   * Records the entity and its review, and moves the opening to the stage,
   * if it is still on this attempt. An entity id another person's row
   * already holds is never taken over: the opening is held for review.
   */
  private async record(
    wawuUserId: string,
    attempt: number,
    entityId: string,
    review: ProviderReviewState,
  ): Promise<void> {
    const now = await this.host.dbNow();
    const fields = {
      personId: review.personId,
      status: review.status,
      bvnStatus: review.bvnStatus,
      ninStatus: review.ninStatus,
      documentStatus: review.documentStatus,
      addressProofStatus: review.addressProofStatus,
      identificationStatus: review.identificationStatus,
      rejectionReasons: review.reasons,
      reviewReadAt: now,
      ...(review.updated !== null
        ? { entityUpdatedAt: new Date(review.updated) }
        : {}),
    };
    let stage;
    try {
      stage = await this.prisma.$transaction(async (tx) => {
        const mine = await tx.nuvionEntity.findUnique({
          where: { wawuUserId },
          select: {
            entityId: true,
            decidedAt: true,
            status: true,
            correctedAt: true,
            entityUpdatedAt: true,
          },
        });
        if (mine?.entityId && mine.entityId !== entityId) {
          throw new HeldEntity();
        }
        // A delivery may have recorded it first: its decision time stays.
        const decided = isNewDecision(mine, review)
          ? { decidedAt: now }
          : mine?.decidedAt
            ? { decidedAt: mine.decidedAt }
            : {};
        await tx.nuvionEntity.upsert({
          where: { wawuUserId },
          create: { wawuUserId, entityId, ...fields, ...decided },
          update: { entityId, ...fields, ...decided },
        });
        const stage = reviewStageOf({
          status: review.status,
          decidedAt: now,
          correctedAt: null,
          bvnStatus: review.bvnStatus,
          ninStatus: review.ninStatus,
          documentStatus: review.documentStatus,
          addressProofStatus: review.addressProofStatus,
          rejectionReasons: review.reasons,
        });
        await tx.fintavaWalletOpening.updateMany({
          where: {
            wawuUserId,
            attempts: attempt,
            state: { in: ['opening', 'unknown'] },
          },
          data: { state: openingStateForStage(stage), failure: null },
        });
        return stage;
      });
      await alignClaim(this.prisma, wawuUserId, stage);
      this.logger.log(
        review.found
          ? 'wallet opening (review): the entity a lost answer made was found and recorded'
          : 'wallet opening (review): entity made and recorded',
      );
    } catch (e) {
      if (e instanceof HeldEntity || isUniqueViolation(e)) {
        await this.prisma.fintavaWalletOpening.updateMany({
          where: {
            wawuUserId,
            attempts: attempt,
            state: { in: ['opening', 'unknown'] },
          },
          data: { state: 'conflict', failure: ENTITY_HELD },
        });
        this.logger.error(
          'wallet opening (review): the entity the provider answered is recorded for someone else; held for review',
        );
        return;
      }
      // The entity exists and could not be written: reconciled from the
      // provider's delivery, never made again.
      await this.lost(wawuUserId, attempt);
      throw e;
    }
  }

  /**
   * After a refusal: corrected details correct the same entity. The opening
   * is claimed for it (`review` to `opening`), and goes back to `review`
   * whatever happens: a correction sent twice is the same correction.
   *
   * The claim on the BVN follows what Nuvion is told (D4). When the review
   * named the BVN or the NIN, both go again and the claim moves to the BVN
   * typed, in this step; when it named something else, no number goes and the
   * claim takes back the BVN Nuvion already has (the number typed is not
   * used). Either way another account holding the number is the plain answer
   * and nothing is sent.
   */
  private async correct(
    row: ReviewedOpeningRow,
    entity: EntityRow,
    send: {
      bvn: string;
      nin: string;
      email: string;
      phone: string;
      details: Omit<
        ProviderReviewDetails,
        'customerId' | 'numbersAgain' | 'lostAttemptAt' | 'beforeCreate'
      >;
      input: OpenNairaWalletDto;
    },
  ): Promise<void> {
    const prisma = this.prisma;
    await this.attempts.assertLeft(row.wawuUserId);
    const next = row.attempts + 1;
    const startedAt = await this.host.dbNow();
    // Nuvion may answer this correction with the documents' checks back at
    // `pending`, and the answer's words replace the stored ones below. A
    // document its review refused is kept on the document's own row first,
    // so the person is still asked for a new file (NUV-03 round 2, D1).
    await noteDocumentRefusals(prisma, row.wawuUserId, entity, startedAt);
    const numbersAgain = numbersFailed(entity);
    const claimHash = numbersAgain
      ? this.host.hasher.hash('bvn', send.bvn)
      : heldBvnHash(row.wawuUserId, row.bvnHash);
    let claimed;
    try {
      claimed = await prisma.fintavaWalletOpening.updateMany({
        where: {
          wawuUserId: row.wawuUserId,
          attempts: row.attempts,
          state: 'review',
        },
        data: {
          state: 'opening',
          attempts: next,
          attemptStartedAt: startedAt,
          failure: 'correcting',
          bvnHash: claimHash,
          phone: send.phone,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) return this.heldByAnother(row.wawuUserId);
      throw e;
    }
    if (claimed.count !== 1) return;
    await this.attempts.spend(row.wawuUserId, false);
    const back = (
      state: 'review' | 'open' | 'stopped',
      extra: { bvnHash?: string; phone?: string } = {},
    ) =>
      prisma.fintavaWalletOpening.updateMany({
        where: { wawuUserId: row.wawuUserId, attempts: next, state: 'opening' },
        data: { state, failure: null, ...extra },
      });

    let opened;
    try {
      opened = await this.host.provider.openWallet({
        firstName: send.input.firstName,
        lastName: send.input.lastName,
        phone: send.phone,
        email: send.email,
        address: send.input.address,
        dateOfBirth: send.input.dateOfBirth,
        bvn: send.bvn,
        nin: send.nin,
        review: {
          ...send.details,
          customerId: entity.entityId,
          numbersAgain,
          lostAttemptAt: null,
        },
      });
    } catch (e) {
      // Nothing is known to have changed: the claim's BVN and phone go back.
      await back('review', { bvnHash: row.bvnHash, phone: row.phone });
      if (e instanceof WalletProviderError && e.kind === 'under_review') {
        throw new MoneyError('identity_under_review', UNDER_REVIEW_MESSAGE);
      }
      if (!(e instanceof WalletProviderError)) throw e;
      // A correction whose answer was lost is the same correction when sent
      // again: the person may simply send it again.
      if (this.host.mayHaveOpened(e)) return;
      throw this.host.refusal(e);
    }
    const review =
      opened.state === 'provisioning' ? (opened.review ?? null) : null;
    const now = await this.host.dbNow();
    await prisma.nuvionEntity.updateMany({
      where: { wawuUserId: row.wawuUserId, entityId: entity.entityId },
      data: {
        correctedAt: now,
        reviewReadAt: now,
        // Nuvion's own time of this correction: a decision read later with a
        // time past it is a new decision, one without is the echo (D3).
        entityUpdatedAt:
          review?.updated != null ? new Date(review.updated) : null,
        ...(review
          ? {
              status: review.status,
              bvnStatus: review.bvnStatus,
              ninStatus: review.ninStatus,
              documentStatus: review.documentStatus,
              addressProofStatus: review.addressProofStatus,
              identificationStatus: review.identificationStatus,
            }
          : {}),
      },
    });
    const after = await this.entity(row.wawuUserId);
    const stage = after ? reviewStageOf(after) : 'needs_documents';
    await back(openingStateForStage(stage));
    await alignClaim(prisma, row.wawuUserId, stage);
    this.logger.log('wallet opening (review): corrected details sent');
  }

  /** The answer was lost: `unknown`, never sent again blindly. */
  private async lost(wawuUserId: string, attempt: number): Promise<void> {
    await this.prisma.fintavaWalletOpening.updateMany({
      where: { wawuUserId, attempts: attempt, state: 'opening' },
      data: { state: 'unknown' },
    });
  }
}

class HeldEntity extends Error {}
