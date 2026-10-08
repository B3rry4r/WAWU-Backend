import { Injectable } from '@nestjs/common';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import type {
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

/**
 * Payouts (task NUV-06): the `outflows.*` events whose `payment_type` is
 * `bank-transfer` (NIP sends), including `outflows.failed` and
 * `outflows.cancelled`. This file is NUV-06's alone: it adds its events to
 * `events` and fills `handle`, and never edits the receiver, the dispatcher
 * or another task's handler. With no events listed, no delivery reaches it:
 * the deliveries stay stored, `pending`, and are handled once it lists them.
 */
@Injectable()
export class NuvionPayoutsHandler implements NuvionEventHandler {
  readonly task = 'NUV-06';
  readonly events: readonly NuvionWebhookEventName[] = [];

  handle(): Promise<NuvionHandlerResult> {
    return Promise.resolve({
      outcome: 'done',
      note: `${this.task}: nothing to do`,
    });
  }
}
