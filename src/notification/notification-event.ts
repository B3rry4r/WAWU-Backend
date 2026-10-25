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
  | 'legal_delivered'
  // R2-LEGAL2 (CHECK-3 H-1): the consultant's quote is ready to read and sign.
  /** A consultant priced a legal request. Recipient: the client. */
  | 'legal_quote_ready'
  // HOME-16 (R-59): TGIF reaches Home as a daily notification.
  /** The day's TGIF is ready. Recipient: each person who keeps "TGIF each morning" on. */
  | 'tgif_daily'
  // INBOX-24 (R-63): a private community's monthly pass is about to end.
  /** The pass ends in 3 days. Recipient: the member. The tap opens the renew sheet. */
  | 'community_pass_ending'
  // INBOX-25 (R-71): a removed member's unused pass days were paid back.
  /** The unused days of a pass were paid back to the wallet. Recipient: the removed member. */
  | 'community_pass_refunded'
  // FIX-105 (R-81): new messages in a community the person joined.
  /** Other people posted in a community the person joined. One notice per person and room, counted. */
  | 'community_messages';

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
    }
  /**
   * R2-LEGAL2 (CHECK-3 H-1, S21). A consultant priced a legal request, so the
   * quote and the engagement letter are waiting. Recipient: the client. The
   * tap opens the matter (`/legal/requests/<id>`), where the letter is signed.
   */
  | {
      kind: 'legal_quote_ready';
      userWawuId: string;
      requestId: string;
      serviceName: string;
    }
  /**
   * HOME-16 (R-59). The day's TGIF is ready: the daily notice, made once per
   * person per day by the TGIF job (src/scheduler/tgif-daily-notice.service.ts).
   * Recipient: the person. `day` is the Lagos calendar day (YYYY-MM-DD) and is
   * what a tap opens; `series` is the day's title as the book writes it and
   * `verseReference` its verse.
   */
  | {
      kind: 'tgif_daily';
      userWawuId: string;
      day: string;
      series: string;
      verseReference: string;
    }
  /**
   * INBOX-24 (R-63). The member's monthly pass for a private community ends
   * in 3 days. Made once per pass by the reminder sweep. Recipient: the
   * member. `endsAt` is the pass's last moment; the tap opens the renew sheet
   * for the room (`/communities/<id>/renew`, built from the id and never from
   * input). Nothing is debited by itself: renewing is a payment the person
   * confirms with their PIN.
   */
  | {
      kind: 'community_pass_ending';
      userWawuId: string;
      communityId: string;
      communityName: string;
      endsAt: Date;
    }
  /**
   * INBOX-25 (R-71). The host removed the member from a room that sells a
   * monthly pass, and the unused days were paid back to their wallet. Once per
   * removal, when the provider has confirmed the move. Recipient: the removed
   * member. `amount` is the refund in naira.
   */
  | {
      kind: 'community_pass_refunded';
      userWawuId: string;
      communityId: string;
      communityName: string;
      amount: number;
    }
  /**
   * FIX-105 (R-81, owner, 24 Oct 2026: "New messages, grouped"). Other people
   * posted in a community the person joined. Recipient: a member (or the
   * host), never the person who posted. Several messages are ONE notice: the
   * notice is updated (its count and its time) until the person opens the
   * room or reads it, and the next message after that starts a new one.
   * `messageCount` is how many messages from other people are in the notice.
   * Written in batches by the community notice sweep
   * (src/community-message/community-message-notice.service.ts), never one per
   * message from a request; the tap opens the room (`about` names it).
   */
  | {
      kind: 'community_messages';
      userWawuId: string;
      communityId: string;
      communityName: string;
      messageCount: number;
    };

/** A pass's last day as the reminder writes it: "12 Nov 2026", Lagos time. */
function passEndDay(endsAt: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(endsAt);
}

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

/** Words a title keeps in lower case (unless first): "What You Have in Christ". */
const TITLE_SMALL_WORDS = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

/**
 * A TGIF series as the book writes it ("SONS, NOT SLAVES") in title case
 * ("Sons, Not Slaves"; "WHAT YOU HAVE IN CHRIST" becomes "What You Have in
 * Christ"). Pure, so the same day reads the same on every server.
 */
export function tgifSeriesTitle(series: string): string {
  return series
    .trim()
    .split(/\s+/)
    .map((word, i) => {
      const lower = word.toLowerCase();
      if (i > 0 && TITLE_SMALL_WORDS.has(lower.replace(/[^\p{L}]+$/u, ''))) {
        return lower;
      }
      return lower.replace(/\p{L}/u, (c) => c.toUpperCase());
    })
    .join(' ');
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
        // No matter or service name: a lock screen must not show what kind
        // of legal matter someone has.
        body: one
          ? 'Your consultant has sent you a document. Open your request to see it.'
          : `Your consultant has sent you ${event.fileCount} documents. Open your request to see them.`,
        tone: 'success',
        amount: null,
        creditsCount: null,
        actionLabel: 'Open documents',
        imageUrl: null,
        actionHref: `/legal/requests/${event.requestId}`,
        campaignId: null,
      };
    }

    /**
     * R2-LEGAL2 (S21). The quote is ready. The words are true of where the tap
     * goes: the matter, which asks for the signature. No matter or service
     * name, as on `legal_delivered`: a lock screen must not show what kind of
     * legal matter someone has.
     */
    case 'legal_quote_ready':
      return {
        ...base,
        title: 'Your quote is ready',
        body: 'Your consultant has sent you a quote. Open your request to read it and sign.',
        tone: 'info',
        amount: null,
        creditsCount: null,
        actionLabel: 'Open request',
        imageUrl: null,
        actionHref: `/legal/requests/${event.requestId}`,
        campaignId: null,
      };

    /**
     * HOME-16 (R-59). The title is the day's TGIF title (the series, as the
     * book writes it in capitals, set in title case); the body says it is
     * ready and names the day's verse. Nothing personal rides on a lock
     * screen: no name, no reading. Routed by `kind`: the day it opens is the
     * notification's target (`targetFor`), never a path.
     */
    case 'tgif_daily':
      return {
        ...base,
        title: `TGIF: ${tgifSeriesTitle(event.series)}`,
        body: `Today's TGIF is ready. ${event.verseReference}.`,
        tone: 'accent',
        amount: null,
        creditsCount: null,
        actionLabel: 'Read TGIF',
        ...NO_RICH_MEDIA,
      };

    /**
     * INBOX-24 (R-63). The reminder 3 days before a pass ends. It says the
     * day and offers the renew tap; it never says money moves by itself,
     * because none does.
     */
    case 'community_pass_ending':
      return {
        ...base,
        title: 'Your pass is ending soon',
        body: `Your pass for “${event.communityName}” ends on ${passEndDay(event.endsAt)}. Renew it to stay in.`,
        tone: 'warning',
        amount: null,
        creditsCount: null,
        actionLabel: 'Renew',
        imageUrl: null,
        actionHref: `/communities/${event.communityId}/renew`,
        campaignId: null,
      };

    /**
     * FIX-105 (R-81). The words of one grouped notice: how many messages and
     * in which room. No message text and no sender name: a lock screen shows
     * this, and the room shows the messages.
     */
    case 'community_messages':
      return {
        ...base,
        title: 'New messages',
        body:
          event.messageCount === 1
            ? `There is 1 new message in “${event.communityName}”.`
            : `There are ${event.messageCount} new messages in “${event.communityName}”.`,
        tone: 'info',
        amount: null,
        creditsCount: null,
        actionLabel: 'Open room',
        imageUrl: null,
        actionHref: `/communities/${event.communityId}`,
        campaignId: null,
      };

    /**
     * INBOX-25 (R-71). The wallet row says the same thing; this is the one
     * notice. The member did nothing, so it says what came back and why, in
     * plain words.
     */
    case 'community_pass_refunded':
      return {
        ...base,
        title: 'Your pass was refunded',
        body: `The host of “${event.communityName}” removed you from the room. ${formatNaira(event.amount)} for the days you had left is back in your wallet.`,
        tone: 'info',
        amount: Math.round(event.amount),
        creditsCount: null,
        actionLabel: null,
        ...NO_RICH_MEDIA,
      };

    /**
     * NUV-02 round 2 (D6). No matter, name or number in the copy: a lock
     * screen shows it. The fixes are fixed sentences of ours.
     */
    case 'identity_review':
      return composeIdentityReview(
        event.userWawuId,
        event.outcome,
        event.fixes ?? [],
      );

    /**
     * WALLET-10 (W15). Money reached the person's account. The amount is
     * said in naira from the kobo the ledger holds; the sender only when the
     * provider named one.
     */
    case 'money_in':
      return composeMoneyIn(event);

    /** WALLET-39. The correction of a `money_in` notice. */
    case 'money_in_reversed':
      return composeMoneyInReversed(event);

    /**
     * WALLET-40 (owner answer 31). Fixed words: no account number, name or
     * bank on a lock screen. Routed by `kind` (a tap opens Wallet).
     */
    case 'wallet_ready':
      return {
        ...base,
        title: 'Your account number is ready',
        body: 'Tap to see it in your wallet.',
        tone: 'success',
        amount: null,
        creditsCount: null,
        actionLabel: null,
        ...NO_RICH_MEDIA,
      };
  }
}

/**
 * NUV-02 round 2: the three endings of the provider's identity review, and
 * (round 3) an unfinished one closed after too long.
 */
function composeIdentityReview(
  userWawuId: string,
  outcome: 'approved' | 'rejected' | 'stopped' | 'expired',
  fixes: readonly string[],
): NotificationDraft {
  const base = { userWawuId, kind: 'identity_review' } as const;
  const none = {
    amount: null,
    creditsCount: null,
    imageUrl: null,
    actionHref: null,
    campaignId: null,
  };
  switch (outcome) {
    case 'approved':
      return {
        ...base,
        title: 'Identity check passed',
        body: 'Your identity check passed. Your account is being set up.',
        tone: 'success',
        actionLabel: null,
        ...none,
      };
    case 'rejected':
      return {
        ...base,
        title: 'Identity check needs a fix',
        body: `We could not finish your identity check. ${
          fixes.length > 0
            ? fixes.join(' ')
            : 'Check your details and send them again.'
        }`,
        tone: 'warning',
        actionLabel: 'Fix details',
        ...none,
      };
    case 'stopped':
      return {
        ...base,
        title: 'Identity check stopped',
        body: 'We could not finish your identity check. Contact support and we will help.',
        tone: 'danger',
        actionLabel: null,
        ...none,
      };
    case 'expired':
      return {
        ...base,
        title: 'Identity check closed',
        body: 'Your identity check was not finished, so we closed it. Send your details again to start a new one.',
        tone: 'warning',
        actionLabel: 'Start again',
        ...none,
      };
  }
}

/**
 * ₦ from whole kobo, exactly: `₦1,250` for a whole number of naira and
 * `₦1,250.50` otherwise. Nothing is rounded and nothing goes through a float
 * (the ledger holds BIGINT kobo, and a credit is told as it was credited).
 * Naira only.
 */
export function formatNairaFromKobo(kobo: bigint): string {
  const negative = kobo < 0n;
  const abs = negative ? -kobo : kobo;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = Number(abs % 100n);
  const fraction = rest === 0 ? '' : `.${String(rest).padStart(2, '0')}`;
  return `${negative ? '-' : ''}₦${whole}${fraction}`;
}

/** Longest sender name the copy carries; a lock screen has no room for more. */
const MONEY_IN_NAME_MAX = 60;

/**
 * The sender's name as another bank wrote it, made safe to show: control
 * characters out, runs of space made one, an em-dash or en-dash written as a
 * hyphen (R-5: nothing a person reads has one, and a name is not ours to
 * keep them in), cut to MONEY_IN_NAME_MAX characters. Null when nothing is
 * left.
 */
export function moneyInSenderName(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A number written into a name (a phone, an account) is shown as its last
    // four digits, the way the account field is (SWEEP-MONEY, WALLET-39 F1).
    .replace(
      /\d(?:[ -]?\d){5,}/g,
      (run) => `****${run.replace(/\D/g, '').slice(-4)}`,
    );
  if (cleaned === '') return null;
  const chars = Array.from(cleaned);
  return chars.length <= MONEY_IN_NAME_MAX
    ? cleaned
    : chars.slice(0, MONEY_IN_NAME_MAX).join('').trimEnd();
}

/**
 * The last four digits of the sender's account number as `****1234`, or null
 * when the provider gave no number of at least six digits (a shorter one
 * would show most of it).
 */
export function moneyInMaskedAccount(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 6 ? `****${digits.slice(-4)}` : null;
}

/**
 * WALLET-39. "Tolu Bakare" as "Tolu B.": the first word and the first letter
 * of the last, for a person who sent money from inside WAWU. A lock screen
 * shows this text, so a surname is never spelt out. One word stays as it is.
 * Null when nothing is left to show.
 */
export function moneyInShortName(
  raw: string | null | undefined,
): string | null {
  const name = moneyInSenderName(raw);
  if (name === null) return null;
  const words = name.split(' ');
  if (words.length < 2) return name;
  // The initial is the first character that is not punctuation: "Adaeze
  // (CEO)" is "Adaeze C.", not "Adaeze (.". A trailing Jr. or Sr. is not the
  // surname, so "Ada Obi Jr." is "Ada O." (SWEEP-MONEY, WALLET-39 F4).
  let rest = words.slice(1);
  if (rest.length > 1 && /^(jr|sr)\.?$/i.test(rest[rest.length - 1])) {
    rest = rest.slice(0, -1);
  }
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const initial = Array.from(rest[i]).find((c) => !/^[\p{P}\p{Z}]$/u.test(c));
    if (initial !== undefined) return `${words[0]} ${initial}.`;
  }
  return words[0];
}

/**
 * What a money-in notice (and its correction) say, from one set of facts.
 * `received` is the notice, `taken` is the correction. Both name the amount
 * and where it came from, never a whole account number, never a dash, and no
 * wallet, balance or cash-out language (WALLET-10), so a lock screen is safe.
 */
interface MoneyInWords {
  title: string;
  received: string;
  taken: string;
}

function moneyInWords(
  event: Extract<NotificationEvent, { kind: 'money_in' | 'money_in_reversed' }>,
): MoneyInWords {
  const amount = formatNairaFromKobo(event.amountKobo);
  switch (event.source ?? 'bank') {
    case 'transfer': {
      const who = moneyInShortName(event.senderName) ?? 'a WAWU user';
      return {
        title: 'Money received',
        // "Tolu B." already ends the sentence.
        received: `You received ${amount} from ${who}${who.endsWith('.') ? '' : '.'}`,
        taken: `The ${amount} you received from ${who} was reversed.`,
      };
    }
    case 'earning':
      return {
        title: 'Earnings received',
        received: `You received ${amount} in earnings.`,
        taken: `The ${amount} in earnings was reversed.`,
      };
    case 'points':
      return {
        title: 'Money received',
        received: `You received ${amount} from your points.`,
        taken: `The ${amount} from your points was reversed.`,
      };
    case 'refund':
      return {
        title: 'Refund received',
        received: `You received a refund of ${amount}.`,
        taken: `The ${amount} refund was reversed.`,
      };
    default: {
      // A bank transfer. The number is only ever shown with a name beside it
      // (a person's, or the bank's), masked to its last four digits.
      const name = moneyInSenderName(event.senderName);
      const bank = name ? null : moneyInSenderName(event.senderBankName);
      const label = name ?? bank;
      const mask = label
        ? moneyInMaskedAccount(event.senderAccountNumber)
        : null;
      const from = label
        ? `${label}${mask ? (name ? ` (${mask})` : ` ${mask}`) : ''}`
        : null;
      return {
        title: 'Money received',
        received: from
          ? `You received ${amount} from ${from}.`
          : `You received ${amount} by bank transfer.`,
        taken: from
          ? `The ${amount} you received from ${from} was reversed.`
          : `The ${amount} bank transfer was reversed.`,
      };
    }
  }
}

/**
 * WALLET-10 (bank transfers in), WALLET-39 (every credit, R-54).
 * "You received ₦5,000 from Ada Obi (****1234)." with a sender name,
 * "You received ₦5,000 by bank transfer." without one, "You received ₦5,000
 * from Tolu B." from another person, "You received ₦2,550 in earnings.", "You
 * received a refund of ₦1,200.". The number is only ever shown with a name
 * beside it, masked to its last four digits: a lock screen shows this text.
 * No wallet, balance or cash-out language, no dash.
 *
 * `amount` (whole naira, an Int column) is set only when the credit is a
 * whole number of naira that fits: a credit with kobo in it is told in the
 * body, never rounded into the column.
 */
function composeMoneyIn(
  event: Extract<NotificationEvent, { kind: 'money_in' }>,
): NotificationDraft {
  const words = moneyInWords(event);
  const wholeNaira =
    event.amountKobo % 100n === 0n ? event.amountKobo / 100n : null;
  return {
    userWawuId: event.userWawuId,
    kind: 'money_in',
    title: words.title,
    body: words.received,
    tone: 'success',
    amount:
      wholeNaira !== null && wholeNaira <= 2147483647n
        ? Number(wholeNaira)
        : null,
    creditsCount: null,
    actionLabel: null,
    imageUrl: null,
    actionHref: null,
    campaignId: null,
  };
}

/**
 * WALLET-39. The correction of a `money_in` notice: the credit was taken back.
 * It names the same amount and source as the notice it corrects. No amount
 * column: a list row must not show it as money in.
 */
function composeMoneyInReversed(
  event: Extract<NotificationEvent, { kind: 'money_in_reversed' }>,
): NotificationDraft {
  const words = moneyInWords(event);
  return {
    userWawuId: event.userWawuId,
    kind: 'money_in_reversed',
    title: 'Money reversed',
    body: words.taken,
    tone: 'warning',
    amount: null,
    creditsCount: null,
    actionLabel: null,
    imageUrl: null,
    actionHref: null,
    campaignId: null,
  };
}

/* ------------------------------------------------------------------ */
/* ME-10: reviews, and what a notification is about                     */
/* ------------------------------------------------------------------ */

/**
 * Every kind that can be written: the union above (the web's list plus the
 * INBOX kinds) and ME-10's `review_received`. M31 and M32 list reviews
 * ("Sales, tips, paid questions and reviews show up here").
 */
export type NotificationKind =
  | CoreNotificationKind
  | 'review_received'
  // NUV-02 round 2: the wallet provider's review of the person ended.
  | 'identity_review'
  // WALLET-10: money reached the person's account by bank transfer.
  // WALLET-39: and from another person, as earnings, as a refund.
  | 'money_in'
  // WALLET-39: a credit the person was told about was taken back.
  | 'money_in_reversed'
  // WALLET-40: the person's account number is ready, after opening began.
  | 'wallet_ready';

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
 * NUV-02 round 2 (D6). The wallet provider's review of the person's
 * identity ended: `UNDER_REVIEW_MESSAGE` promises "We will let you know when
 * the review is done", and this is how. Recipient: the person. Sent once per
 * decision. `fixes` are our own sentences saying what to correct (never the
 * provider's text, never a BVN, NIN or ID number).
 */
interface IdentityReviewEvent {
  kind: 'identity_review';
  userWawuId: string;
  outcome: 'approved' | 'rejected' | 'stopped' | 'expired';
  fixes?: readonly string[];
}

/**
 * WALLET-10 (W15). A bank transfer reached the person's account. Recipient:
 * the person whose account it is. Sent once per credited ledger row
 * (src/money/money-in-notice), after the credit is a completed `in` row, never
 * from the webhook delivery. `amountKobo` is the whole kobo credited.
 * `senderName` and `senderAccountNumber` are what the provider gave about the
 * sender, null when it gave nothing; the copy shows the account number only as
 * its last four digits and only beside a name.
 */
interface MoneyInEvent {
  kind: 'money_in';
  userWawuId: string;
  amountKobo: bigint;
  senderName?: string | null;
  senderAccountNumber?: string | null;
  /**
   * WALLET-39 (R-54): where the money came from. Left out it is `bank`, which
   * is every WALLET-10 caller. `transfer` is another person's send (the copy
   * names them as "Tolu B."), `earning` is earnings landing, `points` is a
   * points cash-out landing, `refund` is a refund.
   */
  source?: MoneyInSource;
  /** The bank the transfer came from, when the provider named one (WALLET-39). */
  senderBankName?: string | null;
}

/** Where a credit came from, as the copy says it (WALLET-39). */
export type MoneyInSource =
  'bank' | 'transfer' | 'earning' | 'points' | 'refund';

/**
 * WALLET-39. A credit the person was told about ("You received ...") was
 * taken back: the ledger row went `reversed`. Recipient: the person. Sent once
 * per credit, only when a `money_in` notice was written for it. The words
 * name the same amount and source as the notice they correct.
 */
interface MoneyInReversedEvent {
  kind: 'money_in_reversed';
  userWawuId: string;
  amountKobo: bigint;
  senderName?: string | null;
  senderAccountNumber?: string | null;
  source?: MoneyInSource;
  senderBankName?: string | null;
}

/**
 * WALLET-40 (owner answer 31, 17 Oct 2026; BACKEND_GAPS G-823). The person's
 * account number became ready after their wallet opening had started: A28
 * promises "This usually takes a few minutes" and this is the alert. Recipient:
 * the person. Written once per wallet, in the transaction that records the
 * wallet (src/money/opening/wallet-ready-notice.ts), and never for a number
 * that was ready in the request that opened the wallet. It carries no number,
 * name or target: a lock screen shows it, and the tap opens Wallet by `kind`.
 */
interface WalletReadyEvent {
  kind: 'wallet_ready';
  userWawuId: string;
}

/**
 * ME-10. What a notification can be about: the thing opening it opens (M31).
 * `content` a piece, `paid_question` a paid question (DirectMessage),
 * `community` a room, `profile` a person, `tgif_day` (HOME-16) a day of TGIF
 * whose id is the day, YYYY-MM-DD.
 */
export type NotificationTargetKind =
  | 'content'
  | 'paid_question'
  | 'community'
  | 'profile'
  // HOME-16: a day of TGIF; the id is the day, YYYY-MM-DD.
  | 'tgif_day'
  // WALLET-39: a wallet transaction; the id is the ledger row's, the one
  // `GET /money/transactions/{id}` answers for its owner.
  | 'transaction';

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
  | NotificationEventCore
  | ReviewReceivedEvent
  | IdentityReviewEvent
  | MoneyInEvent
  | MoneyInReversedEvent
  | WalletReadyEvent
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
  community_pass_refunded: 'money',
  content_published: 'content',
  content_rejected: 'content',
  review_received: 'content',
  new_follower: 'other',
  kyc_verified: 'other',
  campaign: 'other',
  verify_reminder: 'other',
  legal_delivered: 'other',
  legal_quote_ready: 'other',
  identity_review: 'other',
  money_in: 'money',
  money_in_reversed: 'money',
  tgif_daily: 'other',
  // INBOX-24. Default (agent), owner may override: under "Messages", beside
  // the room it belongs to.
  community_pass_ending: 'messages',
  // FIX-105 (R-81). Under "Messages", beside the room it opens.
  community_messages: 'messages',
  // WALLET-40. Default (agent), owner may override: under "Money", beside the
  // wallet it opens.
  wallet_ready: 'money',
};

/** The NotificationTarget row emit() writes beside a notification, minus its id. */
export interface NotificationTargetDraft {
  targetKind: NotificationTargetKind;
  targetId: string;
  actorWawuId: string | null;
}

/**
 * ME-10. What a notification is about, from its event. A join approval names
 * its room by itself, and a daily TGIF notice its day (HOME-16); every other
 * kind says so through `about`. An actor who
 * is the recipient is dropped (nobody is "the other person" to themselves).
 * Null when the event names nothing, which leaves the row routed by `kind`.
 */
export function targetFor(
  event: NotificationEvent,
): NotificationTargetDraft | null {
  const target =
    event.about?.target ??
    (event.kind === 'community_join_approved' ||
    event.kind === 'community_pass_ending' ||
    event.kind === 'community_messages'
      ? { kind: 'community' as const, id: event.communityId }
      : event.kind === 'tgif_daily'
        ? { kind: 'tgif_day' as const, id: event.day }
        : null);
  if (!target || !target.id) return null;
  const actor = event.about?.actorWawuId ?? null;
  return {
    targetKind: target.kind,
    targetId: target.id,
    actorWawuId: actor && actor !== event.userWawuId ? actor : null,
  };
}
