import type { NotificationSettings } from '../common/types';
import type { NotificationKind } from '../notification/notification-event';
import { SETTINGS_GATE } from '../notification/notification.service';

/**
 * Which notifications reach a phone, decided once per kind (INBOX-03).
 *
 * A Record over every `NotificationKind`: a kind added to the vocabulary does
 * not compile until someone decides here whether it is pushed. The Z3
 * switches are not a second list: a kind with an entry in the notification
 * service's `SETTINGS_GATE` is muted by the same switch for push, read at the
 * moment of sending.
 *
 *   send  pushed, unless the kind's switch is off.
 *   hold  not pushed. The notification still reaches the in-app list. A held
 *         kind has no Z3 switch the owner has agreed covers it, so pushing it
 *         would send something the person cannot turn off.
 *
 * Default (agent), owner may override: BACKEND_GAPS G-265 lists every held
 * kind and the question for each. Changing a kind is one line here.
 */
export type PushRule = 'send' | 'hold';

export const PUSH_RULE: Record<NotificationKind, PushRule> = {
  // Money in, refunds, followers, reviews: each has its Z3 switch.
  sale: 'send',
  tip_received: 'send',
  dm_refunded: 'send',
  new_follower: 'send',
  dm_deadline: 'send',
  content_published: 'send',
  content_rejected: 'send',
  review_received: 'send',
  // A new paid question is what a creator most needs on a phone. It has no
  // switch of its own (G-24); push follows "Paid questions" (see PUSH_ONLY_GATE).
  dm_received: 'send',
  // The task names join decisions. They answer a request the person made
  // themselves and no switch covers them (G-32).
  community_join_approved: 'send',
  community_join_declined: 'send',
  // The state of the person's own account or a marketing send, with no switch
  // that is agreed to cover them. Held until the owner answers (G-265).
  paid_dm_warning: 'hold',
  paid_dm_paused: 'hold',
  credits_low: 'hold',
  kyc_verified: 'hold',
  verify_reminder: 'hold',
  campaign: 'hold',
};

/**
 * Switches that gate a kind for PUSH only, because gating it in the list
 * would change what an existing settings key does for the web (G-24).
 * `dm_received` lands in the list whatever the switch says; the phone does
 * not buzz for it when "Paid questions" is off.
 */
export const PUSH_ONLY_GATE: Partial<
  Record<NotificationKind, keyof NotificationSettings>
> = {
  dm_received: 'dmReminders',
};

/** The Z3 switch that mutes `kind` on a phone, if any. */
export function pushGateFor(
  kind: string,
): keyof NotificationSettings | undefined {
  const k = kind as NotificationKind;
  return PUSH_ONLY_GATE[k] ?? SETTINGS_GATE[k];
}

/** The kinds the sweep enqueues. */
export function pushedKinds(): NotificationKind[] {
  return (Object.keys(PUSH_RULE) as NotificationKind[]).filter(
    (k) => PUSH_RULE[k] === 'send',
  );
}

export function isPushed(kind: string): boolean {
  return PUSH_RULE[kind as NotificationKind] === 'send';
}
