import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AddMoneyService } from '../../money/add-money/add-money.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import { NuvionHandlerRegistry } from './nuvion-handler-registry';
import type {
  NuvionDelivery,
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

/** The events WALLET-25 and WALLET-26 handle: a payment intent's end, and a funding session's change. */
export const NUVION_ADD_MONEY_EVENTS = [
  'payment_intent.completed',
  'payment_intent.failed',
  'payment_intent.cancelled',
  'funding_sessions.updated',
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function text(o: Record<string, unknown>, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * Adding money by card, Apple Pay, USSD or the bank checkout (WALLET-25,
 * WALLET-26): Nuvion's `payment_intent.*` and `funding_sessions.updated`
 * deliveries tell the Hub an attempt moved, and the Hub asks Nuvion where it
 * stands (as Nuvion's own guide says: "Verify a funding session's status
 * before treating a payment as settled, rather than relying on the webhook
 * payload alone"). This handler never credits: a card is charged before the
 * money lands, so the credit is written when the inflow settles, by NUV-04's
 * recorder through AddMoneyService.creditInflow, keyed on the transfer.
 *
 * This file is WALLET-25's alone. It adds itself to the handler registry when
 * the app starts (the registry's `add`), so the registry, the receiver, the
 * dispatcher and NuvionWebhookModule stay as NUV-01 made them. The service is
 * looked up when a delivery comes, not injected, as NUV-04's handler does.
 *
 * An event for a payment that is not one of ours (another task's) is `done`.
 * Only under `WALLET_PROVIDER=nuvion`: a server on Fintava leaves Nuvion's
 * deliveries pending, for a Nuvion server to handle.
 */
@Injectable()
export class NuvionAddMoneyHandler implements NuvionEventHandler, OnModuleInit {
  readonly task = 'WALLET-25';
  readonly events: readonly string[] = NUVION_ADD_MONEY_EVENTS;

  constructor(private readonly moduleRef: ModuleRef) {}

  onModuleInit(): void {
    this.find<NuvionHandlerRegistry>(NuvionHandlerRegistry)?.add(this);
  }

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
    const service = this.find<AddMoneyService>(AddMoneyService);
    if (!service) {
      return { outcome: 'wait', note: 'add money is not mounted' };
    }
    const data = isRecord(d.data) ? d.data : {};
    const providerRef = text(data, 'id') ?? d.resourceId;
    const reference =
      d.event === 'funding_sessions.updated'
        ? text(data, 'unique_reference')
        : text(data, 'reference');
    const session = await service.findByProvider({ providerRef, reference });
    if (!session) {
      return { outcome: 'done', note: `${d.event}: not an add-money attempt` };
    }
    const now = await service.refresh(session);
    return {
      outcome: 'done',
      note: `${d.event}: the attempt is ${now.status}`,
    };
  }

  private find<T>(token: unknown): T | null {
    try {
      return this.moduleRef.get<T>(token as string, { strict: false });
    } catch {
      return null;
    }
  }
}
