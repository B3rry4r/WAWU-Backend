import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Settings for opening a person's Fintava account and showing it (task
 * MONEY-12). None is required: the server starts without any of them.
 */
export const WALLET_OPENING_CONFIG_KEYS = {
  bankName: 'WALLET_BANK_NAME',
  licenceLine: 'WALLET_LICENCE_LINE',
  depositInsuranceLine: 'WALLET_DEPOSIT_INSURANCE_LINE',
} as const;

/**
 * PROVISIONAL(WALLET-BANK-NAME, owner=YOU, why=Fintava's create answer names no bank and Fintava spells its bank three ways; R-1 leaves the wording to the owner)
 *
 * The bank shown beside the account number (W1, W15, A8). Fintava's create
 * answer carries no bank name. Its transaction records for these very
 * wallets say "Loma Bank" (`senderBank`, `receiverBank`, mobile repo
 * `docs/fintava/sandbox/11-transaction-by-reference.md`), its bank list says
 * "LOMA BANK" and its account examples "Iyin Ekiti Microfinance Bank Limited
 * (Loma Bank)" (`docs/contract/WALLET.md` section 4, item 5). Overridable
 * with WALLET_BANK_NAME. The code is Fintava's own, `090620`
 * (FINTAVA_WALLET_BANK_CODE).
 */
export const DEFAULT_WALLET_BANK_NAME = 'Loma Bank';

/**
 * How account opening finds a lost answer (wallet-opening.service.ts).
 * Fixed, not config: none is a fee, a limit or a promise.
 */
export const WALLET_OPENING_DEFAULTS = {
  /** Openings the sweep looks at per pass, oldest first. */
  batch: 20,
  /** Pages of `/customers/list` read when looking for a lost create. */
  listPages: 10,
  /** Rows per page (Fintava's largest). */
  listTake: 100,
  /**
   * How much older than the attempt a list row may be and still be looked
   * at: our clock and Fintava's may differ.
   */
  clockSkewMs: 5 * 60_000,
  /**
   * Added to the money timeout before an `opening` row whose request never
   * finished (the server stopped mid-way) is treated as a lost answer.
   */
  stuckAfterMs: 60_000,
  /** Fintava is asked about one lost answer at most this often. */
  recheckAfterMs: 15_000,
} as const;

function line(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  return v === '' ? null : v;
}

/** Read once at boot. */
@Injectable()
export class WalletOpeningSettings {
  readonly bankName: string;
  /** Licence wording, filled in by the owner (R-1). Null hides the line. */
  readonly licenceLine: string | null;
  /** Deposit-insurance wording, filled in by the owner (R-1). Null hides the line. */
  readonly depositInsuranceLine: string | null;

  constructor(config: ConfigService) {
    const get = (key: string) => config.get<string>(key);
    this.bankName =
      line(get(WALLET_OPENING_CONFIG_KEYS.bankName)) ??
      DEFAULT_WALLET_BANK_NAME;
    this.licenceLine = line(get(WALLET_OPENING_CONFIG_KEYS.licenceLine));
    this.depositInsuranceLine = line(
      get(WALLET_OPENING_CONFIG_KEYS.depositInsuranceLine),
    );
  }
}
