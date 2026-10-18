import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { deriveVerificationState } from '../common/verification/verification-state';
import {
  CreditSpendService,
  type CreditSpendPrismaClient,
} from '../credit-spend/credit-spend.service';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import { StorageService, deliverableKeyFrom } from '../storage/storage.service';
import type { Paginated } from '../common/interceptors/response.interceptor';
import type { CommunityKind } from '../../generated/prisma/enums';
import type { CommunityMessage, CommunityMessageSender } from '../common/types';
import { WawuIdClient } from '../common/auth/wawu-id.client';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { NotificationService } from '../notification/notification.service';
import { LivePublisher } from '../live/live-publisher.service';
import {
  CommunityPassAccess,
  PASS_ENDED_MESSAGE,
} from '../community/pass/community-pass-access.service';
import type { CreateCommunityMessageDto } from './dto/create-community-message.dto';
import {
  COST_SETTING,
  PAID_KINDS,
  attachmentCount,
  kindOf,
  shortfallSentence,
  type MessageKind,
  type PaidMessageKind,
} from './message-kind';

/**
 * What a message that costs nothing is stored with. Written onto
 * `CommunityMessage.costInCredits` so the stored row says, truthfully, that
 * this message was not paid for. Nothing is debited and NO `CreditSpend` row
 * is written for one of these; see `store`. A message is free when its
 * sender hosts the room, or when it is text and emoji (R-62).
 */
const FREE_MESSAGE_COST_IN_CREDITS = 0;

/**
 * Where a photo, a video or a voice note must have been uploaded, and the
 * files a phone or a person may send for it (the folders and their
 * allowlists are FOLDER_CONTENT_TYPES in storage/dto/presign-upload.dto.ts).
 */
const MEDIA_FOLDERS = {
  photo: { folder: 'community/message', words: 'photo' },
  video: { folder: 'community/message-video', words: 'video' },
  voice: { folder: 'community/message-voice', words: 'voice note' },
} as const;

/**
 * Warn the sender once their remaining WAWU Credits drop to this COUNT or
 * below. A count, never a naira value (CLAUDE.md) — credits are not money
 * and cannot be cashed out.
 *
 * The warning fires only on the send that CROSSES the threshold (previous
 * balance above it, new balance at or below), plus the send that empties the
 * balance entirely. Emitting whenever `balance <= 5` would put a
 * notification on every one of the next five messages.
 */
const LOW_CREDITS_THRESHOLD = 5;

/**
 * Why a given message is free, or `'credits'` if it isn't.
 *
 *  - `'host'`    — the sender hosts this community.
 *  - `'credits'` — ordinary metered messaging: 1 credit, or the 7-day trial,
 *                  or 402.
 *
 * There used to be a third, `'subscription'`: a paid creator posted free in
 * OPEN communities. That was a subscription perk and went with subscriptions.
 * Nobody loses a free send they paid for, because nobody ever paid.
 */
type MessageEntitlement = 'host' | 'credits';

/**
 * What a send answers with: the stored message, and whether it is the answer to an EARLIER request with the same
 * `Idempotency-Key` (a repeat) rather than a message this request stored.
 */
export interface SentMessage {
  message: CommunityMessage;
  replayed: boolean;
}

/** Prisma's unique-constraint refusal (P2002). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

/**
 * CommunityMessage resource — frozen endpoints `GET /communities/:id/messages`
 * and `POST /communities/:id/messages` (roles: ["any"] on both — any
 * authenticated WAWU user, no creator gate on top of the credits gate
 * described below).
 *
 * `POST` is the one non-trivial contract in this resource: the registry
 * note reads "Server checks CreditsState.creditBalance>0 OR within 7-day
 * trial before accepting; decrements by 1; 402-style rejection with buy
 * more credits if balance=0 and trial ended." CreditsStateModule does not
 * export CreditsStateService (same situation as LearnEntitlement /
 * CourseEnrollment against CreditsState's sibling resources in an earlier
 * wave), so this service reads/writes the `CreditsState` table directly via
 * the shared, globally-registered PrismaService — mirroring exactly how
 * CreditPurchaseService (also outside credits-state/) already does this
 * (see credit-purchase.service.ts, which writes the same table on the
 * purchase path).
 *
 * That credits gate applies only to senders who are NOT entitled to send
 * for free. `resolveEntitlement()` runs first and decides that; everything
 * below describes the metered path it falls through to.
 *
 * WHAT A MESSAGE COSTS (INBOX-22, R-62, which replaces "every metered
 * message costs 1 credit"). The price depends on the KIND of message, and
 * each price is an admin setting read from PlanSettingsService, never a
 * number in this file: text and emoji are free, a photo is
 * `community_credit_cost_photo` (1), a video `community_credit_cost_video`
 * (3), a voice note `community_credit_cost_voice` (3). A message carries at
 * most one attachment, so it costs exactly one kind's price. A free message
 * (text, or any message from the host) is one plain INSERT: no CreditsState
 * row is read or made, no CreditSpend row is written, so a sender with a
 * balance of 0 can still talk and a host's 85% of credits spent in their
 * room is computed on credits actually spent and on nothing else. The
 * paragraphs below describe the PAID path with `cost` standing where they
 * say 1.
 *
 * Gate + decrement semantics (judgment call, since the task brief leaves
 * the exact interaction underspecified):
 *   - A sender whose balance covers `costInCredits` (this message's price)
 *     spends from that real balance. The debit is a conditional UPDATE
 *     guarded on sufficient balance, so it can never go negative and never
 *     double-spend under concurrency (see create()).
 *   - A sender whose balance does not cover it -> 402 rejection.
 *
 * THE FREE TRIAL IS GONE (product owner, 21 Sep 2026: "no 7 day silly
 * trials"). There used to be a third case: a sender with `creditBalance ===
 * 0` was let through anyway if `trialEndsAt > now`, and that message was
 * "trial-covered" — no balance to decrement, so none was decremented, and
 * the host earned ₦0 on it because WAWU had banked nothing. That path is
 * removed, which makes the rule simple enough to state in one line: EVERY
 * metered message costs a credit, and a sender with no credits is asked to
 * buy some.
 *
 * Nobody loses credits they hold. Balances are untouched by this change;
 * only the free allowance on top of them is withdrawn.
 *
 * A CreditsState row is lazily created for a first-time sender exactly like
 * CreditsStateService.getOrCreate does for GET /credits (same default: 0
 * balance, no trial) — CommunityMessage is one of the
 * two documented write-paths onto this table (the other being
 * CreditPurchase.verify), per credits-state.service.ts's own doc comment.
 * That lazy creation happens on the METERED path only: an entitled sender
 * never touches this table, so sending does not silently burn a trial the
 * sender did not need.
 *
 * On every successful METERED send (trial-covered or balance-spent) this
 * service also calls CreditSpendService.record() — CreditSpendModule
 * exports that service specifically for this purpose (see
 * credit-spend.module.ts's own doc comment: "export CreditSpendService for
 * the CommunityMessage module").
 *
 * What lands in the ledger, exactly:
 *   - balance-spent message  -> one CreditSpend row, `creditsSpent: 1`.
 *   - trial-covered message  -> one CreditSpend row, `creditsSpent: 1`.
 *     Pre-existing judgment call, deliberately left alone: CreditSpend
 *     carries no monetary field, it is a volume/attribution ledger, and
 *     trial-period messages are ones WAWU wants visible to the host. NOTE
 *     for whoever turns this ledger into naira: a trial message was never
 *     paid for by anybody, so a straight 90% of `creditsSpent` over-counts
 *     by the trial rows. That is a live question for CreatorEarnings, not
 *     for this service, and it is not silently changed here.
 *   - entitled message (host, or subscriber in an open community)
 *     -> NO row, no balance movement, `costInCredits: 0` on the message.
 *        Nothing was spent, so the ledger says nothing was spent.
 */
@Injectable()
export class CommunityMessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly creditSpendService: CreditSpendService,
    private readonly notifications: NotificationService,
    private readonly wawuId: WawuIdClient,
    private readonly live: LivePublisher,
    private readonly blockedAccounts: BlockedAccountService,
    private readonly passAccess: CommunityPassAccess,
    private readonly settings: PlanSettingsService,
    private readonly storage: StorageService,
  ) {}

  private readonly logger = new Logger(CommunityMessageService.name);

  /**
   * Batch sender-identity lookup for a page of messages — same shape as
   * CreatorDiscoveryService.list() and DirectMessageService's
   * lookupOtherParties: one WawuIdClient.lookupPublicIdentities call plus
   * one userProfile.findMany, merged by id. Called once per page in list(),
   * not once per row. Public so "my communities" (INBOX-01) names the
   * sender of each room's last message the same way.
   */
  async lookupSenders(
    senderIds: string[],
  ): Promise<Map<string, CommunityMessageSender>> {
    const unique = [...new Set(senderIds)];
    const out = new Map<string, CommunityMessageSender>();
    if (unique.length === 0) return out;

    const [identities, profiles] = await Promise.all([
      this.wawuId.lookupPublicIdentities(unique),
      this.prisma.userProfile.findMany({
        where: { wawuUserId: { in: unique } },
        select: {
          wawuUserId: true,
          handle: true,
          avatarUrl: true,
          creatorVerifiedAt: true,
          creatorVerifiedUntil: true,
          professionalVerifiedAt: true,
          professionalVerifiedUntil: true,
        },
      }),
    ]);
    const profileBy = new Map(profiles.map((p) => [p.wawuUserId, p]));

    for (const id of unique) {
      const identity = identities.get(id);
      const profile = profileBy.get(id);
      const fullName = [identity?.firstName, identity?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      out.set(id, {
        wawuId: id,
        name: fullName || profile?.handle || '',
        handle: profile?.handle ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        // Both ticks, derived through the one function. An id with no profile
        // row on this service carries neither.
        verification: deriveVerificationState(profile ?? null),
      });
    }
    return out;
  }

  private async assertCommunityExists(
    communityId: string,
  ): Promise<{ id: string; hostWawuId: string; kind: CommunityKind }> {
    const community = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: { id: true, hostWawuId: true, kind: true },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    return community;
  }

  /**
   * ---------------------------------------------------------------------
   * WHO PAYS FOR A MESSAGE.
   * ---------------------------------------------------------------------
   *
   * This used to be "everybody, always, 1 credit", which charged the HOST for
   * posting in their own room and could 402 them out of a community they own,
   * while they are the party who earns 90% of every credit spent in it. A host
   * with an empty balance and an expired trial was locked out of moderating,
   * welcoming or answering in their own community.
   *
   * The rules, in evaluation order:
   *
   *  1. **Host - always free, in OPEN and PRIVATE alike.** Unconditional and
   *     first, so it cannot be undercut by balance or trial. A host is the
   *     payee of this stream; charging them is charging someone to be paid.
   *     This matches the convention already established elsewhere in this
   *     resource - `assertMember` short-circuits on the host for READS - and
   *     the seeded host message already carries `costInCredits: 0`.
   *
   *  2. **Everyone else - the price of the message's kind** (R-62: text and
   *     emoji free, a photo, a video and a voice note by admin setting), or
   *     402 when their credits do not cover it. The 7-day trial is gone.
   *
   * A paid subscription used to buy a creator free messages in OPEN
   * communities. Subscriptions are gone, so a creator is now an ordinary
   * sender here. CreditSpend is what a host's 90% is computed from, so
   * removing the perk widens what a host earns rather than narrowing it.
   *
   * KYC is deliberately NOT consulted: it gates being PAID, not sending.
   */
  private resolveEntitlement(
    community: { hostWawuId: string; kind: CommunityKind },
    senderWawuId: string,
  ): Promise<MessageEntitlement> {
    return Promise.resolve(
      senderWawuId === community.hostWawuId ? 'host' : 'credits',
    );
  }

  /**
   * What ONE PLAIN MESSAGE costs a sender who is not the host, in WAWU Credits:
   * the price of text and emoji, which R-62 makes nothing. `creditsPerMessage`
   * of `GET /communities/message-cost` is this figure, so the I24 strip and
   * the composer of the app as built before INBOX-23 state no price for a
   * message anybody can send. The prices of photos, videos and voice notes are
   * `costsByKind`. A count, never naira.
   */
  meteredMessageCost(): number {
    return this.costOf('text');
  }

  /**
   * INBOX-22. What each kind of message costs, from the admin settings in
   * force now (TIER-06). Text is always 0: no setting prices it.
   */
  costsByKind(): Record<MessageKind, number> {
    const costs: Record<MessageKind, number> = {
      text: 0,
      photo: 0,
      video: 0,
      voice: 0,
    };
    for (const kind of PAID_KINDS) costs[kind] = this.costOf(kind);
    return costs;
  }

  /** The price of one kind of message, in credits. Only a paid kind reads a setting. */
  private costOf(kind: MessageKind): number {
    if (kind === 'text') return 0;
    return this.settings.number(COST_SETTING[kind]);
  }

  /**
   * INBOX-05. What `senderWawuId` would spend on one PLAIN message in this
   * room, by the same rule `store` charges by: nothing for the host, the text
   * price (nothing, R-62) for everyone else. The app's composer states it, so
   * the price shown is the price paid. A photo, a video or a voice note costs
   * its own price (`costsByKind`), and the host pays none of them.
   */
  async messageCostFor(
    community: { hostWawuId: string; kind: CommunityKind },
    senderWawuId: string,
  ): Promise<number> {
    const entitlement = await this.resolveEntitlement(community, senderWawuId);
    return entitlement === 'credits'
      ? this.costOf('text')
      : FREE_MESSAGE_COST_IN_CREDITS;
  }

  /**
   * Membership gate. `CommunityMembership` and the join/leave endpoints
   * existed, but nothing consulted them: any authenticated user could read a
   * community's entire history and post into it without ever joining, and a
   * private community's pending (unapproved) request behaved like full
   * membership. The host always has access to their own community.
   */
  private async assertMember(
    communityId: string,
    userWawuId: string,
    hostWawuId: string,
  ): Promise<void> {
    if (userWawuId === hostWawuId) return;
    const membership = await this.prisma.communityMembership.findUnique({
      where: { userWawuId_communityId: { userWawuId, communityId } },
      select: { status: true },
    });
    if (!membership || membership.status !== 'joined') {
      throw new ForbiddenException(
        'Join this community to read or post in it.',
      );
    }
    // INBOX-24 (R-63). In a private room that sells a pass, a member whose
    // pass has ended reads and posts nothing until they renew.
    if (!(await this.passAccess.mayEnter(communityId, userWawuId))) {
      throw new ForbiddenException(PASS_ENDED_MESSAGE);
    }
  }

  /**
   * List order: newest-first (`sentAt: 'desc'`), matching this codebase's
   * one existing chat-like sibling — CommentService.list() also orders
   * `createdAt: 'desc'` for a threaded/reverse-chronological feed. No
   * screen-level pagination-direction spec exists for community chat in
   * this repo, so "match the sibling precedent" (per the task brief) means
   * newest-first here too.
   */
  async list(
    communityId: string,
    readerWawuId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<CommunityMessage>> {
    const community = await this.assertCommunityExists(communityId);
    await this.blockedAccounts.assertRoomVisible(
      readerWawuId,
      community.hostWawuId,
      communityId,
    );
    await this.assertMember(communityId, readerWawuId, community.hostWawuId);

    // SETTINGS-04: what a blocked person wrote (or what somebody who blocked
    // the reader wrote) is not shown to the reader in a shared room, and is
    // not counted.
    const hidden = await this.blockedAccounts.hiddenFrom(readerWawuId);
    const where = { communityId, senderWawuId: { notIn: hidden } };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.communityMessage.findMany({
        where,
        orderBy: { sentAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.communityMessage.count({ where }),
    ]);

    const senders = await this.lookupSenders(items.map((m) => m.senderWawuId));
    const enriched: CommunityMessage[] = items.map((m) => ({
      ...m,
      sender: senders.get(m.senderWawuId),
    }));

    return { items: enriched, currentPage: page, perPage, total };
  }

  /**
   * Credits are debited ATOMICALLY. This used to read the balance, compute
   * `balance - cost` in JS and write the result back: two sends racing on
   * one balance of 1 both read 1, both wrote 0, and one message was sent
   * free. The debit is now a single conditional `updateMany` — the balance
   * guard lives in the WHERE clause, so Postgres row-locks and only one of
   * the two concurrent statements can match. Its `count` IS the answer to
   * "did this sender have the credits?", so there is no read-then-write
   * window left to lose.
   *
   * The debit, the message row and the CreditSpend ledger row all run in one
   * interactive transaction: a failure anywhere rolls the credit back
   * instead of charging for a message that was never stored.
   *
   * None of that applies to an ENTITLED send (see resolveEntitlement) —
   * there is no debit and no ledger row to keep in step with the message, so
   * it is a plain single INSERT and needs no transaction.
   *
   * AN OPTIONAL `Idempotency-Key` (INBOX-05 round 5, verifier defect 21). A
   * phone that sent a message and never heard the answer sends it again, and
   * without a key the Hub could not tell that repeat from a second message: it
   * was stored and charged twice. A send may now carry the key the phone made
   * for that one message. Per sender and key the message is stored and
   * charged ONCE; a repeat answers with the first message exactly as it was
   * stored (the same status and body, with `Idempotent-Replayed: true`), and
   * nothing is stored, charged or published again.
   *
   *  - The arbiter is a UNIQUE index, not a read followed by a write: the
   *    key's row (`CommunityMessageKey`, primary key sender + key) is inserted
   *    in the same statement group as the message, so two requests with one
   *    key arriving at the same moment, even on two servers, cannot both get
   *    in. The database refuses the second; its transaction rolls back,
   *    credit and all; and it answers with the first message.
   *  - The message row goes in BEFORE the debit, so a repeat is refused by
   *    the index before it can touch the balance. Debiting first would make
   *    a repeat of a send that took the sender's last credit answer 402
   *    instead of the first message.
   *  - A cheap read before all that answers the ordinary (not racing) repeat
   *    without opening a transaction. It is a shortcut only; the index
   *    decides a race.
   *  - The same key with a different room or different words is not a repeat:
   *    409 `idempotency_key_reused`, nothing stored (the same rule the money
   *    routes follow, docs/contract/CONVENTIONS.md section 4). A repeat is
   *    checked for access like any send first, so a person who has since
   *    lost the room is refused, not answered.
   *  - Without the header none of this runs and nothing changes.
   */
  async create(
    communityId: string,
    senderWawuId: string,
    dto: CreateCommunityMessageDto,
    idempotencyKey?: string,
  ): Promise<SentMessage> {
    const sent = await this.store(
      communityId,
      senderWawuId,
      dto,
      idempotencyKey,
    );
    // A repeat was published when the request that stored it ran.
    if (!sent.replayed) {
      // After the commit, so a listener that hydrates the message finds it.
      await this.live.publish({
        kind: 'community.message',
        communityId,
        messageId: sent.message.id,
      });
    }
    return sent;
  }

  /**
   * The message a sender already stored under this key, if any. A plain read
   * of the row the unique index guards; used as the shortcut before a send
   * and as the answer after the index refused a second one.
   */
  private async earlierSend(
    senderWawuId: string,
    key: string,
  ): Promise<CommunityMessage | null> {
    const row = await this.prisma.communityMessageKey.findUnique({
      where: { senderWawuId_key: { senderWawuId, key } },
      include: { message: true },
    });
    return row?.message ?? null;
  }

  /** A repeat answers with the first message; the same key for other words, another attachment or another room is refused. */
  private replayOf(
    earlier: CommunityMessage,
    communityId: string,
    text: string | null,
    attachments: {
      imageUrl: string | null;
      videoUrl: string | null;
      voiceUrl: string | null;
    },
  ): SentMessage {
    if (
      earlier.communityId !== communityId ||
      earlier.text !== text ||
      earlier.imageUrl !== attachments.imageUrl ||
      earlier.videoUrl !== attachments.videoUrl ||
      earlier.voiceUrl !== attachments.voiceUrl
    ) {
      throw new ConflictException({
        message:
          'That Idempotency-Key was already used for a different message. Send this one with a new key.',
        reason: 'idempotency_key_reused',
      });
    }
    return { message: earlier, replayed: true };
  }

  /**
   * INBOX-22, FIX-77. A photo, a video or a voice note must be a file the
   * SENDER uploaded through the presign path into that kind's own folder
   * (`community/message`, `community/message-video`,
   * `community/message-voice`). The link must be one of THIS bucket's own
   * (its origin and key prefix, read from the storage client: another host,
   * a look-alike host, userinfo, a `%` escape or a backslash is refused) and
   * its key must be exactly `<folder>/<sender>/<uuid>.<ext>`; another
   * person's file, another folder's file and a link to anywhere else are
   * refused. The sender's `StorageObject` row for that key must exist.
   *
   * A video or a voice note must also have landed (`POST /uploads/confirm`
   * made its row `confirmed`). A photo needs no confirm: the web's photo path
   * is presign then PUT and never confirms, so a row that is `pending` or
   * `confirmed` passes and only a given-up (`abandoned`) one is refused.
   *
   * No network call (the bucket's address is worked out by signing a link
   * locally) and no lock, and it runs before anything is charged, so a
   * refused file costs nothing.
   */
  private async assertUploaded(
    senderWawuId: string,
    kind: keyof typeof MEDIA_FOLDERS,
    url: string,
  ): Promise<void> {
    const { folder, words } = MEDIA_FOLDERS[kind];
    const unusable = new BadRequestException(
      kind === 'photo'
        ? 'That photo could not be sent. Choose it again.'
        : `That ${words} could not be used. Upload it again, then send it.`,
    );
    // The strict check LEGAL-03 uses: this bucket's own host and prefix, the
    // kind's own folder, two plain segments after it. A storage that is not
    // configured has no address, so nothing passes there.
    const key = deliverableKeyFrom(url, await this.storage.bucketLocation(), [
      folder,
    ]);
    if (key === null) throw unusable;
    const parts = key.split('/');
    const folderParts = folder.split('/');
    const ownFile =
      parts.length === folderParts.length + 2 &&
      folderParts.every((part, i) => parts[i] === part) &&
      parts[folderParts.length] === senderWawuId &&
      /^[0-9a-f-]{36}\.[a-z0-9]{2,4}$/.test(parts[parts.length - 1]);
    if (!ownFile) throw unusable;
    const row = await this.prisma.storageObject.findUnique({
      where: { key },
      select: { wawuUserId: true, folder: true, status: true },
    });
    if (
      !row ||
      row.wawuUserId !== senderWawuId ||
      row.folder !== folder ||
      (row.status !== 'confirmed' && row.status !== 'pending')
    ) {
      throw unusable;
    }
    if (kind !== 'photo' && row.status !== 'confirmed') {
      throw new BadRequestException(
        `That ${words} has not finished uploading. Wait a moment, then send it again.`,
      );
    }
  }

  /** Checks, charges and stores one message (everything `create` did before INBOX-02). */
  private async store(
    communityId: string,
    senderWawuId: string,
    dto: CreateCommunityMessageDto,
    idempotencyKey?: string,
  ): Promise<SentMessage> {
    // Text, a photo, a video, a voice note, or text with one of them, never
    // neither. Checked before the community is even looked up, and long
    // before a credit is debited: an empty message must never cost anybody
    // anything. (The DTO cannot express this either/or per field; the
    // table's CHECK constraint backs it up.)
    const text = dto.text?.trim() ?? null;
    const imageUrl = dto.imageUrl ?? null;
    const videoUrl = dto.videoUrl ?? null;
    const voiceUrl = dto.voiceUrl ?? null;
    const attachments = { imageUrl, videoUrl, voiceUrl };
    if (!text && attachmentCount(attachments) === 0) {
      throw new BadRequestException(
        'A message needs something in it. Write something, attach a photo, or both.',
      );
    }
    // One attachment at most (INBOX-22): a message costs one kind's price,
    // and no ruling says what two of them add up to.
    if (attachmentCount(attachments) > 1) {
      throw new BadRequestException(
        'A message can carry one photo, one video or one voice note. Send each as its own message.',
      );
    }

    const community = await this.assertCommunityExists(communityId);
    await this.blockedAccounts.assertRoomVisible(
      senderWawuId,
      community.hostWawuId,
      communityId,
    );
    await this.assertMember(communityId, senderWawuId, community.hostWawuId);

    // A repeat that is not racing anything: answered from the row, nothing
    // stored or charged (see create() for why the index, not this, decides).
    if (idempotencyKey) {
      const earlier = await this.earlierSend(senderWawuId, idempotencyKey);
      if (earlier)
        return this.replayOf(earlier, communityId, text, attachments);
    }

    // A photo must be the sender's own upload (presigned or confirmed), a
    // video or a voice note their own confirmed one. Reads only, before any
    // charge: a refused file costs nothing.
    if (imageUrl) await this.assertUploaded(senderWawuId, 'photo', imageUrl);
    if (videoUrl) await this.assertUploaded(senderWawuId, 'video', videoUrl);
    if (voiceUrl) await this.assertUploaded(senderWawuId, 'voice', voiceUrl);

    const kind = kindOf(attachments);
    const entitlement = await this.resolveEntitlement(community, senderWawuId);
    // The host pays nothing for anything in their own room; everyone else
    // pays the price of this message's kind, which for text is nothing.
    const cost = entitlement === 'credits' ? this.costOf(kind) : 0;

    // The key's row, written with the message by the same nested create.
    const keyRow = idempotencyKey
      ? { create: { senderWawuId, key: idempotencyKey } }
      : undefined;

    try {
      // FREE SEND: the host in their own room, or text and emoji from anyone
      // (R-62). Nothing about credits happens on this path AT ALL:
      //   - no CreditsState row is read, created or debited, so a sender with
      //     a balance of 0 (or no row at all) can still talk;
      //   - the 402 gate is never reached, so a host can never be locked out
      //     of their own community;
      //   - NO CreditSpend row is written. That ledger is what the host's 85%
      //     is computed from (CreatorEarningsService), and no credit was spent
      //     here by anybody. Writing a row for a free message would invent
      //     earnings out of nothing, and for the host's own messages it would
      //     be the host paying themselves.
      // The message row records `costInCredits: 0`, which is the truth.
      if (cost === 0) {
        const message = await this.prisma.communityMessage.create({
          data: {
            communityId,
            senderWawuId,
            text,
            imageUrl,
            videoUrl,
            voiceUrl,
            costInCredits: FREE_MESSAGE_COST_IN_CREDITS,
            idempotencyKey: keyRow,
          },
        });
        return { message, replayed: false };
      }

      // Hoisted out of the transaction closure so the credits-low warning
      // below can tell a real debit from a refused one. Read only after the
      // transaction has committed.
      let spentRealBalance = false;

      const message = await this.prisma.$transaction(async (tx) => {
        await this.getOrCreateCreditsState(senderWawuId, tx);

        // The message (and its key) goes in BEFORE the debit: a repeat of a
        // keyed send is refused by the unique index here, before it can touch
        // the balance, and the refusal rolls the whole transaction back.
        const message = await tx.communityMessage.create({
          data: {
            communityId,
            senderWawuId,
            text,
            imageUrl,
            videoUrl,
            voiceUrl,
            costInCredits: cost,
            idempotencyKey: keyRow,
          },
        });

        const { count } = await tx.creditsState.updateMany({
          where: { userWawuId: senderWawuId, creditBalance: { gte: cost } },
          data: { creditBalance: { decrement: cost } },
        });
        spentRealBalance = count > 0;

        // The debit is the whole test: a balance that does not cover this
        // message's price is refused with what it costs, what the sender has
        // and how many credits short they are. Throwing rolls the message
        // row back with it, so nothing is stored and nothing is taken.
        if (!spentRealBalance) {
          const state = await tx.creditsState.findUnique({
            where: { userWawuId: senderWawuId },
            select: { creditBalance: true },
          });
          throw new HttpException(
            {
              message: shortfallSentence(
                kind as PaidMessageKind,
                cost,
                state?.creditBalance ?? 0,
              ),
              reason: 'insufficient_credits',
            },
            HttpStatus.PAYMENT_REQUIRED,
          );
        }

        await this.creditSpendService.record(
          {
            userWawuId: senderWawuId,
            communityId,
            creatorWawuId: community.hostWawuId,
            creditsSpent: cost,
          },
          tx,
        );

        return message;
      });

      // AFTER the commit, never inside it: a notification must not be able to
      // roll back a message the sender has already paid for, and the balance
      // it reports has to be the committed one. It also must not turn a sent,
      // charged message into an error: the sender would send it again.
      if (spentRealBalance) {
        try {
          await this.warnIfCreditsLow(senderWawuId, cost);
        } catch (e) {
          this.logger.warn(
            `Could not send the credits-low notice: ${String(e)}`,
          );
        }
      }

      return { message, replayed: false };
    } catch (error) {
      // Two sends with one key at the same moment: the database let one key
      // row in and refused this one, and the transaction rolled back, credit
      // and all. The first request has committed by now (the index waits for
      // it), so its message is the answer.
      if (idempotencyKey && isUniqueViolation(error)) {
        const earlier = await this.earlierSend(senderWawuId, idempotencyKey);
        if (earlier)
          return this.replayOf(earlier, communityId, text, attachments);
      }
      throw error;
    }
  }

  /**
   * Tell the sender their WAWU Credits are running out — as a COUNT, never a
   * naira value, and never as a balance that could be withdrawn (CLAUDE.md).
   *
   * Only called after a send that actually drew down real balance, so the
   * pre-send count is exactly `remaining + cost`. That lets the warning fire
   * on the crossing send alone rather than on every send from then on. The
   * `remaining === 0` arm covers the last credit being spent, where the
   * crossing test has already fired on an earlier message.
   */
  private async warnIfCreditsLow(
    senderWawuId: string,
    cost: number,
  ): Promise<void> {
    const state = await this.prisma.creditsState.findUnique({
      where: { userWawuId: senderWawuId },
      select: { creditBalance: true },
    });
    if (!state) return;

    const remaining = state.creditBalance;
    const before = remaining + cost;
    const crossedThreshold =
      before > LOW_CREDITS_THRESHOLD && remaining <= LOW_CREDITS_THRESHOLD;

    if (crossedThreshold || remaining === 0) {
      await this.notifications.emit({
        kind: 'credits_low',
        userWawuId: senderWawuId,
        creditsCount: remaining,
      });
    }
  }

  /**
   * Mirrors CreditsStateService.getOrCreate (row at zero, no trial), as an
   * upsert rather than find-then-create so two first-ever sends from the
   * same user can't race into a duplicate-key 500.
   */
  private async getOrCreateCreditsState(
    userWawuId: string,
    client: CreditSpendPrismaClient = this.prisma,
  ): Promise<{ creditBalance: number }> {
    return client.creditsState.upsert({
      where: { userWawuId },
      update: {},
      create: {
        userWawuId,
        creditBalance: 0,
      },
      select: { creditBalance: true },
    });
  }
}
