import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  type ProviderBank,
  type ProviderPayee,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { MoneyError } from '../money-error';
import { BankAccountCheckService } from './bank-account-check.service';

/** Where a saved account is sent: the bank, the number, the holder, the payee ids kept. */
export interface BankSendTarget {
  /** The bank's code in the running provider's list. */
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  /** Nuvion's counterparty and payment detail from an earlier send, or null. */
  payee: ProviderPayee | null;
}

/**
 * What preparing a saved account for a send answers (NUV-06, lead ruling 2):
 * - `ready`: send to `target`;
 * - `name_changed`: the bank now gives another name for the number than the
 *   one kept. Nothing is changed or sent: the person is shown `accountName`
 *   and confirms it (by saving the account again), because a name that
 *   changes under a number may be another person's account;
 * - `refused`: the check did not confirm the account (`not_found`,
 *   `bank_not_supported`, `bad_format`, `multiple_matches`): its own plain
 *   answer, nothing sent;
 * - `unavailable`: no answer in time or the bank list could not be read;
 *   try again, nothing sent;
 * - `missing`: no such saved account.
 */
export type SendTargetResult =
  | { state: 'ready'; target: BankSendTarget }
  | { state: 'name_changed'; accountName: string; target: BankSendTarget }
  | {
      state: 'refused';
      reason:
        'not_found' | 'bank_not_supported' | 'bad_format' | 'multiple_matches';
    }
  | { state: 'unavailable' }
  | { state: 'missing' };

/** A bank's name for matching: lower case, plain letters and digits, no company suffix. */
export function normalizeBankName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(' ')
    .filter((w) => w !== '' && w !== 'plc' && w !== 'ltd' && w !== 'limited')
    .join(' ');
}

/**
 * The bank in Nuvion's list that a saved bank is: by its code when the list
 * has it, else by its name when exactly one bank of the list has that name;
 * null when neither finds one (an unmatched bank is never guessed).
 */
export function matchBank(
  list: ReadonlyMap<string, ProviderBank>,
  code: string,
  name: string,
): ProviderBank | null {
  const byCode = list.get(code);
  if (byCode) return byCode;
  const wanted = normalizeBankName(name);
  if (wanted === '') return null;
  const named = [...list.values()].filter(
    (b) => normalizeBankName(b.name) === wanted,
  );
  return named.length === 1 ? named[0] : null;
}

/** A holder's name for comparing: the words, lower case and plain, in any order. */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(' ')
    .filter((w) => w !== '')
    .sort()
    .join(' ');
}

type Row = {
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  nuvionBankCode: string | null;
  nuvionCheckedAt: Date | null;
};

/**
 * Makes a saved bank account ready to be sent to (task NUV-06), for the
 * send routes (WALLET-09) and for WAWU's own payouts.
 *
 * A row saved under Fintava holds Fintava's bank code and a name Fintava's
 * check gave. Before its first send through Nuvion it is matched to Nuvion's
 * bank list (by code, else by the bank's name), and its name is checked
 * again through Nuvion (`checkAccountName`); only then is it sent to. The
 * match and the time are kept on the row (`nuvionBankCode`,
 * `nuvionCheckedAt`), so the check is made once. A row saved under Nuvion
 * already carries both. Under any other provider the row is sent to as it
 * is.
 *
 * Nuvion's counterparty and payment detail for the account are kept on the
 * row after the first send (`rememberPayee`) and handed back on every later
 * one. A payout account has two pairs: the person's own (their withdrawal)
 * and WAWU's operational account's (WAWU's payouts to them, R-31), because a
 * counterparty sits under the entity that pays.
 */
@Injectable()
export class SavedAccountTargetService {
  private readonly logger = new Logger(SavedAccountTargetService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly banks: BankAccountCheckService,
  ) {}

  /** A saved bank account of this person's list. */
  async forBeneficiary(
    ownerWawuId: string,
    id: string,
  ): Promise<SendTargetResult> {
    const row = await this.prisma.moneyBeneficiary.findFirst({
      where: { id, ownerWawuId, kind: 'bank_account' },
    });
    if (
      !row ||
      row.bankCode === null ||
      row.bankName === null ||
      row.accountNumber === null ||
      row.accountName === null
    ) {
      return { state: 'missing' };
    }
    return this.prepare(
      {
        bankCode: row.bankCode,
        bankName: row.bankName,
        accountNumber: row.accountNumber,
        accountName: row.accountName,
        nuvionBankCode: row.nuvionBankCode,
        nuvionCheckedAt: row.nuvionCheckedAt,
      },
      row.nuvionCounterpartyId,
      row.nuvionPaymentDetailId,
      (data) =>
        this.prisma.moneyBeneficiary.updateMany({
          where: {
            id: row.id,
            bankCode: row.bankCode,
            accountNumber: row.accountNumber,
            nuvionCheckedAt: null,
          },
          data,
        }),
    );
  }

  /**
   * A person's payout account, as the payee of that person (`person`: their
   * withdrawal) or of WAWU's operational account (`wawu`: a payout to them).
   */
  async forPayoutAccount(
    wawuUserId: string,
    payer: 'person' | 'wawu',
  ): Promise<SendTargetResult> {
    const row = await this.prisma.moneyPayoutAccount.findUnique({
      where: { wawuUserId },
    });
    if (!row) return { state: 'missing' };
    return this.prepare(
      row,
      payer === 'person'
        ? row.nuvionCounterpartyId
        : row.nuvionOperationalCounterpartyId,
      payer === 'person'
        ? row.nuvionPaymentDetailId
        : row.nuvionOperationalPaymentDetailId,
      (data) =>
        this.prisma.moneyPayoutAccount.updateMany({
          where: {
            wawuUserId,
            bankCode: row.bankCode,
            accountNumber: row.accountNumber,
            nuvionCheckedAt: null,
          },
          data,
        }),
    );
  }

  /**
   * Keeps the payee ids a send used or made (the receipt's `payee`) on the
   * saved account, so the next send reuses them. Only when both ids are
   * there, and only while the row still holds the same account: an account
   * changed since never takes the old account's ids.
   */
  async rememberBeneficiaryPayee(
    ownerWawuId: string,
    id: string,
    payee: ProviderPayee | undefined | null,
  ): Promise<void> {
    if (!payee?.counterpartyId || !payee.paymentDetailId) return;
    const row = await this.prisma.moneyBeneficiary.findFirst({
      where: { id, ownerWawuId },
      select: { bankCode: true, accountNumber: true },
    });
    if (!row) return;
    await this.prisma.moneyBeneficiary.updateMany({
      where: {
        id,
        ownerWawuId,
        bankCode: row.bankCode,
        accountNumber: row.accountNumber,
      },
      data: {
        nuvionCounterpartyId: payee.counterpartyId,
        nuvionPaymentDetailId: payee.paymentDetailId,
      },
    });
  }

  async rememberPayoutPayee(
    wawuUserId: string,
    payer: 'person' | 'wawu',
    expect: { bankCode: string; accountNumber: string },
    payee: ProviderPayee | undefined | null,
  ): Promise<void> {
    if (!payee?.counterpartyId || !payee.paymentDetailId) return;
    await this.prisma.moneyPayoutAccount.updateMany({
      where: {
        wawuUserId,
        bankCode: expect.bankCode,
        accountNumber: expect.accountNumber,
      },
      data:
        payer === 'person'
          ? {
              nuvionCounterpartyId: payee.counterpartyId,
              nuvionPaymentDetailId: payee.paymentDetailId,
            }
          : {
              nuvionOperationalCounterpartyId: payee.counterpartyId,
              nuvionOperationalPaymentDetailId: payee.paymentDetailId,
            },
    });
  }

  private async prepare(
    row: Row,
    counterpartyId: string | null,
    paymentDetailId: string | null,
    keep: (data: {
      nuvionBankCode: string;
      nuvionCheckedAt: Date;
    }) => Promise<unknown>,
  ): Promise<SendTargetResult> {
    const payee: ProviderPayee | null =
      counterpartyId && paymentDetailId
        ? { counterpartyId, paymentDetailId }
        : null;
    const target = (bankCode: string): BankSendTarget => ({
      bankCode,
      bankName: row.bankName,
      accountNumber: row.accountNumber,
      accountName: row.accountName,
      payee,
    });

    if (this.provider.name !== 'nuvion') {
      return { state: 'ready', target: target(row.bankCode) };
    }
    if (row.nuvionCheckedAt !== null && row.nuvionBankCode !== null) {
      return { state: 'ready', target: target(row.nuvionBankCode) };
    }

    // Saved in the Fintava days: matched to Nuvion's list, checked by name.
    let list: Map<string, ProviderBank>;
    try {
      list = await this.banks.bankList();
    } catch (e) {
      if (e instanceof MoneyError) return { state: 'unavailable' };
      throw e;
    }
    const bank = matchBank(list, row.bankCode, row.bankName);
    if (!bank) return { state: 'refused', reason: 'bank_not_supported' };

    let answer;
    try {
      answer = await this.provider.checkAccountName({
        accountNumber: row.accountNumber,
        bankCode: bank.code,
      });
    } catch (e) {
      if (!(e instanceof WalletProviderError)) throw e;
      this.logger.warn(
        `a saved account could not be checked by name (${e.kind})`,
      );
      return { state: 'unavailable' };
    }
    if (answer.outcome === 'timeout') return { state: 'unavailable' };
    const holder = answer.accountName?.trim() ?? '';
    if (
      !answer.matched ||
      holder === '' ||
      answer.accountNumber !== row.accountNumber
    ) {
      const why = answer.outcome;
      return {
        state: 'refused',
        reason:
          why === 'bank_not_supported' ||
          why === 'bad_format' ||
          why === 'multiple_matches'
            ? why
            : 'not_found',
      };
    }
    if (nameKey(holder) !== nameKey(row.accountName)) {
      // The same number now has another name: shown and confirmed again,
      // never sent to on the strength of the old one.
      return {
        state: 'name_changed',
        accountName: holder,
        target: { ...target(bank.code), accountName: holder },
      };
    }
    await keep({ nuvionBankCode: bank.code, nuvionCheckedAt: new Date() });
    return { state: 'ready', target: target(bank.code) };
  }
}
