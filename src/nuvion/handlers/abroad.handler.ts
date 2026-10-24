import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ABROAD_REFERENCE_PREFIX,
  AbroadSendService,
} from '../../money/abroad/abroad-send.service';
import { AbroadService } from '../../money/abroad/abroad.service';
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

/** The events NUV-11 handles: the end of a payout, and a reversal of one. */
export const NUVION_ABROAD_EVENTS: readonly NuvionWebhookEventName[] = [
  'outflows.completed',
  'outflows.failed',
  'outflows.cancelled',
  'outflows.refunded',
];

const done = (note: string): NuvionHandlerResult => ({ outcome: 'done', note });
const wait = (note: string): NuvionHandlerResult => ({ outcome: 'wait', note });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Sends abroad (task NUV-11, R-84): the `outflows.*` events whose
 * `unique_reference` begins with `wawu-abroad-` (ours), or whose reversal
 * names one of our transfers as its source. The delivery is only a nudge:
 * Nuvion advises reading the transfer again before acting on money, so the
 * transfer is read from Nuvion and the send is brought to what that says
 * (src/money/abroad/abroad-send.service.ts, `apply`). Another handler's events
 * (a naira bank send, a book transfer) are not this one's and are left as
 * `done`. Like NUV-06's, it looks up what it needs when a delivery comes, so
 * the webhook module needs no money module, and it acts only under
 * `WALLET_PROVIDER=nuvion`.
 */
@Injectable()
export class NuvionAbroadHandler implements NuvionEventHandler {
  readonly task = 'NUV-11';
  readonly events: readonly NuvionWebhookEventName[] = NUVION_ABROAD_EVENTS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async handle(d: NuvionDelivery): Promise<NuvionHandlerResult> {
    const data = isRecord(d.data) ? d.data : {};
    const reference =
      typeof data.unique_reference === 'string' ? data.unique_reference : null;
    const meta = isRecord(data.meta) ? data.meta : {};
    const source =
      typeof meta.source_payment_id === 'string'
        ? meta.source_payment_id
        : null;
    const ours = reference?.startsWith(ABROAD_REFERENCE_PREFIX) === true;
    if (!ours && source === null) return done('not a send abroad');

    const sends = this.find<AbroadSendService>(AbroadSendService);
    const abroad = this.find<AbroadService>(AbroadService);
    const provider = this.find<WalletProvider>(WALLET_PROVIDER);
    if (!sends || !abroad || !provider) {
      return wait('the money module is not mounted');
    }
    if (!(provider instanceof NuvionWalletProvider)) {
      return wait(
        `the server runs ${provider.label}; left for a Nuvion server`,
      );
    }
    const row = ours
      ? await sends.byReference(reference)
      : await sends.byProviderId(source!);
    if (!row) return done('no send abroad of ours has this reference');
    const holder = await abroad.holderOf(row.wawuUserId);
    if (!holder) return wait("the person's wallet is not recorded yet");
    const transferId =
      row.providerTransferId ??
      (ours && typeof data.id === 'string' ? data.id : '');
    try {
      const transfer =
        transferId !== ''
          ? await provider.abroad.read(holder, transferId)
          : null;
      if (!transfer)
        return wait('the send has no provider transfer to read yet');
      await sends.apply(row.id, transfer);
      await sends.takeFee(row.id);
      return done(`send ${row.id} is ${transfer.state} at the provider`);
    } catch (e) {
      if (e instanceof WalletProviderError) {
        return wait(`Nuvion could not read the transfer back (${e.kind})`);
      }
      throw e;
    }
  }

  private find<T>(token: unknown): T | null {
    try {
      return this.moduleRef.get<T>(token as string, { strict: false });
    } catch {
      return null;
    }
  }
}
