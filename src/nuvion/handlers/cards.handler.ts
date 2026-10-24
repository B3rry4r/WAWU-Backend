import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
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
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
 * A card the row says is blocked for good stays so. Idempotent: Nuvion may
 * deliver an event twice. Only under `WALLET_PROVIDER=nuvion`, like the other
 * handlers: a server on Fintava leaves the deliveries pending.
 */
@Injectable()
export class NuvionCardsHandler implements NuvionEventHandler {
  readonly task = 'WALLET-31';
  readonly events: readonly NuvionWebhookEventName[] = NUVION_CARDS_EVENTS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async handle(d: NuvionDelivery): Promise<NuvionHandlerResult> {
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
    const data = isRecord(d.data) ? d.data : null;
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
    // The state now, from Nuvion, not from the event.
    const wallet = await this.prisma.fintavaWallet.findUnique({
      where: { wawuUserId: row.wawuUserId },
      select: { walletId: true },
    });
    if (!wallet)
      return { outcome: 'wait', note: "the card's owner has no wallet row" };
    try {
      const card = await provider.cards.getCard(
        { walletId: wallet.walletId },
        cardId,
      );
      if (card.status === 'active' && row.state === 'frozen') {
        await this.prisma.walletCard.updateMany({
          where: { id: row.id, state: 'frozen' },
          data: { state: 'active', frozenBy: null },
        });
      } else if (card.status !== 'active' && row.state === 'active') {
        await this.prisma.walletCard.updateMany({
          where: { id: row.id, state: 'active' },
          data: { state: 'frozen', frozenBy: row.frozenBy ?? 'person' },
        });
      }
      return { outcome: 'done', note: 'card state followed Nuvion' };
    } catch (e) {
      if (e instanceof WalletProviderError && e.kind === 'not_found') {
        await this.prisma.walletCard.updateMany({
          where: { id: row.id, state: { not: 'cancelled' } },
          data: { state: 'cancelled', cancelledAt: new Date() },
        });
        return { outcome: 'done', note: 'Nuvion no longer knows the card' };
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
