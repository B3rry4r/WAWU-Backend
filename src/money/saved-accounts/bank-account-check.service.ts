import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type ProviderAccountName,
  type ProviderBank,
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import {
  WalletProviderError,
  type WalletProviderErrorKind,
} from '../../wallet-provider/wallet-provider-error';
import { MoneyError } from '../money-error';
import type { BankAccountView } from '../money-view.type';

/** The bank did not confirm the account (W8, A21): `422 name_check_failed`. */
export const NAME_CHECK_FAILED_MESSAGE =
  'We could not confirm that account. Check the bank and the account number.';

/** Fintava did not answer: `503 provider_unreachable`. */
export const BANK_UNREACHABLE_MESSAGE =
  'We could not reach the bank right now. Try again in a moment.';

/**
 * A name check that did not confirm the account, by why (NUV-06, lead ruling
 * 2): each its own plain sentence, none naming a provider. All are
 * `422 name_check_failed`, so the app's switch on `reason.code` is
 * unchanged; the sentence tells the person what to fix. A provider whose
 * check says only yes or no (Fintava's) gets NAME_CHECK_FAILED_MESSAGE.
 */
export const NAME_CHECK_ANSWERS = {
  not_found: 'We could not find an account with that number at that bank.',
  bank_not_supported:
    'We cannot check accounts at that bank yet. Choose another bank.',
  bad_format:
    'An account number has ten digits. Check the number and the bank.',
  multiple_matches:
    'More than one account matched. Check the number and the bank.',
} as const;

/**
 * How long Fintava's bank list is kept in memory before it is asked for
 * again. The list is the same 358 banks run after run (mobile repo
 * `docs/fintava/sandbox/01-bank-list.md`); an hour keeps a save to one
 * Fintava call (the name check) without holding a stale list for long.
 * Default (agent), owner may override.
 */
export const BANK_LIST_TTL_MS = 60 * 60_000;

/**
 * Fintava kinds that are the bank, or Fintava, saying "no such account":
 * the person can fix them by checking what they typed. Everything else
 * (no answer, a 5xx, a key or merchant problem, a rate limit, an unreadable
 * answer) is Fintava being unavailable, answered 503 with nothing saved.
 */
const ACCOUNT_REFUSED: readonly WalletProviderErrorKind[] = [
  'refused',
  'validation',
  'not_found',
];

/**
 * Checks a bank account before it is saved (task WALLET-14): the bank code
 * must be one in Fintava's bank list (`GET /banks`), and Fintava's name check
 * (`GET /name/enquiry`, free, MONEY-06) must confirm the account and give its
 * holder's name. The name kept is always the bank's, never one the app sent.
 * A name check that does not confirm the account saves nothing.
 *
 * Nothing here is logged with the account number or the name: the MONEY-06
 * client logs no URL or body, and this file logs nothing of its own.
 *
 * Both calls go through the wallet provider seam (MONEY-20): the bank list
 * and the name check are `WalletProvider.listBanks` and `checkAccountName`
 * (Fintava's `GET /banks` and `GET /name/enquiry`; Nuvion's bank codes and
 * `POST /counterparty-lookups`).
 */
@Injectable()
export class BankAccountCheckService {
  private readonly logger = new Logger(BankAccountCheckService.name);
  private banks: { at: number; byCode: Map<string, ProviderBank> } | null =
    null;
  private fetching: Promise<Map<string, ProviderBank>> | null = null;

  constructor(
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
  ) {}

  /** The account as the bank names it, or a refusal in the contract's shape. */
  async check(
    bankCode: string,
    accountNumber: string,
  ): Promise<BankAccountView> {
    if (!this.provider.configured) throw this.unreachable();
    const bank = (await this.bankList()).get(bankCode);
    if (!bank) {
      throw new MoneyError('name_check_failed', NAME_CHECK_FAILED_MESSAGE);
    }
    let answer: ProviderAccountName;
    try {
      answer = await this.provider.checkAccountName({
        accountNumber,
        bankCode,
      });
    } catch (e) {
      throw this.refusal(e);
    }
    // No answer in time says nothing about the account: the person is told
    // to try again, not that the account is wrong (NUV-06).
    if (answer.outcome === 'timeout') throw this.unreachable();
    const accountName = answer.accountName?.trim() ?? '';
    if (
      !answer.matched ||
      accountName === '' ||
      answer.accountNumber !== accountNumber
    ) {
      const why =
        answer.outcome !== undefined && answer.outcome !== 'matched'
          ? answer.outcome
          : null;
      throw new MoneyError(
        'name_check_failed',
        why === null ? NAME_CHECK_FAILED_MESSAGE : NAME_CHECK_ANSWERS[why],
      );
    }
    return { bankCode, bankName: bank.name, accountNumber, accountName };
  }

  /**
   * What a row saved from this check records about it (NUV-06): under Nuvion
   * the bank's code in Nuvion's list and when the name was confirmed, so the
   * row is not checked again before its first Nuvion send; under any other
   * provider nothing (the row is checked by name before its first Nuvion
   * send, the Fintava days' rule).
   */
  checkedStamp(bankCode: string): {
    nuvionBankCode: string | null;
    nuvionCheckedAt: Date | null;
  } {
    return this.provider.name === 'nuvion'
      ? { nuvionBankCode: bankCode, nuvionCheckedAt: new Date() }
      : { nuvionBankCode: null, nuvionCheckedAt: null };
  }

  /**
   * Fintava's list, kept for BANK_LIST_TTL_MS. One fetch at a time: saves
   * that arrive while it is being fetched wait for that same answer rather
   * than each asking Fintava (single flight). A failed fetch is not kept.
   */
  bankList(): Promise<Map<string, ProviderBank>> {
    if (this.banks && Date.now() - this.banks.at < BANK_LIST_TTL_MS) {
      return Promise.resolve(this.banks.byCode);
    }
    this.fetching ??= this.fetchBanks().finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  private async fetchBanks(): Promise<Map<string, ProviderBank>> {
    let list: ProviderBank[];
    try {
      list = await this.provider.listBanks();
    } catch (e) {
      throw this.refusal(e, true);
    }
    const byCode = new Map(list.map((b) => [b.code, b]));
    this.banks = { at: Date.now(), byCode };
    return byCode;
  }

  /** A failed provider call, in the contract's shape. The provider's text never reaches the app. */
  private refusal(e: unknown, listing = false): unknown {
    if (!(e instanceof WalletProviderError)) return e;
    if (!listing && ACCOUNT_REFUSED.includes(e.kind)) {
      return new MoneyError('name_check_failed', NAME_CHECK_FAILED_MESSAGE);
    }
    this.logger.warn(
      `${listing ? 'bank list' : 'name check'}: ${this.provider.label} ${e.kind}${
        e.httpStatus === null ? '' : ` HTTP ${e.httpStatus}`
      }`,
    );
    return this.unreachable();
  }

  private unreachable(): MoneyError {
    return new MoneyError('provider_unreachable', BANK_UNREACHABLE_MESSAGE, {
      retryAfterSeconds: this.provider.timings.retryAfterSeconds,
    });
  }
}
