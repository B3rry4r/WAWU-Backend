import { Injectable } from '@nestjs/common';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import type {
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

/**
 * Reconciliation (task NUV-08): whatever the nightly figures and the
 * missed-delivery sweep need from stored deliveries. This file is NUV-08's
 * alone: it adds its events to `events` and fills `handle`, and never edits
 * the receiver, the dispatcher or another task's handler. With no events
 * listed, no delivery reaches it: the deliveries stay stored, `pending`, and
 * are handled once it lists them.
 */
@Injectable()
export class NuvionReconcileHandler implements NuvionEventHandler {
  readonly task = 'NUV-08';
  readonly events: readonly NuvionWebhookEventName[] = [];

  handle(): Promise<NuvionHandlerResult> {
    return Promise.resolve({
      outcome: 'done',
      note: `${this.task}: nothing to do`,
    });
  }
}
