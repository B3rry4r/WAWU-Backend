/**
 * The typed vocabulary for the ONLY write path into the Notification table.
 *
 * Before this file, `prisma.notification.create` existed nowhere in `src/` —
 * the two seed upserts in prisma/seed.ts were the entire supply, so every
 * notification any user had ever seen was fixture data. Call sites now hand
 * `NotificationService.emit()` a fact ("this tip settled", "this DM was
 * refunded") and this module turns it into the row; no caller composes a
 * title, body or tone itself. That is deliberate: notification bodies are
 * user-facing copy and CLAUDE.md's product rules bind them (Naira only,
 * WAWU Credits render as a COUNT and never a naira value, no wallet /
 * balance / cash-out language anywhere). Keeping every string in one file
 * is what makes that reviewable.
 *
 * The kinds are exactly the twelve the web client renders — see
 * WAWU-Web/src/types/notification.ts. Anything not in this union cannot be
 * written.
 */

/** Exactly the union in WAWU-Web/src/types/notification.ts. */
export type NotificationKind =
  | 'dm_deadline'
  | 'sale'
  | 'dm_received'
  | 'content_published'
  | 'kyc_verified'
  | 'dm_refunded'
  | 'credits_low'
  | 'content_rejected'
  | 'subscription_renewal'
  | 'new_follower'
  | 'tip_received'
  | 'trial_ending';

/** Exactly the union in WAWU-Web/src/types/notification.ts. */
export type NotificationTone =
  'danger' | 'accent' | 'success' | 'warning' | 'info' | 'neutral';

/**
 * One variant per real event. Every variant carries `userWawuId` — the
 * RECIPIENT, not the actor — because the single most common way to get a
 * notification wrong is to write it to the person who caused it.
 */
export type NotificationEvent =
  /** Paid content unlocked. Recipient: the creator. `netAmount` is what the creator earned after commission. */
  | {
      kind: 'sale';
      userWawuId: string;
      contentTitle: string;
      netAmount: number;
    }
  /** Tip settled. Recipient: the creator. `netAmount` is post-commission. */
  | { kind: 'tip_received'; userWawuId: string; netAmount: number }
  /** Paid DM paid for and created. Recipient: the creator. `amount` is what the fan paid. */
  | { kind: 'dm_received'; userWawuId: string; amount: number }
  /** The 24h reply window is closing. Recipient: the creator. */
  | { kind: 'dm_deadline'; userWawuId: string; hoursLeft: number }
  /** The 24h window closed unanswered. Recipient: the fan who paid. */
  | { kind: 'dm_refunded'; userWawuId: string; amount: number }
  /** Credits ran low or ran out. Recipient: the spender. Always a COUNT. */
  | { kind: 'credits_low'; userWawuId: string; creditsCount: number }
  /** The 7-day WAWU Credits trial is about to end. Recipient: the fan. Always a COUNT. */
  | { kind: 'trial_ending'; userWawuId: string; creditsCount: number }
  /** Subscription billing news. Recipient: the creator. */
  | {
      kind: 'subscription_renewal';
      userWawuId: string;
      state: 'renewed' | 'past_due' | 'expired';
      tier: string;
      /** Only meaningful for `renewed`. */
      amount?: number;
      /** Only meaningful for `renewed`. */
      nextRenewalAt?: Date;
    }
  /** Somebody followed this creator. Recipient: the creator. */
  | { kind: 'new_follower'; userWawuId: string }
  /** Admin review approved an upload. Recipient: the creator. (Emitted from feat/admin-surface.) */
  | { kind: 'content_published'; userWawuId: string; contentTitle: string }
  /** Admin review rejected an upload. Recipient: the creator. (Emitted from feat/admin-surface.) */
  | {
      kind: 'content_rejected';
      userWawuId: string;
      contentTitle: string;
      reason?: string | null;
    }
  /** Manual KYC review concluded. Recipient: the creator. (Emitted from feat/admin-surface.) */
  | { kind: 'kyc_verified'; userWawuId: string; approved: boolean };

/** The row `emit()` will write, before it reaches Prisma. */
export interface NotificationDraft {
  userWawuId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  tone: NotificationTone;
  amount: number | null;
  creditsCount: number | null;
  actionLabel: string | null;
}

/**
 * ₦ with thousands separators, no decimals. Hand-rolled rather than
 * Intl.NumberFormat so the output is identical on every Node build
 * (small-icu images render en-NG as plain digits).
 *
 * Naira only — there is no other currency in this product.
 */
export function formatNaira(amount: number): string {
  const whole = Math.round(amount);
  const sign = whole < 0 ? '-' : '';
  const digits = Math.abs(whole)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}₦${digits}`;
}

/**
 * WAWU Credits are a COUNT. Never a naira value, never cashable — see
 * CLAUDE.md. This helper exists so no call site can accidentally reach for
 * formatNaira() on a credits number.
 */
export function formatCredits(count: number): string {
  return `${count} ${count === 1 ? 'credit' : 'credits'}`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function formatDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "Basic"/"Pro" for copy — the DB stores the lowercase enum value. */
function tierLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * The single place notification copy is written.
 *
 * Copy rules enforced here, per CLAUDE.md:
 *  - every money figure goes through formatNaira() — Naira only, never $;
 *  - every credits figure goes through formatCredits() — a COUNT, and the
 *    `creditsCount` column is set instead of `amount` so the client cannot
 *    render it as money;
 *  - no "wallet", "balance", "withdraw", "cash out" or "payout" anywhere;
 *  - commission is referred to as "the platform fee", never as an invented
 *    rate (85/15 vs 90/10 depends on the creator's tier and is already
 *    snapshotted on the Purchase row).
 */
export function composeNotification(
  event: NotificationEvent,
): NotificationDraft {
  const base = { userWawuId: event.userWawuId, kind: event.kind };

  switch (event.kind) {
    case 'sale':
      return {
        ...base,
        title: 'Content sold',
        body: `Someone unlocked “${event.contentTitle}”. You earned ${formatNaira(event.netAmount)} after the platform fee.`,
        tone: 'success',
        amount: Math.round(event.netAmount),
        creditsCount: null,
        actionLabel: 'View earnings',
      };

    case 'tip_received':
      return {
        ...base,
        title: 'You received a tip',
        body: `Someone tipped you. You earned ${formatNaira(event.netAmount)} after the platform fee.`,
        tone: 'success',
        amount: Math.round(event.netAmount),
        creditsCount: null,
        actionLabel: 'View earnings',
      };

    case 'dm_received':
      return {
        ...base,
        title: 'Paid DM received',
        body: `Someone paid ${formatNaira(event.amount)} to message you. Reply within 24 hours or it is refunded to them.`,
        tone: 'accent',
        amount: Math.round(event.amount),
        creditsCount: null,
        actionLabel: 'Reply now',
      };

    case 'dm_deadline': {
      const hours = Math.max(1, Math.round(event.hoursLeft));
      return {
        ...base,
        title: 'Reply deadline approaching',
        body: `A paid DM is still waiting. About ${hours} ${hours === 1 ? 'hour' : 'hours'} left to reply before it is refunded.`,
        tone: 'danger',
        amount: null,
        creditsCount: null,
        actionLabel: 'Reply now',
      };
    }

    case 'dm_refunded':
      return {
        ...base,
        title: 'Paid DM refunded',
        body: `Your ${formatNaira(event.amount)} has been refunded — the creator did not reply within 24 hours.`,
        tone: 'info',
        amount: Math.round(event.amount),
        creditsCount: null,
        actionLabel: null,
      };

    case 'credits_low': {
      const out = event.creditsCount <= 0;
      return {
        ...base,
        title: out ? 'You are out of credits' : 'Credits running low',
        body: out
          ? 'You have no WAWU Credits left. Top up to keep messaging in communities.'
          : `You have ${formatCredits(event.creditsCount)} left. Top up to keep messaging in communities.`,
        tone: out ? 'danger' : 'warning',
        amount: null,
        creditsCount: event.creditsCount,
        actionLabel: 'Buy credits',
      };
    }

    case 'trial_ending':
      return {
        ...base,
        title: 'Credits trial ending',
        body: `Your WAWU Credits trial ends tomorrow. You have ${formatCredits(event.creditsCount)} left.`,
        tone: 'warning',
        amount: null,
        creditsCount: event.creditsCount,
        actionLabel: 'Buy credits',
      };

    case 'subscription_renewal':
      if (event.state === 'renewed') {
        const until = event.nextRenewalAt
          ? ` Next renewal ${formatDate(event.nextRenewalAt)}.`
          : '';
        return {
          ...base,
          title: 'Subscription renewed',
          body: `Your ${tierLabel(event.tier)} creator subscription renewed for ${formatNaira(event.amount ?? 0)}.${until}`,
          tone: 'success',
          amount: event.amount != null ? Math.round(event.amount) : null,
          creditsCount: null,
          actionLabel: null,
        };
      }
      if (event.state === 'past_due') {
        return {
          ...base,
          title: 'Subscription needs attention',
          body: `Your ${tierLabel(event.tier)} creator subscription did not renew. Update your card to keep uploading.`,
          tone: 'warning',
          amount: null,
          creditsCount: null,
          actionLabel: 'Retry payment',
        };
      }
      return {
        ...base,
        title: 'Subscription ended',
        body: `Your ${tierLabel(event.tier)} creator subscription has ended. Resubscribe to start uploading again.`,
        tone: 'neutral',
        amount: null,
        creditsCount: null,
        actionLabel: 'Resubscribe',
      };

    case 'new_follower':
      return {
        ...base,
        title: 'New follower',
        body: 'Someone started following you.',
        tone: 'info',
        amount: null,
        creditsCount: null,
        actionLabel: null,
      };

    case 'content_published':
      return {
        ...base,
        title: 'Content approved',
        body: `“${event.contentTitle}” is approved and live.`,
        tone: 'success',
        amount: null,
        creditsCount: null,
        actionLabel: 'View content',
      };

    case 'content_rejected':
      return {
        ...base,
        title: 'Content not approved',
        body: `“${event.contentTitle}” was not approved.${event.reason ? ` ${event.reason}` : ''} Your upload slot has been returned.`,
        tone: 'danger',
        amount: null,
        creditsCount: null,
        actionLabel: 'Edit and resubmit',
      };

    case 'kyc_verified':
      return event.approved
        ? {
            ...base,
            title: 'Identity check approved',
            body: 'Your identity check passed. You can now earn on WAWU.',
            tone: 'success',
            amount: null,
            creditsCount: null,
            actionLabel: null,
          }
        : {
            ...base,
            title: 'Identity check needs another look',
            body: 'Your identity check was not approved. Resubmit your ID details to finish.',
            tone: 'warning',
            amount: null,
            creditsCount: null,
            actionLabel: 'Resubmit',
          };
  }
}
