import type { WawuIdClient } from '../common/auth/wawu-id.client';
import type { PrismaService } from '../common/prisma/prisma.service';
import { deriveVerificationState } from '../common/verification/verification-state';
import type { MoneyPartyView } from './money-view.type';

/**
 * Name, handle, avatar and tick per person, the way chats read people
 * (ChatService.people): the name from WAWU ID, the rest from the profile.
 * Shared by every money route that shows another person (saved
 * beneficiaries, WALLET-14; recipient search and recent recipients,
 * WALLET-08), so a person reads the same everywhere.
 *
 * - WAWU ID being unreachable, or not knowing the person, degrades the name
 *   to `fallbackNames` (the name on their wallet, when the caller has it),
 *   then to the handle. It never drops the row; a person with none of the
 *   three reads `displayName: ''` and the caller decides.
 * - MoneyPartyView carries one tick; a person holding both shows the purple
 *   creator one. Default (agent), owner may override.
 * - One WAWU ID call and one profile query for the whole list, never one
 *   per person.
 */
export async function loadMoneyParties(
  prisma: Pick<PrismaService, 'userProfile'>,
  wawuId: Pick<WawuIdClient, 'lookupPublicIdentities'>,
  ids: string[],
  fallbackNames: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, MoneyPartyView>> {
  const out = new Map<string, MoneyPartyView>();
  if (ids.length === 0) return out;
  const [identities, profiles] = await Promise.all([
    wawuId.lookupPublicIdentities(ids),
    prisma.userProfile.findMany({
      where: { wawuUserId: { in: ids } },
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
  for (const id of ids) {
    const identity = identities.get(id);
    const profile = profileBy.get(id);
    const name = [identity?.firstName, identity?.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    const ticks = deriveVerificationState(profile ?? null);
    out.set(id, {
      wawuUserId: id,
      displayName:
        name || fallbackNames.get(id)?.trim() || profile?.handle || '',
      handle: profile?.handle ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      tick: ticks.creator.verified
        ? 'creator'
        : ticks.professional.verified
          ? 'professional'
          : null,
    });
  }
  return out;
}
