import type {
  ProviderCard,
  ProviderCards,
  ProviderCardSecrets,
  ProviderCardTransaction,
  ProviderCardType,
  ProviderCardWallet,
} from '../../wallet-provider/wallet-provider.interface';
import type { NuvionClient, NuvionOp } from '../nuvion-client';
import { NuvionError } from '../nuvion-error';
import { isNuvionId, readNuvionWalletId } from './accounts';

const AREA = 'cards (WALLET-31)';

/**
 * Nuvion's card routes (api-reference__cards.md; guides__card-issuing.md),
 * with what the dev sandbox answered on 24 Oct 2026 (docs/nuvion/DEV-RESULTS.md,
 * WALLET-31):
 * - `POST /virtual-cards` and `POST /disposable-cards` make a USD card funded
 *   from the person's account; Nuvion takes its own fee from that account at
 *   once (400 `error_card_creation_fee_required` when the account cannot cover
 *   it). The card's `name` is ours, the reference, so a card made while the
 *   answer was lost is found again by `GET /cards`.
 * - `entity_id` is a QUERY on the reads and a BODY field on `PATCH .../freeze`,
 *   `PATCH .../unfreeze` and `DELETE /card-details/{id}` (a query there is 404).
 * - A deleted card is 404 on every route afterwards.
 *
 * The card number and CVV come back on a create and on `GET /card-details`.
 * This file reads them only in `revealCard`, hands them to the caller and
 * keeps nothing: every other method maps the answer field by field into a
 * shape that has no number and no CVV, and no method logs a body.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function cardType(raw: string | null): ProviderCardType | null {
  if (raw === 'virtual') return 'virtual';
  if (raw === 'disposable') return 'single_use';
  return null;
}

/** Nuvion wants `MM` and `YY`, at most two years ahead: 23 months from `now`. */
export function cardExpiry(now: Date): { month: string; year: string } {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 23, 1));
  return {
    month: String(d.getUTCMonth() + 1).padStart(2, '0'),
    year: String(d.getUTCFullYear() % 100).padStart(2, '0'),
  };
}

/** A phone number as Nuvion's cardholder wants it: E.164. Null when it cannot be made one. */
export function e164(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  if (/^234\d{10}$/.test(digits)) return `+${digits}`;
  if (/^0\d{10}$/.test(digits)) return `+234${digits.slice(1)}`;
  return null;
}

/** One card row or card object, field by field. Null when it carries no id or status. */
export function readCard(
  raw: unknown,
  fallbackType: ProviderCardType | null = null,
): ProviderCard | null {
  if (!isRecord(raw)) return null;
  const id = text(raw, 'id');
  const status = text(raw, 'status');
  if (!id || !isNuvionId(id)) return null;
  if (status !== 'active' && status !== 'blocked' && status !== 'fraud') {
    return null;
  }
  const last4 = text(raw, 'last4');
  return {
    id,
    type: cardType(text(raw, 'type')) ?? fallbackType,
    name: text(raw, 'name') ?? '',
    status,
    currency: (text(raw, 'currency') ?? 'USD').toUpperCase(),
    last4: last4 !== null && /^\d{4}$/.test(last4) ? last4 : null,
  };
}

export type NuvionCardsMethods = ProviderCards;

/** The card area of the Nuvion adapter (WALLET-31). */
export class NuvionCardsArea implements ProviderCards {
  constructor(private readonly client: NuvionClient) {}

  async createCard(input: {
    wallet: ProviderCardWallet;
    type: ProviderCardType;
    reference: string;
    currency: 'USD';
  }): Promise<ProviderCard> {
    const op: NuvionOp = { name: 'create card', call: 'write' };
    const ids = this.ids(op, input.wallet);
    const holder = await this.cardholder(ids.entityId);
    const { month, year } = cardExpiry(new Date());
    const answer = await this.client.post<unknown>(
      op,
      input.type === 'virtual' ? '/virtual-cards' : '/disposable-cards',
      {
        account_id: ids.accountId,
        entity_id: ids.entityId,
        card_name: input.reference,
        currency: input.currency,
        cardholder: holder,
        expiration_month: month,
        expiration_year: year,
      },
      { reference: input.reference },
    );
    // The answer carries the number and the CVV; readCard takes neither.
    const card = readCard(answer.data, input.type);
    if (!card) {
      // A 2xx without the card: not proof either way, so it is looked for.
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: the answer carries no card`],
        recordMayExist: true,
        requestId: answer.requestId,
        reference: input.reference,
      });
    }
    return { ...card, name: card.name || input.reference };
  }

  async findCard(
    wallet: ProviderCardWallet,
    reference: string,
  ): Promise<ProviderCard | null> {
    const op: NuvionOp = { name: 'find card', call: 'read' };
    const ids = this.ids(op, wallet);
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const answer = await this.client.get<unknown>(op, '/cards', {
        account_id: ids.accountId,
        entity_id: ids.entityId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const data = isRecord(answer.data) ? answer.data : null;
      const rows = data && Array.isArray(data.cards) ? data.cards : null;
      if (!rows) throw this.unreadable(op, 'the card list is not a list');
      for (const row of rows) {
        const card = readCard(row);
        if (card && card.name === reference) return card;
      }
      const pagination =
        data && isRecord(data.pagination) ? data.pagination : null;
      const next = pagination ? text(pagination, 'next_cursor') : null;
      if (!pagination || pagination.has_next !== true || !next) return null;
      cursor = next;
    }
    throw this.unreadable(op, 'the card list is longer than we read');
  }

  async getCard(
    wallet: ProviderCardWallet,
    cardId: string,
  ): Promise<ProviderCard> {
    const op: NuvionOp = { name: 'get card', call: 'read' };
    const ids = this.ids(op, wallet);
    this.checkId(op, cardId);
    const answer = await this.client.get<unknown>(
      op,
      `/card-details/${cardId}`,
      { entity_id: ids.entityId },
    );
    // The answer carries the number and the CVV; readCard takes neither.
    const card = readCard(answer.data);
    if (!card || card.id !== cardId) {
      throw this.unreadable(op, 'the answer is not the card asked for');
    }
    return card;
  }

  async revealCard(
    wallet: ProviderCardWallet,
    cardId: string,
  ): Promise<ProviderCardSecrets> {
    const op: NuvionOp = { name: 'reveal card', call: 'read' };
    const ids = this.ids(op, wallet);
    this.checkId(op, cardId);
    const answer = await this.client.get<unknown>(
      op,
      `/card-details/${cardId}`,
      { entity_id: ids.entityId },
    );
    const d = isRecord(answer.data) ? answer.data : null;
    const number = d ? text(d, 'number') : null;
    const cvv = d ? text(d, 'cvv') : null;
    const month = d ? text(d, 'expiration_month') : null;
    const year = d ? text(d, 'expiration_year') : null;
    if (
      !d ||
      text(d, 'id') !== cardId ||
      !number ||
      !/^\d{12,19}$/.test(number) ||
      !cvv ||
      !/^\d{3,4}$/.test(cvv) ||
      !month ||
      !year
    ) {
      throw this.unreadable(op, 'the card details are not readable');
    }
    const billing = isRecord(d.billing) ? d.billing : null;
    const holder = [text(d, 'first_name'), text(d, 'last_name')]
      .filter((p): p is string => p !== null)
      .join(' ');
    return {
      number,
      expirationMonth: month,
      expirationYear: year,
      cvv,
      cardholderName: holder,
      billing: billing
        ? {
            line1: text(billing, 'address_line_1'),
            line2: text(billing, 'address_line_2'),
            city: text(billing, 'city'),
            state: text(billing, 'state'),
            postalCode: text(billing, 'postal_code'),
          }
        : null,
    };
  }

  async freezeCard(wallet: ProviderCardWallet, cardId: string): Promise<void> {
    await this.change(
      { name: 'freeze card', call: 'write' },
      wallet,
      cardId,
      'freeze',
      'blocked',
    );
  }

  async unfreezeCard(
    wallet: ProviderCardWallet,
    cardId: string,
  ): Promise<void> {
    await this.change(
      { name: 'unfreeze card', call: 'write' },
      wallet,
      cardId,
      'unfreeze',
      'active',
    );
  }

  async deleteCard(wallet: ProviderCardWallet, cardId: string): Promise<void> {
    const op: NuvionOp = { name: 'delete card', call: 'write' };
    const ids = this.ids(op, wallet);
    this.checkId(op, cardId);
    // `entity_id` in the body: as a query Nuvion answers 404 (dev, 24 Oct).
    const answer = await this.client.delete<unknown>(
      op,
      `/card-details/${cardId}`,
      { entity_id: ids.entityId },
    );
    const d = isRecord(answer.data) ? answer.data : null;
    if (!d || d.status !== 'blocked') {
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: the answer does not say the card is blocked`],
        recordMayExist: true,
        requestId: answer.requestId,
      });
    }
  }

  async listCardTransactions(
    wallet: ProviderCardWallet,
    cardId: string,
    query: { limit?: number; cursor?: string },
  ): Promise<{ items: ProviderCardTransaction[]; nextCursor: string | null }> {
    const op: NuvionOp = { name: 'list card transactions', call: 'read' };
    const ids = this.ids(op, wallet);
    this.checkId(op, cardId);
    const answer = await this.client.get<unknown>(
      op,
      `/card-transactions/${cardId}`,
      {
        entity_id: ids.entityId,
        limit: Math.min(Math.max(query.limit ?? 20, 1), 100),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      },
    );
    const data = isRecord(answer.data) ? answer.data : null;
    const rows = data && Array.isArray(data.payments) ? data.payments : null;
    if (!rows) throw this.unreadable(op, 'the card payments are not a list');
    const items: ProviderCardTransaction[] = [];
    for (const row of rows) {
      const t = readCardTransaction(row);
      if (t) items.push(t);
    }
    const pagination =
      data && isRecord(data.pagination) ? data.pagination : null;
    const next = pagination ? text(pagination, 'next_cursor') : null;
    return {
      items,
      nextCursor: pagination && pagination.has_next === true ? next : null,
    };
  }

  // -------------------------------------------------------------------------

  private async change(
    op: NuvionOp,
    wallet: ProviderCardWallet,
    cardId: string,
    action: 'freeze' | 'unfreeze',
    expect: 'blocked' | 'active',
  ): Promise<void> {
    const ids = this.ids(op, wallet);
    this.checkId(op, cardId);
    const answer = await this.client.patch<unknown>(
      op,
      `/card-details/${cardId}/${action}`,
      { entity_id: ids.entityId },
    );
    const d = isRecord(answer.data) ? answer.data : null;
    if (!d || d.status !== expect) {
      throw new NuvionError({
        kind: 'not_confirmed',
        operation: op.name,
        httpStatus: answer.httpStatus,
        messages: [`${AREA}: the answer does not say the card is ${expect}`],
        recordMayExist: true,
        requestId: answer.requestId,
      });
    }
  }

  /** The cardholder Nuvion wants, from the person's own entity there: their name, email and phone. */
  private async cardholder(entityId: string): Promise<{
    first_name: string;
    last_name: string;
    email: string;
    phone_number: string;
  }> {
    const op: NuvionOp = { name: 'read cardholder', call: 'read' };
    const answer = await this.client.get<unknown>(op, `/entities/${entityId}`);
    const data = isRecord(answer.data) ? answer.data : null;
    const person = data && isRecord(data.person) ? data.person : null;
    const first = person ? text(person, 'first_name') : null;
    const last = person ? text(person, 'last_name') : null;
    const email = person ? text(person, 'email') : null;
    const phone = e164(person ? text(person, 'phonenumber') : null);
    if (!first || !last || !email || !phone) {
      throw new NuvionError({
        kind: 'refused',
        operation: op.name,
        messages: [
          `${AREA}: the person's entity lacks a name, an email or a phone number a card needs`,
        ],
        recordMayExist: false,
      });
    }
    return {
      first_name: first,
      last_name: last,
      email,
      phone_number: phone,
    };
  }

  private ids(
    op: NuvionOp,
    wallet: ProviderCardWallet,
  ): { entityId: string; accountId: string } {
    const ids = readNuvionWalletId(wallet.walletId);
    if (!ids) {
      throw new NuvionError({
        kind: 'validation',
        operation: op.name,
        messages: [`${AREA}: the wallet id is not one this adapter made`],
        recordMayExist: false,
      });
    }
    return ids;
  }

  private checkId(op: NuvionOp, id: string): void {
    if (!isNuvionId(id)) {
      throw new NuvionError({
        kind: 'validation',
        operation: op.name,
        messages: [`${AREA}: an id is not in the form Nuvion uses`],
        recordMayExist: false,
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

/** One card payment row (api-reference__cards.md, "Get card transactions"). */
export function readCardTransaction(
  raw: unknown,
): ProviderCardTransaction | null {
  if (!isRecord(raw)) return null;
  const id = text(raw, '_id') ?? text(raw, 'id');
  const amount = raw.amount;
  if (!id || typeof amount !== 'number' || !Number.isSafeInteger(amount)) {
    return null;
  }
  const paymentType = text(raw, 'payment_type');
  const kind =
    paymentType === 'card-debit-reversal'
      ? 'reversal'
      : paymentType === 'card-credit-refund'
        ? 'refund'
        : paymentType === 'card-debit' || paymentType === 'card-debit-recoup'
          ? 'purchase'
          : null;
  if (!kind) return null;
  const recipient = isRecord(raw.recipient) ? raw.recipient : null;
  const address =
    recipient && isRecord(recipient.address) ? recipient.address : null;
  const place = address
    ? [text(address, 'city'), text(address, 'country')]
        .filter((p): p is string => p !== null)
        .join(', ')
    : '';
  const created = raw.created;
  return {
    id,
    kind,
    amountMinor: amount,
    currency: (text(raw, 'currency') ?? 'USD').toUpperCase(),
    status: text(raw, 'status') ?? 'unknown',
    merchant: kind === 'purchase' && recipient ? text(recipient, 'name') : null,
    place: place === '' ? null : place,
    narration: text(raw, 'narration'),
    at:
      typeof created === 'number' && Number.isFinite(created)
        ? new Date(created)
        : null,
  };
}
