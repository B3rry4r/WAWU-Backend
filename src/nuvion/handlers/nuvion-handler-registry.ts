import { Injectable } from '@nestjs/common';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import { NuvionAccountsHandler } from './accounts.handler';
import { NuvionBookHandler } from './book.handler';
import { NuvionDocumentsHandler } from './documents.handler';
import type { NuvionEventHandler } from './nuvion-handler.interface';
import { NuvionOpeningHandler } from './opening.handler';
import { NuvionPayoutsHandler } from './payouts.handler';
import { NuvionReconcileHandler } from './reconcile.handler';

/**
 * Nuvion's event handlers keyed by event name (task NUV-01). One handler
 * file per later task (NUV-02 to NUV-08), each already listed here and in
 * NuvionWebhookModule, so a task fills its own file and edits neither this
 * registry, the receiver nor the dispatcher. An event several tasks care
 * about (`outflows.completed`: book transfers and payouts) runs every
 * handler that lists it, in this order; each says whether it was its own.
 */
@Injectable()
export class NuvionHandlerRegistry {
  private readonly byEvent = new Map<string, NuvionEventHandler[]>();

  constructor(
    opening: NuvionOpeningHandler,
    documents: NuvionDocumentsHandler,
    accounts: NuvionAccountsHandler,
    book: NuvionBookHandler,
    payouts: NuvionPayoutsHandler,
    reconcile: NuvionReconcileHandler,
  ) {
    for (const h of [opening, documents, accounts, book, payouts, reconcile]) {
      this.add(h);
    }
  }

  /** Registers one more handler (the six above, or a spec's). */
  add(handler: NuvionEventHandler): void {
    for (const event of new Set(handler.events)) {
      const list = this.byEvent.get(event) ?? [];
      list.push(handler);
      this.byEvent.set(event, list);
    }
  }

  /** The handlers of one event, in order; none for an event nobody handles. */
  handlersFor(event: string): readonly NuvionEventHandler[] {
    return this.byEvent.get(event) ?? [];
  }

  /** Every event some handler handles. */
  events(): NuvionWebhookEventName[] {
    return [...this.byEvent.keys()] as NuvionWebhookEventName[];
  }
}
