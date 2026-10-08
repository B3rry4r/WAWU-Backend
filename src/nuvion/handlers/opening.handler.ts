import { Injectable } from '@nestjs/common';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import type {
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

/**
 * Opening (task NUV-02): `entities.updated` carries Nuvion's review decision
 * (approved or rejected) for a person's entity, recorded on NuvionEntity.
 * This file is NUV-02's alone: it adds its events to `events` and fills
 * `handle`, and never edits the receiver, the dispatcher or another task's
 * handler. With no events listed, no delivery reaches it: the deliveries
 * stay stored, `pending`, and are handled once it lists them.
 */
@Injectable()
export class NuvionOpeningHandler implements NuvionEventHandler {
  readonly task = 'NUV-02';
  readonly events: readonly NuvionWebhookEventName[] = [];

  handle(): Promise<NuvionHandlerResult> {
    return Promise.resolve({
      outcome: 'done',
      note: `${this.task}: nothing to do`,
    });
  }
}
