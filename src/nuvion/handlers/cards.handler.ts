import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { WalletCard } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { followCardStatus, stepWords } from '../../money/cards/card-status';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { isNuvionId, readNuvionWalletId } from '../areas/accounts';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import type {
  NuvionDelivery,
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

/** The events WALLET-31 handles. */
export const NUVION_CARDS_EVENTS: readonly NuvionWebhookEventName[] = [
  'cards.created',
  'cards.frozen',
  'cards.unfrozen',
  'cards.deleted',
  // A card payment is not a `cards.*` event: it arrives as an outflow whose
  // `payment_type` is `card-debit` or `card-debit-recoup` and which names the
  // card (the card guide, "Webhooks"; CARD-USE).
  'outflows.created',
  'outflows.completed',
  'outflows.failed',
];

/** The `payment_type` of a card being charged (a reversal or a refund is a credit and changes no card). */
const CARD_DEBIT_TYPES = ['card-debit', 'card-debit-recoup'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True for a delivery about a card being charged. */
function isCardDebit(data: Record<string, unknown> | null): boolean {
  return (
    data !== null &&
    typeof data.payment_type === 'string' &&
    CARD_DEBIT_TYPES.includes(data.payment_type)
  );
}

/** The card a payment names: `card_id` (the webhook), or the initiator's (the shape of Get card transactions). */
function cardIdOf(data: Record<string, unknown>): string | null {
  const direct = data.card_id;
  const nested = isRecord(data.initiator) ? data.initiator.card_id : undefined;
  const id = typeof direct === 'string' ? direct : nested;
  return isNuvionId(id) ? id : null;
}

/** The entity a payment names, or the one the stored delivery was filed under. */
function entityOf(
  d: NuvionDelivery,
  data: Record<string, unknown> | null,
): string | null {
  const own =
    data && typeof data.entity_id === 'string' ? data.entity_id : null;
  return own ?? d.entityId;
}

/**
 * The WAWU card's events (task WALLET-31; webhooks__event-types.md,
 * `cards.created`, `.frozen`, `.unfrozen`, `.deleted`): they keep the Hub's
 * row of a card (WalletCard) in step with Nuvion when the change did not come
 * through the Hub (support at Nuvion, a delivery that outran our own update).
 *
 * - `cards.created`: a card made while the answer was lost is found by its
 *   name, our reference, and adopted. A card that is not ours is left alone.
 * - `cards.frozen` and `.unfrozen`: the event carries no time, so a late one
 *   could undo a newer change; the card's status is read from Nuvion
 *   (`getCard`, which keeps no number or CVV) and the row follows that.
 * - `cards.deleted`: the card is blocked for good.
 * - A card payment (CARD-USE): the docs name no `cards.*` event for a use. It
 *   arrives as `outflows.created`, `.completed` or `.failed` with `payment_type`
 *   `card-debit` and the card's id in `card_id`. For a card of ours, the card is
 *   read from Nuvion and the row follows it, exactly as for `cards.frozen`; any
 *   other outflow is not this handler's and costs nothing.
 * - The row follows Nuvion's status (the card guide, 29 Oct 2026; the rules are
 *   in `money/cards/card-status.ts`): `deactivated` on a single-use card is
 *   `used`; `blocked` is frozen (deleted cards are a 404, blocked for good);
 *   `fraud`, and `deactivated` on a reusable card, are frozen as support's.
 * - A status Nuvion adds later, which `getCard` cannot read, leaves the row as
 *   it was: the delivery waits and is logged, never a crash.
 * A card the row says is blocked for good stays so. Idempotent: Nuvion may
 * deliver an event twice. Only under `WALLET_PROVIDER=nuvion`, like the other
 * handlers: a server on Fintava leaves the deliveries pending.
 */
@Injectable()
export class NuvionCardsHandler implements NuvionEventHandler {
  readonly task = 'WALLET-31';
  readonly events: readonly NuvionWebhookEventName[] = NUVION_CARDS_EVENTS;
  private readonly logger = new Logger(NuvionCardsHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async handle(d: NuvionDelivery): Promise<NuvionHandlerResult> {
    const data = isRecord(d.data) ? d.data : null;
    const isOutflow = d.event.startsWith('outflows.');
    // Every transfer of every kind is an outflow: the other rails are not this
    // handler's, whatever the server runs.
    if (isOutflow && !isCardDebit(data)) {
      return { outcome: 'done', note: 'not a card payment' };
    }
    const provider = this.find<WalletProvider>(WALLET_PROVIDER);
    if (!provider) {
      return { outcome: 'wait', note: 'the wallet provider is not mounted' };
    }
    if (!(provider instanceof NuvionWalletProvider)) {
      return {
        outcome: 'wait',
        note: `the server runs ${provider.label}; left for a Nuvion server`,
      };
    }
    if (isOutflow) return this.onOutflow(d, data, provider);
    const cardId = data && typeof data.id === 'string' ? data.id : null;
    if (!cardId) return { outcome: 'failed', note: 'the event names no card' };

    if (d.event === 'cards.created') {
      const name = typeof data?.name === 'string' ? data.name : '';
      const row = await this.prisma.walletCard.findFirst({
        where: { OR: [{ providerCardId: cardId }, { reference: name }] },
      });
      if (!row) return { outcome: 'done', note: 'not a card of ours' };
      if (row.providerCardId && row.providerCardId !== cardId) {
        return {
          outcome: 'failed',
          note: 'the card name belongs to another card',
        };
      }
      if (['creating', 'unknown'].includes(row.state)) {
        await this.prisma.walletCard.updateMany({
          where: { id: row.id, state: { in: ['creating', 'unknown'] } },
          data: { providerCardId: cardId, state: 'active', failure: null },
        });
      } else if (!row.providerCardId && row.state !== 'failed') {
        await this.prisma.walletCard.updateMany({
          where: { id: row.id, providerCardId: null },
          data: { providerCardId: cardId },
        });
      }
      return { outcome: 'done', note: 'card recorded' };
    }

    const row = await this.prisma.walletCard.findUnique({
      where: { providerCardId: cardId },
    });
    if (!row) return { outcome: 'done', note: 'not a card of ours' };
    if (row.state === 'cancelled') {
      return { outcome: 'done', note: 'already blocked for good' };
    }
    if (d.event === 'cards.deleted') {
      await this.prisma.walletCard.updateMany({
        where: { id: row.id, state: { not: 'cancelled' } },
        data: { state: 'cancelled', cancelledAt: new Date() },
      });
      return { outcome: 'done', note: 'card blocked for good' };
    }
    if (d.event !== 'cards.frozen' && d.event !== 'cards.unfrozen') {
      return { outcome: 'done', note: `${d.event}: not WALLET-31's` };
    }
    return this.follow(row, provider);
  }

  /**
   * A card payment (CARD-USE, F1). Nuvion sends no `cards.*` event for a use:
   * the payment is an `outflows.*` delivery with `payment_type` `card-debit`
   * naming the card in `card_id`. When the card is one of ours the card is read
   * from Nuvion and the row follows its status (a single-use card the payment
   * used is `deactivated` there). Only the row of that card is touched, only
   * when the delivery's entity is the card owner's, and no money moves. The log
   * has the row's id and a fixed word, never what was bought, where or for how
   * much.
   */
  private async onOutflow(
    d: NuvionDelivery,
    data: Record<string, unknown> | null,
    provider: NuvionWalletProvider,
  ): Promise<NuvionHandlerResult> {
    const cardId = data ? cardIdOf(data) : null;
    if (!cardId) {
      return { outcome: 'done', note: 'a card payment that names no card' };
    }
    const row = await this.prisma.walletCard.findUnique({
      where: { providerCardId: cardId },
    });
    if (!row) return { outcome: 'done', note: 'not a card of ours' };
    // A payment is a poor moment to learn that a card is gone for good: one
    // "not found" is asked again after the delivery's rest (a minute at least),
    // and only a second one blocks the card.
    return this.follow(row, provider, entityOf(d, data), d.attempts >= 2);
  }

  /**
   * The row follows the card's state at Nuvion, read now (`getCard` keeps no
   * number or CVV), never the event's. `entity` is the entity a delivery names;
   * when it is not the card owner's, the card is left alone. `blockWhenMissing`
   * false: a Nuvion 404 waits for the next try instead of blocking the card.
   */
  private async follow(
    row: WalletCard,
    provider: NuvionWalletProvider,
    entity: string | null = null,
    blockWhenMissing = true,
  ): Promise<NuvionHandlerResult> {
    if (!['active', 'frozen'].includes(row.state)) {
      return {
        outcome: 'done',
        note: `the card is ${row.state}: left as it was`,
      };
    }
    const cardId = row.providerCardId;
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: row.wawuUserId },
      select: { walletId: true },
    });
    if (!wallet)
      return { outcome: 'wait', note: "the card's owner has no wallet row" };
    const owner = readNuvionWalletId(wallet.walletId);
    if (!cardId || !owner) {
      return {
        outcome: 'done',
        note: 'no Nuvion wallet for the card: left alone',
      };
    }
    if (entity !== null && entity !== owner.entityId) {
      this.logger.warn(
        `card ${row.id}: a delivery from another entity named it; left alone`,
      );
      return { outcome: 'done', note: 'another entity: left alone' };
    }
    try {
      // Nothing is held while Nuvion is asked.
      const card = await provider.cards.getCard(
        { walletId: wallet.walletId },
        cardId,
      );
      const step = await followCardStatus(this.prisma, row, card.status);
      if (!step) return { outcome: 'done', note: 'card state followed Nuvion' };
      this.logger.log(
        `card ${row.id} (${row.type}): Nuvion says ${card.status}; now ${stepWords(step)}`,
      );
      return { outcome: 'done', note: `card is ${stepWords(step)}` };
    } catch (e) {
      if (e instanceof WalletProviderError && e.kind === 'not_found') {
        if (!blockWhenMissing) {
          this.logger.warn(
            `card ${row.id}: Nuvion did not know it (not_found); left as it was, asked again`,
          );
          return {
            outcome: 'wait',
            note: 'Nuvion did not know the card: asked again before it is blocked',
          };
        }
        await this.prisma.walletCard.updateMany({
          where: { id: row.id, state: { not: 'cancelled' } },
          data: { state: 'cancelled', cancelledAt: new Date() },
        });
        return { outcome: 'done', note: 'Nuvion no longer knows the card' };
      }
      const kind = e instanceof WalletProviderError ? e.kind : 'error';
      this.logger.warn(
        `card ${row.id}: Nuvion's answer was not used (${kind}); left as it was`,
      );
      if (kind === 'bad_response') {
        return {
          outcome: 'wait',
          note: "Nuvion's answer was not one we read (a new card status, say): card left as it was",
        };
      }
      return { outcome: 'wait', note: 'Nuvion could not be asked' };
    }
  }

  /** A provider from anywhere in the app, or null when it is not there. */
  private find<T>(token: unknown): T | null {
    try {
      return this.moduleRef.get<T>(token as string, { strict: false });
    } catch {
      return null;
    }
  }
}
