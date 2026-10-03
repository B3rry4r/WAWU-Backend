import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { OpenWallet } from '../gate/wallet-gate';
import { TransactionHistoryService } from '../history/transaction-history.service';
import { MoneyError } from '../money-error';
import type { TransactionView } from '../money-view.type';
import { WalletOpeningSettings } from '../opening/wallet-opening-config';
import { ReceiptSettings } from './receipt-config';
import { newReceiptCode, normalReceiptCode, receiptLink } from './receipt-code';
import {
  headlineOf,
  type OwnWallet,
  partiesOf,
  publicReceipt,
  type PublicReceipt,
  receiptDocument,
  type ReceiptDocument,
  receiptLines,
  typeLabelOf,
} from './receipt-document';
import type { ReceiptView } from './receipt-view.type';

/** What a miss is looked up as: no stored code can equal it (codes are 12 base-32 characters). */
const NO_CODE = '-';

/** Fresh codes tried before giving up: two codes colliding in 2 to the 60th is not expected even once. */
const CODE_ATTEMPTS = 3;

/**
 * Receipts (task WALLET-18, W41 to W43; W12 and W27 share from here).
 *
 * - **The owner's side.** Only a row on the caller's own wallet has a
 *   receipt: the row is read through MONEY-15's `detail`, so someone
 *   else's row is the same 404 as no row, and the receipt shows exactly
 *   what W27 shows. The code is made the first time and kept (one per
 *   row; two taps at once still make one).
 * - **The public side.** A code is looked up once in MoneyReceipt and,
 *   when it matches, its row is read as its owner would read it, as it
 *   stands now (Fintava's word moves a status; nothing here adds anything
 *   up or calls Fintava). Every miss, made-up, mistyped or gone, is the same
 *   null, and a code that cannot be one is still looked up, so it takes
 *   the same one query as any other miss.
 */
@Injectable()
export class ReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly history: TransactionHistoryService,
    private readonly wallets: WalletOpeningSettings,
    private readonly settings: ReceiptSettings,
  ) {}

  /** POST /money/transactions/{id}/receipt: the receipt, made on the first ask. */
  async issue(wallet: OpenWallet, entryId: string): Promise<ReceiptView> {
    const tx = await this.history.detail(wallet, entryId);
    const receipt = await this.codeFor(wallet, tx.id);
    const own = await this.ownWallet(wallet);
    return this.view(tx, own, receipt);
  }

  /** The image and the PDF draw this. */
  async document(
    wallet: OpenWallet,
    entryId: string,
  ): Promise<{ doc: ReceiptDocument; code: string; issuedAt: Date }> {
    const view = await this.issue(wallet, entryId);
    return {
      doc: receiptDocument(view),
      code: view.code,
      issuedAt: new Date(view.issuedAt),
    };
  }

  /** GET /r/{code}: what the public page shows, or null for any miss. */
  async lookup(raw: string): Promise<PublicReceipt | null> {
    const code = normalReceiptCode(raw);
    const receipt = await this.prisma.moneyReceipt.findUnique({
      where: { code: code ?? NO_CODE },
    });
    if (!receipt) return null;
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: receipt.wawuUserId },
    });
    if (!wallet || wallet.accountNumber !== receipt.accountNumber) return null;
    let tx: TransactionView;
    try {
      tx = await this.history.detail(wallet, receipt.entryId);
    } catch (e) {
      if (e instanceof MoneyError && e.code === 'not_found') return null;
      throw e;
    }
    return publicReceipt(
      tx,
      { accountNumber: wallet.accountNumber, accountName: wallet.accountName },
      this.wallets.bankName,
      this.wallets.licenceLine,
      receiptLink(receipt.code),
    );
  }

  private async codeFor(
    wallet: OpenWallet,
    entryId: string,
  ): Promise<{ code: string; createdAt: Date }> {
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
      const held = await this.prisma.moneyReceipt.findUnique({
        where: { entryId },
      });
      if (held) return held;
      try {
        return await this.prisma.moneyReceipt.create({
          data: {
            code: newReceiptCode(),
            entryId,
            wawuUserId: wallet.wawuUserId,
            accountNumber: wallet.accountNumber,
          },
        });
      } catch (e) {
        // A second tap made it first (entryId), or the code was taken: read again.
        if ((e as { code?: unknown } | null)?.code !== 'P2002') throw e;
      }
    }
    throw new Error('A receipt code could not be made.');
  }

  private async ownWallet(wallet: OpenWallet): Promise<OwnWallet> {
    const row = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: wallet.wawuUserId },
      select: { accountName: true },
    });
    return {
      accountNumber: wallet.accountNumber,
      accountName: row?.accountName ?? null,
    };
  }

  private view(
    tx: TransactionView,
    own: OwnWallet,
    receipt: { code: string; createdAt: Date },
  ): ReceiptView {
    const parties = partiesOf(tx, own);
    return {
      code: receipt.code,
      link: receiptLink(receipt.code),
      url: this.settings.urlOf(receipt.code),
      transaction: tx,
      typeLabel: typeLabelOf(tx),
      headline: headlineOf(tx),
      from: parties.from,
      to: parties.to,
      bankName: this.wallets.bankName,
      licenceLine: this.wallets.licenceLine,
      lines: receiptLines(tx, parties, this.wallets.bankName),
      issuedAt: receipt.createdAt.toISOString(),
    };
  }
}
