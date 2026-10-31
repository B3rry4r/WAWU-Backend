import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * USER-SUSPEND (R-121). The one place that knows what a suspended person is: who is one, the words a refusal says, and
 * which writes still go through. The visibility filters (BlockedAccountService), the write guard
 * (SuspensionWriteInterceptor) and the moderators' routes (src/user-suspension) all read this file; nothing copies it.
 *
 * A person is suspended while a `UserSuspension` row with `liftedAt` null exists for them. Nothing of theirs is deleted:
 * lifting sets `liftedAt` and every answer is the one it was before.
 */

/** Where a suspended person writes to. The same address REPORT-UGC mails reports to. */
export const SUSPENDED_SUPPORT_EMAIL = 'support@wawuafrica.com';

/** One sentence, no em-dash: the app shows it as it is. */
export const SUSPENDED_MESSAGE = `Your account is suspended. Contact ${SUSPENDED_SUPPORT_EMAIL}.`;

/** The `reason.code` of the refusal. The app keys its calm screen on this, never on the words. */
export const SUSPENDED_CODE = 'account_suspended';

/** The reasons a moderator picks from. The same list, in the same words, as the report sheet's (REPORT-UGC). */
export const SUSPENSION_REASONS = [
  'spam',
  'harassment',
  'hate',
  'sexual',
  'illegal',
  'impersonation',
  'other',
] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

/** The refusal of a write. 403 with `reason: { code, message, supportEmail }`, carried through by AllExceptionsFilter. */
export function suspendedRefusal(): ForbiddenException {
  return new ForbiddenException({
    message: SUSPENDED_MESSAGE,
    reason: {
      code: SUSPENDED_CODE,
      message: SUSPENDED_MESSAGE,
      supportEmail: SUSPENDED_SUPPORT_EMAIL,
    },
  });
}

type Reader = Pick<PrismaService, 'userSuspension'>;

/** True while a suspension of this person is in force. */
export async function isSuspended(
  prisma: Reader,
  wawuId: string | null | undefined,
): Promise<boolean> {
  if (!wawuId) return false;
  const row = await prisma.userSuspension.findFirst({
    where: { wawuUserId: wawuId, liftedAt: null },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Everyone suspended right now, as ids, for the read surfaces' `notIn`. `except` is the person asking: a suspended
 * person still sees their own things, so their own id is never in the list they are given. One small indexed query.
 */
export async function suspendedIds(
  prisma: Reader,
  except?: string | null,
): Promise<string[]> {
  const rows = await prisma.userSuspension.findMany({
    where: { liftedAt: null },
    select: { wawuUserId: true },
  });
  const ids = rows.map((r) => r.wawuUserId);
  return except ? ids.filter((id) => id !== except) : ids;
}

/**
 * The writes a suspended person may still make, by `METHOD path` with the Hub's route template (the global prefix left
 * off, parameter names ignored). Every other write by a signed-in person is refused. This is an allow list on purpose:
 * a route added later is refused for a suspended person until someone decides it should not be.
 *
 * Why each is here: they leave the product (export, delete), reach their own money (never trapped, R-5 and R-11), or are
 * housekeeping and markers that do nothing to anyone else (push token, notification read, a view or read marker the
 * app sends in the background, so reading never trips the refusal).
 */
export const WRITES_ALLOWED_WHILE_SUSPENDED: readonly string[] = [
  // Leave: delete the account, take it back, export the data.
  'DELETE /account',
  'POST /account/cancel-deletion',
  'POST /settings/privacy/export',
  // Their own money, out to their own bank, and what is needed to get there (a wallet, a PIN, a device, identity checks).
  'POST /wallet/withdraw',
  'POST /money/transfers/bank',
  'POST /money/banks/name-check',
  'POST /money/pin',
  'PUT /money/pin',
  'POST /money/pin/verify',
  'POST /money/pin/reset',
  'POST /money/pin/reset/confirm',
  'POST /money/approval/verify',
  'PUT /money/device',
  'DELETE /money/device',
  'POST /money/device/challenge',
  'POST /money/beneficiaries',
  'DELETE /money/beneficiaries/:id',
  'PUT /money/payout-account',
  'POST /money/wallet/open',
  'POST /money/identity/bvn',
  'POST /money/identity/documents',
  'POST /money/identity/liveness',
  'POST /money/identity/selfie',
  'PUT /money/identity/occupation',
  'POST /money/transactions/:id/receipt',
  'POST /money/statements/email',
  'POST /capital/orders/:id/withdrawal',
  // Housekeeping.
  'POST /push-tokens',
  'DELETE /push-tokens',
  'POST /notifications/mark-all-read',
  'POST /notifications/:id/read',
  'PATCH /settings/notifications',
  'POST /policies/accept',
  'POST /email/unsubscribe',
  // Markers the app sends while a person only reads.
  'POST /ads/:id/events',
  'POST /content/:id/view',
  'POST /search/recent',
  'DELETE /search/recent',
  'POST /me/tier-offer/seen',
  'POST /tgif/:date/read',
  'POST /chats/:chatId/read',
  'POST /communities/:id/read',
  'POST /movies/:movieId/watch',
  'POST /schools/courses/:id/apply-click',
];

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** `/api/hub/content/:id/view` becomes `/content/:p/view`: no prefix, no parameter names. */
function shape(path: string): string {
  return path.replace(/^\/api\/hub/, '').replace(/:[A-Za-z0-9_]+/g, ':p');
}

const ALLOWED: ReadonlySet<string> = new Set(
  WRITES_ALLOWED_WHILE_SUSPENDED.map((entry) => {
    const [method, path] = entry.split(' ');
    return `${method} ${shape(path)}`;
  }),
);

/** Whether a suspended person may make this request. A read always may. */
export function writeAllowedWhileSuspended(
  method: string,
  routePath: string,
): boolean {
  const m = method.toUpperCase();
  if (SAFE_METHODS.has(m)) return true;
  return ALLOWED.has(`${m} ${shape(routePath)}`);
}
