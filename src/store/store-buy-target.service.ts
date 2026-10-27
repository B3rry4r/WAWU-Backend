import { Injectable } from '@nestjs/common';
import type { StoreIntentKind } from '../../generated/prisma/enums';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { passTitle } from '../community/pass/community-pass-rules';
import type { StoreErrorCode } from './store-error';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The words the wallet paths use for the same refusals (unlock-wallet.service.ts,
// tip-wallet.service.ts, community-pass.service.ts). Plain sentences, no em-dash.
export const TARGET_CONTENT_NOT_FOUND = 'Content not found';
export const TARGET_CONTENT_FREE =
  'This content is free, so no unlock is required.';
export const TARGET_CONTENT_OWN = 'You cannot buy your own content.';
export const TARGET_CONTENT_OWNED = 'You have already unlocked this content.';
export const TARGET_PERSON_NOT_FOUND = 'We could not find that person.';
export const TARGET_TIP_SELF = 'You cannot tip yourself.';
export const TARGET_TIP_BLOCKED = 'You cannot tip this account.';
export const TARGET_ROOM_NOT_FOUND = 'We could not find that room.';
export const TARGET_ROOM_OWN = 'You host this room, so you do not need a pass.';
export const TARGET_ROOM_NO_PASS = 'This room does not sell a pass.';
export const TARGET_ROOM_REMOVED =
  'The host has removed you from this room. Ask the host to let you back in.';
export const TARGET_PRICE_CHANGED =
  'The price has changed. Please refresh and try again.';

/** What a ladder purchase is for, once it has been checked. */
export interface BuyTarget {
  kind: StoreIntentKind;
  /** The piece's id, the creator's WAWU id, or the room's id. */
  targetId: string;
  /** Who earns the 85%: the piece's maker, the person tipped, the room's host. */
  creatorWawuId: string;
  /** What the earning is called. */
  title: string;
}

export type TargetCheck =
  | {
      ok: true;
      target: BuyTarget;
      /** Only when asked to tolerate it: the price on the piece or room is no longer the list price named. */
      priceChanged?: boolean;
    }
  | { ok: false; code: StoreErrorCode; message: string };

const refuse = (code: StoreErrorCode, message: string): TargetCheck => ({
  ok: false,
  code,
  message,
});

/**
 * Whether a person may buy this piece, tip this creator or get this room's
 * pass (STORE-BUY-HUB, R-101). It is the wallet path's own validation, read
 * the same way: `UnlockWalletService.resolve` for a piece (live, paid, not
 * their own, not blocked, not already theirs), `TipWalletService.resolve` for a
 * tip (a person who exists, not themselves, not blocked) and
 * `CommunityPassService.resolve` for a pass (the room sells one, they do not
 * host it, they are not blocked or removed).
 *
 * It is asked twice: when the intent is made (with `listNaira`, so the price on
 * the piece or room must be the list price the app named) and when the store
 * purchase is granted (without it: the person paid the list price they were
 * shown, and a price that moved since changes nothing they bought).
 */
@Injectable()
export class StoreBuyTargetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocked: BlockedAccountService,
  ) {}

  async check(
    userId: string,
    kind: StoreIntentKind,
    targetId: string,
    opts: { listNaira?: number; tolerateChangedPrice?: boolean } = {},
  ): Promise<TargetCheck> {
    switch (kind) {
      case 'content':
        return this.content(userId, targetId, opts);
      case 'tip':
        return this.tip(userId, targetId);
      case 'pass':
        return this.pass(userId, targetId, opts);
    }
  }

  private async content(
    userId: string,
    contentId: string,
    opts: { listNaira?: number; tolerateChangedPrice?: boolean },
  ): Promise<TargetCheck> {
    const notFound = refuse(
      'store_intent_target_not_found',
      TARGET_CONTENT_NOT_FOUND,
    );
    if (!UUID.test(contentId)) return notFound;
    const content = await this.prisma.contentPiece.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        title: true,
        price: true,
        accessType: true,
        status: true,
        creatorWawuId: true,
      },
    });
    if (!content || content.status !== 'live') return notFound;
    if (
      userId !== content.creatorWawuId &&
      (await this.blocked.isBlockedEitherWay(userId, content.creatorWawuId))
    )
      return notFound;
    if (content.accessType === 'free')
      return refuse('store_intent_not_payable', TARGET_CONTENT_FREE);
    if (content.creatorWawuId === userId)
      return refuse('store_intent_not_payable', TARGET_CONTENT_OWN);
    const owned = await this.prisma.purchase.findFirst({
      where: {
        contentId: content.id,
        buyerWawuId: userId,
        type: 'content',
        status: 'completed',
      },
      select: { id: true },
    });
    if (owned) return refuse('store_intent_not_payable', TARGET_CONTENT_OWNED);
    const priceChanged =
      opts.listNaira !== undefined && content.price !== opts.listNaira;
    if (priceChanged && opts.tolerateChangedPrice !== true)
      return refuse('store_intent_price_changed', TARGET_PRICE_CHANGED);
    return {
      ok: true,
      priceChanged,
      target: {
        kind: 'content',
        targetId: content.id,
        creatorWawuId: content.creatorWawuId,
        title: content.title,
      },
    };
  }

  private async tip(userId: string, creatorId: string): Promise<TargetCheck> {
    const notFound = refuse(
      'store_intent_target_not_found',
      TARGET_PERSON_NOT_FOUND,
    );
    if (!UUID.test(creatorId)) return notFound;
    if (creatorId === userId)
      return refuse('store_intent_not_payable', TARGET_TIP_SELF);
    const profile = await this.prisma.userProfile.findUnique({
      where: { wawuUserId: creatorId },
      select: { wawuUserId: true },
    });
    if (!profile) return notFound;
    if (await this.blocked.isBlockedEitherWay(userId, creatorId))
      return refuse('store_intent_not_payable', TARGET_TIP_BLOCKED);
    return {
      ok: true,
      target: {
        kind: 'tip',
        targetId: creatorId,
        creatorWawuId: creatorId,
        title: 'Tip',
      },
    };
  }

  private async pass(
    userId: string,
    communityId: string,
    opts: { listNaira?: number; tolerateChangedPrice?: boolean },
  ): Promise<TargetCheck> {
    const notFound = refuse(
      'store_intent_target_not_found',
      TARGET_ROOM_NOT_FOUND,
    );
    if (!UUID.test(communityId)) return notFound;
    const room = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: {
        id: true,
        name: true,
        hostWawuId: true,
        passPrice: { select: { priceKobo: true } },
      },
    });
    if (!room) return notFound;
    if (room.hostWawuId === userId)
      return refuse('store_intent_not_payable', TARGET_ROOM_OWN);
    if (await this.blocked.isBlockedEitherWay(userId, room.hostWawuId))
      return notFound;
    if (!room.passPrice)
      return refuse('store_intent_not_payable', TARGET_ROOM_NO_PASS);
    const membership = await this.prisma.communityMembership.findUnique({
      where: { userWawuId_communityId: { userWawuId: userId, communityId } },
      select: { status: true },
    });
    if (membership?.status === 'pending')
      return refuse('store_intent_not_payable', TARGET_ROOM_REMOVED);
    const priceChanged =
      opts.listNaira !== undefined &&
      Number(room.passPrice.priceKobo) !== opts.listNaira * 100;
    if (priceChanged && opts.tolerateChangedPrice !== true)
      return refuse('store_intent_price_changed', TARGET_PRICE_CHANGED);
    return {
      ok: true,
      priceChanged,
      target: {
        kind: 'pass',
        targetId: room.id,
        creatorWawuId: room.hostWawuId,
        title: passTitle(room.name),
      },
    };
  }
}
