import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationService } from '../../notification/notification.service';
import { isRowOf, rowsOf } from '../../wallet-provider/provider-rows';
import {
  type ProviderCustomer,
  type ProviderCustomerMatch,
  type ProviderOpenedWallet,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import {
  WALLET_PROVIDER_UNKNOWN_OUTCOMES,
  WalletProviderError,
  type WalletProviderErrorKind,
} from '../../wallet-provider/wallet-provider-error';
import { IdentityHasher } from '../identity/identity-config';
import { SelfieMatchService } from '../identity/selfie-match.service';
import {
  type CheckedIdentity,
  WalletIdentityService,
} from '../identity/wallet-identity.service';
import { walletStateOf } from '../gate/wallet-gate';
import { MoneyError } from '../money-error';
import type { WalletState, WalletView } from '../money-view.type';
import { TransactionPinService } from '../pin/transaction-pin.service';
import type { OpenNairaWalletDto } from './dto/open-wallet.dto';
import { visibleBeneficiaries } from '../saved-accounts/beneficiary.service';
import { type IdentityStop, stoppedOnIdentity } from './opening-stops';
import { ReviewedOpening } from './reviewed-opening';
import { accountOnItsWay } from './review-stage';
import {
  WALLET_OPENING_DEFAULTS,
  WalletOpeningSettings,
} from './wallet-opening-config';

export const SELFIE_REQUIRED_MESSAGE = 'Take your selfie first.';
export const IDENTITY_HAS_WALLET_MESSAGE =
  'This BVN or phone number already has a wallet on another account.';
export const ACCOUNT_NOT_OPENED_MESSAGE =
  'We could not open your account with these details. Check them and try again.';
export const EMAIL_NEEDED_MESSAGE =
  'Add an email address to your account, then try again.';
export const OPENING_UNAVAILABLE_MESSAGE =
  'We could not open your account right now. Try again in a moment.';
export const PHONE_HELD_MESSAGE =
  'This phone number is already linked to an account we could not match to your BVN, so we have not opened your wallet. Contact support.';

/** FintavaWalletOpening.state (schema.prisma). */
export type OpeningState =
  'opening' | 'unknown' | 'failed' | 'open' | 'conflict';

/** What Fintava said about a lost create, once asked. */
export type OpeningReconciliation =
  'open' | 'conflict' | 'absent' | 'wait' | 'nothing_to_do';

type OpeningRow = {
  wawuUserId: string;
  state: string;
  bvnHash: string;
  phone: string;
  attempts: number;
  attemptStartedAt: Date;
  checkedAt: Date | null;
  failure: string | null;
  /** Which provider the opening is with (NUV-01); null is Fintava. */
  provider?: string | null;
};

const OPENING_SELECT = {
  wawuUserId: true,
  state: true,
  bvnHash: true,
  phone: true,
  attempts: true,
  attemptStartedAt: true,
  checkedAt: true,
  failure: true,
  provider: true,
} as const;

/** A refusal whose words say the record exists: never read as "nothing was made". */
const SAYS_IT_EXISTS = /exist|duplicate|already/i;

/** Kinds after which Fintava's answer is about the details sent (A5's or the address). */
const ABOUT_THE_DETAILS: readonly WalletProviderErrorKind[] = [
  'validation',
  'identity_refused',
];

class LostClaim extends Error {}

type UniqueViolation = { code: 'P2002'; meta?: unknown; message?: string };

/** Prisma's unique-constraint refusal (P2002). */
function isUniqueViolation(e: unknown): e is UniqueViolation {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: unknown }).code === 'P2002'
  );
}

/** Which unique key a P2002 hit, in whatever words Prisma gave. */
function uniqueTarget(e: UniqueViolation): string {
  return `${JSON.stringify(e.meta ?? null)} ${e.message ?? ''}`;
}

/**
 * Opening a person's account at Fintava (task MONEY-12, A7, A8) once Open
 * your wallet's identity steps have passed (KYC-01 BVN and NIN, KYC-02
 * selfie), and the wallet as WAWU records it (GET /money/wallet).
 *
 * One person, one Fintava account. Fintava's `POST /create/customer` refuses
 * neither a repeated call nor a repeated BVN (mobile repo
 * `docs/fintava/sandbox/07-create-customer.md`), so the guarantee is ours:
 *
 * - **The claim.** A create is sent only by the request that claimed the
 *   person's FintavaWalletOpening row (its primary key is the person): a
 *   new row, or a `failed` one moved to `opening` by a conditional update
 *   on its attempt number. Double taps, parallel requests and other
 *   servers find the row taken and answer "still opening"; they never send.
 *   Just before the create goes out, the claim is checked once more
 *   (`opening`, same attempt), and a request that lost it sends nothing.
 * - **One BVN, one phone.** The row's BVN hash and phone are unique, so a
 *   second WAWU account cannot open a second Fintava account for the same
 *   person (`409 identity_has_wallet`).
 * - **Ask first.** Before a create, Fintava is asked whether it already has
 *   a customer for the phone (`/customers/details`). It is the person's,
 *   and recorded instead of making a second, only when Fintava's record
 *   carries the person's BVN: the keyed hash of its `userInfo.bvn` equals
 *   the opening's `bvnHash` (and no other WAWU account holds it). A phone's
 *   customer whose BVN differs, or whose record carries none, is never
 *   adopted and nothing is created: the opening stops as `conflict` for
 *   review (`IDENTITY_STOPS`) and the person is answered
 *   `409 phone_held_by_other_identity`. A recycled number, a SIM swap or a
 *   customer made elsewhere must never hand a stranger's account over.
 * - **A lost answer is reconciled, never resent blindly.** A timeout, a 5xx,
 *   a 2xx we cannot read, or a refusal saying the customer exists, leaves
 *   the row `unknown` (A7's "still opening"). It is settled by asking
 *   Fintava (here on the next request, and by the sweep every 30 seconds):
 *   found by phone (the details lookup, or the customer list: read to its
 *   end, or, when longer than we read, trusted only if every row read was
 *   newest first back past the attempt) AND carrying the person's BVN is
 *   recorded as the person's account; one that does not carry it stops the
 *   opening for review, as above. It is "not created" only when the details lookup gives Fintava's own
 *   `404 ["Customer not found"]` AND the list has no row for the phone AND
 *   the money timeout plus `FINTAVA_RESEND_SAFETY_MS` has passed since the
 *   create was sent (Fintava keeps working after we stop waiting). Anything
 *   else, waits. Only then may a new attempt start, with the details sent
 *   again: none of them is kept.
 * - **One clock.** Every time an opening is stamped with or compared
 *   against (the attempt, the recheck, a stuck request, the resend window)
 *   is the database's `now()`, never a server's own clock, so a server
 *   whose clock runs fast or slow cannot call a create in flight absent.
 *
 * Identity is read once (KYC-02 round 2, finding 3):
 * `WalletIdentityService.checkedIdentity` compares the BVN and the NIN with
 * the passed check and returns that check; the selfie must have matched
 * against exactly that check (`SelfieMatchService.matchedFor`, its time and
 * keyed hash), and the opening records the check it was claimed under.
 *
 * Never stored or logged: the BVN, the NIN, the name, the date of birth,
 * the address (the MONEY-06 client logs no body), nor the BVN or date of
 * birth on Fintava's record (the client hands that BVN only to the keyed
 * hash, in memory). Stored: the keyed BVN
 * hash and the proved phone (to find a lost answer), and the three ids and
 * account name Fintava answered with (FintavaWallet).
 *
 * MONEY-20: every call goes through the wallet provider seam
 * (`WALLET_PROVIDER`: `findCustomerByPhone`, `getCustomerMatch`,
 * `listCustomerSightings`, `openWallet`), never a provider's client. A
 * provider that issues the account number later answers `provisioning`,
 * which is left `unknown` and found again by phone, never created twice.
 */
@Injectable()
export class WalletOpeningService {
  private readonly logger = new Logger(WalletOpeningService.name);
  private sweeping = false;
  /**
   * Opening with a provider that reviews the person itself (NUV-02:
   * `capabilities.separateKyc`, Nuvion): reviewed-opening.ts. Fintava's
   * path below is unchanged.
   */
  private readonly reviewed: ReviewedOpening;
  private expiring = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly hasher: IdentityHasher,
    private readonly identity: WalletIdentityService,
    private readonly selfie: SelfieMatchService,
    private readonly pins: TransactionPinService,
    private readonly settings: WalletOpeningSettings,
    // NUV-02 round 3: tells a person whose opening expired (kind
    // `identity_review`). Absent in a module without notifications.
    @Optional() private readonly notifications?: NotificationService,
  ) {
    this.reviewed = new ReviewedOpening({
      prisma,
      provider,
      hasher,
      dbNow: () => this.dbNow(),
      opening: (id) => this.opening(id),
      unstick: (row, now) => this.unstick(row, now),
      hasWallet: (id) => this.hasWallet(id),
      mayHaveOpened: (e) => this.mayHaveOpened(e),
      refusal: (e) => this.refusal(e),
      unavailable: () => this.unavailable(),
      resendAfterMs: () => this.resendAfterMs(),
      recheckAfterMs: WALLET_OPENING_DEFAULTS.recheckAfterMs,
    });
  }

  /** True when the running provider reviews the person itself (Nuvion). */
  private get reviewing(): boolean {
    return this.provider.capabilities.separateKyc;
  }

  // -------------------------------------------------------------------------
  // GET /money/wallet
  // -------------------------------------------------------------------------

  /**
   * The wallet as WAWU records it. Never calls the provider.
   *
   * NUV-04, under Nuvion: the wallet row is written only once Nuvion makes
   * the account number `active` (src/nuvion/handlers/accounts.ts), so
   * `account` is never a pending number; until then `accountNumberStatus`
   * says it is on its way. The bank a Nuvion wallet's number is at is the
   * one Nuvion named for that account (its account details' issuer,
   * recorded on NuvionEntity; BACKEND_GAPS G-401), and the running
   * provider's configured bank name (`NUVION_WALLET_BANK_NAME`) only when
   * Nuvion named none.
   */
  async view(
    wawuUserId: string,
    address: string | null = null,
  ): Promise<WalletView> {
    const [wallet, opening, pin, nuvion] = await Promise.all([
      this.prisma.fintavaWallet.findUnique({
        where: { wawuUserId },
        select: {
          accountNumber: true,
          accountName: true,
          createdAt: true,
          provider: true,
        },
      }),
      this.prisma.fintavaWalletOpening.findUnique({
        where: { wawuUserId },
        select: { state: true, failure: true },
      }),
      this.pins.state(wawuUserId),
      this.prisma.nuvionEntity.findUnique({
        where: { wawuUserId },
        select: {
          status: true,
          accountId: true,
          accountRequestedAt: true,
          accountNumber: true,
          issuerBankName: true,
          issuerBankCode: true,
        },
      }),
    ]);
    // The wallet gate's own rule (MONEY-13), so this state and the code
    // every other wallet route refuses with always agree.
    const state: WalletState = walletStateOf(wallet !== null, opening);
    // The issuer Nuvion named for this wallet's own number (NUV-04).
    const issuer =
      wallet &&
      isRowOf('nuvion', wallet.provider) &&
      nuvion?.accountNumber === wallet.accountNumber
        ? nuvion
        : null;
    // NUV-02, under a provider that reviews the person: the number is on its
    // way only once the account is requested after an approval. A person who
    // is only being checked, rejected, or stopped (also for a BVN another
    // account took) is told `none`; `opening` there is the review, not the
    // account.
    const review = this.reviewing
      ? await this.reviewed.reviewOf(wawuUserId, opening, address)
      : undefined;
    const onItsWay = this.reviewing
      ? accountOnItsWay(review?.stage ?? null, nuvion)
      : state === 'opening' ||
        nuvion?.status === 'approved' ||
        (nuvion?.accountId ?? null) !== null;
    return {
      state,
      account: wallet
        ? {
            accountNumber: wallet.accountNumber,
            accountName: wallet.accountName ?? '',
            bankName: issuer?.issuerBankName ?? this.settings.bankName,
            bankCode: issuer?.issuerBankCode ?? this.provider.walletBankCode,
            licenceLine: this.settings.licenceLine,
            depositInsuranceLine: this.settings.depositInsuranceLine,
            openedAt: wallet.createdAt.toISOString(),
          }
        : null,
      // No limit figure is known yet (BACKEND_GAPS G-7): null hides the row.
      limits: null,
      pin,
      // W18 is not built (R-28): a wallet only exists after the BVN and
      // selfie checks, so nothing blocks a bank send for its owner.
      bankTransfers: { allowed: wallet !== null, blockedBy: null },
      // The rows GET /money/beneficiaries shows (WALLET-14); none without a wallet.
      beneficiaryCount: wallet
        ? (await visibleBeneficiaries(this.prisma, wawuUserId)).length
        : 0,
      accountNumberStatus: wallet ? 'active' : onItsWay ? 'on_its_way' : 'none',
      // NUV-02, additive and only under a provider that reviews the person
      // itself: the answer under Fintava is exactly MONEY-12's (an absent
      // `openingFlow` is `check`).
      ...(review !== undefined
        ? { openingFlow: 'review' as const, review }
        : {}),
    };
  }

  /** True while an opening is in flight or being reconciled (A7). */
  async isOpening(wawuUserId: string): Promise<boolean> {
    return (await this.view(wawuUserId)).state === 'opening';
  }

  // -------------------------------------------------------------------------
  // POST /money/wallet/open
  // -------------------------------------------------------------------------

  async open(
    wawuUserId: string,
    email: string | null | undefined,
    input: OpenNairaWalletDto,
    phone?: string | null,
    // The caller's address as the proxy gives it, null when there is none:
    // under a reviewing provider the tries are limited per address too.
    address: string | null = null,
  ): Promise<WalletView> {
    if (this.reviewing) {
      // NUV-02: the details, the BVN and the NIN go to the provider's own
      // review; no BVN check or selfie match comes before (reviewed-opening.ts).
      await this.reviewed.open(wawuUserId, { email, phone }, input, address);
      return this.view(wawuUserId, address);
    }
    if (!this.hasher.configured || !this.provider.configured) {
      throw this.unavailable();
    }
    if (await this.hasWallet(wawuUserId)) return this.view(wawuUserId);

    let row = await this.opening(wawuUserId);
    if (stoppedOnIdentity(row)) throw this.phoneHeld();
    // An opening with another provider (NUV-01: a rollback came between) is
    // left exactly as it is, unless it failed, when this one takes it over.
    if (
      row &&
      row.state !== 'failed' &&
      !isRowOf(this.provider.name, row.provider)
    ) {
      return this.view(wawuUserId);
    }
    if (row) row = await this.unstick(row, await this.dbNow());
    if (row && row.state !== 'failed') {
      if (row.state !== 'unknown') return this.view(wawuUserId);
      const settled = await this.reconcile(row);
      row = await this.opening(wawuUserId);
      if (stoppedOnIdentity(row)) throw this.phoneHeld();
      if (settled !== 'absent') return this.view(wawuUserId);
      if (!row || row.state !== 'failed') return this.view(wawuUserId);
    }

    // Identity, read once: the passed check whose BVN and NIN these are,
    // and the selfie that matched against exactly that check.
    // With a check handle (KYC-03) the BVN and NIN are the ones it seals,
    // for this caller and this passed check; otherwise the ones sent.
    const proven = await this.identity.proveIdentity(wawuUserId, input);
    const check = {
      verifiedAt: proven.verifiedAt,
      bvnHash: proven.bvnHash,
      verifiedPhone: proven.verifiedPhone,
    };
    if ((await this.selfie.matchedFor(wawuUserId, check)) === null) {
      throw new MoneyError('selfie_required', SELFIE_REQUIRED_MESSAGE);
    }
    const mail = (email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      throw new MoneyError('account_not_opened', EMAIL_NEEDED_MESSAGE);
    }

    const attempt = await this.claim(wawuUserId, check, row);
    if (attempt === null) return this.view(wawuUserId);

    // Fintava may already have this person's account (an earlier answer
    // that was lost before it was recorded, or a WAWU account deleted
    // since): that one is theirs, never a second. But only if its record
    // carries this person's BVN: the phone alone proves nothing.
    let existing: ProviderCustomerMatch | null = null;
    let answered = false;
    try {
      const lookup = await this.provider.findCustomerByPhone(
        check.verifiedPhone,
        this.bvnDigest,
      );
      if (lookup.state === 'found') existing = lookup;
      // `unknown` (a 2xx without a customer) is not "none": nothing is sent.
      answered = lookup.state !== 'unknown';
    } catch {
      answered = false;
    }
    if (!answered) {
      await this.fail(wawuUserId, attempt, 'lookup_unavailable');
      throw this.unavailable();
    }
    if (existing) {
      const stop = this.identityStop(existing, check.bvnHash);
      if (stop !== null) {
        await this.stopForReview(wawuUserId, attempt, stop, 'opening');
        throw this.phoneHeld();
      }
      const recorded = await this.record(
        wawuUserId,
        attempt,
        existing.customer,
      );
      if (recorded === 'conflict') {
        await this.fail(wawuUserId, attempt, 'held_by_another_account');
        throw new MoneyError(
          'identity_has_wallet',
          IDENTITY_HAS_WALLET_MESSAGE,
        );
      }
      return this.view(wawuUserId);
    }

    // Last look at the claim before the one call that cannot be taken back.
    const sentAt = await this.dbNow();
    const still = await this.prisma.fintavaWalletOpening.updateMany({
      where: { wawuUserId, attempts: attempt, state: 'opening' },
      data: { attemptStartedAt: sentAt },
    });
    if (still.count !== 1) return this.view(wawuUserId);

    let opened: ProviderOpenedWallet;
    try {
      opened = await this.provider.openWallet({
        firstName: input.firstName,
        lastName: input.lastName,
        phone: check.verifiedPhone,
        email: mail,
        address: input.address,
        dateOfBirth: input.dateOfBirth,
        bvn: proven.bvn,
        nin: proven.nin,
      });
    } catch (e) {
      if (!(e instanceof WalletProviderError) || this.mayHaveOpened(e)) {
        await this.lost(wawuUserId, attempt);
        if (!(e instanceof WalletProviderError)) throw e;
        return this.view(wawuUserId);
      }
      await this.fail(wawuUserId, attempt, `refused_${e.kind}`);
      throw this.refusal(e);
    }
    if (opened.state === 'provisioning') {
      // A provider that issues the account number later (Nuvion): the
      // customer exists but there is no account to record yet. Left
      // `unknown`, so it is found by phone and recorded once its account
      // is there, never created twice. Fintava always answers `open`.
      await this.lost(wawuUserId, attempt);
      return this.view(wawuUserId);
    }
    await this.record(wawuUserId, attempt, opened.customer);
    return this.view(wawuUserId);
  }

  // -------------------------------------------------------------------------
  // Holds that run out (NUV-02 round 3, N3), and support releasing one
  // -------------------------------------------------------------------------

  /**
   * Under a provider that reviews the person: an opening at "documents
   * needed", or refused only about documents or details, with no progress
   * from the person for IDENTITY_HOLD_DAYS is marked expired. Its BVN is let
   * go and the person is told once; nothing is sent to the provider. One pass
   * at a time per process, and across servers (an advisory lock and a
   * conditional update per opening). Where ScheduleModule.forRoot() is
   * loaded (AppModule); a spec calls it directly.
   */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'wallet-identity-hold-expiry' })
  async expireIdleHolds(): Promise<number> {
    if (!this.reviewing || this.expiring) return 0;
    this.expiring = true;
    try {
      const expired = await this.reviewed.expireIdle();
      for (const wawuUserId of expired) await this.tellExpired(wawuUserId);
      if (expired.length > 0) {
        this.logger.log(
          `wallet opening: ${expired.length} unfinished openings expired and let go of their BVN`,
        );
      }
      return expired.length;
    } catch (e) {
      // The name only; the next pass picks up whatever this one did not.
      this.logger.error(
        `wallet opening: the hold expiry pass failed (${(e as Error).name ?? 'Error'})`,
      );
      return 0;
    } finally {
      this.expiring = false;
    }
  }

  /**
   * Support lets go of one person's hold at once (the admin route): the
   * opening is marked expired and the person is told once. The BVN is never
   * read or returned. `before` is the opening's state before, for the audit.
   */
  async releaseIdentityHold(wawuUserId: string): Promise<{
    outcome:
      | 'released'
      | 'no_opening'
      | 'already_released'
      | 'not_held'
      | 'in_review'
      | 'has_wallet';
    before: string | null;
  }> {
    const done = await this.reviewed.releaseHold(wawuUserId);
    if (done.outcome === 'released') await this.tellExpired(wawuUserId);
    return done;
  }

  /** The one notification that an opening was closed (at most once: after the marking). */
  private async tellExpired(wawuUserId: string): Promise<void> {
    if (!this.notifications) return;
    try {
      await this.notifications.emit({
        kind: 'identity_review',
        userWawuId: wawuUserId,
        outcome: 'expired',
      });
    } catch {
      this.logger.warn(
        'wallet opening: the person was not told their opening closed',
      );
    }
  }

  // -------------------------------------------------------------------------
  // The sweep: lost answers, every 30 seconds
  // -------------------------------------------------------------------------

  /**
   * Reconciles openings whose answer was lost (`unknown`) and openings whose
   * request never finished (`opening` long past the money timeout). One pass
   * at a time per process; across servers the conditional updates decide.
   * Without FINTAVA_* settings it does nothing.
   */
  @Cron(CronExpression.EVERY_30_SECONDS, { name: 'wallet-opening-reconcile' })
  async sweep(): Promise<Record<OpeningReconciliation, number>> {
    const counts: Record<OpeningReconciliation, number> = {
      open: 0,
      conflict: 0,
      absent: 0,
      wait: 0,
      nothing_to_do: 0,
    };
    if (this.sweeping || !this.provider.configured) {
      return counts;
    }
    this.sweeping = true;
    try {
      const now = await this.dbNow();
      const due = await this.prisma.fintavaWalletOpening.findMany({
        where: {
          AND: [
            {
              OR: [
                { state: 'unknown' },
                {
                  state: 'opening',
                  attemptStartedAt: { lt: this.stuckBefore(now) },
                },
              ],
            },
            // Only openings with the provider the server runs (NUV-01):
            // another provider's lost answer is never looked up here.
            rowsOf(this.provider.name),
          ],
        },
        orderBy: { attemptStartedAt: 'asc' },
        take: WALLET_OPENING_DEFAULTS.batch,
        select: OPENING_SELECT,
      });
      for (const found of due) {
        try {
          const row = await this.unstick(found, await this.dbNow());
          counts[await this.reconcile(row)] += 1;
        } catch (e) {
          this.logger.error(
            `wallet opening: a lost answer could not be reconciled (${(e as Error).name ?? 'Error'}); tried again on the next sweep`,
          );
          counts.wait += 1;
        }
      }
      if (counts.open + counts.absent + counts.conflict > 0) {
        this.logger.log(
          `wallet opening: ${counts.open} opened, ${counts.absent} not created, ${counts.conflict} stopped for review, ${counts.wait} waiting`,
        );
      }
      return counts;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Asks Fintava about one lost create and acts on the answer: `open` (it
   * exists and carries the person's BVN, now recorded), `conflict` (the
   * phone's customer does not carry the person's BVN, or another WAWU
   * account holds it: stopped for review), `absent` (proved not created;
   * the row is `failed` and a new attempt may start), `wait`, or
   * `nothing_to_do` (not `unknown`, or another request is asking right now).
   * Times are the database's.
   */
  async reconcile(row: OpeningRow): Promise<OpeningReconciliation> {
    if (row.state !== 'unknown') return 'nothing_to_do';
    if (!isRowOf(this.provider.name, row.provider)) return 'nothing_to_do';
    // NUV-02: a reviewing provider's lost create is settled from its
    // delivery (NuvionEntity), never created again from here.
    if (this.reviewing) return this.reviewed.reconcile(row);
    const now = await this.dbNow();
    // One asker at a time, and not more often than every few seconds.
    const asking = await this.prisma.fintavaWalletOpening.updateMany({
      where: {
        wawuUserId: row.wawuUserId,
        attempts: row.attempts,
        state: 'unknown',
        OR: [
          { checkedAt: null },
          {
            checkedAt: {
              lt: new Date(
                now.getTime() - WALLET_OPENING_DEFAULTS.recheckAfterMs,
              ),
            },
          },
        ],
      },
      data: { checkedAt: now },
    });
    if (asking.count !== 1) return 'nothing_to_do';

    let seen: ProviderCustomerMatch | null = null;
    let detailsSaidAbsent = false;
    try {
      const lookup = await this.provider.findCustomerByPhone(
        row.phone,
        this.bvnDigest,
      );
      if (lookup.state === 'found') seen = lookup;
      detailsSaidAbsent = lookup.state === 'absent';
    } catch {
      return 'wait';
    }
    if (!seen) {
      const listed = await this.findInList(row.phone, row.attemptStartedAt);
      if (listed === 'unknown') return 'wait';
      if (listed !== 'not_listed') {
        try {
          seen = await this.provider.getCustomerMatch(
            listed.customerId,
            this.bvnDigest,
          );
        } catch {
          return 'wait';
        }
      }
    }
    if (seen) {
      // Found by phone, from the details or the list, of any age: it is
      // this person's only if it carries their BVN.
      const stop = this.identityStop(seen, row.bvnHash);
      if (stop !== null) {
        const stopped = await this.stopForReview(
          row.wawuUserId,
          row.attempts,
          stop,
          'unknown',
        );
        return stopped ? 'conflict' : 'nothing_to_do';
      }
      const recorded = await this.record(
        row.wawuUserId,
        row.attempts,
        seen.customer,
      );
      if (recorded === 'conflict') {
        await this.prisma.fintavaWalletOpening.updateMany({
          where: {
            wawuUserId: row.wawuUserId,
            attempts: row.attempts,
            state: 'unknown',
          },
          data: { state: 'conflict', failure: 'held_by_another_account' },
        });
        this.logger.error(
          `wallet opening: ${this.provider.label} has an account for this phone that another WAWU account holds; it needs review`,
        );
        return 'conflict';
      }
      return recorded === 'recorded' ? 'open' : 'nothing_to_do';
    }
    if (!detailsSaidAbsent) return 'wait';
    const age = now.getTime() - row.attemptStartedAt.getTime();
    if (age < this.resendAfterMs()) return 'wait';
    const failed = await this.prisma.fintavaWalletOpening.updateMany({
      where: {
        wawuUserId: row.wawuUserId,
        attempts: row.attempts,
        state: 'unknown',
      },
      data: { state: 'failed', failure: 'not_created' },
    });
    return failed.count === 1 ? 'absent' : 'nothing_to_do';
  }

  // -------------------------------------------------------------------------

  private hasWallet(wawuUserId: string): Promise<boolean> {
    return this.prisma.fintavaWallet
      .findUnique({ where: { wawuUserId }, select: { wawuUserId: true } })
      .then((w) => w !== null);
  }

  private opening(wawuUserId: string): Promise<OpeningRow | null> {
    return this.prisma.fintavaWalletOpening.findUnique({
      where: { wawuUserId },
      select: OPENING_SELECT,
    });
  }

  /** No resend sooner than this after a create was sent (MONEY-06's rule). */
  private resendAfterMs(): number {
    const t = this.provider.timings;
    return t.moneyTimeoutMs + t.resendSafetyMs;
  }

  /**
   * An `opening` row older than this is a request that never finished: the
   * lookup and the create each end at their own timeout well before it.
   */
  private stuckBefore(now: Date): Date {
    const s = this.provider.timings;
    return new Date(
      now.getTime() -
        (2 * s.readTimeoutMs +
          s.moneyTimeoutMs +
          WALLET_OPENING_DEFAULTS.stuckAfterMs),
    );
  }

  /** A stuck `opening` row becomes `unknown`: its create may have been sent. */
  private async unstick(row: OpeningRow, now: Date): Promise<OpeningRow> {
    if (
      row.state !== 'opening' ||
      row.attemptStartedAt >= this.stuckBefore(now)
    ) {
      return row;
    }
    await this.prisma.fintavaWalletOpening.updateMany({
      where: {
        wawuUserId: row.wawuUserId,
        attempts: row.attempts,
        state: 'opening',
      },
      data: { state: 'unknown' },
    });
    return (await this.opening(row.wawuUserId)) ?? row;
  }

  /**
   * Takes the person's opening for a new attempt: a new row, or a `failed`
   * one (the attempt number it was read with must still be current).
   * Returns the attempt number, or null when another request holds it.
   */
  private async claim(
    wawuUserId: string,
    check: CheckedIdentity,
    row: OpeningRow | null,
  ): Promise<number | null> {
    const tie = {
      bvnHash: check.bvnHash,
      bvnVerifiedAt: check.verifiedAt,
      phone: check.verifiedPhone,
    };
    const startedAt = await this.dbNow();
    try {
      if (!row) {
        await this.prisma.fintavaWalletOpening.create({
          data: {
            wawuUserId,
            state: 'opening',
            attempts: 1,
            attemptStartedAt: startedAt,
            provider: this.provider.name,
            ...tie,
          },
        });
        return 1;
      }
      const next = row.attempts + 1;
      const taken = await this.prisma.fintavaWalletOpening.updateMany({
        where: { wawuUserId, state: 'failed', attempts: row.attempts },
        data: {
          ...tie,
          state: 'opening',
          attempts: next,
          attemptStartedAt: startedAt,
          failure: null,
          checkedAt: null,
          provider: this.provider.name,
        },
      });
      return taken.count === 1 ? next : null;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const target = uniqueTarget(e);
      if (/bvnHash|phone/.test(target)) {
        throw new MoneyError(
          'identity_has_wallet',
          IDENTITY_HAS_WALLET_MESSAGE,
        );
      }
      // The person's own row appeared meanwhile: another request holds it.
      return null;
    }
  }

  /**
   * Records the account Fintava has for this person, if the opening is
   * still on this attempt. `conflict` when another WAWU account already
   * holds that Fintava account; `taken` when this person's wallet was
   * recorded by another request (or the attempt moved on).
   */
  private async record(
    wawuUserId: string,
    attempt: number,
    customer: ProviderCustomer,
  ): Promise<'recorded' | 'taken' | 'conflict'> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const mine = await tx.fintavaWalletOpening.updateMany({
          where: {
            wawuUserId,
            attempts: attempt,
            state: { in: ['opening', 'unknown'] },
          },
          data: { state: 'open', failure: null },
        });
        if (mine.count !== 1) throw new LostClaim();
        await tx.fintavaWallet.create({
          data: {
            wawuUserId,
            customerId: customer.customerId,
            walletId: customer.walletId,
            accountNumber: customer.accountNumber,
            accountName:
              customer.accountName === '' ? null : customer.accountName,
            provider: this.provider.name,
          },
        });
      });
      this.logger.log('wallet opening: account recorded');
      return 'recorded';
    } catch (e) {
      if (e instanceof LostClaim) return 'taken';
      if (!isUniqueViolation(e)) {
        // Fintava has the account and we could not write it: the row stays
        // where it was and the sweep finds the account again by phone.
        await this.lost(wawuUserId, attempt);
        throw e;
      }
      const held = await this.prisma.fintavaWallet.findUnique({
        where: { wawuUserId },
        select: { customerId: true },
      });
      if (held) return 'taken';
      return 'conflict';
    }
  }

  /** The database's clock: the one every opening time is stamped and compared with. */
  private async dbNow(): Promise<Date> {
    const [r] = await this.prisma.$queryRaw<Array<{ now: Date | string }>>`
      SELECT now() AS "now"
    `;
    return new Date(r.now);
  }

  /** The keyed hash of a BVN on Fintava's record (KYC-01's scheme, `bvn:<digits>`). */
  private readonly bvnDigest = (bvn: string): string =>
    this.hasher.hash('bvn', bvn);

  /**
   * Null when Fintava's customer carries the checked BVN; otherwise why it
   * must not be adopted.
   */
  private identityStop(
    found: ProviderCustomerMatch,
    bvnHash: string,
  ): IdentityStop | null {
    if (found.bvnDigest === null) return 'phone_holder_bvn_unreadable';
    return found.bvnDigest === bvnHash ? null : 'phone_held_by_other_identity';
  }

  /**
   * Stops an opening for review (WORKFLOW section 10: someone else's
   * account): `conflict`, nothing adopted and nothing created on it again.
   * True when this request stopped it.
   */
  private async stopForReview(
    wawuUserId: string,
    attempt: number,
    why: IdentityStop,
    from: 'opening' | 'unknown',
  ): Promise<boolean> {
    const stopped = await this.prisma.fintavaWalletOpening.updateMany({
      where: { wawuUserId, attempts: attempt, state: from },
      data: { state: 'conflict', failure: why },
    });
    if (stopped.count === 1) {
      this.logger.error(
        `wallet opening: ${this.provider.label}'s customer for this phone is not shown to be this person (${why}); nothing adopted or created, it needs review`,
      );
    }
    return stopped.count === 1;
  }

  /** The answer was lost: `unknown`, reconciled before anything is sent again. */
  private async lost(wawuUserId: string, attempt: number): Promise<void> {
    await this.prisma.fintavaWalletOpening.updateMany({
      where: { wawuUserId, attempts: attempt, state: 'opening' },
      data: { state: 'unknown' },
    });
  }

  /** Nothing was created on this attempt: a new one may start. */
  private async fail(
    wawuUserId: string,
    attempt: number,
    why: string,
    from: OpeningState[] = ['opening'],
  ): Promise<void> {
    await this.prisma.fintavaWalletOpening.updateMany({
      where: { wawuUserId, attempts: attempt, state: { in: from } },
      data: { state: 'failed', failure: why },
    });
  }

  /**
   * Looks for the phone in Fintava's customer list (N1: its order is not
   * assumed). Pages are read until the list ends, up to `listPages`: a list
   * read to its end without the phone is `not_listed`, whatever its order.
   * A list longer than that is `not_listed` only when every row read was
   * newest first and the rows reached back past a little before the
   * attempt; otherwise `unknown`. Also `unknown` when a page could not be
   * read or a row has no readable time.
   */
  private async findInList(
    phone: string,
    since: Date,
  ): Promise<{ customerId: string } | 'not_listed' | 'unknown'> {
    const cutoff = since.getTime() - WALLET_OPENING_DEFAULTS.clockSkewMs;
    const local = `0${phone.replace(/^\+234/, '')}`;
    let previous = Number.POSITIVE_INFINITY;
    let newestFirst = true;
    let reachedAttempt = false;
    for (let page = 1; page <= WALLET_OPENING_DEFAULTS.listPages; page += 1) {
      let rows;
      try {
        rows = await this.provider.listCustomerSightings({
          page,
          take: WALLET_OPENING_DEFAULTS.listTake,
        });
      } catch {
        return 'unknown';
      }
      for (const row of rows.items) {
        const at = row.createdAt === null ? NaN : Date.parse(row.createdAt);
        if (Number.isNaN(at)) return 'unknown';
        if (row.phone === local) return { customerId: row.customerId };
        if (at > previous) newestFirst = false;
        previous = at;
        if (at < cutoff) reachedAttempt = true;
      }
      if (!rows.hasNextPage) return 'not_listed';
    }
    if (newestFirst && reachedAttempt) return 'not_listed';
    if (!newestFirst) {
      this.logger.warn(
        `wallet opening: ${this.provider.label}'s customer list is longer than we read and not newest first; a lost answer waits`,
      );
    }
    return 'unknown';
  }

  /** Fintava may have made the customer although the call failed. */
  private mayHaveOpened(e: WalletProviderError): boolean {
    if (e.recordMayExist || WALLET_PROVIDER_UNKNOWN_OUTCOMES.includes(e.kind)) {
      return true;
    }
    if (['not_configured', 'auth', 'merchant_inactive'].includes(e.kind)) {
      return false;
    }
    return e.messages.some((m) => SAYS_IT_EXISTS.test(m));
  }

  private refusal(e: WalletProviderError): HttpException {
    if (ABOUT_THE_DETAILS.includes(e.kind)) {
      return new MoneyError('account_not_opened', ACCOUNT_NOT_OPENED_MESSAGE);
    }
    return this.unavailable();
  }

  private phoneHeld(): HttpException {
    return new MoneyError('phone_held_by_other_identity', PHONE_HELD_MESSAGE);
  }

  private unavailable(): HttpException {
    return new MoneyError('provider_unreachable', OPENING_UNAVAILABLE_MESSAGE, {
      retryAfterSeconds: this.provider.timings.retryAfterSeconds,
    });
  }
}
