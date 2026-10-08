import { Injectable } from '@nestjs/common';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import type {
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

/**
 * Book transfers (task NUV-05): the `outflows.*` events whose `payment_type`
 * is `book-transfer` (paying from the wallet, held money through WAWU's
 * operational account), and the matching `inflows.completed` on the
 * receiving side. This file is NUV-05's alone: it adds its events to
 * `events` and fills `handle`, and never edits the receiver, the dispatcher
 * or another task's handler. With no events listed, no delivery reaches it:
 * the deliveries stay stored, `pending`, and are handled once it lists them.
 */
@Injectable()
export class NuvionBookHandler implements NuvionEventHandler {
  readonly task = 'NUV-05';
  readonly events: readonly NuvionWebhookEventName[] = [];

  handle(): Promise<NuvionHandlerResult> {
    return Promise.resolve({
      outcome: 'done',
      note: `${this.task}: nothing to do`,
    });
  }
}
