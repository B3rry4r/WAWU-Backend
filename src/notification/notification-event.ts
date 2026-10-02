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
 * Anything not in this union cannot be written. The union started as exactly
 * the kinds the web client renders (WAWU-Web/src/types/notification.ts); it
 * no longer is: INBOX-01 added `community_join_approved` and
 * `community_join_declined` for the app, which the web's list does not name
 * (mobile repo BACKEND_GAPS.md G-27).
 *
 * Build brief C8 adds the only two kinds that are not a report of a
 * transaction: `campaign` (an admin-composed announcement, the one kind whose
 * copy a human supplies) and `verify_reminder` (B1's recurring verification
 * prompt). Both carry the rich fields - a picture and an in-app destination -
 * that make the notification list an experiential surface rather than a list
 * of sentences.
 */

/**
 * The web's union (WAWU-Web/src/types/notification.ts) plus the two INBOX-01
 * kinds at the end.
 */
export type NotificationKind =
  | 'dm_deadline'
  | 'sale'
  | 'dm_received'
  | 'content_published'
  | 'kyc_verified'
  | 'dm_refunded'
  | 'credits_low'
  | 'content_rejected'
  | 'new_follower'
  | 'tip_received'
  // Build brief C8 adds two kinds that are not a reaction to a transaction.
  /** An admin-composed announcement or promotion, fanned out from a NotificationCampaign. */
  | 'campaign'
  /** The recurring "you are not verified yet" prompt from brief B1. */
  | 'verify_reminder'
  // INBOX-01: the answer to a request to join a private community.
  /** The host let the requester in. */
  | 'community_join_approved'
  /** The host said no. */
  | 'community_join_declined';

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
  /**
   * Manual KYC review concluded. Recipient: the creator.
   *
   * Emitted by KycSubmissionService.review() — the single transition both the
   * admin queue and POST /kyc/:id/review delegate to. This comment previously
   * claimed "(Emitted from feat/admin-surface.)" and nothing emitted it at all;
   * the kind was declared and rendered with no writer for the life of the
   * module (legacy-app-repair, 2026-08-31).
   */
  | { kind: 'kyc_verified'; userWawuId: string; approved: boolean }
  /**
   * An admin-composed announcement or promotion (build brief C8). This is the
   * ONE event whose copy the caller supplies, because the caller is a human
   * writing a campaign in the dashboard rather than a module reporting a fact.
   * Everything about it is still validated before it gets here:
   * ComposeCampaignDto bounds the lengths and the tone, and
   * assertSafeDestination() bounds where it can send someone.
   */
  | {
      kind: 'campaign';
      userWawuId: string;
      campaignId: string;
      title: string;
      body: string;
      tone: NotificationTone;
      imageUrl: string | null;
      actionLabel: string | null;
      actionHref: string | null;
    }
  /**
   * The recurring "you have not verified yet" prompt (build brief B1:
   * "Unverified creators and professionals receive persistent, recurring
   * prompts to verify, and each prompt states the concrete benefits").
   *
   * `audience` picks which of the two ticks the copy talks about. It carries
   * NO price: the two figures (N4,999 and N9,999 a year) live on the
   * verification screen this prompt opens, which is where they are written
   * down once. Repeating a price in a notification is how a stale figure ends
   * up in somebody's history.
   */
  | {
      kind: 'verify_reminder';
      userWawuId: string;
      audience: 'creator' | 'professional';
    }
  /**
   * INBOX-01. A host answered a request to join their private community.
   * Recipient: the person who asked, never the host. Emitted only when the
   * answer changed something: an approval that flipped `pending` to `joined`,
   * or a decline that removed a pending request.
   */
  | {
      kind: 'community_join_approved';
      userWawuId: string;
      communityId: string;
      communityName: string;
    }
  | {
      kind: 'community_join_declined';
      userWawuId: string;
      communityName: string;
    };

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
  /**
   * Build brief C8: notifications carry a picture. Null on every kind that
   * has nothing to show, which is every transactional kind - the client draws
   * the compact row in that case rather than an empty frame.
   */
  imageUrl: string | null;
  /**
   * An in-app path this notification opens. The two C8 kinds set it, and so
   * does `community_join_approved`, whose destination is one particular room
   * that `kind` alone cannot name; that path is built here from the room's
   * id, never typed by anyone. Every other transactional kind is routed by
   * `kind` on the client, because where "your DM is about to expire" goes is
   * a property of the event, not something a composer should be able to
   * retarget.
   */
  actionHref: string | null;
  /** Set only on `campaign`, so a dispatch can be counted and audited. */
  campaignId: string | null;
}

/**
 * Everything a transactional kind leaves unset. Spread into each draft so the
 * three C8 columns cannot be silently forgotten when a kind is added: the
 * compiler requires them, and this names the "no picture, routed by kind"
 * default once instead of eleven times.
 */
const NO_RICH_MEDIA = {
  imageUrl: null,
  actionHref: null,
  campaignId: null,
} as const;

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
        ...NO_RICH_MEDIA,
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
        ...NO_RICH_MEDIA,
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
        ...NO_RICH_MEDIA,
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
        ...NO_RICH_MEDIA,
      };
    }

    case 'dm_refunded':
      return {
        ...base,
        title: 'Paid DM refunded',
        body: `Your ${formatNaira(event.amount)} has been refunded. The creator did not reply within 24 hours.`,
        tone: 'info',
        amount: Math.round(event.amount),
        creditsCount: null,
        actionLabel: null,
        ...NO_RICH_MEDIA,
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
        ...NO_RICH_MEDIA,
      };
    }

    case 'new_follower':
      return {
        ...base,
        title: 'New follower',
        body: 'Someone started following you.',
        tone: 'info',
        amount: null,
        creditsCount: null,
        actionLabel: null,
        ...NO_RICH_MEDIA,
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
        ...NO_RICH_MEDIA,
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
        ...NO_RICH_MEDIA,
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
            ...NO_RICH_MEDIA,
          }
        : {
            ...base,
            title: 'Identity check needs another look',
            body: 'Your identity check was not approved. Resubmit your ID details to finish.',
            tone: 'warning',
            amount: null,
            creditsCount: null,
            actionLabel: 'Resubmit',
            ...NO_RICH_MEDIA,
          };

    /**
     * The one kind whose words come from a person. Kept inside this switch
     * anyway so `composeNotification` stays the single place a Notification
     * row's shape is decided, and so the campaign's fields are normalised
     * (empty string -> null) exactly once.
     */
    case 'campaign':
      return {
        ...base,
        title: event.title,
        body: event.body,
        tone: event.tone,
        amount: null,
        creditsCount: null,
        actionLabel: event.actionLabel ?? null,
        imageUrl: event.imageUrl ?? null,
        actionHref: event.actionHref ?? null,
        campaignId: event.campaignId,
      };

    /**
     * Present tense only. Every clause below is something that is true the
     * moment the submission is approved, and is implemented today:
     *
     *  - the tick: VerificationSubmissionService.review() (creators) and
     *    AdminProfessionalReviewService (professionals) both call
     *    WawuIdClient.elevateVerificationTier on approval, and the web client
     *    renders <VerificationBadge> from that claim;
     *  - the destination: /profile/verification is a built screen. It no
     *    longer lists tiers or takes a submission (the five-rung ladder was
     *    replaced by the two paid ticks); it is now where those ticks are
     *    bought.
     *
     * What it deliberately does NOT say is anything in the future tense. "We
     * will let you know when your badge is approved" would need a notification
     * emitted on that approval, and nothing emits one today - so it is not
     * promised here. See DECISIONS.md D17b.
     */
    case 'verify_reminder': {
      const professional = event.audience === 'professional';
      return {
        ...base,
        title: 'Your account is not verified yet',
        body: professional
          ? 'Verified professionals carry the green tick on their profile and on every card they appear on. Send your credentials to start.'
          : 'Verified creators carry the purple tick on their profile and on every card they appear on. Send your ID to start.',
        tone: 'info',
        amount: null,
        creditsCount: null,
        actionLabel: 'Get verified',
        imageUrl: null,
        actionHref: '/profile/verification',
        campaignId: null,
      };
    }

    /**
     * INBOX-01. "We'll let you know when she answers" (I31) is this pair.
     * The approval opens the room: `/communities/<id>`, under the
     * `/communities` destination campaigns already use, built from the id and
     * never from input.
     */
    case 'community_join_approved':
      return {
        ...base,
        title: 'Request approved',
        body: `The host of “${event.communityName}” approved your request to join. You're in.`,
        tone: 'success',
        amount: null,
        creditsCount: null,
        actionLabel: 'Open room',
        imageUrl: null,
        actionHref: `/communities/${event.communityId}`,
        campaignId: null,
      };

    case 'community_join_declined':
      return {
        ...base,
        title: 'Request declined',
        body: `The host of “${event.communityName}” declined your request to join.`,
        tone: 'neutral',
        amount: null,
        creditsCount: null,
        actionLabel: null,
        ...NO_RICH_MEDIA,
      };
  }
}
