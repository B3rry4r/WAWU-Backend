import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { toAlpha2 } from './country-code';
import {
  FLUTTERWAVE_WALLET_GATEWAY,
  type FlutterwaveWalletGateway,
} from './flutterwave-wallet.gateway';

/** Nobody withdraws ₦50. Below this the transfer fee eats the transfer. */
export const MIN_WITHDRAWAL_NGN = 1000;

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLUTTERWAVE_WALLET_GATEWAY)
    private readonly flw: FlutterwaveWalletGateway,
  ) {}

  /**
   * Opens the creator's wallet, once.
   *
   * Opened AT REGISTRATION now, not at KYC approval (build brief C7:
   * "auto-provision a wallet on registration for creators and
   * professionals"). Two things made that safe to move:
   *
   *  - A payout subaccount is opened in the person's own name at Flutterwave
   *    MFB, under Flutterwave's licence, with name/email/country/phone. It is
   *    not a WAWU-held balance, so an account existing early holds nothing
   *    of ours and nothing of anybody else's.
   *  - The gate KYC actually exists for is money LEAVING to an outside bank
   *    account. That gate moved to withdraw(), where it bites, instead of
   *    being enforced by the wallet simply not existing.
   *
   * The second reason is the stronger one: while the wallet did not exist,
   * a creator's share of a completed sale stayed in WAWU's own Flutterwave
   * balance (the funding sweep skips a creator with no wallet). That is WAWU
   * sitting on creator money. Opening the account at registration moves each
   * share out to its owner as it is earned.
   *
   * Idempotent on wawuUserId. A second call returns the existing wallet
   * rather than opening a second account nobody can reconcile.
   */
  async ensureWallet(input: {
    wawuUserId: string;
    accountName: string;
    email: string;
    country: string;
    phone?: string;
  }) {
    const existing = await this.prisma.creatorWallet.findUnique({
      where: { wawuUserId: input.wawuUserId },
    });
    if (existing) return existing;

    const psa = await this.flw.createWallet({
      accountName: input.accountName,
      email: input.email,
      country: input.country,
      ...(input.phone ? { mobilenumber: input.phone } : {}),
    });

    try {
      return await this.prisma.creatorWallet.create({
        data: {
          wawuUserId: input.wawuUserId,
          accountReference: psa.accountReference,
          barterId: psa.barterId,
          nuban: psa.nuban,
          bankName: psa.bankName,
          bankCode: psa.bankCode,
          status: psa.status,
        },
      });
    } catch (e) {
      // Two requests raced and the other won. Theirs is as good as ours, and
      // the wallet Flutterwave just opened for this one is an orphan worth
      // shouting about rather than swallowing.
      const again = await this.prisma.creatorWallet.findUnique({
        where: { wawuUserId: input.wawuUserId },
      });
      if (again) {
        this.logger.error(
          `Raced wallet creation for ${input.wawuUserId}: orphaned PSA ${psa.accountReference}`,
        );
        return again;
      }
      throw e;
    }
  }

  /**
   * Everything a creator needs from their own account, in one read.
   *
   * `availableNgn` is FLUTTERWAVE'S figure, asked for on every load. Nothing
   * in this method adds anything up and calls the result a balance: a total
   * this hub worked out for itself can disagree with what the bank will
   * actually pay, and the creator would believe ours.
   *
   * `paidInNgn`, `pendingInNgn` and `withdrawnNgn` are a different kind of
   * number and are labelled as one on the screen. They are what WAWU has
   * INSTRUCTED over the life of the wallet, summed from our own ledger, which
   * is a record we do own. They are shown beside the balance, never as it.
   */
  async getWallet(claims: {
    sub: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string;
    country: string;
  }) {
    const wawuUserId = claims.sub;
    let wallet = await this.prisma.creatorWallet.findUnique({
      where: { wawuUserId },
    });

    if (!wallet) {
      // Registration opens the wallet (openForAccount, called from profile
      // onboarding). This is the backstop for an account that registered
      // before that existed, or whose provisioning call did not get through.
      const profile = await this.prisma.userProfile.findUnique({
        where: { wawuUserId },
        select: { accountType: true },
      });
      if (profile?.accountType !== 'creator') {
        // Not an error state on the client: it is an ordinary buyer account
        // looking at a creator's screen, and it must say what would make them
        // eligible rather than just refusing.
        throw new BadRequestException(
          'A wallet comes with a creator or professional account. Switch your account type to start selling and one is opened for you.',
        );
      }
      wallet = await this.openForAccount(claims);
    }

    const [{ availableNgn }, totals, state] = await Promise.all([
      this.flw.balance(wallet.accountReference),
      this.ledgerTotals(wawuUserId),
      this.prisma.creatorState.findUnique({
        where: { wawuUserId },
        select: { kycStatus: true },
      }),
    ]);

    const kycApproved = state?.kycStatus === 'approved';
    return {
      accountReference: wallet.accountReference,
      // The creator's own account number. Anyone can pay into it directly.
      accountNumber: wallet.nuban,
      bankName: wallet.bankName,
      availableNgn,
      ...totals,
      /**
       * Whether money may leave for an outside bank account, decided here
       * rather than by the app. The screen reads this instead of re-checking
       * KYC for itself, so there is one answer and the server owns it.
       */
      withdrawalsEnabled: kycApproved,
      withdrawalsBlockedReason: kycApproved
        ? null
        : 'Your identity check has to be approved before money can be sent to your bank account.',
      status: wallet.status,
      createdAt: wallet.createdAt,
    };
  }

  /**
   * Opens a wallet for an account that has just become a creator.
   *
   * Called from onboarding, where the account type is chosen. It NEVER throws:
   * a creator whose Flutterwave call happened to fail must still finish
   * registering, and getWallet() opens one on the next read.
   */
  async provisionOnRegistration(claims: {
    sub: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string;
    country: string;
  }): Promise<{ provisioned: boolean }> {
    try {
      await this.openForAccount(claims);
      return { provisioned: true };
    } catch (e) {
      this.logger.error(
        `Could not open a wallet for ${claims.sub} at registration: ${(e as Error).message}`,
      );
      return { provisioned: false };
    }
  }

  /**
   * The claims-to-Flutterwave translation, in one place.
   *
   * A wallet is a bank account and needs a real name to open in; the caller's
   * token carries the name WAWU ID holds, which is the one KYC will later be
   * checked against.
   */
  private openForAccount(claims: {
    sub: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string;
    country: string;
  }) {
    return this.ensureWallet({
      wawuUserId: claims.sub,
      accountName: `${claims.firstName} ${claims.lastName}`.trim(),
      // Flutterwave keys a payout subaccount by email and rejects a
      // duplicate, so this is namespaced per account rather than the
      // creator's own address, which they may share with another product.
      email: claims.email ?? `${claims.sub}@wallet.wawuafrica.com`,
      // Flutterwave wants ISO alpha-2; the claim is a full name.
      country: toAlpha2(claims.country),
      phone: claims.phone,
    });
  }

  /**
   * What WAWU has instructed over this wallet's life, from our own ledger.
   *
   * Only COMPLETED movements count toward the settled figures, because a
   * pending one has not happened yet and a failed one never will. Pending
   * earnings are reported separately: a creator who has sold something that
   * is still in flight should see it named rather than silently missing.
   *
   * A reversal is an earning taken back, so it comes off what was paid in.
   */
  private async ledgerTotals(wawuUserId: string): Promise<{
    paidInNgn: number;
    pendingInNgn: number;
    withdrawnNgn: number;
  }> {
    const groups = await this.prisma.walletLedgerEntry.groupBy({
      by: ['kind', 'status'],
      where: { wawuUserId },
      _sum: { amount: true },
    });
    const sum = (kind: string, status: string) =>
      groups.find((g) => g.kind === kind && g.status === status)?._sum.amount ?? 0;

    return {
      paidInNgn: sum('earning', 'completed') - sum('reversal', 'completed'),
      pendingInNgn: sum('earning', 'pending'),
      withdrawnNgn: sum('withdrawal', 'completed'),
    };
  }

  /**
   * Moves a creator's share of something they sold into their wallet.
   *
   * `reference` is the caller's idempotency key and it is unique in the
   * ledger, so replaying the same sale cannot pay twice. The row is written
   * BEFORE the transfer: if the process dies mid-call the entry is left
   * pending and reconcilable, which is recoverable. Writing it after would
   * lose money that had already moved.
   */
  async creditEarning(input: {
    wawuUserId: string;
    amount: number;
    reference: string;
    sourceType: string;
    sourceId: string;
  }) {
    if (input.amount <= 0) {
      throw new BadRequestException('An earning must be a positive amount.');
    }

    const existing = await this.prisma.walletLedgerEntry.findUnique({
      where: { reference: input.reference },
    });
    if (existing) return existing;

    const wallet = await this.prisma.creatorWallet.findUnique({
      where: { wawuUserId: input.wawuUserId },
    });
    if (!wallet) {
      throw new NotFoundException(
        'That creator has no wallet yet, so there is nowhere to pay this.',
      );
    }

    let entry;
    try {
      entry = await this.prisma.walletLedgerEntry.create({
        data: {
          wawuUserId: input.wawuUserId,
          kind: 'earning',
          amount: input.amount,
          reference: input.reference,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
        },
      });
    } catch {
      // The unique reference did its job under a race.
      const won = await this.prisma.walletLedgerEntry.findUnique({
        where: { reference: input.reference },
      });
      if (won) return won;
      throw new ConflictException('Could not record that earning.');
    }

    try {
      const result = await this.flw.fundWallet({
        barterId: wallet.barterId,
        amount: input.amount,
        reference: input.reference,
        narration: 'WAWU earnings',
      });
      return await this.prisma.walletLedgerEntry.update({
        where: { id: entry.id },
        data: { transferId: result.transferId },
      });
    } catch (e) {
      // Left PENDING, deliberately, not failed: the request may well have
      // reached Flutterwave. Only the webhook, or a reconciliation against
      // their transfer list, can say. Marking it failed here would invite a
      // second payment for the same sale.
      this.logger.error(
        `Funding ${input.reference} for ${input.wawuUserId} could not be confirmed: ${(e as Error).message}`,
      );
      return entry;
    }
  }

  /**
   * Sends money from the creator's wallet to their bank account.
   *
   * The account NAME is resolved from the bank immediately before sending and
   * stored with the withdrawal. A creator typing a digit wrong otherwise pays
   * a stranger, irreversibly, and there is no way to tell afterwards that it
   * was not what they meant.
   *
   * THIS is where the identity check bites, now that the wallet itself is
   * opened at registration. It used to be enforced by the wallet not existing
   * at all, which stopped an unverified creator from cashing out and also
   * stopped their earnings from ever reaching them. Paying money OUT to an
   * outside bank account is the act KYC is actually for, so the gate sits on
   * it directly.
   */
  async withdraw(input: {
    wawuUserId: string;
    amount: number;
    bankCode: string;
    accountNumber: string;
  }) {
    if (!Number.isInteger(input.amount) || input.amount < MIN_WITHDRAWAL_NGN) {
      throw new BadRequestException(
        `The smallest withdrawal is ₦${MIN_WITHDRAWAL_NGN.toLocaleString('en-NG')}.`,
      );
    }

    const [wallet, state] = await Promise.all([
      this.prisma.creatorWallet.findUnique({
        where: { wawuUserId: input.wawuUserId },
      }),
      this.prisma.creatorState.findUnique({
        where: { wawuUserId: input.wawuUserId },
        select: { kycStatus: true },
      }),
    ]);
    if (!wallet) throw new NotFoundException('No wallet for this account yet.');
    if (state?.kycStatus !== 'approved') {
      throw new BadRequestException(
        'Your identity check has to be approved before money can be sent to your bank account.',
      );
    }

    // Flutterwave's balance is the authority, not anything we have summed.
    const { availableNgn } = await this.flw.balance(wallet.accountReference);
    if (availableNgn < input.amount) {
      throw new BadRequestException(
        `You have ₦${availableNgn.toLocaleString('en-NG')} available.`,
      );
    }

    const resolved = await this.flw.resolveAccount(
      input.bankCode,
      input.accountNumber,
    );

    const reference = `wawu-wd-${randomUUID()}`;
    const entry = await this.prisma.walletLedgerEntry.create({
      data: {
        wawuUserId: input.wawuUserId,
        kind: 'withdrawal',
        amount: input.amount,
        reference,
      },
    });
    await this.prisma.walletWithdrawal.create({
      data: {
        wawuUserId: input.wawuUserId,
        entryId: entry.id,
        amount: input.amount,
        bankCode: input.bankCode,
        accountNumber: input.accountNumber,
        accountName: resolved.accountName,
      },
    });

    try {
      const result = await this.flw.withdraw({
        accountReference: wallet.accountReference,
        bankCode: input.bankCode,
        accountNumber: input.accountNumber,
        amount: input.amount,
        reference,
        narration: 'WAWU withdrawal',
      });
      await this.prisma.walletLedgerEntry.update({
        where: { id: entry.id },
        data: { transferId: result.transferId },
      });
    } catch (e) {
      // A REFUSAL is safe to mark failed: Flutterwave answered and said no, so
      // no money moved. An unreachable Flutterwave is not the same thing and
      // is left pending for the webhook or reconciliation to settle.
      const refused = (e as { status?: number }).status === 400;
      await this.prisma.walletLedgerEntry.update({
        where: { id: entry.id },
        data: refused
          ? { status: 'failed', failureReason: (e as Error).message, settledAt: new Date() }
          : {},
      });
      throw e;
    }

    return {
      reference,
      amount: input.amount,
      accountName: resolved.accountName,
      status: 'pending' as const,
    };
  }

  /** What has moved, newest first. */
  async history(wawuUserId: string, take = 50) {
    const entries = await this.prisma.walletLedgerEntry.findMany({
      where: { wawuUserId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(take, 200),
    });
    return entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      amount: e.amount,
      status: e.status,
      reference: e.reference,
      failureReason: e.failureReason,
      createdAt: e.createdAt,
      settledAt: e.settledAt,
    }));
  }

  /**
   * Settles one movement from Flutterwave's own webhook.
   *
   * Conditional on the row still being pending, so a webhook Flutterwave
   * delivers twice - which they do - cannot settle the same entry twice or
   * resurrect one that has already failed.
   */
  async settleFromWebhook(input: {
    reference: string;
    succeeded: boolean;
    failureReason?: string;
  }): Promise<{ settled: boolean }> {
    const { count } = await this.prisma.walletLedgerEntry.updateMany({
      where: { reference: input.reference, status: 'pending' },
      data: {
        status: input.succeeded ? 'completed' : 'failed',
        settledAt: new Date(),
        ...(input.succeeded ? {} : { failureReason: input.failureReason ?? 'Transfer failed' }),
      },
    });
    if (count === 0) {
      this.logger.log(`Webhook for ${input.reference} settled nothing (already settled, or unknown).`);
    }
    return { settled: count > 0 };
  }

  /**
   * Settles movements the webhook never told us about.
   *
   * Every "we could not confirm" path in this service leaves an entry PENDING
   * rather than guessing, which is correct and also leaves somebody's money in
   * limbo until something asks. This is that something: it takes pending
   * entries past a grace period and asks Flutterwave outright what became of
   * them.
   *
   * The grace period is deliberate. A transfer is genuinely pending for a
   * while, and reconciling one that is still in flight would mark a live
   * transfer failed and invite a second attempt.
   */
  async reconcilePending(olderThanMs = 30 * 60 * 1000, take = 100): Promise<{ checked: number; settled: number }> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stale = await this.prisma.walletLedgerEntry.findMany({
      where: { status: 'pending', createdAt: { lt: cutoff } },
      select: { id: true, reference: true },
      take,
    });

    let settled = 0;
    for (const entry of stale) {
      try {
        const result = await this.flw.transferByReference(entry.reference);
        if (result === null) {
          // Flutterwave has never heard of it, so the request never landed and
          // no money moved. Safe to fail, and safe to retry afterwards.
          const { count } = await this.prisma.walletLedgerEntry.updateMany({
            where: { id: entry.id, status: 'pending' },
            data: {
              status: 'failed',
              failureReason: 'Never reached Flutterwave',
              settledAt: new Date(),
            },
          });
          settled += count;
          continue;
        }
        if (result.status === 'SUCCESSFUL' || result.status === 'FAILED') {
          const { settled: did } = await this.settleFromWebhook({
            reference: entry.reference,
            succeeded: result.status === 'SUCCESSFUL',
            ...(result.message ? { failureReason: result.message } : {}),
          });
          if (did) settled += 1;
        }
        // Anything else (NEW, PENDING) is still in flight. Leave it.
      } catch (e) {
        // Could not ask. Still not evidence, so still pending.
        this.logger.warn(`Could not reconcile ${entry.reference}: ${(e as Error).message}`);
      }
    }
    return { checked: stale.length, settled };
  }

  /** Banks a creator can withdraw to. */
  banks() {
    return this.flw.banks();
  }

  /** Confirms whose account a number is, before anyone sends money to it. */
  resolveAccount(bankCode: string, accountNumber: string) {
    return this.flw.resolveAccount(bankCode, accountNumber);
  }
}
