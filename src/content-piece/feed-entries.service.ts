import { Injectable } from '@nestjs/common';
import type { Paginated } from '../common/interceptors/response.interceptor';
import {
  ContentEngagementService,
  type FeedItem,
} from './content-engagement.service';
import {
  FEED_CARD_EVERY,
  FeedCardsService,
  type CreatorCard,
  type ProfessionalCard,
} from './feed-cards.service';
import type { ContentSort } from './ranking';

/** One entry of the mixed feed: a piece, or a creator or professional card. */
export type FeedEntry =
  | { kind: 'content'; content: FeedItem }
  | { kind: 'creator'; creator: CreatorCard }
  | { kind: 'professional'; professional: ProfessionalCard };

/**
 * Which card slot, if any, follows the piece at 0-based position `index` of
 * the whole feed. Slot numbers are global (not per page) so a card is never
 * chosen twice across pages.
 */
export function cardSlotAfter(index: number): number | null {
  return (index + 1) % FEED_CARD_EVERY === 0
    ? (index + 1) / FEED_CARD_EVERY - 1
    : null;
}

/** Even slots are creators, odd slots professionals; both count up. */
export function candidateFor(slot: number): {
  kind: 'creator' | 'professional';
  index: number;
} {
  return slot % 2 === 0
    ? { kind: 'creator', index: slot / 2 }
    : { kind: 'professional', index: (slot - 1) / 2 };
}

/**
 * GET /feed/entries (HOME-05): the For you feed with creator and professional
 * cards among the content. The Following tab is only people the viewer
 * follows, so it carries no cards.
 */
@Injectable()
export class FeedEntriesService {
  constructor(
    private readonly engagement: ContentEngagementService,
    private readonly cards: FeedCardsService,
  ) {}

  async entries(
    viewerWawuId: string,
    tab: 'for_you' | 'following',
    category: string | undefined,
    sort: ContentSort,
    page: number,
    perPage: number,
  ): Promise<Paginated<FeedEntry>> {
    const feed = await this.engagement.feed(
      viewerWawuId,
      tab,
      category,
      sort,
      page,
      perPage,
    );
    const content: FeedEntry[] = feed.items.map((c) => ({
      kind: 'content',
      content: c,
    }));
    if (tab !== 'for_you' || feed.items.length === 0) {
      return { ...feed, items: content };
    }

    const start = (page - 1) * perPage;
    const slots = feed.items
      .map((_, i) => ({ i, slot: cardSlotAfter(start + i) }))
      .filter((s): s is { i: number; slot: number } => s.slot !== null);
    if (slots.length === 0) return { ...feed, items: content };

    const wanted = slots.map((s) => ({ ...s, ...candidateFor(s.slot) }));
    const [creatorIds, listingIds] = await Promise.all([
      wanted.some((w) => w.kind === 'creator')
        ? this.cards.creatorCandidates(viewerWawuId)
        : Promise.resolve([] as string[]),
      wanted.some((w) => w.kind === 'professional')
        ? this.cards.professionalCandidates(viewerWawuId)
        : Promise.resolve([] as string[]),
    ]);
    const chosenCreators = wanted
      .filter((w) => w.kind === 'creator')
      .map((w) => creatorIds[w.index])
      .filter((id): id is string => id !== undefined);
    const chosenListings = wanted
      .filter((w) => w.kind === 'professional')
      .map((w) => listingIds[w.index])
      .filter((id): id is string => id !== undefined);
    const [creatorCards, proCards] = await Promise.all([
      this.cards.creatorCards(viewerWawuId, chosenCreators),
      this.cards.professionalCards(chosenListings),
    ]);

    const items: FeedEntry[] = [];
    feed.items.forEach((c, i) => {
      items.push({ kind: 'content', content: c });
      const w = wanted.find((x) => x.i === i);
      if (!w) return;
      if (w.kind === 'creator') {
        const card = creatorCards.get(creatorIds[w.index] ?? '');
        if (card) items.push({ kind: 'creator', creator: card });
      } else {
        const card = proCards.get(listingIds[w.index] ?? '');
        if (card) items.push({ kind: 'professional', professional: card });
      }
    });
    return { ...feed, items };
  }
}
