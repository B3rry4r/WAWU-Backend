/**
 * Account has NO Prisma model (registry: fields: []) — DELETE /account acts
 * directly on wawuUserId; nothing to store locally beyond the 48h grace
 * period marker below. Wire-response interface only.
 */

/** DELETE /account response.shape: "{deletionScheduledAt}". */
export interface AccountDeletionResponse {
  deletionScheduledAt: string;
}
