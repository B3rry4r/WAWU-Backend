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
 * (mobile repo BACKEND_GAPS.md G-32).
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
type CoreNotificationKind =
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
  | 'community_join_declined'
  // INBOX-09: a creator's paid-question standing (DECISIONS R-13).
  /** Too many paid questions went unanswered: the first warning. */
  | 'paid_dm_warning'
  /** Paid messages are switched off for a while. */
  | 'paid_dm_paused'
  // LEGAL-03: documents WAWU delivered on a legal request.
  /** Documents were delivered on a legal request. Recipient: the client. */
  | 'legal_delivered';

/** Exactly the union in WAWU-Web/src/types/notification.ts. */
export type NotificationTone =
  'danger' | 'accent' | 'success' | 'warning' | 'info' | 'neutral';

/**
 * One variant per real event. Every variant carries `userWawuId` — the
 * RECIPIENT, not the actor — because the single most common way to get a
 * notification wrong is to write it to the person who caused it.
 */
type NotificationEventCore =
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
  /**
   * Too many paid questions went unanswered over the window (R-13). Recipient:
   * the creator. Every figure arrives from config, never from this file.
   */
  | {
      kind: 'paid_dm_warning';
      userWawuId: string;
      unansweredPct: number;
      windowDays: number;
      pauseAtPct: number;
      pauseDays: number;
    }
  /** Paid messages switched off until `until` (R-13). Recipient: the creator. */
  | {
      kind: 'paid_dm_paused';
      userWawuId: string;
      unansweredPct: number;
      windowDays: number;
      pauseDays: number;
      until: Date;
    }
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
    }
  /**
   * LEGAL-03. WAWU delivered documents on a legal request (S23). Recipient:
   * the client, never the consultant. `fileCount` is how many arrived in this
   * delivery.
   */
  | {
      kind: 'legal_delivered';
      userWawuId: string;
      requestId: string;
      serviceName: string;
      fileCount: number;
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

    case 'paid_dm_warning':
      return {
        ...base,
        title: 'Reply to your paid questions',
        body: `${event.unansweredPct}% of the paid questions you got in the last ${event.windowDays} days went unanswered. At ${event.pauseAtPct}%, paid messages switch off for ${event.pauseDays} days.`,
        tone: 'warning',
        amount: null,
        creditsCount: null,
        actionLabel: 'Reply now',
        ...NO_RICH_MEDIA,
      };

    case 'paid_dm_paused':
      return {
        ...base,
        title: 'Paid messages are off',
        body: `${event.unansweredPct}% of the paid questions you got in the last ${event.windowDays} days went unanswered, so paid messages are off for ${event.pauseDays} days. They come back on ${formatDate(event.until)}.`,
        tone: 'danger',
        amount: null,
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

    case 'review_received':
      return {
        ...base,
        title: 'New review',
        body: `Someone rated “${event.contentTitle}” ${event.stars} out of 5.`,
        tone: 'info',
        amount: null,
        creditsCount: null,
        actionLabel: 'View content',
        ...NO_RICH_MEDIA,
      };

    /**
     * LEGAL-03 (S23). The documents are in the matter's conversation, so the
     * notification opens that matter: `/legal/requests/<id>`, built here from
     * the id and never from input.
     */
    case 'legal_delivered': {
      const one = event.fileCount === 1;
      return {
        ...base,
        title: one ? 'Your document is ready' : 'Your documents are ready',
        body: `${event.fileCount} ${one ? 'document' : 'documents'} for “${event.serviceName}” ${one ? 'is' : 'are'} in your legal chat.`,
        tone: 'success',
        amount: null,
        creditsCount: null,
        actionLabel: 'Open documents',
        imageUrl: null,
        actionHref: `/legal/requests/${event.requestId}`,
        campaignId: null,
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* ME-10: reviews, and what a notification is about                     */
/* ------------------------------------------------------------------ */

/**
 * Every kind that can be written: the union above (the web's list plus the
 * INBOX kinds) and ME-10's `review_received`. M31 and M32 list reviews
 * ("Sales, tips, paid questions and reviews show up here").
 */
export type NotificationKind = CoreNotificationKind | 'review_received';

/**
 * ME-10. Somebody rated a piece for the first time (a changed rating is not
 * news). Recipient: the creator. Stars only; who rated is the target's
 * actor, never written into the copy.
 */
interface ReviewReceivedEvent {
  kind: 'review_received';
  userWawuId: string;
  contentTitle: string;
  stars: number;
}

/**
 * ME-10. What a notification can be about: the thing opening it opens (M31).
 * `content` a piece, `paid_question` a paid question (DirectMessage),
 * `community` a room, `profile` a person.
 */
export type NotificationTargetKind =
  'content' | 'paid_question' | 'community' | 'profile';

/**
 * ME-10. Optional on every event: the thing it is about and the other person
 * in it. The caller passes ids it already holds from the event it is
 * reporting; nothing here is read from a request. Stored beside the
 * notification (NotificationTarget), never on it, so GET /notifications is
 * unchanged.
 */
export interface NotificationAbout {
  target?: { kind: NotificationTargetKind; id: string } | null;
  /** The other person in the event (buyer, tipper, follower, asker, rater). Never the recipient. */
  actorWawuId?: string | null;
}

/**
 * Every event `emit()` takes: one variant per real event (see
 * NotificationEventCore: `userWawuId` is always the RECIPIENT), each of
 * which may also say what it is about (ME-10).
 */
export type NotificationEvent = (
  NotificationEventCore | ReviewReceivedEvent
) & {
  about?: NotificationAbout;
};

/**
 * ME-10. M31's filter chips: which chip each kind shows under. A Record over
 * the union, so a kind added later does not compile until it is placed. A
 * stored kind outside the union (nothing writes one) reads as `other`.
 */
export const NOTIFICATION_CATEGORY: Record<
  NotificationKind,
  'money' | 'messages' | 'content' | 'other'
> = {
  sale: 'money',
  tip_received: 'money',
  dm_refunded: 'money',
  credits_low: 'money',
  dm_received: 'messages',
  dm_deadline: 'messages',
  paid_dm_warning: 'messages',
  paid_dm_paused: 'messages',
  community_join_approved: 'messages',
  community_join_declined: 'messages',
  content_published: 'content',
  content_rejected: 'content',
  review_received: 'content',
  new_follower: 'other',
  kyc_verified: 'other',
  campaign: 'other',
  verify_reminder: 'other',
  legal_delivered: 'other',
};

/** The NotificationTarget row emit() writes beside a notification, minus its id. */
export interface NotificationTargetDraft {
  targetKind: NotificationTargetKind;
  targetId: string;
  actorWawuId: string | null;
}

/**
 * ME-10. What a notification is about, from its event. A join approval names
 * its room by itself; every other kind says so through `about`. An actor who
 * is the recipient is dropped (nobody is "the other person" to themselves).
 * Null when the event names nothing, which leaves the row routed by `kind`.
 */
export function targetFor(
  event: NotificationEvent,
): NotificationTargetDraft | null {
  const target =
    event.about?.target ??
    (event.kind === 'community_join_approved'
      ? { kind: 'community' as const, id: event.communityId }
      : null);
  if (!target || !target.id) return null;
  const actor = event.about?.actorWawuId ?? null;
  return {
    targetKind: target.kind,
    targetId: target.id,
    actorWawuId: actor && actor !== event.userWawuId ? actor : null,
  };
}
