import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  deriveVerificationState,
  unverified,
  type VerificationState,
} from './verification-state';

/**
 * Reads the two ticks for a set of accounts, in one query.
 *
 * Every user-shaped response carries `verification`, and most of them render
 * a page of users at a time, so the shape that matters is the batch one: N
 * ids in, one `findMany`, a Map out. `forOne` exists for the single-profile
 * reads and is the same call with one id.
 *
 * An id with no `UserProfile` row comes back unverified rather than absent.
 * A caller that had to distinguish "no row" from "no tick" would end up
 * writing `?? unverified()` at every call site, which is the inline
 * derivation this service exists to prevent.
 */
@Injectable()
export class VerificationStateService {
  constructor(private readonly prisma: PrismaService) {}

  async forMany(
    wawuUserIds: string[],
    now: Date = new Date(),
  ): Promise<Map<string, VerificationState>> {
    const unique = [...new Set(wawuUserIds)];
    const out = new Map<string, VerificationState>();
    if (unique.length === 0) return out;

    const rows = await this.prisma.userProfile.findMany({
      where: { wawuUserId: { in: unique } },
      select: {
        wawuUserId: true,
        creatorVerifiedAt: true,
        creatorVerifiedUntil: true,
        professionalVerifiedAt: true,
        professionalVerifiedUntil: true,
      },
    });
    const byId = new Map(rows.map((r) => [r.wawuUserId, r]));

    for (const id of unique) {
      out.set(id, deriveVerificationState(byId.get(id) ?? null, now));
    }
    return out;
  }

  async forOne(
    wawuUserId: string,
    now: Date = new Date(),
  ): Promise<VerificationState> {
    const map = await this.forMany([wawuUserId], now);
    return map.get(wawuUserId) ?? unverified();
  }
}
