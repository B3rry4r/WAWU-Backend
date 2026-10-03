import { HttpException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FintavaClient } from '../../fintava/fintava-client';
import { FINTAVA_DEFAULTS } from '../../fintava/fintava-config';
import {
  FINTAVA_UNKNOWN_OUTCOMES,
  FintavaError,
  type FintavaErrorKind,
} from '../../fintava/fintava-error';
import type { FintavaCustomer } from '../../fintava/fintava.interface';
import { IdentityHasher } from '../identity/identity-config';
import { SelfieMatchService } from '../identity/selfie-match.service';
import {
  BVN_NOT_CHECKED_MESSAGE,
  type CheckedIdentity,
  WalletIdentityService,
} from '../identity/wallet-identity.service';
import { FINTAVA_WALLET_BANK_CODE } from '../ledger/ledger-config';
import { MoneyError } from '../money-error';
import type { WalletState, WalletView } from '../money-view.type';
import { TransactionPinService } from '../pin/transaction-pin.service';
import type { OpenNairaWalletDto } from './dto/open-wallet.dto';
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

/** FintavaWalletOpening.state (schema.prisma). */
export type OpeningState =
  'opening' | 'unknown' | 'failed' | 'open' | 'conflict';

/** What Fintava said about a lost create, once asked. */
export type OpeningReconciliation =
  'open' | 'conflict' | 'absent' | 'wait' | 'nothing_to_do';

type OpeningRow = {
  wawuUserId: string;
  state: string;
  phone: string;
  attempts: number;
  attemptStartedAt: Date;
  checkedAt: Date | null;
};

const OPENING_SELECT = {
  wawuUserId: true,
  state: true,
  phone: true,
  attempts: true,
  attemptStartedAt: true,
  checkedAt: true,
} as const;

/** A refusal whose words say the record exists: never read as "nothing was made". */
const SAYS_IT_EXISTS = /exist|duplicate|already/i;

/** Kinds after which Fintava's answer is about the details sent (A5's or the address). */
const ABOUT_THE_DETAILS: readonly FintavaErrorKind[] = [
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
 *   a customer for the phone (`/customers/details`); if it has one no other
 *   WAWU account holds, that account is the person's and is recorded,
 *   instead of making a second.
 * - **A lost answer is reconciled, never resent blindly.** A timeout, a 5xx,
 *   a 2xx we cannot read, or a refusal saying the customer exists, leaves
 *   the row `unknown` (A7's "still opening"). It is settled by asking
 *   Fintava (here on the next request, and by the sweep every 30 seconds):
 *   found by phone (the details lookup, or the newest-first customer list
 *   back to when the attempt was sent) is recorded as the person's account;
 *   it is "not created" only when the details lookup gives Fintava's own
 *   `404 ["Customer not found"]` AND the list has no row for the phone AND
 *   the money timeout plus `FINTAVA_RESEND_SAFETY_MS` has passed since the
 *   create was sent (Fintava keeps working after we stop waiting). Anything
 *   else, waits. Only then may a new attempt start, with the details sent
 *   again: none of them is kept.
 *
 * Identity is read once (KYC-02 round 2, finding 3):
 * `WalletIdentityService.checkedIdentity` compares the BVN and the NIN with
 * the passed check and returns that check; the selfie must have matched
 * against exactly that check (`SelfieMatchService.matchedFor`, its time and
 * keyed hash), and the opening records the check it was claimed under.
 *
 * Never stored or logged: the BVN, the NIN, the name, the date of birth,
 * the address (the MONEY-06 client logs no body). Stored: the keyed BVN
 * hash and the proved phone (to find a lost answer), and the three ids and
 * account name Fintava answered with (FintavaWallet).
 */
@Injectable()
export class WalletOpeningService {
  private readonly logger = new Logger(WalletOpeningService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fintava: FintavaClient,
    private readonly hasher: IdentityHasher,
    private readonly identity: WalletIdentityService,
    private readonly selfie: SelfieMatchService,
    private readonly pins: TransactionPinService,
    private readonly settings: WalletOpeningSettings,
  ) {}

  // -------------------------------------------------------------------------
  // GET /money/wallet
  // -------------------------------------------------------------------------

  /** The wallet as WAWU records it. Never calls Fintava. */
  async view(wawuUserId: string): Promise<WalletView> {
    const [wallet, opening, pin] = await Promise.all([
      this.prisma.fintavaWallet.findUnique({
        where: { wawuUserId },
        select: { accountNumber: true, accountName: true, createdAt: true },
      }),
      this.prisma.fintavaWalletOpening.findUnique({
        where: { wawuUserId },
        select: { state: true },
      }),
      this.pins.state(wawuUserId),
    ]);
    let state: WalletState = 'not_open';
    if (wallet) state = 'open';
    else if (
      opening &&
      ['opening', 'unknown', 'conflict', 'open'].includes(opening.state)
    ) {
      state = 'opening';
    }
    return {
      state,
      account: wallet
        ? {
            accountNumber: wallet.accountNumber,
            accountName: wallet.accountName ?? '',
            bankName: this.settings.bankName,
            bankCode: FINTAVA_WALLET_BANK_CODE,
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
      // Nobody can save a beneficiary until WALLET-14 serves them.
      beneficiaryCount: 0,
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
  ): Promise<WalletView> {
    if (
      !this.hasher.configured ||
      this.fintava.environment === 'unconfigured'
    ) {
      throw this.unavailable();
    }
    if (await this.hasWallet(wawuUserId)) return this.view(wawuUserId);

    const now = new Date();
    let row = await this.opening(wawuUserId);
    if (row) row = await this.unstick(row, now);
    if (row && row.state !== 'failed') {
      if (row.state !== 'unknown') return this.view(wawuUserId);
      const settled = await this.reconcile(row, now);
      if (settled !== 'absent') return this.view(wawuUserId);
      row = await this.opening(wawuUserId);
      if (!row || row.state !== 'failed') return this.view(wawuUserId);
    }

    // Identity, read once: the passed check whose BVN and NIN these are,
    // and the selfie that matched against exactly that check.
    const check = await this.identity.checkedIdentity(
      wawuUserId,
      input.bvn,
      input.nin,
    );
    if (!check) {
      throw new MoneyError('bvn_not_checked', BVN_NOT_CHECKED_MESSAGE);
    }
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
    // since): that one is theirs, never a second.
    let existing: FintavaCustomer | null = null;
    let answered = false;
    try {
      const lookup = await this.fintava.lookupCustomerByPhone(
        check.verifiedPhone,
      );
      if (lookup.state === 'found') existing = lookup.customer;
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
      const recorded = await this.record(wawuUserId, attempt, existing);
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
    const sentAt = new Date();
    const still = await this.prisma.fintavaWalletOpening.updateMany({
      where: { wawuUserId, attempts: attempt, state: 'opening' },
      data: { attemptStartedAt: sentAt },
    });
    if (still.count !== 1) return this.view(wawuUserId);

    let customer: FintavaCustomer;
    try {
      customer = await this.fintava.createCustomer({
        firstName: input.firstName,
        lastName: input.lastName,
        phone: check.verifiedPhone,
        email: mail,
        address: input.address,
        dateOfBirth: input.dateOfBirth,
        bvn: input.bvn,
        nin: input.nin,
      });
    } catch (e) {
      if (!(e instanceof FintavaError) || this.mayHaveOpened(e)) {
        await this.lost(wawuUserId, attempt);
        if (!(e instanceof FintavaError)) throw e;
        return this.view(wawuUserId);
      }
      await this.fail(wawuUserId, attempt, `refused_${e.kind}`);
      throw this.refusal(e);
    }
    await this.record(wawuUserId, attempt, customer);
    return this.view(wawuUserId);
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
  async sweep(
    now = new Date(),
  ): Promise<Record<OpeningReconciliation, number>> {
    const counts: Record<OpeningReconciliation, number> = {
      open: 0,
      conflict: 0,
      absent: 0,
      wait: 0,
      nothing_to_do: 0,
    };
    if (this.sweeping || this.fintava.environment === 'unconfigured') {
      return counts;
    }
    this.sweeping = true;
    try {
      const due = await this.prisma.fintavaWalletOpening.findMany({
        where: {
          OR: [
            { state: 'unknown' },
            {
              state: 'opening',
              attemptStartedAt: { lt: this.stuckBefore(now) },
            },
          ],
        },
        orderBy: { attemptStartedAt: 'asc' },
        take: WALLET_OPENING_DEFAULTS.batch,
        select: OPENING_SELECT,
      });
      for (const found of due) {
        try {
          const row = await this.unstick(found, now);
          counts[await this.reconcile(row, now)] += 1;
        } catch (e) {
          this.logger.error(
            `wallet opening: a lost answer could not be reconciled (${(e as Error).name ?? 'Error'}); tried again on the next sweep`,
          );
          counts.wait += 1;
        }
      }
      if (counts.open + counts.absent + counts.conflict > 0) {
        this.logger.log(
          `wallet opening: ${counts.open} opened, ${counts.absent} not created, ${counts.conflict} held by another account, ${counts.wait} waiting`,
        );
      }
      return counts;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Asks Fintava about one lost create and acts on the answer: `open` (it
   * exists, now recorded), `conflict` (it exists and another WAWU account
   * holds it), `absent` (proved not created; the row is `failed` and a new
   * attempt may start), `wait`, or `nothing_to_do` (not `unknown`, or
   * another request is asking right now).
   */
  async reconcile(
    row: OpeningRow,
    now = new Date(),
  ): Promise<OpeningReconciliation> {
    if (row.state !== 'unknown') return 'nothing_to_do';
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

    let seen: FintavaCustomer | null = null;
    let detailsSaidAbsent = false;
    try {
      const lookup = await this.fintava.lookupCustomerByPhone(row.phone);
      if (lookup.state === 'found') seen = lookup.customer;
      detailsSaidAbsent = lookup.state === 'absent';
    } catch {
      return 'wait';
    }
    if (!seen) {
      const listed = await this.findInList(row.phone, row.attemptStartedAt);
      if (listed === 'unknown') return 'wait';
      if (listed !== 'not_listed') {
        try {
          seen = await this.fintava.getCustomer(listed.customerId);
        } catch {
          return 'wait';
        }
      }
    }
    if (seen) {
      const recorded = await this.record(row.wawuUserId, row.attempts, seen);
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
          'wallet opening: Fintava has an account for this phone that another WAWU account holds; it needs review',
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
    return (
      this.fintava.settings.moneyTimeoutMs +
      this.fintava.settings.resendSafetyMs
    );
  }

  /**
   * An `opening` row older than this is a request that never finished: the
   * lookup and the create each end at their own timeout well before it.
   */
  private stuckBefore(now: Date): Date {
    const s = this.fintava.settings;
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
    try {
      if (!row) {
        await this.prisma.fintavaWalletOpening.create({
          data: { wawuUserId, state: 'opening', attempts: 1, ...tie },
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
          attemptStartedAt: new Date(),
          failure: null,
          checkedAt: null,
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
    customer: FintavaCustomer,
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
   * Looks for the phone in Fintava's customer list, newest first, back to a
   * little before the attempt was sent. `unknown` when the list could not
   * be read, a row has no readable time, or the pages ran out first.
   */
  private async findInList(
    phone: string,
    since: Date,
  ): Promise<{ customerId: string } | 'not_listed' | 'unknown'> {
    const cutoff = since.getTime() - WALLET_OPENING_DEFAULTS.clockSkewMs;
    const local = `0${phone.replace(/^\+234/, '')}`;
    for (let page = 1; page <= WALLET_OPENING_DEFAULTS.listPages; page += 1) {
      let rows;
      try {
        rows = await this.fintava.listCustomerSightings({
          page,
          take: WALLET_OPENING_DEFAULTS.listTake,
        });
      } catch {
        return 'unknown';
      }
      let older = false;
      for (const row of rows.items) {
        if (row.phone === local) return { customerId: row.customerId };
        const at = row.createdAt === null ? NaN : Date.parse(row.createdAt);
        if (Number.isNaN(at)) return 'unknown';
        if (at < cutoff) older = true;
      }
      if (older || !rows.hasNextPage) return 'not_listed';
    }
    return 'unknown';
  }

  /** Fintava may have made the customer although the call failed. */
  private mayHaveOpened(e: FintavaError): boolean {
    if (e.recordMayExist || FINTAVA_UNKNOWN_OUTCOMES.includes(e.kind)) {
      return true;
    }
    if (['not_configured', 'auth', 'merchant_inactive'].includes(e.kind)) {
      return false;
    }
    return e.messages.some((m) => SAYS_IT_EXISTS.test(m));
  }

  private refusal(e: FintavaError): HttpException {
    if (ABOUT_THE_DETAILS.includes(e.kind)) {
      return new MoneyError('account_not_opened', ACCOUNT_NOT_OPENED_MESSAGE);
    }
    return this.unavailable();
  }

  private unavailable(): HttpException {
    return new MoneyError('provider_unreachable', OPENING_UNAVAILABLE_MESSAGE, {
      retryAfterSeconds: FINTAVA_DEFAULTS.retryAfterSeconds,
    });
  }
}
