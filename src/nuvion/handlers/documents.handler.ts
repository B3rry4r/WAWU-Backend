import { Injectable } from '@nestjs/common';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import type {
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

/**
 * Documents and the hosted selfie (task NUV-03): Nuvion documents no event
 * of their own; an entity's review moving on arrives as `entities.updated`
 * (NUV-02's). This file is NUV-03's alone: it adds its events to `events`
 * and fills `handle`, and never edits the receiver, the dispatcher or
 * another task's handler. With no events listed, no delivery reaches it: the
 * deliveries stay stored, `pending`, and are handled once it lists them.
 */
@Injectable()
export class NuvionDocumentsHandler implements NuvionEventHandler {
  readonly task = 'NUV-03';
  readonly events: readonly NuvionWebhookEventName[] = [];

  handle(): Promise<NuvionHandlerResult> {
    return Promise.resolve({
      outcome: 'done',
      note: `${this.task}: nothing to do`,
    });
  }
}
