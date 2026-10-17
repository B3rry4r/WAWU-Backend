import {
  BadRequestException,
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import {
  BANK_CODE_MESSAGE,
  BANK_CODE_PATTERN,
  NUBAN_MESSAGE,
  NUBAN_PATTERN,
} from '../dto/money-request.dto';
import { dropTransactionPin } from '../gate/wallet-gate';
import { MoneyError } from '../money-error';
import {
  BANK_UNREACHABLE_MESSAGE,
  BankAccountCheckService,
  NAME_CHECK_ANSWERS,
  NAME_CHECK_FAILED_MESSAGE,
} from '../saved-accounts/bank-account-check.service';
import { NameCheckBudget } from '../saved-accounts/name-check-budget';
import { NameCheckTokenService } from '../saved-accounts/name-check-token.service';
import {
  type BankSendTarget,
  normalizeBankName,
  nameKey,
  SavedAccountTargetService,
  type SendTargetResult,
} from '../saved-accounts/saved-account-target.service';
import { SELF_TRANSFER_MESSAGE } from './transfer-recipient';

/**
 * A saved account whose bank or holder is not the one kept (task WALLET-09,
 * lead notes N3 and N5): shown to the person with the bank's name and the
 * holder's name as they stand now, and sent to only after they confirm it
 * (saving the account again). One sentence for both, because the app shows
 * both names beside it.
 */
export const ACCOUNT_CHANGED_MESSAGE =
  'Check the bank and the name on this account, then confirm that it is the right one.';

/**
 * The route's `400` for a send to an account that is not saved and carries no
 * `nameToken` (FIX-41): the person must have seen the name the bank gives
 * before the money goes there. One plain sentence for the app to show.
 */
export const NAME_TOKEN_REQUIRED_MESSAGE =
  'Check the name on this account first, then send again.';

/**
 * How the bank is asked about an account that is not saved: the check is
 * handed in, and the caller decides whether it spends one of the person's
 * hourly name checks (WALLET-37 round 5). Saved accounts do not use it.
 */
export type UnsavedEnquiry = <T>(ask: () => Promise<T>) => Promise<T>;

/** Where the bank send found its place: a saved place, so its payee ids are kept after the send. */
export type BankSendPlace =
  | { kind: 'beneficiary'; id: string }
  | { kind: 'payout'; bankCode: string }
  | null;

/** Who a bank send goes to, once the bank has been asked. */
export interface ResolvedBankTarget {
  /** Where to send: the bank's code in the provider's list, its name there, and the holder's name now. */
  target: BankSendTarget;
  /** The saved place this account is (a beneficiary of the sender's, or their payout account), if any. */
  place: BankSendPlace;
}

/** Where the guard leaves what it resolved, for `@CurrentBankTarget()`. */
export const BANK_TARGET_KEY = 'wawuBankSendTarget';

export type TargetRequest = Request & {
  user?: WawuJwtClaims;
  [BANK_TARGET_KEY]?: ResolvedBankTarget;
};

/**
 * Who a send to a bank account may go to, and the one place it is decided
 * (task WALLET-09; NUV-06's lead notes N3 and N5). `bankTransfer` sends
 * whatever it is asked, so this is the only gate:
 *
 * - **Never to yourself:** a bank send to the sender's own wallet at the
 *   provider's own bank is `400 self_transfer`.
 * - **The bank is asked, every time.** The name check runs again just before
 *   the send, with the provider's bank code, and the send goes to the name
 *   and the bank name the bank gave: the app never sends a name. No answer
 *   in time is `503 provider_unreachable`; an account the bank does not
 *   confirm is `422 name_check_failed` with the sentence that says why.
 * - **A saved account** (one of the sender's beneficiaries, or their payout
 *   account) goes through `SavedAccountTargetService`: `ready` sends to the
 *   target it names (the provider's code for the bank, the payee ids kept);
 *   `refused` and `unavailable` send nothing. Its kept holder name, and the
 *   bank's name kept with the row against the provider's name for the code
 *   (a code that is another bank in the provider's list is not the bank that
 *   was saved), are compared with the answer of the check just made: any
 *   difference is `409 account_name_changed`, carrying both names as they
 *   stand now, and nothing is sent until the person confirms them by saving
 *   the account again.
 * - **Any other account** is sent to as the check just made names it.
 *
 * Reads our own database and asks the bank (free); it moves nothing.
 */
@Injectable()
export class BankSendTargets {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly banks: BankAccountCheckService,
    private readonly saved: SavedAccountTargetService,
  ) {}

  async resolve(
    owner: string,
    bankCode: string,
    accountNumber: string,
    unsavedEnquiry?: UnsavedEnquiry,
  ): Promise<ResolvedBankTarget> {
    await this.assertNotOwnWallet(owner, bankCode, accountNumber);

    let place = await this.placeOf(owner, bankCode, accountNumber);
    let prepared: SendTargetResult | null = null;
    if (place) {
      prepared =
        place.kind === 'beneficiary'
          ? await this.saved.forBeneficiary(owner, place.id)
          : await this.saved.forPayoutAccount(owner, 'person');
      if (prepared.state === 'missing') {
        // The place went between the two reads: sent to as any other account.
        place = null;
        prepared = null;
      } else if (prepared.state === 'unavailable') {
        throw this.unreachable();
      } else if (prepared.state === 'refused') {
        throw new MoneyError(
          'name_check_failed',
          NAME_CHECK_ANSWERS[prepared.reason] ?? NAME_CHECK_FAILED_MESSAGE,
        );
      }
    }

    const kept =
      prepared &&
      (prepared.state === 'ready' || prepared.state === 'name_changed')
        ? prepared.target
        : null;
    // The bank, asked now, with the code the provider knows the bank by. An
    // account that is not saved is asked through `unsavedEnquiry`, which may
    // count the enquiry or refuse it before the bank is reached.
    const ask = () =>
      this.banks.check(kept?.bankCode ?? bankCode, accountNumber);
    const live = await (place === null && unsavedEnquiry
      ? unsavedEnquiry(ask)
      : ask());

    if (kept && prepared) {
      const holderChanged =
        prepared.state === 'name_changed' ||
        nameKey(live.accountName) !== nameKey(kept.accountName);
      const bankChanged =
        normalizeBankName(live.bankName) !== normalizeBankName(kept.bankName);
      if (holderChanged || bankChanged) {
        throw new MoneyError('account_name_changed', ACCOUNT_CHANGED_MESSAGE, {
          accountName: live.accountName,
          bankName: live.bankName,
        });
      }
    }
    return {
      target: {
        bankCode: live.bankCode,
        bankName: live.bankName,
        accountNumber: live.accountNumber,
        accountName: live.accountName,
        payee: kept?.payee ?? null,
      },
      place,
    };
  }

  /** The sender's own wallet, named as a bank account at the provider's own bank. */
  private async assertNotOwnWallet(
    owner: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<void> {
    if (this.provider.walletBankCode === '') return;
    if (bankCode !== this.provider.walletBankCode) return;
    const own = await this.prisma.fintavaWallet.findFirst({
      where: { wawuUserId: owner, accountNumber },
      select: { wawuUserId: true },
    });
    if (own) throw new MoneyError('self_transfer', SELF_TRANSFER_MESSAGE);
  }

  /**
   * The saved place the typed account is: one of the sender's beneficiaries
   * (matched on the code it was saved with, or the provider's code kept on
   * it), else their payout account.
   */
  private async placeOf(
    owner: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<BankSendPlace> {
    const beneficiary = await this.prisma.moneyBeneficiary.findFirst({
      where: {
        ownerWawuId: owner,
        kind: 'bank_account',
        accountNumber,
        OR: [{ bankCode }, { nuvionBankCode: bankCode }],
      },
      select: { id: true },
    });
    if (beneficiary) return { kind: 'beneficiary', id: beneficiary.id };
    const payout = await this.prisma.moneyPayoutAccount.findFirst({
      where: {
        wawuUserId: owner,
        accountNumber,
        OR: [{ bankCode }, { nuvionBankCode: bankCode }],
      },
      select: { bankCode: true },
    });
    return payout ? { kind: 'payout', bankCode: payout.bankCode } : null;
  }

  private unreachable(): MoneyError {
    return new MoneyError('provider_unreachable', BANK_UNREACHABLE_MESSAGE, {
      retryAfterSeconds: this.provider.timings.retryAfterSeconds,
    });
  }
}

/**
 * Runs `BankSendTargets.resolve` for the account the request names, after
 * the wallet gate and the Idempotency-Key (a repeat of a finished send is
 * answered first, whatever has happened to the account since) and BEFORE the
 * PIN guard (`RequireIdempotentApproval(route, ...guards)`), so a person never
 * types a PIN for a send that could not have gone, and a refusal here uses no
 * PIN try and gives the key back. It leaves what it resolved on the request,
 * so the send does not ask the bank a second time.
 *
 * - **A bank code or account number that is not one is the route's own 400**
 *   (the sentence the ValidationPipe gives for the field), answered here
 *   before the bank is asked or the PIN looked at: guards run before pipes,
 *   so the body is read raw, and the handler's `@CurrentBankTarget()` could
 *   not run without a target (round 2, verifier finding 1). The rest of the
 *   body is the pipe's, after the PIN.
 * - **An account that is not saved is bound to the name the person saw**
 *   (round 2, finding 7; FIX-41): the send carries the `nameToken` of the
 *   name check, and a send without one is the route's `400` (a plain
 *   sentence, nothing sent, no PIN try used, the key given back). When the
 *   bank names another holder now (or the token is not this person's, this
 *   account's, or is old), it is `409 account_name_changed` with the names
 *   as they stand, and nothing is sent. A saved account (a beneficiary, or
 *   the payout account a withdrawal goes to) is compared with the name kept
 *   for it, as before, and needs no token.
 *
 * - **Asking the bank about an account that is not saved is a name check**
 *   (WALLET-37 round 5; R-51, G-764): unless the send carries a token this
 *   person got for this bank code and account number (and it is not old), it
 *   spends one of their 30 an hour like `POST /money/banks/name-check`, and
 *   past them the answer is `429 name_check_rate_limited` with the bank not
 *   asked, so no holder name comes back. A saved account is never counted.
 *
 * A refusal here drops any PIN or biometric header unread, as the wallet gate
 * does.
 */
@Injectable()
export class BankSendTargetGuard implements CanActivate {
  constructor(
    private readonly targets: BankSendTargets,
    private readonly nameTokens: NameCheckTokenService,
    private readonly budget: NameCheckBudget,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<TargetRequest>();
    const owner = req.user?.sub;
    if (!owner) {
      throw new Error(
        'BankSendTargetGuard ran without a signed-in caller: WawuAuthGuard must run first.',
      );
    }
    const body = req.body as
      | { bankCode?: unknown; accountNumber?: unknown; nameToken?: unknown }
      | undefined;
    const { bankCode, accountNumber, nameToken } = body ?? {};
    try {
      if (typeof bankCode !== 'string' || !BANK_CODE_PATTERN.test(bankCode)) {
        throw new BadRequestException(BANK_CODE_MESSAGE);
      }
      if (
        typeof accountNumber !== 'string' ||
        !NUBAN_PATTERN.test(accountNumber)
      ) {
        throw new BadRequestException(NUBAN_MESSAGE);
      }
      if (nameToken !== undefined && typeof nameToken !== 'string') {
        throw new BadRequestException('nameToken must be a string');
      }
      // Asking the bank for an account that is not saved, with a name token
      // the person did not get for this account (or none), is a name check
      // like any other: it spends one of their 30 an hour, and past them the
      // bank is not asked and no name comes back (WALLET-37 round 5, G-764).
      // A send with a token this person got for this account, or to a saved
      // account, is the send's own check and is not counted. A bank that
      // cannot answer gives the place back.
      const res = context.switchToHttp().getResponse<Response>();
      const unsavedEnquiry: UnsavedEnquiry = (ask) =>
        this.nameTokens.issuedFor(nameToken, owner, bankCode, accountNumber)
          ? ask()
          : this.budget.run(owner, res, ask);
      const resolved = await this.targets.resolve(
        owner,
        bankCode,
        accountNumber,
        unsavedEnquiry,
      );
      if (resolved.place === null) {
        // An account that is not saved is sent to only under the name the
        // person was shown (FIX-41): a send with no token is refused here,
        // before the PIN, with nothing sent and the key given back.
        if (nameToken === undefined) {
          throw new BadRequestException(NAME_TOKEN_REQUIRED_MESSAGE);
        }
        const now = resolved.target;
        if (!this.nameTokens.matches(nameToken, owner, now)) {
          throw new MoneyError(
            'account_name_changed',
            ACCOUNT_CHANGED_MESSAGE,
            {
              accountName: now.accountName,
              bankName: now.bankName,
            },
          );
        }
      }
      req[BANK_TARGET_KEY] = resolved;
      return true;
    } catch (e) {
      dropTransactionPin(req);
      throw e;
    }
  }
}

/** The target the guard resolved, for the send handler. */
export const CurrentBankTarget = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ResolvedBankTarget => {
    const target = ctx.switchToHttp().getRequest<TargetRequest>()[
      BANK_TARGET_KEY
    ];
    if (!target) {
      throw new Error(
        '@CurrentBankTarget() on a route without BankSendTargetGuard.',
      );
    }
    return target;
  },
);
