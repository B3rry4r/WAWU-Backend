import { Injectable, Logger } from '@nestjs/common';
import { FintavaClient } from '../../fintava/fintava-client';
import { FINTAVA_DEFAULTS } from '../../fintava/fintava-config';
import {
  FintavaError,
  type FintavaErrorKind,
} from '../../fintava/fintava-error';
import type { FintavaBank } from '../../fintava/fintava.interface';
import { MoneyError } from '../money-error';
import type { BankAccountView } from '../money-view.type';

/** The bank did not confirm the account (W8, A21): `422 name_check_failed`. */
export const NAME_CHECK_FAILED_MESSAGE =
  'We could not confirm that account. Check the bank and the account number.';

/** Fintava did not answer: `503 provider_unreachable`. */
export const BANK_UNREACHABLE_MESSAGE =
  'We could not reach the bank right now. Try again in a moment.';

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
const ACCOUNT_REFUSED: readonly FintavaErrorKind[] = [
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
 */
@Injectable()
export class BankAccountCheckService {
  private readonly logger = new Logger(BankAccountCheckService.name);
  private banks: { at: number; byCode: Map<string, FintavaBank> } | null = null;
  private fetching: Promise<Map<string, FintavaBank>> | null = null;

  constructor(private readonly fintava: FintavaClient) {}

  /** The account as the bank names it, or a refusal in the contract's shape. */
  async check(
    bankCode: string,
    accountNumber: string,
  ): Promise<BankAccountView> {
    if (this.fintava.environment === 'unconfigured') throw this.unreachable();
    const bank = (await this.bankList()).get(bankCode);
    if (!bank) {
      throw new MoneyError('name_check_failed', NAME_CHECK_FAILED_MESSAGE);
    }
    let answer: Awaited<ReturnType<FintavaClient['bankNameEnquiry']>>;
    try {
      answer = await this.fintava.bankNameEnquiry(accountNumber, bankCode);
    } catch (e) {
      throw this.refusal(e);
    }
    const accountName = answer.accountName?.trim() ?? '';
    if (
      !answer.matched ||
      accountName === '' ||
      answer.accountNumber !== accountNumber
    ) {
      throw new MoneyError('name_check_failed', NAME_CHECK_FAILED_MESSAGE);
    }
    return { bankCode, bankName: bank.name, accountNumber, accountName };
  }

  /**
   * Fintava's list, kept for BANK_LIST_TTL_MS. One fetch at a time: saves
   * that arrive while it is being fetched wait for that same answer rather
   * than each asking Fintava (single flight). A failed fetch is not kept.
   */
  private bankList(): Promise<Map<string, FintavaBank>> {
    if (this.banks && Date.now() - this.banks.at < BANK_LIST_TTL_MS) {
      return Promise.resolve(this.banks.byCode);
    }
    this.fetching ??= this.fetchBanks().finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  private async fetchBanks(): Promise<Map<string, FintavaBank>> {
    let list: FintavaBank[];
    try {
      list = await this.fintava.listBanks();
    } catch (e) {
      throw this.refusal(e, true);
    }
    const byCode = new Map(list.map((b) => [b.code, b]));
    this.banks = { at: Date.now(), byCode };
    return byCode;
  }

  /** A failed Fintava call, in the contract's shape. Fintava's text never reaches the app. */
  private refusal(e: unknown, listing = false): unknown {
    if (!(e instanceof FintavaError)) return e;
    if (!listing && ACCOUNT_REFUSED.includes(e.kind)) {
      return new MoneyError('name_check_failed', NAME_CHECK_FAILED_MESSAGE);
    }
    this.logger.warn(
      `${listing ? 'bank list' : 'name check'}: Fintava ${e.kind}${
        e.httpStatus === null ? '' : ` HTTP ${e.httpStatus}`
      }`,
    );
    return this.unreachable();
  }

  private unreachable(): MoneyError {
    return new MoneyError('provider_unreachable', BANK_UNREACHABLE_MESSAGE, {
      retryAfterSeconds: FINTAVA_DEFAULTS.retryAfterSeconds,
    });
  }
}
