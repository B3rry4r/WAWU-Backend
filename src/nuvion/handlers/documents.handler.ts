import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { WalletProviderError } from '../../wallet-provider/wallet-provider-error';
import { MoneyError } from '../../money/money-error';
import { DocumentError } from '../documents/document-errors';
import { DocumentsFlow } from '../documents/documents-flow';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import type {
  NuvionDelivery,
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const done = (note: string): NuvionHandlerResult => ({ outcome: 'done', note });
const wait = (note: string): NuvionHandlerResult => ({ outcome: 'wait', note });

/**
 * Documents and the hosted selfie (task NUV-03). Nuvion documents no event
 * of their own and none for the selfie; an entity's review moving on
 * arrives as `entities.updated` (NUV-02's handler records the review; this
 * one runs after it). This file is NUV-03's alone.
 *
 * For each delivery the entity is read back first (the docs advise acting
 * on the resource, never on the delivery), and then the flow heals what a
 * lost answer left: a submission Nuvion has (the entity is past
 * `incomplete`, so the claim is settled and the opening shows `checking`),
 * an upload Nuvion took whose answer never came (found on the entity's own
 * document list, never sent again), and the opening is advanced once if it
 * is now ready (after a correction, say). Every step is idempotent: Nuvion
 * may deliver an event twice, and a delivery is tried again after any
 * handler waits.
 *
 * Only under `WALLET_PROVIDER=nuvion`: a server running Fintava leaves the
 * delivery pending (`wait`) for the server that runs Nuvion (rollback
 * safety, NUV-01). The adapter is found at run time (ModuleRef), so the
 * webhook module (NUV-01's) needs no new import. Notes are our own words:
 * never a number, a name or Nuvion's text.
 */
@Injectable()
export class NuvionDocumentsHandler implements NuvionEventHandler {
  private readonly logger = new Logger(NuvionDocumentsHandler.name);
  readonly task = 'NUV-03';
  readonly events: readonly NuvionWebhookEventName[] = ['entities.updated'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async handle(delivery: NuvionDelivery): Promise<NuvionHandlerResult> {
    const nuvion = this.runningNuvion();
    if (nuvion === null) {
      return wait('this server does not run Nuvion; kept for one that does');
    }
    const data = isRecord(delivery.data) ? delivery.data : null;
    const entityId =
      delivery.resourceId ??
      (data && typeof data.id === 'string' ? data.id : null);
    if (entityId === null) return done('no entity named; nothing to do');
    if (data && typeof data.type === 'string' && data.type !== 'individual') {
      return done('not a person; nothing to do');
    }

    // NUV-02's handler ran first and recorded or adopted the entity; one it
    // does not know is not an opening of ours.
    const owner = await this.prisma.nuvionEntity.findUnique({
      where: { entityId },
      select: { wawuUserId: true },
    });
    if (owner === null) return done('not an opening of ours; left alone');

    let status: string;
    try {
      status = (await nuvion.documents.readDocuments(entityId)).status;
    } catch (e) {
      return wait(`the entity could not be read back (${kindOf(e)})`);
    }
    try {
      const result = await new DocumentsFlow(this.prisma, nuvion).reconcile(
        owner.wawuUserId,
        status,
      );
      return done(`documents: ${result}`);
    } catch (e) {
      this.logger.warn(`nuvion documents: ${kindOf(e)}`);
      // Nuvion read the submission and said no (or has the person under
      // review): sending it again changes nothing, and the person's next
      // step sends it afresh. Anything else may pass: try again later.
      if (
        e instanceof DocumentError ||
        (e instanceof MoneyError && e.code === 'identity_under_review')
      ) {
        return done(
          `the submission was refused (${e.code}); left for the person`,
        );
      }
      return wait(`the opening could not be advanced (${kindOf(e)})`);
    }
  }

  /** The running adapter when it is Nuvion's; null otherwise. */
  private runningNuvion(): NuvionWalletProvider | null {
    let provider: WalletProvider;
    try {
      provider = this.moduleRef.get<WalletProvider>(WALLET_PROVIDER, {
        strict: false,
      });
    } catch {
      return null;
    }
    return provider instanceof NuvionWalletProvider ? provider : null;
  }
}

function kindOf(e: unknown): string {
  return e instanceof WalletProviderError
    ? e.kind
    : ((e as Error).name ?? 'Error');
}
