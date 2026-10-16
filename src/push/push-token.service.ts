import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { NOW_UTC } from './push-clock';
import { PUSH_MAX_TOKENS_PER_USER } from './push-config';
import type { RegisterPushTokenDto } from './dto/push-token.dto';

@Injectable()
export class PushTokenService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registers a phone for the caller. Safe to call on every app start.
   * Returns false, and stores nothing, for an account whose deletion is asked
   * for (see `stopAccount`).
   *
   * One statement decides who owns a token: INSERT ... ON CONFLICT on the
   * unique token. Two people registering the same phone at once cannot both
   * win; the later statement takes the row and the other's pending pushes for
   * it are dropped at send time. A token that moves to a new person, or comes
   * back after Expo called it dead, gets a fresh `createdAt`, so the new owner
   * is never sent what was written before they had it.
   *
   * A person over the cap loses the phone seen longest ago (disabled ones go
   * first). The per-person lock makes the cap exact under parallel calls, and
   * orders a registration against `stopAccount` for the same person.
   */
  async register(
    userWawuId: string,
    dto: RegisterPushTokenDto,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'push-token:' + userWawuId}, 0))`;
      const stopped = await tx.pushStoppedAccount.count({
        where: { userWawuId },
      });
      if (stopped > 0) return false;
      await tx.$executeRaw`
        INSERT INTO "PushToken"
          ("id", "userWawuId", "expoPushToken", "platform", "deviceId", "deviceLabel", "createdAt", "lastSeenAt")
        VALUES
          (gen_random_uuid()::text, ${userWawuId}, ${dto.expoPushToken}, ${dto.platform},
           ${dto.deviceId ?? null}, ${dto.deviceLabel ?? null}, ${NOW_UTC}, ${NOW_UTC})
        ON CONFLICT ("expoPushToken") DO UPDATE SET
          "createdAt" = CASE
            WHEN "PushToken"."userWawuId" <> EXCLUDED."userWawuId"
              OR "PushToken"."disabledAt" IS NOT NULL
            THEN ${NOW_UTC} ELSE "PushToken"."createdAt" END,
          "userWawuId" = EXCLUDED."userWawuId",
          "platform" = EXCLUDED."platform",
          "deviceId" = EXCLUDED."deviceId",
          "deviceLabel" = EXCLUDED."deviceLabel",
          "lastSeenAt" = ${NOW_UTC},
          "disabledAt" = NULL,
          "disabledReason" = NULL`;
      await tx.$executeRaw`
        DELETE FROM "PushToken"
        WHERE "userWawuId" = ${userWawuId}
          AND "id" NOT IN (
            SELECT "id" FROM "PushToken"
            WHERE "userWawuId" = ${userWawuId}
            ORDER BY ("disabledAt" IS NULL) DESC, "lastSeenAt" DESC, "id"
            LIMIT ${PUSH_MAX_TOKENS_PER_USER})`;
      return true;
    });
  }

  /**
   * Removes the caller's own token (sign-out). Another person's token, or one
   * that is not there, removes nothing and answers the same, so the route
   * cannot be used to find out whose phone a token is.
   */
  async remove(userWawuId: string, expoPushToken: string): Promise<boolean> {
    const { count } = await this.prisma.pushToken.deleteMany({
      where: { userWawuId, expoPushToken },
    });
    return count > 0;
  }

  /**
   * The account's deletion was asked for (`DELETE /account`, lead ruling of
   * 7 Oct 2026, VU-2): its phones are forgotten now, not at purge. Deletes
   * every token and delivery of the person and marks the account, so a token
   * registered afterwards is not stored and the sender skips anything still
   * queued. Under the same per-person lock as `register`. Idempotent.
   */
  async stopAccount(userWawuId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'push-token:' + userWawuId}, 0))`;
      await tx.$executeRaw`
        INSERT INTO "PushStoppedAccount" ("userWawuId", "createdAt")
        VALUES (${userWawuId}, ${NOW_UTC})
        ON CONFLICT ("userWawuId") DO NOTHING`;
      await tx.pushDelivery.deleteMany({ where: { userWawuId } });
      await tx.pushToken.deleteMany({ where: { userWawuId } });
    });
  }
}
