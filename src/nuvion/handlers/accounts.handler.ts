import { Injectable } from '@nestjs/common';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import type {
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

/**
 * Accounts and money in (task NUV-04): `accounts.created`,
 * `account_details.created` and `account_details.updated` (the account
 * number going `active`) and `inflows.completed` (money in by bank transfer,
 * R-42). This file is NUV-04's alone: it adds its events to `events` and
 * fills `handle`, and never edits the receiver, the dispatcher or another
 * task's handler. With no events listed, no delivery reaches it: the
 * deliveries stay stored, `pending`, and are handled once it lists them.
 */
@Injectable()
export class NuvionAccountsHandler implements NuvionEventHandler {
  readonly task = 'NUV-04';
  readonly events: readonly NuvionWebhookEventName[] = [];

  handle(): Promise<NuvionHandlerResult> {
    return Promise.resolve({
      outcome: 'done',
      note: `${this.task}: nothing to do`,
    });
  }
}
