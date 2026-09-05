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
   * Called when KYC is approved rather than at signup: the wallet is an
   * account at a bank, and opening one for somebody whose identity has not
   * been checked is the thing KYC exists to prevent.
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
   * The wallet, with the balance Flutterwave reports, opening it on first ask.
   *
   * Opened from the CREATOR'S OWN request rather than from the admin's KYC
   * approval, for one practical reason: a wallet is a bank account and needs a
   * real name to open in, and the caller's token carries their verified name
   * while the KYC row does not. The gate is the same either way - KYC must be
   * approved - it is just enforced where the name is.
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
      const state = await this.prisma.creatorState.findUnique({
        where: { wawuUserId },
        select: { kycStatus: true },
      });
      if (state?.kycStatus !== 'approved') {
        // Not an error state on the client: it is the ordinary "verify first"
        // screen, and it must say which of the two gates is the one blocking.
        throw new BadRequestException(
          'Your identity check has to be approved before a wallet can be opened.',
        );
      }
      wallet = await this.ensureWallet({
        wawuUserId,
        accountName: `${claims.firstName} ${claims.lastName}`.trim(),
        // Flutterwave keys a payout subaccount by email and rejects a
        // duplicate, so this is namespaced per account rather than the
        // creator's own address, which they may share with another product.
        email: claims.email ?? `${wawuUserId}@wallet.wawuafrica.com`,
        country: claims.country || 'NG',
        phone: claims.phone,
      });
    }

    const { availableNgn } = await this.flw.balance(wallet.accountReference);
    return {
      accountReference: wallet.accountReference,
      // The creator's own account number. Anyone can pay into it directly.
      accountNumber: wallet.nuban,
      bankName: wallet.bankName,
      availableNgn,
      status: wallet.status,
      createdAt: wallet.createdAt,
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

    const wallet = await this.prisma.creatorWallet.findUnique({
      where: { wawuUserId: input.wawuUserId },
    });
    if (!wallet) throw new NotFoundException('No wallet for this account yet.');

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

  /** Banks a creator can withdraw to. */
  banks() {
    return this.flw.banks();
  }

  /** Confirms whose account a number is, before anyone sends money to it. */
  resolveAccount(bankCode: string, accountNumber: string) {
    return this.flw.resolveAccount(bankCode, accountNumber);
  }
}
