import type { NotificationSettings } from '../common/types';
import type { NotificationKind } from '../notification/notification-event';
import {
  SETTINGS_GATE,
  type SwitchName,
} from '../notification/notification.service';

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
  // WALLET-10. A bank transfer into the account: "Money in" (Z3) mutes it.
  money_in: 'send',
  // WALLET-39. A credit the person was told about was taken back. Pushed, so
  // a phone that showed "You received" is corrected; "Money in" mutes the push
  // (PUSH_ONLY_GATE), but the list always carries the correction.
  money_in_reversed: 'send',
  dm_refunded: 'send',
  new_follower: 'send',
  dm_deadline: 'send',
  // HOME-16 (R-59). The morning TGIF notice; the TGIF switch (Z2) mutes it.
  tgif_daily: 'send',
  // WALLET-40 (owner answer 31, 17 Oct 2026: "the person gets an alert when
  // the account number is ready"). Pushed, once per wallet. No Z3 switch
  // covers it, and the owner asked for the alert, so the G-265 hold below does
  // not apply to it; it stays the one push the person cannot mute in
  // Settings (the phone's own notification setting still can).
  wallet_ready: 'send',
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
  // INBOX-24 (R-63). The reminder 3 days before a pass ends, with the renew
  // tap. It is the one thing the task asks to reach the phone; no Z3 switch
  // covers it (it is about money the person already paid), so like the join
  // decisions it is always sent.
  community_pass_ending: 'send',
  // INBOX-25 (R-71). A removed member's unused pass days landed in their
  // wallet. It is money in, so the "Money in" switch mutes the push (see
  // PUSH_ONLY_GATE); the list always carries it.
  community_pass_refunded: 'send',
  // FIX-105 (R-81, owner, 24 Oct 2026: it reaches the phone like the other
  // kinds). One push per notice, when the notice is first written; later
  // messages update the notice and do not buzz the phone again until the
  // person has opened the room. The Z3 "Community messages" switch mutes it
  // (SETTINGS_GATE), read again at the moment of sending.
  community_messages: 'send',
  // STORE-SALE-NOTICE (R-101, owner: the creator is told of each store sale).
  // A pass sold and a question answered are money in like a sale or a tip, so
  // the "Money in" switch mutes them (SETTINGS_GATE). The question credit is the
  // asker's money back in another form, so the "Refunds" switch mutes it.
  pass_sold: 'send',
  question_answered: 'send',
  question_credit: 'send',
  // The state of the person's own account or a marketing send, with no switch
  // that is agreed to cover them. Held until the owner answers (G-265).
  paid_dm_warning: 'hold',
  paid_dm_paused: 'hold',
  credits_low: 'hold',
  kyc_verified: 'hold',
  verify_reminder: 'hold',
  campaign: 'hold',
  // LEGAL-03. A consultant's document for a request the person paid for. No
  // switch covers it, so it is held until the owner answers (G-265), as the
  // round 2 report ruled for whichever of LEGAL-03 and INBOX-03 merged second.
  legal_delivered: 'hold',
  // R2-LEGAL2. Held with legal_delivered: the same open question (G-265) covers it.
  legal_quote_ready: 'hold',
  // R2-MONEY2. Held with the other legal kinds (G-265): these reach the in-app list only.
  legal_consultant_joined: 'hold',
  legal_consultation_booked: 'hold',
  // NUV-02. The outcome of the person's own wallet identity check (approved,
  // refused with what to fix, stopped, closed unfinished). Like kyc_verified
  // it is the state of their account and no Z3 switch is agreed to cover it,
  // so it is held until the owner answers (G-265). It reaches the in-app list.
  identity_review: 'hold',
  // PRICE-LIST (R-101, lead ruling): a price the migration moved is told in the app only, never pushed.
  price_moved: 'hold',
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
  // WALLET-39. A "received" notice that stands in the list must always be
  // followed by its correction, so the list is not gated; the phone does not
  // buzz for it when "Money in" is off.
  money_in_reversed: 'moneyIn',
  community_pass_refunded: 'moneyIn',
};

/** The Z3 switch that mutes `kind` on a phone, if any. */
export function pushGateFor(kind: string): SwitchName | undefined {
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
