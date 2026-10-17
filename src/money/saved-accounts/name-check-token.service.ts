import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { FeeSettings } from '../fees/fee-config';
import type { BankAccountView } from '../money-view.type';
import { nameKey, normalizeBankName } from './saved-account-target.service';

/** How long the name a person was shown stays the name they may send to. */
export const NAME_CHECK_TOKEN_MS = 15 * 60_000;

/** Domain separation: a name token is never a fee quote, and the other way round. */
const TOKEN_CONTEXT = 'wawu-name-check.v1.';

/** What a name token carries. Short keys: it travels in the send. */
interface NameClaims {
  v: 1;
  /** wawuUserId the check was made for. */
  u: string;
  /** The bank code the person chose. */
  b: string;
  /** The account number. */
  a: string;
  /** The holder's name as the bank gave it, normalised (`nameKey`). */
  n: string;
  /** The bank's name there, normalised. */
  k: string;
  /** Expires at, in epoch milliseconds. */
  x: number;
}

const b64url = (b: Buffer) => b.toString('base64url');

/**
 * Binds a send to an unsaved account to the name the person was shown
 * (task WALLET-09 round 2, verifier finding 7): `POST /money/banks/name-check`
 * returns a token that says "this person saw this holder at this bank for
 * this account number"; the send carries it, and when the bank names another
 * holder at send time the send is `409 account_name_changed` and nothing is
 * sent. Signed with the fee quote's key (so it needs no setting of its own)
 * under its own context, so a quote token cannot stand for it. Short-lived
 * (NAME_CHECK_TOKEN_MS). Holds nothing and reads no database.
 */
@Injectable()
export class NameCheckTokenService {
  constructor(private readonly settings: FeeSettings) {}

  /** A token for what `owner` was just shown. */
  issue(owner: string, shown: BankAccountView, now = new Date()): string {
    const claims: NameClaims = {
      v: 1,
      u: owner,
      b: shown.bankCode,
      a: shown.accountNumber,
      n: nameKey(shown.accountName),
      k: normalizeBankName(shown.bankName),
      x: now.getTime() + NAME_CHECK_TOKEN_MS,
    };
    const payload = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
    return `${payload}.${b64url(this.mac(payload))}`;
  }

  /**
   * True when `token` is one this server signed, for this person, this bank
   * code and this account number, not past its time, and the bank names the
   * same holder at the same bank now (`now` is the bank's answer, not the
   * app's). Anything else, including no token, is false.
   */
  matches(
    token: unknown,
    owner: string,
    now: BankAccountView,
    at = new Date(),
  ): boolean {
    const claims = this.read(token);
    return (
      claims !== null &&
      claims.u === owner &&
      claims.b === now.bankCode &&
      claims.a === now.accountNumber &&
      claims.n === nameKey(now.accountName) &&
      claims.k === normalizeBankName(now.bankName) &&
      claims.x > at.getTime()
    );
  }

  private mac(payload: string): Buffer {
    return createHmac('sha256', this.settings.quoteKey())
      .update(TOKEN_CONTEXT + payload)
      .digest();
  }

  private read(token: unknown): NameClaims | null {
    if (typeof token !== 'string' || token.length > 1024) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    const expected = this.mac(payload);
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return null;
    }
    try {
      const claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as NameClaims;
      return claims && claims.v === 1 ? claims : null;
    } catch {
      return null;
    }
  }
}
