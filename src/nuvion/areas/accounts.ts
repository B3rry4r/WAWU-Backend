import type {
  ProviderBalance,
  ProviderCustomer,
  WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type { NuvionClient, NuvionOp } from '../nuvion-client';
import { NuvionError } from '../nuvion-error';

const AREA = 'accounts (NUV-04)';

/** The one currency this task's account is in (NUV-09 owns the dollar one). */
export const NUVION_NAIRA = 'NGN';

/** A Nuvion id we put in a path or a query: Nuvion's are ULIDs. */
const NUVION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A Nigerian account number (NUBAN): ten digits. */
const NUBAN = /^\d{10}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** A whole number Nuvion sent as a number (amounts are in the smallest unit). */
function whole(o: Record<string, unknown>, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

/** `deleted` is 0 for a live record; anything else (or a missing one read as 0). */
function deleted(o: Record<string, unknown>): boolean {
  const v = o.deleted;
  return v !== undefined && v !== null && v !== 0;
}

/**
 * The wallet id this area hands out for a Nuvion account, and takes back in
 * `getBalance`. Reading an account of a child entity needs both ids
 * (`GET /accounts/{account_id}?entity_id=`, api-reference__accounts.md), and
 * the seam passes only `walletId`, so the id holds both: `<entity>:<account>`.
 * FintavaWallet.walletId stores it for a Nuvion wallet (provider `nuvion`);
 * NuvionEntity keeps the two ids apart (`entityId`, `accountId`).
 */
export function nuvionWalletId(entityId: string, accountId: string): string {
  if (!NUVION_ID.test(entityId) || !NUVION_ID.test(accountId)) {
    throw new RangeError('A Nuvion id is not in the form Nuvion uses.');
  }
  return `${entityId}:${accountId}`;
}

/** The two ids in a wallet id this area made, or null when it is not one. */
export function readNuvionWalletId(
  walletId: string,
): { entityId: string; accountId: string } | null {
  const parts = walletId.split(':');
  if (parts.length !== 2) return null;
  const [entityId, accountId] = parts;
  if (!NUVION_ID.test(entityId) || !NUVION_ID.test(accountId)) return null;
  return { entityId, accountId };
}

/** True when `id` is safe to put in a Nuvion path or query. */
export function isNuvionId(id: unknown): id is string {
  return typeof id === 'string' && NUVION_ID.test(id);
}

/** One account as Nuvion describes it (api-reference__accounts.md), the fields we use. */
export interface NuvionAccountReading {
  id: string;
  entityId: string | null;
  type: string | null;
  currency: string | null;
  nuvionBan: string | null;
  /** `balance.available`: what can be spent. Null when not a whole number. */
  available: number | null;
  /** `balance.current`: including what is pending settlement. */
  current: number | null;
  deleted: boolean;
}

/**
 * An account object, from wherever an answer or a delivery puts it:
 * `data.account` (GET /accounts/{id}, POST /accounts, accounts.created), or
 * the object itself (a list row). Null when it carries no id.
 */
export function readNuvionAccount(raw: unknown): NuvionAccountReading | null {
  const o = isRecord(raw) && isRecord(raw.account) ? raw.account : raw;
  if (!isRecord(o)) return null;
  const id = text(o, 'id');
  if (!id) return null;
  const balance = isRecord(o.balance) ? o.balance : {};
  return {
    id,
    entityId: text(o, 'entity_id'),
    type: text(o, 'type'),
    currency: text(o, 'currency')?.toUpperCase() ?? null,
    nuvionBan: text(o, 'nuvion_ban'),
    available: whole(balance, 'available'),
    current: whole(balance, 'current'),
    deleted: deleted(o),
  };
}

/** One set of account details (api-reference__account-details.md), the fields we use. */
export interface NuvionAccountDetailsReading {
  id: string;
  entityId: string | null;
  accountId: string | null;
  /** Nuvion's word: `pending` while provisioned, `active` when ready. */
  status: string | null;
  /** Absent while `pending` (fiat). */
  accountNumber: string | null;
  /** The account holder's name: what a payer's bank shows. */
  beneficiaryName: string | null;
  /** The issuing bank's name: `issuer.meta.bank_name`, else `issuer.name`. */
  issuerName: string | null;
  issuerCode: string | null;
  currency: string | null;
  assetType: string | null;
  deleted: boolean;
}

/**
 * Account details, from wherever an answer or a delivery puts them:
 * `data.account_detail` (GET /account-details/{id}), `data.account_details`
 * (POST /account-details, account_details.created), or the object itself
 * (a list row, account_details.updated). Null when it carries no id.
 */
export function readNuvionAccountDetails(
  raw: unknown,
): NuvionAccountDetailsReading | null {
  let o: unknown = raw;
  if (isRecord(raw) && isRecord(raw.account_detail)) o = raw.account_detail;
  else if (isRecord(raw) && isRecord(raw.account_details)) {
    o = raw.account_details;
  }
  if (!isRecord(o)) return null;
  const id = text(o, 'id');
  if (!id) return null;
  const issuer = isRecord(o.issuer) ? o.issuer : {};
  const meta = isRecord(issuer.meta) ? issuer.meta : {};
  return {
    id,
    entityId: text(o, 'entity_id'),
    accountId: text(o, 'account_id'),
    status: text(o, 'status')?.toLowerCase() ?? null,
    accountNumber: text(o, 'account_number'),
    beneficiaryName: text(o, 'beneficiary_name'),
    issuerName: text(meta, 'bank_name') ?? text(issuer, 'name'),
    issuerCode: text(issuer, 'code'),
    currency: text(o, 'currency')?.toUpperCase() ?? null,
    assetType: text(o, 'asset_type')?.toLowerCase() ?? null,
    deleted: deleted(o),
  };
}

/**
 * Why a set of account details cannot be shown as a person's naira account
 * number, or null when it can: it must be `active`, live, fiat, in naira,
 * of this entity and account, and carry a ten-digit account number. Pending
 * details are not an error: the answer is the word `pending` (their number
 * is on its way).
 */
export function nairaDetailsProblem(
  d: NuvionAccountDetailsReading,
  expect: { entityId: string; accountId: string | null },
): string | null {
  if (d.entityId !== null && d.entityId !== expect.entityId) {
    return 'the account details belong to another entity';
  }
  if (expect.accountId !== null && d.accountId !== expect.accountId) {
    return 'the account details belong to another account';
  }
  if (d.deleted) return 'the account details are deleted';
  if (d.currency !== null && d.currency !== NUVION_NAIRA) {
    return `the account details are in ${d.currency}, not naira`;
  }
  if (d.assetType !== null && d.assetType !== 'fiat') {
    return 'the account details are not a bank account';
  }
  if (d.status !== 'active') return 'pending';
  if (!d.accountNumber || !NUBAN.test(d.accountNumber)) {
    return 'the active account details carry no ten-digit account number';
  }
  return null;
}

/**
 * The account, its account number and its balance (task NUV-04): the naira
 * `checking` account opened once the entity is approved (NUV-02 opens it),
 * the account details Nuvion provisions asynchronously (`pending`, then
 * `active`), and the balance, which is Nuvion's `balance.available` read on
 * every request and never a sum of our rows. The lead's scratchpad
 * `nuvion/docs/api-reference__accounts.md`,
 * `api-reference__account-details.md`. This file is NUV-04's alone.
 *
 * Every id it puts in a path is checked to be Nuvion's form and encoded.
 * The calls beyond the seam's two (`createAccountDetails`,
 * `findAccountDetails`, `getAccountDetails`, `getTransfer`) are for the
 * NUV-04 handlers (src/nuvion/handlers/accounts.ts, inflows.ts) and for
 * NUV-08's reconciliation, which finds a missed delivery the same way.
 */
/** The WalletProvider methods this area answers for the adapter. */
export type NuvionAccountsMethods = Pick<
  WalletProvider,
  'getWalletAccount' | 'getBalance'
>;

export class NuvionAccountsArea implements NuvionAccountsMethods {
  constructor(readonly client: NuvionClient) {}

  /**
   * The person's naira wallet at Nuvion, or null while its account number
   * is not `active` (or no naira account exists yet). `customerId` is the
   * entity's id. Read from Nuvion: the entity's naira `checking` account
   * (`GET /accounts?entity_id=`), then its account details
   * (`GET /account-details?account_id=&entity_id=`). Two live naira
   * accounts, or two live sets of details, are a stop (`bad_response`):
   * never a guess at which one money goes to.
   */
  async getWalletAccount(customerId: string): Promise<ProviderCustomer | null> {
    const op: NuvionOp = { name: 'get wallet account', call: 'read' };
    this.checkId(op, customerId);
    const listed = await this.client.listAll<unknown>(op, '/accounts', {
      entity_id: customerId,
      limit: 100,
    });
    if (!listed.complete) {
      throw this.unreadable(op, 'the account list is longer than we read');
    }
    const naira = listed.items
      .map(readNuvionAccount)
      .filter(
        (a): a is NuvionAccountReading =>
          a !== null &&
          !a.deleted &&
          a.currency === NUVION_NAIRA &&
          a.type === 'checking' &&
          (a.entityId === null || a.entityId === customerId),
      );
    if (naira.length === 0) return null;
    if (naira.length > 1) {
      throw this.unreadable(op, 'the entity has more than one naira account');
    }
    const account = naira[0];
    const details = await this.findAccountDetails(customerId, account.id);
    if (!details) return null;
    const problem = nairaDetailsProblem(details, {
      entityId: customerId,
      accountId: account.id,
    });
    if (problem === 'pending') return null;
    if (problem !== null) throw this.unreadable(op, problem);
    return {
      customerId,
      walletId: nuvionWalletId(customerId, account.id),
      accountNumber: details.accountNumber!,
      accountName: details.beneficiaryName ?? '',
    };
  }

  /**
   * Nuvion's balance of one naira account: `balance.available` is what can
   * be spent and the only figure a person is shown; `current` (including
   * what is pending settlement) is `bookedKobo`. Asked on every call
   * (`GET /accounts/{id}?entity_id=`), never cached, never a sum of our
   * rows. Nuvion's amounts are already in the smallest unit (kobo).
   *
   * Refused, never shown (each a `bad_response`, which the balance route
   * answers as W6's 503, never a 0): an answer for another account or
   * entity, a currency other than naira, a balance that is not a whole
   * number of kobo or is below zero. A deleted account is `not_found`.
   */
  async getBalance(wallet: { walletId: string }): Promise<ProviderBalance> {
    const op: NuvionOp = { name: 'get balance', call: 'read' };
    const ids = readNuvionWalletId(wallet.walletId);
    if (!ids) {
      throw new NuvionError({
        kind: 'not_found',
        operation: op.name,
        messages: [`${AREA}: the stored wallet id is not a Nuvion account`],
      });
    }
    const answer = await this.client.get<unknown>(
      op,
      `/accounts/${encodeURIComponent(ids.accountId)}`,
      { entity_id: ids.entityId },
    );
    const account = readNuvionAccount(answer.data);
    const fail = (why: string) =>
      new NuvionError({
        kind: 'bad_response',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: ${why}`],
        requestId: answer.requestId,
      });
    if (!account) throw fail('the answer carries no account');
    if (account.id !== ids.accountId) {
      throw fail('the answer is for another account');
    }
    if (account.entityId !== null && account.entityId !== ids.entityId) {
      throw fail('the answer is for another entity');
    }
    if (account.deleted) {
      throw new NuvionError({
        kind: 'not_found',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: the account is deleted`],
        requestId: answer.requestId,
      });
    }
    if (account.currency !== NUVION_NAIRA) {
      throw fail(`the account is in ${account.currency ?? 'no currency'}`);
    }
    if (account.available === null || account.available < 0) {
      throw fail('the available balance is not a whole number of kobo');
    }
    if (account.current === null || account.current < 0) {
      throw fail('the current balance is not a whole number of kobo');
    }
    return {
      availableKobo: BigInt(account.available),
      bookedKobo: BigInt(account.current),
    };
  }

  /**
   * `POST /account-details` for one naira account: Nuvion provisions its
   * account number (`pending`, then `active`). A write: a lost answer is an
   * unknown outcome (`recordMayExist`), and so is "already exists"; the
   * caller then looks the details up (`findAccountDetails`) and adopts
   * them, never a blind second request.
   */
  async createAccountDetails(
    entityId: string,
    accountId: string,
  ): Promise<NuvionAccountDetailsReading> {
    const op: NuvionOp = { name: 'create account details', call: 'write' };
    this.checkId(op, entityId);
    this.checkId(op, accountId);
    const answer = await this.client.post<unknown>(op, '/account-details', {
      account_id: accountId,
      entity_id: entityId,
    });
    const details = readNuvionAccountDetails(answer.data);
    if (!details) {
      // A 2xx without the record: not proof either way.
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: the answer carries no account details`],
        recordMayExist: true,
        requestId: answer.requestId,
      });
    }
    return details;
  }

  /**
   * The live account details of one account, or null when Nuvion lists
   * none. More than one live set is a stop (`bad_response`).
   */
  async findAccountDetails(
    entityId: string,
    accountId: string,
  ): Promise<NuvionAccountDetailsReading | null> {
    const op: NuvionOp = { name: 'find account details', call: 'read' };
    this.checkId(op, entityId);
    this.checkId(op, accountId);
    const listed = await this.client.listAll<unknown>(op, '/account-details', {
      account_id: accountId,
      entity_id: entityId,
      limit: 100,
    });
    if (!listed.complete) {
      throw this.unreadable(
        op,
        'the account details list is longer than we read',
      );
    }
    const live = listed.items
      .map(readNuvionAccountDetails)
      .filter(
        (d): d is NuvionAccountDetailsReading =>
          d !== null && !d.deleted && d.accountId === accountId,
      );
    if (live.length > 1) {
      throw this.unreadable(op, 'the account has more than one set of details');
    }
    return live[0] ?? null;
  }

  /** `GET /account-details/{id}?entity_id=`: one set, re-read before it is used. */
  async getAccountDetails(
    entityId: string,
    detailsId: string,
  ): Promise<NuvionAccountDetailsReading> {
    const op: NuvionOp = { name: 'get account details', call: 'read' };
    this.checkId(op, entityId);
    this.checkId(op, detailsId);
    const answer = await this.client.get<unknown>(
      op,
      `/account-details/${encodeURIComponent(detailsId)}`,
      { entity_id: entityId },
    );
    const details = readNuvionAccountDetails(answer.data);
    if (!details || details.id !== detailsId) {
      throw new NuvionError({
        kind: 'bad_response',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: the answer is not these account details`],
        requestId: answer.requestId,
      });
    }
    return details;
  }

  /**
   * `GET /transfers/{id}?entity_id=`: an inflow read back before it counts
   * (guides__accept-with-account-details.md: verify the transfer's status
   * with this call rather than the webhook alone). Answers the transfer
   * object as Nuvion sent it; src/nuvion/nuvion-ledger-delivery.ts reads it.
   */
  async getTransfer(entityId: string, transferId: string): Promise<unknown> {
    const op: NuvionOp = { name: 'get transfer', call: 'read' };
    this.checkId(op, entityId);
    this.checkId(op, transferId);
    const answer = await this.client.get<unknown>(
      op,
      `/transfers/${encodeURIComponent(transferId)}`,
      { entity_id: entityId },
    );
    return answer.data;
  }

  private checkId(op: NuvionOp, id: string): void {
    if (!isNuvionId(id)) {
      throw new NuvionError({
        kind: 'validation',
        operation: op.name,
        messages: [`${AREA}: an id is not in the form Nuvion uses`],
      });
    }
  }

  private unreadable(op: NuvionOp, why: string): NuvionError {
    return new NuvionError({
      kind: 'bad_response',
      operation: op.name,
      messages: [`${AREA}: ${why}`],
    });
  }
}
