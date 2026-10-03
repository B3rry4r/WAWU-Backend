import {
  applyDecorators,
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { WawuJwtClaims } from '../../common/auth/wawu-jwt-claims.interface';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MoneyError } from '../money-error';
import type { WalletState } from '../money-view.type';
import { stoppedOnIdentity } from '../opening/opening-stops';

/**
 * "No wallet yet" (R-6, task MONEY-13), answered the same way by every
 * wallet and payment route.
 *
 * Nobody has a wallet until they open one, new and existing users alike: a
 * web user with a Flutterwave wallet (`CreatorWallet`) has no Fintava wallet
 * either. A route that reads or moves a person's Naira wallet therefore
 * starts with this gate. It answers, before anything else runs (the PIN, the
 * body, the quote, Fintava):
 *
 * - `409 wallet_not_open` with NO_WALLET_MESSAGE: there is no wallet, so the
 *   app leads to Open your wallet (KYC-05's first step, A26);
 * - `409 wallet_opening` with WALLET_OPENING_MESSAGE: Open your wallet
 *   finished and MONEY-12 is still opening the account (A7's wait).
 *
 * One body per code, whatever the route: the app switches on `reason.code`
 * and may show `message` as it is. `GET /money/wallet` answers the same
 * facts as 200 with `state` (it is how the Wallet tab finds out), read by
 * the same rule (`walletStateOf`), so its `state` and this gate's code can
 * never disagree. The routes of Open your wallet itself (`/money/identity`,
 * `POST /money/wallet/open`) are not gated: they are where the gate leads.
 *
 * `423 wallet_frozen` is not answered here: nothing stores a freeze (mobile
 * repo BACKEND_GAPS G-10), so it comes from Fintava's own refusal on the
 * call a route makes (MONEY-11's balance does this).
 *
 * Reads our database only; never asks Fintava.
 */

/** The one sentence for "no wallet yet", on every route (Default (agent), owner may override). */
export const NO_WALLET_MESSAGE =
  "You don't have a wallet yet. Open your wallet to continue.";

/** The account is still being opened (MONEY-12, A7). */
export const WALLET_OPENING_MESSAGE =
  'Your account is still being opened. Check again in a moment.';

/** The FintavaWalletOpening states that mean an account is on its way (MONEY-12). */
const ON_ITS_WAY = ['opening', 'unknown', 'conflict', 'open'];

/**
 * The one rule for a person's wallet state, from what WAWU stores (MONEY-12):
 *
 * - a FintavaWallet row: `open`;
 * - no row, and an opening that is in flight, unknown, held for review
 *   because the account found is another WAWU account's, or recorded but
 *   not yet visible: `opening`;
 * - otherwise `not_open`: no opening, a `failed` one (the next request may
 *   try again), or one stopped because the phone's Fintava customer is not
 *   this person (`phone_held_by_other_identity`: Open your wallet answers
 *   that refusal itself).
 *
 * `frozen` is never answered from storage (see above).
 */
export function walletStateOf(
  hasWallet: boolean,
  opening: OpeningRecord | null,
): Exclude<WalletState, 'frozen'> {
  return hasWallet ? 'open' : withoutWallet(opening);
}

type OpeningRecord = { state: string; failure: string | null };

/** `walletStateOf` for a person with no FintavaWallet row. */
function withoutWallet(
  opening: OpeningRecord | null,
): Exclude<WalletState, 'open' | 'frozen'> {
  if (
    opening &&
    !stoppedOnIdentity(opening) &&
    ON_ITS_WAY.includes(opening.state)
  ) {
    return 'opening';
  }
  return 'not_open';
}

/** The caller's open wallet, as the gate found it: what a route needs to act on it. */
export interface OpenWallet {
  wawuUserId: string;
  /** Fintava's `userInfo.id`. */
  customerId: string;
  /** Fintava's `wallet.id`. */
  walletId: string;
  accountNumber: string;
}

/** Where the guard leaves the wallet it found, for `@CurrentWallet()`. */
const OPEN_WALLET_KEY = 'wawuOpenWallet';

type GatedRequest = Request & {
  user?: WawuJwtClaims;
  [OPEN_WALLET_KEY]?: OpenWallet;
};

@Injectable()
export class WalletGate {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The caller's open wallet, or the refusal every wallet route answers:
   * `409 wallet_not_open` or `409 wallet_opening`.
   */
  async requireOpen(wawuUserId: string): Promise<OpenWallet> {
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId },
      select: { customerId: true, walletId: true, accountNumber: true },
    });
    if (wallet) return { wawuUserId, ...wallet };
    const opening = await this.prisma.fintavaWalletOpening.findUnique({
      where: { wawuUserId },
      select: { state: true, failure: true },
    });
    throw walletGateRefusal(withoutWallet(opening));
  }
}

/** The refusal for a state that is not `open`. */
export function walletGateRefusal(
  state: Exclude<WalletState, 'open' | 'frozen'>,
): MoneyError {
  return state === 'opening'
    ? new MoneyError('wallet_opening', WALLET_OPENING_MESSAGE)
    : new MoneyError('wallet_not_open', NO_WALLET_MESSAGE);
}

/**
 * Runs the gate for a route (task MONEY-13). Put it on a route with
 * `@RequireOpenWallet()`; a route with `@RequireTransactionPin()` gets it
 * too, ahead of the PIN.
 *
 * It must run after WawuAuthGuard (class guards run before method guards).
 * It runs once per request: a second instance on the same route passes on
 * the wallet the first one found.
 *
 * When it refuses, it drops any `X-Transaction-Pin` header from the
 * request unread, as TransactionPinGuard would have: a person without a
 * wallet never uses up a PIN try, and the PIN they typed reaches nothing
 * that runs after.
 */
@Injectable()
export class WalletGateGuard implements CanActivate {
  constructor(private readonly gate: WalletGate) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<GatedRequest>();
    if (req[OPEN_WALLET_KEY]) return true;
    const wawuUserId = req.user?.sub;
    if (!wawuUserId) {
      throw new Error(
        'WalletGateGuard ran without a signed-in caller: WawuAuthGuard must run first.',
      );
    }
    try {
      req[OPEN_WALLET_KEY] = await this.gate.requireOpen(wawuUserId);
      return true;
    } catch (e) {
      dropTransactionPin(req);
      throw e;
    }
  }
}

/** Removes `X-Transaction-Pin` from `headers` and `rawHeaders` without reading it. */
function dropTransactionPin(req: Request): void {
  delete req.headers['x-transaction-pin'];
  const raw = req.rawHeaders;
  if (!Array.isArray(raw)) return;
  for (let i = raw.length - 2; i >= 0; i -= 2) {
    if (raw[i].toLowerCase() === 'x-transaction-pin') raw.splice(i, 2);
  }
}

/**
 * Put on every route that reads or moves a person's Naira wallet. The route
 * also lists `...WALLET_GATE_ERRORS` in `@MoneyErrors(...)`, and
 * `src/money/gate/tests/wallet-gate-coverage.spec.ts` holds the two
 * together across every mounted controller. The module that owns the route
 * imports MoneyModule (it exports the gate).
 */
export function RequireOpenWallet(): MethodDecorator {
  return applyDecorators(UseGuards(WalletGateGuard));
}

/** The wallet `@RequireOpenWallet()` found for this request. */
export const CurrentWallet = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): OpenWallet => {
    const wallet = ctx.switchToHttp().getRequest<GatedRequest>()[
      OPEN_WALLET_KEY
    ];
    if (!wallet) {
      throw new Error(
        '@CurrentWallet() on a route without @RequireOpenWallet(): the gate must run first.',
      );
    }
    return wallet;
  },
);
